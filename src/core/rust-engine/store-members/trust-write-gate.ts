/**
 * Trust: the write gate's receipt and hold members (BrainEngine upsertWriteGateReceipt, upsertPageWriteGateReceipt,
 * deleteStalePageWriteGateReceipts, listWriteGateReceiptsFor, deleteStaleWriteGateReceipts, upsertWriteGateHold,
 * listWriteGateHoldRows, getWriteGateHoldRow, decideWriteGateHold), over
 * `rust/crates/gbrain-store/src/trust/write_gate.rs`. The store returns times as ISO text; these members turn them
 * into Dates, as the SQL engines return them (rust/docs/store/trust.md). The owner's allow rules (`trust allow`:
 * addTrustAllowRule, removeTrustAllowRule, readTrustAllowRule, listTrustAllowRuleRows) are served from
 * `trust/allow_rules.rs`. A rule id that is not a whole number fails as Postgres fails the bigint cast (22P02); a whole id
 * below 1 names no rule, so it answers null without a store call.
 */
import type { BrainEngine } from '../../engine.ts';
import type { WriteGateHoldRow, WriteGateReceiptRow } from '../../engine-sql/trust-write-gate.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const RECEIPT_DATES = ['created_at', 'last_seen_at'];
const HOLD_DATES = ['created_at', 'last_seen_at', 'decided_at'];
// The Rust store keeps holds by slug only (the hold-by-page-id contract of master #10200 is a named swap row: a Rust hold does not follow its
// page through a rename), so its rows carry no page binding.
const toHoldRow = (row: Record<string, unknown>) => ({ page_id: null, page_candidates: null, ...withDates(row, HOLD_DATES) }) as unknown as WriteGateHoldRow;

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
  storeCall({ member: 'upsertWriteGateHold', sourceId: input.source_id, slug: input.slug }, () => brain.upsertWriteGateHold((({ page_id: _page, ...rest }) => rest)(input)));

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

const RULE_DATES = ['created_at', 'removed_at'];
const toRule = (row: unknown): Record<string, unknown> | null =>
  row === null || row === undefined ? null : withDates(row as Record<string, unknown>, RULE_DATES);

/** A rule id as Postgres binds it to `bigint`: a fraction or a non-number fails the cast; `false` for a whole id below 1. */
function ruleId(id: number): boolean {
  if (!Number.isSafeInteger(id)) throw Object.assign(new Error(`invalid input syntax for type bigint: "${String(id)}"`), { code: '22P02' });
  return id >= 1;
}

export const listTrustAllowRuleRows: Member<'listTrustAllowRuleRows'> = async (brain, opts = {}) => {
  const rows = await storeCall({ member: 'listTrustAllowRuleRows' }, () => brain.listTrustAllowRules({
    sourceIds: opts.sourceIds?.length ? opts.sourceIds : null, includeRemoved: opts.includeRemoved === true })) as unknown[];
  return rows.map(row => toRule(row)!);
};

export const addTrustAllowRule: Member<'addTrustAllowRule'> = async (brain, rule) => {
  const out = await storeCall({ member: 'addTrustAllowRule', sourceId: rule.sourceId }, () => brain.addTrustAllowRule({
    sourceId: rule.sourceId, uriPrefix: rule.uriPrefix, reasonFamily: rule.reasonFamily, createdBy: rule.createdBy, reason: rule.reason,
  })) as { source_active: boolean; row: unknown; created: boolean };
  return { source_active: out.source_active, row: toRule(out.row), created: out.created };
};

export const removeTrustAllowRule: Member<'removeTrustAllowRule'> = async (brain, id, removedBy) =>
  ruleId(id) ? toRule(await storeCall({ member: 'removeTrustAllowRule' }, () => brain.removeTrustAllowRule(id, removedBy))) : null;

export const readTrustAllowRule: Member<'readTrustAllowRule'> = async (brain, id) =>
  ruleId(id) ? toRule(await storeCall({ member: 'readTrustAllowRule' }, () => brain.readTrustAllowRule(id))) : null;
