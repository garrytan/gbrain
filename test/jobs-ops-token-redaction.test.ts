/**
 * private_queue_owner_token redaction across the jobs MCP op envelopes
 * (src/core/ops/jobs.ts). The token is a capability credential (lease
 * renewal / queue attach), not job data — get_job, list_jobs, and submit_job
 * must replace a present token with the literal '[redacted]' and pass a
 * missing one through as null (NEVER the string '[redacted]').
 *
 * submit_job cannot mint a token through its declared params; the path that
 * returns one is the param-coalesce hit onto an existing token-bearing
 * waiting row (MinionQueue.add hydrates the FULL row, token included), so
 * that is the shape this file exercises for the submit surface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName } from '../src/core/operations.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { _resetAdmissionCacheForTest } from '../src/core/minions/admission.ts';
import { idTakingJobsOps } from './helpers/ops-registry.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates config; MinionQueue.add's ensureSchema reads
  // the schema version from it (same re-seed as submit-queue-state.test.ts).
  await engine.setConfig('version', '85');
});

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const RAW_TOKEN = 'raw-owner-capability-token-5f3a9c81d2e4';

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Direct SQL seed: a waiting private-queue job carrying the raw token. */
async function seedPrivateJob(queue: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data, private_queue_owner_token, private_queue_lease_until)
     VALUES ('subagent', $1, 'waiting', '{}'::jsonb, $2, now() + interval '10 minutes')
     RETURNING id`,
    [queue, RAW_TOKEN],
  );
  return Number(rows[0].id);
}

async function seedPlainJob(): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data)
     VALUES ('embed', 'default', 'waiting', '{}'::jsonb)
     RETURNING id`,
  );
  return Number(rows[0].id);
}

describe('get_job — owner-token redaction', () => {
  it('redacts a present token and never leaks the raw value anywhere in the envelope', async () => {
    const id = await seedPrivateJob('dream-inline-1700000000000-cafe0001');
    const res = await dispatchToolCall(engine, 'get_job', { id }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.private_queue_owner_token).toBe('[redacted]');
    // The raw capability must be absent from the WHOLE serialized response,
    // not just the one field.
    expect(res.content[0].text).not.toContain(RAW_TOKEN);
  });

  it('null passthrough: a plain job reports null, not the string [redacted]', async () => {
    const id = await seedPlainJob();
    const res = await dispatchToolCall(engine, 'get_job', { id }, { ...STDIO });
    const body = parsed(res);
    expect(body.private_queue_owner_token).toBeNull();
    expect(body.private_queue_owner_token).not.toBe('[redacted]');
  });
});

describe('list_jobs — owner-token redaction', () => {
  it('redacts EVERY returned private-queue job; plain jobs stay null', async () => {
    await seedPrivateJob('dream-inline-1700000000000-cafe0002');
    await seedPrivateJob('dream-inline-1700000000000-cafe0003');
    const plainId = await seedPlainJob();
    const res = await dispatchToolCall(engine, 'list_jobs', { limit: 100 }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res) as Array<{ id: number; queue: string; private_queue_owner_token: string | null }>;
    const privateJobs = body.filter(j => j.queue.startsWith('dream-inline-'));
    expect(privateJobs.length).toBe(2);
    for (const j of privateJobs) expect(j.private_queue_owner_token).toBe('[redacted]');
    const plain = body.find(j => j.id === plainId);
    expect(plain?.private_queue_owner_token).toBeNull();
    expect(res.content[0].text).not.toContain(RAW_TOKEN);
  });
});

