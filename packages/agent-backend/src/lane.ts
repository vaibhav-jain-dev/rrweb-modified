/**
 * One lane = one playbook running against one session.
 *
 * The invariant that makes a small model safe here: a check's status is set
 * only by this file's code, from a tool result, an assertion or a timer. The
 * model may translate a typed request into a tool call and may add
 * observations marked as model-written; it never marks anything verified.
 */
import type {
  Anomaly,
  Check,
  Evidence,
  Headline,
  LaneLedger,
  LaneVerdict,
  Observation,
  StepState,
} from '../../web-extension/src/agent/protocol.ts';
import { isMutatingMethod } from '../../web-extension/src/agent/protocol.ts';
import type {
  ExpectDef,
  PlaybookDef,
  PollDef,
  RuleDef,
  VerifyDef,
} from './config/types.ts';
import { matchEndpoint, statusMatches } from './endpoint.ts';
import {
  OPS,
  evaluate,
  getPath,
  interpolate,
  isRef,
  resolveRef,
  resolveValue,
  type Op,
  type Scope,
} from './expr.ts';
import { ModelError, type ModelClient } from './model/types.ts';
import type { RequestRecord, ToolContext } from './sources/types.ts';
import type { ToolRegistry } from './tools/registry.ts';

const MAX_CONCURRENT_POLLS = 4;
const MAX_RESULT_JSON = 2000;
const MAX_ASSERT_JSON = 300;
const ASK_POLL: PollDef = { everyMs: 2000, forMs: 60_000 };

export type LaneDeps = {
  registry: ToolRegistry;
  model: ModelClient | null;
  reference: string;
  /** Wall-clock ms of session start. */
  startedAt: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  requests: () => readonly RequestRecord[];
  onChange: () => void;
  onGate: (tRel: number) => void;
};

type Traffic = { req: RequestRecord; ruleIds: string[] };

type Failure = {
  path: string;
  op: string;
  expected: unknown;
  actual: unknown;
  say?: string;
  detail?: string;
};
type ExpectResult = {
  hard: Failure[];
  soft: Failure[];
  skipped: string[];
  asserts: Evidence[];
};

export class Lane {
  readonly checks: Check[] = [];
  readonly observations: Observation[] = [];
  readonly anomalies: Anomaly[] = [];
  readonly uncovered: Record<string, number> = {};
  /** Latest value of every bound name; what an ask can refer to. */
  readonly vars: Record<string, unknown> = {};
  private readonly traffic: Traffic[] = [];
  private readonly occ = new Map<string, number>();
  private readonly work = new Set<Promise<void>>();
  private readonly steps: StepState[];
  private stepWaits: string[][];
  private gateReadyAt: number | undefined;
  private headline: Headline = {
    level: 'idle',
    text: 'Waiting for the first call…',
    t: 0,
  };
  private stopping = false;
  private polls = 0;
  private pollWaiters: (() => void)[] = [];
  private askSeq = 0;
  private reportedUncovered = new Set<string>();

  readonly pb: PlaybookDef;
  private readonly deps: LaneDeps;

  constructor(pb: PlaybookDef, deps: LaneDeps) {
    this.pb = pb;
    this.deps = deps;
    this.steps = pb.steps.map((s) => ({
      say: s.say,
      wait: s.wait,
      state: 'upcoming' as const,
    }));
    this.stepWaits = pb.steps.map((s) => s.wait);
    this.refreshSteps();
  }

  // -------------------------------------------------------------------------
  // intake
  // -------------------------------------------------------------------------

  onRequest(req: RequestRecord): void {
    const matched = this.pb.rules.filter(
      (r) =>
        matchEndpoint(r.on, req.method, req.pathname) &&
        statusMatches(r.status, req.status, req.failed),
    );
    this.traffic.push({ req, ruleIds: matched.map((r) => r.id) });

    if (
      matched.length === 0 &&
      isMutatingMethod(req.method) &&
      !this.isIgnored(req)
    ) {
      this.noteUnmatchedWrite(req);
    }
    for (const rule of matched) {
      if (rule.verify.length > 0)
        this.setHeadline('checking', `${rule.title}: checking…`);
      this.track(this.runOccurrence(rule, req));
    }
    this.refreshSteps();
    this.deps.onChange();
  }

