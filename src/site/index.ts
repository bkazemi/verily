import type { Evidence, LocalKind, Visibility } from '../core/index.js';

/**
 * For a site that uses a hosted Verily instance instead of running its own. The site's
 * backend does three things, and this is all of them: it vouches to the instance for its
 * signed-in user; it reads its users' connections back; and, if it wants, it checks the
 * result a user returns with. `handler()` serves the endpoints the first of those needs,
 * so a site mounts it and writes none of them.
 *
 * Nothing here needs Node. It uses Web Crypto and `fetch`, so it runs wherever a backend
 * does. It must only ever run on a backend: the key is what the instance believes.
 */
export interface SiteClientOptions {
  /** The instance's origin, such as `https://verily.shirkadeh.org`. */
  instance: string;
  /** This site's id in the instance's registry. */
  site: string;
  /** The key the instance holds for this site. Never sent to a browser. */
  key: string;
  /**
   * Set this and the site's user ids never leave it: every id this client is given is this
   * site's own, and the instance is sent a stand-in made with `pseudonym()`. A subject
   * given no `reference` gets one made the same way. At least 32 characters, kept for this
   * alone, and never changed: a different secret makes every user a different user to the
   * instance, and they lose their links.
   */
  idSecret?: string;
  /** How long `connections()` reuses an answer, in milliseconds. Absent, every call reads. */
  cacheMs?: number;
  /** Replaces the global `fetch`, for a runtime or a test that needs its own. */
  fetch?: typeof fetch;
}

/** What `handler()` needs from the site: who is signed in, and where its own pages are. */
export interface SiteHandlerOptions {
  /**
   * This site's signed-in user for a request, by the site's own session, or undefined if
   * nobody is signed in. Nothing in a request to the handler names a user.
   */
  authenticate(request: Request): Promise<SiteSubject | undefined> | SiteSubject | undefined;
  /** Where a signed-out user who arrives from the instance goes to sign in. Absent, a 401. */
  signInUrl?: string;
  /** Where a user goes when they come back from the instance. Absent, the site's root. */
  returnUrl?: string;
}

/** The signed-in user a handoff vouches for, as the instance will record them. */
export interface SiteSubject {
  /** Private, stable, and never reassigned. The instance never shows it. */
  id: string;
  /** Display text for the subject. */
  label: string;
  /**
   * Durable and safe to show publicly. Never an email address. Optional only for a client
   * with an `idSecret`, which makes one when it is absent.
   */
  reference?: string;
  /** Absent means the site did not say. */
  kind?: LocalKind;
  /** Must be on this site's registered origin. */
  profileUrl?: string;
}

/** How a flow a user was sent into ended, as the instance signed it. */
export interface SiteResult {
  site: string;
  id: string;
  /** `mark` is an account listed another way or retired: read its records again to see how. */
  operation: 'connect' | 'renew' | 'visibility' | 'disconnect' | 'mark';
  outcome: 'complete' | 'cancelled' | 'failed';
  /** Present when the outcome is complete. */
  connection?: string;
  visibility?: Visibility;
  /** The transaction of the handoff this result answers. */
  txn: string;
  exp: number;
}

/** How many subjects the instance reads in one request. */
const maxReadIds = 50;

const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

/** `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`, the payload being JSON. */
async function sign(secret: string, payload: object): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(payload));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), bytes);

  return `${encode(bytes)}.${encode(new Uint8Array(mac))}`;
}

const random = () => encode(crypto.getRandomValues(new Uint8Array(16)));

const seconds = () => Math.floor(Date.now() / 1000);

const unstored = { 'Cache-Control': 'no-store' };

/**
 * A stable stand-in for one of a site's own user ids, for a site that would rather its ids
 * never left it. The same secret and value always give the same result, so nothing has to
 * be stored. The secret must never change: a different one gives every user a different
 * stand-in, which the instance takes for a different user. Use a secret kept for this alone,
 * and not the site's key, which is meant to be replaceable.
 *
 * `purpose` separates stand-ins made from one secret, so a private id and a public
 * reference made from the same user id tell nobody they belong together.
 */
