/**
 * Read-only MongoDB / DocumentDB source.
 *
 * "Read-only" is enforced here, not trusted to the database user:
 *   - the only driver calls in this file are `find` and `countDocuments`;
 *   - filters come from a template in sources.yaml, with typed argument
 *     binding, so an argument can never become an operator;
 *   - operators that run code (`$where`, `$function`, `$accumulator`) are
 *     refused in the template itself;
 *   - the connection asks for `secondaryPreferred` reads.
 *
 * Credentials are read from the env file at connect time and are never put
 * in a log line, a ref or a ledger.
 */
import {
  MongoClient,
  ObjectId,
  type Db,
  type MongoClientOptions,
} from 'mongodb';
import { getPath } from '../expr.ts';
import { expandHome, readEnvFile, substituteEnv } from '../config/env.ts';
import type { ArgType, SourceDef, ToolDef } from '../config/types.ts';
import { ToolError, type SourceProvider, type ToolRun } from './types.ts';

const FORBIDDEN_OPERATORS = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$out',
  '$merge',
]);
const SENSITIVE_KEY =
  /(^|_)(password|passwd|secret|token|ssn|ein|dob|birth|routing|account_number|api_key)(_|$)/i;
const MAX_STRING = 300;
const MAX_ARRAY = 50;
const HEX24 = /^[0-9a-f]{24}$/i;

export type MongoToolSpec = {
  collection: string;
  filter: Record<string, unknown>;
  project: string[] | 'all';
  projectEach?: { arg: string; path: string };
  sort?: Record<string, 1 | -1>;
  limit: number;
  one: boolean;
  count: boolean;
};

export function parseMongoSpec(tool: ToolDef): MongoToolSpec | string {
  const s = tool.spec;
  if (
    typeof s.collection !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(s.collection)
  )
    return 'collection is required';
  const filter = s.filter;
  if (
    filter === undefined ||
    typeof filter !== 'object' ||
    Array.isArray(filter) ||
    filter === null
  ) {
    return 'filter is required (use {} to match everything, with a limit)';
  }
  const bad = findForbidden(filter);
  if (bad) return `filter uses forbidden operator ${bad}`;
  let project: MongoToolSpec['project'] = 'all';
  if (s.project !== undefined) {
    if (s.project === 'all') project = 'all';
    else if (
      Array.isArray(s.project) &&
      s.project.every((p) => typeof p === 'string')
    )
      project = s.project as string[];
    else return '`project` must be a list of field names or "all"';
  }
  let projectEach: MongoToolSpec['projectEach'];
  if (s.projectEach !== undefined) {
    const pe = s.projectEach as { arg?: unknown; path?: unknown };
    if (
      typeof pe.arg !== 'string' ||
      typeof pe.path !== 'string' ||
      !pe.path.includes('{}')
    ) {
      return '`projectEach` needs { arg, path } with {} in path';
    }
    if (tool.args[pe.arg] !== 'string[]')
      return `projectEach arg "${pe.arg}" must be declared string[]`;
    projectEach = { arg: pe.arg, path: pe.path };
  }
  const one = s.one === true;
  const count = s.count === true;
  const limit =
    typeof s.limit === 'number'
      ? Math.min(Math.max(1, s.limit), 50)
      : one
      ? 1
      : 10;
  return {
    collection: s.collection,
    filter: filter as Record<string, unknown>,
    project,
    projectEach,
    sort: s.sort as MongoToolSpec['sort'],
    limit,
    one,
    count,
  };
}

function findForbidden(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findForbidden(n);
      if (f) return f;
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_OPERATORS.has(k)) return k;
      const f = findForbidden(v);
      if (f) return f;
    }
  }
  return undefined;
}

/** Turn an argument into what the filter should hold, per its declared type. */
export function bindArg(name: string, value: unknown, type: ArgType): unknown {
  switch (type) {
    case 'objectid':
      if (typeof value !== 'string' || !HEX24.test(value))
        throw new ToolError('bad_args', `${name} must be a 24-hex id`);
      return new ObjectId(value);
    case 'id':
      // Ids are ObjectIds in some collections and strings in others.
      if (typeof value !== 'string' || value === '')
        throw new ToolError('bad_args', `${name} must be an id string`);
      return HEX24.test(value) ? { $in: [new ObjectId(value), value] } : value;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n))
        throw new ToolError('bad_args', `${name} must be a number`);
      return n;
    }
    case 'boolean':
      return value === true || value === 'true';
    case 'string':
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new ToolError('bad_args', `${name} must be a string`);
      return String(value);
    case 'string[]':
      if (!Array.isArray(value))
        throw new ToolError('bad_args', `${name} must be a list`);
      return value.map(String);
  }
}

