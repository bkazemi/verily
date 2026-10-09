import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  attestationLabel,
  externalId,
  externalIdGroups,
  externalLink,
  externalName,
  isArtifactProvider,
  isCodeProvider,
  isRedirectProvider,
  lastProved,
  accountsOf,
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
  signedBy,
  type SignedDocument,
  type Visibility,
} from '../core/index.js';
import {
  artifactAttempts,
  codeAttempts,
  VerilyService,
  Unavailable,
  type ServiceOptions,
} from './service.js';
import { copyScript, waitScript } from './copy.js';
import { escape } from './escape.js';
import { logo } from '../logo.js';
import { stylesheet, styleVersion } from './style.js';

export { VerilyService, Unavailable } from './service.js';

export { githubProvider } from './github.js';

export { discordProvider } from './discord.js';

export { youtubeProvider } from './youtube.js';

export { githubGistProvider } from './github-gist.js';

export { linkProvider, githubLinkProvider, type LinkProviderOptions } from './link.js';

export {
  dnsProvider,
  wellKnownProvider,
  dnsKeys,
  dnsVerifiers,
  keyRecord,
  verifierRecord,
  type DnsOptions,
  type DomainProviderOptions,
  type Published,
  type WellKnownProviderOptions,
} from './domain.js';

export { pgpProvider } from './pgp.js';

import { short } from './pgp.js';

