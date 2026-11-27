/**
 * The fact reads and writes of `gbrain repair redacted-facts` (src/core/repair/redacted-facts.ts) and of the
 * `gbrain repair conversation-labels` retirement (src/core/repair/conversation-labels.ts). Both SQL engines delegate
 * here; the Rust store serves the same members (rust/crates/gbrain-store/src/facts/text_repair.rs).
 *
 * - redacted-facts: listRedactedFactCandidates, restoreRedactedFactTexts (a compare-and-set in the UPDATE itself, so a
 *   row changed after the apply's recheck is left alone) and listProjectedFenceRows.
 * - conversation-labels: listUnexpiredFactIds, lockFactRows, expireFactWithNote, expirePageFactsBySource and
 *   readMaxFactRowNum.
 *
 * A context append is `concat_ws(' | ', NULLIF(context, ''), note)`.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One active fact whose text holds a redaction marker. */
export interface RedactedFactRow {
  id: number; source_id: string; fact: string; visibility: string; entity_slug: string | null; row_num: number | null;
  source_markdown_slug: string | null; context: string | null; source: string;
}

/** One approved in-place rewrite: the row as previewed and its restored text. */
export interface FactTextRestore {
  id: number; from_text: string; to_text: string; visibility: string; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null;
}

/** Every active, unsuperseded fact of the sources (or of `ids`) whose text holds `[redacted`, by (source, id). */
export async function listRedactedFactCandidates(raw: Raw, sourceIds: readonly string[], ids: readonly number[] | null): Promise<RedactedFactRow[]> {
  const rows = await raw.executeRaw<RedactedFactRow & { id: number | string; row_num: number | string | null }>(`
    SELECT f.id, f.source_id, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug, f.context, f.source
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND f.fact LIKE '%[redacted%' AND ($2::bigint[] IS NULL OR f.id=ANY($2::bigint[]))
     ORDER BY f.source_id, f.id`, [[...sourceIds], ids === null ? null : [...ids]]);
  return rows.map(row => ({ ...row, id: Number(row.id), row_num: row.row_num === null ? null : Number(row.row_num) }));
}

/** Rewrites each row of the source still exactly as previewed and appends `marker` to its context; the ids rewritten, by id. */
export async function restoreRedactedFactTexts(raw: Raw, sourceId: string, restores: readonly FactTextRestore[], marker: string): Promise<number[]> {
  if (!restores.length) return [];
  const rows = await raw.executeRaw<{ id: number | string }>(`UPDATE facts f
    SET fact=r.to_text, context=concat_ws(' | ', NULLIF(f.context,''), $3::text)
   FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, from_text text, to_text text, visibility text, entity_slug text, source_markdown_slug text, row_num int)
  WHERE f.source_id=$1 AND f.id=r.id AND f.fact=r.from_text AND f.visibility=r.visibility AND f.entity_slug IS NOT DISTINCT FROM r.entity_slug
    AND f.source_markdown_slug IS NOT DISTINCT FROM r.source_markdown_slug AND f.expired_at IS NULL AND f.superseded_by IS NULL
    AND f.row_num IS NOT DISTINCT FROM r.row_num AND (r.row_num IS NULL OR f.source LIKE 'cli:extract-conversation-facts%')
  RETURNING f.id`, [sourceId, JSON.stringify(restores), marker]);
  return rows.map(row => Number(row.id)).sort((a, b) => a - b);
}

/** The row numbers of the page's active facts whose number is in `rowNums` and text in `texts`, ascending. */
export async function listProjectedFenceRows(raw: Raw, sourceId: string, slug: string, rowNums: readonly number[], texts: readonly string[]): Promise<number[]> {
  const rows = await raw.executeRaw<{ row_num: number | string }>(`SELECT row_num FROM facts
    WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL AND row_num=ANY($3::int[]) AND fact=ANY($4::text[])`,
  [sourceId, slug, [...rowNums], [...texts]]);
  return rows.map(row => Number(row.row_num)).sort((a, b) => a - b);
}

/** The named facts that are not expired, ascending. */
export async function listUnexpiredFactIds(raw: Raw, ids: readonly number[]): Promise<number[]> {
  const rows = await raw.executeRaw<{ id: number | string }>('SELECT id FROM facts WHERE id=ANY($1::bigint[]) AND expired_at IS NULL', [[...ids]]);
  return rows.map(row => Number(row.id)).sort((a, b) => a - b);
}

/** Locks the named facts of the source for the rest of the transaction (`FOR UPDATE`). */
export async function lockFactRows(raw: Raw, sourceId: string, ids: readonly number[]): Promise<void> {
  await raw.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE', [sourceId, [...ids]]);
}

/** Expires fact `id` of the source when it is not expired, appending `note` to its context; true when it did. */
export async function expireFactWithNote(raw: Raw, sourceId: string, id: number, note: string): Promise<boolean> {
  const rows = await raw.executeRaw(`UPDATE facts SET expired_at=now(), context=concat_ws(' | ', NULLIF(context, ''), $3::text)
      WHERE source_id=$1 AND id=$2 AND expired_at IS NULL RETURNING id`, [sourceId, id, note]);
  return rows.length > 0;
}

/** Expires the page's unexpired facts whose source is one of `sources`; answers how many. */
export async function expirePageFactsBySource(raw: Raw, sourceId: string, slug: string, sources: readonly string[]): Promise<number> {
  const rows = await raw.executeRaw(`UPDATE facts SET expired_at=now() WHERE source_id=$1 AND source_markdown_slug=$2 AND source=ANY($3::text[]) AND expired_at IS NULL
      RETURNING id`, [sourceId, slug, [...sources]]);
  return rows.length;
}

/** The largest `row_num` of any fact (expired or not) the page holds, or null. */
export async function readMaxFactRowNum(raw: Raw, sourceId: string, slug: string): Promise<number | null> {
  const [top] = await raw.executeRaw<{ n: number | string | null }>('SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  return top?.n == null ? null : Number(top.n);
}
