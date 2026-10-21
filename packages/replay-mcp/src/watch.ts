/**
 * Watching the browser while a person uses it: their clicks and typed values,
 * page changes, the calls the page made and how the screen differs. The bot
 * asks for it in small pieces (`report` = what is new since its last ask, or
 * what happened inside one of the person's notes). Replay-driven actions are
 * left out (a run reports those itself). Password values are never recorded.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { UIDigest } from '../../web-extension/src/evidence/types.ts';
import type { Observer, Tracked } from './observe.ts';
import { isWrite } from './observe.ts';
import { digestOf } from './wait.ts';

type UserEvent = { n: number; t: number; k: 'click' | 'set' | 'nav'; text: string };
export type Note = { id: number; text: string; t: number; endT?: number; route: string; digest?: UIDigest; endDigest?: UIDigest };

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB');
const secs = (ms?: number) => (ms === undefined ? '' : ` (${(ms / 1000).toFixed(1)}s)`);
const LIMIT = 12;
const KEEP = 3000;

export class Watcher {
  private events: UserEvent[] = [];
  private seq = 0;
  private paused = false;
  private cursorN = 0;
  private cursorT = Date.now();
  private baseline?: UIDigest;
  /** calls that had not finished when last reported: say how they ended next time */
  private unfinished = new Set<Tracked>();
  readonly notes: Note[] = [];
  /** every event and note is also appended here (one JSON line each), so a closed session can still be read */
  logFile?: string;

  async attach(context: BrowserContext, route: (url: string) => string): Promise<void> {
    await context.exposeBinding('__rrNote', (_src, ev: { k: 'click' | 'set'; text: string }) => this.push(ev.k, ev.text));
    const watch = (page: Page) =>
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || this.paused) return;
        const text = route(frame.url());
        if (this.events.at(-1)?.k === 'nav' && this.events.at(-1)?.text === text) return;
        this.push('nav', text);
      });
    context.pages().forEach(watch);
    context.on('page', watch);
  }

  private push(k: UserEvent['k'], text: string): void {
    if (this.paused) return;
    const e = { n: ++this.seq, t: Date.now(), k, text };
    this.events.push(e);
    if (this.events.length > KEEP) this.events.shift();
    this.log({ type: 'event', ...e });
  }

  private log(line: object): void {
    if (!this.logFile) return;
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      appendFileSync(this.logFile, `${JSON.stringify(line)}\n`);
    } catch {
      // the log is a convenience; never fail a call over it
    }
  }

  /** A replay is driving the page: its actions are not yours. */
  pause(): void {
    this.paused = true;
  }

  async resume(page: Page | undefined): Promise<void> {
    this.paused = false;
    await this.mark(page);
  }

  /** Everything up to now counts as already seen. */
  async mark(page: Page | undefined): Promise<void> {
    this.cursorN = this.seq;
    this.cursorT = Date.now();
    this.unfinished.clear();
    this.baseline = page ? await digestOf(page) : undefined;
  }

  /** Stop recording what the person does (the notes stay). */
  stop(): void {
    this.paused = true;
  }

  /** `from`: the note covers what happens until it is closed. */
  async addNote(page: Page, text: string, from: boolean): Promise<Note> {
    const digest = await digestOf(page);
    const note: Note = { id: this.notes.length + 1, text, t: Date.now(), route: digest?.route ?? page.url(), digest };
    if (!from) note.endT = note.t;
    this.notes.push(note);
    this.log({ type: 'note', id: note.id, t: note.t, text, route: note.route, span: from });
    return note;
  }

  async closeNote(page: Page, id: number): Promise<Note | string> {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return `no note ${id}`;
    if (note.endT !== undefined) return `note ${id} is already closed`;
    note.endT = Date.now();
    note.endDigest = await digestOf(page);
    this.log({ type: 'note-done', id, t: note.endT });
    return note;
  }

  listNotes(): string {
    if (!this.notes.length) return 'no notes yet';
    return this.notes
      .map((n) => `${n.id} ${clock(n.t)} "${n.text.slice(0, 60)}" ${n.route}${n.endT === undefined ? ' (open: from here)' : n.endT === n.t ? '' : ` → ${clock(n.endT)}`}`)
      .join('\n');
  }

  /** What is new since the last ask; or, with a note id, what happened inside that note (does not move the cursor). */
  async report(page: Page | undefined, observer: Observer, noteId?: number): Promise<string> {
    if (noteId !== undefined) return this.reportNote(page, observer, noteId);
    if (!page) return 'no browser open; call watch {action:"start"} (or run) first';
    const fromN = this.cursorN;
    const since = this.cursorT;
    this.cursorN = this.seq;
    this.cursorT = Date.now();

    const events = this.events.filter((e) => e.n > fromN);
    const calls = observer.since(since, new Set());
    const finished = [...this.unfinished].filter((t) => !t.pending && !calls.includes(t));
    this.unfinished = new Set(calls.filter((t) => t.pending && t.resourceType !== 'document' && isWrite(t.method)));
    for (const t of this.unfinished) if (!calls.includes(t)) calls.push(t);

    const now = await digestOf(page);
    const prev = this.baseline;
    this.baseline = now ?? prev;
    const ui = prev && now ? await this.diff(page, prev, now) : [];
    const typing = await this.pendingField(page, events);
    const head = `since last fetch (${Math.max(1, Math.round((Date.now() - since) / 1000))}s ago) · ${now?.route ?? page.url()}`;
    return render(head, events, calls, finished, ui, typing);
  }

  private async reportNote(page: Page | undefined, observer: Observer, id: number): Promise<string> {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return `no note ${id}\n${this.listNotes()}`;
    const end = note.endT ?? Date.now();
    const events = this.events.filter((e) => e.t >= note.t && e.t <= end);
    const calls = observer.since(note.t, new Set()).filter((c) => c.start <= end);
    const now = note.endDigest ?? (note.endT === undefined && page ? await digestOf(page) : undefined);
    const ui = page && note.digest && now ? await this.diff(page, note.digest, now) : [];
    const state = note.endT === undefined ? 'open' : note.endT === note.t ? 'point note' : 'closed';
    const head = `note ${note.id} "${note.text.slice(0, 80)}" · ${clock(note.t)}${note.endT !== undefined && note.endT !== note.t ? ` → ${clock(note.endT)}` : ''} · ${state} · started on ${note.route}`;
    return render(head, events, calls, [], ui, undefined);
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

function render(head: string, events: UserEvent[], calls: Tracked[], finished: Tracked[], ui: string[], typing?: string): string {
  const lines: string[] = [];
  const user = collapse(events);
  if (user.length || typing) {
    lines.push('YOU');
    lines.push(...user.slice(-LIMIT).map((e) => `  ${clock(e.t)} ${e.k === 'nav' ? 'page → ' : e.k === 'click' ? 'click ' : 'set '}${e.text}`));
    if (user.length > LIMIT) lines.push(`  (${user.length - LIMIT} earlier not shown)`);
    if (typing) lines.push(`  now typing ${typing}`);
  }
  const net = describeCalls(calls, finished);
  if (net.length) lines.push('CALLS', ...net);
  if (ui.length) lines.push('SCREEN', ...ui.slice(0, 8).map((u) => `  ${u}`));
  return lines.length ? [head, ...lines].join('\n') : `${head}\nnothing changed`;
}

function collapse(events: UserEvent[]): UserEvent[] {
  const out: (UserEvent & { rep: number })[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && last.k === e.k && last.text === e.text) last.rep++;
    else if (last && last.k === 'set' && e.k === 'set' && last.text.split(' = ')[0] === e.text.split(' = ')[0]) out[out.length - 1] = { ...e, rep: 1 };
    else out.push({ ...e, rep: 1 });
  }
  return out.map((e) => (e.rep > 1 ? { ...e, text: `${e.text} ×${e.rep}` } : e));
}

function describeCalls(calls: Tracked[], finished: Tracked[]): string[] {
  const shown = calls.filter((c) => (c.resourceType !== 'document' && isWrite(c.method)) || c.failed || (c.status ?? 0) >= 400);
  const quiet = calls.length - shown.length;
  const row = (c: Tracked, tail = '') => `  ${clock(c.start)} ${c.endpoint} → ${c.failed ? 'FAILED' : c.pending ? 'still running' : (c.status ?? 'no answer')}${secs(c.ms)}${tail}`;
  const lines = [...finished.map((c) => row(c, ' — started before your last fetch')), ...shown.slice(-LIMIT).map((c) => row(c))];
  if (quiet > 0) lines.push(`  ${quiet} other call${quiet === 1 ? '' : 's'} ok`);
  return lines;
}
