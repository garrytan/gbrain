import { describe, expect, test } from 'bun:test';
import { parseModelsJson, suppliedAdvancedModelTiers } from '../src/main/advanced-model-config.js';

describe('desktop advanced model config', () => {
  test('parses the pretty-printed JSON emitted by pmbrain models --json', () => {
    const report = parseModelsJson(`PMBrain models\n${JSON.stringify({
      tiers: {
        utility: { resolved: 'mimo:mimo-v2.5-pro', source: 'models.default' },
      },
    }, null, 2)}\n`);

    expect(report.tiers?.utility?.resolved).toBe('mimo:mimo-v2.5-pro');
    expect(report.tiers?.utility?.source).toBe('models.default');
  });

  test('only treats explicitly supplied tiers as updates', () => {
    expect(suppliedAdvancedModelTiers({ reasoning: 'deepseek:deepseek-v4-flash' })).toEqual(['reasoning']);
    expect(suppliedAdvancedModelTiers({ utility: '' })).toEqual(['utility']);
    expect(suppliedAdvancedModelTiers({})).toEqual([]);
  });
});
