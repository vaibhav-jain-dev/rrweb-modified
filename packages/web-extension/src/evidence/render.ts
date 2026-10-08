/**
 * Render an EvidenceBundle into the exported package's text artifacts.
 *
 * The overriding design goal here is token economy: `flow.md` is what an
 * AI agent reads first (and often only), so every request becomes one
 * line - METHOD path \> status (duration) - never a dumped body, never
 * headers, with noise collapsed to a single count line. Full detail stays
 * one hop away in `actions.json` / `network/index.json` / `raw/`.
 */
import type {
  ActionRecord,
  EvidenceBundle,
  NetworkRequest,
  NoteSpan,
  UiDataFinding,
} from './types';
import { inferApiOrigins } from './classify';
import { templateRoute } from './route-template';
import { describeActionRange } from './notes';

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

function formatTime(t: number): string {
  const d = new Date(t);
  return d.toISOString().slice(11, 19);
}

/** The longest a target name may be in a flow line. A form's accessible
 * name is often the whole form's text; past this it says nothing a reader
 * can use, and it costs as much as the rest of the block. */
const MAX_LABEL = 60;

/**
 * A short, honest name for what was acted on: the accessible name, the
 * visible text or the locator when one of them is short enough; otherwise
 * the shortest of them cut to MAX_LABEL. A target with no name at all is
 * said to be unlabelled rather than dressed up as a selector.
 */
function targetName(action: ActionRecord): string {
  const target = action.target;
  if (!target) return '(unlabeled element)';
  const candidates = [target.accessibleName, target.text, target.locator]
    .map((c) => (c ?? '').replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 0);
  const fits = candidates.find((c) => c.length <= MAX_LABEL);
  if (fits) return fits;
  if (candidates.length > 0) {
    const shortest = candidates.reduce((a, b) => (a.length <= b.length ? a : b));
    return `${shortest.slice(0, MAX_LABEL - 1)}…`;
  }
  const tag = (target.tag || 'element').toLowerCase();
  const selector = target.selector ? ` ${truncate(target.selector, 50)}` : '';
  return `unlabelled ${tag}${selector}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function actionLabel(action: ActionRecord): string {
  const target = action.target;
  const name = targetName(action);
  const value = action.value ?? '';
  switch (action.type) {
    case 'click':
      return `Clicked "${name}"`;
    case 'dblclick':
      return `Double-clicked "${name}"`;
    case 'input':
      return `Typed "${value}" into "${name}"`;
    case 'select':
      return `Selected "${value}" in "${name}"`;
    case 'toggle':
      return `Toggled "${name}"${action.value ? ` to ${value}` : ''}`;
    case 'submit':
      return `Submitted "${name}"`;
    case 'key':
      return `Pressed ${value} on "${name}"`;
    case 'scroll':
      return `Scrolled "${target ? name : templateRoute(action.page.route)}"`;
    case 'navigate':
      return `Navigated to ${templateRoute(action.page.route)}`;
    case 'reload':
      return `Reloaded ${templateRoute(action.page.route)}`;
    case 'back':
      return `Went back to ${templateRoute(action.page.route)}`;
    case 'forward':
      return `Went forward to ${templateRoute(action.page.route)}`;
    case 'redirect':
      return `Redirected to ${templateRoute(action.page.route)}`;
    case 'tab-open':
      return `Opened new tab: ${templateRoute(action.page.route)}`;
    case 'tab-close':
      return `Closed tab`;
    default:
      // Exhaustively handled above; this only fires for an ActionType
      // this function hasn't been updated for yet.
      return `${String(action.type)} on "${name}"`;
  }
}


/**
 * The recorder's comments live inline, in the flow, where they apply - one
 * place, nothing to cross-reference. A note opens before the first action at
 * or after it, carrying its text, time range and the actions it covers; it
 * closes after the last action inside it. Nesting shows as indentation.
 */
function noteStartLines(notes: NoteSpan[], emitted: Set<string>, upTo: number): string[] {
  const lines: string[] = [];
  for (const n of notes) {
    if (emitted.has(`s:${n.id}`) || n.startedAt > upTo) continue;
    emitted.add(`s:${n.id}`);
    const end = n.closed ? formatTime(n.endedAt) : `${formatTime(n.endedAt)}, never marked done - ended with the recording`;
    lines.push(`${noteIndent(n)}NOTE ▶ ${n.text}`);
    lines.push(`${noteIndent(n)}  (recorder's comment, ${formatTime(n.startedAt)} → ${end} · ${describeActionRange(n)})`);
  }
  if (lines.length) lines.push('');
  return lines;
}

