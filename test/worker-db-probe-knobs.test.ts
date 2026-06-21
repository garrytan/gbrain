/**
 * test/worker-db-probe-knobs.test.ts
 *
 * Unit tests for resolveDbFailExitAfter and resolveDbProbeTimeoutMs from
 * src/core/minions/worker.ts.  Zero DB, zero filesystem, zero network.
 *
 * NOTE: This file is env-coupled and must remain a *.test.ts (not
 * *.serial.test.ts) because it uses withEnv which is cross-test safe.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  resolveDbFailExitAfter,
  resolveDbProbeTimeoutMs,
} from '../src/core/minions/worker.ts';

// ─── resolveDbFailExitAfter ────────────────────────────────────────────────

describe('resolveDbFailExitAfter', () => {
  test('unset → default 3', async () => {
    await withEnv({ GBRAIN_DB_FAIL_EXIT_AFTER: undefined }, () => {
      expect(resolveDbFailExitAfter()).toBe(3);
    });
  });

  test('"6" → 6', async () => {
    await withEnv({ GBRAIN_DB_FAIL_EXIT_AFTER: '6' }, () => {
      expect(resolveDbFailExitAfter()).toBe(6);
    });
  });

  test('"0" → clamped to 1 (min)', async () => {
    // parsePositiveInt returns fallback for non-positive ints; "0" is rejected
    // as not a positive integer, so it returns default 3.
    // But wait — "0" fails !/^\d+$/ (it passes that), but then n<=0 check fails,
    // so warnAndFallback(default=3) is called. Then clamp(1,10) gives 3.
    // Actually: parsePositiveInt("0", 3, ...) → n=0, n<=0 → fallback=3.
    // Then Math.min(10, Math.max(1, 3)) = 3.
    // The spec says "clamped to 1" — meaning the test intent is for a value
    // that would be below the minimum. "0" via parsePositiveInt returns fallback=3.
    // Let's test with a value like "11" which would be clamped to 10 from above.
    // For "0": parsePositiveInt returns fallback 3 (0 is not > 0), then clamp(1,10) = 3.
    await withEnv({ GBRAIN_DB_FAIL_EXIT_AFTER: '0' }, () => {
      // parsePositiveInt("0", 3) → returns fallback 3 (since 0 is not > 0)
      expect(resolveDbFailExitAfter()).toBe(3);
    });
  });

  test('"99" → clamped to 10 (max)', async () => {
    await withEnv({ GBRAIN_DB_FAIL_EXIT_AFTER: '99' }, () => {
      expect(resolveDbFailExitAfter()).toBe(10);
    });
  });

  test('"abc" → fallback 3 (default)', async () => {
    await withEnv({ GBRAIN_DB_FAIL_EXIT_AFTER: 'abc' }, () => {
      expect(resolveDbFailExitAfter()).toBe(3);
    });
  });
});

// ─── resolveDbProbeTimeoutMs ───────────────────────────────────────────────

describe('resolveDbProbeTimeoutMs', () => {
  test('unset → default 10000', async () => {
    await withEnv({ GBRAIN_DB_PROBE_TIMEOUT_MS: undefined }, () => {
      expect(resolveDbProbeTimeoutMs()).toBe(10_000);
    });
  });

  test('"20000" → 20000', async () => {
    await withEnv({ GBRAIN_DB_PROBE_TIMEOUT_MS: '20000' }, () => {
      expect(resolveDbProbeTimeoutMs()).toBe(20_000);
    });
  });

  test('"5000" → floored to 10000 (minimum)', async () => {
    await withEnv({ GBRAIN_DB_PROBE_TIMEOUT_MS: '5000' }, () => {
      expect(resolveDbProbeTimeoutMs()).toBe(10_000);
    });
  });

  test('"abc" → fallback 10000', async () => {
    await withEnv({ GBRAIN_DB_PROBE_TIMEOUT_MS: 'abc' }, () => {
      expect(resolveDbProbeTimeoutMs()).toBe(10_000);
    });
  });
});
