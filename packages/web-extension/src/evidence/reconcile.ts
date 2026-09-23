/**
 * API-response-to-rendered-UI reconciliation. Every function here
 * produces `UiDataFinding`s, and every finding is a *candidate*, never an
 * assertion: a field present in an API response and absent from the UI is
 * frequently correct (internal ids, audit metadata, feature-flagged
 * fields). The job of this module is to surface the evidence with enough
 * precision that an agent - or a person - can quickly decide whether it's
 * actually a problem, not to decide that itself.
 */
import { templateEndpoint } from './route-template';
import type { AppMap, CollectionInfo, NetworkRequest, UIDigest, UiDataFinding } from './types';

const TRIVIAL_KEY_RE = /^(id|_id|uuid|guid|createdAt|updatedAt|timestamp|__typename)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export type FlatAtom = { path: string; value: string; key: string };

export function flattenJson(value: unknown, path = '$', depth = 0, out: FlatAtom[] = []): FlatAtom[] {
  if (depth > 6 || out.length > 2000) return out;
  if (value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const key = path.split(/[.[]/).pop()?.replace(']', '') ?? path;
    out.push({ path, value: String(value), key });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJson(v, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenJson(v, `${path}.${k}`, depth + 1, out);
    }
  }
  return out;
}

function isTrivial(atom: FlatAtom): boolean {
  if (TRIVIAL_KEY_RE.test(atom.key)) return true;
  if (UUID_RE.test(atom.value)) return true;
  if (ISO_DATE_RE.test(atom.value)) return true;
  if (atom.value === 'true' || atom.value === 'false') return true;
  if (atom.value.length < 2) return true;
  return false;
}

/** Find the JSON array (if any) whose length is the best candidate match
 * for a rendered collection - by shared field names between the array's
 * objects and the collection's column headers, falling back to the
 * longest top-level array in the payload. */
function findMatchingArray(
  parsed: unknown,
  collection: CollectionInfo,
): { path: string; items: unknown[] } | undefined {
  const candidates: { path: string; items: unknown[] }[] = [];
  function walk(value: unknown, path: string, depth: number) {
    if (depth > 4) return;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      candidates.push({ path, items: value });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, `${path}.${k}`, depth + 1);
      }
    }
  }
  walk(parsed, '$', 0);
  if (candidates.length === 0) return undefined;
  if (!collection.columns?.length) {
    return candidates.reduce((a, b) => (b.items.length > a.items.length ? b : a));
  }
  const lowerCols = collection.columns.map((c) => c.toLowerCase());
  let best: { path: string; items: unknown[] } | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    const first = candidate.items[0] as Record<string, unknown>;
    const keys = Object.keys(first ?? {}).map((k) => k.toLowerCase());
    const score = keys.filter((k) => lowerCols.some((c) => c.includes(k) || k.includes(c))).length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best ?? candidates[0];
}

export type ReconcileOptions = {
  route: string;
  actionSeq?: number;
  screenshotRef?: string;
  includeTrivialFields?: boolean;
  priorDigests?: UIDigest[];
};

/**
 * Reconcile one network response against the UI digest captured right
 * after it. Returns candidate findings only - see module doc.
 */