function noteEndLines(notes: NoteSpan[], emitted: Set<string>, nextActionT: number | undefined): string[] {
  const lines: string[] = [];
  // Innermost first, so nested notes close in the order they were opened.
  for (const n of [...notes].reverse()) {
    if (emitted.has(`e:${n.id}`) || !emitted.has(`s:${n.id}`)) continue;
    if (nextActionT !== undefined && n.endedAt >= nextActionT) continue;
    emitted.add(`e:${n.id}`);
    lines.push(`${noteIndent(n)}NOTE ■ ${n.closed ? 'done' : 'still open'}: ${truncate(n.text, 40)}`);
  }
  if (lines.length) lines.push('');
  return lines;
}

function noteIndent(span: NoteSpan): string {
  return '  '.repeat(span.depth);
}

function renderNetworkLine(req: NetworkRequest): string {
  const status = req.failed ? 'FAILED' : (req.status ?? '?');
  const duration = req.duration !== undefined ? ` (${Math.round(req.duration)}ms)` : '';
  return `  ${req.method} ${shortenUrl(req.url)} → ${status}${duration}`;
}

/**
 * Render the compact flow: one block per action, each with at most a
 * handful of network lines (primary requests individually, everything
 * else collapsed to counts), the UI diff summary, and a screenshot
 * pointer. Designed to stay well under typical context budgets even for a
 * session with 50+ actions.
 */
