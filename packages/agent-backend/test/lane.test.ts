import { describe, expect, it } from 'vitest';
import { FakeModel } from '../src/model/fake.ts';
import { ModelError } from '../src/model/types.ts';
import { askSchema, validateAskPlan } from '../src/lane.ts';
import { fakeRegistry, makeLane, playbook, rec } from './helpers.ts';

const LOAN = '6a62d0b46ccb69068d608083';
const LOAN_URL = `https://h/lms/api/user/v1/loan-application/${LOAN}`;

const createPb = () =>
  playbook(
    `
id: p
title: P
rules:
  - id: create
    title: Loan created
    on: "POST /lms/api/v1/loan-application"
    status: "201"
    bind:
      loan_id: $res.body._id
    verify:
      - id: row
        tool: loan
        args: { id: $loan_id }
        poll: { everyMs: 1000, forMs: 5000 }
        expect:
          - { path: found, op: eq, value: true }
          - { path: doc.number, op: eq, value: $res.body.number }
        say: "Loan {number} is in the database"
`,
    ['loan'],
  );

const createCall = () =>
  rec('POST', 'https://h/lms/api/v1/loan-application', {
    status: 201,
    res: { _id: LOAN, number: 'L-9' },
  });

describe('a rule occurrence', () => {
  it('verifies when the source agrees, and says so in the headline', async () => {
    const { registry, calls } = fakeRegistry(
      { loan: () => ({ found: true, count: 1, doc: { number: 'L-9' } }) },
      { loan: { id: 'id' } },
    );
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    const l = t.lane.ledger();
    expect(l.checks).toHaveLength(1);
    expect(l.checks[0].status).toBe('verified');
    expect(l.checks[0].note).toBe('Loan L-9 is in the database');
    expect(l.headline).toMatchObject({
      level: 'ok',
      text: 'Loan L-9 is in the database',
    });
    expect(calls[0].args).toEqual({ id: LOAN });
    expect(l.verdict.verified).toBe(1);
  });

  it('polls until the document appears, then verifies', async () => {
    let n = 0;
    const { registry, calls } = fakeRegistry({
      loan: () =>
        ++n < 3
          ? { found: false, count: 0, doc: null }
          : { found: true, count: 1, doc: { number: 'L-9' } },
    });
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    const c = t.lane.ledger().checks[0];
    expect(c.status).toBe('verified');
    expect(calls).toHaveLength(3);
    const tool = c.evidence.find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ kind: 'tool', attempt: 3 });
  });

  it('fails with the contradicting value when polling runs out, and keeps a timeout record', async () => {
    const { registry, calls } = fakeRegistry({
      loan: () => ({ found: true, count: 1, doc: { number: 'WRONG' } }),
    });
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    const c = t.lane.ledger().checks[0];
    expect(c.status).toBe('failed');
    expect(c.note).toMatch(/doc\.number eq "L-9" — got "WRONG"/);
    expect(c.evidence.some((e) => e.kind === 'timeout')).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
    // only the last attempt's tool/assert evidence is kept, so a long poll cannot bloat the ledger
    expect(c.evidence.filter((e) => e.kind === 'tool')).toHaveLength(1);
  });

  it('reports "could not check" — not "failed" — when the source is down', async () => {
    const { registry } = fakeRegistry({
      loan: () => ({
        ok: false,
        kind: 'unavailable',
        message: 'mongo devlms: connect ECONNREFUSED',
        ms: 3,
      }),
    });
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    const c = t.lane.ledger().checks[0];
    expect(c.status).toBe('unchecked');
    expect(c.evidence).toContainEqual({
      kind: 'error',
      message: 'mongo devlms: connect ECONNREFUSED',
    });
    expect(t.lane.ledger().headline.text).toMatch(/could not check/);
  });

  it('retries an unavailable source while a poll window is open', async () => {
    let n = 0;
    const { registry } = fakeRegistry({
      loan: () =>
        ++n < 3
          ? { ok: false, kind: 'unavailable', message: 'timeout', ms: 1 }
          : { found: true, count: 1, doc: { number: 'L-9' } },
    });
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    expect(t.lane.ledger().checks[0].status).toBe('verified');
  });

  it('does not retry a bad call', async () => {
    const { registry, calls } = fakeRegistry({
      loan: () => ({
        ok: false,
        kind: 'bad_args',
        message: 'missing argument id',
        ms: 0,
      }),
    });
    const t = makeLane(createPb(), registry);
    t.feed(createCall());
    await t.settle();
    expect(calls).toHaveLength(1);
    expect(t.lane.ledger().checks[0].status).toBe('unchecked');
  });

  it('ignores calls whose status the rule did not ask for', async () => {
    const { registry, calls } = fakeRegistry({ loan: () => ({ found: true }) });
    const t = makeLane(createPb(), registry);
    t.feed(
      rec('POST', 'https://h/lms/api/v1/loan-application', {
        status: 409,
        res: { detail: 'dup' },
      }),
    );
    await t.settle();
    expect(calls).toHaveLength(0);
    expect(t.lane.ledger().anomalies[0]).toMatchObject({
      kind: 'error_response',
    });
  });

  it('passes a soft expectation with a warning but fails a hard one', async () => {
    const pb = playbook(
      `
id: p
rules:
  - id: r
    on: "POST /x"
    verify:
      - tool: t
        expect:
          - { path: a, op: eq, value: 1 }
          - { path: b, op: eq, value: 2, soft: true }
`,
      ['t'],
    );
    const ok = fakeRegistry({ t: () => ({ a: 1, b: 99 }) });
    const t1 = makeLane(pb, ok.registry);
    t1.feed(rec('POST', 'https://h/x'));
    await t1.settle();
    const c1 = t1.lane.ledger().checks[0];
    expect(c1.status).toBe('verified');
    expect(c1.warnings?.[0]).toMatch(/b eq 2 — got 99/);

    const bad = fakeRegistry({ t: () => ({ a: 0, b: 2 }) });
    const t2 = makeLane(pb, bad.registry);
    t2.feed(rec('POST', 'https://h/x'));
    await t2.settle();
    expect(t2.lane.ledger().checks[0].status).toBe('failed');
  });

  it('skips an expectation whose reference cannot be resolved, and says so', async () => {
    const pb = playbook(
      `
id: p
rules:
  - id: r
    on: "POST /x"
    verify:
      - tool: t
        expect:
          - { path: a, op: eq, value: $res.body.nothing_here }
`,
      ['t'],
    );
    const { registry } = fakeRegistry({ t: () => ({ a: 1 }) });
    const t = makeLane(pb, registry);
    t.feed(rec('POST', 'https://h/x', { res: {} }));
    await t.settle();
    const c = t.lane.ledger().checks[0];
    expect(c.status).toBe('verified');
    expect(c.warnings?.[0]).toMatch(/skipped.*did not resolve/);
  });

  it('anyOf passes when one alternative holds (soft-delete vs hard-delete)', async () => {
    const pb = playbook(
      `
id: p
rules:
  - id: r
    on: "DELETE /x/:id"
    verify:
      - tool: t
        expect:
          - anyOf:
              - { path: found, op: eq, value: false }
              - { path: doc.active, op: eq, value: false }
`,
      ['t'],
    );
    const soft = fakeRegistry({
      t: () => ({ found: true, doc: { active: false } }),
    });
    const a = makeLane(pb, soft.registry);
    a.feed(rec('DELETE', `https://h/x/${LOAN}`));
    await a.settle();
    expect(a.lane.ledger().checks[0].status).toBe('verified');

    const still = fakeRegistry({
      t: () => ({ found: true, doc: { active: true } }),
    });
    const b = makeLane(pb, still.registry);
    b.feed(rec('DELETE', `https://h/x/${LOAN}`));
    await b.settle();
    expect(b.lane.ledger().checks[0].status).toBe('failed');
  });

  it('compares every field the PATCH changed against what was stored', async () => {
    const pb = playbook(
      `
id: p
rules:
  - id: patch
    on: "PATCH /lms/api/user/v1/loan-application/:id/data"
    bind:
      loan_id: $path[0]
      fields: $req.body | keys
      want: $req.body | mapvalues(value)
    verify:
      - tool: values
        args: { loan_id: $loan_id, fields: $fields }
        expect:
          - { path: values, op: includes_map, value: $want }
`,
      ['values'],
    );
    const { registry, calls } = fakeRegistry({
      values: () => ({ found: true, values: { f1: 10, f2: 'old' } }),
    });
    const t = makeLane(pb, registry);
    t.feed(
      rec('PATCH', `${LOAN_URL}/data`, {
        req: { f1: { value: 10 }, f2: { value: 'new' } },
      }),
    );
    await t.settle();
    expect(calls[0].args).toEqual({ loan_id: LOAN, fields: ['f1', 'f2'] });
    const c = t.lane.ledger().checks[0];
    expect(c.status).toBe('failed');
    expect(c.note).toMatch(/1 differ: f2/);
  });
});

