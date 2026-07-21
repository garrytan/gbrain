/**
 * Google embedding Matryoshka dim plumbing for openai-compat recipes.
 *
 * Pins:
 *  - google/gemini-embedding-2 emits `dimensions: N` on openai-compat
 *    (matches OpenAI text-3 + DashScope + Zhipu pattern)
 *  - google/gemini-embedding-001 (legacy name) also handled
 *  - text-embedding-004 (Google's stable production name) also handled
 *  - inputType is dropped — Google embeddings are symmetric
 *  - other Gemini-prefixed models (chat) are NOT matched
 *
 * Context: Google's gemini-embedding-2 supports flexible output dims
 * (128..3072, recommended 768/1536/3072). Without this branch the
 * gateway sent no `dimensions` field, the API returned 3072, and the
 * gateway dim-mismatch validator at gateway.ts:1981 hard-failed on
 * first embed for any brain configured at a non-default dim.
 */

import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('Google embeddings — openai-compat Matryoshka', () => {
  test('google/gemini-embedding-2 emits dimensions=1536', () => {
    const opts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-2',
      1536,
    );
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('google/gemini-embedding-2 emits dimensions=768 (lower Matryoshka step)', () => {
    const opts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-2',
      768,
    );
    expect(opts).toEqual({ openaiCompatible: { dimensions: 768 } });
  });

  test('google/gemini-embedding-2 emits dimensions=3072 (full-fidelity)', () => {
    const opts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-2',
      3072,
    );
    expect(opts).toEqual({ openaiCompatible: { dimensions: 3072 } });
  });

  test('legacy google/gemini-embedding-001 also covered', () => {
    const opts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-001',
      1536,
    );
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('text-embedding-004 (stable Google prod name) also covered', () => {
    const opts = dimsProviderOptions(
      'openai-compatible',
      'text-embedding-004',
      1536,
    );
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('Google branch ignores inputType (symmetric retrieval)', () => {
    // Mirrors the CDX2-F6 contract: asymmetric providers (ZE, Voyage) accept
    // input_type, but Google embeddings are symmetric — must NOT emit the
    // field or OpenRouter may forward it and cause provider-side rejection.
    const queryOpts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-2',
      1536,
      'query',
    );
    const docOpts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-embedding-2',
      1536,
      'document',
    );
    expect(queryOpts).toEqual({ openaiCompatible: { dimensions: 1536 } });
    expect(docOpts).toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('does NOT match unrelated Google models (e.g. chat gemini-3)', () => {
    // Gemini chat models live behind the recipe.touchpoints.chat path, not
    // embedding. If dimsProviderOptions started matching chat model IDs here,
    // embedMany would send `dimensions` to a chat endpoint and break.
    const opts = dimsProviderOptions(
      'openai-compatible',
      'google/gemini-3-flash-preview',
      1536,
    );
    expect(opts).toBeUndefined();
  });
});
