/** Pure helpers behind the popup and side panel, so they can be tested without a DOM. */
import type {
  Check,
  CheckStatus,
  HealthResponse,
  LaneLedger,
  StepState,
} from './protocol';

export type Tone = 'green' | 'red' | 'orange' | 'gray' | 'blue';

export const STATUS_TONE: Record<CheckStatus, Tone> = {
  verified: 'green',
  failed: 'red',
  unchecked: 'orange',
  never_seen: 'red',
  observed: 'blue',
  pending: 'gray',
};

export const STATUS_TEXT: Record<CheckStatus, string> = {
  verified: 'verified',
  failed: 'failed',
  unchecked: 'could not check',
  never_seen: 'never happened',
  observed: 'checking',
  pending: 'waiting',
};

export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}

/** Newest first, with unfinished and bad checks pinned above settled good ones. */
export function orderChecks(checks: Check[]): Check[] {
  const rank = (c: Check) =>
    c.status === 'observed' || c.status === 'pending'
      ? 0
      : c.status === 'verified'
      ? 2
      : 1;
  return [...checks].sort(
    (a, b) => rank(a) - rank(b) || (b.tObserved ?? 0) - (a.tObserved ?? 0),
  );
}

export function stepIcon(s: StepState['state']): string {
  return s === 'passed'
    ? '✓'
    : s === 'blocked'
    ? '✕'
    : s === 'current'
    ? '▶'
    : '○';
}

export function laneBadge(lane: LaneLedger): { text: string; tone: Tone } {
  const v = lane.verdict;
  if (v.failed || v.never_seen)
    return { text: `${v.failed + v.never_seen} to look at`, tone: 'red' };
  if (v.unchecked) return { text: `${v.unchecked} unchecked`, tone: 'orange' };
  if (v.observed + v.pending) return { text: 'checking…', tone: 'blue' };
  if (lane.gateReadyAt !== undefined)
    return { text: 'go ahead', tone: 'green' };
  return { text: `${v.verified} ok`, tone: v.verified ? 'green' : 'gray' };
}

export type BackendView =
  | { kind: 'checking' }
  | { kind: 'offline'; reason: string }
  | {
      kind: 'ready';
      model: string;
      hardware: string;
      hardwareTone: Tone;
      unreadySources: string[];
    };

export function describeBackend(health: HealthResponse): BackendView {
  const unready = Object.entries(health.sources)
    .filter(([, s]) => !s.ready)
    .map(([name]) => name);
  if (!health.model)
    return {
      kind: 'ready',
      model: 'no model (rules only)',
      hardware: '',
      hardwareTone: 'gray',
      unreadySources: unready,
    };
  if (health.gpu === true)
    return {
      kind: 'ready',
      model: health.model,
      hardware: 'GPU',
      hardwareTone: 'green',
      unreadySources: unready,
    };
  if (health.gpu === false)
    return {
      kind: 'ready',
      model: health.model,
      hardware: 'CPU - slow',
      hardwareTone: 'orange',
      unreadySources: unready,
    };
  return {
    kind: 'ready',
    model: health.model,
    hardware: '',
    hardwareTone: 'gray',
    unreadySources: unready,
  };
}
