import {
  externalId,
  externalIdGroups,
  externalLink,
  externalName,
  externalSince,
  type ExternalAccount,
} from '../core/index.js';
import { logo } from '../logo.js';
import { markOf, pathAttributes, tones, verification, type MarkTone } from '../marks.js';
import { html, raw, type Html, type OptionalHtml } from './html.js';
import { styleVersion } from './style.js';

/**
 * The shell every Verily page shares: the stylesheet, the logotype and the heading. `variant`
 * is a class on the page's `main`, such as `single` for a page with one thing on it.
 * `script` is the path of one script the page runs. `mark` is drawn before the heading.
 */
export const page = (
  prefix: string,
  title: string,
  body: Html,
  variant = '',
  script = '',
  mark?: OptionalHtml,
) =>
  html`
    <!doctype html>
    <html lang="en">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${title} · Verily</title>
      <link rel="stylesheet" href="${prefix}/style.css?v=${styleVersion}">
      <body>
        <main${variant && html` class="${variant}"`}>
          ${raw(logo)}
          <h1>${mark}${title}</h1>
          ${body}
        </main>
        ${script && html`<script src="${script}" defer></script>`}
      </body>
    </html>
  `.markup;

/**
 * The V the badge draws for a record, in the tone that says how the record stands.
 * `cropped` fits the box to the strokes, for a V that has to meet the edges around it.
 */
export function verdict(tone: MarkTone, cropped = false): Html {
  const [first, second] = tones[tone];
  const stroke = raw('stroke-width="32" stroke-linejoin="miter"');

  const check = Object.entries(verification.check).map(
    ([name, value]) => html` ${raw(name)}="${value}"`,
  );

  return html`
    <svg
      class="verdict ${tone}"
      viewBox="${cropped ? verification.strokes : verification.viewBox}"
      fill="none"
      aria-hidden="true"
      focusable="false">
      <path d="${verification.path}" ${stroke} stroke="${first}"/>
      <path d="${verification.path}" ${stroke}${check} stroke="${second}"/>
    </svg>
  `;
}

/** A card's heading: its text, and the provider's mark before it where there is one. */
export type Heading = string | { text: string; mark: Html };

/** A provider's name with its mark, for a card's heading. */
export function marked(text: string, provider: string, method?: string): Heading {
  const mark = markOf(provider, method);

  if (!mark) return text;

  const attributes = pathAttributes(mark).map(([name, value]) => html` ${raw(name)}="${value}"`);

  return {
    text,
    mark: html`
      <svg
        class="provider"
        viewBox="${mark.viewBox}"
        fill="${mark.stroke ? 'none' : 'currentColor'}"
        aria-hidden="true"
        focusable="false">
        ${mark.paths.map((d) => html`<path d="${d}"${attributes}/>`)}
      </svg>
    `,
  };
}

/**
 * One side of a link, with each thing known about it on its own line. A name, the
 * identifier behind it and how it was shown are three separate claims, and a reader
 * running them together in one sentence is the way to misread which was established.
 *
 * Both sides render as the same card, so the pair reads as a pair.
 */
export function card(
  heading: Heading,
  name: string,
  url: string | undefined,
  reference?: string | string[],
  ...extra: OptionalHtml[]
) {
  return side(heading, name, url, reference, undefined, extra);
}

/**
 * The card for an external account: its name, link and id, with the "Joined <date>" text
 * on the name's line when the creation date is known.
 */
export function externalCard(
  heading: Heading,
  external: ExternalAccount,
  ...extra: OptionalHtml[]
) {
  return side(
    heading,
    externalName(external),
    externalLink(external),
    // A mailbox's address or a domain is its name already, so there is no second identifier.
    externalIdGroups(external) ?? externalId(external),
    externalSince(external, day),
    extra,
  );
}

export function side(
  heading: Heading,
  name: string,
  url: string | undefined,
  reference: string | string[] | undefined,
  since: string | undefined,
  extra: OptionalHtml[],
): Html {
  const profile = url && safeUrl(url);

  return html`
    <div class="side">
      <p class="who">${typeof heading === 'string' ? heading : [heading.mark, heading.text]}</p>
      <p class="name">
        ${profile ? html`<a href="${profile}" rel="noreferrer">${name}</a>` : name}${
          since && html`<span class="since">${since}</span>`
        }
      </p>
      ${
        typeof reference === 'string'
          ? html`<p class="reference">${reference}</p>`
          : reference &&
            html`
              <p class="reference fingerprint">
                ${reference.map((group) => html`<span>${group}</span>`)}
              </p>
            `
      }
      ${extra}
    </div>
  `;
}

/** A day, as the date alone. */
export const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** A day as it is said, such as "Jan 11, 2027". In UTC, as every other time here is. */
export const date = (time: number) =>
  new Date(time).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** How far off a time is in whole days, such as "in 90 days" or "12 days ago". */
export function distance(time: number, now: number) {
  const days = Math.round((time - now) / 86400000);

  if (days === 0) return 'today';

  const count = `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;

  return days > 0 ? `in ${count}` : `${count} ago`;
}

/** A time to the minute, in UTC, such as "Oct 16, 2026, 18:28 UTC". */
export const minute = (time: number) =>
  `${new Date(time).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  })} UTC`;

/** Seconds are the finest thing a record measured in days can mean; milliseconds are noise. */
export const moment = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every time on the page in one list. A date inside a sentence is a date a reader has to
 * find; the times of a record belong together, where they can be compared at a glance.
 */
export function times(rows: [string, number | undefined][]): Html {
  return html`<dl>${rows
    .filter(([, time]) => time !== undefined)
    .map(([label, time]) => html`<dt>${label}</dt><dd>${moment(time!)}</dd>`)}</dl>`;
}

/** A URL as written if it is http(s), and nothing otherwise. */
export function safeUrl(value: string) {
  try {
    const url = new URL(value);

    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
