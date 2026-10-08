import type { Evidence } from '../core/index.js';
import {
  badgeShown,
  quietBadge,
  renderBadge,
  renderBadgeMessage,
  renderBadgePending,
  renderConnectPill,
} from './badge.js';
import {
  openConnectDialog,
  type ConnectApi,
  type FlowView,
  type Methods,
} from './connect-dialog.js';
import { openEvidenceDialog, type Account, type Listing, type Manage } from './evidence-dialog.js';
import { drawSignedWith, standing, watchSigned } from './signed.js';

export type { Evidence } from '../core/index.js';

export interface Result {
  outcome: 'complete' | 'cancelled' | 'failed';
  connectionId?: string;
}

/**
 * What each host's dialog opens on and how it reads again, kept apart from the pill: the
 * most recent records read for the host, and the way to read them afresh. Both are set on
 * every presentation whether or not the pill changed, because new records often leave the
 * pill looking the same, and a renewal moves dates the pill never shows. The click handler
 * holds neither. It looks them up when clicked, so it is the same handler however the pill
 * came to be drawn and cannot fall behind what the host was last given.
 */
const latestGroup = new WeakMap<HTMLElement, Evidence[]>();
const loaders = new WeakMap<HTMLElement, () => Promise<Evidence[]>>();

/**
 * What a host's dialog lets its reader do with the accounts shown, for a host whose page
 * said its reader holds them: the holder's own badge, on a page only they are shown.
 * Looked up when the dialog opens.
 */
const managers = new WeakMap<HTMLElement, Manage>();

/** Where a host's records are no longer to be shown: an open dialog says so on its next read. */
const unavailable = async (): Promise<Evidence[]> => {
  throw new Error('Unavailable');
};

/**
 * How many times each host has been given something to present. A read that takes time
 * can finish after the host has moved on: to other records, to none, or to the same ones
 * asked for again. What it brings back then is about a host that no longer exists, so
 * whoever started it checks it is still the latest before touching the host, whether it
 * came back with records or with a failure.
 */
const generations = new WeakMap<HTMLElement, number>();

/** Starts a presentation, and returns whether it is still the host's latest. */
function begin(element: HTMLElement): () => boolean {
  const mine = (generations.get(element) ?? 0) + 1;

  generations.set(element, mine);

  return () => generations.get(element) === mine;
}

/** Stops a host's dialog showing what the host no longer presents, from its next read on. */
function forget(element: HTMLElement) {
  begin(element);
  latestGroup.delete(element);
  loaders.set(element, unavailable);
}

/** Takes a host's records away: its pill says so now, and an open dialog when it next reads. */
function withdraw(element: HTMLElement) {
  forget(element);
  renderBadgeMessage(element, 'Unavailable');
}

/**
 * Makes a drawn pill open the dialog. A modified click is left alone, so it follows the
 * pill's own link where it has one. Assigned, not added: the pill is kept across renders,
 * so a listener per render would stack up on the same element.
 */
function opens(element: HTMLElement, badge: HTMLElement) {
  badge.setAttribute('aria-haspopup', 'dialog');

  badge.onclick = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      typeof HTMLDialogElement === 'undefined'
    )
      return;

    event.preventDefault();
    details(element);
  };
}

/** Opens a host's dialog on the records it holds now. */
function details(element: HTMLElement) {
  {
    // The dialog opens on what the host holds, at full size, and the read that follows
    // either leaves it alone or replaces it. It is given the records themselves and groups
    // them into accounts each time it draws, so an account whose leading record runs out
    // is taken up at that moment by another of its records that is still good.
    openEvidenceDialog(
      element,
      // Looked up at each read, so an open dialog follows a loader replaced under it. A
      // read the host moved on from while it was out is not shown: the host's loader by
      // then is asked instead, until one comes back to a host that has not changed.
      async () => {
        for (;;) {
          const before = generations.get(element);

          try {
            const records = await (loaders.get(element) ?? unavailable)();

            if (generations.get(element) === before) return records;
          } catch (error) {
            if (generations.get(element) === before) throw error;
          }
        }
      },
      latestGroup.get(element),
      accounts,
      managers.get(element),
    );
  }
}

