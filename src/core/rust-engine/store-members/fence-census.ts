/**
 * The fence census members (src/core/engine-sql/fence-census.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_fence.rs, rust/docs/store/cli-reads-doctor-fence.md).
 *
 * Every member but the trend and budget ledger reads is served from the store: the sources and pages the census scans, and the census's own
 * `op_checkpoints` rows (the scan record and the candidate parts), which the store writes in its housekeeping key space.
 * The trend rows (`fence-trend`) are written only by the sync and page-write paths through `executeRaw`, which a Rust
 * brain refuses, so none exists: the trend read answers `[]` without a call. The census reads sync holds through
 * `readGitHoldRecords` (store-members/sync-hold-store.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listFenceCensusSources: Member<'listFenceCensusSources'> = (brain, sourceIds) =>
  storeCall({ member: 'listFenceCensusSources' }, () => brain.listFenceCensusSources({ sourceIds: sourceIds ? [...sourceIds] : null }));

export const readFencePassHorizon: Member<'readFencePassHorizon'> = (brain, graceMs) =>
  storeCall({ member: 'readFencePassHorizon' }, () => brain.readFencePassHorizon({ graceMs: Math.max(0, Math.floor(graceMs)) }));

export const listFenceCensusPagesById: Member<'listFenceCensusPagesById'> = (brain, sourceId, afterId, limit) =>
  storeCall({ member: 'listFenceCensusPagesById' }, () => brain.listFenceCensusPages({ sourceId, mode: 'id', afterId, limit }));

export const listFenceCensusPagesUpdated: Member<'listFenceCensusPagesUpdated'> = (brain, sourceId, lower, after, limit) =>
  storeCall({ member: 'listFenceCensusPagesUpdated' }, () => brain.listFenceCensusPages({ sourceId, mode: 'updated', lower, after, limit }));

export const listLiveFencePageIds: Member<'listLiveFencePageIds'> = async (brain, pageIds) => {
  if (!pageIds.length) return [];
  const ids = (await storeCall({ member: 'listLiveFencePageIds' }, () => brain.listLiveFencePageIds({ pageIds: [...pageIds] }))) as unknown[];
  return ids.map(Number);
};

export const readFenceScanRecord: Member<'readFenceScanRecord'> = (brain, op, fingerprint) =>
  storeCall({ member: 'readFenceScanRecord' }, async () => (await brain.readFenceCheckpointRecord({ op, fingerprint })) ?? null);

export const writeFenceScanRecord: Member<'writeFenceScanRecord'> = async (brain, op, fingerprint, record) => {
  await storeCall({ member: 'writeFenceScanRecord' }, () => brain.writeFenceScanRecord({ op, fingerprint, record }));
};

export const upsertFenceCandidatePart: Member<'upsertFenceCandidatePart'> = async (brain, op, fingerprint, ids, part, finding) => {
  await storeCall({ member: 'upsertFenceCandidatePart' }, () =>
    brain.upsertFenceCandidatePart({ op, fingerprint, sourceId: ids.sourceId, incarnation: ids.incarnation, key: ids.key, part, finding }));
};

export const clearFenceCandidateParts: Member<'clearFenceCandidateParts'> = async (brain, op, fingerprints, part) => {
  if (!fingerprints.length) return;
  await storeCall({ member: 'clearFenceCandidateParts' }, () => brain.clearFenceCandidateParts({ op, fingerprints: [...fingerprints], part }));
};

export const readFenceTrendRecords: Member<'readFenceTrendRecords'> = async () => [];

export const countSegmentedFencePages: Member<'countSegmentedFencePages'> = (brain, sourceIds, walkedSourceIds) =>
  storeCall({ member: 'countSegmentedFencePages' }, async () =>
    Number(await brain.countSegmentedFencePages({ sourceIds: [...sourceIds], walkedSourceIds: [...walkedSourceIds] })));


/** The daily budget ledger is written by the spend reservations through `executeRaw`, which a Rust brain refuses, so no ledger row exists. */
export const readBudgetLedgerDay: Member<'readBudgetLedgerDay'> = async () => null;
