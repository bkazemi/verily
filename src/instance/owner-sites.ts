import type { Provider } from '../core/index.js';
import { html } from '../server/html.js';
import { date } from '../server/render.js';
import { limits } from './limits.js';
import { respond, see, unavailable } from './page.js';
import { dnsPrefix, type DnsCheck, type Site, type Sites } from './sites.js';
import type { Store } from './store.js';

/** The highest limit the owner may give a site, in requests a minute. */
const maxLimit = 100000;

/**
 * Where the instance owner oversees the sites registered here: suspends one by hand, sets
 * its request limit, and approves it for YouTube. Sites in `SITES` are listed apart, read
 * only, since they are changed in the configuration.
 */
export class OwnerSites {
  constructor(
    private readonly store: Store,
    private readonly sites: Sites,
    private readonly providers: Provider[],
  ) {}

  /**
   * Every stored site, with how it stands and the owner's controls over it, then every site
   * in `SITES`.
   */
  async page(): Promise<Response> {
    const stored = this.sites.stored();

    const rows = await Promise.all(
      stored.map(async (site) => {
        const check = await this.store.get<DnsCheck>(`${dnsPrefix}${site.id}`);
        const registered = (await this.sites.operators(site.id))[0]?.addedAt;

        return this.row(site, check, registered);
      }),
    );

    const configured = this.sites.configured();

    return respond(
      'Sites',
      html`
        <h2>Registered here</h2>
        ${
          stored.length
            ? html`
                <p class="fine">
                  A site registered here gets ${limits.registered} requests a minute and no
                  YouTube until you change either. A suspended site starts nothing new, but its
                  backend can still read its connections.
                </p>
                ${rows}
              `
            : html`<p>No sites are registered here.</p>`
        }
        ${
          configured.length > 0 &&
          html`
            <h2>Set by the host</h2>
            <p class="fine">
              These sites are set in the instance's <code>SITES</code> setting and change only
              with it. Their DNS is not checked, and they cannot be suspended, limited or held
              back from YouTube here.
            </p>
            ${configured.map((site) => this.configuredRow(site))}
          `
        }
        <p><a href="/">Back to owner settings</a></p>
      `,
    );
  }

  /** One of the page's forms, sent to `path`. Every one returns to the page. */
  async change(path: string, request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const id = fields.get('id') ?? '';

    if (!this.sites.stored().some((site) => site.id === id)) return unavailable();

    if (path === '/sites/suspend') {
      const suspend = fields.get('suspend') === 'yes';

      await this.sites.control(id, ({ suspendedAt, ...rest }) =>
        suspend ? { ...rest, suspendedAt: suspendedAt ?? Date.now() } : rest,
      );
    } else if (path === '/sites/youtube') {
      const approve = fields.get('approve') === 'yes';

      await this.sites.control(id, ({ youtubeApprovedAt, ...rest }) =>
        approve ? { ...rest, youtubeApprovedAt: youtubeApprovedAt ?? Date.now() } : rest,
      );
    } else if (path === '/sites/limit') {
      const given = fields.get('limit')?.trim() ?? '';
      const limit = Number(given);

      // Left empty, the site goes back to the default.
      if (given && !(Number.isInteger(limit) && limit >= 1 && limit <= maxLimit))
        return respond(
          'Limit not changed',
          html`
            <p>A limit is a whole number of requests a minute, from 1 to ${maxLimit}.</p>
            <p><a href="/sites">Back to sites</a></p>
          `,
          400,
          'single',
        );

      await this.sites.control(id, ({ limit: _, ...rest }) => (given ? { ...rest, limit } : rest));
    } else return unavailable();

    return see('/sites');
  }

  /** A site in `SITES`, as it is configured. */
  private configuredRow(site: Site) {
    const names = new Map(this.providers.map((provider) => [provider.id, provider.name]));

    const providers = site.providers
      ? site.providers.map((id) => names.get(id) ?? id).join(', ')
      : 'Every one offered';

    const visibility = site.visibility
      ? site.visibility.map((v) => v[0]!.toUpperCase() + v.slice(1)).join(', ')
      : 'Public, Unlisted';

    return html`
      <section>
        <h3>${site.name}</h3>
        <dl>
          <dt>Site id</dt>
          <dd>${site.id}</dd>
          <dt>Origin</dt>
          <dd><a href="${site.origin}">${site.origin}</a></dd>
          <dt>Providers</dt>
          <dd>${providers}</dd>
          <dt>Visibility</dt>
          <dd>${visibility}</dd>
          <dt>Request limit</dt>
          <dd>${limits.site} a minute</dd>
        </dl>
      </section>
    `;
  }

  private row(site: Site, check: DnsCheck | undefined, registered: number | undefined) {
    const controls = this.sites.controls.get(site.id) ?? {};

    const standing =
      controls.suspendedAt !== undefined
        ? `Suspended by you since ${date(controls.suspendedAt)}`
        : check?.absentSince !== undefined
          ? `Suspended since ${date(check.absentSince)}: DNS record missing`
          : check?.checkedAt !== undefined
            ? `Served · DNS record found ${date(check.checkedAt)}`
            : 'Served · DNS record not checked yet';

    const hidden = html`<input type="hidden" name="id" value="${site.id}">`;

    return html`
      <section>
        <h3>${site.name}</h3>
        <dl>
          <dt>Site id</dt>
          <dd>${site.id}</dd>
          <dt>Origin</dt>
          <dd><a href="${site.origin}">${site.origin}</a></dd>
          ${registered !== undefined && html`<dt>Registered</dt><dd>${date(registered)}</dd>`}
          <dt>Status</dt>
          <dd>${standing}</dd>
          <dt>YouTube</dt>
          <dd>
            ${
              controls.youtubeApprovedAt !== undefined
                ? `Approved ${date(controls.youtubeApprovedAt)}`
                : 'Withheld'
            }
          </dd>
        </dl>
        <form action="/sites/limit" method="post">
          ${hidden}
          <label>
            Requests a minute
            <input
              name="limit"
              type="number"
              min="1"
              max="${maxLimit}"
              value="${controls.limit ?? ''}"
              placeholder="${limits.registered}">
          </label>
          <button>Save</button>
        </form>
        <div class="actions">
          <form action="/sites/youtube" method="post">
            ${hidden}
            ${
              controls.youtubeApprovedAt === undefined
                ? html`<button name="approve" value="yes">Approve YouTube</button>`
                : html`<button name="approve" value="no">Withhold YouTube</button>`
            }
          </form>
          <form action="/sites/suspend" method="post">
            ${hidden}
            ${
              controls.suspendedAt === undefined
                ? html`<button name="suspend" value="yes" class="danger">Suspend</button>`
                : html`<button name="suspend" value="no">Unsuspend</button>`
            }
          </form>
        </div>
      </section>
    `;
  }
}
