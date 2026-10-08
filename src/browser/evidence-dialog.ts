import {
  attestationLabel,
  externalId,
  externalLink,
  externalName,
  lastProved,
  localSide,
  proofTitle,
  statusLabel,
  type Attestation,
  type Evidence,
} from '../core/index.js';
import { markStyles, verificationMark } from './mark.js';
import { providerMark } from './provider-mark.js';
import { onSignatureResult, signature, standing, type Signature } from './signed.js';
import { projectUrl, verilyLogo } from './logo.js';
import { version } from '../version.js';

/** The logotype as a link to the project, as both dialogs carry it in their footer. */
export function stampLink(): HTMLAnchorElement {
  const link = outward(node('a'), projectUrl);

  link.append(verilyLogo());

  return link;
}

const openDialogs = new WeakMap<HTMLElement, HTMLDialogElement>();

export const styles = `
  * { box-sizing: border-box; }
  dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); margin: auto; padding: 24px; border: 1px solid #dce2de; border-radius: 16px; background: #fff; color: #23312b; box-shadow: 0 24px 90px #10201935; font: 13px/1.6 system-ui, sans-serif; }
  dialog::backdrop { background: #15271f66; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.3px; }
  button { width: 32px; height: 32px; border: 1px solid #dce2de; border-radius: 8px; background: #fff; color: #52645a; font: 20px system-ui, sans-serif; cursor: pointer; }
  button:hover { background: #f2f5f1; }
  .icon { display: grid; place-items: center; padding: 0; }
  .icon svg { width: 16px; height: 16px; }
  .title { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .all { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; color: #52645a; }
  .all:hover { background: #f2f5f1; }
  .all svg { width: 16px; height: 16px; }
  a { color: #245f43; text-underline-offset: 3px; overflow-wrap: anywhere; }
  a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid #357ce5; outline-offset: 3px; }
  /* An element given its own display would otherwise go on showing while hidden. */
  [hidden] { display: none !important; }
  .summary { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .mark { width: 36px; height: 36px; flex-shrink: 0; }
  .provider { width: 14px; height: 14px; }
  .state { font-size: 14px; font-weight: 650; line-height: 1.4; }
  .muted { color: #6b786f; font-size: 12px; }
  .account { position: relative; }
  .veiled > :not(.checking) { filter: blur(4px); opacity: .55; user-select: none; }
  .checking { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; color: #23312b; font-size: 13px; font-weight: 600; }
  .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .caution { display: inline-block; margin-left: 4px; color: #a15c00; cursor: help; vertical-align: -1.5px; }
  .caution svg { display: block; width: 12px; height: 12px; }
  .bad { color: #b3261e; font-weight: 650; text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }
  .account { padding: 14px 16px; border: 1px solid #e0e6df; border-radius: 10px; margin-top: 12px; }
  .account h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 3px; color: #6b786f; font-size: 11px; font-weight: 550; }
  .account a, .account strong { font-weight: 650; font-size: 14px; }
  /* The account's own name carries that weight; a link inside a line of prose does not. */
  .summary a, .method a, .additional a { font: inherit; }
  .reference { margin-top: 2px; }
  .method { margin-top: 8px; }
  /* In the corner the heading leaves empty, apart from everything that was checked. */
  .listing { position: absolute; top: 12px; right: 14px; padding: 1px 8px; border: 1px solid #e0e6df; border-radius: 999px; color: #6b786f; font-size: 11px; font-weight: 550; }
  .listing.preferred { border-color: #245f43; color: #245f43; }
  /* Quiet, as its pill is: the surface and the name step back, and the controls do not. */
  .account.retired { background: #f6f8f5; }
  .account.retired > a, .account.retired > strong { color: #6b786f; }
  .account.retired .mark { opacity: .45; }
  .group { margin: 20px 0 0; color: #6b786f; font-size: 11px; font-weight: 550; }
  summary.group { display: flex; align-items: center; gap: 4px; width: fit-content; border-radius: 4px; list-style: none; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  .fold { display: flex; align-items: center; gap: 4px; width: auto; height: auto; padding: 2px 8px 2px 4px; margin-left: -4px; border: 0; background: none; font: 550 12px/1.6 system-ui, sans-serif; }
  .fold svg, summary svg { width: 12px; height: 12px; }
  .fold[aria-expanded="true"] svg, details[open] > summary svg { transform: rotate(90deg); }
  @media (prefers-reduced-motion: no-preference) { .fold svg, summary svg { transition: transform .15s; } }
  /* The fold and what the holder may do share a line, until a question needs the whole of it. */
  .bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .account .bar .row { margin: 0 0 0 auto; }
  .additional { margin-top: 2px; padding-left: 12px; }
  .joiner { display: block; width: 20px; height: 20px; margin: 8px auto -4px; color: #90a096; }
  dl { margin: 16px 0 0; padding-top: 12px; border-top: 1px solid #e5e9e3; display: grid; grid-template-columns: auto 1fr; gap: 5px 16px; font-size: 11px; }
  dt { color: #6b786f; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .explanation { margin-top: 16px; }
  .action { width: auto; height: auto; padding: 9px 14px; font: 600 13px/1.3 system-ui, sans-serif; color: #23312b; text-align: left; }
  .action.primary { border-color: #245f43; background: #245f43; color: #fff; }
  .action.primary:hover { background: #1d4f37; }
  .action:disabled { opacity: .6; cursor: progress; }
  .action.danger:hover { border-color: #b3261e; background: #fdecea; color: #b3261e; }
  .row { display: flex; justify-content: end; gap: 8px; margin-top: 16px; }
  .account .row { align-items: center; justify-content: start; flex-wrap: wrap; margin-top: 12px; }
  .account .action { padding: 5px 10px; font-size: 12px; }
  .account .action.dots { display: grid; place-items: center; align-self: stretch; width: 30px; padding: 0; }
  .dots svg { width: 16px; height: 16px; }
  /* Placed under its button each time it opens, above the dialog and clipped by none of it. */
  .menu { position: fixed; inset: auto; margin: 0; min-width: 170px; padding: 6px; border: 1px solid #dce2de; border-radius: 10px; background: #fff; color: #23312b; box-shadow: 0 12px 40px #10201930; }
  .menu:popover-open { display: grid; }
  .account .menu .action { border: 0; border-radius: 6px; padding: 6px 10px; font-weight: 550; }
  .menu .danger { color: #b3261e; }
  .menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid #e5e9e3; }
  footer { display: flex; align-items: center; justify-content: start; gap: 6px; margin: 20px 0 -8px; color: #9aa9a0; font-size: 11px; }
  footer a { display: flex; color: inherit; }
  .logo { display: block; height: 13px; }
  ${markStyles}
`;

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag);

  element.textContent = text;
  element.className = className;

  return element;
}

