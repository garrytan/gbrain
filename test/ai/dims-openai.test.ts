/**
 * v0.36.0.0 (D13): OpenAI Matryoshka dim validation tests.
 *
 * Pins:
 *  - OpenAI text-embedding-3-* accepts arbitrary truncation via Matryoshka,
 *    bounded by the model's native size (1536 for -small, 3072 for -large)
 *  - dimsProviderOptions throws AIConfigError for out-of-range dims
 *  - Error message includes a paste-ready `gbrain config set` fix
 *  - Plumbing reaches BOTH the native-openai path (line 97) AND the
 *    openai-compatible path (line 167) — Azure-OpenAI hosts text-3 via the
 *    compat adapter, same validation contract there.
 *
 * Why: the v0.36.0.0 wave flips the default embedding to ZE at 1024d. The
 * fallback path is OpenAI text-embedding-3-large at 1024d (also valid per
 * Matryoshka). Without range validation, a user who mis-configures
 * `embedding_dimensions=5000` against text-embedding-3-small gets opaque
 * HTTP 400s at first embed instead of a config-time fail-loud.
 */

import { describe, test, expect } from 'bun:test';
import {
  dimsProviderOptions,
  isValidOpenAITextEmbedding3Dim,
  isOpenAITextEmbedding3Model,
  maxOpenAITextEmbedding3Dim,
} from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('OpenAI text-embedding-3 model recognition', () => {
  test('isOpenAITextEmbedding3Model for known variants', () => {
    expect(isOpenAITextEmbedding3Model('text-embedding-3-small')).toBe(true);
    expect(isOpenAITextEmbedding3Model('text-embedding-3-large')).toBe(true);
  });

  test('isOpenAITextEmbedding3Model rejects ada-002 and unrelated', () => {
    expect(isOpenAITextEmbedding3Model('text-embedding-ada-002')).toBe(false);
    expect(isOpenAITextEmbedding3Model('zembed-1')).toBe(false);
    expect(isOpenAITextEmbedding3Model('voyage-3-large')).toBe(false);
  });

  test('maxOpenAITextEmbedding3Dim returns 1536 / 3072', () => {
    expect(maxOpenAITextEmbedding3Dim('text-embedding-3-small')).toBe(1536);
    expect(maxOpenAITextEmbedding3Dim('text-embedding-3-large')).toBe(3072);
    expect(maxOpenAITextEmbedding3Dim('text-embedding-ada-002')).toBeUndefined();
  });
});

describe('isValidOpenAITextEmbedding3Dim — Matryoshka range', () => {
  test('text-embedding-3-large: accepts 1..3072', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1024)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1536)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 3072)).toBe(true);
  });

  test('text-embedding-3-large: rejects out-of-range', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 0)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', -1)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 3073)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 5000)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-large', 1.5)).toBe(false);
  });

  test('text-embedding-3-small: rejects > 1536 (smaller native size)', () => {
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 1536)).toBe(true);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 1537)).toBe(false);
    expect(isValidOpenAITextEmbedding3Dim('text-embedding-3-small', 3072)).toBe(false);
  });
});

describe('dimsProviderOptions — OpenAI native path', () => {
  test('text-embedding-3-large at 1024d returns dimensions=1024 (D13 happy path)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1024);
    expect(opts).toEqual({ openai: { dimensions: 1024 } });
  });

  test('text-embedding-3-small at 512d returns dimensions=512', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-small', 512);
    expect(opts).toEqual({ openai: { dimensions: 512 } });
  });

  test('text-embedding-3-large at 5000d throws AIConfigError', () => {
    expect(() => dimsProviderOptions('native-openai', 'text-embedding-3-large', 5000))
      .toThrow(AIConfigError);
  });

  test('text-embedding-3-small at 3072d throws (exceeds small native size)', () => {
    expect(() => dimsProviderOptions('native-openai', 'text-embedding-3-small', 3072))
      .toThrow(AIConfigError);
  });

  test('AIConfigError message includes paste-ready fix hint', () => {
    try {
      dimsProviderOptions('native-openai', 'text-embedding-3-large', 5000);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('text-embedding-3-large');
      expect(msg).toContain('5000');
      expect(msg).toContain('3072');
      // Paste-ready fix appears in the `fix` property of AIConfigError.
      const fix = (err as AIConfigError).fix ?? '';
      expect(fix).toContain('gbrain config set embedding_dimensions');
    }
  });

  test('ada-002 returns undefined (no dimensions support)', () => {
    expect(dimsProviderOptions('native-openai', 'text-embedding-ada-002', 1536))
      .toBeUndefined();
  });

  test('inputType ignored on OpenAI symmetric provider (regression guard)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1024, 'query');
    expect(opts).toEqual({ openai: { dimensions: 1024 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });
});

describe('dimsProviderOptions — OpenAI on openai-compatible adapter (Azure case)', () => {
  test('text-embedding-3-large at 1024d via openai-compat path returns dimensions=1024', () => {
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('text-embedding-3-large at 5000d via openai-compat path throws', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 5000))
      .toThrow(AIConfigError);
  });

  test('inputType ignored on OpenAI symmetric provider via openai-compat path', () => {
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1024, 'query');
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });
});