export { generateSigningKey, signer } from './signing.js';

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
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Verily</title><link rel="stylesheet" href="${escape(prefix)}/style.css?v=${styleVersion}"><body><main>${logo}<h1>${escape(title)}</h1>${body}</main></body></html>`;

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/**
 * What a request wants back, by one rule for every route that has more than one answer.
 * The query says so first, where a route has that form. Then `Accept`, when it asks for
 * JSON and not for a page. Then, for a POST, how the request itself was sent: a JSON body
 * is answered in JSON, which is all a badge script published before `Accept` was read can
 * say. Anything else is a page.
 */
function wants(request: Request, url: URL): 'json' | 'signed' | 'page' {
  const format = url.searchParams.get('format');

  if (format === 'json' || format === 'signed') return format;

  const accept = request.headers.get('accept') ?? '';

  if (/\bapplication\/json\b/i.test(accept) && !/\btext\/html\b/i.test(accept)) return 'json';

  return request.method === 'POST' &&
    request.headers.get('content-type')?.startsWith('application/json')
    ? 'json'
    : 'page';
}

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
  reference?: string | string[],
  ...extra: string[]
) {
  const profile = url && safeUrl(url);

  return `<div class="side"><p class="who">${escape(heading)}</p><p class="name">${
    profile ? `<a href="${escape(profile)}" rel="noreferrer">${escape(name)}</a>` : escape(name)
  }</p>${
    typeof reference === 'string'
      ? `<p class="reference">${escape(reference)}</p>`
      : reference
        ? `<p class="reference fingerprint">${reference.map((group) => `<span>${escape(group)}</span>`).join('')}</p>`
        : ''
  }${extra.join('')}</div>`;
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
  const label = attestationLabel(attestation.method, names, attestation);

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
    dns: 'Add a DNS record',
    wellknown: 'Serve a file',
    signature: `Sign with ${provider.name}`,
    code: `Confirm by ${provider.name.toLowerCase()}`,
  };

  return actions[providerMethod(provider)] ?? `Continue with ${provider.name}`;
}

/** What the holder hands back for an artifact method, named for what it is. */
function artifactField(provider: ArtifactProvider): string {
  if (provider.field) return provider.field;

  if (provider.artifact === 'document') return 'Your proof';

  return provider.method === 'backlink'
    ? 'Address of the page carrying your link'
    : 'Address of your published proof';
}

/**
 * Said before the holder approves, where the method they used found another proof already
 * standing: it goes on the record with this one, and they did not ask for it by name.
 */
function standingNote(flow: Flow, site: string): string | undefined {
  const found: Record<string, string> = {
    backlink: `This account already links back to ${site}.`,
    dns: `This domain already names ${site} in a DNS record.`,
    wellknown: `This domain already names ${site} in a file it serves.`,
  };

  const note = flow.standing?.map((a) => found[a.method]).find((said) => said !== undefined);

  return note ? `${note} Confirming records that too.` : undefined;
}

/**
 * Said above a proof that was handed back and refused, while the flow still waits for it:
 * why, where the provider said why in words meant for the holder, and how many tries remain.
 */
function refusedNote(flow: Flow): string | undefined {
  if (!flow.tries) return undefined;

  const left = artifactAttempts - flow.tries;

  return `${flow.reason ? `That did not check out: ${flow.reason}.` : 'That could not be checked.'} ${left === 1 ? 'One try is' : `${left} tries are`} left.`;
}

/** Said beside every artifact method: what the holder publishes is public by design. */
function artifactNote(provider: ArtifactProvider, expect?: string): string {
  // A minted string names nobody, so there is nothing for a reader to follow. What names
  // the subject is its address, which a site may give as http as well as https.
  if (
    ['dns', 'wellknown'].includes(provider.method) &&
    !['https:', 'http:'].includes(URL.parse(expect ?? '')?.protocol ?? '')
  )
    return `This ${provider.method === 'dns' ? 'record' : 'file'} is public, and anyone can look it up. It does not say what it is for.`;

  const notes: Record<string, string> = {
    backlink:
      'This link is public, as is the page you point at. Anyone reading either one can follow it here.',
    dns: 'This record is public, as is the page it names. Anyone reading either one can follow it here.',
    wellknown:
      'This file is public, as is the page it names. Anyone reading either one can follow it here.',
  };

  return (
    notes[provider.method] ??
    'This line is public, as is whatever published it. Publish nothing else alongside it.'
  );
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

/**
 * What the holder would be linking, for the sentence that asks them to: an account with a
 * sign-in provider, a key, an address, a domain. Each is named once, however many ways it
 * can be shown.
 */
function heldNames(providers: Provider[]): string {
  const held = (p: Provider) =>
    ({
      signature: `${p.name} key`,
      code: `${p.name.toLowerCase()} address`,
      dns: 'domain',
      wellknown: 'domain',
    })[providerMethod(p) as string] ?? `${p.name} account`;

  const names = [...new Set(providers.map(held))];

  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
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

/** Provider setup with the flow’s return instructions, shared by HTML and the dialog. */
function proofInstructions(provider: ArtifactProvider, flow: Flow): Instruction[] {
  return [
    ...provider.instructions(flow.expect!, flow.artifact ?? flow.suggested),
    ...(flow.dnsDraftId
      ? [
          'Your DNS setup is saved for seven days from when you started. To continue later, sign in and choose the DNS method again. For a renewal, reopen the same connection’s renewal. The proof must pass a fresh check; keep this TXT value while you wait.',
        ]
      : []),
  ];
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
  named?: Named,
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
        // A mailbox's address or a domain is its name already, so there is no second identifier.
        externalIdGroups(e.external) ?? externalId(e.external),
        externalNotes(e.attestations, names),
      ) +
      times(
        e.status === 'retired'
          ? [
              ['Approved', e.approvedAt],
              // Two rows, always, so a reader sees any gap between them: an account retired
              // weeks after it was last proved went unproved for those weeks.
              ['Last verified', lastProved(e)],
              ['Retired', e.retiredAt],
              ['Sharing link expires', e.linkExpiresAt],
            ]
          : [
              ['Approved', e.approvedAt],
              ['Authenticated', e.authenticatedAt],
              [
                current ? 'Valid until' : 'Expired on',
                e.status === 'revoked' ? undefined : e.expiresAt,
              ],
              ['Revoked on', e.revokedAt],
              // Only a method that publishes an artifact drifts; a sign-in does not go stale.
              [
                'Last checked',
                e.attestations.external[0].artifactUrl
                  ? e.attestations.external[0].confirmedAt
                  : undefined,
              ],
              ['Sharing link expires', e.linkExpiresAt],
            ],
      ) +
      `${e.linkExpiresAt ? '<p class="fine">Anyone with this link can view and forward it.</p>' : ''}
    ${e.signedUrl ? `<p class="signed" id="signed"><strong>Signed by ${escape(e.verifierName)}</strong>${keyId ? `<br>${keyLine(base, keyId, named)}` : ''}<br><a href="${escape(safeUrl(e.signedUrl))}">Download signed record</a> · <a href="${escape(base)}/check">Check a record</a></p>` : ''}
    <p class="fine">This connection does not establish legal identity, trustworthiness, content authorship, or permanent ownership.</p>
    <p class="fine"><a href="${escape(base)}/external-revoke/${escape(e.id)}">Remove this connection using your external account</a></p>
    ${e.visibility === 'unlisted' ? `<p class="fine"><a href="${escape(base)}/external-share-revoke/${escape(e.id)}">Revoke only this sharing link using your external account</a></p>` : ''}
    <p class="fine"><a href="${escape(report)}" rel="noreferrer">Report an incorrect record</a></p>`,
  );
}

/** Joins a subject's card to its accounts: the link itself, drawn as the dialog draws it. */
const joiner =
  '<svg class="joiner" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">' +
  [
    'M10.5 7.5 13 5a4.95 4.95 0 0 1 7 7l-2.5 2.5',
    'M13.5 16.5 11 19a4.95 4.95 0 0 1-7-7l2.5-2.5',
    'M9 15l6-6',
  ]
    .map((d) => `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`)
    .join('') +
  '</svg>';

/**
 * One account as a badge's dialog draws it: what it is and how it stands, the verifier's
 * own page for it, how it was shown, how its holder lists it, and its times.
 */
function accountCard(e: Evidence, external: Attestations['external'], now: number) {
  const retired = e.status === 'retired';
  const record = escape(safeUrl(e.evidenceUrl));

  return card(
    e.providerName,
    externalName(e.external),
    externalLink(e.external),
    externalIdGroups(e.external) ?? externalId(e.external),
    `<p class="how">${escape(statusLabel(e, now))} · via: <a href="${record}">${escape(e.verifierName)}</a>${e.signedUrl ? `<a class="signed-mark" href="${record}#signed">signed</a>` : ''}</p>`,
    externalNotes({ ...e.attestations, external }, { site: e.siteName, provider: e.providerName }),
    times(
      retired
        ? [
            ['Approved', e.approvedAt],
            ['Last verified', lastProved(e)],
            ['Retired', e.retiredAt],
          ]
        : [
            ['Approved', e.approvedAt],
            [e.expiresAt > now ? 'Valid until' : 'Expired on', e.expiresAt],
            ['Last checked', external[0].artifactUrl ? external[0].confirmedAt : undefined],
          ],
    ),
    // The holder's own word on the account, which nothing checked, so it sits apart from
    // the methods, in the card's corner as the dialog has it.
    retired || !e.mark
      ? ''
      : e.mark === 'preferred'
        ? '<div class="listing preferred">Preferred</div>'
        : '<div class="listing">No longer used</div>',
  );
}

/**
 * The public records given, as a page that shows what a badge's dialog does: a card to a
 * subject, then one to each of its accounts in the badge's own order.
 */
function publishedPage(records: Evidence[], base: string) {
  const now = Date.now();
  const subjects = new Map<string, Evidence[]>();

  for (const e of records) {
    const key = JSON.stringify([e.siteName, e.local.reference]);

    subjects.set(key, [...(subjects.get(key) ?? []), e]);
  }

  return page(
    base,
    'Public connections',
    records.length
      ? [...subjects.values()]
          .map((held) => {
            const local = localSide(held[0]!.local, held[0]!.siteName);

            return (
              card(local.heading, local.value, held[0]!.local.profileUrl) +
              joiner +
              `<div class="accounts">${accountsOf(held, now)
                .map(({ lead, external }) => accountCard(lead, external, now))
                .join('')}</div>`
            );
          })
          .join('')
      : '<p>No public connections.</p>',
  );
}

/** Where a verifier's domain was read naming a signing key, and how far that read goes. */
type Named = { domain: string; lookup: string; dnssec: boolean };

/**
 * Names a signing key on one line: its last sixteen digits, linked to the key itself with
 * the whole fingerprint on hover, then whether a domain's DNS was read naming it. That is a
 * link to the lookup that found it, a second place to learn whose the key is which is not
 * this server, and its hover names the domain that was asked, whatever address the record
 * beside it gives for its verifier.
 */
function keyLine(base: string, keyId: string, named?: Named) {
  const key = `Key <a href="${escape(base)}/keys.asc" title="${escape(keyId)}">${escape(short(keyId))}</a>`;

  return named
    ? `${key} · <a href="${escape(named.lookup)}" rel="noreferrer" title="${escape(`View the lookup for ${named.domain}`)}">confirmed in DNS${named.dnssec ? ' (DNSSEC)' : ''}</a>`
    : key;
}

const checkForm =
  '<form method="post"><label>Signed record <textarea name="record" rows="8" cols="72" required></textarea></label><button>Check</button></form>';

/**
 * What a signed record says, once its signature has been checked against this verifier's
 * keys. It is a record of the past: the page says when, and sends the reader to the live
 * record for whether it still stands.
 */
function checkedPage(d: SignedDocument, keyId: string, base: string, named?: Named) {
  const names = { site: d.siteName, provider: d.providerName };
  const local = localSide(d.local, d.siteName);

  // A retired record did not stand when it was signed, and its heading says so first.
  const retired = d.version === 2;

  return page(
    base,
    retired ? 'Retired connection' : 'Signed record',
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
        externalIdGroups(d.external) ?? externalId(d.external),
        externalNotes(d.attestations, names),
      ) +
      times(
        retired
          ? [
              ['Signed', d.issuedAt],
              ['Approved', d.approvedAt],
              ['Last verified', lastProved(d)],
              ['Retired', d.retiredAt],
            ]
          : [
              ['Signed', d.issuedAt],
              ['Approved', d.approvedAt],
              ['Valid until', d.expiresAt],
            ],
      ) +
      `<p class="fine">${keyLine(base, keyId, named)}</p>
    <p class="fine"><a href="${escape(safeUrl(d.evidenceUrl))}">See whether this connection still stands</a></p>`,
  );
}

export function createVerily(options: ServerOptions) {
  const service = new VerilyService(options);
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

  const cookieName = `verily_flow_${Buffer.from(prefix).toString('hex')}`;

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
   * external side refuses a standing proof, which anybody can hand back. A retired record
   * is renewed by the method it was first shown by, so that one is offered alone.
   */
  async function offer(
    kind: Flow['kind'],
    id: string,
    user: LocalAccount | undefined,
    requested: string | null,
  ): Promise<Provider[]> {
    let namespace = requested ?? undefined;
    let only: string | undefined;

    if (user && id) {
      const held = await service.read(id, user);

      namespace = held.provider;

      if (held.status === 'retired') {
        // Who can read a retired record is frozen with the rest of it.
        if (kind === 'visibility') throw new Unavailable();

        only = held.attestations.external[0].method;
      }
    }

    const offered = (user ? permitted(user) : service.providers).filter(
      (p) =>
        (namespace === undefined || p.id === namespace) &&
        (only === undefined || providerMethod(p) === only) &&
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
        `<p>${escape(outcome)}</p>${reason ? `<p>${escape(reason)}.</p>` : ''}<div id="verily-result" data-outcome="${escape(outcome)}" data-id="${escape(id)}"></div><script src="${escape(prefix)}/result.js" defer></script><p>You can close this window and return to account settings.</p>`,
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
   * A connect or renew flow as the in-page dialog draws it: the same steps the flow pages
   * walk through, as data, so the holder never has to leave the page they started on.
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
        instructions: proofInstructions(provider, flow),
        artifact: provider.artifact,
        field: artifactField(provider),
        input: provider.input ?? 'url',
        ...((flow.artifact ?? flow.suggested)
          ? { suggested: flow.artifact ?? flow.suggested }
          : {}),
        ...(flow.tries ? { refused: refusedNote(flow) } : {}),
        note: artifactNote(provider, flow.expect),
      });

    if (flow.phase === 'pending' && isCodeProvider(provider))
      Object.assign(view, { code: codeStep(provider, flow), note: codeNote });

    if (flow.phase === 'approval') {
      const joined = await service.joining(flow);
      const found = standingNote(flow, service.siteOf(flow.local!));

      Object.assign(view, {
        local: subject(flow.local!),
        external: flow.external,
        ...(joined ? { joined: { visibility: joined.visibility } } : {}),
        ...(found ? { standingNote: found } : {}),
        visibilities: visibilities(flow.local!),
        ...(signs ? { signedNote } : {}),
      });
    }

    if (flow.phase === 'failed' && flow.reason) view.reason = flow.reason;

    if (flow.phase === 'complete') view.connectionId = flow.resultId;

    return view;
  }

  /** A flow the dialog may read: one this holder started, to connect an account or renew one. */
  async function ownFlow(request: Request, id: string) {
    const flow = await service.flow(id, binding(request));

    if (!['connect', 'renew'].includes(flow.kind) || (await local(request)).id !== flow.local?.id)
      throw new Unavailable();

    return flow;
  }

  /**
   * What the tab a confirmation was pressed in says. It is the end of that tab's part: the
   * page that asked is waiting on the flow and carries on from there, so this one offers
   * nowhere to go.
   */
  const confirmed = (flow: Flow) =>
    html(
      page(
        prefix,
        flow.phase === 'failed' ? 'Address not confirmed' : 'Address confirmed',
        flow.phase === 'failed'
          ? `<p>${escape(flow.reason ?? 'This address could not be confirmed')}.</p>`
          : '<p>You can close this tab now.</p>',
      ),
    );

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

        if (path === '/wait.js')
          return new Response(waitScript, {
            headers: { ...headers, 'Content-Type': 'text/javascript' },
          });

        const phase = path.match(/^\/flows\/([^/]+)\/phase$/);

        // All a waiting page needs to know, and only the browser that started the flow.
        if (phase) return json({ phase: (await service.flow(phase[1]!, binding(request))).phase });

        if (path === '/result.js')
          return new Response(
            `const e=document.getElementById('verily-result');if(window.opener&&e){window.opener.postMessage({type:'verily-result',outcome:e.dataset.outcome,connectionId:e.dataset.id},location.origin);window.close()}`,
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

          // Several providers are named by their buttons, not strung together in the heading.
          const several = new Set(offered.map((p) => p.name)).size > 1;

          // One form per method. With one on offer the provider is all there is to name.
          // A new link started from this page always ends on its approval, as it did when
          // this form was a GET, so it says so: `/verify` is an address any site can send a
          // browser to, and the approval is where the holder sees what they are linking.
          const forms = offered
            .map(
              (p) =>
                `<form method="post" action="${escape(prefix)}/sessions"><input type="hidden" name="kind" value="${kind}">${kind === 'connect' ? '<input type="hidden" name="unattended" value="1">' : ''}<input type="hidden" name="connectionId" value="${escape(id)}"><input type="hidden" name="provider" value="${escape(p.id)}"><input type="hidden" name="method" value="${escape(providerMethod(p))}"><button>${escape(offered.length > 1 ? methodAction(p) : `Continue with ${p.name}`)}</button></form>`,
            )
            .join('');

          return html(
            page(
              prefix,
              external
                ? 'Remove a connection'
                : kind === 'renew'
                  ? 'Renew this connection'
                  : several
                    ? 'Verify an account'
                    : `Verify with ${providerNames(offered)}`,
              `
            ${
              user
                ? card(subject(user).heading, subject(user).value, user.profileUrl)
                : '<p>Authenticate with the matching external account to review and remove this link.</p>'
            }
            <p>Confirm the connection between this ${escape(subjectNoun(user?.kind) ?? 'site')} and your ${escape(heldNames(offered))}.</p>
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

        if (path.startsWith('/flows/') && wants(request, url) === 'json')
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
                `${instructions(proofInstructions(provider, flow))}
            ${flow.tries ? `<p>${escape(refusedNote(flow))}</p>` : ''}
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/submit">
            <label>${escape(artifactField(provider))} ${
              provider.artifact === 'document'
                ? `<textarea name="artifact" rows="14" cols="72" required>${escape(flow.artifact ?? '')}</textarea>`
                : `<input name="artifact" type="${provider.input ?? 'url'}" value="${escape(flow.artifact ?? flow.suggested ?? '')}" autocapitalize="none" spellcheck="false" required>`
            }</label>
            <button>Check my proof</button></form>
            <p class="fine">${escape(artifactNote(provider, flow.expect))}</p>
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
                    : `<p>A message was sent to ${escape(step.sentTo)}. Press the button in it, and this page carries on.</p><noscript><p><a href="${escape(prefix)}/flows/${escape(flow.id)}">I pressed the button</a></p></noscript><p>Or enter the code from the message here.</p>${
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
            ${step.sentTo === undefined ? `<p class="fine">${escape(codeNote)}</p>` : `<script src="${escape(prefix)}/wait.js" defer></script>`}`,
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
          const found = standingNote(flow, service.siteOf(flow.local!));

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
              externalIdGroups(flow.external!) ?? externalId(flow.external!),
            )}
            ${joined ? `<p>This account is already linked here. Confirming adds this method to that connection, beneath the one it was first shown by, and it stays ${escape(joined.visibility)}.</p>` : ''}
            ${found ? `<p>${escape(found)}</p>` : ''}
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
        // in. In the browser that started the flow, arriving is the confirmation: its
        // cookie shows the one who asked is the one who opened the message. Anywhere else
        // arriving confirms nothing: a scanner that opens every link in a message carries
        // no cookie, gets this page and stops, and a holder on another device is shown
        // what they are confirming first.
        if (confirmation) {
          const token = url.searchParams.get('token') ?? '';
          const asked = await service.confirming(confirmation[1]!, token);

          if (await service.flow(confirmation[1]!, binding(request)).catch(() => undefined))
            return confirmed(await service.confirm(confirmation[1]!, token));

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
          const site = url.searchParams.get('site');
          const reference = url.searchParams.get('reference') ?? undefined;
          const subject = site === null ? undefined : { site, reference };

          // A page only where one is asked for by name. An embed published before `Accept`
          // was sent asks for nothing, and must go on getting the list.
          if (
            url.searchParams.get('format') !== 'json' &&
            /\btext\/html\b/i.test(request.headers.get('accept') ?? '')
          )
            return html(publishedPage(await service.listed(subject), prefix));

          const response = json(await service.published(subject));

          response.headers.set('Access-Control-Allow-Origin', '*');

          return response;
        }

        // The keys a signed record is checked against. Public, like the records they sign.
        if (path === '/keys') {
          const dns = await service.keyRecords();

          // With them, the records that name these keys in the DNS of this verifier's domain.
          const response = json({ keys: await service.keys(), ...(dns ? { dns } : {}) });

          response.headers.set('Access-Control-Allow-Origin', '*');

          return response;
        }

        // The same keys as a file `gpg --import` reads.
        if (path === '/keys.asc' && signs) return plain(await service.armoredKeys());

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

          return wants(request, url) === 'json'
            ? json(evidence)
            : html(evidencePage(evidence, prefix, options.reportUrl));
        }

        const hosted = path.match(/^\/connections\/([^/]+)\/proof$/);

        // As public as the evidence it belongs to, and checked the same way.
        if (hosted) return plain(await service.proof(hosted[1]!));

        if (path.startsWith('/connections/')) {
          const id = path.slice(13);

          if (wants(request, url) === 'signed') {
            const response = plain(await service.signed(id));

            // Kept as a file, which is what `gpg --verify` is given.
            response.headers.set('Content-Disposition', `attachment; filename="verily-${id}.asc"`);

            return response;
          }

          // Canonical routes and widgets never use local-session privileges.
          const evidence = await service.read(id);

          if (wants(request, url) === 'json') {
            const response = json(evidence);

            // Public evidence can be embedded on static sites without credentials.
            response.headers.set('Access-Control-Allow-Origin', '*');

            return response;
          }

          const keyId = (await service.keys())[0]?.id;

          return html(
            evidencePage(
              evidence,
              prefix,
              options.reportUrl,
              keyId,
              keyId && evidence.signedUrl ? await service.keyNamed(keyId) : undefined,
            ),
          );
        }

        if (path.startsWith('/manage/'))
          return json(await service.read(path.slice(8), await local(request)));
      } else {
        const data = await body(request);
        // The in-page dialog asks in JSON and is answered in JSON; a form gets its page.
        const asJson = wants(request, url) === 'json';

        if (path === '/check' && signs) {
          try {
            const signed = data.record ?? '';
            const document = await service.checked(signed);

            const by = (await signedBy(signed))!;

            if (document)
              return html(checkedPage(document, by, prefix, await service.keyNamed(by)));
          } catch {
            // A record this build cannot draw is not one it can vouch for.
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
            // Posted from this origin, which the check on every POST has already held it to.
            // A form may still ask to be held to an approval, which only ever adds one.
            !data.unattended,
          );

          if (asJson && ['connect', 'renew'].includes(kind))
            return json(
              await flowView(await service.flow(flow.flowId, flow.binding), flow.authorizationUrl),
              flowCookie(flow.binding),
            );

          return redirect(entry(flow), flowCookie(flow.binding));
        }

        const confirmation = path.match(/^\/confirm\/([^/]+)$/);

        if (confirmation) {
          return confirmed(await service.confirm(confirmation[1]!, data.token ?? ''));
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
          /^\/connections\/([^/]+)\/(disconnect|mark|share|share-revoke|visibility)$/,
        );

        if (management) {
          const user = await local(request),
            id = management[1]!;

          if (management[2] === 'disconnect') {
            await service.revoke(id, user);

            return json({ ok: true });
          }

          // Acts on the account the record names: every record of it this holder has.
          if (management[2] === 'mark') {
            await service.mark(id, user, data.as as 'preferred' | 'current' | 'unused' | 'retired');

            return json({ ok: true });
          }

          if (management[2] === 'visibility') {
            if ((await service.read(id, user)).status === 'retired') throw new Unavailable();

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
