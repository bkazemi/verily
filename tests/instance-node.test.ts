import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInstance } from '../src/instance/index.js';
import { nodeListener } from '../src/instance/node.js';
import { fromEnv } from '../src/instance/env.js';
import { serve } from '../src/instance/serve.js';
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

const settings = {
  PUBLIC_ORIGIN: origin,
  SITE_NAME: 'Instance Site',
  OWNER_LABEL: 'owner',
  OWNER_REFERENCE: 'the owner',
  OWNER_PROFILE_URL: 'https://site.test/',
  OWNER_KEY: ownerKey,
  REPORT_URL: 'mailto:reports@instance.test',
  SIGNING: 'off',
};

test('settings offer a sign-in only when its secrets are set, and name what is missing', () => {
  // The GitHub sign-in and the GitHub link-back share an id, so each is named with its method.
  const offered = (extra: object) =>
    fromEnv({ ...settings, ...extra }).providers.map((p) => `${p.id}:${p.method ?? 'oauth'}`);

  assert.deepEqual(offered({}), ['github:backlink', 'domain:dns', 'openpgp:signature']);

  assert.ok(
    offered({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' }).includes('github:oauth'),
  );

  assert.ok(!offered({ DISCORD_CLIENT_ID: 'id' }).includes('discord:oauth'));

  assert.ok(
    offered({ DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret' }).includes('discord:oauth'),
  );

  assert.equal(fromEnv(settings).signingKey, false);
  assert.equal(fromEnv({ ...settings, SIGNING: undefined, SIGNING_KEY: '' }).signingKey, undefined);
  assert.equal(fromEnv({ ...settings, EMAIL_DAILY_LIMIT: '250' }).mailPerDay, 250);
  assert.equal(fromEnv({ ...settings, EMAIL_DAILY_LIMIT: 'many' }).mailPerDay, undefined);

  assert.throws(() => fromEnv({ ...settings, OWNER_KEY: '' }), /OWNER_KEY must be set/);
});

test('serve runs an instance from its settings and counts by the header a proxy sets', async () => {
  const store = new MemoryStore();

  const { server, close } = await serve(
    { ...settings, PORT: '0', CLIENT_ADDRESS_HEADER: 'X-Real-IP' },
    store,
  );

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    assert.match(await (await fetch(`${base}/`)).text(), /<h1>Sign in<\/h1>/);

    const login = (ip: string) =>
      fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Real-IP': ip },
        body: 'key=wrong',
      });

    await login('203.0.113.1');
    await login('203.0.113.2');

    // One bucket per address the proxy named.
    assert.equal((await store.list('rate/client/')).length, 2);
  } finally {
    await close();
  }

  await assert.rejects(serve(settings), /DATABASE_URL must be set/);
});

test('the Cloudflare starter depends on this release and names the package entry', async () => {
  const { cloudflareStarter: files } = await import('../src/instance/starter.js');
  const { version } = await import('../src/version.js');

  assert.deepEqual(Object.keys(files).sort(), [
    '.gitignore',
    'package.json',
    'worker.ts',
    'wrangler.jsonc',
  ]);

  assert.equal(
    JSON.parse(files['package.json']!).dependencies['@bkazemi/verily'],
    `^${version.slice(1)}`,
  );

  assert.match(files['worker.ts']!, /from '@bkazemi\/verily\/instance\/cloudflare'/);
  // The names the package's own class and stand-in go by, which the settings must match.
  assert.match(files['wrangler.jsonc']!, /"class_name": "VerilyStore"/);
  assert.match(files['wrangler.jsonc']!, /"undici": "@bkazemi\/verily\/instance\/undici"/);
  assert.match(files['wrangler.jsonc']!, /"main": "worker\.ts"/);
});

test('init writes the whole starter or none of it, and leaves existing files alone', async () => {
  const { init } = await import('../src/instance/init.js');
  const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'verily-init-'));

  try {
    // The last file written is the one in the way, so every earlier one would be left behind.
    await writeFile(join(directory, '.gitignore'), 'mine\n');
    await assert.rejects(init(directory), /\.gitignore already exists\. Nothing was written\./);
    assert.deepEqual(await readdir(directory), ['.gitignore']);
    assert.equal(await readFile(join(directory, '.gitignore'), 'utf8'), 'mine\n');

    await rm(join(directory, '.gitignore'));
    await init(join(directory, 'new', 'project'));

    assert.deepEqual((await readdir(join(directory, 'new', 'project'))).sort(), [
      '.gitignore',
      'package.json',
      'worker.ts',
      'wrangler.jsonc',
    ]);

    await assert.rejects(init(join(directory, 'new', 'project')), /Nothing was written/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
