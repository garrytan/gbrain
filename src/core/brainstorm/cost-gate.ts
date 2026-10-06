/**
 * Cost gate for one brainstorm / lsd run (#5873).
 *
 * The run wraps every gateway call in a BudgetTracker, and the orchestrator
 * keeps its own ceiling checks (pre-run estimate, mid-run guard over the
 * crosses, pre-judge check). The policy is the repo-wide one:
 *   - no flag: the $5 default goes on the tracker as a `default` cap, so an
 *     unpriced chat model warns once and runs while priced calls stay
 *     metered; the orchestrator's checks price an unpriced model at the
 *     Sonnet fallback rate, so an oversized run is still stopped.
 *   - `--max-usd N` (legacy `--max-cost N`): a `user` cap. A run that would
 *     call a model nothing prices is refused before any work, with the shared
 *     no_pricing guidance (look up the rate, `gbrain pricing set`, retry).
 *   - `--max-usd off`: no USD cap on the tracker or the checks; spend is still
 *     ledgered and `--strict-budget` still applies.
 * Operator `pricing.overrides` reach every price the run computes.
 *
 * Builds on @andreineacsu's #5959 (pre-judge check, judge-priced estimate,
 * gateway chat model precedence, brainstorm_health pricing signal).
 */

import type { BrainEngine } from '../engine.ts';
import { getChatModel, getEmbeddingModel } from '../ai/gateway.ts';
import { AIConfigError } from '../ai/errors.ts';
import { BudgetExhausted, loadPricingOverrides } from '../budget/budget-tracker.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { isModelPriceable, usageCostUsd, type BudgetKind, type PricingOverrides } from '../budget/reservation-cost.ts';
import { noPricingFix, noPricingGuidance, noPricingMessage, pricingSetCommand } from '../budget/no-pricing.ts';

/** Ceiling for a run started without a cap flag. */
export const DEFAULT_MAX_COST_USD = 5;

/** Rate for a chat model nothing prices: Sonnet tier, the gateway's default chat model, derived from canonical. */
const FALLBACK_CHAT_PRICING = canonicalLookup('anthropic:claude-sonnet-4-6') ?? { input: 3, output: 15 };

/** Judge prompt and verdict tokens per idea; the pre-run estimate and the pre-judge check share them. */
const JUDGE_INPUT_TOKENS_PER_IDEA = 350;
const JUDGE_OUTPUT_TOKENS_PER_IDEA = 200;

export interface BrainstormCostGate {
  /** Ceiling for the estimate, mid-run and pre-judge checks, and the tracker cap; null when the user turned the cap off. */
  ceilingUsd: number | null;
  /** `user` for a cap flag (including off), `default` for the $5 default. */
  capSource: 'user' | 'default';
  /** The chat model the judge runs, priced by the estimate and the pre-judge check. */
  judgeModel: string;
  pricingOverrides: PricingOverrides | undefined;
  /** Cross and judge chat models nothing prices, cross first, deduplicated. */
  unpricedChatModels: Array<{ model: string; role: 'chat' | 'judge' }>;
}

export function resolveBrainstormCostGate(input: {
  /** The cap flag: a USD amount, null for off, undefined when absent. */
  maxCostUsd?: number | null;
  crossModel: string;
  judgeModel: string;
  pricingOverrides?: PricingOverrides;
}): BrainstormCostGate {
  const unpricedChatModels: BrainstormCostGate['unpricedChatModels'] = [];
  for (const [model, role] of [[input.crossModel, 'chat'], [input.judgeModel, 'judge']] as const) {
    if (unpricedChatModels.some((u) => u.model === model)) continue;
    if (!isModelPriceable(model, 'chat', input.pricingOverrides)) unpricedChatModels.push({ model, role });
  }
  return {
    ceilingUsd: input.maxCostUsd === undefined ? DEFAULT_MAX_COST_USD : input.maxCostUsd,
    capSource: input.maxCostUsd === undefined ? 'default' : 'user',
    judgeModel: input.judgeModel,
    pricingOverrides: input.pricingOverrides,
    unpricedChatModels,
  };
}

/**
 * The refusal for a user cap that would meet a model nothing prices, or null.
 * Checked before the preview, retrieval and checkpoint: the capped tracker
 * would throw the same no_pricing at that model's first reserve(), and for
 * the judge only after every cross had been paid for.
 */
export function userCapNoPricingRefusal(gate: BrainstormCostGate, embedModel: string | null, label: string): BudgetExhausted | null {
  if (gate.capSource !== 'user' || gate.ceilingUsd === null) return null;
  const unpriced: { model: string; kind: BudgetKind; role: string } | undefined =
    gate.unpricedChatModels[0]
      ? { model: gate.unpricedChatModels[0].model, kind: 'chat', role: gate.unpricedChatModels[0].role }
      : embedModel && !isModelPriceable(embedModel, 'embed', gate.pricingOverrides)
        ? { model: embedModel, kind: 'embed', role: 'embedding' }
        : undefined;
  if (!unpriced) return null;
  const pricing = noPricingGuidance(unpriced.model, unpriced.kind);
  return new BudgetExhausted(noPricingMessage(pricing, { label: `${label} (${unpriced.role} model)`, capUsd: gate.ceilingUsd }), {
    reason: 'no_pricing',
    spent: 0,
    cap: gate.ceilingUsd,
    modelId: unpriced.model,
    pricing,
    capSource: 'user',
    fix: noPricingFix(pricing),
  });
}

/** The remedy an over-ceiling estimate names. Raising the cap does not help when the estimate rests on a guessed rate. */
export function ceilingRemedy(gate: BrainstormCostGate): string {
  const unpriced = gate.unpricedChatModels[0];
  return unpriced
    ? `register the real rate of "${unpriced.model}" (the estimate assumes Sonnet rates): ${pricingSetCommand(unpriced.model, 'chat')}`
    : 'raise --max-usd';
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
 * so without this check the judge ran past the ceiling on an unmetered model.
 */
export function assertJudgeWithinCeiling(
  gate: BrainstormCostGate,
  crossModel: string,
  crossUsage: { input_tokens: number; output_tokens: number },
  ideaCount: number,
  label: string,
): void {
  if (gate.ceilingUsd === null) return;
  const spent = chatCostUsd(crossModel, crossUsage.input_tokens, crossUsage.output_tokens, gate.pricingOverrides);
  const projected = judgeCostUsd(gate.judgeModel, ideaCount, gate.pricingOverrides);
  if (spent + projected <= gate.ceilingUsd) return;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  throw new BudgetExhausted(
    `${label}: crosses cost ${usd(spent)} and the projected judge cost is ${usd(projected)}, ` +
    `over the ${usd(gate.ceilingUsd)} ceiling; skipping the judge. Lower --limit, or ${ceilingRemedy(gate)}`,
    { reason: 'cost', spent, cap: gate.ceilingUsd, modelId: gate.judgeModel },
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
  return resolveBrainstormCostGate({
    crossModel: chatModel,
    judgeModel: (await resolveBrainstormJudgeModel(engine)) ?? chatModel,
    pricingOverrides: await loadPricingOverrides(engine),
  }).unpricedChatModels[0] ?? null;
}
