import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OPS } from '../expr.ts';
import type {
  AgentConfig,
  ArgType,
  ExpectDef,
  PlaybookDef,
  PollDef,
  RuleDef,
  SourceDef,
  StepDef,
  ToolDef,
  VerifyDef,
} from './types.ts';

const ARG_TYPES: ArgType[] = [
  'string',
  'id',
  'objectid',
  'number',
  'boolean',
  'string[]',
];
const MIN_POLL_MS = 1000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class ConfigError extends Error {}

function fail(where: string, msg: string): never {
  throw new ConfigError(`${where}: ${msg}`);
}

export function splitFrontMatter(text: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = parseYaml(m[1]) as unknown;
  return { meta: isObj(meta) ? meta : {}, body: m[2] };
}

// ---------------------------------------------------------------------------
// sources.yaml
// ---------------------------------------------------------------------------

export function parseSources(
  text: string,
  file: string,
): { sources: SourceDef[]; tools: ToolDef[] } {
  const doc = parseYaml(text) as unknown;
  if (!isObj(doc)) fail(file, 'expected a mapping with `sources` and `tools`');
  const sources: SourceDef[] = [];
  const srcMap = doc.sources;
  if (srcMap !== undefined && !isObj(srcMap))
    fail(file, '`sources` must be a mapping');
  for (const [name, raw] of Object.entries((srcMap as Obj | undefined) ?? {})) {
    if (!isObj(raw)) fail(`${file} sources.${name}`, 'expected a mapping');
    const { type, ...config } = raw;
    if (type !== 'mongo' && type !== 'http' && type !== 'session') {
      fail(
        `${file} sources.${name}`,
        `type must be mongo, http or session (got ${String(type)})`,
      );
    }
    sources.push({ name, type, config });
  }
  // The recording itself is always available.
  if (!sources.some((s) => s.name === 'session'))
    sources.push({ name: 'session', type: 'session', config: {} });

  const tools: ToolDef[] = [];
  const toolMap = doc.tools;
  if (toolMap !== undefined && !isObj(toolMap))
    fail(file, '`tools` must be a mapping');
  for (const [name, raw] of Object.entries(
    (toolMap as Obj | undefined) ?? {},
  )) {
    const where = `${file} tools.${name}`;
    if (!isObj(raw)) fail(where, 'expected a mapping');
    const { source, description, args, ...spec } = raw;
    if (typeof source !== 'string' || !sources.some((s) => s.name === source)) {
      fail(where, `unknown source "${String(source)}"`);
    }
    const argTypes: Record<string, ArgType> = {};
    if (args !== undefined) {
      if (!isObj(args)) fail(where, '`args` must be a mapping of name: type');
      for (const [a, t] of Object.entries(args)) {
        if (!ARG_TYPES.includes(t as ArgType))
          fail(where, `arg "${a}" has unknown type "${String(t)}"`);
        argTypes[a] = t as ArgType;
      }
    }
    tools.push({
      name,
      description: typeof description === 'string' ? description : name,
      source,
      args: argTypes,
      spec,
    });
  }
  return { sources, tools };
}

// ---------------------------------------------------------------------------
// playbooks
// ---------------------------------------------------------------------------

function parsePoll(raw: unknown, where: string): PollDef | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) fail(where, '`poll` must be { everyMs, forMs }');
  const everyMs = Number(raw.everyMs);
  const forMs = Number(raw.forMs);
  if (!Number.isFinite(everyMs) || !Number.isFinite(forMs) || forMs <= 0)
    fail(where, '`poll` needs numeric everyMs and forMs');
  return { everyMs: Math.max(MIN_POLL_MS, everyMs), forMs };
}

