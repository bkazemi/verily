import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import {
  createVerily,
  emailProvider,
  generateSigningKey,
  signer,
  type EmailMessage,
} from '../src/server/index.js';
import {
  signedBy,
  verifySigned,
  type SignedDocument,
  type VerifierKey,
} from '../src/core/index.js';
import { alice, MemoryStorage } from './helpers.js';

const newKey = () => generateSigningKey('verifier.test');

const codeIn = (message: EmailMessage) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/m.exec(message.text)![0];

function fixture(signing: { signingKey?: string | (() => Promise<string>) } = {}) {
  let now = 1000000;
  const outbox: EmailMessage[] = [];

  const app = createVerily({
    storage: new MemoryStorage(),
    providers: [emailProvider({ send: async (message) => void outbox.push(message) })],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'verifier.test',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async () => alice,
    now: () => now,
    ...signing,
  });

  async function connect(visibility: 'public' | 'unlisted' = 'public') {
    const flow = await app.service.start(alice, undefined, 'connect');

    await app.service.submit(flow.flowId, flow.binding, 'alice@example.test');
    await app.service.submit(flow.flowId, flow.binding, codeIn(outbox.at(-1)!));

    return (await app.service.approve(flow.flowId, flow.binding, alice, visibility))!;
  }

  const request = (path: string, options: RequestInit = {}) =>
    app.handle(new Request(`https://site.test/api/verily${path}`, options));

  const check = (record: string) =>
    request('/check', {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ record }),
    });

  return {
    app,
    outbox,
    service: app.service,
    connect,
    request,
    check,
    advance: (ms: number) => (now += ms),
  };
}

const document: SignedDocument = {
  type: 'verily-evidence',
  version: 1,
  issuedAt: 5,
  id: 'c1',
  local: { label: 'alice', reference: 'alice' },
  external: { id: '1', handle: 'alice', profileUrl: 'https://provider.test/alice' },
  provider: 'fake',
  providerName: 'Fake',
  attestations: {
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 1 }],
  },
  siteName: 'Site',
  verifierName: 'verifier.test',
  visibility: 'public',
  connectedAt: 1,
  authenticatedAt: 1,
  approvedAt: 1,
  visibilityApprovedAt: 1,
  expiresAt: 10,
  evidenceUrl: 'https://site.test/api/verily/connections/c1',
};

