/**
 * Route templating: `/home/c/8a3602a6-…/p/68c53678…/dashboard?loanId=6a62…`
 * becomes `/home/c/:id/p/:id/dashboard?loanId=:id`.
 *
 * A real recording's routes are dominated by identifiers - UUIDs, Mongo
 * object ids, numeric keys - that make every route unique and 150 characters
 * long. Templating them is what lets findings group by screen rather than
 * by visit, keeps flow.md readable at a glance, and keeps an agent from
 * treating two visits to one screen as two screens. The exact route stays
 * in actions.json for anyone who needs the identifier itself.
 */

const ID_SEGMENT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|[0-9a-f]{8,}|\d{4,})$/i;

export function templateSegment(segment: string): string {
  return ID_SEGMENT.test(segment) ? ':id' : segment;
}

/** Template the path and the query values of a route or URL path. */
export function templateRoute(route: string): string {
  if (!route) return route;
  const [pathAndQuery, hash] = route.split('#', 2);
  const [path, query] = pathAndQuery.split('?', 2);
  const templatedPath = path
    .split('/')
    .map((segment) => templateSegment(decodeURIComponentSafe(segment)))
    .join('/');
  if (query === undefined) return hash === undefined ? templatedPath : `${templatedPath}#${hash}`;
  const templatedQuery = query
    .split('&')
    .map((pair) => {
      const [key, value] = pair.split('=', 2);
      if (value === undefined) return key;
      return `${key}=${templateSegment(decodeURIComponentSafe(value))}`;
    })
    .join('&');
  const out = `${templatedPath}?${templatedQuery}`;
  return hash === undefined ? out : `${out}#${hash}`;
}

/** `METHOD /templated/path` - the endpoint a request belongs to, without its query. */
export function templateEndpoint(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${templateRoute(parsed.pathname)}`;
  } catch {
    return `${method} ${templateRoute(url.split('?')[0])}`;
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
