import { expect, test } from 'bun:test';
import { ALL_PHASES, DEFAULT_PHASES, resolveCyclePhases } from '../src/core/cycle.ts';
import { resolveDreamPresetPhases } from '../src/commands/dream.ts';

test('默认和完整整理暂停候选观点，保留显式高级入口', () => {
  for (const phases of [DEFAULT_PHASES, resolveCyclePhases(undefined, undefined), resolveDreamPresetPhases('full')]) {
    expect(phases).toContain('capture_entities');
    expect(phases).toContain('extract');
    expect(phases).toContain('embed');
    expect(phases).not.toContain('propose_takes');
    expect(phases).not.toContain('grade_takes');
    expect(phases).not.toContain('calibration_profile');
  }
  expect(resolveCyclePhases(['propose_takes'], undefined)).toEqual(['propose_takes']);
  expect(ALL_PHASES).toContain('propose_takes');
});

test('实体识别先于可选的观点、模式和概念生成', () => {
  for (const phase of ['patterns', 'synthesize_concepts', 'propose_takes']) {
    expect(ALL_PHASES.indexOf('capture_entities')).toBeLessThan(ALL_PHASES.indexOf(phase as never));
  }
});