/** How a pill of several accounts names them, where the page that placed it says. */
export interface Arrangement {
  /** Every account on a row of its own, in a pill as tall as its rows. */
  stacked?: boolean;
  /**
   * Whether a short pill opens a panel naming its accounts while a pointer rests on it or
   * the keyboard is on it. On unless this is false. A stacked pill has nothing to open.
   */
  peek?: boolean;
}

/**
 * Hosts whose pill is stacked, and hosts whose pill opens no panel, where the page asked
 * for either. Kept here so every later refresh of the host draws it the same way.
 */
const stackedHosts = new WeakSet<HTMLElement>();
const quietHosts = new WeakSet<HTMLElement>();

/**
 * How many accounts a pill names before it counts the rest. A stacked pill pays for each
 * row in the page's height. A panel floats over the page and pays nothing, but it cannot
 * be scrolled, so it stops while it still fits a small window.
 */
const stackedAccounts = 4;
const peekedAccounts = 8;

/** Records how a host's pill is arranged, from what the page last said. */
function arrange(element: HTMLElement, { stacked, peek }: Arrangement) {
  if (stacked) stackedHosts.add(element);
  else stackedHosts.delete(element);

  if (peek === false) quietHosts.add(element);
  else quietHosts.delete(element);
}

const live = (evidence: Evidence) =>
  evidence.status === 'verified' && evidence.expiresAt > Date.now();

/**
 * A subject's accounts, one entry for each. The one its holder prefers comes first, then
 * the rest in the order they were connected, earliest first, then those the holder no
 * longer uses, and last those retired. Records are not accounts: the same account can
 * stand on several, shown a second way, or revoked once and connected again. Those are one
 * account and get one card.
 *
 * Where any of an account's records is verified now, the earliest of those speaks for it,
 * and the ways the others show it are listed beneath as other methods. Its lapsed
 * records are left out, having been replaced. Where none is verified, the latest one says
 * what became of it. Either way the account keeps the place of its first connection.
 * Each entry names every record of the account not yet revoked, shown or not, so removing
 * the account removes them all. One left behind, lapsed or unconfirmed, could be confirmed
 * again later and bring the account back without its holder approving anything.
 *
 * A record from a backend older than `connectedAt` is placed by when it was approved.
 */
function accounts(records: Evidence[]): Account[] {
  const when = (e: Evidence) => e.connectedAt ?? e.approvedAt;
  const byAccount = new Map<string, Evidence[]>();

  for (const record of records) {
    const key = JSON.stringify([record.provider, record.external.id]);

    byAccount.set(key, [...(byAccount.get(key) ?? []), record]);
  }

  return [...byAccount.values()]
    .map((held) => {
      const sorted = [...held].sort((a, b) => when(a) - when(b));
      const verified = sorted.filter(live);
      const base = verified[0] ?? sorted.reduce((a, b) => (b.approvedAt > a.approvedAt ? b : a));
      const external = [...base.attestations.external] as Evidence['attestations']['external'];

      for (const other of verified.slice(1))
        for (const attestation of other.attestations.external)
          if (!external.some((shown) => shown.method === attestation.method))
            external.push(attestation);

      return {
        ...base,
        connectedAt: when(sorted[0]!),
        attestations: { ...base.attestations, external },
        links: sorted.filter((e) => e.status !== 'revoked').map((e) => e.id),
        // Every record the card speaks for, so its signature mark answers for all of them.
        sources: verified.length ? verified : [base],
      };
    })
    .sort((a, b) => place(a) - place(b) || a.connectedAt - b.connectedAt);
}

/**
 * Where an account is listed among a subject's others, before the order they were
 * connected in. This is all there is to preferring an account: there is no separate pin.
 */
function place(account: Evidence): number {
  if (account.status === 'retired') return 3;

  return account.mark === 'preferred' ? 0 : account.mark === 'unused' ? 2 : 1;
}

/**
 * One subject's accounts as a single pill: the first of them, then how many more stand
 * behind it. The order is the holder's preferred account, then the order the rest were
 * connected in, which a renewal never changes, then the ones no longer used.
 * Only accounts verified now are counted, and one of those leads when the first has
 * lapsed, so the pill never puts a lapsed account forward while a good one sits behind
 * a number. The lapsed ones are all still there in the dialog, each in its place. A
 * preferred account that has lapsed keeps its mark, and leads again once renewed. A
 * retired account is never counted, and leads only where nothing else is shown.
 *
 * `load` gives the records afresh when the dialog opens and as it stays open.
 */
