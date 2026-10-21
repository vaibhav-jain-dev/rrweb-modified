import type { ActionType } from '../../web-extension/src/evidence/types.ts';

/** One recorded call a step is expected to produce. */
export type ExpectedCall = {
  /** `METHOD /templated/path` */
  endpoint: string;
  status: number;
  ms: number;
};

export type Expect = {
  /** templated route the page should be on after the step */
  route?: string;
  calls: ExpectedCall[];
  /** alert/toast/dialog texts that first appeared after this step */
  toasts: string[];
  /** longest recorded call, the base for this step's time limit */
  recordedMs: number;
};

export type Step = {
  seq: number;
  type: ActionType;
  url: string;
  route: string;
  /** Playwright-style locator, `css=…` or `role=button[name="…"]` */
  locator?: string;
  candidates: string[];
  role?: string;
  name?: string;
  inputType?: string;
  value?: string;
  /** `$secret.NAME` in `value` is resolved from REPLAY_SECRET_NAME at run time */
  label: string;
  /** why this step is not executed, if so */
  skip?: string;
  expect: Expect;
};

export type StepStatus =
  | 'ok'
  | 'slow'
  | 'skipped'
  | 'diverged'
  | 'failed'
  | 'timeout'
  | 'unlocatable';

export type ObservedCall = {
  endpoint: string;
  method: string;
  url: string;
  status?: number;
  failed?: boolean;
  ms?: number;
  pending?: boolean;
};

export type StepResult = {
  seq: number;
  label: string;
  status: StepStatus;
  route: string;
  ms: number;
  recordedMs: number;
  calls: ObservedCall[];
  notes: string[];
  uiDiff: string[];
  digestHash?: string;
  /** a write was in flight or unanswered; the run must not repeat it */
  writeUnknown?: boolean;
};
