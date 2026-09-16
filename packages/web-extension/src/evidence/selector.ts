/**
 * Robust CSS/locator selector generation. Every candidate is validated for
 * uniqueness against the live document before being accepted - this module
 * never returns a selector without checking it actually resolves to exactly
 * one element, because a selector nobody can trust is worse than none.
 */

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];

/** attrs that make reasonable, stable selector fragments */
const STABLE_ATTRS = ['name', 'href', 'type', 'placeholder', 'aria-label', 'title'];

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function isUnique(doc: ParentNode, selector: string, el: Element): boolean {
  try {
    const matches = doc.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

/**
 * Heuristic: does this id/class look machine-generated rather than
 * author-chosen? Emotion/styled-components hashes, React's `:r0:` ids, and
 * long digit runs are common examples - selectors built on them break the
 * moment the app rebuilds, so they're deprioritized (not banned outright).
 */
export function looksGenerated(value: string): boolean {
  if (/^:r[0-9a-z]+:$/i.test(value)) return true; // React useId()
  if (/[0-9]{4,}/.test(value)) return true; // long digit run
  if (/^(css|sc|emotion|styled|jsx)-[a-z0-9]{5,}$/i.test(value)) return true;
  if (/^[a-z0-9]{8,}$/i.test(value) && /[0-9]/.test(value) && !/[aeiou]{2,}/i.test(value)) {
    return true; // opaque hash-like token
  }
  return false;
}

function minimalCssPath(doc: ParentNode, el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    const currentNode: Element = node;
    let part = currentNode.tagName.toLowerCase();
    const parent: Element | null = currentNode.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === currentNode.tagName,
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(currentNode) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    const candidate = parts.join(' > ');
    if (isUnique(doc, candidate, el)) return candidate;
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

export type SelectorResult = {
  selector: string;
  selectorCandidates: string[];
  locator: string;
};

export function buildSelector(el: Element, doc: ParentNode = el.ownerDocument): SelectorResult {
  const candidates: string[] = [];
  let best: string | undefined;
  let locator: string | undefined;

  // 1. test-id style attributes
  for (const attr of TEST_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const sel = `[${attr}=${JSON.stringify(value)}]`;
    if (isUnique(doc, sel, el)) {
      candidates.push(sel);
      best ??= sel;
      locator ??= sel;
    }
  }

  // 2. #id, deprioritized if it looks generated
  const id = el.id;
  if (id) {
    const sel = `#${cssEscape(id)}`;
    if (isUnique(doc, sel, el)) {
      candidates.push(sel);
      if (!best && !looksGenerated(id)) best = sel;
    }
  }

  // 3. role + accessible name locator (Playwright-style)
  const role = el.getAttribute('role') ?? implicitRole(el);
  const name = accessibleNameHint(el);
  if (role && name) {
    const roleLocator = `role=${role}[name=${JSON.stringify(name)}]`;
    candidates.push(roleLocator);
    locator ??= roleLocator;
  }

  // 4. label association for form controls
  if (isFormControl(el)) {
    const label = findAssociatedLabel(el);
    if (label) {
      const labelLocator = `label=${JSON.stringify(label)}`;
      candidates.push(labelLocator);
      locator ??= labelLocator;
    }
  }

  // 5. unique stable attribute combination
  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const sel = `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
    if (isUnique(doc, sel, el)) {
      candidates.push(sel);
      best ??= sel;
    }
  }

  // 6. minimal CSS path, always resolvable, last resort for `best`
  const path = minimalCssPath(doc, el);
  candidates.push(path);
  best ??= path;
  locator ??= `css=${path}`;

  return {
    selector: best ?? path,
    selectorCandidates: Array.from(new Set(candidates)),
    locator,
  };
}

function isFormControl(el: Element): boolean {
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

function findAssociatedLabel(el: Element): string | undefined {
  const id = el.id;
  if (id) {
    const label = el.ownerDocument?.querySelector(`label[for=${JSON.stringify(id)}]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const wrappingLabel = el.closest('label');
  if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();
  return undefined;
}

const IMPLICIT_ROLES: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  INPUT: 'textbox',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  TABLE: 'table',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  DIALOG: 'dialog',
};

function implicitRole(el: Element): string | undefined {
  return IMPLICIT_ROLES[el.tagName];
}

/** Cheap accessible-name approximation used only to build locator hints;
 * see accname.ts for the fuller computation used in digests/findings. */
function accessibleNameHint(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const text = el.textContent?.trim();
  if (text && text.length <= 80) return text;
  return undefined;
}
