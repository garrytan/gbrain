/**
 * Cost gate for one brainstorm / lsd run (#5873).
 *
 * The run wraps every gateway call in a BudgetTracker. A tracker with a cap
 * fails closed (reserve() throws no_pricing) on a model it cannot price, so
 * the default cap goes on the tracker only when the cross and judge chat
 * models are both priceable: the rule `isModelPriceable` sets for default caps
 * (embed-backfill, extract_atoms). A --max-cost the user passed stays
 * fail-closed, and the run refuses before any work when it would meet an
 * unpriced chat model. The orchestrator's own guards hold the ceiling either
 * way: the pre-run estimate, the mid-run guard over the crosses and the
 * pre-judge check, each pricing a model nothing prices at the Sonnet fallback
 * rate (the dream-cycle BudgetMeter's rule), so a paid route missing from the
 * tables is still stopped. Operator `pricing.overrides` reach every price the
 * run computes: the tracker, those guards and the reported actual.
 */

import type { BrainEngine } from '../engine.ts';
import { getChatModel, getEmbeddingModel } from '../ai/gateway.ts';
import { AIConfigError } from '../ai/errors.ts';
import { BudgetExhausted, loadPricingOverrides } from '../budget/budget-tracker.ts';
import { canonicalLookup } from '../model-pricing.ts';
import {
  canonicalPricingKey,
  isModelPriceable,
  usageCostUsd,
  type PricingOverrides,
} from '../budget/reservation-cost.ts';

/** Ceiling for a run started without --max-cost. */
export const DEFAULT_MAX_COST_USD = 5;

/** Rate for a chat model nothing prices: Sonnet tier, the gateway's default chat model, derived from canonical. */
const FALLBACK_CHAT_PRICING = canonicalLookup('anthropic:claude-sonnet-4-6') ?? { input: 3, output: 15 };

/** Judge prompt and verdict tokens per idea; the pre-run estimate and the pre-judge check share them. */
const JUDGE_INPUT_TOKENS_PER_IDEA = 350;
const JUDGE_OUTPUT_TOKENS_PER_IDEA = 200;

export interface BrainstormCostGate {
  /** Ceiling for the pre-run estimate, the mid-run guard and the pre-judge check: --max-cost, else the default. */
  maxCostUsd: number;
  /** Cap for the run's BudgetTracker. Undefined when the default would meet an unpriced chat model. */
  trackerCapUsd: number | undefined;
  /** True when the user passed --max-cost. */
  explicitCap: boolean;
  /** The chat model the judge runs, priced by the estimate and the pre-judge check. */
  judgeModel: string;
  /** Operator overrides keyed by the configured and the served model id, plus a $0 question-embedding row. */
  pricingOverrides: PricingOverrides | undefined;
  /** The cross-generation chat model, when nothing prices it. */
  unpricedCrossModel?: string;
  /** The judge chat model, when nothing prices it. */
  unpricedJudgeModel?: string;
  /** The unpriced embedding model counted at $0. */
  zeroPricedEmbedModel?: string;
}

/**
 * Add each override row under its canonical key too. An override is keyed by
 * the id the operator configured (`nvidia:nemotron-3-super`), while the
 * gateway records the id it served (`nvidia:nvidia/nemotron-3-super-120b-a12b`);
 * overrideFor canonicalizes the looked-up id, never the stored key.
 */
function withCanonicalKeys(overrides: PricingOverrides | undefined): PricingOverrides | undefined {
  if (!overrides) return undefined;
  const out: PricingOverrides = { ...overrides };
  for (const [key, rate] of Object.entries(overrides)) {
    const canonical = canonicalPricingKey(key).toLowerCase();
    if (!(canonical in out)) out[canonical] = rate;
  }
  return out;
}

