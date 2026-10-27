import type { NetworkRequest } from '../../web-extension/src/evidence/types.ts';
import type { PlaybookDef, ToolDef } from '../src/config/types.ts';
import { parsePlaybook } from '../src/config/load.ts';
import { toRequestRecord } from '../src/endpoint.ts';
import { Lane, type LaneDeps } from '../src/lane.ts';
import type { ModelClient } from '../src/model/types.ts';
import type { RunOutcome, ToolRegistry } from '../src/tools/registry.ts';
import type { RequestRecord, ToolContext } from '../src/sources/types.ts';

export const T0 = 1_700_000_000_000;

let seq = 0;
export function net(
  method: string,
  url: string,
  over: Partial<NetworkRequest> & { req?: unknown; res?: unknown } = {},
): NetworkRequest {
  const { req, res, ...rest } = over;
  seq++;
  return {
    requestId: `r${seq}`,
    method,
    url,
    status: 200,
    resourceType: 'Fetch',
    requestBody: req === undefined ? null : JSON.stringify(req),
    responseBody: res === undefined ? null : JSON.stringify(res),
    startTime: T0 + 1000 * seq,
    endTime: T0 + 1000 * seq + 50,
    ...rest,
  };
}

export function rec(
  method: string,
  url: string,
  over: Parameters<typeof net>[2] = {},
): RequestRecord {
  return toRequestRecord(net(method, url, over), T0);
}

function isOutcome(v: unknown): v is RunOutcome {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.ok === true
    ? 'run' in o && 'ms' in o
    : o.ok === false && 'kind' in o && 'message' in o;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) =>
  | RunOutcome
  | Record<string, unknown>
  | Promise<RunOutcome | Record<string, unknown>>;

/** A registry whose tools are plain functions; records every call. */
export function fakeRegistry(
  handlers: Record<string, ToolHandler>,
  argTypes: Record<string, ToolDef['args']> = {},
) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const defs = new Map<string, ToolDef>(
    Object.keys(handlers).map((name) => [
      name,
      {
        name,
        description: `${name} tool`,
        source: 'x',
        args: argTypes[name] ?? {},
        spec: {},
      },
    ]),
  );
  const reg = {
    has: (n: string) => defs.has(n),
    get: (n: string) => defs.get(n),
    list: () => [...defs.values()],
    describe: () => [...defs.values()].map((d) => `- ${d.name}`).join('\n'),
    health: async () => ({}),
    close: async () => {},
    invalid: new Map<string, string>(),
    async run(
      name: string,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<RunOutcome> {
      calls.push({ tool: name, args });
      const h = handlers[name];
      if (!h)
        return {
          ok: false,
          kind: 'bad_args',
          message: `unknown tool ${name}`,
          ms: 0,
        };
      const out = await h(args, ctx);
      if (isOutcome(out)) return out;
      return {
        ok: true,
        run: { value: out as Record<string, unknown>, ref: `fake ${name}` },
        ms: 1,
      };
    },
  };
  return { registry: reg as unknown as ToolRegistry, calls };
}

export function playbook(
  yamlFrontMatter: string,
  tools: string[],
): PlaybookDef {
  return parsePlaybook(
    `---\n${yamlFrontMatter}\n---\nbrief`,
    'test.md',
    new Set(tools),
  );
}

/** A lane on a virtual clock: sleeping advances time instantly. */
export function makeLane(
  pb: PlaybookDef,
  registry: ToolRegistry,
  opts: { model?: ModelClient | null; requests?: RequestRecord[] } = {},
) {
  let clock = T0;
  const gates: number[] = [];
  const requests = opts.requests ?? [];
  const deps: LaneDeps = {
    registry,
    model: opts.model ?? null,
    reference: '',
    startedAt: T0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    requests: () => requests,
    onChange: () => {},
    onGate: (t) => gates.push(t),
  };
  const lane = new Lane(pb, deps);
  return {
    lane,
    gates,
    requests,
    feed(r: RequestRecord) {
      clock = Math.max(clock, r.endTime);
      requests.push(r);
      lane.onRequest(r);
    },
    idle: () => lane.idle(),
    /** Let polling run its course, then close the lane the way Stop would. */
    settle: async () => {
      await lane.idle();
      await lane.finalize(2000);
    },
  };
}
