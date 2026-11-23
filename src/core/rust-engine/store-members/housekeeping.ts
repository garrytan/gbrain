/**
 * The housekeeping members the Rust store answers (engine-sql/persistence-housekeeping.ts): the host's housekeeping turn
 * (claimHousekeepingTurn, completeHousekeepingTurn), the receipt reads (readReceiptBudget, listCompactableReceipts,
 * listReservationsAfter, listTrueUpRequests), `repair receipt-compaction`'s reads (readReceiptCompactionWindow,
 * listReceiptCompactionCandidates, countKeptFailedReceipts), the true-up's write (trueUpReservations), the capacity forecast's reads
 * (readCapacityForecastInputs) and the projection queue reads (listPendingSegmentedProjections, selectProjectionWindowJobs),
 * the segmented projector's queue writes (claimSegmentedProjection, renewSegmentedProjectionClaim, releaseSegmentedProjectionClaim,
 * deleteProjectionJob, markProjectionRebuildFailed) and the writer-version reads (readWriterVersionCutoff, listWriterVersions,
 * recentWriterVersions, readSegmentedGateEvidence).
 *
 * The store keeps no `persistence_consumers` rows and no worktree topology, so a live consumer never blocks a turn. Its
 * `persistence_effects` rows size the true-up as on Postgres. It keeps the page projection queue: every page write
 * updates it as PGLite's `gbrain_queue_page_projection` trigger does. The Postgres `direct` route changes nothing here.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Housekeeping").
 */
import type {
  CapacityForecastInputs, HousekeepingTurnClaim, PendingSegmentedProjection, ProjectionJobRef, ProjectionPageRef, ProjectionWindowRow, ReceiptBudget,
  ReceiptCompactionCandidate, ReceiptCompactionWindow, SegmentedProjectionClaimOutcome, SegmentedProjectionFilter, TrueUpReservation,
} from '../../engine-sql/persistence-housekeeping.ts';
import type { ProjectionScanCursor } from '../../page-state/projection-window.ts';
import {
  isoTime, recentWriterVersionRow, segmentedGateEvidenceRow, writerVersionRow, type RecentWriterVersionRow, type SegmentedGateEvidenceRow, type WriterVersionRow,
} from '../../engine-sql/writer-versions.ts';
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

export const readReceiptCompactionWindow: StoreMember<[hours: number], ReceiptCompactionWindow> = (brain, hours) =>
  storeCall({ member: 'readReceiptCompactionWindow' }, () => brain.readReceiptCompactionWindow(hours));

/** Every request here has a null worktree, so no receipt is any worktree's newest sync receipt. */
export const listReceiptCompactionCandidates: StoreMember<[states: readonly string[], cutoff: string, maxSequence: string], ReceiptCompactionCandidate[]> =
  (brain, states, cutoff, maxSequence) => storeCall({ member: 'listReceiptCompactionCandidates' },
    () => brain.listReceiptCompactionCandidates([...states], cutoff, maxSequence));

export const countKeptFailedReceipts: StoreMember<[cutoff: string], number> = (brain, cutoff) =>
  storeCall({ member: 'countKeptFailedReceipts' }, () => brain.countKeptFailedReceipts(cutoff));

export const listReservationsAfter: StoreMember<[after: string, limit: number], Array<{ id: string; sequence: string; compacted: boolean }>> =
  (brain, after, limit) => storeCall({ member: 'listReservationsAfter' }, () => brain.listReservationsAfter(after, limit));

/** Effect bytes and `unfinished` come from the request's effect rows, as the Postgres statement reads them. */
export const listTrueUpRequests: StoreMember<[ids: readonly string[]], Record<string, unknown>[]> = (brain, ids) =>
  storeCall({ member: 'listTrueUpRequests' }, () => brain.listTrueUpRequests([...ids]));

