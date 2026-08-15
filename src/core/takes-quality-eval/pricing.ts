/**
 * takes-quality-eval/pricing — fail-closed model pricing for budget
 * enforcement.
 *
 * The KEY SET here is an intentional allowlist — only the default panel and a
 * handful of likely overrides. Passing a model NOT in this list to
 * `eval takes-quality run --budget-usd N` aborts with an actionable error
 * rather than guessing (codex review #4 fail-closed posture vs
 * cross-modal-eval/runner.ts which silently estimates zero on unknown models).
 *
 * The VALUES come from the canonical table (`src/core/model-pricing.ts`) — do
 * NOT hand-edit rates here; update canonical and they flow through. This keeps
 * the allowlist's fail-closed curation while removing the duplicated numbers
 * that let Opus 4.7 drift to a stale $15/$75 here.
 *
 * Schema is `{model_id: {input_per_1m, output_per_1m}}` so callers can compute
 *   (in_tokens * input_per_1m + out_tokens * output_per_1m) / 1_000_000.
 */

import { canonicalLookup } from '../model-pricing.ts';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
}

/**
 * The curated allowlist of models takes-quality will budget-gate. Each must
 * exist in CANONICAL_PRICING; the map below fails fast at module load if one
 * is missing (a programmer error caught immediately, not at run time).
 */
const SUPPORTED_MODELS = [
  'openai:gpt-4o',
  'openai:gpt-5',
  'openai:gpt-5.2',
  'openai:gpt-5.5',
  // GPT-5.6 family (GA 2026-07-09); Terra replaces gpt-5.2 in
  // DEFAULT_MODEL_PANEL after gpt-5.2 dropped off the live price sheet.
  'openai:gpt-5.6-sol',
  'openai:gpt-5.6-terra',
  'openai:gpt-5.6-luna',
  'anthropic:claude-opus-5',
  'anthropic:claude-opus-4-8',
  'anthropic:claude-opus-4-7',
  'anthropic:claude-sonnet-5',
  'anthropic:claude-sonnet-4-6',
  'anthropic:claude-haiku-4-5',
  // gemini-1.5-pro was retired by Google (#3510) and the 2.0-flash family
  // shut down 2026-06-01; the dead ids stay listed so historical eval rows
  // still price (`gemini-2-flash` is the legacy alias spelling).
  // gemini-3.6-flash replaces 2.0-flash in DEFAULT_MODEL_PANEL.
  'google:gemini-2.0-flash',
  'google:gemini-2-flash',
  'google:gemini-3.6-flash',
  'google:gemini-3.5-flash',
  'google:gemini-3.5-flash-lite',
] as const;

export const MODEL_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  SUPPORTED_MODELS.map((id) => {
    const p = canonicalLookup(id);
    if (!p) {
      throw new Error(
        `takes-quality allowlist model "${id}" is missing from CANONICAL_PRICING ` +
        `(src/core/model-pricing.ts). Add it there.`,
      );
    }
    return [id, { input_per_1m: p.input, output_per_1m: p.output }];
  }),
);

export class PricingNotFoundError extends Error {
  constructor(public readonly modelId: string) {
    super(
      `Model "${modelId}" has no pricing entry. Add it to CANONICAL_PRICING in ` +
      `src/core/model-pricing.ts AND to the SUPPORTED_MODELS allowlist in ` +
      `src/core/takes-quality-eval/pricing.ts, OR pass --budget-usd 0 to disable ` +
      `budget enforcement (you'll still see the cost printed to stderr but the ` +
      `runner won't abort).`,
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
