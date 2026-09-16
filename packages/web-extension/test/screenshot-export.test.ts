import { describe, expect, it } from 'vitest';
import { dedupeScreenshotRefs, remapFindingScreenshotRefs } from '~/evidence/screenshot-export';
import type { ScreenshotRef, UiDataFinding } from '~/evidence/types';

function shot(actionSeq: number, path: string, digestHash: string): ScreenshotRef {
  return { actionSeq, phase: 'after', path, digestHash };
}

describe('dedupeScreenshotRefs', () => {
  it('keeps the first occurrence of a digestHash untouched', () => {
    const out = dedupeScreenshotRefs([shot(0, 'screenshots/action-0000-after.jpg', 'h1')]);
    expect(out[0].path).toBe('screenshots/action-0000-after.jpg');
    expect(out[0].dedupedFrom).toBeUndefined();
  });

  it('points a repeated digestHash at the first path and records dedupedFrom', () => {
    const refs = [
      shot(0, 'screenshots/action-0000-after.jpg', 'h1'),
      shot(1, 'screenshots/action-0001-after.jpg', 'h1'),
      shot(2, 'screenshots/action-0002-after.jpg', 'h2'),
    ];
    const out = dedupeScreenshotRefs(refs);
    expect(out[0].path).toBe('screenshots/action-0000-after.jpg');
    expect(out[1].path).toBe('screenshots/action-0000-after.jpg');
    expect(out[1].dedupedFrom).toBe('screenshots/action-0000-after.jpg');
    expect(out[2].path).toBe('screenshots/action-0002-after.jpg');
    expect(out[2].dedupedFrom).toBeUndefined();
  });

  it('leaves a screenshot with no digestHash alone rather than guessing', () => {
    const refs: ScreenshotRef[] = [{ actionSeq: 0, phase: 'after', path: 'screenshots/x.jpg' }];
    expect(dedupeScreenshotRefs(refs)).toEqual(refs);
  });
});

describe('remapFindingScreenshotRefs', () => {
  const original = [
    shot(0, 'screenshots/action-0000-after.jpg', 'h1'),
    shot(1, 'screenshots/action-0001-after.jpg', 'h1'),
  ];
  const deduped = dedupeScreenshotRefs(original);

  function finding(screenshotRef?: string): UiDataFinding {
    return {
      kind: 'missing_in_ui',
      summary: 'x',
      evidence: { screenshotRef },
      howToVerify: 'x',
    };
  }

  it('retargets a finding pointing at a dropped duplicate path', () => {
    const [remapped] = remapFindingScreenshotRefs(
      [finding('screenshots/action-0001-after.jpg')],
      original,
      deduped,
    );
    expect(remapped.evidence.screenshotRef).toBe('screenshots/action-0000-after.jpg');
  });

  it('leaves a finding pointing at a surviving path unchanged', () => {
    const [remapped] = remapFindingScreenshotRefs(
      [finding('screenshots/action-0000-after.jpg')],
      original,
      deduped,
    );
    expect(remapped.evidence.screenshotRef).toBe('screenshots/action-0000-after.jpg');
  });

  it('is a no-op when nothing was deduped', () => {
    const noDupOriginal = [shot(0, 'a.jpg', 'h1'), shot(1, 'b.jpg', 'h2')];
    const noDupDeduped = dedupeScreenshotRefs(noDupOriginal);
    const findings = [finding('a.jpg')];
    expect(remapFindingScreenshotRefs(findings, noDupOriginal, noDupDeduped)).toBe(findings);
  });
});
