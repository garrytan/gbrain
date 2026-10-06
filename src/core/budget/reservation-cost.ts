/**
 * Pure pricing math shared by BudgetTracker (reserve + record) and callers
 * that must predict a tracker decision before any spend (skillopt preflight's
 * impossible-reservation check). One lookup chain: operator overrides, then
 * the shipped tables with recipe-alias normalization, then the free
 * local-inference providers; `null` means unpriced (TX2 applies under a cap).
 */

import { ANTHROPIC_PRICING, type ModelPricing } from '../anthropic-pricing.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { splitProviderModelId } from '../model-id.ts';
import { resolveRecipe } from '../ai/model-resolver.ts';
import { getRecipe } from '../ai/recipes/index.ts';

export type BudgetKind = 'chat' | 'embed' | 'rerank' | 'decide';

/**
 * #4312 — normalized operator price overrides: model string (lowercased) →
 * per-1M-token pricing. Declared in the config plane as JSON, e.g.
 *   gbrain config set pricing.overrides '{"litellm:gpt-4o": {"input": 2.5, "output": 10}, "litellm:text-embedding-3-large": 0.13}'
 * A bare number means one rate for input AND output tokens (embeddings only
 * ever bill input, so a scalar is the natural spelling there).
 */
export type PricingOverrides = Record<string, ModelPricing>;

/**
 * Recipe-alias normalization shared by the override and table lookups:
 * `claude-cli:haiku` → `claude-cli:claude-haiku-4-5-20251001`. Bare ids and
 * unknown providers throw out of resolveRecipe and keep the raw id, so the
 * downstream chains decide those exactly as before.
 */
export function canonicalPricingKey(modelId: string): string {
  try {
    const { parsed } = resolveRecipe(modelId);
    return `${parsed.providerId}:${parsed.modelId}`;
  } catch {
    return modelId;
  }
}

/**
 * Whether `key` may stand in `pricing.overrides`. A model id always may. A
 * provider wildcard (`claude-cli:*`) may only for a provider whose recipe
 * bills by subscription: one rate is honest for every model of a flat-rate
 * plan and wrong for every model of a per-token API. A bare `*` never may.
 */
export function isAllowedPricingOverrideKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k.includes('*')) return k.length > 0;
  if (!k.endsWith(':*') || k.slice(0, -2).includes('*')) return false;
  return getRecipe(k.slice(0, -2))?.billing === 'subscription';
}

/** Where a price came from: an operator model override, an operator provider wildcard, or the shipped tables. */
export type PricingSource = 'override' | 'provider_wildcard' | 'table';

function overrideWithSource(modelId: string, overrides?: PricingOverrides): { pricing: ModelPricing; source: PricingSource } | null {
  if (!overrides) return null;
  const raw = modelId.trim().toLowerCase();
  const key = canonicalPricingKey(modelId.trim()).toLowerCase();
  const exact = overrides[raw] ?? overrides[key];
  if (exact) return { pricing: exact, source: 'override' };
  const provider = splitProviderModelId(key).provider;
  const wildcard = provider ? overrides[`${provider}:*`] : undefined;
  return wildcard ? { pricing: wildcard, source: 'provider_wildcard' } : null;
}

/**
 * Override lookup (keys normalized to lowercase at parse time): the raw key
 * first, then the recipe-canonical key — an override written against the
 * dated id must also price the alias the operator configured, or the alias
 * silently bills at list price while the table lookup below resolves it.
 * Then the provider wildcard (`claude-cli:*`), which parsePricingOverrides
 * admits only for subscription-billed providers: exact > wildcard > tables.
 */
export function overrideFor(modelId: string, overrides?: PricingOverrides): ModelPricing | null {
  return overrideWithSource(modelId, overrides)?.pricing ?? null;
}

/**
 * Provider id prefixes that always price at $0 for the rerank kind
 * (electricity, not API tokens). Centralized here so `--max-cost` callers
 * don't hard-fail TX2 when a local rerank provider is configured. Matched
 * against the provider half of the `provider:model` string. Extend this set
 * when adding new local-inference rerank recipes.
 */
