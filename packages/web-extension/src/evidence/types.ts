/**
 * Pure data types for the evidence/UX-audit layer. Nothing in this file
 * imports `chrome.*`/`Browser.*` - it is plain data, shared between the
 * background service worker (which populates it), the content-script
 * plugins (which produce some of it), and `render.ts` (which turns it into
 * the exported package).
 */

export type Redacted<T = string> = T | { redacted: true; reason: string };

export type PageRef = {
  url: string;
  route: string;
  title: string;
  tabId: number;
  frameId: number;
  frameUrl?: string;
};

export type TargetInfo = {
  /** node id from rrweb's mirror - links this action to raw/events.json */
  rrwebId?: number;
  selector: string;
  selectorCandidates: string[];
  /** Playwright-style locator, e.g. role=button[name="Approve"] */
  locator: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  attrs: Record<string, string>;
  box?: { x: number; y: number; w: number; h: number };
  coords?: { x: number; y: number };
};

export type ActionType =
  | 'click'
  | 'dblclick'
  | 'input'
  | 'key'
  | 'select'
  | 'toggle'
  | 'submit'
  | 'scroll'
  | 'navigate'
  | 'reload'
  | 'back'
  | 'forward'
  | 'redirect'
  | 'tab-open'
  | 'tab-close';

export type ActionRecord = {
  seq: number;
  t: number;
  type: ActionType;
  page: PageRef;
  target?: TargetInfo;
  value?: string;
  keystrokes?: number;
};

export type NetworkRequest = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string | null;
  responseBody?: string | null;
  bodyTruncated?: boolean;
  startTime: number;
  endTime?: number;
  duration?: number;
  failed?: boolean;
  errorText?: string;
  initiator?: { type: string; stack?: string[] };
  /** which action window this request was attributed to, if any */
  actionSeq?: number;
  ambiguous?: boolean;
  completedAfterSettle?: boolean;
  tier?: 'primary' | 'secondary' | 'noise';
};

export type ConsoleRecord = {
  t: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source: 'console' | 'exception' | 'unhandledrejection' | 'browser-log';
  stack?: string[];
  actionSeq?: number;
};

export type StorageDelta = {
  t: number;
  area: 'local' | 'session';
  key: string;
  op: 'set' | 'remove' | 'clear';
  value?: Redacted;
  actionSeq?: number;
};

export type CollectionInfo = {
  key: string;
  selector: string;
  label?: string;
  count: number;
  columns?: string[];
  fieldSelectors?: Record<string, string>;
  sampleRows?: string[][];
  rowKeyHint?: string;
};

export type ControlInfo = {
  selector: string;
  role: string;
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  state: VisibilityState;
};

export type VisibilityState =
  | 'visible-usable'
  | 'visible-disabled'
  | 'dom-only-hidden'
  | 'ax-ignored';

export type UIDigest = {
  url: string;
  route: string;
  title: string;
  capturedAt: number;
  headings: string[];
  landmarks: { role: string; name?: string }[];
  collections: CollectionInfo[];
  controls: ControlInfo[];
  status: { role: 'alert' | 'status' | 'dialog' | 'toast'; text: string }[];
  counters: Record<string, number>;
  textAtoms: string[];
  hiddenAtoms: string[];
  digestHash: string;
};

export type UIDiff = {
  summary: string[];
  collectionChanges: {
    key: string;
    label?: string;
    countBefore?: number;
    countAfter?: number;
  }[];
  controlChanges: { selector: string; label: string; before?: string; after?: string }[];
  routeChanged?: { before: string; after: string };
};

export type AppMapNodeKind =
  | 'route'
  | 'nav-item'
  | 'tab'
  | 'nested-tab'
  | 'dialog'
  | 'drawer'
  | 'table'
  | 'list'
  | 'filter'
  | 'pagination'
  | 'major-state';

export type AppMapNode = {
  kind: AppMapNodeKind;
  id: string;
  label?: string;
  accessibleName?: string;
  selector: string;
  parentId?: string;
  route: string;
  firstSeenAction: number;
  states: VisibilityState[];
  reachedBy?: number;
};

export type AppMapEdge = { from: string; to: string; via: 'click' | 'nav' | 'route' };

export type AppMap = { nodes: AppMapNode[]; edges: AppMapEdge[] };

export type FindingKind =
  | 'count_mismatch'
  | 'missing_in_ui'
  | 'hidden_in_ui'
  | 'value_mismatch'
  | 'stale_in_ui'
  | 'not_focusable'
  | 'truncated'
  | 'unreachable_nav'
  | 'hidden_tab'
  | 'incomplete_table'
  | 'missing_pagination'
  | 'missing_filter_control'
  | 'api_field_no_ui'
  | 'inaccessible_control'
  | 'inconsistent_state';

export type UiDataFinding = {
  kind: FindingKind;
  /** never phrased as a verdict - always a candidate for the agent to verify */
  summary: string;
  evidence: {
    route?: string;
    actionSeq?: number;
    selector?: string;
    jsonPath?: string;
    screenshotRef?: string;
    apiValue?: unknown;
    uiValue?: unknown;
    /** `METHOD /templated/path` of the response a data finding came from,
     * so findings.md can group by endpoint rather than list one entry per
     * field. */
    endpoint?: string;
  };
  howToVerify: string;
};

export type ScreenshotRef = {
  actionSeq: number;
  phase: 'before' | 'after';
  path: string;
  digestHash?: string;
  dedupedFrom?: string;
};

export type EvidenceSession = {
  id: string;
  name: string;
  createTimestamp: number;
  modifyTimestamp: number;
  recorderVersion: string;
  captureMode: 'cdp' | 'fallback';
};

export type EvidenceBundle = {
  session: EvidenceSession;
  actions: ActionRecord[];
  network: NetworkRequest[];
  console: ConsoleRecord[];
  storage: StorageDelta[];
  /** One slot per action, `undefined` where settle detection never ran for
   * it - kept index-aligned with `actions` (like `diffs`) rather than
   * filtered, so exporters can pair each digest back to its actionSeq. */
  digests: (UIDigest | undefined)[];
  diffs: (UIDiff | undefined)[];
  screenshots: ScreenshotRef[];
  appMap: AppMap;
  findings: UiDataFinding[];
  /** What redaction removed at capture time, counted by reason - so the
   * package can say what is missing, not only that something is. Absent on
   * bundles built before the tally was persisted. */
  redactionReport?: Record<string, number>;
};