describe('writes nothing verifies', () => {
  const pb = playbook(
    `
id: p
ignore: ["POST /login"]
rules:
  - { id: r, on: "POST /known" }
`,
    [],
  );

  it('lists unmatched writes once, counts repeats, ignores reads and ignored endpoints', async () => {
    const { registry } = fakeRegistry({});
    const t = makeLane(pb, registry);
    t.feed(rec('POST', 'https://h/mystery/1'));
    t.feed(rec('POST', 'https://h/mystery/2'));
    t.feed(rec('GET', 'https://h/anything'));
    t.feed(rec('POST', 'https://h/login'));
    await t.settle();
    const l = t.lane.ledger();
    expect(l.uncovered).toEqual({ 'POST /mystery/1': 1, 'POST /mystery/2': 1 });
    expect(
      l.anomalies.filter((a) => a.kind === 'uncovered_write'),
    ).toHaveLength(2);
  });

  it('collapses repeats of the same templated endpoint', async () => {
    const { registry } = fakeRegistry({});
    const t = makeLane(pb, registry);
    t.feed(rec('POST', `https://h/mystery/${LOAN}`));
    t.feed(rec('POST', 'https://h/mystery/6a62d0b46ccb69068d608084'));
    await t.settle();
    const l = t.lane.ledger();
    expect(l.uncovered).toEqual({ 'POST /mystery/:id': 2 });
    expect(l.anomalies).toHaveLength(1);
  });

  it('a rule with no verify only asserts the call happened', async () => {
    const { registry } = fakeRegistry({});
    const t = makeLane(pb, registry);
    t.feed(rec('POST', 'https://h/known'));
    await t.settle();
    expect(t.lane.ledger().checks[0]).toMatchObject({ status: 'verified' });
  });

  it('a required rule that never fires is recorded as never seen', async () => {
    const req = playbook(
      'id: p\nrules:\n  - { id: must, title: Must happen, on: "POST /must", required: true }',
      [],
    );
    const { registry } = fakeRegistry({});
    const t = makeLane(req, registry);
    await t.settle();
    expect(t.lane.ledger().checks[0]).toMatchObject({
      status: 'never_seen',
      claim: 'Must happen',
    });
    expect(t.lane.ledger().verdict.never_seen).toBe(1);
  });
});