/**
 * Points an anchor out of the dialog. Every link here opens in a new tab: the dialog is
 * read against what it links to, and following one in place would close the dialog and
 * take the reader off the page the pill was on. `noreferrer` keeps the opener unreachable.
 */
export function outward(anchor: HTMLAnchorElement, url: string): HTMLAnchorElement {
  anchor.href = url;
  anchor.rel = 'noreferrer';
  anchor.target = '_blank';

  return anchor;
}

/**
 * Where the verifier lists every public record of a record's subject. A record whose
 * address is not the usual one is left linking to itself.
 */
export function subjectUrl(e: Evidence): string {
  const url = new URL(e.evidenceUrl);
  const path = url.pathname.replace(/\/connections\/[^/]+$/, '/published');

  if (path === url.pathname) return e.evidenceUrl;

  url.pathname = path;
  url.search = `site=${encodeURIComponent(e.siteName)}&reference=${encodeURIComponent(e.local.reference)}`;

  return url.href;
}

/** Opens somewhere else, in a tab of its own: a box with an arrow leaving it. */
function awayMark(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of [
    'M14 5h5v5',
    'M19 5l-8 8',
    'M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4',
  ]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }

  return svg;
}

/** A small mark of plain strokes, in the surrounding colour. */
function strokes(box: number, width: number, paths: string[]): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of paths) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }

  return svg;
}

/** Points at what is folded away, and turns to point down once it is open. */
const foldMark = () => strokes(16, 1.8, ['M6 3.5 10.5 8 6 12.5']);

/** Three dots: there is more to do here than the buttons beside it. */
const moreMark = () => strokes(16, 2.4, ['M3 8h.01', 'M8 8h.01', 'M13 8h.01']);

/** A cross drawn in a square, so it sits in the middle of its button in any font. */
export const closeMark = () => strokes(16, 1.8, ['M4 4l8 8', 'M12 4l-8 8']);

/** Points back the way the reader came, drawn for the same reason the cross is. */
export const backMark = () => strokes(16, 1.8, ['M10 3.5 5.5 8 10 12.5']);

/** Joins the two cards: the link itself, drawn rather than described. */
export function linkMark(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'joiner');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of [
    'M10.5 7.5 13 5a4.95 4.95 0 0 1 7 7l-2.5 2.5',
    'M13.5 16.5 11 19a4.95 4.95 0 0 1-7-7l2.5-2.5',
    'M9 15l6-6',
  ]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }

  return svg;
}

/**
 * Names how one side was established, inside that side's card. A method that published a
 * proof is itself the link to it, so a reader can check the claim without taking this
 * backend's word for it, and several proofs on one card each say which one they open.
 * The methods are named, never ranked: which ones convince is the reader's call.
 * Additional methods sit beneath the main one, indented under it.
 */
function attestationNote(
  attestation: Attestation,
  names: { site: string; provider: string },
  additional = false,
): HTMLElement[] {
  const label = attestationLabel(attestation.method, names, attestation);

  if (!label) return [];

  const note = node('div', additional ? '+ ' : '', `muted ${additional ? 'additional' : 'method'}`);

  // Evidence is rejected before it reaches here unless every artifact url is http(s).
  if (!attestation.artifactUrl) {
    note.append(document.createTextNode(label));

    return [note];
  }

  const proof = outward(node('a', label), attestation.artifactUrl);

  proof.title = proofTitle(attestation, moment);
  note.append(proof);

  return [note];
}

