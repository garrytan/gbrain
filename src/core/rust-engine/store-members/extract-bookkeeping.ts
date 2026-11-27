/**
 * Extract bookkeeping writes (engine-sql/extract-bookkeeping.ts), served by the store (gbrain-store
 * extract_bookkeeping.rs; rust/docs/store/extract-bookkeeping.md): the receipt write's two page reads and the
 * `extract_rollup_7d` day upsert (store A 0x0A).
 *
 * The store keeps no withheld origin, so a slot's `withheld_source_path` is always null. Its schema is current, so
 * the pre-v141 upsert is never needed and refuses. A count that is not a 32-bit integer refuses, as the SQL's `int`
 * parameters refuse it.
 */
import type { ExtractReceiptSlot, ExtractRollupDelta } from '../../engine-sql/extract-bookkeeping.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const COUNTS = ['halt_count', 'eval_fail_count', 'eval_pass_count', 'round_completed_count', 'expected_limit_count', 'rollup_write_failures'] as const;

export const readExtractReceiptSlot: StoreMember<[sourceId: string, slug: string], ExtractReceiptSlot | null> = async (brain, sourceId, slug) =>
  (await storeCall({ member: 'readExtractReceiptSlot', sourceId }, () => brain.readExtractReceiptSlot(sourceId, slug))) ?? null;

export const readExtractReceiptSeal: StoreMember<[sourceId: string, slug: string, safeVersion: number], boolean | null> =
  async (brain, sourceId, slug, safeVersion) =>
    (await storeCall({ member: 'readExtractReceiptSeal', sourceId }, () => brain.readExtractReceiptSeal(sourceId, slug, safeVersion))) ?? null;

export const upsertExtractRollupDay: StoreMember<[d: ExtractRollupDelta, opts?: { preV141?: boolean }], void> = async (brain, d, opts) => {
  if (opts?.preV141) refuseMember('upsertExtractRollupDay', 'the pre-v141 rollup statement (the store schema is current)');
  for (const k of COUNTS) {
    if (!Number.isInteger(d[k]) || d[k] < -2147483648 || d[k] > 2147483647) refuseMember('upsertExtractRollupDay', `a ${k} that is not a 32-bit integer`);
  }
  const delta = {
    kind: d.kind, sourceId: d.source_id, day: d.day, costUsd: d.cost_usd, haltCount: d.halt_count, evalFailCount: d.eval_fail_count,
    evalPassCount: d.eval_pass_count, roundCompletedCount: d.round_completed_count, expectedLimitCount: d.expected_limit_count,
    rollupWriteFailures: d.rollup_write_failures, haltReason: d.halt_reason,
  };
  await storeCall({ member: 'upsertExtractRollupDay', sourceId: d.source_id }, () => brain.upsertExtractRollupDay(delta));
};
