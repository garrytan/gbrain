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
}
