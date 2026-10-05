import { externalName, statusLabel, type Evidence } from '../core/index.js';
import { clockMark, dashMark, markStyles, paintMark, verificationMark } from './mark.js';
import { providerMark } from './provider-mark.js';

const styles = `
  :host { display: inline-block; max-width: 100%; vertical-align: middle; }
  * { box-sizing: border-box; }
  .badge, .peek {
    border: 1px solid var(--verily-border, #dce2e0); border-radius: 6px;
    background: var(--verily-surface, #fff); color: var(--verily-text, #202c29);
    font: var(--verily-font-size, 13px)/1.35
      var(--verily-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 5px;
    text-decoration: none;
  }
  button.badge { margin: 0; cursor: pointer; }
  a[href]:hover, button.badge:hover { background: var(--verily-hover, #f3f6f4); border-color: var(--verily-border, #dce2e0); }
  .badge:focus-visible { outline: 2px solid #357ce5; outline-offset: 2px; }
  .name { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .more { flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--verily-muted, #65726c); }
  .label { display: none; font-size: 11px; color: var(--verily-muted, #65726c); }
  .badge:hover .label, .badge:focus-within .label { display: inline; }
  .icon { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; font-size: 12px; font-weight: 750; }
  .icon .glyph { display: block; width: 12px; height: 12px; }
  .mark { display: block; flex-shrink: 0; width: 20px; height: 20px; }
  .mark.pending { opacity: .45; }
  /* A dim ring where the account will go; it only spins where motion is welcome. */
  .spinner {
    flex-shrink: 0; width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid currentColor; opacity: .3;
  }
  .divider { flex-shrink: 0; width: 1px; height: 12px; background: var(--verily-border, #dce2e0); }
  /* Several accounts, one to a row. The mark stays beside them and the rule runs their height. */
  .badge.stacked { align-items: stretch; padding: 5px 8px 5px 6px; text-align: left; }
  .stacked .mark { align-self: center; }
  .stacked .divider { height: auto; }
  .rows { display: grid; gap: 4px; min-width: 0; }
  .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  /*
   * The accounts behind a short pill's count, opened beside it. Shut unless the browser
   * has it open as a popover, so one without popovers never shows it at all.
   */
  .peek {
    display: none; position: fixed; inset: auto; margin: 0; padding: 8px 10px;
    width: max-content; max-width: min(320px, calc(100vw - 16px));
    border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .14); pointer-events: none;
    overflow: hidden;
  }
  /* A row taken out to fit the window: its own display would otherwise keep it showing. */
  .row[hidden] { display: none; }
  .peek:popover-open { display: block; }
  .peek .via { display: block; margin-top: 6px; font-size: 11px; color: var(--verily-muted, #65726c); }
  .provider { display: block; flex-shrink: 0; width: 14px; height: 14px; }
  .expired .icon { color: #815a12; background: #fbefce; }
  .revoked .icon, .message .icon { color: #626d69; background: #edf0ee; }
  .message { color: var(--verily-muted, #65726c); }
  .add { font-weight: 600; }
  @media (prefers-reduced-motion: no-preference) {
    a, button { transition: background .12s, border-color .12s; }
    /* The mark is drawn before the answer arrives, so it resolves rather than swaps. */
    .mark, .mark path { transition: opacity .18s ease, stroke .18s ease; }
    .spinner { border-top-color: transparent; opacity: .4; animation: verily-spin .7s linear infinite; }
  }
  @keyframes verily-spin { to { transform: rotate(360deg); } }
  ${markStyles}
`;

/** Built once: a re-render adopts the same sheet rather than reparsing the CSS. */
let sheet: CSSStyleSheet | undefined;

interface Frame {
  host: HTMLElement;
  root: ShadowRoot;
  pill?: HTMLElement;
  mark?: SVGSVGElement;
  /** The panel a short pill opens beside itself, and what shuts it, while it has one. */
  peek?: HTMLElement;
  quiet?: () => void;
}

/** The shadow host already built inside an element, kept so refreshes reuse it. */
const frames = new WeakMap<HTMLElement, Frame>();

/** Marks the waiting pill, which shows no message of its own. */
const pendingKey = '\u0000pending';

/** What each host currently shows, so an unchanged refresh can leave it alone. */
const shown = new WeakMap<HTMLElement, string>();
const messages = new WeakMap<HTMLElement, string>();

function badgeSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
  }

  return sheet;
}

