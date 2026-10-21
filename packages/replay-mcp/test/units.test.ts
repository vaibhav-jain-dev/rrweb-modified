import { describe, expect, it } from 'vitest';
import { compareStep } from '../src/compare.ts';
import { applyPatch, resolveValue } from '../src/patch.ts';
import { collapseUi } from '../src/report.ts';
import type { Step } from '../src/types.ts';
import { stepLimitMs } from '../src/wait.ts';
import { unansweredWrites } from '../src/writes.ts';

const step = (over: Partial<Step> = {}): Step => ({
  seq: 1, type: 'click', url: 'http://x/a', route: '/a', candidates: [], label: 'click "Go"',
  expect: { calls: [{ endpoint: 'PATCH /api/x/:id', status: 200, ms: 1500 }], toasts: ['Saved'], recordedMs: 1500, route: '/a' },
  ...over,
});
const call = (over = {}) => ({ endpoint: 'PATCH /api/x/:id', method: 'PATCH', url: 'http://x/api/x/1', status: 200, ms: 100, ...over });

describe('patch', () => {
  it('sets a field and rejects a step that is not there', () => {
    const out = applyPatch([step({ type: 'input', value: 'a', label: 'type "a" into f' })], { set: { '1.value': 'b' } });
    expect(out[0].value).toBe('b');
    expect(out[0].label).toContain('"b"');
    expect(() => applyPatch([step()], { skip: [9] })).toThrow(/step 9/);
  });
  it('range skips outside, skip skips named', () => {
    const out = applyPatch([step({ seq: 1 }), step({ seq: 2 }), step({ seq: 3 })], { range: [2, 3], skip: [3] });
    expect(out.map((s) => !!s.skip)).toEqual([true, false, true]);
  });
  it('resolves secrets from the environment only', () => {
    process.env.REPLAY_SECRET_TOKEN = 't0k';
    expect(resolveValue('$secret.token')).toBe('t0k');
    expect(() => resolveValue('$secret.NOPE')).toThrow(/REPLAY_SECRET_NOPE/);
    expect(resolveValue('plain')).toBe('plain');
  });
});

describe('compare', () => {
  const base = { route: '/a', seenToasts: new Set(['saved']), ms: 1000, timedOut: false };
  it('ok when calls, route and message match', () => {
    expect(compareStep({ ...base, step: step(), calls: [call()] }).status).toBe('ok');
  });
  it('slow is not a failure', () => {
    const v = compareStep({ ...base, step: step(), calls: [call()], ms: 14_000 });
    expect(v.status).toBe('slow');
  });
  it('a missing call, a 5xx, a wrong route and a missing message are each reported', () => {
    expect(compareStep({ ...base, step: step(), calls: [] }).status).toBe('diverged');
    expect(compareStep({ ...base, step: step(), calls: [call({ status: 500 })] }).status).toBe('failed');
    expect(compareStep({ ...base, step: step(), calls: [call()], route: '/b' }).status).toBe('diverged');
    expect(compareStep({ ...base, step: step(), calls: [call()], seenToasts: new Set() }).status).toBe('diverged');
  });
  it('a call that was an error when recorded and is fine now is a note, not a problem', () => {
    const s = step({ expect: { calls: [{ endpoint: 'PATCH /api/x/:id', status: 404, ms: 10 }], toasts: [], recordedMs: 10 } });
    const v = compareStep({ ...base, step: s, calls: [call({ status: 201 })] });
    expect(v.status).toBe('ok');
    expect(v.notes[0]).toContain('which was an error');
  });
  it('timed out with the call missing is a timeout', () => {
    expect(compareStep({ ...base, step: step(), calls: [], timedOut: true }).status).toBe('timeout');
  });
});

describe('wait limits and writes', () => {
  it('limit follows the recorded time, floor 10s, cap 60s, stretched when slow', () => {
    expect(stepLimitMs(step({ expect: { calls: [], toasts: [], recordedMs: 0 } }))).toBe(10_000);
    expect(stepLimitMs(step({ expect: { calls: [], toasts: [], recordedMs: 9_623 } }))).toBe(50_115);
    expect(stepLimitMs(step({ expect: { calls: [], toasts: [], recordedMs: 60_000 } }))).toBe(60_000);
    expect(stepLimitMs(step(), 2)).toBeGreaterThan(stepLimitMs(step()));
  });
  it('a write with no answer is flagged; a GET or an answered write is not', () => {
    const w = [
      { ...call({ pending: true, status: undefined }), start: 0, resourceType: 'fetch' },
      { ...call({ method: 'GET' }), start: 0, resourceType: 'fetch' },
      { ...call(), start: 0, resourceType: 'fetch' },
    ];
    expect(unansweredWrites(w)).toHaveLength(1);
  });
});

describe('report', () => {
  it('collapses the recorder-style repeated UI lines', () => {
    const lines = Array.from({ length: 40 }, () => 'div appeared: 3 rows');
    expect(collapseUi(lines)).toEqual(['div appeared: 3 rows ×40']);
  });
});
