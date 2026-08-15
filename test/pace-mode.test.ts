/**
 * Pins the DB-pacing mode bundles + resolution chain.
 * The load-bearing claim: env beats config (incident escape hatch), per-call
 * beats env, and `off` resolves to a disabled bundle.
 */
import { describe, expect, test } from 'bun:test';
import {
  PACE_BUNDLES,
  PACE_MODES,
  DEFAULT_PACE_MODE,
  isPaceMode,
  resolvePaceMode,
  loadOverridesFromConfig,
  readPaceEnv,
} from '../src/core/pace-mode.ts';

describe('pace-mode bundles', () => {
  test('off is the default and is disabled', () => {
    expect(DEFAULT_PACE_MODE).toBe('off');
    expect(PACE_BUNDLES.off.enabled).toBe(false);
  });

  test('enabled bundles cap concurrency below the unpaced default (20)', () => {
    for (const m of ['gentle', 'balanced', 'aggressive'] as const) {
      expect(PACE_BUNDLES[m].enabled).toBe(true);
      expect(PACE_BUNDLES[m].maxConcurrency).toBeGreaterThanOrEqual(1);
      expect(PACE_BUNDLES[m].maxConcurrency).toBeLessThan(20);
    }
  });

  test('isPaceMode guards the union', () => {
    expect(PACE_MODES.every(isPaceMode)).toBe(true);
    expect(isPaceMode('turbo')).toBe(false);
    expect(isPaceMode(undefined)).toBe(false);
  });
});

describe('resolvePaceMode precedence', () => {
  test('unknown mode falls back to off (disabled), mode_valid=false', () => {
    const r = resolvePaceMode({ mode: 'turbo' });
    expect(r.resolved_mode).toBe('off');
    expect(r.mode_valid).toBe(false);
    expect(r.enabled).toBe(false);
  });

  test('config mode applies its bundle', () => {
    const r = resolvePaceMode({ mode: 'balanced' });
    expect(r.resolved_mode).toBe('balanced');
    expect(r.maxConcurrency).toBe(PACE_BUNDLES.balanced.maxConcurrency);
  });

  test('env mode beats config mode (incident escape hatch)', () => {
    const r = resolvePaceMode({ mode: 'gentle', envMode: 'aggressive' });
    expect(r.resolved_mode).toBe('aggressive');
  });

  test('per-call mode beats env and config', () => {
    const r = resolvePaceMode({ mode: 'gentle', envMode: 'balanced', perCallMode: 'aggressive' });
    expect(r.resolved_mode).toBe('aggressive');
  });

  test('env knob override beats config knob override', () => {
    const r = resolvePaceMode({
      mode: 'balanced',
      configOverrides: { maxConcurrency: 6 },
      envOverrides: { maxConcurrency: 2 },
    });
    expect(r.maxConcurrency).toBe(2);
  });

  test('per-call knob beats env and config', () => {
    const r = resolvePaceMode({
      mode: 'balanced',
      configOverrides: { maxConcurrency: 6 },
      envOverrides: { maxConcurrency: 2 },
      perCall: { maxConcurrency: 12 },
    });
    expect(r.maxConcurrency).toBe(12);
  });

  test('clamps an out-of-range maxConcurrency back to the bundle when enabled', () => {
    const r = resolvePaceMode({ mode: 'balanced', perCall: { maxConcurrency: 0 } });
    expect(r.enabled).toBe(true);
    expect(r.maxConcurrency).toBe(PACE_BUNDLES.balanced.maxConcurrency);
  });

  test('clamps a bad ewmaAlpha back to a sane default', () => {
    const r = resolvePaceMode({ mode: 'balanced', perCall: { ewmaAlpha: 5 } });
    expect(r.ewmaAlpha).toBeGreaterThan(0);
    expect(r.ewmaAlpha).toBeLessThanOrEqual(1);
  });
});

describe('config + env parsing', () => {
  test('loadOverridesFromConfig parses present keys only', () => {
    const ov = loadOverridesFromConfig({
      'pace.max_concurrency': '5',
      'pace.pace_at_ms': '400',
    });
    expect(ov.maxConcurrency).toBe(5);
    expect(ov.paceAtMs).toBe(400);
    expect(ov.maxSleepMs).toBeUndefined();
  });

  test('readPaceEnv reads GBRAIN_PACE_* including mode', () => {
    const { envMode, envOverrides } = readPaceEnv({
      GBRAIN_PACE_MODE: 'gentle',
      GBRAIN_PACE_MAX_CONCURRENCY: '3',
      GBRAIN_PACE_ENABLED: 'true',
    });
    expect(envMode).toBe('gentle');
    expect(envOverrides.maxConcurrency).toBe(3);
    expect(envOverrides.enabled).toBe(true);
  });

  test('rejects out-of-range env concurrency (falls through)', () => {
    const { envOverrides } = readPaceEnv({ GBRAIN_PACE_MAX_CONCURRENCY: '99999' });
    expect(envOverrides.maxConcurrency).toBeUndefined();
  });
});