/** Seconds are noise on a record measured in days, and every time here reads the same way. */
function moment(time: number) {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Both sides of a link render as the same card, so a reader can see it is a pair.
 * `extra` carries evidence belonging to that side alone: a provider authenticates and
 * expires on its own terms, and a second provider on the same subject would differ.
 */
export function accountCard(
  heading: Node[],
  name: string,
  reference: string | undefined,
  url?: string,
  ...extra: HTMLElement[]
) {
  const card = node('section', '', 'account');
  const title = node('h3');
  const value = node(url ? 'a' : 'strong', name);

  title.append(...heading);

  if (value instanceof HTMLAnchorElement) outward(value, url!);

  card.append(title, value);

  if (reference) card.append(node('div', reference, 'muted reference'));

  card.append(...extra);

  return card;
}

/**
 * A record as a card shows it. Where the card speaks for several records of one account,
 * `links` names every one not yet revoked, whether or not it is shown, so removing the
 * account removes them all and none is left to take the card up again.
 */
export type Account = Evidence & {
  links?: string[];
  /**
   * The records as they were read, where a card is drawn from more than one: what it says
   * is put together from all of them, and each has a signed record of its own.
   */
  sources?: Evidence[];
};

/**
 * How a holder may have an account listed: the one to lead with, an ordinary one, one they
 * no longer use, or one that is finished and kept only as history.
 */
export type Listing = 'preferred' | 'current' | 'unused' | 'retired';

/**
 * What the holder of the accounts shown may do from the dialog, where the page that drew
 * the badge said its reader is that holder.
 */
export interface Manage {
  /** Opens what connects an account, in this dialog's place. Given a provider, starts on it. */
  connect(provider?: string): void;
  /**
   * Opens what renews the record named, in this dialog's place: the same account shown
   * again, which extends that record under its id. `method` is the one method that may.
   * Absent where the page gave no way to, and Renew then connects on the provider.
   */
  renew?(id: string, provider: string, method?: string): void;
  /** Removes the links named. Rejects if any could not be removed. */
  remove(ids: string[]): Promise<void>;
  /**
   * Lists the account one link names as asked, every record of it at once. Rejects if it
   * could not be. Absent where the page gave no way to, and the card then offers none.
   */
  mark?(id: string, as: Listing): Promise<void>;
}

/** What the holder is told before an account is retired, since it cannot be undone from here. */
const retiringNote =
  'Retiring keeps this record as history. It will no longer read as verified, and who can read it cannot be changed afterwards.';

/**
 * The links removing an account would remove. The record shown may itself be revoked while
 * older ones of the account are not, and those must stay removable, so this is not read
 * from the status on the card.
 */
const removable = (evidence: Account) =>
  evidence.links ?? (evidence.status === 'revoked' ? [] : [evidence.id]);

/**
 * Everything a holder may do to an account besides renewing it, behind one button. The
 * menu is a popover, so it is drawn above the dialog and the dialog's scrolling cannot
 * clip it, the browser shuts it on Escape or a press elsewhere, and its button opens and
 * shuts it. Nothing where the browser has no popovers, and the choices are then laid out.
 */
function actionsMenu(more: HTMLButtonElement, choices: HTMLElement[]): HTMLElement | undefined {
  const menu = node('div', '', 'menu');

  if (typeof menu.showPopover !== 'function') return undefined;

  const label = 'More actions';

  more.className = 'action dots';
  more.title = label;
  more.setAttribute('aria-label', label);
  more.setAttribute('aria-haspopup', 'menu');
  more.append(moreMark());
  more.popoverTargetElement = menu;

  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');

  for (const choice of choices) choice.setAttribute('role', 'menuitem');

  // Whatever removes the account sits last and apart from the rest.
  menu.append(...choices.slice(0, -1), node('hr'), choices.at(-1)!);

  const shut = () => {
    try {
      if (menu.matches(':popover-open')) menu.hidePopover();
    } catch {
      // Gone from the page with its card.
    }
  };

  const gap = 4;
  const edge = 8;

  // Under the button and ending where it ends, before it is first painted.
  menu.addEventListener('beforetoggle', (event) => {
    if ((event as ToggleEvent).newState !== 'open') return;

    const at = more.getBoundingClientRect();

    menu.style.top = `${at.bottom + gap}px`;
    menu.style.right = `${document.documentElement.clientWidth - at.right}px`;
  });

  menu.addEventListener('toggle', (event) => {
    if ((event as ToggleEvent).newState !== 'open') return;

    // Over the button where the window ends before the menu does.
    const { height, bottom } = menu.getBoundingClientRect();

    if (bottom > innerHeight - edge)
      menu.style.top = `${Math.max(edge, more.getBoundingClientRect().top - gap - height)}px`;

    // It does not follow its button, so it does not stay open once the button moves.
    menu.closest('dialog')?.addEventListener('scroll', shut, { once: true });
    choices[0]!.focus();
  });

  menu.addEventListener('click', shut);

  menu.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];

    if (!step) return;

    event.preventDefault();

    const at = choices.indexOf(event.target as HTMLElement);

    choices[(at + step + choices.length) % choices.length]!.focus();
  });

  return menu;
}

