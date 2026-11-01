/**
 * Exact token counts from the embedding backend's OWN tokenizer.
 *
 * llama.cpp's `llama-server` serves two endpoints beside its
 * OpenAI-compatible surface:
 *
 *   POST <root>/tokenize    {content, add_special} -> {tokens: number[]}
 *   POST <root>/detokenize  {tokens}                -> {content: string}
 *
 * A recipe that declares `touchpoints.embedding.tokenizer` lets the gateway
 * ask for the real count of each text it is about to embed, instead of
 * estimating `Math.ceil(text.length / chars_per_token)`. On CJK text the
 * estimate runs 2-4x low (one character is often one token), so a batch that
 * looked safely under a declared budget reaches the server over it and comes
 * back as a token-limit error; on English prose the same guess pads
 * needless sub-batches.
 *
 * Contract: EVERY function here is all-or-nothing and never throws. `null`
 * means "the server could not answer" — the caller then keeps its estimate
 * path untouched, so a llama-server built without these endpoints (or one that
 * is restarting) degrades to exactly the old behaviour.
 *
 * Both endpoints live at the server ROOT. The recipe's resolved base URL ends
 * at the OpenAI-compatible mount (`/v1`), so the path join drops a trailing
 * version segment: POST <host>/v1/tokenize is a 404 on llama.cpp.
 */
import { createHash } from 'node:crypto';

import type { EmbeddingTokenizer } from './types.ts';

/** In-flight tokenize requests per `countTokens` call. */
export const TOKENIZE_CONCURRENCY = 8;
/** Per-request timeout when the recipe declares none: llama-server answers
 *  /tokenize in under a millisecond on a warm server. */
export const TOKENIZE_TIMEOUT_MS = 2000;
/** Cache ceiling: one entry per distinct text, evicted oldest-first. */
export const TOKENIZE_CACHE_MAX_ENTRIES = 10_000;

export interface TokenizeOpts {
  /** The recipe's resolved base URL, exactly what the embed request uses. */
  baseUrl: string;
  tokenizer: EmbeddingTokenizer;
  /** Caller's cancellation; aborts the tokenize requests with the embed. */
  signal?: AbortSignal;
}

/** TokenizeOpts plus the per-input cap `serverTokenBudget` cuts against. */
export interface ServerTokenBudgetOpts extends TokenizeOpts {
  /** The recipe's `max_input_tokens` entry for the active model, if any. */
  maxInputTokens?: number;
}

type TokenizeOutcome = { ok: true; ids: number[] } | { ok: false; reason: string };

/**
 * sha256(text) -> token count. Module-level and process-wide on purpose: the
 * same chunk is embedded, re-embedded after a repair and embedded again on the
 * next sync, and re-tokenizing costs a round trip each time.
 *
 * Keyed by the digest plus the `add_special` bit, because that flag adds (or
 * not) the BOS token and would otherwise alias two different counts. The
 * launched model is NOT in the key: a process embeds with one
 * `embedding_model`, and a count inherited from a previously configured
 * server only sizes a sub-batch — it never changes what a text is compared to,
 * and the token-limit halving still catches an under-count.
 */
const _counts = new Map<string, number>();

/** @internal test seam — the cache is process-wide, so a test must own it. */
export function __clearTokenizeCacheForTests(): void {
  _counts.clear();
  _noted.clear();
}

function cacheKey(text: string, addSpecial: boolean): string {
  return `${addSpecial ? '1' : '0'}:${createHash('sha256').update(text).digest('hex')}`;
}

function readCached(key: string): number | undefined {
  const hit = _counts.get(key);
  if (hit === undefined) return undefined;
  // Map iteration is insertion-ordered: re-inserting marks this entry fresh.
  _counts.delete(key);
  _counts.set(key, hit);
  return hit;
}

function writeCached(key: string, count: number): void {
  if (_counts.size >= TOKENIZE_CACHE_MAX_ENTRIES) {
    const oldest = _counts.keys().next();
    if (!oldest.done) _counts.delete(oldest.value);
  }
  _counts.set(key, count);
}

/**
 * One debug line per process when the server tokenizer is unusable, and only
 * under GBRAIN_DEBUG=1: a missing /tokenize is a normal deployment (an older
 * llama.cpp), not something to print at every embed.
 */
const _noted = new Set<string>();

function noteFallback(reason: string, baseUrl: string): void {
  if (process.env.GBRAIN_DEBUG !== '1' || _noted.has(reason)) return;
  _noted.add(reason);
  process.stderr.write(`[embed-tokenize] ${baseUrl}: ${reason}; using the chars_per_token estimate\n`);
}

/** Join a tokenizer endpoint path onto the server root behind `baseUrl`. */
function endpointUrl(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/i, '');
  return `${root}${path.startsWith('/') ? path : `/${path}`}`;
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : TOKENIZE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

function describe(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'TimeoutError' ? 'timed out' : message;
}

function readTokenIds(body: unknown): number[] | null {
  const tokens = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens)) return null;
  for (const token of tokens) {
    if (!Number.isInteger(token) || (token as number) < 0) return null;
  }
  return tokens as number[];
}

