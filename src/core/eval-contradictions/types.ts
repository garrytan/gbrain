/**
 * eval-contradictions/types — stable shapes for the contradiction probe.
 *
 * `schema_version: 1` is the wire contract for `gbrain eval suspected-contradictions --json`.
 * `PROMPT_VERSION` is the cache-key discriminator: bumping this invalidates every
 * cached judge verdict from prior runs, which is the point — when the prompt edits,
 * old verdicts are no longer trustworthy.
 *
 * Adding fields: append-only, default-tolerant. Renaming fields or changing
 * field types is a schema_version bump.
 */

export const SCHEMA_VERSION = 1 as const;

/**
 * Bump when the judge prompt in judge.ts changes meaningfully. Used as part
 * of the cache key tuple — bumping invalidates every cached verdict from
 * prior runs, which is the point: when the prompt edits, old verdicts are
 * no longer trustworthy.
 *
 * v2 (Lane A1, 2026-05): judge prompt now receives `Statement A (from: YYYY-MM-DD)`
 *   or `(date unknown)` per side. Old v1 verdicts are silently invalidated.
 */
export const PROMPT_VERSION = '2' as const;

/** Truncation policy string baked into the cache key. */
export const TRUNCATION_POLICY = '1500-chars-utf8-safe' as const;

export type ContradictionKind = 'cross_slug_chunks' | 'intra_page_chunk_take';

/**
 * v0.34 / Lane A2: severity gains 'info' for the new non-error-class verdicts
 * (temporal_supersession, temporal_evolution) that should surface in the
 * report without inflating the contradiction count.
 */
export type Severity = 'info' | 'low' | 'medium' | 'high';

/**
 * v0.34 / Lane A2: replaces the v1 `contradicts: boolean` shape. Six members.
 *
 * - no_contradiction      → drop from findings (not surfaced)
 * - contradiction         → genuine conflict at the same point in time
 * - temporal_supersession → newer claim updates/replaces older; not an error
 * - temporal_regression   → metric/status went backwards over time
 * - temporal_evolution    → legitimate change over time, neither of the above
 * - negation_artifact     → judge misread an explicit negation in one chunk
 */
export type Verdict =
  | 'no_contradiction'
  | 'contradiction'
  | 'temporal_supersession'
  | 'temporal_regression'
  | 'temporal_evolution'
  | 'negation_artifact';

/**
 * Resolution kinds. v0.34 / Lane A2 added three new members covering the new
 * verdicts; the original four still apply to `verdict === 'contradiction'`.
 *
 * - temporal_supersede     → render `gbrain takes supersede ... --since <date>`
 * - flag_for_review        → informational; no CLI command rendered
 * - log_timeline_change    → render a hint pointing at the future
 *                             timeline-writer subcommand (deferred)
 */
export type ResolutionKind =
  | 'takes_supersede'
  | 'dream_synthesize'
  | 'takes_mark_debate'
  | 'manual_review'
  | 'temporal_supersede'
  | 'flag_for_review'
  | 'log_timeline_change';

export type SourceTier = 'curated' | 'bulk' | 'other';

/**
 * Judge's verdict for a single pair. Either the judge ran cleanly and we have
 * scoring, or it failed and we have a typed error to surface in the report.
 *
 * v0.34 / Lane A2: `verdict: Verdict` replaces the v1 `contradicts: boolean`.
 * Every consumer that previously branched on `verdict.contradicts` now
 * switches on `verdict.verdict`. PROMPT_VERSION bumped in A1 invalidates the
 * old cached rows.
 */
export interface JudgeVerdict {
  verdict: Verdict;
  severity: Severity;
  /** One-line description of what they disagree about, or empty when no contradiction. */
  axis: string;
  confidence: number;
  resolution_kind: ResolutionKind | null;
}

/** Error classes counted toward the run's denominator (NOT silent skips). */
export type JudgeErrorKind = 'parse_fail' | 'refusal' | 'timeout' | 'http_5xx' | 'unknown';

export interface JudgeErrorRow {
  kind: JudgeErrorKind;
  pair_id: string;
  reason: string;
}

export interface JudgeErrorsCounts {
  parse_fail: number;
  refusal: number;
  timeout: number;
  http_5xx: number;
  unknown: number;
  total: number;
  /** Surfaced verbatim in output so users know errors are counted, not silent. */
  note: string;
}

/** One end of a pair (chunk or take). Shape unified across kinds. */
export interface PairMember {
  slug: string;
  /** Present for cross_slug_chunks; null when this end is a take. */
  chunk_id: number | null;
  /** Present for intra_page_chunk_take when this end is a take. */
  take_id: number | null;
  source_tier: SourceTier;
  /** Takes-only: who holds the take (`garry`, `alice`, ...). */
  holder: string | null;
  text: string;
  /**
   * v0.34 / Lane A1: page-level effective_date carried through from SearchResult.
   * Format: YYYY-MM-DD (ISO date-only). Threaded into the judge prompt so the
   * model can classify supersession/regression/evolution. Null means "no
   * temporal anchor for this chunk" — judge sees `(date unknown)` for this side.
   */
  effective_date: string | null;
  effective_date_source: string | null;
}

