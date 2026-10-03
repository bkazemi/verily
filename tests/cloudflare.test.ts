import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';
import { buildWorker } from './fixtures/worker.js';

test('Cloudflare SQLite transactions, persistent owner sessions, OAuth, public embeds and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-cloudflare-'));
  const scriptPath = join(directory, 'worker.mjs');
  const origin = 'https://verifier.test';
  const ownerKey = 'a'.repeat(43);
  let providerCalls = 0;

  await buildWorker(scriptPath);

  const options = {
    name: 'verity-test',
    rootPath: directory,
    modules: true,
    scriptPath,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      VERITY: { className: 'VerityStore', useSQLite: true },
      PROBE: { className: 'StorageProbe', useSQLite: true },
    },
    bindings: {
      PUBLIC_ORIGIN: origin,
      SITE_NAME: 'Site',
      OWNER_LABEL: 'Site author',
      OWNER_REFERENCE: 'site.test author',
      OWNER_PROFILE_URL: 'https://site.test/about/',
      REPORT_URL: 'mailto:owner@site.test',
      OWNER_KEY: ownerKey,
      GITHUB_CLIENT_ID: 'test-client',
      GITHUB_CLIENT_SECRET: 'test-secret',
    },
    outboundService: async (request: { url: string; text(): Promise<string> }) => {
      if (request.url === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(await request.text());

        assert.equal(body.get('client_secret'), 'test-secret');
        assert.ok(body.get('code_verifier'));
        providerCalls++;

        return WorkerResponse.json({ access_token: 'provider-secret' });
      }

      if (request.url === 'https://api.github.com/user')
        return WorkerResponse.json({ id: 123, login: 'octocat' });

      throw new Error(`Unexpected outbound URL: ${new URL(request.url).origin}`);
    },
  };

  let mf = new Miniflare({
    ...convertV4MiniflareOptions(options),
    resourcePersistencePath: join(directory, 'data'),
  });

  const request = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) =>
    mf.dispatchFetch(`${origin}${path}`, { ...init, redirect: 'manual' });

  const post = (path: string, body: string, cookie = '') =>
    request(path, { method: 'POST', headers: { origin, cookie }, body });

  try {
    const namespace = await mf.getDurableObjectNamespace('PROBE');
    const probe = namespace.get(namespace.idFromName('one'));

    assert.equal(await (await probe.fetch('https://probe/rollback')).json(), true);

    const counts = await Promise.all(
      Array.from({ length: 20 }, async () => (await probe.fetch('https://probe/increment')).json()),
    );

    assert.equal(new Set(counts).size, 20);
    assert.ok(counts.includes(20));

    const detached = (await (await probe.fetch('https://probe/detached')).json()) as {
      at: number;
    }[];

    assert.equal(detached[0]!.at, 20);

    assert.deepEqual(
      await (await namespace.get(namespace.idFromName('two')).fetch('https://probe/list')).json(),
      [],
    );

    assert.equal((await request('/api/verity/mine')).status, 404);
    assert.match(await (await request('/')).text(), /<h1>Sign in<\/h1>/);
    assert.equal((await post('/login', 'key=wrong')).status, 403);
    // Bounded before anything reads it. The bound is large enough for a pasted key.
    assert.equal((await post('/login', 'x'.repeat(65537))).status, 413);
    assert.equal((await post('/login', 'x'.repeat(65000))).status, 403);

    assert.equal(
      (await request('/login', { method: 'POST', body: `key=${ownerKey}` })).status,
      303,
    );

    assert.equal((await mf.dispatchFetch('https://attacker.test/')).status, 404);

    const login = await post('/login', `key=${ownerKey}`);

    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    assert.match(login.headers.get('set-cookie')!, /verity_owner=.*HttpOnly; Secure; SameSite=Lax/);
    assert.match(await (await request('/', { headers: { cookie } })).text(), /Verify an account/);
    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    const settings = await request('/', { headers: { cookie } });

    assert.match(await settings.text(), /Verify an account/);

    const start = await post('/api/verity/sessions', 'kind=connect', cookie);

    assert.equal(start.status, 303);

    const noOriginStart = await request('/api/verity/sessions', {
      method: 'POST',
      headers: { cookie },
      body: 'kind=connect',
    });

    assert.equal(noOriginStart.status, 303);

    const nullOriginStart = await request('/api/verity/sessions', {
      method: 'POST',
      headers: { cookie, origin: 'null' },
      body: 'kind=connect',
    });

    assert.equal(nullOriginStart.status, 303);
    const flowCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callbackPath = `/api/verity/callback?state=${state}&code=fixture`;
    const callback = await request(callbackPath, { headers: { cookie: flowCookie } });

    assert.equal(callback.status, 303);
    assert.equal(providerCalls, 1);
    assert.equal((await request(callbackPath, { headers: { cookie: flowCookie } })).status, 404);
    const flowPath = callback.headers.get('location')!;
    const approvalCookie = `${cookie}; ${flowCookie}`;

    const approvals = await Promise.all(
      [1, 2].map(() =>
        post(`${flowPath}/approve`, 'action=approve&visibility=public', approvalCookie),
      ),
    );

    assert.ok(approvals.every((r) => r.status === 200));

    const records = (await (await request('/api/verity/mine', { headers: { cookie } })).json()) as {
      id: string;
    }[];

    assert.equal(records.length, 1);
    const id = records[0]!.id;
    const evidencePath = `/api/verity/connections/${id}?format=json`;
    const evidence = await request(evidencePath, { headers: { origin: 'https://site.test' } });

    assert.equal(evidence.headers.get('access-control-allow-origin'), '*');
    assert.equal(evidence.headers.get('access-control-allow-credentials'), null);
    const publicBody = await evidence.text();

    assert.match(publicBody, /"status":"verified"/);
    assert.ok(!publicBody.includes('provider-secret'));
    assert.ok(!publicBody.includes('site-owner'));
    assert.match(await (await request('/', { headers: { cookie } })).text(), /&lt;verity-badge/);

    assert.equal(
      (
        await request(`/api/verity/connections/${id}/disconnect`, {
          method: 'POST',
          headers: { cookie, origin: 'https://site.test' },
          body: '',
        })
      ).status,
      403,
    );

    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.match(await (await request(evidencePath)).text(), /"status":"verified"/);
    assert.equal((await post(`/api/verity/connections/${id}/disconnect`, '', cookie)).status, 200);
    assert.match(await (await request(evidencePath)).text(), /"status":"revoked"/);
    const logout = await request('/logout', { method: 'POST', headers: { cookie }, body: '' });

    assert.equal(logout.status, 303);
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await request('/api/verity/mine', { headers: { cookie } })).status, 404);

    const secondLogin = await post('/login', `key=${ownerKey}`);
    const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0]!;

    assert.equal(
      (await request('/api/verity/mine', { headers: { cookie: secondCookie } })).status,
      200,
    );

    await mf.dispose();

    const rotatedOptions = {
      ...options,
      bindings: { ...options.bindings, OWNER_KEY: 'b'.repeat(43) },
    };

    mf = new Miniflare({
      ...convertV4MiniflareOptions(rotatedOptions),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.equal(
      (await request('/api/verity/mine', { headers: { cookie: secondCookie } })).status,
      404,
    );

    // The throttle survives isolate restarts along with sessions and evidence.
    for (let i = 0; i < 10; i++) assert.equal((await post('/login', 'key=wrong')).status, 403);

    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.equal((await post('/login', 'key=wrong')).status, 429);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Worker offers email once it can send it, and links a mailbox through Resend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-cloudflare-email-'));
  const scriptPath = join(directory, 'worker.mjs');
  const origin = 'https://verifier.test';
  const ownerKey = 'a'.repeat(43);
  const mailed: { authorization: string | null; body: Record<string, unknown> }[] = [];

  await buildWorker(scriptPath);

  const instance = (bindings: Record<string, string>) =>
    new Miniflare(
      convertV4MiniflareOptions({
        name: 'verity-email-test',
        rootPath: directory,
        modules: true,
        scriptPath,
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          VERITY: { className: 'VerityStore', useSQLite: true },
          PROBE: { className: 'StorageProbe', useSQLite: true },
        },
        bindings: {
          PUBLIC_ORIGIN: origin,
          SITE_NAME: 'Site',
          OWNER_LABEL: 'Site author',
          OWNER_REFERENCE: 'site.test author',
          OWNER_PROFILE_URL: 'https://site.test/about/',
          REPORT_URL: 'mailto:owner@site.test',
          OWNER_KEY: ownerKey,
          GITHUB_CLIENT_ID: 'test-client',
          GITHUB_CLIENT_SECRET: 'test-secret',
          ...bindings,
        },
        outboundService: async (request: {
          url: string;
          headers: { get(name: string): string | null };
          json(): Promise<unknown>;
        }) => {
          if (request.url !== 'https://api.resend.com/emails')
            throw new Error(`Unexpected outbound URL: ${new URL(request.url).origin}`);

          mailed.push({
            authorization: request.headers.get('authorization'),
            body: (await request.json()) as Record<string, unknown>,
          });

          return WorkerResponse.json({ id: 'message-1' });
        },
      }),
    );

  /** Signs the owner in and asks which methods they are offered. */
  const offered = async (mf: Miniflare) => {
    const login = await mf.dispatchFetch(`${origin}/login`, {
      method: 'POST',
      headers: { origin },
      body: `key=${ownerKey}`,
      redirect: 'manual',
    });

    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const methods = (await (
      await mf.dispatchFetch(`${origin}/api/verity/methods`, { headers: { cookie } })
    ).json()) as { methods: { provider: string }[] };

    return { cookie, providers: methods.methods.map((m) => m.provider) };
  };

  // A key with no sender to send from is not enough to offer it.
  const without = instance({ RESEND_API_KEY: 're_test' });

  try {
    assert.ok(!(await offered(without)).providers.includes('email'));
  } finally {
    await without.dispose();
  }

  const mf = instance({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Verity <verify@site.test>' });

  try {
    const owner = await offered(mf);

    assert.ok(owner.providers.includes('email'));

    const start = await mf.dispatchFetch(`${origin}/api/verity/sessions`, {
      method: 'POST',
      headers: { origin, cookie: owner.cookie },
      body: 'kind=connect&provider=email',
      redirect: 'manual',
    });

    assert.equal(start.status, 303);

    const cookie = `${owner.cookie}; ${start.headers.get('set-cookie')!.split(';')[0]!}`;
    const flow = start.headers.get('location')!;

    const post = (path: string, body: string) =>
      mf.dispatchFetch(`${origin}${path}`, {
        method: 'POST',
        headers: { origin, cookie },
        body,
        redirect: 'manual',
      });

    await post(`${flow}/submit`, 'artifact=Alice%40Example.test');

    assert.equal(mailed.length, 1);
    assert.equal(mailed[0]!.authorization, 'Bearer re_test');
    assert.equal(mailed[0]!.body.from, 'Verity <verify@site.test>');
    assert.deepEqual(mailed[0]!.body.to, ['alice@example.test']);

    assert.match(String(mailed[0]!.body.html), />Confirm this address<\/a>/);

    // The button's link, opened and pressed in a browser that holds none of the cookies.
    const link = new URL(/^https:\/\/\S+$/m.exec(String(mailed[0]!.body.text))![0]);

    assert.equal(link.origin, origin);
    assert.equal((await mf.dispatchFetch(link.href)).status, 200);

    const pressed = await mf.dispatchFetch(`${link.origin}${link.pathname}`, {
      method: 'POST',
      headers: { origin, 'cf-connecting-ip': '203.0.113.9' },
      body: `token=${link.searchParams.get('token')!}`,
      redirect: 'manual',
    });

    assert.match(await pressed.text(), /Address confirmed/);
    await post(`${flow}/approve`, 'visibility=public&action=approve');

    const mine = (await (
      await mf.dispatchFetch(`${origin}/api/verity/mine`, { headers: { cookie } })
    ).json()) as { provider: string; status: string; external: { handle: string } }[];

    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.provider, 'email');
    assert.equal(mine[0]!.status, 'verified');
    assert.equal(mine[0]!.external.handle, 'alice@example.test');

    // The owner page names the mailbox by its address, with no @ put in front of it.
    const home = await (await mf.dispatchFetch(`${origin}/`, { headers: { cookie } })).text();

    assert.match(home, /<h3>alice@example\.test<\/h3>/);
  } finally {
    await mf.dispose();
  }

  /** Asks for a code to be mailed to an address, and reports how the flow stands after. */
  const asked = async (worker: Miniflare, session: string, address: string) => {
    const start = await worker.dispatchFetch(`${origin}/api/verity/sessions`, {
      method: 'POST',
      headers: { origin, cookie: session },
      body: 'kind=connect&provider=email',
      redirect: 'manual',
    });

    const cookie = `${session}; ${start.headers.get('set-cookie')!.split(';')[0]!}`;
    const flow = start.headers.get('location')!;

    await worker.dispatchFetch(`${origin}${flow}/submit`, {
      method: 'POST',
      headers: { origin, cookie },
      body: `artifact=${encodeURIComponent(address)}`,
      redirect: 'manual',
    });

    return (await worker.dispatchFetch(`${origin}${flow}`, { headers: { cookie } })).text();
  };

  const capped = instance({
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Verity <verify@site.test>',
    EMAIL_DAILY_LIMIT: '7',
  });

  try {
    const owner = await offered(capped);

    mailed.length = 0;

    // One address is mailed five codes a day, however it is spelled, and no sixth.
    for (let sent = 1; sent <= 5; sent++)
      assert.match(await asked(capped, owner.cookie, 'Victim@example.test'), /A message was sent/);

    const sixth = await asked(capped, owner.cookie, 'victim@EXAMPLE.test');

    assert.match(sixth, /Too many messages have been sent today, so try again tomorrow\./);
    assert.equal(mailed.length, 5);

    // A refusal spends nothing, so the day still has the two codes it had left.
    assert.match(await asked(capped, owner.cookie, 'one@example.test'), /A message was sent/);
    assert.match(await asked(capped, owner.cookie, 'two@example.test'), /A message was sent/);
    assert.match(await asked(capped, owner.cookie, 'three@example.test'), /Too many messages/);
    assert.equal(mailed.length, 7);

    // The counts are the library's own records: they name no address, and last the day.
    const namespace = await capped.getDurableObjectNamespace('VERITY');
    const stub = namespace.get(namespace.idFromName('site-owner'));

    const buckets = (await (
      await stub.fetch('https://probe/list?prefix=verity/limits/')
    ).json()) as Record<string, { count: number; expiresAt: number }>;

    assert.equal(buckets['verity/limits/send/email/day']!.count, 7);
    assert.ok(buckets['verity/limits/send/email/day']!.expiresAt > Date.now() + 23 * 3600000);
    assert.equal(Object.keys(buckets).length, 4);
    assert.ok(!JSON.stringify(buckets).toLowerCase().includes('victim'));
  } finally {
    await capped.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
