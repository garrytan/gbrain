/**
 * The belief ledger's write path (BrainEngine readBeliefCoverage, hasBaselineEvent, countBaselinedSlugs,
 * listPendingBaselineSlugs, listPurgedFingerprints, readBeliefRedactions, insertBeliefRedaction,
 * releaseBeliefRedactions, insertBeliefEvents, recordBeliefCommitMarks; SQL in engine-sql/collate-belief-writes.ts), served
 * from the store (rust/crates/gbrain-store/src/belief_events.rs). What each member answers:
 * rust/docs/store/collate-belief-writes.md.
 */
import type { BeliefCoverageRow, BeliefEventRow, BeliefRedactionRow } from '../../engine-sql/collate-belief-writes.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readBeliefCoverage: StoreMember<[sourceId: string, coverageKey: string], BeliefCoverageRow | null> = async (brain, sourceId, coverageKey) =>
  await storeCall({ member: 'readBeliefCoverage', sourceId }, () => brain.readBeliefCoverage(sourceId, coverageKey)) as BeliefCoverageRow | null;

export const hasBaselineEvent: StoreMember<[sourceId: string, slug: string, runId: string], boolean> = async (brain, sourceId, slug, runId) =>
  await storeCall({ member: 'hasBaselineEvent', sourceId }, () => brain.hasBaselineEvent(sourceId, slug, runId)) as boolean;

export const countBaselinedSlugs: StoreMember<[sourceId: string, runId: string], number> = async (brain, sourceId, runId) =>
  Number(await storeCall({ member: 'countBaselinedSlugs', sourceId }, () => brain.countBaselinedSlugs(sourceId, runId)));

export const listPendingBaselineSlugs: StoreMember<[sourceId: string, runId: string, after: string, skip: readonly string[], limit: number], string[]> =
  async (brain, sourceId, runId, after, skip, limit) =>
    await storeCall({ member: 'listPendingBaselineSlugs', sourceId }, () => brain.listPendingBaselineSlugs(sourceId, runId, after, [...skip], Math.max(1, Math.floor(limit)))) as string[];

/** Fact purge tombstones only: a Rust brain keeps no take purges (nothing writes one), so `takeFps` match nothing. */
export const listPurgedFingerprints: StoreMember<[sourceId: string, factFps: readonly string[], takeFps: readonly string[]], string[]> = async (brain, sourceId, factFps, takeFps) =>
  await storeCall({ member: 'listPurgedFingerprints', sourceId }, () => brain.listPurgedFingerprints(sourceId, [...factFps], [...takeFps])) as string[];

export const readBeliefRedactions: StoreMember<[sourceId: string, subjectKeys: readonly string[], fieldHashes: readonly string[]], BeliefRedactionRow[]> =
  async (brain, sourceId, subjectKeys, fieldHashes) =>
    await storeCall({ member: 'readBeliefRedactions', sourceId }, () => brain.readBeliefRedactions(sourceId, [...subjectKeys], [...fieldHashes])) as BeliefRedactionRow[];

export const insertBeliefRedaction: StoreMember<[sourceId: string, subjectKey: string, field: string, purgeRequest: string, fieldHash: string], number> =
  async (brain, sourceId, subjectKey, field, purgeRequest, fieldHash) =>
    Number(await storeCall({ member: 'insertBeliefRedaction', sourceId }, () => brain.insertBeliefRedaction(sourceId, subjectKey, field, purgeRequest, fieldHash)));

export const releaseBeliefRedactions: StoreMember<[ids: readonly number[], publicationId: string, releasedHash: string], void> = async (brain, ids, publicationId, releasedHash) => {
  await storeCall({ member: 'releaseBeliefRedactions' }, () => brain.releaseBeliefRedactions([...ids], publicationId, releasedHash));
};

export const insertBeliefEvents: StoreMember<[rows: readonly BeliefEventRow[]], number> = async (brain, rows) =>
  Number(await storeCall({ member: 'insertBeliefEvents' }, () => brain.insertBeliefEvents([...rows])));

export const recordBeliefCommitMarks: StoreMember<[publicationIds: readonly string[]], void> = async (brain, publicationIds) => {
  if (!publicationIds.length) return;
  await storeCall({ member: 'recordBeliefCommitMarks' }, () => brain.recordBeliefCommitMarks([...publicationIds]));
};
