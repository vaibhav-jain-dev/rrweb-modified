import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { templateRoute } from '../../web-extension/src/evidence/route-template.ts';
import type { UIDigest } from '../../web-extension/src/evidence/types.ts';
import { prepareAuth } from './auth.ts';
import { compareStep } from './compare.ts';
import { findLocator } from './locate.ts';
import { Observer } from './observe.ts';
import { Watcher } from './watch.ts';
import type { LoadedRecording } from './recording.ts';
import { collapseUi, renderStep, renderSummary } from './report.ts';
import { enableSlow } from './slow.ts';
import type { SlowRange } from './slow.ts';
import type { Step, StepResult } from './types.ts';
import { digestOf, settle, stepLimitMs } from './wait.ts';
import { unansweredWrites } from './writes.ts';
import type { WriteVerifier } from './writes.ts';
import { resolveValue } from './patch.ts';

const INJECT_ENTRY = new URL('../inject/digest-entry.ts', import.meta.url).pathname;
const BAD = new Set(['diverged', 'failed', 'timeout', 'unlocatable']);

export type RunOptions = {
  steps: Step[];
  rec: LoadedRecording;
  slow?: SlowRange;
  verifier?: WriteVerifier;
  /** keep going after a divergence (never after a failure) */
  continueOnDiverge?: boolean;
  log?: (m: string) => void;
};

export type RunOutcome = {
  ok: boolean;
  results: StepResult[];
  summary: string;
  /** full block of the step the run stopped on */
  problem?: string;
};

let digestScript: string | undefined;
async function injectScript(): Promise<string> {
  digestScript ??= (
    await build({ entryPoints: [INJECT_ENTRY], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })
  ).outputFiles[0].text;
  return digestScript;
}

/** One visible browser that stays open between `run` calls. */
export class ReplaySession {
  context?: BrowserContext;
  page?: Page;
  readonly observer = new Observer();
  readonly watcher = new Watcher();
  rec?: LoadedRecording;
  steps: Step[] = [];
  results = new Map<number, StepResult>();
  private lastDigest?: UIDigest;

