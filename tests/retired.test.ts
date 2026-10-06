import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastProved, type ArtifactProvider, type LocalAccount } from '../src/core/index.js';
import { createVerily } from '../src/server/index.js';
import {
  alice,
  bob,
  fakeArtifactProvider,
  fakeDocumentProvider,
  fakeProvider,
  MemoryStorage,
} from './helpers.js';

const day = 86400000;

/** A link back from a GitHub profile: a second way of showing the account a sign-in shows. */
function fakeBacklink(): ArtifactProvider & { pages: Set<string> } {
  const pages = new Set<string>();

  return {
    id: 'github',
    name: 'GitHub',
    method: 'backlink',
    artifact: 'location',
    pages,
    expect: (local: LocalAccount) => local.profileUrl!,
    instructions: (expect) => ['Link here:', { code: expect }],
    verify({ artifact }) {
      if (!pages.has(artifact)) throw new Error('No link back');

      return Promise.resolve({
        id: artifact,
        kind: 'account',
        handle: 'known-alice',
        profileUrl: artifact,
      });
    },
  };
}

function fixture() {
  let now = 1000000;
  const storage = new MemoryStorage();
  const oauth = fakeProvider();
  const backlink = fakeBacklink();
  const notes = fakeArtifactProvider();
  const keys = fakeDocumentProvider();

  const app = createVerily({
    storage,
    providers: [oauth, backlink, notes, keys],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async (r) =>
      r.headers.get('cookie')?.includes('local=alice')
        ? alice
        : r.headers.get('cookie')?.includes('local=bob')
          ? bob
          : undefined,
    now: () => now,
    validityMs: 30 * day,
    recheckMs: 1000,
    freshnessMs: 7 * day,
  });

  const service = app.service;

  /** Shows the sign-in account, as a new record or as a renewal of the one named. */
  async function signIn(renew?: string, visibility: 'public' | 'unlisted' = 'public') {
    const flow = await service.start(alice, renew, renew ? 'renew' : 'connect', {
      provider: 'github',
      method: 'oauth',
    });

    await service.callback(
      new URL(flow.authorizationUrl!).searchParams.get('state')!,
      flow.binding,
      'code',
    );

    return (await service.approve(flow.flowId, flow.binding, alice, visibility))!;
  }

  /** A proof published elsewhere, which is read again on a schedule. */
  async function publish() {
    const url = 'https://notes.test/alice/1';
    const flow = await service.start(alice, undefined, 'connect', { provider: 'notes' });

    notes.artifacts.set(url, flow.expect!);
    await service.submit(flow.flowId, flow.binding, url);

    return (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  }

  /** A proof handed over, whose identity can later be withdrawn. */
  async function sign() {
    const flow = await service.start(alice, undefined, 'connect', { provider: 'keys' });

    await service.submit(flow.flowId, flow.binding, `signed: ${flow.expect!}`);

    return (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  }

  const stored = (id: string) =>
    storage.transaction(async (tx) => (await tx.get('connections', id))!);

  const request = (path: string, options: RequestInit = {}) =>
    app.handle(new Request(`https://site.test/api/verily${path}`, options));

  const post = (path: string, body: Record<string, string>, cookie = 'local=alice') =>
    request(path, {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    service,
    storage,
    oauth,
    backlink,
    notes,
    keys,
    signIn,
    publish,
    sign,
    stored,
    request,
    post,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** One account on two records: the first has run out and the second is verified. */
async function twoRecords() {
  const f = fixture();
  const lapsed = await f.signIn();

  f.advance(20 * day);
  const verified = await f.signIn();

  f.advance(15 * day);

  assert.equal((await f.service.read(lapsed)).status, 'expired');
  assert.equal((await f.service.read(verified)).status, 'verified');

  return { ...f, lapsed, verified };
}

test('a mark is set on every record of the account, and each change is recorded', async () => {
  const f = await twoRecords();
  const marks = async () => (await f.service.mine(alice)).map((e) => e.mark);

  // Naming either record marks the account, lapsed record and all.
  await f.service.mark(f.lapsed, alice, 'preferred');
  assert.deepEqual(await marks(), ['preferred', 'preferred']);

  await f.service.mark(f.verified, alice, 'unused');
  assert.deepEqual(await marks(), ['unused', 'unused']);

  // Still verified and still listed: only where it is shown changes.
  assert.equal((await f.service.read(f.verified)).status, 'verified');
  assert.equal((await f.service.published()).length, 1);

  await f.service.mark(f.lapsed, alice, 'current');
  assert.deepEqual(await marks(), [undefined, undefined]);
  assert.ok(!('mark' in (await f.stored(f.verified))));

  await f.service.mark(f.verified, alice, 'preferred');
  assert.deepEqual(await marks(), ['preferred', 'preferred']);

  // Asking for what already holds writes nothing.
  const before = (await f.storage.transaction((tx) => tx.list('audit'))).length;

  await f.service.mark(f.verified, alice, 'preferred');
  assert.equal((await f.storage.transaction((tx) => tx.list('audit'))).length, before);

  const events = (await f.storage.transaction((tx) => tx.list('audit')))
    .filter((event) => event.action.startsWith('mark-'))
    .map((event) => [event.action, event.connectionId, event.actor]);

  for (const id of [f.lapsed, f.verified])
    assert.deepEqual(
      events.filter(([, connection]) => connection === id).map(([action]) => action),
      ['mark-preferred', 'mark-unused', 'mark-current', 'mark-preferred'],
    );

  assert.ok(events.every(([, , actor]) => actor === 'local'));

  // Only the holder marks, and only in words that mean something.
  await assert.rejects(f.service.mark(f.verified, bob, 'unused'));
  await assert.rejects(f.service.mark(f.verified, alice, 'favourite' as never));
});

test('retiring an account retires each record on its own last proof and revokes none', async () => {
  const f = await twoRecords();

  await f.service.mark(f.verified, alice, 'preferred');
  await f.service.mark(f.verified, alice, 'retired');

  const [lapsed, verified] = [await f.service.read(f.lapsed), await f.service.read(f.verified)];

  for (const evidence of [lapsed, verified]) {
    assert.equal(evidence.status, 'retired');
    assert.equal(evidence.retiredAt, f.now());
    assert.equal(evidence.revokedAt, undefined);
    assert.equal(evidence.mark, undefined);
  }

  // Each stands on the date its own proof was made, and neither on when it was retired.
  assert.equal(lastProved(lapsed), 1000000);
  assert.equal(lastProved(verified), 1000000 + 20 * day);
  assert.ok(!('mark' in (await f.stored(f.verified))));

  // A retired record never reads as verified, however long passes, and is not listed as such.
  f.advance(400 * day);
  assert.equal((await f.service.read(f.verified)).status, 'retired');
  assert.deepEqual(await f.service.published(), []);

  // Asking twice changes nothing the second time, and there is nothing left to mark.
  await f.service.mark(f.lapsed, alice, 'retired');
  assert.equal((await f.service.read(f.lapsed)).retiredAt, 1000000 + 35 * day);
  assert.equal((await f.service.read(f.verified)).retiredAt, 1000000 + 35 * day);
  await assert.rejects(f.service.mark(f.verified, alice, 'preferred'));

  assert.deepEqual(
    (await f.storage.transaction((tx) => tx.list('audit')))
      .filter((event) => event.action === 'retire')
      .map((event) => event.connectionId)
      .sort(),
    [f.lapsed, f.verified].sort(),
  );

  // Removal is unchanged: the holder can still remove what they retired.
  await f.service.revoke(f.verified, alice);
  assert.equal((await f.service.read(f.verified)).status, 'revoked');
});

test('a lapsed or unconfirmed record can be retired, and a revoked one cannot', async () => {
  const f = fixture();
  const lapsed = await f.signIn();

  f.advance(60 * day);
  assert.equal((await f.service.read(lapsed)).status, 'expired');
  await f.service.mark(lapsed, alice, 'retired');
  assert.equal((await f.service.read(lapsed)).status, 'retired');

  const published = await f.publish();

  f.notes.artifacts.clear();
  f.advance(8 * day);
  assert.equal((await f.service.read(published)).status, 'unconfirmed');
  await f.service.mark(published, alice, 'retired');
  assert.equal((await f.service.read(published)).status, 'retired');

  const removed = await f.sign();

  await f.service.revoke(removed, alice);
  await assert.rejects(f.service.mark(removed, alice, 'retired'));
  await assert.rejects(f.service.mark(removed, alice, 'unused'));
  assert.equal((await f.stored(removed)).retiredAt, undefined);
});

test('a revoked record of the account is left out of what a mark touches', async () => {
  const f = await twoRecords();

  await f.service.revoke(f.lapsed, alice);
  await f.service.mark(f.verified, alice, 'retired');

  assert.equal((await f.stored(f.lapsed)).retiredAt, undefined);
  assert.equal((await f.service.read(f.lapsed)).status, 'revoked');
});

test('retiring an account again leaves the dates its history was frozen with', async () => {
  const f = fixture();
  const first = await f.signIn();

  f.advance(day);
  await f.service.mark(first, alice, 'retired');
  const frozen = await f.stored(first);

  // Connected again since: a new record, which the retired one sits behind as history.
  f.advance(day);
  const second = await f.signIn();

  assert.notEqual(second, first);
  assert.equal((await f.service.read(second)).status, 'verified');

  f.advance(day);
  // Naming the retired record still acts on the account.
  await f.service.mark(first, alice, 'unused');
  assert.equal((await f.service.read(second)).mark, 'unused');
  assert.deepEqual(await f.stored(first), frozen);

  await f.service.mark(first, alice, 'retired');

  assert.deepEqual(await f.stored(first), frozen);
  assert.equal((await f.service.read(second)).retiredAt, f.now());
  assert.equal((await f.service.read(first)).retiredAt, 1000000 + day);
});

test("preferring one account moves the mark and leaves another's unused mark", async () => {
  const f = fixture();
  const first = await f.signIn();

  f.oauth.externalId = '43';
  const second = await f.signIn();

  f.oauth.externalId = '44';
  const third = await f.signIn();

  await f.service.mark(first, alice, 'preferred');
  await f.service.mark(second, alice, 'unused');
  await f.service.mark(third, alice, 'preferred');

  assert.equal((await f.service.read(first)).mark, undefined);
  assert.equal((await f.service.read(second)).mark, 'unused');
  assert.equal((await f.service.read(third)).mark, 'preferred');
});

test('a record made later for an account takes the mark its other records carry', async () => {
  const f = fixture();
  const first = await f.signIn();

  await f.service.mark(first, alice, 'unused');
  f.advance(40 * day);

  // The first has run out, and its mark must survive the account being shown again.
  const second = await f.signIn();

  assert.equal((await f.service.read(second)).mark, 'unused');

  // Another account starts with none.
  f.oauth.externalId = '43';
  assert.equal((await f.service.read(await f.signIn())).mark, undefined);
});

test('an account retired while its recheck is in flight keeps its proof date and is not revoked', async () => {
  const f = fixture();
  const published = await f.publish();
  const signed = await f.sign();
  const proved = (await f.service.read(published)).attestations.external[0].confirmedAt;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const verify = f.notes.verify.bind(f.notes);
  let reading = 0;

  f.notes.verify = async (input) => {
    reading += 1;
    await gate;

    return verify(input);
  };

  // The holder has withdrawn the key, which a recheck would read as a revocation.
  f.keys.gone = true;
  const withdrawn = f.keys.withdrawn!.bind(f.keys);

  f.keys.withdrawn = async (...input) => {
    reading += 1;
    await gate;

    return withdrawn(...input);
  };

  f.advance(2000);
  const run = f.service.recheck();

  while (reading < 1) await new Promise((resolve) => setImmediate(resolve));

  await f.service.mark(published, alice, 'retired');
  await f.service.mark(signed, alice, 'retired');
  release();

  assert.equal(await run, 0);
  assert.equal(reading, 2);
  assert.equal((await f.service.read(published)).attestations.external[0].confirmedAt, proved);
  assert.equal(lastProved(await f.service.read(published)), proved);
  assert.equal((await f.service.read(signed)).status, 'retired');
  assert.equal((await f.stored(signed)).revokedAt, undefined);

  // And from then on neither is asked about at all.
  f.advance(10 * day);
  assert.equal(await f.service.recheck(), 0);
  assert.equal(reading, 2);
});

test('a retired record is kept past retention until it is revoked', async () => {
  const f = fixture();
  const id = await f.signIn();

  await f.service.mark(id, alice, 'retired');
  f.advance(1000 * day);
  await f.service.prune();

  assert.equal((await f.service.read(id)).status, 'retired');

  await f.service.revoke(id, alice);
  f.advance(91 * day);
  await f.service.prune();
  await assert.rejects(f.service.read(id));
});

test('only the method a retired record was first shown by renews it', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.backlink.pages.add('https://github.com/known-alice');

  // Started while the record was live, and finished after it was retired.
  const early = await f.service.start(alice, id, 'renew', {
    provider: 'github',
    method: 'backlink',
  });

  await f.service.mark(id, alice, 'retired');
  const frozen = await f.stored(id);

  await assert.rejects(
    f.service.start(alice, id, 'renew', { provider: 'github', method: 'backlink' }),
  );

  await f.service.submit(early.flowId, early.binding, 'https://github.com/known-alice');
  await assert.rejects(f.service.approve(early.flowId, early.binding, alice, 'public'));

  // Who can read it is frozen with the rest of it.
  await assert.rejects(f.service.start(alice, id, 'visibility'));
  assert.deepEqual(await f.stored(id), frozen);

  // Proving the account another way makes a new record and leaves the retired one alone.
  const flow = await f.service.start(alice, undefined, 'connect', {
    provider: 'github',
    method: 'backlink',
  });

  await f.service.submit(flow.flowId, flow.binding, 'https://github.com/known-alice');
  assert.equal(await f.service.joining(await f.service.flow(flow.flowId, flow.binding)), undefined);

  const made = (await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  assert.notEqual(made, id);
  assert.equal((await f.service.read(made)).status, 'verified');
  assert.deepEqual(await f.stored(id), frozen);
});

test('a renewal by its main method revives a retired record under the same id', async () => {
  const f = await twoRecords();

  await f.service.mark(f.verified, alice, 'retired');
  f.advance(day);

  assert.equal(await f.signIn(f.verified), f.verified);

  const revived = await f.service.read(f.verified);

  assert.equal(revived.status, 'verified');
  assert.equal(revived.retiredAt, undefined);
  assert.equal(revived.mark, undefined);
  assert.equal(revived.authenticatedAt, f.now());
  assert.ok(!('retiredAt' in (await f.stored(f.verified))));

  // The account's other retired record stays retired, behind it.
  assert.equal((await f.service.read(f.lapsed)).status, 'retired');
  assert.equal((await f.service.read(f.lapsed)).retiredAt, 1000000 + 35 * day);
});

test('a retired record revived beside a marked live one takes that mark', async () => {
  const f = fixture();
  const retired = await f.signIn();

  await f.service.mark(retired, alice, 'retired');

  // Connected again and marked while the first sat retired.
  f.advance(day);
  const live = await f.signIn();

  await f.service.mark(live, alice, 'unused');
  assert.equal((await f.stored(retired)).mark, undefined);

  // The marked record has run out by the time the older one is revived, and still counts.
  f.advance(40 * day);
  assert.equal((await f.service.read(live)).status, 'expired');
  await f.signIn(retired);

  assert.equal((await f.service.read(retired)).status, 'verified');
  assert.equal((await f.service.read(retired)).mark, 'unused');
});

test('the mark route takes the local session and the same origin, and asks for no proof', async () => {
  const f = await twoRecords();

  assert.equal((await f.post(`/connections/${f.verified}/mark`, { as: 'unused' })).status, 200);

  assert.deepEqual(
    (await (await f.request('/mine', { headers: { cookie: 'local=alice' } })).json()).map(
      (e: { mark?: string }) => e.mark,
    ),
    ['unused', 'unused'],
  );

  for (const [headers, body] of [
    [{ cookie: 'local=alice' }, { as: 'retired' }],
    [{ cookie: 'local=alice', origin: 'https://evil.test' }, { as: 'retired' }],
    [{ cookie: 'local=bob', origin: 'https://site.test' }, { as: 'retired' }],
    [{ origin: 'https://site.test' }, { as: 'retired' }],
    [{ cookie: 'local=alice', origin: 'https://site.test' }, { as: 'favourite' }],
    [{ cookie: 'local=alice', origin: 'https://site.test' }, {}],
  ] as const)
    assert.equal(
      (
        await f.request(`/connections/${f.verified}/mark`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
      404,
    );

  assert.equal((await f.service.read(f.verified)).status, 'verified');

  assert.equal((await f.post(`/connections/${f.lapsed}/mark`, { as: 'retired' })).status, 200);
  assert.equal((await f.service.read(f.verified)).status, 'retired');
});

test('a retired record says so on its page, with its last proof and its retirement apart', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.advance(3 * day);
  await f.service.mark(id, alice, 'retired');
  f.advance(100 * day);

  const text = await (await f.request(`/connections/${id}`)).text();

  assert.match(text, /<h1>Retired connection<\/h1>/);
  assert.match(text, /<dt>Last verified<\/dt><dd>1970-01-01T00:16:40Z<\/dd>/);
  assert.match(text, /<dt>Retired<\/dt><dd>1970-01-04T00:16:40Z<\/dd>/);
  assert.doesNotMatch(text, /Expired on|Valid until|Verified connection/);
  // Whoever holds the account now can still remove it.
  assert.match(text, new RegExp(`/external-revoke/${id}`));

  const evidence = await (await f.request(`/connections/${id}?format=json`)).json();

  assert.equal(evidence.status, 'retired');
  assert.equal(evidence.retiredAt, 1000000 + 3 * day);
});

test('the renew page offers a retired record its main method alone, and no change of visibility', async () => {
  const f = fixture();
  const id = await f.signIn();

  const methods = async () =>
    [
      ...(
        await (await f.request(`/renew/${id}`, { headers: { cookie: 'local=alice' } })).text()
      ).matchAll(/name="method" value="([^"]+)"/g),
    ].map((match) => match[1]);

  assert.deepEqual(await methods(), ['oauth', 'backlink']);
  assert.equal((await f.post(`/connections/${id}/visibility`, {})).status, 200);

  await f.service.mark(id, alice, 'retired');

  assert.deepEqual(await methods(), ['oauth']);
  assert.equal((await f.post(`/connections/${id}/visibility`, {})).status, 404);

  assert.equal(
    (await f.request(`/visibility/${id}`, { headers: { cookie: 'local=alice' } })).status,
    404,
  );

  assert.equal(
    (await f.post('/sessions', { kind: 'renew', connectionId: id, method: 'backlink' })).status,
    404,
  );
});

test('an unlisted retired record can still be shared by link', async () => {
  const f = fixture();
  const id = await f.signIn(undefined, 'unlisted');

  await f.service.mark(id, alice, 'retired');

  const token = (await f.service.share(id, alice))!.url.split('/').at(-1)!;

  assert.equal((await f.service.shared(token)).status, 'retired');
  await assert.rejects(f.service.read(id));
});
