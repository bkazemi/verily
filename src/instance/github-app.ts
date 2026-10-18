import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { escape } from '../server/escape.js';

/** What `githubApp()` gets back from GitHub once the app is created. */
export interface GithubAppCredentials {
  clientId: string;
  clientSecret: string;
  /** The app's settings page on GitHub. */
  htmlUrl: string;
}

/**
 * Registers a GitHub App for sign-in through GitHub's manifest flow. A local server serves a
 * form that posts the manifest to GitHub, the holder clicks Create there, and GitHub
 * redirects back with a code that is exchanged for the app's client id and secret.
 *
 * The app is public, so any GitHub account can sign in with it, and asks for no
 * permissions and no webhook.
 */
export async function githubApp(options: {
  /** The callback URLs to register, at most 10. */
  callbacks: string[];
  /** The organization to own the app. Without one, the signed-in GitHub account owns it. */
  org?: string;
  /** The app's name, unique across GitHub. Defaults to one made from the first callback. */
  name?: string;
  fetch?: typeof fetch;
  /** Called with the local address to open in a browser. */
  onReady: (url: string) => void;
}): Promise<GithubAppCredentials> {
  const { callbacks, org } = options;
  const request = options.fetch ?? fetch;

  if (callbacks.length === 0) throw new Error('Name at least one callback URL');

  if (callbacks.length > 10) throw new Error('GitHub allows at most 10 callback URLs');

  for (const callback of callbacks)
    if (!URL.canParse(callback) || !/^https?:$/.test(new URL(callback).protocol))
      throw new Error(`${callback} is not an http or https URL`);

  if (org !== undefined && !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(org))
    throw new Error(`${org} is not a GitHub organization name`);

  // GitHub caps app names at 34 characters.
  const name = options.name ?? `Verily ${new URL(callbacks[0]!).hostname}`.slice(0, 34);
  const state = randomBytes(16).toString('base64url');
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const manifest = {
    name,
    description: `Sign-in for Verily on ${new URL(callbacks[0]!).hostname}.`,
    url: new URL(callbacks[0]!).origin,
    redirect_url: `${local}/done`,
    callback_urls: callbacks,
    public: true,
    hook_attributes: { url: new URL(callbacks[0]!).origin, active: false },
    default_permissions: {},
  };

  const target = new URL(
    org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new',
  );

  target.searchParams.set('state', state);

  const credentials = new Promise<GithubAppCredentials>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', local);

      const reply = (status: number, title: string, text: string, body = '') => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });

        res.end(
          `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><p>${escape(text)}</p>${body}`,
        );
      };

      if (url.pathname === '/') {
        // The form submits itself, with a button for when scripts are off.
        return reply(
          200,
          'Create the GitHub App',
          'Sending you to GitHub to create the app.',
          `<form method="post" action="${escape(target.href)}">` +
            `<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">` +
            '<button>Continue to GitHub</button></form>' +
            '<script>document.forms[0].submit()</script>',
        );
      }

      if (url.pathname !== '/done') return reply(404, 'Not found', 'Not found.');

      const code = url.searchParams.get('code');

      // A request without the state this run made did not come from GitHub's redirect.
      if (url.searchParams.get('state') !== state || !code)
        return reply(400, 'Wrong link', 'This link is not from this run. Nothing was created.');

      void convert(code).then(
        (result) => {
          reply(200, 'GitHub App created', 'The app is created. Go back to the terminal.');
          resolve(result);
        },
        (error: unknown) => {
          reply(502, 'Failed', 'GitHub did not return the app. See the terminal.');
          reject(error);
        },
      );
    });
  });

  async function convert(code: string): Promise<GithubAppCredentials> {
    const response = await request(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Verily-V0' },
        signal: AbortSignal.timeout(15000),
      },
    );

    const app: unknown = await response.json().catch(() => undefined);

    if (
      !response.ok ||
      !isRecord(app) ||
      typeof app.client_id !== 'string' ||
      typeof app.client_secret !== 'string' ||
      typeof app.html_url !== 'string'
    )
      throw new Error(`GitHub did not return the app (HTTP ${response.status})`);

    return { clientId: app.client_id, clientSecret: app.client_secret, htmlUrl: app.html_url };
  }

  options.onReady(`${local}/`);

  // Closing waits for the last reply to be sent, then drops idle connections.
  return await credentials.finally(() => server.close());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
