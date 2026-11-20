/**
 * The synopsis tier's configuration read (synopsis-sweep.ts `readSynopsisTierConfig`), as one typed engine member
 * every engine serves:
 *
 * - `readSynopsisTierSources(skipFrontmatter)`: the live sources whose own contextual-retrieval mode is
 *   per_chunk_synopsis, by id in byte order, and whether a live markdown page's trusted frontmatter picks that tier
 *   (the trust rule of eligiblePagesSql: the host source, or a source that trusts frontmatter overrides). The page
 *   check is skipped when `skipFrontmatter` is true: the kill switch is on, or the global tier already is the synopsis
 *   tier.
 *
 * The SQL is the text synopsis-sweep.ts ran, except that the source id is ordered with `COLLATE "C"` (bytes): a bare
 * `ORDER BY id` ordered past hyphens on a database with a linguistic collation (en_US), unlike PGLite and the Rust
 * store. A UNION orders only by an output column, so the collation is set on the first branch's column.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** What `readSynopsisTierSources` answers. */
export interface SynopsisTierSources {
  /** The live sources whose own mode is per_chunk_synopsis, by id (byte order). */
  sourceIds: string[];
  /** True when a live markdown page's trusted frontmatter picks the synopsis tier (always false when skipped). */
  frontmatterPicks: boolean;
}

export const READ_SYNOPSIS_TIER_SOURCES_SQL = `SELECT id COLLATE "C" AS id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived
     UNION ALL
     SELECT NULL WHERE NOT $1::boolean AND EXISTS (SELECT 1 FROM pages p LEFT JOIN sources s ON s.id = p.source_id
       WHERE p.deleted_at IS NULL AND p.page_kind = 'markdown' AND NOT COALESCE(s.archived, false)
         AND p.frontmatter @> '{"contextual_retrieval":"per_chunk_synopsis"}'::jsonb
         AND (p.source_id = 'default' OR COALESCE(s.trust_frontmatter_overrides, false)))
     ORDER BY id`;

/** The NULL row is the frontmatter pick; every other row is a source id. */
export async function readSynopsisTierSources(tx: Raw, skipFrontmatter: boolean): Promise<SynopsisTierSources> {
  const rows = await tx.executeRaw<{ id: string | null }>(READ_SYNOPSIS_TIER_SOURCES_SQL, [skipFrontmatter]);
  return { sourceIds: rows.flatMap(r => r.id === null ? [] : [r.id]), frontmatterPicks: rows.some(r => r.id === null) };
}
