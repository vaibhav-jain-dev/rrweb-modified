# @rrweb/agent-backend

A local process that watches a recording as it happens, checks every write the
app makes against the database, and shows the result live in the extension's
side panel. At Stop it hands back a ledger that goes into the recording zip.

```
yarn agent:start          # http://127.0.0.1:47821
```

Then in the extension popup: **Live agent ▾** → tick a playbook → **Start**.
The side panel opens beside the page.

## What you see while recording

- A **headline** that changes as you work: `checking…` → `Loan L-9 is in the
  database` → proceed.
- **Steps** (guided playbooks): the next thing to do, ticked off as each write is
  confirmed. When all are confirmed the panel says *Go ahead*.
- **Checks**, each with its status, how long it took, and the evidence behind it
  (the lookup that ran, its projected result, the comparison).
- **Not verified**: writes the playbook has no rule for, error responses, steps
  that never happened.
- **Ask**: type "check the order I just placed was received". The model turns that
  into one named lookup (never SQL); code runs and judges it.

## How a check is decided

Code decides, the model never does. A rule says *when this call happens, look
this thing up, and expect that*. The lookup result is compared to the request
and response; the outcome is `verified`, `failed`, `unchecked` (the database
could not be asked) or `never_seen`. The model may translate a typed ask into a
lookup, pick a field when the key name is ambiguous, and add a one-line remark
marked *(model)* and unverified. It cannot mark anything verified.

Reads prefer a replica, so every lookup **polls** briefly before calling a
missing document a failure.

## Configuration

Everything lives in a config folder (default `config/lms`, override with
`AGENT_CONFIG_DIR`):

| file | what |
| --- | --- |
| `sources.yaml` | where lookups run (`mongo`, `http`, built-in `session`) and the named **tools** |
| `playbooks/*.md` | YAML front-matter (rules, steps) + a short Markdown brief. The popup dropdown lists these files |
| `REFERENCE.md` | what the data means and which write touches which collection. The model reads the top of it |
| `.env` | optional: model, port, how to reach the database. See `.env.example` |

### Reaching the database

`sources.yaml` points at `~/projects/.env.mongo` (`KEY: value` or `KEY=value`).
Credentials are read when the backend connects, and never logged, copied or
written to a ledger. Mongo access is **read-only by construction**: the provider
only calls `find` and `countDocuments`, filters come from templates with typed
argument binding (an argument can never become an operator), code-running
operators are refused, and `profiles` and other personal-data collections are
denied.

The host in that file is a DocumentDB cluster. From a laptop you normally reach
it through a tunnel, or use a local copy:

| situation | set in `.env` |
| --- | --- |
| a local docker copy | `AGENT_MONGO_URI=mongodb://127.0.0.1:27017/` and `AGENT_MONGO_DATABASE=devlms`. The credentials file is not opened at all |
| an SSH tunnel to the cluster | `AGENT_MONGO_HOST_OVERRIDE=127.0.0.1:27018`, `AGENT_MONGO_DIRECT=true`, `AGENT_MONGO_TLS=true`, `AGENT_MONGO_TLS_CA_FILE=<global-bundle.pem>` |
| direct from a VPN | `AGENT_MONGO_TLS=true`, `AGENT_MONGO_TLS_CA_FILE=…`, `AGENT_MONGO_REPLICA_SET=rs0` |

The popup shows `cannot reach devlms` when the source is down; checks then say
*could not check*, never *failed*.

### Writing a rule

```yaml
rules:
  - id: loan-data-patch
    title: Field values saved
    on: "PATCH /lms/api/user/v1/loan-application/:id/data"
    bind:
      loan_id: $path[0]                    # first id in the URL
      fields: $req.body | keys             # request body keys
      want: $req.body | mapvalues(value)   # { field: value }
    verify:
      - tool: loan_fields_data
        args: { loan_id: $loan_id, fields: $fields }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: values, op: includes_map, value: $want }
        say: "Every field you changed holds the new value"
```

