/**
 * Wanted-link writes (src/core/wanted-links.ts): the statements wanted-links-store.ts ran through `executeRaw` before
 * they had typed members (docs/research/rust-cli-executeraw-map.md, "Extract writes"). The text is the text the call
 * sites ran, so PGLite and Postgres answer exactly as before; a Rust brain answers from its store
 * (rust/crates/gbrain-store/src/wanted_links.rs).
 */
import type { WantedLinkRowsReplacement } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';
import type { SqlExecutor } from './executor.ts';

/** The registered ids among `sourceIds`, by id, read `FOR SHARE` so none disappears before the caller's page-guard lock. */
export async function lockRegisteredSourceIds(exec: SqlExecutor, sourceIds: readonly string[]): Promise<string[]> {
  if (!sourceIds.length) return [];
  const rows = await exec.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [[...sourceIds]]);
  return rows.map(row => row.id);
}

/**
 * Replace one origin's wanted rows for `producers`: rows of those producers that `rows` does not name are deleted,
 * then every row of `rows` is inserted or updated in place (its first_seen_at kept). `checked_at` is `-infinity` for a
 * slug target that is a live page, `readAt` for a bare name, the current time otherwise. Returns the rows written.
 */
export async function replaceWantedLinkRows(exec: SqlExecutor, origin: { pageId: number; sourceId: string },
  replacement: WantedLinkRowsReplacement): Promise<number> {
  const { rows, producers } = replacement;
  if (!producers.length) return 0;
  await executeRawJsonb(exec, `DELETE FROM wanted_links w
      WHERE w.origin_page_id = $1
        AND w.producer IN (SELECT jsonb_array_elements_text(($2::jsonb)->'producers'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(($2::jsonb)->'rows')
          AS v(producer text, ref_kind text, target_source_id text, target_ref text)
          WHERE v.producer = w.producer AND v.ref_kind = w.ref_kind
            AND v.target_source_id = w.target_source_id AND v.target_ref = w.target_ref)`,
  [origin.pageId], [{ rows, producers }]);
  if (!rows.length) return 0;
  const written = await executeRawJsonb<{ id: number }>(exec, `INSERT INTO wanted_links
      (origin_page_id, source_id, producer, ref_kind, target_source_id, target_ref, link_type, context, checked_at)
    SELECT $1, $2, v.producer, v.ref_kind, v.target_source_id, v.target_ref, v.link_type, v.context,
      CASE WHEN v.ref_kind = 'slug' AND EXISTS (SELECT 1 FROM pages t WHERE t.source_id = v.target_source_id
        AND t.deleted_at IS NULL AND t.slug = v.target_ref)
      THEN '-infinity'::timestamptz WHEN v.ref_kind = 'name' THEN $3::timestamptz ELSE now() END
    FROM jsonb_to_recordset(($4::jsonb)->'rows')
      AS v(producer text, ref_kind text, target_source_id text, target_ref text, link_type text, context text)
    ON CONFLICT ON CONSTRAINT wanted_links_reference_unique DO UPDATE
      SET link_type = EXCLUDED.link_type, context = EXCLUDED.context, checked_at = EXCLUDED.checked_at
    RETURNING id`, [origin.pageId, origin.sourceId, replacement.readAt ?? null], [{ rows }]);
  return written.length;
}