test('a signed record checks against its key, and against nothing else', async () => {
  const mine = await signer(await newKey());
  const other = await signer(await newKey());
  const signed = await mine.sign(document);

  assert.match(signed, /^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n\{\n {2}"type"/);
  assert.equal(await signedBy(signed), mine.key.id);
  assert.match(mine.key.id, /^[0-9A-F]{40}$/);

  assert.deepEqual(await verifySigned(signed, [mine.key]), document);
  // A later key list still holds the one that signed it.
  assert.deepEqual(await verifySigned(signed, [other.key, mine.key]), document);
  // As a form posts it, and as an editor may save it.
  assert.deepEqual(await verifySigned(signed.replace(/\n/g, '\r\n'), [mine.key]), document);
  assert.deepEqual(await verifySigned(`\n${signed}\n\n`, [mine.key]), document);

  assert.equal(await verifySigned(signed, [other.key]), undefined);
  assert.equal(await verifySigned(signed, []), undefined);

  // Another key listed under the signer's id signs nothing in its name.
  assert.equal(await verifySigned(signed, [{ ...other.key, id: mine.key.id }]), undefined);
  // Nor does the signer's key listed under another id, or as some other kind of key.
  assert.equal(await verifySigned(signed, [{ ...mine.key, id: other.key.id }]), undefined);
  assert.equal(await verifySigned(signed, [{ ...mine.key, alg: 'Ed25519' as never }]), undefined);

  const theirs = await other.sign(document);
  const under = (text: string) => text.slice(text.indexOf('-----BEGIN PGP SIGNATURE-----'));

  for (const altered of [
    signed.replace('"siteName": "Site"', '"siteName": "Elsewhere"'),
    // Text added outside what was signed, before it and inside it.
    `Elsewhere\n${signed}`,
    signed.replace('\n}\n', '\n}\n{}\n'),
    // Another key's signature, good as it is, where only this key is the verifier's.
    signed.replace(under(signed), under(theirs)),
    signed.replace(under(signed), ''),
    // The same signature twice is two claims, and only one was asked for.
    signed + under(signed),
    // Text after the signature, closed off as though the signature ended there.
    `${signed}\nunsigned text\n-----END PGP SIGNATURE-----`,
    `${signed}\nunsigned text`,
  ])
    assert.equal(await verifySigned(altered, [mine.key]), undefined);

  for (const junk of [null, 'text', {}, [], 5, '-----BEGIN PGP SIGNED MESSAGE-----'])
    assert.equal(await verifySigned(junk, [mine.key]), undefined);

  for (const keys of [null, 'text', [null], [{}], [{ ...mine.key, publicKey: 'text' }]])
    assert.equal(await verifySigned(signed, keys as never), undefined);
});

test('what this signs, OpenPGP.js and GnuPG both read as signed by the same key', async (t) => {
  const mine = await signer(await newKey());
  const signed = await mine.sign({ ...document, siteName: '- dashes, "quotes" and é' });
  const altered = signed.replace('"id": "c1"', '"id": "c2"');

  const read = async (text: string) => {
    const { signatures, data } = await openpgp.verify({
      message: await openpgp.readCleartextMessage({ cleartextMessage: text }),
      verificationKeys: await openpgp.readKey({ armoredKey: mine.key.publicKey }),
    });

    return (await signatures[0]!.verified.catch(() => false)) ? JSON.parse(data) : undefined;
  };

  assert.deepEqual(await read(signed), await verifySigned(signed, [mine.key]));
  assert.equal(await read(altered), undefined);
  assert.equal(await verifySigned(altered, [mine.key]), undefined);

  if (spawnSync('gpg', ['--version']).status !== 0) return t.diagnostic('gpg is not installed');

  const home = mkdtempSync(join(tmpdir(), 'verily-gpg-'));

  try {
    const gpg = (file: string, text: string, ...args: string[]) => {
      writeFileSync(join(home, file), text);

      return spawnSync('gpg', ['--homedir', home, '--batch', ...args, join(home, file)], {
        encoding: 'utf8',
      });
    };

    assert.equal(gpg('keys.asc', mine.key.publicKey, '--import').status, 0);

    const good = gpg('record.asc', signed, '--status-fd', '1', '--verify');

    assert.equal(good.status, 0);
    assert.match(good.stdout, new RegExp(`VALIDSIG ${mine.key.id} `));
    assert.notEqual(gpg('altered.asc', altered, '--verify').status, 0);

    // And the other way: a record signed by GnuPG with the same key checks here.
    const secret = await newKey();
    const theirs = await signer(secret);

    assert.equal(gpg('secret.asc', secret, '--import').status, 0);
    writeFileSync(join(home, 'document.json'), JSON.stringify(document, null, 2));

    const made = execFileSync(
      'gpg',
      [
        '--homedir',
        home,
        '--batch',
        '--yes',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
      ].concat(
        ['--digest-algo', 'SHA512', '--local-user', theirs.key.id, '--clearsign', '--output', '-'],
        [join(home, 'document.json')],
      ),
      { encoding: 'utf8' },
    );

    assert.deepEqual(await verifySigned(made, [theirs.key]), document);
    assert.equal(await verifySigned(made.replace('"c1"', '"c2"'), [theirs.key]), undefined);

    // A key GnuPG made, with a date it runs out on, is read as it stands too.
    const run = (...args: string[]) =>
      execFileSync('gpg', ['--homedir', home, '--batch', '--yes', ...args], { encoding: 'utf8' });

    // Its kind, its use and its length of life are said outright: an older GnuPG makes RSA.
    run(
      ...['--pinentry-mode', 'loopback', '--passphrase', ''],
      ...['--quick-generate-key', 'gpg.test', 'ed25519', 'sign', '1y'],
    );

    const [fingerprint] = /(?<=^fpr:+)[0-9A-F]{40}(?=:$)/m.exec(
      run('--with-colons', '--list-keys', 'gpg.test'),
    )!;

    const theirKey = {
      id: fingerprint,
      alg: 'OpenPGP' as const,
      publicKey: run('--armor', '--export', fingerprint),
    };

    const byGpg = run(
      ...['--pinentry-mode', 'loopback', '--passphrase', '', '--digest-algo', 'SHA512'],
      ...['--local-user', fingerprint, '--clearsign', '--output', '-'],
      join(home, 'document.json'),
    );

    assert.deepEqual(await verifySigned(byGpg, [theirKey]), document);
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a key that says it is revoked or has run out is taken at its word', async () => {
  const secret = await newKey();
  const mine = await signer(secret);
  const signed = await mine.sign(document);
  const privateKey = await openpgp.readPrivateKey({ armoredKey: secret });
  const listed = (publicKey: string) => [{ ...mine.key, publicKey }];

  assert.ok(await verifySigned(signed, [mine.key]));

  // Revoked by its holder: it signs nothing, whenever the record was made.
  const revoked = await openpgp.revokeKey({ key: privateKey, format: 'armored' });

  assert.equal(await verifySigned(signed, listed(revoked.publicKey)), undefined);

  // A revocation still applies after the name and its certification.
  const revokedKey = await openpgp.readKey({ armoredKey: revoked.publicKey });
  const reordered = privateKey.toPublic().toPacketList();

  reordered.push(...revokedKey.revocationSignatures);

  assert.equal(
    await verifySigned(
      signed,
      listed(openpgp.armor(openpgp.enums.armor.publicKey, reordered.write())),
    ),
    undefined,
  );

  // A revocation another key made is not this key's word, and changes nothing.
  const other = await openpgp.readPrivateKey({ armoredKey: await newKey() });
  const theirs = await openpgp.revokeKey({ key: other, format: 'object' });
  const meddled = await openpgp.readKey({ armoredKey: mine.key.publicKey });

  meddled.revocationSignatures.push(...theirs.publicKey.revocationSignatures);
  assert.ok(await verifySigned(signed, listed(meddled.armor())));

  // The same key, said by itself to have lasted one hour from the day before yesterday.
  const userIDs = [{ name: 'verifier.test' }];
  const made = new Date(privateKey.getCreationTime().getTime() - 2 * 86400000);

  const old = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    subkeys: [],
    userIDs,
    date: made,
    keyExpirationTime: 3600,
    format: 'object',
  });

  const key = {
    id: old.publicKey.getFingerprint().toUpperCase(),
    alg: 'OpenPGP' as const,
    publicKey: old.publicKey.armor(),
  };

  const text = JSON.stringify(document, null, 2);

  const signedAt = async (date: Date, by = old.privateKey) =>
    openpgp.sign({
      message: await openpgp.createCleartextMessage({ text }),
      signingKeys: by,
      date,
    });

  // Signed inside that hour, it still checks today.
  assert.deepEqual(
    await verifySigned(await signedAt(new Date(made.getTime() + 60000)), [key]),
    document,
  );

  // Signed after it, by the same key with its own word on how long it lasts taken off.
  const { privateKey: lasting } = await openpgp.reformatKey({
    privateKey: old.privateKey,
    userIDs,
    date: made,
    format: 'object',
  });

  assert.equal(lasting.getFingerprint(), old.privateKey.getFingerprint());
  assert.equal(await verifySigned(await signedAt(new Date(), lasting), [key]), undefined);

  // A second name, certified later for one hour and then withdrawn, has no say in how long
  // the key lasts: the first name's word stands, as GnuPG and OpenPGP.js both have it.
  const start = new Date(Date.now() - 2 * 86400000);

  const two = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    subkeys: [],
    userIDs,
    date: start,
    format: 'object',
  });

  const { privateKey: brief } = await openpgp.reformatKey({
    privateKey: two.privateKey,
    userIDs: [{ name: 'withdrawn.test' }],
    date: new Date(start.getTime() + 60000),
    keyExpirationTime: 3600,
    format: 'object',
  });

  two.privateKey.users.push(
    await brief.users[0]!.revoke(
      two.privateKey.keyPacket as openpgp.SecretKeyPacket,
      undefined,
      new Date(start.getTime() + 120000),
    ),
  );

  const second = await signer(two.privateKey.armor());
  const current = await second.sign(document);

  assert.match(second.key.publicKey, /^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
  assert.deepEqual(await verifySigned(current, [second.key]), document);

  const agreed = await openpgp.verify({
    message: await openpgp.readCleartextMessage({ cleartextMessage: current }),
    verificationKeys: await openpgp.readKey({ armoredKey: second.key.publicKey }),
  });

  assert.ok(await agreed.signatures[0]!.verified);

  // Left standing, that second name is the key's newest word, and the key has run out.
  const standing = await openpgp.readKey({ armoredKey: second.key.publicKey });

  for (const user of standing.users) user.revocationSignatures = [];

  assert.equal(
    await verifySigned(current, [{ ...second.key, publicKey: standing.armor() }]),
    undefined,
  );

  // A key with nothing of its own saying how long it lasts is not read at all.
  const bare = await openpgp.readKey({ armoredKey: mine.key.publicKey });

  for (const user of bare.users) user.selfCertifications = [];

  assert.equal(await verifySigned(signed, listed(bare.armor())), undefined);
});

