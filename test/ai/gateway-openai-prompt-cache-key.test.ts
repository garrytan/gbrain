/**
 * OpenAI `prompt_cache_key` routing hint (takeover of PR #2442's remaining
 * half, originally by @CoachRyanNguyen).
 *
 * OpenAI caches prompt prefixes automatically; a stable `prompt_cache_key`
 * keeps requests that share a prefix on the same inference engine, lifting the
 * automatic-cache hit rate. `chat()` derives one from the system prompt + tool
 * names for native-OpenAI models and passes it via
 * `providerOptions.openai.promptCacheKey` (which @ai-sdk/openai maps to the
 * request's `prompt_cache_key`).
 *
 * Pins:
 *   - key derivation is stable (tool ORDER doesn't matter), sensitive to
 *     system/tool-set changes, and absent without a system prompt
 *   - the chat() wiring only fires for native-openai (anthropic/compat get
 *     nothing), and config `provider_chat_options` overrides the derived key
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  chat,
  configureGateway,
  openAIPromptCacheKey,
  resetGateway,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';

describe('openAIPromptCacheKey — derivation', () => {
  test('same system + same tools → identical stable key (sticky routing)', () => {
    const a = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search', 'put_page'] });
    const b = openAIPromptCacheKey({ system: 'SYS', toolNames: ['put_page', 'search'] });
    expect(a).toBe(b as string); // tool ORDER must not change the key
    expect(a).toMatch(/^gbrain:[0-9a-f]{32}$/);
  });

  test('different system → different key', () => {
    const a = openAIPromptCacheKey({ system: 'SYS A', toolNames: [] });
    const b = openAIPromptCacheKey({ system: 'SYS B', toolNames: [] });
    expect(a).not.toBe(b as string);
  });

  test('different tool set → different key', () => {
    const a = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search'] });
    const b = openAIPromptCacheKey({ system: 'SYS', toolNames: ['search', 'put_page'] });
    expect(a).not.toBe(b as string);
  });

  test('no system prompt → undefined (do not pin one-off requests)', () => {
    expect(openAIPromptCacheKey({ system: undefined, toolNames: ['search'] })).toBeUndefined();
  });
});

describe('chat() wiring — prompt_cache_key per provider', () => {
  beforeEach(() => {
    resetGateway();
    __setGenerateTextTransportForTests(null);
  });

  async function captureProviderOptions(
    config: Parameters<typeof configureGateway>[0],
    opts: Partial<Parameters<typeof chat>[0]> = {},
  ): Promise<Record<string, any> | undefined> {
    let captured: Record<string, any> | undefined;
    __setGenerateTextTransportForTests(async (args: any) => {
      captured = args.providerOptions;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      } as any;
    });
    configureGateway(config);
    await chat({
      model: config.chat_model ?? 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      ...opts,
    });
    return captured;
  }

  test('native-openai with a system prompt → providerOptions.openai.promptCacheKey', async () => {
    const providerOptions = await captureProviderOptions(
      { chat_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'fake' } },
      { system: 'SYS' },
    );
    expect(providerOptions?.openai?.promptCacheKey).toMatch(/^gbrain:[0-9a-f]{32}$/);
  });

  test('native-openai without a system prompt → no providerOptions at all', async () => {
    const providerOptions = await captureProviderOptions(
      { chat_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'fake' } },
    );
    expect(providerOptions).toBeUndefined();
  });

  test('native-anthropic never gets an openai promptCacheKey', async () => {
    const providerOptions = await captureProviderOptions(
      { chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'fake' } },
      { system: 'SYS' },
    );
    expect(providerOptions?.openai).toBeUndefined();
  });

  test('openai-compatible (deepseek) never gets promptCacheKey (provider ignores providerOptions.openai)', async () => {
    const providerOptions = await captureProviderOptions(
      { chat_model: 'deepseek:deepseek-chat', env: { DEEPSEEK_API_KEY: 'fake' } },
      { system: 'SYS' },
    );
    expect(providerOptions?.openai).toBeUndefined();
  });

  test('config provider_chat_options overrides the derived key', async () => {
    const providerOptions = await captureProviderOptions(
      {
        chat_model: 'openai:gpt-4o-mini',
        env: { OPENAI_API_KEY: 'fake' },
        provider_chat_options: { openai: { promptCacheKey: 'session-42' } },
      },
      { system: 'SYS' },
    );
    expect(providerOptions?.openai?.promptCacheKey).toBe('session-42');
  });
});
