/**
 * Decide whether a replayed step did what the recorded one did. Code decides;
 * the model is told only when something differs.
 */
import { templateRoute } from '../../web-extension/src/evidence/route-template.ts';
import type { ObservedCall, Step, StepStatus } from './types.ts';

const isOk = (s: number | undefined) => s !== undefined && s >= 200 && s < 400;

export type Verdict = { status: StepStatus; notes: string[] };

export function compareStep(args: {
  step: Step;
  calls: ObservedCall[];
  route: string;
  seenToasts: Set<string>;
  ms: number;
  timedOut: boolean;
}): Verdict {
  const { step, calls, route, seenToasts, ms, timedOut } = args;
  const notes: string[] = [];
  let status: StepStatus = 'ok';
  const worsen = (to: StepStatus) => {
    const rank: Record<string, number> = { ok: 0, slow: 1, diverged: 2, failed: 3, timeout: 4 };
    if ((rank[to] ?? 0) > (rank[status] ?? 0)) status = to;
  };

  for (const want of step.expect.calls) {
    const got = calls.filter((c) => c.endpoint === want.endpoint && !c.pending);
    if (got.length === 0) {
      // A GET is often a prefetch or a cache hit; a write that did not happen is the real divergence.
      if (want.endpoint.startsWith('GET ')) {
        notes.push(`not seen: ${want.endpoint}`);
      } else {
        notes.push(`missing call ${want.endpoint} (recorded ${want.status})`);
        worsen(timedOut ? 'timeout' : 'diverged');
      }
      continue;
    }
    const last = got[got.length - 1];
    if (last.failed) {
      notes.push(`${want.endpoint} failed at the network (recorded ${want.status})`);
      worsen('failed');
    } else if (isOk(want.status) && !isOk(last.status)) {
      notes.push(`${want.endpoint} → ${last.status} (recorded ${want.status})`);
      worsen((last.status ?? 0) >= 500 ? 'failed' : 'diverged');
    } else if (!isOk(want.status) && isOk(last.status)) {
      notes.push(`${want.endpoint} → ${last.status} (recorded ${want.status}, which was an error)`);
    }
  }

  const expected = new Set(step.expect.calls.map((c) => c.endpoint));
  for (const c of calls) {
    if (expected.has(c.endpoint) || c.pending) continue;
    if (c.failed || (c.status ?? 0) >= 500) {
      notes.push(`unexpected ${c.endpoint} → ${c.failed ? 'network failure' : c.status}`);
      worsen('failed');
    } else if ((c.status ?? 0) >= 400) {
      notes.push(`unexpected ${c.endpoint} → ${c.status}`);
      worsen('diverged');
    }
  }

  if (step.expect.route && templateRoute(route) !== step.expect.route) {
    notes.push(`route is ${templateRoute(route)}, recorded ${step.expect.route}`);
    worsen('diverged');
  }
  for (const toast of step.expect.toasts) {
    if (!seenToasts.has(toast.toLowerCase())) {
      notes.push(`expected message not shown: "${toast.slice(0, 80)}"`);
      worsen(timedOut ? 'timeout' : 'diverged');
    }
  }
  if (timedOut && status === 'ok') {
    notes.push('page did not settle in time');
    worsen('timeout');
  }
  if (status === 'ok' && ms > Math.max(3000, 2 * step.expect.recordedMs)) {
    notes.push(`slow: ${(ms / 1000).toFixed(1)}s (recorded ${(step.expect.recordedMs / 1000).toFixed(1)}s)`);
    status = 'slow';
  }
  return { status, notes };
}
