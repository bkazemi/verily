import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  expired,
  type FlowResult,
  type LocalAccount,
  type LocalKind,
  type Visibility,
} from '../core/index.js';
import type { Store } from './store.js';
import { limits } from './limits.js';
import { readCookie, setCookie } from './page.js';
import { hash, secret } from '../server/service.js';

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

/** What an operator may change about a stored site. Absent lists mean every one. */
export type Settings = Pick<Site, 'authorizeUrl' | 'returnUrl' | 'providers' | 'visibility'>;

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
  /** The key before the last rotation, still accepted until `previousUntil`. */
  previousKey?: string;
  previousUntil?: number;
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
 * What the instance holds for a disconnect or a mark, which have no flow of their own to
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
   * The hash of the site key that signed the token this session was opened with. Its result
   * is signed with that same key while the key is accepted, even if it has been replaced
   * since, because the backend that started the handoff may not have the new key yet.
   */
  signer?: string;
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

/** Where a site registered on the instance itself is kept, under its id. */
const registeredPrefix = 'site/registered/';

/** Where a site's operators are kept, under its id. */
const operatorsPrefix = 'site/operators/';

/** Where an id that has been used is kept once its site is gone, so it is never reused. */
const retiredPrefix = 'site/retired/';

/** What is kept of a stored site once it is gone: that its id was used, when, and why. */
export interface Retired {
  retiredAt: number;
  /** `deleted` by an operator, or `lapsed` after a month suspended. */
  reason: 'deleted' | 'lapsed';
}

/** How long a stored site stays suspended before it is deleted. */
export const lapseMs = 30 * 24 * 3600000;

/** Where the instance owner's controls over a stored site are kept, under its id. */
const controlsPrefix = 'site/controls/';

/**
 * What the instance owner has set for a stored site. Kept apart from the site itself, so
 * nothing its operators change can reach it.
 */
export interface Controls {
  /** When the owner suspended the site. Absent while the owner has not. */
  suspendedAt?: number;
  /** Requests a minute for the site, in place of `limits.registered`. */
  limit?: number;
  /** When the owner let the site's holders use YouTube. Absent while it is withheld. */
  youtubeApprovedAt?: number;
}

/** Providers a stored site's holders get only once the owner approves the site. */
const approvalNeeded = ['youtube'];

/** Where the last DNS check of a stored site is kept, under its id. */
export const dnsPrefix = 'site/dns/';

/** What the last DNS check of a stored site found. */
export interface DnsCheck {
  /** When the DNS was last asked, whether or not it answered. */
  attemptedAt: number;
  /** When the DNS last answered. Absent if it never has. */
  checkedAt?: number;
  /** When the site's `verily-verifier` record was first found missing. Absent while it is there. */
  absentSince?: number;
}

/** Someone who may manage a stored site. Only a dashboard key, for now, kept hashed. */
export interface Operator {
  kind: 'key';
  hash: string;
  addedAt: number;
}

/** A site's id: what prefixes its subjects and names it in every token. */
export const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id);

/** A key: base64url, of at least 32 bytes. */
export const validKey = (key: unknown): key is string =>
  typeof key === 'string' && /^[A-Za-z0-9_-]{43,}$/.test(key);

