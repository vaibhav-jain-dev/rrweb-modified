import {
  ModelError,
  type GenerateRequest,
  type ModelClient,
  type Priority,
} from './types.ts';

const PRIORITY_ORDER: Record<Priority, number> = {
  ask: 0,
  extract: 1,
  note: 2,
};
/** Background notes are dropped, not queued, once this many requests wait. */
const NOTE_QUEUE_LIMIT = 3;

type Job = {
  req: GenerateRequest;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  seq: number;
};

export type OllamaOptions = {
  host: string;
  model: string;
  numCtx?: number;
  keepAlive?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * One request in flight at a time (a 3B model on one GPU gains nothing from
 * concurrency and the page would feel it), priority-ordered, JSON-schema
 * constrained.
 */
export class OllamaClient implements ModelClient {
  readonly name: string;
  private readonly host: string;
  private readonly numCtx: number;
  private readonly keepAlive: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private queue: Job[] = [];
  private running = false;
  private seq = 0;
  private onGpu: boolean | null = null;

  constructor(opts: OllamaOptions) {
    this.name = opts.model;
    this.host = opts.host.replace(/\/+$/, '');
    this.numCtx = opts.numCtx ?? 4096;
    this.keepAlive = opts.keepAlive ?? '30m';
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  gpu(): boolean | null {
    return this.onGpu;
  }

  generate<T>(req: GenerateRequest): Promise<T> {
    if (req.priority === 'note' && this.queue.length >= NOTE_QUEUE_LIMIT) {
      return Promise.reject(new ModelError('busy', 'model queue is busy'));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        req,
        resolve: resolve as (v: unknown) => void,
        reject,
        seq: this.seq++,
      });
      this.queue.sort(
        (a, b) =>
          PRIORITY_ORDER[a.req.priority] - PRIORITY_ORDER[b.req.priority] ||
          a.seq - b.seq,
      );
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        try {
          job.resolve(await this.call(job.req));
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async call(req: GenerateRequest): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.name,
          stream: false,
          format: req.schema,
          keep_alive: this.keepAlive,
          options: { temperature: 0, num_ctx: this.numCtx, num_predict: 256 },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (e) {
      throw new ModelError(
        'unavailable',
        `ollama: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok)
      throw new ModelError('unavailable', `ollama answered ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    void this.refreshGpu();
    try {
      return JSON.parse(data.message?.content ?? '');
    } catch {
      throw new ModelError('invalid', 'ollama did not return JSON');
    }
  }

  /** The loaded model reports how much of itself sits in VRAM. */
  private async refreshGpu(): Promise<void> {
    try {
      const res = await this.doFetch(`${this.host}/api/ps`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = (await res.json()) as {
        models?: {
          name: string;
          model?: string;
          size: number;
          size_vram: number;
        }[];
      };
      const mine = data.models?.find(
        (m) => m.name === this.name || m.model === this.name,
      );
      if (mine && mine.size > 0)
        this.onGpu = mine.size_vram >= mine.size * 0.95;
    } catch {
      /* leave as-is */
    }
  }
}
