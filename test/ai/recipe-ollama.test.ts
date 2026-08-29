/**
 * Ollama recipe smoke.
 *
 * Pins the local-first contract:
 *   - no hosted credentials are required
 *   - embeddings use the local /v1 embeddings endpoint
 *   - chat + expansion can use Ollama's OpenAI-compatible /v1/chat/completions
 *   - chat is intentionally not marked as subagent/tool-loop capable
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';

describe('recipe: ollama', () => {
  test('registered with local OpenAI-compatible shape', () => {
    const r = getRecipe('ollama');
    expect(r).toBeDefined();
    expect(r!.id).toBe('ollama');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:11434/v1');
    expect(r!.auth_env?.required ?? []).toEqual([]);
    expect(r!.auth_env?.optional ?? []).toContain('OLLAMA_BASE_URL');
    expect(r!.auth_env?.optional ?? []).toContain('OLLAMA_API_KEY');
  });

  test('declares local embedding, expansion, and chat touchpoints', () => {
    const r = getRecipe('ollama')!;

    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models).toContain('nomic-embed-text');
    expect(r.touchpoints.embedding!.default_dims).toBe(768);
    expect(r.touchpoints.embedding!.cost_per_1m_tokens_usd).toBe(0);

    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.expansion!.models).toContain('qwen2.5-coder:14b');
    expect(r.touchpoints.expansion!.cost_per_1m_tokens_usd).toBe(0);

    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models).toContain('qwen2.5-coder:14b');
    expect(r.touchpoints.chat!.supports_tools).toBe(false);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
    expect(r.touchpoints.chat!.cost_per_1m_input_usd).toBe(0);
    expect(r.touchpoints.chat!.cost_per_1m_output_usd).toBe(0);
  });

  test('model resolver accepts local chat and expansion models', () => {
    const r = getRecipe('ollama')!;

    expect(() => assertTouchpoint(r, 'chat', 'qwen2.5-coder:14b')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'qwen2.5-coder:14b')).not.toThrow();
    expect(() => assertTouchpoint(r, 'chat', 'locally-installed-model')).not.toThrow();
  });

  test('default auth: no env -> "Bearer unauthenticated"', () => {
    const r = getRecipe('ollama')!;
    const auth = defaultResolveAuth(r, {}, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer unauthenticated');
  });

  test('default auth: OLLAMA_API_KEY set -> "Bearer <key>"', () => {
    const r = getRecipe('ollama')!;
    const auth = defaultResolveAuth(r, { OLLAMA_API_KEY: 'sk-ollama-fake' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-ollama-fake');
  });
});