  private isIgnored(req: RequestRecord): boolean {
    return this.pb.ignore.some((p) =>
      matchEndpoint(p, req.method, req.pathname),
    );
  }

  private noteUnmatchedWrite(req: RequestRecord): void {
    const failedCall =
      req.failed || (req.status !== undefined && req.status >= 400);
    if (failedCall) {
      this.anomalies.push({
        t: req.tRel,
        kind: 'error_response',
        text: `${req.endpoint} answered ${
          req.failed ? 'with a network failure' : req.status
        }`,
        requestId: req.requestId,
        endpoint: req.endpoint,
      });
      return;
    }
    this.uncovered[req.endpoint] = (this.uncovered[req.endpoint] ?? 0) + 1;
    if (!this.reportedUncovered.has(req.endpoint)) {
      this.reportedUncovered.add(req.endpoint);
      this.anomalies.push({
        t: req.tRel,
        kind: 'uncovered_write',
        text: `${req.endpoint} wrote data but no rule verifies it`,
        requestId: req.requestId,
        endpoint: req.endpoint,
      });
    }
  }

  private track(p: Promise<void>): void {
    this.work.add(p);
    void p.finally(() => {
      this.work.delete(p);
      this.deps.onChange();
    });
  }

  // -------------------------------------------------------------------------
  // rule occurrence
  // -------------------------------------------------------------------------

  private async runOccurrence(
    rule: RuleDef,
    req: RequestRecord,
  ): Promise<void> {
    const n = (this.occ.get(rule.id) ?? 0) + 1;
    this.occ.set(rule.id, n);
    const scope = requestScope(req);
    const requestEvidence: Evidence = {
      kind: 'request',
      requestId: req.requestId,
      endpoint: req.endpoint,
      status: req.status,
      url: `${req.method} ${req.url}`,
    };

    // Bind first, whether or not there is anything to verify: bound values
    // are what a later ask refers to ("check that order").
    const bindFailure = await this.bindAll(rule, scope);

    if (rule.verify.length === 0) {
      // A rule with nothing to verify only asserts the call happened.
      this.checks.push(
        this.newCheck(
          `${rule.id}#${n}`,
          rule.id,
          rule.title,
          req,
          bindFailure ? 'unchecked' : 'verified',
          [requestEvidence],
          req.tRel,
          bindFailure
            ? { note: `could not bind values: ${bindFailure}`, noteBy: 'code' }
            : {},
        ),
      );
      this.setHeadline(
        bindFailure ? 'bad' : 'ok',
        bindFailure
          ? `${rule.title}: could not bind values`
          : `${rule.title} — call seen`,
      );
      return;
    }

    const mine = rule.verify.map((v) =>
      this.newCheck(
        `${rule.id}#${n}.${v.id}`,
        rule.id,
        `${rule.title} · ${v.tool}`,
        req,
        'observed',
        [requestEvidence],
        undefined,
      ),
    );
    for (const c of mine) c.activity = 'queued';
    this.checks.push(...mine);
    this.setHeadline('checking', `${rule.title}: checking…`);

    if (bindFailure) {
      for (const c of mine)
        this.finish(
          c,
          'unchecked',
          `could not bind values: ${bindFailure}`,
          rule.title,
        );
      return;
    }

    for (let i = 0; i < rule.verify.length; i++) {
      await this.runVerify(mine[i], rule.verify[i], scope, rule.title);
    }
  }

