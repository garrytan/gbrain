/**
 * Doctor reads, second set (src/core/engine-sql/doctor-derived.ts), on the Rust engine. Three kinds of member:
 *  - served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs,
 *    rust/docs/store/cli-reads-doctor-derived.md);
 *  - answered empty with no store call, because the store keeps no writer for the relation the statement reads
 *    (`page_extraction_state`, `derived_generations`, `derived_generation_items`, `derived_generation_activations`,
 *    `belief_events`, `extract_rollup_7d`): no Rust brain ever holds a row there, so the empty answer is the one PGLite
 *    gives a brain that never wrote one;
 *  - not listed in STORE_MEMBERS, so they refuse with `engine_capability_missing` (TODOS.md, "Rust engine lane 14 follow-ups").
 *    `listBudgetLimitedRows` and `readBudgetHoldAge` are of this kind: a Rust brain can hold large pages, so an empty
 *    `page_embedding_budget` answer would report "nothing held" without reading anything.
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
/** The statement deadline (`timeoutMs`) bounds a SQL scan; the store answers from one snapshot with no cancellation point. */
export const listAtomFenceCandidates: Member<'listAtomFenceCandidates'> = async (brain, opts) =>
  storeCall({ member: 'listAtomFenceCandidates' }, () =>
    brain.listAtomFenceCandidates({ sourceIds: opts.sourceIds, atomId: opts.atomId, after: opts.after, limit: opts.limit }));

/** Belief ledger rows: the store keeps no `belief_events`, so no source is a recorded one and no tombstone is listed. */
export const listRecordedTombstones: Member<'listRecordedTombstones'> = async () => [];
/** Page extraction state: the store keeps no `page_extraction_state`, so no page is held for an undetected format. */
export const listAmbiguousExtractionInputs: Member<'listAmbiguousExtractionInputs'> = async () => [];
/** Derived generations and their ledger: the store keeps none, so no retirement is ledger-covered. */
export const countLedgerCoveredAtomRetirements: Member<'countLedgerCoveredAtomRetirements'> = async () => 0;
export const listLiveGenerationRetirements: Member<'listLiveGenerationRetirements'> = async () => [];
export const listHeldGenerations: Member<'listHeldGenerations'> = async () => [];
export const listPendingGenerationMembers: Member<'listPendingGenerationMembers'> = async () => [];
export const listOrphanGenerationCandidates: Member<'listOrphanGenerationCandidates'> = async () => [];
/** The 7-day extract rollup: the store keeps no `extract_rollup_7d`, so no kind has a rollup row or a recorded halt reason. */
export const readExtractRollup7d: Member<'readExtractRollup7d'> = async () => [];
export const listRecordedHaltReasons7d: Member<'listRecordedHaltReasons7d'> = async () => [];
