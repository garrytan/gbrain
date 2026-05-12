import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { _internal } from '../src/commands/backfill.ts';

const { clampConcurrency } = _internal;

describe('backfill --concurrency clamp (X5)', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GBRAIN_DIRECT_POOL_SIZE; });
  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_DIRECT_POOL_SIZE;
    else process.env.GBRAIN_DIRECT_POOL_SIZE = original;
  });

  test('default with pool=3 → effective=2 (always reserve 1)', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '3';
    const r = clampConcurrency(undefined);
    expect(r.effective).toBe(2);
    expect(r.warning).toBeUndefined();
  });

  test('explicit within ceiling → no clamp', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '5';
    const r = clampConcurrency(3);
    expect(r.effective).toBe(3);
    expect(r.warning).toBeUndefined();
  });

  test('explicit above ceiling → clamps + warns', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '3';
    const r = clampConcurrency(5);
    expect(r.effective).toBe(2); // 3 - 1 (reserved)
    expect(r.warning).toContain('clamped to 2');
    expect(r.warning).toContain('GBRAIN_DIRECT_POOL_SIZE');
  });

  test('default + small pool → minimum effective=1', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '2';
    const r = clampConcurrency(undefined);
    expect(r.effective).toBe(1); // 2 - 1 = 1
  });

  test('explicit 1 always allowed', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '3';
    const r = clampConcurrency(1);
    expect(r.effective).toBe(1);
    expect(r.warning).toBeUndefined();
  });

  test('default with pool=10 → cap at 3 (reasonable default)', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '10';
    const r = clampConcurrency(undefined);
    expect(r.effective).toBe(3); // min(ceiling=9, default=3)
  });
});
