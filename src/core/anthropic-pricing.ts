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
  // Claude 4.7 generation (current)
  // Opus 4.7 dropped from $15/$75 (Opus 4) to $5/$25 per
  // https://platform.claude.com/docs/en/about-claude/models/overview (verified 2026-05-10).
  'claude-opus-4-7':            { input:  5.00, output: 25.00 },
  'claude-sonnet-4-6':          { input:  3.00, output: 15.00 },
  // Both the dateless canonical id (TIER_DEFAULTS / aliases / every caller uses
  // this) AND the dated snapshot. The dateless entry was missing pre-v0.42.9.0,
  // so a budget-capped Haiku run (skillopt with --max-cost, eval harnesses) hit
  // BudgetTracker no_pricing and every rollout silently scored 0.
  'claude-haiku-4-5':           { input:  1.00, output:  5.00 },
  'claude-haiku-4-5-20251001':  { input:  1.00, output:  5.00 },
  // Older but still frequently aliased
  'claude-opus-4-6':            { input:  5.00, output: 25.00 },
  'claude-3-5-sonnet-20241022': { input:  3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input:  0.80, output:  4.00 },
};

import { splitProviderModelId } from './model-id.ts';

/**
 * Estimate the upper-bound USD cost of a single submit.
 * Uses (estimatedInputTokens × inputRate) + (maxOutputTokens × outputRate).
 * The maxOutputTokens upper-bounds the output cost — actual completions
 * usually return less.
 *
 * Returns null when the model isn't in the pricing map. Callers warn-once
 * and treat as zero-cost (the cycle runs unbounded for that submit).
 *
 * Accepts bare (`claude-opus-4-7`), colon-prefixed (`anthropic:claude-opus-4-7`),
 * and slash-prefixed (`anthropic/claude-opus-4-7`) ids. Routes through
 * `splitProviderModelId` so the slash-form (which arrives via CLI `--judge-model`
 * and OpenRouter recipe lists) hits the pricing table. Pre-v0.41.21.0 the inline
 * `:`-only split missed slash form → BudgetTracker no_pricing hard-fail with
 * `--max-cost N` (closes #1540).
 */
export function estimateMaxCostUsd(
  modelId: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number | null {
  let p: ModelPricing | undefined = ANTHROPIC_PRICING[modelId];
  if (!p) {
    const { model: tail } = splitProviderModelId(modelId);
    if (tail) p = ANTHROPIC_PRICING[tail];
  }
  if (!p) return null;
  return (
    (estimatedInputTokens / 1_000_000) * p.input +
    (maxOutputTokens     / 1_000_000) * p.output
  );
}
