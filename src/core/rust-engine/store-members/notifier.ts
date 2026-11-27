/**
 * The commit notifier members the Rust store answers (engine-sql/notifier.ts): the host lease (claimNotifierLease,
 * readNotifierLease, holdsNotifierLease, releaseNotifierLease), the host source list (listNotifierHostSourceRows), the
 * per-source state and coverage rows (readNotifierSources, writeNotifierState, writeNotifierCoverage,
 * recordNotifierSyncerHost), the freshness status rows (readNotifierStatusRows, hasNotifierCoverage) and the wanted
 * markers (upsertWantedMarker, attachWantedMarkerJob, readWantedMarkers, readDueWantedMarkers,
 * pruneSatisfiedWantedMarkers, clearWantedMarker, settleFreshnessMarker, listSourceWantedMarkers), the first due
 * time sources status reads (readFirstDue), the source shape a sync request reads (readSourceSyncShape) and the first-due
 * clock of the oldest unsynced commit (readNotifierFirstDue).
 *
 * The store keeps the lease row with Postgres's fencing rule, one notifier row per source and one marker row per source
 * and intent. It keeps no managed worktree bindings, so every source row reads `bound` false and the binding fields
 * null. Each source row reads the source's `last_commit` (advanceSourceCommit), and a freshness marker that names
 * that head is not due.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Commit notifier").
 */
import {
  toNotifierSourceRow, toNotifierStatusRow, toPendingWantedMarker, toWantedMarker,
  type Coverage, type MarkerIntent, type NotifierHostSourceRow, type NotifierLeaseClaim, type NotifierLeaseClaimInput, type NotifierLeaseHolder,
  type NotifierSourceRow, type NotifierStatusRow, type NotifierFirstDueRow, type PendingWantedMarker, type SourceSyncShapeRow, type StatePatch, type WantedMarker, type WantedMarkerInput,
  type FirstDueRow,
} from '../../engine-sql/notifier.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store stamps microseconds; the SQL engines read an expiry back as a millisecond ISO string. */
const msHolder = (h: NotifierLeaseHolder): NotifierLeaseHolder => ({ ...h, expires_at: new Date(h.expires_at).toISOString() });

/** The fencing token when this resident owns the host's lease, else the live holder. */
export const claimNotifierLease: StoreMember<[l: NotifierLeaseClaimInput], NotifierLeaseClaim> = async (brain, l) => {
  const claim = await storeCall({ member: 'claimNotifierLease' }, () =>
    brain.claimNotifierLease({ hostId: l.hostId, ownerId: l.ownerId, kind: l.kind, pid: l.pid, leaseMs: l.leaseMs, ...(l.fence ? { fence: l.fence } : {}) })) as NotifierLeaseClaim;
  if (claim.owner || claim.holder === null) return claim;
  return { owner: false, holder: msHolder(claim.holder) };
};

/** The host's lease row, or null when it has none. */
export const readNotifierLease: StoreMember<[hostId: string], NotifierLeaseHolder | null> = async (brain, hostId) => {
  const row = await storeCall({ member: 'readNotifierLease' }, () => brain.readNotifierLease(hostId)) as NotifierLeaseHolder | null;
  return row === null ? null : msHolder(row);
};

/** The fencing check: the lease is still the owner's, with its fence, and unexpired. */
export const holdsNotifierLease: StoreMember<[hostId: string, ownerId: string, fence: number], boolean> = (brain, hostId, ownerId, fence) =>
  storeCall({ member: 'holdsNotifierLease' }, () => brain.holdsNotifierLease(hostId, ownerId, fence));

/** Expires the owner's own lease now, in one store write. */
export const releaseNotifierLease: StoreMember<[hostId: string, ownerId: string], void> = async (brain, hostId, ownerId) => {
  await storeCall({ member: 'releaseNotifierLease' }, () => brain.releaseNotifierLease(hostId, ownerId));
};

/** Every source that is not archived, in id order. */
export const listNotifierHostSourceRows: StoreMember<[], NotifierHostSourceRow[]> = (brain) =>
  storeCall({ member: 'listNotifierHostSourceRows' }, () => brain.listNotifierHostSourceRows());