export async function pseudonym(secret: string, value: string, purpose = 'id'): Promise<string> {
  if (secret.length < 32) throw new Error('A pseudonym secret needs at least 32 characters');

  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(`verily ${purpose}\n${value}`),
  );

  return encode(new Uint8Array(mac));
}

export function createSiteClient(options: SiteClientOptions) {
  const instance = new URL(options.instance);

  if (
    instance.origin !== options.instance ||
    (instance.protocol !== 'https:' &&
      !(instance.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(instance.hostname)))
  )
    throw new Error('instance must be an HTTPS origin without a trailing slash');

  if (!/^[a-z0-9-]{1,32}$/.test(options.site)) throw new Error('Invalid site id');

  if (!/^[A-Za-z0-9_-]{43,}$/.test(options.key))
    throw new Error('key must be the base64url key the instance holds for this site');

  const request = options.fetch ?? fetch;
  const idSecret = options.idSecret;

  /** The id the instance knows a user by: the site's own, or its stand-in. */
  const sent = async (id: string) => (idSecret ? pseudonym(idSecret, id) : id);

  /** A subject as it goes into a token, common to both kinds of handoff. */
  async function vouched(subject: SiteSubject) {
    const reference =
      subject.reference ??
      (idSecret
        ? `${options.site}-${(await pseudonym(idSecret, subject.id, 'reference')).slice(0, 10)}`
        : undefined);

    if (!reference) throw new Error('A subject needs a reference, or the client an idSecret');

    return {
      id: await sent(subject.id),
      ...(subject.kind ? { kind: subject.kind } : {}),
      label: subject.label,
      reference,
      ...(subject.profileUrl ? { profileUrl: subject.profileUrl } : {}),
    };
  }

  /** What was last read for each id sent, while `cacheMs` says it may be reused. */
  const cached = new Map<string, { readAt: number; connections: Evidence[] }>();

  const client = {
    /**
     * Where to link a signed-in user: to verify an account, or to manage the ones they
     * have. The instance sends them on to this site's authorize endpoint with a `state`.
     */
    beginUrl(purpose: 'connect' | 'manage' = 'connect'): string {
      return `${instance.origin}/handoff/request?${new URLSearchParams({ site: options.site, purpose })}`;
    },

    /**
     * For the authorize endpoint: where to redirect a signed-in user, with a handoff that
     * vouches for them. Call it only once this site has itself established who they are,
     * with the `state` the instance sent. `txn` names this handoff in the result that
     * comes back; a site that reads its connections from the instance can ignore it.
     */
    async authorize(state: string, subject: SiteSubject): Promise<{ url: string; txn: string }> {
      if (!state) throw new Error('The state the instance sent is required');

      const txn = random();

      const token = await sign(options.key, {
        site: options.site,
        state,
        ...(await vouched(subject)),
        txn,
        // Under the five minutes the instance allows, so a slow clock does not overrun it.
        exp: seconds() + 240,
      });

      return { url: `${instance.origin}/handoff/accept?${new URLSearchParams({ token })}`, txn };
    },

    /**
     * For a page that shows the connect pill with `handoff-url`: a token that vouches for
     * the signed-in user to the dialog on that page. Serve it from an endpoint on this
     * site, to its signed-in user only and to a POST from this site's own pages, and call
     * it only once this site has itself established who they are. It works once, within
     * four minutes, and only from a page on this site's registered origin.
     */
    async handoff(subject: SiteSubject): Promise<{ token: string; txn: string }> {
      const txn = random();

      const token = await sign(options.key, {
        site: options.site,
        op: 'dialog',
        ...(await vouched(subject)),
        txn,
        exp: seconds() + 240,
      });

      return { token, txn };
    },

    /**
     * Each subject's connections, unlisted ones included, by the id this site vouched for
     * them with. Only this site can read them. Every id asked for is in the answer, with an
     * empty list for a subject who has none. Revoked and expired records are included, so
     * show one only when its `status` is `verified`. With `cacheMs` set, an answer read
     * within it is reused unless `fresh` asks for a new one.
     */
    async connections(
      ids: string[],
      { fresh = false }: { fresh?: boolean } = {},
    ): Promise<Record<string, Evidence[]>> {
      // No prototype, so an id such as `__proto__` is an entry like any other.
      const answer: Record<string, Evidence[]> = Object.create(null);
      const found: Record<string, Evidence[]> = Object.create(null);
      const names = new Map<string, string>();
      const now = Date.now();

      for (const id of new Set(ids)) names.set(id, await sent(id));

      // An answer too old to reuse is dropped, or a client that lives as long as its
      // server would keep every user it ever read.
      for (const [id, held] of cached)
        if (now - held.readAt >= (options.cacheMs ?? 0)) cached.delete(id);

      const wanted = [...new Set(names.values())].filter((id) => {
        const held = cached.get(id);

        if (fresh || !held || now - held.readAt >= (options.cacheMs ?? 0)) return true;

        found[id] = held.connections;

        return false;
      });

      for (let at = 0; at < wanted.length; at += maxReadIds) {
        const token = await sign(options.key, {
          site: options.site,
          op: 'read',
          ids: wanted.slice(at, at + maxReadIds),
          exp: seconds() + 60,
        });

        const response = await request(`${instance.origin}/site/connections`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) throw new Error(`The instance answered ${response.status}`);

        const { connections } = (await response.json()) as {
          connections: Record<string, Evidence[]>;
        };

        for (const id of Object.keys(connections)) {
          found[id] = connections[id]!;

          if (options.cacheMs) cached.set(id, { readAt: now, connections: found[id] });
        }
      }

      for (const [id, name] of names) answer[id] = found[name] ?? [];

      return answer;
    },

    /**
     * For the return endpoint: the result a user came back with, if the instance signed it
     * for this site and it has not expired. Undefined otherwise. A site that reads its
     * connections from the instance has no need of it and can send the user straight on.
     *
     * A site that stores what a result says must also check that `id` is the signed-in
     * user and that `txn` is the handoff it is waiting on, since a user's own older result
     * is validly signed too. With an `idSecret`, `id` is the user's stand-in.
     */
    async result(token: string): Promise<SiteResult | undefined> {
      const [payload, mac, ...rest] = token.split('.');

      if (!payload || !mac || rest.length) return undefined;

      try {
        const bytes = decode(payload);

        if (!(await crypto.subtle.verify('HMAC', await hmacKey(options.key), decode(mac), bytes)))
          return undefined;

        const result = JSON.parse(new TextDecoder().decode(bytes)) as SiteResult;

        return result.site === options.site &&
          typeof result.exp === 'number' &&
          result.exp > seconds()
          ? result
          : undefined;
      } catch {
        return undefined;
      }
    },

    /**
     * The endpoints a site needs, as one function from a `Request` to a `Response`. Mount
     * it on every path under one prefix, such as `/api/verily/*`. The authorize and return
     * URLs registered with the instance are `<prefix>/authorize` and `<prefix>/return`,
     * and the connect pill's `handoff-url` is `<prefix>/handoff`.
     */
    handler(site: SiteHandlerOptions): (request: Request) => Promise<Response> {
      const go = (location: string) =>
        new Response(null, { status: 303, headers: { Location: location, ...unstored } });

      const refuse = (status: number) => new Response(null, { status, headers: unstored });

      return async (request) => {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname.split('/').pop()}`;

        // Wherever the user went on the instance, this site reads their links from it.
        if (route === 'GET return') return go(site.returnUrl ?? '/');

        if (route === 'GET authorize') {
          const state = url.searchParams.get('state');

          if (!state) return refuse(400);

          const subject = await site.authenticate(request);

          if (!subject) return site.signInUrl ? go(site.signInUrl) : refuse(401);

          return go((await client.authorize(state, subject)).url);
        }

        if (route === 'POST handoff') {
          // The token is for this site's own pages. A browser says where a request is from.
          if ((request.headers.get('sec-fetch-site') ?? 'same-origin') !== 'same-origin')
            return refuse(403);

          const subject = await site.authenticate(request);

          if (!subject) return refuse(401);

          return new Response(JSON.stringify({ token: (await client.handoff(subject)).token }), {
            headers: { 'Content-Type': 'application/json', ...unstored },
          });
        }

        return refuse(404);
      };
    },
  };

  return client;
}

export type SiteClient = ReturnType<typeof createSiteClient>;
