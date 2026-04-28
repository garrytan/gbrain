/**
 * Provider factory + adapter tests.
 *
 * Strategy: mock the OpenAI SDK at the module level so the adapter
 * exercises the unified interface without real API calls.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { getEmbeddingProvider, getLlmProvider } from '../src/llm/factory.ts';
import { OpenAICompatibleAdapter } from '../src/llm/adapters/openai-compatible.ts';
import { AnthropicAdapter } from '../src/llm/adapters/anthropic.ts';
import { resolveModel } from '../src/llm/tiers.ts';

describe('llm/factory.ts — getLlmProvider', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.LLM_API_KEY;
  });

  test('returns null when no config and no env vars', () => {
    const provider = getLlmProvider({ engine: 'pglite' });
    expect(provider).toBeNull();
  });

  test('legacy path: resolves Anthropic adapter from anthropic_api_key', () => {
    const provider = getLlmProvider({
      engine: 'pglite',
      anthropic_api_key: 'sk-ant-test',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(AnthropicAdapter);
  });

  test('legacy path: resolves from ANTHROPIC_API_KEY env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const provider = getLlmProvider({ engine: 'pglite' });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(AnthropicAdapter);
  });

  test('new path: resolves Anthropic adapter when llm_provider=anthropic', () => {
    const provider = getLlmProvider({
      engine: 'pglite',
      llm_provider: 'anthropic',
      llm_api_key: 'sk-ant',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(AnthropicAdapter);
  });

  test('new path: resolves OpenAI-compatible adapter when llm_provider=openai', () => {
    const provider = getLlmProvider({
      engine: 'pglite',
      llm_provider: 'openai',
      llm_api_key: 'sk-openai',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  test('new path: resolves OpenAI-compatible adapter when llm_provider=deepseek', () => {
    const provider = getLlmProvider({
      engine: 'pglite',
      llm_provider: 'deepseek',
      llm_api_key: 'sk-deepseek',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  test('new path: falls back to DEEPSEEK_API_KEY env var', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deep-env';
    const provider = getLlmProvider({
      engine: 'pglite',
      llm_provider: 'deepseek',
    });
    expect(provider).not.toBeNull();
  });

  test('new path: falls back to LLM_API_KEY env var', () => {
    process.env.LLM_API_KEY = 'sk-llm-env';
    const provider = getLlmProvider({
      engine: 'pglite',
      llm_provider: 'openai',
    });
    expect(provider).not.toBeNull();
  });
});

describe('llm/factory.ts — getEmbeddingProvider', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.LLM_API_KEY;
  });

  test('returns null when no config and no env vars', () => {
    const provider = getEmbeddingProvider({
      engine: 'pglite',
    });
    expect(provider).toBeNull();
  });

  test('legacy path: resolves OpenAI-compatible adapter from openai_api_key', () => {
    const provider = getEmbeddingProvider({
      engine: 'pglite',
      openai_api_key: 'sk-test',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  test('legacy path: resolves from OPENAI_API_KEY env var', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const provider = getEmbeddingProvider({ engine: 'pglite' });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  test('new path: resolves from embedding_provider + embedding_api_key', () => {
    const provider = getEmbeddingProvider({
      engine: 'pglite',
      embedding_provider: 'deepseek',
      embedding_api_key: 'sk-deepseek',
    });
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  test('new path: falls back to llm_api_key when embedding_api_key is absent', () => {
    const provider = getEmbeddingProvider({
      engine: 'pglite',
      embedding_provider: 'deepseek',
      llm_api_key: 'sk-llm',
    });
    expect(provider).not.toBeNull();
  });

  test('new path: returns null when provider is set but no key is available', () => {
    const provider = getEmbeddingProvider({
      engine: 'pglite',
      embedding_provider: 'deepseek',
    });
    expect(provider).toBeNull();
  });
});

describe('llm/tiers.ts — resolveModel', () => {
  test('returns default model per provider and tier', () => {
    expect(resolveModel('anthropic', 'smart', { engine: 'pglite' })).toBe('claude-sonnet-4-6');
    expect(resolveModel('openai', 'fast', { engine: 'pglite' })).toBe('gpt-4o-mini');
    expect(resolveModel('deepseek', 'embedding', { engine: 'pglite' })).toBe('bge-small-en-v1.5');
  });

  test('user override in config takes precedence', () => {
    const config = { engine: 'pglite' as const, smart_model: 'gpt-4o-custom' };
    expect(resolveModel('openai', 'smart', config)).toBe('gpt-4o-custom');
  });

  test('falls back to openai defaults for unknown provider', () => {
    expect(resolveModel('unknown', 'smart', { engine: 'pglite' })).toBe('gpt-4o');
  });
});

describe('llm/adapters/anthropic.ts — AnthropicAdapter', () => {
  test('supportsFeature returns true for prompt_caching and native_tool_use', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    expect(adapter.supportsFeature('prompt_caching')).toBe(true);
    expect(adapter.supportsFeature('native_tool_use')).toBe(true);
    expect(adapter.supportsFeature('streaming')).toBe(false);
  });

  test('embed throws — not supported', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    expect(() => adapter.embed(['hello'])).toThrow(/does not support embeddings/);
  });
});

describe('llm/adapters/openai-compatible.ts — OpenAICompatibleAdapter', () => {
  test('supportsFeature returns false for all features', () => {
    const adapter = new OpenAICompatibleAdapter({
      apiKey: 'sk-test',
      model: 'text-embedding-3-large',
    });
    expect(adapter.supportsFeature('prompt_caching')).toBe(false);
    expect(adapter.supportsFeature('native_tool_use')).toBe(false);
    expect(adapter.supportsFeature('anything')).toBe(false);
  });
});
