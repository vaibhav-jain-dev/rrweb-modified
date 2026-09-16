import Browser from 'webextension-polyfill';
import type { eventWithTime } from '@rrweb/types';
import Channel from '~/utils/channel';
import {
  EventName,
  LocalDataKey,
  MessageName,
  RecorderStatus,
  ServiceName,
  SyncDataKey,
} from '~/types';
import type {
  LocalData,
  RecordStartedMessage,
  RecordStoppedMessage,
  Session,
  Settings,
  SyncData,
} from '~/types';
import {
  appendEventChunk,
  createSession,
  finalizeSession,
  getSession,
} from '~/utils/storage';
import {
  currentCaptureMode,
  handleEmittedEvent,
  initOrchestrator,
  startOrchestration,
  stopOrchestration,
} from './orchestrator';
import { buildEvidenceBundle, cleanupSessionEvidence, packageBundle } from './export/build';
import { RECOMMENDED_NETWORK_EXCLUSIONS } from '~/evidence/network-exclusions';

/**
 * IMPORTANT (MV3 service worker lifecycle):
 *
 * Every listener below is registered SYNCHRONOUSLY, at the top level of
 * this module, before any `await`. Chrome only guarantees that a listener
 * added during the *first* synchronous execution turn of the service
 * worker will reliably receive events that woke the worker up. A listener
 * registered after an `await` (as this file used to do, inside a single
 * top-level `void (async () => {...})()`) can miss the very message that
 * woke the worker - see
 * https://developer.chrome.com/docs/extensions/mv3/service_workers/events/#registration
 *
 * Recording state (`recorderStatus`) is also no longer reset to IDLE
 * unconditionally on every worker start. This module used to do that
 * unconditionally, on the theory that "the extension was reloaded". But an
 * MV3 worker doesn't only start on install/reload - it restarts constantly
 * during a long recording, every time Chrome evicts it for being idle
 * (commonly ~30s). Resetting to IDLE on every one of those restarts would
 * silently end an in-progress recording without the user doing anything.
 * Instead, the persisted status in `Browser.storage.local` is treated as
 * the source of truth and rehydrated; the in-memory `recorderStatus`
 * variable below is a cache of it, valid for the lifetime of this worker
 * instance, not the lifetime of the recording.
 */

const channel = new Channel();
initOrchestrator(channel);

let recorderStatus: LocalData[LocalDataKey.recorderStatus] = {
  status: RecorderStatus.IDLE,
  activeTabId: -1,
};

/**
 * Race guards for StartButtonClicked/StopButtonClicked.
 *
 * Both handlers check `recorderStatus.status` once at the top, then run a
 * long chain of `await`s (chrome.debugger.attach, IndexedDB writes,
 * content-script round trips) before finally writing the new status back.
 * If a second identical message arrives during that window - a
 * double-click before the popup button disables itself, or a duplicate
 * message replayed after a service worker restart - the second
 * invocation reads the same stale `recorderStatus.status` and proceeds
 * too, since nothing has updated it yet. Two concurrent
 * `startOrchestration()` calls then race: the second tears down the
 * first mid-setup (see its own `if (state) await stopOrchestration()`
 * guard), silently orphaning the first session's IndexedDB chunks and
 * losing its `chrome.debugger` attach.
 *
 * These booleans are set synchronously, before the first `await` in each
 * handler, so a re-entrant call is rejected immediately rather than
 * racing on an object field that hasn't been written back yet.
 */
let starting = false;
let stopping = false;

async function setRecorderStatus(
  next: LocalData[LocalDataKey.recorderStatus],
) {
  recorderStatus = next;
  await Browser.storage.local.set({
    [LocalDataKey.recorderStatus]: recorderStatus,
  });
}

/**
 * Buffers events for the currently recording tab and flushes them to
 * IndexedDB in small, frequent chunks instead of holding the entire
 * recording in this worker's memory until Stop is pressed. If the worker
 * is evicted between flushes, at most one chunk's worth of events (a few
 * hundred milliseconds) is lost - not the whole session.
 */
const FLUSH_INTERVAL_MS = 250;
const FLUSH_MAX_BUFFER = 100;
let eventBuffer: eventWithTime[] = [];
let flushSeq = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
}

