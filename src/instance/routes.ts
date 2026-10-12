/**
 * The paths this worker answers itself. The library is mounted at the root of the origin
 * and answers every other path, so a path listed here must be one the library does not
 * serve: this worker looks here first, and a library route of the same name would never be
 * reached.
 */
export const own = new Set([
  '/',
  '/login',
  '/logout',
  '/disconnect',
  '/mark',
  '/records',
  '/handoff/request',
  '/handoff/accept',
  '/site/connections',
  '/site/enter',
  '/site/enter.js',
  '/site/session',
  '/.well-known/verily-keys.json',
]);
