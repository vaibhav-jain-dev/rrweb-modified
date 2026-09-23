import { describe, expect, it } from 'vitest';
import {
  PACKAGE_SCHEMA_VERSION,
  SKILL_NAME,
  renderFlow,
  renderFindings,
  renderManifest,
  renderReadme,
  renderSummaryJson,
} from '~/evidence/render';
import type { EvidenceBundle } from '~/evidence/types';

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    session: {
      id: 's1',
      name: 'Approve application flow',
      createTimestamp: 0,
      modifyTimestamp: 0,
      recorderVersion: 'test',
      captureMode: 'cdp',
    },
    actions: [],
    network: [],
    console: [],
    storage: [],
    digests: [],
    diffs: [],
    screenshots: [],
    appMap: { nodes: [], edges: [] },
    findings: [],
    ...overrides,
  };
}

describe('renderFlow', () => {
  it('renders the exact ACTION/NETWORK/UI/SCREENSHOT shape from the spec', () => {
    const b = bundle({
      actions: [
        {
          seq: 12,
          t: 1_700_000_000_000,
          type: 'click',
          page: { url: 'https://x/applications', route: '/applications', title: '', tabId: 1, frameId: 0 },
          target: { selector: '[data-testid=filter-pending]', selectorCandidates: [], locator: '', tag: 'BUTTON', accessibleName: 'Pending', attrs: {} },
        },
      ],
      network: [
        {
          requestId: 'r1',
          method: 'GET',
          url: 'https://x/api/applications?status=pending',
          status: 200,
          startTime: 0,
          duration: 142,
          actionSeq: 12,
          tier: 'primary',
        },
      ],
      diffs: [
        {
          summary: ['Applications table changed', 'Rows: 24 → 7', 'Status filter changed: All → Pending'],
          collectionChanges: [{ key: 'k', countBefore: 24, countAfter: 7 }],
          controlChanges: [],
        },
      ],
      screenshots: [{ actionSeq: 12, phase: 'after', path: 'screenshots/action-12-after.jpg' }],
    });
    const flow = renderFlow(b);
    expect(flow).toContain('ACTION 12');
    expect(flow).toContain('Clicked "Pending"');
    expect(flow).toContain('GET /api/applications?status=pending → 200 (142ms)');
    expect(flow).toContain('Rows: 24 → 7');
    expect(flow).toContain('SCREENSHOT  screenshots/action-12-after.jpg');
  });

  it('renders "no network activity" for an action with zero requests', () => {
    const b = bundle({
      actions: [
        {
          seq: 1,
          t: 0,
          type: 'click',
          page: { url: 'https://x/', route: '/', title: '', tabId: 1, frameId: 0 },
        },
      ],
    });
    expect(renderFlow(b)).toContain('NETWORK  (no network activity)');
  });

  it('collapses noise-tier requests to a count instead of listing them', () => {
    const noise = Array.from({ length: 40 }, (_, i) => ({
      requestId: `noise-${i}`,
      method: 'GET',
      url: `https://cdn.x/asset-${i}.png`,
      status: 200,
      startTime: 0,
      actionSeq: 1,
      tier: 'noise' as const,
    }));
    const b = bundle({
      actions: [{ seq: 1, t: 0, type: 'click', page: { url: 'https://x/', route: '/', title: '', tabId: 1, frameId: 0 } }],
      network: noise,
    });
    const flow = renderFlow(b);
    expect(flow).toContain('40 lower-relevance requests omitted');
    expect(flow).not.toContain('asset-39.png');
  });

  it('stays compact for a session with many actions (token-economy check)', () => {
    const actions = Array.from({ length: 60 }, (_, i) => ({
      seq: i,
      t: i * 1000,
      type: 'click' as const,
      page: { url: 'https://x/', route: '/applications', title: '', tabId: 1, frameId: 0 },
      target: { selector: `.row-${i}`, selectorCandidates: [], locator: '', tag: 'BUTTON', accessibleName: `Row ${i}`, attrs: {} },
    }));
    const network = actions.map((a) => ({
      requestId: `r${a.seq}`,
      method: 'GET',
      url: `https://x/api/rows/${a.seq}`,
      status: 200,
      startTime: a.t,
      duration: 50,
      actionSeq: a.seq,
      tier: 'primary' as const,
    }));
    const flow = renderFlow(bundle({ actions, network }));
    // ~60 actions with one request each should stay well under typical
    // small-context budgets - each action block is a handful of lines.
    expect(flow.length).toBeLessThan(60 * 400);
  });
});