export function bindFilter(
  template: unknown,
  args: Record<string, unknown>,
  types: Record<string, ArgType>,
): unknown {
  if (
    typeof template === 'string' &&
    template.startsWith('$') &&
    !template.startsWith('$$')
  ) {
    const name = template.slice(1);
    if (!(name in types))
      throw new ToolError(
        'bad_args',
        `filter references undeclared arg $${name}`,
      );
    if (args[name] === undefined || args[name] === null)
      throw new ToolError('bad_args', `missing arg ${name}`);
    return bindArg(name, args[name], types[name]);
  }
  if (Array.isArray(template))
    return template.map((t) => bindFilter(t, args, types));
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([k, v]) => [k, bindFilter(v, args, types)]),
    );
  }
  return template;
}

/** Plain JSON for the ledger: ids and dates as strings, sensitive keys hidden, bounded. */
export function normalize(value: unknown, key = '', depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY)
      .map((v) => normalize(v, key, depth + 1));
    if (value.length > MAX_ARRAY)
      out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }
  if (typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    if (
      ctor === 'Decimal128' ||
      ctor === 'Long' ||
      ctor === 'Int32' ||
      ctor === 'Double'
    )
      return String(value);
    if (ctor === 'Binary') return '[binary]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = normalize(v, k, depth + 1);
    return out;
  }
  return String(value);
}

export type MongoConnection = {
  uri: string;
  options: MongoClientOptions;
  database: string;
};

/** Build connection settings from the env file, sources.yaml options and AGENT_* overrides. */
export function buildConnection(
  def: SourceDef,
  processEnv: Record<string, string | undefined>,
): MongoConnection {
  const cfg = def.config;
  const envFile = typeof cfg.envFile === 'string' ? cfg.envFile : undefined;
  // A full connection string given by the person is complete in itself: the
  // credentials file is not opened at all, so pointing the agent at a local
  // copy never reads the real credentials.
  const needsFile = !processEnv.AGENT_MONGO_URI;
  const fileEnv: Record<string, string> =
    envFile && needsFile ? readEnvFile(envFile) : {};
  const get = (k: string) => processEnv[`AGENT_${k}`] ?? fileEnv[k];

  const database =
    get('MONGO_DATABASE') ??
    (typeof cfg.database === 'string'
      ? substituteEnv(cfg.database, { ...fileEnv, ...processEnv })
      : undefined) ??
    get('MONGO_INITDB_DATABASE') ??
    databaseFromUri(processEnv.AGENT_MONGO_URI);
  if (!database)
    throw new ToolError(
      'unavailable',
      `mongo source "${def.name}": no database name (set AGENT_MONGO_DATABASE)`,
    );

  const options: MongoClientOptions = {
    appName: 'rrweb-agent',
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
    retryWrites: false,
    readPreference: 'secondaryPreferred',
  };
  const extra = (cfg.options ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(extra)) {
    (options as Record<string, unknown>)[k] =
      typeof v === 'string'
        ? expandHome(substituteEnv(v, { ...fileEnv, ...processEnv }))
        : v;
  }
  if (get('MONGO_TLS') === 'true') options.tls = true;
  const ca = get('MONGO_TLS_CA_FILE');
  if (ca) options.tlsCAFile = expandHome(ca);
  if (get('MONGO_DIRECT') === 'true') options.directConnection = true;
  const replica = get('MONGO_REPLICA_SET');
  if (replica) options.replicaSet = replica;

  const full =
    get('MONGO_URI') ??
    (typeof cfg.uri === 'string'
      ? substituteEnv(cfg.uri, { ...fileEnv, ...processEnv })
      : undefined);
  if (full) return { uri: full, options, database };

  const host = get('MONGO_HOST_OVERRIDE') ?? get('MONGO_HOST');
  const port = get('MONGO_PORT') ?? '27017';
  if (!host)
    throw new ToolError(
      'unavailable',
      `mongo source "${def.name}": no MONGO_HOST (set envFile, or AGENT_MONGO_URI)`,
    );
  const user = get('MONGO_INITDB_ROOT_USERNAME');
  const pass = get('MONGO_INITDB_ROOT_PASSWORD');
  // Credentials go in `auth`, not the URI, so characters like $ or @ need no escaping.
  if (user && pass) {
    options.auth = { username: user, password: pass };
    options.authSource = get('MONGO_AUTH_SOURCE') ?? 'admin';
  }
  return {
    uri: `mongodb://${host.includes(':') ? host : `${host}:${port}`}/`,
    options,
    database,
  };
}

function databaseFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    const name = new URL(uri).pathname.replace(/^\//, '');
    return name || undefined;
  } catch {
    return undefined;
  }
}

