/**
 * Source-Type Boost Map
 *
 * Multiplies into ts_rank / vector cosine score at SQL build time so that
 * curated content (originals/, concepts/, writing/) outranks bulk content
 * (wintermute/chat/, daily/, media/x/) for non-temporal queries.
 *
 * Keyed by slug prefix. Longest-prefix-match wins (sorted at lookup time
 * inside sql-ranking.ts). Defaults grounded in the composition of the
 * canonical brain at ~/git/brain/.
 *
 * Override via env: GBRAIN_SOURCE_BOOST="originals/:1.8,wintermute/chat/:0.3"
 * Hard-exclude via env: GBRAIN_SEARCH_EXCLUDE="test/,scratch/"
 */

export const DEFAULT_SOURCE_BOOSTS: Record<string, number> = {
  // Curated, opinionated, high-signal — Garry's own writing
  'originals/': 1.5,
  // Reusable knowledge frameworks
  'concepts/': 1.3,
  // Long-form essays / articles
  'writing/': 1.4,
  // Entity pages
  'people/': 1.2,
  'companies/': 1.2,
  'deals/': 1.2,
  // Notes from real meetings
  'meetings/': 1.1,
  // Ingested third-party content
  'media/articles/': 1.1,
  'media/repos/': 1.1,
  // Neutral baselines (explicit for clarity)
  'yc/': 1.0,
  'civic/': 1.0,
  // Bulk / noisy
  'daily/': 0.8,
  'media/x/': 0.7,
  // Chat transcripts — massive, noisy, swamp keyword queries
  'wintermute/chat/': 0.5,
};

/**
 * Hard-excludes — slug prefixes that should never enter search results
 * (unless explicitly opted-in via include_slug_prefixes).
 */
export const DEFAULT_HARD_EXCLUDES: string[] = [
  'test/',
  'archive/',
  'attachments/',
  '.raw/',
];

/**
 * Parse GBRAIN_SOURCE_BOOST env var.
 * Format: comma-separated prefix:factor pairs.
 * Example: "originals/:1.8,wintermute/chat/:0.3"
 *
 * Malformed entries are skipped silently. Returns empty object if env is
 * unset or unparseable in its entirety.
 */
export function parseSourceBoostEnv(env: string | undefined): Record<string, number> {
  if (!env) return {};
  const out: Record<string, number> = {};
  for (const pair of env.split(',')) {
    const idx = pair.lastIndexOf(':');
    if (idx <= 0) continue;
    const prefix = pair.slice(0, idx).trim();
    const factor = Number.parseFloat(pair.slice(idx + 1).trim());
    if (!prefix || !Number.isFinite(factor) || factor < 0) continue;
    out[prefix] = factor;
  }
  return out;
}

/**
 * Parse GBRAIN_SEARCH_EXCLUDE env var.
 * Format: comma-separated slug prefixes.
 * Example: "test/,scratch/,private/"
 *
 * Blank entries skipped. Returns empty array if env is unset.
 */
export function parseHardExcludesEnv(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Resolve the effective boost map by merging defaults with env override.
 * Env entries override defaults (shallow merge); env-only entries are added.
 */
export function resolveBoostMap(
  envValue: string | undefined = process.env.GBRAIN_SOURCE_BOOST,
): Record<string, number> {
  const override = parseSourceBoostEnv(envValue);
  return { ...DEFAULT_SOURCE_BOOSTS, ...override };
}

/**
 * Resolve the effective hard-exclude prefix list.
 *
 * - Defaults union with env-supplied excludes
 * - Subtract any caller-supplied include_slug_prefixes (opt-back-in)
 * - Caller-supplied exclude_slug_prefixes adds to the union
 */
export function resolveHardExcludes(
  excludeOpt?: string[],
  includeOpt?: string[],
  envValue: string | undefined = process.env.GBRAIN_SEARCH_EXCLUDE,
): string[] {
  const envExcludes = parseHardExcludesEnv(envValue);
  const union = new Set<string>([...DEFAULT_HARD_EXCLUDES, ...envExcludes, ...(excludeOpt ?? [])]);
  if (includeOpt?.length) {
    for (const p of includeOpt) union.delete(p);
  }
  return Array.from(union);
}
