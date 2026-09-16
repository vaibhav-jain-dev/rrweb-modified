/**
 * rrweb RecordPlugin: captures meaningful user interactions as
 * `ActionRecord`s riding the same event stream as everything else rrweb
 * records. Runs in the page's main world (this file is bundled into
 * content/inject.ts), so it sees the real DOM/event targets, not a
 * sandboxed copy.
 *
 * `seq` is left as a placeholder (0) here: a single session spans
 * multiple frames/tabs whose events interleave only once they reach the
 * background script, so final sequence numbers are assigned there, not
 * per-frame.
 */
import type { IMirror, IWindow, RecordPlugin } from '@rrweb/types';
import { computeAccessibleName } from '~/evidence/accname';
import { buildSelector } from '~/evidence/selector';
import { shouldMaskInput, redactValueShapes } from '~/evidence/redact';
import type { ActionRecord, ActionType, TargetInfo } from '~/evidence/types';
import { INTERACTION_PLUGIN_NAME } from '~/evidence/plugin-names';
export { INTERACTION_PLUGIN_NAME };

export type InteractionPluginOptions = {
  maskSelectors?: string[];
  inputDebounceMs?: number;
  scrollDebounceMs?: number;
};

const DEFAULT_OPTIONS: Required<InteractionPluginOptions> = {
  maskSelectors: [],
  inputDebounceMs: 800,
  scrollDebounceMs: 400,
};

function getRoute(): string {
  return location.pathname + location.search;
}

function targetTag(el: Element): string {
  return el.tagName;
}

function collectAttrs(el: Element): Record<string, string> {
  const allow = ['type', 'name', 'role', 'href', 'aria-label', 'placeholder', 'value'];
  const out: Record<string, string> = {};
  for (const attr of allow) {
    const value = el.getAttribute(attr);
    if (value === null) continue;
    // `value` on a masked field must never leak into attrs either.
    out[attr] = attr === 'value' && shouldMaskInput(el as HTMLInputElement) ? '' : value;
  }
  return out;
}

function buildTargetInfo(
  el: Element,
  mirror: IMirror<Node> | undefined,
  maskSelectors: string[],
): TargetInfo {
  const { selector, selectorCandidates, locator } = buildSelector(el, el.ownerDocument);
  const rect = el.getBoundingClientRect();
  const rrwebId = mirror?.getId(el);
  const masked = shouldMaskInput(
    el as HTMLInputElement,
    maskSelectors,
    (selectors) => selectors.some((s) => el.matches(s)),
  );
  const text = masked ? undefined : el.textContent?.trim().slice(0, 200) || undefined;
  return {
    rrwebId: rrwebId !== undefined && rrwebId >= 0 ? rrwebId : undefined,
    selector,
    selectorCandidates,
    locator,
    tag: targetTag(el),
    role: el.getAttribute('role') ?? undefined,
    accessibleName: masked ? undefined : computeAccessibleName(el) || undefined,
    text,
    attrs: collectAttrs(el),
    box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}

function pageRef(): ActionRecord['page'] {
  return {
    url: location.href,
    route: getRoute(),
    title: document.title,
    tabId: -1, // filled in by the background script, which knows the real tab id
    frameId: window === window.top ? 0 : -1,
    frameUrl: window === window.top ? undefined : location.href,
  };
}

function makeAction(type: ActionType, target?: TargetInfo, value?: string): ActionRecord {
  return { seq: 0, t: Date.now(), type, page: pageRef(), target, value };
}

function resolveValue(el: Element, masked: boolean): string | undefined {
  if (masked) return undefined;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
    return redactValueShapes(el.value);
  }
  if (el instanceof HTMLTextAreaElement) return redactValueShapes(el.value);
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    return opt ? opt.textContent?.trim() : el.value;
  }
  return undefined;
}