test('a key is read as it stood when the record was signed', async () => {
  const day = 86400;
  const start = new Date(Date.now() - 2 * day * 1000);

  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    subkeys: [],
    userIDs: [{ name: 'verifier.test' }],
    date: start,
    format: 'object',
  });

  const signed = await (await signer(privateKey.armor())).sign(document);

  /** The public key with one more certification of its name, which gives the key an hour. */
  const certified = async (date: Date, lapse?: number) => {
    const key = await openpgp.readKey({ armoredKey: publicKey.armor() });
    const user = key.users[0]!;
    const made = new openpgp.SignaturePacket();

    made.signatureType = openpgp.enums.signature.certGeneric;
    made.publicKeyAlgorithm = privateKey.keyPacket.algorithm;
    made.hashAlgorithm = openpgp.enums.hash.sha512;

    made.keyFlags = Uint8Array.of(
      openpgp.enums.keyFlags.certifyKeys | openpgp.enums.keyFlags.signData,
    );

    made.keyExpirationTime = 3600;
    made.keyNeverExpires = false;

    if (lapse) {
      made.signatureExpirationTime = lapse;
      made.signatureNeverExpires = false;
    }

    // The library's own types leave out the configuration this call cannot do without.
    await (made.sign as (...given: unknown[]) => Promise<void>).call(
      made,
      privateKey.keyPacket,
      { userID: user.userID, key: key.keyPacket },
      date,
      false,
      openpgp.config,
    );

    user.selfCertifications.push(made);

    return key;
  };

  const here = async (key: openpgp.Key) =>
    verifySigned(signed, [
      { id: key.getFingerprint().toUpperCase(), alg: 'OpenPGP', publicKey: key.armor() },
    ]);

  /** Whether OpenPGP.js takes the record as signed by this key. */
  const there = async (key: openpgp.Key) => {
    const { signatures } = await openpgp.verify({
      message: await openpgp.readCleartextMessage({ cleartextMessage: signed }),
      verificationKeys: key,
    });

    return signatures[0]!.verified.catch(() => false);
  };

  assert.deepEqual(await here(publicKey), document);
  assert.equal(await there(publicKey), true);

  // The key's newer word gives it an hour, and that word lapses but has not yet: it is not
  // passed over for the older one that set no end, so the key ran out a day and more ago.
  const brief = await certified(new Date(start.getTime() + 60000), 10 * day);

  assert.equal(await here(brief), undefined);
  assert.equal(await there(brief), false);

  // The same word once it has lapsed says nothing, and the older one stands again.
  const lapsed = await certified(new Date(start.getTime() + 60000), 3600);

  assert.deepEqual(await here(lapsed), document);
  assert.equal(await there(lapsed), true);

  // A word dated tomorrow changes nothing about a record signed today.
  const ahead = await certified(new Date(Date.now() + day * 1000));

  assert.deepEqual(await here(ahead), document);
  assert.equal(await there(ahead), true);

  const soon = new Date(start.getTime() + 60000);
  const tomorrow = new Date(Date.now() + day * 1000);
  const { keySuperseded, userIDInvalid } = openpgp.enums.reasonForRevocation;

  // A key superseded leaves what it signed before then standing, and signs nothing after.
  const superseded = async (date: Date) =>
    (
      await openpgp.revokeKey({
        key: privateKey,
        reasonForRevocation: { flag: keySuperseded },
        date,
        format: 'object',
      })
    ).publicKey;

  assert.deepEqual(await here(await superseded(tomorrow)), document);
  assert.equal(await there(await superseded(tomorrow)), true);
  assert.equal(await here(await superseded(soon)), undefined);
  assert.equal(await there(await superseded(soon)), false);

  // The same holds of the key's only name, withdrawn as no longer right.
  const withdrawn = async (date: Date) => {
    const key = await openpgp.readKey({ armoredKey: publicKey.armor() });

    key.users[0] = await key.users[0]!.revoke(
      privateKey.keyPacket as openpgp.SecretKeyPacket,
      { flag: userIDInvalid },
      date,
    );

    return key;
  };

  assert.deepEqual(await here(await withdrawn(tomorrow)), document);
  assert.equal(await there(await withdrawn(tomorrow)), true);

  const nameless = await withdrawn(soon);

  assert.equal(await here(nameless), undefined);
  assert.equal(await there(nameless), false);
});

