# Reading a recording: from a bug report to a reproduction

The recording is evidence, not a verdict. The job is to find the one moment
the report is about, read everything the package holds about that moment, and
say what the evidence supports — separately from what it does not.

## 1. Orient (≈3 KB)

1. `manifest.json` — how many actions and requests, which files are large.
2. `README.md` — confirm the schema version matches what this skill describes.
3. `flow.md` — skim the `ACTION` headers only: the routes visited and the
   labels. Note the `actionSeq` values around the step the report describes.

Stop here if the report is about a route the session never visited: say so.

## 2. Find the moment

- The report names a click or a page: match its label / route in `flow.md`.
- The report names an API: grep `flow.md` for the path; the `ACTION` block it
  sits under is the moment. A request listed under **BACKGROUND ACTIVITY** was
  attributed to no action — polling, usually.
- The report names a value shown wrongly: `findings.md` may already list it
  under *Value mismatch* or *API field with no UI representation*, with the
  `actionSeq` and `jsonPath`.

## 3. Read that moment only

For the chosen `actionSeq = n`:

| want | read | how |
| --- | --- | --- |
| what exactly was clicked/typed | `actions.json[n]` | `target.locator`, `value` |
| the request and response | `network/index.json` | filter `actionSeq == n`; follow `sameAs` to the entry that carries the body; `bodyTruncated` means the tail is missing |
| a reproducible call | `network/curl.sh` | search the same path; headers that were credentials are `[REDACTED:header]` and must be supplied |
| what the page showed | `ui-state/digests.json` entry with `actionSeq == n` | `collections` for row counts, `controls` for state, `status` for toasts; follow `sameAs` |
| what it looked like | `screenshots/action-000n-after.jpg` | only if the digest cannot answer; a shared file means the state was unchanged |
| errors at the time | `console.json` | filter `actionSeq == n`, ignore `debug` |

Do not read `network/index.json` whole. Extract the entries for one
`actionSeq` (`jq '.[] | select(.actionSeq == n)'`) and stop.

## 4. Decide what the evidence supports

Write three lists, and keep them apart:

- **Observed** — a fact with a pointer: "`GET /lms/api/.../data` returned 200
  in 2.7 s (`network/index.json` requestId …); the digest after action 2 shows
  the loan table with 0 rows."
- **Candidate** — a `findings.md` entry you checked and could not rule out, in
  the recorder's own words, with its `howToVerify`.
- **Not determinable from the recording** — a redacted value, a truncated
  body, a request tiered `noise` by a settings rule, a state between two
  rapid actions that share one digest.

A finding that lives only in `findings.md` and nowhere in the request or the
digest is not observed; it stays a candidate.

## 5. Reproduce

1. Take the request from `network/curl.sh`, supply credentials, run it against
   the same environment.
2. Compare the response body with `responseBody` in the recording — same
   fields, same values? A difference is a lead; the environment moved.
3. Repeat the user's steps from `flow.md` in the app, watching the same
   request in devtools.

## What to write up

Route, `actionSeq`, request path and status, the observed/candidate split,
and the recorder version from `manifest.json`. A screenshot path is a pointer
a reader can open; an image pasted into prose is a cost with no join key.
