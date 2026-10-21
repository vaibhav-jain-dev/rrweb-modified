import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildZip } from './fixture.ts';
import { startMock } from './mock-app.ts';
import type { MockApp } from './mock-app.ts';

let app: MockApp;
let client: Client;
let zip: string;

const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')?.text ?? '');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-mcp-'));
  zip = join(dir, 'recording-mock.zip');
  app = await startMock();
  buildZip(zip, app.origin);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: [new URL('../src/main.ts', import.meta.url).pathname],
      env: { ...(process.env as Record<string, string>), REPLAY_HEADLESS: '1', REPLAY_PROFILE_DIR: join(dir, 'profile'), REPLAY_SECRET_PASSWORD: 'pw', REPLAY_OUT_DIR: join(dir, 'out') },
    }),
  );
});
afterAll(async () => {
  await client.callTool({ name: 'close_browser', arguments: {} }).catch(() => undefined);
  await client.close();
  await app.close();
});

describe('rrweb-replay over MCP stdio', () => {
  it('exposes the five tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['close_browser', 'inspect', 'load_recording', 'run', 'screenshot']);
  });

  it('load → run with a patch → inspect live (text, not a picture) → screenshot on request', async () => {
    expect(textOf(await client.callTool({ name: 'load_recording', arguments: { zip } }))).toContain('7 steps');
    const run = textOf(await client.callTool({ name: 'run', arguments: { patch: { set: { '6.value': 'via mcp' } } } }));
    expect(run).toMatch(/^ok · /);
    expect(app.patches.at(-1)).toEqual({ notes: 'via mcp' });
    const live = textOf(await client.callTool({ name: 'inspect', arguments: { live: true } }));
    expect(live).toContain('/home');
    expect(live).toContain('Saved');
    const shot = (await client.callTool({ name: 'screenshot', arguments: {} })) as { content: { type: string }[] };
    expect(shot.content[0].type).toBe('image');
  });

  it('a bad patch comes back as an error the bot can act on, not a crash', async () => {
    const r = (await client.callTool({ name: 'run', arguments: { patch: { skip: [99] } } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('step 99');
  });
});
