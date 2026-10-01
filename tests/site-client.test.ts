import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSiteClient, pseudonym } from '../src/site/index.js';

const key = 'k'.repeat(43);
const instance = 'https://verifier.test';

/** A token checked the way the instance checks it, apart from the client's own code. */
function opened(token: string, secret = key) {
  const [payload, mac] = token.split('.') as [string, string];
  const bytes = Buffer.from(payload, 'base64url');

  assert.equal(createHmac('sha256', secret).update(bytes).digest('base64url'), mac);

  return JSON.parse(bytes.toString()) as Record<string, unknown>;
}

function signed(payload: object, secret = key) {
  const bytes = Buffer.from(JSON.stringify(payload));

  return `${bytes.toString('base64url')}.${createHmac('sha256', secret).update(bytes).digest('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);

test('a site client signs a handoff the instance can check', async () => {
  const client = createSiteClient({ instance, site: 'partner', key });

  assert.equal(client.beginUrl(), `${instance}/begin?site=partner&purpose=connect`);
  assert.equal(client.beginUrl('manage'), `${instance}/begin?site=partner&purpose=manage`);

  const { url, txn } = await client.authorize('the-state', {
    id: 'u-1',
    label: 'Alice',
    reference: 'partner-ABCD',
  });

  const target = new URL(url);

  assert.equal(`${target.origin}${target.pathname}`, `${instance}/start`);

  const payload = opened(target.searchParams.get('token')!);

  assert.deepEqual(
    { ...payload, exp: undefined },
    {
      site: 'partner',
      state: 'the-state',
      id: 'u-1',
      label: 'Alice',
      reference: 'partner-ABCD',
      txn,
      exp: undefined,
    },
  );

  assert.ok((payload.exp as number) > now() && (payload.exp as number) <= now() + 300);

  // Each handoff is its own transaction.
  const again = await client.authorize('the-state', {
    id: 'u-1',
    kind: 'account',
    label: 'Alice',
    reference: 'partner-ABCD',
    profileUrl: 'https://partner.test/u/alice',
  });

  assert.notEqual(again.txn, txn);

  const full = opened(new URL(again.url).searchParams.get('token')!);

  assert.equal(full.kind, 'account');
  assert.equal(full.profileUrl, 'https://partner.test/u/alice');
  await assert.rejects(client.authorize('', { id: 'u', label: 'A', reference: 'r' }), /state/);
});

test('a site client reads connections in batches, with a token marked as a read', async () => {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];

  const client = createSiteClient({
    instance,
    site: 'partner',
    key,
    fetch: (async (url: string, init: { headers: Record<string, string> }) => {
      const payload = opened(init.headers.Authorization!.replace(/^Bearer /, ''));

      calls.push({ url, payload });

      return Response.json({
        connections: Object.fromEntries((payload.ids as string[]).map((id) => [id, []])),
      });
    }) as unknown as typeof fetch,
  });

  const ids = Array.from({ length: 120 }, (_, i) => `u-${i}`);
  const found = await client.connections([...ids, 'u-0']);

  assert.equal(Object.keys(found).length, 120);

  assert.deepEqual(
    calls.map((call) => (call.payload.ids as string[]).length),
    [50, 50, 20],
  );

  for (const call of calls) {
    assert.equal(call.url, `${instance}/site/connections`);
    assert.equal(call.payload.site, 'partner');
    assert.equal(call.payload.op, 'read');
    assert.ok((call.payload.exp as number) <= now() + 300);
  }

  assert.deepEqual({ ...(await client.connections([])) }, {});
  assert.equal(calls.length, 3);

  // An id that names something on every object is an id like any other, across batches too.
  const named = createSiteClient({
    instance,
    site: 'partner',
    key,
    fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
      const asked = opened(init.headers.Authorization!.replace(/^Bearer /, '')).ids as string[];

      return new Response(
        `{"connections":{${asked.map((id) => `${JSON.stringify(id)}:[{"id":"c"}]`).join(',')}}}`,
      );
    }) as unknown as typeof fetch,
  });

  const odd = ['__proto__', 'constructor', 'toString', ...ids.slice(0, 60)];
  const all = await named.connections(odd);

  assert.deepEqual(Object.keys(all), odd);
  assert.deepEqual(all['__proto__'], [{ id: 'c' }]);
  assert.deepEqual(all['constructor'], [{ id: 'c' }]);

  const refused = createSiteClient({
    instance,
    site: 'partner',
    key,
    fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
  });

  await assert.rejects(refused.connections(['u-1']), /answered 404/);
});

test('a site client accepts only a result the instance signed for it, still in date', async () => {
  const client = createSiteClient({ instance, site: 'partner', key });

  const result = {
    site: 'partner',
    id: 'u-1',
    operation: 'connect',
    outcome: 'complete',
    connection: 'c1',
    visibility: 'unlisted',
    txn: 't1',
    exp: now() + 600,
  };

  assert.deepEqual(await client.result(signed(result)), result);

  for (const bad of [
    signed(result, 'x'.repeat(43)),
    signed({ ...result, site: 'other' }),
    signed({ ...result, exp: now() - 1 }),
    signed(result).replace(
      /^[^.]+/,
      Buffer.from(JSON.stringify({ ...result, id: 'u-2' })).toString('base64url'),
    ),
    'not-a-token',
    'a.b.c',
    '',
  ])
    assert.equal(await client.result(bad), undefined);
});

test('a pseudonym is stable, differs by secret, value and purpose, and needs a real secret', async () => {
  const secret = 's'.repeat(32);
  const id = await pseudonym(secret, 'user-1');

  assert.equal(id, await pseudonym(secret, 'user-1'));
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(id, await pseudonym(secret, 'user-2'));
  assert.notEqual(id, await pseudonym('t'.repeat(32), 'user-1'));
  assert.notEqual(id, await pseudonym(secret, 'user-1', 'reference'));
  await assert.rejects(pseudonym('short', 'user-1'), /at least 32/);
});

test('a site client refuses a setup the instance would refuse', () => {
  assert.throws(
    () => createSiteClient({ instance: `${instance}/`, site: 'partner', key }),
    /origin/,
  );

  assert.throws(
    () => createSiteClient({ instance: 'http://verifier.test', site: 'partner', key }),
    /HTTPS/,
  );

  assert.throws(() => createSiteClient({ instance, site: 'Partner', key }), /site id/);
  assert.throws(() => createSiteClient({ instance, site: 'partner', key: 'short' }), /key/);
});
