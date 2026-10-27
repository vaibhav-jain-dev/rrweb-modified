import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type {
  ClientMessage,
  ServerMessage,
} from '../../web-extension/src/agent/protocol.ts';
import { createAgentServer, type AgentServer } from '../src/server.ts';
import type { AgentConfig } from '../src/config/types.ts';
import { FakeModel } from '../src/model/fake.ts';
import { fakeRegistry, net, playbook, T0 } from './helpers.ts';

const LOAN = '6a62d0b46ccb69068d608083';

const pb = playbook(
  `
id: writes
title: Writes
description: checks writes
rules:
  - id: create
    title: Loan created
    on: "POST /loan"
    status: "201"
    bind: { loan_id: $res.body._id }
    verify:
      - tool: loan
        args: { id: $loan_id }
        poll: { everyMs: 1000, forMs: 3000 }
        expect: [{ path: found, op: eq, value: true }]
        say: "Loan is there"
`,
  ['loan'],
);

const config: AgentConfig = {
  dir: '',
  sources: [],
  tools: [],
  playbooks: [pb],
  reference: 'ref',
  warnings: [],
};

let agent: AgentServer | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

async function start(
  opts: { token?: string; found?: boolean; model?: FakeModel } = {},
) {
  const { registry } = fakeRegistry(
    { loan: () => ({ found: opts.found ?? true }) },
    { loan: { id: 'id' } },
  );
  agent = createAgentServer({
    config,
    registry,
    model: opts.model ?? null,
    token: opts.token,
    port: 0,
  });
  const { port } = await agent.listen();
  return { port, base: `http://127.0.0.1:${port}` };
}

function connect(port: number, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  const inbox: ServerMessage[] = [];
  const waiters: {
    match: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    inbox.push(m);
    for (const w of [...waiters]) {
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  return {
    ws,
    open: new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
      ws.once('unexpected-response', () => rej(new Error('rejected')));
    }),
    send: (m: ClientMessage) => ws.send(JSON.stringify(m)),
    next: <T extends ServerMessage['type']>(type: T) =>
      new Promise<Extract<ServerMessage, { type: T }>>((resolve) => {
        const hit = inbox.find((m) => m.type === type);
        if (hit) return resolve(hit as never);
        waiters.push({
          match: (m) => m.type === type,
          resolve: resolve as never,
        });
      }),
  };
}

describe('http', () => {
  it('reports health and lists playbooks', async () => {
    const { base } = await start();
    const health = await (await fetch(`${base}/health`)).json();
    expect(health).toMatchObject({ ok: true, model: null, playbooks: 1 });
    const list = await (await fetch(`${base}/playbooks`)).json();
    expect(list).toEqual([
      {
        id: 'writes',
        title: 'Writes',
        description: 'checks writes',
        rules: 1,
        steps: 0,
        needsModel: false,
      },
    ]);
  });

  it('only lets the extension (or localhost) read it from a browser', async () => {
    const { base } = await start();
    const ext = await fetch(`${base}/health`, {
      headers: { origin: 'chrome-extension://abcdef' },
    });
    expect(ext.headers.get('access-control-allow-origin')).toBe(
      'chrome-extension://abcdef',
    );
    const web = await fetch(`${base}/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(web.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('requires the token when one is set, for http and for the socket', async () => {
    const { base, port } = await start({ token: 's3cret' });
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/health`, {
          headers: { 'x-agent-token': 's3cret' },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${base}/health?token=s3cret`)).status).toBe(200);
    const denied = connect(port);
    await expect(denied.open).rejects.toBeTruthy();
    const ok = connect(port, '?token=s3cret');
    await ok.open;
    ok.ws.close();
  });

  it('404s an unknown session', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/sessions/nope/ledger`)).status).toBe(404);
  });
});

