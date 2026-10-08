/**
 * The routes more than one side has to know by name: the handler that serves them, the
 * dialog that calls them, and a deployment that lets a dialog on another origin through.
 * Paths are beneath wherever the handler is mounted. Kept as one table so that a route
 * the dialog calls is a route the others know of, and nothing keeps a list of its own.
 */
interface Route {
  method: 'GET' | 'POST';
  /** `:id` stands for one path segment. */
  path: string;
  /** Asked for as JSON by the query, where the same address is otherwise a page. */
  format?: 'json';
  /** Acts on a record with nothing but the holder's own session. */
  manages?: true;
  /** False for a route no dialog calls, listed so the others still know it by name. */
  dialog?: false;
}

export const routes = {
  methods: { method: 'GET', path: '/methods' },
  start: { method: 'POST', path: '/sessions' },
  flow: { method: 'GET', path: '/flows/:id', format: 'json' },
  submit: { method: 'POST', path: '/flows/:id/submit' },
  approve: { method: 'POST', path: '/flows/:id/approve' },
  disconnect: { method: 'POST', path: '/connections/:id/disconnect', manages: true },
  mark: { method: 'POST', path: '/connections/:id/mark', manages: true },
  share: { method: 'POST', path: '/connections/:id/share', manages: true, dialog: false },
  shareRevoke: {
    method: 'POST',
    path: '/connections/:id/share-revoke',
    manages: true,
    dialog: false,
  },
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof routes;

const names = Object.keys(routes) as RouteName[];

/** Whether a path is a route's, with any one segment where the route has `:id`. */
function matches(route: Route, path: string): boolean {
  const want = route.path.split('/');
  const got = path.split('/');

  return (
    want.length === got.length &&
    want.every((part, at) => (part === ':id' ? got[at] !== '' : part === got[at]))
  );
}

/** The address of a route, for the record or flow it acts on where it names one. */
export function routePath(name: RouteName, id?: string): string {
  const route: Route = routes[name];
  const path = route.path.replace(':id', encodeURIComponent(id ?? ''));

  return route.format ? `${path}?format=${route.format}` : path;
}

/** The route a request is for, by its method and its path beneath the mount. */
export function routeOf(method: string, path: string): RouteName | undefined {
  return names.find((name) => routes[name].method === method && matches(routes[name], path));
}

/**
 * The route a dialog's request is for, or nothing where it is not one a dialog makes: a
 * route no dialog calls, or a page asked for without the query that makes it JSON.
 */
export function dialogRoute(
  method: string,
  path: string,
  query: URLSearchParams,
): RouteName | undefined {
  const name = routeOf(method, path);
  const route: Route | undefined = name && routes[name];

  if (!route || route.dialog === false) return undefined;

  return !route.format || query.get('format') === route.format ? name : undefined;
}

/** Whether any dialog route is at a path, whatever the method: what a preflight asks about. */
export function dialogPath(path: string): boolean {
  return names.some((name) => {
    const route: Route = routes[name];

    return route.dialog !== false && matches(route, path);
  });
}
