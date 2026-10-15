import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstance, registry } from '../src/instance/index.js';
import { open, sign, Sites, type Site } from '../src/instance/sites.js';
import { hash } from '../src/server/service.js';
import { fakeProvider, MemoryStore } from './helpers.js';

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
  const store = new MemoryStore();

  const instance = createInstance({
    store,
    origin: 'https://instance.test',
    siteName: 'Instance Site',
    owner: { label: 'owner', reference: 'the owner', profileUrl: 'https://owner.test/' },
    ownerKey: 'k'.repeat(43),
    reportUrl: 'mailto:reports@instance.test',
    providers: [fakeProvider(), { ...fakeProvider(), id: 'discord', name: 'Discord' }],
    signingKey: false,
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
    dns: {
      fetch: async () => {
        throw new Error('offline');
      },
    },
  });

  await new Sites(store, new Map()).register(site, {
    kind: 'key',
    hash: hash(dashboardKey),
    addedAt: 0,
  });

  const request = (path: string, init: RequestInit = {}) =>
    instance.handle(
      new Request(`https://instance.test${path}`, {
        ...init,
        headers: {
          origin: 'https://instance.test',
          'content-type': 'application/x-www-form-urlencoded',
          ...init.headers,
        },
      }),
    );

  const post = (path: string, fields: Record<string, string | string[]>, cookie = '') =>
    request(path, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      body: new URLSearchParams(
        Object.entries(fields).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((one) => [name, one]),
        ),
      ).toString(),
    });

  const login = async (id = 'managed', key = dashboardKey) => {
    const response = await post('/dashboard/login', { id, key });

    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };

  return { store, request, post, login };
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

  await store.put('site/operators/managed', []);
  assert.match(await (await request('/dashboard', { headers: { cookie } })).text(), /Sign in/);

  for (let i = 0; i < 9; i++) await login('managed', 'x'.repeat(43));

  assert.equal((await login('managed', 'x'.repeat(43))).response.status, 429);
});

test('a key replaced for a routine change keeps the old one working for a day', async () => {
  const { store, request, post, login } = await managed();
  const { cookie } = await login();

  const read = async (key: string) =>
    (
      await request('/site/connections', {
        headers: {
          authorization: `Bearer ${sign(key, {
            site: 'managed',
            op: 'read',
            ids: ['someone'],
            exp: Math.floor(Date.now() / 1000) + 60,
          })}`,
        },
      })
    ).status;

  const shown = await (await post('/dashboard/rotate', { keep: 'day' }, cookie)).text();
  const newKey = shown.match(/<pre><code>([A-Za-z0-9_-]{43})</)![1]!;
  const stored = (await store.get<Site>('site/registered/managed'))!;

  assert.equal(stored.key, newKey);
  assert.equal(stored.previousKey, siteKey);
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
  const { store, request, post, login } = await managed();
  const { cookie } = await login();

  const read = async (key: string) =>
    (
      await request('/site/connections', {
        headers: {
          authorization: `Bearer ${sign(key, {
            site: 'managed',
            op: 'read',
            ids: ['someone'],
            exp: Math.floor(Date.now() / 1000) + 60,
          })}`,
        },
      })
    ).status;

  const replace = async (keep: string) =>
    (await (await post('/dashboard/rotate', { keep }, cookie)).text()).match(
      /<pre><code>([A-Za-z0-9_-]{43})</,
    )![1]!;

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

  assert.equal((await post('/dashboard/previous-key', {}, cookie)).status, 303);
  assert.equal(await read(second), 404);
  assert.equal(await read(third), 200);

  assert.doesNotMatch(
    await (await request('/dashboard', { headers: { cookie } })).text(),
    /Stop accepting the old key/,
  );

  // Without a session, the key is left alone.
  assert.equal((await post('/dashboard/rotate', { keep: 'none' })).status, 403);
  assert.equal((await post('/dashboard/previous-key', {})).status, 403);
  assert.equal(await read(third), 200);
});