function presentGroup(element: HTMLElement, records: Evidence[], load: () => Promise<Evidence[]>) {
  const ordered = accounts(records.map(standing));
  const verified = ordered.filter(live);
  const lead = verified[0] ?? ordered[0]!;

  latestGroup.set(element, records);
  loaders.set(element, load);

  // The accounts the count stands for are named too, as far as there is room: in rows of
  // the pill where it is stacked, and otherwise in the panel a short pill opens.
  const stacked = stackedHosts.has(element);
  const peek = !stacked && !quietHosts.has(element);

  const badge = renderBadge(element, lead, {
    more: Math.max(verified.length - 1, 0),
    linked: lead.visibility === 'public',
    rows: stacked
      ? verified.slice(1, stackedAccounts)
      : peek
        ? verified.slice(1, peekedAccounts)
        : [],
    peek,
  });

  // Null means the pill on screen is unchanged. Its handler stands, and reads the above.
  if (badge) opens(element, badge);

  // A check that comes back may change what the pill is drawn from: the signed record's own
  // words once it checks, and a record no longer verified if it fails.
  watchSigned(records, () => {
    if (latestGroup.get(element) === records) presentGroup(element, records, load);
  });
}

/**
 * The records as one subject's, each safe to draw, or nothing. Every link in them must be
 * one a page may follow, and they must all describe the same subject: the dialog names
 * the subject once, above every account, and may not put one subject's name over
 * another's.
 */
function oneSubject(records: unknown): Evidence[] | undefined {
  if (!Array.isArray(records) || !records.length || !records.every(validEvidence)) return undefined;

  const [first] = records as [Evidence, ...Evidence[]];

  return records.every(
    (e) =>
      readable(e) && e.siteName === first.siteName && e.local.reference === first.local.reference,
  )
    ? records
    : undefined;
}

/**
 * Presents records the page already holds, without asking any backend for them. This is
 * how a site shows links only it can read: its own backend read them with its key and put
 * them in the page for the readers it chose. Nothing here can check them again, so the
 * page is what vouches for them, and an unlisted one is drawn with no link to follow.
 */
export function presentConnections(
  element: HTMLElement,
  records: unknown,
  arrangement: Arrangement = {},
): void {
  const subject = oneSubject(records);

  arrange(element, arrangement);

  // Nothing is awaited here, but a read still out for this host must not land on top.
  begin(element);

  if (!subject) {
    withdraw(element);

    return;
  }

  presentGroup(element, subject, async () => subject);
}

