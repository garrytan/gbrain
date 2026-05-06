import { describe, test, expect, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  getEmbeddingModel,
  getEmbeddingDimensions,
  getExpansionModel,
} from '../../src/core/ai/gateway.ts';
import { parseModelId, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('gateway configuration', () => {
  beforeEach(() => resetGateway());

  test('configureGateway sets current models and dims', () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake' },
    });
    expect(getEmbeddingModel()).toBe('google:gemini-embedding-001');
    expect(getEmbeddingDimensions()).toBe(768);
    expect(getExpansionModel()).toBe('anthropic:claude-haiku-4-5-20251001');
  });

  test('defaults preserve v0.13 OpenAI behavior', () => {
    configureGateway({ env: {} });
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getEmbeddingDimensions()).toBe(1536);
    expect(getExpansionModel()).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('gateway.isAvailable (silent-drop regression surface)', () => {
  beforeEach(() => resetGateway());

  test('returns false when gateway not configured', () => {
    expect(isAvailable('embedding')).toBe(false);
  });

  test('embedding available when OPENAI_API_KEY set and model is openai', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embedding UNAVAILABLE when OPENAI_API_KEY missing even if config names openai', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(false);
  });

  test('embedding AVAILABLE for google when GOOGLE_GENERATIVE_AI_API_KEY set even if OPENAI_API_KEY is NOT (Codex silent-drop regression)', () => {
    configureGateway({
      embedding_model: 'google:gemini-embedding-001',
      embedding_dimensions: 768,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google' }, // NOTE: OPENAI_API_KEY deliberately absent
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embedding AVAILABLE for ollama with no API key (local)', () => {
    configureGateway({
      embedding_model: 'ollama:nomic-embed-text',
      embedding_dimensions: 768,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('anthropic rejects embedding touchpoint (has no embedding model)', () => {
    configureGateway({
      embedding_model: 'anthropic:claude-haiku-4-5-20251001',
      embedding_dimensions: 1536,
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    expect(isAvailable('embedding')).toBe(false);
  });

  test('expansion available when ANTHROPIC_API_KEY set', () => {
    configureGateway({
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { ANTHROPIC_API_KEY: 'fake' },
    });
    expect(isAvailable('expansion')).toBe(true);
  });
});

describe('model-resolver', () => {
  test('parseModelId splits on first colon', () => {
    expect(parseModelId('openai:text-embedding-3-large')).toEqual({
      providerId: 'openai',
      modelId: 'text-embedding-3-large',
    });
  });

  test('parseModelId handles model ids with colons', () => {
    expect(parseModelId('litellm:azure:gpt-4')).toEqual({
      providerId: 'litellm',
      modelId: 'azure:gpt-4',
    });
  });

  test('parseModelId rejects missing colon', () => {
    expect(() => parseModelId('openai-text-embedding-3-large')).toThrow(AIConfigError);
  });

  test('parseModelId rejects empty provider or model', () => {
    expect(() => parseModelId(':model')).toThrow(AIConfigError);
    expect(() => parseModelId('provider:')).toThrow(AIConfigError);
  });

  test('resolveRecipe finds known providers', () => {
    const { recipe, parsed } = resolveRecipe('openai:text-embedding-3-large');
    expect(recipe.id).toBe('openai');
    expect(parsed.modelId).toBe('text-embedding-3-large');
  });

  test('resolveRecipe throws AIConfigError for unknown provider', () => {
    expect(() => resolveRecipe('cohere:embed-v3')).toThrow(AIConfigError);
  });
});

describe('dims.dimsProviderOptions', () => {
  test('OpenAI text-embedding-3 returns dimensions param', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-3-large', 1536);
    expect(opts).toEqual({ openai: { dimensions: 1536 } });
  });

  test('OpenAI ada-002 returns undefined (no dim param)', () => {
    const opts = dimsProviderOptions('native-openai', 'text-embedding-ada-002', 1536);
    expect(opts).toBeUndefined();
  });

  test('Google gemini-embedding returns outputDimensionality', () => {
    const opts = dimsProviderOptions('native-google', 'gemini-embedding-001', 768);
    expect(opts).toEqual({ google: { outputDimensionality: 768 } });
  });

  test('Anthropic returns undefined (no embedding model)', () => {
    const opts = dimsProviderOptions('native-anthropic', 'claude-haiku-4-5', 1536);
    expect(opts).toBeUndefined();
  });

  test('openai-compatible returns undefined (no standard dim param)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768);
    expect(opts).toBeUndefined();
  });
});
