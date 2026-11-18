/**
 * The housekeeping members the Rust store answers (engine-sql/persistence-housekeeping.ts): the host's housekeeping turn
 * (claimHousekeepingTurn, completeHousekeepingTurn), the receipt reads (readReceiptBudget, listCompactableReceipts,
 * listReservationsAfter, listTrueUpRequests), the capacity forecast's reads (readCapacityForecastInputs) and the
 * projection queue reads (listPendingSegmentedProjections, selectProjectionWindowJobs) and the writer-version cutoff
 * (readWriterVersionCutoff).
 *
 * The store keeps no `persistence_consumers` rows, no `persistence_effects` rows and no worktree topology, so a live
 * consumer never blocks a turn and effect bytes are 0. It keeps the page projection queue: every page write updates it
 * as PGLite's `gbrain_queue_page_projection` trigger does. The Postgres `direct` route changes nothing here.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Housekeeping").
 */
import type {
  CapacityForecastInputs, HousekeepingTurnClaim, PendingSegmentedProjection, ProjectionWindowRow, ReceiptBudget, SegmentedProjectionFilter,
} from '../../engine-sql/persistence-housekeeping.ts';
import type { ProjectionScanCursor } from '../../page-state/projection-window.ts';
import { isoTime } from '../../engine-sql/writer-versions.ts';
import { requestRow } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

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

/**
 * The jobs of live segmented pages of active sources, oldest first. Every job here has reason `canonical_change`: the
 * writers of the other reasons are raw SQL this engine refuses.
 */
export const listPendingSegmentedProjections: StoreMember<[filter: SegmentedProjectionFilter], PendingSegmentedProjection[]> = (brain, filter) =>
  storeCall({ member: 'listPendingSegmentedProjections' }, () => brain.listPendingSegmentedProjections({
    limit: filter.limit, notAfter: filter.notAfter, retryCooldown: filter.retryCooldown,
    reasons: filter.reasons ? [...filter.reasons] : undefined, exclude: filter.exclude ? [...filter.exclude] : undefined,
  }));

/** The recency lane, then the key window; one row of nulls carrying the high water when no job is selected. */
export const selectProjectionWindowJobs: StoreMember<[cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean], ProjectionWindowRow[]> =
  (brain, cursor, retryCooldown) => storeCall({ member: 'selectProjectionWindowJobs' }, () => brain.selectProjectionWindowJobs(
    { after: { source_incarnation: cursor.after.source_incarnation, slug: cursor.after.slug }, highWater: cursor.highWater }, retryCooldown));

/**
 * The writer-version cutoff (engine-sql/writer-versions.ts): the brain's creation time, since a Rust brain stamps every
 * request from birth.
 */
export const readWriterVersionCutoff: StoreMember<[], string | null> = async brain =>
  isoTime(await storeCall({ member: 'readWriterVersionCutoff' }, () => brain.readWriterVersionCutoff()));
