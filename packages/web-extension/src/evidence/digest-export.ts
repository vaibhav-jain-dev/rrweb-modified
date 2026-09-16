/**
 * Serialize digests for export, collapsing repeats of the same UI state
 * (byte-identical `digestHash`, e.g. clicks that don't change the page) to
 * a `{ sameAs: <actionSeq> }` pointer instead of the full snapshot. Real
 * sessions are dominated by this: on a 147-action recording seen in the
 * wild, only 32 of the digests were actually distinct, so this alone cuts
 * ui-state/digests.json by ~75%+ with zero information loss - every
 * repeat is still recorded as having happened, just not re-stored.
 */
import type { ActionRecord, UIDigest } from './types';

export function serializeDigests(
  actions: ActionRecord[],
  digests: (UIDigest | undefined)[],
): unknown[] {
  const seenAt = new Map<string, number>();
  const out: unknown[] = [];
  for (let i = 0; i < actions.length; i++) {
    const digest = digests[i];
    if (!digest) continue;
    const actionSeq = actions[i].seq;
    const firstSeq = seenAt.get(digest.digestHash);
    if (firstSeq === undefined) {
      seenAt.set(digest.digestHash, actionSeq);
      out.push({ actionSeq, route: digest.route, digestHash: digest.digestHash, digest });
    } else {
      out.push({ actionSeq, route: digest.route, digestHash: digest.digestHash, sameAs: firstSeq });
    }
  }
  return out;
}