  /** Returns an error message, or undefined when every binding resolved (possibly to undefined). */
  private async bindAll(
    rule: RuleDef,
    scope: Scope,
  ): Promise<string | undefined> {
    try {
      for (const [name, spec] of Object.entries(rule.bind)) {
        const value = await this.resolveBind(spec, scope);
        scope[name] = value;
        this.vars[name] = value;
      }
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  private newCheck(
    id: string,
    ruleId: string,
    claim: string,
    req: RequestRecord | undefined,
    status: Check['status'],
    evidence: Evidence[],
    tResolved: number | undefined,
    extra: Partial<Check> = {},
  ): Check {
    return {
      id,
      ruleId,
      origin: 'playbook',
      claim,
      status,
      requestId: req?.requestId,
      endpoint: req?.endpoint,
      tObserved: req?.tRel,
      tResolved,
      evidence,
      ...extra,
    };
  }

  private async resolveBind(spec: unknown, scope: Scope): Promise<unknown> {
    if (
      spec &&
      typeof spec === 'object' &&
      !Array.isArray(spec) &&
      'find' in spec
    ) {
      const f = spec as { find: string; in?: string; prefer?: string[] };
      const data = f.in
        ? resolveValue(f.in, scope)
        : scope.res && (scope.res as { body?: unknown }).body;
      return this.findValue(f.find, data, f.prefer ?? []);
    }
    return resolveValue(spec, scope);
  }

  /** Find "the id of X" in a JSON value: by key name first, by constrained model choice second. */
  private async findValue(
    description: string,
    data: unknown,
    prefer: string[],
  ): Promise<unknown> {
    const leaves = collectLeaves(data);
    const keyed = (re: RegExp) =>
      leaves.find((l) => re.test(l.path.split('.').pop() ?? ''));
    for (const p of prefer) {
      const hit = leaves.find((l) => l.path === p);
      if (hit) return hit.value;
    }
    const hit = keyed(/^_id$/) ?? keyed(/^id$/) ?? keyed(/(_id|Id)$/);
    if (hit) return hit.value;
    if (!this.deps.model || leaves.length === 0) return undefined;
    const candidates = leaves.slice(0, 60);
    try {
      const answer = await this.deps.model.generate<{ path: string }>({
        priority: 'extract',
        system:
          'You choose which field of a JSON response answers the question. Answer with one path from the list.',
        user: `Question: ${description}\nFields:\n${candidates
          .map((c) => `${c.path} = ${shortValue(c.value)}`)
          .join('\n')}`,
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', enum: candidates.map((c) => c.path) },
          },
          required: ['path'],
        },
      });
      return candidates.find((c) => c.path === answer.path)?.value;
    } catch (e) {
      if (e instanceof ModelError) return undefined;
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // verify with polling
  // -------------------------------------------------------------------------

  private async runVerify(
    check: Check,
    v: VerifyDef,
    scope: Scope,
    title: string,
  ): Promise<void> {
    const args = resolveValue(v.args, scope) as Record<string, unknown>;
    await this.withPollSlot(check, async () => {
      const poll = v.poll;
      const startedAt = this.deps.now();
      const deadline = startedAt + (poll?.forMs ?? 0);
      let attempt = 0;
      for (;;) {
        attempt++;
        check.activity = `checking ${v.tool}${
          poll ? ` (try ${attempt})` : ''
        }…`;
        this.deps.onChange();
        const ctx: ToolContext = { requests: this.deps.requests() };
        const out = await this.deps.registry.run(v.tool, args, ctx);
        const canRetry =
          !!poll &&
          !this.stopping &&
          this.deps.now() + poll.everyMs <= deadline;

        if (!out.ok) {
          if (out.kind === 'unavailable' && canRetry) {
            await this.nap(poll!.everyMs);
            continue;
          }
          check.evidence = check.evidence.filter((e) => e.kind !== 'error');
          check.evidence.push({ kind: 'error', message: out.message });
          this.finish(check, 'unchecked', out.message, title);
          return;
        }

        const result = out.run.value;
        const res = runExpects(v.expect, { ...scope, result }, result);
        check.evidence = check.evidence.filter(
          (e) =>
            e.kind !== 'tool' && e.kind !== 'assert' && e.kind !== 'timeout',
        );
        check.evidence.push({
          kind: 'tool',
          tool: v.tool,
          args: boundedArgs(args),
          result: trimResult(result),
          ref: out.run.ref,
          ms: out.ms,
          attempt,
        });
        check.evidence.push(...res.asserts);
        const warnings = [
          ...res.soft.map(describeFailure),
          ...res.skipped.map((s) => `skipped: ${s}`),
        ];
        check.warnings = warnings.length ? warnings : undefined;

        if (res.hard.length === 0) {
          for (const [name, ref] of Object.entries(v.capture ?? {})) {
            const val = isRef(ref)
              ? resolveRef(ref, { ...scope, result })
              : ref;
            scope[name] = val;
            this.vars[name] = val;
          }
          const line = interpolate(v.say ?? `${title}: ${v.tool} confirmed`, {
            ...scope,
            ...flatResult(result),
          });
          this.finish(
            check,
            'verified',
            warnings.length ? `${line} (⚠ ${warnings.length} soft)` : line,
            title,
            line,
          );
          return;
        }
        if (canRetry) {
          check.activity = `waiting for ${v.tool} to match (try ${attempt})…`;
          await this.nap(poll!.everyMs);
          continue;
        }
        if (poll)
          check.evidence.push({ kind: 'timeout', withinMs: poll.forMs });
        const first = res.hard[0];
        this.finish(
          check,
          'failed',
          first.say ?? describeFailure(first),
          title,
        );
        void this.explainFailure(check);
        return;
      }
    });
  }

  private finish(
    check: Check,
    status: Check['status'],
    note: string,
    title: string,
    headlineText?: string,
  ): void {
    check.status = status;
    check.note = note;
    check.noteBy = 'code';
    check.activity = undefined;
    check.tResolved = Math.max(
      check.tObserved ?? 0,
      this.deps.now() - this.deps.startedAt,
    );
    if (status === 'verified')
      this.setHeadline('ok', headlineText ?? `${title}: ok`);
    else
      this.setHeadline(
        'bad',
        `${title}: ${
          status === 'unchecked' ? 'could not check — ' : ''
        }${note}`,
      );
    this.refreshSteps();
    this.deps.onChange();
  }

  private async nap(ms: number): Promise<void> {
    let left = ms;
    while (left > 0 && !this.stopping) {
      const d = Math.min(250, left);
      await this.deps.sleep(d);
      left -= d;
    }
  }

  private async withPollSlot(
    check: Check,
    fn: () => Promise<void>,
  ): Promise<void> {
    while (this.polls >= MAX_CONCURRENT_POLLS && !this.stopping) {
      check.activity = 'queued';
      await new Promise<void>((r) => this.pollWaiters.push(r));
    }
    this.polls++;
    try {
      await fn();
    } finally {
      this.polls--;
      this.pollWaiters.shift()?.();
    }
  }

  /** Model-written, unverified, never changes a status. */
  private async explainFailure(check: Check): Promise<void> {
    const model = this.deps.model;
    if (!model || !this.pb.needsModel) return;
    try {
      const out = await model.generate<{ why: string }>({
        priority: 'note',
        system: `${this.pb.brief}\nExplain in one short sentence the most likely reason a database check failed. Do not invent data.`,
        user: `Check: ${check.claim}\nNote: ${
          check.note
        }\nEvidence: ${JSON.stringify(check.evidence).slice(0, 1500)}`,
        schema: {
          type: 'object',
          properties: { why: { type: 'string' } },
          required: ['why'],
        },
      });
      if (out.why) {
        this.observations.push({
          t: this.deps.now() - this.deps.startedAt,
          text: `${check.claim}: ${out.why.slice(0, 200)}`,
          requestId: check.requestId,
          by: 'model',
        });
        this.deps.onChange();
      }
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
    }
  }

  // -------------------------------------------------------------------------
  // asks
  // -------------------------------------------------------------------------

  async ask(
    text: string,
  ): Promise<{ ok: boolean; checkId?: string; message?: string }> {
    const model = this.deps.model;
    if (!model)
      return {
        ok: false,
        message:
          'No model is running. Start Ollama, or add a rule to the playbook.',
      };
    const tools = this.deps.registry.list();
    const known = Object.keys(this.vars);
    let plan: AskPlan;
    try {
      plan = await model.generate<AskPlan>({
        priority: 'ask',
        system: [
          'You turn a request into exactly one database/API lookup. Choose the tool and its arguments.',
          'Arguments are either a literal string or a reference to a known value written as $name.',
          'Use poll=true when the thing may take a while to appear. Add expectations only if the request states one.',
          this.deps.reference.slice(0, 2500),
        ].join('\n'),
        user: `Request: ${text}\nKnown values: ${
          known.length
            ? known.map((k) => `$${k}=${shortValue(this.vars[k])}`).join(', ')
            : '(none yet)'
        }\nTools:\n${this.deps.registry.describe()}`,
        schema: askSchema(tools.map((t) => t.name)),
      });
    } catch (e) {
      if (e instanceof ModelError)
        return {
          ok: false,
          message: `The model could not be reached (${e.message}).`,
        };
      throw e;
    }
    const checked = validateAskPlan(plan, this.deps.registry, this.vars);
    if (typeof checked === 'string') return { ok: false, message: checked };

    const n = ++this.askSeq;
    const verify: VerifyDef = {
      id: 'ask',
      tool: checked.tool,
      args: checked.args,
      poll: checked.poll ? ASK_POLL : undefined,
      expect: checked.expect,
      say: checked.claim,
    };
    const check = this.newCheck(
      `ask#${n}`,
      'ask',
      checked.claim,
      undefined,
      'observed',
      [],
      undefined,
      {
        origin: 'ask',
        askText: text,
        tObserved: this.deps.now() - this.deps.startedAt,
      },
    );
    this.checks.push(check);
    this.setHeadline('checking', `${checked.claim}: checking…`);
    this.track(this.runVerify(check, verify, { ...this.vars }, 'Ask'));
    this.deps.onChange();
    return { ok: true, checkId: check.id };
  }

  // -------------------------------------------------------------------------
  // steps and gate
  // -------------------------------------------------------------------------

  private refreshSteps(): void {
    if (this.steps.length === 0) return;
    const consumed = new Set<string>();
    const nowT = this.deps.now() - this.deps.startedAt;

    this.steps.forEach((step, i) => {
      const waits = this.stepWaits[i];
      let allOk = waits.length > 0;
      let anyBad = false;
      for (const w of waits) {
        const hit = this.findForWait(w, consumed);
        if (!hit) {
          allOk = false;
          continue;
        }
        consumed.add(hit.req.requestId);
        const st = this.requestState(hit.req.requestId);
        if (st === 'bad') anyBad = true;
        if (st !== 'ok') allOk = false;
      }
      const prev = step.state;
      step.state = allOk ? 'passed' : anyBad ? 'blocked' : 'upcoming';
      if (step.state === 'passed' && prev !== 'passed') step.passedAt = nowT;
      if (step.state !== 'passed') step.passedAt = undefined;
    });

    // An instruction-only step is done once anything after it is.
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (
        this.stepWaits[i].length === 0 &&
        this.steps.slice(i + 1).some((s) => s.state === 'passed')
      ) {
        this.steps[i].state = 'passed';
      }
    }
    const current = this.steps.findIndex((s) => s.state !== 'passed');
    this.steps.forEach((s, i) => {
      if (i === current && s.state === 'upcoming') s.state = 'current';
      if (i === current && s.reachedAt === undefined) s.reachedAt = nowT;
    });

    const waitSteps = this.steps.filter((_, i) => this.stepWaits[i].length > 0);
    const done =
      waitSteps.length > 0 && waitSteps.every((s) => s.state === 'passed');
    if (done && this.gateReadyAt === undefined) {
      this.gateReadyAt = nowT;
      this.setHeadline('ok', 'All steps verified — go ahead');
      this.deps.onGate(nowT);
    } else if (!done) {
      this.gateReadyAt = undefined;
    }
  }

  private findForWait(
    wait: string,
    consumed: Set<string>,
  ): Traffic | undefined {
    const isRule = this.pb.rules.some((r) => r.id === wait);
    return this.traffic.find((t) => {
      if (consumed.has(t.req.requestId)) return false;
      if (isRule) return t.ruleIds.includes(wait);
      return (
        matchEndpoint(wait, t.req.method, t.req.pathname) &&
        statusMatches('2xx', t.req.status, t.req.failed)
      );
    });
  }

  private requestState(requestId: string): 'ok' | 'pending' | 'bad' {
    const mine = this.checks.filter((c) => c.requestId === requestId);
    if (
      mine.some(
        (c) =>
          c.status === 'failed' ||
          c.status === 'unchecked' ||
          c.status === 'never_seen',
      )
    )
      return 'bad';
    if (mine.some((c) => c.status === 'observed' || c.status === 'pending'))
      return 'pending';
    return 'ok';
  }

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  private setHeadline(level: Headline['level'], text: string): void {
    this.headline = { level, text, t: this.deps.now() - this.deps.startedAt };
  }

  ledger(): LaneLedger {
    const verdict: LaneVerdict = {
      verified: 0,
      failed: 0,
      unchecked: 0,
      never_seen: 0,
      pending: 0,
      observed: 0,
    };
    for (const c of this.checks) verdict[c.status]++;
    const current = this.steps.findIndex((s) => s.state !== 'passed');
    let headline = this.headline;
    if (this.steps.length && headline.level === 'idle' && current >= 0) {
      headline = {
        level: 'idle',
        text: `Next: ${this.steps[current].say}`,
        t: headline.t,
      };
    }
    return {
      playbookId: this.pb.id,
      playbookHash: this.pb.hash,
      title: this.pb.title,
      verdict,
      headline,
      checks: this.checks.map((c) => ({ ...c })),
      steps: this.steps.length ? this.steps.map((s) => ({ ...s })) : undefined,
      currentStep: this.steps.length && current >= 0 ? current : undefined,
      gateReadyAt: this.gateReadyAt,
      observations: [...this.observations],
      anomalies: [...this.anomalies],
      uncovered: { ...this.uncovered },
    };
  }

  /** Resolves when no check is running. Does not stop polling (finalize does). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  /** Let in-flight checks settle (bounded), then close out what cannot. */
  async finalize(waitMs = 8000): Promise<void> {
    this.stopping = true;
    for (const w of this.pollWaiters.splice(0)) w();
    await Promise.race([
      Promise.allSettled([...this.work]),
      new Promise((r) => setTimeout(r, waitMs)),
    ]);
    const t = this.deps.now() - this.deps.startedAt;
    for (const c of this.checks) {
      if (c.status === 'observed' || c.status === 'pending') {
        c.status = 'unchecked';
        c.note = 'recording stopped before this check finished';
        c.noteBy = 'code';
        c.activity = undefined;
        c.tResolved = t;
      }
    }
    for (const rule of this.pb.rules) {
      if (this.occ.has(rule.id) || !rule.required) continue;
      this.checks.push(
        this.newCheck(
          `${rule.id}#0`,
          rule.id,
          rule.title,
          undefined,
          'never_seen',
          [],
          t,
          {
            note: `expected ${rule.on}, but it was never called`,
            noteBy: 'code',
          },
        ),
      );
    }
    this.steps.forEach((s, i) => {
      if (s.state === 'passed') return;
      for (const w of this.stepWaits[i]) {
        this.anomalies.push({
          t,
          kind: 'missing_call',
          text: `step "${s.say}" never saw ${w}`,
          endpoint: w,
        });
      }
    });
    this.deps.onChange();
  }
}

// ---------------------------------------------------------------------------
// helpers (exported for tests)
// ---------------------------------------------------------------------------

export function requestScope(req: RequestRecord): Scope {
  return {
    req: {
      body: req.requestBody,
      header: req.requestHeaders,
      query: req.query,
      method: req.method,
    },
    res: {
      body: req.responseBody,
      status: req.status,
      header: req.responseHeaders,
    },
    path: req.idSegments,
    query: req.query,
    url: req.url,
  };
}

export function runExpects(
  expects: ExpectDef[],
  scope: Scope,
  result: Record<string, unknown>,
): ExpectResult {
  const out: ExpectResult = { hard: [], soft: [], skipped: [], asserts: [] };
  const one = (
    e: ExpectDef,
  ): {
    ok: boolean;
    skipped?: string;
    failure?: Failure;
    evidence?: Evidence;
  } => {
    const actual = getPath(result, e.path);
    const expected = resolveValue(e.value, scope);
    if (needsValue(e.op) && hasUndefined(expected) && containsRef(e.value)) {
      return {
        ok: true,
        skipped: `${e.path} ${e.op} ${String(
          e.value,
        )} (reference did not resolve)`,
      };
    }
    const o = evaluate(e.op, actual, expected);
    const evidence: Evidence = {
      kind: 'assert',
      path: e.path,
      op: e.op,
      expected: compact(expected),
      actual: compact(actual),
      ok: o.ok,
      soft: e.soft || undefined,
    };
    return {
      ok: o.ok,
      evidence,
      failure: o.ok
        ? undefined
        : {
            path: e.path,
            op: e.op,
            expected: compact(expected),
            actual: compact(actual),
            say: e.say,
            detail: o.detail,
          },
    };
  };
  for (const e of expects) {
    if (e.anyOf) {
      const subs = e.anyOf.map(one);
      const ok = subs.some((s) => s.ok);
      for (const s of subs) if (s.evidence) out.asserts.push(s.evidence);
      for (const s of subs) if (s.skipped) out.skipped.push(s.skipped);
      if (!ok) {
        const f: Failure = {
          path: e.anyOf.map((a) => a.path).join(' | '),
          op: 'anyOf',
          expected: 'one of the alternatives',
          actual: subs.map((s) => s.failure?.actual),
          say: e.say,
        };
        (e.soft ? out.soft : out.hard).push(f);
      }
      continue;
    }
    const r = one(e);
    if (r.evidence) out.asserts.push(r.evidence);
    if (r.skipped) out.skipped.push(r.skipped);
    if (!r.ok && r.failure) (e.soft ? out.soft : out.hard).push(r.failure);
  }
  return out;
}

function needsValue(op: Op): boolean {
  return !['exists', 'missing', 'truthy', 'falsy'].includes(op);
}
function containsRef(v: unknown): boolean {
  if (isRef(v)) return true;
  if (Array.isArray(v)) return v.some(containsRef);
  if (v && typeof v === 'object') return Object.values(v).some(containsRef);
  return false;
}
function hasUndefined(v: unknown): boolean {
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.some(hasUndefined);
  if (v && typeof v === 'object') return Object.values(v).some(hasUndefined);
  return false;
}

export function describeFailure(f: Failure): string {
  const exp =
    f.op === 'exists' ||
    f.op === 'missing' ||
    f.op === 'truthy' ||
    f.op === 'falsy'
      ? ''
      : ` ${shortValue(f.expected)}`;
  return `${f.path} ${f.op}${exp} — got ${shortValue(f.actual)}${
    f.detail ? ` (${f.detail})` : ''
  }`;
}

function compact(v: unknown): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s && s.length > MAX_ASSERT_JSON
    ? `${s.slice(0, MAX_ASSERT_JSON)}…`
    : v;
}

