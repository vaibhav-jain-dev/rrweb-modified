import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_BUFFERED,
  PING_MS,
  createAgentClient,
  toWebSocketUrl,
  type ClientDeps,
  type SocketLike,
  type StatusUpdate,
} from '~/agent/client';
import type {
  AgentConfig,
  ClientMessage,
  ServerMessage,
} from '~/agent/protocol';
import { check, lane, result } from './agent-fixtures';

class MockSocket implements SocketLike {
  static all: MockSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    MockSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

type Timer = { id: number; at: number; fn: () => void };
function clock() {
  let now = 0;
  let next = 1;
  let timers: Timer[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { id: next++, at: now + ms, fn };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    now: () => now,
    pending: () => timers.length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

const config: AgentConfig = {
  backendUrl: 'http://127.0.0.1:47821',
  playbooks: ['lms-writes'],
};
const opts = { sessionId: 's1', startedAt: 1000, pageOrigin: 'https://app' };
let statuses: StatusUpdate[];
let c: ReturnType<typeof clock>;

function make(cfg = config) {
  const deps: ClientDeps = {
    createSocket: (url) => new MockSocket(url),
    onStatus: (s) => statuses.push(s),
    ...c,
  };
  return createAgentClient(cfg, opts, deps);
}
const sock = () => MockSocket.all[MockSocket.all.length - 1];

beforeEach(() => {
  MockSocket.all = [];
  statuses = [];
  c = clock();
});

describe('toWebSocketUrl', () => {
  it('maps http to ws and https to wss, carrying the token', () => {
    expect(toWebSocketUrl({ ...config, token: 'a b' })).toBe(
      'ws://127.0.0.1:47821/ws?token=a%20b',
    );
    expect(
      toWebSocketUrl({ ...config, backendUrl: 'https://agent.local:9' }),
    ).toBe('wss://agent.local:9/ws');
    expect(
      toWebSocketUrl({ ...config, backendUrl: 'nonsense' }),
    ).toBeUndefined();
  });
});

describe('createAgentClient', () => {
  it('does nothing without playbooks or with a bad address', () => {
    expect(make({ ...config, playbooks: [] })).toBeUndefined();
    expect(make({ ...config, backendUrl: 'nonsense' })).toBeUndefined();
    expect(MockSocket.all).toHaveLength(0);
  });

  it('sends session.start first, then everything produced before the socket opened, in order', () => {
    const client = make()!;
    client.sendEvent({
      kind: 'network',
      t: 1,
      payload: { requestId: 'a', method: 'POST', url: 'u', startTime: 1 },
    });
    client.sendEvent({
      kind: 'network',
      t: 2,
      payload: { requestId: 'b', method: 'POST', url: 'u', startTime: 2 },
    });
    sock().open();
    expect(sock().sent.map((m) => m.type)).toEqual([
      'session.start',
      'event',
      'event',
    ]);
    expect(sock().sent[0]).toMatchObject({
      sessionId: 's1',
      startedAt: 1000,
      playbooks: ['lms-writes'],
    });
    // once open, events go straight out
    client.sendEvent({
      kind: 'network',
      t: 3,
      payload: { requestId: 'c', method: 'POST', url: 'u', startTime: 3 },
    });
    expect(sock().sent).toHaveLength(4);
  });

  it('keeps only the newest events when the backend stays away', () => {
    const client = make()!;
    for (let i = 0; i < MAX_BUFFERED + 50; i++) {
      client.sendEvent({
        kind: 'network',
        t: i,
        payload: { requestId: `r${i}`, method: 'POST', url: 'u', startTime: i },
      });
    }
    sock().open();
    const events = sock().sent.filter((m) => m.type === 'event');
    expect(events).toHaveLength(MAX_BUFFERED);
    expect((events[0] as { t: number }).t).toBe(50);
  });

  it('pings every 20 s while open (this also keeps the service worker alive)', async () => {
    make();
    sock().open();
    await c.advance(PING_MS * 3 + 5);
    expect(sock().sent.filter((m) => m.type === 'ping')).toHaveLength(3);
  });

  it('reports connected on ack and keeps the ledger it is sent', () => {
    const client = make()!;
    sock().open();
    sock().receive({
      type: 'session.ack',
      sessionId: 's1',
      lanes: ['lms-writes'],
      model: 'm',
      resumed: false,
    });
    expect(statuses.at(-1)).toMatchObject({
      state: 'connected',
      model: 'm',
      lanes: ['lms-writes'],
    });
    const l = result([lane([check()])]).ledger;
    sock().receive({ type: 'ledger.update', sessionId: 's1', ledger: l });
    expect(client.lastLedger()).toEqual(l);
  });

  it('warns when the backend does not know a selected playbook', () => {
    make({ ...config, playbooks: ['lms-writes', 'gone'] });
    sock().open();
    sock().receive({
      type: 'session.ack',
      sessionId: 's1',
      lanes: ['lms-writes'],
      resumed: false,
    });
    expect(statuses.at(-1)?.message).toMatch(/not found/);
  });

  it('reconnects with backoff after a drop and replays what it missed', async () => {
    const client = make()!;
    sock().open();
    sock().drop();
    expect(statuses.at(-1)).toMatchObject({ state: 'lost' });
    client.sendEvent({
      kind: 'network',
      t: 5,
      payload: { requestId: 'late', method: 'POST', url: 'u', startTime: 5 },
    });
    expect(MockSocket.all).toHaveLength(1);
    await c.advance(1000);
    expect(MockSocket.all).toHaveLength(2);
    sock().open();
    expect(sock().sent.map((m) => m.type)).toEqual(['session.start', 'event']);
    // a drop after a good connection starts over at 1 s...
    sock().drop();
    await c.advance(1000);
    expect(MockSocket.all).toHaveLength(3);
    // ...but attempts that never connect back off: 2 s, then 4 s
    sock().drop();
    await c.advance(1000);
    expect(MockSocket.all).toHaveLength(3);
    await c.advance(1000);
    expect(MockSocket.all).toHaveLength(4);
    sock().drop();
    await c.advance(3000);
    expect(MockSocket.all).toHaveLength(4);
    await c.advance(1000);
    expect(MockSocket.all).toHaveLength(5);
  });
});

describe('stop', () => {
  it('returns the backend result', async () => {
    const client = make()!;
    sock().open();
    const r = result([lane([check()])]);
    const done = client.stop(9000);
    expect(sock().sent.at(-1)).toEqual({
      type: 'session.stop',
      sessionId: 's1',
      endedAt: 9000,
    });
    sock().receive({ type: 'session.result', sessionId: 's1', ...r });
    expect(await done).toEqual(r);
    expect(sock().closed).toBe(true);
    expect(statuses.at(-1)?.state).toBe('finished');
  });

  it('does not make Stop wait when the backend was never reachable', async () => {
    const client = make()!;
    const out = await client.stop(1);
    expect(out).toBeUndefined();
    expect(c.pending()).toBe(0);
    expect(statuses.at(-1)).toMatchObject({
      state: 'lost',
      message: expect.stringMatching(/never reachable/),
    });
  });

  it('falls back to the last ledger, marked incomplete, if the backend goes quiet at Stop', async () => {
    const client = make()!;
    sock().open();
    const l = result([
      lane([check({ status: 'failed', note: 'row missing' })]),
    ]).ledger;
    sock().receive({ type: 'ledger.update', sessionId: 's1', ledger: l });
    const done = client.stop(9000);
    await c.advance(10_000);
    const out = await done;
    expect(out?.ledger.incomplete).toBe(true);
    expect(out?.ledger.endedAt).toBe(9000);
    expect(out?.log).toMatch(/backend was lost/);
    expect(out?.log).toMatch(/FAIL/);
  });

  it('still delivers Stop if the backend comes back within the wait', async () => {
    const client = make()!;
    sock().open();
    sock().drop();
    const done = client.stop(9000);
    await c.advance(1000);
    sock().open();
    expect(sock().sent.map((m) => m.type)).toEqual([
      'session.start',
      'session.stop',
    ]);
    sock().receive({
      type: 'session.result',
      sessionId: 's1',
      ...result([lane([check()])]),
    });
    expect((await done)?.ledger.lanes).toHaveLength(1);
  });

  it('retries at once and waits only briefly when the backend is already gone at Stop', async () => {
    const client = make()!;
    sock().open();
    const l = result([lane([check()])]).ledger;
    sock().receive({ type: 'ledger.update', sessionId: 's1', ledger: l });
    sock().drop();
    let out: Awaited<ReturnType<typeof client.stop>> | 'pending' = 'pending';
    void client.stop(9000).then((r) => (out = r));
    // the retry does not wait for the backoff timer
    expect(MockSocket.all).toHaveLength(2);
    sock().drop();
    await c.advance(2999);
    expect(out).toBe('pending');
    await c.advance(1);
    expect(out).toMatchObject({ ledger: { incomplete: true } });
    expect(c.pending()).toBe(0);
  });

  it('returns nothing, rather than inventing a ledger, if it never received one', async () => {
    const client = make()!;
    sock().open();
    const done = client.stop(9000);
    await c.advance(10_000);
    expect(await done).toBeUndefined();
  });
});
