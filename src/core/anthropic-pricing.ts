/**
 * v0.28: Anthropic model pricing constants for the dream-cycle budget meter.
 *
 * Prices in USD per 1M tokens (input | output). Numbers reflect Anthropic's
 * published pricing as of 2026-05-01. Update when Anthropic publishes new
 * pricing — the JSON in `~/.gbrain/audit/dream-budget-*.jsonl` carries the
 * snapshot per call so historical estimates stay reproducible.
 *
 * Codex P1 #10 fold: non-Anthropic models (gemini, gpt, anything not in
 * this map) bypass the budget gate with a `BUDGET_METER_NO_PRICING` warn
 * once per process. The cycle still runs unbounded for those models.
 * Future: per-provider pricing modules.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Map of Anthropic model id → pricing. Aliases (opus/sonnet/haiku) resolve via DEFAULT_ALIASES. */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 4.7 family (current generation)
  'claude-opus-4-7':            { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':          { input:  3.00, output: 15.00 },
  'claude-haiku-4-5-20251001':  { input:  1.00, output:  5.00 },
  // Older but still frequently aliased
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
  'claude-3-5-sonnet-20241022': { input:  3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input:  0.80, output:  4.00 },
};

/**
 * Estimate the upper-bound USD cost of a single submit.
 * Uses (estimatedInputTokens × inputRate) + (maxOutputTokens × outputRate).
 * The maxOutputTokens upper-bounds the output cost — actual completions
 * usually return less.
 *
 * Returns null when the model isn't in the pricing map. Callers warn-once
 * and treat as zero-cost (the cycle runs unbounded for that submit).
 */
export function estimateMaxCostUsd(
  modelId: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number | null {
  const p = ANTHROPIC_PRICING[modelId];
  if (!p) return null;
  return (
    (estimatedInputTokens / 1_000_000) * p.input +
    (maxOutputTokens     / 1_000_000) * p.output
  );
}