async function flushEvents() {
  if (eventBuffer.length === 0) return;
  if (!recorderStatus.sessionId) return;
  const toFlush = eventBuffer;
  eventBuffer = [];
  await appendEventChunk(recorderStatus.sessionId, flushSeq++, toFlush).catch(
    () => {
      // Persisting failed (e.g. IndexedDB quota); put the events back so a
      // later flush can retry rather than silently dropping them.
      eventBuffer = toFlush.concat(eventBuffer);
    },
  );
}

/**
 * Register everything below synchronously. Async setup work (hydrating
 * settings, hydrating recorder status) happens in fire-and-forget async
 * functions that don't gate registration.
 */

void (async () => {
  const result =
    ((await Browser.storage.sync.get(SyncDataKey.settings)) as SyncData) ||
    undefined;
  const defaultSettings: Settings = {
    networkExclusions: RECOMMENDED_NETWORK_EXCLUSIONS,
  };
  let settings = defaultSettings;
  if (result && result.settings) {
    setDefaultSettings(result.settings, defaultSettings);
    settings = result.settings;
  }
  await Browser.storage.sync.set({
    settings,
  } as SyncData);
})();

void (async () => {
  const stored = (await Browser.storage.local.get(
    LocalDataKey.recorderStatus,
  )) as LocalData | undefined;
  const persisted = stored?.[LocalDataKey.recorderStatus];
  if (persisted) {
    // Rehydrate rather than reset - see the module-level comment above.
    recorderStatus = persisted;
  } else {
    // First run ever: nothing persisted yet, IDLE is the correct default.
    await setRecorderStatus({ status: RecorderStatus.IDLE, activeTabId: -1 });
  }
})();

channel.on(EventName.StartButtonClicked, async () => {
  // Set synchronously, before any `await` below, so a second
  // StartButtonClicked message that arrives while this one is still in
  // flight is rejected here rather than also passing the
  // `recorderStatus.status` check (which isn't written back to
  // RECORDING until the very end of this handler). See the comment on
  // `starting`/`stopping` above for the full race this closes.
  if (recorderStatus.status !== RecorderStatus.IDLE || starting) return;
  starting = true;
  try {
    const tabs = await Browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || tab.windowId === undefined) return;
    const tabId = tab.id;

    // Attach chrome.debugger (CDP) before asking the content script to
    // start: whether it succeeds determines `useFallbackNetwork` below, and
    // the content script's plugin list is fixed for the life of this
    // recording, so this ordering matters - see docs on
    // EvidenceCaptureConfig in ~/types.
    const evidenceSession = await startOrchestration(tabId, tab.windowId);

    // With CDP attached, the in-page fetch/XHR plugin would double-count
    // every request (once via CDP, once via the page patch), so it only
    // runs as a fallback when CDP could not attach.
    await Browser.storage.local.set({
      [LocalDataKey.evidenceConfig]: {
        useFallbackNetwork: currentCaptureMode() !== 'cdp',
        maskSelectors: [],
      },
    });

    const res = (await channel
      .requestToTab(tabId, ServiceName.StartRecord, {})
      .catch(async (error: Error) => {
        await stopOrchestration().catch(() => undefined);
        await setRecorderStatus({
          ...recorderStatus,
          errorMessage: error.message,
        });
      })) as RecordStartedMessage;
    if (!res) return;

    // The raw rrweb event stream (used by the session list / player) and
    // the evidence bundle share one session id, so the two views of the
    // same recording line up under one identifier end to end.
    const session: Session = {
      id: evidenceSession.id,
      name: evidenceSession.name,
      tags: [],
      createTimestamp: evidenceSession.createTimestamp,
      modifyTimestamp: evidenceSession.modifyTimestamp,
      recorderVersion: evidenceSession.recorderVersion,
    };
    eventBuffer = [];
    flushSeq = 0;
    await createSession(session);

    await setRecorderStatus({
      status: RecorderStatus.RECORDING,
      activeTabId: tabId,
      startTimestamp: res.startTimestamp,
      sessionId: session.id,
      captureMode: evidenceSession.captureMode,
    });
  } finally {
    starting = false;
  }
});

