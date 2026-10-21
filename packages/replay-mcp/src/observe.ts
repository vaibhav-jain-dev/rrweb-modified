/**
 * Watch the page's own network the way the recorder did, so a replayed step
 * can be compared with the recorded one by templated endpoint, not by URL.
 */
import type { BrowserContext, Page, Request } from 'playwright';
import { templateEndpoint } from '../../web-extension/src/evidence/route-template.ts';
import type { ObservedCall } from './types.ts';

export type Tracked = ObservedCall & { start: number; end?: number; resourceType: string };

const RELEVANT = new Set(['fetch', 'xhr', 'document']);

export class Observer {
  readonly all: Tracked[] = [];
  private byRequest = new Map<Request, Tracked>();

  attach(context: BrowserContext): void {
    context.on('request', (req) => {
      const t: Tracked = {
        endpoint: templateEndpoint(req.method(), req.url()),
        method: req.method(),
        url: req.url(),
        start: Date.now(),
        resourceType: req.resourceType(),
        pending: true,
      };
      this.byRequest.set(req, t);
      this.all.push(t);
    });
    context.on('response', (res) => {
      const t = this.byRequest.get(res.request());
      if (t) t.status = res.status();
    });
    context.on('requestfinished', (req) => {
      const t = this.byRequest.get(req);
      if (!t) return;
      t.end = Date.now();
      t.ms = t.end - t.start;
      t.pending = false;
    });
    // A page that navigates right after a response (a login fetch, then
    // `location = …`) never reports `requestfinished` for it. Once the main
    // frame moves on, a call that already got its status is done.
    const watch = (page: Page) =>
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        const now = Date.now();
        for (const t of this.all) {
          if (t.pending && t.status !== undefined) {
            t.pending = false;
            t.end = now;
            t.ms = now - t.start;
          }
        }
      });
    context.pages().forEach(watch);
    context.on('page', watch);
    context.on('requestfailed', (req) => {
      const t = this.byRequest.get(req);
      if (!t) return;
      t.end = Date.now();
      t.ms = t.end - t.start;
      t.pending = false;
      t.failed = true;
    });
  }

  /** Relevant calls that started at or after `since`. */
  since(since: number, ignore: Set<string>): Tracked[] {
    return this.all.filter((t) => t.start >= since && RELEVANT.has(t.resourceType) && !ignore.has(t.endpoint));
  }
}

export function isWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
