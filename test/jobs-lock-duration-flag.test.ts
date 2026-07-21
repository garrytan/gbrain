/**
 * Unit tests for parseLockDurationFlag (issue #1014) —
 * flag > GBRAIN_LOCK_DURATION env > undefined (worker default 30000ms).
 */

import { describe, test, expect } from 'bun:test';
import { parseLockDurationFlag } from '../src/commands/jobs.ts';

describe('parseLockDurationFlag', () => {
  test('returns undefined when absent (no flag, no env)', () => {
    expect(parseLockDurationFlag(['jobs', 'work'], {})).toBeUndefined();
  });

  test('reads the --lock-duration flag', () => {
    expect(parseLockDurationFlag(['jobs', 'work', '--lock-duration', '120000'], {})).toBe(120000);
  });

  test('falls back to GBRAIN_LOCK_DURATION env', () => {
    expect(parseLockDurationFlag(['jobs', 'work'], { GBRAIN_LOCK_DURATION: '60000' })).toBe(60000);
  });

  test('flag wins over env', () => {
    expect(parseLockDurationFlag(
      ['jobs', 'work', '--lock-duration', '45000'],
      { GBRAIN_LOCK_DURATION: '60000' },
    )).toBe(45000);
  });

  test('empty env string is treated as absent', () => {
    expect(parseLockDurationFlag(['jobs', 'work'], { GBRAIN_LOCK_DURATION: '' })).toBeUndefined();
  });

  test('rejects sub-1000ms values (seconds-vs-ms unit confusion)', () => {
    expect(() => parseLockDurationFlag(['jobs', 'work', '--lock-duration', '30'], {})).toThrow(/milliseconds/);
  });

  test('rejects non-integer / garbage values', () => {
    expect(() => parseLockDurationFlag(['jobs', 'work', '--lock-duration', 'abc'], {})).toThrow();
    expect(() => parseLockDurationFlag(['jobs', 'work', '--lock-duration', '1500.5'], {})).toThrow();
    expect(() => parseLockDurationFlag(['jobs', 'work', '--lock-duration', '-1'], {})).toThrow();
  });
});
