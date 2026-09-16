/**
 * Redaction. Applied before anything is persisted, never at export time.
 *
 * Design: keep visible/semantic text and ordinary data (so "Clicked
 * Pending" and "24 \> 7 rows" survive), but always strip anything
 * credential-shaped. Every redaction leaves a `[REDACTED:<reason>]` marker
 * so the agent knows something was there, and callers can tally reasons
 * into a redaction report.
 */

export type RedactionReport = Record<string, number>;

const HEADER_DENYLIST = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'proxy-authorization',
]);

const KEY_DENYLIST_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'credential',
  'refresh',
  'sessionid',
  'ssn',
  'creditcard',
  'credit_card',
  'cvv',
  'pin',
  'privatekey',
  'private_key',
];

const URL_PARAM_DENYLIST = new Set([
  'token',
  'access_token',
  'key',
  'code',
  'signature',
  'sig',
  'password',
]);

// JWT-shaped: three base64url segments separated by dots.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const PEM_RE = /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

function matchesKeyDenylist(key: string): boolean {
  const lower = key.toLowerCase();
  return KEY_DENYLIST_SUBSTRINGS.some((needle) => lower.includes(needle));
}

export function mark(reason: string, report?: RedactionReport): string {
  if (report) report[reason] = (report[reason] ?? 0) + 1;
  return `[REDACTED:${reason}]`;
}

/** Redact denylisted or credential-shaped values inside free text. */
export function redactValueShapes(text: string, report?: RedactionReport): string {
  let out = text;
  out = out.replace(PEM_RE, () => mark('pem', report));
  out = out.replace(JWT_RE, () => mark('jwt', report));
  out = out.replace(BEARER_RE, () => mark('bearer', report));
  out = out.replace(AWS_KEY_RE, () => mark('aws-key', report));
  return out;
}

export function redactHeaders(
  headers: Record<string, string> | undefined,
  report?: RedactionReport,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HEADER_DENYLIST.has(key.toLowerCase())) {
      out[key] = `${mark('header', report)} (len=${value.length})`;
    } else {
      out[key] = redactValueShapes(value, report);
    }
  }
  return out;
}

/** Redact a JSON-shaped value in place (returns a new value, deep). */
export function redactJson(value: unknown, report?: RedactionReport): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactValueShapes(value, report);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, report));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (matchesKeyDenylist(key)) {
      out[key] = mark('key', report);
    } else {
      out[key] = redactJson(val, report);
    }
  }
  return out;
}

/** Redact a request/response body. Tries JSON first, falls back to plain
 * text scanning for value-shaped secrets and form-encoded denylisted keys. */
export function redactBody(
  body: string | null | undefined,
  contentType: string | undefined,
  report?: RedactionReport,
): string | null {
  if (body === null || body === undefined) return body ?? null;
  const isJson = contentType?.includes('json') || /^[\s]*[{[]/.test(body);
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(body);
      return JSON.stringify(redactJson(parsed, report));
    } catch {
      // not actually JSON, fall through
    }
  }
  if (contentType?.includes('form-urlencoded') || /^([\w.-]+=[^&]*&?)+$/.test(body)) {
    try {
      const params = new URLSearchParams(body);
      for (const [key, value] of Array.from(params.entries())) {
        params.set(
          key,
          matchesKeyDenylist(key) ? mark('key', report) : redactValueShapes(value, report),
        );
      }
      return params.toString();
    } catch {
      // fall through
    }
  }
  return redactValueShapes(body, report);
}

export function redactUrl(url: string, report?: RedactionReport): string {
  try {
    const parsed = new URL(url);
    let touched = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (URL_PARAM_DENYLIST.has(key.toLowerCase())) {
        parsed.searchParams.set(key, mark('url-param', report));
        touched = true;
      }
    }
    return touched ? parsed.toString() : redactValueShapes(url, report);
  } catch {
    return redactValueShapes(url, report);
  }
}

export function redactStorageValue(
  key: string,
  value: string,
  report?: RedactionReport,
): string {
  if (matchesKeyDenylist(key)) return mark('storage-key', report);
  return redactValueShapes(value, report);
}

/**
 * Should this form input's value be masked entirely, regardless of
 * content? Always true for `type=password`; also true for any field whose
 * name/id/autocomplete matches the credential denylist, or that matches a
 * caller-supplied mask selector list.
 */
export function shouldMaskInput(
  el: { type?: string; name?: string; id?: string; autocomplete?: string },
  maskSelectors: string[] = [],
  matchesSelector?: (selectors: string[]) => boolean,
): boolean {
  if (el.type === 'password') return true;
  const candidates = [el.name, el.id, el.autocomplete].filter(
    (v): v is string => !!v,
  );
  if (candidates.some((c) => matchesKeyDenylist(c))) return true;
  if (maskSelectors.length && matchesSelector?.(maskSelectors)) return true;
  return false;
}

export function isKeyDenylisted(key: string): boolean {
  return matchesKeyDenylist(key);
}

export function isHeaderDenylisted(key: string): boolean {
  return HEADER_DENYLIST.has(key.toLowerCase());
}
