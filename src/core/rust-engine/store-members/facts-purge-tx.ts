/**
 * The fact purge's transaction statements that read and delete facts, takes and pages by id
 * (src/core/engine-sql/facts-purge.ts), served from rust/crates/gbrain-store/src/facts/purge_tx.rs:
 * listPurgeStreamSlugs, deletePurgedFacts, listPurgedPageRevisions, listPagesForPurgeRewrite, deletePurgedTakes,
 * deletePurgeTrustProposals, deletePurgeOpenLoops, deletePurgeWriteGateHolds and deletePurgeWriteGateReceipts. Each delete
 * runs in the module that owns its rows (trust/proposals.rs, facts/loops.rs, trust/write_gate.rs). Also served:
 * updatePageBodyForPurge, setPurgeVersionBody, redactVersionChangeReasons, deletePurgedChunks, expireDerivedFacts,
 * deactivateDerivedTakes and softDeleteDerivedPages (purge_tx.rs), findPurgeBlockedPublication (facts/purge_journal.rs)
 * and insertPurgeEffects (the store's insertWithdrawalEffects: the two statements are the same SQL).
 *
 * An id list binds as `bigint[]` (facts, takes) or `int[]` (pages) on SQL, so an id that is not an integer refuses
 * rather than guess at its cast error. `listPurgeStreamSlugs` answers in byte order; its SQL has no ORDER BY.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { withDates } from '../store-codec.ts';
import { escapeFenceCell } from '../../fence-shared.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The page columns PGLite returns as a Date (timestamptz / date). */
const PAGE_DATES = ['created_at', 'updated_at', 'deleted_at', 'effective_date', 'ingested_at', 'salience_touched_at'];

function wholeIds(member: string, ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) refuseMember(member, 'an id that is not an integer');
  return [...ids];
}

export const listPurgeStreamSlugs: Member<'listPurgeStreamSlugs'> = async (brain, factIds) => {
  const ids = wholeIds('listPurgeStreamSlugs', factIds);
  if (!ids.length) return [];
  return storeCall({ member: 'listPurgeStreamSlugs' }, () => brain.listPurgeStreamSlugs({ ids }));
};

export const deletePurgedFacts: Member<'deletePurgedFacts'> = async (brain, factIds, sourceId) => {
  const ids = wholeIds('deletePurgedFacts', factIds);
  if (!ids.length) return 0;
  return storeCall({ member: 'deletePurgedFacts', sourceId }, () => brain.deletePurgedFacts({ sourceId, ids }));
};

export const listPurgedPageRevisions: Member<'listPurgedPageRevisions'> = async (brain, sourceId, pageIds) => {
  const ids = wholeIds('listPurgedPageRevisions', pageIds);
  if (!ids.length) return [];
  return storeCall({ member: 'listPurgedPageRevisions', sourceId }, () => brain.listPurgedPageRevisions({ sourceId, ids }));
};

export const listPagesForPurgeRewrite: Member<'listPagesForPurgeRewrite'> = async (brain, sourceId, pageIds) => {
  const ids = wholeIds('listPagesForPurgeRewrite', pageIds);
  if (!ids.length) return [];
  const rows = await storeCall({ member: 'listPagesForPurgeRewrite', sourceId }, () => brain.listPagesForPurgeRewrite({ sourceId, ids }));
  return (rows as Array<Record<string, unknown>>).map(row => withDates(row, PAGE_DATES));
};

export const deletePurgedTakes: Member<'deletePurgedTakes'> = async (brain, takeIds) => {
  const ids = wholeIds('deletePurgedTakes', takeIds);
  if (!ids.length) return 0;
  return storeCall({ member: 'deletePurgedTakes' }, () => brain.deletePurgedTakes({ ids }));
};

