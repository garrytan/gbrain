/**
 * v0.41 E5 + Eng D6 — lease-cap controller tests.
 *
 * IRON-RULE regression suite for the Eng D6 sign-error correction:
 * bounces with NO 429s = workers starving = cap should go UP not DOWN.
 * Pre-correction, the controller would crater the cap during a healthy
 * 100-job burst (the field-report scenario). This test pins the right
 * sign so a future "let's simplify the rule" PR can't silently regress it.
 *
 * Pure-function tests on nextLeaseCap; no DB needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  nextLeaseCap,
  controllerTick,
  readControllerWindow,
  readCurrentLeaseCap,
  writeLeaseCap,
  DEFAULT_CONTROLLER_OPTS,
  type ControllerWindowStats,
} from '../src/core/minions/lease-cap-controller.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function stableWindow(opts: Partial<ControllerWindowStats> = {}): ControllerWindowStats {
  return {
    bounce_count: 0,
    upstream_429_count: 0,
    lease_utilization: 0.7,
    latency_stable: true,
    window_ms: 60_000,
    ...opts,
  };
}

describe('nextLeaseCap (Eng D6 IRON-RULE: bounces without 429 = ramp UP)', () => {
  test('REGRESSION GUARD: bounces only + no 429 = RAMP UP (was: ramp down)', () => {
    const next = nextLeaseCap(32, stableWindow({ bounce_count: 5, upstream_429_count: 0 }));
    expect(next).toBeGreaterThan(32);
  });

  test('429s only + no bounces = ramp DOWN', () => {
    const next = nextLeaseCap(32, stableWindow({ upstream_429_count: 2 }));
    expect(next).toBeLessThan(32);
  });

  test('429s + bounces (mixed) = ramp DOWN (upstream signal wins)', () => {
    // Codex pass-3 verified this case explicitly.
    const next = nextLeaseCap(32, stableWindow({ bounce_count: 10, upstream_429_count: 2 }));
    expect(next).toBeLessThan(32);
  });

  test('latency unstable = ramp DOWN even on bounces-only', () => {
    const next = nextLeaseCap(32, stableWindow({ bounce_count: 5, latency_stable: false }));
    expect(next).toBeLessThan(32);
  });

  test('healthy window (no bounces, util > threshold, latency stable) = ramp UP slow', () => {
    const next = nextLeaseCap(32, stableWindow({ lease_utilization: 0.8 }));
    expect(next).toBeGreaterThan(32);
  });

  test('deadband (no bounces + low util) = no change', () => {
    const next = nextLeaseCap(32, stableWindow({ lease_utilization: 0.2 }));
    expect(next).toBe(32);
  });

  test('ceiling clamps ramp UP', () => {
    const next = nextLeaseCap(127, stableWindow({ bounce_count: 10 }));
    expect(next).toBe(128); // hit the ceiling
  });

  test('floor clamps ramp DOWN', () => {
    const next = nextLeaseCap(4, stableWindow({ upstream_429_count: 5 }));
    expect(next).toBe(4); // already at floor
  });

  test('asymmetric AIMD steps: ramp-down step > ramp-up step', () => {
    expect(DEFAULT_CONTROLLER_OPTS.ramp_down_step).toBeGreaterThan(DEFAULT_CONTROLLER_OPTS.ramp_up_step);
  });
});

describe('field-report scenario simulation', () => {
  test('starving workers (bounces but no upstream pushback) get MORE capacity, not less', () => {
    // Simulates the field report: 100 jobs at concurrency=10 with cap=8.
    // Workers bounce because the lease is full; upstream is healthy
    // (Azure Sweden, no provider rate limit → no 429s; latency stable).
    // Correct behavior: cap goes UP to 12, 16, 20... until either
    // bounces stop or upstream pushes back.
    let cap = 8;
    const window: ControllerWindowStats = stableWindow({
      bounce_count: 50,
      upstream_429_count: 0,
      lease_utilization: 1.0,
      latency_stable: true,
    });
    // Run 5 controller ticks under steady starvation.
    for (let i = 0; i < 5; i++) {
      cap = nextLeaseCap(cap, window);
    }
    // After 5 ticks of starvation signal, cap should have ramped up.
    expect(cap).toBeGreaterThan(8);
    expect(cap).toBeGreaterThanOrEqual(8 + 5 * DEFAULT_CONTROLLER_OPTS.ramp_up_step - 0);
  });

  test('upstream overload (429 burst) ramps cap DOWN aggressively', () => {
    let cap = 64;
    const window: ControllerWindowStats = stableWindow({
      upstream_429_count: 10,
      latency_stable: false,
    });
    for (let i = 0; i < 5; i++) {
      cap = nextLeaseCap(cap, window);
    }
    // 5 ticks at ramp_down_step=8 = -40 from 64. Floor stops at 4.
    expect(cap).toBeLessThanOrEqual(64 - 5 * DEFAULT_CONTROLLER_OPTS.ramp_down_step);
    expect(cap).toBeGreaterThanOrEqual(DEFAULT_CONTROLLER_OPTS.min_floor);
  });
});

describe('controllerTick integration (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = 'minions-lease-cap-controller'`);
    await engine.executeRaw(`DELETE FROM minion_lease_pressure_log`);
    await engine.executeRaw(`DELETE FROM minion_jobs`);
    await engine.executeRaw(`DELETE FROM config WHERE key = 'minions.lease_cap_current'`);
  });

  test('first tick on empty brain returns no change (deadband)', async () => {
    const r = await controllerTick(engine);
    expect(r).not.toBeNull();
    expect(r!.changed).toBe(false);
    expect(r!.next).toBe(r!.previous);
  });

  test('writeLeaseCap + readCurrentLeaseCap roundtrip', async () => {
    await writeLeaseCap(engine, 48);
    const got = await readCurrentLeaseCap(engine);
    expect(got).toBe(48);
  });

  test('readControllerWindow returns zero counts on empty brain', async () => {
    const w = await readControllerWindow(engine, 60_000);
    expect(w.bounce_count).toBe(0);
    expect(w.upstream_429_count).toBe(0);
    expect(w.latency_stable).toBe(true); // default-true
  });
});