/**
 * Under a holder's own account: renewing it, which is showing the same account again, and
 * removing it, which asks once more before it does. A removed link has nothing left to do.
 *
 * An account still in use can also be listed another way, or retired, which asks first as
 * removing does. Those and removing it are then kept in a menu beside Renew, so the row
 * stays one line. A retired one is renewed or removed and nothing else.
 */
function manageRow(evidence: Account, manage: Manage) {
  const row = node('div', '', 'row');

  const act = (label: string, danger = false) => {
    const control = node('button', label, danger ? 'action danger' : 'action');

    control.type = 'button';

    return control;
  };

  const [named] = removable(evidence);
  const { mark } = manage;

  // A mark is the account's, set through any one of its links that still stands.
  const listable =
    mark !== undefined && named !== undefined && !['revoked', 'retired'].includes(evidence.status);

  /** A control that lists the account one way, and says so if that did not go through. */
  const list = (label: string, as: Listing) => {
    const control = act(label);

    control.onclick = async () => {
      for (const other of row.children) (other as HTMLButtonElement).disabled = true;

      try {
        await mark!(named!, as);
      } catch {
        offer('That did not go through.');
      }
    };

    return control;
  };

  const offer = (note = '') => {
    const renew = act('Renew');
    const remove = act('Remove', true);

    // The record the card is drawn from is the one renewed. A retired one comes back by the
    // method it was first shown by alone, and a removed one cannot be renewed at all, so
    // the account behind it is connected again.
    renew.onclick = () =>
      manage.renew && evidence.status !== 'revoked'
        ? manage.renew(
            evidence.id,
            evidence.provider,
            evidence.status === 'retired' ? evidence.attestations.external[0].method : undefined,
          )
        : manage.connect(evidence.provider);

    remove.onclick = confirm;

    const listing: HTMLElement[] = [];

    if (listable) {
      const retire = act('Retire');

      retire.onclick = retiring;

      listing.push(
        ...(evidence.mark === 'preferred' ? [] : [list('Mark as preferred', 'preferred')]),
        ...(evidence.mark === 'unused' ? [] : [list('Mark as unused', 'unused')]),
        ...(evidence.mark === undefined ? [] : [list('Mark as current', 'current')]),
        retire,
      );
    }

    const said = note ? [node('span', note, 'muted')] : [];
    const more = act('');
    // Two buttons need no menu between them.
    const menu = listing.length ? actionsMenu(more, [...listing, remove]) : undefined;

    if (menu) row.replaceChildren(renew, more, menu, ...said);
    else row.replaceChildren(renew, ...listing, remove, ...said);
  };

  const retiring = () => {
    const cancel = act('Cancel');
    const sure = list('Retire', 'retired');

    cancel.onclick = () => offer();
    row.replaceChildren(node('span', retiringNote, 'muted'), cancel, sure);
    cancel.focus();
  };

  const confirm = () => {
    const cancel = act('Cancel');
    const sure = act('Remove', true);

    cancel.onclick = () => offer();

    sure.onclick = async () => {
      cancel.disabled = sure.disabled = true;

      try {
        await manage.remove(removable(evidence));
      } catch {
        offer('That did not go through.');
      }
    };

    row.replaceChildren(
      node(
        'span',
        // Removing stops new signed records. One already saved goes on checking.
        evidence.signedUrl
          ? 'Remove this link? Signed records already saved still check.'
          : 'Remove this link?',
        'muted',
      ),
      cancel,
      sure,
    );

    cancel.focus();
  };

  offer();

  return row;
}

/**
 * Checks every record a card speaks for. A card may be drawn from several records of one
 * account, and what it says of a signature answers for all of them.
 */
function signatures(evidence: Account): Promise<Signature[]> {
  return Promise.all(
    (evidence.sources ?? [evidence]).map((source): Promise<Signature> =>
      source.signedUrl === undefined
        ? Promise.resolve({ state: 'unchecked', why: 'unreadable' })
        : signature(source),
    ),
  );
}

/**
 * Says a record is signed, in a word beside its verifier. The word opens the verifier's
 * own page for the record at what it says of the signature, where the signed record is to be
 * had: nothing is downloaded from the card. The signed record is checked here against the
 * verifier's keys: a tick once it has checked, and a warning in the word's place if it
 * fails, the one thing on a card that is a warning. `warned` is told each time that warning
 * is drawn, on the first check or on a later one, so whatever folds the card away opens.
 */
