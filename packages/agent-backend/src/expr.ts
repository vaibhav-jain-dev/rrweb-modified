/**
 * The tiny expression language playbooks use to say where a value comes
 * from, and the assertions that compare it.
 *
 * A string that starts with `$` is a reference; anything else is a literal.
 *   $req.body.title        request body, dot path
 *   $res.body._id          response body
 *   $res.status            response status
 *   $path[0]               first identifier segment in the URL path
 *   $path.last             last identifier segment
 *   $query.q               query-string value
 *   $req.header.x-user     request header (lower-case)
 *   $loan_id               a value bound earlier in the rule
 *   $result.doc.title      (in `expect`) the tool result
 * and a pipe applies a function: `$req.body | keys`, `$req.body | mapvalues(value)`.
 *
 * Nothing here evaluates code. A reference that cannot be resolved yields
 * `undefined`, and the caller decides whether that is an error.
 */

export type Scope = Record<string, unknown>;

export type Pipe =
  | 'keys'
  | 'values'
  | 'length'
  | 'first'
  | 'last'
  | 'string'
  | 'mapvalues'
  | 'pick';

const PIPES = new Set<string>([
  'keys',
  'values',
  'length',
  'first',
  'last',
  'string',
  'mapvalues',
  'pick',
]);

/** Walk `a.b[0].c` (and `a["b"]`) through plain data. */
export function getPath(root: unknown, path: string): unknown {
  if (path === '' || path === '$') return root;
  const tokens: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\["([^"]+)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
    else if (m[3] !== undefined) tokens.push(m[3]);
  }
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof tok === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tok];
    } else if (Array.isArray(cur) && tok === 'last') {
      cur = cur[cur.length - 1];
    } else if (Array.isArray(cur) && tok === 'length') {
      cur = cur.length;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}

function applyPipe(value: unknown, pipe: string): unknown {
  const m = /^([a-z]+)(?:\(([^)]*)\))?$/.exec(pipe.trim());
  if (!m || !PIPES.has(m[1])) throw new Error(`unknown pipe "${pipe}"`);
  const name = m[1] as Pipe;
  const arg = m[2]?.trim();
  switch (name) {
    case 'keys':
      return value && typeof value === 'object' ? Object.keys(value) : [];
    case 'values':
      return value && typeof value === 'object' ? Object.values(value) : [];
    case 'length':
      if (Array.isArray(value) || typeof value === 'string')
        return value.length;
      return value && typeof value === 'object' ? Object.keys(value).length : 0;
    case 'first':
      return Array.isArray(value) ? value[0] : undefined;
    case 'last':
      return Array.isArray(value) ? value[value.length - 1] : undefined;
    case 'string':
      return value === undefined || value === null
        ? value
        : typeof value === 'string'
        ? value
        : JSON.stringify(value);
    case 'mapvalues': {
      // { fid: { value: 1 }, other: 2 } | mapvalues(value) -> { fid: 1, other: 2 }
      if (!value || typeof value !== 'object') return {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] =
          arg && v && typeof v === 'object' && !Array.isArray(v) && arg in v
            ? (v as Record<string, unknown>)[arg]
            : v;
      }
      return out;
    }
    case 'pick': {
      if (!value || typeof value !== 'object' || !arg) return {};
      const wanted = arg.split(',').map((s) => s.trim());
      const out: Record<string, unknown> = {};
      for (const k of wanted)
        if (k in (value as object))
          out[k] = (value as Record<string, unknown>)[k];
      return out;
    }
  }
}

/** Resolve one reference (with optional pipes) against a scope. */
export function resolveRef(ref: string, scope: Scope): unknown {
  const [head, ...pipes] = ref.split('|').map((s) => s.trim());
  const body = head.slice(1); // drop `$`
  // Root is the first identifier; the rest is a path into it.
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)(.*)$/.exec(body);
  if (!m) throw new Error(`bad reference "${ref}"`);
  const [, root, rest] = m;
  if (!(root in scope)) return undefined;
  const restPath = rest.startsWith('.') ? rest.slice(1) : rest;
  let value = getPath(scope[root], restPath);
  for (const p of pipes) value = applyPipe(value, p);
  return value;
}

