/**
 * A write that timed out may still have landed. The runner never sends it
 * again on a guess: it asks a verifier, and with no answer it stops.
 */
import type { Tracked } from './observe.ts';
import { isWrite } from './observe.ts';

export type WriteVerdict = 'landed' | 'not_landed' | 'unknown';

export interface WriteVerifier {
  check(call: { endpoint: string; url: string; method: string }): Promise<WriteVerdict>;
}

/** Writes in this step that never got an answer. */
export function unansweredWrites(calls: Tracked[]): Tracked[] {
  return calls.filter((c) => isWrite(c.method) && ((c.pending && c.status === undefined) || (c.failed && c.status === undefined)));
}

/**
 * Verifier backed by a URL: GET `<base>?endpoint=…&url=…` returning
 * `{"landed": true|false}`. Lets the agent-backend (or any service that can
 * look the record up) answer without this package knowing the database.
 */
export function httpVerifier(base: string): WriteVerifier {
  return {
    async check(call) {
      try {
        const u = new URL(base);
        u.searchParams.set('endpoint', call.endpoint);
        u.searchParams.set('url', call.url);
        const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return 'unknown';
        const body = (await res.json()) as { landed?: boolean };
        return body.landed === true ? 'landed' : body.landed === false ? 'not_landed' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}
