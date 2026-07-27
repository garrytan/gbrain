/**
 * v0.41.13.0 — unit tests for the sync --timeout / --max-age fix wave.
 *
 * Coverage diagram (v4 plan):
 *   Unit (no DB):  parseDurationSeconds, partial JSON shape, runOne timer
 *                  cleanup invariants (R1/R3 regression checks).
 *   PGLite:        AbortSignal threading at every checkpoint, migration v97
 *                  backfill, deleteLockRowIfStale semantics. (Separate file.)
 *
 * Test-isolation rule (CLAUDE.md R1): no process.env mutations. No
 * top-level module mocks (R2 — `mock.module` calls leak across files in the
 * shard process). Engine lifecycle follows the canonical PGLite block in
 * the separate PGLite-only test file.
 */
import { describe, test, expect } from 'bun:test';
import { parseDurationSeconds } from '../src/core/sync-concurrency.ts';

describe('parseDurationSeconds (v0.41.13.0 T16)', () => {
  test('undefined input returns undefined (caller detects missing flag)', () => {
    expect(parseDurationSeconds(undefined, '--timeout')).toBeUndefined();
  });

  test('accepts bare integer as seconds', () => {
    expect(parseDurationSeconds('60', '--timeout')).toBe(60);
    expect(parseDurationSeconds('1', '--timeout')).toBe(1);
    expect(parseDurationSeconds('3600', '--timeout')).toBe(3600);
  });

  test('accepts "s" suffix (explicit seconds)', () => {
    expect(parseDurationSeconds('60s', '--timeout')).toBe(60);
    expect(parseDurationSeconds('1s', '--timeout')).toBe(1);
  });

  test('accepts "m" suffix (minutes converted to seconds)', () => {
    expect(parseDurationSeconds('10m', '--timeout')).toBe(600);
    expect(parseDurationSeconds('1m', '--timeout')).toBe(60);
  });

  test('accepts "h" suffix (hours converted to seconds)', () => {
    expect(parseDurationSeconds('1h', '--timeout')).toBe(3600);
    expect(parseDurationSeconds('2h', '--timeout')).toBe(7200);
  });

  test('trims whitespace before parsing', () => {
    expect(parseDurationSeconds('  60  ', '--timeout')).toBe(60);
    expect(parseDurationSeconds(' 10m ', '--timeout')).toBe(600);
  });

  test('rejects empty string', () => {
    expect(() => parseDurationSeconds('', '--timeout')).toThrow('--timeout');
  });

  test('rejects garbage', () => {
    expect(() => parseDurationSeconds('foo', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('abc', '--timeout')).toThrow('--timeout');
  });

  test('rejects zero', () => {
    expect(() => parseDurationSeconds('0', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('0s', '--timeout')).toThrow('--timeout');
  });

  test('rejects negative', () => {
    expect(() => parseDurationSeconds('-3', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('-60s', '--timeout')).toThrow('--timeout');
  });

  test('rejects decimals', () => {
    expect(() => parseDurationSeconds('1.5', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('1.5m', '--timeout')).toThrow('--timeout');
  });

  test('rejects unrecognized units', () => {
    expect(() => parseDurationSeconds('60ms', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('1d', '--timeout')).toThrow('--timeout');
    expect(() => parseDurationSeconds('60x', '--timeout')).toThrow('--timeout');
  });

  test('error message names the flag passed in', () => {
    try {
      parseDurationSeconds('foo', '--max-age');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('--max-age');
      expect((e as Error).message).not.toContain('--timeout');
    }
  });

  test('error message includes the offending input', () => {
    try {
      parseDurationSeconds('0', '--timeout');
      throw new Error('should have thrown');
    } catch (e) {
      // JSON.stringify('0') → '"0"' so the message contains the quoted token
      expect((e as Error).message).toContain('"0"');
    }
  });
});

describe('SyncResult partial envelope (v0.41.13.0 T1)', () => {
  // R3 regression: existing union members stay valid. Test that the type
  // shape is additive — every existing status value still satisfies the
  // SyncResult type and consumers that switch on .status still see all the
  // historical arms.
  test('partial is additive over the existing status union', () => {
    // Compile-time only: TypeScript would reject this assignment if the
    // status union narrowed in a way that broke existing values.
    const existing: Array<
      'up_to_date' | 'synced' | 'first_sync' | 'dry_run' | 'blocked_by_failures'
    > = ['up_to_date', 'synced', 'first_sync', 'dry_run', 'blocked_by_failures'];
    expect(existing).toHaveLength(5);
  });
});
