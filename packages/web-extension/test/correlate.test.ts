import { describe, expect, it } from 'vitest';
import {
  attributeRequests,
  buildActionWindows,
  backgroundRequests,
  detectPolling,
} from '~/evidence/correlate';
import type { ActionRecord, NetworkRequest } from '~/evidence/types';

function action(seq: number, t: number): ActionRecord {
  return {
    seq,
    t,
    type: 'click',
    page: { url: 'https://x.test/', route: '/', title: '', tabId: 1, frameId: 0 },
  };
}

function req(url: string, startTime: number, endTime?: number): NetworkRequest {
  return { requestId: `${url}-${startTime}`, method: 'GET', url, startTime, endTime, status: 200 };
}

describe('buildActionWindows + attributeRequests', () => {
  it('one action, no network: the action still exists with no attributed requests', () => {
    const actions = [action(1, 1000)];
    const windows = buildActionWindows(actions, new Map([[1, 1400]]), 2000);
    const result = attributeRequests([], windows);
    expect(result).toEqual([]);
  });

  it('one action, many requests: all attributed to the same action', () => {
    const actions = [action(1, 1000)];
    const windows = buildActionWindows(actions, new Map([[1, 1500]]), 2000);
    const requests = [req('/a', 1010), req('/b', 1200), req('/c', 1400)];
    const result = attributeRequests(requests, windows);
    expect(result.every((r) => r.actionSeq === 1)).toBe(true);
  });

  it('a request fired slightly before the action event surfaces is still caught (pre-roll)', () => {
    const actions = [action(1, 1000)];
    const windows = buildActionWindows(actions, new Map([[1, 1500]]), 2000);
    const requests = [req('/a', 900)]; // 100ms before, within the 120ms pre-roll
    const result = attributeRequests(requests, windows);
    expect(result[0].actionSeq).toBe(1);
  });

  it('multiple fast actions: overlapping windows resolve to the innermost, flagged ambiguous', () => {
    const actions = [action(1, 1000), action(2, 1050)];
    const windows = buildActionWindows(actions, new Map([[1, 1600], [2, 1600]]), 2000);
    const requests = [req('/a', 1080)]; // inside both windows
    const result = attributeRequests(requests, windows);
    expect(result[0].actionSeq).toBe(2); // action 2 started later -> innermost
    expect(result[0].ambiguous).toBe(true);
  });

  it('a request that completes after settle is flagged completedAfterSettle with the true duration', () => {
    const actions = [action(1, 1000)];
    const windows = buildActionWindows(actions, new Map([[1, 1400]]), 5000);
    const requests = [req('/slow', 1050, 4000)];
    const result = attributeRequests(requests, windows);
    expect(result[0].actionSeq).toBe(1);
    expect(result[0].completedAfterSettle).toBe(true);
    expect(result[0].endTime).toBe(4000);
  });

  it('background traffic unrelated to any action window stays unattributed', () => {
    const actions = [action(1, 1000)];
    const windows = buildActionWindows(actions, new Map([[1, 1200]]), 5000);
    const requests = [req('/unrelated', 3000)];
    const result = attributeRequests(requests, windows);
    expect(result[0].actionSeq).toBeUndefined();
  });

  it('an action with no known settle time still gets a window up to the next action', () => {
    const actions = [action(1, 1000), action(2, 2000)];
    const windows = buildActionWindows(actions, new Map(), 5000);
    expect(windows[0].end).toBe(2000);
    expect(windows[1].end).toBe(5000);
  });
});

describe('detectPolling', () => {
  it('collapses repeated unattributed requests at a stable interval into one group', () => {
    const requests = Array.from({ length: 6 }, (_, i) => req('/api/notifications', i * 5000));
    const groups = detectPolling(requests);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ url: '/api/notifications', count: 6, intervalMs: 5000 });
  });

  it('does not flag a handful of one-off unattributed requests as polling', () => {
    const requests = [req('/api/a', 0), req('/api/b', 1000), req('/api/c', 5000)];
    expect(detectPolling(requests)).toEqual([]);
  });

  it('does not flag irregular-interval repeats as polling', () => {
    const requests = [req('/x', 0), req('/x', 1000), req('/x', 8000), req('/x', 8200)];
    expect(detectPolling(requests)).toEqual([]);
  });
});

describe('backgroundRequests', () => {
  it('excludes requests belonging to a detected polling group', () => {
    const requests = Array.from({ length: 5 }, (_, i) => req('/poll', i * 1000));
    const polling = detectPolling(requests);
    const bg = backgroundRequests(requests, new Set(polling.map((p) => p.url)));
    expect(bg).toEqual([]);
  });

  it('includes genuinely unexplained one-off background requests', () => {
    const requests = [req('/mystery', 0)];
    const bg = backgroundRequests(requests, new Set());
    expect(bg).toHaveLength(1);
  });
});
