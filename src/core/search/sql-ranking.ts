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

import { quarantineFilterFragment } from '../quarantine.ts';

/**
 * Escape `%`, `_`, and `\` so a string can be used as a LIKE prefix literal.
 *
 * Exported (issue #1777) so callers that build parameterized LIKE clauses with
 * `ESCAPE '\'` (e.g. the `hidden_by_search_policy` doctor check) reuse this one
 * escaper instead of re-implementing it. Pair with `ESCAPE '\'` in the SQL so
 * the backslash this inserts is treated as the escape char, not a literal.
 */
export function escapeLikePattern(s: string): string {
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

/**
 * v0.26.5 — Build the soft-delete + archived-source visibility filter.
 *
 * Two filters in one fragment:
 *  - Page-level soft-delete: `<pageAlias>.deleted_at IS NULL` hides pages that
 *    `delete_page` flipped via `softDeletePage`.
 *  - Source-level archive: `NOT <sourceAlias>.archived` hides every page
 *    belonging to a source that `gbrain sources archive` soft-deleted.
 *
 * Unlike `buildSourceFactorCase`, this clause is NOT bypassed by `detail=high`.
 * Soft-deleted content stays hidden regardless of query detail level — the
 * recovery window is for explicit `include_deleted: true` callers, not for
 * temporal queries.
 *
 * Returns a fragment with leading `AND` so callers can splice it into a WHERE
 * unconditionally. Both column references are engine-supplied (never user
 * input), so no escape is required on the alias names themselves.
 *
 * @param pageAlias   — page table alias (e.g. `'p'`)
 * @param sourceAlias — source table alias (e.g. `'s'`); the caller is
 *                      responsible for joining `sources` so this alias resolves.
 *
 * v0.42 (issue #1699) — also hides QUARANTINED pages (high-confidence junk
 * the content-quality gate flagged with `frontmatter.quarantine`). Primary
 * protection is that quarantine writes zero chunks, so a chunk-less page is
 * already invisible to keyword/vector search; this clause is the
 * belt-and-suspenders cover for residual chunk paths (stale/orphan chunk
 * queries, CJK ILIKE fallback). FLAGGED pages (`content_flag`) are NOT
 * excluded — they stay searchable by design; the agent gets a warning via
 * `SearchResult.content_flag`.
 *
 * @param pageAlias   — page table alias (e.g. `'p'`)
 * @param sourceAlias — source table alias (e.g. `'s'`); the caller is
 *                      responsible for joining `sources` so this alias resolves.
 *
 * @returns raw SQL fragment, e.g.
 *   `AND p.deleted_at IS NULL AND NOT s.archived AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine')`
 */
export function buildVisibilityClause(pageAlias: string, sourceAlias: string): string {
  // Single source of truth for the quarantine SQL lives in quarantine.ts so
  // the marker key + filter can't drift from the search filter (#1699).
  const quarantine = quarantineFilterFragment(pageAlias);
  return `AND ${pageAlias}.deleted_at IS NULL AND NOT ${sourceAlias}.archived AND ${quarantine}`;
}

// ============================================================
// Per-page max-pool (T1 / D7) — single source of truth
// ============================================================

/**
 * Build the `best_per_page` pooling CTE: collapse a chunk-grain candidate set
 * to ONE row per page — the page's highest-scoring chunk.
 *
 * This is the per-page max-pool that `searchKeyword` always had and that
 * `searchVector` was missing (the retrieval-maxpool incident: a page got
 * represented by whichever chunk survived the candidate cut, not its best
 * chunk). Both engines (postgres + pglite) AND both retrieval paths
 * (keyword + vector) consume this one builder so they cannot drift — the
 * recurring postgres/pglite parity bug class this repo guards against.
 *
 * Contract on the candidate CTE (`candidateCte`):
 *   - exposes `source_id` + `slug` columns (the composite per-page collapse key)
 *   - exposes a numeric `score` column (the value pooled on)
 *   - exposes `page_id` and `chunk_id` columns (deterministic tiebreak)
 *
 * Collapse key is COMPOSITE `(source_id, slug)`, NOT slug alone — two pages
 * with the same slug in different sources are distinct pages (the federated
 * multi-source contract; matches dedup.ts's pageKey and the v0.34.1 source
 * isolation seal). Pooling on bare slug would collapse them and drop the
 * neighbor-source page before ranking. `COALESCE(source_id, 'default')` keeps
 * pre-v0.17 single-source rows (null source_id) collapsing correctly.
 *
 * Determinism: `DISTINCT ON` keeps the FIRST row per key under the ORDER BY,
 * so the tiebreak `… score DESC, page_id ASC, chunk_id ASC` makes the surviving
 * chunk fully deterministic when two chunks of the same page tie on score
 * (basis-vector eval fixtures, planner-independent — same rationale as the
 * v0.41.13 searchVector stable tiebreaker).
 *
 * Pooling happens over the FULL candidate set (`innerLimit` rows) BEFORE the
 * user-facing `LIMIT`, so a page's best chunk can't be truncated out by
 * weaker chunks of OTHER pages occupying the early `LIMIT` slots — the vector
 * path now returns N distinct pages (each by best chunk), not N chunks that
 * collapse to fewer pages downstream.
 *
 * @param candidateCte — name of the upstream CTE to pool (e.g. `'hnsw_candidates'`,
 *                        `'ranked_chunks'`). Engine-supplied identifier, never user input.
 * @returns raw SQL fragment: `best_per_page AS ( ... )` (no trailing comma)
 */
export function buildBestPerPagePoolCte(candidateCte: string): string {
  return `best_per_page AS (
        SELECT DISTINCT ON (COALESCE(source_id, 'default'), slug) *
        FROM ${candidateCte}
        ORDER BY COALESCE(source_id, 'default'), slug, score DESC, page_id ASC, chunk_id ASC
      )`;
}

// ============================================================
// v0.29.1 — Recency component SQL builder
// ============================================================

/**
 * Typed expression for "what NOW() should be" in the SQL. Tests pass
 * `{ kind: 'fixed', isoUtc }` for deterministic output regardless of wall
 * clock. Production callers leave it default (`{ kind: 'now' }`).
 *
 * The builder constructs the SQL literal internally via escapeSqlLiteral
 * for the 'fixed' branch — caller-supplied strings NEVER flow into raw SQL,
 * preventing the injection vector codex pass-1 #5 flagged.
 */
export type NowExpr = { kind: 'now' } | { kind: 'fixed'; isoUtc: string };

function nowExprToSql(now: NowExpr): string {
  if (now.kind === 'now') return 'NOW()';
  return `'${escapeSqlLiteral(now.isoUtc)}'::timestamptz`;
}

/**
 * Build the per-row recency component SQL fragment.
 *
 * For each prefix in the decay map, emit one CASE branch:
 *   - halflifeDays = 0 (or coefficient = 0) → literal 0 (evergreen short-circuit)
 *   - halflifeDays > 0  → coefficient * halflife / (halflife + days_old)
 *
 * Prefixes sorted longest-first so 'media/articles/' matches before 'media/'
 * (mirror of buildSourceFactorCase's ordering).
 *
 * Output is a single SQL expression suitable for SELECT / ORDER BY.
 *
 * @param slugColumn — qualified column reference (engine-supplied, trusted)
 * @param dateExpr   — qualified expression for the page's effective date
 *                     (typically `COALESCE(p.effective_date, p.updated_at)`)
 * @param decayMap   — per-prefix configurations (resolved from defaults +
 *                     yaml + env + caller)
 * @param fallback   — applied to slugs matching no prefix
 * @param now        — typed NOW() expression (default `{ kind: 'now' }`)
 */
export function buildRecencyComponentSql(opts: {
  slugColumn: string;
  dateExpr: string;
  decayMap: import('./recency-decay.ts').RecencyDecayMap;
  fallback: import('./recency-decay.ts').RecencyDecayConfig;
  now?: NowExpr;
}): string {
  const { slugColumn, dateExpr, decayMap, fallback } = opts;
  const now = opts.now ?? { kind: 'now' };
  const nowSql = nowExprToSql(now);
  const daysOldSql = `EXTRACT(EPOCH FROM (${nowSql} - ${dateExpr})) / 86400.0`;

  const prefixes = Object.keys(decayMap).sort((a, b) => b.length - a.length);
  const branches: string[] = [];

  for (const prefix of prefixes) {
    const cfg = decayMap[prefix];
    const literal = buildLikePrefixLiteral(prefix);
    if (cfg.halflifeDays === 0 || cfg.coefficient === 0) {
      branches.push(`WHEN ${slugColumn} LIKE ${literal} THEN 0`);
    } else {
      const h = cfg.halflifeDays;
      const c = cfg.coefficient;
      branches.push(
        `WHEN ${slugColumn} LIKE ${literal} THEN ${c} * ${h}.0 / (${h}.0 + ${daysOldSql})`,
      );
    }
  }

  let elseSql: string;
  if (fallback.halflifeDays === 0 || fallback.coefficient === 0) {
    elseSql = '0';
  } else {
    const h = fallback.halflifeDays;
    const c = fallback.coefficient;
    elseSql = `${c} * ${h}.0 / (${h}.0 + ${daysOldSql})`;
  }

  if (branches.length === 0) return `(${elseSql})`;
  return `(CASE ${branches.join(' ')} ELSE ${elseSql} END)`;
}

// Exported for unit tests
export const __test__ = { escapeLikePattern, escapeSqlLiteral, buildLikePrefixLiteral };
