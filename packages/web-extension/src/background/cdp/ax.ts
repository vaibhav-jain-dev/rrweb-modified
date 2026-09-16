/**
 * CDP accessibility-tree cross-check: which visually-present nodes does
 * Chrome's accessibility tree mark `ignored`? This is what lets
 * `reconcile.ts`'s `findInaccessibleControls` distinguish a control that
 * merely isn't focusable from one a screen reader genuinely cannot see.
 *
 * Matching an AX node back to one of our own digest's selectors precisely
 * is hard in general (CDP gives us DOM attributes, not a CSS selector, and
 * we can't cheaply re-run the same selector algorithm cross-context).
 * This module only reports a match when the ignored node carries a
 * data-testid-style attribute or a stable id - exactly the identifiers
 * `evidence/selector.ts` prefers as its first two candidates - so a
 * successful match is trustworthy; anything else is conservatively
 * skipped (silence, never a false positive).
 */
import { sendCommand } from './attach';

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
const IGNORED_INTERESTING_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'tab',
  'menuitem',
  'switch',
]);
const MAX_NODES_TO_RESOLVE = 50;

type AxNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value?: string };
  backendDOMNodeId?: number;
};

type DomAttributesResult = { node: { attributes?: string[] } };

function attrsToRecord(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!flat) return out;
  for (let i = 0; i < flat.length - 1; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

function selectorFromAttrs(attrs: Record<string, string>): string | undefined {
  for (const attr of TEST_ID_ATTRS) {
    if (attrs[attr]) return `[${attr}="${attrs[attr]}"]`;
  }
  if (attrs.id) return `#${CSS.escape ? CSS.escape(attrs.id) : attrs.id}`;
  return undefined;
}

export async function captureAxIgnoredSelectors(tabId: number): Promise<Set<string>> {
  const result = await sendCommand<{ nodes: AxNode[] }>(tabId, 'Accessibility.getFullAXTree');
  if (!result?.nodes) return new Set();

  const candidates = result.nodes
    .filter(
      (n) =>
        n.ignored &&
        n.backendDOMNodeId !== undefined &&
        (!n.role?.value || IGNORED_INTERESTING_ROLES.has(n.role.value)),
    )
    .slice(0, MAX_NODES_TO_RESOLVE);

  const selectors = new Set<string>();
  await Promise.all(
    candidates.map(async (node) => {
      const described = await sendCommand<DomAttributesResult>(tabId, 'DOM.describeNode', {
        backendNodeId: node.backendDOMNodeId,
      });
      const attrs = attrsToRecord(described?.node.attributes);
      const selector = selectorFromAttrs(attrs);
      if (selector) selectors.add(selector);
    }),
  );

  return selectors;
}
