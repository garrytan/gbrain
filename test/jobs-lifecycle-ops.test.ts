/**
 * C1 — behavioral lifecycle suite for the queue-row jobs (Minions) ops in
 * src/core/ops/jobs.ts: cancel_job, retry_job, pause_job, resume_job,
 * replay_job, get_job_progress, send_job_message (local arm only, light).
 *
 * For each op this pins three things against a real PGLite queue:
 *   1. the dry-run posture — every mutating lifecycle op short-circuits with
 *      its declared `{ dry_run: true, action, id }` envelope and mutates
 *      NOTHING. pause_job/resume_job originally lacked the short-circuit (a
 *      dry-run call still flipped the row) — fixed as this suite's test+fix
 *      pair. get_job_progress is a pure read and returns its normal result
 *      under dryRun.
 *   2. the real queue-row transition, as MinionQueue actually implements it:
 *        cancel:  waiting|active|delayed|waiting-children|paused → cancelled
 *                 (lock cleared, finished_at stamped)
 *        retry:   failed|dead → waiting with the full #2783 "run this fresh"
 *                 reset (attempts_made/attempts_started/stalled_counter → 0,
 *                 error_text/started_at/finished_at/lock → NULL)
 *        pause:   waiting|active|delayed → paused (lock cleared)
 *        resume:  paused → waiting
 *        replay:  completed|failed|dead source → a NEW waiting row via
 *                 queue.add (source row untouched; 'cancelled' is terminal
 *                 but deliberately NOT replayable); envelope's `source_id`
 *                 is the SOURCE JOB id, not a brain source
 *        progress: read of the token-fenced updateProgress channel
 *   3. incompatible-status refusals → OperationError('invalid_params'),
 *      message pinned loosely (code + substring).
 *
 * Deliberately NOT duplicated here:
 *   - private_queue_owner_token redaction → test/jobs-ops-token-redaction.test.ts
 *   - send_job_message remote sender fence, local sender identity, and its
 *     terminal-status refusal → test/jobs-sidechannel-fence.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError, type Operation } from '../src/core/ops/contract.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { _resetAdmissionCacheForTest } from '../src/core/minions/admission.ts';

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
  // resetPgliteState truncates config; MinionQueue's ensureSchema (replay_job
  // routes through queue.add) reads the schema version from it — same re-seed
  // as test/jobs-ops-token-redaction.test.ts.
  await engine.setConfig('version', '85');
  // Admission policy cache is module-global; another file in this shard
  // process may have cached a per-name policy. Reset so replay's queue.add
  // sees the defaults.
  _resetAdmissionCacheForTest();
});

const cancel_job = operationsByName['cancel_job'];
const retry_job = operationsByName['retry_job'];
const pause_job = operationsByName['pause_job'];
const resume_job = operationsByName['resume_job'];
const replay_job = operationsByName['replay_job'];
const get_job_progress = operationsByName['get_job_progress'];
const send_job_message = operationsByName['send_job_message'];

/** Ctx factory — same shape as test/operations-source-isolation-matrix.test.ts
 *  (sourceId is REQUIRED on OperationContext). Local/trusted by default: this
 *  file pins the local arm; remote fences live in the sidechannel-fence file. */
function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: false,
    transport: 'stdio',
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}
const dryCtx = () => ctxOf({ dryRun: true });

/** Direct SQL seed (columns beyond these fall back to schema defaults). */
async function seedJob(opts: {
  status: string;
  name?: string;
  data?: Record<string, unknown>;
  lockToken?: string;
  errorText?: string;
  attemptsMade?: number;
  attemptsStarted?: number;
  stalledCounter?: number;
  priority?: number;
  maxAttempts?: number;
  /** Stamp started_at + finished_at = now() (terminal-status realism). */
  withTimestamps?: boolean;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs
       (name, queue, status, data, priority, max_attempts,
        lock_token, lock_until, error_text,
        attempts_made, attempts_started, stalled_counter,
        started_at, finished_at)
     VALUES ($1, 'default', $2, $3::jsonb, $4, $5,
             $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() + interval '5 minutes' END,
             $7, $8, $9, $10,
             CASE WHEN $11::boolean THEN now() ELSE NULL END,
             CASE WHEN $11::boolean THEN now() ELSE NULL END)
     RETURNING id`,
    [
      opts.name ?? 'embed',
      opts.status,
      opts.data ?? {},
      opts.priority ?? 0,
      opts.maxAttempts ?? 3,
      opts.lockToken ?? null,
      opts.errorText ?? null,
      opts.attemptsMade ?? 0,
      opts.attemptsStarted ?? 0,
      opts.stalledCounter ?? 0,
      opts.withTimestamps ?? false,
    ],
  );
  return Number(rows[0].id);
}

async function row(id: number): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM minion_jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function jobCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM minion_jobs`,
  );
  return Number(rows[0].n);
}

