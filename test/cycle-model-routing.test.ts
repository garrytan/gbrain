import { describe, expect, test } from 'bun:test';
import {
  CALIBRATION_CYCLE_MODEL_CONFIG_KEYS,
  resolveCalibrationCycleModel,
} from '../src/core/cycle/model-routing.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function engineWithConfig(config: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    async getConfig(key: string) {
      return config[key] ?? null;
    },
  } as unknown as BrainEngine;
}

describe('calibration cycle model routing', () => {
  test('declares phase-specific config keys', () => {
    expect(CALIBRATION_CYCLE_MODEL_CONFIG_KEYS.propose_takes).toBe('models.tier.propose_takes');
    expect(CALIBRATION_CYCLE_MODEL_CONFIG_KEYS.grade_takes).toBe('models.tier.grade_takes');
    expect(CALIBRATION_CYCLE_MODEL_CONFIG_KEYS.calibration_profile).toBe('models.tier.calibration_profile');
  });

  test('phase-specific key wins over the reasoning tier', async () => {
    const engine = engineWithConfig({
      'models.tier.reasoning': 'openrouter:private/gemma4-31b',
      'models.tier.propose_takes': 'openrouter:private/gpt-oss-120b',
    });

    await expect(resolveCalibrationCycleModel(engine, 'propose_takes')).resolves.toBe('openrouter:private/gpt-oss-120b');
  });

  test('falls back to models.tier.reasoning when the phase key is unset', async () => {
    const engine = engineWithConfig({
      'models.tier.reasoning': 'openrouter:private/gemma4-31b',
    });

    await expect(resolveCalibrationCycleModel(engine, 'grade_takes')).resolves.toBe('openrouter:private/gemma4-31b');
  });

  test('explicit model override wins over config', async () => {
    const engine = engineWithConfig({
      'models.tier.reasoning': 'openrouter:private/gemma4-31b',
      'models.tier.calibration_profile': 'openrouter:private/gpt-oss-120b',
    });

    await expect(resolveCalibrationCycleModel(engine, 'calibration_profile', 'openrouter:private/manual')).resolves.toBe('openrouter:private/manual');
  });
});
