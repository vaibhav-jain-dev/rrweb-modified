/**
 * Wait the way the recording says the app behaves, not for a fixed time:
 * until the calls the step produced when it was recorded have finished, no
 * other relevant call is in flight, the expected toast has been seen, and the
 * page has stopped changing. Polling and telemetry are never waited on.
 */
import type { Page } from 'playwright';
import type { UIDigest } from '../../web-extension/src/evidence/types.ts';
import type { Observer, Tracked } from './observe.ts';
import type { Step } from './types.ts';

const QUIET_MS = 300;
const POLL_MS = 120;
const FLOOR_MS = 10_000;
const CAP_MS = 60_000;

/** max(10s, 5× the slowest recorded call + 2s), capped at 60s, stretched by `factor` in slow mode. */
export function stepLimitMs(step: Step, factor = 1): number {
  const base = Math.max(FLOOR_MS, 5 * step.expect.recordedMs + 2000);
  return Math.min(CAP_MS * factor, base * factor);
}

export async function digestOf(page: Page): Promise<UIDigest | undefined> {
  try {
    return (await page.evaluate(() => {
      const w = window as unknown as { __rrDigest?: (route: string) => unknown };
      return w.__rrDigest?.(location.pathname + location.search);
    })) as UIDigest | undefined;
  } catch {
    return undefined; // mid-navigation
  }
}

export type Settled = {
  timedOut: boolean;
  pending: Tracked[];
  digest?: UIDigest;
  seenToasts: Set<string>;
  waitedMs: number;
};

export async function settle(
  page: Page,
  obs: Observer,
  step: Step,
  startedAt: number,
  background: Set<string>,
  limitMs: number,
): Promise<Settled> {
  const wantedByEndpoint = new Map<string, number>();
  for (const c of step.expect.calls.filter((x) => !x.endpoint.startsWith('GET '))) wantedByEndpoint.set(c.endpoint, (wantedByEndpoint.get(c.endpoint) ?? 0) + 1);
  const wantedToasts = step.expect.toasts.map((t) => t.toLowerCase());
  const seenToasts = new Set<string>();

  let lastHash: string | undefined;
  let stableSince = Date.now();
  let digest: UIDigest | undefined;
  const deadline = startedAt + limitMs;

  for (;;) {
    const calls = obs.since(startedAt, background);
    const pending = calls.filter((c) => c.pending);
    const metCalls = [...wantedByEndpoint].every(
      ([endpoint, n]) => calls.filter((c) => c.endpoint === endpoint && !c.pending).length >= n,
    );

    digest = (await digestOf(page)) ?? digest;
    if (digest) {
      const hay = [...digest.status.map((s) => s.text), ...digest.textAtoms].map((t) => t.toLowerCase());
      for (const w of wantedToasts) if (hay.some((h) => h.includes(w))) seenToasts.add(w);
    }
    const hash = digest?.digestHash;
    if (hash !== lastHash) {
      lastHash = hash;
      stableSince = Date.now();
    }
    const stable = Date.now() - stableSince >= QUIET_MS;
    const toastsOk = wantedToasts.every((w) => seenToasts.has(w));
    // The success message of a call that failed will never come; do not wait out the limit for it.
    const errored = calls.some((c) => !c.pending && (c.failed || (c.status ?? 0) >= 400) && wantedByEndpoint.has(c.endpoint));

    if (metCalls && pending.length === 0 && stable && (toastsOk || errored)) {
      return { timedOut: false, pending: [], digest, seenToasts, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() >= deadline) {
      return { timedOut: true, pending, digest, seenToasts, waitedMs: Date.now() - startedAt };
    }
    await page.waitForTimeout(POLL_MS);
  }
}
