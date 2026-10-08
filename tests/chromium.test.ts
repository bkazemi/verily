import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';
import { chromium } from 'playwright-core';
import { nodeHandler } from '../src/server/index.js';
import { createTenant } from '../example/tenant.js';
import { buildWorker } from './fixtures/worker.js';

/** A Chromium to drive: named outright, one Playwright downloaded, or one installed. */
function chromiumPath(): string | undefined {
  const cache = join(homedir(), '.cache', 'ms-playwright');

  const downloaded = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .map((name) => join(cache, name, 'chrome-linux64', 'chrome'))
    : [];

  return [
    process.env.CHROMIUM_PATH,
    ...downloaded,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ].find((path) => path && existsSync(path));
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version']);

    return true;
  } catch {
    return false;
  }
}

const executablePath = chromiumPath();

const port = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };

      server.close(() => resolve(port));
    });
  });

test(
  'in Chromium, a holder goes from the site to the instance and back with a signed result',
  { skip: !executablePath || !hasOpenssl() ? 'no Chromium or openssl found' : false },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'verily-chromium-'));
    const scriptPath = join(directory, 'worker.mjs');
    const key = 'r'.repeat(43);

    // Every host is served here, through a proxy only this browser uses, so the instance
    // and the site are two sites with their own cookies and nothing leaves the machine.
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test'],
        ...['-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')],
      ],
      { stdio: 'ignore' },
    );

    const tls = {
      key: await readFile(join(directory, 'key.pem'), 'utf8'),
      cert: await readFile(join(directory, 'cert.pem'), 'utf8'),
    };

    const ports: Record<string, number> = {
      'verifier.test': await port(),
      'partner.test': await port(),
      'github.com': await port(),
    };

    const verifier = 'https://verifier.test';
    const site = 'https://partner.test';

    await buildWorker(scriptPath);

    const mf = new Miniflare({
      ...convertV4MiniflareOptions({
        name: 'verily-chromium-test',
        rootPath: directory,
        modules: true,
        scriptPath,
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          VERILY: { className: 'VerilyStore', useSQLite: true },
          PROBE: { className: 'StorageProbe', useSQLite: true },
        },
        bindings: {
          PUBLIC_ORIGIN: verifier,
          SITE_NAME: 'shirkadeh.test',
          OWNER_LABEL: 'shirkadeh.test',
          OWNER_REFERENCE: 'shirkadeh.test',
          OWNER_PROFILE_URL: 'https://shirkadeh.test/',
          REPORT_URL: 'mailto:owner@shirkadeh.test',
          OWNER_KEY: 'a'.repeat(43),
          GITHUB_CLIENT_ID: 'test-client',
          GITHUB_CLIENT_SECRET: 'test-secret',
          SITES: JSON.stringify([
            {
              id: 'partner',
              name: 'Partner',
              origin: site,
              authorizeUrl: `${site}/verily/authorize`,
              returnUrl: `${site}/verily/return`,
            },
          ]),
          SITE_PARTNER_KEY: key,
        },
        outboundService: async (request: { url: string }) => {
          if (request.url === 'https://github.com/login/oauth/access_token')
            return WorkerResponse.json({ access_token: 'provider-secret' });

          if (request.url === 'https://api.github.com/user')
            return WorkerResponse.json({ id: 123, login: 'octocat' });

          throw new Error(`Unexpected outbound URL: ${new URL(request.url).origin}`);
        },
      }),
      host: '127.0.0.1',
      port: ports['verifier.test'],
      httpsKey: tls.key,
      httpsCert: tls.cert,
    });

    const tenant = createTenant({
      origin: site,
      instance: verifier,
      site: 'partner',
      key,
      name: 'Partner',
    });

    const server = createHttpsServer(tls, nodeHandler(tenant.handle, site));

    // GitHub is the one party not run for real: its consent page answers at once.
    const github = createHttpsServer(tls, (request, response) => {
      const asked = new URL(request.url!, 'https://github.com').searchParams;
      const back = new URL(asked.get('redirect_uri')!);

      back.searchParams.set('state', asked.get('state')!);
      back.searchParams.set('code', 'fixture');
      response.writeHead(302, { location: back.href }).end();
    });

    const proxy = createHttpServer().on('connect', (request, client, head) => {
      const target = ports[request.url!.split(':')[0]!];

      if (!target) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');

      const upstream = connect(target, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client).pipe(upstream);
      });

      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });

    const listen = (
      s: { listen(port: number, host: string, done: () => void): unknown },
      at: number,
    ) => new Promise<void>((resolve) => s.listen(at, '127.0.0.1', resolve));

    const proxyPort = await port();

    await listen(server, ports['partner.test']!);
    await listen(github, ports['github.com']!);
    await listen(proxy, proxyPort);

    const browser = await chromium.launch({
      executablePath,
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
    });

    try {
      await mf.ready;

      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();

      page.setDefaultTimeout(10000);

      await page.goto(`${site}/`);
      await page.fill('input[name=name]', 'Alice');
      await page.click('text=Create a demo account');
      await page.waitForURL(`${site}/u/alice`);

      // The site's button, the handoff, the provider, and the approval page.
      await page.click('text=Verify an account');
      await page.waitForURL(`${verifier}/verify`);
      await page.click('text=Sign in with GitHub');
      await page.waitForURL(/\/flows\//);
      assert.match(await page.content(), /Partner receives the result/);

      // The approval form's POST is redirected on to the site, which form-action allows.
      await page.check('input[value=public]');
      await page.click('button[value=approve]');
      await page.waitForURL(`${site}/u/alice`);

      const alice = [...tenant.users.values()].find((user) => user.handle === 'alice')!;
      const [[connection, visibility]] = [...alice.links] as [[string, string]];

      assert.equal(visibility, 'public');
      assert.equal(await page.locator(`verily-badge[connection-id="${connection}"]`).count(), 1);

      // Disconnecting from the settings page is a form too, and returns the same way.
      await page.click('text=Manage linked accounts');
      await page.waitForURL(`${verifier}/`);
      await page.click('text=Disconnect');
      await page.waitForURL(`${site}/u/alice`);
      assert.equal(alice.links.size, 0);
    } finally {
      await browser.close();
      await mf.dispose();
      server.close();
      github.close();
      proxy.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
