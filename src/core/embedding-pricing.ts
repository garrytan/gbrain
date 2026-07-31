/**
 * v0.32.7 CJK wave — embedding model pricing lookup table.
 *
 * Sibling to `anthropic-pricing.ts`. Used by `gbrain upgrade`'s post-upgrade
 * cost-estimate prompt so users with large brains see a dollar figure
 * before the chunker-version sweep re-embeds.
 *
 * Prices in USD per 1M tokens. Every entry carries the official page it came
 * from plus the date it was last read against that page — re-verify alongside
 * the Anthropic-pricing refresh cycle; drift here produces estimates that
 * mislead operators. This table is for EMBEDDINGS only; chat/completion
 * pricing lives in `model-pricing.ts` (different unit) and must never be
 * mixed in here.
 *
 * Codex outside-voice C3 fold: embedding providers with no entry below
 * (Hunyuan, Dashscope, etc.) return UNKNOWN_PROVIDER from `lookupPrice`
 * so the cost-estimate prompt can fall back to a "estimate unavailable
 * for <provider>; press Ctrl-C in 10s to abort" message rather than
 * fabricate numbers.
 */

export interface EmbeddingPricing {
  /** USD per 1M tokens (embedding cost; embeddings have no separate output rate). */
  pricePerMTok: number;
}

/**
 * `provider:model` keyed pricing. The colon-separated key matches
 * gateway model strings (e.g. 'openai:text-embedding-3-large').
 */
export const EMBEDDING_PRICING: Record<string, EmbeddingPricing> = {
  // OpenAI (https://developers.openai.com/api/docs/pricing, verified 2026-07-28)
  'openai:text-embedding-3-large': { pricePerMTok: 0.13 },
  'openai:text-embedding-3-small': { pricePerMTok: 0.02 },
  // Legacy OpenAI ada (still common in older brains)
  'openai:text-embedding-ada-002': { pricePerMTok: 0.10 },
  // Voyage (https://docs.voyageai.com/docs/pricing, verified 2026-07-28)
  'voyage:voyage-4-large':         { pricePerMTok: 0.12 },
  'voyage:voyage-4':               { pricePerMTok: 0.06 },
  'voyage:voyage-4-lite':          { pricePerMTok: 0.02 },
  // voyage-4-nano is deliberately absent: it's the open-weight variant (see
  // src/core/ai/recipes/voyage.ts) and Voyage's pricing page lists no hosted
  // rate for it. A 0 entry would under-estimate anyone paying for it via the
  // hosted API; no entry means lookupEmbeddingPrice returns `unknown` and the
  // caller prints "estimate unavailable" instead of a wrong number.
  // Legacy Voyage models (same page, "older models" section — no free tokens):
  'voyage:voyage-3-large':         { pricePerMTok: 0.18 },
  'voyage:voyage-3':               { pricePerMTok: 0.06 },
  // ZeroEntropy (https://www.zeroentropy.dev/pricing, verified 2026-07-28)
  'zeroentropyai:zembed-1':        { pricePerMTok: 0.05 },
  // ZeroEntropy reranker (docs/ai-providers/zeroentropy.md — $0.025/1M tokens).
  // Reused here (not a separate rerank table) because budget-tracker.ts's
  // rerank-kind lookup falls back to this same table for paid providers.
  'zeroentropyai:zerank-2':        { pricePerMTok: 0.025 },
  // Mistral (https://mistral.ai/pricing/api/, verified 2026-07-28)
  'mistral:mistral-embed':         { pricePerMTok: 0.10 },
  'mistral:mistral-embed-2312':    { pricePerMTok: 0.10 },
  // Perplexity (https://docs.perplexity.ai/getting-started/pricing, verified 2026-07-28)
  'perplexity:pplx-embed-v1-0.6b': { pricePerMTok: 0.004 },
  'perplexity:pplx-embed-v1-4b':   { pricePerMTok: 0.03 },
};

export type PriceLookupResult =
  | { kind: 'known'; pricePerMTok: number; key: string }
  | { kind: 'unknown'; provider: string; model: string };

/**
 * Resolve a model string into a price-per-1M-tokens. Accepts both
 * `provider:model` and bare `model` forms (bare assumes openai).
 */
export function lookupEmbeddingPrice(modelString: string): PriceLookupResult {
  const [providerRaw, modelRaw] = modelString.includes(':')
    ? modelString.split(':', 2)
    : ['openai', modelString];
  const provider = providerRaw.trim().toLowerCase();
  const model = (modelRaw ?? '').trim();
  const key = `${provider}:${model}`;
  const hit = EMBEDDING_PRICING[key];
  if (hit) return { kind: 'known', pricePerMTok: hit.pricePerMTok, key };
  return { kind: 'unknown', provider, model };
}

/**
 * Estimate USD cost for embedding `charCount` characters. Uses
 * 3.5 chars/token as the OpenAI tiktoken-shaped approximation for English;
 * CJK-heavy brains will under-estimate by ~2x (one char ≈ one token), but
 * we'd rather under-estimate than spook users with a 10x worst-case figure.
 */
export function estimateCostFromChars(charCount: number, pricePerMTok: number): number {
  const tokens = Math.ceil(charCount / 3.5);
  return (tokens / 1_000_000) * pricePerMTok;
}
