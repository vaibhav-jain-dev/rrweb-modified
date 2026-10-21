/** Build a recording-*.zip shaped like the extension's, for the mock app. */
import { writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { MOCK_LOAN_ID } from './mock-app.ts';

export function buildZip(path: string, origin: string): void {
  const page = (route: string) => ({ url: origin + route, route, title: 't', tabId: 1, frameId: 0 });
  const tgt = (locator: string, extra: Record<string, unknown> = {}) => ({
    selector: locator, selectorCandidates: [], locator, tag: 'X', attrs: {}, ...extra,
  });
  // Raw order as the recorder writes it: the click and submit come before the typed values.
  const actions = [
    { seq: 0, t: 1000, type: 'click', page: page('/login'), target: tgt('role=button[name="Sign In"]', { role: 'button', accessibleName: 'Sign In' }) },
    { seq: 1, t: 1001, type: 'submit', page: page('/login'), target: tgt('css=form') },
    { seq: 2, t: 1700, type: 'input', page: page('/login'), value: 'me@x.com', target: tgt('css=input[name="email"]', { attrs: { type: 'text' } }) },
    { seq: 3, t: 1701, type: 'input', page: page('/login'), value: '', target: tgt('css=input[name="password"]', { attrs: { type: 'password' } }) },
    { seq: 4, t: 5000, type: 'click', page: page('/home'), target: tgt('role=button[name="Add Loan"]', { role: 'button', accessibleName: 'Add Loan' }) },
    { seq: 5, t: 6000, type: 'click', page: page('/home'), target: tgt('role=button[name="Edit notes"]', { role: 'button', accessibleName: 'Edit notes' }) },
    { seq: 6, t: 7000, type: 'input', page: page('/home'), value: 'check 1', target: tgt('css=#notes', { attrs: { type: 'text' }, accessibleName: 'Notes' }) },
    { seq: 7, t: 8000, type: 'click', page: page('/home'), target: tgt('role=button[name="Save Application"]', { role: 'button', accessibleName: 'Save Application' }) },
  ];
  const call = (seq: number, method: string, path: string, status: number, duration: number) => ({
    requestId: `r${seq}`, method, url: origin + path, status, duration, startTime: seq * 1000, actionSeq: seq,
    tier: 'primary', resourceType: 'fetch',
  });
  const network = [
    call(1, 'POST', '/api/login', 200, 200),
    call(4, 'POST', '/api/loan', 201, 2500),
    call(7, 'PATCH', `/api/loan/${MOCK_LOAN_ID}`, 200, 1500),
    { ...call(4, 'OPTIONS', '/api/loan', 200, 20), tier: 'noise' },
  ];
  const dig = (actionSeq: number, route: string, status: string[]) => ({
    actionSeq, route, digestHash: `h${actionSeq}`,
    digest: { url: origin + route, route, title: 't', capturedAt: 0, headings: [], landmarks: [], collections: [], controls: [], status: status.map((text) => ({ role: 'status', text })), counters: {}, textAtoms: [], hiddenAtoms: [], digestHash: `h${actionSeq}` },
  });
  const digests = [dig(0, '/login', []), dig(1, '/home', []), dig(2, '/login', []), dig(3, '/login', []), dig(4, '/home', ['Loan created']), dig(5, '/home', ['Loan created']), dig(6, '/home', ['Loan created']), dig(7, '/home', ['Saved'])];
  writeFileSync(path, zipSync({
    'actions.json': strToU8(JSON.stringify(actions)),
    'network/index.json': strToU8(JSON.stringify(network)),
    'ui-state/digests.json': strToU8(JSON.stringify(digests)),
  }));
}
