/**
 * Ties everything together for one recording session: CDP attach/network/
 * console/screenshot/AX, the rrweb event stream (for actions + storage
 * deltas riding as plugin events, and mutations for settle detection),
 * settle-triggered digest/screenshot capture, and buffered persistence
 * into the evidence IndexedDB store. background/index.ts calls into this
 * module rather than implementing any of it inline.
 */
import { nanoid } from 'nanoid';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import type Channel from '~/utils/channel';
import { ServiceName } from '~/types';
import { attachDebugger, detachDebugger, isAttached } from './cdp/attach';
import { attachNetworkCapture } from './cdp/network';
import { attachConsoleCapture } from './cdp/console';
import { captureScreenshot } from './cdp/screenshot';
import { captureAxIgnoredSelectors } from './cdp/ax';
import { createSettleTracker, type SettleTracker } from './settle';
import { diffDigests } from '~/evidence/digest';
import { INTERACTION_PLUGIN_NAME, STORAGE_PLUGIN_NAME } from '~/evidence/plugin-names';
import type { RedactionReport } from '~/evidence/redact';
import type {
  ActionRecord,
  AppMapNode,
  ConsoleRecord,
  EvidenceSession,
  NetworkRequest,
  StorageDelta,
  UIDigest,
} from '~/evidence/types';
import { appendEvidenceChunk, putEvidenceBlob } from '~/utils/storage';
import type { SettleResult } from './export/build';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_MAX_BUFFER = 200;

let channelRef: Channel | undefined;
export function initOrchestrator(channel: Channel) {
  channelRef = channel;
}

type State = {
  tabId: number;
  windowId: number;
  session: EvidenceSession;
  cdpAttached: boolean;
  settleTracker: SettleTracker;
  actionSeqCounter: number;
  lastDigest?: UIDigest;
  redactionReport: RedactionReport;
  buffers: {
    action: ActionRecord[];
    network: NetworkRequest[];
    console: ConsoleRecord[];
    storage: StorageDelta[];
    digest: SettleResult[];
  };
  seqCounters: { action: number; network: number; console: number; storage: number; digest: number };
  flushTimer?: ReturnType<typeof setInterval>;
  unsubscribers: (() => void)[];
  settleWork: Promise<void>[];
};

let state: State | undefined;

export async function startOrchestration(
  tabId: number,
  windowId: number,
): Promise<EvidenceSession> {
  if (state) await stopOrchestration();

  const cdpAttached = await attachDebugger(tabId);

  const session: EvidenceSession = {
    id: nanoid(),
    name: 'recording…',
    createTimestamp: Date.now(),
    modifyTimestamp: Date.now(),
    recorderVersion: 'evidence/1',
    captureMode: cdpAttached ? 'cdp' : 'fallback',
  };

  const settleTracker = createSettleTracker();

  state = {
    tabId,
    windowId,
    session,
    cdpAttached,
    settleTracker,
    actionSeqCounter: 0,
    redactionReport: {},
    buffers: { action: [], network: [], console: [], storage: [], digest: [] },
    seqCounters: { action: 0, network: 0, console: 0, storage: 0, digest: 0 },
    unsubscribers: [],
    settleWork: [],
  };

  if (cdpAttached) {
    const s = state;
    s.unsubscribers.push(
      attachNetworkCapture(
        tabId,
        (req) => {
          s.buffers.network.push(req);
          s.settleTracker.noteRequestEnd();
          maybeEagerFlush(s);
        },
        s.redactionReport,
      ),
    );
    s.unsubscribers.push(
      attachConsoleCapture(
        tabId,
        (entry) => {
          s.buffers.console.push(entry);
          maybeEagerFlush(s);
        },
        s.redactionReport,
      ),
    );
  }

  state.flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);

  return session;
}

/**
 * Called from background/index.ts's ContentScriptEmitEvent handler for
 * every rrweb event, in addition to (not instead of) that handler's own
 * raw-stream persistence. Recognizes three shapes: our interaction/storage
 * plugin events, and core Mutation incremental-snapshot events (used only
 * as a settle-detection quiet signal, never persisted themselves - the
 * raw stream already has them).
 */
export function handleEmittedEvent(event: eventWithTime): void {
  if (!state) return;
  const s = state;

  if (event.type === EventType.Plugin) {
    const { plugin, payload } = event.data;
    if (plugin === INTERACTION_PLUGIN_NAME) {
      const action = payload as ActionRecord;
      onActionDetected(s, action);
      return;
    }
    if (plugin === STORAGE_PLUGIN_NAME) {
      const delta = payload as StorageDelta;
      delta.actionSeq = s.actionSeqCounter > 0 ? s.actionSeqCounter - 1 : undefined;
      s.buffers.storage.push(delta);
      maybeEagerFlush(s);
      return;
    }
    return;
  }

  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Mutation
  ) {
    s.settleTracker.noteMutation();
  }
}

function onActionDetected(s: State, action: ActionRecord) {
  const seq = s.actionSeqCounter++;
  action.seq = seq;
  action.page.tabId = s.tabId;
  s.buffers.action.push(action);
  maybeEagerFlush(s);

  const work = captureSettleEvidence(s, seq, action.t).catch((err: unknown) => {
    console.warn('[evidence] settle capture failed', err);
  });
  s.settleWork.push(work);
}

