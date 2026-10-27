/**
 * Runs the shipped playbook through the real Mongo provider against a real
 * MongoDB. Opt-in, because it needs one:
 *
 *   docker run --rm -d --name agent-e2e-mongo -p 127.0.0.1:27099:27017 mongo:5.0
 *   AGENT_E2E_MONGO_URI=mongodb://127.0.0.1:27099/ yarn workspace @rrweb/agent-backend test mongo.e2e
 *
 * It seeds its own database and never reads the credentials file.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { SessionRuntime } from '../src/session.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { net, T0 } from './helpers.ts';

const URI = process.env.AGENT_E2E_MONGO_URI;
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const DB = `agent_e2e_${Date.now()}`;

describe.skipIf(!URI)('the LMS playbook against a real MongoDB', () => {
  let client: MongoClient;
  let registry: ToolRegistry;
  let playbooks: ReturnType<typeof loadConfig>['playbooks'];
  const loanId = new ObjectId();
  const milestoneNew = new ObjectId();
  const condId = new ObjectId();
  const noteId = new ObjectId();
  const formId = new ObjectId();
  const L = loanId.toHexString();
  const API = `https://h/lms/api/user/v1/loan-application/${L}`;

  beforeAll(async () => {
    client = await new MongoClient(URI!).connect();
    const db = client.db(DB);
    await db.collection('loan_applications').insertOne({
      _id: loanId,
      loan_application_number: 'L-100',
      loan_milestone_id: milestoneNew,
      folder_id: 'f1',
      active: true,
      // embedded conditions, as the LMS stores them
      conditions: [
        {
          _id: condId,
          title: 'Proof of income',
          status: 'WAIVED',
          secret_token: 'must-not-leak',
        },
      ],
      created_at: new Date(),
    });
    await db.collection('loan_application_milestones').insertMany([
      { loan_application_id: loanId, milestone_id: new ObjectId() },
      { loan_application_id: loanId, milestone_id: milestoneNew },
    ]);
    await db.collection('loan_fields_data').insertOne({
      loan_id: loanId,
      fields_data: { fa: { value: 10 }, fb: { value: 'hello' } },
      updated_at: new Date(),
    });
    await db.collection('notes').insertMany([
      {
        _id: noteId,
        loan_id: loanId,
        note: 'Please send the form',
        condition_id: condId,
        is_system_generated: false,
        created_at: new Date(),
      },
      {
        loan_id: loanId,
        note: 'Condition waived',
        condition_id: condId,
        is_system_generated: true,
        created_at: new Date(Date.now() + 1),
      },
    ]);
    // event_trail stores the loan as a string in this fixture: the tool must match either form
    await db
      .collection('event_trail')
      .insertOne({
        loan_application_id: L,
        event_type: 'CONDITION_WAIVED',
        created_at: new Date(),
      });
    await db
      .collection('forms')
      .insertOne({ _id: formId, label: 'Main form', active: true });
    await db
      .collection('profiles')
      .insertOne({ _id: new ObjectId(), data: { ssn: '123-45-6789' } });

    // The shipped sources.yaml, pointed at the throwaway server instead of the credentials file.
    const dir = mkdtempSync(join(tmpdir(), 'agent-e2e-'));
    mkdirSync(join(dir, 'playbooks'));
    copyFileSync(
      join(root, 'config/lms/playbooks/lms-writes.md'),
      join(dir, 'playbooks/lms-writes.md'),
    );
    const yaml = readFileSync(
      join(root, 'config/lms/sources.yaml'),
      'utf8',
    ).replace(
      'envFile: ~/projects/.env.mongo',
      `uri: ${URI}\n    database: ${DB}`,
    );
    writeFileSync(join(dir, 'sources.yaml'), yaml);
    const config = loadConfig(dir);
    playbooks = config.playbooks;
    registry = new ToolRegistry(config, {});
  });

  afterAll(async () => {
    await client?.db(DB).dropDatabase();
    await client?.close();
    await registry?.close();
  });

  async function run(calls: ReturnType<typeof net>[]) {
    let clock = T0;
    const s = new SessionRuntime({
      sessionId: 'e2e',
      startedAt: T0,
      pageOrigin: '',
      playbooks,
      registry,
      model: null,
      reference: '',
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    for (const c of calls) {
      clock = Math.max(clock, c.endTime ?? 0);
      s.ingest({ kind: 'network', t: c.endTime ?? 0, payload: c });
      await new Promise((r) => setTimeout(r, 5));
    }
    const out = await s.stop(clock + 100);
    return out.ledger.lanes[0].checks;
  }

  it('is reachable', async () => {
    const h = await registry.health();
    expect(h.devlms).toMatchObject({ ready: true });
  });

  it('verifies a loan creation by the _id the API returned (ObjectId in the database, string on the wire)', async () => {
    const checks = await run([
      net('POST', 'https://h/lms/api/v1/loan-application', {
        status: 201,
        res: { _id: L, loan_application_number: 'L-100' },
        req: { folder_id: 'f1' },
      }),
    ]);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['loan-create#1.row', 'verified'],
      ['loan-create#1.milestones', 'verified'],
    ]);
    expect(checks[0].note).toBe('Loan L-100 is in the database');
    expect(checks[1].note).toBe('2 milestone rows written for the loan');
  });

  it('catches a loan number that does not match what the API said', async () => {
    const checks = await run([
      net('POST', 'https://h/lms/api/v1/loan-application', {
        status: 201,
        res: { _id: L, loan_application_number: 'L-999' },
      }),
    ]);
    expect(checks[0].status).toBe('failed');
    expect(checks[0].note).toMatch(
      /doc\.loan_application_number eq "L-999" — got "L-100"/,
    );
  });

  it('reports a loan that was never written as failed, not as passed', async () => {
    const checks = await run([
      net('POST', 'https://h/lms/api/v1/loan-application', {
        status: 201,
        res: {
          _id: new ObjectId().toHexString(),
          loan_application_number: 'L-1',
        },
      }),
    ]);
    expect(checks[0].status).toBe('failed');
    expect(checks[0].evidence.some((e) => e.kind === 'timeout')).toBe(true);
  });

  it('checks every field a PATCH changed against loan_fields_data', async () => {
    const good = await run([
      net('PATCH', `${API}/data`, {
        req: { fa: { value: 10 }, fb: { value: 'hello' } },
      }),
    ]);
    expect(good[0].status).toBe('verified');
    const stale = await run([
      net('PATCH', `${API}/data`, {
        req: { fa: { value: 10 }, fb: { value: 'changed in UI' } },
      }),
    ]);
    expect(stale[0].status).toBe('failed');
    expect(stale[0].note).toMatch(/1 differ: fb/);
  });

  it('checks the milestone a PUT moved the loan to', async () => {
    const ok = await run([
      net('PUT', `${API}/move-to-milestone`, {
        req: { next_milestone_id: milestoneNew.toHexString() },
      }),
    ]);
    expect(ok[0]).toMatchObject({
      id: 'loan-milestone-move#1.loan',
      status: 'verified',
    });
    const wrong = await run([
      net('PUT', `${API}/move-to-milestone`, {
        req: { next_milestone_id: new ObjectId().toHexString() },
      }),
    ]);
    expect(wrong[0].status).toBe('failed');
  });

  it('finds a waived condition inside the embedded conditions array, plus its system note and event', async () => {
    const checks = await run([
      net('POST', `${API}/conditions/${condId.toHexString()}/waive`, {
        res: { status: 'WAIVED' },
        req: { note: 'ok' },
      }),
    ]);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['condition-waive#1.state', 'verified'],
      ['condition-waive#1.note', 'verified'],
      ['condition-waive#1.event', 'verified'],
    ]);
  });

  it('verifies a condition note by its returned id and text', async () => {
    const checks = await run([
      net('POST', `${API}/conditions/${condId.toHexString()}/notes`, {
        status: 201,
        req: { text: 'Please send the form' },
        res: { _id: noteId.toHexString() },
      }),
    ]);
    expect(checks[0]).toMatchObject({ status: 'verified' });
  });

  it('verifies a form save by id and label', async () => {
    const checks = await run([
      net('PUT', `https://h/lms/api/v2/forms/${formId.toHexString()}`, {
        req: { label: 'Main form' },
        res: {},
      }),
    ]);
    expect(checks[0].status).toBe('verified');
  });

  it('never lets a sensitive-looking field or a denied collection reach the ledger', async () => {
    const checks = await run([
      net('POST', `${API}/conditions/create`, {
        status: 201,
        req: { title: 'Proof of income' },
        res: [],
      }),
    ]);
    const text = JSON.stringify(checks);
    expect(checks[0].status).toBe('verified');
    expect(text).not.toContain('must-not-leak');
    expect(registry.invalid.size).toBe(0);
    // profiles is denied for the source, so no tool can be declared against it
    const res = await registry.run(
      'loan_application',
      { id: L },
      { requests: [] },
    );
    expect(res.ok && JSON.stringify(res.run.value)).not.toContain(
      '123-45-6789',
    );
  });

  it('only ever reads: the database is unchanged after every run above', async () => {
    const db = client.db(DB);
    expect(await db.collection('loan_applications').countDocuments()).toBe(1);
    expect(await db.collection('notes').countDocuments()).toBe(2);
    expect(
      await db.collection('loan_fields_data').findOne({ loan_id: loanId }),
    ).toMatchObject({ fields_data: { fb: { value: 'hello' } } });
  });
});
