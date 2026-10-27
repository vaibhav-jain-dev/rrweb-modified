import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  parsePlaybook,
  parseSources,
} from '../src/config/load.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const LMS = resolve(here, '../config/lms');

describe('the shipped LMS config', () => {
  const config = loadConfig(LMS);

  it('loads with no warnings', () => {
    expect(config.warnings).toEqual([]);
    expect(config.playbooks.map((p) => p.id)).toContain('lms-writes');
    expect(config.reference).toMatch(/LMS reference/);
  });

  it('has a rule for every write seen in the recordings', () => {
    const rules = config.playbooks
      .find((p) => p.id === 'lms-writes')!
      .rules.map((r) => r.id);
    for (const id of [
      'loan-create',
      'loan-data-patch',
      'loan-milestone-move',
      'loan-instance-visibility',
      'condition-create',
      'condition-attach',
      'condition-waive',
      'condition-note',
      'form-save',
      'template-create',
      'template-update',
      'field-create',
      'field-update',
      'condition-catalog-create',
      'condition-catalog-delete',
    ])
      expect(rules).toContain(id);
  });

  it('declares only tools that are valid for their source (no connection needed)', () => {
    const registry = new ToolRegistry(config, {});
    expect([...registry.invalid]).toEqual([]);
    expect(registry.has('loan_fields_data')).toBe(true);
    expect(registry.has('last_response')).toBe(true);
  });

  it('every verify names a tool that exists', () => {
    const registry = new ToolRegistry(config, {});
    for (const pb of config.playbooks) {
      for (const r of pb.rules)
        for (const v of r.verify)
          expect(registry.has(v.tool), `${pb.id}/${r.id} -> ${v.tool}`).toBe(
            true,
          );
    }
  });
});

describe('sources.yaml validation', () => {
  it('rejects a tool pointing at an unknown source', () => {
    expect(() =>
      parseSources('tools:\n  t: { source: nope, args: {} }\n', 'f'),
    ).toThrow(/unknown source/);
  });
  it('rejects an unknown arg type', () => {
    expect(() =>
      parseSources(
        'sources:\n  s: { type: mongo }\ntools:\n  t: { source: s, args: { a: wat } }\n',
        'f',
      ),
    ).toThrow(/unknown type/);
  });
  it('always provides the session source', () => {
    const { sources } = parseSources('sources: {}\ntools: {}\n', 'f');
    expect(sources.map((s) => s.name)).toContain('session');
  });
});

describe('playbook validation', () => {
  const tools = new Set(['t']);
  const wrap = (fm: string) => `---\n${fm}\n---\nbody`;

  it('requires an id', () => {
    expect(() => parsePlaybook(wrap('title: x'), 'f', tools)).toThrow(
      ConfigError,
    );
  });
  it('rejects a verify that uses an unknown tool', () => {
    expect(() =>
      parsePlaybook(
        wrap(
          'id: a\nrules:\n  - id: r\n    on: "POST /x"\n    verify:\n      - { tool: nope }',
        ),
        'f',
        tools,
      ),
    ).toThrow(/unknown tool/);
  });
  it('rejects an unknown operator', () => {
    expect(() =>
      parsePlaybook(
        wrap(
          'id: a\nrules:\n  - id: r\n    on: "POST /x"\n    verify:\n      - tool: t\n        expect: [{ path: a, op: nope }]',
        ),
        'f',
        tools,
      ),
    ).toThrow(/op must be one of/);
  });
  it('rejects a malformed `on`', () => {
    expect(() =>
      parsePlaybook(wrap('id: a\nrules:\n  - { id: r, on: "x" }'), 'f', tools),
    ).toThrow(/METHOD|POST/);
  });
  it('enforces a floor on the poll interval', () => {
    const pb = parsePlaybook(
      wrap(
        'id: a\nrules:\n  - id: r\n    on: "POST /x"\n    verify:\n      - { tool: t, poll: { everyMs: 10, forMs: 5000 } }',
      ),
      'f',
      tools,
    );
    expect(pb.rules[0].verify[0].poll!.everyMs).toBe(1000);
  });
  it('checks that a step waits on a rule or an endpoint', () => {
    expect(() =>
      parsePlaybook(
        wrap('id: a\nsteps:\n  - { say: go, wait: [nonsense] }'),
        'f',
        tools,
      ),
    ).toThrow(/neither a rule id/);
    expect(
      parsePlaybook(
        wrap('id: a\nsteps:\n  - { say: go, wait: ["POST /x"] }'),
        'f',
        tools,
      ).steps,
    ).toHaveLength(1);
  });
});

describe('include', () => {
  it('pulls rules and ignores from the included playbook, own rules win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
    mkdirSync(join(dir, 'playbooks'));
    writeFileSync(join(dir, 'sources.yaml'), 'sources: {}\ntools: {}\n');
    writeFileSync(
      join(dir, 'playbooks', 'base.md'),
      '---\nid: base\nignore: ["POST /login"]\nrules:\n  - { id: r1, title: base, on: "POST /a" }\n  - { id: r2, title: base2, on: "POST /b" }\n---\n',
    );
    writeFileSync(
      join(dir, 'playbooks', 'child.md'),
      '---\nid: child\ninclude: [base]\nrules:\n  - { id: r1, title: child, on: "POST /a" }\nsteps:\n  - { say: first, wait: [r2] }\n---\n',
    );
    const cfg = loadConfig(dir);
    expect(cfg.warnings.filter((w) => !w.includes('REFERENCE'))).toEqual([]);
    const child = cfg.playbooks.find((p) => p.id === 'child')!;
    expect(child.rules.map((r) => `${r.id}:${r.title}`).sort()).toEqual([
      'r1:child',
      'r2:base2',
    ]);
    expect(child.ignore).toEqual(['POST /login']);
  });

  it('one broken playbook does not stop the others loading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
    mkdirSync(join(dir, 'playbooks'));
    writeFileSync(join(dir, 'sources.yaml'), 'sources: {}\ntools: {}\n');
    writeFileSync(join(dir, 'playbooks', 'good.md'), '---\nid: good\n---\n');
    writeFileSync(join(dir, 'playbooks', 'bad.md'), '---\ntitle: no id\n---\n');
    const cfg = loadConfig(dir);
    expect(cfg.playbooks.map((p) => p.id)).toEqual(['good']);
    expect(cfg.warnings.some((w) => w.includes('bad.md'))).toBe(true);
  });
});
