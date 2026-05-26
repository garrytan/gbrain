/**
 * v0.41 D4 — submit-time cost + duration projection for batch jobs.
 *
 * Closes the "wake up to a $300 Anthropic bill" failure mode at the source.
 * Before `gbrain jobs submit` queues a batch, this projection prints
 * "this batch will take ~30 min and cost ~$2.40 at current cap of 32".
 * TTY users get a confirmation prompt above the configurable threshold;
 * cron / non-TTY callers see the projection on stderr and proceed.
 *
 * Math is deliberately rough — heavy-tailed (codex pass-2 #11) so we
 * carry a ±30% confidence band rather than pretending precision.
 *
 * Cold-start fallback (no historical jobs for the model/name): model-
 * default per-token pricing + 5s mean latency estimate. Operators see
 * `(no history; estimate is a wide guess)` so they don't trust the
 * number more than it deserves.
 *
 * Unknown model: returns the `cost_estimate_unavailable` tagged variant
 * with the model name. The `--budget-usd` flag refuses to gate against
 * an unavailable cost estimate; same precedent as cross-modal-eval.
 */

import { ANTHROPIC_PRICING } from '../anthropic-pricing.ts';

export interface RecentJobStats {
  /** How many jobs informed this window. 0 → cold start. */
  sample_size: number;
  /** Mean wall-clock duration per job. ms. Undefined when cold start. */
  mean_latency_ms?: number;
  /** Mean USD cost per job. Undefined when cold start OR cost unavailable. */
  mean_cost_usd?: number;
  /** Standard deviation of cost per job. Used for ±band. */
  stddev_cost_usd?: number;
  /** Effective concurrency seen recently (min of worker pool + lease cap). */
  effective_concurrency: number;
  /** Lease cap headroom; informational. */
  lease_headroom?: number;
}

export interface BatchProjection {
  /** Total wall-clock estimate in ms. */
  total_duration_ms: number;
  /** Total cost estimate USD. NaN-safe; null when unknown model. */
  total_cost_usd: number | null;
  /** ±USD band (≈30% of cost OR derived from sample stddev). */
  cost_band_usd: number | null;
  /** ±ms band on duration. */
  duration_band_ms: number;
  /** Concurrency used for the math. */
  effective_concurrency: number;
  /** True when no historical data was available; estimate is a wide guess. */
  cold_start: boolean;
  /** When non-null, model name that has no pricing entry. */
  unknown_model?: string;
  /** Suggested cap-raise (informational; printed in stderr). */
  raise_cap_hint?: string;
}

/** Strip `provider:` prefix the same way the SDK call site does. */
function bareModel(model: string): string {
  const idx = model.indexOf(':');
  return idx > 0 ? model.slice(idx + 1) : model;
}

/**
 * Resolve per-token cost for a model. Returns null for unknown models.
 * Conservative: uses output-side pricing as a tight upper bound when
 * we don't have per-call usage stats yet.
 */
function modelDefaultMeanCostUsd(model: string): number | null {
  // Match the alias map's behavior loosely: bare names + the few we know.
  const bare = bareModel(model);
  const p = ANTHROPIC_PRICING[bare];
  if (!p) return null;
  // Assume a typical subagent turn: ~2k input + ~1k output tokens.
  // Heavy bound; real avgs will be smaller for simple jobs, larger for
  // tool-loop heavy jobs. The cold-start `(no history)` annotation tells
  // the operator the number is approximate.
  const COLD_INPUT = 2000;
  const COLD_OUTPUT = 1000;
  return (COLD_INPUT * p.input + COLD_OUTPUT * p.output) / 1_000_000;
}

const COLD_LATENCY_MS = 5000;

export interface ProjectBatchInput {
  job_count: number;
  /** `provider:model` or bare model id. Used for pricing lookup. */
  model: string;
  stats: RecentJobStats;
  /** Current rate-lease cap; used for the raise-cap hint. */
  current_lease_cap: number;
}

