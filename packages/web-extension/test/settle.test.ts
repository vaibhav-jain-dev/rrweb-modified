import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSettleTracker } from '~/background/settle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createSettleTracker', () => {
  it('settles after quietMs with no activity and no in-flight requests', async () => {
    const tracker = createSettleTracker({ quietMs: 400, minWaitMs: 100, pollMs: 50 });
    const start = Date.now();
    const promise = tracker.waitForSettle(start);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.timedOut).toBe(false);
    tracker.dispose();
  });

  it('does not settle while a request is still in flight, even if quiet otherwise', async () => {
    const tracker = createSettleTracker({ quietMs: 200, minWaitMs: 50, maxWaitMs: 1000, pollMs: 50 });
    const start = Date.now();
    tracker.noteRequestStart();
    const promise = tracker.waitForSettle(start);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    // never settled quietly - hit the max-wait bound instead
    expect(result.timedOut).toBe(true);
    tracker.dispose();
  });

  it('settles once the in-flight request ends and quiet period passes', async () => {
    const tracker = createSettleTracker({ quietMs: 200, minWaitMs: 50, maxWaitMs: 5000, pollMs: 50 });
    const start = Date.now();
    tracker.noteRequestStart();
    const promise = tracker.waitForSettle(start);
    await vi.advanceTimersByTimeAsync(300);
    tracker.noteRequestEnd();
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;
    expect(result.timedOut).toBe(false);
    tracker.dispose();
  });

  it('respects minWaitMs even if quiet immediately', async () => {
    const tracker = createSettleTracker({ quietMs: 50, minWaitMs: 500, maxWaitMs: 2000, pollMs: 25 });
    const start = Date.now();
    const promise = tracker.waitForSettle(start);
    await vi.advanceTimersByTimeAsync(200);
    // still pending - hasn't reached minWaitMs yet
    let resolved = false;
    void promise.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.settledAt - start).toBeGreaterThanOrEqual(500);
    tracker.dispose();
  });

  it('settles anyway past maxWaitMs, flagged timedOut, if activity never stops', async () => {
    const tracker = createSettleTracker({ quietMs: 300, minWaitMs: 50, maxWaitMs: 1000, pollMs: 50 });
    const start = Date.now();
    const promise = tracker.waitForSettle(start);
    // keep noting mutations so it never goes quiet on its own
    const keepBusy = setInterval(() => tracker.noteMutation(), 100);
    await vi.advanceTimersByTimeAsync(1100);
    clearInterval(keepBusy);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    tracker.dispose();
  });

  it('a new waitForSettle call resolves the stale in-flight wait immediately', async () => {
    const tracker = createSettleTracker({ quietMs: 400, minWaitMs: 50, maxWaitMs: 5000, pollMs: 50 });
    const start1 = Date.now();
    const first = tracker.waitForSettle(start1);
    await vi.advanceTimersByTimeAsync(100);
    const second = tracker.waitForSettle(Date.now());
    const firstResult = await first;
    expect(firstResult.timedOut).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await second;
    tracker.dispose();
  });
});