export function renderFlow(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`# Flow: ${bundle.session.name}`);
  lines.push('');
  lines.push(
    `Recorded ${new Date(bundle.session.createTimestamp).toISOString()} · ${bundle.actions.length} actions · capture mode: ${bundle.session.captureMode}`,
  );
  // Said once here, not under every action: for a 50-action session the
  // per-action version was a quarter of the file saying the same thing.
  lines.push(
    'Detail for any ACTION n: actions.json[n] · network/index.json entries with actionSeq=n · ui-state/digests.json actionSeq=n · screenshots/action-000n-after.jpg',
  );
  lines.push('');
  lines.push(...renderSummary(bundle));
  lines.push('');
  const notes = bundle.notes ?? [];
  const emittedNotes = new Set<string>();

  const requestsByAction = new Map<number, NetworkRequest[]>();
  for (const req of bundle.network) {
    if (req.actionSeq === undefined) continue;
    const list = requestsByAction.get(req.actionSeq) ?? [];
    list.push(req);
    requestsByAction.set(req.actionSeq, list);
  }
  const consoleByAction = new Map<number, typeof bundle.console>();
  for (const c of bundle.console) {
    if (c.actionSeq === undefined) continue;
    const list = consoleByAction.get(c.actionSeq) ?? [];
    list.push(c);
    consoleByAction.set(c.actionSeq, list);
  }
  const storageByAction = new Map<number, typeof bundle.storage>();
  for (const s of bundle.storage) {
    if (s.actionSeq === undefined) continue;
    const list = storageByAction.get(s.actionSeq) ?? [];
    list.push(s);
    storageByAction.set(s.actionSeq, list);
  }

  bundle.actions.forEach((action, i) => {
    lines.push(...noteStartLines(notes, emittedNotes, action.t));
    // The route is templated (ids replaced by :id) so a reader sees the
    // screen, not the visit; the exact route is in actions.json.
    lines.push(`ACTION ${action.seq}  ·  ${formatTime(action.t)}  ·  ${templateRoute(action.page.route)}`);
    lines.push(actionLabel(action));
    lines.push('');

    const requests = requestsByAction.get(action.seq) ?? [];
    if (requests.length === 0) {
      lines.push('NETWORK  (no network activity)');
    } else {
      lines.push('NETWORK');
      const primary = requests.filter((r) => r.tier !== 'noise');
      const noise = requests.filter((r) => r.tier === 'noise');
      for (const req of primary.slice(0, 8)) {
        lines.push(renderNetworkLine(req));
        if (req.ambiguous) lines.push('    (ambiguous: overlapped with a nearby action)');
        if (req.completedAfterSettle) lines.push('    (completed after this action settled)');
      }
      if (primary.length > 8) lines.push(`  … and ${primary.length - 8} more primary requests`);
      if (noise.length > 0) lines.push(`  (+ ${noise.length} lower-relevance request${noise.length === 1 ? '' : 's'} omitted)`);
    }
    lines.push('');

    const diff = bundle.diffs[i];
    if (diff && diff.summary.length > 0) {
      lines.push('UI');
      for (const line of diff.summary) lines.push(`  - ${line}`);
      lines.push('');
    }

    const storageChanges = storageByAction.get(action.seq);
    if (storageChanges?.length) {
      lines.push('STORAGE');
      for (const s of storageChanges) {
        const value = typeof s.value === 'string' ? s.value : `[redacted:${(s.value as { reason: string })?.reason ?? '?'}]`;
        lines.push(`  ${s.area}Storage: ${s.key} = "${value}"`);
      }
      lines.push('');
    }

    // Debug lines dominate a real session (42 of 47 in one recording) and
    // say nothing about what the user saw; they stay in console.json.
    const consoleEntries = consoleByAction.get(action.seq)?.filter((c) => c.level !== 'debug');
    if (consoleEntries?.length) {
      lines.push('CONSOLE');
      for (const c of consoleEntries.slice(0, 4)) {
        lines.push(`  [${c.level}] ${c.text.slice(0, 200)}`);
      }
      if (consoleEntries.length > 4) lines.push(`  … and ${consoleEntries.length - 4} more in console.json`);
      lines.push('');
    }

    const screenshot = bundle.screenshots.find(
      (s) => s.actionSeq === action.seq && s.phase === 'after',
    );
    if (screenshot) {
      lines.push(`SCREENSHOT  ${screenshot.path}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push(...noteEndLines(notes, emittedNotes, bundle.actions[i + 1]?.t));
  });
  // Notes that opened after the last action, or covered no action at all.
  lines.push(...noteStartLines(notes, emittedNotes, Number.POSITIVE_INFINITY));
  lines.push(...noteEndLines(notes, emittedNotes, undefined));

  const polling = summarizeUnattributed(bundle.network);
  if (polling.length) {
    lines.push('BACKGROUND ACTIVITY (not tied to any specific action)');
    for (const line of polling) lines.push(`  - ${line}`);
  }

  return lines.join('\n');
}

/**
 * The ten-line summary at the top of flow.md: what the session touched,
 * in the numbers a reader needs before deciding where to look. It is the
 * cheapest answer to "is the thing I am looking for even in here".
 */
function renderSummary(bundle: EvidenceBundle): string[] {
  const lines: string[] = ['SUMMARY'];
  const pageOrigin = bundle.actions[0] ? originOf(bundle.actions[0].page.url) : '';
  if (pageOrigin) lines.push(`  page origin:  ${pageOrigin}`);
  const apiOrigins = inferApiOrigins(bundle.network).filter((o) => o !== pageOrigin);
  if (apiOrigins.length) lines.push(`  api origins:  ${apiOrigins.join(', ')}`);

  const routes: string[] = [];
  for (const action of bundle.actions) {
    const route = templateRoute(action.page.route);
    if (routes[routes.length - 1] !== route) routes.push(route);
  }
  if (routes.length) {
    const shown = routes.slice(0, 8).join(' → ');
    lines.push(`  routes:       ${shown}${routes.length > 8 ? ` → … (${routes.length - 8} more)` : ''}`);
  }

  const tiers = { primary: 0, secondary: 0, noise: 0 };
  for (const req of bundle.network) tiers[req.tier ?? 'secondary']++;
  const failed = bundle.network.filter((r) => r.failed || (r.status !== undefined && r.status >= 400)).length;
  lines.push(
    `  requests:     ${bundle.network.length} (${tiers.primary} primary · ${tiers.secondary} secondary · ${tiers.noise} noise)` +
      (failed ? ` · ${failed} failed or ≥400` : ''),
  );

  const distinct = new Set(bundle.findings.map(findingGroupKey)).size;
  lines.push(`  findings:     ${distinct} distinct candidates (${bundle.findings.length} raw) — see findings.md`);

  const redacted = Object.values(bundle.redactionReport ?? {}).reduce((a, b) => a + b, 0);
  if (redacted) lines.push(`  redacted:     ${redacted} values removed at capture — see redaction-report.json`);
  return lines;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function summarizeUnattributed(network: NetworkRequest[]): string[] {
  const unattributed = network.filter((r) => r.actionSeq === undefined);
  if (unattributed.length === 0) return [];
  const byUrl = new Map<string, number>();
  for (const r of unattributed) byUrl.set(r.url, (byUrl.get(r.url) ?? 0) + 1);
  return Array.from(byUrl.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) =>
      count > 1 ? `${shortenUrl(url)} ×${count}` : shortenUrl(url),
    );
}

// A Map, not an object literal: the FindingKind values are intentionally
// snake_case (they read as external, JSON-facing identifiers throughout
// this file and its tests), which the object-literal-key form of eslint's
// camelcase rule would otherwise flag as if they were JS identifiers.
const FINDING_HEADERS = new Map<UiDataFinding['kind'], string>([
  ['count_mismatch', 'Count mismatch'],
  ['missing_in_ui', 'API field with no UI representation'],
  ['hidden_in_ui', 'Data present but inaccessible in the UI'],
  ['value_mismatch', 'Value mismatch'],
  ['stale_in_ui', 'Stale UI value'],
  ['not_focusable', 'Control not focusable / unnamed'],
  ['truncated', 'Truncated rendered text'],
  ['unreachable_nav', 'Unreachable navigation item'],
  ['hidden_tab', 'Hidden tab'],
  ['incomplete_table', 'Incomplete table'],
  ['missing_pagination', 'Missing pagination control'],
  ['missing_filter_control', 'Missing filter control'],
  ['api_field_no_ui', 'API field never rendered'],
  ['inaccessible_control', 'Inaccessible control'],
  ['inconsistent_state', 'Inconsistent UI state'],
]);

function findingHeader(kind: UiDataFinding['kind']): string {
  return FINDING_HEADERS.get(kind) ?? kind;
}

const FINDINGS_PER_KIND_CAP = 20;
const OCCURRENCES_SHOWN_CAP = 3;

/** The kinds that are one finding per JSON path of one response. */
const FIELD_LEVEL_KINDS = new Set<UiDataFinding['kind']>(['missing_in_ui', 'hidden_in_ui', 'api_field_no_ui']);
/** Paths listed per endpoint before "… and N more". */
const PATHS_PER_ENDPOINT_CAP = 40;

/**
 * Field-level findings, one block per endpoint: which paths of that
 * response never reached the page, on which routes, seen how often. One
 * candidate per endpoint, because that is the unit somebody verifies -
 * "does this screen render what this call returns" - not one per field.
 */
function renderFieldFindingsByEndpoint(kind: UiDataFinding['kind'], groups: UiDataFinding[][]): string[] {
  const byEndpoint = new Map<string, UiDataFinding[][]>();
  for (const group of groups) {
    const endpoint = group[0].evidence.endpoint ?? '';
    const list = byEndpoint.get(endpoint) ?? [];
    list.push(group);
    byEndpoint.set(endpoint, list);
  }
  const lines: string[] = [];
  const what =
    kind === 'hidden_in_ui'
      ? 'present in the DOM but not visible'
      : 'returned but never rendered';
  // One instruction for the section, not one per endpoint.
  lines.push(
    "Verify each: that endpoint's response in network/index.json against the ui-state digest for the same actionSeq - is the path really absent from the page, and should it be shown?",
  );
  lines.push('');
  for (const [endpoint, endpointGroups] of byEndpoint) {
    const routes = new Set<string>();
    let raw = 0;
    for (const group of endpointGroups) {
      raw += group.length;
      for (const f of group) if (f.evidence.route) routes.add(templateRoute(f.evidence.route));
    }
    const paths = endpointGroups.map((g) => g[0].evidence.jsonPath ?? '?');
    lines.push(`- **Candidate:** ${paths.length} field${paths.length === 1 ? '' : 's'} of \`${endpoint}\` ${what} (${raw} raw observation${raw === 1 ? '' : 's'})`);
    if (routes.size) lines.push(`  Routes: ${Array.from(routes).join(', ')}`);
    const shown = paths.slice(0, PATHS_PER_ENDPOINT_CAP).map((p) => `\`${p}\``).join(', ');
    lines.push(`  Paths: ${shown}${paths.length > PATHS_PER_ENDPOINT_CAP ? ` … and ${paths.length - PATHS_PER_ENDPOINT_CAP} more` : ''}`);
    lines.push('');
  }
  return lines;
}

/** Same field/value tripping the same rule on every action that happens to
 * re-fetch it (e.g. a loan record loaded on every page of a wizard) is the
 * dominant source of duplicate findings, not distinct issues - group them
 * into one candidate with an occurrence count instead of repeating the
 * same boilerplate once per action. */
function findingGroupKey(f: UiDataFinding): string {
  return `${f.kind}::${f.evidence.jsonPath ?? ''}::${f.summary}`;
}

/**
 * Render findings.md. Every entry is explicitly labelled a candidate for
 * verification - this function never asserts anything is broken.
 *
 * Token economy matters here as much as in flow.md (see the file-level
 * comment above): identical (kind, jsonPath, summary) findings recurring
 * across actions are collapsed into one entry with an occurrence count
 * rather than repeated verbatim, and each kind is capped so one noisy rule
 * can't blow out the whole document - both make output size predictable
 * regardless of session length instead of scaling with action count.
 */
export function renderFindings(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push('# UX / data-discovery candidates');
  lines.push('');
  lines.push(
    'Candidates to verify, never asserted bugs. A candidate repeating across actions is one entry with a count; each rule shows at most 20.',
  );
  lines.push('');

  if (bundle.findings.length === 0) {
    lines.push('No candidates were surfaced by the heuristics for this session.');
    return lines.join('\n');
  }

  const byKind = new Map<UiDataFinding['kind'], UiDataFinding[]>();
  for (const f of bundle.findings) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }

  const totalRaw = bundle.findings.length;
  let totalGroups = 0;
  for (const findings of byKind.values()) {
    const seen = new Set(findings.map(findingGroupKey));
    totalGroups += seen.size;
  }
  lines.push(
    `**${totalGroups} distinct candidate${totalGroups === 1 ? '' : 's'}** ` +
      `(${totalRaw} raw observation${totalRaw === 1 ? '' : 's'} before de-duplication) across ${byKind.size} rule${byKind.size === 1 ? '' : 's'}.`,
  );
  lines.push('');

  for (const [kind, findings] of byKind) {
    const groups = new Map<string, UiDataFinding[]>();
    for (const f of findings) {
      const key = findingGroupKey(f);
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }
    const groupList = Array.from(groups.values());

    lines.push(`## ${findingHeader(kind)} (${groupList.length} distinct, ${findings.length} raw)`);
    lines.push('');

    // Field-level data findings are one per JSON path, and a single
    // response can produce eighty of them - one recording had 84 of its 88
    // candidates under one rule. When the findings carry the endpoint they
    // came from, they are printed per endpoint as a list of paths rather
    // than as eighty blocks saying the same thing about different fields.
    if (FIELD_LEVEL_KINDS.has(kind) && groupList.every((g) => g[0].evidence.endpoint)) {
      lines.push(...renderFieldFindingsByEndpoint(kind, groupList));
      continue;
    }

    for (const group of groupList.slice(0, FINDINGS_PER_KIND_CAP)) {
      const f = group[0];
      lines.push(`- **Candidate:** ${f.summary}`);
      if (f.evidence.route) lines.push(`  Route: ${templateRoute(f.evidence.route)}`);
      if (group.length > 1) {
        lines.push(`  Seen ${group.length} times across actions.`);
      }
      for (const occurrence of group.slice(0, OCCURRENCES_SHOWN_CAP)) {
        const ev = occurrence.evidence;
        const evParts: string[] = [];
        if (ev.actionSeq !== undefined) evParts.push(`action: ${ev.actionSeq}`);
        if (ev.selector) evParts.push(`selector: \`${ev.selector}\``);
        if (ev.jsonPath) evParts.push(`json path: \`${ev.jsonPath}\``);
        if (ev.endpoint) evParts.push(`endpoint: ${ev.endpoint}`);
        if (ev.screenshotRef) evParts.push(`screenshot: ${ev.screenshotRef}`);
        if (evParts.length) lines.push(`  Evidence: ${evParts.join(', ')}`);
      }
      if (group.length > OCCURRENCES_SHOWN_CAP) {
        lines.push(`  … and ${group.length - OCCURRENCES_SHOWN_CAP} more occurrence(s).`);
      }
      lines.push(`  Verify: ${f.howToVerify}`);
      lines.push('');
    }
    if (groupList.length > FINDINGS_PER_KIND_CAP) {
      lines.push(
        `  … and ${groupList.length - FINDINGS_PER_KIND_CAP} more distinct "${findingHeader(kind)}" candidates not shown - see actions.json / ui-state/digests.json for the full set.`,
      );
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * The skill that explains this package: the name an agent asks any Agent
 * Skills runtime for. It lives beside this code in
 * skills/rrweb-evidence-recording, so the change that alters the export is
 * the change that alters its description.
 */
export const SKILL_NAME = 'rrweb-evidence-recording';

/**
 * Bumped when a file, a field or a meaning in the package changes in a way a
 * reader written against the previous shape would get wrong. The skill's
 * references/package-format.md is written against this number.
 */
export const PACKAGE_SCHEMA_VERSION = 2;

/**
 * The package's own README: the entry point, so it carries what a reader
 * needs to decide where to go next - counts, whether the recorder left
 * comments, and what the big files cost - in about fifteen lines. Every
 * file it names is a file packageBundle writes - a README that promises a
 * raw/ directory that is not there sends an agent looking for it, and the
 * next thing it does is invent what it would have found. `sizes` holds the
 * byte sizes of the files written so far (everything but this file and
 * manifest.json).
 */
export function renderReadme(bundle: EvidenceBundle, sizes: Record<string, number> = {}): string {
  const size = (path: string) => (sizes[path] !== undefined ? ` (${formatBytes(sizes[path])})` : '');
  const primary = bundle.network.filter((r) => r.tier === 'primary').length;
  const screenshots = new Set(bundle.screenshots.map((s) => s.path)).size;
  const notes = bundle.notes?.length ?? 0;
  const counts = [
    `Recorded ${new Date(bundle.session.createTimestamp).toISOString()}`,
    `${bundle.actions.length} actions`,
    `${bundle.network.length} requests (${primary} primary)`,
    `${bundle.findings.length} findings`,
    `${screenshots} screenshots`,
    ...(notes ? [`${notes} recorder comment${notes === 1 ? '' : 's'}`] : []),
  ].join(' · ');
  const notesHint = notes
    ? " Its `NOTE ▶` lines are the person's own comments on what they were doing - the intent behind the actions they cover; read them as such."
    : '';
  return [
    `# Evidence package: ${bundle.session.name}`,
    '',
    counts,
    `Written by the rrweb evidence recorder - skill \`${SKILL_NAME}\`, package schema ${PACKAGE_SCHEMA_VERSION}.`,
    "That skill's SKILL.md says how to read this; its references/package-format.md has every field.",
    '',
    'Read in this order and stop as soon as the question is answered:',
    '',
    `1. **flow.md**${size('flow.md')} - a SUMMARY, then one block per action: what was done, the requests it caused, how the UI changed, the screenshot.${notesHint}`,
    `2. **findings.md**${size('findings.md')} - heuristic API-vs-UI candidates to verify, never asserted bugs. Only when the question is about data not shown, hidden controls or counts.`,
    `3. Drill-down for one actionSeq only, never read whole: actions.json[n] · network/index.json${size('network/index.json')} filtered to actionSeq=n · network/curl.sh (a reproducible curl per request) · ui-state/digests.json${size('ui-state/digests.json')} filtered to actionSeq=n · screenshots/action-000n-after.jpg · console.json · storage.json · app-map.json.`,
    '',
    '`actionSeq` is the join key: the same n names the same moment in every file.',
    '`[REDACTED:<reason>]` marks a value removed at capture, counted in redaction-report.json; there is no original to ask for.',
    'manifest.json lists every file with its byte size. The raw rrweb event stream is not included.',
    '',
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * manifest.json: what is in the package and what each file costs, written
 * last so every size is final. It cannot list itself.
 */
export function renderManifest(bundle: EvidenceBundle, sizes: Record<string, number>): string {
  const files = Object.keys(sizes)
    .sort()
    .map((path) => ({ path, bytes: sizes[path] }));
  const screenshots = new Set(bundle.screenshots.map((s) => s.path));
  return JSON.stringify(
    {
      schema_version: PACKAGE_SCHEMA_VERSION,
      recorder_version: bundle.session.recorderVersion,
      skill: SKILL_NAME,
      generated_at: new Date(bundle.session.modifyTimestamp).toISOString(),
      session: {
        id: bundle.session.id,
        name: bundle.session.name,
        recorded_at: new Date(bundle.session.createTimestamp).toISOString(),
        capture_mode: bundle.session.captureMode,
      },
      counts: {
        actions: bundle.actions.length,
        requests: bundle.network.length,
        findings: bundle.findings.length,
        notes: bundle.notes?.length ?? 0,
        screenshots: screenshots.size,
      },
      files,
    },
    null,
    2,
  );
}
