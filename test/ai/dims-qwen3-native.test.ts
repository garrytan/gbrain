/**
 * Qwen3-Embedding native-width dims suppression tests.
 *
 * Pins:
 *  - dimsProviderOptions returns undefined when the configured dim equals
 *    the model's native width (1024/2560/4096 for 0.6B/4B/8B) — fixed-dim
 *    OpenAI-compatible backends serving this family (e.g. vLLM) reject the
 *    `dimensions` parameter with HTTP 400 "does not support matryoshka
 *    representation" even when the value equals the native size, and
 *    omitting it in the equal case is a no-op for Ollama.
 *  - Matryoshka truncation is preserved: a dim that differs from the native
 *    width still emits { openaiCompatible: { dimensions } } for Ollama.
 */

import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('qwen3-embedding native-width suppression', () => {
  test('bare model at native 1024 emits no dimensions param', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding', 1024)).toBeUndefined();
  });

  test('tagged variants at their native width emit no dimensions param', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:0.6b', 1024)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 2560)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 4096)).toBeUndefined();
  });

  test('non-native dim still requests Matryoshka truncation', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding', 512))
      .toEqual({ openaiCompatible: { dimensions: 512 } });
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('unknown tag falls through to sending the configured dim', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:32b', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });
});

describe('qwen3-embedding hyphenated hub-form ids (OpenRouter et al.)', () => {
  test('org-prefixed hub id requests Matryoshka truncation at non-native dim', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen/qwen3-embedding-8b', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
    expect(dimsProviderOptions('openai-compatible', 'qwen/qwen3-embedding-4b', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('hub id at native width emits no dimensions param', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen/qwen3-embedding-8b', 4096)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'qwen/qwen3-embedding-4b', 2560)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'qwen/qwen3-embedding-0.6b', 1024)).toBeUndefined();
  });

  test('bare hyphenated id (no org prefix) also matches', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding-8b', 2000))
      .toEqual({ openaiCompatible: { dimensions: 2000 } });
  });

  test('unknown hyphenated variant falls through to sending the configured dim', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding-32b', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });
});

describe('qwen3-embedding mixed-case hub ids — LiteLLM / vLLM / HF routers (#4123)', () => {
  test('THE reported case: correctly-cased Qwen/Qwen3-Embedding-4B at 1536 pins dimensions', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-4B', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('native-width suppression still applies under folding (4B at 2560 → undefined)', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-4B', 2560))
      .toBeUndefined();
  });

  test('org-less cased hyphen form pins a Matryoshka width', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen3-Embedding-8B', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('org-prefixed cased 8B at a Matryoshka width pins dimensions', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-8B', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('cased 0.6B at its native width stays suppressed', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-0.6B', 1024))
      .toBeUndefined();
  });

  test('cased Ollama colon-tag form: native suppressed, non-native pinned', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen3-Embedding:4B', 2560)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'Qwen3-Embedding:4B', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('SCREAMING form folds too', () => {
    expect(dimsProviderOptions('openai-compatible', 'QWEN/QWEN3-EMBEDDING-4B', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('no-leak pin: the returned blob carries ONLY dimensions — no folded model id can reach the wire', () => {
    const opts = dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-4B', 1536)!;
    expect(Object.keys(opts)).toEqual(['openaiCompatible']);
    expect(Object.keys(opts.openaiCompatible)).toEqual(['dimensions']);
  });
});