function parseExpect(raw: unknown, where: string): ExpectDef {
  if (!isObj(raw)) fail(where, 'expectation must be a mapping');
  if (raw.anyOf !== undefined) {
    if (!Array.isArray(raw.anyOf) || raw.anyOf.length === 0)
      fail(where, '`anyOf` must be a non-empty list');
    return {
      path: '',
      op: 'truthy',
      anyOf: raw.anyOf.map((e, i) => parseExpect(e, `${where}.anyOf[${i}]`)),
      soft: raw.soft === true,
      say: typeof raw.say === 'string' ? raw.say : undefined,
    };
  }
  if (typeof raw.path !== 'string') fail(where, '`path` is required');
  if (typeof raw.op !== 'string' || !OPS.includes(raw.op as never)) {
    fail(where, `op must be one of ${OPS.join(', ')} (got ${String(raw.op)})`);
  }
  return {
    path: raw.path,
    op: raw.op as ExpectDef['op'],
    value: raw.value,
    soft: raw.soft === true,
    say: typeof raw.say === 'string' ? raw.say : undefined,
  };
}

function parseVerify(raw: unknown, where: string, idx: number): VerifyDef {
  if (!isObj(raw)) fail(where, 'verify entry must be a mapping');
  if (typeof raw.tool !== 'string') fail(where, '`tool` is required');
  if (raw.args !== undefined && !isObj(raw.args))
    fail(where, '`args` must be a mapping');
  const expectRaw = raw.expect === undefined ? [] : raw.expect;
  if (!Array.isArray(expectRaw)) fail(where, '`expect` must be a list');
  let capture: Record<string, string> | undefined;
  if (raw.capture !== undefined) {
    if (!isObj(raw.capture)) fail(where, '`capture` must be a mapping');
    capture = Object.fromEntries(
      Object.entries(raw.capture).map(([k, v]) => [k, String(v)]),
    );
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : `v${idx}`,
    tool: raw.tool,
    args: (raw.args as Obj | undefined) ?? {},
    poll: parsePoll(raw.poll, where),
    expect: expectRaw.map((e, i) => parseExpect(e, `${where}.expect[${i}]`)),
    say: typeof raw.say === 'string' ? raw.say : undefined,
    capture,
  };
}

export type RawPlaybooks = Map<string, Obj>;

/** `include: [other-id]` pulls in that playbook's rules and ignore list (one level). */
function mergeIncludes(meta: Obj, raw: RawPlaybooks, where: string): Obj {
  if (meta.include === undefined) return meta;
  if (!Array.isArray(meta.include))
    fail(where, '`include` must be a list of playbook ids');
  const rules: unknown[] = [];
  const ignore: unknown[] = [];
  for (const id of meta.include) {
    const other = raw.get(String(id));
    if (!other)
      fail(where, `include "${String(id)}": no playbook with that id`);
    if (Array.isArray(other.rules)) rules.push(...other.rules);
    if (Array.isArray(other.ignore)) ignore.push(...other.ignore);
  }
  const ownRules = Array.isArray(meta.rules) ? meta.rules : [];
  const ownIds = new Set(ownRules.map((r) => (isObj(r) ? r.id : undefined)));
  return {
    ...meta,
    // The including playbook wins on a clash.
    rules: [
      ...rules.filter((r) => !(isObj(r) && ownIds.has(r.id))),
      ...ownRules,
    ],
    ignore: [...ignore, ...(Array.isArray(meta.ignore) ? meta.ignore : [])],
  };
}

