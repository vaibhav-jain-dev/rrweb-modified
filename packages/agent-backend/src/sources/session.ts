/**
 * The recording itself as a source: no network, no credentials. Lets a
 * playbook (or an ask) read what the app already returned during this
 * session, e.g. "the last response from POST /session".
 */
import { getPath } from '../expr.ts';
import { matchEndpoint } from '../endpoint.ts';
import type { ToolDef } from '../config/types.ts';
import {
  ToolError,
  type RequestRecord,
  type SourceProvider,
  type ToolContext,
  type ToolRun,
} from './types.ts';

export const SESSION_TOOLS: ToolDef[] = [
  {
    name: 'last_response',
    description:
      'Field from the most recent response of an endpoint in this session.',
    source: 'session',
    args: { endpoint: 'string', path: 'string' },
    spec: {},
  },
  {
    name: 'count_calls',
    description: 'How many times an endpoint was called in this session.',
    source: 'session',
    args: { endpoint: 'string' },
    spec: {},
  },
  {
    name: 'last_status',
    description: 'HTTP status of the most recent call to an endpoint.',
    source: 'session',
    args: { endpoint: 'string' },
    spec: {},
  },
];

function latest(
  requests: readonly RequestRecord[],
  endpoint: string,
): RequestRecord | undefined {
  const m = /^(\S+)\s+(\S+)$/.exec(endpoint.trim());
  if (!m)
    throw new ToolError('bad_args', 'endpoint must look like "POST /path/:id"');
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i];
    if (matchEndpoint(endpoint, r.method, r.pathname)) return r;
  }
  return undefined;
}

export class SessionProvider implements SourceProvider {
  readonly name = 'session';
  readonly type = 'session';
  validateTool(): string | undefined {
    return undefined;
  }
  async health() {
    return { ready: true };
  }
  async run(
    tool: ToolDef,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolRun> {
    const endpoint = String(args.endpoint ?? '');
    switch (tool.name) {
      case 'last_response': {
        const r = latest(ctx.requests, endpoint);
        const value = r
          ? getPath(r.responseBody, String(args.path ?? ''))
          : undefined;
        return {
          value: { found: value !== undefined, value },
          ref: `session last_response ${endpoint}`,
        };
      }
      case 'count_calls': {
        const count = ctx.requests.filter((r) =>
          matchEndpoint(endpoint, r.method, r.pathname),
        ).length;
        return {
          value: { found: count > 0, count },
          ref: `session count_calls ${endpoint}`,
        };
      }
      case 'last_status': {
        const r = latest(ctx.requests, endpoint);
        return {
          value: { found: !!r, status: r?.status },
          ref: `session last_status ${endpoint}`,
        };
      }
      default:
        throw new ToolError('bad_args', `unknown session tool ${tool.name}`);
    }
  }
  async close() {}
}
