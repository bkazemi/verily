import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactProvider, LocalAccount } from '../src/core/index.js';
import { VerilyService } from '../src/server/service.js';
import { alice, bob, fakeArtifactProvider, fakeProvider, MemoryStorage } from './helpers.js';

/** Alice after the site moved her profile: the same subject at a new address. */
const moved = { ...alice, profileUrl: 'https://site.test/users/alice' };

/** A link back from a GitHub profile: the account is named by its address alone. */
function fakeBacklink(): ArtifactProvider & { pages: Set<string>; calls: number } {
  const pages = new Set<string>();

  return {
    id: 'github',
    name: 'GitHub',
    method: 'backlink',
    artifact: 'location',
    pages,
    calls: 0,
    expect: (local: LocalAccount) => local.profileUrl!,
    instructions: (expect) => ['Link here:', { code: expect }],
    resolve: (artifact) =>
      /^[\w-]+$/.test(artifact) ? `https://github.com/${artifact}` : artifact,
    known: (account) => account.handle,
    verify({ artifact }) {
      this.calls += 1;

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

function fixture(extra: ArtifactProvider[] = []) {
  let now = 1000000;
  const oauth = fakeProvider();
  const backlink = fakeBacklink();

  const service = new VerilyService({
    storage: new MemoryStorage(),
    providers: [oauth, backlink, ...extra],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 30 * 86400000,
    recheckMs: 1000,
    freshnessMs: 5000,
  });

  async function signIn(local: LocalAccount = alice) {
    const flow = await service.start(local, undefined, 'connect', { method: 'oauth' });
    const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

    await service.callback(state, flow.binding, 'code');

    return (await service.approve(flow.flowId, flow.binding, local, 'public'))!;
  }

  async function linkBack(
    kind: 'connect' | 'renew' = 'connect',
    id?: string,
    page = 'https://github.com/Known-Alice',
  ) {
    backlink.pages.add(page);
    const flow = await service.start(alice, id, kind, { provider: 'github', method: 'backlink' });

    // Read at the start where a record already named the account and the link was there.
    if ((await service.flow(flow.flowId, flow.binding)).phase === 'pending')
      await service.submit(flow.flowId, flow.binding, page);

    return { flow, id: await service.approve(flow.flowId, flow.binding, alice, 'unlisted') };
  }

  return {
    service,
    oauth,
    backlink,
    signIn,
    linkBack,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a second method on the same account joins the record beneath the first', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.advance(10);
  const added = await f.linkBack();

  // The same record, still public: joining it does not rechoose its visibility.
  assert.equal(added.id, id);
  assert.equal((await f.service.mine(alice)).length, 1);

  const evidence = await f.service.read(id);

  assert.equal(evidence.visibility, 'public');
  assert.equal(evidence.attestations!.external[0].method, 'oauth');

  assert.deepEqual(
    evidence.attestations!.external.map((a) => [a.method, a.artifactUrl]),
    [
      ['oauth', undefined],
      ['backlink', 'https://github.com/Known-Alice'],
    ],
  );

  // The record keeps the account the first method named, not the address the second read.
  assert.equal(evidence.external.id, '42');
});

test('a flow that joins a record is recorded without an approval', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.backlink.pages.add('https://github.com/known-alice');

  const flow = await f.service.start(
    alice,
    undefined,
    'connect',
    { method: 'backlink' },
    undefined,
    true,
  );

  const ended = await f.service.flow(flow.flowId, flow.binding);

  // The account is the record's and its visibility stands, so there was nothing to ask.
  assert.equal(ended.phase, 'complete');
  assert.equal(ended.resultId, id);
  assert.equal((await f.service.read(id)).attestations!.external.length, 2);
});

test('a flow the holder was sent into by a link is recorded only once they approve it', async () => {
  const f = fixture();
  const id = await f.signIn();

  // Not shown to have come from the holder's own page: any site can send a browser here.
  f.backlink.pages.add('https://github.com/known-alice');
  const calls = f.backlink.calls;
  const flow = await f.service.start(alice, undefined, 'connect', { method: 'backlink' });

  // Nothing was read, and the record is as it was.
  assert.equal(f.backlink.calls, calls);
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'pending');

  await f.service.submit(flow.flowId, flow.binding, 'known-alice');

  // Shown, and still waiting on the approval: the one step a link cannot press.
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'approval');
  assert.equal((await f.service.read(id)).attestations!.external.length, 1);

  const renew = await f.service.start(alice, id, 'renew', { method: 'oauth' });
  const state = new URL(renew.authorizationUrl!).searchParams.get('state')!;

  await f.service.callback(state, renew.binding, 'code');
  assert.equal((await f.service.flow(renew.flowId, renew.binding)).phase, 'approval');
});

