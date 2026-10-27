/**
 * The backend as an MCP server (Streamable HTTP at `/mcp`, stateless), so an
 * MCP client such as Claude Code can follow a recording while it happens:
 * list the sessions, read a ledger, look at the requests, and run the same
 * named lookups the playbooks use. Nothing here writes, and a source is only
 * reached through the registry's typed tools - the same guarantees as a rule.
 *
 *   claude mcp add --transport http rrweb-agent http://127.0.0.1:47821/mcp
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { renderAgentLog } from '../../web-extension/src/agent/log.ts';
import type { CheckStatus } from '../../web-extension/src/agent/protocol.ts';
import type { SessionRuntime } from './session.ts';
import type { ToolRegistry } from './tools/registry.ts';

export type McpDeps = {
  registry: ToolRegistry;
  sessions: Map<string, SessionRuntime>;
  version: string;
};

const INSTRUCTIONS =
  'Follows recordings the rrweb extension streams to this backend while the live agent is on. ' +
  'Start with sessions (newest first). ledger gives the checks the agent decided (verified / failed / unchecked / never_seen) as a short log; ' +
  'statuses come from code comparing database or API results, never from a model. ' +
  'requests lists what the app called; request shows one with bodies (cut at 4 KB). ' +
  'lookup runs one named, read-only lookup (the list is in its description); it never writes and accepts only the declared arguments.';

// The SDK's generic tool typing recurses without bound on zod 3.25; the
// schemas are still validated at runtime, so register through a loose type.
type Handler = (args: any) => Promise<unknown> | unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
type Register = (
  name: string,
  config: { description: string; inputSchema: Record<string, unknown> },
  cb: Handler,
) => void;

const text = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
});
const fail = (t: string) => ({ ...text(t), isError: true });

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'rrweb-agent', version: deps.version },
    { instructions: INSTRUCTIONS },
  );
  const register = server.registerTool.bind(server) as unknown as Register;

  const session = (id: string | undefined) => {
    if (id) return deps.sessions.get(id);
    // Default to the newest session that is still recording.
    const all = [...deps.sessions.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    return all.find((s) => !s.isEnded) ?? all[0];
  };
  const sessionArg = z
    .string()
    .optional()
    .describe('session id from `sessions`; default: the newest one');

  register(
    'sessions',
    {
      description:
        'Recordings this backend is following or finished in the last 10 minutes, newest first, with their check counts.',
      inputSchema: {},
    },
    () => {
      const all = [...deps.sessions.values()].sort(
        (a, b) => b.startedAt - a.startedAt,
      );
      if (!all.length)
        return text(
          'No sessions. Start a recording in the extension with a live-agent playbook selected.',
        );
      return text(
        all
          .map((s) => {
            const { lanes } = s.ledger();
            const n = (k: CheckStatus) =>
              lanes.reduce((sum, lane) => sum + lane.verdict[k], 0);
            return `${s.sessionId}  ${s.isEnded ? 'ended' : 'recording'}  started ${new Date(
              s.startedAt,
            ).toISOString()}  lanes: ${s.laneIds().join(', ') || '(none)'}  ${n(
              'verified',
            )} verified · ${n('failed')} failed · ${n(
              'unchecked',
            )} unchecked · ${n('never_seen')} never seen`;
          })
          .join('\n'),
      );
    },
  );

  register(
    'ledger',
    {
      description:
        "A session's checks: `log` (default) is one line per check in time order; `json` is the full ledger with evidence.",
      inputSchema: {
        sessionId: sessionArg,
        format: z.enum(['log', 'json']).optional(),
      },
    },
    ({ sessionId, format }: { sessionId?: string; format?: 'log' | 'json' }) => {
      const s = session(sessionId);
      if (!s) return fail(`unknown session ${sessionId ?? ''}`.trim());
      const l = s.ledger();
      return text(
        format === 'json' ? JSON.stringify(l, null, 2) : renderAgentLog(l),
      );
    },
  );

  register(
    'requests',
    {
      description:
        'What the app called during a session, newest first: request id, endpoint, status, time from start. Writes only by default.',
      inputSchema: {
        sessionId: sessionArg,
        all: z
          .boolean()
          .optional()
          .describe('include GETs, not only POST/PUT/PATCH/DELETE'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    ({
      sessionId,
      all,
      limit,
    }: {
      sessionId?: string;
      all?: boolean;
      limit?: number;
    }) => {
      const s = session(sessionId);
      if (!s) return fail(`unknown session ${sessionId ?? ''}`.trim());
      const list = s.requestList(limit ?? 30, !all);
      if (!list.length) return text('No requests yet.');
      return text(
        list
          .map(
            (r) =>
              `${(r.tRel / 1000).toFixed(1)}s  ${r.requestId}  ${r.endpoint}  ${
                r.status ?? '–'
              }`,
          )
          .join('\n'),
      );
    },
  );

  register(
    'request',
    {
      description:
        'One request with its bodies (each cut at 4 KB). The backend holds the last 400 requests of a session.',
      inputSchema: { sessionId: sessionArg, requestId: z.string() },
    },
    ({ sessionId, requestId }: { sessionId?: string; requestId: string }) => {
      const s = session(sessionId);
      if (!s) return fail(`unknown session ${sessionId ?? ''}`.trim());
      const d = s.requestDetail(requestId);
      return d
        ? text(JSON.stringify(d, null, 2))
        : fail(`request ${requestId} is no longer held`);
    },
  );

  const tools = deps.registry.list().map((t) => t.name);
  if (tools.length) {
    register(
      'lookup',
      {
        description:
          'Run one named, read-only lookup and get its projected result and how it was obtained. Available:\n' +
          deps.registry.describe(),
        inputSchema: {
          tool: z.enum(tools as [string, ...string[]]),
          args: z
            .record(z.unknown())
            .optional()
            .describe('the arguments named in the tool signature'),
          sessionId: sessionArg.describe(
            'session whose requests the built-in session tools read; default: the newest one',
          ),
        },
      },
      async ({
        tool,
        args,
        sessionId,
      }: {
        tool: string;
        args?: Record<string, unknown>;
        sessionId?: string;
      }) => {
        const s = session(sessionId);
        const out = await deps.registry.run(
          tool,
          args ?? {},
          s?.toolContext() ?? { requests: [] },
        );
        if (!out.ok)
          return fail(
            `${out.kind === 'unavailable' ? 'could not check' : 'bad call'}: ${
              out.message
            }`,
          );
        return text(
          JSON.stringify(
            { value: out.run.value, ref: out.run.ref, ms: out.ms },
            null,
            2,
          ),
        );
      },
    );
  }

  server.registerResource(
    'ledger',
    new ResourceTemplate('session://{id}/ledger', {
      list: () => ({
        resources: [...deps.sessions.values()].map((s) => ({
          uri: `session://${s.sessionId}/ledger`,
          name: `ledger ${s.sessionId}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      description: "A session's full ledger",
      mimeType: 'application/json',
    },
    (uri, { id }) => {
      const s = deps.sessions.get(String(id));
      if (!s) throw new Error(`unknown session ${String(id)}`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(s.ledger(), null, 2),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Serve one MCP request. Stateless: a fresh server and transport per
 * request, so nothing lingers between calls. `allowedHosts` (set when the
 * backend listens on loopback) refuses DNS-rebinding requests.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpDeps,
  allowedHosts: string[] | undefined,
): Promise<void> {
  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...(allowedHosts
      ? { enableDnsRebindingProtection: true, allowedHosts }
      : {}),
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