export function resolveBrainstormCostGate(input: {
  /** --max-cost, when the user passed it. */
  maxCostUsd?: number;
  /** The chat model the cross generations run. */
  crossModel: string;
  /** The chat model the judge runs. */
  judgeModel: string;
  /** The question-embedding model, or null when no gateway embedding runs. */
  embedModel: string | null;
  pricingOverrides?: PricingOverrides;
}): BrainstormCostGate {
  let pricingOverrides = withCanonicalKeys(input.pricingOverrides);
  let zeroPricedEmbedModel: string | undefined;
  if (input.embedModel && !isModelPriceable(input.embedModel, 'embed', pricingOverrides)) {
    // The run embeds one short question. Counting it at $0 keeps the cap on
    // the chat calls instead of failing that embedding on no_pricing, which
    // the orchestrator would downgrade to neutral distance scores. Same rule
    // extract_atoms applies to an unpriced embed route under a set budget.
    const key = canonicalPricingKey(input.embedModel.trim()).toLowerCase();
    pricingOverrides = { ...pricingOverrides, [key]: { input: 0, output: 0 } };
    zeroPricedEmbedModel = input.embedModel;
  }
  const unpricedCrossModel = isModelPriceable(input.crossModel, 'chat', pricingOverrides) ? undefined : input.crossModel;
  const unpricedJudgeModel = isModelPriceable(input.judgeModel, 'chat', pricingOverrides) ? undefined : input.judgeModel;
  const explicitCap = input.maxCostUsd !== undefined;
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  return {
    maxCostUsd,
    trackerCapUsd: explicitCap || (!unpricedCrossModel && !unpricedJudgeModel) ? maxCostUsd : undefined,
    explicitCap,
    judgeModel: input.judgeModel,
    pricingOverrides,
    unpricedCrossModel,
    unpricedJudgeModel,
    zeroPricedEmbedModel,
  };
}

/** The first unpriced chat model of the run with its role, cross before judge. */
export function firstUnpricedChatModel(gate: BrainstormCostGate): { model: string; role: 'chat' | 'judge' } | null {
  if (gate.unpricedCrossModel) return { model: gate.unpricedCrossModel, role: 'chat' };
  if (gate.unpricedJudgeModel) return { model: gate.unpricedJudgeModel, role: 'judge' };
  return null;
}

/** The paste-ready command that declares a model's rate without dropping the operator's other rows. */
export function pricingOverrideRemedy(model: string): string {
  return `\`gbrain config set pricing.overrides '{"${model}": {"input": <usd-per-1M-input-tokens>, "output": <usd-per-1M-output-tokens>}}'\` ` +
    '(the value replaces the whole map, so keep any rows already set)';
}

/**
 * Refuse a run whose explicit --max-cost would meet an unpriced chat model,
 * before the preview, retrieval and checkpoint. The capped tracker would
 * throw the same no_pricing at that model's first reserve(), and for the
 * judge only after every cross had been paid for.
 */
export function assertExplicitCapPriceable(gate: BrainstormCostGate, label: string): void {
  const unpriced = firstUnpricedChatModel(gate);
  if (!gate.explicitCap || !unpriced) return;
  throw new BudgetExhausted(
    `${label}: no pricing entry for ${unpriced.role} model "${unpriced.model}", and --max-cost cannot hold a cap ` +
    `on a model it cannot price. Declare its rate with ${pricingOverrideRemedy(unpriced.model)}, or drop --max-cost ` +
    `to run under the default ${'$'}${DEFAULT_MAX_COST_USD} ceiling at Sonnet rates.`,
    { reason: 'no_pricing', spent: 0, cap: gate.maxCostUsd, modelId: unpriced.model },
  );
}

/** The remedy an over-ceiling estimate names. An unpriced model fails closed under any --max-cost, so raising it is none. */
export function ceilingRemedy(gate: BrainstormCostGate): string {
  const unpriced = [gate.unpricedCrossModel, gate.unpricedJudgeModel].filter((m): m is string => !!m);
  return unpriced.length > 0
    ? `declare the rate of ${[...new Set(unpriced)].map((m) => `"${m}"`).join(' and ')} in pricing.overrides`
    : 'raise --max-cost';
}

