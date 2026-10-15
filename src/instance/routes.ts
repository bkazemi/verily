/**
 * The paths the instance answers itself. The library is mounted at the root of the origin
 * and answers every other path, so a path listed here must be one the library does not
 * serve: the instance looks here first, and a library route of the same name would never be
 * reached.
 */
export const own = new Set([
  '/',
  '/login',
  '/logout',
  '/disconnect',
  '/mark',
  '/confirm',
  '/records',
  '/register',
  '/register/check',
  '/register/cancel',
  '/dashboard',
  '/dashboard/login',
  '/dashboard/logout',
  '/dashboard/settings',
  '/dashboard/rotate',
  '/dashboard/previous-key',
  '/handoff/request',
  '/handoff/accept',
  '/site/connections',
  '/site/enter',
  '/site/enter.js',
  '/site/session',
  '/.well-known/verily-keys.json',
]);
