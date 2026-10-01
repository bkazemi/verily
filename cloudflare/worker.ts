import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { externalName, localSide, statusLabel, type Evidence } from '../src/core/index.js';
import { logo } from '../src/logo.js';
import { styleVersion } from '../src/server/style.js';
import {
  createVerity,
  discordProvider,
  youtubeProvider,
  githubLinkProvider,
  githubProvider,
} from '../src/server/index.js';
import { CloudflareStorage } from './storage.js';
import { OwnerAuth } from './auth.js';
import { registry, Sites, type Site, peek } from './sites.js';
import { allow, client, limits, prune } from './limits.js';
import type { LocalAccount, LocalKind } from '../src/core/index.js';

export interface Env {
  VERITY: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  SITE_NAME: string;
  /** What this deployment links: one of its accounts, a page, or the site. Defaults to account. */
  OWNER_KIND?: LocalKind;
  OWNER_LABEL: string;
  OWNER_REFERENCE: string;
  OWNER_PROFILE_URL: string;
  REPORT_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Discord sign-in is offered only when both are set. */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** YouTube sign-in is offered only when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OWNER_KEY: string;
  /**
   * The sites that send their users here instead of hosting Verity, as a JSON list of
   * `{ id, name, origin, authorizeUrl, returnUrl }`. Each needs its key in the secret
   * `SITE_<ID>_KEY`, such as `SITE_PARTNER_KEY`.
   */
  SITES?: string | unknown[];
  [key: `SITE_${string}_KEY`]: string | undefined;
}

const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * Every page here says in its heading what it is, the way the library's pages do. The
 * logotype above already says whose it is, so the heading never has to repeat that.
 */
