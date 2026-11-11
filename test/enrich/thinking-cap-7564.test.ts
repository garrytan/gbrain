/**
 * #7564 / #8699 — enrich's write-up call must leave a thinking-by-default
 * model room to reason. A flat 2048-token cap is spent on reasoning by
 * Claude 5 (and other thinking recipes), so the write-up came back cut off
 * or, behind claude-cli, failed outright. Non-thinking models keep 2048.
 * Hermetic: the generateText seam captures the SDK args; fake keys only.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../../src/core/ai/gateway.ts';
import { defaultSynthesize } from '../../src/commands/enrich.ts';

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
});

async function capturedCap(model: string): Promise<number> {
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-fake', OPENAI_API_KEY: 'sk-fake' } });
  let captured: any;
  __setGenerateTextTransportForTests(async (args: any) => {
    captured = args;
    return { content: [{ type: 'text', text: 'write-up' }], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1 } } as any;
  });
  const text = await defaultSynthesize({ system: 's', user: 'u', model });
  expect(text).toBe('write-up');
  return captured.maxOutputTokens;
}

describe('enrich write-up output cap (#7564, #8699)', () => {
  test('a Claude 5 model gets the thinking headroom', async () => {
    expect(await capturedCap('anthropic:claude-sonnet-5-5')).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
  });

  test('a non-thinking model keeps the 2048 write-up cap', async () => {
    expect(await capturedCap('openai:gpt-4o')).toBe(2048);
  });
});
