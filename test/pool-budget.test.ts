/**
 * Long-hold permit math (src/core/pool-budget.ts). Long holds leave one
 * connection free for reads and control work; a self-contained holder (one
 * that uses only its reserved connection, like a transaction) may take the
 * only connection of a one-connection pool, so GBRAIN_POOL_SIZE=1 can run
 * `transaction: false` migrations.
 */
import { describe, expect, test } from 'bun:test';
import { poolLongHoldCapacity, tryAcquirePoolLongHold } from '../src/core/pool-budget.ts';

const pool = (max?: number) => ({ options: max === undefined ? {} : { max } });

describe('poolLongHoldCapacity', () => {
  test('ordinary long holds keep one connection free', () => {
    expect(poolLongHoldCapacity(pool(1))).toBe(0);
    expect(poolLongHoldCapacity(pool(2))).toBe(1);
    expect(poolLongHoldCapacity(pool(10))).toBe(9);
    expect(poolLongHoldCapacity(pool())).toBe(9);
  });

  test('a self-contained holder may use the only connection of a one-connection pool', () => {
    expect(poolLongHoldCapacity(pool(1), undefined, { selfContained: true })).toBe(1);
    expect(poolLongHoldCapacity(pool(2), undefined, { selfContained: true })).toBe(1);
    expect(poolLongHoldCapacity(pool(10), undefined, { selfContained: true })).toBe(9);
  });

  test('the direct-route fallback still caps the pool size', () => {
    expect(poolLongHoldCapacity(pool(10), 1)).toBe(0);
    expect(poolLongHoldCapacity(pool(10), 3)).toBe(2);
    expect(poolLongHoldCapacity(pool(), 1, { selfContained: true })).toBe(1);
  });

  test('invalid pool sizes grant nothing', () => {
    for (const max of [0, -1, Number.NaN, 1.5]) {
      expect(poolLongHoldCapacity(pool(max))).toBe(0);
      expect(poolLongHoldCapacity(pool(max), undefined, { selfContained: true })).toBe(0);
    }
  });
});

describe('tryAcquirePoolLongHold', () => {
  test('one-connection pool: refuses ordinary holders, grants one self-contained holder at a time', () => {
    const single = pool(1);
    expect(tryAcquirePoolLongHold(single)).toBeNull();
    const release = tryAcquirePoolLongHold(single, undefined, { selfContained: true });
    expect(release).not.toBeNull();
    expect(tryAcquirePoolLongHold(single, undefined, { selfContained: true })).toBeNull();
    expect(tryAcquirePoolLongHold(single)).toBeNull();
    release!();
    release!();
    const again = tryAcquirePoolLongHold(single, undefined, { selfContained: true });
    expect(again).not.toBeNull();
    again!();
  });

  test('a self-contained holder shares the budget with ordinary holders on larger pools', () => {
    const shared = pool(2);
    const ordinary = tryAcquirePoolLongHold(shared);
    expect(ordinary).not.toBeNull();
    expect(tryAcquirePoolLongHold(shared, undefined, { selfContained: true })).toBeNull();
    ordinary!();
    const contained = tryAcquirePoolLongHold(shared, undefined, { selfContained: true });
    expect(contained).not.toBeNull();
    expect(tryAcquirePoolLongHold(shared)).toBeNull();
    contained!();
  });
});
