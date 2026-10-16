import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../src/instance/index.js';
import { open, Sites, type Site } from '../src/instance/sites.js';
import { hash } from '../src/server/service.js';
import { fakeProvider, memoryInstance, offlineDns, readStatus } from './helpers.js';

const dashboardKey = 'd'.repeat(43);
const siteKey = 's'.repeat(43);

const site: Site = {
  id: 'managed',
  name: 'managed.test',
  origin: 'https://managed.test',
  authorizeUrl: 'https://managed.test/authorize',
  returnUrl: 'https://managed.test/return',
  key: siteKey,
};

/** An instance serving one pinned site, and one stored site with a dashboard key. */
async function managed() {
  const { store, request, post } = memoryInstance({
    providers: [fakeProvider(), { ...fakeProvider(), id: 'discord', name: 'Discord' }],
    sites: registry(
      [
        {
          id: 'pinned',
          name: 'pinned.test',
          origin: 'https://pinned.test',
          authorizeUrl: 'https://pinned.test/authorize',
          returnUrl: 'https://pinned.test/return',
        },
      ],
      { SITE_PINNED_KEY: 'p'.repeat(43) },
    ),
    dns: offlineDns,
  });

  await new Sites(store, new Map()).register(site, {
    kind: 'key',
    hash: hash(dashboardKey),
    addedAt: 0,
  });

  const login = async (id = 'managed', key = dashboardKey) => {
    const response = await post('/dashboard/login', { id, key });

    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };

  /**
   * Sends the rotate form as the dashboard page has it, with the key it replaces, and
   * confirms it.
   */
  const rotate = async (cookie: string, keep: string) => {
    const page = await (await request('/dashboard', { headers: { cookie } })).text();
    const from = page.match(/name="from" value="([^"]+)"/)![1]!;

    return post('/dashboard/rotate', { keep, from, confirm: 'yes' }, cookie);
  };

  return { store, request, post, login, rotate };
}

test('an operator signs in with the site id and dashboard key, and changes the settings', async () => {
  const { store, request, post, login } = await managed();

  assert.equal((await login('managed', 'x'.repeat(43))).response.status, 403);

  // A site in SITES has no operators, so nobody signs in to it here.
  assert.equal((await login('pinned', dashboardKey)).response.status, 403);

  const { response, cookie } = await login();

  assert.equal(response.status, 303);
  assert.match(cookie, /^verily_dashboard=/);

  const page = await (await request('/dashboard', { headers: { cookie } })).text();

  assert.match(page, /managed\.test/);
  assert.match(page, /<dt>Status<\/dt><dd>Served · DNS record not checked yet<\/dd>/);

  const saved = await post(
    '/dashboard/settings',
    {
      authorizeUrl: 'https://managed.test/v2/authorize',
      returnUrl: 'https://managed.test/v2/return',
      provider: ['discord', 'unknown'],
      visibility: ['unlisted'],
    },
    cookie,
  );

  assert.equal(saved.status, 303);

  const stored = (await store.get<Site>('site/registered/managed'))!;

  assert.equal(stored.authorizeUrl, 'https://managed.test/v2/authorize');
  assert.deepEqual(stored.providers, ['discord']);
  assert.deepEqual(stored.visibility, ['unlisted']);
  assert.equal(stored.key, siteKey);

  // Every provider and both visibilities are kept as no list at all.
  await post(
    '/dashboard/settings',
    {
      authorizeUrl: stored.authorizeUrl,
      returnUrl: stored.returnUrl,
      provider: ['github', 'discord'],
      visibility: ['public', 'unlisted'],
    },
    cookie,
  );

  const widened = (await store.get<Site>('site/registered/managed'))!;

  assert.equal(widened.providers, undefined);
  assert.equal(widened.visibility, undefined);

  // URLs off the site's origin, or nothing chosen, are refused and change nothing.
  const elsewhere = await post(
    '/dashboard/settings',
    {
      authorizeUrl: 'https://elsewhere.test/authorize',
      returnUrl: stored.returnUrl,
      provider: ['github'],
      visibility: ['public'],
    },
    cookie,
  );

  assert.equal(elsewhere.status, 400);

  const empty = await post(
    '/dashboard/settings',
    { authorizeUrl: stored.authorizeUrl, returnUrl: stored.returnUrl },
    cookie,
  );

  assert.equal(empty.status, 400);
  assert.deepEqual(await store.get<Site>('site/registered/managed'), widened);

  // Without a session, nothing is changed.
  assert.equal(
    (await post('/dashboard/settings', { authorizeUrl: 'https://managed.test/x' })).status,
    403,
  );

  // Signing out ends the session.
  await post('/dashboard/logout', {}, cookie);
  assert.match(await (await request('/dashboard', { headers: { cookie } })).text(), /Sign in/);
});

