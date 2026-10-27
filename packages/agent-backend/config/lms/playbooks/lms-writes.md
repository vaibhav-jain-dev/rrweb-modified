---
id: lms-writes
title: LMS writes → database
description: After every POST / PUT / PATCH / DELETE the app makes, look in devlms for what it should have written, then say whether to proceed.
model: true

# Calls that use a write method but write nothing in the LMS database.
ignore:
  - "POST /core-internals/login"
  - "POST /api/utils/set-tokens"
  - "POST /lms/api/user/v1/products/:id/pipeline"
  - "POST /lms/api/v1/products/:id/fields/batch"

rules:
  # ---- loan lifecycle -----------------------------------------------------
  - id: loan-create
    title: Loan created
    on: "POST /lms/api/v1/loan-application"
    status: "201"
    bind:
      loan_id: { find: the new loan application's id, in: $res.body, prefer: [_id] }
    verify:
      - id: row
        tool: loan_application
        args: { id: $loan_id }
        poll: { everyMs: 1500, forMs: 15000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.loan_application_number, op: eq, value: $res.body.loan_application_number }
          - { path: doc.folder_id, op: eq, value: $req.body.folder_id, soft: true }
        say: "Loan {loan_application_number} is in the database"
      - id: milestones
        tool: loan_milestone_rows
        args: { loan_id: $loan_id }
        poll: { everyMs: 1500, forMs: 10000 }
        expect:
          - { path: count, op: gte, value: 1 }
        say: "{count} milestone rows written for the loan"

  - id: loan-data-patch
    title: Field values saved
    on: "PATCH /lms/api/user/v1/loan-application/:id/data"
    bind:
      loan_id: $path[0]
      fields: $req.body | keys
      want: $req.body | mapvalues(value)
    verify:
      - id: values
        tool: loan_fields_data
        args: { loan_id: $loan_id, fields: $fields }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: values, op: includes_map, value: $want }
        say: "{count} loan_fields_data document found; every field you changed holds the new value"

  - id: loan-milestone-move
    title: Milestone moved
    on: "PUT /lms/api/user/v1/loan-application/:id/move-to-milestone"
    bind:
      loan_id: $path[0]
      target: $req.body.next_milestone_id
    verify:
      - id: loan
        tool: loan_application
        args: { id: $loan_id }
        poll: { everyMs: 1500, forMs: 10000 }
        expect:
          - { path: doc.loan_milestone_id, op: eq, value: $target }
        say: "Loan {loan_application_number} is now on the requested milestone"
      - id: event
        tool: loan_events
        args: { loan_id: $loan_id }
        expect:
          - { path: rows, op: truthy, soft: true }

  - id: loan-instance-visibility
    title: Instance visibility saved
    on: "PUT /lms/api/user/v1/loan-application/:id/instance"
    bind:
      loan_id: $path[0]
    verify:
      - id: visibility
        tool: instance_visibility
        args: { loan_id: $loan_id }
        poll: { everyMs: 1200, forMs: 6000 }
        expect:
          - { path: found, op: eq, value: true }
        say: "Instance visibility document exists for the loan"

  # ---- conditions and notes on a loan --------------------------------------
  - id: condition-create
    title: Condition added to loan
    on: "POST /lms/api/user/v1/loan-application/:id/conditions/create"
    bind:
      loan_id: $path[0]
    verify:
      - id: embedded
        tool: loan_conditions
        args: { loan_id: $loan_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: doc.conditions, op: has_item, value: { title: $req.body.title } }
        say: "Condition \"{title}\" is on the loan"

  - id: condition-attach
    title: Conditions attached to loan
    on: "POST /lms/api/user/v1/loan-application/:id/conditions"
    bind:
      loan_id: $path[0]
    verify:
      - id: embedded
        tool: loan_conditions
        args: { loan_id: $loan_id }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.conditions, op: truthy }

  - id: condition-waive
    title: Condition waived
    on: "POST /lms/api/user/v1/loan-application/:id/conditions/:id/waive"
    bind:
      loan_id: $path[0]
      condition_id: $path[1]
    verify:
      - id: state
        tool: loan_conditions
        args: { loan_id: $loan_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: doc.conditions, op: has_item, value: { _id: $condition_id, status: $res.body.status } }
        say: "The condition now has status {status} on the loan"
      - id: note
        tool: loan_notes
        args: { loan_id: $loan_id }
        poll: { everyMs: 1200, forMs: 6000 }
        expect:
          - { path: rows, op: has_item, value: { condition_id: $condition_id }, soft: true }
        say: "A note was written against the condition"
      - id: event
        tool: loan_events
        args: { loan_id: $loan_id }
        expect:
          - { path: rows, op: has_item, value: { event_type: CONDITION_WAIVED }, soft: true }

  - id: condition-note
    title: Condition note saved
    on: "POST /lms/api/user/v1/loan-application/:id/conditions/:id/notes"
    status: "201"
    bind:
      note_id: $res.body._id
    verify:
      - id: note
        tool: note_by_id
        args: { id: $note_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.note, op: eq, value: $req.body.text }
        say: "The note text is in the database"

  # ---- configuration -------------------------------------------------------
  - id: form-save
    title: Form saved
    on: "PUT /lms/api/v2/forms/:id"
    bind:
      form_id: $path[0]
    verify:
      - id: form
        tool: form_by_id
        args: { id: $form_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.label, op: eq, value: $req.body.label }
        say: "Form \"{label}\" is saved"

  - id: template-create
    title: Template create queued
    on: "POST /lms/api/v1/templatesV2"
    status: "201"
    bind:
      job_id: $res.body.job_id
    verify:
      - id: job
        tool: job_by_id
        args: { id: $job_id }
        poll: { everyMs: 2000, forMs: 30000 }
        expect:
          - { path: found, op: eq, value: true }
        say: "Background job {job_id} exists"

  - id: template-update
    title: Template update queued
    on: "PUT /lms/api/v1/templates/v2/:id"
    bind:
      job_id: $res.body.job_id
      template_id: $path[0]
    verify:
      - id: job
        tool: job_by_id
        args: { id: $job_id }
        poll: { everyMs: 2000, forMs: 30000 }
        expect:
          - { path: found, op: eq, value: true }
        say: "Background job {job_id} exists"
      - id: template
        tool: template_by_id
        args: { id: $template_id }
        expect:
          - { path: found, op: eq, value: true }

  - id: field-create
    title: Field created
    on: "POST /lms/api/v1/products/:id/fields/"
    status: "201"
    bind:
      field_id: $res.body._id
    verify:
      - id: field
        tool: field_by_id
        args: { id: $field_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.label, op: eq, value: $req.body.label }
        say: "Field \"{label}\" exists"

  - id: field-update
    title: Field updated
    on: "PUT /lms/api/v1/products/:id/fields/:id"
    bind:
      field_id: $path[1]
    verify:
      - id: field
        tool: field_by_id
        args: { id: $field_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: doc.label, op: eq, value: $req.body.label }
        say: "Field label saved as \"{label}\""

  - id: condition-catalog-create
    title: Condition added to product
    on: "POST /lms/api/v1/products/:id/condition"
    status: "201"
    bind:
      title: $req.body.title
    verify:
      - id: catalog
        tool: conditions_by_title
        args: { title: $title }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - { path: found, op: eq, value: true }
        say: "Condition \"{title}\" is in the catalog"

  - id: condition-catalog-delete
    title: Condition removed from product
    on: "DELETE /lms/api/v1/products/:id/condition/:id"
    bind:
      condition_id: $path[1]
    verify:
      - id: gone
        tool: condition_by_id
        args: { id: $condition_id }
        poll: { everyMs: 1200, forMs: 8000 }
        expect:
          - anyOf:
              - { path: found, op: eq, value: false }
              - { path: doc.active, op: eq, value: false }
        say: "The condition is gone (or inactive)"
---
You are watching a loan-management web app being used. Each time the app writes data, you
look in the database for what should have been written and report whether to proceed.

Rules you follow:
- You only call the named lookups you are given. You never invent collection or field names.
- A check passes or fails by comparing real database values; you do not decide that.
- If something fails, explain the most likely cause in one sentence, using only the evidence given.

See REFERENCE.md for what each collection holds.
