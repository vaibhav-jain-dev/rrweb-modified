/** `ask` jumps the queue, `extract` next, `note` is dropped when the queue is deep. */
export type Priority = 'ask' | 'extract' | 'note';

export type GenerateRequest = {
  system: string;
  user: string;
  /** JSON schema the answer must satisfy; the model is constrained to it. */
  schema: Record<string, unknown>;
  priority: Priority;
};

export class ModelError extends Error {
  kind: 'busy' | 'unavailable' | 'invalid';
  constructor(kind: 'busy' | 'unavailable' | 'invalid', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ModelClient {
  /** Model name for the ledger, or null when none is configured. */
  readonly name: string | null;
  /** true = running on GPU, false = CPU or split, null = not known yet. */
  gpu(): boolean | null;
  generate<T>(req: GenerateRequest): Promise<T>;
}