function signedMark(evidence: Account, later: Later, warned: () => void) {
  const mark = node('span');
  const link = outward(node('a', 'signed'), `${evidence.evidenceUrl}#signed`);
  const see = 'See the signature (opens in a new tab)';

  const settle = (results: Signature[]) => {
    const first = results[0];

    if (results.some((result) => result.state === 'invalid')) {
      const warning = node('span', 'invalid signature', 'bad');

      warning.setAttribute('role', 'alert');
      // What it means, for a reader who has never met a signature, kept off the card.
      warning.title = `This record does not match the signature ${evidence.verifierName} put on it, so it may have been altered. Do not rely on it.`;
      mark.replaceChildren(document.createTextNode(' · '), warning);
      warned();

      return;
    }

    if (first?.state === 'valid' && results.every((result) => result.state === 'valid')) {
      link.textContent = 'signed ✓';
      // Names where the keys came from, which is what the tick answers for.
      link.title = `Signature checked in this browser against the keys ${new URL(evidence.evidenceUrl).host} publishes (key ${first.keyId}). ${see}`;
      mark.replaceChildren(document.createTextNode(' · '), link);

      return;
    }

    // No verdict was reached. The record is signed and says so, with a warning beside the
    // word in place of a tick, and why is said on hover. A check that only ran out of time
    // or could not read what it needed is made again when the dialog next reads.
    const why = results.find((result) => result.state === 'unchecked');

    const reason =
      why?.state === 'unchecked' && why.why === 'timeout'
        ? 'Signature check timed out, retrying.'
        : `The signature could not be read${why ? ', retrying' : ''}.`;

    const caution = node('span', '', 'caution');

    caution.title = reason;
    caution.setAttribute('role', 'img');
    caution.setAttribute('aria-label', reason);
    caution.append(cautionMark());
    link.textContent = 'signed';
    link.title = `${reason} ${see}`;
    mark.replaceChildren(document.createTextNode(' · '), link, caution);

    if (why) later(() => void signatures(evidence).then(settle));
  };

  // Nothing is said until the check comes back: the card is veiled until then.
  void signatures(evidence).then(settle);

  return mark;
}

/** A small warning triangle, drawn so it looks the same wherever the dialog is shown. */
function cautionMark(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of ['M8 2.2 14.3 13.3H1.7Z', 'M8 6.6v3.2', 'M8 11.6v.1']) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }

  return svg;
}

/**
 * Asks for something to be done when the dialog next reads its records. A card is drawn
 * once and kept, so this is how one that could not check a signature tries again.
 */
type Later = (retry: () => void) => void;

/** A card's dates folded away: whether they start open, and who to tell once that changes. */
interface Fold {
  open: boolean;
  toggle(open: boolean): void;
}

/**
 * Opens and shuts what a card folds away: how its account was shown, every method of it
 * together so that none is put ahead of another, and its dates.
 */
