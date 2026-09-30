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
    try {
      const result = await runExtractAtomsDrainForSource(engine, {
        sourceId,
        windowSeconds,
        brainDir: repoPath,
      });
      // issue #3218: every item the drain attempted failed (0 succeeded, >=1
      // provider error) — completing this job normally would mark the
      // durable job done while the backlog sits untouched, and no retry
      // policy would ever fire on it again. Throw so the worker's ordinary
      // failJob path (attempt+backoff, or dead-letter once exhausted) takes
      // over instead — matching the existing behavior for every other
      // handler failure. Partial success (>=1 item extracted) keeps
      // completing normally, unchanged.
      if (result.status === 'provider_failure') {
        throw new Error(formatDrainProviderFailure(result));
      }
      return result;
    } catch (e) {
      if (e instanceof LockUnavailableError) {
        return { phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' };
      }
      throw e;
    }
  };
}
