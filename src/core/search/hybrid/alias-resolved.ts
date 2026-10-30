import type { BrainEngine } from '../../engine.ts';
import type { PageReadPolicy, SearchResult } from '../../types.ts';
import { pageReadFilter } from '../read-policy-sql.ts';

/**
 * v0.42 (T19) — apply 1.05x boost to results whose slug is a canonical_slug
 * in slug_aliases. Stamps `alias_resolved_boost` on touched results so
 * --explain can render the contribution.
 *
 * Single index-hit query bounded by top-K (slug_aliases is small relative
 * to the result set; ALIASES <<< PAGES even on the 186K-page production
 * brain where 5.5K aliases is ~3% of pages).
 *
 * Source-scoped (codex F9: keyed by {source_id, slug} not just slug).
 */
const ALIAS_RESOLVED_BOOST = 1.05;

export async function readAliasCanonicals(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string }>,
  policy?: PageReadPolicy,
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  // Find which refs are canonical of any slug_aliases row.
  // Two-array unnest for source-scoped composite lookup.
  const sourceIds = refs.map(r => r.source_id);
  const slugs = refs.map(r => r.slug);
  const params: unknown[] = [sourceIds, slugs];
  const filter = pageReadFilter('p', policy, params, !!policy);
  let rows: Array<{ source_id: string; canonical_slug: string }> = [];
  try {
    rows = await engine.executeRaw<{ source_id: string; canonical_slug: string }>(
      `SELECT DISTINCT a.source_id, a.canonical_slug
       FROM slug_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.canonical_slug
       WHERE (a.source_id, a.canonical_slug) IN (
         SELECT * FROM unnest($1::text[], $2::text[])
       ) AND ${filter}`,
      params,
    );
  } catch {
    // Pre-v104 brain or other SQL miss; no-op.
    return new Set();
  }
  return new Set(rows.map(r => `${r.source_id}::${r.canonical_slug}`));
}

export function applyAliasResolvedBoost(results: SearchResult[], canonicalSet: Set<string>): void {
  for (const r of results) {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    if (canonicalSet.has(key)) {
      r.score *= ALIAS_RESOLVED_BOOST;
      r.alias_resolved_boost = ALIAS_RESOLVED_BOOST;
    }
  }
}