export const deletePurgeTrustProposals: Member<'deletePurgeTrustProposals'> = async (brain, sourceId, factIds, takeIds) => {
  const facts = wholeIds('deletePurgeTrustProposals', factIds);
  const takes = wholeIds('deletePurgeTrustProposals', takeIds);
  return storeCall({ member: 'deletePurgeTrustProposals', sourceId }, () => brain.deletePurgeTrustProposals({ sourceId, factIds: facts, takeIds: takes }));
};

export const deletePurgeOpenLoops: Member<'deletePurgeOpenLoops'> = async (brain, sourceId, factIds) => {
  const ids = wholeIds('deletePurgeOpenLoops', factIds);
  return storeCall({ member: 'deletePurgeOpenLoops', sourceId }, () => brain.deletePurgeOpenLoops({ sourceId, ids }));
};

export const deletePurgeWriteGateHolds: Member<'deletePurgeWriteGateHolds'> = (brain, sourceId, factHash) =>
  storeCall({ member: 'deletePurgeWriteGateHolds', sourceId }, () => brain.deletePurgeWriteGateHolds({ sourceId, factHash }));

export const deletePurgeWriteGateReceipts: Member<'deletePurgeWriteGateReceipts'> = (brain, factIds, takeIds, holdIds) =>
  storeCall({ member: 'deletePurgeWriteGateReceipts' }, () =>
    brain.deletePurgeWriteGateReceipts({ factIds: [...factIds], takeIds: [...takeIds], holdIds: [...holdIds] }));

export const updatePageBodyForPurge: Member<'updatePageBodyForPurge'> = async (brain, sourceId, pageId, compiled, timeline, hash) => {
  const [id] = wholeIds('updatePageBodyForPurge', [pageId]);
  await storeCall({ member: 'updatePageBodyForPurge', sourceId }, () => brain.updatePageBodyForPurge({ sourceId, pageId: id, compiled, timeline, hash }));
};

export const setPurgeVersionBody: Member<'setPurgeVersionBody'> = async (brain, versionId, compiled, timeline) => {
  const [id] = wholeIds('setPurgeVersionBody', [versionId]);
  await storeCall({ member: 'setPurgeVersionBody' }, () => brain.setPurgeVersionBody({ versionId: id, compiled, timeline }));
};

export const redactVersionChangeReasons: Member<'redactVersionChangeReasons'> = async (brain, sourceId, needle, reasonNeedle) =>
  (await storeCall({ member: 'redactVersionChangeReasons', sourceId }, () => brain.redactVersionChangeReasons({ sourceId, needle, reasonNeedle })) as number[]).map(Number);

export const deletePurgedChunks: Member<'deletePurgedChunks'> = async (brain, pageIds) => {
  const ids = wholeIds('deletePurgedChunks', pageIds);
  if (!ids.length) return 0;
  return storeCall({ member: 'deletePurgedChunks' }, () => brain.deletePurgedChunks({ ids }));
};

export const expireDerivedFacts: Member<'expireDerivedFacts'> = async (brain, factIds, sourceId) => {
  const ids = wholeIds('expireDerivedFacts', factIds);
  if (!ids.length) return 0;
  return storeCall({ member: 'expireDerivedFacts', sourceId }, () => brain.expireDerivedFacts({ sourceId, ids }));
};

export const deactivateDerivedTakes: Member<'deactivateDerivedTakes'> = async (brain, takeIds, sourceId) => {
  const ids = wholeIds('deactivateDerivedTakes', takeIds);
  if (!ids.length) return 0;
  return storeCall({ member: 'deactivateDerivedTakes', sourceId }, () => brain.deactivateDerivedTakes({ sourceId, ids }));
};

export const softDeleteDerivedPages: Member<'softDeleteDerivedPages'> = async (brain, pageIds, sourceId) => {
  const ids = wholeIds('softDeleteDerivedPages', pageIds);
  if (!ids.length) return [];
  return storeCall({ member: 'softDeleteDerivedPages', sourceId }, () => brain.softDeleteDerivedPages({ sourceId, ids }));
};