function asData(v: unknown): Record<string, unknown> {
  return (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
}

async function expectOpError(
  op: Operation,
  ctx: OperationContext,
  params: Record<string, unknown>,
  code: string,
  substring: string,
): Promise<void> {
  try {
    await op.handler(ctx, params);
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    const err = e as OperationError;
    expect(err.code).toBe(code);
    expect(err.message).toContain(substring);
    return;
  }
  throw new Error(`expected ${op.name} to throw OperationError('${code}'), but it resolved`);
}

// ---------------------------------------------------------------------------
// cancel_job
// ---------------------------------------------------------------------------

describe('cancel_job — lifecycle', () => {
  it('dry-run short-circuits with the declared envelope and mutates nothing', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = await cancel_job.handler(dryCtx(), { id });
    expect(res).toEqual({ dry_run: true, action: 'cancel_job', id });
    const r = await row(id);
    expect(r.status).toBe('waiting');
    expect(r.finished_at).toBeNull();
  });

  it('waiting → cancelled: lock cleared, finished_at stamped, envelope carries the cancelled row', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = (await cancel_job.handler(ctxOf(), { id })) as Record<string, unknown>;
    expect(res.id).toBe(id);
    expect(res.status).toBe('cancelled');
    const r = await row(id);
    expect(r.status).toBe('cancelled');
    expect(r.lock_token).toBeNull();
    expect(r.finished_at).not.toBeNull();
  });

  it('active → cancelled: the held lock is NULLed so the worker\'s renewLock fence fires', async () => {
    const id = await seedJob({ status: 'active', lockToken: 'tok-cancel-active' });
    const res = (await cancel_job.handler(ctxOf(), { id })) as Record<string, unknown>;
    expect(res.status).toBe('cancelled');
    const r = await row(id);
    expect(r.status).toBe('cancelled');
    expect(r.lock_token).toBeNull();
    expect(r.lock_until).toBeNull();
  });

  it('terminal statuses refuse: completed and already-cancelled → invalid_params', async () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const id = await seedJob({ status, withTimestamps: true });
      await expectOpError(cancel_job, ctxOf(), { id }, 'invalid_params', 'Cannot cancel job');
      expect((await row(id)).status).toBe(status); // refusal mutates nothing
    }
  });
});

// ---------------------------------------------------------------------------
// retry_job
// ---------------------------------------------------------------------------

