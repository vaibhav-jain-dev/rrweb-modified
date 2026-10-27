# Live agent plan

> **Status: built.** This file is the original design. Where the build differs,
> the table below wins; run instructions are in `packages/agent-backend/README.md`.
>
> | Plan said | Built |
> | --- | --- |
> | `packages/agent-protocol` shared package | No separate package. The wire/ledger types (`src/agent/protocol.ts`), the log renderer (`src/agent/log.ts`) and route templating live in the extension and the backend imports them by relative path; Node 24 runs the TypeScript directly. One definition, no cross-package build. |
> | `postgres` source | `mongo` instead (the LMS is MongoDB/DocumentDB). `http` and the built-in `session` source are in. `redis`/`shell`/`mcp` are not. |
> | `schema.md` | `REFERENCE.md`: what each collection holds **and** the map of every write → collection → what is checked. |
> | `follow:` baseline files | `yarn agent:learn <zip> --name x` writes an ordinary playbook (`follow-x.md`) with `include: [lms-writes]` and the recording's writes as `steps`. |
> | Rules per playbook were one-shot checks | Rules fire **per matching request** (every PATCH/POST/PUT/DELETE gets its own checks); `required: true` gives the one-shot "must happen" case. |
> | Statuses `pending/observed/verified/failed/never_seen` | Adds `unchecked`: the source could not be asked. It is never reported as a failure. |
> | – | `yarn agent:probe <zip>` replays a recording's writes through the rules against the database (read-only) to confirm rules against live documents; `--dry` shows the lookups only. |
> | – | A full `AGENT_MONGO_URI` means `~/projects/.env.mongo` is never opened. |
> | MCP adapter (phase 6) | Not built. The tool registry (`src/tools/registry.ts`) has the `{name, args, handler}` shape an MCP adapter needs; nothing else is wired. |
> | Firefox side panel | Chrome only; the Firefox build hides the live-agent UI. |
> | Player timeline markers | Not built. Checks carry `actionSeq`, `tObserved`, `tResolved`, which is what markers need. |
>
> Verified: 101 backend tests + 187 extension tests; 11 more against a real
> MongoDB (opt-in, `mongo.e2e`); `yarn build:chrome` bundles the side panel; the
> CLI was run on a real recording. **Not** verified: the extension loaded in a
> browser against a live backend (popup → side panel → zip), and any check
> against `devlms` itself.

A local model watches a recording as it happens, resolves a checklist the
recorder chose up front, shows its progress in a side panel, and leaves a
verifiable ledger in the exported package. This document is the design and
the build order. Decisions are made; open questions are listed at the end.

## 1. What it is for

The recorder picks one or more **playbooks** before pressing Start. A
playbook is a checklist of things that should happen during the session
("the session API returns an id", "a DB row exists for that id within 5s",
"its user_id matches the request header") plus a short brief for the model.
While recording, each selected playbook runs as a **lane**: it watches the
same events the recorder already captures, moves checks through
`pending → observed → verified | failed | never_seen`, and shows that in a
side panel beside the page. When every check in a lane's gate is verified,
the panel says **go ahead**. At Stop, the lane's ledger and a short
narrative are written into the recording zip next to `flow.md`.

The useful output is the **ledger**, not a transcript. Both the live panel
and the export render the same ledger; the panel is the ledger in motion.

