import { page } from '../server/render.js';

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
  new Response(page('', heading, body, variant), {
    status,
    headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