/** The 500ms interval flush is the common case; a burst of activity
 * (rapid clicks, a chatty console, a page full of storage writes) can
 * outrun that, so also flush eagerly once any buffer gets large, same
 * idea as `FLUSH_MAX_BUFFER` in background/index.ts's raw event sink. */
function maybeEagerFlush(s: State) {
  const total =
    s.buffers.action.length +
    s.buffers.network.length +
    s.buffers.console.length +
    s.buffers.storage.length +
    s.buffers.digest.length;
  if (total >= FLUSH_MAX_BUFFER) void flush();
}

async function captureSettleEvidence(s: State, actionSeq: number, actionT: number) {
  const { settledAt } = await s.settleTracker.waitForSettle(actionT);

  const digestPayload = channelRef
    ? ((await channelRef
        .requestToTab(s.tabId, ServiceName.CaptureDigest, {})
        .catch(() => undefined)) as { digest: UIDigest; appMapNodes: AppMapNode[] } | undefined)
    : undefined;
  if (!digestPayload?.digest) return;

  const diff = diffDigests(s.lastDigest, digestPayload.digest);
  s.lastDigest = digestPayload.digest;

  let axIgnoredSelectors: string[] = [];
  let screenshotPath: string | undefined;

  if (s.cdpAttached) {
    axIgnoredSelectors = Array.from(await captureAxIgnoredSelectors(s.tabId));
  }

  // captureScreenshot tries CDP first and falls back to
  // chrome.tabs.captureVisibleTab internally - no branch needed here.
  const shot = await captureScreenshot(s.tabId, s.windowId);
  if (shot) {
    const path = `screenshots/action-${String(actionSeq).padStart(4, '0')}-after.jpg`;
    await putEvidenceBlob(s.session.id, `${s.session.id}/${path}`, shot.blob);
    screenshotPath = path;
  }

  s.buffers.digest.push({
    actionSeq,
    // The action's own timestamp, so export pairs this digest with exactly
    // that action rather than the nearest one in time - rapid clicks used
    // to share one digest and one screenshot that way.
    actionT,
    settledAt,
    digest: digestPayload.digest,
    diffSummary: diff.summary,
    axIgnoredSelectors,
    appMapNodes: digestPayload.appMapNodes ?? [],
    screenshotPath,
  });
}

async function flush() {
  if (!state) return;
  const s = state;
  const { buffers, seqCounters } = s;

  const jobs: Promise<unknown>[] = [];
  if (buffers.action.length) {
    jobs.push(appendEvidenceChunk(s.session.id, 'action', seqCounters.action++, buffers.action.splice(0)));
  }
  if (buffers.network.length) {
    jobs.push(appendEvidenceChunk(s.session.id, 'network', seqCounters.network++, buffers.network.splice(0)));
  }
  if (buffers.console.length) {
    jobs.push(appendEvidenceChunk(s.session.id, 'console', seqCounters.console++, buffers.console.splice(0)));
  }
  if (buffers.storage.length) {
    jobs.push(appendEvidenceChunk(s.session.id, 'storage', seqCounters.storage++, buffers.storage.splice(0)));
  }
  if (buffers.digest.length) {
    jobs.push(appendEvidenceChunk(s.session.id, 'digest', seqCounters.digest++, buffers.digest.splice(0)));
  }
  await Promise.all(jobs);
}

export function isOrchestrating(): boolean {
  return !!state;
}

export function currentCaptureMode(): 'cdp' | 'fallback' | undefined {
  return state?.session.captureMode;
}

export async function stopOrchestration(): Promise<EvidenceSession | undefined> {
  if (!state) return undefined;
  const s = state;
  state = undefined;

  if (s.flushTimer !== undefined) clearInterval(s.flushTimer);
  s.settleTracker.dispose();

  // let any in-flight settle captures (digest/screenshot requests) finish
  // rather than dropping the last action's evidence
  await Promise.race([Promise.all(s.settleWork), sleep(4000)]);

  s.unsubscribers.forEach((fn) => fn());
  if (isAttached(s.tabId)) await detachDebugger(s.tabId);

  await flushState(s);

  // The redaction tally lives only in memory until here. Persisting it is
  // what lets the export say what was removed and why (redaction-report.json)
  // rather than leaving a reader to guess what a [REDACTED:*] marker cost.
  await appendEvidenceChunk(s.session.id, 'redaction', 0, [s.redactionReport]);

  return { ...s.session, modifyTimestamp: Date.now() };
}

async function flushState(s: State) {
  const jobs: Promise<unknown>[] = [];
  if (s.buffers.action.length)
    jobs.push(appendEvidenceChunk(s.session.id, 'action', s.seqCounters.action++, s.buffers.action));
  if (s.buffers.network.length)
    jobs.push(appendEvidenceChunk(s.session.id, 'network', s.seqCounters.network++, s.buffers.network));
  if (s.buffers.console.length)
    jobs.push(appendEvidenceChunk(s.session.id, 'console', s.seqCounters.console++, s.buffers.console));
  if (s.buffers.storage.length)
    jobs.push(appendEvidenceChunk(s.session.id, 'storage', s.seqCounters.storage++, s.buffers.storage));
  if (s.buffers.digest.length)
    jobs.push(appendEvidenceChunk(s.session.id, 'digest', s.seqCounters.digest++, s.buffers.digest));
  await Promise.all(jobs);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
