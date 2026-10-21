import { buildDigest, diffDigests } from '../../web-extension/src/evidence/digest.ts';

(window as unknown as { __rrDigest: (route: string) => unknown }).__rrDigest = (route) =>
  buildDigest(document, route);

(window as unknown as { __rrDiff: (a: unknown, b: unknown) => string[] }).__rrDiff = (a, b) =>
  diffDigests(a as Parameters<typeof diffDigests>[0], b as Parameters<typeof diffDigests>[1]).summary;

// What a person does in the page, reported to the replay server (not for replay-driven steps: it pauses those).
type Win = { __rrNote?: (e: { k: 'click' | 'set'; text: string }) => void; __rrFocus?: () => string | null };
const w = window as unknown as Win;
const clip = (s: string, n = 50) => s.replace(/\s+/g, ' ').trim().slice(0, n);

const nameOf = (el: Element): string => {
  const aria = el.getAttribute('aria-label');
  if (aria) return clip(aria);
  const id = (el as HTMLElement).id;
  const label = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.closest('label')?.textContent;
  if (label?.trim()) return clip(label);
  const ph = el.getAttribute('placeholder');
  if (ph) return clip(ph);
  const text = clip((el as HTMLElement).innerText ?? el.textContent ?? '');
  return text || el.getAttribute('name') || id || el.tagName.toLowerCase();
};

const valueOf = (el: HTMLInputElement): string => {
  if (el.type === 'password') return '[hidden]';
  if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
  return clip(el.value, 60);
};

document.addEventListener(
  'click',
  (ev) => {
    if (!ev.isTrusted || !(ev.target instanceof Element)) return;
    const el = ev.target.closest('button,a,input,select,textarea,label,summary,[role]') ?? ev.target;
    w.__rrNote?.({ k: 'click', text: `"${nameOf(el)}"` });
  },
  true,
);

document.addEventListener(
  'change',
  (ev) => {
    const el = ev.target as HTMLInputElement | null;
    if (!ev.isTrusted || !el?.tagName) return;
    w.__rrNote?.({ k: 'set', text: `"${nameOf(el)}" = ${valueOf(el)}` });
  },
  true,
);

w.__rrFocus = () => {
  const el = document.activeElement as HTMLInputElement | null;
  if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || !el.value) return null;
  return `"${nameOf(el)}" = ${valueOf(el)}`;
};
