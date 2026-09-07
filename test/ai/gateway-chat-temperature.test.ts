/**
 * Phase D (eng review gap 8) — `ChatOpts.temperature` reaches the AI SDK
 * call, and the provider-reported model snapshot surfaces as
 * `ChatResult.responseModel`.
 *
 * The official LongMemEval judge pins temperature 0; before this field the
 * gateway had no way to send one, so a judge run would have silently used
 * the provider default. Two seams: `__setGenerateTextTransportForTests`
 * keeps provider resolution live and captures the exact generateText args;
 * `__setChatTransportForTests` shows the resolved ChatOpts carry the field
 * verbatim. Hermetic — no network, a fake key satisfies instantiation.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  chat,
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
  __setGenerateTextTransportForTests,
  type ChatOpts,
} from '../../src/core/ai/gateway.ts';

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
  __setChatTransportForTests(null);
});

function sdkResult(extra: Record<string, unknown> = {}): any {
  return {
    content: [{ type: 'text', text: 'yes' }],
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 1 },
    ...extra,
  };
}

describe('ChatOpts.temperature → generateText', () => {
  test('temperature 0 is passed verbatim (0 is not dropped as falsy) alongside maxOutputTokens', async () => {
    configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => { captured = args; return sdkResult({ response: { modelId: 'gpt-4o-2024-08-06' } }); });
    const res = await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'Is it correct? yes or no' }], maxTokens: 10, temperature: 0 });
    expect(captured).toBeDefined();
    expect(captured.temperature).toBe(0);
    expect(captured.maxOutputTokens).toBe(10);
    // Requested id stays on `model`; the API snapshot rides `responseModel`.
    expect(res.model).toBe('openai:gpt-4o');
    expect(res.responseModel).toBe('gpt-4o-2024-08-06');
    expect(res.text).toBe('yes');
  });

  test('a non-zero temperature is threaded too; omitted → the key is absent (provider default)', async () => {
    configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
    let captured: any;
    __setGenerateTextTransportForTests(async (args: any) => { captured = args; return sdkResult(); });
    await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'q' }], temperature: 0.7 });
    expect(captured.temperature).toBe(0.7);
    await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'q' }] });
    expect('temperature' in captured).toBe(false);
  });

  test('no response.modelId from the SDK → responseModel is absent, model still the requested id', async () => {
    configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
    __setGenerateTextTransportForTests(async () => sdkResult());
    const res = await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'q' }], temperature: 0 });
    expect(res.responseModel).toBeUndefined();
    expect(res.model).toBe('openai:gpt-4o');
  });

  test('the test chat transport receives the resolved ChatOpts with temperature intact', async () => {
    configureGateway({ env: {} });
    let seen: ChatOpts | undefined;
    __setChatTransportForTests(async (opts) => {
      seen = opts;
      return { text: 'no', blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model ?? '', providerId: 'openai' };
    });
    await chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'q' }], maxTokens: 10, temperature: 0 });
    expect(seen?.temperature).toBe(0);
    expect(seen?.maxTokens).toBe(10);
  });
});
