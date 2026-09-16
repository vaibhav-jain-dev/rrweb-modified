/**
 * UI digest: a capped, structured walk of the rendered page - not a DOM
 * dump. Answers "what is on screen and usable" in a form small enough to
 * diff cheaply and to hand to an AI agent, and separates what is genuinely
 * visible/usable from what merely exists in the DOM.
 */
import { computeAccessibleName, computeVisibility } from './accname';
import { buildSelector } from './selector';
import type { CollectionInfo, ControlInfo, UIDigest, UIDiff, VisibilityState } from './types';

const MAX_SAMPLE_ROWS = 20;
const MAX_TEXT_ATOMS = 300;
const MAX_ATOM_LEN = 200;

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

function extractCollections(doc: Document): CollectionInfo[] {
  const collections: CollectionInfo[] = [];
  const seen = new Set<Element>();

  // tables
  doc.querySelectorAll('table').forEach((table) => {
    if (seen.has(table)) return;
    seen.add(table);
    const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    const columns = headerCells.map((c) => normalizeText(c.textContent ?? ''));
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const rows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);
    const sampleRows = rows.slice(0, MAX_SAMPLE_ROWS).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => normalizeText(cell.textContent ?? '')),
    );
    const { selector } = buildSelector(table, doc);
    collections.push({
      key: selector,
      selector,
      label: nearbyLabel(table),
      count: rows.length,
      columns: columns.length ? columns : undefined,
      sampleRows,
      rowKeyHint: guessKeyColumn(columns),
    });
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
    const { selector } = buildSelector(list, doc);
    collections.push({
      key: selector,
      selector,
      label: nearbyLabel(list),
      count: items.length,
      sampleRows: items
        .slice(0, MAX_SAMPLE_ROWS)
        .map((item) => [normalizeText(item.textContent ?? '')]),
    });
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
    if (container.children[0].textContent?.trim().length === 0) return;
    seen.add(container);
    const { selector } = buildSelector(container, doc);
    collections.push({
      key: selector,
      selector,
      label: nearbyLabel(container),
      count: container.children.length,
      sampleRows: Array.from(container.children)
        .slice(0, MAX_SAMPLE_ROWS)
        .map((item) => [normalizeText(item.textContent ?? '').slice(0, MAX_ATOM_LEN)]),
    });
  });

  return collections;
}

function guessKeyColumn(columns: string[]): string | undefined {
  return columns.find((c) => /^(id|#|key|code|ref|reference)$/i.test(c));
}

function nearbyLabel(el: Element): string | undefined {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = el.ownerDocument.getElementById(labelledBy);
    if (label?.textContent) return normalizeText(label.textContent);
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return normalizeText(ariaLabel);
  const heading = el.previousElementSibling;
  if (heading && /^H[1-6]$/.test(heading.tagName)) {
    return normalizeText(heading.textContent ?? '');
  }
  return undefined;
}

function extractControls(doc: Document): ControlInfo[] {
  const selectorForRole = CONTROL_ROLES.map((r) => `[role="${r}"]`).join(',');
  const nodes = doc.querySelectorAll(
    `button, a[href], input, select, textarea, [role="tab"], ${selectorForRole}`,
  );
  const controls: ControlInfo[] = [];
  nodes.forEach((el) => {
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
    controls.push(control);
  });
  return controls;
}

function extractCounters(doc: Document): Record<string, number> {
  const counters: Record<string, number> = {};
  const text = doc.body.textContent ?? '';
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

  // Plain recursive walk rather than `TreeWalker` + `NodeFilter.SHOW_TEXT`:
  // portable across environments where that combination is unreliable
  // (notably happy-dom, used by this file's own tests).
  function visit(node: Node) {
    if (textAtoms.size >= MAX_TEXT_ATOMS && hiddenAtoms.size >= MAX_TEXT_ATOMS) return;
    if (node.nodeType === 3 /* TEXT_NODE */) {
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
    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(doc.body);
  return { textAtoms: Array.from(textAtoms), hiddenAtoms: Array.from(hiddenAtoms) };
}

function extractHeadings(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('h1, h2, h3'))
    .map((h) => normalizeText(h.textContent ?? ''))
    .filter(Boolean)
    .slice(0, 30);
}

function extractLandmarks(doc: Document): { role: string; name?: string }[] {
  const selector =
    'nav, main, header, footer, aside, [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="tablist"], [role="dialog"]';
  return Array.from(doc.querySelectorAll(selector)).map((el) => ({
    role: role(el) || el.tagName.toLowerCase(),
    name: computeAccessibleName(el) || undefined,
  }));
}

function extractStatus(
  doc: Document,
): { role: 'alert' | 'status' | 'dialog' | 'toast'; text: string }[] {
  const out: { role: 'alert' | 'status' | 'dialog' | 'toast'; text: string }[] = [];
  doc.querySelectorAll('[role="alert"], [role="status"]').forEach((el) => {
    const text = normalizeText(el.textContent ?? '');
    if (text) out.push({ role: el.getAttribute('role') as 'alert' | 'status', text });
  });
  doc.querySelectorAll('[role="dialog"], dialog[open]').forEach((el) => {
    const text = normalizeText(el.textContent ?? '').slice(0, MAX_ATOM_LEN);
    if (text) out.push({ role: 'dialog', text });
  });
  return out;
}

export function buildDigest(doc: Document, route: string): UIDigest {
  const collections = extractCollections(doc);
  const controls = extractControls(doc);
  const { textAtoms, hiddenAtoms } = extractAtoms(doc);
  const hashInput = JSON.stringify({
    collections: collections.map((c) => [c.key, c.count]),
    controlCount: controls.length,
    textAtoms,
  });
  return {
    url: doc.location?.href ?? '',
    route,
    title: doc.title,
    capturedAt: Date.now(),
    headings: extractHeadings(doc),
    landmarks: extractLandmarks(doc),
    collections,
    controls,
    status: extractStatus(doc),
    counters: extractCounters(doc),
    textAtoms,
    hiddenAtoms,
    digestHash: fnv1a(hashInput),
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
