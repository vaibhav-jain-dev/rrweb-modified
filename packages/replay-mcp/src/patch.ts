import { z } from 'zod/v4';
import type { Step } from './types.ts';

const NewStep = z.object({
  type: z.enum(['click', 'input', 'select', 'toggle', 'navigate', 'key']),
  locator: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
});

export const PatchSchema = z.object({
  /** `"18.value": "check 2"` — change a field of one step */
  set: z.record(z.string(), z.string()).optional(),
  /** step numbers not to run */
  skip: z.array(z.number().int()).optional(),
  /** run only this inclusive range */
  range: z.tuple([z.number().int(), z.number().int()]).optional(),
  /** replace a step entirely, keyed by seq */
  replace: z.record(z.string(), NewStep).optional(),
  /** add steps after a seq */
  insert: z.array(z.object({ after: z.number().int(), step: NewStep })).optional(),
});
export type Patch = z.infer<typeof PatchSchema>;

const SETTABLE = new Set(['value', 'locator', 'name', 'url']);

/** Apply a patch to a step list. Throws with a message the bot can act on. */
export function applyPatch(steps: Step[], patch: Patch | undefined): Step[] {
  let out = steps.map((s) => ({ ...s, expect: { ...s.expect } }));
  if (!patch) return out;
  const bySeq = (seq: number) => {
    const s = out.find((x) => x.seq === seq);
    if (!s) throw new Error(`patch names step ${seq}, which is not in the recording`);
    return s;
  };
  for (const [key, val] of Object.entries(patch.set ?? {})) {
    const [seqText, field] = key.split('.');
    const step = bySeq(Number(seqText));
    if (!SETTABLE.has(field)) throw new Error(`patch.set "${key}": field must be one of ${[...SETTABLE].join(', ')}`);
    (step as Record<string, unknown>)[field] = val;
    if (field === 'locator') step.candidates = [val];
    step.label = step.label.replace(/type ".*?"/, `type "${val.slice(0, 30)}"`);
  }
  for (const seq of patch.skip ?? []) bySeq(seq).skip = 'skipped by patch';
  for (const [seqText, ns] of Object.entries(patch.replace ?? {})) {
    const step = bySeq(Number(seqText));
    Object.assign(step, newStep(step.seq, ns, step));
  }
  for (const ins of patch.insert ?? []) {
    const idx = out.findIndex((s) => s.seq === ins.after);
    if (idx < 0) throw new Error(`patch.insert after ${ins.after}: no such step`);
    out.splice(idx + 1, 0, newStep(ins.after + 0.5, ins.step, out[idx]));
  }
  if (patch.range) {
    const [from, to] = patch.range;
    out = out.map((s) => (s.seq < from || s.seq > to ? { ...s, skip: s.skip ?? 'outside range' } : s));
  }
  return out;
}

function newStep(seq: number, ns: z.infer<typeof NewStep>, base: Step): Step {
  return {
    ...base,
    seq,
    type: ns.type,
    locator: ns.locator,
    candidates: ns.locator ? [ns.locator] : [],
    value: ns.value,
    url: ns.url ?? base.url,
    skip: undefined,
    // nothing of the replaced step's identity may leak into locating the new one
    name: undefined,
    role: undefined,
    inputType: undefined,
    label: ns.label ?? `${ns.type} ${ns.locator ?? ns.url ?? ''}`.trim(),
    expect: { calls: [], toasts: [], recordedMs: 0 },
  };
}

/** `$secret.NAME` → env REPLAY_SECRET_NAME. Never reads the recording. */
export function resolveValue(value: string | undefined): string | undefined {
  if (!value?.startsWith('$secret.')) return value;
  const key = `REPLAY_SECRET_${value.slice('$secret.'.length).toUpperCase()}`;
  const v = process.env[key];
  if (v === undefined) throw new Error(`step needs a secret: set ${key} in the environment`);
  return v;
}
