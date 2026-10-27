/**
 * Agent checks as marks on the Player's timeline. The ledger is cleared
 * with the rest of the evidence after export, so the session keeps this
 * small list instead; the Player turns it into rrweb custom events, which
 * rrweb-player draws on its progress bar (hover shows the tag).
 */
import { EventType, type eventWithTime } from '@rrweb/types';
import type { CheckStatus, Ledger } from './protocol';

export type AgentMarker = {
  /** Epoch ms: when the check was decided. */
  t: number;
  status: CheckStatus;
  /** `Loan created · loan_application — Loan L-9 is in the database` */
  label: string;
};

const MARK: Partial<Record<CheckStatus, string>> = {
  verified: '✓',
  failed: '✗',
  unchecked: '?',
};

const COLOR: Partial<Record<CheckStatus, string>> = {
  verified: '#38A169',
  failed: '#E53E3E',
  unchecked: '#A0AEC0',
};

/** One marker per decided check. `never_seen` has no moment, and unfinished checks have no outcome. */
export function agentMarkers(ledger: Ledger): AgentMarker[] {
  const out: AgentMarker[] = [];
  for (const lane of ledger.lanes) {
    for (const c of lane.checks) {
      const at = c.tResolved ?? c.tObserved;
      if (!MARK[c.status] || at === undefined) continue;
      out.push({
        t: ledger.startedAt + at,
        status: c.status,
        label: `${c.claim} — ${c.note ?? c.status}`.slice(0, 160),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const tagOf = (m: AgentMarker) => `agent ${MARK[m.status] ?? ''} ${m.label}`;

/** rrweb-player colors a mark by its tag, so every tag gets its status color. */
export function agentMarkerTags(markers: AgentMarker[]): Record<string, string> {
  return Object.fromEntries(markers.map((m) => [tagOf(m), COLOR[m.status] ?? '#A0AEC0']));
}

/**
 * The events with a custom event per marker, in time order. Marks are kept
 * inside the recording's span so they never lengthen the replay.
 */
export function withAgentMarkers(events: eventWithTime[], markers: AgentMarker[]): eventWithTime[] {
  if (!markers.length || events.length < 2) return events;
  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;
  const marks = markers.map(
    (m) =>
      ({
        type: EventType.Custom,
        timestamp: Math.min(last, Math.max(first, m.t)),
        data: { tag: tagOf(m), payload: { status: m.status, label: m.label } },
      }) as eventWithTime,
  );
  const out: eventWithTime[] = [];
  let i = 0;
  for (const e of events) {
    // `<` keeps a mark after any recorded event with the same timestamp
    while (i < marks.length && marks[i].timestamp < e.timestamp) out.push(marks[i++]);
    out.push(e);
  }
  while (i < marks.length) out.push(marks[i++]);
  return out;
}
