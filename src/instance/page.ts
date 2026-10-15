import { html, type Html } from '../server/html.js';
import { page } from '../server/render.js';

export const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/** A cookie's value as the request carries it, or undefined. */
export const readCookie = (request: Request, name: string) =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/**
 * A Set-Cookie value for every cookie the instance sets: never readable by script, sent
 * only over HTTPS, and kept off cross-site requests. A lifetime of 0 clears it.
 */
export const setCookie = (name: string, value: string, ms: number, path = '/') =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${ms / 1000}`;

/** A 303 to `location`, setting each of `cookies`. */
export function see(location: string, cookies: string[] = []) {
  const headers = new Headers({ ...safeHeaders, Location: location });

  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(null, { status: 303, headers });
}

/**
 * Every page here says in its heading what it is, the way the library's pages do. The
 * logotype above already says whose it is, so the heading never has to repeat that.
 * `script` is the path of one script the page runs, which its policy then allows.
 */
export const respond = (heading: string, body: Html, status = 200, variant = '', script = '') =>
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
  respond(
    'Unavailable',
    html`<p>This resource is unavailable. <a href="/">Go to the start page</a>.</p>`,
    status,
    'single',
  );
