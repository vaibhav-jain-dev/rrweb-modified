import type { NetworkRequest } from '../../web-extension/src/evidence/types.ts';
import {
  templateEndpoint,
  templateSegment,
} from '../../web-extension/src/evidence/route-template.ts';
import type { RequestRecord } from './sources/types.ts';

const MAX_BODY_CHARS = 64 * 1024;

/** `POST /a/:id/b` against a real method + pathname. `:name` matches one segment, `**` the rest. */
export function matchEndpoint(
  pattern: string,
  method: string,
  pathname: string,
): boolean {
  const m = /^(\S+)\s+(\S+)$/.exec(pattern.trim());
  if (!m) return false;
  const [, pm, pp] = m;
  if (pm !== '*' && pm.toUpperCase() !== method.toUpperCase()) return false;
  const want = pp.replace(/\/+$/, '').split('/');
  const got = pathname.replace(/\/+$/, '').split('/');
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '**') return true;
    if (i >= got.length) return false;
    if (want[i].startsWith(':')) {
      if (got[i] === '') return false;
      continue;
    }
    if (want[i] !== got[i]) return false;
  }
  return want.length === got.length;
}

/** `2xx`, `4xx`, `200,201`, `>=400`, `<300`, `*`. */
export function statusMatches(
  spec: string,
  status: number | undefined,
  failed: boolean,
): boolean {
  const s = spec.trim();
  if (s === '*') return true;
  if (status === undefined) return false;
  if (failed && s !== '*') return false;
  return s.split(',').some((part) => {
    const p = part.trim();
    let m = /^([1-5])xx$/i.exec(p);
    if (m) return Math.floor(status / 100) === Number(m[1]);
    m = /^(>=|<=|>|<)\s*(\d{3})$/.exec(p);
    if (m) {
      const n = Number(m[2]);
      return m[1] === '>='
        ? status >= n
        : m[1] === '<='
        ? status <= n
        : m[1] === '>'
        ? status > n
        : status < n;
    }
    return Number(p) === status;
  });
}

function parseBody(text: string | null | undefined): {
  value: unknown;
  truncated: boolean;
} {
  if (text === null || text === undefined || text === '')
    return { value: undefined, truncated: false };
  const truncated = text.length > MAX_BODY_CHARS;
  const slice = truncated ? text.slice(0, MAX_BODY_CHARS) : text;
  const c = slice.trimStart()[0];
  if (c === '{' || c === '[') {
    try {
      return { value: JSON.parse(slice), truncated };
    } catch {
      /* fall through: keep as text */
    }
  }
  return { value: slice, truncated };
}

export function toRequestRecord(
  n: NetworkRequest,
  sessionStart: number,
): RequestRecord {
  let pathname = n.url;
  const query: Record<string, string> = {};
  try {
    const u = new URL(n.url);
    pathname = u.pathname;
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
  } catch {
    pathname = n.url.split('?')[0];
  }
  const lower = (h?: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
  const req = parseBody(n.requestBody);
  const res = parseBody(n.responseBody);
  const idSegments = pathname
    .split('/')
    .filter((s) => s && templateSegment(decodeSafe(s)) === ':id');
  return {
    requestId: n.requestId,
    method: n.method.toUpperCase(),
    url: n.url,
    pathname,
    endpoint: templateEndpoint(n.method.toUpperCase(), n.url),
    idSegments,
    query,
    status: n.status,
    failed: !!n.failed,
    requestHeaders: lower(n.requestHeaders),
    responseHeaders: lower(n.responseHeaders),
    requestBody: req.value,
    responseBody: res.value,
    truncated: req.truncated || res.truncated || !!n.bodyTruncated,
    startTime: n.startTime,
    endTime: n.endTime ?? n.startTime,
    tRel: Math.max(0, (n.endTime ?? n.startTime) - sessionStart),
  };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
