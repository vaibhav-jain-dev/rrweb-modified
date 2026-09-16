/**
 * Canonicalize repeated screenshots - actions whose UI digest hash matches
 * an earlier action (the page didn't visually change) get pointed at that
 * earlier screenshot's path instead of storing the same image bytes
 * again. Mirrors the digest/network dedup: nothing about *when* the
 * repeat happened is lost (ScreenshotRef keeps its own actionSeq), only
 * the duplicate binary is dropped.
 */
import type { ScreenshotRef, UiDataFinding } from './types';

export function dedupeScreenshotRefs(screenshots: ScreenshotRef[]): ScreenshotRef[] {
  const canonicalPathByHash = new Map<string, string>();
  return screenshots.map((s) => {
    if (!s.digestHash) return s; // nothing to key dedup on - keep as-is
    const canonical = canonicalPathByHash.get(s.digestHash);
    if (canonical === undefined) {
      canonicalPathByHash.set(s.digestHash, s.path);
      return s;
    }
    return canonical === s.path ? s : { ...s, path: canonical, dedupedFrom: canonical };
  });
}

/** Findings capture a screenshotRef path directly rather than through a
 * ScreenshotRef, so once screenshots are canonicalized, any finding
 * pointing at a now-dropped duplicate path needs to be retargeted at the
 * surviving one it was deduped into. */
export function remapFindingScreenshotRefs(
  findings: UiDataFinding[],
  originalScreenshots: ScreenshotRef[],
  dedupedScreenshots: ScreenshotRef[],
): UiDataFinding[] {
  const remap = new Map<string, string>();
  originalScreenshots.forEach((orig, i) => {
    const canonical = dedupedScreenshots[i].path;
    if (canonical !== orig.path) remap.set(orig.path, canonical);
  });
  if (remap.size === 0) return findings;
  return findings.map((f) => {
    const ref = f.evidence.screenshotRef;
    if (!ref || !remap.has(ref)) return f;
    return { ...f, evidence: { ...f.evidence, screenshotRef: remap.get(ref) } };
  });
}
