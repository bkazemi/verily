import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstance, registry } from '../src/instance/index.js';
import { open, sign, Sites, type DnsCheck, type Site } from '../src/instance/sites.js';
import { hash } from '../src/server/service.js';
import { fakeProvider, MemoryStore } from './helpers.js';

const site = (id: string, origin = `https://${id}.test`): Site => ({
  id,
  name: `${id}.test`,
  origin,
  authorizeUrl: `${origin}/authorize`,
  returnUrl: `${origin}/return`,
  key: id[0]!.repeat(43),
});

/** The first operator a new site is saved with. */
const first = { kind: 'key' as const, hash: 'h', addedAt: 0 };

const pinned = () => registry([site('pinned')], { SITE_PINNED_KEY: 'p'.repeat(43) });

test('stored sites are served beside the pinned ones, which win on a clash', async () => {
  const store = new MemoryStore();
  const sites = new Sites(store, pinned());

  await sites.register(site('stored'), first);
  assert.deepEqual([...sites.sites.keys()], ['pinned', 'stored']);

  // A change to a stored site's settings keeps everything else, its key included.
  await sites.update('stored', {
    authorizeUrl: 'https://stored.test/v2/authorize',
    returnUrl: 'https://stored.test/v2/return',
    providers: ['github'],
  });

  assert.equal(sites.sites.get('stored')!.authorizeUrl, 'https://stored.test/v2/authorize');
  assert.deepEqual(sites.sites.get('stored')!.providers, ['github']);
  assert.equal(sites.sites.get('stored')!.key, site('stored').key);

  // URLs off the site's origin are refused.
  await assert.rejects(
    sites.update('stored', {
      authorizeUrl: 'https://elsewhere.test/authorize',
      returnUrl: 'https://stored.test/return',
    }),
    /own origin/,
  );

  // A new site may not take a stored site's id, and a change needs a site to change.
  await assert.rejects(sites.register(site('stored'), first), /is taken/);
  await assert.rejects(sites.update('unknown', site('unknown')), /not registered/);

  // An id that was ever used is never given out again.
  await store.put('site/retired/gone', { retiredAt: 0 });
  await assert.rejects(sites.register(site('gone'), first), /is taken/);

  // The pinned site's id and origin, and another stored site's origin, are refused.
  await assert.rejects(sites.register(site('pinned'), first), /set by the host/);
  await assert.rejects(sites.update('pinned', site('pinned')), /set by the host/);

  await assert.rejects(
    sites.register(site('copy', 'https://pinned.test'), first),
    /already registered/,
  );

  await assert.rejects(
    sites.register(site('copy', 'https://stored.test'), first),
    /already registered/,
  );

  await assert.rejects(sites.register({ ...site('bad'), key: 'short' }, first), /base64url key/);

  await assert.rejects(sites.register(site('plain', 'http://plain.test'), first), /HTTPS origin/);

  // Written past register(), as a host's own tooling might, a clash is still not served.
  await store.put('site/registered/sneaky', site('sneaky', 'https://pinned.test'));
  await sites.refresh();
  assert.deepEqual([...sites.sites.keys()], ['pinned', 'stored']);

  // Pruning leaves registered sites alone.
  const instance = createInstance({
    store,
    origin: 'https://instance.test',
    siteName: 'Instance Site',
    owner: { label: 'owner', reference: 'the owner', profileUrl: 'https://owner.test/' },
    ownerKey: 'k'.repeat(43),
    reportUrl: 'mailto:reports@instance.test',
    providers: [fakeProvider()],
    signingKey: false,
    dns: {
      fetch: async () => {
        throw new Error('offline');
      },
    },
  });

  // A DNS lookup that fails suspends nothing.
  await instance.upkeep();
  assert.ok(await store.get('site/registered/stored'));
  const attempt = await store.get<DnsCheck>('site/dns/stored');

  assert.ok(attempt!.attemptedAt);
  assert.equal(attempt!.checkedAt, undefined);
  assert.equal(attempt!.absentSince, undefined);
});

