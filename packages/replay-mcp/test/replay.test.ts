import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Service } from '../src/service.ts';
import { buildZip } from './fixture.ts';
import { startMock } from './mock-app.ts';
import type { MockApp } from './mock-app.ts';

let dir: string;
let zip: string;
let app: MockApp;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'replay-'));
  process.env.REPLAY_HEADLESS = '1';
  process.env.REPLAY_PROFILE_DIR = join(dir, 'profile');
  process.env.REPLAY_SECRET_PASSWORD = 'pw';
  process.env.REPLAY_LOGIN_WAIT_MS = '3000';
  zip = join(dir, 'recording-mock.zip');
  app = await startMock();
  buildZip(zip, app.origin);
});
afterAll(async () => {
  await app.close();
});

describe('replay of a recording through the mock app', () => {
  it('lists steps with the sign-in reordered and the password as a secret', () => {
    const list = new Service().load(zip);
    const order = list.split('\n').filter((l) => /^\s+\d/.test(l)).map((l) => Number(l.trim().split(/\s/)[0]));
    expect(order).toEqual([2, 3, 0, 4, 5, 6, 7]); // inputs, then the click; the separate submit is gone
    expect(list).toContain('type password');
  });

  it('runs the whole flow, changes "check 1" to "check 2", and tolerates slow APIs', async () => {
    const svc = new Service();
    svc.load(zip);
    const out = await svc.run({ patch: { set: { '6.value': 'check 2' } } });
    await svc.close();
    expect(out).toMatch(/^ok · /);
    expect(app.patches.at(-1)).toEqual({ notes: 'check 2' });
    expect(out).toContain('saved as run');
  });

  it('is signed in on the next run (browser session) and repeats a saved run with no patch', async () => {
    delete process.env.REPLAY_SECRET_PASSWORD; // nothing to type: sign-in must come from the session
    const svc = new Service();
    const listing = svc.load(zip);
    const saved = /saved runs: (\S+)/.exec(listing)?.[1];
    expect(saved).toBeTruthy();
    const out = await svc.run({ reuse: saved });
    await svc.close();
    expect(out).toMatch(/^ok · /);
    expect(out).toContain('3 skipped'); // the three recorded sign-in steps: the session already holds it
    expect(app.patches.at(-1)).toEqual({ notes: 'check 2' });
  });

  it('still passes when every API call is delayed 1–2.5s extra', async () => {
    const svc = new Service();
    svc.load(zip);
    const out = await svc.run({ patch: { set: { '6.value': 'check 3' } }, slow: [1000, 2500] });
    await svc.close();
    expect(out).toMatch(/^ok · /);
    expect(out).toMatch(/\d+ slow/);
    expect(app.patches.at(-1)).toEqual({ notes: 'check 3' });
  });

  it('stops at the step that went wrong and shows recorded vs actual for that step only', async () => {
    app.cfg.patchStatus = 500;
    const svc = new Service();
    svc.load(zip);
    const out = await svc.run({ patch: { set: { '6.value': 'x' } } });
    await svc.close();
    app.cfg.patchStatus = 200;
    expect(out).toMatch(/^STOPPED at step 7 \(failed\)/);
    expect(out).toContain('RECORDED');
    expect(out).toContain('PATCH /api/loan/:id → 200');
    expect(out).toContain('PATCH /api/loan/:id → 500');
  });

  it('reports a locator that matches nothing, without calling it a success', async () => {
    const svc = new Service();
    svc.load(zip);
    const out = await svc.run({ patch: { replace: { '5': { type: 'click', locator: 'role=button[name="Does Not Exist"]' } } } });
    await svc.close();
    expect(out).toMatch(/^STOPPED at step 5 \(unlocatable\)/);
  }, 90_000);
});
