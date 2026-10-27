/**
 * Ties everything together for one recording session: CDP attach/network/
 * console/screenshot/AX, the rrweb event stream (for actions + storage
 * deltas riding as plugin events, and mutations for settle detection),
 * settle-triggered digest/screenshot capture, and buffered persistence
 * into the evidence IndexedDB store. background/index.ts calls into this
 * module rather than implementing any of it inline.
 */
import { nanoid } from 'nanoid';
import Browser from 'webextension-polyfill';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import type Channel from '~/utils/channel';
import { LocalDataKey, ServiceName } from '~/types';
import type { LocalData } from '~/types';
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
import { createAgentClient, type AgentClient, type SocketLike, type StatusUpdate } from '~/agent/client';
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '~/agent/protocol';
import type { SettleResult } from './export/build';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_MAX_BUFFER = 200;
/**
 * Accessibility.getFullAXTree builds Chrome's whole AX tree on the page's
 * main thread and ships it here as JSON. Measured in Chromium: 4k elements
 * blocked the page for ~70ms (4 MB), 14k for ~300ms (14 MB), 42k for ~1s
 * (43 MB) - on a long page, after every action. Past this size the AX
 * cross-check is skipped.
 */
const AX_MAX_ELEMENTS = 4000;

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
  /** AX cross-check for `lastDigest`, reused while the UI is unchanged. */
  lastAxIgnoredSelectors: string[];
  /** Tail of the settle-capture chain; captures run one at a time. */
  captureChain: Promise<void>;
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

/** The live agent for this recording, when playbooks were selected and the backend is reachable. */
let agent: AgentClient | undefined;

async function readAgentConfig(): Promise<AgentConfig> {
  const stored = (await Browser.storage.local.get(LocalDataKey.agentConfig).catch(() => ({}))) as Partial<LocalData>;
  return { ...DEFAULT_AGENT_CONFIG, ...(stored[LocalDataKey.agentConfig] ?? {}) };
}

/**
 * Start the agent without ever delaying or failing the recording: the client
 * buffers events until its socket is up, and a missing backend only shows in
 * the side panel.
 */
async function startAgent(sessionId: string, tabId: number, startedAt: number): Promise<void> {
  // The previous recording's status must not outlive it: the side panel
  // follows whatever session is named here.
  await Browser.storage.local.remove(LocalDataKey.agentStatus).catch(() => undefined);
  try {
    const config = await readAgentConfig();
    if (config.playbooks.length === 0) return;
    const tab = await Browser.tabs.get(tabId).catch(() => undefined);
    const setStatus = (s: StatusUpdate) =>
      void Browser.storage.local.set({ [LocalDataKey.agentStatus]: { sessionId, ...s } }).catch(() => undefined);
    agent = createAgentClient(
      config,
      { sessionId, startedAt, pageOrigin: safeOrigin(tab?.url) },
      {
        createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
        onStatus: setStatus,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        now: Date.now,
      },
    );
  } catch (e) {
    console.warn('[agent] could not start', e);
    agent = undefined;
  }
}

function safeOrigin(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

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
    lastAxIgnoredSelectors: [],
    captureChain: Promise.resolve(),
    redactionReport: {},
    buffers: { action: [], network: [], console: [], storage: [], digest: [] },
    seqCounters: { action: 0, network: 0, console: 0, storage: 0, digest: 0 },
    unsubscribers: [],
    settleWork: [],
  };

  void startAgent(session.id, tabId, session.createTimestamp);

  if (cdpAttached) {
    const s = state;
    s.unsubscribers.push(
      attachNetworkCapture(
        tabId,
        (req) => {
          agent?.sendEvent({ kind: 'network', t: req.endTime ?? Date.now(), payload: req });
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
  // A new recording starts with no open notes (see background/notes.ts).
  await Browser.storage.local.set({ [LocalDataKey.openNotes]: [] }).catch(() => undefined);

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

  const work = captureSettleEvidence(s, seq, action).catch((err: unknown) => {
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

async function captureSettleEvidence(s: State, actionSeq: number, action: ActionRecord) {
  const actionT = action.t;
  const { settledAt, superseded } = await s.settleTracker.waitForSettle(actionT);

  // Captures for a burst of actions (rapid clicks, typing, scrolling) would
  // otherwise all start at once - each superseded wait resolves the instant
  // the next action arrives. Running them one at a time keeps the AX dump
  // and screenshot work from piling up on the recorded page.
  const run = s.captureChain.then(() =>
    captureSettled(s, actionSeq, actionT, settledAt, superseded, action.type === 'scroll'),
  );
  s.captureChain = run.catch(() => undefined);
  await run;
}

async function captureSettled(
  s: State,
  actionSeq: number,
  actionT: number,
  settledAt: number,
  superseded: boolean,
  isScroll: boolean,
) {
  const digestPayload = channelRef
    ? ((await channelRef
        .requestToTab(s.tabId, ServiceName.CaptureDigest, {})
        .catch(() => undefined)) as { digest: UIDigest; appMapNodes: AppMapNode[] } | undefined)
    : undefined;
  if (!digestPayload?.digest) return;

  const uiChanged = s.lastDigest?.digestHash !== digestPayload.digest.digestHash;
  const diff = diffDigests(s.lastDigest, digestPayload.digest);
  s.lastDigest = digestPayload.digest;

  let axIgnoredSelectors = s.lastAxIgnoredSelectors;
  let screenshotPath: string | undefined;

  // A superseded action was interrupted mid-transition by the next one, which
  // gets its own AX check and screenshot once things settle; capturing here
  // too is just extra work on the page for an in-between frame. The cheap,
  // read-only digest above is still kept so every action has one.
  if (!superseded) {
    // Accessibility.getFullAXTree makes Chrome build the whole AX tree on the
    // page's main thread, so only redo it when the UI actually changed, on a
    // page small enough for that to be quick, and not for a scroll: it
    // doesn't change what is accessible, and on an infinite list every
    // scroll changes the UI.
    const pageSize = digestPayload.digest.elementCount ?? 0;
    if (s.cdpAttached && uiChanged && !isScroll && pageSize <= AX_MAX_ELEMENTS) {
      axIgnoredSelectors = Array.from(await captureAxIgnoredSelectors(s.tabId));
      s.lastAxIgnoredSelectors = axIgnoredSelectors;
    }

    const shot = await captureScreenshot(s.tabId, s.windowId);
    if (shot) {
      const path = `screenshots/action-${String(actionSeq).padStart(4, '0')}-after.jpg`;
      await putEvidenceBlob(s.session.id, `${s.session.id}/${path}`, shot);
      screenshotPath = path;
    }
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

  // Ask the agent for its ledger now that the last request has been captured.
  // Whatever happens here, the recording itself is already safe.
  if (agent) {
    const a = agent;
    agent = undefined;
    const result = await a.stop(Date.now()).catch(() => undefined);
    if (result) await appendEvidenceChunk(s.session.id, 'agent', 0, [result]).catch(() => undefined);
  }
  // Notes still open stay open in the export (flagged as such); only the
  // popup's list is cleared. Their events were written as they happened.
  await Browser.storage.local.set({ [LocalDataKey.openNotes]: [] }).catch(() => undefined);

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