## 2. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | The agent loop runs in a **local backend process**, not the extension. | MV3 service workers are evicted after ~30s idle; a loop that waits on a 3B model and a DB cannot live there. The backend is also what MCP exposes later. |
| D2 | Backend is a new workspace package `packages/agent-backend` (Node 24, TS, ESM, Hono + `ws`). | Same toolchain as the repo; Hono is tiny and MCP's Streamable HTTP transport fits on it later. |
| D3 | A third small package `packages/agent-protocol` holds the shared types, zod schemas and the route-templating util. | Backend must never depend on the extension; both need the same message and ledger shapes. |
| D4 | **Code changes check status; the model never does.** | A 3B model's prose cannot be trusted to assert "DB matches". Tool results, assertions and timers transition state. The model picks field paths and writes one-line explanations. |
| D5 | Tools are **named lookups with bound parameters**, declared in config, run by pluggable **source providers** (`session`, `postgres`, `http`, later `redis`, `shell`, `mcp`). No `run_sql`. | Reliability with a small model, and evidence hygiene: a `returns:` projection is mandatory, so only the columns a check needs ever enter the ledger or the zip. |
| D6 | Model: Ollama `/api/chat` with a JSON-schema `format` constraint; default `qwen2.5-coder:3b` (already pulled), env-overridable. | Structured output removes the parse-and-pray step; the brain is a per-playbook setting so a stronger model (or an MCP client) can run the same playbook later. |
| D7 | Live UI is a Chrome **side panel**, opened from the popup's Start click. Popup only gains the playbook dropdown. | Popups die on blur; the panel stays beside the page. `chrome.sidePanel.open` needs a user gesture, so the popup click handler opens it. |
| D8 | Transport: service worker → backend over **WebSocket** (ingest + control, pings every 20s keep the worker alive); side panel ← backend over **SSE** (survives worker eviction, auto-reconnects). | Each context talks to the backend directly; no relay through the worker for the panel. |
| D9 | Export stays **offline from the backend**: at Stop the backend returns the final ledger over the socket and the worker persists it as an evidence chunk kind `agent`; `export/build.ts` reads IndexedDB as it does for everything else. | A zip must still build if the backend was closed before export. |
| D10 | Backend holds only **redacted** data (the CDP module redacts before the sink) and keeps bodies in a bounded in-memory ring per session; nothing raw is written to disk. Binds `127.0.0.1`; optional `AGENT_TOKEN`. | Local use; the leakage surface is the zip, which D5 controls. |
| D11 | Structured config is **YAML**, free-text context is **Markdown**. `sources.yaml` (sources + tools), `schema.md` (what tables/fields mean, fed to the model), `playbooks/*.md` (YAML front-matter for checks, Markdown body for the brief). | Parsing an invented Markdown DSL for tool definitions is a bug farm; YAML front-matter + body is a known shape and the dropdown is just the files in the folder. |
| D12 | Chrome only for the panel in this pass. Firefox keeps recording as today; the agent UI is hidden when `chrome.sidePanel` is absent. | `sidebar_action` can come later; nothing else is browser-specific. |

## 3. Architecture

```
┌──────────────── Chrome ─────────────────┐      ┌────────── agent-backend (127.0.0.1:47821) ──────────┐
│ popup ── GET /playbooks, /health ───────┼─────▶│ http: /health /playbooks /sessions/:id/{stream,requests}│
│   └ Start → sidePanel.open + StartRecord│      │                                                      │
│ service worker                          │  WS  │ ingest ─▶ SessionStore (events ring, ledger)         │
│   orchestrator sinks ─▶ agent/client.ts ┼─────▶│            └▶ Lane[playbook] ─▶ Runner ─▶ Ollama      │
│   (session.start/event/stop, pings)     │◀─────┼─ ledger.update / session.result     └▶ ToolRegistry │
│   persists `agent` chunk at stop        │      │                                        ├ session    │
│ side panel ◀── SSE /sessions/:id/stream ┼──────┤                                        ├ postgres   │
│   checklist · feed · noticed · go-ahead │      │                                        └ http       │
│ export/build.ts ─▶ agent/ledger.json,   │      │ config: sources.yaml schema.md playbooks/*.md .env   │
│   agent/log.txt, AGENT ▶ lines, SUMMARY │      │ later: mcp.ts (same registry, session resources)     │
└─────────────────────────────────────────┘      └──────────────────────────────────────────────────────┘
```

### Packages

