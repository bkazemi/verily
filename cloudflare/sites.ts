import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import {
  expired,
  type FlowResult,
  type LocalAccount,
  type LocalKind,
  type Visibility,
} from '../src/core/index.js';
import { hash, secret } from '../src/server/service.js';

/** How long a handoff may take, from `/handoff/request` to `/handoff/accept`, and how far ahead a token may run. */
export const handoffMs = 5 * 60000;

/** How long a site session lasts once the handoff lands. */
export const sessionMs = 3600000;

/** How long a result stays acceptable. A flow expires sooner, so every retry of one is covered. */
const resultMs = 10 * 60000;

/** How many subjects one read may name. */
const maxReadIds = 50;

const stateCookie = 'verily_handoff';

export const sessionCookie = 'verily_site';

/** A site that sends its users here instead of hosting Verily itself. */
export interface Site {
  /** Prefixes its subjects' ids, and names it in every token. */
  id: string;
  /** The site name stamped on its subjects. */
  name: string;
  origin: string;
  /** The site's endpoint that signs a handoff for its signed-in user. */
  authorizeUrl: string;
  /** Where a holder is sent back to when a flow ends. */
  returnUrl: string;
  /** Shared with the site's backend. Signs handoffs one way and results the other. */
  key: string;
  /** The provider ids its holders may use. Absent means every one this instance offers. */
  providers?: string[];
  /** The visibilities its holders may choose. Absent means both. */
  visibility?: Visibility[];
}

export type Purpose = 'connect' | 'manage';

interface State {
  site: string;
  purpose: Purpose;
  expiresAt: number;
}

/** How a holder may have an account listed, as the library's mark route takes it. */
export type Listing = 'preferred' | 'current' | 'unused' | 'retired';

/**
 * What the worker holds for a disconnect or a mark, which have no flow of their own to
 * hold it.
 */
interface Operation {
  connection: string;
  visibility?: Visibility;
  /** How the account is to be listed, for a mark. Absent, the operation is a disconnect. */
  mark?: Listing;
  /** Set once the change has committed. Until then the operation is pending. */
  finishedAt?: number;
}

export interface SiteSession {
  site: string;
  purpose: Purpose;
  txn: string;
  local: LocalAccount;
  expiresAt: number;
  /** Set by the first return. Nothing new can start after it, but a retry still resolves. */
  closed?: boolean;
  /** The flow whose result this session returned with. No other flow's result is signed. */
  returned?: string;
  operation?: Operation;
  /**
   * Opened for the dialog on the site's own page, which reads how each flow ended for
   * itself. No flow returns to the site from it, so no flow's end closes it, and the
   * holder can try again in the same dialog.
   */
  dialog?: true;
}

/** A loopback origin may be plain HTTP, as the library allows its own base URL to be. */
function secureOrigin(value: string) {
  const url = new URL(value);

  return (
    url.origin === value &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  );
}

/**
 * The registered sites, from the `SITES` variable, each with its key from the secret
 * `SITE_<ID>_KEY`. Anything wrong in the list refuses to start rather than serving a site
 * half set up. A site whose key is missing or malformed is left out instead.
 */
export function registry(config: unknown, secrets: Record<string, unknown>): Map<string, Site> {
  const list: unknown = typeof config === 'string' ? JSON.parse(config) : (config ?? []);

  if (!Array.isArray(list)) throw new Error('SITES must be a list');

  const sites = new Map<string, Site>();

  for (const entry of list as Record<string, unknown>[]) {
    const { id, name, origin, authorizeUrl, returnUrl, providers, visibility } = entry ?? {};

    if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id) || sites.has(id))
      throw new Error('Each site needs a unique id of lowercase letters, digits and hyphens');

    const key = secrets[`SITE_${id.toUpperCase().replace(/-/g, '_')}_KEY`];

    if (typeof name !== 'string' || !name || name.length > 100)
      throw new Error(`Site ${id} needs a name`);

    if (typeof origin !== 'string' || !secureOrigin(origin))
      throw new Error(`Site ${id} needs an HTTPS origin without a trailing slash`);

    for (const url of [authorizeUrl, returnUrl])
      if (typeof url !== 'string' || new URL(url).origin !== origin)
        throw new Error(`Site ${id} must authorize and return on its own origin`);

    if (
      providers !== undefined &&
      (!Array.isArray(providers) ||
        !providers.length ||
        providers.some((p) => typeof p !== 'string' || !p))
    )
      throw new Error(`Site ${id} must list at least one provider id, or none at all`);

    if (
      visibility !== undefined &&
      (!Array.isArray(visibility) ||
        !visibility.length ||
        visibility.some((v) => v !== 'public' && v !== 'unlisted'))
    )
      throw new Error(`Site ${id} must list "public", "unlisted" or both, or no visibility at all`);

    // A secret is set apart from a deployment and cannot be checked before one. A wrong
    // one leaves its own site unserved, and never takes the rest of the instance with it.
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(key)) {
      console.error(`Site ${id} is not served: it needs a base64url key of at least 32 bytes`);

      continue;
    }

    sites.set(id, {
      id,
      name,
      origin,
      authorizeUrl: authorizeUrl as string,
      returnUrl: returnUrl as string,
      key,
      ...(providers ? { providers: providers as string[] } : {}),
      ...(visibility ? { visibility: visibility as Visibility[] } : {}),
    });
  }

  return sites;
}