test("a subkey's signature does not pass under the key's own name", async () => {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    subkeys: [{ sign: true }],
    userIDs: [{ name: 'verifier.test' }],
    format: 'object',
  });

  const key = {
    id: publicKey.getFingerprint().toUpperCase(),
    alg: 'OpenPGP' as const,
    publicKey: publicKey.armor(),
  };

  // Signed by the subkey, as the library chooses to where there is one.
  const message = await openpgp.readCleartextMessage({
    cleartextMessage: await openpgp.sign({
      message: await openpgp.createCleartextMessage({ text: JSON.stringify(document, null, 2) }),
      signingKeys: privateKey,
    }),
  });

  assert.equal(await verifySigned(message.armor(), [key]), undefined);

  // The same signature made to name the key itself, in the part of it nothing signs, while
  // still pointing the library at the subkey that made it.
  const [mark] = (message as unknown as { signature: openpgp.Signature }).signature.packets;
  const subkey = Buffer.from(publicKey.subkeys[0]!.getKeyID().toHex(), 'hex');

  type Unsigned = { type: number; critical: boolean; body: Uint8Array };

  (mark as unknown as { unhashedSubpackets: Unsigned[] }).unhashedSubpackets.push(
    {
      type: 33,
      critical: false,
      body: Uint8Array.of(4, ...publicKey.keyPacket.getFingerprintBytes()!),
    },
    { type: 16, critical: false, body: Uint8Array.from(subkey) },
  );

  const renamed = message.armor();

  assert.equal(await signedBy(renamed), key.id);
  assert.equal(await verifySigned(renamed, [key]), undefined);
});

