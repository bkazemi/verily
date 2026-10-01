import { randomBytes } from 'node:crypto';
import { createSiteClient } from '@bkazemi/verity/site';

/**
 * A site that uses a public Verity instance instead of hosting its own: everything such a
 * site's backend does, and nothing more. It vouches for its signed-in user, sends them to
 * the instance, and takes a signed result back, all through the site client. It registers
 * nothing with any sign-in provider and runs no Verity backend of its own.
 *
 * This site shows public links as badges, so it keeps each result. A site that shows its
 * users' links itself can skip that and ask the instance with `client.connections()`.
 */
export interface TenantOptions {
  /** This site's own origin, as registered with the instance. */
  origin: string;
  /** The instance's origin, such as `https://verity.shirkadeh.org`. */
  instance: string;
  /** This site's id in the instance's registry. */
  site: string;
  /** The key the instance holds as `SITE_<ID>_KEY`, shared with nobody else. */
  key: string;
  name: string;
  /** The badge script, `dist/verity.js`, served from this site as a site embedding it would. */
  script?: string;
}

type Visibility = 'public' | 'unlisted';

interface User {
  id: string;
  handle: string;
  name: string;
  /** Connection ids and how each may be shown. An unlisted one is known but never shown. */
  links: Map<string, Visibility>;
  /** The one transaction this user's next result must belong to. */
  pending?: string;
  /** The last result applied, so the same one arriving again is accepted and changes nothing. */
  consumed?: { txn: string; token: string };
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function createTenant(options: TenantOptions) {
  const client = createSiteClient({
    instance: options.instance,
    site: options.site,
    key: options.key,
  });

  const users = new Map<string, User>();
  const sessions = new Map<string, string>();

  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'self'; connect-src 'self' ${options.instance}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };

  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(options.name)}</title><body><header><a href="/">${escape(options.name)}</a></header><main><h1>${escape(title)}</h1>${body}</main></body></html>`,
      { status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } },
    );

  const see = (location: string, cookie?: string) =>
    new Response(null, {
      status: 303,
      headers: { ...headers, Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
    });

  const cookie = (value: string, maxAge: number) =>
    `tenant_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${options.origin.startsWith('https:') ? '; Secure' : ''}`;

  function signedIn(request: Request) {
    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('tenant_session='))
      ?.slice('tenant_session='.length);

    return users.get(sessions.get(token ?? '') ?? '');
  }

  const begin = (purpose: 'connect' | 'manage') => client.beginUrl(purpose);

  /**
   * Where to send this user with a handoff that vouches for them, binding the state the
   * instance gave this browser. Its transaction becomes the user's pending one, which
   * supersedes any before it.
   */
  async function authorize(user: User, state: string) {
    const { url, txn } = await client.authorize(state, {
      id: user.id,
      kind: 'account',
      label: user.name,
      reference: user.handle,
      profileUrl: `${options.origin}/u/${user.handle}`,
    });

    user.pending = txn;

    return url;
  }

  /**
   * Takes a result for this user, or refuses it. The client checks the instance signed it
   * for this site and that it is in date. Because this site stores what a result says, it
   * must also be for this user and for their pending transaction, which it then consumes.
   * The one result last consumed may arrive again, since a retry delivers the same token,
   * and changes nothing. Anything else is stale or not theirs, and changes nothing either.
   */
  async function receive(user: User, token: string): Promise<boolean> {
    const result = await client.result(token);

    if (!result || result.id !== user.id) return false;

    if (user.consumed?.txn === result.txn) return user.consumed.token === token;

    if (user.pending !== result.txn) return false;

    user.pending = undefined;
    user.consumed = { txn: result.txn, token };

    if (result.outcome !== 'complete' || !result.connection) return true;

    if (result.operation === 'disconnect') user.links.delete(result.connection);
    else if (result.visibility) user.links.set(result.connection, result.visibility);

    return true;
  }

  function profile(user: User, viewer: User | undefined) {
    const own = viewer?.id === user.id;
    const links = [...user.links];
    const shown = links.filter(([, visibility]) => visibility === 'public');
    const hidden = links.filter(([, visibility]) => visibility === 'unlisted');

    return page(
      user.name,
      `<p>@${escape(user.handle)}</p>
      ${shown.map(([id]) => `<p><verity-badge backend-url="${escape(options.instance)}/api/verity" connection-id="${escape(id)}"></verity-badge></p>`).join('')}
      ${
        own
          ? `${hidden.map(() => `<p>An account is linked but hidden. <a href="${escape(begin('manage'))}">Make public</a></p>`).join('')}
      <p><a href="${escape(begin('connect'))}">Verify an account</a></p>
      ${links.length ? `<p><a href="${escape(begin('manage'))}">Manage linked accounts</a></p>` : ''}
      <form method="post" action="/logout"><button>Sign out</button></form>`
          : ''
      }
      ${options.script ? '<script src="/verity.js" defer></script>' : ''}`,
    );
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const user = signedIn(request);

    if (request.method === 'POST') {
      if (request.headers.get('origin') !== options.origin) return page('Unavailable', '', 403);

      if (url.pathname === '/signup') {
        const form = new URLSearchParams(await request.text());
        const name = (form.get('name') ?? '').trim();

        const handle = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        if (!name || name.length > 60 || !handle || users.size >= 1000)
          return page('Choose another name', '<p><a href="/">Back</a></p>', 400);

        const id = randomBytes(8).toString('hex');

        const unique = [...users.values()].some((u) => u.handle === handle)
          ? `${handle}-${id.slice(0, 4)}`
          : handle;

        users.set(id, { id, handle: unique, name, links: new Map() });

        const session = randomBytes(32).toString('base64url');

        sessions.set(session, id);

        return see(`/u/${unique}`, cookie(session, 86400));
      }

      if (url.pathname === '/logout') return see('/', cookie('', 0));
    }

    if (request.method !== 'GET') return page('Unavailable', '', 405);

    if (url.pathname === '/verity.js' && options.script)
      return new Response(options.script, {
        headers: { ...headers, 'Content-Type': 'text/javascript' },
      });

    if (url.pathname === '/verity/authorize') {
      const state = url.searchParams.get('state');

      if (!user || !state) return see('/');

      return see(await authorize(user, state));
    }

    if (url.pathname === '/verity/return') {
      if (!user || !(await receive(user, url.searchParams.get('result') ?? '')))
        return page('Result not accepted', '<p>That result is stale or not yours.</p>', 400);

      return see(`/u/${user.handle}`);
    }

    const handle = url.pathname.match(/^\/u\/([a-z0-9-]+)$/)?.[1];

    if (handle) {
      const shown = [...users.values()].find((u) => u.handle === handle);

      return shown ? profile(shown, user) : page('Not found', '', 404);
    }

    if (url.pathname === '/') {
      if (user) return see(`/u/${user.handle}`);

      return page(
        'Welcome',
        `<p>A demonstration site. It keeps its own accounts and sends them to ${escape(new URL(options.instance).host)} to link accounts elsewhere.</p>
        <form method="post" action="/signup"><label>Display name <input name="name" required maxlength="60"></label><button>Create a demo account</button></form>`,
      );
    }

    return page('Not found', '', 404);
  }

  return { handle, users };
}
