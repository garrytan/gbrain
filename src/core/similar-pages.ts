/**
 * "Did you mean an existing page?" — a question asked after a page is
 * created, never a merge.
 *
 * When a write creates a new page, a few indexed lexical checks look for an
 * existing page in the same source that is probably the same thing: the same
 * title or a declared alias, the same name in another directory, or a very
 * similar title in the same directory. Up to three candidates come back as
 * slugs with the evidence that matched; the writer decides. A similarity
 * score alone cannot separate a rewording from a related page, so nothing is
 * merged and no threshold-based decision is made here. Zero provider calls:
 * the page's embedding does not exist yet at write time.
 */
import type { BrainEngine } from './engine.ts';
import { normalizeAlias } from './search/alias-normalize.ts';
import { privatePagesFilterFragment } from './search/private-visibility.ts';

export type SimilarPageEvidence = 'exact_title' | 'alias' | 'same_name_other_directory' | 'similar_title';

export interface SimilarPageCandidate { slug: string; source_id: string; evidence: SimilarPageEvidence }

const CHECKS = ['exact_title', 'alias', 'same_name_other_directory', 'similar_title'] as const;
const TITLE_SIMILARITY_FLOOR = 0.55;
const MAX_CANDIDATES = 3;

/**
 * Existing pages in `sourceId` that a newly created `slug` probably
 * duplicates. `excludePrivate` keeps private pages out for callers that may
 * not read them. Returns null when `slug` already existed (not a create) or
 * when `put_page.similar_pages` is not turned on (default off).
 */
export async function findSimilarPages(engine: Pick<BrainEngine, 'executeRaw'>, input: {
  sourceId: string; slug: string; title: string; excludePrivate: boolean;
}): Promise<{ candidates: SimilarPageCandidate[]; checks_ran: readonly string[] } | null> {
  const title = input.title.trim();
  const basename = input.slug.slice(input.slug.lastIndexOf('/') + 1);
  const dir = input.slug.includes('/') ? input.slug.slice(0, input.slug.indexOf('/')) : '';
  // ILIKE without wildcards is an exact case-insensitive match the title
  // trigram index (idx_pages_trgm) serves; % and _ in the title are escaped.
  const privacy = input.excludePrivate ? ` AND ${privatePagesFilterFragment('p')}` : '';
  const rows = await engine.executeRaw<{ slug: string; evidence: SimilarPageEvidence }>(`
    WITH hits AS (
      SELECT NULL::text AS slug, 'page_exists' AS evidence, 0 AS tier, 0::real AS sim FROM pages p
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
      UNION ALL
      SELECT NULL::text, 'disabled', 0, 0::real WHERE NOT EXISTS (SELECT 1 FROM config c
        WHERE c.key = 'put_page.similar_pages' AND lower(trim(c.value)) IN ('true', '1', 'yes', 'on'))
      UNION ALL
      SELECT p.slug, 'exact_title' AS evidence, 1 AS tier, 1.0::real AS sim FROM pages p
        WHERE p.source_id = $1 AND p.slug <> $2 AND p.deleted_at IS NULL AND $3 <> '' AND p.title ILIKE $7 ESCAPE '\\'${privacy}
      UNION ALL
      SELECT p.slug, 'alias', 2, 1.0::real FROM page_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug
        WHERE a.source_id = $1 AND a.alias_norm = $4 AND $4 <> '' AND p.slug <> $2 AND p.deleted_at IS NULL${privacy}
      UNION ALL
      SELECT p.slug, 'same_name_other_directory', 3, 1.0::real FROM pages p
        WHERE p.source_id = $1 AND regexp_replace(p.slug, '^.*/', '') = $5 AND p.slug <> $2 AND p.deleted_at IS NULL${privacy}
      UNION ALL
      SELECT p.slug, 'similar_title', 4, similarity(p.title, $3) FROM pages p
        WHERE p.source_id = $1 AND $3 <> '' AND p.title % $3 AND similarity(p.title, $3) >= ${TITLE_SIMILARITY_FLOOR}
          AND ($6 = '' OR p.slug LIKE $6 || '/%') AND p.slug <> $2 AND p.deleted_at IS NULL${privacy}
    )
    SELECT DISTINCT ON (slug) slug, evidence, tier, sim FROM hits ORDER BY slug, tier, sim DESC`,
  [input.sourceId, input.slug, title, normalizeAlias(title), basename, dir, title.replace(/[\\%_]/g, ch => `\\${ch}`)]);
  // The page already exists (a create raced another writer, or this is an update): not a create, no advisory.
  // The advisory runs only when `put_page.similar_pages` is true (default off, held-out verdict H5b); read in the same statement.
  if ((rows as Array<{ evidence: string }>).some(row => row.evidence === 'page_exists' || row.evidence === 'disabled')) return null;
  const ranked = (rows as Array<{ slug: string; evidence: SimilarPageEvidence; tier: number; sim: number }>)
    .sort((a, b) => a.tier - b.tier || b.sim - a.sim || a.slug.localeCompare(b.slug)).slice(0, MAX_CANDIDATES);
  return { candidates: ranked.map(row => ({ slug: row.slug, source_id: input.sourceId, evidence: row.evidence })), checks_ran: CHECKS };
}
