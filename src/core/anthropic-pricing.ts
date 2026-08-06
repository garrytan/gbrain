/**
 * Anthropic chat pricing — a bare-keyed VIEW of the canonical pricing table
 * (`src/core/model-pricing.ts`).
 *
 * Kept as a distinct export because many callers look up by bare Claude id
 * (`claude-opus-4-7`) and because `estimateMaxCostUsd` carries the
 * null-on-miss contract the dream-cycle budget gate depends on. The dollar
 * numbers live in model-pricing.ts — DO NOT hand-edit prices here; this map is
 * derived from the `anthropic:` canonical entries (prefix stripped), so it
 * cannot drift from the other pricing views. (Pre-unification this map and
 * takes-quality-eval/pricing.ts duplicated the numbers and drifted: Opus 4.7
 * read $15/$75 in one and $5/$25 in the other.)
 *
 * Codex P1 #10 fold: non-Anthropic models (gemini, gpt, anything not in this
 * map) bypass the budget gate with a `BUDGET_METER_NO_PRICING` warn once per
 * process. The cycle still runs unbounded for those models.
 */

import { CANONICAL_PRICING, type ModelPricing } from './model-pricing.ts';
import { splitProviderModelId } from './model-id.ts';
import { lookupOpenRouterChatPrice, routerTail } from './openrouter-rates.ts';

export type { ModelPricing };

/**
 * Bare-keyed Anthropic view, derived from the canonical table. Both the
 * dateless ids (`claude-haiku-4-5`, used by aliases / TIER_DEFAULTS / most
 * callers) and the dated snapshots (`claude-haiku-4-5-20251001`) are present
 * because canonical carries both.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(CANONICAL_PRICING)
    .filter(([key]) => key.startsWith('anthropic:'))
    .map(([key, pricing]) => [key.slice('anthropic:'.length), pricing]),
);

/**
 * Resolve a chat model id to its canonical pricing entry.
 *
 * Looks at the FULL canonical table, not just the bare-keyed Anthropic view.
 * Previously this resolved against `ANTHROPIC_PRICING` alone, which is
 * `CANONICAL_PRICING` filtered to `anthropic:` keys — so every non-Anthropic
 * model priced a `null` even though canonical carried its rate (14 of the 25
 * canonical entries were unreachable). Because `BudgetTracker.reserve()`
 * hard-throws `BudgetExhausted{reason:'no_pricing'}` when a cap is set and
 * pricing is missing, that made every cost-capped path — `gbrain enrich`,
 * `cycle.enrich_thin`, `extract_atoms`, skillopt — fail outright on OpenAI,
 * Gemini, and DeepSeek models. See garrytan/gbrain#2504.
 *
 * Resolution order, most-specific first:
 *   1. bare Anthropic id (`claude-haiku-4-5`) — the form most callers pass
 *   2. fully-qualified canonical id (`openai:gpt-5.2`)
 *   3. bare id behind any provider prefix (`bedrock:claude-haiku-4-5`)
 *
 * Routing-provider ids (`openrouter:openai/gpt-5.2`) resolve ONLY from
 * OpenRouter's own published catalogue, cached on disk by
 * `openrouter-rates.ts`. They are never aliased to the vendor's direct price:
 * a router bills its OWN rates, so an alias would under-estimate real spend and
 * hand back a silently wrong cap — worse than a refused one under the TX2
 * contract. With no cached rate the id stays unpriced and that refusal stands,
 * exactly as it did before this lookup existed.
 */
function resolveChatPricing(modelId: string): ModelPricing | undefined {
  const direct = ANTHROPIC_PRICING[modelId] ?? CANONICAL_PRICING[modelId];
  if (direct) return direct;

  // Checked BEFORE the tail fallback below: the tail of
  // `openrouter:anthropic/claude-sonnet-4-6` must never be allowed to match a
  // bare canonical key and quietly price at Anthropic's direct rate.
  const routed = lookupOpenRouterChatPrice(modelId);
  if (routed) return routed;

  // A router id whose rate is not cached must stay unpriced. Falling through
  // to the tail fallback would let `openrouter:anthropic/claude-sonnet-4-6`
  // match a bare canonical key and price at Anthropic's DIRECT rate — the
  // vendor-alias mistake this whole path exists to avoid.
  if (routerTail(modelId) !== null) return undefined;

  const { model: tail } = splitProviderModelId(modelId);
  if (!tail) return undefined;

  return ANTHROPIC_PRICING[tail] ?? CANONICAL_PRICING[tail];
}

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
  const p = resolveChatPricing(modelId);
  if (!p) return null;
  return (
    (estimatedInputTokens / 1_000_000) * p.input +
    (maxOutputTokens     / 1_000_000) * p.output
  );
}