const FREE_LOCAL_RERANK_PROVIDERS: ReadonlySet<string> = new Set([
  'llama-server-reranker',
]);

/**
 * Provider id prefixes whose embeddings run on local inference (electricity,
 * not API tokens) and so price at $0. Without this, a `--max-cost`-bounded
 * embed/reindex job configured for a local provider TX2 hard-fails because
 * lookupEmbeddingPrice has no entry for them. Matched against the provider
 * half of the `provider:model` string.
 *
 * 'litellm' is excluded — a LiteLLM proxy can front a paid provider, so
 * pricing-unknown is the honest state there.
 *
 * Sibling to FREE_LOCAL_RERANK_PROVIDERS; v0.41+ TODO unifies them via
 * recipe-cost-driven resolution.
 */
const FREE_LOCAL_EMBED_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'llama-server',
  'lmstudio',
]);

/**
 * Chat sibling of FREE_LOCAL_EMBED_PROVIDERS / FREE_LOCAL_RERANK_PROVIDERS.
 *
 * Local inference costs electricity, not tokens, so these providers price at
 * $0 rather than TX2 hard-failing. Without this a caller that sets ANY cost cap
 * cannot use a local chat model at all: CANONICAL_PRICING has no `ollama:*`
 * keys, so `reserve()` throws no_pricing before the first call and every work
 * item is skipped with `budget_exhausted: true` at $0 spent.
 *
 * That is not theoretical — `cycle.extract_atoms` always constructs its tracker
 * with `maxCostUsd` (config only accepts `n > 0`, so the cap can't be unset),
 * which made `models.dream.extract_atoms: ollama:*` silently extract nothing.
 *
 * `litellm` is excluded on purpose, matching the embed set: a LiteLLM proxy can
 * front a paid provider, so pricing-unknown is the honest state there.
 */
const FREE_LOCAL_CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'llama-server',
]);

function lookupPricing(modelId: string, kind: BudgetKind): ModelPricing | null {
  if (kind === 'embed') {
    const hit = lookupEmbeddingPrice(modelId);
    if (hit.kind === 'known') {
      return { input: hit.pricePerMTok, output: 0 };
    }
    // v0.40.x: local-inference embed providers cost electricity, not tokens.
    if (hit.kind === 'unknown' && FREE_LOCAL_EMBED_PROVIDERS.has(hit.provider)) {
      return { input: 0, output: 0 };
    }
    return null;
  }
  // chat or rerank: try bare key first, then provider:model or provider/model.
  // v0.41.21.0: route through splitProviderModelId so slash-prefixed ids
  // (the form `--judge-model` and OpenRouter recipes emit) hit the pricing
  // table. Pre-fix, slash-form silently no_pricing-failed `--max-cost` on
  // brainstorm/lsd.
  const bare = ANTHROPIC_PRICING[modelId];
  if (bare) return bare;
  // Recipe aliases (`claude-cli:haiku`, `anthropic:sonnet`) are not pricing
  // keys, and the gateway reserves with the string the user configured —
  // BEFORE alias resolution — so `claude-cli:haiku` under a cap used to TX2
  // hard-fail with no_pricing while the dated id it maps to priced fine.
  // Normalize once here; the chain below then prices the canonical id, and
  // alias vs dated id agree at reserve(), record() and isModelPriceable().
  // Bare ids and unknown providers keep the raw id (canonicalPricingKey): the
  // existing chain decides those exactly as before.
  const key = canonicalPricingKey(modelId);
  const { provider: providerId, model: modelTail } = splitProviderModelId(key);
  if (modelTail) {
    const tailHit = ANTHROPIC_PRICING[modelTail];
    if (tailHit) return tailHit;
  }
  if (kind === 'rerank' || kind === 'decide') {
    const hit = lookupEmbeddingPrice(key);
    if (hit.kind === 'known') return { input: hit.pricePerMTok, output: 0 };
  }
  // v0.40.6.1: zero-price local-inference rerank providers so the budget
  // tracker's TX2 hard-fail doesn't trip on `llama-server-reranker:<model>`
  // under `--max-cost`. Only the rerank kind — chat/embed already have
  // their own provider-specific pricing surfaces.
  if (kind === 'rerank' && providerId && FREE_LOCAL_RERANK_PROVIDERS.has(providerId)) {
    return { input: 0, output: 0 };
  }
  // Fall back to the full canonical pricing table so non-Anthropic chat
  // models with a known price (openai:*, google:*, deepseek:*) resolve under
  // --max-cost instead of TX2 no_pricing hard-failing at $0. ANTHROPIC_PRICING
  // above is only the bare-keyed Claude view.
  const canon = canonicalLookup(key);
  if (canon) return canon;
  // Local-inference chat providers cost electricity, not tokens. Checked AFTER
  // the canonical table so an explicitly-priced local entry, should one ever be
  // added, still wins over the blanket zero.
  if (kind === 'chat' && providerId && FREE_LOCAL_CHAT_PROVIDERS.has(providerId)) {
    return { input: 0, output: 0 };
  }
  return null;
}

