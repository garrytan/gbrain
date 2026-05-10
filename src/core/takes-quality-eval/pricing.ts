/**
 * takes-quality-eval/pricing — fail-closed model pricing table for budget
 * enforcement.
 *
 * Per-1M-token rates in USD. Drifts as providers update prices; refresh
 * alongside model-family bumps. The list is intentionally small — only
 * the default 3-model panel and a handful of likely overrides. If you
 * pass a model not in this table to `eval takes-quality run --budget-usd N`,
 * the runner aborts with an actionable error rather than guessing
 * (codex review #4 fail-closed posture vs cross-modal-eval/runner.ts
 * which silently estimates zero on unknown models).
 *
 * Schema is `{model_id: {input_per_1m, output_per_1m}}` so callers can
 * compute estimated cost as
 *   (in_tokens * input_per_1m + out_tokens * output_per_1m) / 1_000_000.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI (refreshed 2026-05; verify before relying for budget gating)
  'openai:gpt-4o':                { input_per_1m: 2.5,  output_per_1m: 10.0 },
  'openai:gpt-5':                 { input_per_1m: 5.0,  output_per_1m: 20.0 },
  'openai:gpt-5.5':               { input_per_1m: 4.0,  output_per_1m: 16.0 },

  // Anthropic
  'anthropic:claude-opus-4-7':    { input_per_1m: 15.0, output_per_1m: 75.0 },
  'anthropic:claude-sonnet-4-6':  { input_per_1m: 3.0,  output_per_1m: 15.0 },
  'anthropic:claude-haiku-4-5':   { input_per_1m: 0.8,  output_per_1m: 4.0  },

  // Google
  'google:gemini-1.5-pro':        { input_per_1m: 1.25, output_per_1m: 5.0  },
  'google:gemini-2-flash':        { input_per_1m: 0.30, output_per_1m: 1.20 },
};

export class PricingNotFoundError extends Error {
  constructor(public readonly modelId: string) {
    super(
      `Model "${modelId}" has no pricing entry in src/core/takes-quality-eval/pricing.ts. ` +
      `Add an entry for the model and re-run, OR pass --budget-usd 0 to disable budget ` +
      `enforcement (you'll still see the cost printed to stderr but the runner won't abort).`,
    );
    this.name = 'PricingNotFoundError';
  }
}

/**
 * Look up pricing for a model. Throws PricingNotFoundError when the model
 * isn't in the table — caller catches and surfaces the actionable message.
 */
export function getPricing(modelId: string): ModelPricing {
  const p = MODEL_PRICING[modelId];
  if (!p) throw new PricingNotFoundError(modelId);
  return p;
}

/**
 * Estimate cost in USD for a given model + token usage. Uses fail-closed
 * lookup; throws on unknown model.
 */
export function estimateCost(modelId: string, inTokens: number, outTokens: number): number {
  const p = getPricing(modelId);
  return (inTokens * p.input_per_1m + outTokens * p.output_per_1m) / 1_000_000;
}
