/**
 * Wire and ledger types shared by the extension and `packages/agent-backend`.
 *
 * Plain data only: no `chrome.*`, no imports other than types, and no TS
 * syntax Node's type stripping cannot erase (no enums, no namespaces). The
 * backend imports this file by relative path and runs it as-is.
 */
import type {
  ActionRecord,
  ConsoleRecord,
  NetworkRequest,
  StorageDelta,
} from '../evidence/types';

export const AGENT_DEFAULT_PORT = 47821;
export const AGENT_DEFAULT_URL = `http://127.0.0.1:${AGENT_DEFAULT_PORT}`;

// ---------------------------------------------------------------------------
// Ledger: the one structure the panel renders live and the export writes.
// ---------------------------------------------------------------------------

export type CheckStatus =
  | 'pending' // armed, the request it waits for has not happened yet
  | 'observed' // request seen, verification running or polling
  | 'verified' // every hard expectation held
  | 'failed' // the source answered and contradicted the expectation
  | 'unchecked' // the source could not be asked (down, no tool, bad args)
  | 'never_seen'; // the request it waited for never happened

export type Evidence =
  | {
      kind: 'request';
      requestId: string;
      endpoint: string;
      status?: number;
      /** `METHOD url` with ids intact, for the person to find it in network/ */
      url?: string;
    }
  | {
      kind: 'tool';
      tool: string;
      /** The bound arguments, as run. */
      args: Record<string, unknown>;
      /** Only the projected fields the tool declared; never a raw document. */
      result: unknown;
      /** How it was obtained, e.g. `mongo devlms.loan_applications find {"_id": …}`. */
      ref: string;
      ms: number;
      attempt: number;
    }
  | {
      kind: 'assert';
      path: string;
      op: string;
      expected: unknown;
      actual: unknown;
      ok: boolean;
      soft?: boolean;
    }
  | { kind: 'error'; message: string }
  | { kind: 'timeout'; withinMs: number };

export type Check = {
  id: string;
  /** Playbook rule this came from, or `ask`. */
  ruleId: string;
  origin: 'playbook' | 'ask';
  askText?: string;
  claim: string;
  status: CheckStatus;
  /** Request that triggered it. */
  requestId?: string;
  endpoint?: string;
  /** Milliseconds from session start. */
  tObserved?: number;
  tResolved?: number;
  /** Filled at export from `tObserved`; the join key into flow.md. */
  actionSeq?: number;
  /** Live only: "checking loan_fields_data (3/10)…". Not exported. */
  activity?: string;
  evidence: Evidence[];
  /** One line. Written by code, or by the model for failures (marked). */
  note?: string;
  noteBy?: 'code' | 'model';
  /** Soft expectations that did not hold. */
  warnings?: string[];
};

export type Observation = {
  t: number;
  text: string;
  requestId?: string;
  /** Always unverified: model-written. */
  by: 'model';
};

export type Anomaly = {
  t: number;
  kind:
    | 'error_response'
    | 'uncovered_write'
    | 'unexpected_call'
    | 'missing_call';
  text: string;
  requestId?: string;
  endpoint?: string;
};

export type StepState = {
  say: string;
  /** Endpoint patterns or rule ids that must be seen and verified. */
  wait: string[];
  reachedAt?: number;
  passedAt?: number;
  state: 'upcoming' | 'current' | 'passed' | 'blocked';
};

export type Headline = {
  level: 'idle' | 'checking' | 'ok' | 'bad';
  text: string;
  t: number;
};

export type LaneVerdict = {
  verified: number;
  failed: number;
  unchecked: number;
  never_seen: number;
  pending: number;
  observed: number;
};

export type LaneLedger = {
  playbookId: string;
  playbookHash: string;
  title: string;
  verdict: LaneVerdict;
  headline: Headline;
  checks: Check[];
  steps?: StepState[];
  currentStep?: number;
  /** Set when the lane's steps are all passed: the "go ahead" moment. */
  gateReadyAt?: number;
  observations: Observation[];
  anomalies: Anomaly[];
  /** Mutating endpoints seen with no rule: { "POST /x/:id": 3 }. */
  uncovered: Record<string, number>;
};

export type Ledger = {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  model?: string;
  /** True when the backend was lost mid-session and this was assembled by the worker. */
  incomplete?: boolean;
  lanes: LaneLedger[];
};

export type AgentResult = {
  ledger: Ledger;
  /** Narrative rendered from the ledger. */
  log: string;
};

// ---------------------------------------------------------------------------
// Worker -> backend (WebSocket)
// ---------------------------------------------------------------------------

export type AgentEventPayload =
  | { kind: 'network'; t: number; payload: NetworkRequest }
  | { kind: 'action'; t: number; payload: ActionRecord }
  | { kind: 'console'; t: number; payload: ConsoleRecord }
  | { kind: 'storage'; t: number; payload: StorageDelta }
  | { kind: 'note'; t: number; payload: { text: string; id: string } };

export type ClientMessage =
  | {
      type: 'session.start';
      sessionId: string;
      startedAt: number;
      pageOrigin: string;
      playbooks: string[];
      token?: string;
    }
  | ({ type: 'event'; sessionId: string } & AgentEventPayload)
  | { type: 'session.stop'; sessionId: string; endedAt: number }
  | { type: 'ping' };

export type ServerMessage =
  | {
      type: 'session.ack';
      sessionId: string;
      lanes: string[];
      model?: string;
      resumed: boolean;
    }
  | { type: 'ledger.update'; sessionId: string; ledger: Ledger }
  | ({ type: 'session.result'; sessionId: string } & AgentResult)
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type HealthResponse = {
  ok: true;
  version: string;
  model: string | null;
  /** null = unknown (model not loaded yet) */
  gpu: boolean | null;
  playbooks: number;
  sources: Record<string, { type: string; ready: boolean; error?: string }>;
};

export type PlaybookSummary = {
  id: string;
  title: string;
  description?: string;
  rules: number;
  steps: number;
  needsModel: boolean;
};

export type SseEvent =
  | { type: 'ledger'; ledger: Ledger }
  | { type: 'gate'; playbookId: string; t: number }
  | { type: 'end' };

export type AskRequest = { playbookId?: string; text: string };
export type AskResponse = { ok: boolean; checkId?: string; message?: string };

export type RequestDetail = {
  requestId: string;
  method: string;
  url: string;
  endpoint: string;
  status?: number;
  requestBody?: unknown;
  responseBody?: unknown;
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Extension-side persisted config (LocalDataKey.agentConfig)
// ---------------------------------------------------------------------------

export type AgentConfig = {
  backendUrl: string;
  token?: string;
  /** Playbook ids picked in the popup for the next/current recording. */
  playbooks: string[];
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  backendUrl: AGENT_DEFAULT_URL,
  playbooks: [],
};

export function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}