describe('steps and the go-ahead', () => {
  const pb = () =>
    playbook(
      `
id: p
rules:
  - id: create
    title: Create
    on: "POST /orders"
    bind: { order_id: $res.body.id }
    verify:
      - tool: order
        args: { id: $order_id }
        poll: { everyMs: 1000, forMs: 20000 }
        expect:
          - { path: doc.status, op: in, value: [received, processing] }
        say: "Order {order_id} received — you can proceed"
steps:
  - say: "Place an order"
    wait: [create]
  - say: "Open the order page"
    wait: ["GET /orders/:id"]
  - say: "Done — stop the recording"
`,
      ['order'],
    );

  it('walks the person through, advances as checks verify, and fires the gate once', async () => {
    // the DB first says "pending", then "received" on the third look
    let looks = 0;
    const { registry } = fakeRegistry({
      order: () => ({
        found: true,
        doc: { status: ++looks < 3 ? 'pending' : 'received' },
      }),
    });
    const t = makeLane(pb(), registry);

    let l = t.lane.ledger();
    expect(l.headline.text).toBe('Next: Place an order');
    expect(l.currentStep).toBe(0);
    expect(l.steps![0].state).toBe('current');

    t.feed(rec('POST', 'https://h/orders', { status: 201, res: { id: 'o1' } }));
    // while it polls, the panel shows what it is doing
    await Promise.resolve();
    expect(t.lane.ledger().headline.level).toBe('checking');
    await t.idle();
    l = t.lane.ledger();
    expect(looks).toBe(3);
    expect(l.checks[0].status).toBe('verified');
    expect(l.checks[0].note).toBe('Order o1 received — you can proceed');
    expect(l.steps![0].state).toBe('passed');
    expect(l.currentStep).toBe(1);
    expect(t.gates).toHaveLength(0);

    t.feed(rec('GET', 'https://h/orders/6a62d0b46ccb69068d608083'));
    l = t.lane.ledger();
    expect(l.steps![1].state).toBe('passed');
    expect(l.gateReadyAt).toBeDefined();
    expect(l.headline.text).toBe('All steps verified — go ahead');
    expect(t.gates).toHaveLength(1);

    t.feed(rec('GET', 'https://h/orders/6a62d0b46ccb69068d608084'));
    expect(t.gates).toHaveLength(1);
  });

  it('blocks the step when its check fails, instead of moving on', async () => {
    const { registry } = fakeRegistry({
      order: () => ({ found: true, doc: { status: 'rejected' } }),
    });
    const t = makeLane(pb(), registry);
    t.feed(rec('POST', 'https://h/orders', { status: 201, res: { id: 'o1' } }));
    await t.settle();
    const l = t.lane.ledger();
    expect(l.steps![0].state).toBe('blocked');
    expect(l.gateReadyAt).toBeUndefined();
  });

  it('lets the person get ahead: a later call is not lost because an earlier step is still open', async () => {
    const { registry } = fakeRegistry({
      order: () => ({ found: true, doc: { status: 'received' } }),
    });
    const t = makeLane(pb(), registry);
    t.feed(rec('GET', 'https://h/orders/6a62d0b46ccb69068d608083'));
    t.feed(rec('POST', 'https://h/orders', { status: 201, res: { id: 'o1' } }));
    await t.settle();
    expect(t.lane.ledger().steps!.map((s) => s.state)).toEqual([
      'passed',
      'passed',
      'current',
    ]);
    expect(t.gates).toHaveLength(1);
  });

  it('a step that never happened is reported at stop', async () => {
    const { registry } = fakeRegistry({
      order: () => ({ found: true, doc: { status: 'received' } }),
    });
    const t = makeLane(pb(), registry);
    await t.settle();
    expect(
      t.lane
        .ledger()
        .anomalies.some(
          (a) => a.kind === 'missing_call' && /Place an order/.test(a.text),
        ),
    ).toBe(true);
  });
});

