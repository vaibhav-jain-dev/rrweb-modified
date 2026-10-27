/**
 * The agent's narrative (`agent/log.txt`), rendered from the ledger. It is
 * derived, never accumulated chat: every line is a check, an anomaly or a
 * model observation, in time order, so it can always be regenerated and
 * never says more than the ledger can back up.
 */
import type { Check, Ledger, LaneLedger } from './protocol';

export function formatT(ms: number | undefined): string {
  if (ms === undefined) return '--:--.-';
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export const STATUS_MARK: Record<Check['status'], string> = {
  verified: 'OK  ',
  failed: 'FAIL',
  unchecked: 'SKIP',
  never_seen: 'MISS',
  observed: '... ',
  pending: '... ',
};

function laneSummary(l: LaneLedger): string {
  const v = l.verdict;
  const parts = [`${v.verified} verified`];
  if (v.failed) parts.push(`${v.failed} failed`);
  if (v.never_seen) parts.push(`${v.never_seen} never seen`);
  if (v.unchecked) parts.push(`${v.unchecked} could not be checked`);
  if (v.observed || v.pending)
    parts.push(`${v.observed + v.pending} unfinished`);
  return parts.join(' · ');
}

export function renderAgentLog(ledger: Ledger): string {
  const out: string[] = [];
  out.push(`Agent log for session ${ledger.sessionId}`);
  out.push(
    `Started ${new Date(ledger.startedAt).toISOString()}${
      ledger.model ? `  model: ${ledger.model}` : '  model: none'
    }`,
  );
  if (ledger.incomplete)
    out.push(
      'NOTE: the agent backend was lost during this session; this log is incomplete.',
    );
  out.push(
    'Times are mm:ss.s from the start of the recording. Statuses are set by code from database/API results; lines marked (model) are unverified.',
  );

  for (const lane of ledger.lanes) {
    out.push(
      '',
      `== ${lane.title} (${lane.playbookId}) ==`,
      `   ${laneSummary(lane)}`,
    );
    if (lane.gateReadyAt !== undefined)
      out.push(`   all steps verified at ${formatT(lane.gateReadyAt)}`);

    type Line = { t: number; text: string };
    const lines: Line[] = [];
    for (const c of lane.checks) {
      const when = c.tResolved ?? c.tObserved ?? 0;
      const origin = c.origin === 'ask' ? ` [asked: "${c.askText}"]` : '';
      const lag =
        c.tObserved !== undefined &&
        c.tResolved !== undefined &&
        c.tResolved > c.tObserved
          ? ` (+${c.tResolved - c.tObserved} ms after the call)`
          : '';
      lines.push({
        t: when,
        text: `${STATUS_MARK[c.status]} ${c.claim}${origin} — ${
          c.note ?? c.status
        }${lag}`,
      });
      for (const w of c.warnings ?? [])
        lines.push({ t: when, text: `     warning: ${w}` });
    }
    for (const a of lane.anomalies)
      lines.push({ t: a.t, text: `NOTE ${a.text}` });
    for (const o of lane.observations)
      lines.push({ t: o.t, text: `(model) ${o.text}` });
    lines.sort((a, b) => a.t - b.t);
    for (const l of lines) out.push(`${formatT(l.t)}  ${l.text}`);

    const uncovered = Object.entries(lane.uncovered);
    if (uncovered.length) {
      out.push(
        '',
        '   Writes with no verifier (not checked against the database):',
      );
      for (const [endpoint, n] of uncovered) out.push(`     ${endpoint} ×${n}`);
    }
    const bad = lane.checks.filter(
      (c) => c.status === 'failed' || c.status === 'never_seen',
    );
    if (bad.length) {
      out.push('', '   Look first:');
      for (const c of bad) out.push(`     ${c.id}: ${c.note ?? c.status}`);
    }
  }
  return out.join('\n') + '\n';
}
