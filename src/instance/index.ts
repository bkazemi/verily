import {
  dialogPath,
  dialogRoute,
  lastProved,
  localSide,
  routeOf,
  routes,
  statusLabel,
  type Evidence,
  type LocalAccount,
  type Provider,
} from '../core/index.js';
import { html, raw, type Html } from '../server/html.js';
import { card, date, distance, externalCard, marked, page, verdict } from '../server/render.js';
import { toneOf } from '../marks.js';
import { version } from '../version.js';
import { createVerily, generateSigningKey } from '../server/index.js';
import { recordStorage, type Store } from './store.js';
import { OwnerAuth } from './auth.js';
import { sessionCookie, Sites, type Listing, type Site, peek } from './sites.js';
import { allow, client, limits, prune } from './limits.js';
import { recheckSites, Registrations, type Registration } from './register.js';
import { Dashboard } from './dashboard.js';
import { OwnerSites } from './owner-sites.js';
import type { DnsOptions } from '../server/domain.js';
import { own } from './routes.js';
import { respond, safeHeaders, see, unavailable } from './page.js';

export { fromEnv, type InstanceEnv } from './env.js';

export { registry, type Site } from './sites.js';

export { recordStorage, type KeyValue, type Store } from './store.js';

export interface InstanceOptions {
  /** Everything the instance keeps: the records, and its own sessions, handoffs and counts. */
  store: Store;
  /** The origin the instance is served from. HTTPS, with no trailing slash. */
  origin: string;
  /** The owner's own site. A registered site's subjects carry their site's name instead. */
  siteName: string;
  /** What the owner links here: one of their accounts, a page, or the site. */
  owner: Omit<LocalAccount, 'id' | 'siteName'> & { profileUrl: string };
  /** The secret the owner signs in with. */
  ownerKey: string;
  reportUrl: string;
  /** The methods offered. A registered site may narrow these for its own holders. */
  providers: Provider[];
  /**
   * The sites the host configures, as `registry()` reads them. Sites registered on the
   * instance itself are kept in the store and served alongside these.
   */
  sites?: Map<string, Site>;
  /**
   * The key public records are signed by, armored. Left out, a key is made on first use and
   * kept in the store. `false` turns signing off.
   */
  signingKey?: string | false;
  /** How many codes may be mailed in a day, where the mail allowance is not the default. */
  mailPerDay?: number;
  /**
   * Whether anyone may register a site at `/register`. With `open`, a site is served once
   * its domain's DNS shows the requester controls it. `off` by default.
   */
  registration?: Registration;
  /** Replaces how DNS is read, for a host behind an egress proxy, or for tests. */
  dns?: DnsOptions;
  /** How often each published proof is re-read. Six hours by default. */
  recheckMs?: number;
  /** How many proofs one `upkeep()` re-reads per provider. 10 by default. */
  recheckBudget?: number;
}

/**
 * The page at the root for anybody not signed in, and the only thing it does. Whoever
 * reaches it either holds the owner key or has no business past it, so it carries one
 * field and no account of what lies behind.
 */
const signIn = (message?: Html, status = 200) =>
  respond(
    'Sign in',
    html`
      ${message}
      <form action="/login" method="post">
        <label>
          Owner key
          <input name="key" type="password" autocomplete="current-password" required>
        </label>
        <button>Sign in</button>
      </form>
    `,
    status,
    'single',
  );

const redirect = (cookie: string) => see('/', [cookie]);

/** Every refused handoff looks the same, so nobody can learn which check it failed. */
const refused = () =>
  respond(
    'Link expired',
    html`<p>This link has expired or was already used. Start again from the site that sent you.</p>`,
    403,
    'single',
  );

/**
 * Whether a request is for one of the library's own management routes, which a site
 * session does not get. Which routes those are is the library's to say.
 */
const manages = (method: string, path: string) => {
  const name = routeOf(method, path);

  return name !== undefined && 'manages' in routes[name];
};

/** GETs that create state, and so are limited like every POST. */
const limitedGets = ['/handoff/request', '/handoff/accept', '/callback'];

/** Matches the library's own bound: large enough for a pasted key, small enough to buffer. */
const maxBodyBytes = 65536;

/** How a holder may have an account listed, as the library's mark route takes it. */
const listings: readonly Listing[] = ['preferred', 'current', 'unused', 'retired'];

/** Said on the page that asks before an account is retired. */
const retiringNote =
  'Retiring keeps this record as history. It will no longer read as verified, and who can read it cannot be changed afterwards.';

/** A connection's card heading: the provider's mark and name, and anything after the name. */
const cardHeading = (e: Evidence, after = '') =>
  marked(`${e.providerName ?? e.provider}${after}`, e.provider, e.attestations.external[0]?.method);

/** Carries a flow's binding for a page on another origin, where the cookie cannot. */
const flowHeader = 'X-Verily-Flow';

