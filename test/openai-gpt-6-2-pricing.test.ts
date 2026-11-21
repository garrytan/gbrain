import { describe, expect, test } from 'bun:test';
import { parseOpenAIChatId, rankOpenAIChatModels } from '../src/core/ai/openai-latest.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('gpt-6.2 astra and sol', () => {
  test('astra ids parse', () => {
    expect(parseOpenAIChatId('gpt-6.2-astra')?.suffix).toBe('astra');
    expect(parseOpenAIChatId('gpt-6-astra')?.suffix).toBe('astra');
  });
  test('both ids carry canonical pricing', () => {
    expect(canonicalLookup('openai:gpt-6.2-astra')).toMatchObject({ input: 8, output: 40 });
    expect(canonicalLookup('openai:gpt-6.2-sol')).toMatchObject({ input: 2, output: 10 });
  });
  test('discovery defaults stay on gpt-5.6', () => {
    const r = rankOpenAIChatModels(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(r.tiers?.deep).toBe('openai:gpt-5.6-sol');
  });
});
