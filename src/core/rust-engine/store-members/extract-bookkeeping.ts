/**
 * The extract bookkeeping members (BrainEngine upsertExtractRollup, readExtractReceiptPrior, readExtractReceiptSealed;
 * SQL in engine-sql/extract-bookkeeping.ts). The receipt reads are served from the store's page records
 * (rust/crates/gbrain-store/src/cli_reads/extract_receipt.rs, rust/docs/store/sweep-reads.md).
 *
 * `upsertExtractRollup` adds the event to the store's `extract_rollup_7d` row of its (kind, source, day)
 * (rust/crates/gbrain-store/src/facts/extract_rollup.rs, rust/docs/store/facts.md). `form` picks the statement of a
 * brain behind migration v141, as in Postgres. The rollup is a best-effort cache on every engine; its caller records a
 * failed write and goes on.
 */
import type { ExtractReceiptPriorRow, ExtractRollupRow } from '../../engine-sql/extract-bookkeeping.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../search/safe-chunks.ts';
import { storeCall, type StoreMember } from './common.ts';

export const upsertExtractRollup: StoreMember<[row: ExtractRollupRow, form?: 'pre_v141'], void> = async (brain, row, form) => {
  await storeCall({ member: 'upsertExtractRollup', sourceId: row.sourceId }, () =>
    brain.upsertExtractRollup({ ...row, form: form ?? null }));
};

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
