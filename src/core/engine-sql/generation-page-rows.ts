/**
 * The page row read of the generation adapters (generations/adapters/page.ts `readPageRows`) as one typed engine
 * member. Each `match` is one statement the adapters sent through `executeRaw`, with the same parameters: the
 * single-page adapter's row of one slug, the synthesis adapter's outputs of a transcript, the atoms adapter's atoms of
 * an origin field, and the Life Chronicle adapter's events of a depth page. Every row of the source matching it is
 * returned, deleted rows included, by slug, with its tags sorted and whether its body is segmented. Both sorts carry
 * `COLLATE "C"`, which the adapters' text did not, so Postgres sorts by bytes on every locale, as PGLite and the Rust
 * store do. These are internal reads of derived pages, not caller page reads, so they take no page read policy, as the
 * statements never did. The Rust engine serves them from its page records
 * (rust/crates/gbrain-store/src/generations/page_rows.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** One page row: the identity fields, `deleted` (soft-deleted) and `segmented` (`body_storage = 'segmented'`). */
export interface GenerationPageRow {
  page_id: number; slug: string; type: string; title: string; compiled_truth: string | null; timeline: string | null;
  frontmatter: Record<string, unknown> | null; deleted: boolean; segmented: boolean; tags: string[];
}

/** Which rows of `sourceId` to read. Each `match` is one fixed statement. */
export type GenerationPageRowsQuery =
  /** The row of `slug`. */
  | { sourceId: string; match: 'slug'; slug: string }
  /** Rows of `slugs`, and live dream-generated pages whose `raw_source` is `locator` (none when it is null). */
  | { sourceId: string; match: 'synthesis'; slugs: readonly string[]; locator: string | null }
  /** Atom rows of `slugs`, and live atoms whose frontmatter `field` is `value` (none when it is null). */
  | { sourceId: string; match: 'atoms'; slugs: readonly string[]; field: 'source_slug' | 'source_path'; value: string | null }
  /** Rows of `slugs`, and live Life Chronicle event pages of `depth`. */
  | { sourceId: string; match: 'chronicle'; slugs: readonly string[]; depth: string };

export const GENERATION_PAGE_ROWS_SQL = {
  slug: `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (p.slug = $2) ORDER BY p.slug COLLATE "C"`,
  synthesis: `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL
      AND p.frontmatter->>'raw_source' = $3 AND p.frontmatter->>'dream_generated' = 'true')) ORDER BY p.slug COLLATE "C"`,
  atomsSourceSlug: `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_slug' = $3))) ORDER BY p.slug COLLATE "C"`,
  atomsSourcePath: `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_path' = $3))) ORDER BY p.slug COLLATE "C"`,
  chronicle: `SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,
            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.type='event' AND p.frontmatter->'event'->>'depth' = $3
      AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')) ORDER BY p.slug COLLATE "C"`,
} as const;

function statement(q: GenerationPageRowsQuery): { sql: string; params: unknown[] } {
  switch (q.match) {
    case 'slug': return { sql: GENERATION_PAGE_ROWS_SQL.slug, params: [q.sourceId, q.slug] };
    case 'synthesis': return { sql: GENERATION_PAGE_ROWS_SQL.synthesis, params: [q.sourceId, [...q.slugs], q.locator] };
    case 'atoms':
      if (q.field !== 'source_slug' && q.field !== 'source_path') break;
      return { sql: q.field === 'source_slug' ? GENERATION_PAGE_ROWS_SQL.atomsSourceSlug : GENERATION_PAGE_ROWS_SQL.atomsSourcePath,
        params: [q.sourceId, [...q.slugs], q.value] };
    case 'chronicle': return { sql: GENERATION_PAGE_ROWS_SQL.chronicle, params: [q.sourceId, [...q.slugs], q.depth] };
  }
  throw new Error(`readGenerationPageRows: not a page row match: ${JSON.stringify(q)}`);
}

/** Checks the query before any engine reads it, so every engine refuses the same queries. */
export function checkGenerationPageRowsQuery(q: GenerationPageRowsQuery): void {
  statement(q);
}

/** The rows of `q`, by slug. `page_id` is a number; `tags` is never null. */
export async function readGenerationPageRows(raw: EngineRawRead, q: GenerationPageRowsQuery): Promise<GenerationPageRow[]> {
  const { sql, params } = statement(q);
  const rows = await raw<Omit<GenerationPageRow, 'tags'> & { tags: string[] | null }>(sql, params);
  return rows.map(row => ({ ...row, page_id: Number(row.page_id), tags: row.tags ?? [] }));
}
