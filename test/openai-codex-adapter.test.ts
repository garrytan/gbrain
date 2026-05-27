import { describe, expect, test } from 'bun:test';
import {
  openAICodexChat,
  openAICodexJson,
} from '../src/core/ai/openai-codex/adapter.ts';
import { InMemoryTokenStore } from '../src/core/ai/openai-codex/token-store.ts';

function tokenStore(): InMemoryTokenStore {
  const store = new InMemoryTokenStore();
  void store.set({
    access_token: 'access-token-test',
    refresh_token: 'refresh-token-test',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return store;
}

describe('openai-codex native adapter', () => {
  test('posts ChatGPT OAuth bearer token to backend /responses and normalizes text response', async () => {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), init, body });
      return new Response(JSON.stringify({
        id: 'resp_123',
        model: 'gpt-5.5',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'adapter-ok' }] },
        ],
        usage: { input_tokens: 11, output_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexChat({
      model: 'gpt-5.5',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 32,
      tokenStore: tokenStore(),
      fetchImpl,
    });

    expect(result.text).toBe('adapter-ok');
    expect(result.usage.input_tokens).toBe(11);
    expect(result.usage.output_tokens).toBe(3);
    expect(result.model).toBe('openai-codex:gpt-5.5');
    expect(result.providerId).toBe('openai-codex');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-test');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((calls[0].init.headers as Record<string, string>)['OpenAI-Beta']).toBe('responses_http');
    expect(calls[0].body.model).toBe('gpt-5.5');
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.instructions).toBe('Be terse.');
    expect(calls[0].body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
    ]);
  });

  test('requests strict JSON schema output and parses returned JSON text', async () => {
    const calls: Array<any> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return new Response(JSON.stringify({
        output_text: '{"queries":["alpha","beta"]}',
        usage: { input_tokens: 7, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexJson<{ queries: string[] }>({
      model: 'gpt-5.5',
      prompt: 'Return query rewrites.',
      schemaName: 'gbrain_expansion',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
      },
      tokenStore: tokenStore(),
      fetchImpl,
    });

    expect(result.object).toEqual({ queries: ['alpha', 'beta'] });
    expect(result.usage.input_tokens).toBe(7);
    expect(result.usage.output_tokens).toBe(6);
    expect(calls[0].text.format).toEqual({
      type: 'json_schema',
      name: 'gbrain_expansion',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
      },
      strict: true,
    });
  });
});