const mac = (key: string, payload: Buffer) => createHmac('sha256', key).update(payload).digest();

/** `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`, the payload being JSON. */
export function sign(key: string, payload: object): string {
  const bytes = Buffer.from(JSON.stringify(payload));

  return `${bytes.toString('base64url')}.${mac(key, bytes).toString('base64url')}`;
}

/** The payload of a token, without checking it. Only good for choosing which key checks it. */
export function peek(token: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());

    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The payload of a token whose MAC verifies under `key`, compared in constant time. */
export function open(key: string, token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');

  if (parts.length !== 2) return undefined;

  const payload = Buffer.from(parts[0]!, 'base64url');
  const given = Buffer.from(parts[1]!, 'base64url');
  const expected = mac(key, payload);

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

  return peek(token);
}

const cookie = (request: Request, name: string) =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const setCookie = (name: string, value: string, ms: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ms / 1000}`;

const string = (value: unknown, max = 500): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * The subject a handoff vouches for, as the library will hold it, or undefined if the
 * handoff describes one badly. `validate` is the library's own check of the subject, which
 * the union of every site's origin would not make alone.
 */
function subject(
  site: Site,
  payload: Record<string, unknown>,
  validate: (local: LocalAccount) => LocalAccount,
): LocalAccount | undefined {
  if (
    !string(payload.id, 400) ||
    !string(payload.label) ||
    !string(payload.reference) ||
    (payload.kind !== undefined && !['account', 'page', 'site'].includes(String(payload.kind))) ||
    (payload.profileUrl !== undefined &&
      (typeof payload.profileUrl !== 'string' ||
        !URL.canParse(payload.profileUrl) ||
        new URL(payload.profileUrl).origin !== site.origin))
  )
    return undefined;

  try {
    return validate({
      id: `${site.id}:${payload.id}`,
      ...(payload.kind ? { kind: payload.kind as LocalKind } : {}),
      label: payload.label,
      reference: payload.reference,
      ...(payload.profileUrl ? { profileUrl: payload.profileUrl as string } : {}),
      siteName: site.name,
    });
  } catch {
    return undefined;
  }
}

/**
 * Handoffs from registered sites, the sessions they open, and the results sent back. The
 * site vouches for its signed-in user; this is where that is checked, and a handoff is
 * bound to the browser that asked for it, the way OAuth binds a callback with `state`.
 */
export class Sites {
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly sites: Map<string, Site>,
  ) {}

  /**
   * Starts a handoff: a state stored with the site and purpose, set in this browser, and
   * sent to the site to sign into its token. Returns where to go and the cookie to set.
   */
  async begin(site: string | null, purpose: string | null) {
    const registered = this.sites.get(site ?? '');

    if (!registered || !['connect', 'manage'].includes(purpose ?? '')) return undefined;

    const state = secret();

    await this.storage.put<State>(`site/state/${hash(state)}`, {
      site: registered.id,
      purpose: purpose as Purpose,
      expiresAt: Date.now() + handoffMs,
    });

    const location = new URL(registered.authorizeUrl);

    location.searchParams.set('state', state);

    return { location: location.href, cookie: setCookie(stateCookie, state, handoffMs) };
  }

  /**
   * Redeems a signed handoff for a session, or refuses it. Every refusal is the same
   * undefined, so a caller cannot tell which check failed. `validate` is the library's own
   * check of the subject, which the union of every site's origin would not make alone.
   */
  async start(
    request: Request,
    token: string,
    validate: (local: LocalAccount) => LocalAccount,
  ): Promise<{ purpose: Purpose; cookies: string[] } | undefined> {
    const site = this.sites.get(String(peek(token)?.site ?? ''));

    if (!site) return undefined;

    const payload = open(site.key, token);
    const now = Date.now();
    const held = cookie(request, stateCookie);

    if (
      !payload ||
      payload.site !== site.id ||
      typeof payload.exp !== 'number' ||
      payload.exp * 1000 <= now ||
      payload.exp * 1000 > now + handoffMs ||
      !string(payload.state) ||
      !held ||
      // The state this browser was given, which a browser sent someone else's link lacks.
      !timingSafeEqual(Buffer.from(hash(held)), Buffer.from(hash(payload.state))) ||
      !string(payload.txn)
    )
      return undefined;

    const local = subject(site, payload, validate);

    if (!local) return undefined;

    const session = secret();
    const txn = payload.txn;

    // The state is consumed with the session made, so the token and the state each work once.
    const purpose = await this.storage.transaction(async (tx) => {
      const key = `site/state/${hash(payload.state as string)}`;
      const state = await tx.get<State>(key);

      if (!state || state.site !== site.id || expired(state, now)) return undefined;

      await tx.delete(key);

      await tx.put<SiteSession>(`site/session/${hash(session)}`, {
        site: site.id,
        purpose: state.purpose,
        txn,
        local,
        expiresAt: now + sessionMs,
      });

      return state.purpose;
    });

    if (!purpose) return undefined;

    return {
      purpose,
      cookies: [setCookie(sessionCookie, session, sessionMs), setCookie(stateCookie, '', 0)],
    };
  }

  /**
   * Redeems a handoff a site's own page presents, for the connect dialog on that page, and
   * returns the session it opens. There is no redirect to bind with a state. The site's
   * backend gave the token to its signed-in user's page, and a browser sends that page's
   * origin with the request, so the token is marked for this use, taken only from the
   * site's origin, and works once. The session is the same as a redirect opens, carried by
   * the page in a header because the cookie would be another site's on that page.
   *
   * `admit` counts the handoff against the site that signed it, and is asked only once it
   * has verified, before anything is stored: the request has no cookie to say whose it is,
   * and a token that does not verify must spend nothing of the site it names. A handoff
   * not admitted is 'limited', and is not used up.
   */
  async dialog(
    token: string,
    origin: string | null,
    validate: (local: LocalAccount) => LocalAccount,
    admit: (site: Site) => Promise<boolean>,
  ): Promise<{ site: Site; session: string } | 'limited' | undefined> {
    const site = this.sites.get(String(peek(token)?.site ?? ''));

    if (!site || origin !== site.origin) return undefined;

    const payload = open(site.key, token);
    const now = Date.now();

    if (
      !payload ||
      payload.site !== site.id ||
      payload.op !== 'dialog' ||
      typeof payload.exp !== 'number' ||
      payload.exp * 1000 <= now ||
      payload.exp * 1000 > now + handoffMs ||
      !string(payload.txn)
    )
      return undefined;

    const local = subject(site, payload, validate);

    if (!local) return undefined;

    if (!(await admit(site))) return 'limited';

    const session = secret();
    const txn = payload.txn;

    // Kept until the token would have expired anyway, so the token works once.
    const used = `site/state/${hash(`dialog ${site.id} ${txn}`)}`;

    const opened = await this.storage.transaction(async (tx) => {
      if (await tx.get(used)) return false;

      await tx.put<State>(used, { site: site.id, purpose: 'connect', expiresAt: now + handoffMs });

      await tx.put<SiteSession>(`site/session/${hash(session)}`, {
        site: site.id,
        purpose: 'connect',
        txn,
        local,
        expiresAt: now + sessionMs,
        dialog: true,
      });

      return true;
    });

    return opened ? { site, session } : undefined;
  }

  /**
   * Checks a site backend's request to read its own subjects' connections: a token under
   * that site's key, marked as a read so that a handoff token, which passes through a
   * browser, is never one. The ids are the site's own, as it sends them in a handoff, and
   * are only ever looked up under its prefix, so no site reaches another's subjects.
   */
  read(token: string): { site: Site; ids: string[] } | undefined {
    const site = this.sites.get(String(peek(token)?.site ?? ''));

    if (!site) return undefined;

    const payload = open(site.key, token);
    const now = Date.now();

    if (
      !payload ||
      payload.site !== site.id ||
      payload.op !== 'read' ||
      typeof payload.exp !== 'number' ||
      payload.exp * 1000 <= now ||
      payload.exp * 1000 > now + handoffMs ||
      !Array.isArray(payload.ids) ||
      !payload.ids.length ||
      payload.ids.length > maxReadIds ||
      !payload.ids.every((id) => string(id, 400))
    )
      return undefined;

    return { site, ids: [...new Set(payload.ids as string[])] };
  }

  /** This browser's site session, whether or not it has returned yet. */
  async session(request: Request): Promise<{ key: string; session: SiteSession } | undefined> {
    const token = cookie(request, sessionCookie);

    if (!token) return undefined;

    const key = `site/session/${hash(token)}`;
    const session = await this.storage.get<SiteSession>(key);

    if (!session || expired(session, Date.now()) || !this.sites.has(session.site)) return undefined;

    return { key, session };
  }

  /**
   * A session that can still start something: not yet returned, and not partway through a
   * disconnect. A pending disconnect holds the session's one result, so nothing else may
   * start that could end with another; only retrying that disconnect goes on.
   */
  async open(request: Request) {
    const found = await this.session(request);

    return found && !found.session.closed && !found.session.operation ? found : undefined;
  }

  /**
   * Where a flow that ended goes, as a function of the stored result alone: the same
   * result signs the same token, since its expiry is counted from when the flow ended.
   * Only the registry says where a site's holders return, and the first return closes the
   * session to anything new.
   */
  async finish(
    flow: string,
    context: Record<string, string> | undefined,
    local: LocalAccount | undefined,
    result: FlowResult,
  ): Promise<string | undefined> {
    const site = this.sites.get(context?.site ?? '');

    if (!site || !context?.txn || !local) return undefined;

    if (!['connect', 'renew', 'visibility'].includes(result.kind)) return undefined;

    // The sign-in window of a dialog shows the flow's own result page and goes nowhere.
    if (
      context.session?.startsWith('site/session/') &&
      (await this.storage.get<SiteSession>(context.session))?.dialog
    )
      return undefined;

    // Another flow's return, or a disconnect, already speaks for this transaction. This
    // flow ended all the same, however it ended, and its holder sees the result page.
    if (!(await this.claim(context.session, flow))) return undefined;

    return this.returnUrl(site, local, context.txn, {
      operation: result.kind,
      outcome: result.phase,
      connection: result.connectionId,
      visibility: result.visibility,
      finishedAt: result.finishedAt,
    });
  }

  /**
   * Takes the session's one return for a flow, and closes the session with it. A site
   * accepts one result for a transaction, so only one is ever signed: the first flow to end
   * holds the return, every load of that flow holds it again, and no flow gets it once a
   * disconnect is recorded, pending or done. Decided in one transaction, as `pending` is,
   * so of a flow ending and a disconnect starting exactly one goes on.
   */
  private async claim(key: string | undefined, flow: string): Promise<boolean> {
    if (!key?.startsWith('site/session/')) return false;

    return this.storage.transaction(async (tx) => {
      const session = await tx.get<SiteSession>(key);

      if (!session || expired(session, Date.now()) || session.operation) return false;

      if (session.returned) return session.returned === flow;

      await tx.put(key, { ...session, closed: true, returned: flow });

      return true;
    });
  }

  /** The signed result a holder carries back to their site. */
  returnUrl(
    site: Site,
    local: LocalAccount,
    txn: string,
    result: {
      operation: string;
      outcome: string;
      connection?: string;
      visibility?: Visibility;
      finishedAt: number;
    },
  ): string {
    if (!local.id.startsWith(`${site.id}:`)) throw new Error('Subject from another site');

    const complete = result.outcome === 'complete';

    const token = sign(site.key, {
      site: site.id,
      id: local.id.slice(site.id.length + 1),
      operation: result.operation,
      outcome: result.outcome,
      ...(complete ? { connection: result.connection, visibility: result.visibility } : {}),
      txn,
      exp: Math.floor((result.finishedAt + resultMs) / 1000),
    });

    const url = new URL(site.returnUrl);

    url.searchParams.set('result', token);

    return url.href;
  }

  /**
   * Records a disconnect or a mark as pending on the session before anything is changed, so
   * a retry knows what it is finishing. A session already carrying one only resumes that one.
   */
  async pending(
    key: string,
    connection: string,
    visibility: Visibility,
    mark?: Listing,
  ): Promise<SiteSession | undefined> {
    return this.storage.transaction(async (tx) => {
      const session = await tx.get<SiteSession>(key);

      if (!session || expired(session, Date.now())) return undefined;

      if (session.operation)
        return session.operation.connection === connection && session.operation.mark === mark
          ? session
          : undefined;

      if (session.closed) return undefined;

      session.operation = { connection, visibility, ...(mark ? { mark } : {}) };
      await tx.put(key, session);

      return session;
    });
  }

  /** Records an operation as done once its change has committed, and closes the session. */
  async completed(key: string): Promise<SiteSession> {
    return this.storage.transaction(async (tx) => {
      const session = (await tx.get<SiteSession>(key))!;

      session.operation!.finishedAt ??= Date.now();
      session.closed = true;
      await tx.put(key, session);

      return session;
    });
  }
}
