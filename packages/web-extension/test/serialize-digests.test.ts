import { describe, expect, it } from 'vitest';
import { serializeDigests } from '~/evidence/digest-export';
import type { ActionRecord, UIDigest } from '~/evidence/types';

function action(seq: number): ActionRecord {
  return {
    seq,
    t: seq * 1000,
    type: 'click',
    page: { url: 'https://x.test/', route: '/x', title: '', tabId: 1, frameId: 0 },
  };
}

function digest(hash: string, route = '/x'): UIDigest {
  return {
    url: 'https://x.test/',
    route,
    title: '',
    capturedAt: 0,
    headings: [],
    landmarks: [],
    collections: [],
    controls: [],
    status: [],
    counters: {},
    textAtoms: [],
    hiddenAtoms: [],
    digestHash: hash,
  };
}

describe('serializeDigests', () => {
  it('keeps the full digest on first occurrence of a hash', () => {
    const out = serializeDigests([action(0)], [digest('h1')]);
    expect(out).toEqual([
      { actionSeq: 0, route: '/x', digestHash: 'h1', digest: digest('h1') },
    ]);
  });

  it('collapses a repeated identical digest into a sameAs pointer instead of duplicating it', () => {
    const out = serializeDigests(
      [action(0), action(1), action(2)],
      [digest('h1'), digest('h1'), digest('h2')],
    );
    expect(out).toEqual([
      { actionSeq: 0, route: '/x', digestHash: 'h1', digest: digest('h1') },
      { actionSeq: 1, route: '/x', digestHash: 'h1', sameAs: 0 },
      { actionSeq: 2, route: '/x', digestHash: 'h2', digest: digest('h2') },
    ]);
  });

  it('points repeats back to the first occurrence, not the immediately preceding one', () => {
    const out = serializeDigests(
      [action(0), action(1), action(2)],
      [digest('h1'), digest('h2'), digest('h1')],
    );
    expect(out[2]).toEqual({ actionSeq: 2, route: '/x', digestHash: 'h1', sameAs: 0 });
  });

  it('skips actions with no digest (settle never ran) without breaking actionSeq alignment', () => {
    const out = serializeDigests(
      [action(0), action(1), action(2)],
      [digest('h1'), undefined, digest('h1')],
    );
    expect(out).toEqual([
      { actionSeq: 0, route: '/x', digestHash: 'h1', digest: digest('h1') },
      { actionSeq: 2, route: '/x', digestHash: 'h1', sameAs: 0 },
    ]);
  });

  it('matches the ~78% duplicate-rate reduction observed on a real 147-action recording', () => {
    // 147 actions cycling through 32 distinct states, like the real session
    // that motivated this - regression guard on the shape of the win, not
    // just that dedup happens at all.
    const hashes = Array.from({ length: 147 }, (_, i) => `h${i % 32}`);
    const actions = hashes.map((_, i) => action(i));
    const digests = hashes.map((h) => digest(h));
    const out = serializeDigests(actions, digests) as { digest?: unknown }[];
    const fullCount = out.filter((e) => e.digest).length;
    expect(fullCount).toBe(32);
  });
});
