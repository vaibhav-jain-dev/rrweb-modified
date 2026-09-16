import { describe, expect, it } from 'vitest';
import { flattenJson, reconcileResponse, findInaccessibleControls, findTruncatedText } from '~/evidence/reconcile';
import type { NetworkRequest, UIDigest } from '~/evidence/types';

function digest(overrides: Partial<UIDigest> = {}): UIDigest {
  return {
    url: 'https://x.test/',
    route: '/applications',
    title: '',
    capturedAt: 0,
    headings: [],
    landmarks: [],
    collections: [],
    controls: [],
    status: [],
    counters: {},
    textAtoms: [],
    hiddenAtoms: [],
    digestHash: 'h',
    ...overrides,
  };
}

function jsonRequest(body: unknown): NetworkRequest {
  return {
    requestId: 'r1',
    method: 'GET',
    url: 'https://api.x.test/applications',
    status: 200,
    startTime: 0,
    responseBody: JSON.stringify(body),
  };
}

describe('flattenJson', () => {
  it('flattens nested objects and arrays with JSON paths', () => {
    const atoms = flattenJson({ user: { name: 'Ada' }, tags: ['a', 'b'] });
    expect(atoms).toEqual(
      expect.arrayContaining([
        { path: '$.user.name', value: 'Ada', key: 'name' },
        { path: '$.tags[0]', value: 'a', key: '0' },
      ]),
    );
  });
});

describe('reconcileResponse: count_mismatch', () => {
  it('flags a count mismatch between response array length and rendered rows', () => {
    const req = jsonRequest({ applications: Array.from({ length: 24 }, (_, i) => ({ id: i, status: 'pending' })) });
    const d = digest({
      collections: [
        { key: 'sel', selector: 'table', label: 'Applications', count: 7, columns: ['id', 'status'] },
      ],
    });
    const findings = reconcileResponse(req, d, { route: '/applications' });
    const finding = findings.find((f) => f.kind === 'count_mismatch');
    expect(finding).toBeDefined();
    expect(finding?.evidence).toMatchObject({ apiValue: 24, uiValue: 7 });
  });

  it('does not flag count_mismatch when the counts agree (negative case)', () => {
    const req = jsonRequest({ applications: [{ id: 1, status: 'pending' }] });
    const d = digest({
      collections: [{ key: 'sel', selector: 'table', count: 1, columns: ['id', 'status'] }],
    });
    const findings = reconcileResponse(req, d, { route: '/applications' });
    expect(findings.find((f) => f.kind === 'count_mismatch')).toBeUndefined();
  });
});

describe('reconcileResponse: missing_in_ui / hidden_in_ui', () => {
  it('flags a response field that appears nowhere in the UI as missing_in_ui', () => {
    const req = jsonRequest({ internalNote: 'escalate to billing team' });
    const d = digest();
    const findings = reconcileResponse(req, d, { route: '/applications' });
    expect(findings.some((f) => f.kind === 'missing_in_ui')).toBe(true);
  });

  it('flags a response field present only in hiddenAtoms as hidden_in_ui, not missing_in_ui', () => {
    const req = jsonRequest({ approverName: 'Jordan Lee' });
    const d = digest({ hiddenAtoms: ['Jordan Lee'] });
    const findings = reconcileResponse(req, d, { route: '/applications' });
    expect(findings.some((f) => f.kind === 'hidden_in_ui')).toBe(true);
    expect(findings.some((f) => f.kind === 'missing_in_ui')).toBe(false);
  });

  it('does not flag a field that is genuinely rendered (negative case)', () => {
    const req = jsonRequest({ status: 'Approved' });
    const d = digest({ textAtoms: ['Approved'] });
    const findings = reconcileResponse(req, d, { route: '/applications' });
    expect(findings).toEqual([]);
  });

  it('does not flag trivial fields like ids and timestamps by default (negative case)', () => {
    const req = jsonRequest({
      id: 'e29b41d4-a716-4466-b3f2-1234567890ab',
      createdAt: '2026-09-15T10:00:00Z',
      active: true,
    });
    const d = digest();
    const findings = reconcileResponse(req, d, { route: '/applications' });
    expect(findings.filter((f) => f.kind === 'missing_in_ui')).toEqual([]);
  });

  it('never asserts a bug - every finding carries evidence and a verification step', () => {
    const req = jsonRequest({ hiddenField: 'secret business value' });
    const d = digest();
    const findings = reconcileResponse(req, d, { route: '/applications', actionSeq: 5 });
    for (const f of findings) {
      expect(f.howToVerify).toBeTruthy();
      expect(f.summary).not.toMatch(/\bbug\b/i);
      expect(f.summary).not.toMatch(/\bbroken\b/i);
    }
  });
});

describe('findInaccessibleControls', () => {
  it('flags a visible-usable control with no accessible name', () => {
    const d = digest({
      controls: [{ selector: '.icon-btn', role: 'button', state: 'visible-usable' }],
    });
    const findings = findInaccessibleControls(d, new Set(), '/x');
    expect(findings.some((f) => f.kind === 'not_focusable')).toBe(true);
  });

  it('does not flag a control that has an accessible name (negative case)', () => {
    const d = digest({
      controls: [{ selector: '.btn', role: 'button', name: 'Approve', state: 'visible-usable' }],
    });
    const findings = findInaccessibleControls(d, new Set(), '/x');
    expect(findings).toEqual([]);
  });

  it('flags a control that is visually present but AX-ignored', () => {
    const d = digest({
      controls: [{ selector: '.btn', role: 'button', name: 'Approve', state: 'visible-usable' }],
    });
    const findings = findInaccessibleControls(d, new Set(['.btn']), '/x');
    expect(findings.some((f) => f.kind === 'inaccessible_control')).toBe(true);
  });
});

describe('findTruncatedText', () => {
  it('flags rendered text that is a prefix of the full API value', () => {
    const req = jsonRequest({ description: 'This is a very long description that gets cut off in the UI' });
    const d = digest({ textAtoms: ['This is a very long description that'] });
    const findings = findTruncatedText(req, d, '/x');
    expect(findings.some((f) => f.kind === 'truncated')).toBe(true);
  });

  it('does not flag when the full text is rendered (negative case)', () => {
    const req = jsonRequest({ description: 'Short and complete' });
    const d = digest({ textAtoms: ['Short and complete'] });
    const findings = findTruncatedText(req, d, '/x');
    expect(findings).toEqual([]);
  });
});
