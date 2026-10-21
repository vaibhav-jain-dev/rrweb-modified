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
  it('exposes the tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['changes', 'close_browser', 'inspect', 'keepalive', 'load_recording', 'note', 'run', 'screenshot', 'watch']);
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

describe('idle lease over MCP stdio', () => {
  it('keeps the browser while the bot calls keepalive, closes it after idle, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-idle-'));
    const z = join(dir, 'recording-mock.zip');
    buildZip(z, app.origin);
    const c = new Client({ name: 'idle', version: '0' });
    await c.connect(
      new StdioClientTransport({
        command: 'node',
        args: [new URL('../src/main.ts', import.meta.url).pathname],
        env: { ...(process.env as Record<string, string>), REPLAY_HEADLESS: '1', REPLAY_IDLE_MS: '4000', REPLAY_PROFILE_DIR: join(dir, 'profile'), REPLAY_SECRET_PASSWORD: 'pw', REPLAY_OUT_DIR: join(dir, 'out') },
      }),
    );
    try {
      await c.callTool({ name: 'load_recording', arguments: { zip: z } });
      const run = textOf(await c.callTool({ name: 'run', arguments: {} }));
      expect(run).toContain('idle limit');
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 2500)); // 7.5 s in total, more than the 4 s limit, but renewed each time
        expect(textOf(await c.callTool({ name: 'keepalive', arguments: {} }))).toContain('browser open');
      }
      await new Promise((r) => setTimeout(r, 6000)); // nothing from the bot
      const after = textOf(await c.callTool({ name: 'keepalive', arguments: {} }));
      expect(after).toContain('the browser was closed');
      expect(after).toContain('browser closed');
      expect(textOf(await c.callTool({ name: 'changes', arguments: {} }))).toContain('no browser open');
    } finally {
      await c.close();
    }
  }, 60000);
});

describe('watch over MCP stdio', () => {
  it('start watching without a recording, note, ask changes, screenshot one element', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-watch-'));
    const c = new Client({ name: 'watch', version: '0' });
    await c.connect(
      new StdioClientTransport({
        command: 'node',
        args: [new URL('../src/main.ts', import.meta.url).pathname],
        env: { ...(process.env as Record<string, string>), REPLAY_HEADLESS: '1', REPLAY_PROFILE_DIR: join(dir, 'profile'), REPLAY_WATCH_DIR: join(dir, 'watch') },
      }),
    );
    try {
      expect(textOf(await c.callTool({ name: 'changes', arguments: {} }))).toContain('no browser open');
      const w = textOf(await c.callTool({ name: 'watch', arguments: { action: 'start', url: `${app.origin}/login` } }));
      expect(w).toContain('watching');
      expect(w).toContain('idle limit'); // the bot is told how long the window lives
      expect(textOf(await c.callTool({ name: 'note', arguments: { text: 'on the login page' } }))).toContain('note 1 saved');
      expect(textOf(await c.callTool({ name: 'note', arguments: { text: 'from here', from: true } }))).toContain('open from here');
      expect(textOf(await c.callTool({ name: 'note', arguments: {} }))).toContain('"on the login page"');
      expect(textOf(await c.callTool({ name: 'changes', arguments: {} }))).toContain('nothing changed');
      const shot = (await c.callTool({ name: 'screenshot', arguments: { selector: '#go' } })) as { content: { type: string }[] };
      expect(shot.content.some((x) => x.type === 'image')).toBe(true);
    } finally {
      await c.callTool({ name: 'close_browser', arguments: {} }).catch(() => undefined);
      await c.close();
    }
  }, 60000);
});
