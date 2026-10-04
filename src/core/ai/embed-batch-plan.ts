/**
 * The embedding request plan shared by `embed()` and every caller that must
 * predict it before spending (#5680: the migration worst-case authorization).
 * One home for per-input truncation, the token-budget pre-split, the hard item
 * cap, and the per-request input ceiling a guard reserves before dispatch.
 */
import type { Recipe } from './types.ts';
import { resolveRecipe } from './model-resolver.ts';
import { truncateUtf8 } from '../text-safe.ts';
import { sendableEmbeddingInputs } from './embedding-guard.ts';

/** Per-input character cap applied before any embedding request. */
export const EMBED_MAX_CHARS = 8000;
/** Default chars-per-token when a recipe omits it. Matches OpenAI tiktoken on English. */
export const DEFAULT_CHARS_PER_TOKEN = 4;
/** Default safety factor when a recipe omits it. */
export const DEFAULT_SAFETY_FACTOR = 0.8;

/**
 * #3875: default per-call item cap for `no_batch_cap` recipes (Ollama,
 * LiteLLM proxy). These recipes declare no static token/item cap because the
 * backend's capacity is user-launched — but the per-SDK-call
 * AI_EMBED_TIMEOUT_MS (60s default) then bounded a whole FILE's chunks in one
 * request. A slow local model (CPU Ollama) embedding a large file timed out
 * deterministically and every retry re-sent the same oversized batch. Capping
 * items per sub-batch makes the 60s timeout a per-BATCH budget: 16 chunks per
 * call finishes comfortably even on CPU-bound local models, and a genuinely
 * wedged provider still surfaces the timeout loudly on the first sub-batch.
 * An explicit `max_batch_items` on the recipe always wins over this default.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export const NO_BATCH_CAP_SUB_BATCH_ITEMS = 16;

export function truncateEmbedInputs(texts: ReadonlyArray<string | null | undefined>): string[] {
  return texts.map(t => truncateUtf8(t ?? '', EMBED_MAX_CHARS));
}

/**
 * Split texts into sub-batches that stay under the provided budget. Pure;
 * no module state. Exported for the adaptive-embed-batch test suite.
 *
 * @param texts - The texts to partition. Each text counts as
 *   `Math.ceil(text.length / charsPerToken)` tokens for budget purposes.
 * @param budgetTokens - The token ceiling for each sub-batch. Caller is
 *   responsible for applying any safety-factor shrink before passing in.
 * @param charsPerToken - Provider-specific character density. Defaults to
 *   `DEFAULT_CHARS_PER_TOKEN` (4) when omitted, matching OpenAI tiktoken.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function splitByTokenBudget(
  texts: string[],
  budgetTokens: number,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): string[][] {
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const estTokens = Math.ceil(text.length / ratio);
    if (current.length > 0 && currentTokens + estTokens > budgetTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += estTokens;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * Split a batch into sub-batches of at most `maxItems` inputs. Enforces a
 * hard COUNT cap that the token-budget split can't (many tiny inputs fit
 * under any token budget). Used for endpoints like llama.cpp's llama-server
 * that reject requests exceeding their launch batch size.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function capBatchItems(texts: string[], maxItems: number): string[][] {
  if (maxItems <= 0 || texts.length <= maxItems) return [texts];
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += maxItems) {
    batches.push(texts.slice(i, i + maxItems));
  }
  return batches;
}

/**
 * The provider requests `embed()` dispatches for already-truncated texts.
 * Pre-split is gated on `max_batch_tokens` (or the operator's
 * GBRAIN_EMBED_MAX_BATCH_TOKENS cap, #3622, for recipes that ship without
 * one); recipes without either ride one request. The hard COUNT cap
 * (e.g. llama-server's 32) then re-splits any oversized batch, and
 * `no_batch_cap` recipes default to NO_BATCH_CAP_SUB_BATCH_ITEMS (#3875).
 */
export function planEmbedRequests(texts: string[], recipe: Recipe, safetyFactor: number, envMaxBatchTokens?: number): string[][] {
  const embedding = recipe.touchpoints?.embedding;
  const maxBatchTokens = embedding?.max_batch_tokens ?? envMaxBatchTokens;
  const tokenBatches = maxBatchTokens
    ? splitByTokenBudget(texts, Math.floor(maxBatchTokens * safetyFactor), embedding?.chars_per_token ?? DEFAULT_CHARS_PER_TOKEN)
    : [texts];
  const maxBatchItems = embedding?.max_batch_items ?? (embedding?.no_batch_cap === true ? NO_BATCH_CAP_SUB_BATCH_ITEMS : undefined);
  return maxBatchItems ? tokenBatches.flatMap(b => capBatchItems(b, maxBatchItems)) : tokenBatches;
}

/**
 * #5680: the most input tokens one request can bill. Every token covers at
 * least one UTF-8 byte of its input, and a declared per-input limit caps each
 * text, so the ceiling follows the request's own texts instead of the
 * recipe's whole batch cap. Additive, so it bounds any later split or retry
 * of the same texts.
 */
export function embedRequestMaxInputTokens(texts: string[], recipe: Recipe, modelId: string): number {
  const perInput = recipe.touchpoints?.embedding?.max_input_tokens?.[modelId] ?? Infinity;
  return texts.reduce((sum, text) => sum + Math.min(Math.max(1, Buffer.byteLength(text, 'utf8')), perInput), 0);
}

