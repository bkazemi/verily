import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstance, registry } from '../src/instance/index.js';
import { Sites, type Site } from '../src/instance/sites.js';
import { fakeProvider, MemoryStore } from './helpers.js';

const site = (id: string, origin = `https://${id}.test`): Site => ({
  id,
  name: `${id}.test`,
  origin,
  authorizeUrl: `${origin}/authorize`,
  returnUrl: `${origin}/return`,
  key: id[0]!.repeat(43),
});

const pinned = () => registry([site('pinned')], { SITE_PINNED_KEY: 'p'.repeat(43) });

test('stored sites are served beside the pinned ones, which win on a clash', async () => {
  const store = new MemoryStore();
  const sites = new Sites(store, pinned());

  await sites.save(site('stored'));
  assert.deepEqual([...sites.sites.keys()], ['pinned', 'stored']);

  // A change to a stored site replaces it.
  await sites.save({ ...site('stored'), name: 'Renamed' });
  assert.equal(sites.sites.get('stored')!.name, 'Renamed');

  // The pinned site's id and origin, and another stored site's origin, are refused.
  await assert.rejects(sites.save(site('pinned')), /set by the host/);
  await assert.rejects(sites.save(site('copy', 'https://pinned.test')), /already registered/);
  await assert.rejects(sites.save(site('copy', 'https://stored.test')), /already registered/);
  await assert.rejects(sites.save({ ...site('bad'), key: 'short' }), /base64url key/);
  await assert.rejects(sites.save(site('plain', 'http://plain.test')), /HTTPS origin/);

  // Written past save(), as a host's own tooling might, a clash is still not served.
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
  });

  await instance.upkeep();
  assert.ok(await store.get('site/registered/stored'));
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
  await new Sites(store, new Map()).save(site('later'));

  assert.match((await handoff('later')).headers.get('location')!, /^https:\/\/later\.test\//);

  // And removes it.
  await store.delete('site/registered/later');
  assert.equal((await handoff('later')).status, 404);
});