test('the same key always signs under the same id, and a key that cannot serve is refused', async () => {
  const key = await newKey();

  assert.deepEqual((await signer(key)).key, (await signer(key)).key);
  await assert.rejects(signer('short'), /Invalid signing key/);
  await assert.rejects(signer((await signer(key)).key.publicKey), /Invalid signing key/);

  const userIDs = [{ name: 'other' }];
  const made = { type: 'ecc', curve: 'ed25519Legacy', userIDs } as const;

  // One that signs with a subkey, so its records would name a key no list holds, one
  // that has run out, and one that is locked.
  for (const { privateKey } of [
    await openpgp.generateKey({ ...made, subkeys: [{ sign: true }] }),
    await openpgp.generateKey({
      ...made,
      subkeys: [],
      date: new Date(Date.now() - 86400000),
      keyExpirationTime: 3600,
    }),
    await openpgp.generateKey({ ...made, subkeys: [], passphrase: 'locked' }),
  ])
    await assert.rejects(signer(privateKey), /Invalid signing key/);
});

test('an instance with no signing key signs nothing and offers nothing', async () => {
  const f = fixture();
  const id = await f.connect();

  assert.equal((await f.service.read(id)).signedUrl, undefined);
  assert.deepEqual(await (await f.request('/keys')).json(), { keys: [] });
  assert.equal((await f.request('/keys.asc')).status, 404);
  assert.equal((await f.request(`/connections/${id}?format=signed`)).status, 404);
  assert.equal((await f.request('/check')).status, 404);
  assert.doesNotMatch(await (await f.request(`/connections/${id}`)).text(), /signed record/);
});

