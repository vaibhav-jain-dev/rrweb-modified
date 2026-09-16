/**
 * Screenshot capture: CDP full-page screenshot when the debugger is
 * attached, falling back to chrome.tabs.captureVisibleTab (viewport only)
 * otherwise. Downscaled to a max width via OffscreenCanvas, available in
 * MV3 service workers - no extra dependency needed.
 */
import Browser from 'webextension-polyfill';
import { sendCommand } from './attach';

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

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function captureViaCdp(tabId: number): Promise<Blob | undefined> {
  const result = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: Math.round(JPEG_QUALITY * 100),
    captureBeyondViewport: true,
  });
  if (!result?.data) return undefined;
  return base64ToBlob(result.data, 'image/jpeg');
}

async function captureViaTabsApi(windowId: number): Promise<Blob | undefined> {
  try {
    const dataUrl = await Browser.tabs.captureVisibleTab(windowId, { format: 'png' });
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return undefined;
  }
}

export async function captureScreenshot(
  tabId: number,
  windowId: number,
): Promise<{ blob: Blob; usedCdp: boolean } | undefined> {
  const cdpBlob = await captureViaCdp(tabId);
  if (cdpBlob) return { blob: await downscale(cdpBlob), usedCdp: true };
  const fallbackBlob = await captureViaTabsApi(windowId);
  if (fallbackBlob) return { blob: await downscale(fallbackBlob), usedCdp: false };
  return undefined;
}
