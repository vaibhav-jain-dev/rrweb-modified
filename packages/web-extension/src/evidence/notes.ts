/**
 * Turns the recorder's note start/done events into time ranges mapped onto
 * actions, so a reader of the export knows what the person was doing and
 * exactly which actions each comment covers. Pure data in, pure data out.
 */
import type { ActionRecord, NoteEvent, NoteSpan } from './types';

/**
 * Fold start/done events into spans, in start order. A note never marked
 * done ends at `sessionEnd` and is flagged `closed: false`. A note whose
 * parent is unknown (events lost to a worker restart) becomes top level.
 */
export function foldNotes(
  events: NoteEvent[],
  actions: ActionRecord[],
  sessionEnd: number,
): NoteSpan[] {
  const ordered = [...events].sort((a, b) => a.t - b.t);
  const spans = new Map<string, NoteSpan>();
  for (const e of ordered) {
    if (e.kind === 'start') {
      const parent = e.parentId ? spans.get(e.parentId) : undefined;
      spans.set(e.id, {
        id: e.id,
        parentId: parent?.id,
        depth: parent ? parent.depth + 1 : 0,
        text: e.text,
        startedAt: e.t,
        endedAt: sessionEnd,
        closed: false,
      });
    } else {
      const span = spans.get(e.id);
      if (span && !span.closed) {
        span.endedAt = e.t;
        span.closed = true;
      }
    }
  }
  const result = [...spans.values()];
  for (const span of result) {
    const inside = actions.filter((a) => a.t >= span.startedAt && a.t <= span.endedAt);
    if (inside.length) {
      span.firstActionSeq = inside[0].seq;
      span.lastActionSeq = inside[inside.length - 1].seq;
    }
  }
  return result;
}

/** "actions 3-7", "action 4" or "no actions". */
export function describeActionRange(span: NoteSpan): string {
  if (span.firstActionSeq === undefined || span.lastActionSeq === undefined) return 'no actions';
  return span.firstActionSeq === span.lastActionSeq
    ? `action ${span.firstActionSeq}`
    : `actions ${span.firstActionSeq}-${span.lastActionSeq}`;
}
