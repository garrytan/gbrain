/**
 * GST-3452: doctor sync_freshness on a source with no successful sync yet,
 * where the last run is not a failure:
 *
 *  - a connector run that stopped only on a provider usage or rate limit
 *    (`stopped_on: usage_limit`, nothing failed) inside the freshness window
 *    is WARN (`sync_usage_limited`, fix `next: wait`);
 *  - a sync job that is still running (active, live job lock) but holds no
 *    sync lock at the moment is WARN (`sync_first_run_in_progress`);
 *  - the same records past the window, a partial run that failed items, and a
 *    job whose lock expired stay FAIL (`sync_no_successful_sync`).
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';
import { cliRenderContext, renderAction, type Action } from '../src/core/agent-output.ts';
import { CODES } from '../src/core/error-registry.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw("DELETE FROM minion_jobs WHERE name = 'sync'");
});

async function addSource(id: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, last_sync_at, chunker_version, config)
     VALUES ($1, $1, $2, NULL, $3, '{"federated":true}'::jsonb)`,
    [id, `/tmp/${id}`, chunkerStamp()],
  );
}

async function addSyncJob(sourceId: string, status: string, result: Record<string, unknown> | null,
  opts: { finishedHoursAgo?: number; lockMinutes?: number } = {}): Promise<number> {
  const job = await new MinionQueue(engine).add('sync', { sourceId }, { queue: 'default' }, { allowProtectedSubmit: true });
  const done = ['completed', 'failed', 'dead'].includes(status);
  await engine.executeRaw(
    `UPDATE minion_jobs SET status=$2, result=$3::text::jsonb,
       started_at=now() - (($4::float + 0.5) || ' hours')::interval,
       finished_at=CASE WHEN $5::boolean THEN now() - ($4::float || ' hours')::interval END,
       lock_until=CASE WHEN $6::float IS NULL THEN NULL ELSE now() + ($6::float || ' minutes')::interval END,
       attempts_started=1, attempts_made=CASE WHEN $5::boolean THEN 1 ELSE 0 END,
       lock_token=CASE WHEN $2='active' THEN 'test-worker' END,
       claim_generation=CASE WHEN $2='active' THEN claim_generation + 1 ELSE claim_generation END
     WHERE id=$1`,
    [job.id, status, result ? JSON.stringify(result) : null, opts.finishedHoursAgo ?? 0.2, done, opts.lockMinutes ?? null],
  );
  return Number(job.id);
}

const next = (fix: unknown) => renderAction(fix as Action, cliRenderContext()).next;
const entries = (d: Record<string, unknown> | undefined) => d?.no_successful_sync as Array<Record<string, unknown>>;

describe('GST-3452 sync_freshness: a first sync stopped by a usage limit', () => {
  test('a run that stopped only on a usage limit is warn with a wait fix, not "no successful sync"', async () => {
    await addSource('mail');
    const jobId = await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3, failedFiles: 2 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain("Source 'mail': first sync stopped at a usage limit");
    expect(result.message).not.toContain('no successful sync recorded');
    const [entry] = entries(result.details);
    expect(entry).toMatchObject({ source_id: 'mail', code: 'sync_usage_limited', reason: 'usage_limit', result: 'completed (partial)', job_id: jobId });
    expect(next(entry!.fix)).toBe('wait');
  });

  test('a later run that landed nothing before the same limit keeps the warning while a landing run is inside the window', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 5 });
    await addSyncJob('mail', 'completed', { skipped: true, reason: 'sync_in_progress' }, { finishedHoursAgo: 4 });
    const jobId = await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 0 }, { finishedHoursAgo: 1 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited', job_id: jobId });
  });

  test('limited runs that land nothing, with no landing run inside the window, stay fail', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 24 * 30 });
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 0 }, { finishedHoursAgo: 1 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync' });
  });

  test('a run that failed in between ends the chain: the older landing run no longer counts', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 5 });
    await addSyncJob('mail', 'completed', { status: 'partial', failedFiles: 1 }, { finishedHoursAgo: 3 });
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 0 }, { finishedHoursAgo: 1 });
    expect((await checkSyncFreshness(engine)).status).toBe('fail');
  });

  test('the same run past the freshness window stays fail', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3, failedFiles: 2 }, { finishedHoursAgo: 24 * 30 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync', reason: 'last_attempt_unsuccessful' });
  });

  test('a partial run with no usage-limit stop stays fail', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', failedFiles: 2 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync' });
  });

  test('the code is registered as a warning that clears on its own', () => {
    expect(CODES.sync_usage_limited.class).toBe('retryable');
  });
});

describe('GST-3452 sync_freshness: a first sync still running in a job', () => {
  test('an active sync job with a live job lock is "first sync running" (warn), even between sync locks', async () => {
    await addSource('mail');
    const jobId = await addSyncJob('mail', 'active', null, { lockMinutes: 5 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain(`Source 'mail': first sync running (job #${jobId}), no successful sync yet`);
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_first_run_in_progress', reason: 'first_sync_running', job_id: jobId });
    expect(next(entries(result.details)[0]!.fix)).toBe('wait');
  });

  test('an active job whose lock expired (its worker is gone) stays fail', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'active', null, { lockMinutes: -10 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync', reason: 'attempt_queued' });
  });
});