/** A session or a binding as this instance mints them, and nothing that could bend a header. */
const opaque = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * Lets the page that asked read the answer. These requests carry no cookie and are given
 * none, so naming whichever origin asked gives nothing away, least of all which origins
 * are registered sites: what a caller may do is decided by the token it holds.
 */
function shared(response: Response, request: Request): Response {
  const answer = new Response(response.body, response);

  answer.headers.set('Access-Control-Allow-Origin', request.headers.get('origin') ?? '*');
  answer.headers.set('Access-Control-Expose-Headers', flowHeader);
  answer.headers.append('Vary', 'Origin');

  return answer;
}

const preflight = (request: Request) =>
  shared(
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': `Authorization, Content-Type, ${flowHeader}`,
        'Access-Control-Max-Age': '600',
      },
    }),
    request,
  );

const data = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { ...safeHeaders, 'Content-Type': 'application/json', ...headers },
  });

/**
 * A JSON object from a request's body, or an empty one. Only a body sent as JSON is read:
 * a form cannot send that type, so nothing here can be reached by a form on another page.
 */
async function fields(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return {};

  return parsed(await request.text()) ?? {};
}

/** The JSON object a text holds, or undefined if it holds anything else. */
function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);

    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run in the sign-in window a site's dialog opens. The window is on this origin, so the
 * flow's binding can be a cookie here, where the provider's callback will look for it. The
 * page that opened the window sends the binding, and this script says which origin that
 * page is on. The instance takes the binding only if that origin is the site the flow
 * belongs to, so a page elsewhere cannot have someone sign in to a flow it started.
 */
const enterScript = `const status=document.getElementById('status');const fail=()=>{status.textContent='This window could not start the sign-in. Close it and try again.'};let taken=false;if(!window.opener)fail();else{window.addEventListener('message',async(event)=>{const d=event.data;if(taken||event.source!==window.opener||!d||d.type!=='verily-enter'||typeof d.flow!=='string'||typeof d.binding!=='string'||typeof d.url!=='string')return;taken=true;let target;try{target=new URL(d.url)}catch{return fail()}if(target.protocol!=='https:')return fail();const response=await fetch('/site/enter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flow:d.flow,binding:d.binding,origin:event.origin})}).catch(()=>undefined);if(!response||!response.ok)return fail();location.replace(target.href)});window.opener.postMessage({type:'verily-enter'},'*')}`;

const enterPage = () =>
  new Response(
    page(
      '',
      'Sign in',
      html`<p id="status">Opening the sign-in page.</p>`,
      'single',
      '/site/enter.js',
    ),
    {
      headers: {
        ...safeHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    },
  );

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

/**
 * The checks that need nothing stored: the origin, the method, and a bound on the body.
 * Gives back the response to send, or the request with its body read. `handle` runs this
 * itself. A host that passes requests on to another process can run it first, so that
 * process is not woken for a request this turns away.
 */
export async function admit(request: Request, origin: string): Promise<Request | Response> {
  const url = new URL(request.url);

  if (url.origin !== origin) return unavailable();

  // Asked by a browser before a page on another origin may send the dialog's headers.
  if (
    request.method === 'OPTIONS' &&
    (dialogPath(url.pathname) || url.pathname === '/site/session')
  )
    return preflight(request);

  if (!['GET', 'POST'].includes(request.method)) return unavailable(405);

  let body: ArrayBuffer | undefined;

  try {
    body = await boundedBody(request);
  } catch {
    return respond('Request too large', html``, 413, 'single');
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: 'manual',
  });
}

/** A multi-site Verily server: a request handler, and the upkeep its host runs on a timer. */
export type Instance = ReturnType<typeof createInstance>;

export function createInstance(options: InstanceOptions) {
  return new Server(options);
}

class Server {
  private readonly app;
  private readonly store: Store;
  private readonly origin: string;
  private readonly auth: OwnerAuth;
  private readonly sites: Sites;
  private readonly registrations?: Registrations;
  private readonly dashboard: Dashboard;
  private readonly ownerSites: OwnerSites;
  private readonly local: LocalAccount;

