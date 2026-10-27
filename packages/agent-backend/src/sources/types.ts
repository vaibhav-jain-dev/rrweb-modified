import type { ToolDef } from '../config/types.ts';

/** A captured request as the backend holds it: parsed, templated, bounded. */
export type RequestRecord = {
  requestId: string;
  method: string;
  url: string;
  pathname: string;
  /** `METHOD /templated/path`, ids replaced by `:id`. */
  endpoint: string;
  /** Identifier-looking path segments, in order. */
  idSegments: string[];
  query: Record<string, string>;
  status?: number;
  failed: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: unknown;
  responseBody: unknown;
  truncated: boolean;
  /** Wall-clock ms. */
  startTime: number;
  endTime: number;
  /** Milliseconds from session start, for the ledger. */
  tRel: number;
};

export type ToolContext = {
  requests: readonly RequestRecord[];
};

export type ToolRun = {
  /** Only what the tool declared it returns. */
  value: Record<string, unknown>;
  /** How it was obtained. No secrets, no raw filters of unbounded size. */
  ref: string;
};

/** `unavailable` = could not ask; `bad_args` = the call itself was wrong. */
export class ToolError extends Error {
  kind: 'unavailable' | 'bad_args';
  constructor(kind: 'unavailable' | 'bad_args', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SourceProvider {
  readonly name: string;
  readonly type: string;
  /** Returns an error string if the tool spec is unusable for this source. */
  validateTool(tool: ToolDef): string | undefined;
  health(): Promise<{ ready: boolean; error?: string }>;
  run(
    tool: ToolDef,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolRun>;
  close(): Promise<void>;
}
