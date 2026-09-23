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
  UiDataFinding,
} from './types';

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

function actionLabel(action: ActionRecord): string {
  const target = action.target;
  const name = target?.accessibleName || target?.text || target?.selector || '(unlabeled element)';
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
      return `Scrolled "${target ? name : action.page.route}"`;
    case 'navigate':
      return `Navigated to ${action.page.route}`;
    case 'reload':
      return `Reloaded ${action.page.route}`;
    case 'back':
      return `Went back to ${action.page.route}`;
    case 'forward':
      return `Went forward to ${action.page.route}`;
    case 'redirect':
      return `Redirected to ${action.page.route}`;
    case 'tab-open':
      return `Opened new tab: ${action.page.route}`;
    case 'tab-close':
      return `Closed tab`;
    default:
      // Exhaustively handled above; this only fires for an ActionType
      // this function hasn't been updated for yet.
      return `${String(action.type)} on "${name}"`;
  }
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
  lines.push('');

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
    lines.push(`ACTION ${action.seq}  ·  ${formatTime(action.t)}  ·  ${action.page.route}`);
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

    const consoleEntries = consoleByAction.get(action.seq);
    if (consoleEntries?.length) {
      lines.push('CONSOLE');
      for (const c of consoleEntries.slice(0, 4)) {
        lines.push(`  [${c.level}] ${c.text.slice(0, 200)}`);
      }
      lines.push('');
    }

    const screenshot = bundle.screenshots.find(
      (s) => s.actionSeq === action.seq && s.phase === 'after',
    );
    if (screenshot) {
      lines.push(`SCREENSHOT  ${screenshot.path}`);
      lines.push('');
    }

    // Where the detail for this moment is, by the one key every file shares.
    // Nothing here names a file the package does not contain: the raw rrweb
    // event stream is not exported, so an rrwebId is not a pointer to read.
    lines.push(
      `DRILL-DOWN  actions.json#${action.seq} · network/index.json actionSeq=${action.seq} · ui-state/digests.json actionSeq=${action.seq}`,
    );
    lines.push('');

    lines.push('---');
    lines.push('');
  });

  const polling = summarizeUnattributed(bundle.network);
  if (polling.length) {
    lines.push('BACKGROUND ACTIVITY (not tied to any specific action)');
    for (const line of polling) lines.push(`  - ${line}`);
  }

  return lines.join('\n');
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
    'Everything below is a **candidate** for an AI agent or reviewer to verify, not an assertion of a bug. ' +
      'Each entry states the rule that fired, the evidence, and how to check it. Findings repeating across ' +
      'multiple actions (the same field re-observed on every page load, say) are collapsed into one entry ' +
      'with an occurrence count, not listed once per action.',
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

    for (const group of groupList.slice(0, FINDINGS_PER_KIND_CAP)) {
      const f = group[0];
      lines.push(`- **Candidate:** ${f.summary}`);
      if (group.length > 1) {
        lines.push(`  Seen ${group.length} times across actions.`);
      }
      for (const occurrence of group.slice(0, OCCURRENCES_SHOWN_CAP)) {
        const ev = occurrence.evidence;
        const evParts: string[] = [];
        if (ev.route) evParts.push(`route: ${ev.route}`);
        if (ev.actionSeq !== undefined) evParts.push(`action: ${ev.actionSeq}`);
        if (ev.selector) evParts.push(`selector: \`${ev.selector}\``);
        if (ev.jsonPath) evParts.push(`json path: \`${ev.jsonPath}\``);
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
export const PACKAGE_SCHEMA_VERSION = 1;

/**
 * The package's own README. Every file it names is a file packageBundle
 * writes - a README that promises a raw/ directory that is not there sends
 * an agent looking for it, and the next thing it does is invent what it
 * would have found.
 */
export function renderReadme(bundle: EvidenceBundle): string {
  return [
    `# Evidence package: ${bundle.session.name}`,
    '',
    'This package captures a browser session recorded against an already-running',
    'web application, with no changes to that application. It was written by the',
    `rrweb evidence recorder - skill \`${SKILL_NAME}\`, package schema ${PACKAGE_SCHEMA_VERSION}.`,
    "That skill's SKILL.md says how to read this cheapest-first and its",
    'references/package-format.md describes every file and field. Start here:',
    '',
    '1. **manifest.json** - the schema and recorder version, and every other file',
    '   in this package with its size, so you know what a read costs before',
    '   making it.',
    '2. **flow.md** - the compact narrative: one block per action with what was',
    '   done, the primary requests, how the UI changed, the screenshot, and where',
    '   to drill. Read this first; it is small on purpose.',
    '3. **findings.md** - heuristic UX/data-discovery candidates (missing fields,',
    '   hidden controls, count mismatches, etc). Every entry is a candidate to',
    '   verify, never an asserted bug. Repeats of the same candidate across',
    '   actions are collapsed into one entry with an occurrence count, and each',
    '   rule caps at 20 distinct candidates, so this file stays a bounded size',
    '   regardless of how long the session was.',
    '4. **summary.json / actions.json** - the same flow as structured data.',
    '5. **network/index.json** - every request with headers and bodies, and',
    '   **network/curl.sh** with a reproducible curl per non-noise request.',
    '   Telemetry (Sentry, analytics), CORS preflights and other non-backend',
    "   traffic are pre-tiered `noise` by Settings' network-exclusion rules.",
    '   This is the largest file: filter it by `actionSeq`, never read it whole.',
    '6. **ui-state/digests.json** - the structured UI digest captured after each',
    '   action (tables, controls, visible/hidden text) - the basis for',
    '   findings.md. An action whose page state exactly matches an earlier one',
    '   is stored as `{ sameAs: <actionSeq> }` rather than repeated in full.',
    '7. **screenshots/** - the viewport after each action settled; an unchanged',
    '   state points at the earlier image instead of repeating it.',
    '8. **app-map.json / console.json / storage.json** - supporting evidence.',
    '9. **redaction-report.json** - what was removed before this package was',
    '   written, counted by reason. Passwords, tokens, auth headers and cookie',
    '   values never reach disk; a `[REDACTED:<reason>]` marker stands where',
    '   each one was, and there is no original to ask for.',
    '',
    '`actionSeq` is the join key across every file: the same number names the',
    'same moment in flow.md, actions.json, network/index.json, ui-state/ and',
    'screenshots/.',
    '',
    'For the lowest-token read: **flow.md + findings.md are enough to understand',
    'what happened and what to double-check.** Open network/, ui-state/ or',
    'screenshots/ only for the specific actionSeq you need to verify - they are',
    'drill-down detail, not required reading, and the largest files here.',
    '',
    'The raw rrweb event stream is not included in this package.',
    '',
  ].join('\n');
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
        screenshots: screenshots.size,
      },
      files,
    },
    null,
    2,
  );
}

export function renderSummaryJson(bundle: EvidenceBundle): string {
  const summary = bundle.actions.map((action) => {
    const requests = bundle.network.filter((r) => r.actionSeq === action.seq);
    return {
      seq: action.seq,
      t: action.t,
      type: action.type,
      route: action.page.route,
      target: action.target?.accessibleName ?? action.target?.text ?? action.target?.selector,
      network: requests.map((r) => ({
        method: r.method,
        url: shortenUrl(r.url),
        status: r.status,
      })),
    };
  });
  return JSON.stringify(summary, null, 2);
}
