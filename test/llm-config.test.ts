import { afterEach, describe, expect, test } from 'bun:test';
import { getLLMRuntimeConfig } from '../src/core/llm/factory.ts';

describe('LLM runtime config defaults', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  test('defaults to OpenAI when provider is not configured', () => {
    delete process.env.GBRAIN_LLM_PROVIDER;
    delete process.env.GBRAIN_LLM_MODEL;
    delete process.env.GBRAIN_LLM_VERDICT_MODEL;

    expect(getLLMRuntimeConfig(null)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      verdictModel: 'gpt-4o-mini',
      openaiMaxInflight: 8,
    });
  });

  test('uses Anthropic only when explicitly configured', () => {
    process.env.GBRAIN_LLM_PROVIDER = 'anthropic';
    delete process.env.GBRAIN_LLM_MODEL;
    delete process.env.GBRAIN_LLM_VERDICT_MODEL;

    expect(getLLMRuntimeConfig(null)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      verdictModel: 'claude-haiku-4-5-20251001',
    });
  });
});
