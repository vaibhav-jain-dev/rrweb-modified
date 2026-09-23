/**
 * Assemble an EvidenceBundle from everything persisted during a session,
 * run the correlation/classification/reconciliation pipeline over it, and
 * package it into a downloadable .zip. This is the one place all the
 * evidence/* pure functions come together.
 */
import Browser from 'webextension-polyfill';
import { zipSync, strToU8 } from 'fflate';
import {
  attributeRequests,
  backgroundRequests,
  buildActionWindows,
  detectPolling,
} from '~/evidence/correlate';
import { classifyAll } from '~/evidence/classify';
import { RECOMMENDED_NETWORK_EXCLUSIONS } from '~/evidence/network-exclusions';
import { SyncDataKey, type Settings, type SyncData } from '~/types';
import {
  findAppMapCandidates,
  findInaccessibleControls,
  findTruncatedText,
  reconcileResponse,
} from '~/evidence/reconcile';
import { toCurlScript } from '~/evidence/curl';
import type { RedactionReport } from '~/evidence/redact';
import {
  renderFindings,
  renderFlow,
  renderManifest,
  renderReadme,
  renderSummaryJson,
} from '~/evidence/render';
import { emptyAppMap, mergeAppMapNodes, recordNavigationEdge } from '~/evidence/appmap';
import { serializeDigests } from '~/evidence/digest-export';
import { serializeNetwork } from '~/evidence/network-export';
import { dedupeScreenshotRefs, remapFindingScreenshotRefs } from '~/evidence/screenshot-export';
import type {
  ActionRecord,
  AppMapNode,
  ConsoleRecord,
  EvidenceBundle,
  EvidenceSession,
  NetworkRequest,
  ScreenshotRef,
  StorageDelta,
  UIDigest,
  UiDataFinding,
} from '~/evidence/types';
import {
  clearEvidenceForSession,
  getEvidenceBlobsForSession,
  getEvidenceItems,
} from '~/utils/storage';

export type SettleResult = {
  actionSeq: number;
  /** The timestamp of the action this settle belongs to - the exact join
   * back to it after actions are renumbered at export. Absent on evidence
   * recorded before it was stored, which falls back to nearest-in-time. */
  actionT?: number;
  settledAt: number;
  digest: UIDigest;
  diffSummary: string[];
  axIgnoredSelectors: string[];
  appMapNodes: AppMapNode[];
  screenshotPath?: string;
};

/**
 * Build the full EvidenceBundle for a session by reading back everything
 * that was buffered into IndexedDB during recording (see
 * background/index.ts and orchestrator.ts) and running the pure
 * correlation/classification/reconciliation functions over it once, at
 * export time - simpler and just as correct as doing it incrementally,
 * since none of those functions depend on wall-clock "now".
 */
