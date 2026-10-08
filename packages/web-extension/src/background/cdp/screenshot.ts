/**
 * Screenshot capture via chrome.tabs.captureVisibleTab (viewport only).
 * Downscaled to a max width via OffscreenCanvas, available in MV3 service
 * workers - no extra dependency needed.
 *
 * There is deliberately no CDP Page.captureScreenshot fallback: on a live,
 * visible tab it disturbs the page's render surface (the app visibly blinks,
 * or is left clipped with a blank remainder). captureVisibleTab only reads
 * the compositor output. Its catch is a quota - Chrome rejects more than
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (2) calls per second - so calls
 * are serialized and spaced out here instead of failing over to CDP.
 */
import Browser from 'webextension-polyfill';

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;

async function downscale(blob: Blob): Promise<Blob> {
  // Feature-detected (matches the pattern rrweb's own canvas worker uses,
  // packages/rrweb/src/record/workers/image-bitmap-data-url-worker.ts)
  // rather than referenced unconditionally: OffscreenCanvas is universal
  // in the MV3 service workers this extension actually targets (Chrome,
  // Firefox), but isn't in every engine ESLint's compat check knows about.
  if (!('OffscreenCanvas' in globalThis)) return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width <= MAX_WIDTH) {
      bitmap.close();
      return blob;
    }
    const scale = MAX_WIDTH / bitmap.width;
    if ('OffscreenCanvas' in globalThis) {
      const canvas = new OffscreenCanvas(
        Math.round(bitmap.width * scale),
        Math.round(bitmap.height * scale),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) return blob;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    }
    bitmap.close();
    return blob;
  } catch {
    return blob;
  }
}

async function captureViaTabsApi(windowId: number): Promise<Blob | undefined> {
  try {
    const dataUrl = await Browser.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: Math.round(JPEG_QUALITY * 100),
    });
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return undefined;
  }
}

// Chrome allows 2 captureVisibleTab calls per second; leave some headroom.
const MIN_CAPTURE_INTERVAL_MS = 600;
let lastCaptureAt = 0;
let captureQueue: Promise<unknown> = Promise.resolve();

/**
 * Returns undefined (no screenshot) rather than capturing something else
 * when the recorded tab isn't the one showing in its window:
 * captureVisibleTab captures whatever tab is visible, so after the user
 * switches tabs it would silently file the wrong page as evidence.
 */
export function captureScreenshot(tabId: number, windowId: number): Promise<Blob | undefined> {
  const run = async () => {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const tab = await Browser.tabs.get(tabId).catch(() => undefined);
    if (!tab?.active || tab.windowId !== windowId) return undefined;
    lastCaptureAt = Date.now();
    const blob = await captureViaTabsApi(windowId);
    return blob ? await downscale(blob) : undefined;
  };
  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}
