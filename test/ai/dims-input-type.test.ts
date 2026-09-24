import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

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