References start with `$`: `$req.body.x`, `$res.body._id`, `$res.status`,
`$path[0]`, `$query.q`, `$req.header.x-user`, a name bound earlier, and `$result.…`
in a `capture`. Pipes: `keys`, `values`, `length`, `first`, `last`, `string`,
`mapvalues(k)`, `pick(a,b)`. Operators: `eq ne in exists missing gt gte lt lte
contains regex has_item includes_map truthy falsy`. `soft: true` makes an
expectation a warning; `anyOf:` passes if one alternative holds; `required: true`
on a rule records `never_seen` if the call never happens.

A bound value can be found rather than named:
`loan_id: { find: the new loan's id, in: $res.body, prefer: [_id] }` looks for
`_id`, `id`, `*_id` first and only asks the model (constrained to a list of real
paths) as a last resort.

### Guided flows: redo a recording with the agent beside you

```
yarn agent:learn ~/Downloads/recording-….zip --name new-loan
```

writes `playbooks/follow-new-loan.md`: the recording's successful writes, in
order, as **steps** (`Click "New loan" on /home`, …), including the verification
rules of `lms-writes`. Select it in the popup; the panel tells you what to do
next and ticks it off when the database confirms each write. Edit the generated
steps freely.

### Checking your rules against real documents

```
yarn agent:probe ~/Downloads/recording-….zip --dry     # show the lookups, run nothing
yarn agent:probe ~/Downloads/recording-….zip           # replay the writes against the database
yarn agent:probe <zip> --rules loan-create,form-save --json ledger.json
```

Replays a recording's calls through the rules (read-only). Rules marked `soft`
in the shipped playbook are the ones whose stored shape is not yet confirmed
against live data; probe is how to confirm them. Exit code 1 if any check failed.

## Replaying a recording

To repeat a recording rather than watch one, see `packages/replay-mcp`. Its
`REPLAY_VERIFY_URL` seam lets a replay ask a service whether a write that got no
answer actually landed, so the run never sends it twice on a guess.

## Resource use

The model runs on the GPU or not at all: `/health` reports `gpu: false` if Ollama
split it onto CPU and the popup shows *CPU – slow*. One model request at a time,
background remarks dropped when the queue is deep, polling floored at 1 s and
capped at four at once, nothing runs when no events arrive. The extension does no
extra work on the page: it forwards network records it already captured.

## Environment

| variable | default | |
| --- | --- | --- |
| `AGENT_MODEL` | `qwen2.5-coder:3b` | `none` = rules only (no asks, no remarks) |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |
| `AGENT_PORT` / `AGENT_HOST` | `47821` / `127.0.0.1` | |
| `AGENT_TOKEN` | – | required if `AGENT_HOST` is not loopback; set the same in the extension's options |
| `AGENT_CONFIG_DIR` | `config/lms` | |

## Tests

```
yarn agent:test                       # 101 tests, no services needed
docker run --rm -d --name agent-e2e-mongo mongo:5.0      # then, with its IP:
AGENT_E2E_MONGO_URI=mongodb://<ip>:27017/ yarn agent:test mongo.e2e   # +11 against a real MongoDB
```

The end-to-end test seeds its own throwaway database and never reads the
credentials file.

## Layout

```
src/server.ts        http + SSE + WebSocket        src/lane.ts      rule engine, polling, steps, asks
src/session.ts       per-recording state           src/expr.ts      references, pipes, assertions
src/sources/         mongo · http · session        src/config/      sources.yaml + playbook parsing
src/tools/registry   named tools, typed arguments  src/cli.ts       probe, learn
src/model/           ollama (1 in flight, GPU)     src/recording.ts reads recording-*.zip
```

The wire types and the narrative renderer are shared with the extension
(`packages/web-extension/src/agent/`), and Node runs them directly, so there is
one definition of each.
