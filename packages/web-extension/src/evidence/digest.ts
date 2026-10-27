/**
 * UI digest: a capped, structured walk of the rendered page - not a DOM
 * dump. Answers "what is on screen and usable" in a form small enough to
 * diff cheaply and to hand to an AI agent, and separates what is genuinely
 * visible/usable from what merely exists in the DOM.
 */
import { computeAccessibleName, computeVisibility } from './accname';
import { buildSelector } from './selector';
import { boundedText } from './text';
import type { CollectionInfo, ControlInfo, UIDigest, UIDiff, VisibilityState } from './types';

const MAX_SAMPLE_ROWS = 20;
const MAX_TEXT_ATOMS = 300;
const MAX_ATOM_LEN = 200;
// A long page (a feed after a few minutes of scrolling) has thousands of
// controls and repeated lists, and every one listed costs a selector checked
// against the whole document. Listing all of them grew with the square of
// the page: 3s at 14k elements, 28s at 42k, blocking the page after every
// action. Past these caps the digest keeps a selection and says so in
// `truncated`.
const MAX_CONTROLS = 300;
const MAX_COLLECTIONS = 50;
const MAX_LANDMARKS = 30;
const MAX_STATUS = 20;
const MAX_STATUS_LEN = 1000;
const MAX_HEADINGS = 30;
const MAX_COUNTER_TEXT = 100_000;
// Even capped, each listed control or collection costs a selector checked
// against the whole document, so on a huge page the caps alone still mean
// a long freeze. Selector work stops at these budgets; what was left out
// shows in `truncated`.
const CONTROLS_BUDGET_MS = 50;
const COLLECTIONS_BUDGET_MS = 30;
/** Listed whatever the budget, so a digest always describes what is on screen. */
const MIN_CONTROLS = 10;
/** Text nodes the atom walk visits. Visible text usually fills its cap early;
 * past that the walk only looks for hidden text, and a long page would
 * otherwise be read to the end after every action. */
const MAX_ATOM_WALK = 20_000;

const CONTROL_ROLES = [
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'searchbox',
  'switch',
  'tab',
  'menuitem',
];

function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function role(el: Element): string {
  return el.getAttribute('role') ?? implicitRole(el) ?? '';
}

const IMPLICIT_ROLES: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  INPUT: 'textbox',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
};

function implicitRole(el: Element): string | undefined {
  return IMPLICIT_ROLES[el.tagName];
}

function inputRole(el: HTMLInputElement): string {
  if (el.type === 'checkbox') return 'checkbox';
  if (el.type === 'radio') return 'radio';
  if (el.type === 'search') return 'searchbox';
  return 'textbox';
}

type CollectionCandidate = {
  el: Element;
  kind: 'table' | 'list' | 'repeat';
  rows: Element[];
};

function findCollectionCandidates(doc: Document): CollectionCandidate[] {
  const candidates: CollectionCandidate[] = [];
  const seen = new Set<Element>();

  // tables
  doc.querySelectorAll('table').forEach((table) => {
    if (seen.has(table)) return;
    seen.add(table);
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const rows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);
    candidates.push({ el: table, kind: 'table', rows });
  });

  // role=list / ul / ol with repeated li item shape (skip nav lists)
  doc.querySelectorAll('ul, ol, [role="list"]').forEach((list) => {
    if (seen.has(list)) return;
    if (list.closest('nav, [role="navigation"]')) return;
    const items = Array.from(list.children).filter(
      (c) => c.tagName === 'LI' || c.getAttribute('role') === 'listitem',
    );
    if (items.length < 2) return;
    seen.add(list);
    candidates.push({ el: list, kind: 'list', rows: items });
  });

  // grid/card-repeat patterns: a container whose children share the same
  // tag+class signature, repeated 3+ times (common table-less "cards" UI)
  doc.querySelectorAll('div, section').forEach((container) => {
    if (seen.has(container)) return;
    if (container.children.length < 3) return;
    const sig = (el: Element) => `${el.tagName}.${el.className}`;
    const first = sig(container.children[0]);
    const uniform = Array.from(container.children).every((c) => sig(c) === first);
    if (!uniform) return;
    // avoid double-counting a container whose repeated children are
    // themselves individually trivial (icons, single spans)
    if (!boundedText(container.children[0], 1).text) return;
    seen.add(container);
    candidates.push({ el: container, kind: 'repeat', rows: Array.from(container.children) });
  });

  return candidates;
}

