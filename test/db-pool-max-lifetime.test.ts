/**
 * issue #6 — `resolveMaxLifetimeSeconds`: explicit, env-overridable
 * max_lifetime for all four postgres() call sites.
 *
 * NOT a behavior change at default: postgres.js (verified against 3.4.9)
 * already defaults max_lifetime to `60 * (30 + Math.random() * 30)`. This
 * resolver makes the value explicit and adds the GBRAIN_POOL_MAX_LIFETIME_S
 * incident escape hatch (0 disables recycling; N = seconds).
 *
 * Hermetic: resolver only — env injected as a param (rule R1), no pools.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  resolveMaxLifetimeSeconds,
  _resetMaxLifetimeWarningForTests,
} from '../src/core/db.ts';
import { withEnv } from './helpers/with-env.ts';

beforeEach(() => {
  _resetMaxLifetimeWarningForTests();
});

describe('resolveMaxLifetimeSeconds', () => {
  test('default (no env): a per-CONNECTION jitter FUNCTION, 30-60 minutes', () => {
    // Must be a function, not a pre-evaluated number: postgres.js re-evaluates
    // a function default per connection, so connections in one pool get
    // independent recycle deadlines instead of a synchronized reconnect spike
    // (data-migration specialist).
    const v = resolveMaxLifetimeSeconds({});
    expect(typeof v).toBe('function');
    const fn = v as () => number;
    for (let i = 0; i < 20; i++) {
      const n = fn();
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1800);
      expect(n).toBeLessThanOrEqual(3600);
    }
  });

  test('env override: positive integer seconds honored verbatim', () => {
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '900' })).toBe(900);
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '1' })).toBe(1);
  });

  test('env 0 disables recycling (null — postgres.js accepts null)', () => {
    expect(resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '0' })).toBeNull();
  });

  test('empty string falls through to the default (function)', () => {
    const v = resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: '' });
    expect(typeof v).toBe('function');
  });

  test('invalid values warn once on stderr and fall back to the default', () => {
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      for (const bad of ['abc', '-5', '3.5', 'NaN']) {
        const v = resolveMaxLifetimeSeconds({ GBRAIN_POOL_MAX_LIFETIME_S: bad });
        expect(typeof v).toBe('function');
      }
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    // warn-once latch: 4 bad values, exactly 1 warning
    const warnings = writes.filter((w) => w.includes('GBRAIN_POOL_MAX_LIFETIME_S'));
    expect(warnings.length).toBe(1);
  });

  test('jitter varies per CONNECTION (thundering-herd protection)', () => {
    const fn = resolveMaxLifetimeSeconds({}) as () => number;
    const values = new Set<number>();
    for (let i = 0; i < 30; i++) values.add(fn());
    expect(values.size).toBeGreaterThan(1);
  });

  test('wiring: the env override reaches a REAL constructed pool (ConnectionManager read pool)', async () => {
    // postgres() is lazy — constructing the pool performs no I/O, so this
    // pins the construction seam without a database. Without this, the
    // resolver could be green while GBRAIN_POOL_MAX_LIFETIME_S is silently
    // dead at every call site (adversarial-review vacuity finding).
    const { ConnectionManager } = await import('../src/core/connection-manager.ts');
    const { endPoolBounded } = await import('../src/core/db.ts');
    await withEnv({ GBRAIN_POOL_MAX_LIFETIME_S: '900' }, async () => {
      const cm = new ConnectionManager({
        url: 'postgresql://user@127.0.0.1:5/never-connected',
      });
      const pool = await cm.getReadPool();
      try {
        expect(
          (pool as unknown as { options: { max_lifetime: number | null } }).options.max_lifetime,
        ).toBe(900);
      } finally {
        await endPoolBounded(pool);
      }
    });
  });

  test('wiring: the default reaches a real pool as a FUNCTION (per-connection jitter)', async () => {
    const { ConnectionManager } = await import('../src/core/connection-manager.ts');
    const { endPoolBounded } = await import('../src/core/db.ts');
    await withEnv({ GBRAIN_POOL_MAX_LIFETIME_S: undefined }, async () => {
      const cm = new ConnectionManager({
        url: 'postgresql://user@127.0.0.1:5/never-connected',
      });
      const pool = await cm.getReadPool();
      try {
        const v = (pool as unknown as { options: { max_lifetime: unknown } }).options.max_lifetime;
        expect(typeof v).toBe('function');
      } finally {
        await endPoolBounded(pool);
      }
    });
  });
});
