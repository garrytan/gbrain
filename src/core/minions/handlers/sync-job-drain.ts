/**
 * #6706: the managed drain inside a durable `sync` job.
 *
 * A job drains its catch-up (the CLI's path) instead of landing one page per job, bounded by the instant the queue
 * itself would end the job: its claim-time `timeout_at`, or for a job without `timeout_ms` the wall-clock sweep
 * (`queue.ts` handleWallClockTimeouts), capped at an hour and less a reserve so cleanup, git and the embed submission
 * finish first. When the drain stops with work left and the stop is safe to repeat, one follow-up job continues it
 * behind whatever is already waiting. The job result carries the CLI's `outcome` / `drain` / `next` fields.
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import type { SyncOpts, SyncResult } from '../../../commands/sync.ts';

/** The smallest worker lease the wall-clock sweep can use for a row without `lock_duration_ms` (the worker default). */
const WORKER_LOCK_DEFAULT_MS = 30_000;
/** A job whose row cannot be read (tests, a vanished row) drains at most this long. */
const UNKNOWN_BUDGET_MS = 5 * 60_000;
/** The longest a single job drains; a continuation takes the rest. */
export const JOB_DRAIN_MAX_MS = 60 * 60_000;
/** Time kept back from the job's deadline for lane settlement, cleanup, git and the embed submission (cycle precedent). */
export const JOB_DRAIN_RESERVE_MS = 60_000;
const PROGRESS_EVERY_MS = 10_000;
const LIST_KEEP = 50;
/** A continuation runs no sooner than embed-backfill (priority 5), so it queues behind the embeds and syncs already waiting. */
const CONTINUATION_PRIORITY = 5;

interface JobRow { started_ms: number | null; wall_ms: number | null; timeout_ms: number | null; queue: string | null; priority: number | null }

export interface JobDrainPlan {
  opts: Pick<SyncOpts, 'drain' | 'deadlineAtMs' | 'lanes' | 'noBulk'>;
  row: JobRow | null;
  trusted: boolean;
}

/** The drain options for this job, or none when draining is off (`drain: false` from a trusted submitter, or `sync.job_drain=false`). */
export async function planJobDrain(engine: BrainEngine, job: MinionJobContext, now = Date.now()): Promise<JobDrainPlan> {
  const trusted = !job.submission_authority || job.submission_authority.kind === 'application';
  const params = trusted ? job.data : {};
  const configured = await engine.getConfig('sync.job_drain').catch(() => null);
  if (params.drain === false || configured === 'false') return { opts: {}, row: null, trusted };
  const { WALL_CLOCK_THRESHOLD_MS_SQL } = await import('../handler-timeouts.ts');
  const [row] = await engine.executeRaw<JobRow>(
    `SELECT (EXTRACT(EPOCH FROM started_at) * 1000)::float8 AS started_ms, (${WALL_CLOCK_THRESHOLD_MS_SQL})::float8 AS wall_ms,
            timeout_ms, queue, priority
       FROM minion_jobs WHERE id = $2`, [WORKER_LOCK_DEFAULT_MS, job.id]).catch(() => []);
  const started = row?.started_ms ?? now;
  const hard = job.deadlineAtMs ?? (row?.started_ms != null && row.wall_ms != null ? row.started_ms + row.wall_ms : now + UNKNOWN_BUDGET_MS);
  const at = Math.min(hard, started + JOB_DRAIN_MAX_MS);
  // The reserve also absorbs skew between the database clock (started_at) and this worker's clock.
  const deadlineAtMs = at - Math.min(JOB_DRAIN_RESERVE_MS, Math.max(0, at - now) / 4);
  const lanes = typeof params.lanes === 'number' && Number.isInteger(params.lanes) && params.lanes >= 1 && params.lanes <= 16 ? params.lanes : 1;
  return { opts: { drain: true, deadlineAtMs, lanes, ...(params.noBulk === true ? { noBulk: true } : {}) }, row: row ?? null, trusted };
}

/** Throttled best-effort progress for `jobs get` / MCP polling while the drain commits pages. Never throws into the sync. */
export function jobDrainProgress(job: MinionJobContext, estimate: (remaining: number | null, processed: number, elapsedMs: number) => { rate_pages_per_min: number | null; eta_seconds: number | null }):
  { onProgress: NonNullable<SyncOpts['onProgress']>; flush(): Promise<void> } {
  const startedAt = Date.now();
  let index = 0, processed = 0, total: number | null = null, phase = 'managed_sync.start', lastAdvanceAt: string | null = null, wroteAt = 0;
  const snapshot = () => {
    const remaining = total === null ? null : Math.max(0, total - index);
    return { phase, index, total, processed, remaining, ...estimate(remaining, processed, Date.now() - startedAt), last_advance_at: lastAdvanceAt };
  };
  return {
    onProgress: event => {
      if (!event.phase.startsWith('managed_sync.')) return;
      phase = event.phase;
      if (typeof event.total === 'number') total = event.total;
      if (typeof event.bankedFiles === 'number') index = event.bankedFiles;
      if (event.phase !== 'managed_sync.page_committed') return;
      const now = Date.now();
      processed++;
      lastAdvanceAt = new Date(now).toISOString();
      if (now - wroteAt >= PROGRESS_EVERY_MS) { wroteAt = now; job.updateProgress(snapshot()).catch(() => undefined); }
    },
    flush: async () => { if (lastAdvanceAt) await job.updateProgress(snapshot()).catch(() => undefined); },
  };
}

