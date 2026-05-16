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

export type Severity = 'low' | 'medium' | 'high';

export type ResolutionKind =
  | 'takes_supersede'
  | 'dream_synthesize'
  | 'takes_mark_debate'
  | 'manual_review';

export type SourceTier = 'curated' | 'bulk' | 'other';

/**
 * Judge's verdict for a single pair. Either the judge ran cleanly and we have
 * scoring, or it failed and we have a typed error to surface in the report.
 */
export interface JudgeVerdict {
  contradicts: boolean;
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
  severity: Severity;
  axis: string;
  confidence: number;
  resolution_kind: ResolutionKind;
  resolution_command: string;
}

export interface PerQueryResult {
  query: string;
  result_count: number;
  contradictions: ContradictionFinding[];
  /** Pairs the date pre-filter rejected before any judge call. Diagnostic only. */
  pairs_skipped_by_date: number;
  /** Pairs the cache satisfied without a judge call. */
  pairs_cache_hit: number;
  /** Pairs the judge actually scored. */
  pairs_judged: number;
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
  queries_with_contradiction: number;
  total_contradictions_flagged: number;
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
