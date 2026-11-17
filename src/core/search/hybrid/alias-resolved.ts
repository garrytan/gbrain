import type { BrainEngine } from '../../engine.ts';
import type { PageReadPolicy, SearchResult } from '../../types.ts';
import { rethrowCapabilityRefusal } from '../../engine-capability-refusal.ts';

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
  let rows: Array<{ source_id: string; canonical_slug: string }> = [];
  try {
    rows = await engine.aliasCanonicalRefs(refs, policy);
  } catch (err) {
    rethrowCapabilityRefusal(err);
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
