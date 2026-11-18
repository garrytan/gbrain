/**
 * The housekeeping members the Rust store answers (engine-sql/persistence-housekeeping.ts): the host's housekeeping turn
 * (claimHousekeepingTurn, completeHousekeepingTurn), the receipt reads (readReceiptBudget, listCompactableReceipts,
 * listReservationsAfter, listTrueUpRequests), the capacity forecast's reads (readCapacityForecastInputs) and the
 * projection queue reads (listPendingSegmentedProjections, selectProjectionWindowJobs).
 *
 * The store keeps no `persistence_consumers` rows, no `persistence_effects` rows, no worktree topology and no page
 * projection jobs, so a live consumer never blocks a turn, effect bytes are 0 and the projection queue is empty. The
 * Postgres `direct` route changes nothing here.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Housekeeping").
 */
import type {
  CapacityForecastInputs, HousekeepingTurnClaim, PendingSegmentedProjection, ProjectionWindowRow, ReceiptBudget, SegmentedProjectionFilter,
} from '../../engine-sql/persistence-housekeeping.ts';
import type { ProjectionScanCursor } from '../../page-state/projection-window.ts';
import { requestRow } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** Leases this host's turn when it is free; no resident consumer is ever live on this engine. */
export const claimHousekeepingTurn: StoreMember<[claim: HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }], boolean> =
  (brain, claim) => storeCall({ member: 'claimHousekeepingTurn' }, () => brain.claimHousekeepingTurn({ ...claim, consumerKinds: [...claim.consumerKinds] }));

/** Marks the host's leased turn finished; a turn this host does not hold is left as it is. */
export const completeHousekeepingTurn: StoreMember<[turn: { op: string; hostId: string }, opts?: { direct?: boolean }], void> = async (brain, turn) => {
  await storeCall({ member: 'completeHousekeepingTurn' }, () => brain.completeHousekeepingTurn(turn));
};

export const readReceiptBudget: StoreMember<[retentionKey: string, floorDays: number], ReceiptBudget> = (brain, retentionKey, floorDays) =>
  storeCall({ member: 'readReceiptBudget' }, () => brain.readReceiptBudget(retentionKey, floorDays));

/** No effect is ever unsettled and no managed sync cursor is ever open here, so only the age and refusal tests apply. */
export const listCompactableReceipts: StoreMember<[retentionDays: number], Record<string, unknown>[]> = async (brain, retentionDays) => {
  const rows = await storeCall({ member: 'listCompactableReceipts' }, () => brain.listCompactableReceipts(retentionDays)) as unknown[];
  return rows.map(row => requestRow<Record<string, unknown>>(row)!);
};

export const listReservationsAfter: StoreMember<[after: string, limit: number], Array<{ id: string; sequence: string; compacted: boolean }>> =
  (brain, after, limit) => storeCall({ member: 'listReservationsAfter' }, () => brain.listReservationsAfter(after, limit));

/** Effect bytes are always "0" and `unfinished` always false: the store records no effects. */
export const listTrueUpRequests: StoreMember<[ids: readonly string[]], Record<string, unknown>[]> = (brain, ids) =>
  storeCall({ member: 'listTrueUpRequests' }, () => brain.listTrueUpRequests([...ids]));

/** Principal rows, then the topology-change rows; no relation size, so `tableBytes` is null. */
export const readCapacityForecastInputs: StoreMember<[opts?: { light?: boolean }], CapacityForecastInputs> = (brain, opts) =>
  storeCall({ member: 'readCapacityForecastInputs' }, () => brain.readCapacityForecastInputs(opts?.light === true));

/** The store queues no projection jobs (`queue_page_projection` keeps nothing), so no segmented job is pending. */
export const listPendingSegmentedProjections: StoreMember<[filter: SegmentedProjectionFilter], PendingSegmentedProjection[]> = async () => [];

/**
 * The queue is empty while every live page's projection is sealed: then the window is the one row of nulls Postgres
 * returns for an empty queue. A page that is not sealed stands for a job this store cannot list yet, so the read refuses
 * rather than answer "nothing pending". The check reads every page record.
 */
export const selectProjectionWindowJobs: StoreMember<[cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean], ProjectionWindowRow[]> =
  async (brain) => {
    const empty = await storeCall({ member: 'selectProjectionWindowJobs' }, () => brain.projectionQueueEmpty()) as boolean;
    if (!empty) refuseMember('selectProjectionWindowJobs', 'a page projection is not sealed and the store keeps no projection queue');
    return [{ lane: null, ord: null, source_incarnation: null, slug: null, revision: null, high_water: null }];
  };
