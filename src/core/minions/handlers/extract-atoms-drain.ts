/**
 * `extract-atoms-drain` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.42.x (#1685 GAP D) — PROTECTED bounded extract_atoms backlog drain.
 * Thin wrapper over the shared helper (DECISION 5A) so the CLI `--drain`
 * path, this handler, and autopilot's auto-drain can't diverge on lock id /
 * window / defer behavior. On LockUnavailableError (the routine cycle holds
 * the per-source lock) the job completes `{ deferred: true }` and retries
 * next tick instead of failing — cooperative interleave (CODEX accepted).
 */
export function makeExtractAtomsDrainHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    if (job.data.retryRequestId !== undefined) {
      if (typeof job.data.retryRequestId !== 'string' || typeof job.data.sourceId !== 'string') throw new Error('Atom retry requires sourceId and retryRequestId strings.');
      const { retryManagedAtomBatch } = await import('../../persistence/atom-retry.ts');
      return retryManagedAtomBatch(engine, job.data.sourceId, job.data.retryRequestId, `job:${job.id}`);
    }
    const { formatDrainProviderFailure, runExtractAtomsDrainForSource } =
      await import('../../cycle/extract-atoms-drain.ts');
    const { LockUnavailableError } = await import('../../db-lock.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const windowSeconds =
      typeof job.data.window === 'number' && job.data.window > 0 ? job.data.window : 120;
    const repoPath =
      typeof job.data.repoPath === 'string'
        ? job.data.repoPath
        : ((await engine.getConfig('sync.repo_path')) ?? undefined);
    const { UnrecoverableError } = await import('../errors.ts');
    // #5809: at or past the job's deadline the worker dead-letters the row
    // anyway; a retry would hold the cycle lock for another full timeout.
    const { deadlineAtMs } = job;
    const pastDeadline = () => deadlineAtMs != null && Date.now() >= deadlineAtMs;
    try {
      const result = await runExtractAtomsDrainForSource(engine, {
        sourceId,
        windowSeconds,
        brainDir: repoPath,
        signal: job.signal,
        deadlineAtMs,
      });
      const counts = `batches=${result.batches}, extracted=${result.extracted}, remaining=${result.remaining ?? '?'}`;
      if (result.stopped === 'deadline') {
        throw new UnrecoverableError(`extract-atoms-drain: stopped at the job deadline (${counts})`);
      }
      // Cancel/pause/shutdown: the worker's own abort handling decides the row.
      if (result.stopped === 'aborted') {
        throw job.signal.reason instanceof Error ? job.signal.reason : new Error(`extract-atoms-drain: aborted (${counts})`);
      }
      // #5832: another holder took the cycle lock; retry under the job's backoff.
      if (result.stopped === 'lock_lost') {
        throw new Error(`extract-atoms-drain: lost the cycle lock lease (${counts})`);
      }
      // issue #3218: every item the drain attempted failed (0 succeeded, >=1
      // provider error) — completing this job normally would mark the
      // durable job done while the backlog sits untouched, and no retry
      // policy would ever fire on it again. Throw so the worker's ordinary
      // failJob path (attempt+backoff, or dead-letter once exhausted) takes
      // over instead — matching the existing behavior for every other
      // handler failure. Partial success (>=1 item extracted) keeps
      // completing normally, unchanged.
      if (result.status === 'provider_failure' && pastDeadline()) {
        throw new UnrecoverableError(formatDrainProviderFailure(result, { final: true }));
      }
      if (result.status === 'provider_failure') {
        throw new Error(formatDrainProviderFailure(result));
      }
      return result;
    } catch (e) {
      if (e instanceof LockUnavailableError) {
        return { phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' };
      }
      if (e instanceof UnrecoverableError || !pastDeadline()) throw e;
      throw new UnrecoverableError(e instanceof Error ? e.message : String(e));
    }
  };
}
