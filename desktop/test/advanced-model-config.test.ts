import { describe, expect, test } from 'bun:test';
import {
  ADVANCED_MODEL_PHASES,
  ADVANCED_PHASE_CONFIG_KEYS,
  ADVANCED_PHASE_TIERS,
  parseModelsJson,
  suppliedAdvancedModelPhases,
  suppliedAdvancedModelTiers,
} from '../src/main/advanced-model-config.js';

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

  test('only treats explicitly supplied Dream phase overrides as updates', () => {
    expect(suppliedAdvancedModelPhases({ propose_takes: 'mimo:mimo-v2.5-pro' })).toEqual(['propose_takes']);
    expect(suppliedAdvancedModelPhases({ grade_takes: '' })).toEqual(['grade_takes']);
    expect(suppliedAdvancedModelPhases({})).toEqual([]);
  });

  test('maps Dream phases to the CLI config keys used by resolveModel', () => {
    expect(ADVANCED_MODEL_PHASES).toEqual([
      'synthesize',
      'synthesize_verdict',
      'patterns',
      'extract_atoms',
      'synthesize_concepts',
      'consolidate',
      'conversation_facts_backfill',
      'capture_entities',
      'propose_takes',
      'grade_takes',
      'calibration_profile',
    ]);
    expect(ADVANCED_PHASE_CONFIG_KEYS.synthesize).toBe('models.dream.synthesize');
    expect(ADVANCED_PHASE_CONFIG_KEYS.capture_entities).toBe('models.dream.capture_entities');
    expect(ADVANCED_PHASE_CONFIG_KEYS.extract_atoms).toBe('models.dream.extract_atoms');
    expect(ADVANCED_PHASE_CONFIG_KEYS.synthesize_concepts).toBe('models.dream.synthesize_concepts');
    expect(ADVANCED_PHASE_CONFIG_KEYS.consolidate).toBe('models.dream.consolidate');
    expect(ADVANCED_PHASE_CONFIG_KEYS.propose_takes).toBe('models.propose_takes');
    expect(ADVANCED_PHASE_CONFIG_KEYS.grade_takes).toBe('models.grade_takes');
    expect(ADVANCED_PHASE_CONFIG_KEYS.calibration_profile).toBe('models.calibration_profile');
  });

  test('inherits each Dream phase from its actual runtime tier', () => {
    expect(ADVANCED_PHASE_TIERS.synthesize).toBe('subagent');
    expect(ADVANCED_PHASE_TIERS.synthesize_verdict).toBe('utility');
    expect(ADVANCED_PHASE_TIERS.patterns).toBe('subagent');
    expect(ADVANCED_PHASE_TIERS.extract_atoms).toBe('reasoning');
  });
});