export class MongoProvider implements SourceProvider {
  readonly name: string;
  readonly type = 'mongo';
  private client?: MongoClient;
  private connecting?: Promise<Db>;
  private readonly deny: Set<string>;
  private readonly maxTimeMs: number;

  private readonly def: SourceDef;
  private readonly processEnv: Record<string, string | undefined>;

  constructor(
    def: SourceDef,
    processEnv: Record<string, string | undefined> = process.env,
  ) {
    this.def = def;
    this.processEnv = processEnv;
    this.name = def.name;
    const deny = Array.isArray(def.config.deny)
      ? (def.config.deny as unknown[]).map(String)
      : [];
    this.deny = new Set(deny);
    this.maxTimeMs =
      typeof def.config.maxTimeMs === 'number' ? def.config.maxTimeMs : 4000;
  }

  validateTool(tool: ToolDef): string | undefined {
    const spec = parseMongoSpec(tool);
    if (typeof spec === 'string') return spec;
    if (this.deny.has(spec.collection))
      return `collection ${spec.collection} is denied for source ${this.name}`;
    return undefined;
  }

  private connect(): Promise<Db> {
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = buildConnection(this.def, this.processEnv);
        const client = new MongoClient(conn.uri, conn.options);
        try {
          await client.connect();
        } catch (e) {
          await client.close().catch(() => undefined);
          throw e;
        }
        this.client = client;
        return client.db(conn.database);
      })();
      // A failed connect must be retryable on the next call, not cached forever.
      this.connecting.catch(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async health(): Promise<{ ready: boolean; error?: string }> {
    try {
      const db = await this.connect();
      await db.command({ ping: 1 }, { readPreference: 'secondaryPreferred' });
      return { ready: true };
    } catch (e) {
      return { ready: false, error: scrub(e) };
    }
  }

  async run(tool: ToolDef, args: Record<string, unknown>): Promise<ToolRun> {
    const spec = parseMongoSpec(tool);
    if (typeof spec === 'string')
      throw new ToolError('bad_args', `${tool.name}: ${spec}`);
    if (this.deny.has(spec.collection))
      throw new ToolError('bad_args', `${tool.name}: collection denied`);

    const filter = bindFilter(spec.filter, args, tool.args) as Record<
      string,
      unknown
    >;
    let db: Db;
    try {
      db = await this.connect();
    } catch (e) {
      throw new ToolError('unavailable', `mongo ${this.name}: ${scrub(e)}`);
    }
    const coll = db.collection(spec.collection);
    const ref = `mongo ${db.databaseName}.${spec.collection} ${
      spec.count ? 'count' : 'find'
    } ${compactFilter(filter)}`;

    try {
      if (spec.count) {
        const count = await coll.countDocuments(filter, {
          maxTimeMS: this.maxTimeMs,
        });
        return { value: { found: count > 0, count }, ref };
      }
      const projection = buildProjection(spec, args);
      let cursor = coll.find(filter, { projection, maxTimeMS: this.maxTimeMs });
      if (spec.sort) cursor = cursor.sort(spec.sort);
      const docs = await cursor.limit(spec.limit).toArray();

      const value: Record<string, unknown> = {
        found: docs.length > 0,
        count: docs.length,
      };
      if (spec.one) value.doc = docs[0] ? normalize(docs[0]) : null;
      else value.rows = docs.map((d) => normalize(d));
      if (spec.projectEach) {
        const items =
          (args[spec.projectEach.arg] as string[] | undefined) ?? [];
        const values: Record<string, unknown> = {};
        for (const item of items) {
          const v = docs[0]
            ? getPath(docs[0], spec.projectEach.path.replace('{}', item))
            : undefined;
          if (v !== undefined) values[item] = normalize(v, item);
        }
        value.values = values;
      }
      return { value, ref };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('unavailable', `mongo ${this.name}: ${scrub(e)}`);
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (c) await c.close().catch(() => undefined);
  }
}

function buildProjection(
  spec: MongoToolSpec,
  args: Record<string, unknown>,
): Record<string, 0 | 1> | undefined {
  const p: Record<string, 0 | 1> = {};
  if (spec.project !== 'all') for (const f of spec.project) p[f] = 1;
  if (spec.projectEach) {
    const items = (args[spec.projectEach.arg] as string[] | undefined) ?? [];
    for (const item of items) p[spec.projectEach.path.replace('{}', item)] = 1;
  }
  return Object.keys(p).length ? p : undefined;
}

function compactFilter(filter: unknown): string {
  const s = JSON.stringify(filter, (_k, v) =>
    v instanceof ObjectId ? `ObjectId(${v.toHexString()})` : v,
  );
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** Driver errors can echo connection strings; keep the message, drop anything URI-shaped. */
export function scrub(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://<redacted>')
    .slice(0, 300);
}
