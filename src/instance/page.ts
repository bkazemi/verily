import { logo } from '../logo.js';
import { escape } from '../server/escape.js';
import { styleVersion } from '../server/style.js';

export const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/**
 * Every page here says in its heading what it is, the way the library's pages do. The
 * logotype above already says whose it is, so the heading never has to repeat that.
 */
export const html = (heading: string, body: string, status = 200, variant = '') =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)} · Verily</title><link rel="stylesheet" href="/style.css?v=${styleVersion}"><body><main${variant && ` class="${variant}"`}>${logo}<h1>${escape(heading)}</h1>${body}</main></body></html>`,
    { status, headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
  );