/** A site entry checked field by field, without its key. Throws on the first thing wrong. */
export function checked(entry: Record<string, unknown>): Omit<Site, 'key'> {
  const { id, name, origin, authorizeUrl, returnUrl, providers, visibility } = entry ?? {};

  if (!validId(id))
    throw new Error('Each site needs an id of lowercase letters, digits and hyphens');

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

  return {
    id,
    name,
    origin,
    authorizeUrl: authorizeUrl as string,
    returnUrl: returnUrl as string,
    ...(providers ? { providers: providers as string[] } : {}),
    ...(visibility ? { visibility: visibility as Visibility[] } : {}),
  };
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
    const site = checked(entry);

    if (sites.has(site.id)) throw new Error(`Site ${site.id} is listed twice`);

    const key = secrets[`SITE_${site.id.toUpperCase().replace(/-/g, '_')}_KEY`];

    // A secret is set apart from a deployment and cannot be checked before one. A wrong
    // one leaves its own site unserved, and never takes the rest of the instance with it.
    if (!validKey(key)) {
      console.error(`Site ${site.id} is not served: it needs a base64url key of at least 32 bytes`);

      continue;
    }

    sites.set(site.id, { ...site, key });
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

/** How long a replaced site key is still accepted, so the site has time to deploy the new one. */
export const rotationMs = 24 * 3600000;

/** The site's keys that are accepted now: its key, and its previous key while in date. */
const accepted = (site: Site) => [
  site.key,
  ...(site.previousKey && (site.previousUntil ?? 0) > Date.now() ? [site.previousKey] : []),
];

/**
 * Whether the key a session was opened with is still accepted. A key replaced at once, or
 * whose 24 hours are over or were ended early, takes its sessions with it, so a leaked key
 * is no use to whoever already opened a session with it. A session from before sessions
 * named their key has none, and lasts its hour.
 */
const keyAccepted = (site: Site, session: SiteSession) =>
  session.signer === undefined || accepted(site).some((key) => hash(key) === session.signer);

/**
 * The payload of a token signed by one of the site's accepted keys, and the hash of the
 * key that signed it.
 */
function verified(site: Site, token: string) {
  for (const key of accepted(site)) {
    const payload = open(key, token);

    if (payload) return { payload, signer: hash(key) };
  }

  return undefined;
}

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
  /**
   * Every site served: the pinned ones, then the ones kept in the store, as `refresh()`
   * last read them.
   */
  sites: Map<string, Site>;

  /**
   * Stored sites whose DNS no longer names this instance, or that the owner suspended. They
   * start nothing new, but their backends can still read their connections, so they can
   * move elsewhere.
   */
  suspended = new Set<string>();

  /** What the instance owner has set for each stored site, as `refresh()` last read it. */
  controls = new Map<string, Controls>();

  /**
   * `pinned` are the sites the host configures, from `SITES`. They cannot be changed here,
   * and a stored site with the same id or origin is not served.
   */
  constructor(
    private readonly storage: Store,
    private readonly pinned: Map<string, Site>,
  ) {
    this.sites = new Map(pinned);
  }

  /**
   * Reads the stored sites again. The instance does this on every request, so a site
   * registered, changed or removed by another process is served as it now is.
   */
  async refresh(): Promise<void> {
    const sites = new Map(this.pinned);
    const origins = new Set([...this.pinned.values()].map((site) => site.origin));

    for (const [, site] of await this.storage.list<Site>(registeredPrefix)) {
      if (sites.has(site.id) || origins.has(site.origin)) continue;

      sites.set(site.id, site);
      origins.add(site.origin);
    }

    const suspended = new Set<string>();
    const controls = new Map<string, Controls>();

    for (const [key, set] of await this.storage.list<Controls>(controlsPrefix)) {
      const id = key.slice(controlsPrefix.length);

      controls.set(id, set);

      if (set.suspendedAt !== undefined && !this.pinned.has(id)) suspended.add(id);
    }

    for (const [key, check] of await this.storage.list<DnsCheck>(dnsPrefix)) {
      const id = key.slice(dnsPrefix.length);

      if (check.absentSince !== undefined && !this.pinned.has(id)) suspended.add(id);
    }

    this.sites = sites;
    this.suspended = suspended;
    this.controls = controls;
  }

  /** The sites the host configures in `SITES`. */
  configured(): Site[] {
    return [...this.pinned.values()];
  }

  /** The sites kept in the store and served, which are the ones whose DNS is checked. */
  stored(): Site[] {
    return [...this.sites.values()].filter((site) => !this.pinned.has(site.id));
  }

  /**
   * Requests a minute for a site, counted once for its holders and once for its backend's
   * reads. Undefined for a pinned site, which gets the instance's default.
   */
  limit(id: string): number | undefined {
    if (this.pinned.has(id)) return undefined;

    return this.controls.get(id)?.limit ?? limits.registered;
  }

  /**
   * The provider ids a site's holders may use, from those the instance `offers`. A stored
   * site goes without YouTube until the owner approves it. Undefined means every one.
   */
  providers(site: Site, offers: string[]): string[] | undefined {
    const held = this.withheld(site.id);

    return held.length
      ? (site.providers ?? offers).filter((id) => !held.includes(id))
      : site.providers;
  }

  /**
   * The provider ids the owner has not approved a site for, whichever its operators chose.
   * None for a pinned site.
   */
  withheld(id: string): string[] {
    return this.pinned.has(id) || this.controls.get(id)?.youtubeApprovedAt ? [] : approvalNeeded;
  }

  /** Changes what the instance owner has set for a stored site. */
  async control(id: string, change: (controls: Controls) => Controls): Promise<void> {
    if (this.pinned.has(id)) throw new Error(`Site ${id} is set by the host`);

    await this.storage.transaction(async (tx) => {
      if (!(await tx.get<Site>(`${registeredPrefix}${id}`)))
        throw new Error(`Site ${id} is not registered`);

      const key = `${controlsPrefix}${id}`;

      await tx.put<Controls>(key, change((await tx.get<Controls>(key)) ?? {}));
    });

    await this.refresh();
  }

  /** A site that may start something new: served, and not suspended. */
  private active(id: string): Site | undefined {
    return this.suspended.has(id) ? undefined : this.sites.get(id);
  }

  /**
   * Keeps a new site in the store with its first operator. Refused if the entry is
   * malformed, or its origin belongs to another site, or its id is in use or has ever been.
   */
  async register(site: Site, first: Operator): Promise<void> {
    const entry: Site = { ...checked(site as unknown as Record<string, unknown>), key: site.key };

    if (!validKey(entry.key)) throw new Error(`Site ${entry.id} needs a base64url key`);

    if (this.pinned.has(entry.id)) throw new Error(`Site ${entry.id} is set by the host`);

    await this.storage.transaction(async (tx) => {
      if (
        (await tx.get(`${registeredPrefix}${entry.id}`)) ||
        (await tx.get(`${retiredPrefix}${entry.id}`))
      )
        throw new Error(`The id ${entry.id} is taken`);

      for (const [, other] of [
        ...this.pinned.entries(),
        ...(await tx.list<Site>(registeredPrefix)),
      ])
        if (other.origin === entry.origin) throw new Error(`${entry.origin} is already registered`);

      await tx.put<Site>(`${registeredPrefix}${entry.id}`, entry);
      await tx.put<Operator[]>(`${operatorsPrefix}${entry.id}`, [first]);
    });

    await this.refresh();
  }

  /**
   * Changes a stored site's settings. The rest of the site, its keys above all, is read in
   * the same transaction and kept as it is, so a change made from a page loaded before a
   * key was replaced cannot bring the old key back. Refused if the result is malformed.
   */
  async update(id: string, settings: Settings): Promise<void> {
    if (this.pinned.has(id)) throw new Error(`Site ${id} is set by the host`);

    await this.storage.transaction(async (tx) => {
      const stored = await tx.get<Site>(`${registeredPrefix}${id}`);

      if (!stored) throw new Error(`Site ${id} is not registered`);

      const { key, previousKey, previousUntil, providers, visibility, ...rest } = stored;

      const changed = checked({
        ...rest,
        authorizeUrl: settings.authorizeUrl,
        returnUrl: settings.returnUrl,
        ...(settings.providers ? { providers: settings.providers } : {}),
        ...(settings.visibility ? { visibility: settings.visibility } : {}),
      });

      await tx.put<Site>(`${registeredPrefix}${id}`, {
        ...changed,
        key,
        ...(previousKey && previousUntil ? { previousKey, previousUntil } : {}),
      });
    });

    await this.refresh();
  }

  /**
   * Gives a stored site a new key and returns it. With `keep`, the old key is still
   * accepted for `rotationMs`, for a routine change. Without it, the old key stops working
   * at once, for a key that may have leaked. Any key before the old one stops either way.
   *
   * With `from`, the hash of the key the caller saw, nothing changes unless that is still
   * the site's key, so a form sent twice replaces the key once. Returns undefined then.
   */
  async rotate(id: string, keep: boolean, from?: string): Promise<string | undefined> {
    const key = secret();

    const replaced = await this.storage.transaction(async (tx) => {
      const stored = await tx.get<Site>(`${registeredPrefix}${id}`);

      if (!stored) throw new Error(`Site ${id} is not registered`);

      if (from !== undefined && hash(stored.key) !== from) return false;

      const { previousKey, previousUntil, ...site } = stored;

      await tx.put<Site>(`${registeredPrefix}${id}`, {
        ...site,
        key,
        ...(keep ? { previousKey: stored.key, previousUntil: Date.now() + rotationMs } : {}),
      });

      return true;
    });

    await this.refresh();

    return replaced ? key : undefined;
  }

  /** Stops accepting a stored site's previous key, once the new one is deployed. */
  async retirePreviousKey(id: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const stored = await tx.get<Site>(`${registeredPrefix}${id}`);

      if (!stored) throw new Error(`Site ${id} is not registered`);

      const { previousKey, previousUntil, ...site } = stored;

      await tx.put<Site>(`${registeredPrefix}${id}`, site);
    });

    await this.refresh();
  }

  /**
   * Removes a stored site with its operators, DNS state and owner's controls, and keeps its
   * id so no other site is ever given it. Its users' records stay, but their site starts nothing new.
   */
  async retire(id: string, reason: Retired['reason']): Promise<void> {
    if (this.pinned.has(id)) throw new Error(`Site ${id} is set by the host`);

    await this.storage.transaction(async (tx) => {
      if (!(await tx.get<Site>(`${registeredPrefix}${id}`)))
        throw new Error(`Site ${id} is not registered`);

      await tx.put<Retired>(`${retiredPrefix}${id}`, { retiredAt: Date.now(), reason });
      await tx.delete(`${registeredPrefix}${id}`);
      await tx.delete(`${operatorsPrefix}${id}`);
      await tx.delete(`${dnsPrefix}${id}`);
      await tx.delete(`${controlsPrefix}${id}`);
    });

    await this.refresh();
  }

  /** The operators of a stored site. */
  async operators(id: string): Promise<Operator[]> {
    return (await this.storage.get<Operator[]>(`${operatorsPrefix}${id}`)) ?? [];
  }

  /**
   * Starts a handoff: a state stored with the site and purpose, set in this browser, and
   * sent to the site to sign into its token. Returns where to go and the cookie to set.
   */
  async begin(site: string | null, purpose: string | null) {
    const registered = this.active(site ?? '');

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
    const site = this.active(String(peek(token)?.site ?? ''));

    if (!site) return undefined;

    const { payload, signer } = verified(site, token) ?? {};
    const now = Date.now();
    const held = readCookie(request, stateCookie);

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
        signer,
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
    const site = this.active(String(peek(token)?.site ?? ''));

    if (!site || origin !== site.origin) return undefined;

    const { payload, signer } = verified(site, token) ?? {};
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
        signer,
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

    const payload = verified(site, token)?.payload;
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
    const token = readCookie(request, sessionCookie);

    if (!token) return undefined;

    const key = `site/session/${hash(token)}`;
    const session = await this.storage.get<SiteSession>(key);

    const site = session && this.sites.get(session.site);

    if (!session || !site || expired(session, Date.now()) || !keyAccepted(site, session))
      return undefined;

    return { key, session };
  }

  /**
   * A session that can still start something: not yet returned, and not partway through a
   * disconnect. A pending disconnect holds the session's one result, so nothing else may
   * start that could end with another; only retrying that disconnect goes on.
   */
  async open(request: Request) {
    const found = await this.session(request);

    return found &&
      !found.session.closed &&
      !found.session.operation &&
      !this.suspended.has(found.session.site)
      ? found
      : undefined;
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

    const session = context.session?.startsWith('site/session/')
      ? await this.storage.get<SiteSession>(context.session)
      : undefined;

    // The sign-in window of a dialog shows the flow's own result page and goes nowhere.
    if (session?.dialog) return undefined;

    // Nothing is signed for a session whose key has since been withdrawn.
    if (session && !keyAccepted(site, session)) return undefined;

    // Another flow's return, or a disconnect, already speaks for this transaction. This
    // flow ended all the same, however it ended, and its holder sees the result page.
    if (!(await this.claim(context.session, flow))) return undefined;

    return this.returnUrl(
      site,
      local,
      context.txn,
      {
        operation: result.kind,
        outcome: result.phase,
        connection: result.connectionId,
        visibility: result.visibility,
        finishedAt: result.finishedAt,
      },
      session?.signer,
    );
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

  /**
   * The signed result a holder carries back to their site, under the key that opened its
   * session while that key is still accepted, and under the site's key otherwise.
   */
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
    signer?: string,
  ): string {
    if (!local.id.startsWith(`${site.id}:`)) throw new Error('Subject from another site');

    const complete = result.outcome === 'complete';

    const key = accepted(site).find((candidate) => hash(candidate) === signer) ?? site.key;

    const token = sign(key, {
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