export function shortValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function trimResult(v: Record<string, unknown>): unknown {
  const s = JSON.stringify(v);
  return s.length > MAX_RESULT_JSON
    ? { _truncated: true, preview: `${s.slice(0, MAX_RESULT_JSON)}…` }
    : v;
}

function boundedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [
      k,
      Array.isArray(v) && v.length > 20
        ? [...v.slice(0, 20), `[+${v.length - 20} more]`]
        : v,
    ]),
  );
}

/** Result fields made available to `say` templates: `{loan_application_number}` as well as `{doc.x}`. */
function flatResult(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  const doc = result.doc;
  if (doc && typeof doc === 'object') Object.assign(out, doc);
  return out;
}

function collectLeaves(
  data: unknown,
  prefix = '',
  depth = 0,
  out: { path: string; value: string | number }[] = [],
) {
  if (depth > 4 || out.length > 200) return out;
  if (typeof data === 'string' || typeof data === 'number') {
    if (prefix) out.push({ path: prefix, value: data });
  } else if (Array.isArray(data)) {
    data
      .slice(0, 3)
      .forEach((v, i) =>
        collectLeaves(v, prefix ? `${prefix}[${i}]` : `[${i}]`, depth + 1, out),
      );
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data))
      collectLeaves(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ask plan
// ---------------------------------------------------------------------------

export type AskPlan = {
  claim: string;
  tool: string;
  args: Record<string, string>;
  poll?: boolean;
  expect?: { path: string; op: string; value?: string }[];
};

export function askSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      claim: { type: 'string' },
      tool: { type: 'string', enum: toolNames },
      args: { type: 'object', additionalProperties: { type: 'string' } },
      poll: { type: 'boolean' },
      expect: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            op: { type: 'string', enum: [...OPS] },
            value: { type: 'string' },
          },
          required: ['path', 'op'],
        },
      },
    },
    required: ['claim', 'tool', 'args'],
  };
}

