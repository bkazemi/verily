import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTenant } from '../example/tenant.js';

const origin = 'https://partner.test';
const key = 'r'.repeat(43);

/** What the instance signs, made apart from the tenant's own code. */
function sign(payload: object, secret = key) {
  const bytes = Buffer.from(JSON.stringify(payload));

  return `${bytes.toString('base64url')}.${createHmac('sha256', secret).update(bytes).digest('base64url')}`;
}

function payload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<
    string,
    string | number
  >;
}

async function fixture() {
  const tenant = createTenant({
    origin,
    instance: 'https://verifier.test',
    site: 'partner',
    key,
    name: 'Partner',
  });

  const request = (path: string, init: RequestInit = {}) =>
    tenant.handle(new Request(`${origin}${path}`, init));

  async function signUp(name: string) {
    const response = await request('/signup', {
      method: 'POST',
      headers: { origin },
      body: `name=${name}`,
    });

    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const user = [...tenant.users.values()].find((u) => u.name === name)!;

    return { cookie, user };
  }

  return { tenant, request, signUp };
}

test('a site takes each result once, for its user and their current transaction only', async () => {
  const f = await fixture();
  const alice = await f.signUp('Alice');
  const bob = await f.signUp('Bob');

  /** Starts a handoff for Alice and returns the transaction the site signed into it. */
  const handoff = async () => {
    const authorized = await f.request('/verily/authorize?state=s', {
      headers: { cookie: alice.cookie },
    });

    const token = new URL(authorized.headers.get('location')!).searchParams.get('token')!;
    const signed = payload(token);

    assert.equal(signed.site, 'partner');
    assert.equal(signed.state, 's');
    assert.equal(signed.id, alice.user.id);
    assert.equal(signed.profileUrl, `${origin}/u/alice`);
    assert.ok((signed.exp as number) <= Date.now() / 1000 + 300);

    return signed.txn as string;
  };

  const result = (txn: string, fields: Record<string, string>, extra: object = {}) =>
    sign({
      site: 'partner',
      id: alice.user.id,
      operation: 'connect',
      outcome: 'complete',
      connection: 'c1',
      ...fields,
      txn,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...extra,
    });

  const deliver = async (token: string, cookie = alice.cookie) =>
    (await f.request(`/verily/return?result=${token}`, { headers: { cookie } })).status;

  const first = await handoff();
  const unlisted = result(first, { visibility: 'unlisted' });

  assert.equal(await deliver(unlisted), 303);
  assert.deepEqual([...alice.user.links], [['c1', 'unlisted']]);

  // A retry delivers the same token again, and is accepted without changing anything.
  assert.equal(await deliver(unlisted), 303);
  assert.equal(await deliver(result(first, { visibility: 'public' })), 400);

  const second = await handoff();
  const shown = result(second, { operation: 'visibility', visibility: 'public' });

  assert.equal(await deliver(shown), 303);
  assert.deepEqual([...alice.user.links], [['c1', 'public']]);

  // The older result, replayed after the newer change, would hide the account again.
  assert.equal(await deliver(unlisted), 400);
  assert.deepEqual([...alice.user.links], [['c1', 'public']]);

  // Not Alice's, not signed with this site's key, or out of date.
  const third = await handoff();

  for (const bad of [
    result(third, { visibility: 'unlisted' }, { id: bob.user.id }),
    result(third, { visibility: 'unlisted' }, { site: 'other' }),
    result(third, { visibility: 'unlisted' }, { exp: Math.floor(Date.now() / 1000) - 1 }),
    sign({ ...payload(result(third, { visibility: 'unlisted' })) }, 'x'.repeat(43)),
  ])
    assert.equal(await deliver(bad), 400);

  assert.equal(await deliver(result(third, { visibility: 'unlisted' }), bob.cookie), 400);

  // A newer handoff supersedes an older one still pending.
  const fourth = await handoff();

  assert.equal(await deliver(result(third, { visibility: 'unlisted' })), 400);
  assert.equal(await deliver(result(fourth, { operation: 'disconnect' })), 303);
  assert.deepEqual([...alice.user.links], []);
});

test('a site shows a public link as a badge, and an unlisted one only to its holder', async () => {
  const f = await fixture();
  const alice = await f.signUp('Alice');

  alice.user.links.set('shown', 'public');
  alice.user.links.set('hidden', 'unlisted');

  const own = await (await f.request('/u/alice', { headers: { cookie: alice.cookie } })).text();
  const theirs = await (await f.request('/u/alice')).text();

  for (const html of [own, theirs]) {
    assert.match(html, /connection-id="shown"/);
    assert.ok(!html.includes('connection-id="hidden"'));
  }

  assert.match(
    own,
    /linked but hidden\. <a href="https:\/\/verifier\.test\/handoff\/request\?site=partner&amp;purpose=manage">Make public/,
  );

  assert.ok(!theirs.includes('linked but hidden'));
  assert.ok(!theirs.includes('/handoff/request'));
});