test('a session ends once its dashboard key is removed, and sign-ins are limited', async () => {
  const { store, request, login } = await managed();
  const { cookie } = await login();

  // A suspended site says so, and what to publish to be served again.
  await store.put('site/dns/managed', { attemptedAt: 0, checkedAt: 0, absentSince: 0 });

  const suspended = await (await request('/dashboard', { headers: { cookie } })).text();

  assert.match(suspended, /<dd>Suspended since Jan 1, 1970<\/dd>/);
  assert.match(suspended, /no longer has <code>verily-verifier=instance\.test<\/code>/);
  assert.match(suspended, /Otherwise the site is deleted on Jan 31, 1970\./);

  await store.put('site/operators/managed', []);
  assert.match(await (await request('/dashboard', { headers: { cookie } })).text(), /Sign in/);

  for (let i = 0; i < 9; i++) await login('managed', 'x'.repeat(43));

  assert.equal((await login('managed', 'x'.repeat(43))).response.status, 429);
});

test('a key replaced for a routine change keeps the old one working for a day', async () => {
  const { store, request, post, login, rotate } = await managed();
  const { cookie } = await login();

  const read = (key: string) => readStatus(request, 'managed', key);

  const shown = await (await rotate(cookie, 'day')).text();

  // The key is on a page of its own, not among the dashboard's forms.
  assert.match(shown, /<h1>New site key<\/h1>/);
  assert.match(shown, /The old key keeps working until /);
  assert.doesNotMatch(shown, /<form/);

  const newKey = shown.match(/<pre><code>([A-Za-z0-9_-]{43})</)![1]!;
  const stored = (await store.get<Site>('site/registered/managed'))!;

  assert.equal(stored.key, newKey);
  assert.equal(stored.previousKey, siteKey);

  // Replacing it again during the overlap asks first, and says the older key stops now.
  const from = (await (await request('/dashboard', { headers: { cookie } })).text()).match(
    /name="from" value="([^"]+)"/,
  )![1]!;

  const asked = await (await post('/dashboard/rotate', { keep: 'day', from }, cookie)).text();

  assert.match(asked, /<h1>Replace the key\?<\/h1>/);
  assert.match(asked, /The older key still accepted from the last replacement stops working now\./);
  assert.equal((await store.get<Site>('site/registered/managed'))!.key, newKey);
  assert.equal(await read(newKey), 200);
  assert.equal(await read(siteKey), 200);

  // Settings saved during the overlap keep the old key accepted.
  await post(
    '/dashboard/settings',
    {
      authorizeUrl: stored.authorizeUrl,
      returnUrl: stored.returnUrl,
      provider: ['github'],
      visibility: ['public'],
    },
    cookie,
  );

  assert.equal((await store.get<Site>('site/registered/managed'))!.previousKey, siteKey);

  // A result is signed with the key that opened its session, here the old key, which was
  // the site's key when the handoff arrived. Without one, it is signed with the new key.
  const sites = new Sites(store, new Map());

  await sites.refresh();

  const signed = (signer?: string) =>
    new URL(
      sites.returnUrl(
        sites.sites.get('managed')!,
        { id: 'managed:someone', label: 'someone', reference: 'someone' },
        'txn',
        { operation: 'connect', outcome: 'cancelled', finishedAt: Date.now() },
        signer,
      ),
    ).searchParams.get('result')!;

  assert.ok(open(siteKey, signed(hash(siteKey))));
  assert.ok(open(newKey, signed(hash(newKey))));
  assert.ok(open(newKey, signed()));

  // Once the day is over, only the new key works.
  await store.put('site/registered/managed', {
    ...(await store.get<Site>('site/registered/managed'))!,
    previousUntil: Date.now() - 1,
  });

  assert.equal(await read(siteKey), 404);
  assert.equal(await read(newKey), 200);
  await sites.refresh();
  assert.ok(open(newKey, signed(hash(siteKey))));
});

