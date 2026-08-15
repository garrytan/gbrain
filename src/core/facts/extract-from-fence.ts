/**
 * v0.32.2: pure mapper from parsed-fence rows → NewFact rows ready for
 * batch insert.
 *
 * The fence parser (`src/core/facts-fence.ts`) is markdown-shaped: rows
 * carry strings, optional flags, and the strikethrough-context semantic
 * distinction. The engine layer (`engine.insertFact` / new
 * `engine.insertFacts`) is Date-shaped and DB-shaped. This module is the
 * boundary.
 *
 * It is intentionally pure: no engine call, no I/O. Inputs are the parsed
 * facts plus the page-level binding (entity slug + source_id). Output is
 * a `FenceExtractedFact[]` — structural superset of `NewFact` that
 * carries the v51 fence columns (`row_num`, `source_markdown_slug`).
 *
 * Codex Q7 resolution: engines stay markdown-unaware. The cycle phase
 * (commit 7) and the backstop rewrite (commit 5) call this function to
 * convert parsed fences into engine-shaped rows, then hand them to the
 * batch insert.
 *
 * Strikethrough → date derivation:
 *   - `forgotten` rows get `valid_until = today` so the DB's existing
 *     `expired_at = valid_until + now()` rule produces the same forget
 *     state after `gbrain rebuild` (v0.32.3) as before.
 *   - `supersededBy` rows preserve their existing `validUntil` if set;
 *     otherwise leave `valid_until = null` (the consolidator phase fills
 *     this in based on the newer row's `valid_from`).
 *   - Inactive rows with neither flag (parser-tolerated hand-edits) are
 *     treated like `forgotten` for DB-derivation purposes — the user's
 *     strikethrough intent is honored; the lost reason is a JSONL
 *     warning surfaced by extract-facts, not a parse failure.
 */

import type { NewFact, FactKind, FactVisibility } from '../engine.ts';
import type { ParsedFact } from '../facts-fence.ts';

/**
 * Fence-extracted fact row. Structural superset of `NewFact` with the
 * v51 fence-only columns. Commit 4 widens the engine surface
 * (`insertFacts(rows, opts)`) to accept this shape directly. Until then,
 * the type lives here so commit 3 ships without an engine touch.
 */
export type FenceExtractedFact = NewFact & {
  row_num: number;
  source_markdown_slug: string;
};

/**
 * Default `source` value when a fence row doesn't carry one. The string
 * is the explicit provenance tag downstream consumers (recall, doctor)
 * use to distinguish backfilled / reconciled rows from rows originally
 * inserted via `mcp:extract_facts` or `cli:think`.
 *
 * Exported so the migration orchestrator (commit 6) can reuse it when
 * fencing pre-v51 DB facts that have no `source` recorded.
 */
export const FENCE_SOURCE_DEFAULT = 'fence:reconcile';

function parseValidDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  // Be lenient on date shape — accept 'YYYY-MM-DD' or full ISO.
  // Invalid → undefined (caller decides whether to default or skip).
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * Format today's date as 'YYYY-MM-DD' UTC. Stable across timezones — used
 * by the forgotten-row derivation so re-running the mapping on the same
 * fence in different zones produces an identical `valid_until` (matters
 * for the bisect E2E that asserts byte-identical DB state after re-extract).
 */
function todayUtcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface ExtractFromFenceOpts {
  /**
   * Override for "today" — only used by tests to make the forgotten-row
   * derivation deterministic. Production callers leave this unset and
   * the mapper uses real UTC midnight today.
   */
  nowOverride?: Date;
  /**
   * v0.35.4 (D-ENG-1 + D-CDX-5) — optional fallback for `valid_from` when
   * the fence row lacks an explicit `validFrom:`. Threaded by the
   * `extract-facts` cycle phase from `engine.getPage(slug).effective_date`
   * so a meeting page dated 2026-04-28 stamps its facts as claimed-on
   * that date instead of "the import timestamp".
   *
   * Precedence chain:
   *   1. Explicit `validFrom:` in the fence row (today's behavior, preserved).
   *   2. `pageEffectiveDate` when set.
   *   3. `undefined` → engine.insertFact defaults to now() at insert time.
   *
   * Optional because `facts/fence-write.ts` calls this from a context
   * with no `Page` object available (Codex F6). Null and undefined are
   * treated identically: fall through to behavior (3).
   */
  pageEffectiveDate?: Date | null;
}

/**
 * v0.35.4 (D-ENG-4) — normalized metric vocabulary.
 *
 * Seed map for common founder/company metrics. Free-text labels normalize
 * to lowercase snake_case so trajectory queries don't fragment across
 * capitalization variants. Unknown labels still pass through (lowercased
 * + spaces → underscores) so the user can author arbitrary metrics
 * without a code change. Exported so tests can pin the map.
 */
