import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { readRecording } from '../src/recording.ts';
import { net, T0 } from './helpers.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const LOAN = '6a62d0b46ccb69068d608083';

let zipPath = '';
let configDir = '';

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cli-'));
  // A recording in the exact shape the extension exports: a deduped repeat, a noise entry, actions with labels.
  const create = net('POST', 'https://h/lms/api/v1/loan-application', {
    status: 201,
    res: { _id: LOAN, loan_application_number: 'L-1' },
    req: { product_id: 'p', folder_id: 'f' },
    actionSeq: 1,
  });
  const patch = net(
    'PATCH',
    `https://h/lms/api/user/v1/loan-application/${LOAN}/data`,
    { req: { f1: { value: 5 } }, res: { ok: 1 }, actionSeq: 2 },
  );
  const repeat = {
    ...patch,
    requestId: 'dup',
    startTime: patch.startTime + 3000,
    endTime: patch.endTime! + 3000,
    actionSeq: 3,
    sameAs: patch.requestId,
    requestBody: undefined,
    responseBody: undefined,
  };
  const login = net('POST', 'https://h/core-internals/login', {
    req: { email: 'a' },
    res: { access: 'x' },
    actionSeq: 0,
  });
  const noise = net('POST', 'https://telemetry.example/collect', {
    tier: 'noise',
    actionSeq: 1,
  });
  const get = net('GET', 'https://h/lms/api/v1/things', {
    res: [],
    actionSeq: 1,
  });
  const actions = [
    {
      seq: 0,
      t: T0,
      type: 'click',
      page: {
        url: 'https://h/login',
        route: '/login',
        title: '',
        tabId: 1,
        frameId: 0,
      },
      target: {
        accessibleName: 'Sign In',
        selector: 'b',
        selectorCandidates: [],
        locator: 'x',
        tag: 'BUTTON',
        attrs: {},
      },
    },
    {
      seq: 1,
      t: T0 + 1,
      type: 'click',
      page: { url: 'u', route: '/home', title: '', tabId: 1, frameId: 0 },
      target: {
        accessibleName: 'New loan',
        selector: 'b',
        selectorCandidates: [],
        locator: 'x',
        tag: 'BUTTON',
        attrs: {},
      },
    },
    {
      seq: 2,
      t: T0 + 2,
      type: 'input',
      page: {
        url: 'u',
        route: `/loans/${LOAN}`,
        title: '',
        tabId: 1,
        frameId: 0,
      },
      target: {
        accessibleName: 'Amount',
        selector: 'i',
        selectorCandidates: [],
        locator: 'x',
        tag: 'INPUT',
        attrs: {},
      },
    },
    {
      seq: 3,
      t: T0 + 3,
      type: 'input',
      page: {
        url: 'u',
        route: `/loans/${LOAN}`,
        title: '',
        tabId: 1,
        frameId: 0,
      },
      target: {
        accessibleName: 'Amount',
        selector: 'i',
        selectorCandidates: [],
        locator: 'x',
        tag: 'INPUT',
        attrs: {},
      },
    },
  ];
  zipPath = join(dir, 'recording-test.zip');
  writeFileSync(
    zipPath,
    zipSync({
      'network/index.json': strToU8(
        JSON.stringify([login, create, noise, patch, get, repeat]),
      ),
      'actions.json': strToU8(JSON.stringify(actions)),
      'README.md': strToU8('x'),
    }),
  );

  // A config with the real playbook and a tools file that needs no database.
  configDir = join(dir, 'cfg');
  mkdirSync(join(configDir, 'playbooks'), { recursive: true });
  copyFileSync(
    join(root, 'config/lms/playbooks/lms-writes.md'),
    join(configDir, 'playbooks/lms-writes.md'),
  );
  copyFileSync(
    join(root, 'config/lms/REFERENCE.md'),
    join(configDir, 'REFERENCE.md'),
  );
  // Same tool names and shapes, pointed at a source that is never reached (dry runs only).
  const sources = readFileSync(
    join(root, 'config/lms/sources.yaml'),
    'utf8',
  ).replace(
    'envFile: ~/projects/.env.mongo',
    'uri: mongodb://127.0.0.1:1/\n    database: devlms',
  );
  writeFileSync(join(configDir, 'sources.yaml'), sources);
});

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AGENT_CONFIG_DIR: configDir },
  });

describe('readRecording', () => {
  it('restores the payload of a deduped repeat from its first occurrence', () => {
    const rec = readRecording(zipPath);
    const dup = rec.network.find((r) => r.requestId === 'dup')!;
    expect(dup.requestBody).toBe(JSON.stringify({ f1: { value: 5 } }));
    expect(rec.network.map((r) => r.startTime)).toEqual(
      [...rec.network.map((r) => r.startTime)].sort((a, b) => a - b),
    );
  });
  it('rejects a zip that is not a recording', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'agent-cli-')), 'x.zip');
    writeFileSync(p, zipSync({ 'a.txt': strToU8('x') }));
    expect(() => readRecording(p)).toThrow(/no network\/index.json/);
  });
});

describe('probe --dry', () => {
  it('shows the lookups each write would run, with the ids taken from the recording, and touches no database', () => {
    const out = cli('probe', zipPath, '--dry');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(
      `would run loan_application({"id":"${LOAN}"})`,
    );
    expect(out.stdout).toContain('would run loan_fields_data(');
    expect(out.stdout).toContain('"fields":["f1"]');
    // the replay used the repeat's restored body too
    expect(out.stdout.match(/would run loan_fields_data/g)!.length).toBe(2);
    // login is ignored, the GET and the noise call are not writes
    expect(out.stdout).not.toMatch(/NOTE .*login/);
    expect(out.stdout).not.toMatch(/NOTE .*telemetry/);
  });

  it('can be limited to some rules', () => {
    const out = cli('probe', zipPath, '--dry', '--rules', 'loan-create');
    expect(out.stdout).toContain('would run loan_application(');
    expect(out.stdout).not.toContain('would run loan_fields_data');
    expect(out.stdout).toMatch(
      /PATCH \/lms\/api\/user\/v1\/loan-application\/:id\/data ×2 has no rule/,
    );
  });

  it('prints usage for bad input', () => {
    expect(cli().status).toBe(2);
  });
});

describe('learn', () => {
  it('writes a playbook that includes the rules and walks the recorded writes in order', () => {
    const out = cli('learn', zipPath, '--name', 'new-loan');
    expect(out.status, out.stderr).toBe(0);
    const text = readFileSync(
      join(configDir, 'playbooks/follow-new-loan.md'),
      'utf8',
    );
    expect(text).toContain('id: follow-new-loan');
    expect(text).toContain('include: [lms-writes]');

    const cfg = loadConfig(configDir);
    expect(cfg.warnings.filter((w) => !w.includes('REFERENCE'))).toEqual([]);
    const pb = cfg.playbooks.find((p) => p.id === 'follow-new-loan')!;
    expect(pb.rules.length).toBeGreaterThan(10);
    expect(pb.steps.map((s) => s.say)).toEqual([
      'Click "Sign In" on /login',
      'Click "New loan" on /home',
      'Type into "Amount" on /loans/:id',
      'Type into "Amount" on /loans/:id',
    ]);
    expect(pb.steps[1].wait).toEqual(['POST /lms/api/v1/loan-application']);
    expect(pb.steps[2].wait).toEqual([
      'PATCH /lms/api/user/v1/loan-application/:id/data',
    ]);
  });

  it('requires a name', () => {
    expect(cli('learn', zipPath).status).toBe(1);
  });
});
