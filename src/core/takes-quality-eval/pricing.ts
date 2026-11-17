/**
 * takes-quality-eval/pricing — model pricing for `eval takes-quality run`.
 *
 * Every model the canonical table prices (`src/core/model-pricing.ts`) is
 * budget-gateable; an operator rate registered with `foresights pricing set`
 * (`pricing.overrides`) wins over the table. Rates are never hand-copied here.
 *
 * Miss policy (new models must run): an unpriced model runs with a warning when
 * no `--budget-usd` cap is set, and its spend is not counted. Under a user-set
 * cap it refuses with `no_pricing`, whose fix is the `foresights pricing set`
 * registration, because the cap could not be enforced.
 */

import { canonicalLookup } from '../model-pricing.ts';
import { overrideFor, type PricingOverrides } from '../budget/reservation-cost.ts';
import { noPricingFix, noPricingGuidance, noPricingMessage, noPricingSteps, pricingSetCommand } from '../budget/no-pricing.ts';
import { opError, type OperationError } from '../ops/contract.ts';

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
}

/** The model's rate: registered override first, then the canonical table; null when unpriced. */
export function getPricing(modelId: string, overrides?: PricingOverrides): ModelPricing | null {
  const p = overrideFor(modelId, overrides) ?? canonicalLookup(modelId);
  return p ? { input_per_1m: p.input, output_per_1m: p.output } : null;
}

/** USD for a call's token usage; null when the model is unpriced. */
export function estimateCost(modelId: string, inTokens: number, outTokens: number, overrides?: PricingOverrides): number | null {
  const p = getPricing(modelId, overrides);
  return p ? (inTokens * p.input_per_1m + outTokens * p.output_per_1m) / 1_000_000 : null;
}

/** The refusal for an unpriced model under a user-set `--budget-usd` cap. */
export function unpricedUnderCapError(modelId: string, capUsd: number): OperationError {
  const g = noPricingGuidance(modelId, 'chat');
  return opError('no_pricing', noPricingMessage(g, { label: 'eval takes-quality', capUsd }), noPricingSteps(g), {
    fix: noPricingFix(g),
    docs: g.docs,
  });
}

/** The warning for an unpriced model with no cap: it runs, its spend is not counted. */
export function unpricedWarning(modelId: string): string {
  return `[eval takes-quality] warning: foresights has no price for ${modelId}; it runs, but its spend is not counted in cost_usd. ` +
    `Look up its rate and register it: ${pricingSetCommand(modelId, 'chat')}`;
}
