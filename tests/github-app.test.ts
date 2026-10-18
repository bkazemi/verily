import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubApp } from '../src/instance/github-app.js';

/** Starts the flow and waits for its local address. */
function started(options: Partial<Parameters<typeof githubApp>[0]> = {}) {
  const calls: string[] = [];
  let ready!: (url: string) => void;
  const local = new Promise<string>((resolve) => (ready = resolve));

  const result = githubApp({
    callbacks: ['https://site.test/verily/callback', 'http://localhost:3000/verily/callback'],
    fetch: (async (url) => {
      calls.push(String(url));

      return Response.json(
        {
          client_id: 'Iv23client',
          client_secret: 'private-secret',
          html_url: 'https://github.com/apps/verily-site-test',
          pem: 'private-key',
        },
        { status: 201 },
      );
    }) as typeof fetch,
    onReady: ready,
    ...options,
  });

  return { calls, local, result };
}

/** Reads the manifest form the local page serves. */
async function form(local: string) {
  const html = await (await fetch(local)).text();
  const action = /action="([^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&');
  const value = /name="manifest" value="([^"]+)"/.exec(html)![1]!.replaceAll('&quot;', '"');

  return { action: new URL(action), manifest: JSON.parse(value) as Record<string, unknown> };
}

test('github-app posts a public manifest and returns the converted credentials', async () => {
  const { calls, local, result } = started();
  const page = await local;
  const { action, manifest } = await form(page);

  assert.equal(action.origin + action.pathname, 'https://github.com/settings/apps/new');

  assert.deepEqual(manifest, {
    name: 'Verily site.test',
    description: 'Sign-in for Verily on site.test.',
    url: 'https://site.test',
    redirect_url: new URL('/done', page).href,
    callback_urls: ['https://site.test/verily/callback', 'http://localhost:3000/verily/callback'],
    public: true,
    hook_attributes: { url: 'https://site.test', active: false },
    default_permissions: {},
  });

  // A redirect without this run's state is turned away and the run keeps waiting.
  const stray = await fetch(new URL('/done?code=abc&state=wrong', page));

  assert.equal(stray.status, 400);
  assert.deepEqual(calls, []);

  const state = action.searchParams.get('state')!;
  const done = await fetch(new URL(`/done?code=abc&state=${state}`, page));

  assert.equal(done.status, 200);

  assert.deepEqual(await result, {
    clientId: 'Iv23client',
    clientSecret: 'private-secret',
    htmlUrl: 'https://github.com/apps/verily-site-test',
  });

  assert.deepEqual(calls, ['https://api.github.com/app-manifests/abc/conversions']);
});

test('github-app posts to the organization and fails when GitHub returns no app', async () => {
  const { local, result } = started({
    org: 'acme',
    name: 'Acme sign-in',
    fetch: (async () => Response.json({ message: 'Not Found' }, { status: 404 })) as typeof fetch,
  });

  const page = await local;
  const { action, manifest } = await form(page);

  assert.equal(action.pathname, '/organizations/acme/settings/apps/new');
  assert.equal(manifest.name, 'Acme sign-in');

  const rejected = assert.rejects(result, /GitHub did not return the app \(HTTP 404\)/);

  const done = await fetch(
    new URL(`/done?code=abc&state=${action.searchParams.get('state')}`, page),
  );

  assert.equal(done.status, 502);
  await rejected;
});

test('github-app checks its arguments before starting', async () => {
  const onReady = () => assert.fail('the server should not start');

  await assert.rejects(githubApp({ callbacks: [], onReady }), /at least one callback/);

  await assert.rejects(
    githubApp({ callbacks: Array(11).fill('https://site.test/callback'), onReady }),
    /at most 10/,
  );

  await assert.rejects(githubApp({ callbacks: ['ftp://site.test/'], onReady }), /not an http/);

  await assert.rejects(
    githubApp({ callbacks: ['https://site.test/'], org: '../x', onReady }),
    /not a GitHub organization/,
  );
});