- `packages/agent-protocol` (`@rrweb/agent-protocol`) — types + zod: `WireMessage`, `Ledger`, `Check`, `Playbook`, `SourceConfig`, `ToolDef`; `route-template.ts` moves here and the extension re-exports it.
- `packages/agent-backend` (`@rrweb/agent-backend`) — `src/server.ts`, `src/ingest.ts` (WS), `src/stream.ts` (SSE), `src/store.ts`, `src/lane.ts`, `src/runner.ts`, `src/model/{ollama,fake}.ts`, `src/tools/{registry,assert,extract}.ts`, `src/sources/{types,session,postgres,http}.ts`, `src/config/{load,playbook,sources}.ts`, `src/narrative.ts`, later `src/mcp.ts`. Scripts: `dev`, `start`, `test`. Root scripts: `agent:dev`, `agent:start`.
- `packages/web-extension` — new `src/agent/client.ts` (WS client), `src/sidepanel/{index.html,index.tsx,App.tsx}`, popup dropdown, `LocalDataKey.agentConfig`, `EventName.AgentLedgerUpdated` (optional), export changes, manifest `side_panel` + `sidePanel` permission (chrome layer).

## 4. Config formats

`AGENT_CONFIG_DIR` (default `packages/agent-backend/config/`) holds:

**`.env`**
```
DATABASE_URL=postgres://user:pass@localhost:5432/app
BILLING_BASE_URL=https://billing.staging.internal
BILLING_TOKEN=...
AGENT_MODEL=qwen2.5-coder:3b
OLLAMA_HOST=http://127.0.0.1:11434
AGENT_PORT=47821
# AGENT_TOKEN=        # optional; if set the extension must send it (Options page)
```

**`sources.yaml`**
```yaml
sources:
  app_db:      { type: postgres, url: $DATABASE_URL, timeoutMs: 3000, maxRows: 5 }
  billing_api: { type: http, baseUrl: $BILLING_BASE_URL, headers: { Authorization: "Bearer $BILLING_TOKEN" } }

tools:
  lookup_session:
    source: app_db
    description: Session row by id.
    args: { id: string }
    sql: SELECT id, user_id, created_at, status FROM sessions WHERE id = $id
    returns: [id, user_id, created_at, status]

  get_invoice:
    source: billing_api
    description: Latest invoice for a session.
    args: { session_id: string }
    request: { method: GET, path: /v1/invoices, query: { session: $session_id } }
    returns: { id: $.data[0].id, amount: $.data[0].amount, status: $.data[0].status }
```
Rules: every `$arg` is bound (pg parameter / URL-encoded), never interpolated.
`returns` is mandatory and is the only shape that leaves the provider.
Built-in `session` source needs no declaration: `last_response(endpoint, path)`,
`count_calls(endpoint)`, `header(endpoint, name)`, `status(endpoint)`.

**`schema.md`** — free text the model gets as context: what each table and
field means, which header carries the user, anything a new teammate would
need. Not parsed.

**`playbooks/session-create.md`**
```markdown
---
id: session-create
title: Session create → DB
gate: [api_returns_id, row_exists, user_matches]      # all verified ⇒ "go ahead"
watch:
  - endpoint: "POST /session"
  - endpoint: "* /session/:id"
    status: ">=400"
    note: "error on session route"                    # anomaly feed, not a check
checks:
  api_returns_id:
    expect: { endpoint: "POST /session", status: "2xx" }
    extract: { id: "?" }                              # "?" ⇒ model picks the JSON path once
  row_exists:
    after: api_returns_id
    within: 5s
    call: { tool: lookup_session, args: { id: $api_returns_id.id } }
    assert:
      - { path: $.result.id, op: eq, value: $api_returns_id.id }
  user_matches:
    after: row_exists
    assert:
      - { path: $row_exists.result.user_id, op: eq, value: $api_returns_id.headers.x-user }
---
You are checking that creating a session persists correctly. The app's API
is described in schema.md. When asked for a field path, answer with the JSON
path only.
```
A check with an `extract` of `"?"` is the only place the model is required.
Everything else is deterministic; a playbook with no `?` runs with no model
at all and is the first thing that must work (phase 3).