test('a public record is served signed as of now, and checks against the published keys', async () => {
  const f = fixture({ signingKey: await newKey() });
  const id = await f.connect();
  const evidence = await f.service.read(id);

  assert.equal(evidence.signedUrl, `https://site.test/api/verily/connections/${id}?format=signed`);

  f.advance(5000);

  const response = await f.request(`/connections/${id}?format=signed`);

  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('content-type')!, /^text\/plain/);

  assert.match(
    response.headers.get('content-disposition')!,
    /^attachment; filename="verily-.+\.asc"$/,
  );

  const signed = await response.text();
  const { keys } = (await (await f.request('/keys')).json()) as { keys: VerifierKey[] };

  // The same keys as one file for `gpg --import`.
  assert.equal(await (await f.request('/keys.asc')).text(), `${keys[0]!.publicKey.trim()}\n`);
  const checked = (await verifySigned(signed, keys))!;

  assert.equal(checked.issuedAt, 1005000);
  assert.equal(checked.external.handle, 'alice@example.test');
  assert.equal(checked.verifierName, 'verifier.test');
  assert.equal(checked.evidenceUrl, evidence.evidenceUrl);
  // What stands now is asked of the instance, so the signed record does not claim it.
  assert.ok(!('status' in checked) && !('signedUrl' in checked));

  assert.match(
    await (await f.request(`/connections/${id}`)).text(),
    new RegExp(
      `<p class="signed" id="signed"><strong>Signed by verifier\\.test</strong> with OpenPGP key <a href="/api/verily/keys\\.asc">${await signedBy(signed)}</a>\\. <a [^>]*>Download the signed record`,
    ),
  );
});

test('a key read from storage is read once', async () => {
  let reads = 0;
  const key = await newKey();

  const f = fixture({
    signingKey: async () => {
      reads += 1;

      return key;
    },
  });

  const id = await f.connect();

  await f.service.signed(id);
  await f.service.signed(id);

  assert.equal(reads, 1);
  assert.deepEqual(await f.service.keys(), [(await signer(key)).key]);
});

test('no signed record is made of a record that is unlisted, removed or run out', async () => {
  const f = fixture({ signingKey: await newKey() });
  const unlisted = await f.connect('unlisted');

  assert.equal((await f.service.read(unlisted, alice)).signedUrl, undefined);
  assert.equal((await f.request(`/connections/${unlisted}?format=signed`)).status, 404);

  const removed = await f.connect();
  const kept = await f.service.signed(removed);

  await f.service.revoke(removed, alice);

  assert.equal((await f.service.read(removed)).signedUrl, undefined);
  assert.equal((await f.request(`/connections/${removed}?format=signed`)).status, 404);
  // The signed record taken before still says what it said.
  assert.equal((await f.service.checked(kept))!.id, removed);

  const lapsed = await f.connect();

  f.advance(400 * 86400000);

  assert.equal((await f.request(`/connections/${lapsed}?format=signed`)).status, 404);
});

test('the check page reads a signed record back, and refuses one it did not sign', async () => {
  const f = fixture({ signingKey: await newKey() });
  const id = await f.connect();
  const signed = await f.service.signed(id);

  assert.match(await (await f.request('/check')).text(), /<textarea name="record"/);

  const page = await (await f.check(signed)).text();

  assert.match(page, /verifier\.test signed this record/);
  assert.match(page, /alice@example\.test/);
  assert.match(page, new RegExp(`Signing key <a [^>]*>${await signedBy(signed)}</a>`));
  assert.match(page, new RegExp(`href="https://site\\.test/api/verily/connections/${id}"`));

  const forged = await (
    await signer(await newKey())
  ).sign({
    ...(await f.service.checked(signed))!,
    siteName: 'Elsewhere',
  });

  for (const record of [forged, 'not a record', '{}', '']) {
    const refused = await (await f.check(record)).text();

    assert.match(refused, /not a record signed by verifier\.test/);
    assert.doesNotMatch(refused, /Elsewhere/);
  }
});

test('a retired key still checks what it signed', async () => {
  const old = await newKey();
  const before = fixture({ signingKey: old });
  const signed = await before.service.signed(await before.connect());

  const after = createVerily({
    storage: new MemoryStorage(),
    providers: [emailProvider({ send: async () => {} })],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'verifier.test',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async () => alice,
    signingKey: await newKey(),
    retiredKeys: [(await signer(old)).key],
  });

  assert.equal((await after.service.keys()).length, 2);
  assert.ok(await after.service.checked(signed));
});

