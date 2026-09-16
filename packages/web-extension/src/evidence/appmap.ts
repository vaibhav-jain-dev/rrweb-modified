/**
 * Application-map builder: incrementally accumulates an inventory of the
 * app surface actually observed across a session - routes, nav items,
 * tabs/nested tabs, dialogs/drawers, tables/lists, filters, pagination -
 * with visible/accessible labels and visible-vs-merely-present state.
 * Fed by the same UIDigest already computed for correlation (see
 * digest.ts) - no separate DOM walk.
 */
import { computeAccessibleName, computeVisibility } from './accname';
import { buildSelector } from './selector';
import type { AppMap, AppMapEdge, AppMapNode, AppMapNodeKind, VisibilityState } from './types';

function nodeId(kind: AppMapNodeKind, route: string, selector: string): string {
  return `${kind}:${route}:${selector}`;
}

function isNestedTab(el: Element): boolean {
  const ancestorTab = el.parentElement?.closest('[role="tab"], [role="tablist"] [role="tab"]');
  return !!ancestorTab;
}

/**
 * DOM-dependent extraction - runs in the content script's main world
 * (called from inject.ts alongside buildDigest), not in the background,
 * which has no Document to walk.
 */
export function extractAppMapNodes(
  doc: Document,
  route: string,
  actionSeq: number,
): AppMapNode[] {
  const nodes: AppMapNode[] = [];

  function push(kind: AppMapNodeKind, el: Element, parentSelector?: string) {
    const { selector } = buildSelector(el, doc);
    const state: VisibilityState = computeVisibility(el);
    nodes.push({
      kind,
      id: nodeId(kind, route, selector),
      label: el.textContent?.trim().slice(0, 100) || undefined,
      accessibleName: computeAccessibleName(el) || undefined,
      selector,
      parentId: parentSelector ? nodeId('nav-item', route, parentSelector) : undefined,
      route,
      firstSeenAction: actionSeq,
      states: [state],
      reachedBy: actionSeq,
    });
  }

  doc.querySelectorAll('nav a, [role="navigation"] a, [role="navigation"] [role="link"]').forEach((el) => {
    push('nav-item', el);
  });

  doc.querySelectorAll('[role="tab"]').forEach((el) => {
    push(isNestedTab(el) ? 'nested-tab' : 'tab', el);
  });

  doc.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]').forEach((el) => {
    push('dialog', el);
  });

  // drawer heuristic: fixed/sticky-positioned element with aria-modal or
  // a recognizable "close" control, that isn't already a dialog role
  doc.querySelectorAll('[aria-modal="true"]:not([role="dialog"]):not([role="alertdialog"])').forEach((el) => {
    push('drawer', el);
  });

  doc.querySelectorAll('table').forEach((el) => push('table', el));
  doc.querySelectorAll('ul, ol, [role="list"]').forEach((el) => {
    if (el.closest('nav, [role="navigation"]')) return;
    if (el.children.length < 2) return;
    push('list', el);
  });

  doc.querySelectorAll('[role="navigation"][aria-label*="pagination" i], nav[aria-label*="pagination" i]').forEach((el) => {
    push('pagination', el);
  });
  doc.querySelectorAll('select, input[type="search"], input[type="checkbox"][name*="filter" i]').forEach((el) => {
    if (el.closest('[role="navigation"]')) return;
    push('filter', el);
  });

  return nodes;
}

/**
 * Pure merge: fold newly-observed nodes (already extracted, e.g. by
 * `extractAppMapNodes` in the content script and sent back over the wire)
 * into an accumulating app map. Same id \> union the observed states;
 * new id \> append. Runs in the background script, which has no DOM of
 * its own.
 */
export function mergeAppMapNodes(map: AppMap, newNodes: AppMapNode[]): AppMap {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));

  for (const node of newNodes) {
    const existing = byId.get(node.id);
    if (existing) {
      for (const s of node.states) {
        if (!existing.states.includes(s)) existing.states.push(s);
      }
      if (node.reachedBy !== undefined) existing.reachedBy ??= node.reachedBy;
    } else {
      byId.set(node.id, node);
    }
  }

  const edges: AppMapEdge[] = [...map.edges];
  return { nodes: Array.from(byId.values()), edges };
}

export function recordNavigationEdge(map: AppMap, fromRoute: string, toRoute: string): AppMap {
  const fromNode = map.nodes.find((n) => n.kind === 'route' && n.route === fromRoute);
  const toId = nodeId('route', toRoute, toRoute);
  if (!map.nodes.some((n) => n.id === toId)) {
    map.nodes.push({
      kind: 'route',
      id: toId,
      selector: toRoute,
      route: toRoute,
      firstSeenAction: 0,
      states: ['visible-usable'],
    });
  }
  if (fromNode) {
    map.edges.push({ from: fromNode.id, to: toId, via: 'nav' });
  }
  return map;
}

export function emptyAppMap(): AppMap {
  return { nodes: [], edges: [] };
}