function toCollectionInfo(doc: Document, candidate: CollectionCandidate): CollectionInfo {
  const { el, kind, rows } = candidate;
  const { selector } = buildSelector(el, doc);
  const info: CollectionInfo = {
    key: selector,
    selector,
    label: nearbyLabel(el),
    count: rows.length,
    sampleRows: [],
  };
  if (kind === 'table') {
    const headerCells = Array.from(el.querySelectorAll('thead th, thead td'));
    const columns = headerCells.map((c) => boundedText(c, MAX_ATOM_LEN).text);
    info.columns = columns.length ? columns : undefined;
    info.sampleRows = rows
      .slice(0, MAX_SAMPLE_ROWS)
      .map((row) => Array.from(row.querySelectorAll('td')).map((cell) => boundedText(cell, MAX_ATOM_LEN).text));
    info.rowKeyHint = guessKeyColumn(columns);
  } else {
    info.sampleRows = rows.slice(0, MAX_SAMPLE_ROWS).map((item) => [boundedText(item, MAX_ATOM_LEN).text]);
  }
  return info;
}

/** Past the cap (or the selector budget), the largest collections are kept -
 * on a long page that is the feed or results list, not the hundreds of tag
 * lists inside its cards. Listed in document order. */
function extractCollections(doc: Document): { collections: CollectionInfo[]; total: number } {
  const deadline = performance.now() + COLLECTIONS_BUDGET_MS;
  const candidates = findCollectionCandidates(doc);
  const largestFirst = [...candidates]
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, MAX_COLLECTIONS);
  const built = new Map<CollectionCandidate, CollectionInfo>();
  for (const candidate of largestFirst) {
    if (built.size > 0 && performance.now() > deadline) break;
    built.set(candidate, toCollectionInfo(doc, candidate));
  }
  const collections = candidates.flatMap((c) => {
    const info = built.get(c);
    return info ? [info] : [];
  });
  return { collections, total: candidates.length };
}

