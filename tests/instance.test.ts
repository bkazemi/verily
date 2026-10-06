import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerily, type Ended, type ServerOptions } from '../src/server/index.js';
import type { LocalAccount } from '../src/core/index.js';
import { alice, fakeArtifactProvider, fakeProvider, MemoryStorage } from './helpers.js';

/** One instance serving a site of its own and a subject that belongs to another. */
const member: LocalAccount = {
  id: 'partner:123',
  kind: 'account',
  label: 'Alice',
  reference: 'alice',
  profileUrl: 'https://partner.test/u/alice',
  siteName: 'Partner',
};

const origin = 'https://verifier.test';

function fixture(options: Partial<ServerOptions> = {}) {
  const storage = new MemoryStorage();

  const app = createVerily({
    storage,
    providers: [fakeProvider(), fakeArtifactProvider()],
    baseUrl: `${origin}/api/verily`,
    siteName: 'Instance Site',
    verifierName: 'verifier.test',
    profileOrigins: ['https://site.test', 'https://partner.test'],
    reportUrl: 'mailto:reports@verifier.test',
    authenticate: async (r) =>
      r.headers.get('cookie')?.includes('local=member')
        ? member
        : r.headers.get('cookie')?.includes('local=alice')
          ? alice
          : undefined,
    ...options,
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.handle(new Request(`${origin}/api/verily${path}`, { redirect: 'manual', ...init }));

  const post = (path: string, body: string, cookie: string) =>
    request(path, { method: 'POST', headers: { origin, cookie }, body });

  /** A redirect flow up to its approval page. Returns the flow's path and cookies. */
  async function approval(who: string, start = 'kind=connect&provider=github&method=oauth') {
    const begun = await post('/sessions', start, `local=${who}`);

    assert.equal(begun.status, 303);
    const flowCookie = begun.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(begun.headers.get('location')!).searchParams.get('state')!;

    const callback = await request(`/callback?state=${state}&code=ok`, {
      headers: { cookie: flowCookie },
    });

    const path = callback.headers.get('location')!.replace('/api/verily', '');

    return { path, cookie: `${flowCookie}; local=${who}`, id: path.split('/').at(-1)! };
  }

  return { app, storage, request, post, approval };
}

test('a subject with its own site is described by that site, and the instance only as verifier', async () => {
  const f = fixture();
  const pages: string[] = [];

  const verify = await f.request('/verify', { headers: { cookie: 'local=member' } });

  pages.push(await verify.text());
  assert.match(pages.at(-1)!, /Account on Partner/);

  const methods = (await (
    await f.request('/methods', { headers: { cookie: 'local=member' } })
  ).json()) as { siteName: string; local: { heading: string } };

  pages.push(JSON.stringify(methods));
  assert.equal(methods.siteName, 'Partner');
  assert.equal(methods.local.heading, 'Account on Partner');

  // The line a holder publishes names the site they are proving an account for.
  const artifact = await f.post(
    '/sessions',
    'kind=connect&provider=notes&method=gist',
    'local=member',
  );

  const artifactCookie = artifact.headers.get('set-cookie')!.split(';')[0]!;

  const instructions = await f.request(
    artifact.headers.get('location')!.replace('/api/verily', ''),
    { headers: { cookie: `${artifactCookie}; local=member` } },
  );

  pages.push(await instructions.text());
  assert.match(pages.at(-1)!, /Verily proof for Partner: /);

  const flow = await f.approval('member');
  const review = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  pages.push(await review.text());
  assert.match(pages.at(-1)!, /Account on Partner/);
  assert.match(pages.at(-1)!, /Partner receives the result\. Verified via verifier\.test\./);
  assert.match(pages.at(-1)!, /Only Partner can read this link, and it chooses who there sees it/);
  assert.match(pages.at(-1)!, /Public: anyone can view both sides of this link, on Partner or/);
  assert.ok(!pages.at(-1)!.includes('sharing link'));

  const approved = await f.post(
    `${flow.path}/approve`,
    'action=approve&visibility=public',
    flow.cookie,
  );

  pages.push(await approved.text());

  const [evidence] = await f.app.service.mine(member);

  assert.equal(evidence!.siteName, 'Partner');
  assert.equal(evidence!.verifierName, 'verifier.test');
  // The site's name is said once, at the top level, not again inside the subject.
  assert.equal('siteName' in evidence!.local, false);

  const json = await f.request(`/connections/${evidence!.id}?format=json`);

  pages.push(await json.text());
  assert.match(pages.at(-1)!, /"siteName":"Partner"/);

  const html = await f.request(`/connections/${evidence!.id}`);

  pages.push(await html.text());
  assert.match(pages.at(-1)!, /Account on Partner/);

  for (const page of pages) assert.ok(!page.includes('Instance Site'), page);

  // A subject naming no site of its own keeps the instance's name, as it always did.
  const own = await f.approval('alice');

  assert.match(
    await (await f.request(own.path, { headers: { cookie: own.cookie } })).text(),
    /<p class="who">Instance Site<\/p>.*Instance Site receives the result/s,
  );

  assert.throws(
    () => f.app.service.validateLocal({ ...member, siteName: '' }),
    /Invalid local subject site name/,
  );
});

test('an instance without context or finish ends flows on its own result page', async () => {
  const f = fixture();
  const flow = await f.approval('member');

  const approved = await f.post(
    `${flow.path}/approve`,
    'action=approve&visibility=unlisted',
    flow.cookie,
  );

  assert.equal(approved.status, 200);
  assert.match(await approved.text(), /data-outcome="complete"/);

  const stored = await f.storage.transaction((tx) => tx.get('flows', flow.id));

  assert.equal(stored!.context, undefined);
  assert.equal(stored!.result!.phase, 'complete');
  assert.equal((await f.request(flow.path, { headers: { cookie: flow.cookie } })).status, 200);
});

/**
 * Stands in for a site taking results back: it applies the first result for a transaction
 * and accepts only that same one again, which is all a retry may ever deliver.
 */
function site() {
  const held = new Map<string, string>();

  return {
    held,
    receive(url: string) {
      const result = new URL(url).searchParams;
      const txn = result.get('txn')!;
      const value = result.toString();

      if (held.has(txn) && held.get(txn) !== value) throw new Error('A different result');

      held.set(txn, value);
    },
  };
}

/** A finish that sends a site's flows back with everything the stored result says. */
const returning =
  (calls: Ended[] = [], fail = () => false) =>
  async (ended: Ended) => {
    calls.push(ended);

    if (fail()) throw new Error('Signing failed');

    if (!ended.context) return undefined;

    return `https://partner.test/verily/return?${new URLSearchParams({
      txn: ended.context.txn!,
      id: ended.local!.id,
      kind: ended.result.kind,
      phase: ended.result.phase,
      connection: ended.result.connectionId ?? '',
      visibility: ended.result.visibility ?? '',
      at: String(ended.result.finishedAt),
    })}`;
  };

/** Context for whoever is signed in as the site's member, as a site session would give. */
const context = async (r: Request) =>
  r.headers.get('cookie')?.includes('local=member') ? { site: 'partner', txn: 't1' } : undefined;

test('removing a link from the external side never carries a site session context', async () => {
  const calls: Ended[] = [];

  const f = fixture({
    context,
    finish: returning(calls),
    formTargets: ['https://partner.test'],
  });

  const connected = await f.approval('member');

  await f.post(`${connected.path}/approve`, 'action=approve&visibility=public', connected.cookie);
  const [record] = await f.app.service.mine(member);

  // The holder is still signed into the site, and that session's cookie goes with every request.
  const removal = await f.approval('member', `kind=revoke&connectionId=${record!.id}`);
  const stored = await f.storage.transaction((tx) => tx.get('flows', removal.id));

  assert.equal(stored!.kind, 'revoke');
  assert.equal(stored!.context, undefined);

  const removed = await f.post(
    `${removal.path}/approve`,
    'action=approve&visibility=unlisted',
    removal.cookie,
  );

  assert.equal(removed.status, 200);
  assert.match(await removed.text(), /data-outcome="complete"/);
  assert.equal(calls.at(-1)!.context, undefined);
  assert.equal((await f.app.service.mine(member))[0]!.status, 'revoked');
});

test('a finish that throws is recovered by loading the result page again', async () => {
  const calls: Ended[] = [];
  let failures = 1;

  const f = fixture({
    context,
    finish: returning(calls, () => failures-- > 0),
    formTargets: ['https://partner.test'],
  });

  const target = site();
  const flow = await f.approval('member');

  const review = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  assert.match(
    review.headers.get('content-security-policy')!,
    /form-action 'self' https:\/\/provider\.test https:\/\/partner\.test/,
  );

  const failed = await f.post(
    `${flow.path}/approve`,
    'action=approve&visibility=public',
    flow.cookie,
  );

  assert.equal(failed.status, 500);

  const retried = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  assert.equal(retried.status, 303);
  target.receive(retried.headers.get('location')!);

  // The connection changes after the flow ended; the result the flow reports does not.
  const [record] = await f.app.service.mine(member);

  assert.match(retried.headers.get('location')!, /phase=complete/);
  assert.match(retried.headers.get('location')!, /visibility=public/);
  await f.app.service.revoke(record!.id, member);

  const again = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  assert.equal(again.headers.get('location'), retried.headers.get('location'));
  target.receive(again.headers.get('location')!);
  assert.equal(target.held.size, 1);
  assert.equal(calls.length, 3);
});

test('a lost response is recovered with the same result, and a cancelled flow returns too', async () => {
  const f = fixture({ context, finish: returning(), formTargets: ['https://partner.test'] });
  const target = site();
  const flow = await f.approval('member');

  // The first response never reaches the browser.
  const lost = await f.post(
    `${flow.path}/approve`,
    'action=approve&visibility=unlisted',
    flow.cookie,
  );

  assert.equal(lost.status, 303);

  const loaded = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  assert.equal(loaded.headers.get('location'), lost.headers.get('location'));
  target.receive(loaded.headers.get('location')!);
  target.receive(lost.headers.get('location')!);
  assert.equal(target.held.size, 1);
  assert.match(target.held.get('t1')!, /kind=connect&phase=complete/);
  assert.match(target.held.get('t1')!, /visibility=unlisted/);

  const cancelled = await f.approval('member');

  const answer = await f.post(
    `${cancelled.path}/approve`,
    'action=cancel&visibility=unlisted',
    cancelled.cookie,
  );

  assert.match(answer.headers.get('location')!, /phase=cancelled/);

  // A flow the holder abandons at the provider ends there, and returns from there.
  const declined = await f.post('/sessions', 'kind=connect', 'local=member');
  const declinedCookie = declined.headers.get('set-cookie')!.split(';')[0]!;
  const state = new URL(declined.headers.get('location')!).searchParams.get('state')!;

  const callback = await f.request(`/callback?state=${state}&error=access_denied`, {
    headers: { cookie: declinedCookie },
  });

  const page = await f.request(callback.headers.get('location')!.replace('/api/verily', ''), {
    headers: { cookie: declinedCookie },
  });

  assert.match(page.headers.get('location')!, /phase=cancelled/);
});

test('a subject is offered and held to the providers chosen for it', async () => {
  const f = fixture({
    providersFor: (local) => (local.siteName === 'Partner' ? ['notes'] : undefined),
  });

  const cookie = 'local=member';
  const page = await (await f.request('/verify', { headers: { cookie } })).text();

  assert.match(page, /<h1>Verify with Notes<\/h1>/);
  assert.ok(!page.includes('GitHub'));

  const methods = (await (await f.request('/methods', { headers: { cookie } })).json()) as {
    methods: { provider: string }[];
  };

  assert.deepEqual(
    methods.methods.map((m) => m.provider),
    ['notes'],
  );

  assert.equal((await f.post('/sessions', 'kind=connect&provider=github', cookie)).status, 404);
  assert.equal((await f.post('/sessions', 'kind=connect&method=oauth', cookie)).status, 404);

  // Nothing asked for is the first one permitted, which here is not the first configured.
  const started = await f.post('/sessions', 'kind=connect', cookie);

  assert.match(started.headers.get('location')!, /\/api\/verily\/flows\//);

  // A record made before its provider was taken away can no longer be renewed by it.
  const open = fixture();
  const flow = await open.approval('member');

  await open.post(`${flow.path}/approve`, 'action=approve&visibility=public', flow.cookie);
  const [record] = await open.app.service.mine(member);

  const narrowed = createVerily({
    ...open.app.service.options,
    reportUrl: 'mailto:reports@verifier.test',
    authenticate: async () => member,
    providersFor: () => ['notes'],
  });

  const renew = await narrowed.handle(
    new Request(`${origin}/api/verily/sessions`, {
      method: 'POST',
      headers: { origin },
      body: `kind=renew&connectionId=${record!.id}`,
    }),
  );

  assert.equal(renew.status, 404);

  // Whoever holds the external account can still remove it, whatever the subject may use.
  const removal = await narrowed.handle(
    new Request(`${origin}/api/verily/sessions`, {
      method: 'POST',
      headers: { origin },
      body: `kind=revoke&connectionId=${record!.id}`,
    }),
  );

  assert.equal(removal.status, 303);

  // Listed in the other order than configured, the list's order is the one that holds.
  const reversed = fixture({ providersFor: () => ['notes', 'github', 'notes', 'absent'] });

  const ordered = (await (await reversed.request('/methods', { headers: { cookie } })).json()) as {
    methods: { provider: string }[];
  };

  assert.deepEqual(
    ordered.methods.map((m) => m.provider),
    ['notes', 'github'],
  );

  const listed = await (await reversed.request('/verify', { headers: { cookie } })).text();

  assert.ok(listed.indexOf('Publish a proof on Notes') < listed.indexOf('Sign in with GitHub'));

  assert.match(
    (await reversed.post('/sessions', 'kind=connect', cookie)).headers.get('location')!,
    /\/api\/verily\/flows\//,
  );

  // A subject nothing was chosen for keeps every method.
  assert.match(
    await (await f.request('/verify', { headers: { cookie: 'local=alice' } })).text(),
    /Sign in with GitHub/,
  );
});

test('a subject held to one visibility is not offered the other, and cannot ask for it', async () => {
  const f = fixture({
    visibilityFor: (local) => (local.siteName === 'Partner' ? ['unlisted'] : undefined),
  });

  const flow = await f.approval('member');
  const page = await (await f.request(flow.path, { headers: { cookie: flow.cookie } })).text();

  // The in-page dialog is told the same, so it neither offers nor sends the other.
  const view = (await (
    await f.request(`${flow.path}?format=json`, { headers: { cookie: flow.cookie } })
  ).json()) as { visibilities: string[] };

  assert.deepEqual(view.visibilities, ['unlisted']);
  assert.match(page, /<input type="hidden" name="visibility" value="unlisted">/);
  assert.match(page, /Unlisted\. Only Partner can read this link/);
  assert.ok(!page.includes('type="radio"'));
  assert.ok(!page.includes('value="public"'));

  // Asked for by hand, the other visibility is refused and the flow is still there to approve.
  assert.equal(
    (await f.post(`${flow.path}/approve`, 'action=approve&visibility=public', flow.cookie)).status,
    404,
  );

  assert.equal((await f.app.service.mine(member)).length, 0);
  await f.post(`${flow.path}/approve`, 'action=approve&visibility=unlisted', flow.cookie);

  const [record] = await f.app.service.mine(member);

  assert.equal(record!.visibility, 'unlisted');

  // With one visibility there is nothing to change it to, by page or by form.
  assert.equal(
    (await f.request(`/visibility/${record!.id}`, { headers: { cookie: 'local=member' } })).status,
    404,
  );

  assert.equal(
    (await f.post('/sessions', `kind=visibility&connectionId=${record!.id}`, 'local=member'))
      .status,
    404,
  );

  // Renewing carries a visibility it never applies, so it is not held to the list.
  const renewal = await f.approval('member', `kind=renew&connectionId=${record!.id}`);

  assert.equal(
    (await f.post(`${renewal.path}/approve`, 'action=approve&visibility=unlisted', renewal.cookie))
      .status,
    200,
  );

  // A subject nothing was chosen for still chooses, public included.
  const free = await f.approval('alice');
  const choice = await (await f.request(free.path, { headers: { cookie: free.cookie } })).text();

  assert.match(choice, /type="radio" name="visibility" value="public"/);

  assert.equal(
    (await f.post(`${free.path}/approve`, 'action=approve&visibility=public', free.cookie)).status,
    200,
  );
});

test('a flow that joins a record is recorded with that record, and sets no visibility', async () => {
  const artifact = { ...fakeArtifactProvider(), id: 'github', name: 'GitHub' };

  const f = fixture({
    providers: [fakeProvider(), artifact],
    visibilityFor: () => ['unlisted'],
  });

  // A record first shown by signing in, then a second flow showing the same account another way.
  const first = await f.approval('member');

  await f.post(`${first.path}/approve`, 'action=approve&visibility=unlisted', first.cookie);
  const [record] = await f.app.service.mine(member);

  const begun = await f.post(
    '/sessions',
    'kind=connect&provider=github&method=gist',
    'local=member',
  );

  const cookie = `${begun.headers.get('set-cookie')!.split(';')[0]!}; local=member`;
  const path = begun.headers.get('location')!.replace('/api/verily', '');
  const stored = await f.storage.transaction((tx) => tx.get('flows', path.split('/').at(-1)!));

  artifact.artifacts.set('https://notes.test/proof', stored!.expect!);
  await f.post(`${path}/submit`, 'artifact=https://notes.test/proof', cookie);

  // Whether it joins is decided in the transaction that records it, so no record can go
  // away between the two and leave a visibility to be chosen by whoever approves.
  assert.match(await (await f.request(path, { headers: { cookie } })).text(), /<p>complete<\/p>/);

  // An approval sent anyway finds the flow ended, and changes nothing.
  await f.post(`${path}/approve`, 'action=approve&visibility=public', cookie);

  const after = await f.app.service.mine(member);

  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, record!.id);
  assert.equal(after[0]!.visibility, 'unlisted');
});

test('a form target must be an origin', () => {
  assert.throws(
    () => fixture({ formTargets: ['https://partner.test/return'] }),
    /A form target must be an origin/,
  );
});