export function init({ backendUrl, handoffUrl }: { backendUrl: string; handoffUrl?: string }) {
  const base = new URL(backendUrl, location.href);

  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid backend URL');

  // Where the backend's routes begin, with no slash to end it: a backend mounted at the
  // root of its origin has a path of `/` however it is written, and its routes are not
  // under `//`.
  const root = base.href.replace(/\/$/, '');

  /**
   * A backend on another origin: an instance this site is registered with. Its cookies
   * are another site's on this page, so the dialog carries what they would have. The
   * session comes from trading a handoff, which this site's own backend signs for its
   * signed-in user at `handoffUrl`, and each flow's binding comes back in a header.
   */
  const remote = base.origin !== location.origin;
  const bindings = new Map<string, string>();
  let session: Promise<string> | undefined;

  async function openSession(): Promise<string> {
    const handed = await fetch(new URL(handoffUrl!, location.href), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });

    const vouched: unknown = handed.ok ? await handed.json() : undefined;

    if (!record(vouched) || typeof vouched.token !== 'string')
      throw new Error('Verily request unavailable');

    const traded = await fetch(`${root}/site/session`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: vouched.token }),
    });

    const opened: unknown = traded.ok ? await traded.json() : undefined;

    if (!record(opened) || typeof opened.session !== 'string')
      throw new Error('Verily request unavailable');

    return opened.session;
  }

  /** One of the dialog's requests. `flow` names the flow whose binding goes with it. */
  async function ask(path: string, data?: Record<string, string>, flow?: string): Promise<unknown> {
    if (!remote) return request(path, data);

    const binding = flow && bindings.get(flow);

    const response = await fetch(`${root}${path}`, {
      credentials: 'omit',
      cache: 'no-store',
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${await (session ??= openSession())}`,
        ...(binding ? { 'X-Verily-Flow': binding } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });

    if (!response.ok) throw new Error('Verily request unavailable');

    const answer: unknown = await response.json();
    const bound = response.headers.get('X-Verily-Flow');

    // Only starting a flow sets a binding, and the answer names the flow it is for.
    if (bound && record(answer) && typeof answer.id === 'string') bindings.set(answer.id, bound);

    return answer;
  }

  async function request(path: string, data?: Record<string, string>): Promise<unknown> {
    const response = await fetch(`${root}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(data
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }
        : {}),
    });

    if (!response.ok) throw new Error('Verily request unavailable');

    return response.json();
  }

  /** The connect flow as the dialog drives it, every answer checked before it is drawn. */
  const flows: ConnectApi = {
    async methods() {
      const data = await ask('/methods');

      if (!record(data) || !record(data.local) || !Array.isArray(data.methods))
        throw new Error('Invalid methods response');

      if (typeof data.local.profileUrl === 'string') safeUrl(data.local.profileUrl);

      return data as unknown as Methods;
    },
    start: async (provider, method, renew) =>
      flowView(
        await ask(
          '/sessions',
          renew
            ? { kind: 'renew', connectionId: renew, provider, method }
            : { kind: 'connect', provider, method },
        ),
      ),
    read: async (id) =>
      flowView(await ask(`/flows/${encodeURIComponent(id)}?format=json`, undefined, id)),
    submit: async (id, artifact) =>
      flowView(await ask(`/flows/${encodeURIComponent(id)}/submit`, { artifact }, id)),
    async approve(id, visibility, cancel) {
      const data = await ask(
        `/flows/${encodeURIComponent(id)}/approve`,
        { action: cancel ? 'cancel' : 'approve', visibility },
        id,
      );

      if (!record(data)) throw new Error('Invalid approval response');

      return data.outcome === 'complete' && typeof data.connectionId === 'string'
        ? { outcome: 'complete', connectionId: data.connectionId }
        : { outcome: 'cancelled' };
    },
    /**
     * With the backend on another origin, the sign-in window opens on the backend first.
     * The page there asks for the flow's binding and keeps it as a cookie of its own
     * origin, which is where the provider's callback looks for it, and then goes on to the
     * provider. The binding is sent to the backend's origin alone.
     */
    ...(remote
      ? {
          enter(popup: Window, flow: FlowView) {
            const receive = (event: MessageEvent) => {
              if (
                event.source !== popup ||
                event.origin !== base.origin ||
                !record(event.data) ||
                event.data.type !== 'verily-enter'
              )
                return;

              window.removeEventListener('message', receive);

              popup.postMessage(
                {
                  type: 'verily-enter',
                  flow: flow.id,
                  binding: bindings.get(flow.id),
                  url: flow.authorizationUrl,
                },
                base.origin,
              );
            };

            window.addEventListener('message', receive);
            popup.location.href = `${root}/site/enter`;
          },
        }
      : {}),
  };

  const client = {
    /**
     * Opens the connect dialog over the current page. Resolves when it closes, with how
     * the last attempt in it ended. Call from a click: a sign-in method opens a window.
     */
    openConnect(
      opener: HTMLElement = document.body,
      back?: () => void,
      provider?: string,
      /** A record of the holder's to renew, in place of connecting: see `openConnectDialog`. */
      renew?: { id: string; method?: string },
    ): Promise<Result> {
      if (remote && !handoffUrl)
        throw new Error('A backend on another origin requires a handoff URL');

      // Each opening is vouched for afresh, for whoever is signed in to this site now.
      session = undefined;

      return openConnectDialog(opener, flows, back, provider, renew);
    },
    /**
     * Draws the pill that opens the connect dialog. The host receives a `verily-result`
     * event, whose detail is the Result, whenever the dialog closes on a new connection.
     */
    mountConnect(element: HTMLElement) {
      const pill = renderConnectPill(element);

      pill.setAttribute('aria-haspopup', 'dialog');

      pill.onclick = async () => {
        if (typeof HTMLDialogElement === 'undefined' && !remote) {
          location.href = `${root}/verify`;

          return;
        }

        const result = await client.openConnect(element);

        if (result.outcome === 'complete')
          element.dispatchEvent(
            new CustomEvent('verily-result', { detail: result, bubbles: true, composed: true }),
          );
      };
    },
    async connect({ provider }: { provider: string }): Promise<Result> {
      if (base.origin !== location.origin)
        throw new Error('Management requires a same-origin backend');

      const popup = window.open('about:blank', '_blank', 'popup,width=600,height=750');

      if (!popup) throw new Error('Allow popups to verify');

      try {
        const data = await request('/connect', { provider });

        if (
          !record(data) ||
          typeof data.url !== 'string' ||
          new URL(data.url).origin !== base.origin
        )
          throw new Error('Invalid flow URL');

        return await new Promise<Result>((resolve) => {
          const finish = (result: Result) => {
            clearInterval(timer);
            clearTimeout(timeout);
            window.removeEventListener('message', receive);
            popup.close();
            resolve(result);
          };

          const receive = (event: MessageEvent) => {
            if (
              event.origin !== base.origin ||
              event.source !== popup ||
              !record(event.data) ||
              event.data.type !== 'verily-result'
            )
              return;

            const value = event.data;

            if (value.outcome === 'complete' && typeof value.connectionId === 'string')
              finish({ outcome: 'complete', connectionId: value.connectionId });
            else finish({ outcome: value.outcome === 'cancelled' ? 'cancelled' : 'failed' });
          };

          const timer = setInterval(() => {
            if (popup.closed) finish({ outcome: 'cancelled' });
          }, 500);

          const timeout = setTimeout(() => finish({ outcome: 'failed' }), 11 * 60000);

          window.addEventListener('message', receive);
          popup.location.href = data.url as string;
        });
      } catch (error) {
        popup.close();

        throw error;
      }
    },
    /** The site's current public connections, so an embed need not hardcode ids. */
    async listPublished(): Promise<Evidence[]> {
      const data = await request('/published');

      if (!Array.isArray(data) || !data.every(validEvidence))
        throw new Error('Invalid evidence response');

      return data;
    },
    async getConnection(id: string): Promise<Evidence> {
      const data = await request(`/connections/${encodeURIComponent(id)}?format=json`);

      if (!validEvidence(data)) throw new Error('Invalid evidence response');

      return data;
    },
    async mountBadge(
      element: HTMLElement,
      { connectionId, evidence }: { connectionId: string; evidence?: Evidence },
    ) {
      // Evidence already in hand renders at once. Otherwise a host with nothing to show
      // gets the waiting pill, whose frame and mark the finished badge keeps; a host that
      // already shows a badge keeps it up until the check answers, so a periodic refresh
      // never blinks the pill through an interim state.
      if (!evidence && !badgeShown(element)) renderBadgePending(element);

      const current = begin(element);

      try {
        const e = evidence ?? (await client.getConnection(connectionId));

        if (!current()) return;

        if (!validEvidence(e)) throw new Error('Invalid evidence response');

        if (e.visibility !== 'public') throw new Error('Unavailable');

        // Validate both links before rendering any provider details.
        externalUrl(e.external);
        safeUrl(e.evidenceUrl);
        // What the dialog draws has one more link in it than the pill, so it opens on the
        // record only if that one is good too, and otherwise on what it reads.
        latestGroup.set(element, readable(e) ? [e] : []);

        loaders.set(element, async () => {
          const fresh = await client.getConnection(e.id);

          if (fresh.visibility !== 'public' || !readable(fresh)) throw new Error('Unavailable');

          return [fresh];
        });

        const draw = () => {
          const badge = renderBadge(element, standing(e));

          // Null means the pill on screen is unchanged. Its handler stands, and reads the above.
          if (badge) opens(element, badge);
        };

        draw();

        // Drawn again from the signed record once it checks, and as unverified if it fails.
        watchSigned([e], () => {
          if (current()) draw();
        });
      } catch {
        if (current()) withdraw(element);
      }
    },
    /**
     * Several of one subject's public connections as a single pill. One that cannot be
     * read is left out, since the rest are still true without it; with none left, or with
     * records of more than one subject, the pill says it is unavailable.
     */
    async mountBadges(
      element: HTMLElement,
      { connectionIds, ...arrangement }: { connectionIds: string[] } & Arrangement,
    ) {
      const ids = [...new Set(connectionIds)];

      arrange(element, arrangement);

      if (ids.length === 1) return client.mountBadge(element, { connectionId: ids[0]! });

      if (!badgeShown(element)) renderBadgePending(element);

      const read = async () => {
        const answers = await Promise.allSettled(ids.map((id) => client.getConnection(id)));

        const records = oneSubject(
          answers
            .filter((a): a is PromiseFulfilledResult<Evidence> => a.status === 'fulfilled')
            .map((a) => a.value)
            .filter((e) => e.visibility === 'public'),
        );

        if (!records) throw new Error('Unavailable');

        return records;
      };

      const current = begin(element);

      try {
        const records = await read();

        if (current()) presentGroup(element, records, read);
      } catch {
        if (current()) withdraw(element);
      }
    },
    disconnect(id: string) {
      // On another origin this is vouched for afresh, as each opening of the dialog is.
      if (remote) session = undefined;

      return ask(`/connections/${encodeURIComponent(id)}/disconnect`, {});
    },
    /**
     * Says how the holder would have an account listed, or retires it. Names one record
     * and acts on the account: every record of it the holder has.
     */
    mark(id: string, as: Listing) {
      if (remote) session = undefined;

      return ask(`/connections/${encodeURIComponent(id)}/mark`, { as });
    },
    issueShare: (id: string) => request(`/connections/${encodeURIComponent(id)}/share`, {}),
    revokeShare: (id: string) => request(`/connections/${encodeURIComponent(id)}/share-revoke`, {}),
  };

  return client;
}

