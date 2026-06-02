import { describe, it, expect } from 'bun:test';
import { defaultAutoPromoteConfig, normalizeAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';

describe('auto_promote config', () => {
  it('defaults are safe (disabled, conservative)', () => {
    const c = defaultAutoPromoteConfig();
    expect(c.enabled).toBe(false);
    expect(c.confidence_threshold).toBe(0.8);
    expect(c.restore_window_hours).toBe(168);
    expect(c.escalation.max_per_cycle).toBe(20);
    expect(c.eligibility.sensitivities).toEqual(['public', 'work']);
    expect(c.eligibility.evidence_kinds).toEqual(['direct_user_statement', 'source_extracted']);
  });
  it('clamps threshold into 0..1 and floors negatives', () => {
    expect(normalizeAutoPromoteConfig({ confidence_threshold: 2 }).confidence_threshold).toBe(1);
    expect(normalizeAutoPromoteConfig({ confidence_threshold: -1 }).confidence_threshold).toBe(0);
  });
  it('drops secret/unknown from sensitivities even if configured', () => {
    const c = normalizeAutoPromoteConfig({ eligibility: { sensitivities: ['work', 'secret', 'unknown', 'personal'] } as any });
    expect(c.eligibility.sensitivities).toEqual(['work', 'personal']);
  });
});