/** Turn a model's plan into something runnable, or a message the person can act on. */
export function validateAskPlan(
  plan: AskPlan,
  registry: ToolRegistry,
  vars: Record<string, unknown>,
):
  | {
      claim: string;
      tool: string;
      args: Record<string, unknown>;
      poll: boolean;
      expect: ExpectDef[];
    }
  | string {
  const tool = registry.get(plan?.tool);
  if (!tool) {
    const names = registry
      .list()
      .map((t) => t.name)
      .slice(0, 8)
      .join(', ');
    return `No tool matches that request. Available: ${names}.`;
  }
  const args: Record<string, unknown> = {};
  for (const name of Object.keys(tool.args)) {
    const raw = plan.args?.[name];
    if (raw === undefined || raw === '')
      return `${tool.name} needs "${name}" and I could not work it out. Say it, or do the action first so I can see the value.`;
    if (isRef(raw)) {
      const key = raw.slice(1).split(/[.[]/)[0];
      if (!(key in vars)) {
        const have = Object.keys(vars);
        return `I don't know $${key} yet${
          have.length ? ` (known: ${have.map((h) => `$${h}`).join(', ')})` : ''
        }.`;
      }
      args[name] = resolveValue(raw, vars);
    } else {
      args[name] = tool.args[name] === 'string[]' ? [raw] : raw;
    }
  }
  const expect: ExpectDef[] = [];
  for (const e of plan.expect ?? []) {
    if (!OPS.includes(e.op as Op)) return `Unknown comparison "${e.op}".`;
    expect.push({ path: e.path, op: e.op as Op, value: e.value });
  }
  // With nothing stated, "is it there" is the only honest default.
  if (expect.length === 0)
    expect.push({ path: 'found', op: 'eq', value: true });
  return {
    claim: plan.claim || `${tool.name}`,
    tool: tool.name,
    args,
    poll: !!plan.poll,
    expect,
  };
}