// What a signed record says is drawn in a record's place, so it is held to the same rules.
drawSignedWith((value): value is Evidence => validEvidence(value) && readable(value) !== undefined);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * The record as the dialog would draw it, or nothing if any link in it may not be
 * rendered. The pill checks the two links it shows itself; the dialog shows one more.
 */
function readable(evidence: Evidence): Evidence | undefined {
  try {
    safeUrl(evidence.evidenceUrl);
    externalUrl(evidence.external);

    if (evidence.local.profileUrl) safeUrl(evidence.local.profileUrl);

    if (evidence.signedUrl) safeUrl(evidence.signedUrl);

    return evidence;
  } catch {
    return undefined;
  }
}

/** A flow step, refused unless every address in it may be followed or drawn as a link. */
function flowView(value: unknown): FlowView {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.phase !== 'string' ||
    !record(value.provider)
  )
    throw new Error('Invalid flow response');

  if (value.authorizationUrl !== undefined) safeUrl(String(value.authorizationUrl));

  if (value.phase === 'approval') {
    if (!record(value.local) || !record(value.external)) throw new Error('Invalid flow response');

    externalUrl(value.external);

    if (value.local.profileUrl !== undefined) safeUrl(String(value.local.profileUrl));

    if (value.signedNote !== undefined && typeof value.signedNote !== 'string')
      throw new Error('Invalid flow response');
  }

  return value as unknown as FlowView;
}