/** Counts plus the first entries of a long list, so a drained job's result row stays small. */
function trimList<T>(list: T[] | undefined): { list?: T[]; count?: number } {
  if (!list || list.length <= LIST_KEEP) return list ? { list } : {};
  return { list: list.slice(0, LIST_KEEP), count: list.length };
}

/**
 * The drained job's result fields: the CLI's `outcome` / `drain` / `next`, an `incomplete` alias, and at most one
 * continuation job when the stop is safe to repeat and this job committed at least one entry. Empty for a result
 * with no drain, so classic and other syncs keep master's result.
 */
export async function settleJobDrain(engine: BrainEngine, job: MinionJobContext, result: SyncResult, sourceId: string, plan: JobDrainPlan): Promise<Record<string, unknown>> {
  const { drainJsonFields, jobDisposition } = await import('../../persistence/sync-drain.ts');
  const { managedSyncResumeArgs, syncResumeCommand } = await import('../../sync-reconcile.ts');
  const disposition = jobDisposition(result, sourceId);
  if (!disposition) return {};
  const resume = syncResumeCommand(managedSyncResumeArgs({ sourceId }));
  const fields = drainJsonFields(result, resume, sourceId) as { outcome?: string; drain?: SyncResult['drain']; next?: Record<string, unknown> & { why?: string; docs?: string } };
  const held = trimList(result.held), pages = trimList(result.pagesAffected);
  const out: Record<string, unknown> = { ...fields, incomplete: disposition !== 'synced',
    ...(held.list ? { held: held.list } : {}), ...(held.count ? { held_count: held.count } : {}),
    ...(pages.list ? { pagesAffected: pages.list } : {}), ...(pages.count ? { pages_affected_count: pages.count } : {}) };
  if (disposition === 'synced') return out;
  const d = result.drain!;
  let continuationId: number | null = null;
  const { embedBackfillWorkerSurface } = await import('../embed-backfill-admission.ts');
  // PGLite has no resident worker to run a queued follow-up (the embed-backfill rule); its `next` stays the resume command.
  if (disposition === 'continue' && plan.trusted && d.processed > 0 && embedBackfillWorkerSurface(engine).status === 'worker_backed') {
    try {
      const { MinionQueue } = await import('../queue.ts');
      const next = await new MinionQueue(engine).add('sync', { ...job.data, sourceId, continuation_of: job.id }, {
        idempotency_key: `sync-continue:${sourceId}:${job.id}`,
        maxWaiting: 1,
        ...(plan.row?.queue ? { queue: plan.row.queue } : {}),
        priority: Math.max(plan.row?.priority ?? 0, CONTINUATION_PRIORITY),
        ...(plan.row?.timeout_ms != null ? { timeout_ms: plan.row.timeout_ms } : {}),
        ...(typeof fields.next?.retry_after_ms === 'number' && fields.next.retry_after_ms > 0 ? { delay: fields.next.retry_after_ms } : {}),
      });
      continuationId = next.id;
      // A job cancelled while it settled leaves no runnable successor behind.
      if ((job.signal.aborted || job.shutdownSignal?.aborted) && next.data?.continuation_of === job.id) { await new MinionQueue(engine).cancelJob(next.id).catch(() => undefined); continuationId = null; }
    } catch { /* best-effort: the next freshness tick or the resume command continues */ }
  }
  const status = `gbrain sources status ${sourceId} --json`;
  if (continuationId !== null && fields.next) {
    // The successor owns the resume: every field observes it (no executable sync `fix` survives), polled after a short delay.
    out.next = { command: status, safe_to_loop: true, retry_after_ms: Math.max(30_000, Number(fields.next.retry_after_ms) || 0),
      eta_seconds: d.eta_seconds, rate_pages_per_min: d.rate_pages_per_min, ...(fields.next.docs ? { docs: fields.next.docs } : {}),
      why: `Follow-up sync job #${continuationId} continues from the cursor (${d.remaining ?? 'an unknown number of'} entries left); this job stopped ${d.stop_reason ?? d.outcome} with its cursor and accepted writes intact. `
        + `Watch it with \`gbrain jobs get ${continuationId} --json\` or the source's cursor; running \`${resume}\` now would start a second drainer beside it.` };
  } else if (!plan.trusted && fields.next) {
    // A remote job cannot run the host's CLI and may not queue its own successor: the host operator resumes, or the caller submits a new sync job.
    out.next = { command: status, safe_to_loop: false, retry_after_ms: 0, eta_seconds: d.eta_seconds, rate_pages_per_min: d.rate_pages_per_min,
      ...(fields.next.code ? { code: fields.next.code } : {}), ...(fields.next.docs ? { docs: fields.next.docs } : {}),
      why: `${fields.next.why ?? ''} This job was submitted remotely, so it queued no follow-up: submit a new sync job for source ${sourceId}, or ask the brain host's operator to run \`${resume}\`.` };
  }
  out.continuation_job_id = continuationId;
  const next = out.next as { why?: string; docs?: string } | undefined;
  console.error(`[sync] job ${job.id} source ${sourceId}: ${d.outcome}/${d.stop_reason ?? 'none'}, ${d.remaining ?? 'an unknown number of'} entries left. `
    + `${next?.why ?? ''}${next?.docs ? ` Docs: ${next.docs}` : ''}`);
  return out;
}