test('a renewal is recorded once the account is shown again', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.advance(10);
  const flow = await f.service.start(alice, id, 'renew', { method: 'oauth' }, undefined, true);
  const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

  await f.service.callback(state, flow.binding, 'code');

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'complete');
  assert.equal((await f.service.read(id)).approvedAt, 1000010);
});

test('a new link still waits for the holder to approve it', async () => {
  const f = fixture();
  const flow = await f.service.start(alice, undefined, 'connect', { method: 'oauth' });
  const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

  await f.service.callback(state, flow.binding, 'code');

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'approval');
  assert.deepEqual(await f.service.mine(alice), []);
});

test('an account already on record is offered, so the holder need not name it', async () => {
  const f = fixture();

  // Nothing says whose profile to read until some method has named the account.
  const first = await f.service.start(alice, undefined, 'connect', { method: 'backlink' });

  assert.equal((await f.service.flow(first.flowId, first.binding)).suggested, undefined);

  const id = await f.signIn();
  const flow = await f.service.start(alice, undefined, 'connect', { method: 'backlink' });

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).suggested, 'known-alice');

  // Somebody else's record says nothing about this subject.
  const other = await f.service.start(bob, undefined, 'connect', { method: 'backlink' });

  assert.equal((await f.service.flow(other.flowId, other.binding)).suggested, undefined);

  // A flow on the record itself is offered that record's account.
  const renew = await f.service.start(alice, id, 'renew', { method: 'backlink' });

  assert.equal((await f.service.flow(renew.flowId, renew.binding)).suggested, 'known-alice');
});

test('two accounts on record leave which one to the holder', async () => {
  const f = fixture();

  await f.signIn();
  f.oauth.externalId = '43';

  f.oauth.authenticate = () =>
    Promise.resolve({
      id: '43',
      handle: 'other-alice',
      profileUrl: 'https://github.com/other-alice',
    });

  await f.signIn();

  const flow = await f.service.start(alice, undefined, 'connect', { method: 'backlink' });

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).suggested, undefined);
});

test('signing in records a link back already on the profile, with nothing more to do', async () => {
  const f = fixture();

  // No link on the profile: the sign-in stands alone, and is none the worse for it.
  const alone = await f.signIn(moved);

  assert.equal((await f.service.read(alone)).attestations!.external.length, 1);

  f.backlink.pages.add('https://github.com/known-alice');
  const id = await f.signIn();

  assert.deepEqual(
    (await f.service.read(id)).attestations!.external.map((a) => [
      a.method,
      a.artifactUrl,
      a.expect,
    ]),
    [
      ['oauth', undefined, undefined],
      ['backlink', 'https://github.com/known-alice', alice.profileUrl],
    ],
  );

  // It is a proof like any other from here: read again on schedule, gone when taken down.
  f.advance(2000);
  assert.equal(await f.service.recheck(), 1);

  f.backlink.pages.clear();
  f.advance(6000);
  await f.service.recheck();
  assert.equal((await f.service.read(id)).attestations!.external.length, 1);
});

