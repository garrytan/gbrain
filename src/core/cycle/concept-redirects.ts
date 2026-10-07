/**
 * #6161: concept merges a human made, read back as stem redirects for
 * synthesize_concepts' grouping. The concept-synthesis skill merges concept B
 * into A by archiving B under `concepts/_merged/` with `merged_into: A` and
 * listing B in A's `aliases`. Either record redirects B's atoms to A, so the
 * phase grows A instead of recreating B. Aliases count only on pages the phase
 * owns (`synthesized_by: synthesize_concepts…`), the pages a merge targets.
 */
import type { BrainEngine } from '../engine.ts';

/** Map of concept stem → canonical stem. The first record (by slug) wins a conflict. */
export async function loadConceptRedirects(engine: BrainEngine, sourceId: string,
  stemFor: (ref: string) => string | null): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ slug: string; merged_into: string | null; aliases: unknown; synthesized_by: string | null }>(
    `SELECT slug, frontmatter->>'merged_into' AS merged_into, frontmatter->'aliases' AS aliases, frontmatter->>'synthesized_by' AS synthesized_by
       FROM pages
      WHERE source_id = $1 AND slug LIKE 'concepts/%' AND deleted_at IS NULL
        AND ((frontmatter->>'merged_into') IS NOT NULL OR jsonb_typeof(frontmatter->'aliases') = 'array')
      ORDER BY slug`, [sourceId]);
  const redirects = new Map<string, string>();
  const add = (from: string | null, to: string | null) => {
    if (from && to && from !== to && !redirects.has(from)) redirects.set(from, to);
  };
  for (const row of rows) {
    if (row.merged_into) add(stemFor(row.slug), stemFor(row.merged_into));
    const aliases = typeof row.aliases === 'string' ? JSON.parse(row.aliases) as unknown : row.aliases;
    if (!String(row.synthesized_by ?? '').startsWith('synthesize_concepts') || !Array.isArray(aliases)) continue;
    for (const alias of aliases) if (typeof alias === 'string') add(stemFor(alias), stemFor(row.slug));
  }
  return redirects;
}

/** One hop through the redirects; a two-way redirect (a cycle) keeps the stem. */
export function canonicalConceptStem(stem: string, redirects: Map<string, string>): string {
  const target = redirects.get(stem);
  return target && redirects.get(target) !== stem ? target : stem;
}