  constructor(private readonly options: InstanceOptions) {
    const origin = new URL(options.origin);

    if (origin.protocol !== 'https:' || origin.origin !== options.origin)
      throw new Error('The origin must be an HTTPS origin without a trailing slash');

    this.origin = options.origin;
    this.store = options.store;
    this.auth = new OwnerAuth(this.store, options.ownerKey);
    this.sites = new Sites(this.store, options.sites ?? new Map());

    this.dashboard = new Dashboard(
      this.store,
      this.sites,
      options.providers,
      origin.host,
      options.reportUrl,
    );

    this.ownerSites = new OwnerSites(this.store, this.sites, options.providers);

    if (options.registration === 'open')
      this.registrations = new Registrations(this.store, this.sites, this.origin, options.dns);

    const ownerOrigin = new URL(options.owner.profileUrl).origin;

    // A site with no user accounts must not have its subject described as one, so the
    // owner's kind is whatever the host gave, absent included.
    this.local = { id: 'site-owner', ...options.owner };

    this.app = createVerily({
      storage: recordStorage(this.store),
      providers: options.providers,
      sendLimits: { day: options.mailPerDay },
      ...(options.signingKey === false
        ? {}
        : { signingKey: options.signingKey ?? (() => this.signingKey()) }),
      // Whether this origin's DNS names its signing key, and whether a site's names this
      // instance as its verifier. Both go to the resolver the domain method already asks.
      dns: options.dns ?? true,
      // The whole origin is this instance, so the library's routes sit at its root.
      baseUrl: this.origin,
      siteName: options.siteName,
      // The verifier is the origin that ran the flow and serves the evidence, which a
      // reader can check. It is not the site name: that host is claimed, not demonstrated.
      // The host alone: how the backend is operated is not something a reader verifies.
      verifierName: origin.host,
      // Each published proof is re-read every six hours, so one taken down is noticed soon.
      recheckMs: options.recheckMs ?? 6 * 3600000,
      // Every site's origin, since the library checks one list. That a subject's profile
      // is on its own site's origin is checked when its handoff arrives. Asked each time,
      // since sites registered here come and go while the instance runs.
      profileOrigins: () => [ownerOrigin, ...[...this.sites.sites.values()].map((s) => s.origin)],
      reportUrl: options.reportUrl,
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
      // A site's holders get the providers that site chose, less any the owner has not
      // approved it for. A holder whose site is gone gets none, rather than every one. The
      // owner has no site.
      providersFor: (local) => {
        const site = this.siteOf(local);

        if (!site) return local.id.includes(':') ? [] : undefined;

        return this.sites.providers(
          site,
          options.providers.map((provider) => provider.id),
        );
      },
      visibilityFor: (local) => this.siteOf(local)?.visibility,
      finish: ({ id, context, local, result }) => this.sites.finish(id, context, local, result),
    });

    this.app.service.validateLocal(this.local);
  }

  /** The library's service, for a host that needs more than requests and upkeep. */
  get service() {
    return this.app.service;
  }

  /**
   * What a host runs on a timer, about hourly: drops what has expired, and re-reads the
   * published proofs that are due. The default of 10 per provider each hour stays inside
   * the rate limit a provider gives an unauthenticated caller.
   */
  async upkeep(): Promise<void> {
    await this.app.service.prune();
    await this.app.service.recheck(this.options.recheckBudget ?? 10);
    await this.auth.prune();
    await prune(this.store);
    await recheckSites(this.store, this.sites, this.origin, this.options.dns);
  }

  /**
   * Answers one request. `address` is the client's address as the host knows it, which
   * rate limits count by. The instance reads no forwarding header itself, since which one
   * can be trusted depends on what the host sits behind.
   */
  async handle(request: Request, address: string | null = null): Promise<Response> {
    let response: Response;

    try {
      await this.sites.refresh();

      const admitted = await admit(request, this.origin);

      response = admitted instanceof Response ? admitted : await this.route(admitted, address);
    } catch {
      response = respond('Temporarily unavailable', html`<p>Try again shortly.</p>`, 503, 'single');
    }

    // An approval or disconnect form redirects on to the holder's site, and Chromium holds
    // a form's redirects to form-action. Only a holder that site sent here is told its
    // origin, and only that one: named on every response, the policy would tell any visitor
    // which sites this instance serves.
    const policy = response.headers.get('Content-Security-Policy');
    const found = policy ? await this.sites.session(request).catch(() => undefined) : undefined;

    if (policy && found)
      response.headers.set(
        'Content-Security-Policy',
        policy.replace(
          /form-action [^;]*/,
          (allowed) => `${allowed} ${this.site(found.session).origin}`,
        ),
      );

    return response;
  }

