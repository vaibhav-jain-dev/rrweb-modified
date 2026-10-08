import { describe, expect, it } from 'vitest';
import { describeActionRange, foldNotes } from '~/evidence/notes';
import { renderFlow } from '~/evidence/render';
import type { ActionRecord, EvidenceBundle, NoteEvent } from '~/evidence/types';

const action = (seq: number, t: number): ActionRecord => ({
  seq,
  t,
  type: 'click',
  page: { url: 'https://x/a', route: '/a', title: '', tabId: 1, frameId: 0 },
});

describe('foldNotes', () => {
  const actions = [action(0, 1000), action(1, 2000), action(2, 3000), action(3, 4000)];

  it('maps a note to the actions between its start and done', () => {
    const events: NoteEvent[] = [
      { kind: 'start', id: 'a', text: 'Filling form', t: 900 },
      { kind: 'done', id: 'a', t: 2500 },
    ];
    const [n] = foldNotes(events, actions, 5000);
    expect(n).toMatchObject({ closed: true, endedAt: 2500, firstActionSeq: 0, lastActionSeq: 1, depth: 0 });
    expect(describeActionRange(n)).toBe('actions 0-1');
  });

  it('nests a child and keeps it inside its parent', () => {
    const events: NoteEvent[] = [
      { kind: 'start', id: 'a', text: 'outer', t: 900 },
      { kind: 'start', id: 'b', parentId: 'a', text: 'inner', t: 1500 },
      { kind: 'done', id: 'b', t: 2500 },
      { kind: 'done', id: 'a', t: 3500 },
    ];
    const [outer, inner] = foldNotes(events, actions, 5000);
    expect(inner).toMatchObject({ parentId: 'a', depth: 1, firstActionSeq: 1, lastActionSeq: 1 });
    expect(outer).toMatchObject({ firstActionSeq: 0, lastActionSeq: 2 });
  });

  it('ends a note never marked done at the recording end and says so', () => {
    const [n] = foldNotes([{ kind: 'start', id: 'a', text: 'x', t: 3500 }], actions, 5000);
    expect(n).toMatchObject({ closed: false, endedAt: 5000, firstActionSeq: 3 });
  });

  it('reports a note that covered no action', () => {
    const [n] = foldNotes(
      [
        { kind: 'start', id: 'a', text: 'thinking', t: 1100 },
        { kind: 'done', id: 'a', t: 1200 },
      ],
      actions,
      5000,
    );
    expect(describeActionRange(n)).toBe('no actions');
  });
});

describe('renderFlow notes', () => {
  it('prints inline start/end markers around the covered actions', () => {
    const actions = [action(0, 1000), action(1, 2000), action(2, 3000)];
    const notes = foldNotes(
      [
        { kind: 'start', id: 'n1', text: 'Checking staff section', t: 900 },
        { kind: 'done', id: 'n1', t: 2500 },
      ],
      actions,
      5000,
    );
    const bundle = {
      session: { id: 's', name: 'S', createTimestamp: 0, modifyTimestamp: 0, recorderVersion: 't', captureMode: 'cdp' },
      actions,
      network: [],
      console: [],
      storage: [],
      digests: [],
      diffs: [],
      screenshots: [],
      appMap: { nodes: [], edges: [] },
      findings: [],
      notes,
    } as EvidenceBundle;
    const out = renderFlow(bundle);
    expect(out).toContain('actions 0-1');
    expect(out.split('Checking staff section').length).toBe(3); // start + end marker, no outline
    const start = out.indexOf('NOTE ▶ Checking staff section');
    const end = out.indexOf('NOTE ■ done: Checking staff section');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(out.indexOf('ACTION 0'));
    expect(end).toBeGreaterThan(out.indexOf('ACTION 1'));
    expect(end).toBeLessThan(out.indexOf('ACTION 2'));
  });
});
