/**
 *   node src/cli.ts probe <recording.zip> [--rules a,b] [--dry] [--json out.json]
 *   node src/cli.ts learn <recording.zip> --name <flow-name> [--include lms-writes]
 *
 * probe  replays a recording's calls through the playbook rules against the
 *        real database (read-only) and prints what would have been verified.
 *        It is how a rule's field names are confirmed against live documents.
 * learn  writes playbooks/follow-<name>.md: the recording's writes, in order,
 *        as steps, so the agent can walk you through the same flow again.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMutatingMethod } from '../../web-extension/src/agent/protocol.ts';
import {
  templateEndpoint,
  templateRoute,
} from '../../web-extension/src/evidence/route-template.ts';
import type { ActionRecord } from '../../web-extension/src/evidence/types.ts';
import { readEnvFile } from './config/env.ts';
import { loadConfig } from './config/load.ts';
import { resolveConfigDir } from './main.ts';
import { readRecording } from './recording.ts';
import { SessionRuntime } from './session.ts';
import { ToolRegistry } from './tools/registry.ts';

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function probe(zip: string, flags: Flags): Promise<number> {
  const dir = resolveConfigDir();
  const own = join(dir, '.env');
  if (existsSync(own))
    for (const [k, v] of Object.entries(readEnvFile(own)))
      if (process.env[k] === undefined) process.env[k] = v;
  const config = loadConfig(dir);
  for (const w of config.warnings) console.warn(`! ${w}`);
  const wanted =
    typeof flags.rules === 'string'
      ? new Set(flags.rules.split(','))
      : undefined;
  const playbooks = config.playbooks.map((p) =>
    wanted ? { ...p, rules: p.rules.filter((r) => wanted.has(r.id)) } : p,
  );

  const registry = new ToolRegistry(config);
  const dry = flags.dry === true;
  if (dry) {
    const real = registry.run.bind(registry);
    registry.run = async (name, args, ctx) => {
      if (
        registry.has(name) &&
        name !== 'last_response' &&
        name !== 'count_calls' &&
        name !== 'last_status'
      ) {
        console.log(`   would run ${name}(${JSON.stringify(args)})`);
        return {
          ok: false,
          kind: 'bad_args',
          message: 'dry run: not executed',
          ms: 0,
        };
      }
      return real(name, args, ctx);
    };
  } else {
    const health = await registry.health();
    for (const [name, h] of Object.entries(health)) {
      console.log(
        `source ${name} (${h.type}): ${
          h.ready ? 'ready' : `NOT READY - ${h.error ?? 'unknown'}`
        }`,
      );
    }
  }

  const rec = readRecording(zip);
  const net = rec.network.filter(
    (r) => r.tier !== 'noise' && r.method.toUpperCase() !== 'OPTIONS',
  );
  if (net.length === 0) throw new Error('no usable requests in that recording');
  const startedAt = net[0].startTime;

  // Replays run on a virtual clock so a check that polls for 15 s on a
  // document that is not there does not make probing take 15 s.
  let clock = startedAt;
  const session = new SessionRuntime({
    sessionId: `probe-${Date.now()}`,
    startedAt,
    pageOrigin: '',
    playbooks,
    registry,
    model: null,
    reference: config.reference,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  let replayed = 0;
  for (const r of net) {
    clock = Math.max(clock, r.endTime ?? r.startTime);
    session.ingest({
      kind: 'network',
      t: r.endTime ?? r.startTime,
      payload: r,
    });
    replayed++;
    // Let the checks this call started run before the next call arrives.
    await new Promise((res) => setTimeout(res, 0));
  }
  const result = await session.stop(clock);
  await registry.close();

  console.log(`\nreplayed ${replayed} calls from ${rec.name}\n`);
  let failed = 0;
  for (const lane of result.ledger.lanes) {
    console.log(
      `== ${lane.title}: ${lane.verdict.verified} verified, ${lane.verdict.failed} failed, ${lane.verdict.unchecked} could not be checked`,
    );
    for (const c of lane.checks) {
      if (c.origin !== 'playbook') continue;
      const mark = {
        verified: 'OK  ',
        failed: 'FAIL',
        unchecked: 'SKIP',
        never_seen: 'MISS',
        observed: '... ',
        pending: '... ',
      }[c.status];
      console.log(
        `  ${mark} ${c.claim}  [${c.endpoint ?? ''}]\n       ${c.note ?? ''}`,
      );
      for (const w of c.warnings ?? []) console.log(`       ⚠ ${w}`);
      if (c.status === 'failed') failed++;
    }
    for (const [ep, n] of Object.entries(lane.uncovered))
      console.log(`  NOTE ${ep} ×${n} has no rule`);
  }
  if (typeof flags.json === 'string') {
    writeFileSync(resolve(flags.json), JSON.stringify(result.ledger, null, 2));
    console.log(`\nledger written to ${flags.json}`);
  }
  return failed ? 1 : 0;
}

function actionLabel(a: ActionRecord): string {
  const name = (
    a.target?.accessibleName ||
    a.target?.text ||
    a.target?.locator ||
    'element'
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
  const where = a.page?.route ? ` on ${templateRoute(a.page.route)}` : '';
  switch (a.type) {
    case 'click':
    case 'dblclick':
      return `Click "${name}"${where}`;
    case 'input':
      return `Type into "${name}"${where}`;
    case 'select':
      return `Choose "${a.value ?? ''}" in "${name}"${where}`;
    case 'submit':
      return `Submit "${name}"${where}`;
    case 'toggle':
      return `Toggle "${name}"${where}`;
    default:
      return `${a.type}${where}`;
  }
}

function learn(zip: string, flags: Flags): number {
  const name =
    typeof flags.name === 'string'
      ? flags.name.replace(/[^a-z0-9_-]/gi, '-')
      : undefined;
  if (!name) throw new Error('--name <flow-name> is required');
  const include =
    typeof flags.include === 'string' ? flags.include : 'lms-writes';
  const dir = resolveConfigDir();
  const rec = readRecording(zip);

  const writes = rec.network.filter(
    (r) =>
      r.tier !== 'noise' &&
      isMutatingMethod(r.method) &&
      r.status !== undefined &&
      r.status >= 200 &&
      r.status < 300,
  );
  const bySeq = new Map<number, string[]>();
  for (const r of writes) {
    if (r.actionSeq === undefined) continue;
    const list = bySeq.get(r.actionSeq) ?? [];
    const ep = templateEndpoint(r.method.toUpperCase(), r.url);
    if (!list.includes(ep)) list.push(ep);
    bySeq.set(r.actionSeq, list);
  }
  const steps = [...bySeq.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seq, wait]) => {
      const action = rec.actions.find((a) => a.seq === seq);
      return { say: action ? actionLabel(action) : `Step ${seq}`, wait };
    });
  if (steps.length === 0)
    throw new Error('that recording has no successful writes to follow');

  const yamlSteps = steps
    .map(
      (s) =>
        `  - say: ${JSON.stringify(s.say)}\n    wait: [${s.wait
          .map((w) => JSON.stringify(w))
          .join(', ')}]`,
    )
    .join('\n');
  const text = `---
id: follow-${name}
title: ${JSON.stringify(`Follow: ${name}`)}
description: ${JSON.stringify(
    `Redo the flow from ${rec.name}; each write is checked against the database and the panel says when to proceed.`,
  )}
model: true
include: [${include}]
steps:
${yamlSteps}
---
You are guiding someone through a flow they recorded before, one step at a time.
After each step you say whether the database holds what the app just wrote.
Generated by \`yarn agent:learn\` from ${rec.name}; edit the steps freely.
`;
  const out = join(dir, 'playbooks');
  mkdirSync(out, { recursive: true });
  const file = join(out, `follow-${name}.md`);
  writeFileSync(file, text);
  console.log(`wrote ${file}\n${steps.length} steps:`);
  steps.forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.say}  -> ${s.wait.join(', ')}`),
  );
  return 0;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, zip] = positional;
  if (!cmd || !zip || (cmd !== 'probe' && cmd !== 'learn')) {
    console.error(
      'usage:\n  probe <recording.zip> [--rules a,b] [--dry] [--json out.json]\n  learn <recording.zip> --name <flow-name> [--include lms-writes]',
    );
    return 2;
  }
  return cmd === 'probe' ? probe(zip, flags) : learn(zip, flags);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