/**
 * An external subject's address, refused unless it may be drawn. A mailbox has no page and
 * is never linked, so its address need only be the `mailto:` it says it is.
 */
function externalUrl(external: { kind?: unknown; profileUrl?: unknown }) {
  const address = String(external.profileUrl);

  if (external.kind !== 'mailbox') return safeUrl(address);

  if (new URL(address).protocol !== 'mailto:') throw new Error('Invalid URL');

  return address;
}

function safeUrl(value: string) {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid URL');

  return url.href;
}

/**
 * Both sides must be described, because a half-filled record would let a renderer imply a
 * method for a side that never reported one.
 */
function validAttestations(value: unknown): boolean {
  if (!record(value)) return false;

  return (
    validAttestation(value.local) &&
    Array.isArray(value.external) &&
    value.external.length > 0 &&
    value.external.every(validAttestation)
  );
}

function validAttestation(attestation: unknown): boolean {
  if (!record(attestation)) return false;

  return (
    ['backend', 'provider'].includes(String(attestation.by)) &&
    typeof attestation.method === 'string' &&
    typeof attestation.confirmedAt === 'number' &&
    Number.isFinite(attestation.confirmedAt) &&
    (attestation.expect === undefined || typeof attestation.expect === 'string') &&
    (attestation.dnssec === undefined || typeof attestation.dnssec === 'boolean') &&
    // Rendered as a link later, so only http(s) may ever reach an href.
    (attestation.artifactUrl === undefined || httpUrl(attestation.artifactUrl))
  );
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validEvidence(value: unknown): value is Evidence {
  if (!record(value) || !record(value.local) || !record(value.external)) return false;

  return (
    ['id', 'provider', 'providerName', 'siteName', 'verifierName', 'evidenceUrl'].every(
      (k) => typeof value[k] === 'string',
    ) &&
    ['label', 'reference'].every(
      (k) => typeof (value.local as Record<string, unknown>)[k] === 'string',
    ) &&
    ['id', 'handle', 'profileUrl'].every(
      (k) => typeof (value.external as Record<string, unknown>)[k] === 'string',
    ) &&
    (value.local.profileUrl === undefined || typeof value.local.profileUrl === 'string') &&
    // A signed record lives beside the record it was made from and nowhere else, since the
    // keys it is checked against are read from where the record lives.
    (value.signedUrl === undefined || value.signedUrl === `${value.evidenceUrl}?format=signed`) &&
    validAttestations(value.attestations) &&
    (value.local.kind === undefined || typeof value.local.kind === 'string') &&
    (value.external.kind === undefined ||
      ['account', 'key', 'page', 'mailbox', 'domain'].includes(String(value.external.kind))) &&
    (value.revokedAt === undefined ||
      (typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt))) &&
    ['verified', 'unconfirmed', 'expired', 'retired', 'revoked'].includes(String(value.status)) &&
    // A retired record stands on its dates, so one that does not say when is not one.
    (value.status === 'retired'
      ? typeof value.retiredAt === 'number' && Number.isFinite(value.retiredAt)
      : value.retiredAt === undefined) &&
    (value.mark === undefined || ['preferred', 'unused'].includes(String(value.mark))) &&
    ['public', 'unlisted'].includes(String(value.visibility)) &&
    (value.connectedAt === undefined ||
      (typeof value.connectedAt === 'number' && Number.isFinite(value.connectedAt))) &&
    ['authenticatedAt', 'approvedAt', 'expiresAt'].every(
      (k) => typeof value[k] === 'number' && Number.isFinite(value[k]),
    )
  );
}

