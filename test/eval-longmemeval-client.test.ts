/**
 * #2099 — eval longmemeval's LLM clients must not feed provider-prefixed
 * model ids ('anthropic:claude-sonnet-4-6', the shape resolveModel returns)
 * into the raw Anthropic SDK: the API 404s on them, so every out-of-the-box
 * run died at the first answer-generation call and the trajectory extractor
 * failed open.
 *
 * Fix under test: clients are built via buildLLMClient — gateway-backed when
 * the gateway can serve the model's provider (any recipe, not just
 * Anthropic), raw SDK with a prefix-stripped id otherwise (toRawSdkParams).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { buildLLMClient, toRawSdkParams } from '../src/commands/eval-longmemeval.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

afterAll(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('toRawSdkParams (#2099)', () => {
  test('strips the provider prefix off params.model at the raw-SDK boundary', () => {
    const out = toRawSdkParams({
      model: 'anthropic:claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.max_tokens).toBe(512);
  });

  test('bare model ids pass through unchanged', () => {
    const out = toRawSdkParams({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [],
    });
    expect(out.model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('buildLLMClient (#2099)', () => {
  test('routes through the gateway (not the raw SDK) when the gateway can serve the model', async () => {
    const seen: string[] = [];
    // probeChatModel's Anthropic branch reads process.env (hasAnthropicKey),
    // not the gateway cfg.env — set both so the test is hermetic on CI.
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
      configureGateway({
        chat_model: 'anthropic:claude-sonnet-4-6',
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      } as never);
      __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
        seen.push(opts.model ?? '<none>');
        return {
          text: 'stubbed answer',
          blocks: [],
          stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: opts.model ?? '',
          providerId: 'anthropic',
        } as ChatResult;
      });

      const client = await buildLLMClient('anthropic:claude-sonnet-4-6', false);
      const msg = await client.create({
        model: 'anthropic:claude-sonnet-4-6',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'q' }],
      });

      // Pre-#2099 this path constructed `new Anthropic()` and sent the
      // prefixed id verbatim → HTTP 404. Now the gateway serves it.
      expect(seen).toEqual(['anthropic:claude-sonnet-4-6']);
      const first = msg.content[0];
      expect(first && first.type === 'text' ? first.text : '').toBe('stubbed answer');
    });
  });
});
