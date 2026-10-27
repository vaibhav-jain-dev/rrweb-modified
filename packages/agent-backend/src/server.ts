import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AskRequest,
  ClientMessage,
  HealthResponse,
  PlaybookSummary,
  ServerMessage,
} from '../../web-extension/src/agent/protocol.ts';
import type { AgentConfig } from './config/types.ts';
import { handleMcpRequest } from './mcp.ts';
import type { ModelClient } from './model/types.ts';
import { SessionRuntime } from './session.ts';
import type { ToolRegistry } from './tools/registry.ts';

export const VERSION = '0.1.0';
/** A finished session stays readable (for a late result fetch) this long. */
const KEEP_ENDED_MS = 10 * 60_000;
const MAX_BODY = 64 * 1024;

export type ServerOptions = {
  config: AgentConfig;
  registry: ToolRegistry;
  model: ModelClient | null;
  token?: string;
  host?: string;
  port: number;
};

export type AgentServer = {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  sessions: Map<string, SessionRuntime>;
};

export function createAgentServer(opts: ServerOptions): AgentServer {
  const sessions = new Map<string, SessionRuntime>();
  const sockets = new Set<WebSocket>();
  const endTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!opts.token) return true;
    return (
      req.headers['x-agent-token'] === opts.token ||
      url.searchParams.get('token') === opts.token
    );
  };

  const origin = (req: IncomingMessage): string | undefined => {
    const o = req.headers.origin;
    if (!o) return undefined;
    // Only the extension, and local pages in development, may talk to this.
    return /^(chrome-extension|moz-extension):\/\//.test(o) ||
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)
      ? o
      : undefined;
  };

  /** On loopback, the Host values a local client can send; anything else is DNS rebinding. */
  const loopbackHosts = (): string[] | undefined => {
    const host = opts.host ?? '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return undefined;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : opts.port;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  };

  const json = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
  ) => {
    const o = origin(req);
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(o ? { 'access-control-allow-origin': o, vary: 'origin' } : {}),
    });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(
            chunks.length
              ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
              : {},
          );
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent)
        json(req, res, 500, {
          ok: false,
          message: e instanceof Error ? e.message : 'error',
        });
      else res.end();
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const o = origin(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(o ? { 'access-control-allow-origin': o, vary: 'origin' } : {}),
        'access-control-allow-headers': 'content-type, x-agent-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }
    if (!authorized(req, url))
      return json(req, res, 401, {
        ok: false,
        message: 'bad or missing token',
      });

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/mcp') {
      // MCP clients send no Origin; a web page does, and may not use this.
      if (req.headers.origin && !o)
        return json(req, res, 403, { ok: false, message: 'origin not allowed' });
      return handleMcpRequest(
        req,
        res,
        { registry: opts.registry, sessions, version: VERSION },
        loopbackHosts(),
      );
    }

    if (req.method === 'GET' && path === '/health') {
      const health: HealthResponse = {
        ok: true,
        version: VERSION,
        model: opts.model?.name ?? null,
        gpu: opts.model?.gpu() ?? null,
        playbooks: opts.config.playbooks.length,
        sources: await opts.registry.health(),
      };
      return json(req, res, 200, health);
    }

    if (req.method === 'GET' && path === '/playbooks') {
      const list: PlaybookSummary[] = opts.config.playbooks.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        rules: p.rules.length,
        steps: p.steps.length,
        needsModel: p.needsModel,
      }));
      return json(req, res, 200, list);
    }

    const m = /^\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (m) {
      const session = sessions.get(decodeURIComponent(m[1]));
      const rest = m[2] ?? '';
      if (!session)
        return json(req, res, 404, { ok: false, message: 'unknown session' });

      if (req.method === 'GET' && rest === 'ledger')
        return json(req, res, 200, session.ledger());

      if (req.method === 'GET' && rest === 'stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...(o ? { 'access-control-allow-origin': o, vary: 'origin' } : {}),
        });
        const write = (e: unknown) =>
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        const unsub = session.subscribe(write);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          unsub();
        });
        return;
      }

      if (req.method === 'GET' && rest.startsWith('requests/')) {
        const d = session.requestDetail(
          decodeURIComponent(rest.slice('requests/'.length)),
        );
        return d
          ? json(req, res, 200, d)
          : json(req, res, 404, {
              ok: false,
              message: 'request no longer held',
            });
      }

      if (req.method === 'POST' && rest === 'ask') {
        const body = (await readBody(req)) as Partial<AskRequest>;
        if (typeof body.text !== 'string' || !body.text.trim())
          return json(req, res, 400, {
            ok: false,
            message: 'text is required',
          });
        if (session.isEnded)
          return json(req, res, 409, {
            ok: false,
            message: 'the session has ended',
          });
        return json(
          req,
          res,
          200,
          await session.ask(body.text.trim().slice(0, 500), body.playbookId),
        );
      }
    }

    json(req, res, 404, { ok: false, message: 'not found' });
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !authorized(req, url)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, req),
    );
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    let attached: SessionRuntime | undefined;
    let unsub: (() => void) | undefined;

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return send(ws, { type: 'error', message: 'invalid JSON' });
      }
      void onMessage(msg).catch((e: unknown) =>
        send(ws, {
          type: 'error',
          message: e instanceof Error ? e.message : 'error',
        }),
      );
    });
    ws.on('close', () => {
      sockets.delete(ws);
      unsub?.();
    });

    async function onMessage(msg: ClientMessage): Promise<void> {
      switch (msg.type) {
        case 'ping':
          return send(ws, { type: 'pong' });
        case 'session.start': {
          const existing = sessions.get(msg.sessionId);
          const resumed = !!existing && !existing.isEnded;
          let s = existing;
          if (!s || s.isEnded) {
            const wanted = new Set(msg.playbooks);
            s = new SessionRuntime({
              sessionId: msg.sessionId,
              startedAt: msg.startedAt,
              pageOrigin: msg.pageOrigin,
              playbooks: opts.config.playbooks.filter((p) => wanted.has(p.id)),
              registry: opts.registry,
              model: opts.model,
              reference: opts.config.reference,
            });
            sessions.set(msg.sessionId, s);
          }
          unsub?.();
          attached = s;
          unsub = s.subscribe((e) => {
            if (e.type === 'ledger')
              send(ws, {
                type: 'ledger.update',
                sessionId: s!.sessionId,
                ledger: e.ledger,
              });
          });
          return send(ws, {
            type: 'session.ack',
            sessionId: s.sessionId,
            lanes: s.laneIds(),
            model: opts.model?.name ?? undefined,
            resumed,
          });
        }
        case 'event': {
          const s = sessions.get(msg.sessionId) ?? attached;
          if (!s)
            return send(ws, { type: 'error', message: 'unknown session' });
          const { type: _t, sessionId: _s, ...ev } = msg;
          s.ingest(ev);
          return;
        }
        case 'session.stop': {
          const s = sessions.get(msg.sessionId) ?? attached;
          if (!s)
            return send(ws, { type: 'error', message: 'unknown session' });
          const result = await s.stop(msg.endedAt);
          send(ws, {
            type: 'session.result',
            sessionId: s.sessionId,
            ...result,
          });
          endTimers.set(
            s.sessionId,
            setTimeout(() => {
              sessions.delete(s.sessionId);
              endTimers.delete(s.sessionId);
            }, KEEP_ENDED_MS),
          );
          return;
        }
      }
    }
  });

  return {
    server,
    sessions,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            host: opts.host ?? '127.0.0.1',
            port: typeof addr === 'object' && addr ? addr.port : opts.port,
          });
        });
      }),
    close: async () => {
      for (const t of endTimers.values()) clearTimeout(t);
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      await opts.registry.close();
    },
  };
}