export function parsePlaybook(
  text: string,
  file: string,
  knownTools: Set<string>,
  raw: RawPlaybooks = new Map(),
): PlaybookDef {
  const { meta: ownMeta, body } = splitFrontMatter(text);
  const where = file;
  const meta = mergeIncludes(ownMeta, raw, where);
  if (typeof meta.id !== 'string' || !/^[a-z0-9][a-z0-9-_]*$/i.test(meta.id)) {
    fail(where, '`id` is required (letters, digits, - and _)');
  }
  const rulesRaw = meta.rules === undefined ? [] : meta.rules;
  if (!Array.isArray(rulesRaw)) fail(where, '`rules` must be a list');
  const seen = new Set<string>();
  const rules: RuleDef[] = rulesRaw.map((r, i) => {
    const rw = `${where} rules[${i}]`;
    if (!isObj(r)) fail(rw, 'rule must be a mapping');
    if (typeof r.id !== 'string') fail(rw, '`id` is required');
    if (seen.has(r.id)) fail(rw, `duplicate rule id "${r.id}"`);
    seen.add(r.id);
    if (
      typeof r.on !== 'string' ||
      !/^(\*|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/i.test(r.on)
    ) {
      fail(rw, '`on` must look like "POST /path/:id"');
    }
    if (r.bind !== undefined && !isObj(r.bind))
      fail(rw, '`bind` must be a mapping');
    const verifyRaw = r.verify === undefined ? [] : r.verify;
    if (!Array.isArray(verifyRaw)) fail(rw, '`verify` must be a list');
    const verify = verifyRaw.map((v, j) =>
      parseVerify(v, `${rw}.verify[${j}]`, j),
    );
    for (const v of verify) {
      if (!knownTools.has(v.tool))
        fail(rw, `verify uses unknown tool "${v.tool}"`);
    }
    return {
      id: r.id,
      title: typeof r.title === 'string' ? r.title : r.id,
      on: r.on.trim(),
      status:
        typeof r.status === 'string' || typeof r.status === 'number'
          ? String(r.status)
          : '2xx',
      required: r.required === true,
      bind: (r.bind as Obj | undefined) ?? {},
      verify,
    };
  });

  const stepsRaw = meta.steps === undefined ? [] : meta.steps;
  if (!Array.isArray(stepsRaw)) fail(where, '`steps` must be a list');
  const steps: StepDef[] = stepsRaw.map((s, i) => {
    if (!isObj(s) || typeof s.say !== 'string')
      fail(`${where} steps[${i}]`, '`say` is required');
    const wait = s.wait === undefined ? [] : s.wait;
    if (!Array.isArray(wait))
      fail(`${where} steps[${i}]`, '`wait` must be a list');
    for (const w of wait) {
      const isRule = rules.some((r) => r.id === w);
      if (!isRule && !/^(\*|[A-Z]+)\s+\//.test(String(w))) {
        fail(
          `${where} steps[${i}]`,
          `wait entry "${String(w)}" is neither a rule id nor "METHOD /path"`,
        );
      }
    }
    return { say: s.say, wait: wait.map(String) };
  });

  const ignore = meta.ignore === undefined ? [] : meta.ignore;
  if (!Array.isArray(ignore)) fail(where, '`ignore` must be a list');

  return {
    id: meta.id,
    title: typeof meta.title === 'string' ? meta.title : meta.id,
    description:
      typeof meta.description === 'string' ? meta.description : undefined,
    brief: body.trim(),
    ignore: ignore.map(String),
    rules,
    steps,
    needsModel: meta.model === true,
    hash: createHash('sha1').update(text).digest('hex').slice(0, 10),
    file,
  };
}

// ---------------------------------------------------------------------------
// directory
// ---------------------------------------------------------------------------

export function loadConfig(dir: string): AgentConfig {
  const warnings: string[] = [];
  const sourcesFile = join(dir, 'sources.yaml');
  if (!existsSync(sourcesFile)) fail(dir, 'sources.yaml not found');
  const { sources, tools } = parseSources(
    readFileSync(sourcesFile, 'utf8'),
    'sources.yaml',
  );
  const toolNames = new Set(tools.map((t) => t.name));

  const playbooks: PlaybookDef[] = [];
  const pbDir = join(dir, 'playbooks');
  if (existsSync(pbDir)) {
    const files = readdirSync(pbDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    const texts = new Map(
      files.map((f) => [f, readFileSync(join(pbDir, f), 'utf8')]),
    );
    const raw: RawPlaybooks = new Map();
    for (const text of texts.values()) {
      try {
        const { meta } = splitFrontMatter(text);
        if (typeof meta.id === 'string') raw.set(meta.id, meta);
      } catch {
        /* reported when that file is parsed below */
      }
    }
    for (const f of files) {
      try {
        playbooks.push(
          parsePlaybook(texts.get(f)!, `playbooks/${f}`, toolNames, raw),
        );
      } catch (e) {
        // One bad playbook must not take the others down; say which and why.
        if (e instanceof ConfigError) warnings.push(e.message);
        else throw e;
      }
    }
  }
  const refFile = join(dir, 'REFERENCE.md');
  const reference = existsSync(refFile) ? readFileSync(refFile, 'utf8') : '';
  if (!reference)
    warnings.push(
      'REFERENCE.md not found: the model will have no description of your data',
    );
  return { dir, sources, tools, playbooks, reference, warnings };
}
