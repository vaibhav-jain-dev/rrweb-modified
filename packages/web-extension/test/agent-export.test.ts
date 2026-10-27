import { describe, expect, it } from 'vitest';
import {
  agentTotals,
  attachActionSeq,
  describeAgentTotals,
} from '~/evidence/agent-export';
import {
  renderFindings,
  renderFlow,
  renderManifest,
  renderReadme,
} from '~/evidence/render';
import type {
  ActionRecord,
  EvidenceBundle,
  NetworkRequest,
} from '~/evidence/types';
import { check, lane, result } from './agent-fixtures';

const T0 = 1_700_000_000_000;
const action = (seq: number, t: number, name: string): ActionRecord => ({
  seq,
  t,
  type: 'click',
  page: {
    url: 'https://x/',
    route: '/loans/6a62d0b46ccb69068d608083',
    title: '',
    tabId: 1,
    frameId: 0,
  },
  target: {
    selector: 'b',
    selectorCandidates: [],
    locator: '',
    tag: 'BUTTON',
    accessibleName: name,
    attrs: {},
  },
});
const req = (requestId: string, actionSeq?: number): NetworkRequest => ({
  requestId,
  method: 'POST',
  url: 'https://x/api',
  status: 201,
  startTime: T0,
  actionSeq,
  tier: 'primary',
});

function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    session: {
      id: 's1',
      name: 'Flow',
      createTimestamp: T0,
      modifyTimestamp: T0 + 1,
      recorderVersion: 't',
      captureMode: 'cdp',
    },
    actions: [action(0, T0 + 100, 'New loan'), action(1, T0 + 5000, 'Save')],
    network: [req('r1', 0), req('r2', 1)],
    console: [],
    storage: [],
    digests: [],
    diffs: [],
    screenshots: [],
    appMap: { nodes: [], edges: [] },
    findings: [],
    ...over,
  };
}

describe('attachActionSeq', () => {
  const actions = [action(0, T0 + 100, 'a'), action(1, T0 + 5000, 'b')];

  it('joins a check to the action its request was attributed to', () => {
    const out = attachActionSeq(
      result([lane([check({ requestId: 'r2', tObserved: 5100 })])]),
      [req('r1', 0), req('r2', 1)],
      actions,
    );
    expect(out.ledger.lanes[0].checks[0].actionSeq).toBe(1);
  });

  it('places a check with no request after the last action before it', () => {
    const asked = check({
      id: 'ask#1',
      requestId: undefined,
      origin: 'ask',
      askText: 'is it there',
      tObserved: 4000,
    });
    const out = attachActionSeq(result([lane([asked])]), [], actions);
    expect(out.ledger.lanes[0].checks[0].actionSeq).toBe(0);
  });

  it('leaves a check before every action unattached', () => {
    const early = check({ requestId: undefined, tObserved: 10 });
    expect(
      attachActionSeq(result([lane([early])]), [], actions).ledger.lanes[0]
        .checks[0].actionSeq,
    ).toBeUndefined();
  });

  it('drops live-only fields and re-renders the log from the joined ledger', () => {
    const live = check({ activity: 'checking loan_application…' });
    const out = attachActionSeq(
      result([lane([live])]),
      [req('r1', 0)],
      actions,
    );
    expect(out.ledger.lanes[0].checks[0]).not.toHaveProperty('activity');
    expect(out.log).toMatch(/OK\s+Loan created/);
    expect(out.log).not.toBe('backend log');
  });
});

describe('totals', () => {
  it('sums lanes and counts unfinished and uncovered separately', () => {
    const r = result([
      lane(
        [
          check(),
          check({ id: 'b', status: 'failed' }),
          check({ id: 'c', status: 'observed' }),
        ],
        { uncovered: { 'POST /x': 2 } },
      ),
      lane([check({ id: 'd', status: 'never_seen' })]),
    ]);
    const t = agentTotals(r);
    expect(t).toMatchObject({
      verified: 1,
      failed: 1,
      never_seen: 1,
      unfinished: 1,
      uncovered: 2,
      lanes: 2,
    });
    expect(describeAgentTotals(t)).toBe(
      '2 lanes · 1 verified · 1 failed · 1 never seen · 1 unfinished · 2 writes with no verifier',
    );
  });
});

describe('the export', () => {
  const agent = attachActionSeq(
    result([
      lane(
        [
          check({ requestId: 'r1', note: 'Loan L-9 is in the database' }),
          check({
            id: 'f',
            requestId: 'r2',
            status: 'failed',
            claim: 'Field values saved · loan_fields_data',
            note: 'values includes_map — 1 differ: f2',
          }),
          check({
            id: 'ask#1',
            requestId: undefined,
            origin: 'ask',
            askText: 'is the order received',
            status: 'verified',
            claim: 'Order received',
            tObserved: 6000,
          }),
        ],
        {
          uncovered: { 'POST /mystery/:id': 2 },
          anomalies: [
            { t: 3000, kind: 'error_response', text: 'POST /dup answered 409' },
          ],
          observations: [
            { t: 4000, text: 'Looks like replica lag', by: 'model' },
          ],
        },
      ),
    ]),
    [req('r1', 0), req('r2', 1)],
    [action(0, T0 + 100, 'New loan'), action(1, T0 + 5000, 'Save')],
  );

  it('puts AGENT lines under the action each check followed', () => {
    const flow = renderFlow(bundle({ agent }));
    const a0 = flow.indexOf('ACTION 0');
    const a1 = flow.indexOf('ACTION 1');
    const ok = flow.indexOf('AGENT ▶ OK');
    const fail = flow.indexOf('AGENT ▶ FAIL');
    expect(ok).toBeGreaterThan(a0);
    expect(ok).toBeLessThan(a1);
    expect(fail).toBeGreaterThan(a1);
    expect(flow).toContain('Loan L-9 is in the database');
    expect(flow).toContain('1 differ: f2');
  });

  it('shows an ask next to the action before it, with the words the person used', () => {
    expect(renderFlow(bundle({ agent }))).toContain(
      '[asked: "is the order received"]',
    );
  });

  it('summarises the agent in the SUMMARY block', () => {
    const flow = renderFlow(bundle({ agent }));
    expect(flow).toMatch(
      /agent:\s+1 lane · 2 verified · 1 failed · 2 writes with no verifier — see agent\/log.txt/,
    );
  });

  it('says so when the backend was lost', () => {
    const lost = { ...agent, ledger: { ...agent.ledger, incomplete: true } };
    expect(renderFlow(bundle({ agent: lost }))).toMatch(/backend was lost/);
  });

  it('keeps model remarks and unverifiable writes out of the verified lines, in findings.md', () => {
    const md = renderFindings(bundle({ agent }));
    expect(md).toContain(
      '## Agent observations - LMS writes → database (unverified)',
    );
    expect(md).toContain('- POST /mystery/:id ×2');
    expect(md).toContain('- POST /dup answered 409');
    expect(md).toContain('- (model, unverified) Looks like replica lag');
  });

  it('adds nothing when the agent was not used', () => {
    const b = bundle();
    expect(renderFlow(b)).not.toContain('AGENT');
    expect(renderFindings(b)).not.toContain('Agent observations');
    expect(renderReadme(b)).not.toContain('agent/log.txt');
  });

  it('points the README at the agent files, and counts checks in the manifest', () => {
    const b = bundle({ agent });
    expect(renderReadme(b, { 'agent/log.txt': 2048 })).toMatch(
      /agent\/log\.txt\*\* \(2 KB\)/,
    );
    expect(JSON.parse(renderManifest(b, {})).counts.agent_checks).toBe(3);
  });
});
