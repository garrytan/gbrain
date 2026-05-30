import { afterEach, describe, expect, test } from 'bun:test';
import {
  chat,
  configureGateway,
  expand,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import {
  __setOpenAICodexFetchForTests,
  __setOpenAICodexTokenStoreForTests,
} from '../src/core/ai/openai-codex/adapter.ts';
import { InMemoryTokenStore } from '../src/core/ai/openai-codex/token-store.ts';

async function installCodexTestAuth(fetchImpl: typeof fetch): Promise<void> {
  const store = new InMemoryTokenStore();
  await store.set({
    access_token: 'gateway-access-token',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  __setOpenAICodexTokenStoreForTests(store);
  __setOpenAICodexFetchForTests(fetchImpl);
}

describe('gateway openai-codex adapter integration', () => {
  afterEach(() => {
    __setOpenAICodexTokenStoreForTests(null);
    __setOpenAICodexFetchForTests(null);
    resetGateway();
  });

  test('gateway.chat routes openai-codex models through native ChatGPT OAuth adapter', async () => {
    const calls: any[] = [];
    await installCodexTestAuth((async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        output_text: 'gateway-codex-ok',
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      env: {},
    });

    const result = await chat({ messages: [{ role: 'user', content: 'ping' }] });

    expect(result.text).toBe('gateway-codex-ok');
    expect(result.model).toBe('openai-codex:gpt-5.5');
    expect(result.providerId).toBe('openai-codex');
    expect(calls[0].model).toBe('gpt-5.5');
  });

  test('gateway.expand uses openai-codex JSON adapter when expansion_model is openai-codex', async () => {
    const calls: any[] = [];
    await installCodexTestAuth((async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        output_text: '{"queries":["rewrite one","rewrite two"]}',
        usage: { input_tokens: 5, output_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      expansion_model: 'openai-codex:gpt-5.5',
      env: {},
    });

    const result = await expand('source query');

    expect(result).toEqual(['source query', 'rewrite one', 'rewrite two']);
    expect(calls[0].model).toBe('gpt-5.5');
    expect(calls[0].text.format.type).toBe('json_schema');
  });
});
