/**
 * takes-quality-eval/receipt — stable JSON shape for one eval run.
 *
 * `schema_version: 1` is a one-way-door contract (codex review #3). Rename
 * fields → bump schema_version. Adding optional fields is additive and
 * compatible. Any changes here MUST be reflected in docs/eval-takes-quality.md
 * since gbrain-evals (sibling repo) consumes this shape.
 */
import type { RubricDimension } from './rubric.ts';
import type { DimensionRoll } from './aggregate.ts';

export interface TakesQualityReceipt {
  schema_version: 1;
  /** ISO 8601 UTC timestamp of run start. */
  ts: string;
  /** Rubric version at the time of run. */
  rubric_version: string;
  /** Rubric definition fingerprint (binds receipt to its rubric epoch). */
  rubric_sha8: string;
  corpus: {
    source: 'db' | 'fs';
    n_takes: number;
    slug_prefix: string | null;
    corpus_sha8: string;
  };
  prompt_sha8: string;
  models_sha8: string;
  /** Models in slot order; sort-stable before hashing into models_sha8. */
  models: string[];
  cycles_run: number;
  /** One entry per cycle; the count of contributing models that cycle. */
  successes_per_cycle: number[];
  verdict: 'pass' | 'fail' | 'inconclusive';
  scores: Partial<Record<RubricDimension, DimensionRoll>>;
  /** Mean of dim means; null when verdict=inconclusive. */
  overall_score: number | null;
  cost_usd: number;
  /** Top-10 deduped improvements; absent when verdict=inconclusive. */
  improvements?: string[];
  /** Per-slot errors carried through for debugging. */
  errors?: Array<{ modelId: string; error: string }>;
  /** One-line human verdict prose. */
  verdictMessage?: string;
  /**
   * Eval protocol; absent means 1. Protocol 2 (#5331, #5325): judges run with
   * thinking off, and a slot whose reply is malformed (`parse_failed` /
   * `incomplete_scores`) is re-asked once with the same model and sample.
   * `regress` reports a protocol change as a dissimilar input.
   */
  protocol_version?: number;
  /** Protocol 2: a corrected reply replaces the first attempt only when it validates. */
  correction_selection_rule?: 'corrected_if_valid';
  /**
   * Protocol 2: one entry per malformed slot. `cycle` is 0-based like
   * `successes_per_cycle`. `first_error` is the first attempt's format
   * failure; `corrected` is the correction's outcome, or null when it was not
   * sent (`skipped_reason`: the budget cap could not cover it, or the run was
   * aborted). Provider errors and valid low scores are never corrected.
   */
  corrections?: TakesQualityCorrection[];
}

export interface TakesQualityCorrection {
  cycle: number;
  modelId: string;
  first_error: string;
  corrected: 'valid' | 'invalid' | null;
  corrected_error?: string;
  skipped_reason?: 'budget' | 'aborted';
}
