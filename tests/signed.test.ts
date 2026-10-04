import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerity, emailProvider, type EmailMessage } from '../src/server/index.js';
import {
  generateSigningKey,
  signer,
  verifySigned,
  type SignedDocument,
  type SignedEvidence,
} from '../src/core/index.js';
import { alice, MemoryStorage } from './helpers.js';

const codeIn = (message: EmailMessage) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/m.exec(message.text)![0];

function fixture(signing: { signingKey?: string | (() => Promise<string>) } = {}) {
  let now = 1000000;
  const outbox: EmailMessage[] = [];

  const app = createVerity({
    storage: new MemoryStorage(),
    providers: [emailProvider({ send: async (message) => void outbox.push(message) })],
    baseUrl: 'https://site.test/api/verity',
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
    app.handle(new Request(`https://site.test/api/verity${path}`, options));

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
  type: 'verity-evidence',
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
  evidenceUrl: 'https://site.test/api/verity/connections/c1',
};

test('a signed record checks against its key, and against nothing else', async () => {
  const mine = await signer(generateSigningKey());
  const other = await signer(generateSigningKey());
  const signed = await mine.sign(document);

  assert.deepEqual(await verifySigned(signed, [mine.key]), document);
  // A later key list still holds the one that signed it.
  assert.deepEqual(await verifySigned(signed, [other.key, mine.key]), document);

  assert.equal(await verifySigned(signed, [other.key]), undefined);
  assert.equal(await verifySigned(signed, []), undefined);

  // Another key listed under the signer's id signs nothing in its name.
  assert.equal(await verifySigned(signed, [{ ...other.key, id: mine.key.id }]), undefined);

  const edited = btoa(JSON.stringify({ ...document, siteName: 'Elsewhere' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  assert.equal(await verifySigned({ ...signed, payload: edited }, [mine.key]), undefined);

  for (const junk of [null, 'text', {}, { ...signed, alg: 'none' }, { ...signed, signature: '' }])
    assert.equal(await verifySigned(junk, [mine.key]), undefined);
});

test('the same key always signs under the same id, and a malformed key is refused', async () => {
  const key = generateSigningKey();

  assert.deepEqual((await signer(key)).key, (await signer(key)).key);
  await assert.rejects(signer('short'), /Invalid signing key/);
  await assert.rejects(signer('not base64url!'), /Invalid signing key/);
});

test('an instance with no signing key signs nothing and offers nothing', async () => {
  const f = fixture();
  const id = await f.connect();

  assert.equal((await f.service.read(id)).signedUrl, undefined);
  assert.deepEqual(await (await f.request('/keys')).json(), { keys: [] });
  assert.equal((await f.request(`/connections/${id}?format=signed`)).status, 404);
  assert.equal((await f.request('/check')).status, 404);
  assert.doesNotMatch(await (await f.request(`/connections/${id}`)).text(), /signed record/);
});

test('a public record is served signed as of now, and checks against the published keys', async () => {
  const f = fixture({ signingKey: generateSigningKey() });
  const id = await f.connect();
  const evidence = await f.service.read(id);

  assert.equal(evidence.signedUrl, `https://site.test/api/verity/connections/${id}?format=signed`);

  f.advance(5000);

  const response = await f.request(`/connections/${id}?format=signed`);

  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('content-disposition')!, /^attachment; filename="verity-/);

  const signed = (await response.json()) as SignedEvidence;
  const { keys } = (await (await f.request('/keys')).json()) as { keys: never[] };
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
      `<p class="signed" id="signed"><strong>Signed by verifier\\.test</strong> with key ${signed.keyId}\\. <a [^>]*>Download the signed record`,
    ),
  );
});

test('a key read from storage is read once', async () => {
  let reads = 0;
  const key = generateSigningKey();

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
  const f = fixture({ signingKey: generateSigningKey() });
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
  const f = fixture({ signingKey: generateSigningKey() });
  const id = await f.connect();
  const signed = await f.service.signed(id);

  assert.match(await (await f.request('/check')).text(), /<textarea name="record"/);

  const page = await (await f.check(JSON.stringify(signed))).text();

  assert.match(page, /verifier\.test signed this record/);
  assert.match(page, /alice@example\.test/);
  assert.match(page, new RegExp(`Signing key ${signed.keyId}`));
  assert.match(page, new RegExp(`href="https://site\\.test/api/verity/connections/${id}"`));

  const forged = await (
    await signer(generateSigningKey())
  ).sign({
    ...(await f.service.checked(signed))!,
    siteName: 'Elsewhere',
  });

  for (const record of [JSON.stringify(forged), 'not json', '{}', '']) {
    const refused = await (await f.check(record)).text();

    assert.match(refused, /not a record signed by verifier\.test/);
    assert.doesNotMatch(refused, /Elsewhere/);
  }
});

test('a retired key still checks what it signed', async () => {
  const old = generateSigningKey();
  const before = fixture({ signingKey: old });
  const signed = await before.service.signed(await before.connect());

  const after = createVerity({
    storage: new MemoryStorage(),
    providers: [emailProvider({ send: async () => {} })],
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'verifier.test',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async () => alice,
    signingKey: generateSigningKey(),
    retiredKeys: [(await signer(old)).key],
  });

  assert.equal((await after.service.keys()).length, 2);
  assert.ok(await after.service.checked(signed));
});

test('making a record public on a signing instance says a signed record outlives removal', async () => {
  for (const [signing, expected] of [
    [{ signingKey: generateSigningKey() }, true],
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
