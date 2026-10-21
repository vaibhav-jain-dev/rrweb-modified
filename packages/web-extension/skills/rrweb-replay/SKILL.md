---
name: rrweb-replay
description: Repeats a recorded browser session (a recording-*.zip from rrweb-evidence-recording) in a visible browser with changes — a different value, a skipped detour, an extra click — through the rrweb-replay MCP. Use it when asked to "do the same thing again but with …", to re-run a recorded flow, or to check a flow still works against a slow API. Code replays and compares; you send one patch and read one summary.
license: MIT
metadata:
  author: rrweb-modified
  version: "1"
  consumes: "recording-*.zip"
  entry: README.md
  mcp-command: node packages/replay-mcp/src/main.ts
  links: "tech:rrweb, tech:playwright, tech:mcp, concept:session-replay, concept:evidence-recording"
---

# rrweb replay

The `rrweb-replay` MCP (`packages/replay-mcp`) plays a recording back in a
**visible Chromium window** and tells you only where the replay differed from
the recording. You do not drive the browser step by step; you plan once.

## Workflow

1. `load_recording(zip)` — one line per step: number, what it does, route, and
   the write it triggers. Steps marked `·` are skipped by default (body clicks,
   scrolls). Read this once; do not open `flow.md` unless a step is unclear.
2. Decide what the user's instruction changes and send **one patch** to `run`:

   ```json
   { "set": { "18.value": "check 2" }, "skip": [7, 8, 9, 10] }
   ```

   | key | meaning |
   | --- | --- |
   | `set` | `"<step>.<field>": "<value>"`; fields: `value`, `locator`, `name`, `url` |
   | `skip` | step numbers not to run (a detour, a mistake the recorder kept) |
   | `range` | `[from, to]` run only these steps |
   | `replace` | `{"12": {"type":"click","locator":"role=button[name=\"Reject\"]"}}` |
   | `insert` | `[{"after": 12, "step": {"type":"click","locator":"…"}}]` |

   Look at the recording's own errors before planning: a step whose recorded
   call is `404`/`4xx` is usually a mistake the user made and then abandoned
   (`skip` it and what only served it).
3. Read the result:
   - `ok · 17 steps ran · 5 skipped · 2 slow` — done. A patch that ran clean
     is saved; repeat it with `run {reuse: "<name>"}` and no model call.
   - `STOPPED at step N (…)` followed by that one step: `RECORDED` vs `ACTUAL`
     network calls, `UI` changes, `WHY`. Fix with a new patch and run again;
     the browser stays open and the signed-in session stays.
4. Only if that is not enough: `inspect {step}` (the recorded requests for a
   step), `inspect {step, request}` (a body), `inspect {live: true}` (the page
   as text: route, messages, usable controls). `screenshot` is the last
   resort — text is cheaper and answers most questions.
5. **The user can work in the same window.** When they say "I changed
   something", call `changes`: it lists what they clicked and typed, the writes
   the page made and how the screen differs, **since your last call to it** (so
   it is short, and a second call says `nothing changed`). Your own `run` steps
   are not listed. Then continue with a new patch or `run`.

## Keep the session alive

The browser stays open between calls but is **closed after 15 minutes with no
call from you** (the saved sign-in stays, so the next `run` reopens it signed
in). Any tool call renews the 15 minutes. If you are waiting on the user for
longer than that, call `keepalive` at least every 12 minutes. Replies from
`run`, `changes` and `keepalive` end with `[idle limit: closes in N min …]`;
if a reply starts with `note: the browser was closed …`, the window was shut
for being idle, so `run` again.

## Things that are not obvious

- **Sign-in** comes from the browser session, never from the recording (which
  holds no password). If the window shows the login page, the user signs in once
  by hand and the run continues. `$secret.NAME` in a value reads env
  `REPLAY_SECRET_NAME`. Never put a password in a patch.
- **Slow servers are handled in code.** The replay waits for the calls the
  recording says each step produced, to finish, and ignores polling and
  telemetry — no fixed sleeps. A step that is merely slow is `slow`, not a
  failure. `slow: [min, max]` adds that many ms to every API call to test a
  slow server.
- **A write that gets no answer is never sent twice.** The step stops with
  `WRITE …`; check whether it landed before re-running that step (a verifier
  can be wired with `REPLAY_VERIFY_URL`).
- **Each run really performs the writes** (it created a loan in the recording).
  Say so before running against anything but a sandbox.
- The replay compares route, templated API calls with status, and messages
  shown — not pixels. It cannot tell you a layout looks wrong.
- When a recorded locator no longer matches, the replay tries the other
  selectors, then role + name, then text; the step note says which one worked.
  `unlocatable` means all failed: `inspect {live: true}` and patch a `locator`.

## CLI (same engine, no MCP)

```
node packages/replay-mcp/src/cli.ts <recording.zip> --list
node packages/replay-mcp/src/cli.ts <recording.zip> --set 18.value="check 2" --skip 7,8,9,10
node packages/replay-mcp/src/cli.ts <recording.zip> --reuse <saved> --slow 2000,6000
```