export async function buildEvidenceBundle(session: EvidenceSession): Promise<EvidenceBundle> {
  const rawActions = await getEvidenceItems<ActionRecord>(session.id, 'action');
  const rawNetwork = await getEvidenceItems<NetworkRequest>(session.id, 'network');
  const consoleEntries = await getEvidenceItems<ConsoleRecord>(session.id, 'console');
  const storageDeltas = await getEvidenceItems<StorageDelta>(session.id, 'storage');
  const settleResults = await getEvidenceItems<SettleResult>(session.id, 'digest');
  // One tally per stop; summed in case a session was stopped and resumed.
  const redactionReport: RedactionReport = {};
  for (const tally of await getEvidenceItems<RedactionReport>(session.id, 'redaction')) {
    for (const [reason, count] of Object.entries(tally)) {
      redactionReport[reason] = (redactionReport[reason] ?? 0) + count;
    }
  }

  // Assign final sequence numbers in timestamp order (content scripts in
  // different frames/tabs interleave only once their events reach here).
  const actions = [...rawActions]
    .sort((a, b) => a.t - b.t)
    .map((a, i) => ({ ...a, seq: i }));
  // console/storage entries were tagged with the nearest action's
  // *original* seq (assigned live, before this final reordering);
  // rebuild that mapping by matching the closest action timestamp.
  const remapActionSeq = (originalSeq: number | undefined): number | undefined => {
    if (originalSeq === undefined) return undefined;
    const original = settleResults.find((s) => s.actionSeq === originalSeq);
    if (!original) return undefined;
    if (original.actionT !== undefined) {
      return actions.find((a) => a.t === original.actionT)?.seq;
    }
    const nearest = actions.reduce((a, b) =>
      Math.abs(b.t - original.settledAt) < Math.abs(a.t - original.settledAt) ? b : a,
    );
    return nearest?.seq;
  };

  const settleByAction = new Map(settleResults.map((s) => [s.actionSeq, s]));
  const sessionEnd = actions.length ? actions[actions.length - 1].t + 10000 : Date.now();
  const settleTimes = new Map(settleResults.map((s) => [s.actionSeq, s.settledAt]));
  const windows = buildActionWindows(actions, settleTimes, sessionEnd);
  const attributed = attributeRequests(rawNetwork, windows);

  const pageOrigin = actions[0] ? safeOrigin(actions[0].page.url) : '';
  const excludeRules = await getEnabledNetworkExclusions();
  const network = classifyAll(attributed, { pageOrigin, apiOrigins: [pageOrigin], excludeRules });

  const pollingGroups = detectPolling(network);
  const pollingUrls = new Set(pollingGroups.map((g) => g.url));
  void backgroundRequests(network, pollingUrls); // computed for completeness; folded into flow.md via network's own actionSeq === undefined check

  const digests: UIDigest[] = [];
  const diffs: (EvidenceBundle['diffs'][number])[] = [];
  const screenshots: ScreenshotRef[] = [];
  let appMap = emptyAppMap();
  let lastRoute: string | undefined;
  const findings: UiDataFinding[] = [];
  const axIgnoredAll = new Set<string>();

  for (const action of actions) {
    const settle = settleByAction.get(remapSeqOriginal(action, settleResults));
    if (!settle) {
      digests.push(undefined as unknown as UIDigest);
      diffs.push(undefined);
      continue;
    }
    digests.push(settle.digest);
    diffs.push({
      summary: settle.diffSummary,
      collectionChanges: [],
      controlChanges: [],
      routeChanged: lastRoute && lastRoute !== settle.digest.route ? { before: lastRoute, after: settle.digest.route } : undefined,
    });
    if (lastRoute && lastRoute !== settle.digest.route) {
      appMap = recordNavigationEdge(appMap, lastRoute, settle.digest.route);
    }
    lastRoute = settle.digest.route;
    appMap = mergeAppMapNodes(appMap, settle.appMapNodes);
    settle.axIgnoredSelectors.forEach((s) => axIgnoredAll.add(s));
    if (settle.screenshotPath) {
      screenshots.push({ actionSeq: action.seq, phase: 'after', path: settle.screenshotPath, digestHash: settle.digest.digestHash });
    }

    // reconcile + findings for requests attributed to this action
    const actionRequests = network.filter((r) => r.actionSeq === action.seq);
    for (const req of actionRequests) {
      findings.push(
        ...reconcileResponse(req, settle.digest, {
          route: settle.digest.route,
          actionSeq: action.seq,
          screenshotRef: settle.screenshotPath,
          priorDigests: digests.filter(Boolean).slice(0, -1),
        }),
      );
      findings.push(...findTruncatedText(req, settle.digest, settle.digest.route));
    }
    findings.push(...findInaccessibleControls(settle.digest, new Set(settle.axIgnoredSelectors), settle.digest.route));
  }

  const nonEmptyDigests = digests.filter((d): d is UIDigest => !!d);
  findings.push(...findAppMapCandidates(appMap, nonEmptyDigests));

  // Actions whose screenshot is pixel-for-pixel redundant with an earlier
  // one (same digestHash - nothing visually changed) get pointed at that
  // earlier image instead of storing the same bytes again; packageBundle
  // uses the resulting path set to skip writing the dropped duplicates.
  const dedupedScreenshots = dedupeScreenshotRefs(screenshots);
  const dedupedFindings = remapFindingScreenshotRefs(findings, screenshots, dedupedScreenshots);

  return {
    session,
    actions,
    network,
    console: consoleEntries.map((c) => ({ ...c, actionSeq: remapActionSeq(c.actionSeq) })),
    storage: storageDeltas.map((s) => ({ ...s, actionSeq: remapActionSeq(s.actionSeq) })),
    digests,
    diffs,
    screenshots: dedupedScreenshots,
    appMap,
    findings: dedupedFindings,
    redactionReport,
  };
}