describe('capture between verifies', () => {
  it('passes a value from one verify into the next in the same occurrence', async () => {
    const pb = playbook(
      `
id: p
rules:
  - id: r
    on: "POST /x"
    verify:
      - id: first
        tool: a
        capture: { owner: $result.doc.owner }
      - id: second
        tool: b
        args: { who: $owner }
        expect: [{ path: ok, op: eq, value: true }]
`,
      ['a', 'b'],
    );
    const { registry, calls } = fakeRegistry({
      a: () => ({ found: true, doc: { owner: 'u9' } }),
      b: () => ({ ok: true }),
    });
    const t = makeLane(pb, registry);
    t.feed(rec('POST', 'https://h/x'));
    await t.settle();
    expect(calls[1]).toEqual({ tool: 'b', args: { who: 'u9' } });
    expect(t.lane.ledger().verdict.verified).toBe(2);
  });
});

describe('asks', () => {
  const tools = { order: { id: 'id' } } as const;

  it('turns a typed request into a polling check that goes green', async () => {
    let n = 0;
    const { registry, calls } = fakeRegistry(
      {
        order: () =>
          ++n < 3
            ? { found: false }
            : { found: true, doc: { status: 'received' } },
      },
      { order: tools.order },
    );
    const model = new FakeModel(() => ({
      claim: 'Order is received',
      tool: 'order',
      args: { id: '$order_id' },
      poll: true,
      expect: [{ path: 'doc.status', op: 'eq', value: 'received' }],
    }));
    const pb = playbook(
      'id: p\nrules:\n  - { id: r, on: "POST /orders", bind: { order_id: $res.body.id } }',
      [],
    );
    const t = makeLane(pb, registry, { model });
    t.feed(rec('POST', 'https://h/orders', { res: { id: 'o7' } }));
    await t.idle();

    const out = await t.lane.ask(
      'check that the order I just made was received',
    );
    expect(out.ok).toBe(true);
    await t.settle();
    const c = t.lane.ledger().checks.find((x) => x.origin === 'ask')!;
    expect(c).toMatchObject({
      status: 'verified',
      askText: 'check that the order I just made was received',
      claim: 'Order is received',
    });
    expect(calls[0].args).toEqual({ id: 'o7' });
    expect(calls.length).toBe(3);
    // the model was told which values exist and which tools it may use
    expect(model.calls[0].user).toMatch(/\$order_id="o7"/);
    expect(model.calls[0].priority).toBe('ask');
  });

  it('refuses without a model, saying what to do', async () => {
    const { registry } = fakeRegistry({ order: () => ({ found: true }) });
    const t = makeLane(playbook('id: p', []), registry, { model: null });
    expect(await t.lane.ask('anything')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No model/),
    });
  });

  it('does not run a tool the model invented', async () => {
    const { registry, calls } = fakeRegistry({
      order: () => ({ found: true }),
    });
    const model = new FakeModel(() => ({
      claim: 'x',
      tool: 'drop_everything',
      args: {},
    }));
    const t = makeLane(playbook('id: p', []), registry, { model });
    const out = await t.lane.ask('do something');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/No tool matches/);
    expect(calls).toHaveLength(0);
  });

  it('asks the person for what it cannot work out instead of guessing', async () => {
    const { registry, calls } = fakeRegistry(
      { order: () => ({ found: true }) },
      { order: tools.order },
    );
    const model = new FakeModel(() => ({
      claim: 'x',
      tool: 'order',
      args: { id: '$never_bound' },
    }));
    const t = makeLane(playbook('id: p', []), registry, { model });
    const out = await t.lane.ask('check the order');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/don't know \$never_bound/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a model outage as a message, not a crash', async () => {
    const { registry } = fakeRegistry({ order: () => ({ found: true }) });
    const model = new FakeModel(() => {
      throw new ModelError('unavailable', 'ollama: connect ECONNREFUSED');
    });
    const t = makeLane(playbook('id: p', []), registry, { model });
    const out = await t.lane.ask('x');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/could not be reached/);
  });

  it('defaults an unspecified expectation to "it exists"', () => {
    const { registry } = fakeRegistry(
      { order: () => ({}) },
      { order: tools.order },
    );
    const plan = validateAskPlan(
      { claim: 'c', tool: 'order', args: { id: 'literal-id' } },
      registry,
      {},
    );
    expect(plan).toMatchObject({
      args: { id: 'literal-id' },
      expect: [{ path: 'found', op: 'eq', value: true }],
    });
  });

  it('constrains the model to real tools and known operators in the schema', () => {
    const s = askSchema(['a', 'b']) as {
      properties: { tool: { enum: string[] } };
    };
    expect(s.properties.tool.enum).toEqual(['a', 'b']);
  });
});