test('approval is not shown until every proof it will record has been read', async () => {
  const f = fixture();
  const verify = f.backlink.verify.bind(f.backlink);
  let release!: () => void;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => (reading = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));

  f.backlink.pages.add('https://github.com/known-alice');

  f.backlink.verify = async (input) => {
    reading();
    await held;

    return verify(input);
  };

  const flow = await f.service.start(alice, undefined, 'connect', { method: 'oauth' });
  const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;
  const callback = f.service.callback(state, flow.binding, 'code');

  // A dialog polling now must keep waiting, or it would show an approval missing the note.
  await started;
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'exchanging');

  release();
  await callback;

  const shown = await f.service.flow(flow.flowId, flow.binding);

  assert.equal(shown.phase, 'approval');

  assert.deepEqual(
    shown.standing?.map((a) => a.method),
    ['backlink'],
  );
});

test('a link already on the known account is read without asking for anything', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.backlink.pages.add('https://github.com/known-alice');

  const flow = await f.service.start(
    alice,
    undefined,
    'connect',
    { method: 'backlink' },
    undefined,
    true,
  );

  // Nothing was handed back: the sign-in named the account, and its profile was read.
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'complete');

  // A reader is sent to the proof, and it is read again later: both need the address.
  assert.equal(
    (await f.service.read(id)).attestations!.external[1]!.artifactUrl,
    'https://github.com/known-alice',
  );
});

test('a link not there yet leaves the flow waiting, and it can still be handed back', async () => {
  const f = fixture();

  await f.signIn();

  const flow = await f.service.start(
    alice,
    undefined,
    'connect',
    { method: 'backlink' },
    undefined,
    true,
  );

  // Not a failure: the holder has not been told what to publish until now.
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'pending');

  f.backlink.pages.add('https://github.com/known-alice');
  await f.service.submit(flow.flowId, flow.binding, 'known-alice');

  const read = await f.service.flow(flow.flowId, flow.binding);

  assert.equal(read.phase, 'complete');
  // Kept as the address that was read, never as the username that named it.
  assert.equal(read.artifact, 'https://github.com/known-alice');
});

test('the same method again makes a record of its own, as it always did', async () => {
  const f = fixture();
  const first = await f.signIn();
  const second = await f.signIn();

  assert.notEqual(first, second);
  assert.equal((await f.service.read(second)).attestations!.external.length, 1);
});

test('a renewal by another method adds it, and by the same one keeps it in place', async () => {
  const f = fixture();
  const id = await f.signIn();

  await f.linkBack('renew', id);
  f.advance(10);
  await f.linkBack('renew', id);

  const evidence = await f.service.read(id);

  assert.equal(evidence.attestations!.external[0].method, 'oauth');
  assert.equal(evidence.attestations!.external.length, 2);
  assert.equal(evidence.attestations!.external[1]!.confirmedAt, 1000010);
});

test('a record renewed at a differently written address is reread at that address', async () => {
  const f = fixture();
  const id = (await f.linkBack()).id!;

  f.advance(10);
  await f.linkBack('renew', id, 'https://github.com/known-alice');

  // The renewal names the account as it read it, so a reread of the new proof agrees.
  assert.equal((await f.service.read(id, alice)).external.id, 'https://github.com/known-alice');

  f.advance(2000);
  assert.equal(await f.service.recheck(), 1);
});

test('an address that changed hands cannot remove the record it proved', async () => {
  const f = fixture();

  // Proved by a link back, so the record knows the address and not GitHub's number.
  const id = (await f.linkBack()).id!;

  // Whoever holds the username next signs in with it. The profile is the same address;
  // the account GitHub issued is not shown to be the same one.
  for (const kind of ['revoke', 'share-revoke'] as const) {
    const flow = await f.service.start(undefined, id, kind, {
      provider: 'github',
      method: 'oauth',
    });

    await f.service
      .callback(new URL(flow.authorizationUrl!).searchParams.get('state')!, flow.binding, 'code')
      .catch(() => undefined);

    assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'failed', kind);
  }

  assert.equal((await f.service.read(id, alice)).status, 'verified');
});

