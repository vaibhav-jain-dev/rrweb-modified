/**
 * State-settled detection: after an action, wait for network + DOM
 * mutation quiet before capturing the "resulting" UI digest/screenshot/AX
 * summary - so those are captured once, at a meaningful point, rather
 * than on every intermediate render.
 *
 * Model: user action \> network/UI activity \> wait for quiet \> capture.
 * Settle fires when there has been no new network request start and no
 * rrweb mutation event for `quietMs`, with zero requests still in flight,
 * bounded by [minWaitMs, maxWaitMs] (settling anyway past maxWaitMs, with
 * `timedOut: true` so callers know the capture may be premature).
 */

export type SettleOptions = {
  quietMs?: number;
  minWaitMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
};

const DEFAULTS: Required<SettleOptions> = {
  quietMs: 400,
  minWaitMs: 150,
  maxWaitMs: 6000,
  pollMs: 50,
};

export type SettleTracker = {
  /** Call whenever a network request starts. */
  noteNetworkActivity(): void;
  /** Call whenever an rrweb mutation-shaped event arrives. */
  noteMutation(): void;
  /** Call when a request starts/finishes, to track in-flight count. */
  noteRequestStart(): void;
  noteRequestEnd(): void;
  /**
   * Begin waiting for settle for one action. Resolves with the settle
   * timestamp and whether it hit the max-wait bound instead of genuinely
   * quieting down. Only one wait can be in flight; starting a new one
   * before the previous resolves cancels the previous one's timer (its
   * promise still resolves, at the moment of cancellation).
   */
  waitForSettle(actionStart: number): Promise<{ settledAt: number; timedOut: boolean }>;
  dispose(): void;
};

export function createSettleTracker(options: SettleOptions = {}): SettleTracker {
  const opts = { ...DEFAULTS, ...options };
  // Initialized to "now" (tracker creation time), not 0/epoch: a sentinel
  // of 0 would make `now - lastMutationAt` enormous - and therefore
  // trivially "quiet" - for any poll tick before the very first activity
  // is ever noted, letting a settle resolve before activity that starts
  // a little late (e.g. a request whose requestWillBeSent lands 80ms in)
  // has a chance to be seen at all.
  let lastNetworkActivityAt = Date.now();
  let lastMutationAt = Date.now();
  let inFlight = 0;
  let currentPoll: ReturnType<typeof setInterval> | undefined;
  let currentResolve: ((v: { settledAt: number; timedOut: boolean }) => void) | undefined;

  function clearCurrent() {
    if (currentPoll !== undefined) clearInterval(currentPoll);
    currentPoll = undefined;
    currentResolve = undefined;
  }

  return {
    noteNetworkActivity() {
      lastNetworkActivityAt = Date.now();
    },
    noteMutation() {
      lastMutationAt = Date.now();
    },
    noteRequestStart() {
      inFlight += 1;
      lastNetworkActivityAt = Date.now();
    },
    noteRequestEnd() {
      inFlight = Math.max(0, inFlight - 1);
    },
    waitForSettle(actionStart: number) {
      // A new action window supersedes any in-progress wait; resolve the
      // stale one immediately at "now" rather than leaving it dangling.
      if (currentResolve) {
        const resolve = currentResolve;
        clearCurrent();
        resolve({ settledAt: Date.now(), timedOut: true });
      }
      return new Promise<{ settledAt: number; timedOut: boolean }>((resolve) => {
        currentResolve = resolve;
        currentPoll = setInterval(() => {
          const now = Date.now();
          const elapsed = now - actionStart;
          const quiet =
            now - lastNetworkActivityAt >= opts.quietMs &&
            now - lastMutationAt >= opts.quietMs &&
            inFlight === 0;
          if (elapsed >= opts.minWaitMs && quiet) {
            clearCurrent();
            resolve({ settledAt: now, timedOut: false });
            return;
          }
          if (elapsed >= opts.maxWaitMs) {
            clearCurrent();
            resolve({ settledAt: now, timedOut: true });
          }
        }, opts.pollMs);
      });
    },
    dispose() {
      clearCurrent();
    },
  };
}
