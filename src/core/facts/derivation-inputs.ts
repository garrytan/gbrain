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
  const edges = inputs.map(refKey);
  await tx.recordDerivationEdges(derived, row.sourceId ?? null, edges);
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

/**
 * #9653: a page this function hid keeps `marked_at` equal to its `deleted_at`, so the automatic purge can tell a concept
 * hidden only because an input was purged (purge-deleted.ts readRederiveHeldConcepts) from one a person or sync deleted. A later mark of
 * that page keeps the moment; any other mark is stamped now.
 */
export const KEEP_HIDDEN_AT = `CASE WHEN needs_rederive.derived_table='pages' AND EXISTS (SELECT 1 FROM pages hp
  WHERE hp.id::text=needs_rederive.derived_id AND hp.deleted_at=needs_rederive.marked_at) THEN needs_rederive.marked_at ELSE now() END`;

/**
 * The mark's whole statement (the engine-sql member markNeedsRederive sends it as it is): constant text plus KEEP_HIDDEN_AT, no
 * value in the text. $1 table, $2 ids, $3 source, $4 request, $5 reason, $6 the pages this transaction just hid (used twice).
 */
export const MARK_NEEDS_REDERIVE_SQL = `INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason,marked_at)
      SELECT $1,d.id,$3,$4::uuid,$5,COALESCE((SELECT p.deleted_at FROM pages p WHERE d.id=ANY($6::text[]) AND p.id::text=d.id),now()) FROM unnest($2::text[]) AS d(id)
      ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,
        marked_at=CASE WHEN EXCLUDED.derived_id=ANY($6::text[]) THEN EXCLUDED.marked_at ELSE ${KEEP_HIDDEN_AT} END`;

/** #9653: a delete of a page already hidden this way (a person's or a sync's) ends the automatic purge's hold on it. */
export async function releaseHiddenMoment(tx: BrainEngine, pageId: number): Promise<void> {
  await tx.executeRaw(`UPDATE needs_rederive n SET marked_at=clock_timestamp() FROM pages p
    WHERE n.derived_table='pages' AND n.derived_id=p.id::text AND p.id=$1 AND n.marked_at=p.deleted_at`, [pageId]);
}

/**
 * Hide each derived row through its table's own inactive state and mark it
 * `needs_rederive`. Facts expire, takes deactivate, pages soft-delete;
 * a table without a known inactive state is only marked (reported unverified).
 * Returns the rows hidden per table.
 */
export async function hideDerivedRows(tx: BrainEngine, rows: readonly DerivedRow[], mark: { sourceId: string; requestId: string | null; reason: string }):
  Promise<{ hidden: Record<string, number>; markedOnly: Record<string, number> }> {
  const hidden: Record<string, number> = {}, markedOnly: Record<string, number> = {};
  const byTable = new Map<string, string[]>();
  for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id]);
  for (const [table, ids] of byTable) {
    const numeric = ids.filter(id => /^\d+$/.test(id)).map(Number);
    let count = 0;
    if (table === 'facts') count = await tx.expireDerivedFacts(numeric, mark.sourceId);
    else if (table === 'takes') count = await tx.deactivateDerivedTakes(numeric, mark.sourceId);
    let hiddenNow: string[] = [];
    if (table === 'pages') {
      const pages = await tx.softDeleteDerivedPages(numeric, mark.sourceId);
      hiddenNow = pages.filter(row => row.now).map(row => String(row.id));
      count = pages.length;
    }
    if (count) hidden[table] = count;
    if (count < ids.length) markedOnly[table] = ids.length - count;
    await tx.markNeedsRederive(table, ids, mark.sourceId, mark.requestId, mark.reason, hiddenNow);
  }
  return { hidden, markedOnly };
}
