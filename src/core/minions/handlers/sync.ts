/**
 * `sync` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { resolveJobPull } from './job-pull.ts';
import { UnrecoverableError } from '../errors.ts';
import type { SyncResult } from '../../../commands/sync.ts';

export function makeSyncHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { performSync } = await import('../../../commands/sync.ts');
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
    // #4399: a queued automatic freshness sync re-reads the source when it runs, so a source
    // disabled after enqueue is not synced. Explicit jobs still run; a failed lookup falls through.
    if (job.data.embed_reason === 'autopilot_freshness') {
      const id = sourceId ?? 'default';
      const { isSyncDisabledConfig } = await import('../../sync-policy.ts');
      let disabled = false;
      try {
        const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [id]);
        disabled = row !== undefined && isSyncDisabledConfig(row.config);
      } catch {
        disabled = false;
      }
      if (disabled) {
        console.error(`[sync] skipped: source ${id} has syncEnabled:false; queued freshness sync not run.`);
        return { skipped: true, reason: 'sync_disabled', source_id: id };
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
    // #6706: a managed sync drains its catch-up instead of landing one page per job, bounded by the queue's own deadline for
    // this job less a reserve, and by its abort signal. Classic, connector and company-brain syncs ignore `drain`.
    const { planJobDrain, jobDrainProgress, settleJobDrain } = await import('./sync-job-drain.ts');
    const plan = await planJobDrain(engine, job);
    const progress = jobDrainProgress(job, (await import('../../persistence/sync-drain.ts')).drainEstimate);
    // #6706: one drainer per source. A tick, retry or delayed continuation that starts while another sync job for the same
    // source is live completes as a skip (the dispatcher's maxPending does not see delayed rows), like the lock-busy skip below.
    // A continuation ignores its own parent, which stays active until the worker records the parent's completion.
    // #6712 PR 1: the drain lease is the guard between processes of this build; this one still catches a job an older
    // worker runs during a rolling upgrade (it holds no lease). The lease's holder records are not jobs.
    if (plan.opts.drain && await (await import('../../persistence/managed-mode.ts')).readManagedMode(engine).catch(() => false)) {
      const [live] = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM minion_jobs WHERE name='sync' AND status='active' AND lock_until > now() AND id <> $1 AND id <> $3
        AND queue <> 'gbrain-drain-lease' AND (started_at, id) < (SELECT started_at, id FROM minion_jobs WHERE id = $1)
        AND (COALESCE(data->>'sourceId', data->>'source_id')=$2 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL AND ($4::text IS NULL AND $2='default' OR data->>'repoPath'=$4))) LIMIT 1`,
        [job.id, sourceId ?? 'default', typeof job.data.continuation_of === 'number' ? job.data.continuation_of : -1, repoPath ?? null]).catch(() => []);
      if (live) {
        console.error(`[sync] skipped: sync job #${live.id} is already draining ${sourceId ?? 'default'}.`);
        return { skipped: true, reason: 'sync_in_progress', source_id: sourceId ?? 'default', running_job_id: Number(live.id),
          next: { command: `gbrain jobs get ${live.id} --json`, safe_to_loop: true, retry_after_ms: 30_000, why: `Sync job #${live.id} is draining source ${sourceId ?? 'default'}; it resumes the cursor, so nothing else needs to run.` } };
      }
    }
    let result;
    try {
      result = await performSync(engine, {
        repoPath, sourceId, noPull, noEmbed, noExtract, signal,
        ...plan.opts,
        ...(plan.opts.drain ? { onProgress: progress.onProgress } : {}),
        // #6712 PR 1: the job drains under the source's drain lease; a busy lease is the skip below.
        drainHolder: { kind: 'job', id: String(job.id) },
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
        // #6712 PR 1 (folds #6706's live-job guard): one drainer per source is the drain lease; a job that finds it held completes as a skip.
        const id = sourceId ?? 'default';
        const { readDrainHolder, publicDrainHolder } = await import('../../persistence/sync-lease.ts');
        const read = await readDrainHolder(engine, id).catch(() => null);
        const holder = read && read.kind !== 'unknown' ? read : null;
        const runningJob = holder?.kind === 'job' && holder.id && /^\d+$/.test(holder.id) ? Number(holder.id) : null;
        console.error(`[sync] skipped: sync already in progress for ${id} (lock ${err.lockKey} held${holder ? ` by a ${holder.kind} drainer` : ''}).`);
        // A job result is readable by remote callers (get_job), so it carries the public holder: kind and times only.
        return { skipped: true, reason: 'sync_in_progress', source_id: id, ...(holder ? { holder: publicDrainHolder(holder) } : {}),
          ...(runningJob !== null ? { running_job_id: runningJob, next: { command: `gbrain jobs get ${runningJob} --json`, safe_to_loop: true, retry_after_ms: 30_000,
            why: `Sync job #${runningJob} is draining source ${id}; it resumes the cursor, so nothing else needs to run.` } } : {}) };
      }
      // P4.2 (supersedes #6465): a job an older daemon queued for a gbrain-owned content directory completes as a
      // skip instead of dying after its attempts; the dispatchers no longer queue one (automaticSyncSkip).
      if ((err as { code?: unknown } | null)?.code === 'sync_not_applicable') {
        console.error(`[sync] skipped: sync does not apply to ${sourceId ?? 'default'} (gbrain-owned content directory, not a Git checkout).`);
        return { skipped: true, reason: 'sync_not_applicable', source_id: sourceId ?? 'default' };
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
          } else if (submission.status === 'cooldown' || submission.status === 'spend_capped' || submission.status === 'no_worker_surface' || submission.status === 'stalled') {
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

    await progress.flush();
    const drained = await settleJobDrain(engine, job, result, sourceId ?? 'default', plan);
    // #6858: a drain stopped on something only a person clears (a blocked run, a stalled holder, a cap) does not end `completed`:
    // the job ends dead with the run's next step, and its progress keeps the drain fields `jobs get` would otherwise have shown.
    if (drained.incomplete === true && (await import('../../persistence/sync-drain.ts')).jobDisposition(result, sourceId ?? 'default') === 'needs_operator') {
      const { outcome, drain, next } = drained as { outcome?: string; drain?: SyncResult['drain']; next?: { command?: string; why?: string } };
      await job.updateProgress({ blocked: true, outcome, drain, next }).catch(() => undefined);
      throw new UnrecoverableError(`Managed sync of source ${sourceId ?? 'default'} is ${result.status === 'blocked_by_failures' ? 'blocked' : 'stopped'}`
        + ` (${drain?.stop_reason ?? result.status}${drain?.remaining != null ? `, ${drain.remaining} entries left` : ''}). ${next?.why ?? ''}${next?.command ? ` Next: ${next.command}` : ''}`.trim());
    }
    return { ...result, ...drained, embed_job_id: embedJobId, embed_skip_reason: embedSkipReason };
  };
}
