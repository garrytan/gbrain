/**
 * #4530 — the chunker respects the embedding model's per-input token limit.
 *
 * nvidia/nv-embedqa-e5-v5 (NVIDIA NIM) rejects any single input over 512
 * tokens with a non-transient 400; the chunker calibrated to OpenAI/Voyage
 * limits emitted chunks up to ~2000 estimated tokens, so ~35% of a typical
 * vault could NEVER embed. The recipe now declares the per-model limit,
 * resolveMaxChunkTokens() maps it to a chunk-token cap (x 0.6 safety for the
 * cl100k-estimate vs wordpiece mismatch, GBRAIN_MAX_CHUNK_TOKENS escape
 * hatch), and chunkText SPLITS (never truncates) to fit.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  resolveMaxChunkTokens,
  maxInputTokensForModel,
  EMBED_INPUT_SAFETY,
} from '../src/core/embedding-input-limit.ts';
import { DEFAULT_MAX_CHUNK_TOKENS } from '../src/core/chunkers/token-estimate.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { nvidia } from '../src/core/ai/recipes/nvidia.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isEmbedRetriableError, isTransientNetworkEmbedError } from '../src/core/embed-retry.ts';
import { normalizeAIError, AIConfigError } from '../src/core/ai/errors.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * resolveMaxChunkTokens() defaults to process.env; tests that exercise the
 * no-arg path clear GBRAIN_MAX_CHUNK_TOKENS via withEnv (restores the prior
 * ambient value — never mutates shard-global env permanently).
 */
const withoutChunkTokenEnv = <T>(fn: () => T | Promise<T>) =>
  withEnv({ GBRAIN_MAX_CHUNK_TOKENS: undefined }, fn);

beforeEach(() => {
  resetGateway();
});

afterAll(() => {
  // Shard hygiene: restore the legacy embedding pin (truncation-test precedent).
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

const NV_MODEL = 'nvidia:nvidia/nv-embedqa-e5-v5';
const NV_EXPECTED = Math.floor(512 * EMBED_INPUT_SAFETY); // 307

describe('resolveMaxChunkTokens (#4530)', () => {
  test('default stays DEFAULT_MAX_CHUNK_TOKENS when no model limit is declared', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { OPENAI_API_KEY: 'sk-test' },
      });
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    });
  });

  test('gateway unconfigured falls back to the default (fail-open)', async () => {
    await withoutChunkTokenEnv(() => {
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    });
  });

  test('nv-embedqa-e5-v5 resolves 512 x safety', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({
        embedding_model: NV_MODEL,
        embedding_dimensions: 1024,
        env: { NVIDIA_API_KEY: 'nvapi-test' },
      });
      expect(resolveMaxChunkTokens()).toBe(NV_EXPECTED);
    });
  });

  test('the short alias form resolves the same limit', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({
        embedding_model: 'nvidia:nv-embedqa-e5-v5',
        embedding_dimensions: 1024,
        env: { NVIDIA_API_KEY: 'nvapi-test' },
      });
      expect(resolveMaxChunkTokens()).toBe(NV_EXPECTED);
    });
  });

  test('GBRAIN_MAX_CHUNK_TOKENS escape hatch wins, clamped to the default ceiling', () => {
    configureGateway({
      embedding_model: NV_MODEL,
      embedding_dimensions: 1024,
      env: { NVIDIA_API_KEY: 'nvapi-test' },
    });
    expect(resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: '400' })).toBe(400);
    expect(resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: '999999' })).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    expect(resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: '1' })).toBe(64); // floor
    // Garbage falls through to the model/default resolution.
    expect(resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'banana' })).toBe(NV_EXPECTED);
  });

  test('wave-g: invalid GBRAIN_MAX_CHUNK_TOKENS warns once per process per value, not per call', () => {
    // The resolver runs per chunkText site — a typo'd env var must not emit
    // one stderr line per page across a whole backfill.
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { seen.push(args.join(' ')); };
    try {
      resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'warn-once-probe' });
      resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'warn-once-probe' });
      resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'warn-once-probe' });
      expect(seen.filter((l) => l.includes('warn-once-probe')).length).toBe(1);
      // A CHANGED (still-invalid) value warns again — once.
      resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'warn-once-probe-2' });
      resolveMaxChunkTokens({ GBRAIN_MAX_CHUNK_TOKENS: 'warn-once-probe-2' });
      expect(seen.filter((l) => l.includes('warn-once-probe-2')).length).toBe(1);
    } finally {
      console.error = orig;
    }
  });

  test('maxInputTokensForModel is case-insensitive (model_dims #4123 parity)', () => {
    expect(maxInputTokensForModel(nvidia, 'nvidia/nv-embedqa-e5-v5')).toBe(512);
    expect(maxInputTokensForModel(nvidia, 'NVIDIA/NV-EmbedQA-E5-V5')).toBe(512);
    expect(maxInputTokensForModel(nvidia, 'nvidia/nv-embed-v1')).toBeUndefined();
  });
});

describe('chunkText maxTokens cap (#4530)', () => {
  // Realistic prose paragraph, repeated: dense enough that default chunks
  // measure well over the 307-token cap.
  const para = 'The migration plan covers seventy thousand pages of engineering notes, meeting summaries, and design documents that must be re-embedded onto the new provider without loss. ';
  const text = Array.from({ length: 40 }, () => para).join('\n\n');

  test('every emitted chunk fits the model cap — split, not truncated', () => {
    const cap = NV_EXPECTED;
    const chunks = chunkText(text, { maxTokens: cap });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(estimateEmbedTokens(c.text)).toBeLessThanOrEqual(cap);
    }
    // Split, not truncated: the emitted chunks must jointly carry more
    // content than any single capped chunk (nothing was thrown away).
    const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
    expect(totalChars).toBeGreaterThanOrEqual(text.length * 0.9); // overlap adds, strip removes little
  }, 60000);

  test('default behavior is unchanged when maxTokens is not passed', () => {
    const defaultChunks = chunkText(text);
    const explicitDefault = chunkText(text, { maxTokens: DEFAULT_MAX_CHUNK_TOKENS });
    expect(defaultChunks).toEqual(explicitDefault);
  }, 60000);

  test('a maxTokens above the default ceiling is clamped (pipeline sizing)', () => {
    const oversized = chunkText(text, { maxTokens: 999999 });
    expect(oversized).toEqual(chunkText(text));
  }, 60000);
});

describe('the per-input 400 is non-transient (#4530)', () => {
  // The exact wire shape NVIDIA NIM returns for an over-limit input.
  function nvidia400(): Error {
    const e = new Error('Input length 576 exceeds maximum allowed token size 512') as Error & { statusCode: number };
    e.statusCode = 400;
    return e;
  }

  test('never classified retriable — no 60s backoff loop', () => {
    expect(isEmbedRetriableError(nvidia400())).toBe(false);
    expect(isTransientNetworkEmbedError(nvidia400())).toBe(false);
  });

  test('normalizeAIError marks it config-class (non-retryable), not transient', () => {
    expect(normalizeAIError(nvidia400())).toBeInstanceOf(AIConfigError);
  });
});
