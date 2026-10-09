/**
 * The facts extraction default (R2 of the 10x plan, facts-absorb quality gate
 * 2026-10-08): with nothing set, an install whose reasoning tier resolves
 * through Anthropic extracts with claude-haiku-5-5; every explicit setting
 * still wins, and an install that resolves through OpenAI keeps the tier
 * default.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_EXTRACTION_MEASURED_DEFAULTS, getFactsExtractionModel, resolveFactsExtractionModel } from '../src/core/facts/extract.ts';
import { resolveTierDefault } from '../src/core/model-config.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';
import { withEnv } from './helpers/with-env.ts';

const engine = (cfg: Record<string, string> = {}) => ({ getConfig: async (k: string) => cfg[k] ?? null }) as never;
const HOME = { GBRAIN_HOME: '/nonexistent-gbrain-home-for-facts-default-tests', GBRAIN_MODEL: undefined };

describe('facts extraction default model', () => {
  test('Anthropic-keyed install with nothing set extracts with claude-haiku-5-5', async () => {
    await withEnv({ ...HOME, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined }, async () => {
      expect(await resolveFactsExtractionModel(engine())).toEqual({ model: 'anthropic:claude-haiku-5-5', source: 'measured_default' });
      expect(await getFactsExtractionModel(engine())).toBe('anthropic:claude-haiku-5-5');
      expect(await getFactsExtractionModel()).toBe('anthropic:claude-haiku-5-5');
    });
  });

  test('both keys: the Anthropic tier default wins the key walk, so Haiku 5.5 applies', async () => {
    await withEnv({ ...HOME, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' }, async () => {
      expect(await getFactsExtractionModel(engine())).toBe('anthropic:claude-haiku-5-5');
    });
  });

  test('OpenAI-only install keeps the reasoning tier default', async () => {
    await withEnv({ ...HOME, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-test' }, async () => {
      const r = await resolveFactsExtractionModel(engine());
      expect(r.source).toBe('tier_default');
      expect(r.model).toBe(resolveTierDefault('reasoning'));
      expect(r.model.startsWith('openai:')).toBe(true);
    });
  });

  test('explicit settings win over the measured default', async () => {
    await withEnv({ ...HOME, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined }, async () => {
      expect(await resolveFactsExtractionModel(engine({ 'facts.extraction_model': 'anthropic:claude-sonnet-4-6' })))
        .toEqual({ model: 'anthropic:claude-sonnet-4-6', source: 'config_key' });
      expect(await getFactsExtractionModel(engine({ 'models.tier.reasoning': 'anthropic:claude-sonnet-5-5' }))).toBe('anthropic:claude-sonnet-5-5');
      expect(await getFactsExtractionModel(engine({ 'models.default': 'openai:gpt-6-luna' }))).toBe('openai:gpt-6-luna');
    });
    await withEnv({ ...HOME, ANTHROPIC_API_KEY: 'sk-ant-test', GBRAIN_MODEL: 'anthropic:claude-opus-5-5' }, async () => {
      expect(await getFactsExtractionModel(engine())).toBe('anthropic:claude-opus-5-5');
    });
  });

  test('the default is priced, so extraction budget caps keep working', () => {
    for (const model of Object.values(FACTS_EXTRACTION_MEASURED_DEFAULTS)) expect(canonicalLookup(model)).toMatchObject({ input: 0.1, output: 0.5 });
  });
});
