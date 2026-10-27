import type { GenerateRequest, ModelClient } from './types.ts';

/** Deterministic stand-in: tests give it a function, `AGENT_MODEL=none` uses none at all. */
export class FakeModel implements ModelClient {
  readonly name = 'fake';
  calls: GenerateRequest[] = [];
  private readonly handler: (req: GenerateRequest) => unknown;
  constructor(handler: (req: GenerateRequest) => unknown) {
    this.handler = handler;
  }
  gpu(): boolean | null {
    return null;
  }
  async generate<T>(req: GenerateRequest): Promise<T> {
    this.calls.push(req);
    return this.handler(req) as T;
  }
}