channel.on(EventName.StopButtonClicked, async () => {
  // Same synchronous-guard reasoning as `starting` above: `recorderStatus`
  // isn't written back to IDLE until after the StopRecord round trip and
  // `flushEvents()` below, both of which await. A second StopButtonClicked
  // arriving in that window would otherwise also pass the status check
  // and run `stopOrchestration()` a second time concurrently.
  if (recorderStatus.status === RecorderStatus.IDLE || stopping) return;
  stopping = true;
  try {
    if (recorderStatus.status === RecorderStatus.RECORDING)
      (await channel
        .requestToTab(recorderStatus.activeTabId, ServiceName.StopRecord, {})
        .catch(() => ({
          message: MessageName.RecordStopped,
          endTimestamp: Date.now(),
        }))) as RecordStoppedMessage;

    await flushEvents();

    const sessionId = recorderStatus.sessionId;
    await setRecorderStatus({ status: RecorderStatus.IDLE, activeTabId: -1 });

    const evidenceSession = await stopOrchestration();

    if (sessionId) {
      const title =
        (await Browser.tabs
          .query({ active: true, currentWindow: true })
          .then((tabs) => tabs[0]?.title)
          .catch(() => {
            // ignore error
          })) ?? 'new session';
      const finishedSession = await renameSession(sessionId, title);
      await finalizeSession(finishedSession).catch(async (e) => {
        await setRecorderStatus({
          ...recorderStatus,
          errorMessage: (e as { message: string }).message,
        });
      });
      channel.emit(EventName.SessionUpdated, {
        session: finishedSession,
      });

      if (evidenceSession) {
        await downloadEvidencePackage({ ...evidenceSession, name: title }).catch(
          async (e) => {
            // A failed export must not look like the whole recording
            // failed - the raw session above was saved successfully
            // regardless, and is still reachable from the session list.
            await setRecorderStatus({
              ...recorderStatus,
              errorMessage: `Recording saved, but building the evidence package failed: ${(e as { message: string }).message}`,
            });
          },
        );
      }
    }
  } finally {
    stopping = false;
  }
});

channel.on(EventName.PauseButtonClicked, async () => {
  if (recorderStatus.status !== RecorderStatus.RECORDING) return;
  await flushEvents();
  const stopResponse = (await channel
    .requestToTab(recorderStatus.activeTabId, ServiceName.StopRecord, {})
    .catch(() => {
      // ignore error
    })) as RecordStoppedMessage | undefined;
  await setRecorderStatus({
    ...recorderStatus,
    status: RecorderStatus.PAUSED,
    pausedTimestamp: stopResponse?.endTimestamp ?? Date.now(),
  });
});

channel.on(EventName.ResumeButtonClicked, async () => {
  if (recorderStatus.status !== RecorderStatus.PAUSED) return;
  const tabId = await channel.getCurrentTabId();
  if (tabId === -1) return;
  const { startTimestamp, pausedTimestamp } = recorderStatus;
  const pausedTime = pausedTimestamp ? Date.now() - pausedTimestamp : 0;

  const startResponse = (await channel
    .requestToTab(tabId, ServiceName.StartRecord, {})
    .catch(async (e: { message: string }) => {
      await setRecorderStatus({ ...recorderStatus, errorMessage: e.message });
    })) as RecordStartedMessage | undefined;
  if (!startResponse) return;

  await setRecorderStatus({
    ...recorderStatus,
    status: RecorderStatus.RECORDING,
    activeTabId: tabId,
    errorMessage: undefined,
    startTimestamp: (startTimestamp ?? Date.now()) + pausedTime,
    pausedTimestamp: undefined,
  });
});

channel.on(EventName.ContentScriptEmitEvent, (data) => {
  if (recorderStatus.status !== RecorderStatus.RECORDING) return;
  const event = data as eventWithTime;
  eventBuffer.push(event);
  if (eventBuffer.length >= FLUSH_MAX_BUFFER) void flushEvents();
  else scheduleFlush();
  // In addition to (not instead of) the raw-stream persistence above:
  // extracts actions/storage deltas from plugin events and feeds
  // mutation events to the settle detector.
  handleEmittedEvent(event);
});

/**
 * Assemble this session's evidence bundle, zip it, and hand it to
 * chrome.downloads. Kept separate from the Stop handler above so a
 * failure here (e.g. IndexedDB quota, a malformed digest) is caught on
 * its own and doesn't look like the whole recording failed.
 */
