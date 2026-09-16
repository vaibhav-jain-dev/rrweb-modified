/**
 * Action-to-network attribution. Runs against an already-finished
 * timeline (used both by the background script at export time and by
 * tests) rather than live event-by-event, which keeps it a pure function
 * and easy to reason about for the tricky cases: no requests, many
 * requests, overlapping actions, delayed completion, background traffic.
 */
import type { ActionRecord, NetworkRequest } from './types';

export const PRE_ROLL_MS = 120;
export const POLL_MIN_REPEATS = 4;
export const POLL_INTERVAL_TOLERANCE_MS = 500;

export type ActionWindow = {
  actionSeq: number;
  start: number;
  end: number;
};

/**
 * Build one window per action: [action.t - PRE_ROLL_MS, settleTime]. The
 * caller supplies settle times (computed by settle.ts in the background
 * script); actions with no known settle time get a window that extends to
 * the next action's start (or to `sessionEnd`), so nothing is silently
 * unattributed just because settle detection hadn't run for it yet.
 */
export function buildActionWindows(
  actions: ActionRecord[],
  settleTimes: Map<number, number>,
  sessionEnd: number,
): ActionWindow[] {
  const sorted = [...actions].sort((a, b) => a.t - b.t);
  return sorted.map((action, i) => {
    const nextStart = sorted[i + 1]?.t ?? sessionEnd;
    const end = settleTimes.get(action.seq) ?? nextStart;
    return { actionSeq: action.seq, start: action.t - PRE_ROLL_MS, end };
  });
}

function overlappingWindows(t: number, windows: ActionWindow[]): ActionWindow[] {
  return windows.filter((w) => t >= w.start && t <= w.end);
}

/**
 * Attribute each request to a window. Ambiguous cases (two windows open at
 * once) resolve to the innermost (most recently started) window, matching
 * the common case of a fast double-click or rapid successive actions, and
 * are flagged `ambiguous: true` so a consumer can treat the attribution as
 * soft. Requests outside every window are left unattributed (background
 * traffic).
 */
export function attributeRequests(
  requests: NetworkRequest[],
  windows: ActionWindow[],
): NetworkRequest[] {
  return requests.map((req) => {
    const matches = overlappingWindows(req.startTime, windows);
    if (matches.length === 0) return req;
    const innermost = matches.reduce((a, b) => (b.start > a.start ? b : a));
    const completedAfterSettle =
      req.endTime !== undefined && req.endTime > innermost.end;
    return {
      ...req,
      actionSeq: innermost.actionSeq,
      ambiguous: matches.length > 1,
      completedAfterSettle,
    };
  });
}

/**
 * Detect background polling: the same URL (ignoring volatile query params
 * isn't attempted here - exact URL match only, to stay conservative)
 * repeating at a roughly stable interval, unattributed to any action.
 * Collapsed into one summary entry rather than N near-duplicate rows.
 */
export type PollingGroup = {
  url: string;
  count: number;
  intervalMs: number;
  firstStart: number;
  lastStart: number;
};

export function detectPolling(requests: NetworkRequest[]): PollingGroup[] {
  const unattributed = requests.filter((r) => r.actionSeq === undefined);
  const byUrl = new Map<string, NetworkRequest[]>();
  for (const req of unattributed) {
    const list = byUrl.get(req.url) ?? [];
    list.push(req);
    byUrl.set(req.url, list);
  }
  const groups: PollingGroup[] = [];
  for (const [url, reqs] of byUrl) {
    if (reqs.length < POLL_MIN_REPEATS) continue;
    const sorted = [...reqs].sort((a, b) => a.startTime - b.startTime);
    const intervals = sorted.slice(1).map((r, i) => r.startTime - sorted[i].startTime);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const stable = intervals.every((i) => Math.abs(i - avg) <= POLL_INTERVAL_TOLERANCE_MS);
    if (!stable) continue;
    groups.push({
      url,
      count: sorted.length,
      intervalMs: Math.round(avg),
      firstStart: sorted[0].startTime,
      lastStart: sorted[sorted.length - 1].startTime,
    });
  }
  return groups;
}

/** Requests genuinely unattributed and not part of a detected polling group. */
export function backgroundRequests(
  requests: NetworkRequest[],
  pollingUrls: Set<string>,
): NetworkRequest[] {
  return requests.filter((r) => r.actionSeq === undefined && !pollingUrls.has(r.url));
}
