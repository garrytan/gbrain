import { describe, expect, test } from 'bun:test';
import { discoverOpenAICodexModels } from '../src/core/ai/openai-codex/model-discovery.ts';

describe('openai-codex model discovery', () => {
  test('fetches models with bearer token, account header, client version, and filters supported_in_api=true', async () => {
    const calls: { url: string; authorization?: string; accountId?: string; userAgent?: string }[] = [];
    const cache = await discoverOpenAICodexModels({
      endpoint: 'https://codex.example.test/models?client_version=0.133.0',
      accessToken: 'access-token-secret-1234567890',
      accountId: 'acct_123',
      clientVersion: '0.133.0',
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        calls.push({
          url: String(url),
          authorization: String(headers.Authorization),
          accountId: String(headers['ChatGPT-Account-Id']),
          userAgent: String(headers['User-Agent']),
        });
        return new Response(JSON.stringify({
          models: [
            { slug: 'gpt-5.5', display_name: 'GPT 5.5', supported_in_api: true, context_window: 400000 },
            { slug: 'codex-web-only', supported_in_api: false },
          ],
        }), { status: 200, headers: { ETag: 'W/"abc"' } });
      },
    });

    expect(calls).toEqual([{
      url: 'https://codex.example.test/models?client_version=0.133.0',
      authorization: 'Bearer access-token-secret-1234567890',
      accountId: 'acct_123',
      userAgent: 'codex-cli/0.133.0',
    }]);
    expect(cache.fetched_at).toBe('2026-05-24T12:00:00.000Z');
    expect(cache.client_version).toBe('0.133.0');
    expect(cache.etag).toBe('W/"abc"');
    expect(cache.raw_count).toBe(2);
    expect(cache.supported_count).toBe(1);
    expect(cache.models.map(m => m.slug)).toEqual(['gpt-5.5']);
  });

  test('accepts array response shape as fallback compatibility', async () => {
    const cache = await discoverOpenAICodexModels({
      endpoint: 'https://codex.example.test/models',
      accessToken: 'tok',
      now: () => new Date('2026-05-24T12:00:00.000Z'),
      fetch: async () => new Response(JSON.stringify([
        { id: 'gpt-5.5-mini', name: 'GPT 5.5 mini', supported_in_api: true },
      ]), { status: 200 }),
    });
    expect(cache.models).toEqual([{ slug: 'gpt-5.5-mini', display_name: 'GPT 5.5 mini', supported_in_api: true }]);
  });

  test('redacts tokens from transport failures', async () => {
    await expect(discoverOpenAICodexModels({
      endpoint: 'https://codex.example.test/models',
      accessToken: 'access-token-secret-1234567890',
      fetch: async () => new Response('bad access-token-secret-1234567890 sk-proj-abcdefghijklmnop', { status: 401 }),
    })).rejects.toThrow('[REDACTED]');
  });

  test('rejects unsupported response schemas', async () => {
    await expect(discoverOpenAICodexModels({
      endpoint: 'https://codex.example.test/models',
      accessToken: 'tok',
      fetch: async () => new Response(JSON.stringify({ models: [{ slug: 'missing-flag' }] }), { status: 200 }),
    })).rejects.toThrow('supported_in_api');
  });
});
