import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  attestationLabel,
  externalLink,
  externalName,
  isArtifactProvider,
  isCodeProvider,
  isRedirectProvider,
  localSide,
  proofTitle,
  providerMethod,
  statusLabel,
  type Attestation,
  type ArtifactProvider,
  type Attestations,
  type CodeProvider,
  type Evidence,
  type Flow,
  type FlowResult,
  type Inline,
  type Instruction,
  type LocalAccount,
  type Provider,
  type SignedDocument,
  type SignedEvidence,
  type Visibility,
} from '../core/index.js';
import { codeAttempts, VerityService, Unavailable, type ServiceOptions } from './service.js';
import { copyScript } from './copy.js';
import { escape } from './escape.js';
import { logo } from '../logo.js';
import { stylesheet, styleVersion } from './style.js';

export { VerityService, Unavailable } from './service.js';

export { githubProvider } from './github.js';

export { discordProvider } from './discord.js';

export { youtubeProvider } from './youtube.js';

export { githubGistProvider } from './github-gist.js';

export { linkProvider, githubLinkProvider, type LinkProviderOptions } from './link.js';

export { pgpProvider } from './pgp.js';

export {
  emailProvider,
  type EmailImage,
  type EmailMessage,
  type EmailProviderOptions,
} from './email.js';

export { resendSender } from './resend.js';

export type { ServiceOptions } from './service.js';

export interface ServerOptions extends ServiceOptions {
  /** Resolve identity exclusively from the adopting application's authenticated session. */
  authenticate(request: Request): Promise<LocalAccount | undefined>;
  reportUrl: string;
  /**
   * What to store on a flow when it is created, read from the request that creates it, and
   * handed back to `finish`. Never called for removal from the external side, whatever the
   * browser is signed into, since nothing local answers for that.
   */
  context?(request: Request): Promise<Record<string, string> | undefined>;
  /**
   * Where to send the holder once a flow has ended, each time its result page is served. It
   * must depend on nothing but what it is given, so a page loaded again after a failure or
   * a lost response sends the holder to the same place. Undefined shows the result page.
   */
  finish?(ended: Ended): Promise<string | undefined>;
  /**
   * Origins a form here may end up at, beyond this one and the sign-in providers': anywhere
   * `finish` sends a holder, since an approval form's redirect is held to `form-action`.
   */
  formTargets?: string[];
  /**
   * The provider ids a subject may use, where not every subject gets every one: an
   * instance serving several sites offers each site's subjects what that site chose.
   * Undefined means all of them. Removal from the external side is never narrowed.
   */
  providersFor?(local: LocalAccount): string[] | undefined;
  /**
   * The visibilities a subject may choose, where a site does not offer both. Undefined
   * means both. With one, the approval page states it and offers no choice, and there is
   * nothing for a visibility flow to change. A record made before the choice was narrowed
   * keeps the visibility it has.
   */
  visibilityFor?(local: LocalAccount): Visibility[] | undefined;
}

/** A flow that has ended, as `finish` is given it: all of it read from the stored flow. */
export interface Ended {
  /** The flow's id, which names it and is no secret. */
  id: string;
  context?: Record<string, string>;
  local?: LocalAccount;
  result: FlowResult;
}

/**
 * The largest request body any route accepts. A form field is a few hundred bytes, but a
 * pasted OpenPGP key carries every certification it has ever collected and a long-lived
 * one runs to tens of kilobytes. Still small enough that the size itself costs nothing.
 */
const maxBodyBytes = 65536;

