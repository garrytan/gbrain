/**
 * `sync` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { resolveJobPull } from './job-pull.ts';

export function makeSyncHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { performSync } = await import('../../../commands/sync.ts');
    const { explicitSyncProcessing } = await import('../../persistence/sync-authority.ts');
    const repoPath = typeof job.data.repoPath === 'string' ? job.data.repoPath : undefined;
    const noPull = !resolveJobPull(job.data);
    // noEmbed defaults to true (embed is a separate job — submit `embed --stale`
    // after sync, OR run via the autopilot cycle which has its own embed phase).
    // Caller can opt in by passing { noEmbed: false } in job params.
    const noEmbed = job.data.noEmbed !== false;
    // v0.22.13 (PR #490 CODEX-1): resolve sourceId from job param OR by looking
    // up the sources row for repoPath. Mirrors cycle.ts:480 — without this, a
    // multi-source brain reads the global config.sync.last_commit anchor
    // instead of sources.last_commit, which on a regularly-GC'd repo can drop
    // out of git history and trigger 30-min full reimports every cycle.
    let sourceId: string | undefined =
      typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId && repoPath) {
      try {
        const rows = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources WHERE local_path = $1 LIMIT 1`,
          [repoPath],
        );
        sourceId = rows[0]?.id;
      } catch {
        // sources table may not exist on very old brains — fall through to
        // global config.sync.* anchor in performSync.
      }
    }
    // v0.22.13 (PR #490 CODEX-4): route concurrency through the shared
    // autoConcurrency helper instead of hardcoded 4. PGLite engines stay
    // serial (forced 1); explicit job param wins; auto path defaults are
    // applied inside performSync against the resolved file count.
    const concurrencyOverride = typeof job.data.concurrency === 'number'
      ? job.data.concurrency
      : undefined;
    // v0.36+ codex #5 fix: standalone `sync` handler now passes
    // noExtract:true so doctor's remediation plan [sync, extract] doesn't
    // double-extract (performSync inline-extract + standalone extract job).
    // Pre-fix, runPhaseSync in cycle.ts passed noExtract:true but the
    // standalone handler dropped it. Callers that want inline extract can
    // pass { noExtract: false } in job params explicitly.
    const noExtract = job.data.noExtract !== false;
    // v0.46: github-kind single-item refresh (webhook path). The payload
    // carries {repo, number, kind} and sync refreshes exactly that item.
    const githubItem =
      job.data.github_item && typeof job.data.github_item === 'object'
        ? {
            repo: String((job.data.github_item as Record<string, unknown>).repo),
            number: Number((job.data.github_item as Record<string, unknown>).number),
            kind: (job.data.github_item as Record<string, unknown>).kind === 'pr' ? 'pr' as const : 'issue' as const,
            deleted: (job.data.github_item as Record<string, unknown>).deleted === true,
          }
        : undefined;
    // Under a signal owner (`jobs work`, the supervisor) SIGTERM skips the cleanup pass and
    // aborts only the worker's shutdown signal, so the sync and its git pull stop on either signal.
    const { composeAbortSignals } = await import('../../sync-reconcile.ts');
    const signal = composeAbortSignals(job.signal, job.shutdownSignal);
    let result;
    try {
      result = await performSync(engine, {
        repoPath, sourceId, noPull, noEmbed, noExtract, signal,
        explicitProcessing: explicitSyncProcessing(job.data),
        concurrency: concurrencyOverride,
        ...(githubItem ? { githubItem } : {}),
      });
    } catch (err) {
      // v0.42.x (#1794, Part B): single-flight backpressure. A concurrent
      // sync (manual run, sibling autopilot tick) holds the per-source lock.
      // SKIP cleanly — mark the job done, NOT failed — so the holder finishes
      // without this tick polluting the failed-jobs count + supervisor crash
      // metrics. The next scheduled tick resumes against the (by then
      // advanced) anchor.
      const { SyncLockBusyError } = await import('../../../commands/sync.ts');
      if (err instanceof SyncLockBusyError) {
        console.error(
          `[sync] skipped: sync already in progress for ${sourceId ?? 'default'} ` +
          `(lock ${err.lockKey} held).`,
        );
        return { skipped: true, reason: 'sync_in_progress', source_id: sourceId ?? 'default' };
      }
      throw err;
    }

    // A cancelled durable job must not complete or schedule follow-up work,
    // even when a direct sync interruption has a resumable partial result.
    if (signal?.aborted) throw signal.reason ?? new Error('Sync job cancelled');

    // v0.40 D22: auto_embed_backfill defaults TRUE when sourceId is set AND
    // the feature flag is enabled. Submits a child embed-backfill job
    // (fire-and-forget — D15.1) so stale chunks get embedded async without
    // the sync handler waiting on the embed pipeline.
    const autoEmbed = job.data.auto_embed_backfill !== false;
    let embedJobId: number | null = null;
    let embedSkipReason: string | null = null;
    const { syncProducedEmbeddableContent } = await import('../../sync-embed-backfill.ts');
    if (autoEmbed && sourceId && result.status !== 'up_to_date' && result.status !== 'dry_run' && syncProducedEmbeddableContent(result)) {
      try {
        const { isFederatedV2Enabled } = await import('../../feature-flags.ts');
        if (await isFederatedV2Enabled(engine)) {
          const { submitEmbedBackfill } = await import('../../embed-backfill-submit.ts');
          const submission = await submitEmbedBackfill(engine, sourceId, {
            reason: typeof job.data.embed_reason === 'string'
              ? (job.data.embed_reason as string)
              : 'sync_handler',
          });
          if (submission.status === 'submitted') {
            embedJobId = submission.jobId;
          } else if (submission.status === 'cooldown' || submission.status === 'spend_capped' || submission.status === 'no_worker_surface') {
            embedSkipReason = submission.status;
          } else {
            submission satisfies never;
          }
        } else {
          embedSkipReason = 'feature_flag_disabled';
        }
      } catch (err) {
        // Embed-backfill submission failure must NOT fail the sync job.
        embedSkipReason = `submit_error:${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!sourceId) {
      embedSkipReason = 'no_source_id';
    } else if (!autoEmbed) {
      embedSkipReason = 'auto_embed_disabled';
    } else if (result.status !== 'up_to_date' && result.status !== 'dry_run') {
      // #4786 x #2139: a sweep-only `synced` run wrote nothing to embed — a backfill here would only arm the cooldown.
      embedSkipReason = 'no_new_content';
    }

    return { ...result, embed_job_id: embedJobId, embed_skip_reason: embedSkipReason };
  };
}
