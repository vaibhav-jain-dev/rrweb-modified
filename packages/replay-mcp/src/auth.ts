/**
 * Sign-in comes from the browser session, not from the recording (which holds
 * no password). The replay browser keeps a persistent profile: sign in once in
 * the visible window and later runs find the session already there.
 */
import type { Page } from 'playwright';
import type { Step } from './types.ts';

const LOGIN_RE = /^\/(login|signin|sign-in)\b/;
const manualLoginWaitMs = () => Number(process.env.REPLAY_LOGIN_WAIT_MS ?? 5 * 60_000);

export const onLoginPage = (page: Page) => LOGIN_RE.test(new URL(page.url()).pathname);

/** The recording's leading steps that happen on the login screen. */
export function loginSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (s.skip && s.type === 'submit') continue;
    if (!LOGIN_RE.test(s.route)) break;
    out.push(s);
  }
  return out;
}

export type AuthOutcome = 'already-signed-in' | 'signed-in-by-user' | 'steps-will-sign-in';

/**
 * Decide what to do about the recorded login steps. Mutates them to skipped
 * unless a password secret is provided to replay them.
 */
export async function prepareAuth(page: Page, steps: Step[], log: (m: string) => void): Promise<AuthOutcome> {
  const login = loginSteps(steps).filter((s) => !s.skip);
  if (login.length === 0) return 'already-signed-in';
  if (!onLoginPage(page)) {
    for (const s of login) s.skip = 'already signed in (browser session)';
    return 'already-signed-in';
  }
  if (process.env.REPLAY_SECRET_PASSWORD) return 'steps-will-sign-in';
  log('Not signed in. Sign in once in the open browser window; the run continues by itself.');
  const deadline = Date.now() + manualLoginWaitMs();
  while (onLoginPage(page)) {
    if (Date.now() > deadline) throw new Error(`not signed in after ${Math.round(manualLoginWaitMs() / 1000)}s; sign in in the browser window and run again`);
    await page.waitForTimeout(500);
  }
  for (const s of login) s.skip = 'signed in by you (browser session)';
  return 'signed-in-by-user';
}
