/**
 * #6712 PR 2 (L5): the durable obligation of a committed checkpoint's tail (statistics, links; `sync-tail.ts` runs it). The
 * checkpoint's own transaction records it, so a process that dies between that commit and the tail leaves it owed. Kept
 * free of heavy imports: the checkpoint's publication (`sync-prepare.ts`) loads it.
 */
import type { BrainEngine } from '../engine.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

export const SYNC_TAIL_OP = 'managed-sync-tail';

export interface TailObligation { run_id: string; changed: number; extract: boolean; at: string; /** A pass's pin time (database clock): its imports committed in [since, at]. */ since?: string }

/** Inside the checkpoint's transaction: the run's tail is owed before anyone can read the run as synced. */
export async function recordSyncTail(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, cursorKey: string, runId: string): Promise<void> {
  await syncRows(tx, 'tail_record_run', [SYNC_TAIL_OP, sourceId, runId, cursorKey]);
}

/**
 * #6712 PR 4b (design v3.2 §3.3): a live pass's stamp records its tail like a cursor's checkpoint, from the counts the pass
 * carries (there is no cursor row to read them from): `run_id` is the pass id.
 */
export async function recordPassTail(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, passId: string, tail: { changed: number; extract: boolean; since?: string }): Promise<void> {
  await syncRows(tx, 'tail_record_pass', [SYNC_TAIL_OP, sourceId, passId, tail.changed, tail.extract, tail.since ?? null]);
}

/** The source's owed tail, or null when none is owed. */
export async function readSyncTail(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<TailObligation[] | null> {
  const [row] = await syncRows<{ completed_keys: TailObligation[] }>(engine, 'checkpoint_keys', [SYNC_TAIL_OP, sourceId]);
  return row?.completed_keys?.length ? row.completed_keys : null;
}
