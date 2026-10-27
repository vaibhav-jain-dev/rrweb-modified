/**
 * The service worker's connection to the agent backend.
 *
 * Designed so the agent can never hurt a recording: every method resolves
 * rather than throws, sends are fire-and-forget into a bounded buffer, and a
 * dead backend just means no ledger in the export (marked incomplete if some
 * of it had already arrived).
 *
 * The socket also keeps the MV3 service worker alive: Chrome resets a
 * worker's idle timer on WebSocket traffic, and a ping goes out every 20 s.
 */
import { renderAgentLog } from './log';
import type {
  AgentConfig,
  AgentEventPayload,
  AgentResult,
  ClientMessage,
  Ledger,
  ServerMessage,
} from './protocol';

export const PING_MS = 20_000;
export const MAX_BUFFERED = 500;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const RESULT_TIMEOUT_MS = 10_000;
/** How long Stop waits when the socket is already down: one retry, not the full wait. */
const LOST_RESULT_TIMEOUT_MS = 3_000;

export type StatusUpdate = {
  state: 'connecting' | 'connected' | 'lost' | 'finished';
  model?: string;
  lanes?: string[];
  message?: string;
};

export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export type ClientDeps = {
  createSocket: (url: string) => SocketLike;
  onStatus: (s: StatusUpdate) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  now: () => number;
};

export type StartOptions = {
  sessionId: string;
  startedAt: number;
  pageOrigin: string;
};

export type AgentClient = {
  sendEvent(ev: AgentEventPayload): void;
  /** Resolves with the backend's result, or a ledger assembled from the last update. */
  stop(endedAt: number): Promise<AgentResult | undefined>;
  lastLedger(): Ledger | undefined;
};

const CONNECTING = 0;
const OPEN = 1;

export function toWebSocketUrl(config: AgentConfig): string | undefined {
  try {
    const u = new URL(config.backendUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = config.token ? `?token=${encodeURIComponent(config.token)}` : '';
    return u.toString();
  } catch {
    return undefined;
  }
}

export function createAgentClient(
  config: AgentConfig,
  opts: StartOptions,
  deps: ClientDeps,
): AgentClient | undefined {
  const url = toWebSocketUrl(config);
  if (!url || config.playbooks.length === 0) return undefined;

  let socket: SocketLike | undefined;
  let closed = false;
  let attempt = 0;
  let pingTimer: unknown;
  let reconnectTimer: unknown;
  let ledger: Ledger | undefined;
  let model: string | undefined;
  let lanes: string[] | undefined;
  let result: AgentResult | undefined;
  let everConnected = false;
  let resolveResult: ((r: AgentResult) => void) | undefined;
  // Events produced while the socket is down, replayed after reconnecting.
  const buffer: ClientMessage[] = [];

  const hello = (): ClientMessage => ({
    type: 'session.start',
    sessionId: opts.sessionId,
    startedAt: opts.startedAt,
    pageOrigin: opts.pageOrigin,
    playbooks: config.playbooks,
    token: config.token,
  });

  const raw = (m: ClientMessage) => socket?.send(JSON.stringify(m));
  const isOpen = () => socket?.readyState === OPEN;

  function enqueue(m: ClientMessage) {
    buffer.push(m);
    // Drop the oldest, never the session.start/stop framing (those are not buffered here).
    if (buffer.length > MAX_BUFFERED) buffer.shift();
  }

  function connect() {
    if (closed) return;
    deps.onStatus({
      state: attempt === 0 ? 'connecting' : 'lost',
      message: attempt === 0 ? undefined : 'Reconnecting to the agent backend…',
    });
    let s: SocketLike;
    try {
      s = deps.createSocket(url!);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = s;
    s.onopen = () => {
      everConnected = true;
      attempt = 0;
      raw(hello());
      for (const m of buffer.splice(0)) raw(m);
      clearPing();
      pingTimer = deps.setTimer(function tick() {
        if (closed) return;
        if (isOpen()) raw({ type: 'ping' });
        pingTimer = deps.setTimer(tick, PING_MS);
      }, PING_MS);
    };
    s.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'session.ack':
          model = msg.model;
          lanes = msg.lanes;
          deps.onStatus({
            state: 'connected',
            model,
            lanes,
            message:
              msg.lanes.length < config.playbooks.length
                ? 'Some selected playbooks were not found on the backend.'
                : undefined,
          });
          break;
        case 'ledger.update':
          ledger = msg.ledger;
          break;
        case 'session.result':
          result = { ledger: msg.ledger, log: msg.log };
          ledger = msg.ledger;
          resolveResult?.(result);
          break;
        case 'error':
          deps.onStatus({
            state: 'connected',
            model,
            lanes,
            message: msg.message,
          });
          break;
        default:
          break;
      }
    };
    s.onclose = () => {
      clearPing();
      if (closed || result) return;
      deps.onStatus({
        state: 'lost',
        model,
        lanes,
        message:
          'Lost the agent backend. Recording continues; the agent section of the export may be incomplete.',
      });
      scheduleReconnect();
    };
    s.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  function clearPing() {
    if (pingTimer !== undefined) deps.clearTimer(pingTimer);
    pingTimer = undefined;
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer !== undefined) return;
    attempt++;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** Math.min(attempt - 1, 4),
    );
    reconnectTimer = deps.setTimer(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function shutdown() {
    closed = true;
    clearPing();
    if (reconnectTimer !== undefined) deps.clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  }

  connect();

  return {
    sendEvent(ev) {
      if (closed) return;
      const m: ClientMessage = {
        type: 'event',
        sessionId: opts.sessionId,
        ...ev,
      };
      if (isOpen()) raw(m);
      else enqueue(m);
    },

    lastLedger: () => ledger,

    async stop(endedAt) {
      if (closed && result) return result;
      // Never reached the backend: nothing to wait for, so Stop is not delayed.
      if (!everConnected) {
        shutdown();
        deps.onStatus({
          state: 'lost',
          message:
            'The agent backend was never reachable during this recording.',
        });
        return undefined;
      }
      const connected = isOpen();
      const finished = new Promise<AgentResult | undefined>((resolve) => {
        const timer = deps.setTimer(
          () => resolve(undefined),
          connected ? RESULT_TIMEOUT_MS : LOST_RESULT_TIMEOUT_MS,
        );
        resolveResult = (r) => {
          deps.clearTimer(timer);
          resolve(r);
        };
      });
      const stopMsg: ClientMessage = {
        type: 'session.stop',
        sessionId: opts.sessionId,
        endedAt,
      };
      if (connected) raw(stopMsg);
      else {
        // Not connected right now: queue it and retry at once rather than at
        // the next backoff step, so a backend that is back still delivers
        // the result and one that is gone holds the export only briefly.
        enqueue(stopMsg);
        if (reconnectTimer !== undefined) deps.clearTimer(reconnectTimer);
        reconnectTimer = undefined;
        if (socket?.readyState !== CONNECTING) connect();
      }
      const got = await finished;
      shutdown();
      if (got) {
        deps.onStatus({ state: 'finished', model, lanes });
        return got;
      }
      if (!ledger) return undefined;
      // The backend never answered. Keep what had already arrived and say so.
      const partial: Ledger = { ...ledger, endedAt, incomplete: true };
      deps.onStatus({
        state: 'lost',
        model,
        lanes,
        message:
          'The agent backend did not answer at Stop; the export has the last ledger it sent.',
      });
      return { ledger: partial, log: renderAgentLog(partial) };
    },
  };
}