/**
 * The pill to draw into, emptied and ready. Everything that survives a state change is
 * kept: the shadow root and its styles, the pill box itself, and the mark inside it. A
 * badge that was pending and is now verified therefore resolves in place, rather than
 * being torn down and built again where the reader can see it happen.
 */
function frame(
  element: HTMLElement,
  state: string,
  button = false,
): { pill: HTMLElement; mark: SVGSVGElement } {
  let frame = frames.get(element);

  shown.delete(element);
  messages.delete(element);

  if (frame?.host.parentNode !== element) {
    const host = document.createElement('span');
    const root = host.attachShadow({ mode: 'open' });

    root.adoptedStyleSheets = [badgeSheet()];
    frame = { host, root };
    frames.set(element, frame);
    element.replaceChildren(host);
  }

  const tag = state === 'message' ? 'span' : state === 'connect' || button ? 'button' : 'a';

  if (!frame.pill || frame.pill.tagName.toLowerCase() !== tag) {
    frame.pill = document.createElement(tag);
    frame.mark = undefined;
    frame.root.replaceChildren(frame.pill);
  }

  for (const attribute of [
    'href',
    'rel',
    'title',
    'tabindex',
    'role',
    'aria-label',
    'aria-haspopup',
  ])
    frame.pill.removeAttribute(attribute);

  // A panel belongs to the pill it was drawn for, so it goes with what that pill showed.
  frame.quiet?.();
  frame.quiet = undefined;
  frame.peek?.remove();
  frame.peek = undefined;

  frame.pill.onclick =
    frame.pill.onpointerenter =
    frame.pill.onpointerleave =
    frame.pill.onpointerdown =
    frame.pill.onfocus =
    frame.pill.onblur =
    frame.pill.onkeydown =
      null;

  frame.pill.className = `badge ${state}`;
  frame.mark ??= verificationMark('pending');

  // The mark stays where it is, as the pill's first child: a node taken out and put back
  // is styled afresh, and its colours would jump rather than resolve. Callers append what
  // follows it.
  if (frame.mark.parentNode !== frame.pill) frame.pill.replaceChildren(frame.mark);
  else while (frame.mark.nextSibling) frame.mark.nextSibling.remove();

  return { pill: frame.pill, mark: frame.mark };
}

/**
 * Whether what this host was last given is still in it. A page that empties the host
 * itself gets a badge drawn again rather than one skipped as already shown.
 */
function intact(element: HTMLElement): boolean {
  const frame = frames.get(element);

  return frame?.host.parentNode === element && frame.pill?.parentNode === frame.root;
}

/** Whether a host is currently presenting a badge of its own. */
export function badgeShown(element: HTMLElement): boolean {
  return intact(element) && shown.has(element);
}

/** Everything the pill draws: equal keys mean an identical pill. */
function renderKey(
  evidence: Evidence,
  current: boolean,
  label: string,
  more: number,
  linked: boolean,
  rows: Evidence[],
  peek: boolean,
): string {
  return JSON.stringify([
    more,
    linked,
    peek,
    rows.map((row) => [row.provider, row.providerName, externalName(row.external)]),
    evidence.provider,
    evidence.providerName,
    externalName(evidence.external),
    evidence.evidenceUrl,
    evidence.verifierName,
    evidence.local.label,
    evidence.status,
    current,
    label,
  ]);
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');

  element.className = className;
  element.textContent = text;

  return element;
}

/**
 * The pill before there is anything to say in it: its own frame and mark, drawn in the
 * page's text colour because no verification has been read yet, and a spinner standing in
 * for the account this is about. Nothing here is replaced when the answer arrives.
 */
export function renderBadgePending(element: HTMLElement): void {
  if (intact(element) && messages.get(element) === pendingKey) return;

  const { pill, mark } = frame(element, 'pending');

  paintMark(mark, 'pending');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-label', 'Checking verification');
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  const spinner = span('spinner', '');

  spinner.setAttribute('aria-hidden', 'true');
  pill.append(divider, spinner);
  messages.set(element, pendingKey);
}

export function renderBadgeMessage(element: HTMLElement, message: string): void {
  if (intact(element) && messages.get(element) === message) return;

  const { pill, mark } = frame(element, 'message');

  paintMark(mark, 'inactive');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-label', message);
  const icon = span('icon', '');

  icon.append(dashMark());
  icon.setAttribute('aria-hidden', 'true');
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  pill.append(divider, span('label', message), icon);
  messages.set(element, message);
}

