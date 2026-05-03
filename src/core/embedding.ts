/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * Token-based input truncation (8100 tokens, ~92 token headroom under
 * the 8192 ceiling enforced by text-embedding-3-{small,large}).
 */

import OpenAI from 'openai';

const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
// OpenAI text-embedding-3-{small,large} hard-cap input at 8192 tokens.
// We clamp at 8100 to leave ~92 tokens of headroom for any tokenizer
// drift between cl100k_base (what we count with) and OpenAI server-side
// tokenization (which is the same family but version-pinned separately).
const MAX_TOKENS = 8100;
// Fallback character cap when tiktoken fails to load. Conservative ~2:1
// char-to-token ratio so dense code/markup still fits under 8192 tokens.
const FALLBACK_MAX_CHARS = 16000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

// Lazy + cached cl100k_base encoder. Same encoder text-embedding-3-large
// uses on the server, mirroring the pattern in src/core/chunkers/code.ts
// (estimateTokens). Pay init cost once per process; per-chunk overhead
// is then O(n) in text length.
let tiktokenEncoder:
  | { encode: (s: string) => Uint32Array; decode: (t: Uint32Array) => Uint8Array; free: () => void }
  | null = null;
let tiktokenInitialized = false;
const utf8Decoder = new TextDecoder('utf-8');

function initTokenizer(): void {
  if (tiktokenInitialized) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require('@dqbd/tiktoken');
    tiktokenEncoder = m.get_encoding('cl100k_base');
  } catch {
    tiktokenEncoder = null;
  }
  tiktokenInitialized = true;
}

/**
 * Truncate `text` so its cl100k_base token count is <= MAX_TOKENS.
 *
 * Why this exists: chunkers target ~300 words per chunk, but the recursive
 * merger lets chunks grow up to ~1.5x target plus 50-word overlap. Dense
 * code or markup hits 2-3 tokens per char (vs 0.25 tokens/char for prose),
 * so a 600-word chunk can exceed 8192 tokens and OpenAI rejects with HTTP
 * 400 ("Invalid 'input[0]': maximum input length is 8192 tokens"). The
 * old MAX_CHARS=8000 cap did not account for this.
 *
 * UTF-8 safety: we encode -> slice tokens -> decode bytes -> TextDecoder.
 * TextDecoder defaults to fatal=false and replaces invalid sequences,
 * which preserves UTF-8 boundaries even if a multi-byte char straddles
 * the truncation point.
 */
function truncateToTokens(text: string): string {
  if (!text) return text;
  initTokenizer();
  if (!tiktokenEncoder) {
    // Fallback path: tiktoken failed to load (vanishingly unlikely once
    // it loaded successfully for the chunker). Use a conservative char
    // cap that still keeps dense content under 8192 tokens.
    return text.length > FALLBACK_MAX_CHARS ? text.slice(0, FALLBACK_MAX_CHARS) : text;
  }
  const tokens = tiktokenEncoder.encode(text);
  if (tokens.length <= MAX_TOKENS) return text;
  const sliced = tokens.slice(0, MAX_TOKENS);
  const bytes = tiktokenEncoder.decode(sliced);
  return utf8Decoder.decode(bytes);
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = truncateToTokens(text);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each 100-item sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => truncateToTokens(t));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: MODEL,
        input: texts,
        dimensions: DIMENSIONS,
      });

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Check for rate limit with Retry-After header
      let delay = exponentialDelay(attempt);

      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            delay = parsed * 1000;
          }
        }
      }

      await sleep(delay);
    }
  }

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