describe('submit_job — owner-token redaction', () => {
  const submit_job = operationsByName['submit_job'];

  function localCtx(): any {
    return { engine, config: {}, logger: console, dryRun: false, remote: false };
  }

  it('a coalesce hit onto a token-bearing waiting row returns [redacted], never the raw token', async () => {
    // Force a re-resolve so a policy another file cached for 'subagent'
    // cannot mask the default-on param coalescing this test depends on.
    _resetAdmissionCacheForTest();
    const queueName = 'dream-inline-1700000000000-cafe0004';
    const q = new MinionQueue(engine);
    // Seed through add() so __param_hash is stamped identically to what the
    // op handler's add() computes (opts identity: priority 0, max_attempts 3).
    const seeded = await q.add(
      'subagent',
      { prompt: 'coalesce-me' },
      { queue: queueName, priority: 0, max_attempts: 3, private_queue_owner_token: RAW_TOKEN },
      { allowProtectedSubmit: true },
    );
    // The queue layer itself hands back the raw token — redaction is the
    // op envelope's job, which is exactly what this test pins.
    expect(seeded.private_queue_owner_token).toBe(RAW_TOKEN);

    const result = (await submit_job.handler(localCtx(), {
      name: 'subagent',
      data: { prompt: 'coalesce-me' },
      queue: queueName,
    })) as Record<string, unknown>;
    expect(result.coalesced).toBe(true); // proves the token-bearing row was returned, not a fresh insert
    expect(result.private_queue_owner_token).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain(RAW_TOKEN);
  });

  it('null passthrough: a fresh tokenless submission reports null, not the string [redacted]', async () => {
    const res = await dispatchToolCall(engine, 'submit_job', { name: 'embed' }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.id).toBeGreaterThan(0);
    expect(body.private_queue_owner_token).toBeNull();
    expect(body.private_queue_owner_token).not.toBe('[redacted]');
  });
});

/** A2 (test-gap wave 1): status-variant seeder for the cancel/retry pair. */
async function seedPrivateJobWithStatus(status: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data, private_queue_owner_token, private_queue_lease_until)
     VALUES ('subagent', 'dream-inline-1700000000000-cafe0002', $1, '{}'::jsonb, $2, now() + interval '10 minutes')
     RETURNING id`,
    [status, RAW_TOKEN],
  );
  return Number(rows[0].id);
}

describe('cancel_job / retry_job — owner-token redaction (A2)', () => {
  it('cancel_job redacts a present token across the whole envelope', async () => {
    const id = await seedPrivateJobWithStatus('waiting');
    const res = await dispatchToolCall(engine, 'cancel_job', { id }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    expect(parsed(res).private_queue_owner_token).toBe('[redacted]');
    expect(res.content[0].text).not.toContain(RAW_TOKEN);
  });

  it('retry_job redacts a present token across the whole envelope', async () => {
    const id = await seedPrivateJobWithStatus('failed');
    const res = await dispatchToolCall(engine, 'retry_job', { id }, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    expect(parsed(res).private_queue_owner_token).toBe('[redacted]');
    expect(res.content[0].text).not.toContain(RAW_TOKEN);
  });

  it('null passthrough on both ops: tokenless jobs report null, never the string [redacted]', async () => {
    const waiting = await seedPlainJob();
    const cancelRes = await dispatchToolCall(engine, 'cancel_job', { id: waiting }, { ...STDIO });
    expect(parsed(cancelRes).private_queue_owner_token).toBeNull();
    const failedRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, queue, status, data) VALUES ('embed', 'default', 'failed', '{}'::jsonb) RETURNING id`,
    );
    const retryRes = await dispatchToolCall(engine, 'retry_job', { id: Number(failedRows[0].id) }, { ...STDIO });
    expect(parsed(retryRes).private_queue_owner_token).toBeNull();
  });
});

describe('registry sweep ratchet — no jobs op envelope may carry the raw token', () => {
  it('every id-taking jobs op, against waiting AND failed token-bearing jobs, never leaks', async () => {
    const idOps = idTakingJobsOps();
    // The ratchet's teeth: if a new id-taking jobs op lands, it is swept
    // automatically — an unredacted return shows up here, not in prod.
    expect(idOps.length).toBeGreaterThanOrEqual(6);
    for (const status of ['waiting', 'failed'] as const) {
      for (const op of idOps) {
        const id = await seedPrivateJobWithStatus(status);
        const args: Record<string, unknown> = { id };
        if ((op.params as Record<string, unknown>).message) args.message = 'sweep-probe';
        // Success OR error envelope — the raw capability must appear in neither.
        const res = await dispatchToolCall(engine, op.name, args, { ...STDIO });
        expect(res.content[0].text).not.toContain(RAW_TOKEN);
      }
    }
  });
});