describe('a session over the socket', () => {
  it('start → events → stop returns a verified ledger and a narrative', async () => {
    const { port } = await start();
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's1',
      startedAt: T0,
      pageOrigin: 'https://h',
      playbooks: ['writes', 'unknown'],
    });
    const ack = await c.next('session.ack');
    expect(ack).toMatchObject({
      sessionId: 's1',
      lanes: ['writes'],
      resumed: false,
    });

    c.send({
      type: 'event',
      sessionId: 's1',
      kind: 'network',
      t: T0 + 500,
      payload: net('POST', 'https://h/loan', {
        status: 201,
        res: { _id: LOAN },
      }),
    });
    c.send({ type: 'ping' });
    await c.next('pong');
    c.send({ type: 'session.stop', sessionId: 's1', endedAt: T0 + 5000 });
    const result = await c.next('session.result');

    const lane = result.ledger.lanes[0];
    expect(lane.verdict.verified).toBe(1);
    expect(lane.checks[0]).toMatchObject({
      status: 'verified',
      note: 'Loan is there',
      endpoint: 'POST /loan',
    });
    expect(result.ledger.endedAt).toBe(T0 + 5000);
    expect(result.log).toMatch(/OK\s+Loan created/);
    c.ws.close();
  });

  it('streams ledger updates to the live panel over SSE', async () => {
    const { port, base } = await start();
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's2',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    await c.next('session.ack');

    const res = await fetch(`${base}/sessions/s2/stream`);
    const reader = res.body!.getReader();
    const events: {
      type: string;
      ledger?: { lanes: { verdict: { verified: number } }[] };
    }[] = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith('data: '))
            events.push(JSON.parse(frame.slice(6)));
        }
      }
    })();

    c.send({
      type: 'event',
      sessionId: 's2',
      kind: 'network',
      t: T0 + 100,
      payload: net('POST', 'https://h/loan', {
        status: 201,
        res: { _id: LOAN },
      }),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(events[0].type).toBe('ledger');
    expect(events.some((e) => e.ledger?.lanes[0].verdict.verified === 1)).toBe(
      true,
    );

    c.send({ type: 'session.stop', sessionId: 's2', endedAt: T0 + 2000 });
    await c.next('session.result');
    await new Promise((r) => setTimeout(r, 50));
    expect(events.at(-1)!.type).toBe('end');
    await reader.cancel();
    await reading.catch(() => undefined);
    c.ws.close();
  });

  it('a reconnecting worker resumes the same session instead of starting over', async () => {
    const { port } = await start();
    const a = connect(port);
    await a.open;
    a.send({
      type: 'session.start',
      sessionId: 's3',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    await a.next('session.ack');
    a.send({
      type: 'event',
      sessionId: 's3',
      kind: 'network',
      t: T0 + 10,
      payload: net('POST', 'https://h/loan', {
        status: 201,
        res: { _id: LOAN },
      }),
    });
    await new Promise((r) => setTimeout(r, 30));
    a.ws.close();

    const b = connect(port);
    await b.open;
    b.send({
      type: 'session.start',
      sessionId: 's3',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    expect(await b.next('session.ack')).toMatchObject({ resumed: true });
    b.send({ type: 'session.stop', sessionId: 's3', endedAt: T0 + 3000 });
    const result = await b.next('session.result');
    expect(result.ledger.lanes[0].checks).toHaveLength(1);
    b.ws.close();
  });

  it('reports a failing database as failed, with the evidence, not as passed', async () => {
    const { port } = await start({ found: false });
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's4',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    await c.next('session.ack');
    c.send({
      type: 'event',
      sessionId: 's4',
      kind: 'network',
      t: T0 + 10,
      payload: net('POST', 'https://h/loan', {
        status: 201,
        res: { _id: LOAN },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    c.send({ type: 'session.stop', sessionId: 's4', endedAt: T0 + 100 });
    const result = await c.next('session.result');
    // stopping cuts polling short, so the honest status is that it never converged
    const check = result.ledger.lanes[0].checks[0];
    expect(['failed', 'unchecked']).toContain(check.status);
    expect(check.status).not.toBe('verified');
    c.ws.close();
  });

  it('ignores malformed frames without dropping the connection', async () => {
    const { port } = await start();
    const c = connect(port);
    await c.open;
    c.ws.send('not json');
    expect(await c.next('error')).toMatchObject({ message: 'invalid JSON' });
    c.send({ type: 'ping' });
    await c.next('pong');
    c.ws.close();
  });
});

describe('asks over http', () => {
  it('runs an ask with a model and reports a missing model plainly', async () => {
    const model = new FakeModel(() => ({
      claim: 'Loan is there',
      tool: 'loan',
      args: { id: LOAN },
    }));
    const { port, base } = await start({ model });
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's5',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    await c.next('session.ack');

    const res = await fetch(`${base}/sessions/s5/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'is the loan saved?' }),
    });
    expect(await res.json()).toMatchObject({ ok: true, checkId: 'ask#1' });
    await new Promise((r) => setTimeout(r, 30));
    const ledger = await (await fetch(`${base}/sessions/s5/ledger`)).json();
    expect(
      ledger.lanes[0].checks.find(
        (x: { origin: string }) => x.origin === 'ask',
      ),
    ).toMatchObject({ status: 'verified' });

    expect(
      (await fetch(`${base}/sessions/s5/ask`, { method: 'POST', body: '{}' }))
        .status,
    ).toBe(400);
    c.ws.close();
  });

  it('creates an ask-only lane when no playbook is selected', async () => {
    const model = new FakeModel(() => ({
      claim: 'Loan is there',
      tool: 'loan',
      args: { id: LOAN },
    }));
    const { port, base } = await start({ model });
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's6',
      startedAt: T0,
      pageOrigin: '',
      playbooks: [],
    });
    await c.next('session.ack');
    await fetch(`${base}/sessions/s6/ask`, {
      method: 'POST',
      body: JSON.stringify({ text: 'check' }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const ledger = await (await fetch(`${base}/sessions/s6/ledger`)).json();
    expect(
      ledger.lanes.map((l: { playbookId: string }) => l.playbookId),
    ).toEqual(['asks']);
    c.ws.close();
  });

  it('serves request detail for the panel drawer', async () => {
    const { port, base } = await start();
    const c = connect(port);
    await c.open;
    c.send({
      type: 'session.start',
      sessionId: 's7',
      startedAt: T0,
      pageOrigin: '',
      playbooks: ['writes'],
    });
    await c.next('session.ack');
    const n = net('POST', 'https://h/loan', {
      status: 201,
      res: { _id: LOAN },
      req: { a: 1 },
    });
    c.send({
      type: 'event',
      sessionId: 's7',
      kind: 'network',
      t: T0 + 1,
      payload: n,
    });
    await new Promise((r) => setTimeout(r, 30));
    const d = await (
      await fetch(`${base}/sessions/s7/requests/${n.requestId}`)
    ).json();
    expect(d).toMatchObject({
      method: 'POST',
      endpoint: 'POST /loan',
      status: 201,
      requestBody: { a: 1 },
      responseBody: { _id: LOAN },
    });
    expect((await fetch(`${base}/sessions/s7/requests/none`)).status).toBe(404);
    c.ws.close();
  });
});
