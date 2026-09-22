/**
 * Pre-embed input ceiling — the last gate before a text reaches an embedder.
 *
 * Why this exists: stored chunks are not guaranteed to respect the
 * chunker's cap. In observed production behavior, `content_chunks` rows written
 * by an older chunker version outlive the upgrade that introduced
 * `DEFAULT_MAX_CHUNK_TOKENS`, and several paths (`embed-stale`,
 * `migrate-engine`, the re-embed sweeps) recycle `chunk_text` verbatim without
 * ever re-measuring it. So the embed path must assume nothing about what the
 * chunker produced and check for itself.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT.
 *
 * It guarantees the embed path never SPENDS a provider call on a text that
 * already blows gbrain's own declared chunk budget. It does NOT guarantee the
 * provider will accept everything that passes, and treating it as if it did
 * would be a bug. The estimator is cl100k (`estimateEmbedTokens`), which is
 * the tokenizer OpenAI's embedders use; other embedders tokenize the same
 * bytes very differently. Measured against `ollama:bge-m3` (XLM-RoBERTa
 * SentencePiece, 8192-token context) on real HTML/JS chunks:
 *
 *     chunk  chars  cl100k tokens  bge-m3 verdict
 *     4437    6053           1926  accepted
 *     4435    6053           1943  REJECTED (over 8192)
 *     3853    6057           2250  accepted
 *     3851    6057           2224  REJECTED (over 8192)
 *
 * The two classes OVERLAP: 2250 cl100k tokens fit while 1943 did not. No
 * cl100k threshold — and no character threshold either, those pairs are the
 * same length — separates them. A foreign tokenizer's verdict simply cannot
 * be predicted from a local estimate, which is why the reactive half of the
 * fix (`AIInputTooLargeError` + parking the chunk) is load-bearing rather
 * than a fallback. This module is the cheap first line; it is not the
 * guarantee.
 *
 * The cap is therefore expressed as gbrain's OWN invariant — "no chunk may
 * exceed the chunker's budget" — not as a model's context window. Operators
 * running a strict embedder can tighten it via
 * `GBRAIN_MAX_EMBED_INPUT_TOKENS` to trade recall for round-trips.
 */

import { DEFAULT_MAX_CHUNK_TOKENS, estimateEmbedTokens } from './chunkers/token-estimate.ts';

/** Operator override for the per-input token ceiling. */
export const EMBED_INPUT_TOKEN_CAP_ENV = 'GBRAIN_MAX_EMBED_INPUT_TOKENS';

/**
 * Resolve the per-input token ceiling. Defaults to the chunker's own budget:
 * anything above it is by definition a chunk the current chunker would never
 * have emitted, so refusing to send it restores an invariant rather than
 * inventing a new policy. A non-numeric or non-positive override is ignored
 * (fail-safe: a typo must not disable the guard).
 */
export function maxEmbedInputTokens(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[EMBED_INPUT_TOKEN_CAP_ENV];
  if (raw === undefined) return DEFAULT_MAX_CHUNK_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CHUNK_TOKENS;
  return Math.floor(parsed);
}

/** One input the guard refused to send, with the numbers an operator needs. */
export interface OversizedEmbedInput {
  /** Position in the caller's original `texts` array. */
  index: number;
  chars: number;
  estimatedTokens: number;
  /** Ceiling that was in force, so a log line explains itself. */
  cap: number;
}

export interface EmbedInputPartition {
  /** Texts safe to send, in original order. */
  sendable: string[];
  /** `sendable[i]` came from `texts[sendableIndexes[i]]`. */
  sendableIndexes: number[];
  /** Empty on the healthy path — allocation-free for normal corpora. */
  oversized: OversizedEmbedInput[];
}

/** True when `text` is over the ceiling and must not be sent as-is. */
export function isEmbedInputOversized(text: string, cap: number = maxEmbedInputTokens()): boolean {
  if (!text) return false;
  return estimateEmbedTokens(text) > cap;
}

/**
 * Split `texts` into what may be sent and what must not. Order-preserving on
 * both sides so the caller can scatter results back onto its chunk rows by
 * index — the embed paths map one input to exactly one `content_chunks` row,
 * so an input can be dropped but never re-split here.
 *
 * Fast path: measures nothing until a text is long enough to possibly breach
 * the cap. `estimateEmbedTokens` runs tiktoken, which is superlinear on long
 * inputs, and the overwhelming majority of chunks are far under the ceiling.
 *
 * The skip test is on BYTES, not characters. Every cl100k token consumes at
 * least one byte of input, so `byteLength <= cap` genuinely implies
 * `tokens <= cap` — while the same claim about CHARACTERS is false, and false
 * in exactly the direction that matters: one emoji or CJK glyph is one or two
 * JS string units but several tokens under byte fallback, so a character test
 * would wave through the dense chunks this guard exists to catch.
 */
export function partitionEmbedInputs(
  texts: string[],
  cap: number = maxEmbedInputTokens(),
): EmbedInputPartition {
  const sendable: string[] = [];
  const sendableIndexes: number[] = [];
  const oversized: OversizedEmbedInput[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? '';
    // ASCII — the common case — has byteLength === length, so the fast path is
    // just as effective there; multi-byte text correctly falls through.
    if (Buffer.byteLength(text, 'utf8') <= cap) {
      sendable.push(text);
      sendableIndexes.push(i);
      continue;
    }
    const estimatedTokens = estimateEmbedTokens(text);
    if (estimatedTokens > cap) {
      oversized.push({ index: i, chars: text.length, estimatedTokens, cap });
    } else {
      sendable.push(text);
      sendableIndexes.push(i);
    }
  }

  return { sendable, sendableIndexes, oversized };
}

/** One-line operator summary of a refusal. */
export function describeOversizedInput(o: OversizedEmbedInput): string {
  return `${o.chars} chars / ~${o.estimatedTokens} tokens exceeds the ${o.cap}-token embed input cap`;
}
