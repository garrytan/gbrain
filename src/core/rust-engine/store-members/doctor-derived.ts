/**
 * Doctor reads, second set (src/core/engine-sql/doctor-derived.ts), on the Rust engine. Two kinds of member:
 *  - served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs,
 *    doctor_derived_health.rs and doctor_derived_ledgers.rs; the budget holds from embeddings.rs;
 *    rust/docs/store/cli-reads-doctor-derived.md);
 *  - answered empty with no store call, because the store keeps no writer for the relation the statement reads
 *    (`derived_generations`, `derived_generation_items`,
 *    `derived_generation_activations`, `belief_events`, `extract_rollup_7d`): no Rust brain ever holds a row there, so
 *    the empty answer is the one PGLite gives a brain that never wrote one.
 * Every member of `DOCTOR_DERIVED_MEMBERS` is one of the two; none is left to refuse with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { withEmbeddingColumn } from '../../engine-sql/doctor-derived.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// ---- served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs) ----------------------

export const countSafeIndexPending: Member<'countSafeIndexPending'> = async (brain, sourceIds) =>
  storeCall({ member: 'countSafeIndexPending' }, () => brain.countSafeIndexPending(sourceIds ?? null));
export const countPagesByTypeAndOwner: Member<'countPagesByTypeAndOwner'> = async (brain, sourceIds) =>
  storeCall({ member: 'countPagesByTypeAndOwner' }, () => brain.countPagesByTypeAndOwner(sourceIds ?? null));
export const listImageAssetFiles: Member<'listImageAssetFiles'> = async (brain) =>
  storeCall({ member: 'listImageAssetFiles' }, () => brain.listImageAssetFiles());
export const listRestorableAtomRetirements: Member<'listRestorableAtomRetirements'> = async (brain, sourceIds) =>
  storeCall({ member: 'listRestorableAtomRetirements' }, () => brain.listRestorableAtomRetirements(sourceIds));
export const listTimelineHistoryBatch: Member<'listTimelineHistoryBatch'> = async (brain, sourceIds, afterId) =>
  storeCall({ member: 'listTimelineHistoryBatch' }, () => brain.listTimelineHistoryBatch(sourceIds, afterId));
export const readPageCompiledTruths: Member<'readPageCompiledTruths'> = async (brain, ids) =>
  storeCall({ member: 'readPageCompiledTruths' }, () => brain.readPageCompiledTruths(ids));
// ---- served from the store's records (cli_reads/doctor_derived_health.rs, doctor_derived_ledgers.rs) ---------------

/** The one aggregate row; the store holds one vector column, so `column` names it. */
export const readEmbeddingBacklogAge: Member<'readEmbeddingBacklogAge'> = async (brain, column) =>
  storeCall({ member: 'readEmbeddingBacklogAge' }, () => brain.readEmbeddingBacklogAge(column));
/** The unchanged-body recheck (engine-sql/doctor-derived.ts listBodyRecheckGroups, readBodyRecheckPage, listBodyRecheckVersions). */
export const listBodyRecheckGroups: Member<'listBodyRecheckGroups'> = async (brain) =>
  storeCall({ member: 'listBodyRecheckGroups' }, () => brain.listBodyRecheckGroups());
export const readBodyRecheckPage: Member<'readBodyRecheckPage'> = async (brain, pageId) =>
  storeCall({ member: 'readBodyRecheckPage' }, () => brain.readBodyRecheckPage(Number(pageId)));
export const listBodyRecheckVersions: Member<'listBodyRecheckVersions'> = async (brain, pageId) =>
  storeCall({ member: 'listBodyRecheckVersions' }, () => brain.listBodyRecheckVersions(Number(pageId)));
export const readAtomProvenanceCounts: Member<'readAtomProvenanceCounts'> = async (brain) =>
  storeCall({ member: 'readAtomProvenanceCounts' }, () => brain.readAtomProvenanceCounts());
export const countCredentialProjectionPending: Member<'countCredentialProjectionPending'> = async (brain, sourceIds) =>
  storeCall({ member: 'countCredentialProjectionPending' }, () => brain.countCredentialProjectionPending(sourceIds ?? null));