export function reconcileResponse(
  request: NetworkRequest,
  digest: UIDigest,
  opts: ReconcileOptions,
): UiDataFinding[] {
  const findings: UiDataFinding[] = [];
  if (!request.responseBody) return findings;

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.responseBody);
  } catch {
    return findings;
  }
  // Every finding from this response names the endpoint it came from, so
  // findings.md can say "these 62 fields of GET /loan-application/:id/data"
  // once rather than sixty-two times.
  const endpoint = templateEndpoint(request.method, request.url);

  const uiAtoms = new Set(digest.textAtoms);
  const hiddenAtoms = new Set(digest.hiddenAtoms);
  const allAtoms = flattenJson(parsed);

  // count_mismatch: array length vs. best-matching collection count
  for (const collection of digest.collections) {
    const match = findMatchingArray(parsed, collection);
    if (!match) continue;
    if (match.items.length !== collection.count) {
      findings.push({
        kind: 'count_mismatch',
        summary: `Response at ${match.path} had ${match.items.length} items; "${collection.label ?? collection.selector}" rendered ${collection.count}`,
        evidence: {
          route: opts.route,
          endpoint,
          actionSeq: opts.actionSeq,
          selector: collection.selector,
          jsonPath: match.path,
          screenshotRef: opts.screenshotRef,
          apiValue: match.items.length,
          uiValue: collection.count,
        },
        howToVerify: `Compare ${match.path}.length in the response body against the row count of ${collection.selector}.`,
      });
    }
  }

  // missing_in_ui / hidden_in_ui
  for (const atom of allAtoms) {
    if (!opts.includeTrivialFields && isTrivial(atom)) continue;
    if (uiAtoms.has(atom.value)) continue;
    if (hiddenAtoms.has(atom.value)) {
      findings.push({
        kind: 'hidden_in_ui',
        summary: `Value at ${atom.path} ("${atom.value}") is present in the DOM but not visible/accessible`,
        evidence: {
          route: opts.route,
          endpoint,
          actionSeq: opts.actionSeq,
          jsonPath: atom.path,
          screenshotRef: opts.screenshotRef,
          apiValue: atom.value,
        },
        howToVerify: `Search the rendered page for "${atom.value}" - it should be in hiddenAtoms of the matching ui-state digest, not textAtoms.`,
      });
      continue;
    }
    findings.push({
      kind: 'missing_in_ui',
      summary: `Value at ${atom.path} ("${atom.value}") does not appear anywhere in the rendered UI`,
      evidence: {
        route: opts.route,
        endpoint,
        actionSeq: opts.actionSeq,
        jsonPath: atom.path,
        screenshotRef: opts.screenshotRef,
        apiValue: atom.value,
      },
      howToVerify: `Confirm "${atom.value}" is genuinely absent from the page, and check whether the corresponding field should have a UI representation.`,
    });
  }

  // stale_in_ui: a UI atom matches a *previous* response's value for the
  // same JSON path while the latest response differs
  if (opts.priorDigests?.length) {
    const priorValues = new Set(
      opts.priorDigests.flatMap((d) => d.textAtoms),
    );
    for (const atom of allAtoms) {
      if (isTrivial(atom)) continue;
      if (uiAtoms.has(atom.value)) continue;
      const staleCandidate = [...priorValues].find(
        (v) => v !== atom.value && looksLikeSameField(v, atom.value),
      );
      if (staleCandidate && uiAtoms.has(staleCandidate)) {
        findings.push({
          kind: 'stale_in_ui',
          summary: `UI still shows "${staleCandidate}" while the latest response has "${atom.value}" at ${atom.path}`,
          evidence: {
            route: opts.route,
            endpoint,
            actionSeq: opts.actionSeq,
            jsonPath: atom.path,
            screenshotRef: opts.screenshotRef,
            apiValue: atom.value,
            uiValue: staleCandidate,
          },
          howToVerify: `Check whether the UI re-rendered after this response completed.`,
        });
      }
    }
  }

  return findings;
}

/** Very rough heuristic: same length category and shared alpha prefix -
 * good enough to flag a candidate, not to assert equivalence. */
function looksLikeSameField(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 4) return false;
  const prefixLen = Math.min(3, a.length, b.length);
  return a.slice(0, prefixLen).toLowerCase() === b.slice(0, prefixLen).toLowerCase();
}

/**
 * not_focusable / inaccessible_control: controls that look interactive but
 * have no accessible name or are excluded from the AX tree. `axIgnoredSelectors`
 * comes from the CDP accessibility-tree cross-check in the background script.
 */
