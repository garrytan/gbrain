/**
 * SQL Ranking Builders
 *
 * Pure string builders for the source-aware ranking signal that both
 * postgres-engine and pglite-engine inject into searchKeyword / searchVector.
 *
 * Returns RAW SQL FRAGMENTS. Call sites must embed via the engine's "unsafe"
 * SQL tag (`sql.unsafe(fragment)` for postgres.js, equivalent for pglite).
 *
 * Inputs to these builders that originate from env vars or caller options
 * (slug prefixes) are LIKE-pattern-escaped (`%`, `_`, `\`) AND SQL-string
 * escaped (single-quote doubling) before inlining. The slugColumn parameter
 * is supplied by us at the call site and is never user-controllable.
 *
 * Numeric factors come from `parseSourceBoostEnv` which calls Number.parseFloat
 * and validates `Number.isFinite(factor) && factor >= 0`, so they're safe to
 * inline as bare literals.
 */

/** Escape `%`, `_`, and `\` so a string can be used as a LIKE prefix literal. */
function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/** Escape a SQL string literal: replace single-quote with two single-quotes. */
function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/** Escape a slug prefix for use as `LIKE 'prefix%'` (both LIKE-escape and SQL-escape). */
function buildLikePrefixLiteral(prefix: string): string {
  return `'${escapeSqlLiteral(escapeLikePattern(prefix))}%'`;
}

/**
 * Build a CASE expression that returns the source-boost factor for a slug.
 *
 * Returns a literal `'1.0'` when `detail === 'high'` so temporal queries
 * bypass source-boost entirely (mirrors the existing COMPILED_TRUTH_BOOST
 * gate in hybrid.ts).
 *
 * Prefixes are sorted by length descending so longest-match wins:
 * `media/articles/` (1.1) wins over `media/x/` (0.7) without caller-order
 * dependencies.
 *
 * @param slugColumn — qualified column reference (e.g. `'p.slug'`). MUST be
 *                     supplied by the engine, never from user input.
 * @param boostMap   — prefix → factor map (defaults merged with env override)
 * @param detail     — query detail level; `'high'` disables source-boost
 *
 * @returns raw SQL fragment, e.g. `(CASE WHEN p.slug LIKE 'originals/%' THEN 1.5 ... ELSE 1.0 END)`
 */
export function buildSourceFactorCase(
  slugColumn: string,
  boostMap: Record<string, number>,
  detail: 'low' | 'medium' | 'high' | undefined,
): string {
  // Loose-string guard: agents passing `"HIGH"` or `"high "` over MCP/JSON
  // should still hit the temporal-bypass path. TypeScript narrows `detail`
  // for typed callers; this guard catches the untyped boundary.
  const normalized = typeof detail === 'string' ? detail.trim().toLowerCase() : detail;
  if (normalized === 'high') return '1.0';

  const entries = Object.entries(boostMap)
    .filter(([prefix, factor]) => prefix.length > 0 && Number.isFinite(factor) && factor >= 0)
    .sort((a, b) => b[0].length - a[0].length); // longest-prefix-match wins

  if (entries.length === 0) return '1.0';

  const whens = entries.map(([prefix, factor]) =>
    `WHEN ${slugColumn} LIKE ${buildLikePrefixLiteral(prefix)} THEN ${factor}`
  ).join(' ');

  return `(CASE ${whens} ELSE 1.0 END)`;
}

/**
 * Build a `NOT (col LIKE 'p1%' OR col LIKE 'p2%' OR ...)` exclusion clause.
 *
 * Why OR-chain wrapped in NOT, not `NOT LIKE ALL/ANY(array)`:
 *   - `NOT LIKE ALL(array)` means "doesn't match every pattern" — still
 *     keeps rows that match one. Wrong for set-exclusion.
 *   - `NOT LIKE ANY(array)` is non-standard and behavior varies.
 *   - Boolean-friendly OR-chain wrapped in NOT is unambiguous and indexable.
 *
 * Returns empty string when prefixes is empty, so callers can interpolate
 * unconditionally with a leading `AND`.
 *
 * @param slugColumn — qualified column reference (engine-supplied, trusted)
 * @param prefixes   — list of slug prefixes to exclude (env + caller-supplied; escaped)
 *
 * @returns raw SQL fragment (with leading space) or empty string
 */
export function buildHardExcludeClause(slugColumn: string, prefixes: string[]): string {
  if (!prefixes.length) return '';
  const likes = prefixes
    .filter(p => p.length > 0)
    .map(p => `${slugColumn} LIKE ${buildLikePrefixLiteral(p)}`)
    .join(' OR ');
  if (!likes) return '';
  return `AND NOT (${likes})`;
}

// Exported for unit tests
export const __test__ = { escapeLikePattern, escapeSqlLiteral, buildLikePrefixLiteral };
