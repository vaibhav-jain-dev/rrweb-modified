# @rrweb/replay-mcp

An MCP server (and CLI) that repeats a `recording-*.zip` in a visible browser
with changes, and reports only where the replay differed from the recording.

```
yarn replay:mcp                                  # MCP over stdio (see ../../.mcp.json)
node src/cli.ts <zip> --list                     # the steps, one line each
node src/cli.ts <zip> --set 18.value="check 2" --skip 7,8,9,10
node src/cli.ts <zip> --reuse <saved-run> --slow 2000,6000
```

Tools: `load_recording`, `run`, `inspect`, `watch`, `note`, `changes`, `keepalive`, `screenshot`, `close_browser`.

The window stays open between calls and is closed after 15 minutes
(`REPLAY_IDLE_MS`) with no call from the bot; any call renews it and `keepalive`
only renews it. The sign-in is kept, so the next `run` reopens it signed in.
**Watch mode** needs no recording: `watch start` opens the window, you use it,
you say "note this" / "note from here", and the bot asks `changes` (new since
its last ask) or `changes {note}` (what happened inside a note). Screenshots
are on demand only, of one element if asked. Events and notes are also logged
to `~/.rrweb-replay/watch/*.jsonl` (`REPLAY_WATCH_DIR`).

You can also work in the window yourself: `changes` tells the bot what you did
since it last asked (clicks, typed values, writes, screen differences; password
fields are never reported, and the replay's own steps are left out).
How a bot should use them: `../web-extension/skills/rrweb-replay/SKILL.md`.

## How a run works

1. `recording.ts` turns `actions.json` into steps: the recorder writes a click
   and `submit` *before* the values typed in the form, so those are put back in
   order; body clicks and scrolls are skipped; a password field becomes
   `$secret.PASSWORD`. Each step carries what the recording says it caused:
   templated calls with status and time, the route after, and any message that
   first appeared.
2. `patch.ts` applies the bot's one patch.
3. `runner.ts` plays each step in Playwright. `locate.ts` polls the recorded
   locator, then the other selectors, then role+name, then text.
4. `wait.ts` waits for what the recording says should happen (the step's calls
   finished, its message shown, nothing relevant in flight, page quiet for
   300 ms), not a fixed time. Limit: `max(10s, 5× slowest recorded call + 2s)`,
   cap 60s. Polling endpoints (repeating with no action behind them) and
   telemetry are never waited on.
5. `compare.ts` decides — code, not a model — `ok`, `slow`, `diverged`,
   `failed`, `timeout` or `unlocatable`. The run stops at the first problem and
   `report.ts` prints that step as recorded vs actual.

## Sign-in

Not from the recording. The browser uses a persistent profile
(`~/.rrweb-replay/profile`, override `REPLAY_PROFILE_DIR`). Signed in already:
the recorded login steps are skipped. Not signed in: sign in once in the open
window and the run continues. With `REPLAY_SECRET_PASSWORD` set, the recorded
login steps are replayed instead.

A sign-in that lives only in a *session cookie* is dropped when the browser
closes. Inside one MCP session the browser stays open between `run` calls, so
it holds; across separate processes, sign in again (apps that keep the session
in localStorage or a persistent cookie keep it).

## Writes

A write (`POST`/`PUT`/`PATCH`/`DELETE`) that gets no answer is never sent again
on a guess. The run stops with `WRITE …`. With `REPLAY_VERIFY_URL` set, the
runner first calls `GET <url>?endpoint=…&url=…` and expects `{"landed": bool}`.

## Environment

| variable | meaning |
| --- | --- |
| `REPLAY_PROFILE_DIR` | browser profile (the saved sign-in) |
| `REPLAY_HEADLESS=1` | no window (tests) |
| `REPLAY_IDLE_MS` | idle time before the browser is closed (default 15 min) |
| `REPLAY_LOGIN_WAIT_MS` | how long to wait for you to sign in by hand (default 5 min) |
| `REPLAY_SECRET_<NAME>` | value for `$secret.<NAME>`; also read from `~/.rrweb-replay/secrets.env` (`REPLAY_SECRETS_FILE` to move it) |
| `REPLAY_VERIFY_URL` | write verifier, see above |
| `REPLAY_OUT_DIR` | where `last/run.json` is written (default `<zip>.runs/`) |

## Not done

- The run is not exported as its own `recording-*.zip`; `last/run.json` holds
  every step result. The package-format doc does not yet describe a replay zip.
- No built-in database verifier: `REPLAY_VERIFY_URL` is the seam for the
  agent-backend or any service that can look a record up.