const page = (prefix: string, title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Verity</title><link rel="stylesheet" href="${escape(prefix)}/style.css?v=${styleVersion}"><body><main>${logo}<h1>${escape(title)}</h1>${body}</main></body></html>`;

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });

const json = (data: unknown, cookie?: string) =>
  new Response(JSON.stringify(data), {
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  });

/**
 * A proof this backend publishes, served as the text it is so a reader can put it straight
 * into their own tools. Never rendered and never interpreted: it is somebody else's bytes.
 */
const plain = (body: string) =>
  new Response(body, {
    headers: {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'inline',
      'Access-Control-Allow-Origin': '*',
    },
  });

const redirect = (url: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { ...headers, Location: url, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });

/**
 * One side of a link, with each thing known about it on its own line. A name, the
 * identifier behind it and how it was shown are three separate claims, and a reader
 * running them together in one sentence is the way to misread which was established.
 *
 * Both sides render as the same card, so the pair reads as a pair.
 */
function card(
  heading: string,
  name: string,
  url: string | undefined,
  reference?: string,
  ...extra: string[]
) {
  const profile = url && safeUrl(url);

  return `<div class="side"><p class="who">${escape(heading)}</p><p class="name">${
    profile ? `<a href="${escape(profile)}" rel="noreferrer">${escape(name)}</a>` : escape(name)
  }</p>${reference ? `<p class="reference">${escape(reference)}</p>` : ''}${extra.join('')}</div>`;
}

/**
 * Names how one side was established, inside that side's card. Where the method published
 * a proof the name is the link to it, which is what lets the reader check the claim
 * without taking this backend's word for it, and keeps several proofs apart. Methods are
 * named, never ranked.
 */
function attestationNote(
  attestation: Attestation,
  names: { site: string; provider: string },
  additional = false,
) {
  const label = attestationLabel(attestation.method, names);

  if (!label) return '';

  // Set by a provider implementation from holder-supplied input, so it reaches an href
  // only after being confirmed http(s).
  const artifact = attestation.artifactUrl && safeUrl(attestation.artifactUrl);

  const how = `how${additional ? ' additional' : ''}`;

  return `<p class="${how}">${additional ? '+ ' : ''}${
    artifact
      ? `<a href="${escape(artifact)}" rel="noreferrer" title="${escape(proofTitle(attestation, moment))}">${escape(label)}</a>`
      : escape(label)
  }</p>`;
}

/** The external side's methods: the one it was first shown by, then each one since. */
function externalNotes(attestations: Attestations, names: { site: string; provider: string }) {
  const [main, ...rest] = attestations.external;

  return attestationNote(main, names) + rest.map((a) => attestationNote(a, names, true)).join('');
}

/**
 * What a holder does to use one method, for a page offering several. A single method needs
 * no such wording: continuing with the provider is all there is to choose.
 */
function methodAction(provider: Provider): string {
  const actions: Record<string, string> = {
    oauth: `Sign in with ${provider.name}`,
    gist: `Publish a proof on ${provider.name}`,
    backlink: `Link back from ${provider.name}`,
    signature: `Sign with ${provider.name}`,
    code: `Confirm by ${provider.name.toLowerCase()}`,
  };

  return actions[providerMethod(provider)] ?? `Continue with ${provider.name}`;
}

/** What the holder hands back for an artifact method, named for what it is. */
function artifactField(provider: ArtifactProvider): string {
  if (provider.artifact === 'document') return 'Your proof';

  return provider.method === 'backlink'
    ? 'Address of the page carrying your link'
    : 'Address of your published proof';
}

/** Said beside every artifact method: what the holder publishes is public by design. */
function artifactNote(provider: ArtifactProvider): string {
  return provider.method === 'backlink'
    ? 'This link is public, as is the page you point at. Anyone reading either one can follow it here.'
    : 'This line is public, as is whatever published it. Publish nothing else alongside it.';
}

/**
 * Where a mailed code stands, for whichever renderer asks the holder for the next thing:
 * the address to send to, or the code once it has gone. The code and its hash stay behind.
 */
function codeStep(provider: CodeProvider, flow: Flow) {
  return {
    field: provider.field,
    input: provider.input,
    ...(flow.sent
      ? {
          sentTo: flow.sent.account.handle,
          wrong: flow.sent.attempts > 0,
          triesLeft: codeAttempts - flow.sent.attempts,
        }
      : {}),
  };
}

/** Said before the message is sent: the address becomes the name the connection shows. */
const codeNote =
  "We'll email this address to confirm it's yours. The address is shown on the connection, to whoever you let see it.";

/** Names the providers on offer once each, however many ways each can be shown. */
function providerNames(providers: Provider[]): string {
  return [...new Set(providers.map((p) => p.name))].join(' or ');
}

/** Seconds are the finest thing a record measured in days can mean; milliseconds are noise. */
const moment = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every time on the page in one list. A date inside a sentence is a date a reader has to
 * find; the times of a record belong together, where they can be compared at a glance.
 */
function times(rows: [string, number | undefined][]) {
  return `<dl>${rows
    .filter(([, time]) => time !== undefined)
    .map(([label, time]) => `<dt>${escape(label)}</dt><dd>${escape(moment(time!))}</dd>`)
    .join('')}</dl>`;
}

/**
 * What the holder is told, as the provider wrote it. A command is set as a block and never
 * reflowed: it is copied character for character, and one wrapped line is a broken command.
 */
function instructions(parts: Instruction[]) {
  return parts
    .map((part) =>
      typeof part === 'string'
        ? `<p>${escape(part)}</p>`
        : Array.isArray(part)
          ? `<p>${part.map(inline).join('')}</p>`
          : `<pre><code>${escape(part.code)}</code></pre>`,
    )
    .join('');
}

/** A piece of a paragraph. A link that is not http(s) is written as its text alone. */
function inline(piece: Inline) {
  if (typeof piece === 'string') return escape(piece);

  const href = safeUrl(piece.href);

  return href
    ? `<a href="${escape(href)}" rel="noreferrer" target="_blank">${escape(piece.text)}</a>`
    : escape(piece.text);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);

    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The holder's choice of who may read the record, or the one visibility there is when the
 * subject has no choice. A subject from another site is told what each means there: that
 * site can read an unlisted link and decides who on it sees the link, and nobody else can
 * read it at all, while a public one is readable by anyone anywhere.
 */
/**
 * Said wherever a holder makes a record public on an instance that signs: removing the
 * link stops new signed records, and does nothing to one already saved.
 */
const signedNote =
  'Anyone can save a signed record, which still shows this link was made after you remove it';

function visibilityChoice(local: LocalAccount, allowed: Visibility[], signed: boolean) {
  const unlisted = local.siteName
    ? `Only ${local.siteName} can read this link, and it chooses who there sees it. Nobody else can.`
    : 'Anyone with a sharing link can view and forward it. No link is created until you choose to share.';

  const shown =
    (local.siteName
      ? `Public: anyone can view both sides of this link, on ${local.siteName} or anywhere else`
      : 'Public: anyone can view both sides of this link') + (signed ? `. ${signedNote}` : '');

  if (allowed.length === 1)
    return `<input type="hidden" name="visibility" value="${allowed[0]}"><p class="fine">${escape(allowed[0] === 'unlisted' ? `Unlisted. ${unlisted}` : `${shown}.`)}</p>`;

  return `<fieldset><legend>Evidence visibility</legend><label><input type="radio" name="visibility" value="unlisted" checked>Unlisted</label><p>${escape(unlisted)}</p><label><input type="radio" name="visibility" value="public">${escape(shown)}</label></fieldset>`;
}

/**
 * A link's local side is one of the site's accounts, a page, or the site itself.
 * An absent kind means the site did not say, so nothing is asserted about it.
 */
function subjectNoun(kind: string | undefined): string | undefined {
  return { account: 'account', page: 'page', site: 'website' }[kind ?? ''];
}

function evidencePage(
  e: Evidence & { linkExpiresAt?: number },
  base: string,
  report: string,
  keyId?: string,
) {
  const names = { site: e.siteName, provider: e.providerName };

  const local = localSide(e.local, e.siteName);
  const current = e.status !== 'revoked' && e.expiresAt > Date.now();

  return page(
    base,
    `${statusLabel(e, Date.now())} connection`,
    // The heading already names the site and the card already names the subject, so the
    // site's own reference would be a third line saying the same thing. The provider's
    // identifier stays: that one is the provider's word, not the site's own wording.
    card(
      local.heading,
      local.value,
      e.local.profileUrl,
      undefined,
      attestationNote(e.attestations.local, names),
    ) +
      card(
        names.provider,
        externalName(e.external),
        externalLink(e.external),
        // A mailbox's address is its name already, so there is no second identifier.
        e.external.kind === 'mailbox' ? undefined : e.external.id,
        externalNotes(e.attestations, names),
      ) +
      times([
        ['Approved', e.approvedAt],
        ['Authenticated', e.authenticatedAt],
        [current ? 'Valid until' : 'Expired on', e.status === 'revoked' ? undefined : e.expiresAt],
        ['Revoked on', e.revokedAt],
        // Only a method that publishes an artifact drifts; a sign-in does not go stale.
        [
          'Last checked',
          e.attestations.external[0].artifactUrl
            ? e.attestations.external[0].confirmedAt
            : undefined,
        ],
        ['Sharing link expires', e.linkExpiresAt],
      ]) +
      `${e.linkExpiresAt ? '<p class="fine">Anyone with this link can view and forward it.</p>' : ''}
    ${e.signedUrl ? `<p class="signed" id="signed"><strong>Signed by ${escape(e.verifierName)}</strong>${keyId ? ` with key ${escape(keyId)}` : ''}. <a href="${escape(safeUrl(e.signedUrl))}">Download the signed record</a>, which <a href="${escape(base)}/check">can be checked</a> without this page.</p>` : ''}
    <p class="fine">This connection does not establish legal identity, trustworthiness, content authorship, or permanent ownership.</p>
    <p class="fine"><a href="${escape(base)}/external-revoke/${escape(e.id)}">Remove this connection using your external account</a></p>
    ${e.visibility === 'unlisted' ? `<p class="fine"><a href="${escape(base)}/external-share-revoke/${escape(e.id)}">Revoke only this sharing link using your external account</a></p>` : ''}
    <p class="fine"><a href="${escape(report)}" rel="noreferrer">Report an incorrect record</a></p>`,
  );
}

const checkForm =
  '<form method="post"><label>Signed record <textarea name="record" rows="8" cols="72" required></textarea></label><button>Check</button></form>';

/**
 * What a signed record says, once its signature has been checked against this verifier's
 * keys. It is a record of the past: the page says when, and sends the reader to the live
 * record for whether it still stands.
 */
function checkedPage(d: SignedDocument, keyId: string, base: string) {
  const names = { site: d.siteName, provider: d.providerName };
  const local = localSide(d.local, d.siteName);

  return page(
    base,
    'Signed record',
    `<p>${escape(d.verifierName)} signed this record. It shows what stood when it was signed, not what stands now.</p>` +
      card(
        local.heading,
        local.value,
        d.local.profileUrl,
        undefined,
        attestationNote(d.attestations.local, names),
      ) +
      card(
        names.provider,
        externalName(d.external),
        externalLink(d.external),
        d.external.kind === 'mailbox' ? undefined : d.external.id,
        externalNotes(d.attestations, names),
      ) +
      times([
        ['Signed', d.issuedAt],
        ['Approved', d.approvedAt],
        ['Valid until', d.expiresAt],
      ]) +
      `<p class="fine">Signing key ${escape(keyId)}.</p>
    <p class="fine"><a href="${escape(safeUrl(d.evidenceUrl))}">See whether this connection still stands</a></p>`,
  );
}

export function createVerity(options: ServerOptions) {
  const service = new VerityService(options);
  const signs = options.signingKey !== undefined;

  const base = new URL(service.baseUrl),
    prefix = base.pathname.replace(/\/$/, '');

  if (!['https:', 'http:', 'mailto:'].includes(new URL(options.reportUrl).protocol))
    throw new Error('Invalid report URL');

  for (const target of options.formTargets ?? []) {
    const url = new URL(target);

    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== target)
      throw new Error('A form target must be an origin');
  }

  const cookieName = `verity_flow_${Buffer.from(prefix).toString('hex')}`;

  function binding(request: Request) {
    return (
      request.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? ''
    );
  }

  async function local(request: Request) {
    const user = await options.authenticate(request);

    if (!user) throw new Unavailable();

    return service.validateLocal(user);
  }

  async function body(request: Request): Promise<Record<string, string>> {
    const text = await request.text();

    if (text.length > maxBodyBytes) throw new Unavailable();

    if (request.headers.get('content-type')?.startsWith('application/json')) {
      const value: unknown = JSON.parse(text);

      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== 'string')
      )
        throw new Unavailable();

      return value as Record<string, string>;
    }

    return Object.fromEntries(new URLSearchParams(text));
  }

  /**
   * The configured methods a subject may use. Where a list was chosen for it, they come in
   * that list's order, since the first is what a flow runs when nothing is asked for. A
   * provider shown several ways keeps its methods together, in the order configured, and
   * an id this instance does not configure is passed over.
   */
  function permitted(user: LocalAccount): Provider[] {
    const ids = options.providersFor?.(user);

    return ids
      ? [...new Set(ids)].flatMap((id) => service.providers.filter((p) => p.id === id))
      : service.providers;
  }

  /** The visibilities a subject may choose: both, unless fewer were chosen for it. */
  function visibilities(user: LocalAccount): Visibility[] {
    const chosen = options.visibilityFor?.(user);

    return chosen
      ? (['unlisted', 'public'] as const).filter((v) => chosen.includes(v))
      : ['unlisted', 'public'];
  }

  /**
   * The method a new flow runs, held to what its subject may use. Asking for nothing means
   * the first one permitted, not the first one configured, and a flow on an existing record
   * must be on a record whose provider the subject may still use.
   */
  async function choose(
    user: LocalAccount | undefined,
    connectionId: string | undefined,
    choice: { provider?: string; method?: string },
  ) {
    // Nobody local started it, so there is nobody whose choices could narrow it.
    if (!user) return choice;

    const offered = permitted(user);

    if (offered === service.providers) return choice;

    if (connectionId) {
      const held = (await service.read(connectionId, user)).provider;

      if (!offered.some((p) => p.id === held)) throw new Unavailable();

      if (choice.provider === undefined && choice.method === undefined) return choice;
    }

    const found = offered.find(
      (p) =>
        (choice.provider === undefined || p.id === choice.provider) &&
        (choice.method === undefined || providerMethod(p) === choice.method),
    );

    if (!found) throw new Unavailable();

    return { provider: found.id, method: providerMethod(found) };
  }

  /**
   * The methods a page offers. A flow on an existing record stays in its namespace, so
   * where the holder is signed in that record narrows the list; removing a link from the
   * external side refuses a standing proof, which anybody can hand back.
   */
  async function offer(
    kind: Flow['kind'],
    id: string,
    user: LocalAccount | undefined,
    requested: string | null,
  ): Promise<Provider[]> {
    let namespace = requested ?? undefined;

    if (user && id) namespace = (await service.read(id, user)).provider;

    const offered = (user ? permitted(user) : service.providers).filter(
      (p) =>
        (namespace === undefined || p.id === namespace) &&
        !(['revoke', 'share-revoke'].includes(kind) && isArtifactProvider(p) && p.expect),
    );

    if (!offered.length) throw new Unavailable();

    return offered;
  }

  /** A failure names its reason when the provider gave one meant for the holder. */
  function result(outcome: string, id = '', reason?: string) {
    return html(
      page(
        prefix,
        'Verification result',
        `<p>${escape(outcome)}</p>${reason ? `<p>${escape(reason)}.</p>` : ''}<div id="verity-result" data-outcome="${escape(outcome)}" data-id="${escape(id)}"></div><script src="${escape(prefix)}/result.js" defer></script><p>You can close this window and return to account settings.</p>`,
      ),
    );
  }

  /**
   * The page for a flow that has ended, or wherever `finish` sends the holder instead. Only
   * the stored flow is read, so every load of it gives the same answer.
   */
  async function ended(flow: Flow): Promise<Response> {
    if (options.finish && flow.result) {
      const next = await options.finish({
        id: flow.id,
        context: flow.context,
        local: flow.local,
        result: flow.result,
      });

      if (next !== undefined) {
        const url = safeUrl(next);

        if (!url) throw new Error('finish returned an invalid URL');

        return redirect(url);
      }
    }

    return result(flow.phase, flow.resultId, flow.reason);
  }

  /** What the adopting application attaches to a new flow. External removal gets nothing. */
  async function context(request: Request, kind: Flow['kind']) {
    return ['revoke', 'share-revoke'].includes(kind) ? undefined : options.context?.(request);
  }

  /**
   * A redirect provider sends the holder to its own site. An artifact provider keeps them
   * here, where the flow page tells them what to publish and takes the address back.
   */
  const entry = (flow: { flowId: string; authorizationUrl?: string }) =>
    flow.authorizationUrl ?? `${prefix}/flows/${flow.flowId}`;

  /** The binding cookie that ties a flow to the browser that started it. */
  const flowCookie = (binding: string) =>
    `${cookieName}=${binding}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}; Max-Age=${Math.ceil((options.flowTtlMs ?? 600000) / 1000)}${base.protocol === 'https:' ? '; Secure' : ''}`;

  /** The subject as the holder's own card shows it. The private id never leaves here. */
  const subject = (user: LocalAccount) => ({
    ...localSide(user, service.siteOf(user)),
    profileUrl: user.profileUrl,
  });

  /**
   * A connect flow as the in-page dialog draws it: the same steps the flow pages walk
   * through, as data, so the holder never has to leave the page they started on.
   */
  async function flowView(flow: Flow, authorizationUrl?: string) {
    const provider = service.providerOf(flow);

    const view: Record<string, unknown> = {
      id: flow.id,
      phase: flow.phase,
      provider: { id: provider.id, name: provider.name, method: providerMethod(provider) },
    };

    if (authorizationUrl) view.authorizationUrl = authorizationUrl;

    if (flow.phase === 'pending' && flow.expect && isArtifactProvider(provider))
      Object.assign(view, {
        instructions: provider.instructions(flow.expect),
        artifact: provider.artifact,
        field: artifactField(provider),
        note: artifactNote(provider),
      });

    if (flow.phase === 'pending' && isCodeProvider(provider))
      Object.assign(view, { code: codeStep(provider, flow), note: codeNote });

    if (flow.phase === 'approval') {
      const joined = await service.joining(flow);

      Object.assign(view, {
        local: subject(flow.local!),
        external: flow.external,
        ...(joined ? { joined: { visibility: joined.visibility } } : {}),
        visibilities: visibilities(flow.local!),
        ...(signs ? { signedNote } : {}),
      });
    }

    if (flow.phase === 'failed' && flow.reason) view.reason = flow.reason;

    if (flow.phase === 'complete') view.connectionId = flow.resultId;

    return view;
  }

  /** A flow the dialog may read: one this holder started, to connect an account. */
  async function ownFlow(request: Request, id: string) {
    const flow = await service.flow(id, binding(request));

    if (flow.kind !== 'connect' || (await local(request)).id !== flow.local?.id)
      throw new Unavailable();

    return flow;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.origin !== base.origin ||
      !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
    )
      return html(page(prefix, 'Unavailable', ''), 404);

    const path = url.pathname.slice(prefix.length);

    try {
      if (!['GET', 'POST'].includes(request.method)) throw new Unavailable();

      // Same-origin only. No CORS. Applies to every mutation, including approval forms.
      if (request.method === 'POST' && request.headers.get('origin') !== base.origin)
        throw new Unavailable();

      if (request.method === 'GET') {
        // The one thing these pages cache, and only because its address carries its
        // version. It holds no record of anybody, so it is the one response that may sit
        // in a shared cache.
        if (path === '/style.css')
          return new Response(stylesheet, {
            headers: {
              ...headers,
              'Cache-Control':
                url.searchParams.get('v') === styleVersion
                  ? 'public, max-age=31536000, immutable'
                  : 'no-store',
              'Content-Type': 'text/css; charset=utf-8',
            },
          });

        if (path === '/copy.js')
          return new Response(copyScript, {
            headers: { ...headers, 'Content-Type': 'text/javascript' },
          });

        if (path === '/result.js')
          return new Response(
            `const e=document.getElementById('verity-result');if(window.opener&&e){window.opener.postMessage({type:'verity-result',outcome:e.dataset.outcome,connectionId:e.dataset.id},location.origin);window.close()}`,
            { headers: { ...headers, 'Content-Type': 'text/javascript' } },
          );

        if (
          path === '/verify' ||
          path.startsWith('/external-revoke/') ||
          path.startsWith('/external-share-revoke/') ||
          path.startsWith('/visibility/') ||
          path.startsWith('/renew/')
        ) {
          const external =
            path.startsWith('/external-revoke/') || path.startsWith('/external-share-revoke/');

          const kind = external
            ? path.startsWith('/external-share-revoke/')
              ? 'share-revoke'
              : 'revoke'
            : path.startsWith('/visibility/')
              ? 'visibility'
              : path.startsWith('/renew/')
                ? 'renew'
                : 'connect';

          const user = external ? undefined : await local(request);
          const id = kind === 'connect' ? '' : path.split('/').at(-1)!;
          const offered = await offer(kind, id, user, url.searchParams.get('provider'));

          // With one visibility there is nothing for the holder to change it to.
          if (kind === 'visibility' && visibilities(user!).length < 2) throw new Unavailable();

          // One form per method. With one on offer the provider is all there is to name.
          const forms = offered
            .map(
              (p) =>
                `<form method="${kind === 'connect' ? 'get' : 'post'}" action="${escape(prefix)}/sessions"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="connectionId" value="${escape(id)}"><input type="hidden" name="provider" value="${escape(p.id)}"><input type="hidden" name="method" value="${escape(providerMethod(p))}"><button>${escape(offered.length > 1 ? methodAction(p) : `Continue with ${p.name}`)}</button></form>`,
            )
            .join('');

          return html(
            page(
              prefix,
              external
                ? 'Remove a connection'
                : kind === 'renew'
                  ? 'Renew this connection'
                  : `Verify with ${providerNames(offered)}`,
              `
            ${
              user
                ? card(subject(user).heading, subject(user).value, user.profileUrl)
                : '<p>Authenticate with the matching external account to review and remove this link.</p>'
            }
            <p>Confirm the connection between this ${escape(subjectNoun(user?.kind) ?? 'site')} and your ${escape(providerNames(offered))} account.</p>
            ${kind === 'renew' && offered.length > 1 ? '<p class="fine">Renewing another way adds that method beneath the one this connection was first shown by.</p>' : ''}
            ${forms}`,
            ),
          );
        }

        if (path === '/callback') {
          const state = url.searchParams.get('state');

          if (!state) throw new Unavailable();

          const id = await service.callback(
            state,
            binding(request),
            url.searchParams.has('error') ? undefined : (url.searchParams.get('code') ?? undefined),
          );

          return redirect(`${prefix}/flows/${id}`);
        }

        if (path === '/sessions' && url.searchParams.get('kind') === 'connect') {
          const user = await local(request);

          const flow = await service.start(
            user,
            undefined,
            'connect',
            await choose(user, undefined, {
              provider: url.searchParams.get('provider') ?? undefined,
              method: url.searchParams.get('method') ?? undefined,
            }),
            await context(request, 'connect'),
          );

          return redirect(entry(flow), flowCookie(flow.binding));
        }

        // What the in-page dialog offers: every method the signed-in holder may use.
        if (path === '/methods') {
          const user = await local(request);
          const offered = permitted(user);
          const several = offered.length > 1;

          return json({
            siteName: service.siteOf(user),
            verifierName: options.verifierName,
            local: subject(user),
            methods: offered.map((p) => ({
              provider: p.id,
              method: providerMethod(p),
              name: p.name,
              action: several ? methodAction(p) : `Continue with ${p.name}`,
            })),
          });
        }

        if (path.startsWith('/flows/') && url.searchParams.get('format') === 'json')
          return json(await flowView(await ownFlow(request, path.slice(7))));

        if (path.startsWith('/flows/')) {
          const flow = await service.flow(path.slice(7), binding(request));
          const provider = service.providerOf(flow);

          // Holder-paced: nothing has been proved yet, so the page says what to publish
          // and waits. The line is public by design, which is what makes it checkable.
          if (flow.phase === 'pending' && flow.expect && isArtifactProvider(provider)) {
            if (!['revoke', 'share-revoke'].includes(flow.kind))
              if ((await local(request)).id !== flow.local?.id) throw new Unavailable();

            return html(
              page(
                prefix,
                `Verify with ${provider.name}`,
                `${instructions(provider.instructions(flow.expect))}
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/submit">
            <label>${escape(artifactField(provider))} ${
              provider.artifact === 'document'
                ? '<textarea name="artifact" rows="14" cols="72" required></textarea>'
                : '<input name="artifact" type="url" required>'
            }</label>
            <button>Check my proof</button></form>
            <p class="fine">${escape(artifactNote(provider))}</p>
            <script src="${escape(prefix)}/copy.js" defer></script>`,
              ),
            );
          }

          // Holder-paced too, in two steps: where to send a code, then the code itself.
          if (flow.phase === 'pending' && isCodeProvider(provider)) {
            if (!['revoke', 'share-revoke'].includes(flow.kind))
              if ((await local(request)).id !== flow.local?.id) throw new Unavailable();

            const step = codeStep(provider, flow);

            return html(
              page(
                prefix,
                `Verify with ${provider.name}`,
                `${
                  step.sentTo === undefined
                    ? ''
                    : `<p>A message was sent to ${escape(step.sentTo)}. Press the button in it, then come back to this page.</p><p><a href="${escape(prefix)}/flows/${escape(flow.id)}">I pressed the button</a></p><p>Or enter the code from the message here.</p>${
                        step.wrong
                          ? `<p>That code did not match. ${step.triesLeft === 1 ? 'One try is' : `${step.triesLeft} tries are`} left.</p>`
                          : ''
                      }`
                }
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/submit">
            <label>${escape(step.sentTo === undefined ? step.field : 'Your code')} ${
              step.sentTo === undefined
                ? `<input name="artifact" type="${step.input}" autocomplete="${step.input}" required>`
                : '<input name="artifact" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required>'
            }</label>
            <button>${step.sentTo === undefined ? `Send the ${escape(provider.name.toLowerCase())}` : 'Check my code'}</button></form>
            ${step.sentTo === undefined ? `<p class="fine">${escape(codeNote)}</p>` : ''}`,
              ),
            );
          }

          if (flow.phase !== 'approval') return await ended(flow);

          if (
            !['revoke', 'share-revoke'].includes(flow.kind) &&
            (await local(request)).id !== flow.local?.id
          )
            throw new Unavailable();

          // A second way of showing an account already linked here joins that record, whose
          // visibility was chosen when it was made and is not the holder's to rechoose here.
          const joined = await service.joining(flow);
          const kept = ['revoke', 'share-revoke', 'renew'].includes(flow.kind) || joined;

          return html(
            page(
              prefix,
              ['revoke', 'share-revoke'].includes(flow.kind)
                ? 'Remove connection'
                : flow.kind === 'renew'
                  ? 'Renew connection'
                  : joined
                    ? 'Add to connection'
                    : 'Confirm connection',
              `
            ${card(subject(flow.local!).heading, subject(flow.local!).value, flow.local!.profileUrl)}
            ${card(
              provider.name,
              externalName(flow.external!),
              externalLink(flow.external!),
              flow.external!.kind === 'mailbox' ? undefined : flow.external!.id,
            )}
            ${joined ? `<p>This account is already linked here. Confirming adds this method to that connection, beneath the one it was first shown by, and it stays ${escape(joined.visibility)}.</p>` : ''}
            <p class="fine">${escape(service.siteOf(flow.local!))} receives the result. Verified via ${escape(options.verifierName)}.</p>
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/approve">
            ${kept ? '<input type="hidden" name="visibility" value="unlisted">' : visibilityChoice(flow.local!, visibilities(flow.local!), signs)}
            <button name="action" value="approve">${['revoke', 'share-revoke'].includes(flow.kind) ? (flow.kind === 'share-revoke' ? 'Revoke sharing link' : 'Revoke connection') : flow.kind === 'renew' ? 'Renew connection' : joined ? 'Add to connection' : 'Confirm connection'}</button>
            <button name="action" value="cancel">Cancel</button></form><p><a href="${escape(prefix)}/verify">Use a different external account</a></p>`,
            ),
          );
        }

        const confirmation = path.match(/^\/confirm\/([^/]+)$/);

        // Where the button in a message leads, in whatever browser the holder reads mail
        // in. Arriving confirms nothing: a scanner that opens every link in a message gets
        // this page and stops, and the holder is shown what they are confirming first.
        if (confirmation) {
          const token = url.searchParams.get('token') ?? '';
          const asked = await service.confirming(confirmation[1]!, token);

          const next: Record<string, string> = {
            connect: `link it to this ${subjectNoun(asked.local?.kind) ?? 'site'}`,
            renew: 'renew its link',
            visibility: 'change who can read its link',
            revoke: 'remove its link',
            'share-revoke': 'revoke its sharing link',
          };

          return html(
            page(
              prefix,
              'Confirm your address',
              `${asked.local ? card(subject(asked.local).heading, subject(asked.local).value, asked.local.profileUrl) : ''}
            ${card(asked.provider.name, externalName(asked.account), undefined)}
            <p>Confirming shows that this address is yours, so the page that asked can go on to ${escape(next[asked.kind]!)}. Nothing changes until that page is approved too.</p>
            <form method="post" action="${escape(prefix)}/confirm/${escape(confirmation[1]!)}">
            <input type="hidden" name="token" value="${escape(token)}">
            <button>Confirm this address</button></form>
            <p class="fine">If you did not ask for this, close this page. Nothing happens unless you confirm.</p>`,
            ),
          );
        }

        // Lets a static embed track current connections without hardcoding an id.
        if (path === '/published') {
          const response = json(await service.published());

          response.headers.set('Access-Control-Allow-Origin', '*');

          return response;
        }

        // The keys a signed record is checked against. Public, like the records they sign.
        if (path === '/keys') {
          const response = json({ keys: await service.keys() });

          response.headers.set('Access-Control-Allow-Origin', '*');

          return response;
        }

        if (path === '/check' && signs)
          return html(
            page(
              prefix,
              'Check a signed record',
              `<p>Paste the contents of a signed record saved from ${escape(options.verifierName)}.</p>${checkForm}`,
            ),
          );

        if (path === '/mine') return json(await service.mine(await local(request)));

        if (path.startsWith('/s/')) {
          const evidence = await service.shared(path.slice(3));

          return url.searchParams.get('format') === 'json'
            ? json(evidence)
            : html(evidencePage(evidence, prefix, options.reportUrl));
        }

        const hosted = path.match(/^\/connections\/([^/]+)\/proof$/);

        // As public as the evidence it belongs to, and checked the same way.
        if (hosted) return plain(await service.proof(hosted[1]!));

        if (path.startsWith('/connections/')) {
          const id = path.slice(13);

          if (url.searchParams.get('format') === 'signed') {
            const response = json(await service.signed(id));

            response.headers.set('Access-Control-Allow-Origin', '*');
            // Kept as a file: the signature is over these bytes, so they are saved as served.
            response.headers.set('Content-Disposition', `attachment; filename="verity-${id}.json"`);

            return response;
          }

          // Canonical routes and widgets never use local-session privileges.
          const evidence = await service.read(id);

          if (url.searchParams.get('format') === 'json') {
            const response = json(evidence);

            // Public evidence can be embedded on static sites without credentials.
            response.headers.set('Access-Control-Allow-Origin', '*');

            return response;
          }

          return html(
            evidencePage(evidence, prefix, options.reportUrl, (await service.keys())[0]?.id),
          );
        }

        if (path.startsWith('/manage/'))
          return json(await service.read(path.slice(8), await local(request)));
      } else {
        const data = await body(request);
        // The in-page dialog asks in JSON and is answered in JSON; a form gets its page.
        const asJson = request.headers.get('content-type')?.startsWith('application/json');

        if (path === '/check' && signs) {
          try {
            const signed: unknown = JSON.parse(data.record ?? '');
            const document = await service.checked(signed);

            if (document)
              return html(checkedPage(document, (signed as SignedEvidence).keyId, prefix));
          } catch {
            // Not JSON, or a record this build cannot draw: neither is one it can vouch for.
          }

          return html(
            page(
              prefix,
              'Check a signed record',
              `<p>This is not a record signed by ${escape(options.verifierName)}.</p>${checkForm}`,
            ),
          );
        }

        if (path === '/connect') {
          const user = await local(request);
          const provider = service.resolve((await choose(user, undefined, data)).provider);

          return json({
            url: `${service.baseUrl}/verify?provider=${encodeURIComponent(provider.id)}`,
          });
        }

        if (path === '/sessions') {
          if (
            !['connect', 'renew', 'revoke', 'visibility', 'share-revoke'].includes(data.kind ?? '')
          )
            throw new Unavailable();

          const kind = data.kind as Flow['kind'];

          const user = ['revoke', 'share-revoke'].includes(kind) ? undefined : await local(request);

          if (kind === 'visibility' && visibilities(user!).length < 2) throw new Unavailable();

          const flow = await service.start(
            user,
            data.connectionId || undefined,
            kind,
            await choose(user, data.connectionId || undefined, {
              provider: data.provider || undefined,
              method: data.method || undefined,
            }),
            await context(request, kind),
          );

          if (asJson && kind === 'connect')
            return json(
              await flowView(await service.flow(flow.flowId, flow.binding), flow.authorizationUrl),
              flowCookie(flow.binding),
            );

          return redirect(entry(flow), flowCookie(flow.binding));
        }

        const confirmation = path.match(/^\/confirm\/([^/]+)$/);

        if (confirmation) {
          const flow = await service.confirm(confirmation[1]!, data.token ?? '');

          // The flow is still the browser's that started it. This one may be that browser,
          // and then it can carry on from here; any other is sent back to where it began.
          const here = await service.flow(flow.id, binding(request)).catch(() => undefined);

          return html(
            page(
              prefix,
              flow.phase === 'failed' ? 'Address not confirmed' : 'Address confirmed',
              flow.phase === 'failed'
                ? `<p>${escape(flow.reason ?? 'This address could not be confirmed')}.</p>`
                : `<p>Go back to the page where you started. It carries on from here.</p>${
                    here
                      ? `<p><a href="${escape(prefix)}/flows/${escape(flow.id)}">Or carry on in this window</a></p>`
                      : '<p>You can close this window.</p>'
                  }`,
            ),
          );
        }

        const submission = path.match(/^\/flows\/([^/]+)\/submit$/);

        if (submission) {
          if (!data.artifact) throw new Unavailable();

          if (asJson) await ownFlow(request, submission[1]!);

          await service.submit(submission[1]!, binding(request), data.artifact);

          if (asJson)
            return json(await flowView(await service.flow(submission[1]!, binding(request))));

          return redirect(`${prefix}/flows/${submission[1]!}`);
        }

        const approval = path.match(/^\/flows\/([^/]+)\/approve$/);

        if (approval) {
          if (
            !['approve', 'cancel'].includes(data.action ?? '') ||
            !['public', 'unlisted'].includes(data.visibility ?? '')
          )
            throw new Unavailable();

          const flow = await service.flow(approval[1]!, binding(request));

          // A form resubmitted after its response was lost, as reloading a POST does. The
          // flow has ended, so this is its result page, which needs only the binding, as
          // loading it does: whoever signed the holder in may have ended that session since.
          if (!asJson && flow.result) return await ended(flow);

          const user = ['revoke', 'share-revoke'].includes(flow.kind)
            ? undefined
            : await local(request);

          const id = await service.approve(
            flow.id,
            binding(request),
            user,
            data.visibility as 'public' | 'unlisted',
            data.action === 'cancel',
            // Held to what the subject may choose where the approval sets the visibility.
            user && visibilities(user),
          );

          if (asJson)
            return json(id ? { outcome: 'complete', connectionId: id } : { outcome: 'cancelled' });

          return await ended(await service.flow(flow.id, binding(request)));
        }

        const management = path.match(
          /^\/connections\/([^/]+)\/(disconnect|share|share-revoke|visibility)$/,
        );

        if (management) {
          const user = await local(request),
            id = management[1]!;

          if (management[2] === 'disconnect') {
            await service.revoke(id, user);

            return json({ ok: true });
          }

          if (management[2] === 'visibility') {
            await service.read(id, user);

            return json({ url: `${service.baseUrl}/visibility/${id}` });
          }

          return json(
            (await service.share(id, user, management[2] === 'share-revoke')) ?? { ok: true },
          );
        }
      }

      throw new Unavailable();
    } catch (error) {
      // Never serialize/log exceptions: provider responses and request URLs can contain secrets.
      if (error instanceof Unavailable || error instanceof SyntaxError)
        return html(page(prefix, 'Unavailable', '<p>This resource is unavailable.</p>'), 404);

      return html(page(prefix, 'Request failed', '<p>Please try again.</p>'), 500);
    }
  }

  // A sign-in form submits here and is redirected to the provider. Chromium applies
  // form-action to every redirect of a form submission, so each provider's origin must be
  // allowed alongside our own or the redirect is blocked. The origin is read from the
  // provider's own authorization URL, which is built without side effects. An approval
  // form redirected on by `finish` is held to the same rule, hence `formTargets`.
  const formAction = [
    "'self'",
    ...new Set([
      ...service.providers.filter(isRedirectProvider).map(
        (p) =>
          new URL(
            p.authorizationUrl({
              state: 'state',
              challenge: 'challenge',
              redirectUri: `${service.baseUrl}/callback`,
            }),
          ).origin,
      ),
      ...(options.formTargets ?? []),
    ]),
  ].join(' ');

  async function secured(request: Request): Promise<Response> {
    const response = await handle(request);
    const policy = response.headers.get('content-security-policy');

    if (policy)
      response.headers.set(
        'content-security-policy',
        policy.replace("form-action 'self'", `form-action ${formAction}`),
      );

    return response;
  }

  return {
    service,
    handle: secured,
    /**
     * The flow binding, for a host that carries it some way other than this handler's own
     * cookie: the cookie's name, to read a binding from a request or a response, and the
     * header that sets it in a browser.
     */
    flowCookieName: cookieName,
    flowCookie,
  };
}

/** Mount on your chosen Node router. Public origin is configured, never inferred from Host. */
export function nodeHandler(handler: (request: Request) => Promise<Response>, origin: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;

      for await (const chunk of req) {
        length += chunk.length;

        if (length > maxBodyBytes) {
          res.writeHead(413);
          res.end();

          return;
        }

        chunks.push(Buffer.from(chunk));
      }

      const requestHeaders = new Headers();

      for (const [key, value] of Object.entries(req.headers))
        if (value) requestHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);

      const response = await handler(
        new Request(new URL(req.url ?? '/', origin), {
          method: req.method,
          headers: requestHeaders,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );

      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end('Request failed');
    }
  };
}
