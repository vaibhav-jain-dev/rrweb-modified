import type { AgentResult, Check, Ledger, LaneLedger } from '~/agent/protocol';

export function check(over: Partial<Check> = {}): Check {
  return {
    id: 'loan-create#1.row',
    ruleId: 'loan-create',
    origin: 'playbook',
    claim: 'Loan created · loan_application',
    status: 'verified',
    requestId: 'r1',
    endpoint: 'POST /lms/api/v1/loan-application',
    tObserved: 1200,
    tResolved: 1650,
    evidence: [],
    note: 'Loan L-9 is in the database',
    noteBy: 'code',
    ...over,
  };
}

export function lane(
  checks: Check[],
  over: Partial<LaneLedger> = {},
): LaneLedger {
  const verdict = {
    verified: 0,
    failed: 0,
    unchecked: 0,
    never_seen: 0,
    pending: 0,
    observed: 0,
  };
  for (const c of checks) verdict[c.status]++;
  return {
    playbookId: 'lms-writes',
    playbookHash: 'abc',
    title: 'LMS writes → database',
    verdict,
    headline: { level: 'ok', text: 'done', t: 0 },
    checks,
    observations: [],
    anomalies: [],
    uncovered: {},
    ...over,
  };
}

export function result(
  lanes: LaneLedger[],
  over: Partial<Ledger> = {},
): AgentResult {
  return {
    ledger: {
      sessionId: 's1',
      startedAt: 1_700_000_000_000,
      model: 'qwen2.5-coder:3b',
      lanes,
      ...over,
    },
    log: 'backend log',
  };
}
