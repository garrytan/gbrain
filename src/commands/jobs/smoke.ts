/** `gbrain jobs smoke` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, type JobsCommandContext } from './shared.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import { reportInlineWorkerConfiguration } from '../jobs-readiness.ts';

export async function runJobsSmoke({ args, engine, queue }: JobsCommandContext): Promise<void> {
  const startTime = Date.now();
  try { await queue.ensureSchema(); }
  catch (e) {
    console.error(`SMOKE FAIL — schema init: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const sigkillRescue = hasFlag(args, '--sigkill-rescue');
  const wedgeRescue = hasFlag(args, '--wedge-rescue');

  // Smoke harness is short-lived and has no listener — disable the health
  // timer so the no-listener fallback can't trip process.exit(1) mid-test.
  const worker = new MinionWorker(engine, {
    queue: 'smoke', pollInterval: 100, healthCheckInterval: 0,
  });
  worker.register('noop', async () => ({ ok: true, at: new Date().toISOString() }));

  const job = await queue.add('noop', {}, { queue: 'smoke', max_attempts: 1 });
  const workerPromise = worker.start();

  const timeoutMs = 15000;
  let final: MinionJob | null = null;
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
    await new Promise(r => setTimeout(r, 100));
    final = await queue.getJob(job.id);
    if (final && ['completed', 'failed', 'dead', 'cancelled'].includes(final.status)) break;
  }
  worker.stop();
  await workerPromise;

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  if (final?.status !== 'completed') {
    console.error(`SMOKE FAIL — job #${job.id} status: ${final?.status ?? 'timeout'} (${elapsedSec}s elapsed)`);
    if (final?.error_text) console.error(`  Error: ${final.error_text}`);
    if (worker.configurationError) reportInlineWorkerConfiguration(worker.configurationError);
    process.exit(1);
  }

  // --sigkill-rescue: regression case for #219. Simulates a SIGKILL
  // mid-flight by directly manipulating lock_until via handleStalled.
  // Verifies that with the v0.13.1 schema default (max_stalled=5), a
  // stalled job is REQUEUED rather than dead-lettered on first stall.
  // Full subprocess-level SIGKILL lives in test/e2e/minions.test.ts.
  if (sigkillRescue) {
    const rescueJob = await queue.add('noop', {}, { queue: 'smoke' });

    // Transition to active with a past lock_until, mimicking a worker
    // that claimed and then got SIGKILL'd mid-run.
    await engine.executeRaw(
      `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-sigkill-rescue',
                  lock_until=now() - interval '1 minute',
                  started_at=now() - interval '2 minute',
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
      [rescueJob.id]
    );

    const result = await queue.handleStalled();
    const afterStall = await queue.getJob(rescueJob.id);

    if (afterStall?.status === 'dead') {
      console.error(
        `SMOKE FAIL (--sigkill-rescue) — job #${rescueJob.id} was dead-lettered on first stall. ` +
        `This is the #219 regression: schema default max_stalled should rescue, not dead-letter. ` +
        `handleStalled: ${JSON.stringify(result)}`
      );
      process.exit(1);
    }
    if (afterStall?.status !== 'waiting') {
      console.error(
        `SMOKE FAIL (--sigkill-rescue) — unexpected status after stall: ${afterStall?.status}. ` +
        `Expected 'waiting' (rescued). handleStalled: ${JSON.stringify(result)}`
      );
      process.exit(1);
    }
    try { await queue.removeJob(rescueJob.id); } catch { /* non-fatal cleanup */ }
  }

  // --wedge-rescue: regression case for the v0.19.1 production incident.
  // In prod, a wedged worker held a row lock via a pending txn. The
  // lock-renewal UPDATE blocked, lock_until fell below now(), handleStalled
  // saw the candidate but FOR UPDATE SKIP LOCKED skipped (row lock held),
  // handleTimeouts was disqualified (lock_until > now() fails).
  // Only handleWallClockTimeouts' no-constraint sweep evicted.
  //
  // The smoke is single-connection, so we can't simulate a row lock held
  // by another txn. Instead we forge the state where BOTH handleStalled
  // and handleTimeouts are disqualified so only wall-clock fires:
  //   - lock_until far in the future → handleStalled skips (not a stall)
  //   - timeout_at = NULL → handleTimeouts skips (needs NOT NULL)
  //   - started_at 10s ago with timeout_ms=1000 → wall-clock matches
  //     (2 × timeout_ms = 2000ms threshold exceeded)
  if (wedgeRescue) {
    const wedgedJob = await queue.add('noop', {}, {
      queue: 'smoke',
      timeout_ms: 1000,
    });
    await engine.executeRaw(
      `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-wedge-rescue',
                  lock_until=now() + interval '30 seconds',
                  started_at=now() - interval '10 seconds',
                  timeout_at=NULL,
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
      [wedgedJob.id]
    );

    const stallResult = await queue.handleStalled();
    const stalledStatus = await queue.getJob(wedgedJob.id);
    const timeoutResult = await queue.handleTimeouts();
    const timedStatus = await queue.getJob(wedgedJob.id);
    const wallResult = await queue.handleWallClockTimeouts(30000);
    const finalStatus = await queue.getJob(wedgedJob.id);

    if (finalStatus?.status !== 'dead') {
      console.error(
        `SMOKE FAIL (--wedge-rescue) — wall-clock sweep did not evict job #${wedgedJob.id}. ` +
        `Status: ${finalStatus?.status}. ` +
        `handleStalled: requeued=${stallResult.requeued.length} dead=${stallResult.dead.length}, after: ${stalledStatus?.status}; ` +
        `handleTimeouts: ${timeoutResult.length}, after: ${timedStatus?.status}; ` +
        `handleWallClockTimeouts: ${wallResult.length}, final: ${finalStatus?.status}.`
      );
      process.exit(1);
    }
    if (finalStatus.error_text !== 'wall-clock timeout exceeded') {
      console.error(
        `SMOKE FAIL (--wedge-rescue) — dead, but error_text='${finalStatus.error_text}' ` +
        `(expected 'wall-clock timeout exceeded').`
      );
      process.exit(1);
    }
    try { await queue.removeJob(wedgedJob.id); } catch { /* non-fatal cleanup */ }
  }

  const cfg = (await import('../../core/config.ts')).loadConfig();
  const engineLabel = cfg?.engine ?? 'unknown';
  const tags: string[] = [];
  if (sigkillRescue) tags.push('SIGKILL rescue');
  if (wedgeRescue) tags.push('wedge rescue');
  const tag = tags.length > 0 ? ` + ${tags.join(' + ')}` : '';
  console.log(`SMOKE PASS — Minions healthy${tag} in ${elapsedSec}s (engine: ${engineLabel})`);
  if (engineLabel === 'pglite') {
    console.log('Note: the `gbrain jobs work` daemon requires Postgres. PGLite');
    console.log('supports inline execution only (`submit --follow`).');
  }
  try { await queue.removeJob(job.id); } catch { /* non-fatal cleanup */ }
  process.exit(0);
}
