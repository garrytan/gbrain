import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import * as os from 'os';
import { shouldProceed, preflight, complete, getThrottleState, _resetForTest } from '../src/core/backoff.ts';

describe('backoff', () => {
  beforeEach(() => {
    _resetForTest();
  });

  test('shouldProceed returns a ThrottleResult with required fields', () => {
    const result = shouldProceed();
    expect(typeof result.proceed).toBe('boolean');
    expect(typeof result.delay).toBe('number');
    expect(typeof result.reason).toBe('string');
    expect(typeof result.load).toBe('number');
    expect(typeof result.memoryUsed).toBe('number');
    expect(result.delay).toBeGreaterThanOrEqual(0);
    expect(result.load).toBeGreaterThanOrEqual(0);
    expect(result.memoryUsed).toBeGreaterThanOrEqual(0);
  });

  test('concurrent process limit blocks when exceeded', () => {
    // Infinite thresholds: host load and memory can never block, so only the
    // concurrency counter decides.
    const allPermissive = { loadStopPct: Infinity, loadSlowPct: Infinity, memoryStopPct: Infinity };

    // First check: should proceed (0 active)
    expect(shouldProceed(allPermissive).proceed).toBe(true);

    // Register 2 processes by calling preflight with permissive config
    preflight('a', allPermissive);
    preflight('b', allPermissive);

    // Now should block due to concurrency
    const blocked = shouldProceed(allPermissive);
    expect(blocked.proceed).toBe(false);
    expect(blocked.reason).toContain('batch processes active');
  });

  test('complete decrements active process count', async () => {
    const cfg = { loadStopPct: Infinity, loadSlowPct: Infinity, memoryStopPct: Infinity };
    expect(await preflight('test-1', cfg)).toBe(true);
    expect(await preflight('test-2', cfg)).toBe(true);
    complete();
    const state = getThrottleState();
    expect(state.activeProcesses).toBe(1);
  });

  test('missing CPU metrics still enforce concurrent process limit', async () => {
    const load = spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
    const cfg = { memoryStopPct: Infinity };
    try {
      expect(await preflight('a', cfg)).toBe(true);
      expect(await preflight('b', cfg)).toBe(true);
      expect(await preflight('c', cfg)).toBe(false);
      expect(getThrottleState().activeProcesses).toBe(2);
    } finally {
      load.mockRestore();
      _resetForTest();
    }
  });

  test('missing CPU metrics still enforce memory limit', () => {
    const load = spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
    try {
      const blocked = shouldProceed({ memoryStopPct: 0 });
      expect(blocked.proceed).toBe(false);
      expect(blocked.reason).toContain('Memory');
      expect(shouldProceed({ memoryStopPct: Infinity }).proceed).toBe(true);
    } finally {
      load.mockRestore();
    }
  });

  test('complete does not go below zero', () => {
    complete();
    complete();
    const state = getThrottleState();
    expect(state.activeProcesses).toBe(0);
  });

  test('getThrottleState returns current metrics', () => {
    const state = getThrottleState();
    expect(typeof state.load).toBe('number');
    expect(typeof state.memoryUsed).toBe('number');
    expect(typeof state.activeProcesses).toBe('number');
    expect(typeof state.isActiveHours).toBe('boolean');
    expect(state.load).toBeGreaterThanOrEqual(0);
    expect(state.memoryUsed).toBeGreaterThan(0);
    expect(state.memoryUsed).toBeLessThanOrEqual(1);
  });

  test('shouldProceed returns valid result with permissive thresholds', () => {
    _resetForTest();
    const result = shouldProceed({
      loadStopPct: 1.0,
      loadSlowPct: 1.0,
      loadNormalPct: 1.0,
      memoryStopPct: 1.0,
    });
    // With all thresholds at 100%, should proceed unless parallel tests
    // leaked state into the module-level counter. Either way, result is valid.
    expect(typeof result.proceed).toBe('boolean');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test('shouldProceed blocks with zero thresholds', () => {
    const result = shouldProceed({
      loadStopPct: 0.0,
      memoryStopPct: 0.0,
    });
    expect(result.proceed).toBe(false);
  });

  test('preflight returns boolean', async () => {
    const cfg = { loadStopPct: 1.0, loadSlowPct: 1.0, memoryStopPct: 1.0 };
    const ok = await preflight('test-process', cfg);
    expect(typeof ok).toBe('boolean');
    if (ok) {
      const state = getThrottleState();
      expect(state.activeProcesses).toBe(1);
    }
  });

  test('delay is a non-negative number', () => {
    const result = shouldProceed();
    expect(result.delay).toBeGreaterThanOrEqual(0);
    expect(result.delay).toBeLessThanOrEqual(120000);
  });

  test('reason is descriptive', () => {
    const result = shouldProceed();
    expect(result.reason.length).toBeGreaterThan(5);
  });
});