/** Resolve a literal-or-reference, recursing through arrays and objects. */
export function resolveValue(input: unknown, scope: Scope): unknown {
  if (isRef(input)) return resolveRef(input, scope);
  if (Array.isArray(input)) return input.map((v) => resolveValue(v, scope));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = resolveValue(v, scope);
    return out;
  }
  return input;
}

/** `{loan_id}` interpolation for human-facing text. Unknown names stay as-is. */
export function interpolate(text: string, scope: Scope): string {
  return text.replace(
    /\{([A-Za-z_][A-Za-z0-9_.[\]]*)\}/g,
    (whole, expr: string) => {
      const [root, ...rest] = expr.split('.');
      if (!(root in scope)) return whole;
      const v = rest.length
        ? getPath(scope[root], rest.join('.'))
        : scope[root];
      if (v === undefined || v === null) return whole;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  );
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type Op =
  | 'eq'
  | 'ne'
  | 'in'
  | 'exists'
  | 'missing'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'regex'
  | 'has_item'
  | 'includes_map'
  | 'truthy'
  | 'falsy';

export const OPS: readonly Op[] = [
  'eq',
  'ne',
  'in',
  'exists',
  'missing',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'regex',
  'has_item',
  'includes_map',
  'truthy',
  'falsy',
];

/** Ids and numbers arrive as ObjectId strings, numbers or numeric strings
 * depending on which layer wrote them; compare what a person would call equal. */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined)
    return a == b;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
    } catch {
      return false;
    }
  }
  return String(a).trim() === String(b).trim();
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

export type AssertOutcome = {
  ok: boolean;
  actual: unknown;
  expected: unknown;
  detail?: string;
};

export function evaluate(
  op: Op,
  actual: unknown,
  expected: unknown,
): AssertOutcome {
  const res = (ok: boolean, detail?: string): AssertOutcome => ({
    ok,
    actual,
    expected,
    detail,
  });
  switch (op) {
    case 'eq':
      return res(looseEquals(actual, expected));
    case 'ne':
      return res(!looseEquals(actual, expected));
    case 'in':
      return res(
        Array.isArray(expected) && expected.some((e) => looseEquals(actual, e)),
      );
    case 'exists':
      return res(actual !== undefined && actual !== null);
    case 'missing':
      return res(actual === undefined || actual === null);
    case 'truthy':
      return res(!!actual);
    case 'falsy':
      return res(!actual);
    case 'gt':
      return res(Number(actual) > Number(expected));
    case 'gte':
      return res(Number(actual) >= Number(expected));
    case 'lt':
      return res(Number(actual) < Number(expected));
    case 'lte':
      return res(Number(actual) <= Number(expected));
    case 'contains':
      if (typeof actual === 'string')
        return res(actual.includes(String(expected)));
      if (Array.isArray(actual))
        return res(actual.some((a) => looseEquals(a, expected)));
      return res(false);
    case 'regex': {
      try {
        return res(
          typeof actual === 'string' &&
            new RegExp(String(expected)).test(actual),
        );
      } catch {
        return res(false, 'invalid regex');
      }
    }
    case 'has_item': {
      // actual: array of objects; expected: { key: value, ... } all of which must match one item
      if (!Array.isArray(actual) || !expected || typeof expected !== 'object')
        return res(false);
      const want = Object.entries(expected as Record<string, unknown>);
      return res(
        actual.some(
          (item) =>
            item &&
            typeof item === 'object' &&
            want.every(([k, v]) => looseEquals(getPath(item, k), v)),
        ),
      );
    }
    case 'includes_map': {
      // every key in `expected` must be present in `actual` with an equal value
      if (
        !actual ||
        typeof actual !== 'object' ||
        !expected ||
        typeof expected !== 'object'
      )
        return res(false);
      const act = actual as Record<string, unknown>;
      const missing: string[] = [];
      for (const [k, v] of Object.entries(
        expected as Record<string, unknown>,
      )) {
        if (!(k in act) || !looseEquals(act[k], v)) missing.push(k);
      }
      return res(
        missing.length === 0,
        missing.length
          ? `${missing.length} differ: ${missing.slice(0, 5).join(', ')}`
          : undefined,
      );
    }
  }
}
