import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
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

  it('tells the bot what you did by hand since its last fetch, and nothing twice', async () => {
    process.env.REPLAY_SECRET_PASSWORD = 'pw';
    const svc = new Service();
    svc.load(zip);
    await svc.run({ patch: { set: { '6.value': 'first' } } });
    const page = (svc as unknown as { session: { page: Page } }).session.page;
    expect(await svc.changes()).toContain('nothing changed'); // the replay's own actions are not yours
    await page.locator('#notes').fill('typed by hand');
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Saved');
    await new Promise((r) => setTimeout(r, 400));
    const got = await svc.changes();
    expect(got).toContain('YOU');
    expect(got).toContain('"Notes" = typed by hand');
    expect(got).toContain('click "Save Application"');
    expect(got).toContain('PATCH /api/loan/:id → 200');
    expect(app.patches.at(-1)).toEqual({ notes: 'typed by hand' });
    expect(await svc.changes()).toContain('nothing changed');

    // A slow save still running when the bot asks is reported again, with how it ended.
    app.cfg.patchDelayMs = 1500;
    await page.locator('#save').click();
    expect(await svc.changes()).toContain('PATCH /api/loan/:id → still running');
    await new Promise((r) => setTimeout(r, 2500));
    expect(await svc.changes()).toMatch(/PATCH \/api\/loan\/:id → 200.*started before your last fetch/);
    await svc.close();
  });

  it('watch mode with no recording: follows the user, keeps notes ("note this", "note from here"), screenshots only on demand', async () => {
    process.env.REPLAY_WATCH_DIR = join(dir, 'watch');
    process.env.REPLAY_PROFILE_DIR = join(dir, 'profile-watch'); // signed out: the earlier tests left a session in the shared one
    const svc = new Service(); // no load_recording: nothing is replayed
    expect(await svc.changes()).toContain('no browser open');
    const started = await svc.watch({ action: 'start', url: `${app.origin}/login` });
    expect(started).toContain('watching');
    const page = (svc as unknown as { session: { page: Page } }).session.page;

    // the user signs in by hand (the password must never be reported)
    await page.locator('input[name=email]').fill('me@example.com');
    await page.locator('input[name=password]').fill('hunter2-secret');
    await page.locator('#go').click();
    await page.waitForURL('**/home');
    expect(await svc.note({ text: 'signed in' })).toContain('note 1 saved');

    // "note from here": a span, then the work inside it
    expect(await svc.note({ text: 'create a loan', from: true })).toContain('note 2 open from here');
    await page.locator('#add').click();
    await page.locator('#edit').waitFor();
    await page.locator('#edit').click();
    await page.locator('#notes').fill('watch me');
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Saved');
    await new Promise((r) => setTimeout(r, 400));
    expect(await svc.note({ done: 2 })).toContain('note 2 closed');
    await page.locator('#add').click(); // after the span: must not be inside note 2

    const inside = await svc.changes(2);
    expect(inside).toContain('note 2 "create a loan"');
    expect(inside).toContain('click "Add Loan"');
    expect(inside).toContain('"Notes" = watch me');
    expect(inside).toContain('POST /api/loan');
    expect(inside).toContain('PATCH /api/loan/:id → 200');
    expect(inside).toContain('SCREEN');
    expect(inside).not.toContain('me@example.com'); // the sign-in was before the span
    expect(inside.split('click "Add Loan"').length).toBe(2); // the click after the span is not in it

    const all = await svc.changes(); // everything new since watching began
    expect(all).toContain('"Email" = me@example.com');
    expect(all).toContain('[hidden]');
    expect(all).not.toContain('hunter2-secret');
    expect(all.split('click "Add Loan"').length).toBe(3); // both clicks, the one inside the note and the one after it
    expect(await svc.changes()).toContain('nothing changed'); // and nothing twice

    expect(await svc.note({ list: true })).toMatch(/1 .*"signed in"[\s\S]*2 .*"create a loan".* → /);

    // a screenshot of one element is much smaller than the page, and only when asked
    const whole = (await svc.screenshot()) as { data: string };
    const part = (await svc.screenshot('#toast')) as { data: string; mimeType: string };
    expect(part.mimeType).toBe('image/jpeg');
    expect(part.data.length).toBeLessThan(whole.data.length / 3);

    // stop: later activity is not recorded; the log on disk holds events and notes, never the password
    expect(await svc.watch({ action: 'stop' })).toContain('2 notes kept');
    await page.locator('#add').click();
    expect(await svc.changes()).not.toContain('click "Add Loan"');
    const logFile = (svc as unknown as { session: { watcher: { logFile: string } } }).session.watcher.logFile;
    expect(existsSync(logFile)).toBe(true);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"type":"note"');
    expect(log).not.toContain('hunter2-secret');
    await svc.close();
  });
});