  private async route(request: Request, address: string | null): Promise<Response> {
    const url = new URL(request.url);

    // The sign-in window's own script, and nothing else. It sets a cookie that decides
    // whose flow this browser signs in to, so it is held to the origin the browser itself
    // reports, before a missing or opaque one is read as ours below: a form in a sandboxed
    // frame has an opaque origin, and can put any origin it likes in its body.
    if (request.method === 'POST' && url.pathname === '/site/enter') {
      if (
        request.headers.get('origin') !== this.origin ||
        !request.headers.get('content-type')?.startsWith('application/json')
      )
        return unavailable(403);

      if (!(await this.allowed(request, url, address)))
        return respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single');

      return this.enter(request);
    }

    if (
      request.method === 'POST' &&
      !own.has(url.pathname) &&
      (!request.headers.has('origin') || request.headers.get('origin') === 'null')
    ) {
      const headers = new Headers(request.headers);

      headers.set('origin', this.origin);
      request = new Request(request, { headers });
    }

    // The connect dialog on a site's own page, which counts its requests once it knows
    // whose they are.
    if (request.headers.has('authorization') && dialogPath(url.pathname))
      return shared(await this.dialog(request, url, address), request);

    if (!(await this.allowed(request, url, address)))
      return respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single');

    if (request.method === 'POST' && url.pathname === '/site/session') {
      const opened = await this.sites.dialog(
        String((await fields(request)).token ?? ''),
        request.headers.get('origin'),
        (local) => this.app.service.validateLocal(local),
        (site) =>
          allow(this.store, [
            { key: `site/${site.id}`, limit: this.sites.limit(site.id) ?? limits.site },
          ]),
      );

      return shared(
        opened === 'limited'
          ? respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single')
          : opened
            ? data({ session: opened.session })
            : unavailable(),
        request,
      );
    }

    if (request.method === 'GET' && url.pathname === '/site/enter') return enterPage();

    if (request.method === 'GET' && url.pathname === '/site/enter.js')
      return new Response(enterScript, {
        headers: { ...safeHeaders, 'Content-Type': 'text/javascript' },
      });

    if (request.method === 'POST') {
      if (url.pathname === '/login') {
        if (!(await this.auth.allow('login', 10, 15 * 60000)))
          return respond(
            'Too many requests',
            html`<p>Try again in fifteen minutes.</p>`,
            429,
            'single',
          );

        const key = new URLSearchParams(await request.text()).get('key') ?? '';
        const cookie = await this.auth.login(key);

        return cookie ? redirect(cookie) : signIn(html`<p>Incorrect owner key.</p>`, 403);
      }

      if (url.pathname === '/logout') return redirect(await this.auth.logout(request));

      if (request.headers.get('origin') !== this.origin) return unavailable(403);

      if (url.pathname === '/disconnect') return this.disconnect(request);

      if (url.pathname === '/mark') return this.mark(request);

      if (url.pathname.startsWith('/sites/'))
        return (await this.auth.authenticated(request))
          ? this.ownerSites.change(url.pathname, request)
          : unavailable(403);

      if (url.pathname === '/site/dashboard/login') return this.dashboard.login(request);

      if (url.pathname === '/site/dashboard/logout') return this.dashboard.logout(request);

      if (url.pathname === '/site/dashboard/settings') return this.dashboard.settings(request);

      if (url.pathname === '/site/dashboard/rotate') return this.dashboard.rotate(request);

      if (url.pathname === '/site/dashboard/previous-key')
        return this.dashboard.retirePreviousKey(request);

      if (url.pathname === '/site/dashboard/delete') return this.dashboard.delete(request);

      if (this.registrations) {
        if (url.pathname === '/register') return this.registrations.request(request);

        if (url.pathname === '/register/check') return this.registrations.check(request);

        if (url.pathname === '/register/cancel') return this.registrations.cancel();
      }
    }

    if (request.method === 'GET' && url.pathname === '/site/dashboard')
      return this.dashboard.page(request);

    if (request.method === 'GET' && url.pathname === '/sites')
      return (await this.auth.authenticated(request)) ? this.ownerSites.page() : unavailable();

    if (request.method === 'GET' && url.pathname === '/register' && this.registrations)
      return this.registrations.page(request);

    if (request.method === 'GET' && url.pathname === '/site/connections')
      return this.read(request, address);

    if (request.method === 'GET' && url.pathname === '/handoff/request') {
      const begun = await this.sites.begin(
        url.searchParams.get('site'),
        url.searchParams.get('purpose'),
      );

      return begun ? see(begun.location, [begun.cookie]) : unavailable();
    }

    if (request.method === 'GET' && url.pathname === '/handoff/accept') {
      const started = await this.sites.start(
        request,
        url.searchParams.get('token') ?? '',
        (local) => this.app.service.validateLocal(local),
      );

      // Straight on, so the token leaves the address bar.
      return started
        ? see(started.purpose === 'connect' ? '/verify' : '/', started.cookies)
        : refused();
    }

    // Where a reader who has only this domain's name finds the keys its records are signed by.
    if (request.method === 'GET' && url.pathname === '/.well-known/verily-keys.json')
      return new Response(
        JSON.stringify({
          keys: await this.app.service.keys(),
          dns: await this.app.service.keyRecords(),
        }),
        {
          headers: {
            ...safeHeaders,
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );

    // Every path that is not one of the instance's own is the library's to answer.
    if (!own.has(url.pathname)) {
      // A site session removes a link, or lists an account another way, through this
      // instance, which reports it back to the site, and has no sharing links. The library's
      // routes would do neither.
      if (manages(request.method, url.pathname) && (await this.sites.open(request)))
        return unavailable();

      // Some browsers omit Origin on native same-origin form posts. The request
      // already passed the exact public-origin check above; flow cookies are
      // SameSite=Lax and the library still requires the authenticated owner.
      if (request.method === 'POST' && !request.headers.has('origin')) {
        const headers = new Headers(request.headers);

        headers.set('origin', this.origin);
        request = new Request(request, { headers });
      }

      return this.app.handle(request);
    }

    if (request.method === 'GET' && url.pathname === '/confirm') return this.confirm(request, url);

    // Every record on the instance, for whoever holds the owner key and nobody else.
    if (request.method === 'GET' && url.pathname === '/records')
      return (await this.auth.authenticated(request)) ? this.records() : unavailable();

    if (request.method !== 'GET' || url.pathname !== '/') return unavailable();

    const found = await this.sites.session(request);

    if (found && !found.session.closed && !found.session.operation)
      return this.settings(found.session.local, this.site(found.session));

    // A disconnect or a mark that failed partway is the one thing left to do with this session.
    if (found?.session.operation && found.session.operation.finishedAt === undefined) {
      const { connection, mark } = found.session.operation;

      return mark
        ? respond(
            'Change not finished',
            html`
              <p>Changing how this account is listed did not finish.</p>
              <form action="/mark" method="post">
                <input type="hidden" name="connection" value="${connection}">
                <input type="hidden" name="as" value="${mark}">
                <button>Try again</button>
              </form>
            `,
            200,
            'single',
          )
        : respond(
            'Disconnect not finished',
            html`
              <p>Removing this link did not finish.</p>
              <form action="/disconnect" method="post">
                <input type="hidden" name="connection" value="${connection}">
                <button>Try again</button>
              </form>
            `,
            200,
            'single',
          );
    }

    if (await this.auth.authenticated(request)) return this.settings(this.local);

    if (found) {
      const site = this.site(found.session);

      return respond(
        'Session ended',
        html`<p>You are finished here. <a href="${site.origin}">Return to ${site.name}</a> to start again.</p>`,
        200,
        'single',
      );
    }

    return signIn();
  }

  /**
   * One request from the connect dialog on a site's own page. The page holds the session
   * and the flow's binding and sends them as headers, because this instance's cookies are
   * another site's on that page and a browser may not send them. Here they are put where
   * the library looks for them, and a binding the library sets comes back as a header. The
   * session works only from its own site's origin, and only for the dialog's requests.
   */
  private async dialog(request: Request, url: URL, address: string | null): Promise<Response> {
    // Counted against the sender's address, as a refused read is: a request turned away
    // here never reaches the counting a served one gets, and each costs a lookup.
    const turnedAway = async () =>
      (await allow(this.store, [{ key: client(address), limit: limits.client }]))
        ? unavailable()
        : respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single');

    const session = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
    const binding = request.headers.get(flowHeader) ?? '';
    const post = request.method === 'POST';
    const body = post ? await request.text() : undefined;

    if (!opaque.test(session) || (binding && !opaque.test(binding))) return turnedAway();

    // What the dialogs on a registered site's own page may ask for is the library's to say:
    // the methods, a flow's start, state, proof and approval, and the removal or the
    // listing of one of the holder's own accounts. Everything else stays same-origin.
    const route = dialogRoute(request.method, url.pathname, url.searchParams);

    if (!route) return turnedAway();

    if (post) {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return turnedAway();

      // The dialog connects an account or renews one. Every other kind of flow has a page
      // of its own here. Parsed as the library parses it, so the kind checked is the kind
      // it will run.
      if (route === 'start' && !['connect', 'renew'].includes(String(parsed(body!)?.kind)))
        return turnedAway();
    }

    const inner = new Request(request.url, {
      method: request.method,
      headers: {
        cookie: `${sessionCookie}=${session}${binding ? `; ${this.app.flowCookieName}=${binding}` : ''}`,
        origin: this.origin,
        ...(post ? { 'content-type': 'application/json' } : {}),
      },
      body,
    });

    const found = await this.sites.open(inner);

    if (!found || this.site(found.session).origin !== request.headers.get('origin'))
      return turnedAway();

    if (!(await this.allowed(inner, url, address)))
      return respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single');

    const response = await this.app.handle(inner);
    const answer = new Response(response.body, response);

    const set = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${this.app.flowCookieName}=`))
      ?.slice(this.app.flowCookieName.length + 1)
      .split(';')[0];

    answer.headers.delete('Set-Cookie');

    if (set) answer.headers.set(flowHeader, set);

    return answer;
  }

  /**
   * Gives the sign-in window the binding of a flow a site's dialog started, as the cookie
   * the provider's callback checks. `origin` is where the page that sent the binding is,
   * as the window's own script saw it. It must be the site the flow's subject belongs to.
   */
  private async enter(request: Request): Promise<Response> {
    const { flow: id, binding, origin } = await fields(request);

    if (typeof id !== 'string' || typeof binding !== 'string' || !opaque.test(binding))
      return unavailable();

    const flow = await this.app.service.flow(id, binding).catch(() => undefined);
    const site = flow?.local && this.siteOf(flow.local);

    if (!flow || !['connect', 'renew'].includes(flow.kind) || !site || site.origin !== origin)
      return unavailable();

    return new Response(null, {
      status: 204,
      headers: { ...safeHeaders, 'Set-Cookie': this.app.flowCookie(binding) },
    });
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
  private async read(request: Request, address: string | null): Promise<Response> {
    const asked = this.sites.read(
      request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '',
    );

    if (
      !(await allow(this.store, [
        asked
          ? { key: `read/${asked.site.id}`, limit: this.sites.limit(asked.site.id) ?? limits.read }
          : { key: client(address), limit: limits.client },
      ]))
    )
      return respond('Too many requests', html`<p>Try again later.</p>`, 429, 'single');

    if (!asked) return unavailable();

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

  /** This installation's own signing key, made the first time a record is signed. */
  private async signingKey(): Promise<string> {
    const kept = await this.store.get<string>('signing/pgp');

    if (kept) return kept;

    const made = await generateSigningKey(new URL(this.origin).host);

    await this.store.put('signing/pgp', made);

    return made;
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
  private async allowed(request: Request, url: URL, address: string | null): Promise<boolean> {
    if (request.method !== 'POST' && !limitedGets.includes(url.pathname)) return true;

    const found = await this.sites.session(request);
    const owner = found ? undefined : await this.auth.session(request);

    const holder = found
      ? { key: `session/${found.key.slice('site/session/'.length)}`, limit: limits.session }
      : owner
        ? { key: `session/${owner}`, limit: limits.session }
        : { key: client(address), limit: limits.client };

    // A handoff is charged to the site it goes to, whatever session this browser holds.
    // Anything else counts against the site whose session is still in use.
    const named =
      url.pathname === '/handoff/request'
        ? url.searchParams.get('site')
        : url.pathname === '/handoff/accept'
          ? String(peek(url.searchParams.get('token') ?? '')?.site ?? '')
          : found && !found.session.closed
            ? found.session.site
            : undefined;

    const site = named && this.sites.sites.has(named) ? named : undefined;

    return allow(this.store, [
      holder,
      ...(site ? [{ key: `site/${site}`, limit: this.sites.limit(site) ?? limits.site }] : []),
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

    if (!found || !connection) return unavailable();

    const { key, session } = found;
    const held = session.operation;
    let current = held?.connection === connection && !held.mark ? session : undefined;

    if (!current) {
      const owned = (await this.app.service.mine(session.local)).find((e) => e.id === connection);

      if (!owned) return unavailable();

      current = await this.sites.pending(key, connection, owned.visibility);

      if (!current) return unavailable();
    }

    if (current.operation!.finishedAt === undefined) {
      // Idempotent: a connection already revoked is left as it is.
      await this.app.service.revoke(connection, session.local);
      current = await this.sites.completed(key);
    }

    return see(
      this.sites.returnUrl(
        this.site(session),
        session.local,
        session.txn,
        {
          operation: 'disconnect',
          outcome: 'complete',
          connection,
          visibility: current.operation!.visibility,
          finishedAt: current.operation!.finishedAt!,
        },
        session.signer,
      ),
    );
  }

  /**
   * Lists an account another way, or retires it, from a site session, and reports it back
   * to the site as a disconnect is reported: pending on the session first, then changed,
   * then complete. Asking again for what already holds changes nothing, so a retry is safe.
   */
  private async mark(request: Request): Promise<Response> {
    const found = await this.sites.session(request);
    const fields = new URLSearchParams(await request.text());
    const connection = fields.get('connection') ?? '';
    const as = listings.find((listing) => listing === fields.get('as'));

    if (!found || !connection || !as) return unavailable();

    const { key, session } = found;
    const held = session.operation;
    let current = held?.connection === connection && held.mark === as ? session : undefined;

    if (!current) {
      const owned = (await this.app.service.mine(session.local)).find((e) => e.id === connection);

      // Checked before anything is held: what cannot be done must not be left pending.
      if (!owned || owned.status === 'revoked' || (owned.status === 'retired' && as !== 'retired'))
        return unavailable();

      current = await this.sites.pending(key, connection, owned.visibility, as);

      if (!current) return unavailable();
    }

    if (current.operation!.finishedAt === undefined) {
      await this.app.service.mark(connection, session.local, as);
      current = await this.sites.completed(key);
    }

    return see(
      this.sites.returnUrl(
        this.site(session),
        session.local,
        session.txn,
        {
          operation: 'mark',
          outcome: 'complete',
          connection,
          visibility: current.operation!.visibility,
          finishedAt: current.operation!.finishedAt!,
        },
        session.signer,
      ),
    );
  }

  /**
   * The settings page for whoever is signed in: the owner, or a holder a site sent here.
   * The owner's page carries the embed for their own site; a site's holder has the site to
   * show their badge, and removes a link through a route that tells the site so.
   */
  private async settings(subject: LocalAccount, site?: Site) {
    const connections = await this.app.service.mine(subject);
    const local = localSide(subject, this.options.siteName);
    const now = Date.now();

    // The copy button's script, on the one page that has something to copy.
    const embeds = !site && connections.some((e) => e.visibility === 'public');

    return respond(
      site ? 'Your connections' : 'Owner settings',
      html`
        ${card(local.heading, local.value, undefined, subject.reference)}
        <p class="links">
          <a class="button" href="/verify">Verify an account</a>${
            !site &&
            html`
              <a href="/records">Every connection on this instance</a>
              <a href="/sites">Sites</a>
            `
          }
        </p>
        ${
          connections.length
            ? html`
                <p class="fine">
                  Renewing a connection extends it and keeps its ID, so anything that shows it
                  goes on working.${site ? '' : ' Only a public connection can be embedded.'}
                </p>
              `
            : html`<p>No connections yet. Verify an account to make the first one.</p>`
        }
        ${connections.map((e) => this.connection(e, now, site))}
        ${
          site
            ? html`<p><a href="${site.origin}">Back to ${site.name}</a></p>`
            : html`<form action="/logout" method="post"><button>Sign out</button></form>`
        }
      `,
      200,
      '',
      embeds ? '/copy.js' : '',
    );
  }

  /**
   * Every record the instance holds, for its operator: each site's subjects, public and
   * unlisted alike, with what each is linked to and how it stands. Read-only. A public
   * record links to its evidence; an unlisted one has no page that is the operator's to open.
   */
  private async records() {
    const all = await this.app.service.all();
    const now = Date.now();
    const count = (visibility: string) => all.filter((e) => e.visibility === visibility).length;
    const live = (e: Evidence) => ['Verified', 'Unconfirmed'].includes(statusLabel(e, now));
    const sites = [...new Set(all.map((e) => e.siteName))];

    return respond(
      'All connections',
      html`
        <p class="fine">
          ${all.length} on this instance: ${count('public')} public, ${count('unlisted')} unlisted.
        </p>
        ${sites.map((name) => {
          // Live records first. The sort is stable, so each half keeps the stored order.
          const records = all
            .filter((e) => e.siteName === name)
            .sort((a, b) => Number(live(b)) - Number(live(a)));

          return html`
            <h2>${name} · ${records.length}</h2>
            ${records.map((e) => {
              const state = statusLabel(e, now);

              const local =
                e.local.reference && e.local.reference !== e.local.label
                  ? `${e.local.label} · ${e.local.reference}`
                  : e.local.label;

              // The card the settings page draws, without its controls: this page only reads.
              return html`
                <div class="connection">
                  ${externalCard(
                    cardHeading(e, ` · ${e.visibility}`),
                    e.external,
                    html`
                      <span class="state">
                        ${verdict(toneOf(e, now), true)}<span>${state}</span>
                      </span>
                    `,
                    e.visibility === 'public' &&
                      html`<p class="evidence"><a href="${e.evidenceUrl}">Inspect evidence</a></p>`,
                    html`
                      <dl>
                        <dt>Linked to</dt>
                        <dd>${local}</dd>
                        <dt>Connected</dt>
                        <dd>${date(e.connectedAt)}</dd>
                      </dl>
                    `,
                  )}
                </div>
              `;
            })}
          `;
        })}
        <p><a href="/">Back to owner settings</a></p>
      `,
    );
  }

  /**
   * Asks before an account is retired or a connection is removed, since neither can be
   * undone. The page's one button posts to the route that does it.
   */
  private async confirm(request: Request, url: URL) {
    const found = await this.sites.session(request);

    const site =
      found && !found.session.closed && !found.session.operation
        ? this.site(found.session)
        : undefined;

    const subject = site
      ? found!.session.local
      : (await this.auth.authenticated(request))
        ? this.local
        : undefined;

    const action = url.searchParams.get('do');
    const id = url.searchParams.get('connection');
    const e = subject && (await this.app.service.mine(subject)).find((e) => e.id === id);

    if (!e || (action !== 'retire' && action !== 'remove')) return unavailable();

    // What the settings page offers for this record, and nothing it does not.
    if (action === 'retire' ? ['revoked', 'retired'].includes(e.status) : e.status === 'revoked')
      return unavailable();

    const held = site && html`<input type="hidden" name="connection" value="${e.id}">`;

    const [heading, note, form] =
      action === 'retire'
        ? [
            'Retire this account?',
            retiringNote,
            html`
              <form action="${site ? '/mark' : `/connections/${e.id}/mark`}" method="post">
                ${held}
                <input type="hidden" name="as" value="retired">
                <button class="danger">Retire</button>
              </form>
            `,
          ]
        : site
          ? [
              'Disconnect this account?',
              `This removes the link between your ${site.name} account and this one. It cannot be undone. To link them again you would verify the account again.`,
              html`
                <form action="/disconnect" method="post">
                  ${held}
                  <button class="danger">Disconnect</button>
                </form>
              `,
            ]
          : [
              'Revoke this connection?',
              'This ends the connection, and it will read as revoked wherever it is shown. It cannot be undone. Verifying the account again makes a new connection with a new ID.',
              html`
                <form action="/connections/${e.id}/disconnect" method="post">
                  <button class="danger">Revoke connection</button>
                </form>
              `,
            ];

    return respond(
      heading,
      html`
        ${externalCard(cardHeading(e), e.external)}
        <p>${note}</p>
        <div class="choice">${form}<a class="button secondary" href="/">Cancel</a></div>
      `,
      200,
      'single',
    );
  }

  /** One connection: the account's card, its state, and what can be done with it. */
  private connection(e: Evidence, now: number, site?: Site) {
    // The script is the published package's, since a page on another site cannot load a
    // path on this one that the instance does not serve.
    const embed = `<script src="https://cdn.jsdelivr.net/npm/@bkazemi/verily@${version.slice(1)}/dist/verily.js" defer></script>\n<verily-badge backend-url="${this.origin}" connection-id="${e.id}"></verily-badge>`;

    const state = statusLabel(e, now);
    const retired = e.status === 'retired';
    const open = !['revoked', 'retired'].includes(e.status);
    const when = (time: number) => `${date(time)} (${distance(time, now)})`;

    const rows: [string, string][] = [
      ['Visibility', e.visibility === 'public' ? 'Public' : 'Unlisted'],
      ...(retired
        ? ([
            ['Last verified', date(lastProved(e))],
            ['Retired', date(e.retiredAt!)],
          ] as [string, string][])
        : ([['Expires', when(e.expiresAt)]] as [string, string][])),
      ...(e.mark === 'preferred' || e.mark === 'unused'
        ? ([['Listed as', e.mark === 'preferred' ? 'Preferred' : 'No longer used']] as [
            string,
            string,
          ][])
        : []),
    ];

    const shown = site
      ? e.visibility === 'public'
        ? `Anyone can view this connection, on ${site.name} or anywhere else.`
        : `Only ${site.name} can read this connection, and it chooses who there sees it.`
      : '';

    // A site's holder cannot act on a record already revoked.
    const acts = !(site && e.status === 'revoked');

    // Renewing and changing visibility start a flow on a page of their own, so they are
    // links, drawn as buttons beside the others that act on the connection.
    const goes = [
      acts && html`<a class="button" href="/renew/${e.id}">Renew</a>`,
      acts &&
        !retired &&
        site?.visibility?.length !== 1 &&
        html`<a class="button" href="/visibility/${e.id}">Change visibility</a>`,
    ].filter((go) => go !== false);

    // How the holder lists the account, which acts on every record of it they have. A
    // site's holder is sent back to the site with the change, as with a disconnect.
    const listing =
      open &&
      html`
        <form action="${site ? '/mark' : `/connections/${e.id}/mark`}" method="post">
          ${site && html`<input type="hidden" name="connection" value="${e.id}">`}
          ${
            e.mark !== 'preferred' &&
            html`<button name="as" value="preferred">Mark as preferred</button>`
          }
          ${e.mark !== 'unused' && html`<button name="as" value="unused">Mark as unused</button>`}
          ${
            e.mark !== undefined && html`<button name="as" value="current">Mark as current</button>`
          }
        </form>
      `;

    // Retiring and removing go by a page that asks first, since neither can be undone.
    const asks = (action: string, label: string, danger = false) =>
      html`
        <form action="/confirm" method="get">
          <input type="hidden" name="connection" value="${e.id}">
          <button${danger && raw(' class="danger"')} name="do" value="${action}">${label}</button>
        </form>
      `;

    // Retiring and removing cannot be undone, so they sit together on a line of their own
    // below the rest, where nothing else lines up with them.
    const ending =
      e.status !== 'revoked' &&
      html`
        <div class="ending">
          ${open && asks('retire', 'Retire', true)}
          ${asks('remove', site ? 'Disconnect' : 'Revoke', true)}
        </div>
      `;

    return html`
      <div class="connection">
        ${externalCard(
          cardHeading(e),
          e.external,
          html`
            <span class="state">${verdict(toneOf(e, now), true)}<span>${state}</span></span>
          `,
          e.visibility === 'public' &&
            html`<p class="evidence"><a href="${e.evidenceUrl}">Inspect evidence</a></p>`,
          html`<dl>${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`,
          shown && html`<p class="fine">${shown}</p>`,
          !site &&
            e.visibility === 'public' &&
            html`
              <p class="fine">Embed on your site</p>
              <pre><code>${embed}</code></pre>
            `,
          html`
            ${(goes.length > 0 || listing) && html`<div class="actions">${goes}${listing}</div>`}
            ${ending}
          `,
        )}
      </div>
    `;
  }
}
