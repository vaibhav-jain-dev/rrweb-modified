import type { eventWithTime } from '@rrweb/types';

export enum SyncDataKey {
  settings = 'settings',
}

export type SyncData = {
  [SyncDataKey.settings]: Settings;
};

/**
 * One rule for excluding network requests from the "pure backend" evidence
 * view - telemetry, static assets, CORS preflights, etc. `pattern` is
 * matched against the request host (or, for the special `method:` prefix,
 * the HTTP method) - see `evidence/network-exclusions.ts` for matching
 * rules. Recommended rules ship enabled by default; the user can toggle
 * (never delete) them, and can add their own custom patterns.
 */
export type NetworkExclusionRule = {
  id: string;
  label: string;
  pattern: string;
  enabled: boolean;
  /** Built-in rules can be toggled but not removed from the list. */
  builtin?: boolean;
};

export type Settings = {
  networkExclusions?: NetworkExclusionRule[];
};

export enum LocalDataKey {
  recorderStatus = 'recorder_status',
  evidenceConfig = 'evidence_config',
}

export type LocalData = {
  [LocalDataKey.recorderStatus]: {
    status: RecorderStatus;
    activeTabId: number;
    startTimestamp?: number;
    // the timestamp when the recording is paused
    pausedTimestamp?: number;
    errorMessage?: string; // error message when recording failed
    // id of the session currently being written to IndexedDB. Present for
    // the whole RECORDING lifetime so a service worker that gets evicted
    // and restarted mid-recording knows which session to keep appending
    // event chunks to, instead of losing track of it.
    sessionId?: string;
    // Whether network/console/screenshots are coming from chrome.debugger
    // (CDP) or the in-page fallback path - see EvidenceCaptureConfig.
    // Surfaced in the popup so it's obvious which capture fidelity is
    // active for this recording.
    captureMode?: 'cdp' | 'fallback';
  };
  // Set by the background script right before it asks a tab to start
  // recording. Read by content/index.ts (both the top page and any
  // cross-origin iframes, which only learn to start via this storage
  // area, not a direct message) so every frame's inject.ts gets the same
  // capture configuration for this session.
  [LocalDataKey.evidenceConfig]: EvidenceCaptureConfig;
};

export enum RecorderStatus {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED',
  // when user change the tab, the recorder will be paused during the tab change
  PausedSwitch = 'PAUSED_SWITCH',
}

export type Session = {
  id: string;
  name: string;
  tags: string[];
  createTimestamp: number;
  modifyTimestamp: number;
  recorderVersion: string;
};

// all service names for channel
export enum ServiceName {
  StartRecord = 'start-record',
  StopRecord = 'stop-record',
  CaptureDigest = 'capture-digest',
}

// all event names for channel
export enum EventName {
  SessionUpdated = 'session-updated',
  ContentScriptEmitEvent = 'content-script-emit-event',
  StartButtonClicked = 'start-recording-button-clicked',
  StopButtonClicked = 'stop-recording-button-clicked',
  PauseButtonClicked = 'pause-recording-button-clicked',
  ResumeButtonClicked = 'resume-recording-button-clicked',
}

// all message names for postMessage API
export enum MessageName {
  RecordScriptReady = 'rrweb-extension-record-script-ready',
  StartRecord = 'rrweb-extension-start-record',
  RecordStarted = 'rrweb-extension-record-started',
  StopRecord = 'rrweb-extension-stop-record',
  RecordStopped = 'rrweb-extension-record-stopped',
  EmitEvent = 'rrweb-extension-emit-event',
  CaptureDigestRequest = 'rrweb-extension-capture-digest-request',
  CaptureDigestResponse = 'rrweb-extension-capture-digest-response',
}

export type RecordStartedMessage = {
  message: MessageName.RecordStarted;
  startTimestamp: number;
};

/**
 * Evidence-capture options layered on top of rrweb's own `recordOptions`,
 * carried alongside them in the StartRecord postMessage payload from
 * content/index.ts to content/inject.ts. Kept separate from rrweb's own
 * options because these configure our own plugins, not rrweb core.
 */
export type EvidenceCaptureConfig = {
  /** Selectors whose matching inputs are always fully masked, in addition
   * to the built-in credential-shaped denylist. */
  maskSelectors?: string[];
  /**
   * Whether to run the in-page fetch/XHR network-record plugin. Left off
   * when the background script has a working `chrome.debugger` (CDP)
   * attachment, which is the preferred network source; turned on as a
   * fallback when CDP could not attach (DevTools already open, a
   * chrome:// page, or the user declined the debugger banner).
   */
  useFallbackNetwork?: boolean;
};

export type RecordStoppedMessage = {
  message: MessageName.RecordStopped;
  endTimestamp: number;
};

export type EmitEventMessage = {
  message: MessageName.EmitEvent;
  event: eventWithTime;
};

export type CaptureDigestRequestMessage = {
  message: MessageName.CaptureDigestRequest;
  requestId: string;
};

/** `digest`/`appMapNodes` are `UIDigest`/`AppMapNode[]` from
 * `~/evidence/types` - typed loosely here to avoid a circular import
 * between types.ts and evidence/types.ts. */
export type CaptureDigestResponseMessage = {
  message: MessageName.CaptureDigestResponse;
  requestId: string;
  digest: unknown;
  appMapNodes: unknown[];
};
