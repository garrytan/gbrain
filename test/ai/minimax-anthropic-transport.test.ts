import { describe, expect, test } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { MINIMAX_ENDPOINTS } from '../../src/core/ai/recipes/minimax-shared.ts';

describe('MiniMax Anthropic-compatible transport', () => {
  test('the SDK appends only /messages to the internally derived /v1 base', async () => {
    let capturedURL = '';
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedURL = new Request(input, init).url;
      throw new Error('capture-complete');
    };
    const publicBaseURL = MINIMAX_ENDPOINTS.global_en.anthropic_base_url;
    const model = createAnthropic({
      baseURL: `${publicBaseURL}/v1`,
      authToken: 'test-only',
      fetch: transport as unknown as typeof fetch,
    })('MiniMax-M3');

    try {
      await generateText({ model, prompt: 'ping', maxOutputTokens: 1 });
    } catch (error) {
      expect(String(error)).toContain('capture-complete');
    }

    expect(capturedURL).toBe(`${publicBaseURL}/v1/messages`);
  });
});
