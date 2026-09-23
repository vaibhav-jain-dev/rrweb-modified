---
name: rrweb-evidence-recording
description: Records a DEV/staging browser session — every user action, the network requests and console output it caused, a structured digest of the UI after each action, screenshots — into a recording-*.zip with heuristic API-vs-UI findings. Use it to reproduce a UI or API bug from what a user actually did, or when you are handed a recording-*.zip; read README.md, then flow.md, and drill into network/ or ui-state/ only for the actionSeq you need.
license: MIT
metadata:
  author: rrweb-modified
  version: "1"
  produces: "recording-*.zip"
  entry: README.md
  links: "tech:rrweb, tech:chrome-devtools-protocol, concept:evidence-recording, concept:session-replay"
---

# rrweb evidence recording

A Chrome extension built on rrweb's session recorder. **Start Recording**, use
the app, **Stop Recording**: a `recording-<app>-<timestamp>.zip` lands in
Downloads holding what the user did, what the network did in response, how the
UI changed after each step, and heuristic findings. The recorded application is
not changed in any way.

## When to reach for it

- A bug report says "it happened when I clicked X" and you need the request,
  the response and the UI state at that moment, not a guess at them.
- You want reproducible `curl` commands for every call a flow makes.
- You were handed a `recording-*.zip` and need to read it without paying for
  megabytes you do not need.

## Run it

From the repository root:

```sh
yarn doctor        # Node, yarn and a browser are ready
yarn ext:build     # writes packages/web-extension/dist/chrome
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
`packages/web-extension/dist/chrome`. `make run` serves a dev build with HMR
into `dist/chrome-dev` instead; load one or the other, never both.

Open the DEV/staging app, click the extension icon, **Start Recording**, use
the app, **Stop Recording**. Settings → Network exclusions decides which hosts
and URL patterns are tiered `noise` (telemetry, CORS preflights, the
extension's own scripts); leave the recommended defaults on.

## Read a recording — cheapest first

| step | file | ~size | answers |
| --- | --- | ---: | --- |
| 0 | `manifest.json` | 1 KB | schema version, recorder version, every file with its byte size |
| 1 | `README.md` | 2 KB | this ladder, as the recorder itself wrote it |
| 2 | `flow.md` | 5–10 KB | one block per action: what was done, the primary requests, the UI diff, the screenshot, where to drill |
| 3 | `findings.md` | 5–15 KB | candidates to verify, grouped by rule — never asserted bugs |
| 4 | `summary.json` | 5 KB | flow.md as data: one entry per action with its requests |
| 5 | `network/index.json` | MBs | full requests and responses — find the `actionSeq`, then the `requestId`; **never read it whole** |
| 6 | `ui-state/digests.json`, `app-map.json`, `console.json`, `storage.json`, `screenshots/` | | drill-down for one action |

**`actionSeq` is the join key across every file.** `flow.md`'s `ACTION n`
block, `actions.json[n]`, the `network/index.json` entries with
`actionSeq: n`, the `ui-state/digests.json` entry with `actionSeq: n` and
`screenshots/action-000n-after.jpg` all describe the same moment.

`flow.md` opens with a `SUMMARY` block — page and API origins, the routes
visited in order, request counts by tier, how many findings, how many values
were redacted — which is the cheapest answer to "is what I am looking for even
in here". Routes in `flow.md` and `findings.md` are **templated**: identifiers
(UUIDs, object ids, long numbers) are replaced by `:id`, so two visits to one
screen read as one screen. The exact route is in `actions.json`.

## Rules that keep a reading honest

- Everything in `findings.md` is a **candidate**. Verify it against the
  request in `network/index.json` and the digest before repeating it.
- Field-level candidates ("returned but never rendered") are grouped **per
  endpoint** — one entry naming `GET /path/:id` and the JSON paths it
  concerns — because that is the unit to verify: does this screen render
  what this call returns. Sixty paths under one endpoint is one question.
- `tier: noise` means a settings rule excluded the request; `secondary` is
  static assets and same-origin non-API traffic; `primary` is what the app's
  backend was asked. Tiering is heuristic, not a judgement of relevance.
- `sameAs` in `ui-state/digests.json` or `network/index.json` means "identical
  to that earlier entry": the event happened, only the payload is not repeated.
- `[REDACTED:<reason>]` marks a value that existed and was removed at capture
  time; `redaction-report.json` counts them by reason. There is no original to
  ask for.
- `ambiguous: true` on a request means it overlapped two actions;
  `completedAfterSettle: true` means it finished after the UI had settled, so
  that action's digest may not reflect it yet.
- Timestamps are wall-clock milliseconds; the `HH:MM:SS` in `flow.md` is UTC.

## Known blind spots

- `network/index.json` keeps headers and bodies only for the app's own API
  traffic (`Fetch`/`XHR`/`Document`) outside the `noise` tier; scripts,
  stylesheets, images and excluded requests keep their entry (URL, status,
  timing, tier) with `payloadOmitted: "asset" | "noise"`. `network/curl.sh`
  still reproduces every non-noise request in full.
- API origins are inferred from the traffic (every origin that answered a
  fetch/XHR with JSON) and listed in the `SUMMARY`; a JSON API that the
  session never called cannot be inferred and its requests tier by heuristics.
- Recordings made before schema 1 stored no `actionT` on settle results, so
  their digests and screenshots were paired to actions by nearest time and
  rapid actions could share one; on those, trust `digestHash` over the file
  name.
- The raw rrweb event stream is **not** in the package. `rrwebId` on an action
  is rrweb's mirror id for the target node, meaningful only against a live
  recording session.

## References

- `references/package-format.md` — every file and field in the zip, with types.
- `references/reading-a-recording.md` — the playbook: from a bug report to a
  reproduction, and what to write up.
