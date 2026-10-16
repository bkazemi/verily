import { timingSafeEqual } from 'node:crypto';
import { expired, type Provider, type Visibility } from '../core/index.js';
import { html, raw, type Html } from '../server/html.js';
import { date, minute } from '../server/render.js';
import { hash, secret } from '../server/service.js';
import { allow } from './limits.js';
import { respond, readCookie, see, setCookie, unavailable } from './page.js';
import { dnsPrefix, lapseMs, validId, type DnsCheck, type Site, type Sites } from './sites.js';
import type { Store } from './store.js';

const cookieName = 'verily_dashboard';

const sessionMs = 8 * 3600000;

/** Sign-in attempts a minute for one site, whoever makes them. */
const loginLimit = 10;

const sessionPrefix = 'site/dashboard/';

interface DashboardSession {
  site: string;
  /** The hash of the dashboard key it was opened with. Removing that key ends the session. */
  operator: string;
  expiresAt: number;
}

/** The session cookie, sent only to the dashboard's pages. */
const sessionSet = (value: string, ms: number) => setCookie(cookieName, value, ms, '/dashboard');

const signIn = (message?: Html, status = 200) =>
  respond(
    'Site dashboard',
    html`
      ${message}
      <form action="/dashboard/login" method="post">
        <label>Site id <input name="id" autocomplete="username" required></label>
        <label>
          Dashboard key
          <input name="key" type="password" autocomplete="current-password" required>
        </label>
        <button>Sign in</button>
      </form>
    `,
    status,
    'single',
  );

const back = html`<p><a href="/dashboard">Back to the dashboard</a></p>`;

/**
 * Asks before a key change goes ahead, on a page of its own. Its button sends `fields` to
 * `action` again, with `confirm=yes`.
 */
const ask = (
  heading: string,
  text: string,
  action: string,
  fields: Record<string, string>,
  button: string,
  danger: boolean,
) =>
  respond(
    heading,
    html`
      <p>${text}</p>
      <form action="${action}" method="post">
        ${Object.entries(fields).map(
          ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
        )}
        <input type="hidden" name="confirm" value="yes">
        <button${danger && raw(' class="danger"')}>${button}</button>
      </form>
      ${back}
    `,
    200,
    'single',
  );

const checkbox = (name: string, value: string, label: string, checked: boolean) =>
  html`
    <label>
      <input type="checkbox" name="${name}" value="${value}"${checked && raw(' checked')}> ${label}
    </label>
  `;

/**
 * Where the operators of a site registered here change its settings and replace its key.
 * An operator signs in with the site's id and a dashboard key, which is kept only as a
 * hash. Sites in `SITES` have no operators, and are changed by the host.
 */
export class Dashboard {
  constructor(
    private readonly store: Store,
    private readonly sites: Sites,
    private readonly providers: Provider[],
    private readonly host: string,
  ) {}

  /** The signed-in operator's site, if the session and the key it was opened with still hold. */
  private async session(request: Request) {
    const value = readCookie(request, cookieName);

    if (!value) return undefined;

    const key = `${sessionPrefix}${hash(value)}`;
    const session = await this.store.get<DashboardSession>(key);

    if (!session || expired(session, Date.now())) return undefined;

    const site = this.sites.stored().find((stored) => stored.id === session.site);
    const operators = site ? await this.sites.operators(site.id) : [];

    if (!site || !operators.some((operator) => operator.hash === session.operator))
      return undefined;

    return { key, site };
  }

  /** The dashboard for a signed-in operator, or the sign-in form. */
  async page(request: Request): Promise<Response> {
    const found = await this.session(request);

    return found ? this.render(found.site) : signIn();
  }

  async login(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const id = fields.get('id')?.trim() ?? '';
    const given = fields.get('key') ?? '';

    if (!validId(id)) return signIn(html`<p>Incorrect site id or key.</p>`, 403);

    if (!(await allow(this.store, [{ key: `dashboard/${id}`, limit: loginLimit }])))
      return signIn(html`<p>Too many attempts. Try again in a minute.</p>`, 429);

    const operator = (await this.sites.operators(id)).find((candidate) =>
      timingSafeEqual(Buffer.from(candidate.hash), Buffer.from(hash(given))),
    );

    if (!operator || !this.sites.stored().some((site) => site.id === id))
      return signIn(html`<p>Incorrect site id or key.</p>`, 403);

    const session = secret();

    await this.store.put<DashboardSession>(`${sessionPrefix}${hash(session)}`, {
      site: id,
      operator: operator.hash,
      expiresAt: Date.now() + sessionMs,
    });

    return see('/dashboard', [sessionSet(session, sessionMs)]);
  }

