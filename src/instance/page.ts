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
 * `script` is the path of one script the page runs, which its policy then allows.
 */
export const html = (heading: string, body: string, status = 200, variant = '', script = '') =>
  new Response(page('', heading, body, variant, script), {
    status,
    headers: {
      ...safeHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      ...(script
        ? {
            'Content-Security-Policy': safeHeaders['Content-Security-Policy'].replace(
              "style-src 'self';",
              "style-src 'self'; script-src 'self';",
            ),
          }
        : {}),
    },
  });

/**
 * Every refusal reads the same, so the page says nothing about which check failed. The
 * link goes to the root, which shows whoever asks the page that is theirs.
 */
export const unavailable = (status = 404) =>
  html(
    'Unavailable',
    '<p>This resource is unavailable. <a href="/">Go to the start page</a>.</p>',
    status,
    'single',
  );
