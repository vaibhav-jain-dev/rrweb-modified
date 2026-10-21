/**
 * The replay browser is only kept while the bot is around. Any tool call
 * renews the lease; with no call for `ttlMs` the browser is closed (the saved
 * sign-in stays). A call that is still running holds the lease.
 */
export class Lease {
  private timer?: ReturnType<typeof setTimeout>;
  private last = Date.now();
  private busy = 0;
  private closedAt?: number;

  readonly ttlMs: number;
  private onExpire: () => Promise<void> | void;

  constructor(ttlMs: number, onExpire: () => Promise<void> | void) {
    this.ttlMs = ttlMs;
    this.onExpire = onExpire;
  }

  touch(): void {
    this.last = Date.now();
    this.arm();
  }

  async hold<T>(fn: () => Promise<T> | T): Promise<T> {
    this.busy++;
    try {
      return await fn();
    } finally {
      this.busy--;
      this.touch();
    }
  }

  remainingMs(): number {
    return Math.max(0, this.last + this.ttlMs - Date.now());
  }

  /** Set once the browser was closed for being idle; read once, then cleared. */
  takeExpiryNotice(): string | undefined {
    if (this.closedAt === undefined) return undefined;
    const at = new Date(this.closedAt).toLocaleTimeString('en-GB');
    this.closedAt = undefined;
    return `the browser was closed at ${at} after ${Math.round(this.ttlMs / 60000)} min with no call from you; the sign-in is kept and the next run reopens it`;
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), this.ttlMs);
  }

  private async fire(): Promise<void> {
    if (this.busy > 0) return this.arm();
    this.closedAt = Date.now();
    await this.onExpire();
  }
}
