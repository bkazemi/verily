import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerity, type Ended, type ServerOptions } from '../src/server/index.js';
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

  const app = createVerity({
    storage,
    providers: [fakeProvider(), fakeArtifactProvider()],
    baseUrl: `${origin}/api/verity`,
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
    app.handle(new Request(`${origin}/api/verity${path}`, { redirect: 'manual', ...init }));

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

    const path = callback.headers.get('location')!.replace('/api/verity', '');

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
    artifact.headers.get('location')!.replace('/api/verity', ''),
    { headers: { cookie: `${artifactCookie}; local=member` } },
  );

  pages.push(await instructions.text());
  assert.match(pages.at(-1)!, /Verity proof for Partner: /);

  const flow = await f.approval('member');
  const review = await f.request(flow.path, { headers: { cookie: flow.cookie } });

  pages.push(await review.text());
  assert.match(pages.at(-1)!, /Account on Partner/);
  assert.match(pages.at(-1)!, /Partner receives the result\. Verified via verifier\.test\./);
  assert.match(pages.at(-1)!, /Kept between you and Partner&#39;s records/);
  assert.match(pages.at(-1)!, /Public: Partner shows the badge on your profile/);
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

    return `https://partner.test/verity/return?${new URLSearchParams({
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

  const page = await f.request(callback.headers.get('location')!.replace('/api/verity', ''), {
    headers: { cookie: declinedCookie },
  });

  assert.match(page.headers.get('location')!, /phase=cancelled/);
});

test('a form target must be an origin', () => {
  assert.throws(
    () => fixture({ formTargets: ['https://partner.test/return'] }),
    /A form target must be an origin/,
  );
});
