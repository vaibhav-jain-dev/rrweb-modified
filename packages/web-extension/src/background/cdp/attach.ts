/**
 * chrome.debugger (CDP) attach/detach lifecycle for one tab.
 *
 * Attaching shows Chrome's "being debugged" banner and is exclusive - it
 * fails if DevTools is already open on the tab, or the tab is a
 * chrome://, Web Store, or otherwise protected page. Callers must treat a
 * failed attach as a normal, expected outcome (fall back to the in-page
 * capture path), not an error to surface loudly.
 *
 * Event routing: chrome.debugger.onEvent is a single global event, not
 * scoped to a tab by subscription, so this module demultiplexes it by
 * tabId and re-dispatches to whichever CDP submodules (network.ts,
 * screenshot.ts, ax.ts) registered a handler for that tab.
 */

export type CdpEventHandler = (method: string, params: Record<string, unknown> | undefined) => void;

const handlersByTab = new Map<number, Set<CdpEventHandler>>();
const attachedTabs = new Set<number>();
let listenersInstalled = false;

function installGlobalListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const handlers = handlersByTab.get(source.tabId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(method, params as Record<string, unknown> | undefined);
      } catch {
        // one handler failing must not break the others
      }
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attachedTabs.delete(source.tabId);
    // reason is typically 'target_closed' or 'canceled_by_user' (DevTools
    // opened). Either way, this tab's CDP capture stops here; the caller
    // (background/index.ts) is expected to notice via `isAttached()` and
    // degrade gracefully rather than this module trying to re-attach.
    console.warn(`[evidence] CDP detached from tab ${source.tabId}: ${reason}`);
  });
}

const CDP_PROTOCOL_VERSION = '1.3';

/**
 * Domains enabled unconditionally. Each `Domain.enable` call is
 * best-effort - a domain that fails to enable (unlikely, but CDP surface
 * varies slightly by Chrome version) degrades that one signal rather than
 * aborting the whole attach.
 */
const DOMAINS_TO_ENABLE = ['Network', 'Page', 'Runtime', 'Log', 'Accessibility', 'DOM'];

export async function attachDebugger(tabId: number): Promise<boolean> {
  installGlobalListeners();
  if (attachedTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
  } catch {
    return false;
  }
  attachedTabs.add(tabId);

  await Promise.all(
    DOMAINS_TO_ENABLE.map((domain) =>
      chrome.debugger.sendCommand({ tabId }, `${domain}.enable`).catch(() => {
        // degrade quietly - see DOMAINS_TO_ENABLE comment
      }),
    ),
  );

  return true;
}

export async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  handlersByTab.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached (e.g. tab closed, or DevTools took over) - fine
  }
}

export function isAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

export function onCdpEvent(tabId: number, handler: CdpEventHandler): () => void {
  installGlobalListeners();
  const set = handlersByTab.get(tabId) ?? new Set();
  set.add(handler);
  handlersByTab.set(tabId, set);
  return () => {
    handlersByTab.get(tabId)?.delete(handler);
  };
}

export async function sendCommand<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T | undefined> {
  if (!attachedTabs.has(tabId)) return undefined;
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch {
    return undefined;
  }
}