export function projectBatch(input: ProjectBatchInput): BatchProjection {
  const { job_count, model, stats, current_lease_cap } = input;
  const bare = bareModel(model);
  const cold = stats.sample_size === 0;

  // Mean latency: historical → use it. Cold → 5s guess.
  const meanLatencyMs = stats.mean_latency_ms ?? COLD_LATENCY_MS;

  // Mean cost: historical → use it. Cold → model-default guess. Unknown
  // model → return the tagged variant.
  let meanCostUsd: number | null = stats.mean_cost_usd ?? modelDefaultMeanCostUsd(model);
  if (meanCostUsd === null && !(bare in ANTHROPIC_PRICING)) {
    // Unknown model — projection lacks a cost surface.
    const concurrency = Math.max(1, Math.min(stats.effective_concurrency, current_lease_cap));
    return {
      total_duration_ms: Math.ceil((job_count / concurrency) * meanLatencyMs),
      total_cost_usd: null,
      cost_band_usd: null,
      duration_band_ms: Math.ceil(meanLatencyMs * 0.5),
      effective_concurrency: concurrency,
      cold_start: cold,
      unknown_model: bare,
    };
  }
  if (meanCostUsd === null) meanCostUsd = 0; // defensive; shouldn't reach

  // Effective concurrency is min of worker pool seen recently + lease cap.
  const concurrency = Math.max(1, Math.min(stats.effective_concurrency, current_lease_cap));

  const totalDurationMs = Math.ceil((job_count / concurrency) * meanLatencyMs);
  const totalCostUsd = job_count * meanCostUsd;

  // Confidence band: when we have stddev, use it (×1.96 ≈ 95%). Cold
  // start or no stddev → ±30% blanket.
  const costBand = stats.stddev_cost_usd
    ? job_count * stats.stddev_cost_usd * 1.96
    : totalCostUsd * 0.30;
  const durationBand = totalDurationMs * 0.30;

  // Raise-cap hint when lease cap is the binding constraint. If raising
  // the cap by 4x would meaningfully shrink wall-clock, suggest it.
  let raise_cap_hint: string | undefined;
  if (stats.lease_headroom !== undefined && stats.lease_headroom <= 0.1 && current_lease_cap < 128) {
    const suggestedCap = Math.min(current_lease_cap * 4, 128);
    const projectedFasterMs = Math.ceil((job_count / Math.min(suggestedCap, stats.effective_concurrency)) * meanLatencyMs);
    if (projectedFasterMs < totalDurationMs * 0.75) {
      raise_cap_hint =
        `raise GBRAIN_ANTHROPIC_MAX_INFLIGHT to ${suggestedCap} to finish in ~${Math.ceil(projectedFasterMs / 60_000)}min`;
    }
  }

  return {
    total_duration_ms: totalDurationMs,
    total_cost_usd: totalCostUsd,
    cost_band_usd: costBand,
    duration_band_ms: durationBand,
    effective_concurrency: concurrency,
    cold_start: cold,
    raise_cap_hint,
  };
}

/**
 * Format a projection as a human-readable single line for stderr / TTY.
 * Matches the style of the doctor + jobs stats output: concise, with
 * confidence band when meaningful, with the paste-ready hint when
 * applicable.
 */
export function formatProjection(p: BatchProjection): string {
  const mins = Math.max(1, Math.ceil(p.total_duration_ms / 60_000));
  const minsBand = Math.ceil(p.duration_band_ms / 60_000);
  if (p.unknown_model) {
    return `[batch] est duration ~${mins}min (±${minsBand}min) at concurrency=${p.effective_concurrency}; cost estimate unavailable (model "${p.unknown_model}" not in pricing maps).`;
  }
  const dollars = (p.total_cost_usd ?? 0).toFixed(2);
  const dollarsBand = (p.cost_band_usd ?? 0).toFixed(2);
  const coldNote = p.cold_start ? ' (no history; estimate is a wide guess)' : '';
  const hint = p.raise_cap_hint ? ` — ${p.raise_cap_hint}` : '';
  return `[batch] est cost ~$${dollars} (±$${dollarsBand}), est duration ~${mins}min (±${minsBand}min) at concurrency=${p.effective_concurrency}${coldNote}${hint}`;
}

/**
 * Threshold gating: should the TTY prompt for confirmation?
 * Defaults: prompt above $5 OR 30min. Overridable via env vars
 * matching the plan's spec.
 */
export function shouldPromptAtThreshold(p: BatchProjection): boolean {
  const usdThreshold = Number(process.env.GBRAIN_BATCH_PROMPT_THRESHOLD_USD ?? '5');
  const minThreshold = Number(process.env.GBRAIN_BATCH_PROMPT_THRESHOLD_MIN ?? '30');
  const usdOverThreshold = (p.total_cost_usd ?? 0) >= usdThreshold;
  const minutesOverThreshold = p.total_duration_ms >= minThreshold * 60_000;
  return usdOverThreshold || minutesOverThreshold;
}