test('making a record public on a signing instance says a signed record outlives removal', async () => {
  for (const [signing, expected] of [
    [{ signingKey: await newKey() }, true],
    [{}, false],
  ] as const) {
    const f = fixture(signing);
    const flow = await f.service.start(alice, undefined, 'connect');

    await f.service.submit(flow.flowId, flow.binding, 'alice@example.test');
    await f.service.submit(flow.flowId, flow.binding, codeIn(f.outbox.at(-1)!));

    const cookie = `${f.app.flowCookieName}=${flow.binding}`;
    const page = await (await f.request(`/flows/${flow.flowId}`, { headers: { cookie } })).text();

    const view = (await (
      await f.request(`/flows/${flow.flowId}?format=json`, { headers: { cookie } })
    ).json()) as { signedNote?: string };

    assert.equal(/signed record/.test(page), expected);
    assert.equal(typeof view.signedNote === 'string', expected);
  }
});

/**
 * How a reader from before retired records took a signed document, kept here as it was
 * written: it knew one version, and ignored any field it did not know.
 */
const versionOneReads = (document: { type?: unknown; version?: unknown; issuedAt?: unknown }) =>
  document?.type === 'verily-evidence' &&
  document.version === 1 &&
  typeof document.issuedAt === 'number';

/** What a signed record says under its signature, read with no check of who signed it. */
const said = async (signed: string) =>
  JSON.parse(
    (await openpgp.readCleartextMessage({ cleartextMessage: signed })).getText(),
  ) as Record<string, unknown>;

test('a retired record is signed as a version an older reader refuses', async () => {
  const f = fixture({ signingKey: await newKey() });
  const id = await f.connect();

  // A live record is signed as it always was, without the mark its holder gave it.
  await f.service.mark(id, alice, 'preferred');
  assert.equal((await f.service.read(id)).mark, 'preferred');

  const live = await said(await f.service.signed(id));

  assert.equal(live.version, 1);
  assert.ok(versionOneReads(live));
  assert.ok(!('mark' in live) && !('status' in live) && !('retiredAt' in live));

  f.advance(5000);
  await f.service.mark(id, alice, 'retired');
  f.advance(400 * 86400000);

  // Long past its expiry, and still to be had signed: this is the durable form of the claim.
  const evidence = await f.service.read(id);

  assert.equal(evidence.signedUrl, `${evidence.evidenceUrl}?format=signed`);

  const signed = await (await f.request(`/connections/${id}?format=signed`)).text();
  const retired = await said(signed);

  assert.equal(retired.version, 2);
  assert.equal(retired.status, 'retired');
  assert.equal(retired.retiredAt, 1005000);
  assert.ok(!('mark' in retired));

  // Read as version 1 it would be taken for a record that stood, so it must not be read.
  assert.ok(!versionOneReads(retired));

  const checked = (await f.service.checked(signed))!;

  assert.equal(checked.version, 2);
  assert.equal(checked.version === 2 && checked.retiredAt, 1005000);

  const page = await (await f.check(signed)).text();

  assert.match(page, /<h1>Retired connection<\/h1>/);
  assert.match(page, /<dt>Last verified<\/dt><dd>1970-01-01T00:16:40Z<\/dd>/);
  assert.match(page, /<dt>Retired<\/dt><dd>1970-01-01T00:16:45Z<\/dd>/);
  assert.doesNotMatch(page, /Valid until/);

  // Removed, it has no signed form, as no removed record has.
  await f.service.revoke(id, alice);
  assert.equal((await f.request(`/connections/${id}?format=signed`)).status, 404);
});

test('a version 2 document that does not say it is retired is not read', async () => {
  const key = await newKey();
  const { sign, key: published } = await signer(key);

  const retired = { ...document, version: 2 as const, status: 'retired' as const, retiredAt: 7 };

  assert.equal((await verifySigned(await sign(retired), [published]))!.version, 2);
  // Version 1 files already saved check as they always did.
  assert.equal((await verifySigned(await sign(document), [published]))!.version, 1);

  for (const altered of [
    { ...retired, status: 'verified' },
    { ...retired, retiredAt: undefined },
    { ...document, version: 2 },
    { ...document, version: 3 },
  ])
    assert.equal(await verifySigned(await sign(altered as never), [published]), undefined);
});