### Guided playbooks (`steps`)

A playbook may order its checks into **steps**, each with an instruction for
the person. The lane then walks the recorder through the flow: the panel
shows the current step's instruction, the checks under it, and advances when
they verify.

```yaml
steps:
  - say: "Create a session from the dashboard."
    checks: [api_returns_id, row_exists, user_matches]
  - say: "Place an order for that session."
    checks: [order_received]
  - say: "Done — stop the recording."
checks:
  order_received:
    call: { tool: get_order, args: { session_id: $api_returns_id.id } }
    poll: { everyMs: 2000, forMs: 60000 }      # re-run until assert passes or time is up
    assert:
      - { path: $.result.status, op: in, value: [received, processing] }
```
`poll` is deterministic: the runner re-runs the call on the interval and
the check reads `observed` with `activity: "checking get_order (3/30)…"`
until an assertion passes (`verified`) or `forMs` elapses (`failed`). The
panel shows that activity line live; this is the "checking now from the
API… found, you can proceed" the recorder sees. A step with no checks is
an instruction only. The lane never drives the browser; it signals and the
person acts.

### Asks (instructions typed during the session)

The panel has one input. What is typed becomes an **ask**: a check created
at runtime, with the model deciding only *which tool and which arguments*
and code doing everything else.

1. The ask text, the tool list (name, description, args) and the lane's
   current values (`$api_returns_id.id` etc.) go to the model under schema
   `{ claim: string, tool: string, args: Record<string,string>, poll?: {everyMs, forMs}, assert?: Assert[] }`.
2. The runner validates the tool exists and args match its declared names;
   otherwise the ask is `failed` with note "no matching tool" and the panel
   suggests the closest tool names — the person can retype.
3. The resulting check runs exactly like a declared one (`call`, `poll`,
   `assert`) and lands in the ledger as `origin: "ask"` with the original
   text, so the export shows what was asked, what was run and what came
   back. Asks are also persisted as a note (`NOTE ▶`) at that time.

"I made an order, check it is received" → model answers
`{ tool: get_order, args: { session_id: "$api_returns_id.id" }, poll: {2000, 60000}, assert: [status in [received, processing]] }`
→ the panel shows "checking get_order…" → "received — proceed".

## 5. Ledger (the one structure)

```ts
type Ledger = {
  sessionId: string; startedAt: number; model?: string;
  lanes: Lane[];
};
type Lane = {
  playbookId: string; playbookHash: string; title: string;
  currentStep?: number; steps?: { say: string; checks: string[]; reachedAt?: number; passedAt?: number }[];
  verdict: { verified: number; failed: number; never_seen: number; pending: number; gateReady?: number /* t_rel_ms */ };
  checks: Check[];
  observations: Observation[];      // model-noticed, always unverified
  anomalies: Anomaly[];             // `watch` hits, deterministic
};
type Check = {
  id: string; claim: string;
  origin: 'playbook' | 'ask'; askText?: string; step?: number;
  status: 'pending' | 'observed' | 'verified' | 'failed' | 'never_seen';
  activity?: string;                             // live only: "checking get_order (3/30)…" — not exported
  tObserved?: number; tResolved?: number;        // ms relative to session start
  actionSeq?: number;                            // filled at export from tObserved
  evidence: Evidence[];                          // request ids, tool calls + projected results, assertion outcomes
  note?: string;                                 // one line, model- or rule-written
};
type Evidence =
  | { kind: 'request'; requestId: string; endpoint: string; status?: number; field?: string; value?: unknown }
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; result: Record<string, unknown>; ref: string /* "sql: … $1=…" or "GET …→200" */; ms: number }
  | { kind: 'assert'; path: string; op: string; expected: unknown; actual: unknown; ok: boolean }
  | { kind: 'timeout'; withinMs: number };
```
Only projected values appear in `evidence`. The ledger is what the panel
renders, what the worker persists, and what the export writes.

