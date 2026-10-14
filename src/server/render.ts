import {
  externalId,
  externalIdGroups,
  externalLink,
  externalName,
  externalSince,
  type ExternalAccount,
} from '../core/index.js';
import { logo } from '../logo.js';
import { escape } from './escape.js';
import { styleVersion } from './style.js';

/**
 * The shell every Verily page shares: the stylesheet, the logotype and the heading. `variant`
 * is a class on the page's `main`, such as `single` for a page with one thing on it.
 * `script` is the path of one script the page runs.
 */
export const page = (prefix: string, title: string, body: string, variant = '', script = '') =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Verily</title><link rel="stylesheet" href="${escape(prefix)}/style.css?v=${styleVersion}"><body><main${variant && ` class="${variant}"`}>${logo}<h1>${escape(title)}</h1>${body}</main>${script && `<script src="${escape(script)}" defer></script>`}</body></html>`;

/**
 * One side of a link, with each thing known about it on its own line. A name, the
 * identifier behind it and how it was shown are three separate claims, and a reader
 * running them together in one sentence is the way to misread which was established.
 *
 * Both sides render as the same card, so the pair reads as a pair.
 */
export function card(
  heading: string,
  name: string,
  url: string | undefined,
  reference?: string | string[],
  ...extra: string[]
) {
  return side(heading, name, url, reference, undefined, extra);
}

/**
 * The card for an external account: its name, link and id, with the "Joined <date>" text
 * on the name's line when the creation date is known.
 */
export function externalCard(heading: string, external: ExternalAccount, ...extra: string[]) {
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
  heading: string,
  name: string,
  url: string | undefined,
  reference: string | string[] | undefined,
  since: string | undefined,
  extra: string[],
) {
  const profile = url && safeUrl(url);

  return `<div class="side"><p class="who">${escape(heading)}</p><p class="name">${
    profile ? `<a href="${escape(profile)}" rel="noreferrer">${escape(name)}</a>` : escape(name)
  }${since ? `<span class="since">${escape(since)}</span>` : ''}</p>${
    typeof reference === 'string'
      ? `<p class="reference">${escape(reference)}</p>`
      : reference
        ? `<p class="reference fingerprint">${reference.map((group) => `<span>${escape(group)}</span>`).join('')}</p>`
        : ''
  }${extra.join('')}</div>`;
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

/** Seconds are the finest thing a record measured in days can mean; milliseconds are noise. */
export const moment = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every time on the page in one list. A date inside a sentence is a date a reader has to
 * find; the times of a record belong together, where they can be compared at a glance.
 */
export function times(rows: [string, number | undefined][]) {
  return `<dl>${rows
    .filter(([, time]) => time !== undefined)
    .map(([label, time]) => `<dt>${escape(label)}</dt><dd>${escape(moment(time!))}</dd>`)
    .join('')}</dl>`;
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
