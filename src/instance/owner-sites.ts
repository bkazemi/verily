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
 * its request limit, and approves it for YouTube. Sites in `SITES` are the host's, and are
 * not listed.
 */
export class OwnerSites {
  constructor(
    private readonly store: Store,
    private readonly sites: Sites,
  ) {}

  /** Every stored site, with how it stands and the owner's controls over it. */
  async page(): Promise<Response> {
    const stored = this.sites.stored();

    const rows = await Promise.all(
      stored.map(async (site) => {
        const check = await this.store.get<DnsCheck>(`${dnsPrefix}${site.id}`);
        const registered = (await this.sites.operators(site.id))[0]?.addedAt;

        return this.row(site, check, registered);
      }),
    );

    return respond(
      'Registered sites',
      html`
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
            <p><a href="/sites">Back to registered sites</a></p>
          `,
          400,
          'single',
        );

      await this.sites.control(id, ({ limit: _, ...rest }) => (given ? { ...rest, limit } : rest));
    } else return unavailable();

    return see('/sites');
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
        <h2>${site.name}</h2>
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
