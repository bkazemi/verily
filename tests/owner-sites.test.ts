import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../src/instance/index.js';
import { limits } from '../src/instance/limits.js';
import { Sites, type Site } from '../src/instance/sites.js';
import { fakeProvider, memoryInstance, offlineDns, openSession, readStatus } from './helpers.js';

const ownerKey = 'k'.repeat(43);

const site = (id: string): Site => ({
  id,
  name: `${id}.test`,
  origin: `https://${id}.test`,
  authorizeUrl: `https://${id}.test/authorize`,
  returnUrl: `https://${id}.test/return`,
  key: id[0]!.repeat(43),
});

/** An instance with one pinned site and one stored site, and the owner signed in. */
async function overseen() {
  const pinned = () => registry([site('pinned')], { SITE_PINNED_KEY: 'p'.repeat(43) });

  const fixture = memoryInstance({
    providers: [fakeProvider(), { ...fakeProvider(), id: 'youtube', name: 'YouTube' }],
    sites: pinned(),
    dns: offlineDns,
  });

  const sites = new Sites(fixture.store, pinned());

  await sites.register(site('stored'), { kind: 'key', hash: 'h', addedAt: 0 });

  const login = await fixture.post('/login', { key: ownerKey });
  const owner = login.headers.get('set-cookie')!.split(';')[0]!;

  const handoff = async (id: string) =>
    (await fixture.request(`/handoff/request?site=${id}&purpose=connect`)).status;

  /** The providers a holder of the site is offered. */
  const offered = async (id: string, key: string) => {
    await sites.refresh();

    const cookie = await openSession(sites, id, key);
    const listed = await fixture.request('/methods', { headers: { cookie } });

    return ((await listed.json()) as { methods: { provider: string }[] }).methods.map(
      (m) => m.provider,
    );
  };

  return { ...fixture, owner, handoff, offered };
}

test('only the owner sees and changes registered sites', async () => {
  const { request, post, owner } = await overseen();

  assert.equal((await request('/sites')).status, 404);
  assert.equal((await post('/sites/suspend', { id: 'stored', suspend: 'yes' })).status, 403);

  const page = await (await request('/sites', { headers: { cookie: owner } })).text();

  assert.match(page, /stored\.test/);
  assert.match(page, /DNS record not checked yet/);

  // Only stored sites are listed, and only they can be changed.
  assert.ok(!page.includes('pinned.test'));

  assert.equal((await post('/sites/suspend', { id: 'pinned', suspend: 'yes' }, owner)).status, 404);

  assert.match(await (await request('/', { headers: { cookie: owner } })).text(), /href="\/sites"/);
});

test('the owner suspends a stored site by hand, and its backend can still read', async () => {
  const { request, post, owner, handoff } = await overseen();

  assert.equal(await handoff('stored'), 303);

  const suspended = await post('/sites/suspend', { id: 'stored', suspend: 'yes' }, owner);

  assert.equal(suspended.status, 303);
  assert.equal(await handoff('stored'), 404);
  assert.equal(await readStatus(request, 'stored', site('stored').key), 200);

  assert.match(
    await (await request('/sites', { headers: { cookie: owner } })).text(),
    /Suspended by you since/,
  );

  await post('/sites/suspend', { id: 'stored', suspend: 'no' }, owner);
  assert.equal(await handoff('stored'), 303);
});

test('a stored site gets the lower limit until the owner raises it', async () => {
  const { request, post, owner } = await overseen();

  const read = () => readStatus(request, 'stored', site('stored').key);

  for (let i = 0; i < limits.registered; i++) assert.equal(await read(), 200);

  assert.equal(await read(), 429);

  // Raised, the bucket already spent has room again.
  await post('/sites/limit', { id: 'stored', limit: String(limits.registered + 1) }, owner);
  assert.equal(await read(), 200);
  assert.equal(await read(), 429);

  // A limit that is not a whole number in range changes nothing, and empty restores the default.
  assert.equal((await post('/sites/limit', { id: 'stored', limit: '0' }, owner)).status, 400);
  assert.equal((await post('/sites/limit', { id: 'stored', limit: '1.5' }, owner)).status, 400);
  assert.equal((await post('/sites/limit', { id: 'stored', limit: '' }, owner)).status, 303);

  const page = await (await request('/sites', { headers: { cookie: owner } })).text();

  assert.match(page, /name="limit"[^>]*value=""/);
});

test('a stored site goes without YouTube until the owner approves it', async () => {
  const { post, owner, offered } = await overseen();

  assert.deepEqual(await offered('stored', site('stored').key), ['github']);
  assert.deepEqual(await offered('pinned', 'p'.repeat(43)), ['github', 'youtube']);

  await post('/sites/youtube', { id: 'stored', approve: 'yes' }, owner);
  assert.deepEqual(await offered('stored', site('stored').key), ['github', 'youtube']);

  await post('/sites/youtube', { id: 'stored', approve: 'no' }, owner);
  assert.deepEqual(await offered('stored', site('stored').key), ['github']);
});
