import { afterEach, describe, expect, test } from 'bun:test';

import {
  chat,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  type ChatMessage,
} from '../../src/core/ai/gateway.ts';
import type { CodexCredentialSnapshot } from '../../src/core/ai/codex-auth.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';

const TOKEN = 'gateway-codex-token-must-not-leak';

function validCodexAuth(): CodexCredentialSnapshot {
  return {
    ok: true,
    source: 'env',
    accessToken: TOKEN,
    tokenType: 'bearer',
    expiresAtMs: Date.UTC(2030, 0, 1, 0, 0, 0),
    expiresAt: '2030-01-01T00:00:00.000Z',
    accountId: 'acct_gateway_fixture',
  };
}

function sse(text = 'OK'): Response {
  return new Response([
    `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_gateway"}}\n\n`,
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":${JSON.stringify(text)}}\n\n`,
    `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gateway","usage":{"input_tokens":4,"output_tokens":1}}}\n\n`,
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  resetGateway();
});

describe('openai-codex gateway routing', () => {
  test('streams Codex Responses through chat() without public OpenAI fallback', async () => {
    let seenUrl = '';
    let seenBody: any = null;
    let seenHeaders: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      seenHeaders = new Headers(init?.headers);
      if (!seenUrl.startsWith('https://chatgpt.com/backend-api/codex/responses')) {
        throw new Error(`unexpected fetch URL: ${seenUrl}`);
      }
      return sse('OK');
    }) as unknown as typeof fetch;

    try {
      configureGateway({
        chat_model: 'openai-codex:gpt-5.5',
        env: { OPENAI_API_KEY: 'sk-public-openai-must-not-be-used' },
        codex_auth: validCodexAuth(),
      });

      const result = await chat({
        messages: [{ role: 'user', content: 'Say OK' }],
        maxTokens: 8,
      });

      expect(result.text).toBe('OK');
      expect(result.model).toBe('openai-codex:gpt-5.5');
      expect(result.providerId).toBe('openai-codex');
      expect(result.usage).toEqual({
        input_tokens: 4,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      });
      expect(seenUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(seenBody.stream).toBe(true);
      expect(seenBody.store).toBe(false);
      expect(seenBody.model).toBe('gpt-5.5');
      expect(seenHeaders!.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(seenHeaders!.get('chatgpt-account-id')).toBe('acct_gateway_fixture');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects Codex tool definitions before budget reserve or fetch', async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalled = true;
      return sse('SHOULD_NOT_FETCH');
    }) as unknown as typeof fetch;

    try {
      configureGateway({
        chat_model: 'openai-codex:gpt-5.5',
        env: {},
        codex_auth: validCodexAuth(),
      });
      const tracker = new BudgetTracker({
        label: 'codex-tool-rejection-test',
        maxCostUsd: 0.01,
        auditPath: '/tmp/gbrain-codex-tool-rejection-budget.jsonl',
      });

      await expect(withBudgetTracker(tracker, () => chat({
        messages: [{ role: 'user', content: 'Use a tool' }],
        tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
      }))).rejects.toThrow(/text-only/);
      expect(fetchCalled).toBe(false);
      expect(tracker.snapshot().callsRecorded).toBe(0);
      expect(tracker.totalSpent).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects Codex tool-result history before fetch', async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetchCalled = true;
      return sse('SHOULD_NOT_FETCH');
    }) as unknown as typeof fetch;

    try {
      configureGateway({
        chat_model: 'openai-codex:gpt-5.5',
        env: {},
        codex_auth: validCodexAuth(),
      });
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Question' },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'search',
            output: { ok: true },
          }],
        },
      ];

      await expect(chat({ messages })).rejects.toThrow(/tool.*not supported|text-only/);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects public OpenAI API base URL override for openai-codex', async () => {
    for (const baseURL of ['https://api.openai.com/v1', 'https://api.openai.com./v1']) {
      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return sse('SHOULD_NOT_FETCH');
      }) as unknown as typeof fetch;

      try {
        configureGateway({
          chat_model: 'openai-codex:gpt-5.5',
          base_urls: { 'openai-codex': baseURL },
          env: { OPENAI_API_KEY: 'sk-pub...must-not-route' },
          codex_auth: validCodexAuth(),
        });

        await expect(chat({ messages: [{ role: 'user', content: 'Say OK' }] }))
          .rejects.toThrow(/not public OpenAI API base URL/);
        expect(fetchCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        resetGateway();
      }
    }
  });

  test('reports missing Codex auth without using OPENAI_API_KEY', async () => {
    configureGateway({
      chat_model: 'openai-codex:gpt-5.5',
      env: { OPENAI_API_KEY: 'sk-public-openai-must-not-count' },
      codex_auth: { ok: false, source: 'env', code: 'unavailable', message: 'OPENAI_CODEX_ACCESS_TOKEN missing.' },
    });

    let caught: unknown;
    try {
      await chat({ messages: [{ role: 'user', content: 'Say OK' }] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AIConfigError);
    expect((caught as Error).message).toContain('Codex auth unavailable');
    expect((caught as Error).message).not.toContain('sk-public-openai-must-not-count');
  });
});