/** settleResults are keyed by the *original* live-assigned seq; find the
 * one belonging to this (now renumbered) action. The action's timestamp is
 * the exact key; only evidence recorded before it was stored falls back to
 * the nearest settle in time, which can pair rapid actions with one digest. */
export function remapSeqOriginal(action: ActionRecord, settleResults: SettleResult[]): number {
  const exact = settleResults.find((s) => s.actionT === action.t);
  if (exact) return exact.actionSeq;
  if (settleResults.some((s) => s.actionT !== undefined)) return -1;
  const match = settleResults.find((s) => Math.abs(s.settledAt - action.t) < 20000);
  return match?.actionSeq ?? -1;
}

/** Falls back to the recommended defaults if the user has never opened
 * Settings yet (background/index.ts normally seeds these on install, but
 * export can run in tests/tools without that bootstrap having run). */
async function getEnabledNetworkExclusions(): Promise<Settings['networkExclusions']> {
  const result = (await Browser.storage.sync.get(SyncDataKey.settings)) as SyncData | undefined;
  return result?.settings?.networkExclusions ?? RECOMMENDED_NETWORK_EXCLUSIONS;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export async function packageBundle(bundle: EvidenceBundle): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};

  files['README.md'] = strToU8(renderReadme(bundle));
  files['flow.md'] = strToU8(renderFlow(bundle));
  files['findings.md'] = strToU8(renderFindings(bundle));
  files['summary.json'] = strToU8(renderSummaryJson(bundle));
  // actions.json / network/index.json / ui-state/digests.json are drill-down
  // detail (see README - "not needed to understand the flow"), so they're
  // written compact rather than pretty-printed: nobody reads these by eye,
  // and 2-space indentation on the largest files in the package is pure
  // overhead once flow.md/findings.md already carry the readable summary.
  files['actions.json'] = strToU8(JSON.stringify(bundle.actions));
  // Repeats of the exact same call (a polling GET returning unchanged data,
  // say) keep their own timing/actionSeq/tier on every occurrence - only
  // the repeated headers/body payload collapses to a `sameAs` pointer at
  // the first occurrence that carried it, so no timestamp or log entry is
  // ever dropped, just the duplicated bytes.
  files['network/index.json'] = strToU8(JSON.stringify(serializeNetwork(bundle.network)));
  // curl.sh needs full headers/body on every entry to stay reproducible,
  // so it intentionally reads from bundle.network (undeduped), not the
  // serialized index above.
  files['network/curl.sh'] = strToU8(
    toCurlScript(bundle.network.filter((r) => r.tier !== 'noise')),
  );
  files['console.json'] = strToU8(JSON.stringify(bundle.console, null, 2));
  files['storage.json'] = strToU8(JSON.stringify(bundle.storage, null, 2));
  files['ui-state/digests.json'] = strToU8(
    JSON.stringify(serializeDigests(bundle.actions, bundle.digests)),
  );
  files['app-map.json'] = strToU8(JSON.stringify(bundle.appMap, null, 2));
  files['redaction-report.json'] = strToU8(JSON.stringify(bundle.redactionReport ?? {}, null, 2));

  // bundle.screenshots was already deduped in buildEvidenceBundle (repeats
  // pointed at their canonical path); only paths still referenced by some
  // ScreenshotRef need their bytes written - a stored blob whose path lost
  // out to an earlier duplicate is skipped instead of re-added to the zip.
  const keptScreenshotPaths = new Set(bundle.screenshots.map((s) => s.path));
  const blobs = await getEvidenceBlobsForSession(bundle.session.id);
  for (const { id, blob } of blobs) {
    const path = id.slice(bundle.session.id.length + 1); // strip "<sessionId>/" prefix
    if (path.startsWith('screenshots/') && !keptScreenshotPaths.has(path)) continue;
    files[path] = new Uint8Array(await blob.arrayBuffer());
  }

  // Last, because it lists every other file with its size - the screenshots
  // just added included - so a reader knows what a file costs before opening
  // it, and which schema version the skill's package-format.md describes.
  const sizes: Record<string, number> = {};
  for (const [path, bytes] of Object.entries(files)) sizes[path] = bytes.byteLength;
  files['manifest.json'] = strToU8(renderManifest(bundle, sizes));

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}

export async function cleanupSessionEvidence(sessionId: string): Promise<void> {
  await clearEvidenceForSession(sessionId);
}