test('a key replaced now, or an overlap stopped early, leaves only the new key', async () => {
  const { store, request, post, login, rotate } = await managed();
  const { cookie } = await login();

  const read = (key: string) => readStatus(request, 'managed', key);

  const replace = async (keep: string) =>
    (await (await rotate(cookie, keep)).text()).match(/<pre><code>([A-Za-z0-9_-]{43})</)![1]!;

  // Replaced now, for a key that may have leaked: the old one stops at once.
  const second = await replace('none');

  assert.equal(await read(siteKey), 404);
  assert.equal(await read(second), 200);
  assert.equal((await store.get<Site>('site/registered/managed'))!.previousKey, undefined);

  // Replaced with an overlap, which the operator then ends early.
  const third = await replace('day');

  assert.equal(await read(second), 200);

  assert.match(
    await (await request('/dashboard', { headers: { cookie } })).text(),
    /Stop accepting the old key/,
  );

  // Stopping it asks first, and changes nothing until it is confirmed.
  assert.match(
    await (await post('/dashboard/previous-key', {}, cookie)).text(),
    /<h1>Stop accepting the old key\?<\/h1>/,
  );

  assert.equal(await read(second), 200);

  assert.equal((await post('/dashboard/previous-key', { confirm: 'yes' }, cookie)).status, 303);
  assert.equal(await read(second), 404);
  assert.equal(await read(third), 200);

  assert.doesNotMatch(
    await (await request('/dashboard', { headers: { cookie } })).text(),
    /Stop accepting the old key/,
  );

  // Without a session, the key is left alone.
  assert.equal(
    (await post('/dashboard/rotate', { keep: 'none', from: hash(third), confirm: 'yes' })).status,
    403,
  );

  assert.equal((await post('/dashboard/previous-key', {})).status, 403);
  assert.equal(await read(third), 200);
});

test('a rotate form sent twice replaces the key once', async () => {
  const { store, request, post, login } = await managed();
  const { cookie } = await login();

  const page = await (await request('/dashboard', { headers: { cookie } })).text();
  const from = page.match(/name="from" value="([^"]+)"/)![1]!;

  // Replacing the key at once asks first, and changes nothing until it is confirmed.
  const asked = await (await post('/dashboard/rotate', { keep: 'none', from }, cookie)).text();

  assert.match(asked, /<h1>Replace the key now\?<\/h1>/);
  assert.match(asked, /<input type="hidden" name="confirm" value="yes">/);
  assert.doesNotMatch(asked, /<pre>/);
  assert.equal((await store.get<Site>('site/registered/managed'))!.key, siteKey);

  const confirmed = { keep: 'none', from, confirm: 'yes' };
  const first = await post('/dashboard/rotate', confirmed, cookie);
  const newKey = (await first.text()).match(/<pre><code>([A-Za-z0-9_-]{43})</)![1]!;

  // A reload of that response, or the same form in another tab, changes nothing.
  const again = await post('/dashboard/rotate', confirmed, cookie);

  assert.equal(again.status, 409);
  assert.doesNotMatch(await again.text(), /<pre>/);
  assert.equal((await store.get<Site>('site/registered/managed'))!.key, newKey);

  // A form without the key it replaces changes nothing either.
  assert.equal(
    (await post('/dashboard/rotate', { keep: 'none', confirm: 'yes' }, cookie)).status,
    409,
  );

  assert.equal((await store.get<Site>('site/registered/managed'))!.key, newKey);
});

