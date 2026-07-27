/**
 * v0.35.0.0+ dim validator + 4th-arg inputType plumbing tests.
 *
 * Pins:
 *  - ZE valid dim allowlist (CDX1-F-equivalent for zembed-1)
 *  - dimsProviderOptions returns input_type='document' default for ZE
 *  - dimsProviderOptions returns input_type='query' when threaded
 *  - dimsProviderOptions DROPS input_type for OpenAI text-3 (per-model
 *    filtering, NOT generic openai-compat — CDX2-F6)
 *  - dim validator throws AIConfigError for invalid dim
 */

import { describe, test, expect } from 'bun:test';
import {
  dimsProviderOptions,
  isValidZeroEntropyDim,
  ZEROENTROPY_VALID_DIMS,
  supportsZeroEntropyDimension,
} from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('ZE dim allowlist', () => {
  test('exposes all 7 valid Matryoshka steps', () => {
    expect([...ZEROENTROPY_VALID_DIMS]).toEqual([2560, 1280, 640, 320, 160, 80, 40]);
  });

  test('isValidZeroEntropyDim accepts every allowlist value', () => {
    for (const d of ZEROENTROPY_VALID_DIMS) {
      expect(isValidZeroEntropyDim(d)).toBe(true);
    }
  });

  test('isValidZeroEntropyDim rejects non-allowlist values', () => {
    expect(isValidZeroEntropyDim(1024)).toBe(false); // common OpenAI default — catches the bug class
    expect(isValidZeroEntropyDim(1536)).toBe(false); // DEFAULT_EMBEDDING_DIMENSIONS
    expect(isValidZeroEntropyDim(3072)).toBe(false);
    expect(isValidZeroEntropyDim(100)).toBe(false);
  });

  test('supportsZeroEntropyDimension(zembed-1)', () => {
    expect(supportsZeroEntropyDimension('zembed-1')).toBe(true);
    expect(supportsZeroEntropyDimension('zerank-2')).toBe(false);
    expect(supportsZeroEntropyDimension('text-embedding-3-large')).toBe(false);
  });
});

describe('dimsProviderOptions — ZE branch', () => {
  test('default inputType: emits input_type=document', () => {
    const opts = dimsProviderOptions('openai-compatible', 'zembed-1', 2560);
    expect(opts).toEqual({
      openaiCompatible: { dimensions: 2560, input_type: 'document' },
    });
  });

  test('inputType=query: emits input_type=query', () => {
    const opts = dimsProviderOptions('openai-compatible', 'zembed-1', 1280, 'query');
    expect(opts).toEqual({
      openaiCompatible: { dimensions: 1280, input_type: 'query' },
    });
  });

  test('inputType=document: emits input_type=document', () => {
    const opts = dimsProviderOptions('openai-compatible', 'zembed-1', 640, 'document');
    expect(opts).toEqual({
      openaiCompatible: { dimensions: 640, input_type: 'document' },
    });
  });

  test('throws AIConfigError for dim=1024 (catches the silent-default bug)', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'zembed-1', 1024)).toThrow(AIConfigError);
  });

  test('throws AIConfigError for dim=3072', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'zembed-1', 3072)).toThrow(AIConfigError);
  });

  test('error message names valid dims for paste-ready fix', () => {
    try {
      dimsProviderOptions('openai-compatible', 'zembed-1', 1024);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      const msg = (err as Error).message;
      // Lists the 7 valid dims so the user can copy-paste a valid value.
      expect(msg).toContain('2560');
      expect(msg).toContain('40');
    }
  });
});

describe('CDX2-F6: per-model inputType filtering', () => {
  test('OpenAI text-embedding-3-large IGNORES inputType (symmetric provider)', () => {
    // Pass inputType='query' and confirm input_type does NOT reach the
    // provider-options blob. OpenAI's /embeddings endpoint would reject
    // an unexpected field; the test pins the absence.
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1536, 'query');
    expect(opts).toEqual({ openai: { dimensions: 1536 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });

  test('OpenAI text-embedding-3 on openai-compat adapter ignores inputType', () => {
    // Azure OpenAI sometimes hosts text-embedding-3 via openai-compat.
    // input_type would be rejected.
    const opts = dimsProviderOptions('openai-compatible', 'text-embedding-3-large', 1536, 'query');
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1536 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });

  test('Voyage models accept inputType when explicitly threaded', () => {
    // Voyage v4 + v3 accept input_type. inputType undefined → no field
    // (back-compat for pre-v0.35.0.0 tests); inputType='query' → field present.
    const optsDefault = dimsProviderOptions('openai-compatible', 'voyage-3-large', 1024);
    expect(optsDefault).toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(JSON.stringify(optsDefault)).not.toContain('input_type');

    const optsQuery = dimsProviderOptions('openai-compatible', 'voyage-3-large', 1024, 'query');
    expect(optsQuery).toEqual({
      openaiCompatible: { dimensions: 1024, input_type: 'query' },
    });
  });
});