/**
 * Draws the pill, or returns null when the host already shows exactly this evidence:
 * a periodic refresh that changes nothing must not disturb what is on screen.
 *
 * `more` is how many other accounts of the same subject stand behind the one shown, said
 * as a count beside it. `linked` is whether the record has a page of its own a reader can
 * open: an unlisted one has none, so its pill is a button and never a link to nowhere.
 *
 * `rows` are those of the other accounts to name, in order. Stacked, each has a row of
 * its own in the pill, which is then as tall as its rows. Otherwise the pill stays short
 * and, with `peek`, names them in a panel that opens beside it while a pointer rests on it
 * or the keyboard is on it. Either way the accounts past the rows are a count.
 */
export function renderBadge(
  element: HTMLElement,
  evidence: Evidence,
  {
    more = 0,
    linked = true,
    rows = [],
    peek = false,
  }: { more?: number; linked?: boolean; rows?: Evidence[]; peek?: boolean } = {},
): HTMLElement | null {
  const provider = evidence.providerName;
  const current = evidence.status === 'verified' && evidence.expiresAt > Date.now();
  const state = current ? 'verified' : evidence.status === 'revoked' ? 'revoked' : 'expired';

  const label = statusLabel(evidence, Date.now());

  const key = renderKey(evidence, current, label, more, linked, rows, peek);

  if (intact(element) && shown.get(element) === key) return null;

  const handle = externalName(evidence.external);
  const { pill: badge, mark } = frame(element, state, !linked);
  const unnamed = Math.max(more - rows.length, 0);

  const named = rows.map((row) => `, ${row.providerName} ${externalName(row.external)}`).join('');
  const others = `${named}${unnamed ? ` and ${unnamed} more` : ''}`;

  paintMark(mark, current ? 'current' : 'inactive');

  if (linked) {
    (badge as HTMLAnchorElement).href = evidence.evidenceUrl;
    (badge as HTMLAnchorElement).rel = 'noreferrer';
  } else (badge as HTMLButtonElement).type = 'button';

  badge.setAttribute(
    'aria-label',
    `${provider} ${handle}${others}: ${label} | via: ${evidence.verifierName} | inspect verification`,
  );

  const peeked = peek && rows.length > 0;

  // The provider and handle are already visible in the pill itself. A pill with a panel
  // says the rest there, and a tooltip of the browser's own would only sit on top of it.
  if (!peeked)
    badge.title = `${label} | via: ${evidence.verifierName} | Inspect verification for ${evidence.local.label}`;

  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');

  // A provider with no mark of its own is named instead, so the pill never drops it.
  const account = (shown: Evidence) => [
    providerMark(shown.provider, shown.attestations.external[0].method) ??
      span('name', shown.providerName),
    span('name', externalName(shown.external)),
  ];

  /** The account shown and those named after it, one to a row, then the rest as a count. */
  const list = () => {
    const listed = span('rows', '');

    for (const shown of [evidence, ...rows]) {
      const row = span('row', '');

      row.append(...account(shown));
      listed.append(row);
    }

    if (unnamed) listed.append(span('row more', `+${unnamed} more`));

    return listed;
  };

  if (rows.length && !peek) {
    badge.className += ' stacked';
    badge.append(divider, list());
  } else {
    badge.append(divider, ...account(evidence));

    // The accounts behind the one shown, as a number. Each has its own card in the dialog.
    if (more) badge.append(span('more', `+${more}`));
  }

  if (!current) {
    const icon = span('icon', '');

    icon.append(state === 'expired' ? clockMark() : dashMark());

    icon.setAttribute('aria-hidden', 'true');
    badge.append(span('label', label), icon);
  }

  if (peeked) {
    const panel = document.createElement('div');

    panel.className = 'peek';
    // The pill's own label already names every account here, so this is for the eye only.
    panel.setAttribute('aria-hidden', 'true');
    const listed = list();

    panel.append(listed, span('via', `${label} | via: ${evidence.verifierName}`));
    peeks(element, badge, panel, listed, unnamed);
  }

  shown.set(element, key);

  return badge;
}

/**
 * Shuts a host's panel and lets go of what it was listening for. For a host leaving the
 * page: the browser shuts its popover then, but the wait for a scroll would stay behind.
 */
export function quietBadge(element: HTMLElement): void {
  frames.get(element)?.quiet?.();
}

/** How long a pointer rests on a pill before its panel opens, so passing over opens nothing. */
const peekDelayMs = 150;

/**
 * Opens a pill's panel while a mouse rests on it or the keyboard is on it, and shuts it
 * the moment either leaves, the pill is pressed, or the page scrolls from under it.
 *
 * The panel is a popover, so it is drawn above the page and no container of the host's
 * can clip it or sit over it. It takes no space in the page and nothing moves when it
 * opens. It cannot be pointed at: the pill is the one thing to press. A browser without
 * popovers never opens it, and the pill is then the short one it always was.
 */