if (typeof customElements !== 'undefined' && !customElements.get('verily-connect')) {
  /**
   * The pill a signed-in holder clicks to connect an account, in a dialog over the page.
   * A site registered with an instance on another origin names it in `backend-url` and
   * adds `handoff-url`, its own endpoint that vouches for its signed-in user.
   */
  customElements.define(
    'verily-connect',
    class extends HTMLElement {
      static observedAttributes = ['backend-url', 'handoff-url'];

      connectedCallback() {
        this.present();
      }

      attributeChangedCallback() {
        if (this.isConnected) this.present();
      }

      private present() {
        const backendUrl = this.getAttribute('backend-url');

        if (backendUrl)
          init({
            backendUrl,
            handoffUrl: this.getAttribute('handoff-url') ?? undefined,
          }).mountConnect(this);
      }
    },
  );
}

if (typeof customElements !== 'undefined' && !customElements.get('verily-badge')) {
  customElements.define(
    'verily-badge',
    class extends HTMLElement {
      /**
       * Evidence an embed already fetched, handed over before the badge is presented so
       * its first paint is the finished pill rather than a placeholder replaced a round
       * trip later. It seeds one paint only; every later refresh is fetched.
       *
       * Declared only: a field of the class would be set afresh when the element is
       * upgraded, wiping evidence a page assigned before this script had run.
       */
      declare evidence?: Evidence;

      /**
       * A badge may be placed before its connection is known: it then waits, showing the
       * pill's own frame, until `connection-id` names what it presents.
       */
      static observedAttributes = [
        'backend-url',
        'connection-id',
        'connection-ids',
        'connections',
        'handoff-url',
        'connect',
        'stacked',
        'peek',
      ];

      private handed?: unknown;

      /**
       * Records the page already holds, drawn as given and never fetched: one subject's
       * accounts, as the site's own backend read them. Also settable as JSON in the
       * `connections` attribute, for a page rendered on the server.
       */
      get connections(): unknown {
        return this.handed;
      }

      set connections(records: unknown) {
        this.handed = records;
        this.present();
      }

      private timer?: ReturnType<typeof setInterval>;
      private queued = false;

      connectedCallback() {
        // A page may set `connections` before this script has run. That lands on the
        // element itself and hides the setter above from then on, so it is taken off and
        // given to the setter, as it would have been had the script come first.
        if (Object.hasOwn(this, 'connections')) {
          const early = (this as { connections?: unknown }).connections;

          delete (this as { connections?: unknown }).connections;
          this.handed = early;
        }

        this.present();
        this.timer = setInterval(() => this.refresh(), 30000);
      }

      disconnectedCallback() {
        clearInterval(this.timer);
        quietBadge(this);
      }

      attributeChangedCallback() {
        this.present();
      }

      /**
       * Deferred by a microtask, so an embed that sets the backend, the connection and the
       * evidence one after another is drawn once, from all three, before anything paints.
       */
      private present() {
        if (this.queued) return;

        this.queued = true;

        queueMicrotask(() => {
          this.queued = false;

          if (!this.isConnected) return;

          const seed = this.evidence;

          this.evidence = undefined;
          this.refresh(validEvidence(seed) && seed.visibility === 'public' ? seed : undefined);
        });
      }

      private refresh(evidence?: Evidence) {
        const backendUrl = this.getAttribute('backend-url'),
          connectionId = this.getAttribute('connection-id');

        const written = this.getAttribute('connections');
        const handoffUrl = this.getAttribute('handoff-url');

        const arrangement = {
          stacked: this.getAttribute('stacked') !== null,
          peek: this.getAttribute('peek') !== 'off',
        };

        // The holder's own badge, where the page says so: its dialog connects another
        // account, renews one and removes one, through the backend named. The host hears
        // of each change in a `verily-result` event, to read its records again.
        if (backendUrl && (handoffUrl !== null || this.getAttribute('connect') !== null)) {
          const client = init({ backendUrl, handoffUrl: handoffUrl ?? undefined });

          const changed = (detail: object) =>
            this.dispatchEvent(
              new CustomEvent('verily-result', { detail, bubbles: true, composed: true }),
            );

          managers.set(this, {
            connect: (provider) => {
              void client
                .openConnect(this, () => details(this), provider)
                .then((result) => {
                  if (result.outcome === 'complete') changed(result);
                });
            },
            renew: (id, provider, method) => {
              void client
                .openConnect(this, () => details(this), provider, { id, method })
                .then((result) => {
                  if (result.outcome === 'complete') changed(result);
                });
            },
            // One at a time, each told as it goes: if a later one fails, the host still
            // hears of those that went and reads its records again.
            remove: async (ids) => {
              for (const id of ids) {
                await client.disconnect(id);
                changed({ outcome: 'removed', connectionId: id });
              }
            },
            mark: async (id, as) => {
              await client.mark(id, as);
              changed({ outcome: 'marked', connectionId: id, as });
            },
          });
        } else managers.delete(this);

        if (this.handed !== undefined || written !== null) {
          let records = this.handed;

          if (records === undefined)
            try {
              records = JSON.parse(written!);
            } catch {
              records = undefined;
            }

          presentConnections(this, records, arrangement);

          return;
        }

        const ids = (this.getAttribute('connection-ids') ?? '').split(/\s+/).filter(Boolean);

        if (ids.length) {
          if (backendUrl)
            void init({ backendUrl }).mountBadges(this, { connectionIds: ids, ...arrangement });

          return;
        }

        if (!connectionId) {
          // Nothing is named any more, so nothing it named before is to be shown either.
          forget(this);
          renderBadgePending(this);

          return;
        }

        if (backendUrl) void init({ backendUrl }).mountBadge(this, { connectionId, evidence });
      }
    },
  );
}