export const findPurgeBlockedPublication: Member<'findPurgeBlockedPublication'> = (brain, sourceId, slugs, ownRequest) =>
  storeCall({ member: 'findPurgeBlockedPublication', sourceId }, () => brain.findPurgeBlockedPublication({ sourceId, slugs: [...slugs], ownRequest }));

/** The purge's three effects are the withdrawal effects' statement byte for byte (WITHDRAWAL_EFFECTS_SQL): the store's insertWithdrawalEffects. */
export const insertPurgeEffects: Member<'insertPurgeEffects'> = async (brain, requestId, sourceId, data) => {
  await storeCall({ member: 'insertPurgeEffects', sourceId }, () => brain.insertWithdrawalEffects({ requestId, sourceId, data }));
};

/*
 * Four purge statements answer without a store call: their tables have no typed writer, only an `executeRaw` INSERT,
 * which a Rust brain refuses, so the store keeps no such rows and the statement finds none (the listStagingPartEdges
 * pattern). fact-purge-members.test.ts pins each writer: a typed writer of one of these tables fails that case.
 */

/** page_body_staging_parts: written only by persistence/page-upload.ts appendPart (an executeRaw insert). */
export const deletePurgedStagingParts: Member<'deletePurgedStagingParts'> = async () => 0;

/** page_view_digests: written only by page-window/segmented.ts writeDigest (an executeRaw insert). */
export const deletePageViewDigests: Member<'deletePageViewDigests'> = async () => {};

/** take_proposals: written only by cycle/propose-takes.ts and cycle/propose-takes-failures.ts (executeRaw inserts). */
export const deletePurgeTakeProposals: Member<'deletePurgeTakeProposals'> = async () => 0;

/** core_edit_notices: written only by persistence/core-guard.ts prepareCoreGuard (an executeRaw insert). */
export const blankPurgeCoreEditNotices: Member<'blankPurgeCoreEditNotices'> = async () => 0;

/** The re-derive queue (generations/needs_rederive.rs); an empty id list writes nothing, as the SQL inserts no row. */
export const markNeedsRederive: Member<'markNeedsRederive'> = async (brain, table, ids, sourceId, requestId, reason, hiddenNow) => {
  if (!ids.length) return;
  await storeCall({ member: 'markNeedsRederive', sourceId }, () =>
    brain.markNeedsRederive({ table, ids: [...ids], sourceId, requestId, reason, hiddenNow: [...hiddenNow] }));
};

/** The segment-storage statements of a purge, served from page_body.rs. */
export const listSegmentedVersionsForPurge: Member<'listSegmentedVersionsForPurge'> = async (brain, sourceId, needle, pageIds, after) => {
  const ids = wholeIds('listSegmentedVersionsForPurge', pageIds);
  const [cursor] = wholeIds('listSegmentedVersionsForPurge', [after]);
  return storeCall({ member: 'listSegmentedVersionsForPurge', sourceId }, () =>
    brain.listSegmentedVersionsForPurge({ sourceId, needle, pageIds: ids, after: cursor }));
};

export const abortPurgedStagings: Member<'abortPurgedStagings'> = async (brain, stagingIds) => {
  if (!stagingIds.length) return [];
  return ((await storeCall({ member: 'abortPurgedStagings' }, () => brain.abortPurgedStagings([...stagingIds]))) as number[]).map(Number);
};

export const deleteUnreferencedPurgedTexts: Member<'deleteUnreferencedPurgedTexts'> = (brain, sourceId, replaced, claim) =>
  storeCall({ member: 'deleteUnreferencedPurgedTexts', sourceId }, () => brain.deleteUnreferencedPurgedTexts({ sourceId,
    replaced: replaced.map(sha => Buffer.from(sha).toString('hex')), claim: claim.toLowerCase(), fenced: escapeFenceCell(claim).toLowerCase() }));
