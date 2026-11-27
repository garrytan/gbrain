/**
 * The memory-trust evals' harness reads (src/core/engine-sql/eval-harness-reads.ts) on the Rust engine, served from
 * the store (rust/crates/gbrain-store/src/eval_harness_reads.rs, rust/docs/store/eval-harness-reads.md). getFactsByIds
 * and findLiveFactsByText read the fact rows; listPageIdSlugs reads every page row, a soft-deleted one included. An id
 * that is not a safe integer refuses rather than guess at the `bigint[]` cast. hasTable, hasColumn,
 * listTextBearingColumns and scanTextColumns answer from the store's records (gbrain-store `eval_harness_catalog`): the
 * SQL tables it maps keep their names; every other record is named by its keyspace.
 */
import type { BrainEngine } from '../../engine.ts';
import { assertCurrentPauseToken, type FactStateRow, type ManagedPausePrior, type PageIdSlugRow, type TextColumnRow, type TextScanHit } from '../../engine-sql/eval-harness-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));

export const getFactsByIds: Member<'getFactsByIds'> = async (brain, ids) => {
  if (ids.some((id) => !Number.isSafeInteger(id))) refuseMember('getFactsByIds', 'an id that is not a safe integer');
  if (!ids.length) return [];
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'getFactsByIds' }, () => brain.getFactsByIds({ ids: [...ids] }));
  return rows.map((r): FactStateRow => ({
    id: Number(r.id), source_id: String(r.source_id), fact: String(r.fact), entity_slug: (r.entity_slug as string | null) ?? null,
    expired_at: toDate(r.expired_at), superseded_by: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
  }));
};

export const findLiveFactsByText: Member<'findLiveFactsByText'> = async (brain, sourceId, texts) => {
  if (!texts.length) return [];
  const rows: Array<{ id: number | string; fact: string }> = await storeCall({ member: 'findLiveFactsByText' }, () => brain.findLiveFactsByText({ sourceId, texts: [...texts] }));
  return rows.map((r) => ({ id: Number(r.id), fact: r.fact }));
};

export const listPageIdSlugs: Member<'listPageIdSlugs'> = async (brain) => {
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listPageIdSlugs' }, () => brain.listPageIdSlugs());
  return rows.map((r): PageIdSlugRow => ({ id: Number(r.id), slug: String(r.slug), source_id: String(r.source_id), deleted_at: toDate(r.deleted_at) }));
};

export const hasTable: Member<'hasTable'> = (brain, name) =>
  storeCall({ member: 'hasTable' }, () => brain.hasTable({ table: name }));

export const hasColumn: Member<'hasColumn'> = (brain, table, column) =>
  storeCall({ member: 'hasColumn' }, () => brain.hasColumn({ table, column }));

export const listTextBearingColumns: Member<'listTextBearingColumns'> = (brain) =>
  storeCall<TextColumnRow[]>({ member: 'listTextBearingColumns' }, () => brain.listTextBearingColumns());

export const scanTextColumns: Member<'scanTextColumns'> = async (brain, spec) => {
  if (spec.limit !== undefined && !(Number.isSafeInteger(spec.limit) && spec.limit >= 0)) refuseMember('scanTextColumns', 'a limit that is not a whole number');
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'scanTextColumns' }, () => brain.scanTextColumns({
    pattern: spec.pattern, activeOnly: spec.activeOnly, ...(spec.tables ? { tables: [...spec.tables] } : {}), ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
  }));
  return rows.map((r): TextScanHit => ({ table: String(r.table), column: String(r.column), slug: (r.slug as string | null) ?? null,
    page_id: r.page_id === null || r.page_id === undefined ? null : Number(r.page_id), entity_slug: (r.entity_slug as string | null) ?? null, value: String(r.value) }));
};

/** One store write: read the brain mode and turn enabled off with no epoch bump (gbrain-store `pause_managed_persistence`). */
export const pauseManagedPersistence: Member<'pauseManagedPersistence'> = async (brain) => {
  const prior: { enabled: boolean; mode_epoch: string; brain_topology_changes: string } = await storeCall({ member: 'pauseManagedPersistence' }, () => brain.pauseManagedPersistence());
  return { enabled: prior.enabled === true, mode_epoch: String(prior.mode_epoch), brain_topology_changes: String(prior.brain_topology_changes) } satisfies ManagedPausePrior;
};

/**
 * One compare-and-set store write: put enabled back only while still paused at the prior epoch with no brain-wide
 * topology change since. A pause token from an older gbrain is refused first, writing nothing (assertCurrentPauseToken).
 */
export const restoreManagedPersistence: Member<'restoreManagedPersistence'> = async (brain, prior) => {
  assertCurrentPauseToken(prior);
  return storeCall<boolean>({ member: 'restoreManagedPersistence' }, () =>
    brain.restoreManagedPersistence({ enabled: prior.enabled, mode_epoch: prior.mode_epoch, brain_topology_changes: prior.brain_topology_changes }));
};