test("a record proved by a link to the subject's old address is not joined", async () => {
  const f = fixture();
  const id = (await f.linkBack()).id!;

  // The link back named /users/1. Signing in for the subject at its new address must not
  // add to that record, where the old proof would go on standing for the new address.
  const signedIn = await f.signIn(moved);

  assert.notEqual(signedIn, id);
  assert.equal((await f.service.read(id, alice)).local.profileUrl, alice.profileUrl);
});

test('joining at a new address drops the additional proofs that named the old one', async () => {
  // A method whose proof is a token minted per flow, which names no subject.
  const notes = { ...fakeArtifactProvider(), id: 'github', name: 'GitHub' };
  const f = fixture([notes]);
  const id = await f.signIn();

  await f.linkBack('renew', id);

  const flow = await f.service.start(moved, undefined, 'connect', {
    provider: 'github',
    method: 'gist',
  });

  notes.artifacts.set('https://notes.test/alice', flow.expect!);
  await f.service.submit(flow.flowId, flow.binding, 'https://notes.test/alice');

  assert.equal(await f.service.approve(flow.flowId, flow.binding, moved, 'public'), id);

  const evidence = await f.service.read(id);

  assert.equal(evidence.local.profileUrl, moved.profileUrl);

  assert.deepEqual(
    evidence.attestations!.external.map((a) => a.method),
    ['oauth', 'gist'],
  );

  // Nothing is left to confirm the link to where the subject used to be.
  const calls = f.backlink.calls;

  f.advance(2000);
  await f.service.recheck();
  assert.equal(f.backlink.calls, calls);
});

test('a different account on the same provider is not joined by its profile alone', async () => {
  const f = fixture();

  await f.signIn();
  f.oauth.externalId = '99';

  // Both ids were issued by GitHub, so they settle it whatever the profiles say.
  const other = await f.signIn();

  assert.equal((await f.service.read(other)).attestations!.external.length, 1);
  assert.equal((await f.service.mine(alice)).length, 2);
});

test('an additional proof is reread, and leaves the record while it goes unread', async () => {
  const f = fixture();
  const id = await f.signIn();

  await f.linkBack('renew', id);
  f.advance(2000);

  const calls = f.backlink.calls;

  assert.equal(await f.service.recheck(), 1);
  assert.equal(f.backlink.calls, calls + 1);

  // Taken down: rereads fail, and once stale it leaves the record.
  f.backlink.pages.clear();
  f.advance(6000);
  assert.equal(await f.service.recheck(), 0);

  const evidence = await f.service.read(id);

  assert.equal(evidence.attestations!.external.length, 1);
  // The main method is untouched, so the record itself still stands.
  assert.equal(evidence.status, 'verified');
});

test('a standing proof is not offered for removal from the external side', async () => {
  const f = fixture();
  const id = await f.signIn();

  await assert.rejects(
    f.service.start(undefined, id, 'revoke', { provider: 'github', method: 'backlink' }),
    /Unavailable/,
  );

  // Without a choice, removal uses the method the record was first shown by.
  const removal = await f.service.start(undefined, id, 'revoke');

  assert.ok(removal.authorizationUrl);
});

test('a flow stays in the namespace of the record it acts on', async () => {
  const notes = fakeArtifactProvider();

  const service = new VerilyService({
    storage: new MemoryStorage(),
    providers: [fakeProvider(), notes],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
  });

  const flow = await service.start(alice);
  const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

  await service.callback(state, flow.binding, 'code');
  const id = (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  await assert.rejects(service.start(alice, id, 'renew', { provider: 'notes' }), /Unavailable/);
});

test('each method is configured once', () => {
  assert.throws(
    () =>
      new VerilyService({
        storage: new MemoryStorage(),
        providers: [fakeProvider(), fakeProvider()],
        baseUrl: 'https://site.test/api/verily',
        siteName: 'Site',
        verifierName: 'Site',
        profileOrigins: ['https://site.test'],
      }),
    /once/,
  );
});
