import type {
  AgentEventPayload,
  AgentResult,
  Ledger,
  RequestDetail,
} from '../../web-extension/src/agent/protocol.ts';
import { renderAgentLog } from '../../web-extension/src/agent/log.ts';
import type { PlaybookDef } from './config/types.ts';
import { toRequestRecord } from './endpoint.ts';
import { Lane } from './lane.ts';
import type { ModelClient } from './model/types.ts';
import type { RequestRecord } from './sources/types.ts';
import type { ToolRegistry } from './tools/registry.ts';

const MAX_REQUESTS = 400;

const EMIT_DEBOUNCE_MS = 150;

export type SessionOptions = {
  sessionId: string;
  startedAt: number;
  pageOrigin: string;
  playbooks: PlaybookDef[];
  registry: ToolRegistry;
  model: ModelClient | null;
  reference: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type SessionListener = (
  e:
    | { type: 'ledger'; ledger: Ledger }
    | { type: 'gate'; playbookId: string; t: number }
    | { type: 'end' },
) => void;

/**
 * Everything the backend holds for one recording. Bodies live here, in
 * memory, bounded; they are never written to disk and die with the process.
 */
export class SessionRuntime {
  readonly sessionId: string;
  readonly startedAt: number;
  private readonly requests: RequestRecord[] = [];
  private readonly lanes: Lane[] = [];
  private readonly listeners = new Set<SessionListener>();
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private endedAt: number | undefined;
  private result: AgentResult | undefined;
  private adhoc: Lane | undefined;
  private readonly now: () => number;
  private readonly opts: SessionOptions;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.startedAt = opts.startedAt;
    this.now = opts.now ?? Date.now;
    for (const pb of opts.playbooks) this.lanes.push(this.makeLane(pb));
  }

  private makeLane(pb: PlaybookDef): Lane {
    return new Lane(pb, {
      registry: this.opts.registry,
      model: this.opts.model,
      reference: this.opts.reference,
      startedAt: this.startedAt,
      now: this.now,
      sleep: this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      requests: () => this.requests,
      onChange: () => this.scheduleEmit(),
      onGate: (t) => {
        for (const l of this.listeners)
          l({ type: 'gate', playbookId: pb.id, t });
      },
    });
  }

  laneIds(): string[] {
    return this.lanes.map((l) => l.pb.id);
  }

  subscribe(fn: SessionListener): () => void {
    this.listeners.add(fn);
    fn({ type: 'ledger', ledger: this.ledger() });
    if (this.result) fn({ type: 'end' });
    return () => this.listeners.delete(fn);
  }

  ingest(ev: AgentEventPayload): void {
    if (this.endedAt !== undefined) return;
    if (ev.kind !== 'network') return; // lanes read the network; other kinds ride along for the export only
    if (ev.payload.method.toUpperCase() === 'OPTIONS') return;
    const rec = toRequestRecord(ev.payload, this.startedAt);
    this.requests.push(rec);
    if (this.requests.length > MAX_REQUESTS) this.requests.shift();
    for (const lane of this.lanes) lane.onRequest(rec);
    if (this.adhoc) this.adhoc.onRequest(rec);
  }

  async ask(
    text: string,
    playbookId?: string,
  ): Promise<{ ok: boolean; checkId?: string; message?: string }> {
    let lane = playbookId
      ? this.lanes.find((l) => l.pb.id === playbookId)
      : this.lanes[0];
    if (!lane) {
      // Asking works without any playbook: a lane with no rules of its own.
      if (!this.adhoc) {
        this.adhoc = this.makeLane({
          id: 'asks',
          title: 'Asks',
          brief: '',
          ignore: [],
          rules: [],
          steps: [],
          needsModel: true,
          hash: 'adhoc',
          file: '(runtime)',
        });
        this.lanes.push(this.adhoc);
      }
      lane = this.adhoc;
    }
    return lane.ask(text);
  }

  requestDetail(requestId: string): RequestDetail | undefined {
    const r = this.requests.find((x) => x.requestId === requestId);
    if (!r) return undefined;
    return {
      requestId: r.requestId,
      method: r.method,
      url: r.url,
      endpoint: r.endpoint,
      status: r.status,
      requestBody: preview(r.requestBody),
      responseBody: preview(r.responseBody),
      truncated: r.truncated,
    };
  }

  ledger(): Ledger {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      model: this.opts.model?.name ?? undefined,
      lanes: this.lanes.map((l) => l.ledger()),
    };
  }

  private scheduleEmit(): void {
    if (this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const ledger = this.ledger();
      for (const l of this.listeners) l({ type: 'ledger', ledger });
    }, EMIT_DEBOUNCE_MS);
  }

  /** Close out lanes and produce the result once; later calls return the same one. */
  async stop(endedAt: number): Promise<AgentResult> {
    if (this.result) return this.result;
    this.endedAt = endedAt;
    await Promise.all(this.lanes.map((l) => l.finalize()));
    if (this.emitTimer !== undefined) clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    const ledger = this.ledger();
    this.result = { ledger, log: renderAgentLog(ledger) };
    for (const l of this.listeners) {
      l({ type: 'ledger', ledger });
      l({ type: 'end' });
    }
    return this.result;
  }

  get isEnded(): boolean {
    return this.result !== undefined;
  }
}

function preview(v: unknown): unknown {
  if (typeof v === 'string')
    return v.length > 4096 ? `${v.slice(0, 4096)}…` : v;
  const s = JSON.stringify(v);
  if (s === undefined) return undefined;
  return s.length > 4096 ? `${s.slice(0, 4096)}…` : v;
}
