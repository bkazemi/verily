import { html, type Html } from '../server/html.js';
import { domainOf, namedVerifiers, published, type DnsOptions } from '../server/domain.js';
import { hash, secret } from '../server/service.js';
import { respond, readCookie, see, setCookie } from './page.js';
import { checked, dnsPrefix, open, sign, type DnsCheck, type Site, type Sites } from './sites.js';
import type { Store } from './store.js';

/** Whether anyone may register a site here. `open` serves a site once its DNS checks out. */
export type Registration = 'off' | 'open';

/** How long a claim lasts. DNS changes can take up to 72 hours to appear. */
const claimMs = 72 * 3600000;

const claimCookie = 'verily_claim';

/** What a claim cookie carries, signed with the instance's claim key. */
interface Claim {
  site: Omit<Site, 'key'>;
  /** Published as `verily-claim=<code>`, and different for every claim. */
  code: string;
  exp: number;
}

const claimPrefix = 'verily-claim=';

/** The claim cookie, sent only to the registration pages. */
const claimed = (value: string, ms: number) => setCookie(claimCookie, value, ms, '/register');

const field = (form: URLSearchParams, name: string) => (form.get(name) ?? '').trim();

const form = (message?: Html, values: Record<string, string> = {}) =>
  respond(
    'Register a site',
    html`${message}<p>Register your site to send its users here to verify their accounts. You will need to add two DNS records to your domain.</p>
<form action="/register" method="post">
<label>Domain <input name="domain" value="${values.domain ?? ''}" placeholder="example.com" required></label>
<label>Site id <input name="id" value="${values.id ?? ''}" pattern="[a-z0-9-]{1,32}" placeholder="example" required></label>
<label>Authorize URL <input name="authorizeUrl" type="url" value="${values.authorizeUrl ?? ''}" placeholder="https://example.com/api/verily/authorize" required></label>
<label>Return URL <input name="returnUrl" type="url" value="${values.returnUrl ?? ''}" placeholder="https://example.com/api/verily/return" required></label>
<button>Continue</button>
</form>`,
    message ? 400 : 200,
  );

/**
 * Sites asking to be served here. A claim is held in the requester's browser, signed, and
 * nothing is stored until the domain's DNS shows they control it: a `verily-claim` record
 * with the claim's code, and the `verily-verifier` record naming this instance, which
 * stays up for as long as the site is served.
 */
export class Registrations {
  private readonly host: string;

  constructor(
    private readonly store: Store,
    private readonly sites: Sites,
    origin: string,
    private readonly dns: DnsOptions = {},
  ) {
    this.host = new URL(origin).host.toLowerCase();
  }

  /** The secret claims are signed with, made the first time one is. */
  private async key(): Promise<string> {
    return this.store.transaction(async (tx) => {
      const kept = await tx.get<string>('site/claim-key');

      if (kept) return kept;

      const made = secret();

      await tx.put('site/claim-key', made);

      return made;
    });
  }

  private async claim(request: Request): Promise<Claim | undefined> {
    const token = readCookie(request, claimCookie);
    const payload = token ? open(await this.key(), token) : undefined;

    return payload && typeof payload.exp === 'number' && payload.exp * 1000 > Date.now()
      ? (payload as unknown as Claim)
      : undefined;
  }

  /** The form, or the records to publish for a claim this browser holds. */
  async page(request: Request): Promise<Response> {
    const claim = await this.claim(request);

    return claim ? this.records(claim) : form();
  }

  /** Checks the form and gives this browser a claim for it. */
  async request(request: Request): Promise<Response> {
    const values = new URLSearchParams(await request.text());
    const domain = field(values, 'domain').toLowerCase().replace(/\.$/, '');
    const shown = Object.fromEntries([...values].map(([name, value]) => [name, value.trim()]));

    if (!domainOf(`https://${domain}`))
      return form(html`<p>Enter a public domain name, such as example.com.</p>`, shown);

    let site: Omit<Site, 'key'>;

    try {
      site = checked({
        id: field(values, 'id'),
        name: domain,
        origin: `https://${domain}`,
        authorizeUrl: field(values, 'authorizeUrl'),
        returnUrl: field(values, 'returnUrl'),
      });
    } catch {
      return form(
        html`<p>Use an id of lowercase letters, digits and hyphens, and URLs on your domain.</p>`,
        shown,
      );
    }

    if (this.sites.sites.has(site.id))
      return form(html`<p>That id is taken. Choose another.</p>`, shown);

    const exp = Math.floor((Date.now() + claimMs) / 1000);
    const token = sign(await this.key(), { site, code: secret(), exp });

    return see('/register', [claimed(token, claimMs)]);
  }

