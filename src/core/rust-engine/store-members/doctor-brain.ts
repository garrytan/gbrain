/**
 * Doctor brain reads (src/core/engine-sql/doctor-brain.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_brain.rs, rust/docs/store/cli-reads-doctor-brain.md).
 *
 * Served from the store: the interim stored-object count, the oldest source timestamp, the brain maturity row, the
 * visibility candidate pages (all read pages, tags, facts and sources the store keeps) and the failed requests blocked
 * managed-sync cursors wait on (the checkpoint and request records, persistence/diagnostic_checkpoints.rs).
 *
 * the git holds of one non-canonical spelling and the pages with a misspelled readers key.
 *
 * Empty: the receipts of one admitted pass answer the empty value without a store call (see
 * rust/docs/store/cli-reads-doctor-brain.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The git holds of one non-canonical spelling, of unarchived sources at their incarnation (persistence/diagnostic_checkpoints.rs). */
export const countVisibilityNoncanonicalHolds: Member<'countVisibilityNoncanonicalHolds'> = async (brain, holdOp, sourceIds) =>
  Number(await storeCall({ member: 'countVisibilityNoncanonicalHolds' }, () => brain.countNoncanonicalHolds(holdOp, 'visibility_noncanonical', sourceIds ? [...sourceIds] : null)));
export const countReadersNoncanonicalHolds: Member<'countReadersNoncanonicalHolds'> = async (brain, holdOp, sourceIds) =>
  Number(await storeCall({ member: 'countReadersNoncanonicalHolds' }, () => brain.countNoncanonicalHolds(holdOp, 'readers_noncanonical', sourceIds ? [...sourceIds] : null)));
/** The failed request each unfinished managed-sync cursor waits on (persistence/diagnostic_checkpoints.rs). */
export const listContentBlockedReceipts: Member<'listContentBlockedReceipts'> = async (brain) =>
  await storeCall({ member: 'listContentBlockedReceipts' }, () => brain.listContentBlockedReceipts()) as Awaited<ReturnType<BrainEngine['listContentBlockedReceipts']>>;
export const listPassAdmittedReceipts: Member<'listPassAdmittedReceipts'> = async () => [];
export const listInterimStoredObjectCounts: Member<'listInterimStoredObjectCounts'> = (brain, type, shelfSourceId, prefix, adoptedTag) =>
  storeCall({ member: 'listInterimStoredObjectCounts' }, () => brain.listInterimStoredObjectCounts({ type, shelfSourceId, prefix, adoptedTag }));

export const readOldestSourceCreatedAt: Member<'readOldestSourceCreatedAt'> = async (brain) =>
  (await storeCall({ member: 'readOldestSourceCreatedAt' }, () => brain.readOldestSourceCreatedAt())) ?? null;

export const listVisibilityCandidatePages: Member<'listVisibilityCandidatePages'> = (brain, sourceIds) =>
  storeCall({ member: 'listVisibilityCandidatePages' }, () => brain.listVisibilityCandidatePages(sourceIds ? [...sourceIds] : null));

/** Live pages with a misspelled `readable_by` key, by source then slug in byte order (cli_reads/doctor_brain.rs). */
export const listReaderCandidatePages: Member<'listReaderCandidatePages'> = (brain, sourceIds) =>
  storeCall({ member: 'listReaderCandidatePages' }, () => brain.listReaderCandidatePages(sourceIds ? [...sourceIds] : null));
