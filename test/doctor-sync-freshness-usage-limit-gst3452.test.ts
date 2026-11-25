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
import { pendingConnectorResult, type ManagedConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { withConnectorPartialReason } from '../src/commands/sync/connector.ts';
import type { SyncResult } from '../src/commands/sync.ts';

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

const connectorRun = (result: Record<string, unknown>): SyncResult => withConnectorPartialReason({ fromCommit: null, toCommit: '', added: 0, modified: 0,
  deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], ...result } as unknown as SyncResult);

async function addSyncJob(sourceId: string, status: string, partialOrResult: Record<string, unknown> | null,
  opts: { finishedHoursAgo?: number; lockMinutes?: number } = {}): Promise<number> {
  const result = partialOrResult?.status === 'partial' ? connectorRun(partialOrResult) : partialOrResult;
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

  test('limited runs stored with the reason the connector stamps on them still warn', async () => {
    await addSource('mail');
    const landed = await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3, failedFiles: 2 }, { finishedHoursAgo: 3 });
    const identityStop = await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit' }, { finishedHoursAgo: 1 });
    const reasons = await engine.executeRaw<{ id: number; reason: string }>(
      `SELECT id, result->>'reason' AS reason FROM minion_jobs WHERE id IN ($1, $2) ORDER BY id`, [landed, identityStop]);
    expect(reasons.map((row) => row.reason)).toEqual(['connector_item_failures', 'connector_partial']);
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited', job_id: identityStop });
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

  test('a partial run names why it ended partial in the doctor result', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', partial_causes: ['mail sweep failed: upstream error', 'run aborted'] });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync', result: 'completed (partial: mail sweep failed: upstream error; run aborted)' });
    expect(result.message).toContain('mail sweep failed: upstream error');
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
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync', reason: 'last_attempt_unsuccessful' });
    expect(next(entries(result.details)[0]!.fix)).not.toBe('wait');
  });
});

describe('GST-3452 follow-ups: the usage-limit chain', () => {
  test('a newer skipped run at the head does not hide a landing limited run', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 2 });
    await addSyncJob('mail', 'completed', { skipped: true, reason: 'sync_in_progress' }, { finishedHoursAgo: 1 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited' });
  });

  test('a queued next run at the head does not hide a landing limited run', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 2 });
    await addSyncJob('mail', 'waiting', null);
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited' });
  });

  test('many reruns that hit the spent limit keep the warning while the landing run is inside the window', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 6 });
    for (let i = 0; i < 60; i++) await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 0 }, { finishedHoursAgo: 5 - i / 15 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited' });
  }, 60_000);

  test('a run whose writes are still pending is not a landing run', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', reason: 'writer_pending', stopped_on: 'usage_limit', added: 2 }, { finishedHoursAgo: 1 });
    expect((await checkSyncFreshness(engine)).status).toBe('fail');
  });

  test('a run that hit the limit with writes pending passes like a skipped run: an older landing run still counts', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 3 });
    await addSyncJob('mail', 'completed', { status: 'partial', reason: 'writer_pending', stopped_on: 'usage_limit', added: 1 }, { finishedHoursAgo: 2 });
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 0 }, { finishedHoursAgo: 1 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited' });
  });

  test('a run that hit the limit and stopped on its wait budget passes like a skipped run too', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 3 });
    await addSyncJob('mail', 'completed', { status: 'partial', reason: 'timeout', stopped_on: 'usage_limit', added: 1 }, { finishedHoursAgo: 2 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('warn');
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_usage_limited' });
  });

  const limitedResult = { status: 'partial' as const, fromCommit: null, toCommit: '', added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0,
    embedded: 0, pagesAffected: [], stopped_on: 'usage_limit' as const };
  const session = (s: { stoppedAtDeadline: boolean; failedWriteCount: number }) => s as unknown as ManagedConnectorSync;

  test('a pending connector result keeps the usage-limit marker beside its pending reason while its writes are only pending', () => {
    expect(pendingConnectorResult(limitedResult, session({ stoppedAtDeadline: false, failedWriteCount: 0 })))
      .toMatchObject({ status: 'partial', reason: 'writer_pending', stopped_on: 'usage_limit' });
    expect(pendingConnectorResult(limitedResult, session({ stoppedAtDeadline: true, failedWriteCount: 0 })))
      .toMatchObject({ status: 'partial', reason: 'timeout', stopped_on: 'usage_limit' });
  });

  test('a write that failed terminally drops the usage-limit marker, so the run breaks the chain and reads fail', async () => {
    const failed = pendingConnectorResult(limitedResult, session({ stoppedAtDeadline: false, failedWriteCount: 1 }));
    expect(failed.reason).toBe('writer_pending');
    expect(failed.stopped_on).toBeUndefined();
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 3 });
    await addSyncJob('mail', 'completed', JSON.parse(JSON.stringify(failed)), { finishedHoursAgo: 2 });
    expect((await checkSyncFreshness(engine)).status).toBe('fail');
  });

  test('an orphaned active job (its lock expired) after a landing limited run stays fail', async () => {
    await addSource('mail');
    await addSyncJob('mail', 'completed', { status: 'partial', stopped_on: 'usage_limit', added: 3 }, { finishedHoursAgo: 2 });
    await addSyncJob('mail', 'active', null, { lockMinutes: -10 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(next(entries(result.details)[0]!.fix)).not.toBe('wait');
  });
});

describe('GST-3452 follow-ups: a running job', () => {
  test('a job running past the staleness ceiling is not "first sync running"', async () => {
    await addSource('mail');
    const jobId = await addSyncJob('mail', 'active', null, { lockMinutes: 5, finishedHoursAgo: 24 * 7 });
    const result = await checkSyncFreshness(engine);
    expect(result.status).toBe('fail');
    expect(result.message).toContain(`sync job #${jobId} has run for`);
    expect(entries(result.details)[0]).toMatchObject({ code: 'sync_no_successful_sync', reason: 'last_attempt_unsuccessful', job_id: jobId });
    expect(next(entries(result.details)[0]!.fix)).not.toBe('wait');
  });
});
