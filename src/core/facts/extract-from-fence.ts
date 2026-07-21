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
  /**
   * v0.42 (#3014) — page-local row reference parsed from `~~claim~~` +
   * `superseded by #N` (the `#N`). NOT a fact id: `facts.superseded_by`
   * is a FK to `facts.id`, so `insertFacts` resolves this row number to
   * the target row's id in a second pass. undefined when the row is not
   * a supersession.
   */
  superseded_by_row?: number;
};

/**
 * v0.42 (#3014) — the target row a struck `superseded by #N` reference
 * resolves to, as seen at insert time.
 */
export interface SupersedeTarget {
  id: number;
  /**
   * true when the target row is itself inactive (its `expired_at` is
   * set) — i.e. `#N` points at another struck row (a chain). A
   * supersession target must be a live row, so a struck target is
   * rejected.
   */
  struck: boolean;
}

/** Outcome of resolving a `superseded by #N` reference to a fact id. */
export interface SupersedeResolution {
  /** The resolved target fact id, or null when the reference is unsafe. */
  superseded_by: number | null;
  /** A human-readable warning when the reference could not be resolved. */
  warning: string | null;
}

/**
 * v0.42 (#3014) — resolve a struck row's `superseded by #N` page-local
 * reference to a fact id. Pure: the caller supplies the already-looked-up
 * `target` (keyed on source + row_num within the same transaction) so
 * this decision is unit-testable without a DB.
 *
 * Three references are unsafe and resolve to NULL + a warning (never an
 * FK write to a guessed id); `expired_at` is set by the mapper regardless
 * of the outcome so the struck row still exits active views:
 *   - self-reference (`#N` == the row's own number)
 *   - dangling (`#N` names a row absent from the page)
 *   - chain (`#N` names another struck row)
 */
export function resolveSupersededByRow(
  ownRowNum: number,
  supersededByRow: number,
  target: SupersedeTarget | undefined,
  slug: string,
): SupersedeResolution {
  if (supersededByRow === ownRowNum) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" references itself — leaving superseded_by NULL`,
    };
  }
  if (!target) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" names a row absent from the fence — leaving superseded_by NULL`,
    };
  }
  if (target.struck) {
    return {
      superseded_by: null,
      warning: `${slug} row ${ownRowNum}: "superseded by #${supersededByRow}" names a row that is itself superseded (chain) — leaving superseded_by NULL`,
    };
  }
  return { superseded_by: target.id, warning: null };
}

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

    // v0.42 (#3014) — struck rows carry their expiry + supersession
    // reference into the DB. `expired_at` has no DB derivation from
    // `valid_until` (no trigger, sweep, or read-time coalesce), so the
    // mapper stamps it explicitly for EVERY inactive row (superseded,
    // forgotten, or inactive-unrecognized) — that is how a struck row
    // exits active views. `valid_until ?? today` keeps it deterministic
    // under nowOverride. Active rows leave it null.
    const expiredAt: Date | null = !f.active ? (validUntil ?? today) : null;

    const row: FenceExtractedFact = {
      fact: f.claim,
      kind: f.kind as FactKind,
      entity_slug: slug,
      visibility: f.visibility as FactVisibility,
      notability: f.notability,
      context: f.context ?? null,
      valid_from: validFrom,
      valid_until: validUntil,
      expired_at: expiredAt,
      source: f.source ?? FENCE_SOURCE_DEFAULT,
      confidence: f.confidence,
      row_num: f.rowNum,
      source_markdown_slug: slug,
      // v0.42 (#3014) — carry the page-local `superseded by #N` reference
      // for insertFacts to resolve to a fact id. undefined for non-struck
      // rows and for struck rows with no supersession context.
      superseded_by_row: f.supersededBy,
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
