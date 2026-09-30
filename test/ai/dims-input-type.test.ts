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

// #5543 — Qwen3-Embedding is asymmetric, but the openai-compatible branch
// only emitted `dimensions` (or nothing at native width), so a self-hosted
// server could never tell a search query from an indexed chunk and the
// model-card instruction never reached the query. Two seams now carry it:
// `input_type` for servers that honour it, and a text prefix for the ones
// that don't (Ollama, llama-server, vLLM ignore unknown fields).
import {
  QWEN3_EMBEDDING_DEFAULT_QUERY_INSTRUCT,
  isQwen3EmbeddingModel,
  queryInstructPrefix,
} from '../../src/core/ai/dims.ts';

describe('#5543: Qwen3-Embedding threads inputType on openai-compatible', () => {
  test('native width + no inputType stays undefined (vLLM rejects `dimensions` at native)', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:0.6b', 1024)).toBeUndefined();
  });

  test('native width + query threads input_type WITHOUT dimensions', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:0.6b', 1024, 'query')).toEqual({
      openaiCompatible: { input_type: 'query' },
    });
  });

  test('narrowed width + document threads both dimensions and input_type', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 1024, 'document')).toEqual({
      openaiCompatible: { dimensions: 1024, input_type: 'document' },
    });
  });

  test('hub-form cased id (Qwen/Qwen3-Embedding-0.6B) matches too', () => {
    expect(dimsProviderOptions('openai-compatible', 'Qwen/Qwen3-Embedding-0.6B', 1024, 'query')).toEqual({
      openaiCompatible: { input_type: 'query' },
    });
  });
});

describe('#5543: queryInstructPrefix', () => {
  const expectedDefault = `Instruct: ${QWEN3_EMBEDDING_DEFAULT_QUERY_INSTRUCT}\nQuery: `;

  test.each([
    'qwen3-embedding',
    'qwen3-embedding:0.6b',
    'qwen3-embedding:8b',
    'qwen3-embedding-4b',
    'Qwen/Qwen3-Embedding-0.6B',
  ])('%s: query gets the model-card default prefix', (id) => {
    expect(isQwen3EmbeddingModel(id)).toBe(true);
    expect(queryInstructPrefix('openai-compatible', id, 'query')).toBe(expectedDefault);
  });

  test('documents are never prefixed (existing indexes stay valid)', () => {
    expect(queryInstructPrefix('openai-compatible', 'qwen3-embedding:0.6b', 'document')).toBe('');
    expect(queryInstructPrefix('openai-compatible', 'qwen3-embedding:0.6b', undefined)).toBe('');
  });

  test('non-Qwen3 models get no default prefix', () => {
    expect(isQwen3EmbeddingModel('bge-m3')).toBe(false);
    expect(queryInstructPrefix('openai-compatible', 'bge-m3', 'query')).toBe('');
    expect(queryInstructPrefix('openai-compatible', 'voyage-4', 'query')).toBe('');
    expect(queryInstructPrefix('openai-compatible', 'qwen3-reranker', 'query')).toBe('');
  });

  test('native providers never prefix, even for a Qwen3 id', () => {
    expect(queryInstructPrefix('native-openai', 'qwen3-embedding:0.6b', 'query')).toBe('');
    expect(queryInstructPrefix('native-google', 'qwen3-embedding:0.6b', 'query')).toBe('');
  });

  test('configured task line overrides the default', () => {
    expect(queryInstructPrefix('openai-compatible', 'qwen3-embedding:0.6b', 'query', 'Find the note that answers this')).toBe(
      'Instruct: Find the note that answers this\nQuery: ',
    );
  });

  test('configured empty string disables the prefix for Qwen3', () => {
    expect(queryInstructPrefix('openai-compatible', 'qwen3-embedding:0.6b', 'query', '')).toBe('');
    expect(queryInstructPrefix('openai-compatible', 'qwen3-embedding:0.6b', 'query', '   ')).toBe('');
  });

  test('an explicit task line applies to any openai-compatible model (operator choice)', () => {
    expect(queryInstructPrefix('openai-compatible', 'e5-mistral-7b-instruct', 'query', 'Retrieve passages')).toBe(
      'Instruct: Retrieve passages\nQuery: ',
    );
    // ...but still never on documents.
    expect(queryInstructPrefix('openai-compatible', 'e5-mistral-7b-instruct', 'document', 'Retrieve passages')).toBe('');
  });
});