## 6. Wire protocol (`@rrweb/agent-protocol`)

Worker → backend (WS, JSON lines):
- `session.start { sessionId, startedAt, pageOrigin, playbooks: string[], token? }`
- `event { kind: 'network' | 'action' | 'console' | 'storage' | 'note', t, payload }` — payloads are the existing redacted record types, network bodies capped to 64 KB on the wire.
- `session.stop { sessionId, endedAt }`
- `ping`

Panel → backend (HTTP):
- `POST /sessions/:id/ask { laneId, text }` → `{ checkId }`; the worker also records it as a note so it shows in `flow.md`.

Backend → worker:
- `session.ack { sessionId, lanes: string[] }`
- `ledger.update { sessionId, ledger }` (debounced ≤ 4/s)
- `session.result { sessionId, ledger, log }` — sent once after stop; the worker writes chunk `agent` and resolves stop.
- `error { message }`

HTTP:
- `GET /health → { ok, model, playbooks: n }`
- `GET /playbooks → [{ id, title, checks: n, needsModel }]`
- `GET /sessions/:id/stream` (SSE: `ledger`, `feed`, `gate` events)
- `GET /sessions/:id/requests/:requestId` → endpoint, status, headers (redacted), body preview ≤ 4 KB, for the panel's drill-down.

Reconnect: the worker buffers events (cap 500) while disconnected and
replays on reconnect with the same `sessionId`; the backend treats a
`session.start` for a known id as resume.

## 7. Lane runner

Per lane, per batch of events (debounced 1.5s, or immediately on a `watch`/`expect` hit):

1. **Deterministic pass** — match endpoints (templated with the shared util) against `watch` and `expect`; `pending → observed` with request evidence; arm `within` timers; record anomalies.
2. **Resolve bindings** — for each observed check, bind `$ref` values from prior checks; a `"?"` extract asks the model exactly one question (JSON schema `{ path: string }`) given the response's top-level shape (keys + types, not the body) — then code reads the path.
3. **Run `call`** through the registry → tool evidence.
4. **Evaluate `assert`** → `verified`/`failed` with assertion evidence.
5. **Timers** → `never_seen` (never observed) or `failed` (observed, assertion never satisfied in time).
6. **Model turn (optional, once per batch, if the playbook has a body)** — input: brief, `schema.md`, ledger summary, batch summaries (`POST /session → 201, 1.2 KB, keys: data{session{id,user_id}}`), tool list; output schema `{ note?: string, observations?: {text, requestId?}[] }`. Writes only `note` and `observations`. Never status.
7. Emit `ledger.update`; if the gate just completed, emit `gate`.

Ollama calls go through one queue (`OLLAMA_NUM_PARALLEL` is 1 on most
machines); lanes are independent otherwise. A `fake` model adapter (fixed
answers) runs in tests and when `AGENT_MODEL=none`.

### Resource budget

Measured on this machine: RTX 3070 8 GB, Ollama already places models
100% on GPU, 20 cores, 52 GB RAM. Rules so the page and the CPU stay
unaffected:

- The model runs on the GPU or not at all: `OLLAMA_HOST` is checked at
  start with `GET /api/ps`; if the loaded model reports a CPU split the
  backend logs a warning and the `/health` payload says `gpu: false` so the
  popup can show it. `qwen2.5-coder:3b` at `num_ctx: 4096` is ~2.5 GB VRAM.
- `keep_alive: 30m` so the model is not reloaded between batches;
  `num_ctx` capped at 4096; prompts are summaries, never bodies, so a turn
  is a few hundred tokens in and under 100 out.