test('a site written to the store is served on the next request, without a restart', async () => {
  const store = new MemoryStore();

  const instance = createInstance({
    store,
    origin: 'https://instance.test',
    siteName: 'Instance Site',
    owner: { label: 'owner', reference: 'the owner', profileUrl: 'https://owner.test/' },
    ownerKey: 'k'.repeat(43),
    reportUrl: 'mailto:reports@instance.test',
    providers: [fakeProvider()],
    signingKey: false,
    sites: pinned(),
  });

  const handoff = (id: string) =>
    instance.handle(
      new Request(`https://instance.test/handoff/request?site=${id}&purpose=connect`),
    );

  assert.match((await handoff('pinned')).headers.get('location')!, /^https:\/\/pinned\.test\//);
  assert.equal((await handoff('later')).status, 404);

  // Another process registers the site.
  await new Sites(store, new Map()).register(site('later'), first);

  assert.match((await handoff('later')).headers.get('location')!, /^https:\/\/later\.test\//);

  // And removes it.
  await store.delete('site/registered/later');
  assert.equal((await handoff('later')).status, 404);
});

/**
 * An instance open to registration, whose DNS is whatever `records` holds at the time. A
 * name set to null gets no answer.
 */
function registering(records: Map<string, string[] | null>, registration: 'open' | 'off' = 'open') {
  const store = new MemoryStore();

  const instance = createInstance({
    store,
    origin: 'https://instance.test',
    siteName: 'Instance Site',
    owner: { label: 'owner', reference: 'the owner', profileUrl: 'https://owner.test/' },
    ownerKey: 'k'.repeat(43),
    reportUrl: 'mailto:reports@instance.test',
    providers: [fakeProvider()],
    signingKey: false,
    sites: pinned(),
    registration,
    dns: {
      fetch: async (input) => {
        const name = new URL(String(input)).searchParams.get('name')!;

        if (records.get(name) === null) throw new Error('unanswered');

        return Response.json({
          Status: 0,
          Answer: (records.get(name) ?? []).map((value) => ({
            name: `${name}.`,
            type: 16,
            data: `"${value}"`,
          })),
        });
      },
    },
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

  return { store, request, instance };
}

const asked = {
  domain: 'newcomer.test',
  id: 'newcomer',
  authorizeUrl: 'https://newcomer.test/authorize',
  returnUrl: 'https://newcomer.test/return',
};

test('a site registers itself once its DNS shows the claim and names the instance', async () => {
  const records = new Map<string, string[]>();
  const { store, request } = registering(records);

  assert.match(await (await request('/register')).text(), /Register a site/);

  const claimed = await request('/register', {
    method: 'POST',
    body: new URLSearchParams(asked).toString(),
  });

  assert.equal(claimed.status, 303);

  const cookie = claimed.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await request('/register', { headers: { cookie } })).text();
  const code = page.match(/verily-claim=([A-Za-z0-9_-]+)/)![1]!;

  assert.match(page, /verily-verifier=instance\.test/);

  const check = () => request('/register/check', { method: 'POST', headers: { cookie } });

  // Nothing is stored for a claim until its DNS checks out.
  assert.equal((await check()).status, 409);
  assert.equal(await store.get('site/registered/newcomer'), undefined);

  // The claim alone is not enough: the site must also name this instance.
  records.set('_verily.newcomer.test', [`verily-claim=${code}`]);
  assert.match(await (await check()).text(), /verily-verifier record was not/);

  // A malformed claim ahead of the real one, as long in characters but not in bytes.
  records.set('_verily.newcomer.test', [
    `verily-claim=${'é'.repeat(code.length)}`,
    `verily-claim=${code}`,
    'verily-verifier=instance.test',
  ]);

  const registered = await check();
  const shown = await registered.text();

  assert.equal(registered.status, 200);
  assert.match(registered.headers.get('set-cookie')!, /verily_claim=;.*Max-Age=0/);

  const [siteKey, dashboardKey] = [...shown.matchAll(/<pre><code>([A-Za-z0-9_-]{43})</g)].map(
    (match) => match[1]!,
  );

  const stored = await store.get<Site>('site/registered/newcomer');

  assert.equal(stored!.key, siteKey);
  assert.equal(stored!.name, 'newcomer.test');

  // The dashboard key is kept only as its hash.
  const operators = await store.get<{ hash: string }[]>('site/operators/newcomer');

  assert.equal(operators!.length, 1);
  assert.notEqual(operators![0]!.hash, dashboardKey);
  assert.ok(!JSON.stringify([...store.rows]).includes(dashboardKey!));

  // The site is served from the next request.
  const handoff = await request('/handoff/request?site=newcomer&purpose=connect');

  assert.match(handoff.headers.get('location')!, /^https:\/\/newcomer\.test\/authorize/);

  // The same claim cannot register the site again, or replace its keys.
  assert.equal((await check()).status, 409);
  assert.equal((await store.get<Site>('site/registered/newcomer'))!.key, siteKey);
});

test('registration refuses a taken id, a bad claim, and is off unless opened', async () => {
  const { request } = registering(new Map());

  const ask = (fields: Record<string, string>) =>
    request('/register', { method: 'POST', body: new URLSearchParams(fields).toString() });

  assert.match(await (await ask({ ...asked, id: 'pinned' })).text(), /That id is taken/);
  assert.equal((await ask({ ...asked, domain: 'localhost' })).status, 400);
  assert.equal((await ask({ ...asked, returnUrl: 'https://elsewhere.test/return' })).status, 400);

  // A claim cookie this instance did not sign is no claim.
  const forged = await request('/register/check', {
    method: 'POST',
    headers: { cookie: 'verily_claim=e30.AAAA' },
  });

  assert.match(await forged.text(), /expired/);

  const off = registering(new Map(), 'off');

  assert.equal((await off.request('/register')).status, 404);
  assert.equal((await off.request('/register', { method: 'POST', body: '' })).status, 404);
});

test('a stored site whose DNS stops naming the instance is suspended until it does again', async () => {
  const records = new Map([['_verily.moved.test', ['verily-verifier=instance.test']]]);
  const { store, request, instance } = registering(records);

  await new Sites(store, new Map()).register(site('moved'), first);

  const handoff = async () => (await request('/handoff/request?site=moved&purpose=connect')).status;

  const read = async () =>
    (
      await request('/site/connections', {
        headers: {
          authorization: `Bearer ${sign(site('moved').key, {
            site: 'moved',
            op: 'read',
            ids: ['someone'],
            exp: Math.floor(Date.now() / 1000) + 60,
          })}`,
        },
      })
    ).status;

  // Due when a check is this long past.
  const age = async (ms: number) => {
    const check = (await store.get<DnsCheck>('site/dns/moved'))!;

    await store.put('site/dns/moved', {
      ...check,
      attemptedAt: Date.now() - ms,
      checkedAt: Date.now() - ms,
    });
  };

  await instance.upkeep();
  assert.equal(await handoff(), 303);

  // The record goes. Nothing changes until the daily check is due.
  records.set('_verily.moved.test', []);
  await instance.upkeep();
  assert.equal(await handoff(), 303);

  await age(25 * 3600000);
  await instance.upkeep();
  assert.equal(await handoff(), 404);

  // The site's backend can still read its connections, to move them elsewhere.
  assert.equal(await read(), 200);

  // A suspended site is checked hourly, and served again once the record is back.
  records.set('_verily.moved.test', ['verily-verifier=instance.test']);
  await age(2 * 3600000);
  await instance.upkeep();
  assert.equal(await handoff(), 303);
});

test('sites that are always due cannot keep the others from being checked', async () => {
  const hour = 3600000;
  const now = Date.now();
  const records = new Map<string, string[] | null>();
  const { store, request, instance } = registering(records);
  const sites = new Sites(store, new Map());
  const crowd = Array.from({ length: 20 }, (_, i) => `crowd-${i}`);

  for (const id of [...crowd, 'last']) await sites.register(site(id), first);

  const handoff = async (id: string) =>
    (await request(`/handoff/request?site=${id}&purpose=connect`)).status;

  // Twenty suspended sites, due hourly, and one served site whose daily check is due and
  // whose record is gone.
  for (const id of crowd)
    await store.put<DnsCheck>(`site/dns/${id}`, {
      attemptedAt: now - 2 * hour,
      checkedAt: now - 2 * hour,
      absentSince: now - 3 * hour,
    });

  await store.put<DnsCheck>('site/dns/last', {
    attemptedAt: now - 25 * hour,
    checkedAt: now - 25 * hour,
  });

  assert.equal(await handoff('last'), 303);

  await instance.upkeep();
  assert.equal(await handoff('last'), 404);

  // Twenty sites whose DNS never answers are retried hourly, and still take turns with the
  // rest: the site asked longest ago goes first.
  for (const id of crowd) {
    records.set(`_verily.${id}.test`, null);
    await store.put<DnsCheck>(`site/dns/${id}`, { attemptedAt: now - 2 * hour });
  }

  records.set('_verily.last.test', ['verily-verifier=instance.test']);

  await store.put<DnsCheck>('site/dns/last', {
    attemptedAt: now - 2 * hour + 1,
    checkedAt: now - 2 * hour + 1,
    absentSince: now - 3 * hour,
  });

  await instance.upkeep();

  // The crowd was asked first and got no answer. Their status is unchanged.
  assert.equal(await handoff('last'), 404);
  assert.equal((await store.get<DnsCheck>('site/dns/crowd-0'))!.checkedAt, undefined);

  // An hour on, the crowd is due again, but the restored site was asked longest ago.
  for (const id of crowd) {
    const check = (await store.get<DnsCheck>(`site/dns/${id}`))!;

    await store.put(`site/dns/${id}`, { ...check, attemptedAt: check.attemptedAt - hour });
  }

  await instance.upkeep();
  assert.equal(await handoff('last'), 303);
});

test('settings saved from a page loaded before a key change keep the new key', async () => {
  const store = new MemoryStore();
  const stale = new Sites(store, new Map());
  const other = new Sites(store, new Map());

  await stale.register(site('raced'), first);
  await other.refresh();

  // Another request replaces the key while this one still holds the old site.
  const replaced = await other.rotate('raced', false);

  await stale.update('raced', {
    authorizeUrl: 'https://raced.test/v2/authorize',
    returnUrl: 'https://raced.test/return',
  });

  const stored = (await store.get<Site>('site/registered/raced'))!;

  assert.equal(stored.key, replaced);
  assert.equal(stored.previousKey, undefined);
  assert.equal(stored.authorizeUrl, 'https://raced.test/v2/authorize');
});

test('a session opened just before a key change gets its result under the key it was opened with', async () => {
  const store = new MemoryStore();
  const sites = new Sites(store, new Map());
  const oldKey = site('handed').key;

  await sites.register(site('handed'), first);

  const begun = (await sites.begin('handed', 'connect'))!;
  const state = new URL(begun.location).searchParams.get('state')!;

  const token = sign(oldKey, {
    site: 'handed',
    state,
    id: 'someone',
    label: 'someone',
    reference: 'someone',
    txn: 'txn',
    exp: Math.floor(Date.now() / 1000) + 60,
  });

  const started = await sites.start(
    new Request('https://instance.test/handoff/accept', {
      headers: { cookie: begun.cookie.split(';')[0]! },
    }),
    token,
    (local) => local,
  );

  assert.ok(started);

  const [, session] = (await store.list<{ signer?: string }>('site/session/'))[0]!;

  // The routine change comes after the handoff, while the backend still has the old key.
  const newKey = await sites.rotate('handed', true);

  const result = new URL(
    sites.returnUrl(
      sites.sites.get('handed')!,
      { id: 'handed:someone', label: 'someone', reference: 'someone' },
      'txn',
      { operation: 'connect', outcome: 'cancelled', finishedAt: Date.now() },
      session.signer,
    ),
  ).searchParams.get('result')!;

  assert.ok(open(oldKey, result));
  assert.equal(open(newKey, result), undefined);
});

test('replacing a key ends the sessions opened with the key it replaces', async () => {
  const store = new MemoryStore();
  const sites = new Sites(store, new Map());

  await sites.register(site('leaked'), first);

  /** Opens a session with a handoff signed by `key`, and returns its cookie. */
  const opened = async (key: string) => {
    const begun = (await sites.begin('leaked', 'connect'))!;

    const started = await sites.start(
      new Request('https://instance.test/handoff/accept', {
        headers: { cookie: begun.cookie.split(';')[0]! },
      }),
      sign(key, {
        site: 'leaked',
        state: new URL(begun.location).searchParams.get('state')!,
        id: 'someone',
        label: 'someone',
        reference: 'someone',
        txn: 'txn',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
      (local) => local,
    );

    return started!.cookies[0]!.split(';')[0]!;
  };

  const live = async (cookie: string) =>
    !!(await sites.open(new Request('https://instance.test/', { headers: { cookie } })));

  const leaked = await opened(site('leaked').key);

  assert.ok(await live(leaked));

  // Replaced at once, the leaked key's session is over.
  const second = await sites.rotate('leaked', false);

  assert.ok(!(await live(leaked)));

  // Kept for a day, the old key's sessions last until the overlap is ended early.
  const routine = await opened(second);

  await sites.rotate('leaked', true);
  assert.ok(await live(routine));
  await sites.retirePreviousKey('leaked');
  assert.ok(!(await live(routine)));

  // A session from before sessions named their key lasts its hour.
  const key = `site/session/${hash(routine.slice(routine.indexOf('=') + 1))}`;
  const { signer, ...unnamed } = (await store.get<{ signer?: string }>(key))!;

  assert.ok(signer);
  await store.put(key, unnamed);
  assert.ok(await live(routine));
});
