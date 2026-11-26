/**
 * Watchdog attribution (GBRA-130 A-30): an RSS watchdog drain, or a worker the
 * kernel killed, charges only the job that was running alone.
 *
 * The RSS watchdog measures the whole worker process, so when it trips with
 * several jobs in flight it cannot tell which one grew. Each job that shared
 * the drain goes back to the queue with no attempt burned and
 * `WATCHDOG_SUSPECT_MARK` appended to its history (`stacktrace`, append-only,
 * so the mark outlives the worker and survives handler progress writes). A
 * marked job is claimed only by a worker with nothing in flight, and that
 * worker claims nothing else beside it (worker.ts); GST-2529: once it has waited
 * the worker's `watchdogSuspectWaitMs`, a busy worker stops claiming until it
 * drains, so a steady stream of other jobs cannot hold it back. The next trip is
 * attributable: a job that trips the watchdog while it ran alone is charged
 * (an attempt, dead at max attempts) and stays marked.
 *
 * A worker the kernel OOM-kills leaves every claim to the stall sweep. A
 * stalled job whose worker held other expired claims (lock tokens share
 * the `<worker id>:` prefix, or a co-runner of that worker was already
 * requeued this way) is requeued with the mark and no stall counted; a marked or lone
 * job's stall counts as before.
 */
import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from './queue.ts';
import type { MinionJob } from './types.ts';
import { fenceOpts } from '../persistence/host-fence.ts';

/** The history entry that marks a job a watchdog drain or a dead worker could not clear: it runs alone from then on. */
export const WATCHDOG_SUSPECT_MARK = 'rss_watchdog_suspect: an RSS watchdog drain or a worker kill could not be attributed to this job alone; it runs alone from now on';

/** SQL that appends the mark ($n) to `stacktrace` once. */
export function appendSuspectMarkSql(param: string): string {
  return `CASE WHEN COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array(${param}::text) THEN stacktrace
    ELSE COALESCE(stacktrace, '[]'::jsonb) || jsonb_build_array(${param}::text) END`;
}

/** SQL true for a job carrying the mark ($n). */
export function markedJobSql(param: string): string {
  return `(COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array(${param}::text))`;
}

/** SQL true for a job without the mark ($n): what a worker with other jobs in flight may claim. */
export function unmarkedJobSql(param: string): string {
  return `NOT ${markedJobSql(param)}`;
}

/** A co-runner of a watchdog drain back to `waiting`, token-fenced, marked, no attempt burned. False when the claim moved on. */
export function releaseWatchdogClaim(engine: BrainEngine, id: number, lockToken: string, errorText: string): Promise<boolean> {
  return engine.releaseWatchdogClaim(id, lockToken, errorText, fenceOpts(engine));
}

/**
 * The worker's catch for a job the watchdog drain aborted. True when it is
 * settled here (`shared`: requeued uncharged and marked); false for a job that
 * ran alone, which is marked and left for the caller to charge.
 */
export async function settleWatchdogAbort(queue: Pick<MinionQueue, 'releaseWatchdogClaim'>, engine: BrainEngine, job: MinionJob, lockToken: string, shared: boolean, stopped: boolean): Promise<boolean> {
  if (shared) {
    await releaseWatchdogCoRunner(queue, job, lockToken, stopped);
    return true;
  }
  await markWatchdogSuspect(engine, job.id);
  return false;
}

/** Keeps a job charged for a solo trip marked, so its retry runs alone too. Best-effort: the charge does not depend on it. */
async function markWatchdogSuspect(engine: BrainEngine, id: number): Promise<void> {
  try {
    await engine.markJobWatchdogSuspect(id);
  } catch (e) {
    console.error(`[worker] could not mark job ${id} to run alone after its RSS watchdog trip: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether a job carries the mark: a worker runs it alone. */
export const isWatchdogSuspect = (job: MinionJob): boolean => job.stacktrace.includes(WATCHDOG_SUSPECT_MARK);

/** The error text of a job a watchdog drain requeued uncharged. */
export const WATCHDOG_DRAIN_RELEASE = 'rss_watchdog_drain: the RSS watchdog drained the worker and could not attribute it to this job alone; requeued with no attempt burned';

/**
 * A job the watchdog drain aborted while another job shared the worker, or
 * that was claimed as the drain began: back to `waiting`, marked, no attempt
 * burned. An isolated child whose stop is
 * unconfirmed, or any error releasing the claim (the worker is exiting), leaves
 * the claim to the stall sweep, which attributes a dead worker's claims the
 * same way.
 */
async function releaseWatchdogCoRunner(queue: Pick<MinionQueue, 'releaseWatchdogClaim'>, job: MinionJob, lockToken: string, stopped: boolean): Promise<void> {
  if (!stopped) {
    console.log(`Job ${job.id} (${job.name}) shared an RSS watchdog drain and its child's stop is unconfirmed; stall detector will requeue (no attempt burned)`);
    return;
  }
  try {
    const released = await queue.releaseWatchdogClaim(job.id, lockToken, WATCHDOG_DRAIN_RELEASE);
    console.log(`Job ${job.id} (${job.name}) ${released ? 'requeued to run alone' : 'claim already moved on'} after sharing an RSS watchdog drain (no attempt burned)`);
  } catch (e) {
    console.error(`[worker] watchdog release failed for job ${job.id}; stall detector will requeue: ${e instanceof Error ? e.message : String(e)}`);
  }
}

