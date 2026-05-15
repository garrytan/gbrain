/**
 * eval-contradictions/cross-source — M6 source-tier breakdown.
 *
 * Maps each pair-member's slug to a tier ('curated' | 'bulk' | 'other'),
 * then counts pairs by tier combination so the probe report can answer
 * "where do the contradictions live?": between two curated pages (worst —
 * the canonical narrative is internally inconsistent), between curated and
 * bulk (the cleanup target), or between two bulk pages (lowest concern).
 *
 * Tier classification reuses the existing source-boost map: prefixes with
 * boost > 1.0 are 'curated', boost < 1.0 are 'bulk', and 1.0 (or unknown)
 * is 'other'. Longest-prefix-match wins, matching how source-boost.ts
 * itself classifies during ranking.
 */

import { DEFAULT_SOURCE_BOOSTS } from '../search/source-boost.ts';
import type { ContradictionPair, SourceTier, SourceTierBreakdown } from './types.ts';

/**
 * Classify a slug into a tier. Longest-prefix-match. Unknown/baseline slugs
 * map to 'other' (not 'bulk') so the probe doesn't quietly mis-label new
 * directories.
 */
export function classifySlugTier(slug: string): SourceTier {
  if (!slug) return 'other';
  const lower = slug.toLowerCase();
  // Match longest prefix first.
  const prefixes = Object.keys(DEFAULT_SOURCE_BOOSTS).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      const boost = DEFAULT_SOURCE_BOOSTS[prefix];
      if (boost > 1.05) return 'curated';
      if (boost < 0.95) return 'bulk';
      return 'other';
    }
  }
  return 'other';
}

function bucketKey(a: SourceTier, b: SourceTier): keyof SourceTierBreakdown {
  // Order-independent: 'curated' beats 'bulk' beats 'other' for the cross-tier label.
  const has = (t: SourceTier) => a === t || b === t;
  if (a === 'curated' && b === 'curated') return 'curated_vs_curated';
  if (a === 'bulk' && b === 'bulk') return 'bulk_vs_bulk';
  if (has('curated') && has('bulk')) return 'curated_vs_bulk';
  return 'other';
}

/** Build the breakdown across a set of pairs. */
export function buildSourceTierBreakdown(
  pairs: readonly ContradictionPair[],
): SourceTierBreakdown {
  const out: SourceTierBreakdown = {
    curated_vs_curated: 0,
    curated_vs_bulk: 0,
    bulk_vs_bulk: 0,
    other: 0,
  };
  for (const pair of pairs) {
    const tierA = classifySlugTier(pair.a.slug);
    const tierB = classifySlugTier(pair.b.slug);
    out[bucketKey(tierA, tierB)]++;
  }
  return out;
}