function guessKeyColumn(columns: string[]): string | undefined {
  return columns.find((c) => /^(id|#|key|code|ref|reference)$/i.test(c));
}

function nearbyLabel(el: Element): string | undefined {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = el.ownerDocument.getElementById(labelledBy);
    const text = label ? boundedText(label, MAX_ATOM_LEN).text : '';
    if (text) return text;
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return normalizeText(ariaLabel);
  const heading = el.previousElementSibling;
  if (heading && /^H[1-6]$/.test(heading.tagName)) {
    return boundedText(heading, MAX_ATOM_LEN).text;
  }
  return undefined;
}

/**
 * Up to `max` of `els`: those on screen first, then the rest from the top.
 * What the user is looking at is what an action changed.
 */
function onScreenFirst(els: Element[], max: number, doc: Document): Element[] {
  if (els.length <= max) return els;
  const width = doc.defaultView?.innerWidth ?? 0;
  const height = doc.defaultView?.innerHeight ?? 0;
  const onScreen: Element[] = [];
  const offScreen: Element[] = [];
  for (const el of els) {
    if (onScreen.length >= max) break;
    const rect = el.getBoundingClientRect();
    const visible =
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
    if (visible) onScreen.push(el);
    else if (offScreen.length < max) offScreen.push(el);
  }
  return onScreen.concat(offScreen).slice(0, max);
}

function extractControls(doc: Document): { controls: ControlInfo[]; total: number } {
  const deadline = performance.now() + CONTROLS_BUDGET_MS;
  const selectorForRole = CONTROL_ROLES.map((r) => `[role="${r}"]`).join(',');
  const nodes = Array.from(
    doc.querySelectorAll(`button, a[href], input, select, textarea, [role="tab"], ${selectorForRole}`),
  );
  const order = new Map(nodes.map((el, i) => [el, i]));
  const built: { index: number; control: ControlInfo }[] = [];
  for (const el of onScreenFirst(nodes, MAX_CONTROLS, doc)) {
    if (built.length >= MIN_CONTROLS && performance.now() > deadline) break;
    const r = el.tagName === 'INPUT' ? inputRole(el as HTMLInputElement) : role(el) || 'generic';
    const { selector } = buildSelector(el, doc);
    const name = computeAccessibleName(el);
    const state: VisibilityState = computeVisibility(el);
    const control: ControlInfo = {
      selector,
      role: r,
      name: name || undefined,
      disabled: (el as HTMLInputElement).disabled === true,
      state,
    };
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      control.value = (el as HTMLInputElement).value;
    }
    if (r === 'checkbox' || r === 'radio' || r === 'switch') {
      control.checked = (el as HTMLInputElement).checked;
    }
    if (el.hasAttribute('aria-expanded')) {
      control.expanded = el.getAttribute('aria-expanded') === 'true';
    }
    if (el.hasAttribute('aria-selected')) {
      control.selected = el.getAttribute('aria-selected') === 'true';
    }
    built.push({ index: order.get(el) ?? 0, control });
  }
  const controls = built.sort((a, b) => a.index - b.index).map((b) => b.control);
  return { controls, total: nodes.length };
}

function extractCounters(doc: Document): Record<string, number> {
  const counters: Record<string, number> = {};
  const { text } = boundedText(doc.body, MAX_COUNTER_TEXT);
  // "24 results", "Showing 1-10 of 24"
  const resultsRe = /\b(\d+)\s+(results?|items?|records?|rows?)\b/gi;
  let match;
  while ((match = resultsRe.exec(text))) {
    counters[`${match[2].toLowerCase()}`] = parseInt(match[1], 10);
  }
  const ofRe = /\bof\s+(\d+)\b/i.exec(text);
  if (ofRe) counters.total = parseInt(ofRe[1], 10);
  return counters;
}

/**
 * Walk visible text nodes, splitting into `textAtoms` (visible and not
 * `aria-hidden`) and `hiddenAtoms` (present in the DOM but not visible or
 * not accessibility-exposed) - the distinction the reconciliation layer
 * needs to tell "missing" apart from "present but inaccessible".
 */
function extractAtoms(doc: Document): { textAtoms: string[]; hiddenAtoms: string[] } {
  const textAtoms = new Set<string>();
  const hiddenAtoms = new Set<string>();
  let walked = 0;

  // Plain recursive walk rather than `TreeWalker` + `NodeFilter.SHOW_TEXT`:
  // portable across environments where that combination is unreliable
  // (notably happy-dom, used by this file's own tests).
  function visit(node: Node) {
    if (textAtoms.size >= MAX_TEXT_ATOMS && hiddenAtoms.size >= MAX_TEXT_ATOMS) return;
    if (walked >= MAX_ATOM_WALK) return;
    if (node.nodeType === 3 /* TEXT_NODE */) {
      walked += 1;
      const value = normalizeText(node.textContent ?? '');
      if (!value || value.length > MAX_ATOM_LEN) return;
      const parent = node.parentElement;
      if (parent && ['SCRIPT', 'STYLE'].includes(parent.tagName)) return;
      const visible = parent ? computeVisibility(parent) !== 'dom-only-hidden' : true;
      if (visible) {
        if (textAtoms.size < MAX_TEXT_ATOMS) textAtoms.add(value);
      } else if (hiddenAtoms.size < MAX_TEXT_ATOMS) {
        hiddenAtoms.add(value);
      }
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  }

  visit(doc.body);
  return { textAtoms: Array.from(textAtoms), hiddenAtoms: Array.from(hiddenAtoms) };
}

function extractHeadings(doc: Document): string[] {
  const headings: string[] = [];
  for (const h of Array.from(doc.querySelectorAll('h1, h2, h3'))) {
    if (headings.length >= MAX_HEADINGS) break;
    const text = boundedText(h, MAX_ATOM_LEN).text;
    if (text) headings.push(text);
  }
  return headings;
}

function extractLandmarks(doc: Document): { landmarks: { role: string; name?: string }[]; total: number } {
  const selector =
    'nav, main, header, footer, aside, [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="tablist"], [role="dialog"]';
  const nodes = Array.from(doc.querySelectorAll(selector));
  const landmarks = nodes.slice(0, MAX_LANDMARKS).map((el) => ({
    role: role(el) || el.tagName.toLowerCase(),
    name: computeAccessibleName(el) || undefined,
  }));
  return { landmarks, total: nodes.length };
}

function extractStatus(
  doc: Document,
): { role: 'alert' | 'status' | 'dialog' | 'toast'; text: string }[] {
  const out: { role: 'alert' | 'status' | 'dialog' | 'toast'; text: string }[] = [];
  for (const el of Array.from(doc.querySelectorAll('[role="alert"], [role="status"]')).slice(0, MAX_STATUS)) {
    const { text } = boundedText(el, MAX_STATUS_LEN);
    if (text) out.push({ role: el.getAttribute('role') as 'alert' | 'status', text });
  }
  for (const el of Array.from(doc.querySelectorAll('[role="dialog"], dialog[open]')).slice(0, MAX_STATUS)) {
    const { text } = boundedText(el, MAX_ATOM_LEN);
    if (text) out.push({ role: 'dialog', text });
  }
  return out;
}

export function buildDigest(doc: Document, route: string): UIDigest {
  const { collections, total: collectionTotal } = extractCollections(doc);
  const { controls, total: controlTotal } = extractControls(doc);
  const { landmarks, total: landmarkTotal } = extractLandmarks(doc);
  const { textAtoms, hiddenAtoms } = extractAtoms(doc);
  const hashInput = JSON.stringify({
    collections: collections.map((c) => [c.key, c.count]),
    controlCount: controlTotal,
    textAtoms,
  });
  const truncated: NonNullable<UIDigest['truncated']> = {};
  if (controlTotal > controls.length) truncated.controls = controlTotal;
  if (collectionTotal > collections.length) truncated.collections = collectionTotal;
  if (landmarkTotal > landmarks.length) truncated.landmarks = landmarkTotal;
  return {
    url: doc.location?.href ?? '',
    route,
    title: doc.title,
    capturedAt: Date.now(),
    headings: extractHeadings(doc),
    landmarks,
    collections,
    controls,
    status: extractStatus(doc),
    counters: extractCounters(doc),
    textAtoms,
    hiddenAtoms,
    digestHash: fnv1a(hashInput),
    elementCount: doc.getElementsByTagName('*').length,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

function collectionKeyMatch(a: CollectionInfo, b: CollectionInfo): boolean {
  return a.selector === b.selector || (!!a.label && a.label === b.label);
}

export function diffDigests(before: UIDigest | undefined, after: UIDigest): UIDiff {
  const summary: string[] = [];
  const collectionChanges: UIDiff['collectionChanges'] = [];
  const controlChanges: UIDiff['controlChanges'] = [];
  let routeChanged: UIDiff['routeChanged'];

  if (before && before.route !== after.route) {
    routeChanged = { before: before.route, after: after.route };
    summary.push(`Route changed: ${before.route} → ${after.route}`);
  }

  const beforeCollections = before?.collections ?? [];
  for (const afterCol of after.collections) {
    const beforeCol = beforeCollections.find((c) => collectionKeyMatch(c, afterCol));
    if (!beforeCol) {
      if (before) {
        summary.push(`${afterCol.label ?? afterCol.selector} appeared: ${afterCol.count} rows`);
        collectionChanges.push({
          key: afterCol.key,
          label: afterCol.label,
          countAfter: afterCol.count,
        });
      }
      continue;
    }
    if (beforeCol.count !== afterCol.count) {
      summary.push(
        `${afterCol.label ?? afterCol.selector} changed: Rows ${beforeCol.count} → ${afterCol.count}`,
      );
      collectionChanges.push({
        key: afterCol.key,
        label: afterCol.label,
        countBefore: beforeCol.count,
        countAfter: afterCol.count,
      });
    }
  }

  const beforeControls = new Map((before?.controls ?? []).map((c) => [c.selector, c]));
  for (const afterCtrl of after.controls) {
    const beforeCtrl = beforeControls.get(afterCtrl.selector);
    if (!beforeCtrl) continue;
    const changedValue = beforeCtrl.value !== undefined && beforeCtrl.value !== afterCtrl.value;
    const changedChecked =
      beforeCtrl.checked !== undefined && beforeCtrl.checked !== afterCtrl.checked;
    const changedSelected =
      beforeCtrl.selected !== undefined && beforeCtrl.selected !== afterCtrl.selected;
    if (changedValue || changedChecked || changedSelected) {
      const label = afterCtrl.name ?? afterCtrl.selector;
      const before_ = changedValue
        ? beforeCtrl.value
        : changedChecked
          ? String(beforeCtrl.checked)
          : String(beforeCtrl.selected);
      const after_ = changedValue
        ? afterCtrl.value
        : changedChecked
          ? String(afterCtrl.checked)
          : String(afterCtrl.selected);
      summary.push(`${label} changed: ${before_ ?? ''} → ${after_ ?? ''}`);
      controlChanges.push({ selector: afterCtrl.selector, label, before: before_, after: after_ });
    }
  }

  const newStatus = after.status.filter(
    (s) => !before?.status.some((b) => b.text === s.text && b.role === s.role),
  );
  for (const s of newStatus) {
    summary.push(`${s.role} appeared: "${s.text}"`);
  }

  return { summary, collectionChanges, controlChanges, routeChanged };
}