async function postJson(url: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error('body is not JSON');
  }
}

/** Tokenize one text; every failure is a `{ok: false}` reason, never a throw. */
async function postTokenize(text: string, addSpecial: boolean, opts: TokenizeOpts): Promise<TokenizeOutcome> {
  const url = endpointUrl(opts.baseUrl, opts.tokenizer.path);
  try {
    const body = await postJson(url, { content: text, add_special: addSpecial }, timeoutSignal(opts.signal, opts.tokenizer.timeout_ms ?? TOKENIZE_TIMEOUT_MS));
    const ids = readTokenIds(body);
    return ids ? { ok: true, ids } : { ok: false, reason: `${url} answered an unexpected body` };
  } catch (err) {
    return { ok: false, reason: `${url} ${describe(err)}` };
  }
}

/**
 * Exact token counts for `texts`, in order.
 *
 * One POST per cache miss, at most `TOKENIZE_CONCURRENCY` in flight, each
 * bounded by `tokenizer.timeout_ms` (2000 by default) and the caller's signal.
 * ALL-OR-NOTHING: a single non-2xx, timeout, non-JSON or malformed body makes
 * the whole call return `null` — a partly-measured batch would split on two
 * different metrics and silently under-budget the request.
 */
export async function countTokens(texts: string[], opts: TokenizeOpts): Promise<number[] | null> {
  if (!texts.length) return [];
  const addSpecial = opts.tokenizer.add_special ?? false;
  const counts: number[] = new Array(texts.length);
  const misses: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = readCached(cacheKey(texts[i]!, addSpecial));
    if (cached === undefined) misses.push(i);
    else counts[i] = cached;
  }
  if (!misses.length) return counts;

  const outcomes = await mapPool(misses, TOKENIZE_CONCURRENCY, i => postTokenize(texts[i]!, addSpecial, opts));
  for (let k = 0; k < misses.length; k++) {
    const outcome = outcomes[k]!;
    if (!outcome.ok) {
      noteFallback(outcome.reason, opts.baseUrl);
      return null;
    }
    const index = misses[k]!;
    const count = outcome.ids.length;
    counts[index] = count;
    writeCached(cacheKey(texts[index]!, addSpecial), count);
  }
  return counts;
}

/**
 * `text` cut to its first `maxTokens` tokens, or `null` when the server cannot
 * say (no detokenizer declared, an endpoint that fails, a token cap below 1).
 * `null` means "leave the input alone": a byte-level cut is what this replaces,
 * and guessing one would split a multi-byte character.
 */
export async function truncateTextToTokens(text: string, maxTokens: number, opts: TokenizeOpts): Promise<string | null> {
  const detokenizer = opts.tokenizer.detokenizer;
  if (!detokenizer || maxTokens < 1) return null;
  const outcome = await postTokenize(text, opts.tokenizer.add_special ?? false, opts);
  if (!outcome.ok) {
    noteFallback(outcome.reason, opts.baseUrl);
    return null;
  }
  if (outcome.ids.length <= maxTokens) return text;

  const url = endpointUrl(opts.baseUrl, detokenizer);
  try {
    const body = await postJson(url, { tokens: outcome.ids.slice(0, maxTokens) }, timeoutSignal(opts.signal, opts.tokenizer.timeout_ms ?? TOKENIZE_TIMEOUT_MS));
    const content = (body as { content?: unknown } | null)?.content;
    // An empty cut would drop the input from the request entirely; hand the
    // decision back to the caller instead.
    return typeof content === 'string' && content.length > 0 ? content : null;
  } catch (err) {
    noteFallback(`${url} ${describe(err)}`, opts.baseUrl);
    return null;
  }
}

/**
 * The token budget `embed()` plans from: exact counts for the texts it is about
 * to send, and — with a declared per-input cap and a detokenizer — a
 * token-boundary cut for the texts over it.
 *
 * `counts` is positional against the returned `texts`, which the caller passes
 * in the SEND order (empty inputs already filtered out). Every failure returns
 * `counts: null` with the texts as they came, so the caller's chars-per-token
 * estimate keeps its pre-existing behaviour.
 */
export async function serverTokenBudget(
  texts: string[],
  opts: ServerTokenBudgetOpts,
): Promise<{ texts: string[]; counts: number[] | null }> {
  const counts = await countTokens(texts, opts);
  if (counts === null) return { texts, counts: null };

  const maxInputTokens = opts.maxInputTokens;
  if (maxInputTokens === undefined || !opts.tokenizer.detokenizer) return { texts, counts };
  const cut = [...texts];
  for (let i = 0; i < texts.length; i++) {
    if (counts[i]! <= maxInputTokens) continue;
    const truncated = await truncateTextToTokens(texts[i]!, maxInputTokens, opts);
    if (truncated === null) continue; // left as it is: the measured count stays honest
    cut[i] = truncated;
    // Sliced at the boundary, so the text re-tokenizes to at most this many.
    counts[i] = maxInputTokens;
  }
  return { texts: cut, counts };
}

/** Run `fn` over `items` with at most `limit` promises in flight, order kept. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