const html = (heading: string, body: string, status = 200, variant = '') =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)} · Verity</title><link rel="stylesheet" href="/api/verity/style.css?v=${styleVersion}"><body><main${variant && ` class="${variant}"`}>${logo}<h1>${escape(heading)}</h1>${body}</main></body></html>`,
    { status, headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
  );

/**
 * The page at the root for anybody not signed in, and the only thing it does. Whoever
 * reaches it either holds the owner key or has no business past it, so it carries one
 * field and no account of what lies behind.
 */
const signIn = (message = '', status = 200) =>
  html(
    'Sign in',
    `${message}<form action="/login" method="post"><label>Owner key <input name="key" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`,
    status,
    'single',
  );

const redirect = (cookie: string) => see('/', [cookie]);

function see(location: string, cookies: string[] = []) {
  const headers = new Headers({ ...safeHeaders, Location: location });

  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 303, headers });
}

/** Every refused handoff looks the same, so nobody can learn which check it failed. */
const refused = () =>
  html(
    'Link expired',
    '<p>This link has expired or was already used. Start again from the site that sent you.</p>',
    403,
    'single',
  );

/** The library's own management routes, which a site session does not get. */
const management = /^\/api\/verity\/connections\/[^/]+\/(disconnect|share|share-revoke)$/;

/** GETs that create state, and so are limited like every POST. */
const limitedGets = ['/begin', '/start', '/api/verity/sessions', '/api/verity/callback'];

/** Matches the library's own bound: large enough for a pasted key, small enough to buffer. */
const maxBodyBytes = 65536;

/** Buffer only bounded request bodies before passing them to the library. */
async function boundedBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (!request.body) return;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    length += value.byteLength;

    if (length > maxBodyBytes) {
      await reader.cancel();

      throw new Error('Body too large');
    }

    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.origin !== env.PUBLIC_ORIGIN) return html('Unavailable', '', 404);

    if (!['GET', 'POST'].includes(request.method)) return html('Unavailable', '', 405);

    let body: ArrayBuffer | undefined;

    try {
      body = await boundedBody(request);
    } catch {
      return html('Request too large', '', 413);
    }

    try {
      // One installation, with an identity that survives deployments and hostname changes.
      return await env.VERITY.get(env.VERITY.idFromName('site-owner')).fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
        redirect: 'manual',
      });
    } catch {
      return html('Temporarily unavailable', '', 503);
    }
  },
};

export class VerityStore {
  private readonly app;
  private readonly auth: OwnerAuth;
  private readonly sites: Sites;
  private readonly local: LocalAccount;
  private readonly formAction: string;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const origin = new URL(env.PUBLIC_ORIGIN);

    if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN)
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash');

    this.auth = new OwnerAuth(ctx.storage, env.OWNER_KEY);

    this.sites = new Sites(
      ctx.storage,
      registry(env.SITES, env as unknown as Record<string, unknown>),
    );

    const siteOrigins = [...this.sites.sites.values()].map((site) => site.origin);

    this.formAction = ["form-action 'self'", ...siteOrigins].join(' ');

    this.local = {
      id: 'site-owner',
      // A site with no user accounts must not have its subject described as one.
      kind: env.OWNER_KIND,
      label: env.OWNER_LABEL,
      reference: env.OWNER_REFERENCE,
      profileUrl: env.OWNER_PROFILE_URL,
    };

    this.app = createVerity({
      storage: new CloudflareStorage(ctx.storage),
      // Two ways of showing one GitHub account. Whichever is used first is the record's
      // main method, and the other is listed beneath it once used. Discord and YouTube
      // are offered only when their secrets are set.
      providers: [
        githubProvider({
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        }),
        githubLinkProvider(),
        ...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
          ? [
              discordProvider({
                clientId: env.DISCORD_CLIENT_ID,
                clientSecret: env.DISCORD_CLIENT_SECRET,
              }),
            ]
          : []),
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? [
              youtubeProvider({
                clientId: env.GOOGLE_CLIENT_ID,
                clientSecret: env.GOOGLE_CLIENT_SECRET,
              }),
            ]
          : []),
      ],
      baseUrl: `${env.PUBLIC_ORIGIN}/api/verity`,
      // The owner's own site. A registered site's subjects carry their site's name instead.
      siteName: env.SITE_NAME,
      // The verifier is the origin that ran the flow and serves the evidence, which a
      // reader can check. It is not SITE_NAME: that host is claimed, not demonstrated.
      // The host alone: how the backend is operated is not something a reader verifies.
      verifierName: origin.host,
      // Every site's origin, since the library checks one list. That a subject's profile
      // is on its own site's origin is checked when its handoff arrives.
      profileOrigins: [new URL(env.OWNER_PROFILE_URL).origin, ...siteOrigins],
      // A flow's result redirects the approval form on to the site it came from.
      formTargets: siteOrigins,
      reportUrl: env.REPORT_URL,
      // A site session is the more specific: it was opened for this holder moments ago.
      authenticate: async (request) =>
        (await this.sites.open(request))?.session.local ??
        ((await this.auth.authenticated(request)) ? this.local : undefined),
      context: async (request) => {
        const open = await this.sites.open(request);

        return open
          ? {
              site: open.session.site,
              purpose: open.session.purpose,
              txn: open.session.txn,
              session: open.key,
            }
          : undefined;
      },
      // A site's holders get the providers that site chose. The owner has no site.
      providersFor: (local) => this.siteOf(local)?.providers,
      visibilityFor: (local) => this.siteOf(local)?.visibility,
      finish: ({ id, context, local, result }) => this.sites.finish(id, context, local, result),
    });

    this.app.service.validateLocal(this.local);

    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 3600000);
    });
  }

  async alarm() {
    // Schedule first so transient cleanup failures never permanently stop maintenance.
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
    await this.app.service.prune();
    // Published proofs go stale on their own. A small budget per hour stays inside the
    // rate limit a provider gives an unauthenticated caller, shared across this colo.
    await this.app.service.recheck();
    await this.auth.prune();
    await prune(this.ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    let response: Response;

    try {
      response = await this.handle(request);
    } catch {
      response = html('Temporarily unavailable', '', 503);
    }

    // A disconnect form redirects on to the holder's site, and Chromium holds a form's
    // redirects to form-action, as the library does its own approval form's.
    if (!new URL(request.url).pathname.startsWith('/api/verity/'))
      response.headers.set(
        'Content-Security-Policy',
        safeHeaders['Content-Security-Policy'].replace("form-action 'self'", this.formAction),
      );

    return response;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.origin !== this.env.PUBLIC_ORIGIN) return html('Unavailable', '', 404);

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/verity/') &&
      (!request.headers.has('origin') || request.headers.get('origin') === 'null')
    ) {
      const headers = new Headers(request.headers);

      headers.set('origin', this.env.PUBLIC_ORIGIN);
      request = new Request(request, { headers });
    }

    if (!(await this.allowed(request, url)))
      return html('Too many requests', '<p>Try again later.</p>', 429);

    if (request.method === 'POST') {
      if (url.pathname === '/login') {
        if (!(await this.auth.allow('login', 10, 15 * 60000)))
          return html('Too many requests', '<p>Try again in fifteen minutes.</p>', 429);

        const key = new URLSearchParams(await request.text()).get('key') ?? '';
        const cookie = await this.auth.login(key);

        return cookie ? redirect(cookie) : signIn('<p>Incorrect owner key.</p>', 403);
      }

      if (url.pathname === '/logout') return redirect(await this.auth.logout(request));

      if (request.headers.get('origin') !== this.env.PUBLIC_ORIGIN)
        return html('Unavailable', '', 403);

      if (url.pathname === '/disconnect') return this.disconnect(request);
    }

    if (request.method === 'GET' && url.pathname === '/site/connections') return this.read(request);

    if (request.method === 'GET' && url.pathname === '/begin') {
      const begun = await this.sites.begin(
        url.searchParams.get('site'),
        url.searchParams.get('purpose'),
      );

      return begun ? see(begun.location, [begun.cookie]) : html('Unavailable', '', 404);
    }

    if (request.method === 'GET' && url.pathname === '/start') {
      const started = await this.sites.start(
        request,
        url.searchParams.get('token') ?? '',
        (local) => this.app.service.validateLocal(local),
      );

      // Straight on, so the token leaves the address bar.
      return started
        ? see(started.purpose === 'connect' ? '/api/verity/verify' : '/', started.cookies)
        : refused();
    }

    if (url.pathname.startsWith('/api/verity/')) {
      // A site session removes a link through this worker, which reports it back to the
      // site, and has no sharing links. The library's routes would do neither.
      if (
        request.method === 'POST' &&
        management.test(url.pathname) &&
        (await this.sites.open(request))
      )
        return html('Unavailable', '', 404);

      // Some browsers omit Origin on native same-origin form posts. The request
      // already passed the exact public-origin check above; flow cookies are
      // SameSite=Lax and the library still requires the authenticated owner.
      if (request.method === 'POST' && !request.headers.has('origin')) {
        const headers = new Headers(request.headers);

        headers.set('origin', this.env.PUBLIC_ORIGIN);
        request = new Request(request, { headers });
      }

      return this.app.handle(request);
    }

    if (request.method !== 'GET' || url.pathname !== '/') return html('Unavailable', '', 404);

    const found = await this.sites.session(request);

    if (found && !found.session.closed && !found.session.operation)
      return this.settings(found.session.local, this.site(found.session));

    // A disconnect that failed partway is the one thing left to do with this session.
    if (found?.session.operation && found.session.operation.finishedAt === undefined)
      return html(
        'Disconnect not finished',
        `<p>Removing this link did not finish.</p><form action="/disconnect" method="post"><input type="hidden" name="connection" value="${escape(found.session.operation.connection)}"><button>Try again</button></form>`,
        200,
        'single',
      );

    if (await this.auth.authenticated(request)) return this.settings(this.local);

    if (found) {
      const site = this.site(found.session);

      return html(
        'Session ended',
        `<p>You are finished here. <a href="${escape(site.origin)}">Return to ${escape(site.name)}</a> to start again.</p>`,
        200,
        'single',
      );
    }

    return signIn();
  }

  /** The site a subject belongs to, by its id's prefix. The owner's id has none. */
  private siteOf(local: LocalAccount): Site | undefined {
    return local.id.includes(':') ? this.sites.sites.get(local.id.split(':')[0]!) : undefined;
  }

  /**
   * A site's backend reading its own subjects' connections, unlisted ones included, which
   * nobody else can read. This is what lets a site show a link to its own users without the
   * link being public. A refused request counts against the caller's address, and a good
   * one against the site's own allowance, apart from the one its holders' handoffs share.
   */
  private async read(request: Request): Promise<Response> {
    const asked = this.sites.read(
      request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '',
    );

    if (
      !(await allow(this.ctx.storage, [
        asked
          ? { key: `read/${asked.site.id}`, limit: limits.read }
          : { key: client(request), limit: limits.client },
      ]))
    )
      return html('Too many requests', '<p>Try again later.</p>', 429);

    if (!asked) return html('Unavailable', '', 404);

    // No prototype, so an id such as `__proto__` is an entry like any other.
    const connections: Record<string, Evidence[]> = Object.create(null);

    for (const id of asked.ids)
      connections[id] = await this.app.service.mine({
        id: `${asked.site.id}:${id}`,
      } as LocalAccount);

    return new Response(JSON.stringify({ connections }), {
      headers: { ...safeHeaders, 'Content-Type': 'application/json' },
    });
  }

  private site(session: { site: string }): Site {
    return this.sites.sites.get(session.site)!;
  }

  /**
   * Counts a request that creates state: every POST, and the GETs that start a handoff, a
   * session or a flow. A signed-in holder has a bucket of their own and anyone else is
   * counted by address, so one visitor cannot lock everyone else out. A site's requests
   * also share a ceiling, so one site cannot starve another.
   */
  private async allowed(request: Request, url: URL): Promise<boolean> {
    if (request.method !== 'POST' && !limitedGets.includes(url.pathname)) return true;

    const found = await this.sites.session(request);
    const owner = found ? undefined : await this.auth.session(request);

    const holder = found
      ? { key: `session/${found.key.slice('site/session/'.length)}`, limit: limits.session }
      : owner
        ? { key: `session/${owner}`, limit: limits.session }
        : { key: client(request), limit: limits.client };

    // A handoff is charged to the site it goes to, whatever session this browser holds.
    // Anything else counts against the site whose session is still in use.
    const named =
      url.pathname === '/begin'
        ? url.searchParams.get('site')
        : url.pathname === '/start'
          ? String(peek(url.searchParams.get('token') ?? '')?.site ?? '')
          : found && !found.session.closed
            ? found.session.site
            : undefined;

    const site = named && this.sites.sites.has(named) ? named : undefined;

    return allow(this.ctx.storage, [
      holder,
      ...(site ? [{ key: `site/${site}`, limit: limits.site }] : []),
    ]);
  }

  /**
   * Removes a link from a site session and reports it back to the site. There is no flow to
   * hold the result, so the session holds it, and success is reported only once the
   * revocation has committed: pending first, then revoked, then complete. A retry resumes
   * wherever the last attempt stopped, and one already complete reads what it stored.
   */
  private async disconnect(request: Request): Promise<Response> {
    const found = await this.sites.session(request);
    const connection = new URLSearchParams(await request.text()).get('connection') ?? '';

    if (!found || !connection) return html('Unavailable', '', 404);

    const { key, session } = found;
    let current = session.operation?.connection === connection ? session : undefined;

    if (!current) {
      const owned = (await this.app.service.mine(session.local)).find((e) => e.id === connection);

      if (!owned) return html('Unavailable', '', 404);

      current = await this.sites.pending(key, connection, owned.visibility);

      if (!current) return html('Unavailable', '', 404);
    }

    if (current.operation!.finishedAt === undefined) {
      await this.revoke(connection, session.local);
      current = await this.sites.completed(key);
    }

    return see(
      this.sites.returnUrl(this.site(session), session.local, session.txn, {
        operation: 'disconnect',
        outcome: 'complete',
        connection,
        visibility: current.operation!.visibility,
        finishedAt: current.operation!.finishedAt!,
      }),
    );
  }

  /** Idempotent: a connection already revoked is left as it is. */
  protected async revoke(id: string, local: LocalAccount): Promise<void> {
    await this.app.service.revoke(id, local);
  }

  /**
   * The settings page for whoever is signed in: the owner, or a holder a site sent here.
   * The owner's page carries the embed for their own site; a site's holder has the site to
   * show their badge, and removes a link through a route that tells the site so.
   */
  private async settings(subject: LocalAccount, site?: Site) {
    const connections = await this.app.service.mine(subject);
    const local = localSide(subject, this.env.SITE_NAME);

    return html(
      site ? 'Your connections' : 'Owner settings',
      `<div class="side"><p class="who">${escape(local.heading)}</p>
      <p class="name">${escape(local.value)}</p>
      <p class="reference">${escape(subject.reference)}</p></div>
      <p><a href="/api/verity/verify">Verify an account${site ? '' : ' or renew a connection'}</a></p>
      ${site ? '' : '<p class="fine">Approve a public connection to display it on your site. Renew an existing one to extend it in place; only a new pair needs a new connection.</p>'}
      ${connections.map((e) => this.connection(e, site)).join('')}
      ${site ? `<p><a href="${escape(site.origin)}">Back to ${escape(site.name)}</a></p>` : '<form action="/logout" method="post"><button>Sign out</button></form>'}`,
    );
  }

  /** One connection, with the state, the visibility and the expiry each said once. */
  private connection(e: Evidence, site?: Site) {
    const embed = `<script src="/assets/verity.js" defer></script>\n<verity-badge backend-url="${this.env.PUBLIC_ORIGIN}/api/verity" connection-id="${e.id}"></verity-badge>`;

    const shown = site
      ? e.visibility === 'public'
        ? `<p><a href="${escape(e.evidenceUrl)}">Inspect evidence</a></p><p class="fine">Anyone can view this connection, on ${escape(site.name)} or anywhere else.</p>`
        : `<p class="fine">Only ${escape(site.name)} can read this connection, and it chooses who there sees it.</p>`
      : e.visibility === 'public'
        ? `<p><a href="${escape(e.evidenceUrl)}">Inspect evidence</a></p><label>Embed on your site<textarea readonly rows="4" cols="80">${escape(embed)}</textarea></label>`
        : '<p class="fine">Unlisted connections cannot appear in a public pill.</p>';

    const actions =
      site && e.status === 'revoked'
        ? ''
        : `<p><a href="/api/verity/renew/${escape(e.id)}">Renew this connection</a></p>
      <p class="fine">Renewing keeps the same connection ID, so embeds stay valid.</p>
      ${site?.visibility?.length === 1 ? '' : `<p><a href="/api/verity/visibility/${escape(e.id)}">Change visibility</a></p>`}
      ${
        site
          ? `<form action="/disconnect" method="post"><input type="hidden" name="connection" value="${escape(e.id)}"><button>Disconnect</button></form>`
          : `<form action="/api/verity/connections/${escape(e.id)}/disconnect" method="post"><button>Revoke connection</button></form>`
      }`;

    return `<section><p class="who">${escape(e.providerName ?? e.provider)}</p>
      <h3>${escape(externalName(e.external))}</h3>
      <dl><dt>Status</dt><dd>${escape(statusLabel(e, Date.now()))}</dd>
      <dt>Visibility</dt><dd>${escape(e.visibility)}</dd>
      <dt>Expires</dt><dd>${escape(new Date(e.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'))}</dd></dl>
      ${shown}
      ${actions}</section>`;
  }
}
