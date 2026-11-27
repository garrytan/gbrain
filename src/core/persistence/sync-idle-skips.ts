/**
 * GBRA-133 (PR 2b): the managed no-op fast path. An idle tick (sync-pass-run.ts `stampIdlePass`, the pass kind
 * `syncPassKind` decides) stamps `last_sync_at` and the pass row under the drain lease and changes nothing else, yet the
 * managed branch still ran every settle after it: each one reads the state it would act on, finds nothing and returns.
 * The pin already reads most of that state, so the tick records here what it read, and each settle below is skipped when
 * the fact it acts on is absent. The tick itself, its lease, its pass row and its result are unchanged, and every settle
 * that can still find work on an idle tick (the upstream observation, the remember replay, the ghost-page report) runs.
 *
 * `GBRAIN_SYNC_IDLE_FAST_PATH=0` runs every settle again.
 */
import type { BrainEngine } from '../engine.ts';
import { loadSyncFailures } from '../sync-failure-ledger.ts';
import { GIT_HOLD_SUMMARY_OP, summaryFingerprint } from './sync-holds.ts';
import { currentDrainLease } from './sync-lease.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

/** Each settle an idle-clear tick skips, with why it has nothing to do then. */
export const IDLE_SKIPS = {
  hold_report: 'no hold of the incarnation and a zero hold summary, so buildHoldReport returns no fields (performManagedPass reads lease.idleClear itself)',
  settled_failures: 'no managed-sync-failure row of the source and no ledger row of the source, so nothing is cleared, settled or pruned',
  needs_human_sweep: 'no hold of the incarnation, so no hold turns needs_human and no soak event is counted',
  sync_tail: 'the pin read no owed tail under the lease (tailClear), so withSyncTail reads none',
  slug_heal: 'no hold of the incarnation, so no frontmatter_slug_conflict hold to heal',
  origin_heal: 'no hold of the incarnation, so no origin_conflict hold to heal',
} as const;
export type IdleSkip = keyof typeof IDLE_SKIPS;

/** What an idle tick's pin read: an owed tail, the incarnation's holds, its hold summary count and any failure row of the source. */
export interface IdleFacts { tail: boolean; holds: number; holdSummary: number; failures: boolean }

/** The facts the pin's other reads do not carry, read in the same round trip as them. */
export async function readIdleFacts(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, incarnation: string): Promise<Pick<IdleFacts, 'holdSummary' | 'failures'>> {
  const [row] = await syncRows<{ failures: boolean; hold_summary: number | string }>(engine, 'idle_facts', [sourceId, GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation)]);
  return { failures: row?.failures === true, holdSummary: Number(row?.hold_summary ?? 0) };
}

/** Whether an idle tick with these facts leaves the settles in IDLE_SKIPS nothing to do. */
export function idleClear(facts: IdleFacts): boolean {
  // cwd-dotenv-ok: a kill switch that only turns the idle skips off (every settle runs, as before); it names no path.
  return process.env.GBRAIN_SYNC_IDLE_FAST_PATH !== '0' && !facts.tail && facts.holds === 0 && facts.holdSummary === 0 && !facts.failures;
}

/**
 * The settles the last pass under this source's drain lease leaves nothing to do; empty outside the lease or after any
 * pass that was not an idle-clear tick. Read inside the lease: a caller that settles after releasing it keeps the set.
 */
export function idleSkips(sourceId: string): ReadonlySet<IdleSkip> {
  const lease = currentDrainLease(sourceId);
  if (!lease?.idleClear) return new Set();
  const skips = new Set<IdleSkip>(['hold_report', 'needs_human_sweep', 'slug_heal', 'origin_heal']);
  if (lease.tailClear) skips.add('sync_tail');
  if (!loadSyncFailures().some(row => row.source_id === sourceId)) skips.add('settled_failures');
  return skips;
}
