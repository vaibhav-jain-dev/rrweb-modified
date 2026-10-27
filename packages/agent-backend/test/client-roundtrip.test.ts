/**
 * The extension's real client against the backend's real server, over a real
 * WebSocket: the two halves have otherwise only been tested against mocks of
 * each other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createAgentClient,
  type StatusUpdate,
} from '../../web-extension/src/agent/client.ts';
import { attachActionSeq } from '../../web-extension/src/evidence/agent-export.ts';
import { createAgentServer, type AgentServer } from '../src/server.ts';
import type { AgentConfig } from '../src/config/types.ts';
import { fakeRegistry, net, playbook, T0 } from './helpers.ts';

const LOAN = '6a62d0b46ccb69068d608083';
const pb = playbook(
  `
id: writes
title: Writes
rules:
  - id: create
    title: Loan created
    on: "POST /loan"
    status: "201"
    bind: { loan_id: $res.body._id }
    verify:
      - tool: loan
        args: { id: $loan_id }
        poll: { everyMs: 1000, forMs: 4000 }
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
  reference: '',
  warnings: [],
};

let agent: AgentServer | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

const realTimers = {
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: Date.now,
};

describe('extension client <-> backend server', () => {
  it('records, verifies and returns a ledger that survives the export join', async () => {
    const { registry } = fakeRegistry(
      { loan: () => ({ found: true }) },
      { loan: { id: 'id' } },
    );
    agent = createAgentServer({ config, registry, model: null, port: 0 });
    const { port } = await agent.listen();

    const statuses: StatusUpdate[] = [];
    const client = createAgentClient(
      { backendUrl: `http://127.0.0.1:${port}`, playbooks: ['writes'] },
      { sessionId: 'rt1', startedAt: T0, pageOrigin: 'https://app' },
      {
        createSocket: (url) => new WebSocket(url) as never,
        onStatus: (s) => statuses.push(s),
        ...realTimers,
      },
    )!;

    // events sent before the socket is even open are buffered and replayed
    const call = net('POST', 'https://app/loan', {
      status: 201,
      res: { _id: LOAN },
      actionSeq: 3,
    });
    client.sendEvent({ kind: 'network', t: T0 + 700, payload: call });
    await new Promise((r) => setTimeout(r, 150));
    expect(
      statuses.some(
        (s) => s.state === 'connected' && s.lanes?.[0] === 'writes',
      ),
    ).toBe(true);

    const result = await client.stop(T0 + 2000);
    expect(result).toBeDefined();
    const check = result!.ledger.lanes[0].checks[0];
    expect(check).toMatchObject({
      status: 'verified',
      note: 'Loan is there',
      requestId: call.requestId,
    });
    expect(statuses.at(-1)?.state).toBe('finished');

    // and the export can place that check under the action its request belonged to
    const joined = attachActionSeq(result!, [call], []);
    expect(joined.ledger.lanes[0].checks[0].actionSeq).toBe(3);
    expect(joined.log).toMatch(/OK\s+Loan created/);
  });

  it('reports a clean "never reachable" when the backend is not running, without delaying Stop', async () => {
    const statuses: StatusUpdate[] = [];
    const client = createAgentClient(
      { backendUrl: 'http://127.0.0.1:1', playbooks: ['writes'] },
      { sessionId: 'rt2', startedAt: T0, pageOrigin: '' },
      {
        createSocket: (url) => new WebSocket(url) as never,
        onStatus: (s) => statuses.push(s),
        ...realTimers,
      },
    )!;
    client.sendEvent({
      kind: 'network',
      t: 1,
      payload: net('POST', 'https://app/loan'),
    });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    expect(await client.stop(T0)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(statuses.at(-1)).toMatchObject({ state: 'lost' });
  });
});