/**
 * True when the budget tracker can price this model, i.e. when setting a cost
 * cap is meaningful. Callers that apply a *default* cap (rather than one the
 * user asked for) should skip the cap when this returns false — otherwise
 * `reserve()` hard-fails with BudgetExhausted(reason:'no_pricing') and the
 * caller silently does no work.
 */
export function isModelPriceable(modelId: string, kind: BudgetKind, overrides?: PricingOverrides): boolean {
  return priceFor(modelId, kind, overrides) !== null;
}

/**
 * The one price resolver: operator overrides (exact model, then provider
 * wildcard), then the shipped tables (aliases, the claude-cli → Anthropic
 * sibling, canonical rows, free local providers). `null` means unpriced;
 * each caller keeps its own miss policy.
 */
export function priceFor(
  modelId: string,
  kind: BudgetKind,
  overrides?: PricingOverrides,
): { pricing: ModelPricing; source: PricingSource } | null {
  const override = overrideWithSource(modelId, overrides);
  if (override) return override;
  const table = lookupPricing(modelId, kind);
  return table ? { pricing: table, source: 'table' } : null;
}

export function usageCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  kind: BudgetKind,
  overrides?: PricingOverrides,
): number | null {
  // #4312: operator overrides win — the operator owns their bill (negotiated
  // rates, proxy routes the shipped tables can't know about). Missing both →
  // null, and the TX2 fail-closed contract in reserve() still applies.
  const p = priceFor(modelId, kind, overrides)?.pricing;
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/**
 * USD a `reserve()` projects for one call: the input estimate plus the full
 * output ceiling. `null` when the model is unpriced — under a cost cap the
 * tracker then hard-fails with `no_pricing`.
 */
export function reservationCostUsd(
  modelId: string,
  kind: BudgetKind,
  inputTokens: number,
  maxOutputTokens: number,
  overrides?: PricingOverrides,
): number | null {
  return usageCostUsd(modelId, inputTokens, maxOutputTokens, kind, overrides);
}

/**
 * D3: providers whose rows carry the PEAK rate of a time-of-day price
 * (DeepSeek bills half off-peak). A cap must bound the worst case, so caps
 * and estimates use peak; this labels an estimate so the overstatement is
 * never silent. Router rows (`openrouter:deepseek/...`) are the router's own
 * flat rate and are not labelled.
 */
const PEAK_RATE_PROVIDERS: ReadonlySet<string> = new Set(['deepseek']);

/** The label an estimate carries when any of its models prices at a peak row, else ''. */
export function peakRateNote(models: Array<string | null | undefined>): string {
  const peak = models.some((m) => PEAK_RATE_PROVIDERS.has(splitProviderModelId(m).provider ?? ''));
  return peak ? ' (DeepSeek at peak rates, an upper bound; off-peak bills half)' : '';
}