describe('retry_job — lifecycle', () => {
  it('dry-run short-circuits with the declared envelope and mutates nothing', async () => {
    const id = await seedJob({ status: 'failed', errorText: 'boom', withTimestamps: true });
    const res = await retry_job.handler(dryCtx(), { id });
    expect(res).toEqual({ dry_run: true, action: 'retry_job', id });
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.error_text).toBe('boom');
  });

  it('failed → waiting with the full #2783 fresh-run reset (attempts, stall budget, timestamps, error)', async () => {
    const id = await seedJob({
      status: 'failed',
      errorText: 'handler exploded',
      attemptsMade: 2,
      attemptsStarted: 2,
      stalledCounter: 1,
      withTimestamps: true,
    });
    const res = (await retry_job.handler(ctxOf(), { id })) as Record<string, unknown>;
    expect(res.id).toBe(id);
    expect(res.status).toBe('waiting');
    expect(res.attempts_made).toBe(0);
    const r = await row(id);
    expect(r.status).toBe('waiting');
    expect(Number(r.attempts_made)).toBe(0);
    expect(Number(r.attempts_started)).toBe(0);
    expect(Number(r.stalled_counter)).toBe(0);
    expect(r.error_text).toBeNull();
    expect(r.started_at).toBeNull();
    expect(r.finished_at).toBeNull();
    expect(r.lock_token).toBeNull();
    expect(r.delay_until).toBeNull();
  });

  it('dead → waiting (the other retryable status)', async () => {
    const id = await seedJob({ status: 'dead', errorText: 'timed out', withTimestamps: true });
    const res = (await retry_job.handler(ctxOf(), { id })) as Record<string, unknown>;
    expect(res.status).toBe('waiting');
    expect((await row(id)).status).toBe('waiting');
  });

  it('non-retryable statuses refuse: waiting and completed → invalid_params', async () => {
    for (const status of ['waiting', 'completed'] as const) {
      const id = await seedJob({ status });
      await expectOpError(retry_job, ctxOf(), { id }, 'invalid_params', 'must be failed or dead');
      expect((await row(id)).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// pause_job
// ---------------------------------------------------------------------------

describe('pause_job — lifecycle', () => {
  // C1 test+fix pair: the original suite pinned a divergence here (no
  // dryRun short-circuit, no mutating flag — a dry-run call still paused the
  // row). The handler now follows the mutating-op convention.
  it('ctx.dryRun short-circuits with the declared envelope and mutates NOTHING', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = (await pause_job.handler(dryCtx(), { id })) as Record<string, unknown>;
    expect(res).toEqual({ dry_run: true, action: 'pause_job', id });
    expect((await row(id)).status).toBe('waiting');
  });

  it('waiting → paused; envelope is exactly { id, status }', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = await pause_job.handler(ctxOf(), { id });
    expect(res).toEqual({ id, status: 'paused' });
    expect((await row(id)).status).toBe('paused');
  });

  it('active → paused: the held lock is cleared so the worker aborts gracefully', async () => {
    const id = await seedJob({ status: 'active', lockToken: 'tok-pause-active' });
    const res = await pause_job.handler(ctxOf(), { id });
    expect(res).toEqual({ id, status: 'paused' });
    const r = await row(id);
    expect(r.lock_token).toBeNull();
    expect(r.lock_until).toBeNull();
  });

  it('unpausable statuses refuse: completed and already-paused → invalid_params', async () => {
    for (const status of ['completed', 'paused'] as const) {
      const id = await seedJob({ status });
      await expectOpError(pause_job, ctxOf(), { id }, 'invalid_params', 'not pausable');
      expect((await row(id)).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// resume_job
// ---------------------------------------------------------------------------

describe('resume_job — lifecycle', () => {
  // C1 test+fix pair: same fix as pause_job — dryRun now short-circuits.
  it('ctx.dryRun short-circuits with the declared envelope and mutates NOTHING', async () => {
    const id = await seedJob({ status: 'paused' });
    const res = (await resume_job.handler(dryCtx(), { id })) as Record<string, unknown>;
    expect(res).toEqual({ dry_run: true, action: 'resume_job', id });
    expect((await row(id)).status).toBe('paused');
  });

  it('paused → waiting; envelope is exactly { id, status }', async () => {
    const id = await seedJob({ status: 'paused' });
    const res = await resume_job.handler(ctxOf(), { id });
    expect(res).toEqual({ id, status: 'waiting' });
    expect((await row(id)).status).toBe('waiting');
  });

  it('only paused resumes: waiting and completed → invalid_params', async () => {
    for (const status of ['waiting', 'completed'] as const) {
      const id = await seedJob({ status });
      await expectOpError(resume_job, ctxOf(), { id }, 'invalid_params', 'not paused');
      expect((await row(id)).status).toBe(status);
    }
  });
});

// ---------------------------------------------------------------------------
// replay_job
// ---------------------------------------------------------------------------

describe('replay_job — lifecycle', () => {
  it('dry-run short-circuits with the declared envelope; no new row is created', async () => {
    const id = await seedJob({ status: 'completed', withTimestamps: true });
    const before = await jobCount();
    const res = await replay_job.handler(dryCtx(), { id });
    expect(res).toEqual({ dry_run: true, action: 'replay_job', id });
    expect(await jobCount()).toBe(before);
  });

  it('completed → a NEW waiting row via queue.add; source row untouched; envelope source_id = SOURCE JOB id', async () => {
    const origId = await seedJob({
      status: 'completed',
      data: { k: 'orig', n: 1 },
      priority: 5,
      maxAttempts: 7,
      withTimestamps: true,
    });
    const res = (await replay_job.handler(ctxOf(), { id: origId })) as Record<string, unknown>;
    // Envelope: { id: <new>, name, status, source_id: <original job id> }.
    // NOTE: `source_id` here is the numeric SOURCE JOB id (an overloaded name
    // — nothing to do with brain source routing).
    expect(res.source_id).toBe(origId);
    expect(res.name).toBe('embed');
    expect(res.status).toBe('waiting');
    const newId = res.id as number;
    expect(newId).not.toBe(origId);

    // The replay inherits name/queue/priority/max_attempts + data.
    const clone = await row(newId);
    expect(clone.status).toBe('waiting');
    expect(clone.queue).toBe('default');
    expect(Number(clone.priority)).toBe(5);
    expect(Number(clone.max_attempts)).toBe(7);
    expect(asData(clone.data)).toEqual({ k: 'orig', n: 1 });

    // Replay NEVER mutates the source row.
    const orig = await row(origId);
    expect(orig.status).toBe('completed');
    expect(orig.finished_at).not.toBeNull();
  });

  it('data_overrides merge over the source data (shallow spread)', async () => {
    const origId = await seedJob({
      status: 'failed',
      data: { k: 'orig', n: 1 },
      withTimestamps: true,
    });
    const res = (await replay_job.handler(ctxOf(), {
      id: origId,
      data_overrides: { n: 2, extra: 'x' },
    })) as Record<string, unknown>;
    const clone = await row(res.id as number);
    expect(asData(clone.data)).toEqual({ k: 'orig', n: 2, extra: 'x' });
    // Source data is untouched by the merge.
    expect(asData((await row(origId)).data)).toEqual({ k: 'orig', n: 1 });
  });

  it('non-replayable statuses refuse — including cancelled, which is terminal but deliberately outside the completed/failed/dead replay set', async () => {
    for (const status of ['waiting', 'cancelled'] as const) {
      const id = await seedJob({ status });
      const before = await jobCount();
      await expectOpError(replay_job, ctxOf(), { id }, 'invalid_params', 'not in terminal state');
      expect(await jobCount()).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------
// get_job_progress
// ---------------------------------------------------------------------------

describe('get_job_progress — lifecycle', () => {
  it('round-trips progress written through the real token-fenced updateProgress channel', async () => {
    const id = await seedJob({ status: 'active', lockToken: 'tok-progress' });
    const queue = new MinionQueue(engine);
    const progress = { phase: 'embed.batch', done: 3, total: 10 };
    expect(await queue.updateProgress(id, 'tok-progress', progress)).toBe(true);

    const res = await get_job_progress.handler(ctxOf(), { id });
    expect(res).toEqual({ id, name: 'embed', status: 'active', progress });
  });

  it('a job that never reported progress returns progress: null', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = await get_job_progress.handler(ctxOf(), { id });
    expect(res).toEqual({ id, name: 'embed', status: 'waiting', progress: null });
  });

  // REALITY: get_job_progress is a pure read with no dryRun branch — a
  // dry-run context returns the normal read result, not a dry_run envelope.
  it('REALITY: ctx.dryRun returns the normal read (no dry_run marker)', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = (await get_job_progress.handler(dryCtx(), { id })) as Record<string, unknown>;
    expect(res.dry_run).toBeUndefined();
    expect(res.id).toBe(id);
  });

  it('unknown id → invalid_params "Job not found"', async () => {
    await expectOpError(get_job_progress, ctxOf(), { id: 999_999 }, 'invalid_params', 'Job not found');
  });
});

// ---------------------------------------------------------------------------
// send_job_message — LOCAL arm only, light. The remote sender fence, local
// sender identity persistence, and terminal-status refusals are pinned in
// test/jobs-sidechannel-fence.test.ts; queue-level sender auth in
// test/minions.test.ts. Not duplicated here.
// ---------------------------------------------------------------------------

describe('send_job_message — lifecycle (local arm, light)', () => {
  it('dry-run short-circuits with the declared envelope; the inbox stays EMPTY', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = await send_job_message.handler(dryCtx(), { id, payload: { directive: 'noop' } });
    expect(res).toEqual({ dry_run: true, action: 'send_job_message', id });
    const inbox = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_inbox WHERE job_id = $1`,
      [id],
    );
    expect(inbox.length).toBe(0);
  });

  it('local send to a messageable job → { sent: true, message_id, job_id } and one persisted inbox row', async () => {
    const id = await seedJob({ status: 'waiting' });
    const res = (await send_job_message.handler(ctxOf(), {
      id,
      payload: { directive: 'wrap-up' },
    })) as Record<string, unknown>;
    expect(res.sent).toBe(true);
    expect(typeof res.message_id).toBe('number');
    expect(res.job_id).toBe(id);
    const inbox = await engine.executeRaw<{ payload: unknown }>(
      `SELECT payload FROM minion_inbox WHERE job_id = $1`,
      [id],
    );
    expect(inbox.length).toBe(1);
    expect(asData(inbox[0].payload)).toEqual({ directive: 'wrap-up' });
  });
});
