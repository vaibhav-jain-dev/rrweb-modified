/**
 * HTTP source: a named, templated request. GET/HEAD only unless the source
 * says `allowWrites: true`, so a lookup tool cannot change anything by default.
 */
import { getPath } from '../expr.ts';
import { substituteEnv } from '../config/env.ts';
import type { ArgType, SourceDef, ToolDef } from '../config/types.ts';
import { ToolError, type SourceProvider, type ToolRun } from './types.ts';

type HttpSpec = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  returns: Record<string, string>;
};

function parseSpec(tool: ToolDef): HttpSpec | string {
  const r = tool.spec.request as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return '`request` is required';
  const method = String(r.method ?? 'GET').toUpperCase();
  if (typeof r.path !== 'string' || !r.path.startsWith('/'))
    return 'request.path must start with /';
  const returns = tool.spec.returns;
  if (
    !returns ||
    typeof returns !== 'object' ||
    Array.isArray(returns) ||
    Object.keys(returns).length === 0
  ) {
    return '`returns` is required: name -> response path';
  }
  return {
    method,
    path: r.path,
    query: (r.query as Record<string, unknown> | undefined) ?? {},
    returns: Object.fromEntries(
      Object.entries(returns as Record<string, unknown>).map(([k, v]) => [
        k,
        String(v),
      ]),
    ),
  };
}

function fill(
  template: string,
  args: Record<string, unknown>,
  types: Record<string, ArgType>,
  encode: boolean,
): string {
  return template.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_w, name: string) => {
    if (!(name in types))
      throw new ToolError(
        'bad_args',
        `request references undeclared arg $${name}`,
      );
    const v = args[name];
    if (v === undefined || v === null)
      throw new ToolError('bad_args', `missing arg ${name}`);
    const s = String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

export class HttpProvider implements SourceProvider {
  readonly name: string;
  readonly type = 'http';
  private readonly baseUrl: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly allowWrites: boolean;
  private readonly timeoutMs: number;

  constructor(
    def: SourceDef,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.name = def.name;
    const base =
      typeof def.config.baseUrl === 'string'
        ? substituteEnv(def.config.baseUrl, env)
        : undefined;
    this.baseUrl =
      base && !base.includes('$') ? base.replace(/\/+$/, '') : undefined;
    this.headers = Object.fromEntries(
      Object.entries((def.config.headers ?? {}) as Record<string, unknown>).map(
        ([k, v]) => [k, substituteEnv(String(v), env)],
      ),
    );
    this.allowWrites = def.config.allowWrites === true;
    this.timeoutMs =
      typeof def.config.timeoutMs === 'number' ? def.config.timeoutMs : 5000;
  }

  validateTool(tool: ToolDef): string | undefined {
    const spec = parseSpec(tool);
    if (typeof spec === 'string') return spec;
    if (!['GET', 'HEAD'].includes(spec.method) && !this.allowWrites) {
      return `${spec.method} not allowed: source ${this.name} is read-only (set allowWrites: true to override)`;
    }
    return undefined;
  }

  async health(): Promise<{ ready: boolean; error?: string }> {
    return this.baseUrl
      ? { ready: true }
      : {
          ready: false,
          error: 'baseUrl is not set (check the env variable it references)',
        };
  }

  async run(tool: ToolDef, args: Record<string, unknown>): Promise<ToolRun> {
    const spec = parseSpec(tool);
    if (typeof spec === 'string')
      throw new ToolError('bad_args', `${tool.name}: ${spec}`);
    if (!this.baseUrl)
      throw new ToolError(
        'unavailable',
        `http ${this.name}: baseUrl is not set`,
      );

    const url = new URL(this.baseUrl + fill(spec.path, args, tool.args, true));
    for (const [k, v] of Object.entries(spec.query)) {
      url.searchParams.set(
        k,
        typeof v === 'string' ? fill(v, args, tool.args, false) : String(v),
      );
    }
    const ref = `http ${spec.method} ${url.origin}${url.pathname}${
      url.search ? '?…' : ''
    }`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: spec.method,
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ToolError(
        'unavailable',
        `http ${this.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body: only status is reported */
    }
    const value: Record<string, unknown> = {
      status: res.status,
      found: res.ok,
    };
    for (const [name, path] of Object.entries(spec.returns))
      value[name] = getPath(body, path.replace(/^\$\.?/, ''));
    return { value, ref: `${ref} -> ${res.status}` };
  }

  async close(): Promise<void> {}
}