export function findInaccessibleControls(
  digest: UIDigest,
  axIgnoredSelectors: Set<string>,
  route: string,
): UiDataFinding[] {
  const findings: UiDataFinding[] = [];
  for (const control of digest.controls) {
    if (control.state === 'visible-usable' && !control.name && !axIgnoredSelectors.has(control.selector)) {
      findings.push({
        kind: 'not_focusable',
        summary: `A ${control.role} at ${control.selector} has no accessible name`,
        evidence: { route, selector: control.selector },
        howToVerify: `Inspect ${control.selector} - it should have an aria-label, associated <label>, or visible text.`,
      });
    }
    if (axIgnoredSelectors.has(control.selector) && control.state !== 'dom-only-hidden') {
      findings.push({
        kind: 'inaccessible_control',
        summary: `${control.role}${control.name ? ` "${control.name}"` : ''} at ${control.selector} occupies visible space but is ignored by the accessibility tree`,
        evidence: { route, selector: control.selector },
        howToVerify: `Check the accessibility tree for ${control.selector} - it should not be marked ignored while occupying layout space.`,
      });
    }
  }
  return findings;
}

/** truncated: rendered text is a strict prefix of an API value with no
 * apparent tooltip/title affordance. */
export function findTruncatedText(
  request: NetworkRequest,
  digest: UIDigest,
  route: string,
): UiDataFinding[] {
  const findings: UiDataFinding[] = [];
  if (!request.responseBody) return findings;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.responseBody);
  } catch {
    return findings;
  }
  const atoms = flattenJson(parsed).filter((a) => a.value.length > 20);
  for (const atom of atoms) {
    const truncatedMatch = digest.textAtoms.find(
      (t) => t.length > 3 && t.length < atom.value.length && atom.value.startsWith(t),
    );
    if (truncatedMatch) {
      const hasTooltipHint = digest.controls.some(
        (c) => c.name === truncatedMatch || c.value === truncatedMatch,
      );
      if (!hasTooltipHint) {
        findings.push({
          kind: 'truncated',
          summary: `Rendered text "${truncatedMatch}" is a prefix of the response value at ${atom.path}`,
          evidence: {
            route,
            jsonPath: atom.path,
            apiValue: atom.value,
            uiValue: truncatedMatch,
          },
          howToVerify: `Compare the rendered text against ${atom.path} and check for a title attribute or tooltip.`,
        });
      }
    }
  }
  return findings;
}

/**
 * UX-discovery candidates derived from the accumulated app map:
 * unreachable nav items, hidden tabs, and collections that look
 * paginated (page-size-shaped counts) with no pagination control found.
 * Same framing rule as everything else in this module: candidates, never
 * verdicts.
 */
const PAGE_SIZE_SHAPES = [10, 20, 25, 50, 100];

export function findAppMapCandidates(map: AppMap, digests: UIDigest[]): UiDataFinding[] {
  const findings: UiDataFinding[] = [];

  for (const node of map.nodes) {
    const everUsable = node.states.includes('visible-usable');
    const everHidden =
      node.states.includes('dom-only-hidden') || node.states.includes('ax-ignored');

    if (node.kind === 'nav-item' && everUsable && !node.reachedBy) {
      findings.push({
        kind: 'unreachable_nav',
        summary: `Nav item "${node.label ?? node.selector}" was visible and usable but never led to a route change`,
        evidence: { route: node.route, selector: node.selector },
        howToVerify: `Click ${node.selector} and confirm whether it changes the route/URL.`,
      });
    }

    if ((node.kind === 'tab' || node.kind === 'nested-tab') && everHidden && !everUsable) {
      findings.push({
        kind: 'hidden_tab',
        summary: `${node.kind === 'nested-tab' ? 'Nested tab' : 'Tab'} "${node.label ?? node.selector}" was present but never visible/usable this session`,
        evidence: { route: node.route, selector: node.selector },
        howToVerify: `Check whether ${node.selector} is reachable through normal navigation.`,
      });
    }
  }

  for (const digest of digests) {
    for (const collection of digest.collections) {
      if (!PAGE_SIZE_SHAPES.includes(collection.count)) continue;
      const hasPaginationNearby = map.nodes.some(
        (n) => n.kind === 'pagination' && n.route === digest.route,
      );
      if (!hasPaginationNearby) {
        findings.push({
          kind: 'missing_pagination',
          summary: `"${collection.label ?? collection.selector}" rendered exactly ${collection.count} rows (a common page size) with no pagination control found nearby`,
          evidence: { route: digest.route, selector: collection.selector },
          howToVerify: `Check whether more than ${collection.count} records exist and whether there is a way to reach them.`,
        });
      }
    }
  }

  return findings;
}
