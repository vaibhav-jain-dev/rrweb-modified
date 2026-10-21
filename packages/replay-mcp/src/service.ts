/** The five operations, independent of how they are called (MCP or CLI). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyPatch } from './patch.ts';
import type { Patch } from './patch.ts';
import { loadRecording, stepList } from './recording.ts';
import type { LoadedRecording } from './recording.ts';
import { renderStep } from './report.ts';
import { ReplaySession } from './runner.ts';
import { listSavedRuns, loadSavedRun, saveRun } from './saved-runs.ts';
import type { SlowRange } from './slow.ts';
import { httpVerifier } from './writes.ts';

export class Service {
  private session = new ReplaySession();
  private rec?: LoadedRecording;

  load(zip: string): string {
    this.rec = loadRecording(resolve(zip));
    const saved = listSavedRuns(this.rec.path);
    return [
      `${this.rec.name} · ${this.rec.steps.length} steps · page ${this.rec.pageOrigin} · api ${this.rec.apiOrigins.join(', ') || '-'}`,
      '(· = skipped by default; password steps use $secret.PASSWORD)',
      stepList(this.rec),
      saved.length ? `saved runs: ${saved.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async run(args: { patch?: Patch; reuse?: string; save?: string; slow?: SlowRange; continueOnDiverge?: boolean; log?: (m: string) => void }): Promise<string> {
    const rec = this.need();
    const patch = args.reuse ? loadSavedRun(rec.path, args.reuse) : args.patch;
    const steps = applyPatch(rec.steps, patch);
    const verifyUrl = process.env.REPLAY_VERIFY_URL;
    this.session.watcher.pause();
    let out: Awaited<ReturnType<ReplaySession['run']>>;
    try {
      out = await this.session.run({
        steps,
        rec,
        slow: args.slow,
        continueOnDiverge: args.continueOnDiverge,
        verifier: verifyUrl ? httpVerifier(verifyUrl) : undefined,
        log: args.log,
      });
    } finally {
      await this.session.watcher.resume(this.session.page);
    }
    const dir = join(process.env.REPLAY_OUT_DIR ?? join(rec.path, '..', `${rec.name.replace(/\.zip$/, '')}.runs`), 'last');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ patch, results: out.results }, null, 2));
    const extra: string[] = [];
    if (out.ok && (args.save || (patch && !args.reuse))) {
      const id = saveRun(rec.path, args.save, patch);
      extra.push(`saved as run "${id}" (rerun with reuse: "${id}")`);
    }
    return [out.summary, out.problem ?? '', ...extra].filter(Boolean).join('\n\n');
  }

  inspect(args: { step?: number; request?: number }): Promise<string> | string {
    const rec = this.need();
    if (args.step === undefined) return stepList(rec);
    const step = this.session.steps.find((s) => s.seq === args.step) ?? rec.steps.find((s) => s.seq === args.step);
    if (!step) return `no step ${args.step}`;
    const r = this.session.results.get(step.seq);
    const recorded = rec.network.filter((n) => n.actionSeq === step.seq && n.tier !== 'noise' && n.method !== 'OPTIONS');
    if (args.request !== undefined) {
      const req = recorded[args.request];
      if (!req) return `step ${step.seq} has ${recorded.length} recorded requests (0-based)`;
      return JSON.stringify({ method: req.method, url: req.url, status: req.status, ms: req.duration, requestBody: req.requestBody, responseBody: req.responseBody }, null, 2).slice(0, 6000);
    }
    const head = r ? renderStep(step, r) : `STEP ${step.seq} · ${step.route} · ${step.label}  [not run yet]`;
    const reqs = recorded.map((q, i) => `  [${i}] ${q.method} ${new URL(q.url).pathname} → ${q.status ?? 'FAILED'} (${Math.round(q.duration ?? 0)}ms)`);
    return [head, reqs.length ? `RECORDED REQUESTS (inspect request: n for bodies)\n${reqs.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  /** The live page as the recorder's digest saw it: no screenshot needed. */
  async pageState(): Promise<string> {
    const page = this.session.page;
    if (!page) return 'no browser open yet; call run first';
    const d = await (await import('./wait.ts')).digestOf(page);
    if (!d) return `${page.url()} (page is navigating)`;
    const controls = d.controls.filter((c) => c.state === 'visible-usable').slice(0, 25).map((c) => `  ${c.role}${c.name ? ` "${c.name.slice(0, 40)}"` : ''}${c.value ? ` = ${c.value.slice(0, 30)}` : ''}`);
    return [
      `${d.route} · ${d.title}`,
      d.headings.length ? `headings: ${d.headings.slice(0, 6).join(' | ')}` : '',
      d.status.length ? `messages: ${d.status.map((s) => s.text.slice(0, 60)).join(' | ')}` : '',
      `controls (${controls.length} shown):`,
      ...controls,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async screenshot(): Promise<{ data: string; mimeType: string } | string> {
    const page = this.session.page;
    if (!page) return 'no browser open yet; call run first';
    const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
    return { data: buf.toString('base64'), mimeType: 'image/jpeg' };
  }

  /** What you did in the browser (and what the page did) since the last time this was asked. */
  async changes(): Promise<string> {
    const page = this.session.page;
    if (!page || page.isClosed()) return 'no browser open; call run first';
    return this.session.watcher.report(page, this.session.observer);
  }

  /** Is the browser open, and where. */
  state(): string {
    const page = this.session.page;
    return page && !page.isClosed() ? `browser open at ${page.url()}` : 'browser closed';
  }

  waitUntilClosed(): Promise<void> {
    return this.session.waitUntilClosed();
  }

  close(): Promise<void> {
    return this.session.close();
  }

  private need(): LoadedRecording {
    if (!this.rec) throw new Error('call load_recording first');
    return this.rec;
  }
}
