/**
 * Storage for wanted pages (see src/core/wanted-links.ts). Kept free of the
 * link-extraction import graph because derived-links.ts, which every engine
 * imports, calls it inside the derived-link replacement transaction.
 */
import type { BrainEngine } from './engine.ts';
import type { WantedPageRow } from './engine-sql/cli-reads-ops.ts';
import { executeRawJsonb } from './sql-query.ts';
import { sanitizeForJsonb } from './batch-rows.ts';
import { validateSlug } from './utils.ts';

export type WantedProducer = 'body' | 'frontmatter';

export interface WantedLinkInput {
  producer: WantedProducer;
  ref_kind: 'slug' | 'name';
  target_source_id: string;
  target_ref: string;
  link_type: string;
  context: string;
}

export interface WantedLinksReplacement {
  rows: WantedLinkInput[];
  /** Producers whose rows this replacement owns; others stay untouched. */
  producers: readonly WantedProducer[];
  /**
   * wantedReadAt() taken before the extraction's first resolution read. Every
   * `name` row is stamped with it, so a page written after that read wakes the
   * origin and one the read already saw does not. Required when rows has a name.
   */
  readAt?: string;
}

/** The database clock as a UTC ISO string with microseconds, independent of the session's DateStyle. */
export async function wantedReadAt(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  const [row] = await engine.executeRaw<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row!.at;
}

/**
 * #6228/#6225: the rows whose target can become a page. A slug target must
 * pass validateSlug (a regex literal on a code page read as a wikilink does
 * not) and every target must be in a registered source (a `[[memory:123]]`
 * citation names none). Any other row names no possible page; locking it
 * would throw and abort the caller's whole extraction transaction. Foreign
 * sources are read `FOR SHARE`, so one cannot disappear between this check
 * and the page-guard lock; the origin's own source needs no read.
 */
export async function possibleWantedRows<T extends Pick<WantedLinkInput, 'ref_kind' | 'target_source_id' | 'target_ref'>>(
  tx: Pick<BrainEngine, 'executeRaw'>, originSourceId: string, rows: readonly T[],
): Promise<T[]> {
  const shaped = rows.filter(row => row.ref_kind !== 'slug' || pageSlugShaped(row.target_ref));
  const foreign = [...new Set(shaped.map(row => row.target_source_id).filter(id => id !== originSourceId))];
  if (!foreign.length) return shaped;
  const registered = new Set((await tx.executeRaw<{ id: string }>(
    'SELECT id FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [foreign])).map(row => row.id));
  return shaped.filter(row => row.target_source_id === originSourceId || registered.has(row.target_source_id));
}

function pageSlugShaped(target: string): boolean {
  try { validateSlug(target); return true; } catch { return false; } // a refused slug is the answer, not an error
}

/**
 * Replace one origin's wanted rows inside the caller's transaction (the same
 * one that replaces its derived links), keeping only possibleWantedRows. Slug targets are locked first, so a
 * concurrent writer creating the target either committed before this check
 * (and the row is stamped `-infinity`, leaving the origin stale) or commits
 * after it with an `updated_at` past `checked_at`. A bare-name reference may
 * legitimately stay unresolved while a page has its exact slug or basename
 * (basename resolution is opt-in, and a directory hint can skip a top-level
 * slug), so it is stamped with the caller's read time instead: a page written
 * after that read wakes the origin once, and the next extraction settles it.
 */
export async function replaceWantedLinks(
  tx: Pick<BrainEngine, 'executeRaw' | 'lockPageKeys'>,
  origin: { pageId: number; sourceId: string },
  replacement: WantedLinksReplacement,
): Promise<number> {
  if (!replacement.producers.length) return 0;
  if (!replacement.readAt && replacement.rows.some(row => row.ref_kind === 'name')) {
    throw new Error('replaceWantedLinks: name rows need the readAt taken before the extraction read');
  }
  const rows = (await possibleWantedRows(tx, origin.sourceId,
    replacement.rows.filter(row => replacement.producers.includes(row.producer))))
    .map(row => ({ ...row, context: sanitizeForJsonb(row.context) }));
  const slugTargets = rows.filter(row => row.ref_kind === 'slug')
    .map(row => ({ sourceId: row.target_source_id, slug: row.target_ref }));
  if (slugTargets.length) await tx.lockPageKeys(slugTargets);
  await executeRawJsonb(tx, `DELETE FROM wanted_links w
      WHERE w.origin_page_id = $1
        AND w.producer IN (SELECT jsonb_array_elements_text(($2::jsonb)->'producers'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(($2::jsonb)->'rows')
          AS v(producer text, ref_kind text, target_source_id text, target_ref text)
          WHERE v.producer = w.producer AND v.ref_kind = w.ref_kind
            AND v.target_source_id = w.target_source_id AND v.target_ref = w.target_ref)`,
  [origin.pageId], [{ rows, producers: replacement.producers }]);
  if (!rows.length) return 0;
  const written = await executeRawJsonb<{ id: number }>(tx, `INSERT INTO wanted_links
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

export type { WantedPageRow } from './engine-sql/cli-reads-ops.ts';

/**
 * Missing link targets, most-referenced first. Scope applies to the origin
 * pages (the caller's readable sources) and, when `excludePrivate`, private
 * origins are removed BEFORE aggregation so a private page never reveals a
 * target name or contributes to a count. Soft-deleted origins never count.
 * The engine member returns the rows in this shape (engine-sql/cli-reads-ops.ts).
 */
export function listWantedPages(engine: Pick<BrainEngine, 'listWantedPages'>, opts: {
  sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean;
  limit: number; offset: number;
}): Promise<{ total: number; rows: WantedPageRow[] }> {
  return engine.listWantedPages(opts);
}
