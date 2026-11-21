/**
 * Trust: the write gate's receipt and hold members (BrainEngine upsertWriteGateReceipt, upsertPageWriteGateReceipt,
 * deleteStalePageWriteGateReceipts, listWriteGateReceiptsFor, deleteStaleWriteGateReceipts, upsertWriteGateHold,
 * listWriteGateHoldRows, getWriteGateHoldRow, decideWriteGateHold), over
 * `rust/crates/gbrain-store/src/trust/write_gate.rs`. The store returns times as ISO text; these members turn them
 * into Dates, as the SQL engines return them (rust/docs/store/trust.md). `listTrustAllowRuleRows` reads the owner's allow
 * rules, which the store does not keep: `trust allow` adds them through raw SQL, which this engine refuses, so no Rust
 * brain holds one and the list is empty.
 */
import type { BrainEngine } from '../../engine.ts';
import type { WriteGateHoldRow, WriteGateReceiptRow } from '../../engine-sql/trust-write-gate.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const RECEIPT_DATES = ['created_at', 'last_seen_at'];
const HOLD_DATES = ['created_at', 'last_seen_at', 'decided_at'];
const toHoldRow = (row: Record<string, unknown>) => withDates(row, HOLD_DATES) as unknown as WriteGateHoldRow;

export const upsertWriteGateReceipt: Member<'upsertWriteGateReceipt'> = (brain, input) =>
  storeCall({ member: 'upsertWriteGateReceipt', sourceId: input.source_id ?? undefined }, () => brain.upsertWriteGateReceipt(input));

export const upsertPageWriteGateReceipt: Member<'upsertPageWriteGateReceipt'> = (brain, sourceId, slug, receipt) =>
  storeCall({ member: 'upsertPageWriteGateReceipt', sourceId, slug }, () => brain.upsertPageWriteGateReceipt(sourceId, slug, receipt));

export const deleteStalePageWriteGateReceipts: Member<'deleteStalePageWriteGateReceipts'> = async (brain, sourceId, slug, contentHash) => {
  await storeCall({ member: 'deleteStalePageWriteGateReceipts', sourceId, slug },
    () => brain.deleteStalePageWriteGateReceipts(sourceId, slug, contentHash ?? null));
};

export const listWriteGateReceiptsFor: Member<'listWriteGateReceiptsFor'> = async (brain, targetTable, targetId, limit) => {
  const rows: Record<string, unknown>[] = await storeCall({ member: 'listWriteGateReceiptsFor' },
    () => brain.listWriteGateReceiptsFor(targetTable, targetId, limit));
  return rows.map(row => withDates(row, RECEIPT_DATES) as unknown as WriteGateReceiptRow);
};

export const deleteStaleWriteGateReceipts: Member<'deleteStaleWriteGateReceipts'> = (brain, olderThanDays) =>
  storeCall({ member: 'deleteStaleWriteGateReceipts' }, () => brain.deleteStaleWriteGateReceipts(olderThanDays));

export const upsertWriteGateHold: Member<'upsertWriteGateHold'> = (brain, input) =>
  storeCall({ member: 'upsertWriteGateHold', sourceId: input.source_id, slug: input.slug }, () => brain.upsertWriteGateHold(input));

export const listWriteGateHoldRows: Member<'listWriteGateHoldRows'> = async (brain, opts) => {
  const rows: Record<string, unknown>[] = await storeCall({ member: 'listWriteGateHoldRows', sourceId: opts.sourceId },
    () => brain.listWriteGateHoldRows(opts));
  return rows.map(toHoldRow);
};

export const getWriteGateHoldRow: Member<'getWriteGateHoldRow'> = async (brain, id) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'getWriteGateHoldRow' }, () => brain.getWriteGateHoldRow(id));
  return row ? toHoldRow(row) : null;
};

export const decideWriteGateHold: Member<'decideWriteGateHold'> = (brain, id, status, decidedBy) =>
  storeCall({ member: 'decideWriteGateHold' }, () => brain.decideWriteGateHold(id, status, decidedBy));

/** The store keeps no allow rules (`trust allow` writes them through raw SQL, refused here), so none is listed. */
export const listTrustAllowRuleRows: Member<'listTrustAllowRuleRows'> = async () => [];