  async logout(request: Request): Promise<Response> {
    const value = readCookie(request, cookieName);

    if (value) await this.store.delete(`${sessionPrefix}${hash(value)}`);

    return see('/dashboard', [sessionSet('', 0)]);
  }

  /** Saves the site's URLs, providers and visibility. */
  async settings(request: Request): Promise<Response> {
    const found = await this.session(request);

    if (!found) return unavailable(403);

    const fields = new URLSearchParams(await request.text());
    const offered = this.offered();
    const providers = fields.getAll('provider').filter((id) => offered.has(id));

    const visibility = fields
      .getAll('visibility')
      .filter((v): v is Visibility => v === 'public' || v === 'unlisted');

    if (!providers.length || !visibility.length)
      return this.render(
        found.site,
        html`<p>Choose at least one provider and one visibility.</p>`,
        400,
      );

    try {
      await this.sites.update(found.site.id, {
        authorizeUrl: fields.get('authorizeUrl')?.trim() ?? '',
        returnUrl: fields.get('returnUrl')?.trim() ?? '',
        // Every provider chosen is saved as no list, so the site also gets any added later.
        providers: providers.length === offered.size ? undefined : providers,
        visibility: visibility.length === 2 ? undefined : visibility,
      });
    } catch {
      return this.render(
        found.site,
        html`<p>The authorize and return URLs must be on ${found.site.origin}.</p>`,
        400,
      );
    }

    return see('/dashboard');
  }

  /**
   * Replaces the site key and shows the new one, once, on a page of its own. The operator
   * chooses whether the old key keeps working for a day, for a routine change, or stops at
   * once, for a leak. The form names the key it replaces, so sending it again, from a
   * reload or a second tab, replaces nothing.
   */
  async rotate(request: Request): Promise<Response> {
    const found = await this.session(request);

    if (!found) return unavailable(403);

    const fields = new URLSearchParams(await request.text());
    const keep = fields.get('keep') === 'day';
    const from = fields.get('from') ?? '';

    const replaced = () =>
      respond(
        'Key already replaced',
        html`
          <p>
            The site key was already replaced since this form was loaded, so nothing changed.
            The new key was shown when it was made.
          </p>
          ${back}
        `,
        409,
        'single',
      );

    if (from !== hash(found.site.key)) return replaced();

    const overlapping = !!found.site.previousKey && (found.site.previousUntil ?? 0) > Date.now();

    if (fields.get('confirm') !== 'yes')
      return keep
        ? ask(
            'Replace the key?',
            `Deploy the new key to your backend within 24 hours. After that the old key stops working, and so does your site until it has the new one.${overlapping ? ' The older key still accepted from the last replacement stops working now.' : ''}`,
            '/dashboard/rotate',
            { keep: 'day', from },
            'Replace, keep the old key for 24 hours',
            false,
          )
        : ask(
            'Replace the key now?',
            'Your site stops sending users here and reading their connections until you deploy the new key. To change keys without interruption, keep the old key for 24 hours instead.',
            '/dashboard/rotate',
            { keep: 'none', from },
            'Replace now',
            true,
          );

    const key = await this.sites.rotate(found.site.id, keep, from);

    if (!key) return replaced();

    const until = this.sites.sites.get(found.site.id)?.previousUntil;

    return respond(
      'New site key',
      html`
        <p>This key is shown once. Copy it now.</p>
        <pre><code>${key}</code></pre>
        <p>
          ${
            keep && until
              ? `The old key keeps working until ${minute(until)}. Deploy the new key to your backend, then stop accepting the old one from the dashboard.`
              : 'The old key no longer works. Deploy the new key to your backend now: until you do, your site cannot send users here or read their connections.'
          }
        </p>
        ${back}
      `,
    );
  }

  /** Stops accepting the previous site key before its 24 hours are up, once confirmed. */
  async retirePreviousKey(request: Request): Promise<Response> {
    const found = await this.session(request);

    if (!found) return unavailable(403);

    if (new URLSearchParams(await request.text()).get('confirm') !== 'yes')
      return ask(
        'Stop accepting the old key?',
        'Any backend still using the old key stops working at once: it cannot send users here or read their connections. Do this only once the new key is deployed everywhere.',
        '/dashboard/previous-key',
        {},
        'Stop accepting the old key',
        true,
      );

    await this.sites.retirePreviousKey(found.site.id);

    return see('/dashboard');
  }

