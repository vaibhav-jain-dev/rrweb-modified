import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerMessage } from '../../web-extension/src/agent/protocol.ts';
import { createAgentServer, type AgentServer } from '../src/server.ts';
import type { AgentConfig } from '../src/config/types.ts';
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
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await agent?.close();
  agent = undefined;
});

async function start(token?: string) {
  const fake = fakeRegistry(
    { loan: (args) => ({ found: args.id === LOAN }) },
    { loan: { id: 'id' } },
  );
  agent = createAgentServer({
    config,
    registry: fake.registry,
    model: null,
    token,
    port: 0,
  });
  const { port } = await agent.listen();
  return { port, base: `http://127.0.0.1:${port}`, calls: fake.calls };
}

async function mcp(base: string, headers: Record<string, string> = {}) {
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers },
    }),
  );
  return client;
}

const textOf = (r: unknown) =>
  (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

/** Record one session over the socket, the way the extension does. */
async function recordOne(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => ws.once('open', r));
  const ack = new Promise((r) =>
    ws.on('message', (d) => {
      if ((JSON.parse(d.toString()) as ServerMessage).type === 'session.ack')
        r(undefined);
    }),
  );
  ws.send(
    JSON.stringify({
      type: 'session.start',
      sessionId: 's1',
      startedAt: T0,
      pageOrigin: 'https://h',
      playbooks: ['writes'],
    }),
  );
  await ack;
  ws.send(
    JSON.stringify({
      type: 'event',
      sessionId: 's1',
      kind: 'network',
      t: T0 + 500,
      payload: net('POST', 'https://h/loan', {
        status: 201,
        req: { name: 'x' },
        res: { _id: LOAN },
      }),
    }),
  );
  return ws;
}

describe('mcp', () => {
  it('lists the tools, with the named lookups in the lookup description', async () => {
    const { base } = await start();
    const c = await mcp(base);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ledger',
      'lookup',
      'request',
      'requests',
      'sessions',
    ]);
    expect(tools.find((t) => t.name === 'lookup')?.description).toMatch(
      /- loan/,
    );
  });

  it('follows a live session: sessions, ledger, requests, one request', async () => {
    const { base, port } = await start();
    const ws = await recordOne(port);
    const c = await mcp(base);

    await vi.waitFor(async () =>
      expect(
        textOf(await c.callTool({ name: 'ledger', arguments: {} })),
      ).toMatch(/OK +Loan created · loan — Loan is there/),
    );
    expect(textOf(await c.callTool({ name: 'sessions', arguments: {} }))).toMatch(
      /^s1 {2}recording .* lanes: writes {2}1 verified · 0 failed/,
    );

    const reqs = textOf(await c.callTool({ name: 'requests', arguments: {} }));
    expect(reqs).toMatch(/POST \/loan {2}201/);
    const id = reqs.split(/\s+/)[1];
    const one = textOf(
      await c.callTool({ name: 'request', arguments: { requestId: id } }),
    );
    expect(JSON.parse(one)).toMatchObject({
      endpoint: 'POST /loan',
      requestBody: { name: 'x' },
    });

    const json = JSON.parse(
      textOf(
        await c.callTool({ name: 'ledger', arguments: { format: 'json' } }),
      ),
    );
    expect(json.lanes[0].verdict.verified).toBe(1);

    const res = await c.readResource({ uri: 'session://s1/ledger' });
    expect(JSON.parse((res.contents[0] as { text: string }).text)).toMatchObject(
      { sessionId: 's1' },
    );
    ws.close();
  });

  it('runs a named lookup, and refuses an unknown one or a bad session', async () => {
    const { base, calls } = await start();
    const c = await mcp(base);
    const out = await c.callTool({
      name: 'lookup',
      arguments: { tool: 'loan', args: { id: LOAN } },
    });
    expect(JSON.parse(textOf(out))).toMatchObject({
      value: { found: true },
      ref: 'fake loan',
    });
    expect(calls).toEqual([{ tool: 'loan', args: { id: LOAN } }]);

    const bad = await c.callTool({
      name: 'lookup',
      arguments: { tool: 'drop_everything', args: {} },
    });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);

    const gone = await c.callTool({
      name: 'ledger',
      arguments: { sessionId: 'nope' },
    });
    expect(gone.isError).toBe(true);
  });

  it('needs the token when one is set, and refuses web pages and foreign hosts', async () => {
    const { base, port } = await start('s3cret');
    await expect(mcp(base)).rejects.toThrow();
    const c = await mcp(base, { 'x-agent-token': 's3cret' });
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);

    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-agent-token': 's3cret',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    const page = await fetch(`${base}/mcp`, {
      ...init,
      headers: { ...init.headers, origin: 'https://evil.example' },
    });
    expect(page.status).toBe(403);
    // A rebinding page reaches 127.0.0.1 under its own name.
    const rebound = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const r = request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: { ...init.headers, host: `evil.example:${port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on('error', reject);
        r.end(init.body);
      }, reject);
    });
    expect(rebound).toBe(403);
  });
});