/**
 * MV3 extension service workers have no `URL.createObjectURL` (verified
 * live: it throws "URL.createObjectURL is not a function" in this exact
 * context, unlike a regular extension page/document) - the usual way to
 * hand a Blob to `chrome.downloads.download()`. Rather than spin up an
 * offscreen document just to create a blob: URL, this encodes the zip as
 * a `data:` URL directly, entirely with SW-safe APIs (`Blob.arrayBuffer`
 * is available in service workers; `URL.createObjectURL` is not).
 * Base64-encoded in chunks to avoid blowing the call stack on
 * `String.fromCharCode(...bigArray)` for a multi-MB zip.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function downloadEvidencePackage(evidenceSession: {
  id: string;
  name: string;
  createTimestamp: number;
  modifyTimestamp: number;
  recorderVersion: string;
  captureMode: 'cdp' | 'fallback';
}) {
  const bundle = await buildEvidenceBundle(evidenceSession);
  const blob = await packageBundle(bundle);
  const url = await blobToDataUrl(blob);
  const slug = evidenceSession.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const timestamp = new Date(evidenceSession.createTimestamp)
    .toISOString()
    .replace(/[:.]/g, '-');
  await Browser.downloads.download({
    url,
    filename: `recording-${slug || 'session'}-${timestamp}.zip`,
    saveAs: false,
  });
  await cleanupSessionEvidence(evidenceSession.id);
}

/**
 * Recording is anchored to the tab it started on. Unlike the previous
 * behaviour (pause on tab switch, resume by moving the recorder into
 * whichever tab became active, rewriting every buffered event's
 * `timestamp` to paper over the gap), switching to a different tab no
 * longer touches the recording at all: it keeps recording the original
 * tab in the background. Rewriting timestamps made wall-clock time
 * unreliable, which would have corrupted every action/network
 * correlation window built on top of this event stream.
 *
 * If the recording tab itself is closed, the recording is stopped and
 * finalized rather than left dangling.
 */
Browser.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    // Same guard as StopButtonClicked, and for the same reason: this is
    // a second, independent path that can reach `stopOrchestration()` -
    // e.g. the user clicks Stop at the same moment the recording tab is
    // closed. Sharing the `stopping` flag makes the two paths mutually
    // exclusive instead of racing each other.
    if (
      recorderStatus.activeTabId !== tabId ||
      recorderStatus.status !== RecorderStatus.RECORDING ||
      stopping
    )
      return;
    stopping = true;
    try {
      await flushEvents();
      const evidenceSession = await stopOrchestration();
      const sessionId = recorderStatus.sessionId;
      await setRecorderStatus({ status: RecorderStatus.IDLE, activeTabId: -1 });
      if (sessionId) {
        const finishedSession = await renameSession(
          sessionId,
          'recording (tab closed)',
        );
        await finalizeSession(finishedSession).catch(() => {
          // best effort - the chunks remain in IndexedDB even if this fails
        });
        channel.emit(EventName.SessionUpdated, { session: finishedSession });
        if (evidenceSession) {
          await downloadEvidencePackage({
            ...evidenceSession,
            name: 'recording (tab closed)',
          }).catch(() => {
            // best effort here too - the raw session above is still saved
          });
        }
      }
    } finally {
      stopping = false;
    }
  })();
});

/**
 * Update existed settings with new settings.
 * Set new setting values if these properties don't exist in older versions.
 */
function setDefaultSettings(
  existedSettings: Record<string, unknown>,
  newSettings: Record<string, unknown>,
) {
  for (const i in newSettings) {
    // settings[i] contains key-value settings
    if (
      typeof newSettings[i] === 'object' &&
      !(newSettings[i] instanceof Array) &&
      Object.keys(newSettings[i] as Record<string, unknown>).length > 0
    ) {
      if (existedSettings[i]) {
        setDefaultSettings(
          existedSettings[i] as Record<string, unknown>,
          newSettings[i] as Record<string, unknown>,
        );
      } else {
        // settings[i] contains several setting items but these have not been set before
        existedSettings[i] = newSettings[i];
      }
    } else if (existedSettings[i] === undefined) {
      // settings[i] is a single setting item and it has not been set before
      existedSettings[i] = newSettings[i];
    }
  }
}

/**
 * Build the final session document for a recording that started with
 * `createSession()` at Start time. Preserves the original `createTimestamp`
 * (when the recording started, not when it finished) so the session list's
 * default sort reflects actual recording order.
 */
async function renameSession(id: string, title: string): Promise<Session> {
  const existing = await getSession(id).catch(() => undefined);
  return {
    id,
    name: title,
    tags: existing?.tags ?? [],
    createTimestamp: existing?.createTimestamp ?? Date.now(),
    modifyTimestamp: Date.now(),
    recorderVersion: Browser.runtime.getManifest().version_name || 'unknown',
  };
}