export interface ContradictionPair {
  kind: ContradictionKind;
  a: PairMember;
  b: PairMember;
  /** Sum of both members' retrieval scores. Used for deterministic ordering. */
  combined_score: number;
}

export interface ContradictionFinding extends ContradictionPair {
  /**
   * v0.34 / Lane A2: which verdict bucket this finding belongs to. Always one
   * of the five non-`no_contradiction` members (no_contradiction findings are
   * dropped from the report by the runner emit predicate).
   */
  verdict: Verdict;
  severity: Severity;
  axis: string;
  confidence: number;
  resolution_kind: ResolutionKind;
  resolution_command: string;
}

export interface PerQueryResult {
  query: string;
  result_count: number;
  /**
   * v0.34 / Lane A2: contains every non-`no_contradiction` finding (genuine
   * contradictions PLUS temporal_supersession / temporal_regression /
   * temporal_evolution / negation_artifact). Field name preserved for wire-
   * compatibility; consumers that want the strict-contradiction subset
   * filter on `f.verdict === 'contradiction'`.
   */
  contradictions: ContradictionFinding[];
  /** Pairs the date pre-filter rejected before any judge call. Diagnostic only. */
  pairs_skipped_by_date: number;
  /** Pairs the cache satisfied without a judge call. */
  pairs_cache_hit: number;
  /** Pairs the judge actually scored. */
  pairs_judged: number;
}

/**
 * v0.34 / Lane A2: per-run tally across all 6 verdicts. Surfaces in the trend
 * rollup so operators can see whether `gbrain eval suspected-contradictions`
 * is finding mostly genuine contradictions or mostly temporal noise.
 */
export interface VerdictBreakdown {
  no_contradiction: number;
  contradiction: number;
  temporal_supersession: number;
  temporal_regression: number;
  temporal_evolution: number;
  negation_artifact: number;
}

export interface SourceTierBreakdown {
  curated_vs_curated: number;
  curated_vs_bulk: number;
  bulk_vs_bulk: number;
  /** Anything that didn't fit the curated/bulk binary. */
  other: number;
}

export interface WilsonCI {
  point: number;
  lower: number;
  upper: number;
}

export interface Calibration {
  queries_total: number;
  queries_judged_clean: number;
  queries_with_contradiction: number;
  wilson_ci_95: WilsonCI;
  /** Emitted when n < 30 so the user knows the bounds are too wide to act on. */
  small_sample_note?: string;
}

export interface CostBreakdown {
  judge: number;
  embedding: number;
  total: number;
  estimate_note: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hit_rate: number;
}

export interface HotPage {
  slug: string;
  appearances: number;
  max_severity: Severity;
}

export interface ProbeReport {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  judge_model: string;
  prompt_version: string;
  truncation_policy: string;
  top_k: number;
  sampling: 'deterministic' | 'score-first';
  queries_evaluated: number;
  /**
   * Count of queries that produced at least one `verdict === 'contradiction'`
   * finding. Strict-contradiction count; used as the headline metric + the
   * Wilson-CI denominator. v0.34 / Lane A2: meaning preserved from v1, but
   * the field is now narrower than `queries_with_any_finding`.
   */
  queries_with_contradiction: number;
  /**
   * v0.34 / Lane A2: count of queries with ANY non-`no_contradiction` verdict.
   * Always >= queries_with_contradiction. Helps operators see whether the
   * probe is finding mostly genuine contradictions or mostly temporal signals.
   */
  queries_with_any_finding: number;
  total_contradictions_flagged: number;
  /**
   * v0.34 / Lane A2: per-verdict tally across every judged pair in the run.
   * The sum equals (pairs_judged + cache_hits) across all queries.
   */
  verdict_breakdown: VerdictBreakdown;
  calibration: Calibration;
  judge_errors: JudgeErrorsCounts;
  cost_usd: CostBreakdown;
  cache: CacheStats;
  duration_ms: number;
  source_tier_breakdown: SourceTierBreakdown;
  per_query: PerQueryResult[];
  hot_pages: HotPage[];
}

/** Shape persisted to `eval_contradictions_runs` table. Mirrors the columns. */
export interface ContradictionsRunRow {
  run_id: string;
  ran_at: string;
  schema_version: number;
  judge_model: string;
  prompt_version: string;
  queries_evaluated: number;
  queries_with_contradiction: number;
  total_contradictions_flagged: number;
  wilson_ci_lower: number;
  wilson_ci_upper: number;
  judge_errors_total: number;
  cost_usd_total: number;
  duration_ms: number;
  source_tier_breakdown: SourceTierBreakdown;
  report_json: ProbeReport;
}

/** Shape persisted to `eval_contradictions_cache` table. */
export interface ContradictionsCacheRow {
  chunk_a_hash: string;
  chunk_b_hash: string;
  model_id: string;
  prompt_version: string;
  truncation_policy: string;
  verdict: JudgeVerdict;
  created_at: string;
  expires_at: string;
}
