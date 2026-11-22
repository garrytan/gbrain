import type { BrainEngine } from '../engine.ts';
import { buildExtractorSystem, getExtractorVariant, getFactsExtractionModel } from './extract.ts';
import { SEGMENT_TEXT_CHAR_LIMIT } from './conversation-windows.ts';
import { SLOT_TAG_INPUT_CHARS, SLOT_TAG_MAX_TOKENS } from './slot-tagging.ts';
import { CHAT_INPUT_CHARS_PER_TOKEN } from '../ai/chat-input-estimate.ts';
import { usageCostUsd } from '../budget/reservation-cost.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { resolveModel, resolveTierDefault } from '../model-config.ts';
import { normalizeModelId } from '../model-id.ts';
import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';
import { pricingSetCommand } from '../budget/no-pricing.ts';

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
  console.error(`[conversation-facts] ${unpriced} has no pricing; default USD cap is not enforced. To enforce it, look up the model's price and register it: ${pricingSetCommand(unpriced, 'chat')}. Explicit caps remain fail-closed.`);
  return undefined;
}

/** Output tokens one segment's reply takes at most in practice: the extractor's 10-fact cap at about 200 tokens a fact. */
export const OUTPUT_TOKENS_PER_SEGMENT = 2000;

export interface ConversationRunEstimate { model: string; segments: number; input_tokens: number; output_tokens: number; usd: number | null }

/**
 * GBRA-574 B2: what a paid run over `segments` would send, for the --dry-run preview: each segment at most a full window
 * (SEGMENT_TEXT_CHAR_LIMIT) under the conversation extractor's system prompt, without prompt caching, and
 * OUTPUT_TOKENS_PER_SEGMENT back, plus one slot-tagging call per segment at its largest (facts/slot-tagging.ts), each
 * priced per call by the budget tracker's price table. `usd` is null when the model has no price.
 */
export async function conversationRunEstimate(engine: BrainEngine, segments: number): Promise<ConversationRunEstimate> {
  const model = await getFactsExtractionModel(engine);
  const system = buildExtractorSystem(true, await getExtractorVariant(engine));
  const perSegment = Math.ceil((system.length + SEGMENT_TEXT_CHAR_LIMIT) / CHAT_INPUT_CHARS_PER_TOKEN);
  const perTag = Math.ceil(SLOT_TAG_INPUT_CHARS / CHAT_INPUT_CHARS_PER_TOKEN);
  const overrides = await loadPricingOverrides(engine);
  const price = usageCostUsd(model, perSegment, OUTPUT_TOKENS_PER_SEGMENT, 'chat', overrides);
  const tagPrice = usageCostUsd(model, perTag, SLOT_TAG_MAX_TOKENS, 'chat', overrides);
  return { model, segments, input_tokens: segments * (perSegment + perTag), output_tokens: segments * (OUTPUT_TOKENS_PER_SEGMENT + SLOT_TAG_MAX_TOKENS),
    usd: price == null || tagPrice == null ? null : segments * (price + tagPrice) };
}

/** The --dry-run line for an estimate; an unpriced model names the command that registers its price. */
export function conversationEstimateLine(e: ConversationRunEstimate): string {
  return `  Estimated paid run: ${e.segments} segment(s), up to ~${e.input_tokens} input and ~${e.output_tokens} output tokens, `
    + (e.usd == null ? `no price for ${e.model} (register one: ${pricingSetCommand(e.model, 'chat')}).` : `about $${e.usd.toFixed(2)} on ${e.model}.`);
}