function peeks(
  element: HTMLElement,
  pill: HTMLElement,
  panel: HTMLElement,
  listed: HTMLElement,
  unnamed: number,
) {
  const frame = frames.get(element)!;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Asked of the panel each time and never remembered: the browser shuts a popover when
  // its host leaves the page, and tells nobody.
  const open = () => panel.matches(':popover-open');

  // Everything is let go whether or not the panel is still open, for the same reason.
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    globalThis.removeEventListener?.('scroll', hide, true);

    try {
      if (open()) panel.hidePopover();
    } catch {
      // Gone from the page with its host.
    }
  };

  const show = () => {
    timer = undefined;

    if (typeof panel.showPopover !== 'function' || open()) return;

    try {
      panel.showPopover();
    } catch {
      return;
    }

    place(panel, pill, listed, unnamed);
    globalThis.addEventListener?.('scroll', hide, true);
  };

  panel.setAttribute('popover', 'manual');
  frame.root.append(panel);
  frame.peek = panel;
  frame.quiet = hide;

  // A finger has nowhere to rest: touching the pill presses it.
  pill.onpointerenter = (event) => {
    if (event.pointerType === 'touch') return;

    clearTimeout(timer);
    timer = setTimeout(show, peekDelayMs);
  };

  pill.onpointerleave = hide;
  pill.onpointerdown = hide;
  pill.onblur = hide;

  // Only where the keyboard put the focus: a click focuses the pill too, and opens the details.
  pill.onfocus = () => {
    if (pill.matches(':focus-visible')) show();
  };

  pill.onkeydown = (event) => {
    if (event.key === 'Escape') hide();
  };
}

/**
 * Puts an open panel just under its pill, or just over it where there is more room there,
 * and keeps all of it inside the window.
 *
 * A panel cannot be scrolled or pointed at, so whatever of it fell outside the window
 * could never be read. Where it is taller than the room it has, its last accounts are
 * taken out one at a time and added to the count beneath them, until it fits or one
 * account is left. Each opening starts again from every row, since the window may have
 * grown since the last. Whatever still does not fit is cut off at the window's edge.
 */
function place(panel: HTMLElement, pill: HTMLElement, listed: HTMLElement, unnamed: number) {
  const gap = 6;
  const edge = 8;
  const at = pill.getBoundingClientRect();
  const below = innerHeight - edge - (at.bottom + gap);
  const above = at.top - gap - edge;
  const rows = [...listed.children] as HTMLElement[];
  const accounts = rows.filter((row) => !row.className.includes('more'));
  let count = rows.find((row) => row.className.includes('more'));
  let dropped = 0;

  const recount = () => {
    const uncounted = unnamed + dropped;

    if (uncounted && !count) {
      count = span('row more', '');
      listed.append(count);
    }

    if (count) {
      count.textContent = `+${uncounted} more`;
      count.hidden = !uncounted;
    }
  };

  // The last opening's limit is lifted first. Left on, it would hold the panel to the
  // height that fitted then, and a panel measured under it always seems to fit.
  panel.style.maxHeight = '';

  for (const row of accounts) row.hidden = false;

  recount();

  // Under the pill unless only the room above will take it whole or is the larger.
  const under = panel.getBoundingClientRect().height <= below || below >= above;
  const room = Math.max(under ? below : above, 0);

  while (panel.getBoundingClientRect().height > room && dropped < accounts.length - 1) {
    dropped += 1;
    accounts[accounts.length - dropped]!.hidden = true;
    recount();
  }

  const size = panel.getBoundingClientRect();
  const height = Math.min(size.height, room);

  panel.style.maxHeight = `${room}px`;
  panel.style.top = `${under ? at.bottom + gap : at.top - gap - height}px`;
  panel.style.left = `${Math.max(edge, Math.min(at.left, innerWidth - edge - size.width))}px`;
}

/**
 * The pill that starts a connection, in the same frame as the badges it will produce. Its
 * mark claims nothing yet, so it is drawn in the text colour as a pending one is.
 */
export function renderConnectPill(element: HTMLElement): HTMLButtonElement {
  const { pill, mark } = frame(element, 'connect');
  const button = pill as HTMLButtonElement;

  paintMark(mark, 'pending');
  button.type = 'button';
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  button.append(divider, span('add', 'Verify an account'));
  messages.set(element, 'connect');

  return button;
}
