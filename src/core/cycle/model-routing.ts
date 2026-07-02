import type { BrainEngine } from '../engine.ts';
import { resolveModel, TIER_DEFAULTS } from '../model-config.ts';

export type CalibrationCycleModelPhase = 'propose_takes' | 'grade_takes' | 'calibration_profile';

export const CALIBRATION_CYCLE_MODEL_CONFIG_KEYS: Record<CalibrationCycleModelPhase, string> = {
  propose_takes: 'models.tier.propose_takes',
  grade_takes: 'models.tier.grade_takes',
  calibration_profile: 'models.tier.calibration_profile',
};

/**
 * Resolve model routing for the hindsight calibration cycle phases.
 *
 * Phase-specific keys win first. When unset, these phases inherit the
 * reasoning tier so private/non-Anthropic reasoning deployments do not fall
 * back to the gateway's native Anthropic default.
 */
export async function resolveCalibrationCycleModel(
  engine: BrainEngine | null,
  phase: CalibrationCycleModelPhase,
  explicitModel?: string,
): Promise<string> {
  return resolveModel(engine, {
    cliFlag: explicitModel,
    configKey: CALIBRATION_CYCLE_MODEL_CONFIG_KEYS[phase],
    tier: 'reasoning',
    fallback: TIER_DEFAULTS.reasoning,
  });
}
