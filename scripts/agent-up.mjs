#!/usr/bin/env node
/**
 * `make run-backend`: get the live agent backend running, fixing what is
 * missing on the way and skipping everything that is already fine.
 *
 *   1. Node >= 24                      (stops with the fix if not)
 *   2. backend dependencies installed  (runs `yarn install` only if missing)
 *   3. Ollama binary + server          (installs / starts only if missing)
 *   4. the model                       (pulls only if missing)
 *   5. warm the model onto the GPU     (in the background; never blocks)
 *   6. start the backend in the foreground
 *
 * Checks run in parallel and cost milliseconds when all is well. The one
 * thing it will not do silently is install Ollama: that runs the vendor's
 * install script with sudo, so it asks first (or pass AGENT_AUTO_INSTALL=1).
 * AGENT_MODEL=none skips every model step.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'packages/agent-backend');
const MODEL = process.env.AGENT_MODEL ?? 'qwen2.5-coder:3b';
const HOST = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PORT = Number(process.env.AGENT_PORT ?? 47821);

const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${c(32, '✓')} ${m}`);
const info = (m) => console.log(`  ${c(36, '•')} ${m}`);
const warn = (m) => console.log(`  ${c(33, '!')} ${m}`);
const die = (m) => {
  console.error(`  ${c(31, '✗')} ${m}`);
  process.exit(1);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

async function get(path, ms = 800) {
  try {
    const res = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** A TCP connect, not /health: health waits on the database, which may be the thing that is down. */
function alreadyRunning() {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port: PORT });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) die(`Node ${process.version} is too old; the backend needs Node 24+ (it runs TypeScript directly). Run: nvm install 24 && nvm use 24`);
  ok(`Node ${process.version}`);
}

function checkDeps() {
  const needed = ['mongodb', 'ws', 'yaml', 'fflate'].map((d) => existsSync(join(backend, 'node_modules', d)) || existsSync(join(root, 'node_modules', d)));
  if (needed.every(Boolean)) return ok('backend dependencies installed');
  info('installing dependencies (first run only)…');
  // Plain `yarn install`, never `yarn add`: install honours the root `resolutions`
  // (cssom -> rrweb-cssom), add does not and breaks unrelated packages.
  const r = spawnSync('yarn', ['install', '--prefer-offline'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) die('yarn install failed; fix that and run again');
  ok('dependencies installed');
}

async function ensureOllama() {
  if (MODEL === 'none') return ok('AGENT_MODEL=none: running rules-only, no model needed');

  if (!has('ollama')) {
    warn('Ollama is not installed.');
    if (process.platform === 'win32') die('Install Ollama from https://ollama.com/download, then run again.');
    let yes = process.env.AGENT_AUTO_INSTALL === '1';
    if (!yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      yes = /^y/i.test((await rl.question('    Install it now with the official script (curl https://ollama.com/install.sh | sh, uses sudo)? [y/N] ')).trim());
      rl.close();
    }
    if (!yes) {
      warn('skipping the model: the agent will run rules-only (no Ask box). To install: curl -fsSL https://ollama.com/install.sh | sh');
      process.env.AGENT_MODEL = 'none';
      return;
    }
    const r = spawnSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
    if (r.status !== 0 || !has('ollama')) {
      warn('Ollama install did not complete; continuing rules-only.');
      process.env.AGENT_MODEL = 'none';
      return;
    }
    ok('Ollama installed');
  }

  let tags = await get('/api/tags');
  if (!tags) {
    info('starting Ollama…');
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 40 && !tags; i++) {
      await sleep(250);
      tags = await get('/api/tags');
    }
    if (!tags) {
      warn('Ollama did not start; continuing rules-only.');
      process.env.AGENT_MODEL = 'none';
      return;
    }
  }
  ok('Ollama is running');

  const names = new Set((tags.models ?? []).flatMap((m) => [m.name, m.model]));
  const want = MODEL.includes(':') ? MODEL : `${MODEL}:latest`;
  if (names.has(want)) ok(`model ${MODEL} present`);
  else {
    info(`pulling ${MODEL} (one time, ~2 GB)…`);
    const r = spawnSync('ollama', ['pull', MODEL], { stdio: 'inherit' });
    if (r.status !== 0) {
      warn(`could not pull ${MODEL}; continuing rules-only.`);
      process.env.AGENT_MODEL = 'none';
      return;
    }
    ok(`model ${MODEL} pulled`);
  }

  warmInBackground();
}

/** Load the model into VRAM now so the first ask is not slow; report where it landed. */
function warmInBackground() {
  void (async () => {
    try {
      await fetch(`${HOST}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '30m' }),
        signal: AbortSignal.timeout(120_000),
      });
      const ps = await get('/api/ps', 2000);
      const m = ps?.models?.find((x) => x.name === MODEL || x.model === MODEL);
      if (m) {
        const gpu = m.size_vram >= m.size * 0.95;
        console.log(`  ${gpu ? c(32, '✓') : c(33, '!')} model loaded: ${gpu ? 'on GPU' : 'NOT fully on GPU (CPU will be slow)'}`);
      }
    } catch {
      /* the backend reports model problems in the popup */
    }
  })();
}

console.log('Live agent backend\n');

if (await alreadyRunning()) {
  ok(`already running on http://127.0.0.1:${PORT}; nothing to do`);
  process.exit(0);
}

checkNode();
checkDeps();
await ensureOllama();

if (!existsSync(join(root, 'packages/agent-backend/config/lms/.env')) && !existsSync(join(homedir(), 'projects/.env.mongo')) && !process.env.AGENT_MONGO_URI) {
  warn('no database settings found: set AGENT_MONGO_URI (see packages/agent-backend/config/lms/.env.example). Rules will report "could not check".');
}

console.log('');
const child = spawn(process.execPath, ['src/main.ts'], { cwd: backend, stdio: 'inherit', env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
