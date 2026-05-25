/**
 * Ollama recipe and native-chat compatibility shim.
 *
 * Ollama embeddings are OpenAI-compatible, but chat/expansion for thinking
 * models need the native /api/chat `think:false` knob. These tests pin the
 * recipe surface and the gateway fetch wrapper without requiring a live
 * Ollama daemon.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyOpenAICompatConfig,
  configureGateway,
  expand,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

const originalFetch = globalThis.fetch;

describe('recipe: ollama', () => {
  beforeEach(() => resetGateway());
  afterEach(() => {
    resetGateway();
    globalThis.fetch = originalFetch;
  });

  test('declares local embedding, expansion, and chat touchpoints', () => {
    const r = getRecipe('ollama');
    expect(r).toBeDefined();
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:11434/v1');
    expect(r!.touchpoints.embedding?.models).toContain('nomic-embed-text');
    expect(r!.touchpoints.expansion?.models).toContain('qwen3.6:27b');
    expect(r!.touchpoints.chat?.models).toContain('qwen3.6:27b');
    expect(r!.touchpoints.chat?.supports_tools).toBe(false);
    expect(r!.touchpoints.chat?.supports_subagent_loop).toBe(false);
  });

  test('resolver accepts Ollama chat and expansion model ids', () => {
    const r = getRecipe('ollama')!;
    expect(() => assertTouchpoint(r, 'chat', 'qwen3.6:27b')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'qwen3.6:27b')).not.toThrow();
    // OpenAI-compatible recipes accept arbitrary installed model ids.
    expect(() => assertTouchpoint(r, 'chat', 'local-model-not-in-recipe')).not.toThrow();
  });

  test('chat and expansion are available without an API key', () => {
    configureGateway({
      chat_model: 'ollama:qwen3.6:27b',
      expansion_model: 'ollama:qwen3.6:27b',
      env: {},
    });
    expect(isAvailable('chat')).toBe(true);
    expect(isAvailable('expansion')).toBe(true);
  });

  test('OpenAI-compatible base URL is normalized when OLLAMA_BASE_URL omits /v1', () => {
    const r = getRecipe('ollama')!;
    const cfg = applyOpenAICompatConfig(r, {
      env: {},
      base_urls: { ollama: 'http://ollama.example.test:11434' },
    } as any);
    expect(cfg.baseURL).toBe('http://ollama.example.test:11434/v1');
    expect(typeof cfg.fetch).toBe('function');
  });

  test('chat completions are translated to native /api/chat with think:false', async () => {
    const r = getRecipe('ollama')!;
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const body = init?.body && typeof init.body === 'string'
        ? JSON.parse(init.body)
        : null;
      calls.push({ url, body });
      return new Response(JSON.stringify({
        model: body?.model,
        created_at: '2026-05-25T12:00:00Z',
        message: { role: 'assistant', content: '{"queries":["local search"]}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 8,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const cfg = applyOpenAICompatConfig(r, {
      env: {},
      base_urls: { ollama: 'http://127.0.0.1:11434/v1' },
    } as any);
    const resp = await cfg.fetch!(
      'http://127.0.0.1:11434/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6:27b',
          messages: [{ role: 'user', content: 'expand local search' }],
          max_tokens: 64,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0].body).toMatchObject({
      model: 'qwen3.6:27b',
      stream: false,
      think: false,
      format: 'json',
      options: { num_predict: 64, temperature: 0.1 },
    });
    expect(calls[0].body.messages).toEqual([
      { role: 'user', content: 'expand local search' },
    ]);

    const json = await resp.json();
    expect(json.object).toBe('chat.completion');
    expect(json.model).toBe('qwen3.6:27b');
    expect(json.choices[0].message.content).toBe('{"queries":["local search"]}');
    expect(json.choices[0].finish_reason).toBe('stop');
    expect(json.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });
  });

  test('gateway expand uses structured native Ollama format and parses queries', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const body = init?.body && typeof init.body === 'string'
        ? JSON.parse(init.body)
        : null;
      calls.push({ url, body });
      return new Response(JSON.stringify({
        model: body?.model,
        created_at: '2026-05-25T12:00:00Z',
        message: {
          role: 'assistant',
          content: '{"queries":["local semantic search","private embeddings"]}',
        },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 20,
        eval_count: 10,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    configureGateway({
      expansion_model: 'ollama:qwen3.6:27b',
      chat_model: 'ollama:qwen3.6:27b',
      env: {},
    });

    const expanded = await expand('local search');
    expect(expanded).toEqual([
      'local search',
      'local semantic search',
      'private embeddings',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    expect(calls[0].body.think).toBe(false);
    expect(calls[0].body.format).toEqual(expect.objectContaining({
      type: 'object',
    }));
  });

  test('non-chat OpenAI-compatible paths pass through unchanged', async () => {
    const r = getRecipe('ollama')!;
    let seenUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      seenUrl = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const cfg = applyOpenAICompatConfig(r, { env: {} } as any);
    await cfg.fetch!('http://localhost:11434/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', input: 'hello' }),
    });
    expect(seenUrl).toBe('http://localhost:11434/v1/embeddings');
  });
});
