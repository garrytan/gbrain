/**
 * The reads a page purge's receipt and verification make on the brain's own tables (BrainEngine relationExists and
 * readDerivationPurgeState; SQL in engine-sql/purge-receipt.ts; rust/docs/store/pages.md, "The page purge's receipt reads"), and
 * the fact purge's write of its derivation sweep record (recordDerivationPurgeRow).
 *
 * `relationExists` is answered here, without a store call, because the store keeps keyspaces, not SQL relations:
 * - `relationExists` answers true for a relation the graduation inventory lists (a table or a view; an optional `public.` prefix
 *   and the unquoted capital spelling read as to_regclass reads them) that the store keeps, and false for any other name. The
 *   inventory lists relations the store has no storage for: those the purge-plan members name as holding no row
 *   (`STORE_ABSENT_PROBE_TABLES`, `RECEIPT_ABSENT_SLUG_STORES`) and the rebuildable cache `page_view_digests`. Those answer
 *   false, so `clearRebuildableCache` skips the cache and returns null instead of reaching a raw DELETE. The query cache is the
 *   one exception: it answers true though the store keeps none, the documented present-but-empty convention (`clearQueryCache`
 *   answers 0), so the purge receipt names no missing cache, as on a brain whose cache holds no row. A quoted or other-schema
 *   name answers false.
 * - `recordDerivationPurgeRow`, `readDerivationPurgeState` and `continueDerivationSweep` go to the store (page_body/purge_record.rs,
 *   page_body/derivation_sweep.rs): the store keeps the sweep record, `page_segment_derivation_purges` is a relation it keeps, and a
 *   recorded sweep reads `pending` (null for none). The store walks the sweep batch for batch as the SQL engines do (src/core/page-body/
 *   segment-derive.ts runDerivationSweep) and deletes the record when a verify walk deletes nothing. It honors `batchRows`, `totalMs`
 *   and `inlineMs`; it has no statement budget (no batch times out, halves or deletes a row unread, no record stalls: the state
 *   never reads `stalled`) and no scope lock (no record waits on `scope_lock_busy`); the test seams `hooks` stay in the SQL engines.
 */
import type { BrainEngine } from '../../engine.ts';
import { GRADUATION_INVENTORY } from '../../persistence/graduation-inventory.ts';
import { storeCall, type StoreMember } from './common.ts';
import { RECEIPT_ABSENT_SLUG_STORES, STORE_ABSENT_PROBE_TABLES } from './purge-absent-stores.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** Rebuildable caches (class `rebuild`) the store has no storage for; the query cache is not among them (see above). */
const ABSENT_REBUILDABLE_CACHES: ReadonlySet<string> = new Set(['page_view_digests']);

let relations: ReadonlySet<string> | null = null;

/** The inventory's relations the store keeps, or answers present-but-empty (the query cache). */
function keptRelations(): ReadonlySet<string> {
  relations ??= new Set(GRADUATION_INVENTORY.entries.map(e => e.relation)
    .filter(r => !STORE_ABSENT_PROBE_TABLES.has(r) && !RECEIPT_ABSENT_SLUG_STORES.has(r) && !ABSENT_REBUILDABLE_CACHES.has(r)));
  return relations;
}

/** The relation name as to_regclass folds it: an optional `public.` prefix dropped, an unquoted name lowercased; null for a name that is quoted or has another qualifier. */
function foldRelationName(table: string): string | null {
  const bare = table.startsWith('public.') ? table.slice('public.'.length) : table;
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(bare) ? bare.toLowerCase() : null;
}

export const relationExists: Member<'relationExists'> = async (_brain, table) => {
  const name = foldRelationName(table);
  return name !== null && keptRelations().has(name);
};

/** (store `readDerivationPurgeState`) `pending` for a recorded sweep, null for none (the sweep that ends a record is `continueDerivationSweep`); the store has no statement budget, so none is stalled. */
export const readDerivationPurgeState: Member<'readDerivationPurgeState'> = (brain, requestId) =>
  storeCall({ member: 'readDerivationPurgeState' }, () => brain.readDerivationPurgeState({ requestId })) as ReturnType<Member<'readDerivationPurgeState'>>;

/** (store `recordDerivationPurgeRow`) The record is kept; a second one for the request is a no-op. */
export const recordDerivationPurgeRow: Member<'recordDerivationPurgeRow'> = async (brain, row) => {
  await storeCall({ member: 'recordDerivationPurgeRow' }, () => brain.recordDerivationPurgeRow({
    requestId: row.requestId, sourceId: row.sourceId, needles: [...row.needles], patterns: [...row.patterns], pageIds: [...row.pageIds] }));
};

/** (store `continueDerivationSweep`) One call of the sweep: the batches it ran, the rows its first walk deleted and where. */
export const continueDerivationSweep: Member<'continueDerivationSweep'> = (brain, sourceId, opts, limits) =>
  storeCall({ member: 'continueDerivationSweep' }, () => brain.continueDerivationSweep({
    sourceId, first: opts.first ?? null, retry: opts.retry ?? null, inline: opts.inline === true,
    batchRows: limits.batchRows, totalMs: limits.totalMs, inlineMs: limits.inlineMs })) as ReturnType<Member<'continueDerivationSweep'>>;