function foldToggle(folded: HTMLElement[], fold: Fold) {
  const toggle = node('button', '', 'fold');
  let shown = fold.open;

  const set = (open: boolean) => {
    shown = open;

    for (const part of folded) part.hidden = !open;

    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.type = 'button';
  toggle.append(foldMark(), document.createTextNode('Details'));
  set(fold.open);

  toggle.onclick = () => {
    set(!shown);
    fold.toggle(shown);
  };

  return toggle;
}

/**
 * One linked account: its state, how it was shown and when, on a card of its own. A
 * subject with several accounts gets one of these each, since a provider authenticates and
 * expires on its own terms and none of that may be read across to another's card.
 *
 * Given a `fold`, the card is one of several, read first as a list of accounts: it keeps
 * how it was shown and its dates behind a toggle, which shares a line with what the holder
 * may do. Its state, its verifier and what is said of its signature are never folded.
 * Alone, it shows everything.
 */
function externalCard(
  evidence: Account,
  manage?: Manage,
  later: Later = () => {},
  fold?: Fold,
  warned: () => void = () => {},
) {
  const current = evidence.status === 'verified' && evidence.expiresAt > Date.now();
  const status = statusLabel(evidence, Date.now());
  const provider = evidence.providerName;
  const summary = node('div', '', 'summary');
  const copy = node('div');

  // The verifier is named and reachable: this record on the verifier's own domain is
  // what a reader checks the claim against, and a plain click on the pill opens this
  // dialog rather than that page, so the way there belongs here.
  const attribution = node('div', 'via: ', 'muted');

  // An unlisted record has no page a reader could open, so the verifier is named and
  // not linked: a link there would lead to a page that refuses them.
  if (evidence.visibility === 'public') {
    const verifier = outward(node('a', evidence.verifierName), evidence.evidenceUrl);

    verifier.title = `View this record at ${evidence.verifierName} (opens in a new tab)`;
    attribution.append(verifier);
  } else attribution.append(document.createTextNode(evidence.verifierName));

  if (evidence.signedUrl) attribution.append(signedMark(evidence, later, warned));

  copy.append(node('div', status, 'state'), attribution);

  const retired = evidence.status === 'retired';

  // A retired account claims nothing now, which is not the same as a claim that failed.
  summary.append(verificationMark(current ? 'current' : retired ? 'pending' : 'inactive'), copy);
  const dates = node('dl');
  const dateRows: [string, number][] = [['Approved', evidence.approvedAt]];

  if (evidence.status === 'revoked') {
    if (evidence.revokedAt !== undefined) dateRows.push(['Revoked on', evidence.revokedAt]);
  } else if (retired) {
    // Two rows, always, so a reader sees any gap between them: an account retired weeks
    // after it was last proved went unproved for those weeks.
    dateRows.push(['Last verified', lastProved(evidence)]);

    if (evidence.retiredAt !== undefined) dateRows.push(['Retired', evidence.retiredAt]);
  } else {
    // A proof that has gone unread has not reached its expiry, so it still reads forward.
    dateRows.push([
      evidence.expiresAt > Date.now() ? 'Valid until' : 'Expired on',
      evidence.expiresAt,
    ]);
  }

  // When an artifact was last read belongs with the other times, not inside a sentence.
  // Only artifact methods drift: a sign-in is established once and does not go stale.
  const main = evidence.attestations.external[0];

  if (main.artifactUrl && !retired) dateRows.push(['Last checked', main.confirmedAt]);

  for (const [label, time] of dateRows) {
    dates.append(node('dt', label), node('dd', moment(time)));
  }

  const names = { site: evidence.siteName, provider };
  const row = manage && removable(evidence).length ? [manageRow(evidence, manage)] : [];
  const bar = node('div', '', 'bar');

  const methods = [
    ...attestationNote(main, names),
    ...evidence.attestations.external.slice(1).flatMap((a) => attestationNote(a, names, true)),
  ];

  if (fold) bar.append(foldToggle([...methods, dates], fold), ...row);

  const logo = providerMark(evidence.provider, evidence.attestations.external[0].method);

  const card = accountCard(
    // The mark and the name, or just the name. A mark that falls back to writing the name
    // would print it twice here, since this heading writes it either way.
    logo ? [logo, document.createTextNode(provider)] : [document.createTextNode(provider)],
    externalName(evidence.external),
    // A mailbox's address or a domain is its name already, so there is no second identifier.
    externalId(evidence.external),
    externalLink(evidence.external),
    // Status first, then how it was shown, then when. The proof explains the state
    // above it, so it cannot sit before that state has been given.
    summary,
    ...(fold ? [] : methods),
    // How the holder lists the account, in their words and apart from how it was shown:
    // nothing checked it, so it is never among the methods above it.
    ...(evidence.status === 'revoked' || retired
      ? []
      : evidence.mark === 'preferred'
        ? [node('div', 'Preferred', 'listing preferred')]
        : evidence.mark === 'unused'
          ? [node('div', 'No longer used', 'listing')]
          : []),
    ...(fold ? [bar, ...methods, dates] : [dates, ...row]),
  );

  const surface = retired ? 'account retired' : 'account';

  card.className = surface;

  // A signed record is not read, or acted on, before its signature has been checked: until
  // the check comes back the whole card is veiled and out of reach, with a word over it
  // saying why. A record handed over altered is then never read as it was handed over.
  if (evidence.signedUrl) {
    const veiled = [...card.children] as HTMLElement[];
    const checking = node('div', '', 'checking');

    checking.setAttribute('role', 'status');
    checking.append(node('span', '', 'spinner'), document.createTextNode('Checking signature…'));
    card.className = `${surface} veiled`;

    for (const part of veiled) part.inert = true;

    card.append(checking);

    void signatures(evidence).then(() => {
      card.className = surface;

      for (const part of veiled) part.inert = false;

      checking.remove();
    });
  }

  return card;
}

/** Under the holder's accounts: the way to connect another, ahead of the closing note. */
function addRow(manage: Manage) {
  const add = node('button', 'Add account', 'action');
  const row = node('div', '', 'row');

  add.type = 'button';
  add.onclick = () => manage.connect();
  row.append(add);

  return row;
}

/**
 * What a reader has opened in a dialog, kept apart from its cards: they are drawn afresh
 * whenever a record changes, and would otherwise shut under whoever was reading them.
 */
interface Folds {
  /** Whether a card starts open, which the page that drew the badge may ask for. */
  open: boolean;
  /** The accounts a reader has turned the other way, each named by its provider and id. */
  cards: Set<string>;
  /** Whether the retired group is open, once a reader has opened or shut it. */
  retired?: boolean;
}

/**
 * The subject once, then each account linked to it on its own card, in the order given.
 * Retired accounts sit in a group of their own at the foot, under what says they are,
 * shut until it is opened unless no other account is left to read. Every record given is
 * of the one subject, which the caller has checked.
 */
function render(
  content: HTMLElement,
  records: Account[],
  manage?: Manage,
  later?: Later,
  folds: Folds = { open: false, cards: new Set() },
) {
  const [first] = records as [Account, ...Account[]];

  // Each card says what it is. Without that the pair is two unlabelled boxes.
  const local = localSide(first.local, first.siteName);

  const localCard = accountCard(
    [document.createTextNode(local.heading)],
    local.value,
    // The heading names the site and the label names the subject, so the site's own
    // reference adds a third line saying the same thing. The provider id on the other
    // card stays: that one is the provider's identifier, not the site's own wording.
    undefined,
    first.local.profileUrl,
    ...attestationNote(first.attestations.local, {
      site: first.siteName,
      provider: first.providerName,
    }),
  );

  const retired = records.filter((record) => record.status === 'retired');
  const listed = records.filter((record) => record.status !== 'retired');

  // A card alone in its group has room for its dates. Among others it folds them.
  const cards = (among: Account[], warned?: () => void) =>
    among.map((record) => {
      const key = `${record.provider}\n${record.external.id}`;

      return externalCard(
        record,
        manage,
        later,
        among.length > 1
          ? {
              open: folds.cards.has(key) !== folds.open,
              toggle: (open) =>
                void (open === folds.open ? folds.cards.delete(key) : folds.cards.add(key)),
            }
          : undefined,
        warned,
      );
    });

  const history = node('details', '', 'history');
  const count = node('summary', '', 'group');

  count.append(foldMark(), document.createTextNode(`Retired accounts (${retired.length})`));

  // A signature that fails is a warning, and a warning is not left behind a fold.
  history.append(
    count,
    ...cards(retired, () => {
      history.open = true;
    }),
  );

  // Shut to keep history out of the way of the accounts in use. With none of those there
  // is nothing else to read, so it starts open.
  history.open = folds.retired ?? !listed.length;

  // Pressing the heading is the reader's choice, and is kept. It is heard before the
  // group turns, so what it will be is the opposite of what it is.
  count.addEventListener('click', () => {
    folds.retired = !history.open;
  });

  content.replaceChildren(
    localCard,
    linkMark(),
    ...cards(listed),
    ...(manage ? [addRow(manage)] : []),
    ...(retired.length ? [history] : []),
    // Nothing below the cards may name a provider. Approval, method and dates belong to
    // the card they came from, and a second provider on this subject gets its own card.
    node(
      'p',
      'Verification does not guarantee legal identity, trustworthiness, or permanent ownership.',
      'muted explanation',
    ),
  );
}

/**
 * Fetch fresh, permitted evidence; native dialog supplies focus containment and Escape
 * dismissal. `opened` is the record the opener already holds: the dialog is drawn from it
 * before it is shown, so it appears at the size it will keep rather than growing into its
 * own contents, and the check that follows either leaves it alone or replaces it.
 */
export function openEvidenceDialog(
  opener: HTMLElement,
  load: () => Promise<Evidence | Evidence[]>,
  opened?: Evidence | Evidence[],
  /**
   * Turns the records held into the cards drawn, each time they are drawn. The dialog
   * keeps the records as they were read and arranges them afresh at every deadline: which
   * record speaks for an account depends on which are still good, and that changes with
   * the clock, not only with what is read.
   */
  arrange: (records: Evidence[]) => Account[] = (records) => records,
  /**
   * Given where whoever is looking holds these accounts: each then has its renewal and
   * removal under it, and the dialog offers to connect another.
   */
  manage?: Manage,
  /**
   * Whether the cards of several accounts start with their details open. They start shut
   * unless the page asked otherwise, and a reader may turn each either way from there.
   */
  detailsOpen = false,
): void {
  const existing = openDialogs.get(opener);

  if (existing?.open) {
    existing.focus();

    return;
  }

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();

  sheet.replaceSync(styles);
  root.adoptedStyleSheets = [sheet];
  const dialog = node('dialog');
  const heading = node('h2', 'Verification details');
  const close = node('button', '', 'icon');
  // Every account on a page of its own, on the verifier. It sits by the heading it widens,
  // and only where there is more than one account to list.
  const all = node('a', '', 'all');
  const title = node('div', '', 'title');
  const header = node('header');
  // What drew the record, under it. The record is about the pair, not about us.
  const stamp = node('footer');
  const content = node('div', 'Checking verification…');

  heading.id = 'verily-dialog-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  close.type = 'button';
  close.setAttribute('aria-label', 'Close verification details');
  content.setAttribute('aria-live', 'polite');
  stamp.append(stampLink(), node('span', version));
  all.append(awayMark());
  close.append(closeMark());
  // The close was the first thing in the dialog to take the focus, and still is.
  close.autofocus = true;
  title.append(heading);
  header.append(title, close);
  dialog.append(header, content, stamp);

  /** Links removed from this dialog, shown as removed before the page hands over new records. */
  const removed = new Map<string, number>();

  /**
   * How accounts were listed from this dialog, in the order it was asked, shown as asked
   * before the page hands over new records: each names every link of its account, and
   * holds how those links read when it was asked. Once any of them reads differently the
   * backend has spoken, for this change or a later one made elsewhere, and what it says
   * is shown from then on.
   */
  const listed: { ids: string[]; as: Listing; at: number; before: Map<string, string> }[] = [];

  /** What of a record a listing, a retirement or a renewal changes. */
  const listing = (record: Evidence) =>
    JSON.stringify([record.status, record.mark, record.retiredAt, record.approvedAt]);

  /** How each record given reads now, by its id. */
  const listings = (given: Evidence | Evidence[]) =>
    new Map([given].flat().map((record) => [record.id, listing(record)]));

  let held: Evidence | Evidence[] | undefined;

  /** What has been opened in this dialog, which outlasts every redraw of its cards. */
  const folds: Folds = { open: detailsOpen, cards: new Set() };

  /** A record as the listings made here leave it, each applied as the backend applies it. */
  const relisted = (evidence: Evidence): Evidence => {
    let record = evidence;

    for (const { ids, as, at } of listed) {
      if (['revoked', 'retired'].includes(record.status)) break;

      if (!ids.includes(record.id)) {
        // One preferred account for a holder: picking another moves the mark.
        if (as === 'preferred' && record.mark === 'preferred')
          record = { ...record, mark: undefined };

        continue;
      }

      record =
        as === 'retired'
          ? // Its signed form is another document now, to be read with the records to come.
            { ...record, status: 'retired', retiredAt: at, mark: undefined, signedUrl: undefined }
          : { ...record, mark: as === 'current' ? undefined : as };
    }

    return record;
  };

  const actions: Manage | undefined = manage && {
    // The other dialog opens over this one before this one goes, so the page behind is
    // never uncovered between the two.
    connect(provider) {
      manage.connect(provider);
      dialog.close();
    },
    ...(manage.renew
      ? {
          renew(id: string, provider: string, method?: string) {
            manage.renew!(id, provider, method);
            dialog.close();
          },
        }
      : {}),
    async remove(ids) {
      await manage.remove(ids);

      for (const id of ids) removed.set(id, Date.now());

      if (held && dialog.open) draw(held);
    },
    ...(manage.mark
      ? {
          async mark(id: string, as: Listing) {
            await manage.mark!(id, as);

            // Every link of the account the one named belongs to, as the cards group them.
            const account = arrange([held ?? []].flat()).find((card) =>
              removable(card).includes(id),
            );

            listed.push({
              ids: account ? removable(account) : [id],
              as,
              at: Date.now(),
              before: listings(held ?? []),
            });

            if (held && dialog.open) draw(held);
          },
        }
      : {}),
  };

  root.append(dialog);
  document.body.append(host);
  openDialogs.set(opener, dialog);

  let refreshing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let drawn: string | undefined;

  /** What the cards on screen have asked to try again at the next read. */
  const retries = new Set<() => void>();

  /** Redraws only for a record that reads differently from the one already on screen. */
  const draw = (given: Evidence | Evidence[]) => {
    held = given;

    const now = listings(given);

    for (const change of [...listed])
      if (change.ids.some((id) => now.get(id) !== change.before.get(id)))
        listed.splice(listed.indexOf(change), 1);

    const records = arrange(
      [given]
        .flat()
        .map((e) =>
          removed.has(e.id) && e.status !== 'revoked'
            ? { ...e, status: 'revoked' as const, revokedAt: removed.get(e.id) }
            : relisted(standing(e)),
        ),
    );

    const listable = records.filter((e) => e.visibility === 'public' && e.status !== 'revoked');

    // In the header only while it leads somewhere: an anchor with no address is not a link.
    title.replaceChildren(heading, ...(listable.length > 1 ? [all] : []));

    if (listable.length > 1) {
      const label = `View all on ${listable[0]!.verifierName} (opens in a new tab)`;

      outward(all, subjectUrl(listable[0]!));
      all.title = label;
      all.setAttribute('aria-label', label);
    }

    const key = JSON.stringify(records.map((e) => [e, statusLabel(e, Date.now())]));

    if (key === drawn) return;

    drawn = key;
    // The cards are new, and what the old ones were waiting to try again went with them.
    retries.clear();
    render(content, records, actions, (retry) => retries.add(retry), folds);
  };

  /**
   * Redraws at the moment the next record runs out, where that comes before the next check
   * would notice, and then waits on the one after. Each account reaches its own deadline,
   * so with several the first must not be the only one that is watched.
   */
  const watch = (given: Evidence | Evidence[]) => {
    clearTimeout(expiryTimer);

    const remaining = Math.min(
      ...[given]
        .flat()
        .filter((e) => e.status === 'verified' && e.expiresAt > Date.now())
        .map((e) => e.expiresAt - Date.now()),
    );

    if (remaining > 30000) return;

    expiryTimer = setTimeout(() => {
      if (!dialog.open) return;

      draw(given);
      watch(given);
    }, remaining);
  };

  const refresh = async () => {
    if (refreshing) return;

    refreshing = true;

    try {
      const evidence = await load();

      if (!dialog.open) return;

      draw(evidence);
      watch(evidence);
    } catch {
      clearTimeout(expiryTimer);
      drawn = undefined;

      if (dialog.open)
        content.replaceChildren(
          node('p', 'Verification unavailable. Please close this dialog and try again.'),
        );
    } finally {
      refreshing = false;
    }
  };

  const interval = setInterval(() => {
    // A signature that could not be checked last time is checked again with each read.
    for (const retry of [...retries]) {
      retries.delete(retry);
      retry();
    }

    void refresh();
  }, 30000);

  // A check that comes back while the dialog is open may change what a card is drawn from.
  const unwatch = onSignatureResult(() => {
    if (held && dialog.open) draw(held);
  });

  close.addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();

    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close();
  });

  dialog.addEventListener(
    'close',
    () => {
      clearInterval(interval);
      clearTimeout(expiryTimer);
      unwatch();
      openDialogs.delete(opener);
      host.remove();

      opener.firstElementChild?.shadowRoot
        ?.querySelector<HTMLElement>('a, button, [tabindex]')
        ?.focus();
    },
    { once: true },
  );

  if (opened && [opened].flat().length) draw(opened);

  dialog.showModal();
  void refresh();
}
