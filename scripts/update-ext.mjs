#!/usr/bin/env node
/**
 * `make update-ext`: bring the unpacked Chrome extension up to date with the
 * source, and say what is left for you to do.
 *
 *   1. dependencies   `yarn install` only if a lockfile/package.json changed
 *                     since the last run; verifies the cssom resolution
 *   2. build          Chrome build (full turbo build only when a workspace
 *                     package has never been built)
 *   3. verify         manifest, service worker, popup, side panel are present
 *   4. backend        warns if the running agent backend is older than its code
 *                     (--restart-backend restarts it for you)
 *
 * Flags:  --check          type-check and run the extension + backend tests first
 *         --restart-backend  restart the agent backend if it is stale
 *         --force          reinstall and rebuild regardless
 *
 * The one step it cannot do is the last: Chrome only reloads an unpacked
 * extension when you press its reload button.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'packages/web-extension');
const dist = join(ext, 'dist/chrome');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.AGENT_PORT ?? 47821);

const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${c(32, '✓')} ${m}`);
const info = (m) => console.log(`  ${c(36, '•')} ${m}`);
const warn = (m) => console.log(`  ${c(33, '!')} ${m}`);
const die = (m) => {
  console.error(`  ${c(31, '✗')} ${m}`);
  process.exit(1);
};
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: root, stdio: 'inherit', ...opts });
const read = (p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));

console.log('Update extension\n');

// 1. dependencies --------------------------------------------------------
const stampFile = join(root, 'node_modules/.update-ext-stamp');
const inputs = ['yarn.lock', 'package.json', 'packages/web-extension/package.json', 'packages/agent-backend/package.json'];
const stamp = createHash('sha1');
for (const f of inputs) stamp.update(read(join(root, f)));
const want = stamp.digest('hex');
const have = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : '';

if (have !== want || args.has('--force') || !existsSync(join(root, 'node_modules'))) {
  info('dependencies changed, installing…');
  // `install`, never `add`: only install honours the root `resolutions`.
  if (run('yarn', ['install', '--prefer-offline']).status !== 0) die('yarn install failed');
  writeFileSync(stampFile, want);
} else {
  ok('dependencies unchanged');
}
try {
  const name = JSON.parse(readFileSync(join(root, 'node_modules/cssom/package.json'), 'utf8')).name;
  if (name !== 'rrweb-cssom') warn(`node_modules/cssom is "${name}", not rrweb-cssom: run \`git checkout yarn.lock && yarn install\` (it breaks rrdom/rrweb CSS tests)`);
} catch {
  /* cssom not installed: nothing to guard */
}

// optional: prove it works before shipping it ---------------------------------
if (args.has('--check')) {
  info('type-check and tests…');
  const t = (dir, a) => spawnSync(a[0], a.slice(1), { cwd: join(root, dir), stdio: 'inherit' });
  if (t('packages/web-extension', ['npx', 'tsc', '-noEmit']).status !== 0) die('extension type-check failed');
  if (t('packages/agent-backend', ['npx', 'tsc', '-noEmit']).status !== 0) die('backend type-check failed');
  if (t('packages/web-extension', ['npx', 'vitest', 'run']).status !== 0) die('extension tests failed');
  if (t('packages/agent-backend', ['npx', 'vitest', 'run']).status !== 0) die('backend tests failed');
  ok('checks passed');
}

// 2. build -----------------------------------------------------------------
// The fast path builds only the extension; if a workspace package it depends on
// has never been built, the full turbo build is needed once.
const needsFull = ['rrweb', 'types', 'utils', 'plugins/rrweb-plugin-console-record', 'plugins/rrweb-plugin-network-record'].some(
  (p) => !existsSync(join(root, 'packages', p, 'dist')),
);
const started = Date.now();
const before = existsSync(join(dist, 'manifest.json')) ? statSync(join(dist, 'manifest.json')).mtimeMs : 0;
if (needsFull) info('first build of the workspace packages (slow, one time)…');
else info('building…');
const build = needsFull
  ? run('yarn', ['ext:build'], { env: { ...process.env, TARGET_BROWSER: 'chrome' } })
  : run('yarn', ['workspace', '@rrweb/web-extension', 'build:chrome'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
if (build.status !== 0) die('build failed (re-run without output hidden: yarn workspace @rrweb/web-extension build:chrome)');

// 3. verify ----------------------------------------------------------------
const need = ['manifest.json', 'background/index.js', 'popup/popup.html', 'options/index.html', 'sidepanel/index.html', 'content/index.js'];
const missing = need.filter((f) => !existsSync(join(dist, f)));
if (missing.length) die(`build is missing: ${missing.join(', ')}`);
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (!manifest.permissions?.includes('sidePanel') || !manifest.side_panel) die('manifest has no side panel; the build is stale');
if (statSync(join(dist, 'manifest.json')).mtimeMs <= before) warn('manifest was not rewritten by this build');
ok(`built ${manifest.name} ${manifest.version_name ?? manifest.version} in ${((Date.now() - started) / 1000).toFixed(1)} s`);

// 4. backend ---------------------------------------------------------------
function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') newest = Math.max(newest, newestMtime(p));
    } else newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const listener = spawnSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep ':${PORT} ' | sed -E 's/.*pid=([0-9]+).*/\\1/' | head -1`], { encoding: 'utf8' }).stdout.trim();
if (!listener) {
  info('agent backend is not running (start it with: make run-backend)');
} else {
  const startedAt = Number(spawnSync('sh', ['-c', `stat -c %Y /proc/${listener}`], { encoding: 'utf8' }).stdout.trim()) * 1000;
  const codeAt = Math.max(newestMtime(join(root, 'packages/agent-backend/src')), newestMtime(join(root, 'packages/agent-backend/config')), newestMtime(join(ext, 'src/agent')));
  if (codeAt > startedAt) {
    if (args.has('--restart-backend')) {
      spawnSync('kill', [listener]);
      await new Promise((r) => setTimeout(r, 800));
      spawn(process.execPath, [join(root, 'scripts/agent-up.mjs')], { cwd: root, detached: true, stdio: 'ignore' }).unref();
      ok('agent backend was older than its code: restarted');
    } else {
      warn('the running agent backend is older than its code. Restart it: make run-backend  (or rerun with --restart-backend)');
    }
  } else {
    ok('agent backend is current');
  }
}

// the step only you can do -----------------------------------------------------
const win = spawnSync('wslpath', ['-w', dist], { encoding: 'utf8' });
const where = win.status === 0 ? win.stdout.trim() : dist;
console.log(`
  ${c(1, 'Last step (Chrome cannot be reloaded from here):')}
    chrome://extensions  →  find "${manifest.name}"  →  press its reload ↻ button
    first time only: Developer mode → Load unpacked → ${where}
    then reopen the popup (and the side panel if it was open).
`);