  /** What to publish for a claim, and the button that checks it. */
  private records(claim: Claim, message?: Html, status = 200): Response {
    const name = `_verily.${new URL(claim.site.origin).hostname}`;

    return respond(
      'Add the DNS records',
      html`${message}<p>Add two TXT records named <code>${name}</code>:</p>
<pre><code>${`${claimPrefix}${claim.code}`}</code></pre>
<pre><code>${`verily-verifier=${this.host}`}</code></pre>
<p>The first proves you control ${claim.site.name}, and can be removed once the site is registered. The second says this instance verifies for your site. Keep it: if it is removed, the site stops being served within a day.</p>
<p>DNS changes can take up to 72 hours to appear.</p>
<form action="/register/check" method="post"><button>Check the records</button></form>
<form action="/register/cancel" method="post"><button>Start over</button></form>`,
      status,
    );
  }

  /** Looks the records up and, if both are there, registers the site and shows its keys. */
  async check(request: Request): Promise<Response> {
    const claim = await this.claim(request);

    if (!claim) return form(html`<p>That registration expired. Start again.</p>`);

    const domain = new URL(claim.site.origin).hostname;

    const values = await published(domain, this.dns)
      .then((found) => found.values)
      .catch(() => undefined);

    if (!values)
      return this.records(claim, html`<p>DNS could not be read. Try again shortly.</p>`, 503);

    // The code is public once published, so a plain comparison gives nothing away.
    const proved = values.some(
      (value) =>
        value.startsWith(claimPrefix) && value.slice(claimPrefix.length).trim() === claim.code,
    );

    const named = namedVerifiers(values).some(({ host }) => host === this.host);

    if (!proved || !named)
      return this.records(
        claim,
        html`<p>${!proved && !named ? 'Neither record was' : !proved ? 'The verily-claim record was not' : 'The verily-verifier record was not'} found yet.</p>`,
        409,
      );

    const siteKey = secret();
    const dashboardKey = secret();

    try {
      await this.sites.register(
        { ...claim.site, key: siteKey },
        { kind: 'key', hash: hash(dashboardKey), addedAt: Date.now() },
      );
    } catch {
      return respond(
        'Not registered',
        html`<p>That id or domain was registered by someone else first.</p><form action="/register/cancel" method="post"><button>Start over</button></form>`,
        409,
      );
    }

    const response = respond(
      'Site registered',
      html`<p>${claim.site.name} is registered as <code>${claim.site.id}</code>. These keys are shown once and cannot be shown again.</p>
<p>Site key, for your backend only. It signs handoffs and reads your users' connections.</p>
<pre><code>${siteKey}</code></pre>
<p>Dashboard key, for whoever manages the site here. Keep it in a password manager.</p>
<pre><code>${dashboardKey}</code></pre>
<p>If both keys are lost, the site cannot be recovered. Registering the domain again makes a new site, and your users have to connect their accounts again.</p>`,
    );

    response.headers.append('Set-Cookie', claimed('', 0));

    return response;
  }

  /** Drops this browser's claim. */
  cancel(): Response {
    return see('/register', [claimed('', 0)]);
  }
}

/**
 * How often a stored site's DNS is read again: daily, and hourly while it is suspended or
 * after a lookup that got no answer.
 */
const recheckMs = 24 * 3600000;
const retryMs = 3600000;

/** How many sites one `recheckSites()` looks up, so upkeep stays short. */
const recheckBudget = 20;

/**
 * Reads each stored site's DNS again when it is due, and suspends a site whose DNS no
 * longer names this instance, or lifts the suspension once it does again. A lookup that
 * could not be made changes nothing: only an answer without the record suspends a site.
 * Sites in `SITES` are the host's to configure, and are not checked.
 *
 * Every attempt is recorded, answered or not, and the due sites asked longest ago go
 * first. So sites that are always due, suspended or failing, cannot use up every run's
 * budget and leave the rest unchecked.
 */
export async function recheckSites(
  store: Store,
  sites: Sites,
  origin: string,
  dns: DnsOptions = {},
): Promise<void> {
  const host = new URL(origin).host.toLowerCase();
  const now = Date.now();

  await sites.refresh();

  const checks = new Map(
    (await store.list<DnsCheck>(dnsPrefix)).map(([key, check]) => [
      key.slice(dnsPrefix.length),
      check,
    ]),
  );

  const due = sites
    .stored()
    .map((site) => ({ site, last: checks.get(site.id) }))
    .filter(({ last }) => {
      if (!last) return true;

      const answered = last.checkedAt !== undefined && last.checkedAt >= last.attemptedAt;
      const every = answered && last.absentSince === undefined ? recheckMs : retryMs;

      return now - last.attemptedAt >= every;
    })
    .sort((a, b) => (a.last?.attemptedAt ?? 0) - (b.last?.attemptedAt ?? 0))
    .slice(0, recheckBudget);

  for (const { site, last } of due) {
    const values = await published(new URL(site.origin).hostname, dns)
      .then((found) => found.values)
      .catch(() => undefined);

    const named = values && namedVerifiers(values).some((found) => found.host === host);

    await store.put<DnsCheck>(
      `${dnsPrefix}${site.id}`,
      values
        ? {
            attemptedAt: now,
            checkedAt: now,
            ...(named ? {} : { absentSince: last?.absentSince ?? now }),
          }
        : { ...last, attemptedAt: now },
    );
  }

  await sites.refresh();
}
