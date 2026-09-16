#!/usr/bin/env node
/**
 * Zero-dependency environment check for this monorepo.
 *
 * Run with `yarn doctor` whenever something feels off before digging in
 * further. It never installs or downloads anything - it only inspects the
 * current machine and tells you the next command to run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let failed = false;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const fail = (msg) => {
  failed = true;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};

function satisfiesRange(version, range) {
  // Tiny inline check for the ">=X <Y" shape used in this repo's engines
  // field - not a general semver range parser.
  const [, gte] = />=(\d+)/.exec(range) ?? [];
  const [, lt] = /<(\d+)/.exec(range) ?? [];
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (gte && major < Number(gte)) return false;
  if (lt && major >= Number(lt)) return false;
  return true;
}

console.log('Node / package manager\n');

const nodeVersion = process.version;
const requiredNode = pkg.engines?.node;
if (requiredNode && !satisfiesRange(nodeVersion, requiredNode)) {
  fail(
    `Node ${nodeVersion} does not satisfy engines.node "${requiredNode}" ` +
      `(see .nvmrc). Run: nvm use`,
  );
} else {
  ok(`Node ${nodeVersion} satisfies "${requiredNode ?? 'any'}"`);
}

try {
  const yarnVersion = execFileSync('yarn', ['-v'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  ok(`yarn resolves (${yarnVersion}, via .yarnrc.yml yarnPath)`);
} catch {
  fail('yarn is not resolvable from this directory. Run: corepack enable');
}

console.log('\nDependencies\n');

if (existsSync(join(root, 'node_modules'))) {
  ok('root node_modules present');
} else {
  fail('node_modules missing. Run: yarn install --frozen-lockfile');
}

console.log('\nBrowser for tests / recording\n');

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const foundChrome = chromeCandidates.find((p) => existsSync(p));
if (foundChrome) {
  ok(`browser found at ${foundChrome}`);
  if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
    warn(
      `set PUPPETEER_EXECUTABLE_PATH=${foundChrome} so puppeteer-driven ` +
        `tests use it instead of trying to download one`,
    );
  }
} else {
  warn(
    'no Chrome/Chromium found in common locations. Puppeteer-driven tests ' +
      'need PUPPETEER_EXECUTABLE_PATH set to a real browser binary.',
  );
}

console.log('\nExtension build\n');

if (existsSync(join(root, 'packages/web-extension/dist/chrome'))) {
  ok('packages/web-extension/dist/chrome exists (built at least once)');
} else {
  warn('extension not built yet. Run: yarn ext:build');
}

console.log(
  failed
    ? '\nSome checks failed - fix the items above, then re-run `yarn doctor`.'
    : '\nAll required checks passed.',
);
process.exit(failed ? 1 : 0);
