import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * A site that uses a public Verity instance instead of hosting its own: everything such a
 * site's backend does, and nothing more. It signs a handoff for its signed-in user, sends
 * them to the instance, and takes a signed result back. It registers nothing with any
 * sign-in provider and runs no Verity code of its own.
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
  consumed?: { txn: string; payload: string };
}

const mac = (key: string, payload: Buffer) => createHmac('sha256', key).update(payload).digest();

function sign(key: string, payload: object) {
  const bytes = Buffer.from(JSON.stringify(payload));

  return `${bytes.toString('base64url')}.${mac(key, bytes).toString('base64url')}`;
}

/** The payload and its exact bytes, if the MAC verifies. */
function open(key: string, token: string) {
  const [payload, given, ...rest] = token.split('.');

  if (!payload || !given || rest.length) return undefined;

  const bytes = Buffer.from(payload, 'base64url');
  const signature = Buffer.from(given, 'base64url');
  const expected = mac(key, bytes);

  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    return undefined;

  try {
    return {
      raw: bytes.toString(),
      value: JSON.parse(bytes.toString()) as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function createTenant(options: TenantOptions) {
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

  const begin = (purpose: 'connect' | 'manage') =>
    `${options.instance}/begin?${new URLSearchParams({ site: options.site, purpose })}`;

  /**
   * Signs a handoff for this user, binding the state the instance gave this browser. Minting
   * one records its transaction as the user's pending one, which supersedes any before it.
   */
  function authorize(user: User, state: string) {
    const txn = randomBytes(16).toString('base64url');

    user.pending = txn;

    return sign(options.key, {
      site: options.site,
      state,
      id: user.id,
      kind: 'account',
      label: user.name,
      reference: user.handle,
      profileUrl: `${options.origin}/u/${user.handle}`,
      txn,
      exp: Math.floor(Date.now() / 1000) + 240,
    });
  }

  /**
   * Takes a result for this user, or refuses it. It must be signed with this site's key and
   * unexpired, for this user, and for their pending transaction, which it then consumes. The
   * one result last consumed may arrive again, since a retry delivers the same token, and
   * changes nothing. Anything else is stale or not theirs, and changes nothing either.
   */
  function receive(user: User, token: string): boolean {
    const opened = open(options.key, token);

    if (!opened) return false;

    const result = opened.value;

    if (
      result.site !== options.site ||
      result.id !== user.id ||
      typeof result.exp !== 'number' ||
      result.exp * 1000 <= Date.now() ||
      typeof result.txn !== 'string'
    )
      return false;

    if (user.consumed?.txn === result.txn) return user.consumed.payload === opened.raw;

    if (user.pending !== result.txn) return false;

    user.pending = undefined;
    user.consumed = { txn: result.txn, payload: opened.raw };

    if (result.outcome !== 'complete' || typeof result.connection !== 'string') return true;

    if (result.operation === 'disconnect') user.links.delete(result.connection);
    else if (result.visibility === 'public' || result.visibility === 'unlisted')
      user.links.set(result.connection, result.visibility);

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

      return see(
        `${options.instance}/start?${new URLSearchParams({ token: authorize(user, state) })}`,
      );
    }

    if (url.pathname === '/verity/return') {
      if (!user || !receive(user, url.searchParams.get('result') ?? ''))
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