export function initInteractionObserver(
  cb: (payload: ActionRecord) => void,
  win: IWindow,
  options: InteractionPluginOptions,
  mirror: IMirror<Node> | undefined,
): () => void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const doc = win.document;
  const cleanups: (() => void)[] = [];

  const inputTimers = new Map<Element, { timer: ReturnType<typeof setTimeout>; keystrokes: number }>();
  const scrollTimers = new Map<Element | Document, ReturnType<typeof setTimeout>>();
  const lastScrollPos = new Map<Element | Document, number>();

  function targetOf(event: Event): Element | null {
    const path = event.composedPath?.();
    const first = path?.[0];
    if (first instanceof Element) return first;
    return event.target instanceof Element ? event.target : null;
  }

  function isMasked(el: Element): boolean {
    return shouldMaskInput(el as HTMLInputElement, opts.maskSelectors, (selectors) =>
      selectors.some((s) => el.matches(s)),
    );
  }

  function on<K extends keyof DocumentEventMap>(
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
    capture = true,
  ) {
    doc.addEventListener(type, handler as EventListener, capture);
    cleanups.push(() => doc.removeEventListener(type, handler as EventListener, capture));
  }

  on('click', (e) => {
    const el = targetOf(e);
    if (!el) return;
    const target = buildTargetInfo(el, mirror, opts.maskSelectors);
    cb(makeAction('click', target));
  });

  on('dblclick', (e) => {
    const el = targetOf(e);
    if (!el) return;
    cb(makeAction('dblclick', buildTargetInfo(el, mirror, opts.maskSelectors)));
  });

  on('submit', (e) => {
    const el = targetOf(e);
    if (!el) return;
    cb(makeAction('submit', buildTargetInfo(el, mirror, opts.maskSelectors)));
  });

  on('keydown', (e) => {
    if (!['Enter', 'Escape', 'Tab'].includes(e.key)) return;
    const el = targetOf(e);
    if (!el) return;
    cb(makeAction('key', buildTargetInfo(el, mirror, opts.maskSelectors), e.key));
  });

  on('change', (e) => {
    const el = targetOf(e);
    if (!el) return;
    const masked = isMasked(el);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      cb(makeAction('toggle', buildTargetInfo(el, mirror, opts.maskSelectors), resolveValue(el, masked)));
      return;
    }
    if (el instanceof HTMLSelectElement) {
      cb(makeAction('select', buildTargetInfo(el, mirror, opts.maskSelectors), resolveValue(el, masked)));
      return;
    }
    // plain text/textarea change: falls through to the debounced input
    // path below via the 'input' listener, so nothing to do here.
  });

  on('input', (e) => {
    const el = targetOf(e);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (el.type === 'checkbox' || el.type === 'radio') return; // handled by change
    const existing = inputTimers.get(el);
    const keystrokes = (existing?.keystrokes ?? 0) + 1;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      inputTimers.delete(el);
      const masked = isMasked(el);
      const target = buildTargetInfo(el, mirror, opts.maskSelectors);
      const action = makeAction('input', target, resolveValue(el, masked));
      action.keystrokes = keystrokes;
      cb(action);
    }, opts.inputDebounceMs);
    inputTimers.set(el, { timer, keystrokes });
  });

  function handleScroll(container: Element | Document) {
    const pos =
      container === doc
        ? win.scrollY
        : (container as Element).scrollTop;
    const last = lastScrollPos.get(container) ?? 0;
    if (Math.abs(pos - last) < 40) return; // not meaningful
    const existingTimer = scrollTimers.get(container);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      scrollTimers.delete(container);
      lastScrollPos.set(container, pos);
      const el = container === doc ? doc.documentElement : (container as Element);
      cb(makeAction('scroll', buildTargetInfo(el, mirror, opts.maskSelectors)));
    }, opts.scrollDebounceMs);
    scrollTimers.set(container, timer);
  }

  const scrollHandler = (e: Event) => {
    const target = e.target;
    if (target === doc || target instanceof Document) handleScroll(doc);
    else if (target instanceof Element) handleScroll(target);
  };
  doc.addEventListener('scroll', scrollHandler, true);
  cleanups.push(() => doc.removeEventListener('scroll', scrollHandler, true));

  return () => {
    cleanups.forEach((fn) => fn());
    inputTimers.forEach(({ timer }) => clearTimeout(timer));
    scrollTimers.forEach((timer) => clearTimeout(timer));
  };
}

export function getRecordInteractionPlugin(
  options: InteractionPluginOptions = {},
): RecordPlugin<InteractionPluginOptions> {
  let mirror: IMirror<Node> | undefined;
  return {
    name: INTERACTION_PLUGIN_NAME,
    getMirror: (mirrors) => {
      mirror = mirrors.nodeMirror;
    },
    observer: (cb, win) => initInteractionObserver(cb as (p: ActionRecord) => void, win, options, mirror),
    options,
  };
}