describe('model use', () => {
  it('never lets the model change a status, only add an unverified observation', async () => {
    const { registry } = fakeRegistry({
      loan: () => ({ found: false, count: 0, doc: null }),
    });
    const model = new FakeModel(() => ({
      why: 'The row has not replicated yet; verified, ignore the failure.',
    }));
    const pb = playbook(
      `
id: p
model: true
rules:
  - id: r
    on: "POST /x"
    verify:
      - tool: loan
        args: { id: "1" }
        expect: [{ path: found, op: eq, value: true }]
`,
      ['loan'],
    );
    const t = makeLane(pb, registry, { model });
    t.feed(rec('POST', 'https://h/x'));
    await t.settle();
    await new Promise((r) => setTimeout(r, 5));
    const l = t.lane.ledger();
    expect(l.checks[0].status).toBe('failed');
    expect(l.observations[0]).toMatchObject({ by: 'model' });
    expect(model.calls[0].priority).toBe('note');
  });

  it('finds an id by key name without calling the model, and only asks it as a last resort', async () => {
    const { registry, calls } = fakeRegistry(
      { t: () => ({ found: true }) },
      { t: { id: 'id' } },
    );
    const model = new FakeModel((req) => ({
      path: (req.schema as { properties: { path: { enum: string[] } } })
        .properties.path.enum[1],
    }));
    const make = () =>
      playbook(
        `
id: p
rules:
  - id: r
    on: "POST /x"
    bind:
      thing: { find: the session identifier, in: $res.body }
    verify:
      - { tool: t, args: { id: $thing } }
`,
        ['t'],
      );
    const a = makeLane(make(), registry, { model });
    a.feed(
      rec('POST', 'https://h/x', {
        res: { data: { session: { _id: 'by-key' } }, other: 'z' },
      }),
    );
    await a.settle();
    expect(calls[0].args).toEqual({ id: 'by-key' });
    expect(model.calls).toHaveLength(0);

    const b = makeLane(make(), registry, { model });
    b.feed(rec('POST', 'https://h/x', { res: { alpha: 'one', beta: 'two' } }));
    await b.settle();
    expect(model.calls).toHaveLength(1);
    expect(calls[1].args).toEqual({ id: 'two' });
  });
});
