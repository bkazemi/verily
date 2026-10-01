import type { Evidence, LocalKind, Visibility } from '../core/index.js';

/**
 * For a site that uses a hosted Verity instance instead of running its own. The site's
 * backend does three things, and this is all of them: it sends a signed-in user to the
 * instance, vouching for who they are; it reads its users' connections back; and, if it
 * wants, it checks the result a user returns with.
 *
 * Nothing here needs Node. It uses Web Crypto and `fetch`, so it runs wherever a backend
 * does. It must only ever run on a backend: the key is what the instance believes.
 */
export interface SiteClientOptions {
  /** The instance's origin, such as `https://verity.shirkadeh.org`. */
  instance: string;
  /** This site's id in the instance's registry. */
  site: string;
  /** The key the instance holds for this site. Never sent to a browser. */
  key: string;
  /** Replaces the global `fetch`, for a runtime or a test that needs its own. */
  fetch?: typeof fetch;
}

/** The signed-in user a handoff vouches for, as the instance will record them. */
export interface SiteSubject {
  /** Private, stable, and never reassigned. The instance never shows it. */
  id: string;
  /** Display text for the subject. */
  label: string;
  /** Durable and safe to show publicly. Never an email address. */
  reference: string;
  /** Absent means the site did not say. */
  kind?: LocalKind;
  /** Must be on this site's registered origin. */
  profileUrl?: string;
}

/** How a flow a user was sent into ended, as the instance signed it. */
export interface SiteResult {
  site: string;
  id: string;
  operation: 'connect' | 'renew' | 'visibility' | 'disconnect';
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
    encoder.encode(`verity ${purpose}\n${value}`),
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

  return {
    /**
     * Where to link a signed-in user: to verify an account, or to manage the ones they
     * have. The instance sends them on to this site's authorize endpoint with a `state`.
     */
    beginUrl(purpose: 'connect' | 'manage' = 'connect'): string {
      return `${instance.origin}/begin?${new URLSearchParams({ site: options.site, purpose })}`;
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
        id: subject.id,
        ...(subject.kind ? { kind: subject.kind } : {}),
        label: subject.label,
        reference: subject.reference,
        ...(subject.profileUrl ? { profileUrl: subject.profileUrl } : {}),
        txn,
        // Under the five minutes the instance allows, so a slow clock does not overrun it.
        exp: seconds() + 240,
      });

      return { url: `${instance.origin}/start?${new URLSearchParams({ token })}`, txn };
    },

    /**
     * Each subject's connections, unlisted ones included, by the id this site vouched for
     * them with. Only this site can read them. Every id asked for is in the answer, with an
     * empty list for a subject who has none. Revoked and expired records are included, so
     * show one only when its `status` is `verified`.
     */
    async connections(ids: string[]): Promise<Record<string, Evidence[]>> {
      const wanted = [...new Set(ids)];
      // No prototype, so an id such as `__proto__` is an entry like any other.
      const found: Record<string, Evidence[]> = Object.create(null);

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

        for (const id of Object.keys(connections)) found[id] = connections[id]!;
      }

      return found;
    },

    /**
     * For the return endpoint: the result a user came back with, if the instance signed it
     * for this site and it has not expired. Undefined otherwise. A site that reads its
     * connections from the instance has no need of it and can send the user straight on.
     *
     * A site that stores what a result says must also check that `id` is the signed-in
     * user and that `txn` is the handoff it is waiting on, since a user's own older result
     * is validly signed too.
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
  };
}

export type SiteClient = ReturnType<typeof createSiteClient>;
