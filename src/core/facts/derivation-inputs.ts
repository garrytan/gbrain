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
 * a source is purged. `replacePages` (#9653) is for a deriver that rewrites the
 * whole row from these inputs (a concept narrative): the row's page edges not
 * named now are dropped, so a purge of a former input no longer reaches it.
 * For a page they move to each of its retained versions first, so purge and
 * owner-only lineage still reach the history. The copy covers every retained
 * version, including ones archived before that input joined: a later purge
 * of the input over-hides those, never leaves a version built from it live.
 */
export async function recordDerivationInputs(tx: BrainEngine, row: DerivationRef & { sourceId?: string | null },
  inputs: readonly DerivationRef[], opts: { replacePages?: boolean } = {}): Promise<void> {
  if (!inputs.length) return;
  const derived = refKey(row);
  if (inputs.length > DERIVATION_EDGE_LIMIT) throw new RangeError(`A derivation records at most ${DERIVATION_EDGE_LIMIT} inputs.`);
  const edges = inputs.map(refKey);
  if (opts.replacePages) {
    const kept = edges.filter(e => e.table === 'pages').map(e => e.id);
    if (derived.table === 'pages' && /^\d+$/.test(derived.id)) await tx.executeRaw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
      SELECT 'page_versions',v.id::text,d.input_table,d.input_id,d.source_id FROM derivation_inputs d JOIN page_versions v ON v.page_id=$2::integer
      WHERE d.derived_table='pages' AND d.derived_id=$1 AND d.input_table='pages' AND NOT (d.input_id = ANY($3::text[])) ON CONFLICT DO NOTHING`,
    [derived.id, Number(derived.id), kept]);
    await tx.executeRaw(`DELETE FROM derivation_inputs WHERE derived_table=$1 AND derived_id=$2 AND input_table='pages'
      AND NOT (input_id = ANY($3::text[]))`, [derived.table, derived.id, kept]);
  }
  await tx.executeRaw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`, [derived.table, derived.id, row.sourceId ?? null, JSON.stringify(edges.map(e => ({ input_table: e.table, input_id: e.id })))]);
}

/** The page ids a derived row's recorded input edges name. */
export async function pageInputIds(engine: BrainEngine, derived: DerivationRef): Promise<string[]> {
  return (await engine.executeRaw<{ input_id: string }>(`SELECT input_id FROM derivation_inputs WHERE derived_table=$1 AND derived_id=$2 AND input_table='pages'`,
    [derived.table, derived.id])).map(row => row.input_id);
}

export interface DerivedRow { table: string; id: string; depth: number }

/**
 * Every row derived (transitively) from `inputs`, breadth-first, bounded by
 * `limit` rows and `maxDepth` hops. `truncated` is true when a bound stopped
 * the walk; the caller reports the remainder as unverified. Retained versions
 * (#9653) are terminal: they are collected after the live walk under their own
 * `limit`, so a concept's long history never truncates the walk before it
 * reaches a live row still built from the input.
 */
export async function derivedRowsFrom(engine: BrainEngine, inputs: readonly DerivationRef[],
  opts: { limit?: number; maxDepth?: number } = {}): Promise<{ rows: DerivedRow[]; truncated: boolean }> {
  const limit = opts.limit ?? 1_000, maxDepth = opts.maxDepth ?? 8;
  const seen = new Set(inputs.map(i => `${i.table}:${i.id}`));
  const rows: DerivedRow[] = [];
  let frontier = inputs.map(refKey);
  for (let depth = 1; frontier.length && depth <= maxDepth; depth++) {
    const next = await engine.executeRaw<{ derived_table: string; derived_id: string }>(`SELECT DISTINCT d.derived_table,d.derived_id
      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)
        ON d.input_table=f.input_table AND d.input_id=f.input_id
      WHERE d.derived_table<>'page_versions'
      ORDER BY d.derived_table,d.derived_id LIMIT $2`, [JSON.stringify(frontier.map(f => ({ input_table: f.table, input_id: f.id }))), limit + 1]);
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
  const walked = [...inputs.map(i => ({ input_table: i.table, input_id: i.id, depth: 0 })), ...rows.map(r => ({ input_table: r.table, input_id: r.id, depth: r.depth }))];
  const versions = await engine.executeRaw<{ derived_id: string; depth: number }>(`SELECT d.derived_id,min(f.depth)::int+1 AS depth
    FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text,depth int)
      ON d.input_table=f.input_table AND d.input_id=f.input_id
    WHERE d.derived_table='page_versions' GROUP BY d.derived_id ORDER BY d.derived_id LIMIT $2`, [JSON.stringify(walked), limit + 1]);
  if (versions.length > limit) return { rows, truncated: true };
  const versionDepth = new Map(versions.map(v => [v.derived_id, Number(v.depth)] as const));
  for (const [id, depth] of versionDepth) rows.push({ table: 'page_versions', id, depth });
  return { rows, truncated: false };
}

/**
 * Hide each derived row through its table's own inactive state and mark it
 * `needs_rederive`. Facts expire, takes deactivate, pages soft-delete;
 * a table without a known inactive state is only marked (reported unverified).
 * #9653: a page_versions row has no inactive state, but every reader of
 * retained versions tests the mark (versionReadableSql), so a marked version
 * counts as hidden; hiding a page marks each of its versions too, so a
 * re-derived page never brings back a version built from the purged input.
 * Nothing re-derives a version: the mark is permanent, and no row is deleted.
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
    if (table === 'facts') count = (await tx.executeRaw(`UPDATE facts SET expired_at=COALESCE(expired_at,now()) WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`, [numeric, mark.sourceId])).length;
    else if (table === 'takes') count = (await tx.executeRaw(`UPDATE takes k SET active=false FROM pages p WHERE k.id=ANY($1::bigint[]) AND p.id=k.page_id AND p.source_id=$2 RETURNING k.id`, [numeric, mark.sourceId])).length;
    else if (table === 'pages') count = (await tx.executeRaw(`UPDATE pages SET deleted_at=COALESCE(deleted_at,now()) WHERE id=ANY($1::integer[]) AND source_id=$2 RETURNING id`, [numeric, mark.sourceId])).length;
    else if (table === 'page_versions') count = (await tx.executeRaw(`SELECT v.id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE v.id=ANY($1::bigint[]) AND p.source_id=$2`, [numeric, mark.sourceId])).length;
    if (table === 'pages') {
      const versions = await tx.executeRaw<{ id: string }>(`INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason)
        SELECT 'page_versions',v.id::text,$2,$3::uuid,$4 FROM page_versions v WHERE v.page_id=ANY($1::integer[])
        ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,marked_at=now() RETURNING derived_id AS id`,
      [numeric, mark.sourceId, mark.requestId, mark.reason]);
      if (versions.length) hidden.page_versions = (hidden.page_versions ?? 0) + versions.length;
    }
    if (count) hidden[table] = (hidden[table] ?? 0) + count;
    if (count < ids.length) markedOnly[table] = ids.length - count;
    await tx.executeRaw(`INSERT INTO needs_rederive(derived_table,derived_id,source_id,request_id,reason)
      SELECT $1,unnest($2::text[]),$3,$4::uuid,$5 ON CONFLICT (derived_table,derived_id) DO UPDATE SET reason=EXCLUDED.reason,request_id=EXCLUDED.request_id,marked_at=now()`,
    [table, ids, mark.sourceId, mark.requestId, mark.reason]);
  }
  return { hidden, markedOnly };
}
