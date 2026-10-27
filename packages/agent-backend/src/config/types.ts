import type { Op } from '../expr.ts';

export type ArgType =
  | 'string'
  | 'id'
  | 'objectid'
  | 'number'
  | 'boolean'
  | 'string[]';

export type SourceDef = {
  name: string;
  type: 'mongo' | 'http' | 'session';
  /** Everything else under the source in sources.yaml. */
  config: Record<string, unknown>;
};

export type ToolDef = {
  name: string;
  description: string;
  source: string;
  args: Record<string, ArgType>;
  /** Source-specific, validated by the provider's own `validateTool`. */
  spec: Record<string, unknown>;
};

export type ExpectDef = {
  /** Path into the tool result: `doc.status`, `rows`, `found`. */
  path: string;
  op: Op;
  value?: unknown;
  /** A soft expectation that fails is reported as a warning, not a failure. */
  soft?: boolean;
  /** Passes when any one of these passes (used for soft-delete vs hard-delete). */
  anyOf?: ExpectDef[];
  /** Human line for the panel when this expectation fails. */
  say?: string;
};

export type PollDef = { everyMs: number; forMs: number };

export type VerifyDef = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  poll?: PollDef;
  expect: ExpectDef[];
  /** Line shown when it verifies. `{name}` reads bound values and result fields. */
  say?: string;
  /** Names to bind from the result for later verifies in the same occurrence. */
  capture?: Record<string, string>;
};

export type RuleDef = {
  id: string;
  title: string;
  /** `METHOD /path/:id`; method may be `*`. */
  on: string;
  /** `2xx` (default), `200,201`, `>=400`, `*`. */
  status: string;
  /** If the call never happens during the session, the ledger records it as never seen. */
  required: boolean;
  bind: Record<string, unknown>;
  verify: VerifyDef[];
};

export type StepDef = {
  say: string;
  /** Rule ids or endpoint patterns that must be seen and verified. */
  wait: string[];
};

export type PlaybookDef = {
  id: string;
  title: string;
  description?: string;
  /** Markdown body: the model's brief for this lane. */
  brief: string;
  /** Endpoints that are writes by method but not by effect (login, a POST that reads). */
  ignore: string[];
  rules: RuleDef[];
  steps: StepDef[];
  /** Whether the lane uses the model for anything. */
  needsModel: boolean;
  hash: string;
  file: string;
};

export type AgentConfig = {
  dir: string;
  sources: SourceDef[];
  tools: ToolDef[];
  playbooks: PlaybookDef[];
  /** REFERENCE.md: what the collections mean. Fed to the model verbatim. */
  reference: string;
  warnings: string[];
};
