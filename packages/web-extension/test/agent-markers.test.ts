import { describe, expect, it } from 'vitest';
import { EventType, type eventWithTime } from '@rrweb/types';
import { agentMarkerTags, agentMarkers, withAgentMarkers } from '~/agent/markers';
import { check, lane, result } from './agent-fixtures';

const START = 1_700_000_000_000;

function events(...ts: number[]): eventWithTime[] {
  return ts.map((t) => ({ type: EventType.IncrementalSnapshot, timestamp: START + t, data: {} }) as unknown as eventWithTime);
}

describe('agentMarkers', () => {
  it('places each decided check at the moment it was decided, in time order', () => {
    const { ledger } = result([
      lane([
        check({ id: 'b', status: 'failed', tResolved: 9000, note: 'row missing' }),
        check({ id: 'a', status: 'verified', tResolved: 1650 }),
      ]),
    ]);
    expect(agentMarkers(ledger)).toEqual([
      { t: START + 1650, status: 'verified', label: 'Loan created · loan_application — Loan L-9 is in the database' },
      { t: START + 9000, status: 'failed', label: 'Loan created · loan_application — row missing' },
    ]);
  });

  it('leaves out checks with no outcome or no moment', () => {
    const { ledger } = result([
      lane([
        check({ status: 'never_seen', tObserved: undefined, tResolved: undefined }),
        check({ status: 'pending' }),
        check({ status: 'observed' }),
        check({ status: 'unchecked', tResolved: undefined, tObserved: 500 }),
      ]),
    ]);
    expect(agentMarkers(ledger).map((m) => [m.status, m.t])).toEqual([['unchecked', START + 500]]);
  });
});

describe('withAgentMarkers', () => {
  const { ledger } = result([
    lane([
      check({ id: 'a', tResolved: 1500 }),
      check({ id: 'b', status: 'failed', tResolved: 60_000, note: 'row missing' }),
    ]),
  ]);
  const markers = agentMarkers(ledger);

  it('inserts a custom event per marker in time order, inside the recording', () => {
    const out = withAgentMarkers(events(0, 1000, 2000, 5000), markers);
    expect(out.map((e) => e.timestamp - START)).toEqual([0, 1000, 1500, 2000, 5000, 5000]);
    const custom = out.filter((e) => e.type === EventType.Custom);
    expect(custom).toHaveLength(2);
    // a mark after the recording ended is clamped to its last moment, not past it
    expect(out[out.length - 1].type).toBe(EventType.Custom);
    expect(out[out.length - 1].timestamp).toBe(START + 5000);
  });

  it('gives every mark its status color', () => {
    const out = withAgentMarkers(events(0, 70_000), markers);
    const tags = agentMarkerTags(markers);
    const colors = out
      .filter((e) => e.type === EventType.Custom)
      .map((e) => tags[(e.data as { tag: string }).tag]);
    expect(colors).toEqual(['#38A169', '#E53E3E']);
  });

  it('returns the events unchanged when there is nothing to mark', () => {
    const ev = events(0, 1000);
    expect(withAgentMarkers(ev, [])).toBe(ev);
  });
});