  async ensureBrowser(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const profile = process.env.REPLAY_PROFILE_DIR ?? join(homedir(), '.rrweb-replay', 'profile');
    mkdirSync(profile, { recursive: true });
    const launch = () =>
      chromium.launchPersistentContext(profile, {
        headless: process.env.REPLAY_HEADLESS === '1',
        viewport: { width: 1440, height: 900 },
      });
    try {
      this.context = await launch();
    } catch (e) {
      // First run on a machine: fetch the pinned browser once, then retry.
      if (!/Executable doesn't exist/.test(String(e))) throw e;
      process.stderr.write('replay-mcp: installing Chromium once (about 190 MB)...\n');
      execFileSync(process.execPath, [join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
      this.context = await launch();
    }
    // The site's sign-in is a session cookie, which Chromium drops on close; restore the saved copy.
    this.statePath = join(profile, 'session-cookies.json');
    if (existsSync(this.statePath)) {
      await this.context.addCookies(JSON.parse(readFileSync(this.statePath, 'utf8'))).catch(() => undefined);
    }
    await this.context.addInitScript(await injectScript());
    this.observer.attach(this.context);
    await this.watcher.attach(this.context, (u) => templateRoute(new URL(u).pathname + new URL(u).search));
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  private statePath?: string;

  /** Keep the current cookies (sign-in included) for the next start. */
  async saveSession(): Promise<void> {
    if (!this.context || !this.statePath) return;
    const cookies = await this.context.cookies().catch(() => []);
    if (cookies.length) writeFileSync(this.statePath, JSON.stringify(cookies), { mode: 0o600 });
  }

  /** Leave the window open for you to look at, until you close it. */
  async waitUntilClosed(): Promise<void> {
    await this.saveSession();
    await new Promise<void>((resolve) => this.context?.on('close', () => resolve()) ?? resolve());
  }

  async close(): Promise<void> {
    await this.saveSession();
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
  }

  async run(opts: RunOptions): Promise<RunOutcome> {
    const log = opts.log ?? (() => undefined);
    const page = await this.ensureBrowser();
    const { steps, rec } = opts;
    this.rec = rec;
    this.steps = steps;
    const runnable = steps.filter((s) => !s.skip);
    if (runnable.length === 0) return { ok: true, results: [], summary: 'nothing to run (every step is skipped)' };

    const undoSlow = opts.slow ? await enableSlow(this.context!, opts.slow) : undefined;
    const results: StepResult[] = [];
    try {
      if (page.url() === 'about:blank') {
        await page.goto(runnable[0].url, { waitUntil: 'domcontentloaded' });
        await this.settleInitial(page);
      }
      const auth = await prepareAuth(page, steps, log);
      await this.saveSession();
      const notes = auth === 'already-signed-in' ? [] : [`sign-in: ${auth}`];
      this.lastDigest = await digestOf(page);

      for (const step of steps) {
        if (step.skip) {
          results.push(skipped(step));
          continue;
        }
        const r = await this.runStep(page, step, rec, opts);
        results.push(r);
        this.results.set(step.seq, r);
        log(`step ${step.seq} ${r.status} ${r.label}`);
        if (BAD.has(r.status) && !(r.status === 'diverged' && opts.continueOnDiverge)) {
          return {
            ok: false,
            results,
            summary: renderSummary(steps, results, notes),
            problem: renderStep(step, r),
          };
        }
      }
      return { ok: true, results, summary: renderSummary(steps, results, notes) };
    } finally {
      await undoSlow?.();
    }
  }

  private async settleInitial(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  }

  private async runStep(page: Page, step: Step, rec: LoadedRecording, opts: RunOptions): Promise<StepResult> {
    const factor = opts.slow ? Math.max(2, opts.slow[1] / 2000) : 1;
    const limit = stepLimitMs(step, factor);
    const startedAt = Date.now();
    const before = this.lastDigest;
    const notes: string[] = [];
    const hasRecordedWrites = step.expect.calls.some((c) => !c.endpoint.startsWith('GET '));

    let acted = false;
    for (let attempt = 0; attempt < 2 && !acted; attempt++) {
      try {
        const found = step.locator !== undefined || step.candidates.length ? await findLocator(page, step, Math.min(limit, 20_000)) : null;
        if (needsTarget(step) && !found) {
          const down = this.observer.all.filter((t) => t.resourceType === 'document' && (t.status ?? 0) >= 500).at(-1);
          const why = down
            ? `the page itself failed to load: ${down.method} ${new URL(down.url).pathname} → ${down.status} (the app/server, not the replay)`
            : '';
          if (why) return finish(step, 'unlocatable', startedAt, [why], [], '', undefined, []);
          return finish(step, 'unlocatable', startedAt, [`no element matched any of ${step.candidates.length} selectors${step.name ? ` or the name "${step.name}"` : ''}`], [], '', undefined, []);
        }
        if (found?.repaired) notes.push(`located by ${found.via} (recorded locator did not match)`);
        await act(page, step, found?.locator, limit);
        acted = true;
      } catch (e) {
        const pendingWrite = unansweredWrites(this.observer.since(startedAt, rec.background)).length > 0;
        const retriable = attempt === 0 && !hasRecordedWrites && !pendingWrite;
        if (!retriable) {
          return finish(step, 'failed', startedAt, [`${(e as Error).message.split('\n')[0]}`], this.observer.since(startedAt, rec.background), page.url(), undefined, []);
        }
        notes.push('retried once after a transient error');
        await page.waitForTimeout(500);
      }
    }

    const settled = await settle(page, this.observer, step, startedAt, rec.background, limit);
    const calls = this.observer.since(startedAt, rec.background);
    const verdict = compareStep({
      step,
      calls,
      route: routeOf(page),
      seenToasts: settled.seenToasts,
      ms: settled.waitedMs,
      timedOut: settled.timedOut,
    });
    let status = verdict.status;
    const allNotes = [...notes, ...verdict.notes];

    let writeUnknown = false;
    const unanswered = unansweredWrites(calls);
    if (unanswered.length) {
      writeUnknown = true;
      for (const w of unanswered) {
        const v = opts.verifier ? await opts.verifier.check(w) : 'unknown';
        allNotes.push(`${w.endpoint} had no answer; verifier says: ${v}`);
        if (v === 'landed' && status === 'timeout') status = 'slow';
        else if (v !== 'landed') status = 'timeout';
      }
      if (status === 'slow') writeUnknown = false;
    }

    this.lastDigest = settled.digest ?? this.lastDigest;
    const ui = await uiDiff(page, before, settled.digest);
    const r = finish(step, status, startedAt, allNotes, calls, routeOf(page), settled.digest, ui);
    r.writeUnknown = writeUnknown;
    return r;
  }
}

async function uiDiff(page: Page, before: UIDigest | undefined, after: UIDigest | undefined): Promise<string[]> {
  if (!after) return [];
  try {
    const raw = await page.evaluate(
      ([b, a]) => (window as unknown as { __rrDiff: (x: unknown, y: unknown) => string[] }).__rrDiff(b, a),
      [before, after] as const,
    );
    return collapseUi(raw);
  } catch {
    return [];
  }
}

const needsTarget = (s: Step) => ['click', 'dblclick', 'input', 'select', 'toggle'].includes(s.type);
const routeOf = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};

function skipped(step: Step): StepResult {
  return { seq: step.seq, label: step.label, status: 'skipped', route: step.route, ms: 0, recordedMs: 0, calls: [], notes: [step.skip ?? ''], uiDiff: [] };
}

function finish(
  step: Step,
  status: StepResult['status'],
  startedAt: number,
  notes: string[],
  calls: ReturnType<Observer['since']>,
  route: string,
  digest: UIDigest | undefined,
  ui: string[],
): StepResult {
  return {
    seq: step.seq,
    label: step.label,
    status,
    route: route ? templateRoute(route) : step.route,
    ms: Date.now() - startedAt,
    recordedMs: step.expect.recordedMs,
    calls: calls.map(({ endpoint, method, url, status: st, failed, ms, pending }) => ({ endpoint, method, url, status: st, failed, ms, pending })),
    notes,
    uiDiff: ui,
    digestHash: digest?.digestHash,
  };
}

async function act(page: Page, step: Step, target: import('playwright').Locator | undefined, limit: number): Promise<void> {
  const timeout = Math.min(limit, 30_000);
  const value = resolveValue(step.value);
  switch (step.type) {
    case 'click':
    case 'toggle':
      await target!.click({ timeout });
      return;
    case 'dblclick':
      await target!.dblclick({ timeout });
      return;
    case 'input':
      await target!.fill(value ?? '', { timeout });
      return;
    case 'select':
      await target!.selectOption(value ?? '', { timeout });
      return;
    case 'key':
      await page.keyboard.press(value ?? 'Enter');
      return;
    case 'navigate':
    case 'redirect':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout });
      return;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      return;
    case 'back':
      await page.goBack({ timeout });
      return;
    case 'forward':
      await page.goForward({ timeout });
      return;
    default:
      throw new Error(`step type "${step.type}" cannot be replayed`);
  }
}
