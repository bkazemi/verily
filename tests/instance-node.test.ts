import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInstance } from '../src/instance/index.js';
import { nodeListener } from '../src/instance/node.js';
import { fakeProvider, MemoryStore } from './helpers.js';

const origin = 'https://instance.test';
const ownerKey = 'k'.repeat(43);

/** Serves a handler over plain HTTP on a free port, as a proxy's upstream would be. */
async function served(listener: ReturnType<typeof nodeListener>) {
  const server = createServer(listener);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    request: (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { redirect: 'manual', ...init }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the instance runs on Node: the owner signs in, reads their pages, and upkeep runs', async () => {
  const store = new MemoryStore();

  const instance = createInstance({
    store,
    origin,
    siteName: 'Instance Site',
    owner: {
      kind: 'site',
      label: 'owner',
      reference: 'the owner',
      profileUrl: 'https://site.test/',
    },
    ownerKey,
    reportUrl: 'mailto:reports@instance.test',
    providers: [fakeProvider()],
    signingKey: false,
  });

  const { request, close } = await served(nodeListener(instance, { origin }));

  try {
    const anonymous = await request('/');

    assert.equal(anonymous.status, 200);
    assert.match(await anonymous.text(), /<h1>Sign in<\/h1>/);
    assert.equal((await request('/records')).status, 404);

    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

    const wrong = await request('/login', { method: 'POST', headers: form, body: 'key=wrong' });

    assert.equal(wrong.status, 403);

    const login = await request('/login', {
      method: 'POST',
      headers: form,
      body: `key=${ownerKey}`,
    });

    assert.equal(login.status, 303);

    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const settings = await request('/', { headers: { cookie } });

    assert.match(await settings.text(), /<h1>Owner settings<\/h1>/);

    assert.match(
      await (await request('/records', { headers: { cookie } })).text(),
      /0 on this instance/,
    );

    // The library's own routes are mounted at the root, and its stylesheet is served.
    assert.equal((await request('/verify', { headers: { cookie } })).status, 200);
    assert.equal((await request('/style.css')).status, 200);

    assert.equal((await request('/', { method: 'PUT' })).status, 405);

    const large = await request('/login', {
      method: 'POST',
      headers: form,
      body: 'k'.repeat(70000),
    });

    assert.equal(large.status, 413);

    assert.ok((await store.list('owner/session/')).length === 1);
    await instance.upkeep();
    assert.ok((await store.list('owner/session/')).length === 1);
  } finally {
    await close();
  }
});

test('the Node listener sends each cookie as its own header and passes the client address', async () => {
  const seen: (string | null)[] = [];

  const handle = async (_request: Request, address: string | null = null) => {
    seen.push(address);

    const headers = new Headers({ 'Content-Type': 'text/plain' });

    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/');

    return new Response('ok', { headers });
  };

  const direct = await served(nodeListener({ handle }, { origin }));

  const proxied = await served(
    nodeListener(
      { handle },
      { origin, address: (request) => String(request.headers['x-real-ip'] ?? '') || null },
    ),
  );

  try {
    const response = await direct.request('/');

    assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
    await proxied.request('/', { headers: { 'x-real-ip': '203.0.113.7' } });
    assert.deepEqual(seen, ['127.0.0.1', '203.0.113.7']);
  } finally {
    await direct.close();
    await proxied.close();
  }
});