/** Per-request input ceilings `embed()` would reserve for these texts on `modelStr`, at the declared safety factor (empty inputs are never sent, #4616). */
export function embedRequestCeilings(texts: ReadonlyArray<string>, modelStr: string, envMaxBatchTokens?: number): number[] {
  const { parsed, recipe } = resolveRecipe(modelStr);
  const safety = recipe.touchpoints?.embedding?.safety_factor ?? DEFAULT_SAFETY_FACTOR;
  const truncated = truncateEmbedInputs(texts);
  const sent = sendableEmbeddingInputs(truncated);
  if (!sent.length) return [];
  return planEmbedRequests(sent.map(i => truncated[i]!), recipe, safety, envMaxBatchTokens)
    .map(batch => embedRequestMaxInputTokens(batch, recipe, parsed.modelId));
}

/** The most input tokens one rerank request can bill: the query is sent beside every document. */
export function rerankRequestMaxInputTokens(query: string, documents: ReadonlyArray<string>): number {
  return documents.reduce((sum, document) => sum + Buffer.byteLength(query, 'utf8') + Buffer.byteLength(document, 'utf8'), 0);
}

/**
 * Split inputs that exceed a per-item provider token cap into adjacent
 * character windows. Content-preserving: windows have NO overlap and NO
 * dropped tail, so concatenating an item's windows reproduces the item
 * exactly. Items at or under the window size pass through as a single
 * window. Windows of one item are adjacent and in order, so `owners` is
 * monotonic non-decreasing and the gateway's ordered batch concatenation
 * lets meanPoolByOwner regroup by owner afterwards.
 *
 * The caller applies the global EMBED_MAX_CHARS ceiling BEFORE calling this,
 * which bounds the window count per item (EMBED_MAX_CHARS / windowChars) —
 * no separate windows-per-item cap exists and no content is silently
 * dropped.
 *
 * @param texts - Inputs, already ceiled at EMBED_MAX_CHARS.
 * @param windowChars - Conservative per-window character budget (sized at a
 *   worst-case 1 token/char CJK density by the caller).
 * @returns flat — the flattened window list; owners — original input index
 *   per window; splitAny — false when every input fit in one window (the
 *   caller skips pooling entirely in that case).
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function windowOversizedItems(
  texts: string[],
  windowChars: number,
): { flat: string[]; owners: number[]; splitAny: boolean } {
  // Defensive: a misconfigured recipe (windowChars <= 0) must not loop.
  if (windowChars <= 0) {
    return { flat: texts, owners: texts.map((_, i) => i), splitAny: false };
  }
  const flat: string[] = [];
  const owners: number[] = [];
  let splitAny = false;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (text.length <= windowChars) {
      flat.push(text);
      owners.push(i);
      continue;
    }
    splitAny = true;
    for (let start = 0; start < text.length; start += windowChars) {
      flat.push(text.slice(start, start + windowChars));
      owners.push(i);
    }
  }
  return { flat, owners, splitAny };
}

/**
 * Regroup per-window embeddings back to exactly one vector per original
 * input, in input order. Singleton groups pass through VERBATIM (ordinary
 * inputs stay byte-identical to the provider's output — no renormalization
 * of unsplit vectors). Multi-window groups are arithmetic-mean pooled and
 * then L2-normalized so pooled vectors sit at the same magnitude scale as
 * singleton pass-through vectors. Zero-norm guard: an all-zero mean (e.g.
 * the provider returned zero vectors for every window) is returned as-is
 * rather than producing a NaN vector.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function meanPoolByOwner(
  embeddings: Float32Array[],
  owners: number[],
  inputCount: number,
): Float32Array[] {
  const groups: number[][] = Array.from({ length: inputCount }, () => []);
  for (let i = 0; i < embeddings.length; i++) groups[owners[i]].push(i);
  return groups.map(indices => {
    if (indices.length === 1) return embeddings[indices[0]];
    const dims = embeddings[indices[0]].length;
    const mean = new Float32Array(dims);
    for (const idx of indices) {
      const v = embeddings[idx];
      for (let d = 0; d < dims; d++) mean[d] += v[d];
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      mean[d] /= indices.length;
      norm += mean[d] * mean[d];
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return mean; // all-zero input: never emit NaN
    for (let d = 0; d < dims; d++) mean[d] /= norm;
    return mean;
  });
}

/** Worst-case token density assumption for per-item windows: CJK and emoji
 * can run ~1 token/char, denser than any recipe's optimistic chars_per_token. */
export const ITEM_WINDOW_CHARS_PER_TOKEN = 1;
/** Headroom on per-item windows for tokenizer variance and scripts denser
 * than CJK (emoji, some Indic scripts can exceed 1 token/char). */
export const ITEM_WINDOW_SAFETY = 0.8;

/**
 * Per-item window plan for recipes declaring a provider per-ITEM token cap
 * (`touchpoints.embedding.max_item_tokens`, e.g. DashScope v1/v2: 2048):
 * any item over the conservative window size is split into adjacent,
 * non-overlapping character windows; the caller embeds the flat list under
 * the ordinary batch caps and mean-pools each item's windows back to one
 * vector (see meanPoolByOwner). Recipes without the cap take the identity
 * path: flat === truncated, owners identity, splitAny false, no pooling.
 *
 * The caller applies the global EMBED_MAX_CHARS ceiling BEFORE calling this
 * (windowOversizedItems requires it), which bounds the window count per item
 * — no separate windows-per-item cap is needed.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function planItemWindows(
  truncated: string[],
  maxItemTokens: number | undefined,
): { flat: string[]; owners: number[]; splitAny: boolean } {
  const windowChars = maxItemTokens
    ? Math.floor(maxItemTokens * ITEM_WINDOW_CHARS_PER_TOKEN * ITEM_WINDOW_SAFETY)
    : 0;
  return windowChars
    ? windowOversizedItems(truncated, windowChars)
    : { flat: truncated, owners: truncated.map((_, i) => i), splitAny: false };
}
