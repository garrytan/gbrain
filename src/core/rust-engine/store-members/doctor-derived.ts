/**
 * Doctor reads, second set (src/core/engine-sql/doctor-derived.ts), on the Rust engine. Two kinds of member:
 *  - served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs,
 *    doctor_derived_health.rs and doctor_derived_ledgers.rs, rust/docs/store/cli-reads-doctor-derived.md);
 *  - answered empty with no store call, because the store keeps no writer for the relation the statement reads
 *    (`page_extraction_state`, `page_embedding_budget`, `derived_generations`, `derived_generation_items`,
 *    `derived_generation_activations`, `belief_events`, `extract_rollup_7d`): no Rust brain ever holds a row there, so
 *    the empty answer is the one PGLite gives a brain that never wrote one.
 * Every member of `DOCTOR_DERIVED_MEMBERS` is one of the two; none is left to refuse with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

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
export const listExtractionInputReceipts: Member<'listExtractionInputReceipts'> = async (brain) =>
  storeCall({ member: 'listExtractionInputReceipts' }, () => brain.listExtractionInputReceipts());
export const listUnpricedDerivationModels: Member<'listUnpricedDerivationModels'> = async (brain) =>
  storeCall({ member: 'listUnpricedDerivationModels' }, () => brain.listUnpricedDerivationModels());

/** Belief ledger rows: the store keeps no `belief_events`, so no source is a recorded one and no tombstone is listed. */
export const listRecordedTombstones: Member<'listRecordedTombstones'> = async () => [];
/** Page embedding budget rows: the store keeps no `page_embedding_budget`, so no page is held or capped. */
export const listBudgetLimitedRows: Member<'listBudgetLimitedRows'> = async () => [];
/** The same table: no hold exists, so none is stale (the aggregate over no rows is 0 and a null oldest). */
export const readBudgetHoldAge: Member<'readBudgetHoldAge'> = async () => ({ stale: 0, oldest: null });
/** Page extraction state: the store keeps no `page_extraction_state`, so no page is held for an undetected format. */
export const listAmbiguousExtractionInputs: Member<'listAmbiguousExtractionInputs'> = async () => [];
/** Derived generations and their ledger: the store keeps none, so no retirement is ledger-covered. */
export const countLedgerCoveredAtomRetirements: Member<'countLedgerCoveredAtomRetirements'> = async () => 0;
export const listLiveGenerationRetirements: Member<'listLiveGenerationRetirements'> = async () => [];
export const listHeldGenerations: Member<'listHeldGenerations'> = async () => [];
export const listOrphanGenerationCandidates: Member<'listOrphanGenerationCandidates'> = async () => [];
/** The 7-day extract rollup: the store keeps no `extract_rollup_7d`, so no kind has a rollup row or a recorded halt reason. */
export const readExtractRollup7d: Member<'readExtractRollup7d'> = async () => [];
export const listRecordedHaltReasons7d: Member<'listRecordedHaltReasons7d'> = async () => [];
/** One kind's rollup aggregate: with no row for the kind, SUM and MAX over nothing are null, as the SQL engines answer. */
export const readExtractKindRollup7d: Member<'readExtractKindRollup7d'> = async () => ({
  cost_7d_usd: null, eval_pass_count: null, eval_fail_count: null, halt_count: null, round_completed_count: null, last_updated_at: null });