export const METRIC_NORMALIZATION_MAP: ReadonlyMap<string, string> = new Map([
  // Revenue / financial
  ['mrr', 'mrr'],
  ['monthly recurring revenue', 'mrr'],
  ['arr', 'arr'],
  ['annual recurring revenue', 'arr'],
  ['revenue', 'revenue'],
  ['burn', 'burn_rate'],
  ['burn rate', 'burn_rate'],
  ['runway', 'runway'],
  ['cash', 'cash'],
  ['gross margin', 'gross_margin'],
  // Funding
  ['fundraise', 'fundraise'],
  ['raise', 'fundraise'],
  // People
  ['headcount', 'headcount'],
  ['team size', 'team_size'],
  ['team', 'team_size'],
  // Users / engagement
  ['users', 'users'],
  ['mau', 'mau'],
  ['monthly active users', 'mau'],
  ['dau', 'dau'],
  ['daily active users', 'dau'],
  ['churn', 'churn_rate'],
  ['churn rate', 'churn_rate'],
  // Unit economics
  ['cac', 'cac'],
  ['ltv', 'ltv'],
]);

/**
 * Normalize a free-text metric label to lowercase snake_case. Known
 * labels (seed map above) map to canonical names; unknown labels are
 * lowercased + whitespace-collapsed → underscores. Returns undefined for
 * empty / whitespace-only input so the caller can treat it as "no
 * metric set" without an extra null check.
 */
export function normalizeMetricLabel(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const seed = METRIC_NORMALIZATION_MAP.get(trimmed);
  if (seed) return seed;
  // Collapse runs of whitespace to single underscore, strip non-alphanumeric
  // edges. Allows users to write "Net Promoter Score" → `net_promoter_score`
  // without registering it.
  return trimmed.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Map an array of parsed fence rows into engine-ready batch insert rows.
 *
 * @param facts        ParsedFact[] from parseFactsFence()
 * @param slug         The entity page slug (also becomes source_markdown_slug)
 * @param sourceId     The source binding (resolved from sources.local_path
 *                     by the caller; multi-source brains thread this through)
 * @param opts         Optional overrides (test nowOverride; v0.35.4 page-date fallback)
 */
export function extractFactsFromFenceText(
  facts: ParsedFact[],
  slug: string,
  sourceId: string,
  opts: ExtractFromFenceOpts = {},
): FenceExtractedFact[] {
  const today = opts.nowOverride ?? todayUtcDate();
  const pageDateFallback = opts.pageEffectiveDate ?? undefined;

  return facts.map(f => {
    // v0.35.4 (D-ENG-1) valid_from precedence: fence > pageEffectiveDate > engine default (now).
    const fenceDate = parseValidDate(f.validFrom);
    const validFrom = fenceDate ?? pageDateFallback ?? undefined;

    // valid_until derivation. Three branches:
    //   1. Explicit validUntil in the fence → honor as-is.
    //   2. Inactive (forgotten OR strikethrough-unrecognized) → today.
    //   3. Otherwise → null.
    // supersededBy without an explicit validUntil leaves null; the
    // consolidator phase populates it later from the newer row's
    // valid_from.
    let validUntil: Date | null;
    const explicitUntil = parseValidDate(f.validUntil);
    if (explicitUntil) {
      validUntil = explicitUntil;
    } else if (!f.active && (f.forgotten || f.supersededBy === undefined)) {
      // forgotten or unrecognized-inactive: stamp today.
      // (supersededBy with NO explicit validUntil falls through to null
      // intentionally — the consolidator owns that derivation.)
      validUntil = today;
    } else {
      validUntil = null;
    }

    const row: FenceExtractedFact = {
      fact: f.claim,
      kind: f.kind as FactKind,
      entity_slug: slug,
      visibility: f.visibility as FactVisibility,
      notability: f.notability,
      context: f.context ?? null,
      valid_from: validFrom,
      valid_until: validUntil,
      source: f.source ?? FENCE_SOURCE_DEFAULT,
      confidence: f.confidence,
      row_num: f.rowNum,
      source_markdown_slug: slug,
      // v0.35.4 (D-CDX-5) — typed-claim threading. Metric label normalized
      // here so the DB-side index hits use the canonical name; value /
      // unit / period stored verbatim.
      claim_metric: normalizeMetricLabel(f.claimMetric) ?? null,
      claim_value:  f.claimValue ?? null,
      claim_unit:   f.claimUnit ?? null,
      claim_period: f.claimPeriod ?? null,
    };
    return row;
  });
}
