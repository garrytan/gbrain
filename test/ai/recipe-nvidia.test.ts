import { describe, expect, test } from 'bun:test';
import {
  dimsProviderOptions,
  nvidiaEmbeddingDimOptions,
  supportsNvidiaEmbeddingDimension,
} from '../../src/core/ai/dims.ts';
import { getRecipe, RECIPES } from '../../src/core/ai/recipes/index.ts';
import { nvidia } from '../../src/core/ai/recipes/nvidia.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: nvidia', () => {
  test('registered with OpenAI-compatible NIM endpoint', () => {
    expect(RECIPES.has('nvidia')).toBe(true);
    expect(getRecipe('nvidia')).toBe(nvidia);
    expect(nvidia.id).toBe('nvidia');
    expect(nvidia.tier).toBe('openai-compat');
    expect(nvidia.implementation).toBe('openai-compatible');
    expect(nvidia.base_url_default).toBe('https://integrate.api.nvidia.com/v1');
  });

  test('auth flows through defaultResolveAuth — NVIDIA_API_KEY as bearer token', () => {
    // IRON RULE: only Azure overrides resolveAuth. NVIDIA is plain
    // Authorization Bearer, so the recipe must NOT declare its own resolver;
    // defaultResolveAuth derives the header from auth_env.required.
    expect(nvidia.resolveAuth).toBeUndefined();
    expect(nvidia.auth_env?.required).toEqual(['NVIDIA_API_KEY']);
    expect(defaultResolveAuth(nvidia, { NVIDIA_API_KEY: 'fake-nvidia' }, 'embedding')).toEqual({
      headerName: 'Authorization',
      token: 'Bearer fake-nvidia',
    });
    expect(() => defaultResolveAuth(nvidia, {}, 'chat')).toThrow(AIConfigError);
  });

  test('chat touchpoint declares Nemotron 3 Super without subagent-loop claims', () => {
    const chat = nvidia.touchpoints.chat!;
    expect(chat.models).toContain('nvidia/nemotron-3-super-120b-a12b');
    expect(chat.supports_tools).toBe(false);
    expect(chat.supports_subagent_loop).toBe(false);
    expect(chat.max_context_tokens).toBe(128000);
  });

  test('embedding touchpoint declares tested NVIDIA models and natural dimensions', () => {
    const e = nvidia.touchpoints.embedding!;
    expect(e.models).toContain('nvidia/nv-embedqa-e5-v5');
    expect(e.models).toContain('nvidia/llama-nemotron-embed-1b-v2');
    expect(e.models).toContain('nvidia/nv-embed-v1');
    expect(e.models).toContain('nvidia/nv-embedcode-7b-v1');
    expect(e.default_dims).toBe(1024);
    expect(e.dims_options).toEqual([1024, 2048, 4096]);
    expect(e.max_batch_tokens).toBeGreaterThan(0);
  });

  test('aliases allow short model names while preserving NVIDIA catalog ids', () => {
    expect(nvidia.aliases?.['nv-embedqa-e5-v5']).toBe('nvidia/nv-embedqa-e5-v5');
    expect(nvidia.aliases?.['llama-nemotron-embed-1b-v2']).toBe('nvidia/llama-nemotron-embed-1b-v2');
    expect(nvidia.aliases?.['nemotron-3-super']).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(nvidia.aliases?.['nemotron-3-super-120b-a12b']).toBe('nvidia/nemotron-3-super-120b-a12b');
  });

  test('dimsProviderOptions emits passage input_type by default for NVIDIA embeddings', () => {
    expect(dimsProviderOptions('openai-compatible', 'nvidia/nv-embedqa-e5-v5', 1024)).toEqual({
      openaiCompatible: { input_type: 'passage' },
    });
  });

  test('dimsProviderOptions maps query/document inputType for NVIDIA embeddings', () => {
    expect(dimsProviderOptions('openai-compatible', 'nvidia/nv-embedqa-e5-v5', 1024, 'query')).toEqual({
      openaiCompatible: { input_type: 'query' },
    });
    expect(dimsProviderOptions('openai-compatible', 'nvidia/nv-embedqa-e5-v5', 1024, 'document')).toEqual({
      openaiCompatible: { input_type: 'passage' },
    });
  });

  test('llama-nemotron supports a 1280d Matryoshka dimension override', () => {
    expect(nvidiaEmbeddingDimOptions('nvidia/llama-nemotron-embed-1b-v2')).toContain(1280);
    expect(supportsNvidiaEmbeddingDimension('nvidia/llama-nemotron-embed-1b-v2', 1280)).toBe(true);
    expect(dimsProviderOptions('openai-compatible', 'nvidia/llama-nemotron-embed-1b-v2', 1280, 'query')).toEqual({
      openaiCompatible: { input_type: 'query', dimensions: 1280 },
    });
  });

  test('fixed-dim NVIDIA models omit dimensions because they reject overrides', () => {
    const opts = dimsProviderOptions('openai-compatible', 'nvidia/nv-embedqa-e5-v5', 1024, 'query');
    expect(opts).toEqual({ openaiCompatible: { input_type: 'query' } });
    expect(JSON.stringify(opts)).not.toContain('dimensions');
  });
});
