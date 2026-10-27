/**
 * Turn the agent's result into what the export carries: the ledger with each
 * check joined to the action it belongs to (so flow.md can show it in place),
 * without the live-only fields.
 */
import type { AgentResult, Check, LaneLedger } from '../agent/protocol';
import { renderAgentLog } from '../agent/log';
import type { ActionRecord, NetworkRequest } from './types';

/**
 * A check belongs to the action its triggering request was attributed to
 * (the same attribution flow.md uses). One with no request (an ask) belongs
 * to the last action that happened before it was made.
 */
export function attachActionSeq(
  result: AgentResult,
  network: NetworkRequest[],
  actions: ActionRecord[],
): AgentResult {
  const seqByRequest = new Map(network.map((r) => [r.requestId, r.actionSeq]));
  const startedAt = result.ledger.startedAt;

  const lanes: LaneLedger[] = result.ledger.lanes.map((lane) => ({
    ...lane,
    checks: lane.checks.map((c): Check => {
      const { activity: _live, ...rest } = c;
      let actionSeq = c.requestId ? seqByRequest.get(c.requestId) : undefined;
      if (actionSeq === undefined && c.tObserved !== undefined) {
        const at = startedAt + c.tObserved;
        for (const a of actions) if (a.t <= at) actionSeq = a.seq;
      }
      return { ...rest, actionSeq };
    }),
  }));
  const ledger = { ...result.ledger, lanes };
  // The backend's log has no action numbers; re-render from the joined ledger
  // so it matches the file it ships beside.
  return { ledger, log: renderAgentLog(ledger) };
}

export type AgentTotals = {
  verified: number;
  failed: number;
  unchecked: number;
  never_seen: number;
  unfinished: number;
  lanes: number;
  uncovered: number;
};

export function agentTotals(result: AgentResult): AgentTotals {
  const t: AgentTotals = {
    verified: 0,
    failed: 0,
    unchecked: 0,
    never_seen: 0,
    unfinished: 0,
    lanes: result.ledger.lanes.length,
    uncovered: 0,
  };
  for (const lane of result.ledger.lanes) {
    t.verified += lane.verdict.verified;
    t.failed += lane.verdict.failed;
    t.unchecked += lane.verdict.unchecked;
    t.never_seen += lane.verdict.never_seen;
    t.unfinished += lane.verdict.observed + lane.verdict.pending;
    t.uncovered += Object.values(lane.uncovered).reduce((a, b) => a + b, 0);
  }
  return t;
}

export function describeAgentTotals(t: AgentTotals): string {
  const parts = [`${t.verified} verified`];
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.never_seen) parts.push(`${t.never_seen} never seen`);
  if (t.unchecked) parts.push(`${t.unchecked} could not be checked`);
  if (t.unfinished) parts.push(`${t.unfinished} unfinished`);
  if (t.uncovered) parts.push(`${t.uncovered} writes with no verifier`);
  return `${t.lanes} lane${t.lanes === 1 ? '' : 's'} · ${parts.join(' · ')}`;
}