/** The true-up's compare-and-set and counter release in one store write; the freed bytes come back as text. */
export const trueUpReservations: StoreMember<[rows: readonly TrueUpReservation[]], number> = async (brain, rows) =>
  rows.length ? Number(await storeCall({ member: 'trueUpReservations' }, () => brain.trueUpReservations(rows.map(r => ({ ...r }))))) : 0;

/** Principal rows, then the topology-change rows; no relation size, so `tableBytes` is null. */
export const readCapacityForecastInputs: StoreMember<[opts?: { light?: boolean }], CapacityForecastInputs> = (brain, opts) =>
  storeCall({ member: 'readCapacityForecastInputs' }, () => brain.readCapacityForecastInputs(opts?.light === true));

/**
 * The jobs of live segmented pages of active sources, oldest first. A job's reason is `canonical_change`, a projector's
 * claim or `rebuild_failed`: `chunk_replacement_continuing` and `protocol_activation` have no writer on this engine.
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

/** The segmented projector's queue writes, each one store write at the store's clock. */
export const claimSegmentedProjection: StoreMember<[ref: ProjectionPageRef, claim: string], SegmentedProjectionClaimOutcome> = (brain, ref, claim) =>
  storeCall({ member: 'claimSegmentedProjection' }, () => brain.claimSegmentedProjection(ref.sourceId, ref.slug, claim));

export const renewSegmentedProjectionClaim: StoreMember<[ref: ProjectionPageRef, claim: string], boolean> = (brain, ref, claim) =>
  storeCall({ member: 'renewSegmentedProjectionClaim' }, () => brain.renewSegmentedProjectionClaim(ref.sourceId, ref.slug, claim));

export const releaseSegmentedProjectionClaim: StoreMember<[ref: ProjectionPageRef, claim: string], void> = async (brain, ref, claim) => {
  await storeCall({ member: 'releaseSegmentedProjectionClaim' }, () => brain.releaseSegmentedProjectionClaim(ref.sourceId, ref.slug, claim));
};

export const deleteProjectionJob: StoreMember<[job: ProjectionJobRef], void> = async (brain, job) => {
  await storeCall({ member: 'deleteProjectionJob' }, () => brain.deleteProjectionJob({ sourceIncarnation: job.sourceIncarnation, slug: job.slug, revision: job.revision }));
};

export const markProjectionRebuildFailed: StoreMember<[job: ProjectionJobRef], void> = async (brain, job) => {
  await storeCall({ member: 'markProjectionRebuildFailed' }, () => brain.markProjectionRebuildFailed({ sourceIncarnation: job.sourceIncarnation, slug: job.slug, revision: job.revision }));
};

/**
 * The writer-version reads (engine-sql/writer-versions.ts), from the admitter and consumer stamps on each request. The
 * cutoff is the brain's creation time: a Rust brain stamps every request from birth. No request is bound to a worktree,
 * so an unstamped consumer has no owner host to fall back to.
 */
export const readWriterVersionCutoff: StoreMember<[], string | null> = async brain =>
  isoTime(await storeCall({ member: 'readWriterVersionCutoff' }, () => brain.readWriterVersionCutoff()));

export const listWriterVersions: StoreMember<[limit: number], WriterVersionRow[]> = async (brain, limit) =>
  ((await storeCall({ member: 'listWriterVersions' }, () => brain.listWriterVersions(limit))) as Parameters<typeof writerVersionRow>[0][]).map(writerVersionRow);

export const recentWriterVersions: StoreMember<[days: number], RecentWriterVersionRow[]> = async (brain, days) =>
  ((await storeCall({ member: 'recentWriterVersions' }, () => brain.recentWriterVersions(days))) as Parameters<typeof recentWriterVersionRow>[0][]).map(recentWriterVersionRow);

export const readSegmentedGateEvidence: StoreMember<[days: number], SegmentedGateEvidenceRow[]> = async (brain, days) =>
  ((await storeCall({ member: 'readSegmentedGateEvidence' }, () => brain.readSegmentedGateEvidence(days))) as Parameters<typeof segmentedGateEvidenceRow>[0][]).map(segmentedGateEvidenceRow);
