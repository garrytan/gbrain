/**
 * Anthropic's `stop_reason: "refusal"` maps to the gateway's `refusal` stop reason (GST-3251).
 *
 * Protects: chat() over the real native Anthropic lane (@ai-sdk/anthropic against a local stub of the Messages API, no
 * key) reports a refused request as `refusal`. The SDK turns Anthropic's refusal into finishReason 'content-filter' and
 * keeps the provider value only in rawFinishReason, so a mapper that reads finishReason and providerMetadata reported
 * `content_filter`, and conversation fact extraction logged every refused window as content_filter.
 * Fails when: the refusal reads as content_filter, or an ordinary end_turn stops reading as end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

let server: ReturnType<typeof Bun.serve>;
let stopReason = 'refusal';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      return Response.json({
        id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
        content: stopReason === 'refusal' ? [] : [{ type: 'text', text: 'ok' }],
        stop_reason: stopReason,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
  resetGateway();
});

beforeEach(() => {
  resetGateway();
  configureGateway({
    chat_model: 'anthropic:claude-haiku-5-5',
    env: { ANTHROPIC_API_KEY: 'stub-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/v1` },
  });
});

describe('Anthropic stop_reason on the native lane', () => {
  test('refusal is reported as refusal, not content_filter', async () => {
    stopReason = 'refusal';
    const out = await chat({ model: 'anthropic:claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
    expect(out.stopReason).toBe('refusal');
  });

  test('end_turn is still end', async () => {
    stopReason = 'end_turn';
    const out = await chat({ model: 'anthropic:claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
    expect(out.stopReason).toBe('end');
  });
});
