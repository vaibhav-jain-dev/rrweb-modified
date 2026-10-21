/**
 * Read a recording-*.zip into an ordered list of replayable steps.
 *
 * Two clean-ups the raw `actions.json` needs before it can be played:
 * a typed value is flushed late, so a form shows `click Sign In`, `submit`,
 * then the inputs; and a click on `body` is the recorder noticing a dropdown
 * closing, not something to repeat.
 */
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { templateEndpoint, templateRoute } from '../../web-extension/src/evidence/route-template.ts';
import type {
  ActionRecord,
  NetworkRequest,
  UIDigest,
} from '../../web-extension/src/evidence/types.ts';
import type { Expect, ExpectedCall, Step } from './types.ts';

export type LoadedRecording = {
  path: string;
  name: string;
  pageOrigin: string;
  apiOrigins: string[];
  steps: Step[];
  network: NetworkRequest[];
  /** endpoints that repeat on a timer in the recording; never waited on */
  background: Set<string>;
  digests: Map<number, UIDigest>;
};

type DigestEntry = { actionSeq: number; digest?: UIDigest; sameAs?: number };

const FLUSH_WINDOW_MS = 3000;
const BACKGROUND_MIN_REPEATS = 3;

export function loadRecording(path: string): LoadedRecording {
  const files = unzipSync(new Uint8Array(readFileSync(path)), {
    filter: (f) =>
      f.name === 'actions.json' ||
      f.name === 'network/index.json' ||
      f.name === 'ui-state/digests.json',
  });
  const act = files['actions.json'];
  if (!act) throw new Error(`${path}: no actions.json (is this a recording-*.zip?)`);
  const actions = JSON.parse(strFromU8(act)) as ActionRecord[];
  const net = files['network/index.json'];
  const network = net ? (JSON.parse(strFromU8(net)) as NetworkRequest[]) : [];
  const dig = files['ui-state/digests.json'];
  const digestList = dig ? (JSON.parse(strFromU8(dig)) as DigestEntry[]) : [];

  const digests = new Map<number, UIDigest>();
  for (const d of digestList) {
    const resolved = d.digest ?? (d.sameAs !== undefined ? digests.get(d.sameAs) : undefined);
    if (resolved) digests.set(d.actionSeq, resolved);
  }

  const first = actions[0];
  const pageOrigin = first ? new URL(first.page.url).origin : '';
  const apiOrigins = [
    ...new Set(
      network
        .filter((r) => r.resourceType?.toLowerCase() === 'fetch' || r.resourceType?.toLowerCase() === 'xhr')
        .map((r) => originOf(r.url))
        .filter((o) => o && o !== pageOrigin),
    ),
  ];

  const background = findBackground(network);
  const { ordered, merged } = reorder(actions);
  const steps = ordered.map((a) => toStep(a, merged.get(a.seq) ?? [], network, digests, background));
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    pageOrigin,
    apiOrigins,
    steps,
    network,
    background,
    digests,
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Endpoints hit repeatedly with no action behind them: polling. */
function findBackground(network: NetworkRequest[]): Set<string> {
  const counts = new Map<string, number>();
  for (const r of network) {
    if (r.actionSeq !== undefined) continue;
    const key = templateEndpoint(r.method, r.url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= BACKGROUND_MIN_REPEATS).map(([k]) => k));
}

/**
 * `click Sign In`, `submit`, `input…` becomes `input…`, `click Sign In`: the
 * click is what submits, so the separate `submit` is dropped. Only a run of
 * inputs that follows within FLUSH_WINDOW_MS on the same page is moved.
 */
function reorder(actions: ActionRecord[]): { ordered: ActionRecord[]; merged: Map<number, number[]> } {
  const out: ActionRecord[] = [];
  // the dropped `submit` owns the sign-in call; its seq is merged into the click
  const merged = new Map<number, number[]>();
  let i = 0;
  while (i < actions.length) {
    const a = actions[i];
    const next = actions[i + 1];
    const trigger = a.type === 'click' && next?.type === 'submit' ? 2 : a.type === 'submit' ? 1 : 0;
    if (trigger) {
      const after = i + trigger;
      let j = after;
      while (
        j < actions.length &&
        actions[j].type === 'input' &&
        actions[j].page.url === a.page.url &&
        actions[j].t - actions[after - 1].t <= FLUSH_WINDOW_MS
      ) {
        j++;
      }
      if (j > after) {
        out.push(...actions.slice(after, j));
        out.push(a);
        if (trigger === 2) merged.set(a.seq, [next.seq]);
        i = j;
        continue;
      }
    }
    out.push(a);
    i++;
  }
  return { ordered: out, merged };
}

function toStep(
  a: ActionRecord,
  alsoSeqs: number[],
  network: NetworkRequest[],
  digests: Map<number, UIDigest>,
  background: Set<string>,
): Step {
  const t = a.target;
  const inputType = t?.attrs?.type;
  const rawName = t?.tag === 'BODY' ? undefined : (t?.accessibleName ?? t?.text ?? t?.attrs?.placeholder);
  const name = rawName?.replace(/\u200b/g, '').trim() || undefined;
  const step: Step = {
    seq: a.seq,
    type: a.type,
    url: a.page.url,
    route: templateRoute(a.page.route),
    locator: t?.locator,
    candidates: [...new Set([t?.locator, ...(t?.selectorCandidates ?? []).map((c) => `css=${c}`)].filter((x): x is string => !!x))],
    role: t?.role,
    name,
    inputType,
    value: a.value,
    label: labelFor(a, name),
    expect: expectFor(a, alsoSeqs, network, digests, background),
  };
  if (inputType === 'password') step.value = '$secret.PASSWORD';
  if (a.type === 'scroll') step.skip = 'scroll';
  else if (step.locator === 'css=body') step.skip = 'body click (closes an overlay)';
  else if (a.type === 'submit') step.skip = 'submit (the click already submits)';
  return step;
}

function labelFor(a: ActionRecord, name?: string): string {
  const n = name && name.trim() ? `"${name.replace(/​/g, '').slice(0, 40)}"` : (a.target?.locator ?? '').replace(/^css=/, '').slice(-60);
  switch (a.type) {
    case 'input':
      return a.target?.attrs?.type === 'password' ? `type password into ${n}` : `type "${(a.value ?? '').slice(0, 30)}" into ${n}`;
    case 'click':
    case 'dblclick':
      return `click ${n}`;
    case 'navigate':
      return `go to ${templateRoute(a.page.route)}`;
    default:
      return `${a.type} ${n}`.trim();
  }
}

function expectFor(
  a: ActionRecord,
  alsoSeqs: number[],
  network: NetworkRequest[],
  digests: Map<number, UIDigest>,
  background: Set<string>,
): Expect {
  const calls: ExpectedCall[] = [];
  for (const r of network) {
    if ((r.actionSeq !== a.seq && !alsoSeqs.includes(r.actionSeq ?? -1)) || r.tier !== 'primary' || r.method === 'OPTIONS') continue;
    const endpoint = templateEndpoint(r.method, r.url);
    if (background.has(endpoint)) continue;
    calls.push({ endpoint, status: r.failed ? 0 : (r.status ?? 0), ms: Math.round(r.duration ?? 0) });
  }
  const lastSeq = alsoSeqs.length ? Math.max(a.seq, ...alsoSeqs) : a.seq;
  const here = digests.get(lastSeq);
  const before = digests.get(a.seq - 1);
  // The recorder takes its digest as soon as the step settles, so a sign-in
  // whose redirect lands a moment later is recorded as "still on /login".
  // Only a navigation the recording actually saw is expected back.
  const routeBefore = templateRoute(before?.route ?? a.page.route);
  const routeAfter = here ? templateRoute(here.route) : undefined;
  const known = new Set((before?.status ?? []).map((s) => s.text));
  const toasts = (here?.status ?? []).map((s) => s.text.trim()).filter((s) => s && !known.has(s));
  return {
    route: routeAfter && routeAfter !== routeBefore ? routeAfter : undefined,
    calls,
    toasts,
    recordedMs: calls.reduce((m, c) => Math.max(m, c.ms), 0),
  };
}

/** The one-line-per-step list the bot reads instead of the whole flow. */
export function stepList(rec: LoadedRecording): string {
  return rec.steps
    .map((s) => {
      const writes = s.expect.calls.filter((c) => !c.endpoint.startsWith('GET '));
      const tail = writes.length ? `  → ${writes.map((c) => `${c.endpoint} ${c.status}`).join(', ')}` : '';
      return `${String(s.seq).padStart(3)} ${s.skip ? '·' : ' '} ${s.label}  [${s.route}]${tail}${s.skip ? `  (skipped: ${s.skip})` : ''}`;
    })
    .join('\n');
}