/** The statement deadline (`timeoutMs`) bounds a SQL scan; the store answers from one snapshot with no cancellation point. */
export const readIgnoredPrivacyLabelCounts: Member<'readIgnoredPrivacyLabelCounts'> = async (brain, opts) =>
  storeCall({ member: 'readIgnoredPrivacyLabelCounts' }, () => brain.readIgnoredPrivacyLabelCounts(opts.sourceIds ?? null));
export const countDerivedVisibility: Member<'countDerivedVisibility'> = async (brain, sourceIds) =>
  storeCall({ member: 'countDerivedVisibility' }, () => brain.countDerivedVisibility(sourceIds));
export const listUntiledSegmentedPageRows: Member<'listUntiledSegmentedPageRows'> = async (brain, sourceIds, slugs, limit) =>
  storeCall({ member: 'listUntiledSegmentedPageRows' }, () =>
    brain.listUntiledSegmentedPageRows(sourceIds ? [...sourceIds] : null, slugs ? [...slugs] : null, limit));
export const listAmbiguousExtractionInputs: Member<'listAmbiguousExtractionInputs'> = async (brain) =>
  storeCall({ member: 'listAmbiguousExtractionInputs' }, () => brain.listAmbiguousExtractionInputs());
export const listExtractionInputReceipts: Member<'listExtractionInputReceipts'> = async (brain) =>
  storeCall({ member: 'listExtractionInputReceipts' }, () => brain.listExtractionInputReceipts());
export const listUnpricedDerivationModels: Member<'listUnpricedDerivationModels'> = async (brain) =>
  storeCall({ member: 'listUnpricedDerivationModels' }, () => brain.listUnpricedDerivationModels());

/** Belief ledger rows: the store keeps no `belief_events`, so no source is a recorded one and no tombstone is listed. */
export const listRecordedTombstones: Member<'listRecordedTombstones'> = async () => [];
/**
 * Held and capped large pages with chunks still waiting, by source, state and reason, from the store's budget ledger,
 * pages and chunks. The column name is checked as the SQL engines check it (`withEmbeddingColumn`); the store keeps one
 * vector per chunk, so it reads whether that vector is there.
 */
export const listBudgetLimitedRows: Member<'listBudgetLimitedRows'> = async (brain, opts) => {
  withEmbeddingColumn('"__COL__"', opts.column);
  return storeCall({ member: 'listBudgetLimitedRows' }, () => brain.listBudgetLimitedRows(opts.sourceId ?? null, opts.signature ?? null));
};
/** Of the same holds (chunks or not), how many were last updated over a day ago, and the oldest update time (ISO text). */
export const readBudgetHoldAge: Member<'readBudgetHoldAge'> = async (brain) =>
  storeCall({ member: 'readBudgetHoldAge' }, () => brain.readBudgetHoldAge());
/** Derived generations and their ledger: the store keeps none, so no retirement is ledger-covered. */
export const countLedgerCoveredAtomRetirements: Member<'countLedgerCoveredAtomRetirements'> = async () => 0;
/** The live generations that retired items inside the restore window, and the held generations: served from the ledger (generations/doctor_reads.rs). */
export const listLiveGenerationRetirements: Member<'listLiveGenerationRetirements'> = async (brain, sourceIds, restoreDays) =>
  storeCall({ member: 'listLiveGenerationRetirements' }, () => brain.listLiveGenerationRetirements([...sourceIds], restoreDays));
export const listHeldGenerations: Member<'listHeldGenerations'> = async (brain, sourceIds) =>
  storeCall({ member: 'listHeldGenerations' }, () => brain.listHeldGenerations([...sourceIds]));
export const listOrphanGenerationCandidates: Member<'listOrphanGenerationCandidates'> = async () => [];
/** The 7-day extract rollup: the store keeps no `extract_rollup_7d`, so no kind has a rollup row or a recorded halt reason. */
export const readExtractRollup7d: Member<'readExtractRollup7d'> = async () => [];
export const listRecordedHaltReasons7d: Member<'listRecordedHaltReasons7d'> = async () => [];
/** One kind's rollup aggregate: with no row for the kind, SUM and MAX over nothing are null, as the SQL engines answer. */
export const readExtractKindRollup7d: Member<'readExtractKindRollup7d'> = async () => ({
  cost_7d_usd: null, eval_pass_count: null, eval_fail_count: null, halt_count: null, round_completed_count: null, last_updated_at: null });
