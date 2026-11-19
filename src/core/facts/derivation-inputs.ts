/**
 * Complete derivation edges (`derivation_inputs`). A deriver (consolidation,
 * synthesis, patterns, atoms, chronicle, extraction) calls
 * `recordDerivationInputs` in the same transaction that writes the derived
 * row, naming every input placed in the model's context. `write_origin`'s
 * taint sample is a bounded display copy; these edges are the complete set.
 *
 * Purge walks the edges transitively from the purged rows, hides each derived
 * row through its table's own inactive state and records it in
 * `needs_rederive`, before cascades delete the evidence.
 */

import type { BrainEngine } from '../engine.ts';

/** A row reference: `table` is the owning table name, `id` its primary key (stringified). */
export interface DerivationRef { table: string; id: string | number }

export const DERIVATION_EDGE_LIMIT = 10_000;
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function refKey(ref: DerivationRef): { table: string; id: string } {
  if (!TABLE_NAME.test(ref.table)) throw new TypeError(`Invalid derivation table name: ${ref.table}`);
  const id = String(ref.id);
  if (!id) throw new TypeError('A derivation reference needs an id.');
  return { table: ref.table, id };
}

/**
 * Record every input of one derived row. Idempotent; call it inside the
 * transaction that writes `row`. `sourceId` scopes the edges for cleanup when
 * a source is purged.
 */
export async function recordDerivationInputs(tx: BrainEngine, row: DerivationRef & { sourceId?: string | null },
  inputs: readonly DerivationRef[]): Promise<void> {
  if (!inputs.length) return;
  const derived = refKey(row);
  if (inputs.length > DERIVATION_EDGE_LIMIT) throw new RangeError(`A derivation records at most ${DERIVATION_EDGE_LIMIT} inputs.`);
  await tx.recordDerivationInputs(derived, row.sourceId ?? null, inputs.map(refKey));
}

export interface DerivedRow { table: string; id: string; depth: number }

/**
 * Every row derived (transitively) from `inputs`, breadth-first, bounded by
 * `limit` rows and `maxDepth` hops. `truncated` is true when a bound stopped
 * the walk; the caller reports the remainder as unverified.
 */
export async function derivedRowsFrom(engine: BrainEngine, inputs: readonly DerivationRef[],
  opts: { limit?: number; maxDepth?: number } = {}): Promise<{ rows: DerivedRow[]; truncated: boolean }> {
  const limit = opts.limit ?? 1_000, maxDepth = opts.maxDepth ?? 8;
  const seen = new Set(inputs.map(i => `${i.table}:${i.id}`));
  const rows: DerivedRow[] = [];
  let frontier = inputs.map(refKey);
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const next = await engine.listDerivedRows(frontier, limit + 1);
    frontier = [];
    for (const r of next) {
      const key = `${r.derived_table}:${r.derived_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (rows.length >= limit) return { rows, truncated: true };
      rows.push({ table: r.derived_table, id: r.derived_id, depth });
      frontier.push({ table: r.derived_table, id: r.derived_id });
    }
    if (depth === maxDepth && frontier.length) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}

export { KEEP_HIDDEN_AT } from '../engine-sql/facts-purge.ts';

/** #9653: a delete of a page already hidden by hideDerivedRows (a person's or a sync's) ends the automatic purge's hold on it. */
export async function releaseHiddenMoment(tx: BrainEngine, pageId: number): Promise<void> {
  await tx.releaseHiddenMoment(pageId);
}

/**
 * Hide each derived row through its table's own inactive state and mark it
 * `needs_rederive`. Facts expire, takes deactivate, pages soft-delete;
 * a table without a known inactive state is only marked (reported unverified).
 * Returns the rows hidden per table.
 */
export async function hideDerivedRows(tx: BrainEngine, rows: readonly DerivedRow[], mark: { sourceId: string; requestId: string | null; reason: string }):
  Promise<{ hidden: Record<string, number>; markedOnly: Record<string, number> }> {
  return tx.hideDerivedRows(rows.map(r => ({ table: r.table, id: r.id })), mark);
}
