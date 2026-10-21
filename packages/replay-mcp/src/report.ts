import type { Step, StepResult } from './types.ts';

const MAX_UI_LINES = 6;

/** The recorder's UI diff lists every repeated row group; collapse repeats. */
export function collapseUi(raw: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of raw) counts.set(line, (counts.get(line) ?? 0) + 1);
  const lines = [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
  return lines.length > MAX_UI_LINES
    ? [...lines.slice(0, MAX_UI_LINES), `… and ${lines.length - MAX_UI_LINES} more changes`]
    : lines;
}

function recordedLines(step: Step): string[] {
  const lines = step.expect.calls.map((c) => `${c.endpoint} → ${c.status || 'FAILED'} (${c.ms}ms)`);
  if (step.expect.route) lines.push(`route ${step.expect.route}`);
  for (const t of step.expect.toasts) lines.push(`message "${t.slice(0, 80)}"`);
  return lines;
}

/** One step, in the shape of a flow.md ACTION block, with recorded vs actual. */
export function renderStep(step: Step, r: StepResult): string {
  const out = [`STEP ${r.seq} · ${r.route} · ${r.label}  [${r.status.toUpperCase()} · ${(r.ms / 1000).toFixed(1)}s]`];
  const rec = recordedLines(step);
  if (rec.length) out.push('RECORDED', ...rec.map((l) => `  ${l}`));
  out.push('ACTUAL');
  if (r.calls.length === 0) out.push('  (no network activity)');
  for (const c of r.calls.slice(0, 8)) {
    out.push(`  ${c.endpoint} → ${c.pending ? 'PENDING' : c.failed ? 'FAILED' : c.status} (${c.ms ?? '?'}ms)`);
  }
  if (r.calls.length > 8) out.push(`  … and ${r.calls.length - 8} more`);
  if (r.uiDiff.length) out.push('UI', ...r.uiDiff.map((l) => `  - ${l}`));
  if (r.notes.length) out.push('WHY', ...r.notes.map((l) => `  - ${l}`));
  if (r.writeUnknown) out.push('WRITE  a write got no answer; it was NOT repeated. Check whether it landed before re-running this step.');
  return out.join('\n');
}

export function renderSummary(steps: Step[], results: StepResult[], extra: string[] = []): string {
  const ran = results.filter((r) => r.status !== 'skipped');
  const slow = ran.filter((r) => r.status === 'slow').length;
  const bad = ran.find((r) => !['ok', 'slow'].includes(r.status));
  const head = bad
    ? `STOPPED at step ${bad.seq} (${bad.status}) · ${ran.length - 1} ok before it · ${steps.length - results.length} not run`
    : `ok · ${ran.length} steps ran · ${results.length - ran.length} skipped · ${slow} slow`;
  return [head, ...extra].join('\n');
}
