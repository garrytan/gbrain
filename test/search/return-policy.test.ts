/**
 * Unit tests for intent-aware adaptive return-sizing (v0.42).
 * Pure logic — no engine, no LLM. Pins the failsafe (never-empty),
 * intent→cap mapping, config resolution precedence, and the off-by-default
 * contract.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ADAPTIVE_RETURN,
  adaptiveReturnFromConfig,
  resolveAdaptiveReturn,
  adaptiveReturnEnabled,
  applyAdaptiveReturn,
  type AdaptiveReturnConfig,
} from '../../src/core/search/return-policy.ts';

const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `r${i}`);

describe('resolveAdaptiveReturn precedence', () => {
  test('default is OFF (no behavior change)', () => {
    expect(resolveAdaptiveReturn(undefined).enabled).toBe(false);
    expect(DEFAULT_ADAPTIVE_RETURN.enabled).toBe(false);
  });
  test('per-call true enables with default caps', () => {
    const c = resolveAdaptiveReturn(true);
    expect(c.enabled).toBe(true);
    expect(c.entityMax).toBe(DEFAULT_ADAPTIVE_RETURN.entityMax);
  });
  test('per-call false wins over config-enabled', () => {
    const c = resolveAdaptiveReturn(false, { enabled: true });
    expect(c.enabled).toBe(false);
  });
  test('per-call object overrides caps but inherits enabled from config when omitted', () => {
    const c = resolveAdaptiveReturn({ entityMax: 1 }, { enabled: true, otherMax: 9 });
    expect(c.enabled).toBe(true); // from config
    expect(c.entityMax).toBe(1); // per-call override
    expect(c.otherMax).toBe(9); // from config
  });
  test('config plane enables', () => {
    const c = resolveAdaptiveReturn(undefined, { enabled: true });
    expect(c.enabled).toBe(true);
  });
});

describe('adaptiveReturnFromConfig', () => {
  test('reads nested search.* keys with clamping', () => {
    const c = adaptiveReturnFromConfig({
      search: {
        adaptive_return: true,
        adaptive_return_entity_max: 3,
        adaptive_return_other_max: 8,
        adaptive_return_min_keep: 2,
      },
    });
    expect(c).toEqual({ enabled: true, entityMax: 3, otherMax: 8, minKeep: 2 });
  });
  test('rejects sub-1 / non-numeric caps (falls back to defaults)', () => {
    const c = adaptiveReturnFromConfig({
      search: { adaptive_return_entity_max: 0, adaptive_return_other_max: 'x' },
    });
    expect(c.entityMax).toBe(DEFAULT_ADAPTIVE_RETURN.entityMax);
    expect(c.otherMax).toBe(DEFAULT_ADAPTIVE_RETURN.otherMax);
  });
  test('empty / null config → empty partial', () => {
    expect(adaptiveReturnFromConfig(null)).toEqual({});
    expect(adaptiveReturnFromConfig({})).toEqual({});
  });
});

describe('adaptiveReturnEnabled', () => {
  test('true when per-call true', () => {
    expect(adaptiveReturnEnabled(true, null)).toBe(true);
  });
  test('true when config enables', () => {
    expect(adaptiveReturnEnabled(undefined, { search: { adaptive_return: true } })).toBe(true);
  });
  test('false by default', () => {
    expect(adaptiveReturnEnabled(undefined, null)).toBe(false);
  });
});

const ON = (over: Partial<AdaptiveReturnConfig> = {}): AdaptiveReturnConfig => ({
  ...DEFAULT_ADAPTIVE_RETURN,
  enabled: true,
  ...over,
});

describe('applyAdaptiveReturn', () => {
  test('disabled → passthrough, decision.applied=false', () => {
    const { kept, decision } = applyAdaptiveReturn(items(20), 'entity', DEFAULT_ADAPTIVE_RETURN);
    expect(kept.length).toBe(20);
    expect(decision.applied).toBe(false);
  });
  test('entity intent uses entityMax', () => {
    const { kept, decision } = applyAdaptiveReturn(items(20), 'entity', ON({ entityMax: 2 }));
    expect(kept.length).toBe(2);
    expect(decision.cap).toBe(2);
    expect(decision.applied).toBe(true);
  });
  test('non-entity intent uses otherMax', () => {
    for (const intent of ['temporal', 'event', 'general'] as const) {
      const { kept } = applyAdaptiveReturn(items(20), intent, ON({ otherMax: 5 }));
      expect(kept.length).toBe(5);
    }
  });
  test('FAILSAFE: never empty when candidates exist (cap floored to minKeep)', () => {
    // minKeep defaults to 1; even a degenerate cap can't zero the result.
    const { kept } = applyAdaptiveReturn(items(10), 'entity', ON({ entityMax: 1, minKeep: 1 }));
    expect(kept.length).toBe(1);
  });
  test('empty input stays empty (no fabrication)', () => {
    const { kept, decision } = applyAdaptiveReturn([], 'entity', ON());
    expect(kept.length).toBe(0);
    expect(decision.applied).toBe(false);
  });
  test('cap larger than result set keeps all', () => {
    const { kept } = applyAdaptiveReturn(items(2), 'general', ON({ otherMax: 6 }));
    expect(kept.length).toBe(2);
  });
  test('preserves order (returns the ranked prefix)', () => {
    const { kept } = applyAdaptiveReturn(items(5), 'entity', ON({ entityMax: 3 }));
    expect(kept).toEqual(['r0', 'r1', 'r2']);
  });
  test('minKeep > cap still respected (recall floor wins)', () => {
    const { kept } = applyAdaptiveReturn(items(10), 'entity', ON({ entityMax: 1, minKeep: 3 }));
    expect(kept.length).toBe(3);
  });
});
