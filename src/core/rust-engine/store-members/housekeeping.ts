/**
 * The persistence housekeeping reads of engine-sql/persistence-housekeeping.ts the store serves (gbrain-store
 * `persistence::journal`).
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { CapacityForecastInputs } from '../../engine-sql/persistence-housekeeping.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { HousekeepingTurnClaim } from '../../engine-sql/persistence-housekeeping.ts';
import type { PendingSegmentedProjection } from '../../engine-sql/persistence-housekeeping.ts';
import type { ProjectionScanCursor } from '../../page-state/projection-window.ts';
import type { ProjectionWindowRow } from '../../engine-sql/persistence-housekeeping.ts';
import type { ReceiptBudget } from '../../engine-sql/persistence-housekeeping.ts';
import type { SegmentedProjectionFilter } from '../../engine-sql/persistence-housekeeping.ts';
import { requestRow } from '../store-codec.ts';
import type { ProjectionJobRef } from '../../engine-sql/persistence-housekeeping.ts';
import type { TrueUpReservation } from '../../engine-sql/persistence-housekeeping.ts';

/** Principal rows, then the topology-change rows; no relation size, so `tableBytes` is null. */
export const readCapacityForecastInputs: StoreMember<[opts?: { light?: boolean }], CapacityForecastInputs> = (brain, opts) =>
  storeCall({ member: 'readCapacityForecastInputs' }, () => brain.readCapacityForecastInputs(opts?.light === true));

/** Leases this host's turn when it is free; no resident consumer is ever live on this engine. */
export const claimHousekeepingTurn: StoreMember<[claim: HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }], boolean> =
  (brain, claim) => storeCall({ member: 'claimHousekeepingTurn' }, () => brain.claimHousekeepingTurn({ ...claim, consumerKinds: [...claim.consumerKinds] }));

/** Marks the host's leased turn finished; a turn this host does not hold is left as it is. */
export const completeHousekeepingTurn: StoreMember<[turn: { op: string; hostId: string }, opts?: { direct?: boolean }], void> = async (brain, turn) => {
  await storeCall({ member: 'completeHousekeepingTurn' }, () => brain.completeHousekeepingTurn(turn));
};

/** No effect is ever unsettled and no managed sync cursor is ever open here, so only the age and refusal tests apply. */
export const listCompactableReceipts: StoreMember<[retentionDays: number], Record<string, unknown>[]> = async (brain, retentionDays) => {
  const rows = await storeCall({ member: 'listCompactableReceipts' }, () => brain.listCompactableReceipts(retentionDays)) as unknown[];
  return rows.map(row => requestRow<Record<string, unknown>>(row)!);
};

/**
 * The jobs of live segmented pages of active sources, oldest first. A job's reason is `canonical_change`, a projector's
 * claim or `rebuild_failed`: `chunk_replacement_continuing` and `protocol_activation` have no writer on this engine.
 */
export const listPendingSegmentedProjections: StoreMember<[filter: SegmentedProjectionFilter], PendingSegmentedProjection[]> = (brain, filter) =>
  storeCall({ member: 'listPendingSegmentedProjections' }, () => brain.listPendingSegmentedProjections({
    limit: filter.limit, notAfter: filter.notAfter, retryCooldown: filter.retryCooldown,
    reasons: filter.reasons ? [...filter.reasons] : undefined, exclude: filter.exclude ? [...filter.exclude] : undefined,
  }));

export const listReservationsAfter: StoreMember<[after: string, limit: number], Array<{ id: string; sequence: string; compacted: boolean }>> =
  (brain, after, limit) => storeCall({ member: 'listReservationsAfter' }, () => brain.listReservationsAfter(after, limit));

export const readReceiptBudget: StoreMember<[retentionKey: string, floorDays: number], ReceiptBudget> = (brain, retentionKey, floorDays) =>
  storeCall({ member: 'readReceiptBudget' }, () => brain.readReceiptBudget(retentionKey, floorDays));

/** The recency lane, then the key window; one row of nulls carrying the high water when no job is selected. */
export const selectProjectionWindowJobs: StoreMember<[cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean], ProjectionWindowRow[]> =
  (brain, cursor, retryCooldown) => storeCall({ member: 'selectProjectionWindowJobs' }, () => brain.selectProjectionWindowJobs(
    { after: { source_incarnation: cursor.after.source_incarnation, slug: cursor.after.slug }, highWater: cursor.highWater }, retryCooldown));

export const deleteProjectionJob: StoreMember<[job: ProjectionJobRef], void> = async (brain, job) => {
  await storeCall({ member: 'deleteProjectionJob' }, () => brain.deleteProjectionJob({ sourceIncarnation: job.sourceIncarnation, slug: job.slug, revision: job.revision }));
};

export const markProjectionRebuildFailed: StoreMember<[job: ProjectionJobRef], void> = async (brain, job) => {
  await storeCall({ member: 'markProjectionRebuildFailed' }, () => brain.markProjectionRebuildFailed({ sourceIncarnation: job.sourceIncarnation, slug: job.slug, revision: job.revision }));
};

/** Effect bytes and `unfinished` come from the request's effect rows, as the Postgres statement reads them. */
export const listTrueUpRequests: StoreMember<[ids: readonly string[]], Record<string, unknown>[]> = (brain, ids) =>
  storeCall({ member: 'listTrueUpRequests' }, () => brain.listTrueUpRequests([...ids]));

/** The true-up's compare-and-set and counter release in one store write; the freed bytes come back as text. */
export const trueUpReservations: StoreMember<[rows: readonly TrueUpReservation[]], number> = async (brain, rows) =>
  rows.length ? Number(await storeCall({ member: 'trueUpReservations' }, () => brain.trueUpReservations(rows.map(r => ({ ...r }))))) : 0;