- One model request in flight, batches no more often than every 1.5s,
  `?`-extract and asks jump the queue, periodic notes/observations are
  dropped when the queue is deeper than 3.
- Polling tools have a floor of `everyMs: 1000` and a lane-wide cap of 4
  concurrent polls; `postgres` pool size 2; every provider has a timeout.
- The extension does no extra work on the page: the worker only forwards
  records it already produced, on the WebSocket, with bodies cut at 64 KB.
  The side panel is a separate document; rendering it costs the page nothing.
- The backend does no periodic work when no events arrive; timers are the
  only wakeups.

## 8. Extension changes

- `types.ts`: `LocalDataKey.agentConfig = { backendUrl, playbooks: string[], token? }`; `EventName.AgentGate` for an optional badge.
- `popup/App.tsx`: on mount `GET /health`; if ok, show a multi-select of playbooks above the record button; on Start, save the selection, `chrome.sidePanel.open({ windowId })` when any selected, then emit `StartButtonClicked` as today.
- `background/agent/client.ts`: connects on `startOrchestration` when playbooks are selected; the orchestrator's existing sinks (`network`, `console`, `storage`, `action`, `note`) also call `agentClient.send(...)`; `stopOrchestration` awaits `session.result` (≤ 8s, else writes a ledger with `incomplete: true`) and `appendEvidenceChunk(sessionId, 'agent', 0, [result])`.
- `sidepanel/App.tsx` (React + Chakra, like the rest): header with session timer and lane tabs; **current step** card (instruction, its checks, "proceed" state) for guided playbooks; **checklist** (status chips, claim, live `activity` line, elapsed), **go-ahead banner** when the gate or step is ready, **feed** of resolutions and anomalies only, **noticed** tray for observations, **ask** input at the bottom, row click → request detail drawer (`/sessions/:id/requests/:requestId`). Reads `agentConfig` + `recorderStatus` from storage to find the session and the backend.
- `manifest.json` v3/chrome: `"side_panel": { "default_path": "sidepanel/index.html" }`, permission `sidePanel`. `vite.config.ts` picks up the new HTML entry through the manifest.

## 9. Export changes

- `evidence/types.ts`: `EvidenceBundle.agent?: Ledger & { log: string }`.
- `export/build.ts`: read chunk `agent`; map each check's `tObserved` to `actionSeq` with the existing action windows.
- `packageBundle`: `agent/ledger.json` (pretty), `agent/log.txt` (narrative rendered from the ledger by `evidence/agent-render.ts`, not accumulated chat).
- `render.ts`: `SUMMARY` gains `agent: 2 lanes · 5 verified · 1 failed · 1 never seen`; `AGENT ▶` lines placed under the action where a check resolved, same style as `NOTE ▶`; `findings.md` gains a final section **Agent observations (unverified)**; README and manifest size the new files.
- Skill: `SKILL.md` table gets a row for `agent/ledger.json` between `findings.md` and `network/index.json`; `references/package-format.md` documents the ledger; `reading-a-recording.md` says a `failed`/`never_seen` check is the first place to look.
- Player page (later in phase 5): markers on the timeline at `tResolved`, colored by status.

## 10. Build order

Each phase ends with something runnable; nothing in a later phase is needed to use the earlier one.

**Phase 0 — protocol + config formats** (`packages/agent-protocol`)
Types, zod schemas, playbook/sources parsers, route-template move. Tests: parse the example playbook and `sources.yaml`; reject interpolated SQL; `returns` required.
Done when: `yarn workspace @rrweb/agent-protocol test` is green and the extension builds with the re-exported `templateRoute`.

**Phase 1 — backend skeleton, no model, no sources** (`packages/agent-backend`)
Hono server, WS ingest, session store, SSE stream, lane with steps 1/5/7 only (expect, watch, timers). Fake-event script `scripts/replay-events.mjs` that feeds a recorded `network/index.json` through the socket at original timing.
Done when: a replayed recording moves `api_returns_id` to `observed` and `row_exists` to `never_seen`, visible on `curl -N /sessions/:id/stream`.