test('an operator deletes the site once they type its id, and the id is never reused', async () => {
  const { store, request, post, login } = await managed();
  const { cookie } = await login();

  const page = await (await request('/dashboard', { headers: { cookie } })).text();

  assert.match(page, /<form action="\/dashboard\/delete" method="post">/);

  // Anything but the id itself deletes nothing.
  assert.equal((await post('/dashboard/delete', { confirm: 'pinned' }, cookie)).status, 400);
  assert.ok(await store.get('site/registered/managed'));

  // Without a session, nothing is deleted.
  assert.equal((await post('/dashboard/delete', { confirm: 'managed' })).status, 403);

  await store.put('site/dns/managed', { attemptedAt: 0, checkedAt: 0 });

  const deleted = await post('/dashboard/delete', { confirm: 'managed' }, cookie);

  assert.equal(deleted.status, 200);
  assert.match(deleted.headers.get('set-cookie')!, /^verily_dashboard=;.*Max-Age=0/);
  assert.match(await deleted.text(), /<code>managed<\/code>, cannot be registered again/);

  for (const key of ['registered', 'operators', 'dns'])
    assert.equal(await store.get(`site/${key}/managed`), undefined);

  assert.equal((await store.get<{ reason: string }>('site/retired/managed'))!.reason, 'deleted');
  assert.equal((await request('/handoff/request?site=managed&purpose=connect')).status, 404);
  assert.equal((await login()).response.status, 403);
  assert.match(await (await request('/dashboard', { headers: { cookie } })).text(), /Sign in/);

  await assert.rejects(
    new Sites(store, new Map()).register(site, { kind: 'key', hash: 'h', addedAt: 0 }),
    /taken/,
  );
});

test('only a provider the owner has not approved is marked as awaiting approval', async () => {
  const { store, request, post } = memoryInstance({
    providers: [
      fakeProvider(),
      { ...fakeProvider(), id: 'discord', name: 'Discord' },
      { ...fakeProvider(), id: 'youtube', name: 'YouTube' },
    ],
    dns: offlineDns,
  });

  const sites = new Sites(store, new Map());

  await sites.register(site, { kind: 'key', hash: hash(dashboardKey), addedAt: 0 });

  const login = await post('/dashboard/login', { id: 'managed', key: dashboardKey });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

  // A subset leaves GitHub and YouTube unchecked.
  await post(
    '/dashboard/settings',
    {
      authorizeUrl: site.authorizeUrl,
      returnUrl: site.returnUrl,
      provider: ['discord'],
      visibility: ['public', 'unlisted'],
    },
    cookie,
  );

  const page = async () => (await request('/dashboard', { headers: { cookie } })).text();

  const before = await page();

  assert.match(before, /YouTube · awaiting/);
  assert.doesNotMatch(before, /GitHub · awaiting/);
  assert.doesNotMatch(before, /Discord · awaiting/);

  // Approved, YouTube needs nothing more, checked or not.
  await sites.control('managed', (controls) => ({ ...controls, youtubeApprovedAt: Date.now() }));

  assert.doesNotMatch(await page(), /awaiting/);

  // Suspended by the owner, the operator is told how to reach them.
  assert.doesNotMatch(await page(), /contact the instance owner/);
  await sites.control('managed', (controls) => ({ ...controls, suspendedAt: Date.now() }));

  assert.match(
    await page(),
    /<a href="mailto:reports@instance\.test">contact the instance owner<\/a>/,
  );
});
