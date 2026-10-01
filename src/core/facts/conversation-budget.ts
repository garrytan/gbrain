import type { BrainEngine } from '../engine.ts';
import { getFactsExtractionModel } from './extract.ts';
import { resolveModel, resolveTierDefault } from '../model-config.ts';
import { normalizeModelId } from '../model-id.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';

/** Default USD ceilings cannot account for unpriced chat routes. Explicit
 * ceilings stay fail-closed, including either of the cycle's two cost caps.
 * Check the opt-in parser too: it bills under the same extraction tracker.
 * Runtime and page/segment bounds belong to the caller and are never lifted.
 */
export async function conversationFactsCostCap(
  engine: BrainEngine,
  cap: number,
  explicit: boolean,
  overrides?: PricingOverrides,
): Promise<number | undefined> {
  if (explicit) return cap;
  const models = [await getFactsExtractionModel(engine)];
  if (await engine.getConfig('conversation_parser.llm_fallback_enabled') === 'true') {
    models.push(normalizeModelId(await resolveModel(engine, { tier: 'utility', fallback: resolveTierDefault('utility') })));
  }
  const unpriced = models.find(model => !isModelPriceable(model, 'chat', overrides));
  if (!unpriced) return cap;
  console.error(`[conversation-facts] ${unpriced} has no pricing; default USD cap is not enforced. Configure pricing.overrides to enforce a USD cap; explicit caps remain fail-closed.`);
  return undefined;
}
