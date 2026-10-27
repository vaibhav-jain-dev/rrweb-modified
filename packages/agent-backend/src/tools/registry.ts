import type { AgentConfig, ArgType, ToolDef } from '../config/types.ts';
import { HttpProvider } from '../sources/http.ts';
import { MongoProvider } from '../sources/mongo.ts';
import { SESSION_TOOLS, SessionProvider } from '../sources/session.ts';
import {
  ToolError,
  type SourceProvider,
  type ToolContext,
  type ToolRun,
} from '../sources/types.ts';

export type RunOutcome =
  | { ok: true; run: ToolRun; ms: number }
  | {
      ok: false;
      kind: 'unavailable' | 'bad_args';
      message: string;
      ms: number;
    };

export class ToolRegistry {
  private readonly providers = new Map<string, SourceProvider>();
  private readonly tools = new Map<string, ToolDef>();
  /** Tools that failed spec validation at load, with the reason. */
  readonly invalid = new Map<string, string>();

  constructor(
    config: AgentConfig,
    env: Record<string, string | undefined> = process.env,
  ) {
    for (const src of config.sources) {
      if (src.type === 'mongo')
        this.providers.set(src.name, new MongoProvider(src, env));
      else if (src.type === 'http')
        this.providers.set(src.name, new HttpProvider(src, env));
      else this.providers.set(src.name, new SessionProvider());
    }
    for (const t of [...SESSION_TOOLS, ...config.tools]) {
      const provider = this.providers.get(t.source);
      const problem = provider?.validateTool(t);
      if (!provider) this.invalid.set(t.name, `unknown source ${t.source}`);
      else if (problem) this.invalid.set(t.name, problem);
      else this.tools.set(t.name, t);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Short signature lines the model can choose from. */
  describe(): string {
    return this.list()
      .map(
        (t) =>
          `- ${t.name}(${Object.entries(t.args)
            .map(([a, ty]) => `${a}: ${ty}`)
            .join(', ')}): ${t.description}`,
      )
      .join('\n');
  }

  async health(): Promise<
    Record<string, { type: string; ready: boolean; error?: string }>
  > {
    const out: Record<
      string,
      { type: string; ready: boolean; error?: string }
    > = {};
    await Promise.all(
      [...this.providers.entries()].map(async ([name, p]) => {
        out[name] = { type: p.type, ...(await p.health()) };
      }),
    );
    return out;
  }

  async run(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<RunOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      const why = this.invalid.get(name);
      return {
        ok: false,
        kind: 'bad_args',
        message: why
          ? `tool ${name} is invalid: ${why}`
          : `unknown tool ${name}`,
        ms: 0,
      };
    }
    const argProblem = checkArgs(tool, args);
    if (argProblem)
      return {
        ok: false,
        kind: 'bad_args',
        message: `${name}: ${argProblem}`,
        ms: 0,
      };
    const provider = this.providers.get(tool.source)!;
    try {
      const run = await provider.run(tool, args, ctx);
      return { ok: true, run, ms: Date.now() - started };
    } catch (e) {
      if (e instanceof ToolError)
        return {
          ok: false,
          kind: e.kind,
          message: e.message,
          ms: Date.now() - started,
        };
      return {
        ok: false,
        kind: 'unavailable',
        message: e instanceof Error ? e.message : String(e),
        ms: Date.now() - started,
      };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.providers.values()].map((p) => p.close()));
  }
}

function checkArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
): string | undefined {
  for (const [name, type] of Object.entries(tool.args)) {
    const v = args[name];
    if (v === undefined || v === null || v === '')
      return `missing argument ${name}`;
    if (!typeOk(type, v)) return `argument ${name} should be ${type}`;
    if (type === 'string[]' && (v as unknown[]).length === 0)
      return `argument ${name} is empty (nothing to look up)`;
  }
  for (const name of Object.keys(args)) {
    if (!(name in tool.args)) return `unexpected argument ${name}`;
  }
  return undefined;
}

function typeOk(type: ArgType, v: unknown): boolean {
  switch (type) {
    case 'string[]':
      return Array.isArray(v);
    case 'number':
      return Number.isFinite(Number(v));
    case 'boolean':
      return typeof v === 'boolean' || v === 'true' || v === 'false';
    default:
      return typeof v === 'string' || typeof v === 'number';
  }
}
