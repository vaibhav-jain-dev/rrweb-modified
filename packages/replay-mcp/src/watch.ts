/**
 * What happened in the browser since the bot last asked: your own clicks and
 * typed values, page changes, the calls the page made, and how the screen
 * differs. Replay-driven actions are left out (the run reports those itself).
 */
import type { BrowserContext, Page } from 'playwright';
import type { UIDigest } from '../../web-extension/src/evidence/types.ts';
import type { Observer, Tracked } from './observe.ts';
import { isWrite } from './observe.ts';
import { digestOf } from './wait.ts';

type UserEvent = { t: number; k: 'click' | 'set' | 'nav'; text: string };

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB');
const secs = (ms?: number) => (ms === undefined ? '' : ` (${(ms / 1000).toFixed(1)}s)`);
const LIMIT = 12;

export class Watcher {
  private events: UserEvent[] = [];
  private paused = false;
  private cursor = Date.now();
  private baseline?: UIDigest;
  /** calls that had not finished when last reported: say how they ended next time */
  private unfinished = new Set<Tracked>();

  async attach(context: BrowserContext, route: (url: string) => string): Promise<void> {
    await context.exposeBinding('__rrNote', (_src, ev: { k: 'click' | 'set'; text: string }) => {
      if (!this.paused) this.events.push({ t: Date.now(), ...ev });
    });
    const watch = (page: Page) =>
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || this.paused) return;
        const text = route(frame.url());
        if (this.events.at(-1)?.k === 'nav' && this.events.at(-1)?.text === text) return;
        this.events.push({ t: Date.now(), k: 'nav', text });
      });
    context.pages().forEach(watch);
    context.on('page', watch);
  }

  /** A replay is driving the page: its actions are not yours. */
  pause(): void {
    this.paused = true;
  }

  async resume(page: Page | undefined): Promise<void> {
    this.paused = false;
    this.events = [];
    this.cursor = Date.now();
    this.baseline = page ? await digestOf(page) : undefined;
  }

  async report(page: Page, observer: Observer): Promise<string> {
    const since = this.cursor;
    const events = this.events;
    this.events = [];
    this.cursor = Date.now();

    const calls = observer.since(since, new Set());
    const finished = [...this.unfinished].filter((t) => !t.pending && !calls.includes(t));
    this.unfinished = new Set(calls.filter((t) => t.pending && (t.resourceType !== 'document' && isWrite(t.method))));
    for (const t of this.unfinished) if (calls.includes(t) === false) calls.push(t);
    const now = await digestOf(page);
    const prev = this.baseline;
    this.baseline = now ?? prev;
    const ui = prev && now ? await this.diff(page, prev, now) : [];
    const typing = await this.pendingField(page, events);

    const lines: string[] = [];
    const user = collapse(events);
    if (user.length || typing) {
      lines.push('YOU');
      lines.push(...user.slice(-LIMIT).map((e) => `  ${clock(e.t)} ${e.k === 'nav' ? 'page → ' : e.k === 'click' ? 'click ' : 'set '}${e.text}`));
      if (typing) lines.push(`  now typing ${typing}`);
    }
    const net = describeCalls(calls, finished);
    if (net.length) lines.push('CALLS', ...net);
    if (ui.length) lines.push('SCREEN', ...ui.slice(0, 8).map((u) => `  ${u}`));
    const head = `since last fetch (${Math.max(1, Math.round((Date.now() - since) / 1000))}s ago) · ${now?.route ?? page.url()}`;
    return lines.length ? [head, ...lines].join('\n') : `${head}\nnothing changed`;
  }

  private async diff(page: Page, a: UIDigest, b: UIDigest): Promise<string[]> {
    try {
      return await page.evaluate(([x, y]) => (window as unknown as { __rrDiff?: (a: unknown, b: unknown) => string[] }).__rrDiff?.(x, y) ?? [], [a, b] as const);
    } catch {
      return [];
    }
  }

  /** The field you are in right now, if its text is not a finished change yet. */
  private async pendingField(page: Page, events: UserEvent[]): Promise<string | undefined> {
    try {
      const f = await page.evaluate(() => (window as unknown as { __rrFocus?: () => string | null }).__rrFocus?.() ?? null);
      return f && !events.some((e) => e.k === 'set' && e.text === f) ? f : undefined;
    } catch {
      return undefined;
    }
  }
}

function collapse(events: UserEvent[]): UserEvent[] {
  const out: (UserEvent & { n: number })[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && last.k === e.k && last.text === e.text) last.n++;
    else if (last && last.k === 'set' && e.k === 'set' && last.text.split(' = ')[0] === e.text.split(' = ')[0]) out[out.length - 1] = { ...e, n: 1 };
    else out.push({ ...e, n: 1 });
  }
  return out.map((e) => (e.n > 1 ? { ...e, text: `${e.text} ×${e.n}` } : e));
}

function describeCalls(calls: Tracked[], finished: Tracked[]): string[] {
  const shown = calls.filter((c) => (c.resourceType !== 'document' && isWrite(c.method)) || c.failed || (c.status ?? 0) >= 400);
  const quiet = calls.length - shown.length;
  const row = (c: Tracked, tail = '') => `  ${clock(c.start)} ${c.endpoint} → ${c.failed ? 'FAILED' : c.pending ? 'still running' : (c.status ?? 'no answer')}${secs(c.ms)}${tail}`;
  const lines = [...finished.map((c) => row(c, ' — started before your last fetch')), ...shown.slice(-LIMIT).map((c) => row(c))];
  if (quiet > 0) lines.push(`  ${quiet} other call${quiet === 1 ? '' : 's'} ok`);
  return lines;
}
