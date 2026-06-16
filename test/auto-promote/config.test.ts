import { describe, it, expect } from 'bun:test';
import { defaultAutoPromoteConfig, normalizeAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';

describe('auto_promote config', () => {
  it('defaults are safe (disabled, conservative)', () => {
    const c = defaultAutoPromoteConfig();
    expect(c.enabled).toBe(false);
    expect(c.confidence_threshold).toBe(0.8);
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
  it('defaults require_verification to true and accepts an explicit opt-out', () => {
    expect(defaultAutoPromoteConfig().eligibility.require_verification).toBe(true);
    const c = normalizeAutoPromoteConfig({ eligibility: { require_verification: false } as any });
    expect(c.eligibility.require_verification).toBe(false);
  });
  it('defaults allow_verified_risky_upgrade to true and accepts an explicit opt-out', () => {
    expect(defaultAutoPromoteConfig().eligibility.allow_verified_risky_upgrade).toBe(true);
    const c = normalizeAutoPromoteConfig({ eligibility: { allow_verified_risky_upgrade: false } as any });
    expect(c.eligibility.allow_verified_risky_upgrade).toBe(false);
  });
});
