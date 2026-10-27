import { describe, expect, it } from 'vitest';
import {
  describeBackend,
  formatElapsed,
  laneBadge,
  orderChecks,
  stepIcon,
} from '~/agent/ui';
import type { HealthResponse } from '~/agent/protocol';
import { check, lane } from './agent-fixtures';

const health = (over: Partial<HealthResponse> = {}): HealthResponse => ({
  ok: true,
  version: '1',
  model: 'qwen2.5-coder:3b',
  gpu: true,
  playbooks: 1,
  sources: { session: { type: 'session', ready: true } },
  ...over,
});

describe('describeBackend', () => {
  it('says GPU when the model is on the GPU, and warns when it is not', () => {
    expect(describeBackend(health())).toMatchObject({
      hardware: 'GPU',
      hardwareTone: 'green',
    });
    expect(describeBackend(health({ gpu: false }))).toMatchObject({
      hardware: 'CPU - slow',
      hardwareTone: 'orange',
    });
    expect(describeBackend(health({ gpu: null }))).toMatchObject({
      hardware: '',
    });
  });
  it('names a source it cannot reach', () => {
    const v = describeBackend(
      health({
        sources: {
          devlms: { type: 'mongo', ready: false, error: 'x' },
          session: { type: 'session', ready: true },
        },
      }),
    );
    expect(v).toMatchObject({ kind: 'ready', unreadySources: ['devlms'] });
  });
  it('reports rules-only mode when there is no model', () => {
    expect(describeBackend(health({ model: null }))).toMatchObject({
      model: 'no model (rules only)',
    });
  });
});

describe('orderChecks', () => {
  it('pins unfinished and bad checks above settled good ones, newest first within a group', () => {
    const out = orderChecks([
      check({ id: 'ok-old', status: 'verified', tObserved: 1 }),
      check({ id: 'run', status: 'observed', tObserved: 2 }),
      check({ id: 'ok-new', status: 'verified', tObserved: 9 }),
      check({ id: 'bad', status: 'failed', tObserved: 5 }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['run', 'bad', 'ok-new', 'ok-old']);
  });
});

describe('small formatters', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(undefined)).toBe('');
    expect(formatElapsed(430)).toBe('430 ms');
    expect(formatElapsed(2500)).toBe('2.5 s');
    expect(formatElapsed(125_000)).toBe('2 m 5 s');
  });
  it('picks a step icon', () => {
    expect(
      ['passed', 'blocked', 'current', 'upcoming'].map((s) =>
        stepIcon(s as never),
      ),
    ).toEqual(['✓', '✕', '▶', '○']);
  });
  it('summarises a lane for its tab', () => {
    expect(laneBadge(lane([check({ status: 'failed' })]))).toEqual({
      text: '1 to look at',
      tone: 'red',
    });
    expect(laneBadge(lane([check({ status: 'unchecked' })]))).toEqual({
      text: '1 unchecked',
      tone: 'orange',
    });
    expect(laneBadge(lane([check({ status: 'observed' })]))).toMatchObject({
      tone: 'blue',
    });
    expect(laneBadge(lane([check()], { gateReadyAt: 5 }))).toEqual({
      text: 'go ahead',
      tone: 'green',
    });
    expect(laneBadge(lane([check()]))).toEqual({ text: '1 ok', tone: 'green' });
  });
});