  /**
   * Deletes the site, once the operator has typed its id to confirm. Its id is never used
   * again, so the same domain can only come back as a new site.
   */
  async delete(request: Request): Promise<Response> {
    const found = await this.session(request);

    if (!found) return unavailable(403);

    const typed = new URLSearchParams(await request.text()).get('confirm')?.trim();

    if (typed !== found.site.id)
      return this.render(found.site, html`<p>Type the site id to delete the site.</p>`, 400);

    await this.sites.retire(found.site.id, 'deleted');
    await this.store.delete(found.key);

    const response = respond(
      'Site deleted',
      html`
        <p>
          ${found.site.name} is deleted and no longer served here.
          Its id, <code>${found.site.id}</code>, cannot be registered again.
        </p>
      `,
      200,
      'single',
    );

    response.headers.append('Set-Cookie', sessionSet('', 0));

    return response;
  }

  /** The provider ids this instance offers, each once, with a name to show. */
  private offered(): Map<string, string> {
    return new Map(this.providers.map((provider) => [provider.id, provider.name]));
  }

  private async render(site: Site, message?: Html, status = 200): Promise<Response> {
    const check = await this.store.get<DnsCheck>(`${dnsPrefix}${site.id}`);
    const record = `_verily.${new URL(site.origin).hostname}`;

    const suspended = check?.absentSince !== undefined;

    const standing = suspended
      ? `Suspended since ${date(check.absentSince!)}`
      : check?.checkedAt !== undefined
        ? `Served · DNS record found ${date(check.checkedAt)}`
        : 'Served · DNS record not checked yet';

    // The one thing on the page the operator has to act on, so the one sentence.
    const restore =
      suspended &&
      html`
        <p>
          <code>${record}</code> no longer has <code>verily-verifier=${this.host}</code>.
          Add it back and the site is served again within an hour.
          Otherwise the site is deleted on ${date(check.absentSince! + lapseMs)}.
        </p>
      `;

    const overlapping = !!site.previousKey && (site.previousUntil ?? 0) > Date.now();

    const providers = [...this.offered()].map(([id, name]) =>
      checkbox('provider', id, name, !site.providers || site.providers.includes(id)),
    );

    const visibility = (['public', 'unlisted'] as const).map((v) =>
      checkbox(
        'visibility',
        v,
        v[0]!.toUpperCase() + v.slice(1),
        !site.visibility || site.visibility.includes(v),
      ),
    );

    return respond(
      'Site dashboard',
      html`
        ${message}
        <dl>
          <dt>Site</dt>
          <dd>${site.name}</dd>
          <dt>Site id</dt>
          <dd>${site.id}</dd>
          <dt>Status</dt>
          <dd>${standing}</dd>
        </dl>
        ${restore}
        <h2>Settings</h2>
        <form action="/dashboard/settings" method="post">
          <label>
            Authorize URL
            <input name="authorizeUrl" type="url" value="${site.authorizeUrl}" required>
          </label>
          <label>
            Return URL
            <input name="returnUrl" type="url" value="${site.returnUrl}" required>
          </label>
          <fieldset>
            <legend>Providers your users may verify with</legend>
            ${providers}
          </fieldset>
          <fieldset>
            <legend>Visibility your users may choose</legend>
            ${visibility}
          </fieldset>
          <button>Save</button>
        </form>
        <section class="caution">
          <h2>Site key</h2>
          <p class="fine">
            Your backend signs handoffs and reads connections with this key. A new key is shown
            once. Keep the old key working for 24 hours to deploy the new one without
            interruption, or stop it at once if it may have leaked.
          </p>
          ${
            overlapping &&
            html`
              <section>
                <p>
                  The old key is accepted until ${minute(site.previousUntil!)}.
                  Stop accepting it once the new key is deployed.
                </p>
                <div class="actions">
                  <form action="/dashboard/previous-key" method="post">
                    <button>Stop accepting the old key</button>
                  </form>
                </div>
              </section>
            `
          }
          <div class="actions">
            <form action="/dashboard/rotate" method="post">
              <input type="hidden" name="from" value="${hash(site.key)}">
              <button name="keep" value="day">Replace, keep the old key for 24 hours</button>
              <button name="keep" value="none">Replace now</button>
            </form>
          </div>
        </section>
        <section class="danger">
          <h2>Delete the site</h2>
          <p class="fine">
            The site stops being served here at once, and its id can never be registered again.
            To come back, register the domain as a new site; your users then connect their
            accounts again.
          </p>
          <form action="/dashboard/delete" method="post">
            <label>
              Type <code>${site.id}</code> to confirm
              <input name="confirm" autocomplete="off" required>
            </label>
            <button class="danger">Delete the site</button>
          </form>
        </section>
        <footer>
          <div class="actions">
            <form action="/dashboard/logout" method="post"><button>Sign out</button></form>
          </div>
        </footer>
      `,
      status,
    );
  }
}
