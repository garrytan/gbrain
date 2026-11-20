/**
 * The extract bookkeeping members (BrainEngine upsertExtractRollup, readExtractReceiptPrior, readExtractReceiptSealed;
 * SQL in engine-sql/extract-bookkeeping.ts). The receipt reads are served from the store's page records
 * (rust/crates/gbrain-store/src/cli_reads/extract_receipt.rs, rust/docs/store/sweep-reads.md).
 *
 * `upsertExtractRollup` writes nothing and resolves: the store keeps no `extract_rollup_7d` rows yet, so doctor's
 * extract_health reads no rollup rows on this engine (a known difference, rust/docs/store/sweep-reads.md). The rollup is
 * a best-effort cache on every engine; its caller records a failed write and goes on.
 */
import type { ExtractReceiptPriorRow, ExtractRollupRow } from '../../engine-sql/extract-bookkeeping.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../search/safe-chunks.ts';
import { storeCall, type StoreMember } from './common.ts';

export const upsertExtractRollup: StoreMember<[row: ExtractRollupRow, form?: 'pre_v141'], void> = async () => {};

export const readExtractReceiptPrior: StoreMember<[sourceId: string, slug: string], ExtractReceiptPriorRow | undefined> = async (brain, sourceId, slug) => {
  const row: ExtractReceiptPriorRow | null = await storeCall({ member: 'readExtractReceiptPrior', sourceId }, () =>
    brain.readExtractReceiptPrior({ sourceId, slug }));
  return row ?? undefined;
};

export const readExtractReceiptSealed: StoreMember<[sourceId: string, slug: string], { sealed: boolean | null } | undefined> = async (brain, sourceId, slug) => {
  const row: { sealed: boolean | null } | null = await storeCall({ member: 'readExtractReceiptSealed', sourceId }, () =>
    brain.readExtractReceiptSealed({ sourceId, slug, safeVersion: SAFE_FENCE_CHUNKER_VERSION }));
  return row ?? undefined;
};
