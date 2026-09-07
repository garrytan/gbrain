/**
 * Cost-gate decision for the extract_atoms BudgetTracker.
 *
 * Split out of extract-atoms.ts so the decision is a pure, unit-testable
 * function and the phase file stays under the module-size cap. See the
 * "cost cap" comment at the tracker construction site in extract-atoms.ts
 * for the defect this closes.
 */

import { isAvailable, getEmbeddingModel } from '../ai/gateway.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';

/**
 * Cost-gate decision for the extract_atoms BudgetTracker.
 *
 * `enforceCap: true` → construct the tracker with `maxCostUsd`. `false` → run
 * uncapped (the tracker then warns once on unpriced models instead of throwing)
 * and `unpricedModel`/`unpricedKind` name the call that made the cap
 * unenforceable. Pure: no config or gateway access, so it is unit-testable and
 * the call site stays a one-liner.
 */
export interface ExtractAtomsCostGate {
  enforceCap: boolean;
  unpricedModel?: string;
  unpricedKind?: 'chat' | 'embed';
}

/**
 * Both models that bill under the extract_atoms tracker must be priceable for
 * a cap to be enforceable: the extraction chat model AND the embedding model
 * the atom import path calls (pass `null` when embedding is unavailable, in
 * which case the import runs with `noEmbed` and nothing embeds). Operator
 * `pricing.overrides` are consulted first, matching BudgetTracker.reserve().
 */
export function resolveExtractAtomsCostGate(
  extractModel: string,
  embedModel: string | null,
  overrides?: PricingOverrides,
): ExtractAtomsCostGate {
  if (!isModelPriceable(extractModel, 'chat', overrides)) {
    return { enforceCap: false, unpricedModel: extractModel, unpricedKind: 'chat' };
  }
  if (embedModel !== null && !isModelPriceable(embedModel, 'embed', overrides)) {
    return { enforceCap: false, unpricedModel: embedModel, unpricedKind: 'embed' };
  }
  return { enforceCap: true };
}

/**
 * The embedding model the atom import will bill under this phase's tracker,
 * or `null` when embedding is unavailable (the write site then passes
 * `noEmbed: true` and no embed call happens). Mirrors the write site's own
 * `isAvailable('embedding')` check so the gate and the import agree.
 */
export function resolveEmbedModelForCostGate(): string | null {
  try {
    return isAvailable('embedding') ? getEmbeddingModel() : null;
  } catch {
    return null;
  }
}