**Phase 2 — extension wiring**
`agent/client.ts`, popup dropdown + `/health`, side panel rendering the live ledger, manifest/permission, stop → `agent` chunk persisted.
Done when: Start with a playbook selected opens the panel and the checklist updates during a real recording; stopping writes the chunk even if the backend is killed mid-session (ledger marked incomplete).

**Phase 3 — sources, tools, assertions** (still no model)
`session`, `postgres` (`pg`), `http` providers; registry; `assert`; `call` bindings. The example playbook with a static `extract` path (`data.session.id` instead of `"?"`) verifies end-to-end against a local Postgres.
Done when: all three checks go green on a real session and `evidence[]` holds the bound SQL ref and projected row only.

**Phase 3b — steps and polling** (still no model)
`steps` in the playbook, `currentStep` in the lane, `poll` on calls, the step card and activity line in the panel.
Done when: a two-step playbook walks a real session and the order check shows "checking… (n/30)" then "received — proceed".

**Phase 4 — model**
Ollama adapter with schema-constrained output and GPU check, `"?"` extract, **asks** (`POST /sessions/:id/ask`, panel input, tool/arg validation), per-batch note/observations, Ollama queue with priorities, `fake` adapter in tests, `AGENT_MODEL=none` degrade path.
Done when: the playbook with `"?"` resolves on a real session; a typed "check the order is received" becomes a polling check that goes green; a wrong path or tool from the model produces `failed` with the evidence, never `verified`.

**Phase 5 — export + docs**
`agent/ledger.json`, `agent/log.txt`, `flow.md` and `findings.md` changes, README/manifest sizes, skill references, Player markers.
Done when: a zip from a session with the agent reads correctly through the skill's step table, and `yarn ext:test` covers the new render paths.

**Phase 6 — MCP + hardening (optional, when wanted)**
`src/mcp.ts` on `@modelcontextprotocol/sdk`: tools from the registry, resources `session://{id}/ledger` and `session://{id}/events`; `AGENT_TOKEN`; row/size caps enforced per source; Firefox `sidebar_action` if desired.

Rough effort: phases 0–2 are the bulk of the wiring (~2 days), 3–4 a day each, 5 half a day, 6 half a day.

## 11. Risks and how they are handled

- **Service worker eviction mid-session.** WS pings every 20s keep it alive on Chrome ≥116; `sessionId` is already in `recorderStatus`, so a restarted worker reconnects and resumes; events are buffered while disconnected.
- **3B model latency on CPU** (2–5s per turn). Batching per 1.5s and one question per `"?"` keep model turns to a handful per minute; the deterministic pass never waits on the model.
- **Model picks the wrong field.** The assertion fails and the ledger says so with the actual value; the model cannot mark anything verified (D4).
- **Backend down.** Popup hides the dropdown; recording is unaffected; export has no `agent/` files and `README` says so.
- **WSL ↔ Windows Chrome.** Backend binds `127.0.0.1` inside WSL; WSL2 forwards `localhost` to Windows by default, so Chrome on Windows reaches `127.0.0.1:47821`. Ollama likewise. If forwarding is off, set `AGENT_HOST=0.0.0.0` and the token.
- **Zip bloat / leakage.** Only `returns` projections and ≤ 4 KB request previews ever enter the ledger; bodies stay in the backend's memory ring and die with the process.

## 12. Open questions (answer when they come up, not before)

- Should a lane be allowed to *pause* the recording until the gate is ready? Current answer: no — the panel signals, the person decides.
- Per-playbook model choice (`model: claude-…` via MCP client) — phase 6 shape, not needed now.
- Sharing `schema.md` across projects — probably `AGENT_CONFIG_DIR` per target app, nothing more.