describe('renderFindings', () => {
  it('never asserts a bug - always frames entries as candidates', () => {
    const b = bundle({
      findings: [
        {
          kind: 'missing_in_ui',
          summary: 'Value "escalate to billing" does not appear in the UI',
          evidence: { route: '/x', jsonPath: '$.note' },
          howToVerify: 'Check the response and the rendered page.',
        },
      ],
    });
    const findings = renderFindings(b);
    expect(findings).toContain('**Candidate:**');
    // The framing disclaimer legitimately says "not an assertion of a
    // bug" - what must never happen is an individual finding line
    // asserting one.
    const candidateLine = findings.split('\n').find((l) => l.includes('**Candidate:**'))!;
    expect(candidateLine.toLowerCase()).not.toContain('bug');
    expect(candidateLine.toLowerCase()).not.toContain('broken');
    expect(findings).toContain('json path: `$.note`');
  });

  it('says explicitly when there are no candidates', () => {
    const findings = renderFindings(bundle());
    expect(findings).toContain('No candidates were surfaced');
  });

  it('collapses the same candidate recurring across many actions into one entry', () => {
    const repeated = Array.from({ length: 19 }, (_, i) => ({
      kind: 'missing_in_ui' as const,
      summary: 'Value "202600830" does not appear in the UI',
      evidence: { route: '/x', actionSeq: i, jsonPath: '$.loan_application_number' },
      howToVerify: 'Check the response and the rendered page.',
    }));
    const findings = renderFindings(bundle({ findings: repeated }));

    // one distinct candidate, not 19 repeated blocks
    expect(findings.match(/\*\*Candidate:\*\*/g)?.length).toBe(1);
    expect(findings).toContain('Seen 19 times across actions.');
    expect(findings).toContain('1 distinct candidate');
    expect(findings).toContain('19 raw observations');
    // only a bounded number of occurrences are listed individually
    expect(findings).toContain('more occurrence(s)');
  });

  it('caps distinct candidates per rule so one noisy heuristic cannot blow out the file', () => {
    const distinct = Array.from({ length: 30 }, (_, i) => ({
      kind: 'missing_in_ui' as const,
      summary: `Value "field-${i}" does not appear in the UI`,
      evidence: { route: '/x', actionSeq: 0, jsonPath: `$.field${i}` },
      howToVerify: 'Check the response and the rendered page.',
    }));
    const findings = renderFindings(bundle({ findings: distinct }));

    expect(findings.match(/\*\*Candidate:\*\*/g)?.length).toBe(20);
    expect(findings).toContain('10 more distinct');
  });
});

describe('renderSummaryJson', () => {
  it('produces valid JSON with one compact entry per action', () => {
    const b = bundle({
      actions: [
        {
          seq: 1,
          t: 0,
          type: 'click',
          page: { url: 'https://x/', route: '/applications', title: '', tabId: 1, frameId: 0 },
          target: { selector: '.btn', selectorCandidates: [], locator: '', tag: 'BUTTON', accessibleName: 'Approve', attrs: {} },
        },
      ],
      network: [
        { requestId: 'r1', method: 'POST', url: 'https://x/api/applications/1/approve', status: 200, startTime: 0, actionSeq: 1 },
      ],
    });
    const parsed = JSON.parse(renderSummaryJson(b)) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: 'click', target: 'Approve' });
  });
});

describe('the package explains itself', () => {
  it('points every action at the files that hold its detail, by the join key', () => {
    const b = bundle({
      actions: [
        {
          seq: 7,
          t: 0,
          type: 'click',
          page: { url: 'https://x/', route: '/', title: '', tabId: 1, frameId: 0 },
          target: { selector: '.btn', selectorCandidates: [], locator: '', tag: 'BUTTON', attrs: {}, rrwebId: 42 },
        },
      ],
    });
    const flow = renderFlow(b);
    expect(flow).toContain(
      'DRILL-DOWN  actions.json#7 · network/index.json actionSeq=7 · ui-state/digests.json actionSeq=7',
    );
    // The raw event stream is not in the package, so nothing may point at it.
    expect(flow).not.toContain('raw/');
  });

  it('README names the skill and only files the package actually contains', () => {
    const readme = renderReadme(bundle());
    expect(readme).toContain(SKILL_NAME);
    expect(readme).toContain(`schema ${PACKAGE_SCHEMA_VERSION}`);
    for (const present of ['manifest.json', 'flow.md', 'findings.md', 'network/index.json', 'redaction-report.json']) {
      expect(readme).toContain(present);
    }
    for (const absent of ['raw/', 'cookies.json']) {
      expect(readme).not.toContain(absent);
    }
  });

  it('manifest lists every file with its size, the schema and the skill', () => {
    const b = bundle({
      session: { id: 's1', name: 'n', createTimestamp: 1_700_000_000_000, modifyTimestamp: 1_700_000_060_000, recorderVersion: '0.9', captureMode: 'cdp' },
      screenshots: [
        { actionSeq: 0, phase: 'after', path: 'screenshots/action-0000-after.jpg' },
        { actionSeq: 1, phase: 'after', path: 'screenshots/action-0000-after.jpg', dedupedFrom: 'screenshots/action-0000-after.jpg' },
      ],
    });
    const manifest = JSON.parse(renderManifest(b, { 'network/index.json': 3400, 'flow.md': 12 })) as {
      schema_version: number;
      skill: string;
      recorder_version: string;
      counts: { screenshots: number };
      files: { path: string; bytes: number }[];
    };
    expect(manifest).toMatchObject({ schema_version: PACKAGE_SCHEMA_VERSION, skill: SKILL_NAME, recorder_version: '0.9' });
    expect(manifest.counts.screenshots).toBe(1); // a deduped repeat is not a second image
    expect(manifest.files).toEqual([
      { path: 'flow.md', bytes: 12 },
      { path: 'network/index.json', bytes: 3400 },
    ]);
  });
});