/** The per-source rows of `sourceIds` (every row when null), in source id order. */
export const readNotifierSources: StoreMember<[sourceIds: string[] | null], NotifierSourceRow[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readNotifierSources' }, () => brain.readNotifierSources(sourceIds)) as Array<Record<string, unknown>>).map(toNotifierSourceRow);

/** One state transition of a source, in one store write. The message is cut as the SQL engines' caller cuts it. */
export const writeNotifierState: StoreMember<[sourceId: string, patch: StatePatch], void> = async (brain, sourceId, p) => {
  const error = p.error ? { code: p.error.code, message: p.error.message.slice(0, 2000), tracePath: p.error.tracePath ?? null } : null;
  await storeCall({ member: 'writeNotifierState' }, () => brain.writeNotifierState(sourceId, {
    state: p.state, reason: p.reason ?? null, firstDue: p.firstDue, attempts: p.attempts ?? null, nextRetryInMs: p.nextRetryInMs ?? null,
    progress: p.progress === true, errorGiven: p.error !== undefined, error, ...(p.lease ? { lease: p.lease } : {}),
  }));
};

/** The coverage record of a source, in one store write. */
export const writeNotifierCoverage: StoreMember<[sourceId: string, coverage: Coverage], void> = async (brain, sourceId, c) => {
  await storeCall({ member: 'writeNotifierCoverage' }, () => brain.writeNotifierCoverage(sourceId,
    { head: c.head, mode: c.mode, ownerHostId: c.ownerHostId, ownerKind: c.ownerKind, ownerPid: c.ownerPid, ...(c.lease ? { lease: c.lease } : {}) }));
};

/** The host that advanced a classic source; nothing is written when it did not change. */
export const recordNotifierSyncerHost: StoreMember<[sourceId: string, hostId: string], void> = async (brain, sourceId, hostId) => {
  await storeCall({ member: 'recordNotifierSyncerHost' }, () => brain.recordNotifierSyncerHost(sourceId, hostId));
};

/** The status rows of the sources that are not archived, in id order, at most 200. */
export const readNotifierStatusRows: StoreMember<[sourceIds: string[] | null], NotifierStatusRow[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readNotifierStatusRows' }, () => brain.readNotifierStatusRows(sourceIds)) as Array<Record<string, unknown>>).map(toNotifierStatusRow);

/** Whether some source has a coverage record. */
export const hasNotifierCoverage: StoreMember<[], boolean> = (brain) =>
  storeCall({ member: 'hasNotifierCoverage' }, () => brain.hasNotifierCoverage());

type Rows = Array<Record<string, unknown>>;

/** Records (or re-records) a wanted marker in one store write; null when the source does not exist. */
export const upsertWantedMarker: StoreMember<[marker: WantedMarkerInput], WantedMarker | null> = async (brain, m) => {
  const row = await storeCall({ member: 'upsertWantedMarker' }, () => brain.upsertWantedMarker({
    sourceId: m.sourceId, intent: m.intent, wantedHead: m.wantedHead, requestedBy: m.requestedBy, jobId: m.jobId ?? null,
  })) as Record<string, unknown> | null;
  return row === null ? null : toWantedMarker(row);
};

/** Names the queued job of a marker still at `generation`, in one store write. */
export const attachWantedMarkerJob: StoreMember<[sourceId: string, intent: MarkerIntent, generation: number, jobId: number], void> = async (brain, sourceId, intent, generation, jobId) => {
  await storeCall({ member: 'attachWantedMarkerJob' }, () => brain.attachWantedMarkerJob(sourceId, intent, generation, jobId));
};

/** The markers of `sourceIds` (every marker when null), oldest first, at most 1000. */
export const readWantedMarkers: StoreMember<[sourceIds: string[] | null], WantedMarker[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readWantedMarkers' }, () => brain.readWantedMarkers(sourceIds)) as Rows).map(toWantedMarker);

/** The markers that still ask for work, oldest first, at most 1000. */
export const readDueWantedMarkers: StoreMember<[sourceIds: string[] | null], WantedMarker[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readDueWantedMarkers' }, () => brain.readDueWantedMarkers(sourceIds)) as Rows).map(toWantedMarker);

/** Deletes the freshness and pull markers that name the head the source reached, in one store write. */
export const pruneSatisfiedWantedMarkers: StoreMember<[sourceIds: string[]], void> = async (brain, sourceIds) => {
  await storeCall({ member: 'pruneSatisfiedWantedMarkers' }, () => brain.pruneSatisfiedWantedMarkers(sourceIds));
};

/** Deletes a marker at `generation` in one store write; true when a row went. */
export const clearWantedMarker: StoreMember<[sourceId: string, intent: MarkerIntent, generation: number], boolean> = (brain, sourceId, intent, generation) =>
  storeCall({ member: 'clearWantedMarker' }, () => brain.clearWantedMarker(sourceId, intent, generation));

/** Deletes the source's freshness marker at `generation` when a run satisfied it, in one store write. */
export const settleFreshnessMarker: StoreMember<[sourceId: string, generation: number, checkoutHead: string | null], void> = async (brain, sourceId, generation, checkoutHead) => {
  await storeCall({ member: 'settleFreshnessMarker' }, () => brain.settleFreshnessMarker(sourceId, generation, checkoutHead));
};

/** The source's markers as the sync status notifier block lists them. */
export const listSourceWantedMarkers: StoreMember<[sourceId: string], PendingWantedMarker[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listSourceWantedMarkers' }, () => brain.listSourceWantedMarkers(sourceId)) as Rows).map(toPendingWantedMarker);

/** Per existing source: the notifier's observed head and first due time, current incarnation only. */
export const readFirstDue: StoreMember<[sourceIds: string[]], FirstDueRow[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readFirstDue' }, () => brain.readFirstDue(sourceIds))) as FirstDueRow[];
/** A live source as a sync request sees it; the store keeps no worktree bindings, so `root` is null and `bound` false. */
export const readSourceSyncShape: StoreMember<[sourceId: string], SourceSyncShapeRow | null> = async (brain, sourceId) =>
  await storeCall({ member: 'readSourceSyncShape' }, () => brain.readSourceSyncShape(sourceId)) as SourceSyncShapeRow | null;

/** Each existing source's persisted first-due clock and observed head. */
export const readNotifierFirstDue: StoreMember<[sourceIds: string[]], NotifierFirstDueRow[]> = async (brain, sourceIds) =>
  await storeCall({ member: 'readNotifierFirstDue' }, () => brain.readNotifierFirstDue(sourceIds)) as NotifierFirstDueRow[];
