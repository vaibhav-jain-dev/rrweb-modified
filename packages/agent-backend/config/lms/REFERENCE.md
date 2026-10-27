# LMS reference: what to query, and where

This file is read by the agent (the model sees the top of it) and by you. It
describes the LMS data the agent checks after each write. It holds no secrets:
only names and where to find them.

## How the agent reaches the database

| thing        | where                   | notes                                                                                                                                                                                                               |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| credentials  | `~/projects/.env.mongo` | read at runtime by `sources.yaml` (`envFile`). Keys used: `MONGO_HOST`, `MONGO_PORT`, `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `MONGO_INITDB_DATABASE`. Never copied, logged or put in a ledger. |
| database     | `devlms`                | from `MONGO_INITDB_DATABASE`.                                                                                                                                                                                       |
| access       | read-only               | the provider only calls `find` and `countDocuments`; filters come from `sources.yaml` templates. A database user with write rights is still not able to write through this.                                         |
| reachability | see `README.md`         | the host in that file is a DocumentDB cluster; from a laptop it usually needs the tunnel in `~/projects/connect-docdb.sh`, or point `AGENT_MONGO_URI` at the local docker copy made by `sync-mongo-to-docker.sh`.   |

## The tools (lookups) and what each one answers

Ids may be stored as ObjectId or string depending on the collection; every
`id` argument matches both.

| tool                                          | collection                                    | answers                                                                           |
| --------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `loan_application(id)`                        | `loan_applications`                           | does the loan exist; its number, milestone (`loan_milestone_id`), folder, product |
| `loan_fields_data(loan_id, fields[])`         | `loan_fields_data`                            | the saved value of each field id: `fields_data.<field_id>.value`                  |
| `loan_milestone_rows(loan_id)`                | `loan_application_milestones`                 | one row per milestone the loan carries (`loan_application_id`, `milestone_id`)    |
| `loan_conditions(loan_id)`                    | `loan_applications` (embedded `conditions[]`) | the conditions on a loan and their `status`                                       |
| `loan_notes(loan_id)`                         | `notes`                                       | newest notes incl. system-generated ones (`is_system_generated`, `condition_id`)  |
| `note_by_id(id)`                              | `notes`                                       | one note                                                                          |
| `loan_events(loan_id)`                        | `event_trail`                                 | what the system logged happened (`event_type` e.g. `CONDITION_WAIVED`)            |
| `instance_visibility(loan_id)`                | `loan_applications_instance_visibility`       | saved visibility of repeated sections                                             |
| `form_by_id`, `template_by_id`, `field_by_id` | `forms`, `templates`, `fields`                | product configuration documents                                                   |
| `job_by_id(id)`                               | `jobs`                                        | the background job a template save returns (`job_id`)                             |
| `condition_by_id`, `conditions_by_title`      | `conditions`                                  | the product's condition catalog                                                   |

Denied entirely (personal data): `profiles`, `profile_sync_operations`,
`title_companies`, `lms_permissions`, `email_messages`.

## Every write the app makes, and what the agent looks for

Learned from 16 recordings (`recording-lenderx-loan-management-platform-*.zip`,
2026-09-21 → 2026-10-07) and checked against the field names in
`whitelabel_lms_backend/backend/src/db/validators/`. Paths are shown templated;
`:id` is the loan unless noted.

| call (seen)                                          | writes to                                                                          | the agent checks                                                                              | rule id                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| `POST /lms/api/v1/loan-application` (4) → 201        | `loan_applications`, `loan_application_milestones`, `loan_fields_data`, `counters` | loan `_id` from the response exists with the same `loan_application_number`; ≥1 milestone row | `loan-create`              |
| `PATCH …/loan-application/:id/data` (3)              | `loan_fields_data`                                                                 | each changed field id holds the new value                                                     | `loan-data-patch`          |
| `PUT …/loan-application/:id/move-to-milestone` (3)   | `loan_applications.loan_milestone_id`, `event_trail`                               | `loan_milestone_id` equals `next_milestone_id`                                                | `loan-milestone-move`      |
| `PUT …/loan-application/:id/instance` (2)            | `loan_applications_instance_visibility`, `loan_fields_data`                        | the visibility document exists                                                                | `loan-instance-visibility` |
| `POST …/loan-application/:id/conditions/create` (1)  | `loan_applications.conditions[]`, `event_trail`                                    | a condition with the requested title is on the loan                                           | `condition-create`         |
| `POST …/loan-application/:id/conditions` (4; 409 ×3) | `loan_applications.conditions[]`                                                   | conditions present on the loan                                                                | `condition-attach`         |
| `POST …/conditions/:id/waive` (1)                    | `loan_applications.conditions[]`, `notes`, `event_trail`                           | status matches the response; a system note; `CONDITION_WAIVED` event (soft)                   | `condition-waive`          |
| `POST …/conditions/:id/notes` (1) → 201              | `notes`                                                                            | the note `_id` from the response exists with the sent text                                    | `condition-note`           |
| `PUT /lms/api/v2/forms/:id` (6; 400 ×1)              | `forms`                                                                            | form exists with the sent label                                                               | `form-save`                |
| `POST /lms/api/v1/templatesV2` (3) → 201             | `jobs` (then `templates` when the job finishes)                                    | the returned `job_id` exists                                                                  | `template-create`          |
| `PUT /lms/api/v1/templates/v2/:id` (2)               | `jobs`, `templates`                                                                | the job exists; the template exists                                                           | `template-update`          |
| `POST /lms/api/v1/products/:id/fields/` (1) → 201    | `fields`                                                                           | the new field exists with the sent label                                                      | `field-create`             |
| `PUT /lms/api/v1/products/:id/fields/:id` (1)        | `fields`                                                                           | label equals the sent label                                                                   | `field-update`             |
| `POST /lms/api/v1/products/:id/condition` (1) → 201  | `conditions`                                                                       | a catalog entry with the title exists                                                         | `condition-catalog-create` |
| `DELETE /lms/api/v1/products/:id/condition/:id` (1)  | `conditions`                                                                       | gone, or `active: false`                                                                      | `condition-catalog-delete` |

Write-method calls that write nothing in the LMS database (ignored, not
"uncovered"): `POST /core-internals/login`, `POST /api/utils/set-tokens`,
`POST …/products/:id/pipeline` (a search), `POST …/products/:id/fields/batch`
(a read).

Anything else that writes shows up under **Writes with no verifier** in the
panel and in `agent/log.txt`, so a missing rule is visible instead of silent.

## Things that have bitten before (so a failure reads correctly)

- **Replica lag.** Reads prefer a secondary; a just-written document can be
  missing for a second or two. That is why every verify polls.
- **`PATCH …/data` shape.** The body is `{ "<field_id>": { "value": … } }`; the
  agent compares `value`. Calculated and conditional fields are recalculated
  after the write, so a field you did not touch may change too: only fields
  in the request are compared.
- **`move-to-milestone` across several steps** commits each intermediate
  milestone separately and is not transactional: a crash leaves the loan on an
  intermediate milestone. If the check fails with a milestone that is _between_
  the old and the requested one, that is what happened.
- **Template saves are asynchronous.** `templatesV2` answers with a `job_id`
  before the template exists; "job exists" is the honest check at call time.
- **`loan_edit_sessions` is not on `main`.** Do not add tools for it until it is.
- **`unverified mapping`**: rules marked `soft: true` in the playbook are the
  ones whose exact stored shape has not been confirmed against live data (for
  example the exact `event_type` strings). They report a warning, not a failure.
  Run `yarn agent:probe` to confirm them against real documents.

## Extending

- A new lookup: add a block under `tools:` in `sources.yaml`.
- A new rule: add an entry under `rules:` in `playbooks/lms-writes.md`
  (`on`, `bind`, `verify`, `expect`). `yarn agent:probe <recording.zip>` replays a
  recording's writes through the rules against the real database and shows what
  would have been verified.
- A different system: copy this folder, change the `envFile`, tools and rules,
  and start with `AGENT_CONFIG_DIR=<folder>`.
- A different source type: `type: http` is built in (read-only by default).
  Anything else is one file implementing `SourceProvider` in `src/sources/`.