/** USD for chat usage at the run's prices. A model nothing prices counts at the Sonnet fallback rate. */
export function chatCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricingOverrides?: PricingOverrides,
): number {
  return usageCostUsd(model, inputTokens, outputTokens, 'chat', pricingOverrides)
    ?? (inputTokens / 1_000_000) * FALLBACK_CHAT_PRICING.input
      + (outputTokens / 1_000_000) * FALLBACK_CHAT_PRICING.output;
}

/** Projected USD for judging `ideaCount` ideas on `judgeModel`. */
export function judgeCostUsd(judgeModel: string, ideaCount: number, pricingOverrides?: PricingOverrides): number {
  return chatCostUsd(
    judgeModel,
    ideaCount * JUDGE_INPUT_TOKENS_PER_IDEA,
    ideaCount * JUDGE_OUTPUT_TOKENS_PER_IDEA,
    pricingOverrides,
  );
}

/**
 * Stop before the judge when the crosses already paid plus the projected
 * judge cost pass the ceiling. The mid-run guard watches only the crosses,
 * so without this check the judge ran unbounded on an uncapped tracker.
 */
export function assertJudgeWithinCeiling(
  gate: BrainstormCostGate,
  crossModel: string,
  crossUsage: { input_tokens: number; output_tokens: number },
  ideaCount: number,
  label: string,
): void {
  const spent = chatCostUsd(crossModel, crossUsage.input_tokens, crossUsage.output_tokens, gate.pricingOverrides);
  const projected = judgeCostUsd(gate.judgeModel, ideaCount, gate.pricingOverrides);
  if (spent + projected <= gate.maxCostUsd) return;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  throw new BudgetExhausted(
    `${label}: crosses cost ${usd(spent)} and the projected judge cost is ${usd(projected)}, ` +
    `over the ${usd(gate.maxCostUsd)} ceiling; skipping the judge. Lower --limit, or ${ceilingRemedy(gate)}`,
    { reason: 'cost', spent, cap: gate.maxCostUsd, modelId: gate.judgeModel },
  );
}

/**
 * Null when the gateway is not configured (unit runs that inject chatFn) or,
 * for embeddings, when the brain's embedding identity is unverified: the
 * embedding call then fails before any reserve(). Both are AIConfigError;
 * anything else is a real failure and propagates.
 */
function unlessUnconfigured(read: () => string): string | null {
  try {
    return read();
  } catch (err) {
    if (err instanceof AIConfigError) return null;
    throw err;
  }
}

/** The chat model a gateway.chat call without `model` runs. */
export function configuredChatModel(): string | null {
  return unlessUnconfigured(getChatModel);
}

/** The embedding model gateway.embedQuery runs. */
export function configuredEmbeddingModel(): string | null {
  return unlessUnconfigured(getEmbeddingModel);
}

/**
 * Judge-phase model precedence: --judge-model flag, else the
 * `models.brainstorm.judge` config key, else undefined (falls back to
 * `modelOverride` then the gateway default at the runJudge callsite).
 */
export async function resolveBrainstormJudgeModel(
  engine: Pick<BrainEngine, 'getConfig'>,
  judgeModelFlag?: string,
): Promise<string | undefined> {
  if (judgeModelFlag) return judgeModelFlag;
  const configured = await engine.getConfig('models.brainstorm.judge');
  return configured ?? undefined;
}

/**
 * The first chat model a brainstorm run would call that nothing prices, with
 * its role, or null. Null too when no gateway is configured: the model is then
 * unknown, not unpriced. The brainstorm_health doctor check reports it.
 */
export async function findUnpricedBrainstormChatModel(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<{ model: string; role: 'chat' | 'judge' } | null> {
  const chatModel = configuredChatModel();
  if (!chatModel) return null;
  return firstUnpricedChatModel(resolveBrainstormCostGate({
    crossModel: chatModel,
    judgeModel: (await resolveBrainstormJudgeModel(engine)) ?? chatModel,
    embedModel: null,
    pricingOverrides: await loadPricingOverrides(engine),
  }));
}
