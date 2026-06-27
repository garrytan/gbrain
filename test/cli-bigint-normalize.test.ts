/**
 * Regression tests for the local-op CLI output normalizer and CLI command
 * reachability.
 *
 *  - bigintToStringReplacer: cli.ts JSON-normalizes a local op's return value
 *    so a bigint column (e.g. a BIGSERIAL `id`) round-trips to a string instead
 *    of crashing `JSON.stringify`. (garrytan/gbrain#2450)
 *  - CLI_ONLY: `calibration` is reachable; it was missing from the set, so the
 *    dispatch fell through to "Unknown command" despite a `case 'calibration'`
 *    handler existing. (garrytan/gbrain#2035)
 */
import { describe, test, expect } from 'bun:test';
import { bigintToStringReplacer, CLI_ONLY } from '../src/cli.ts';

describe('bigintToStringReplacer (#2450)', () => {
  test('serializes a bigint to its string form instead of throwing', () => {
    const raw = { id: 9007199254740993n, total: 5, name: 'x' };
    const out = JSON.parse(JSON.stringify(raw, bigintToStringReplacer));
    expect(out).toEqual({ id: '9007199254740993', total: 5, name: 'x' });
  });

  test('handles nested + array bigints', () => {
    const raw = { row: { id: 1n }, ids: [2n, 3n], plain: true };
    const out = JSON.parse(JSON.stringify(raw, bigintToStringReplacer));
    expect(out).toEqual({ row: { id: '1' }, ids: ['2', '3'], plain: true });
  });

  test('leaves non-bigint values untouched', () => {
    expect(bigintToStringReplacer('k', 5)).toBe(5);
    expect(bigintToStringReplacer('k', 's')).toBe('s');
    expect(bigintToStringReplacer('k', null)).toBeNull();
  });

  test('a bare object with a bigint throws under plain stringify but not with the replacer', () => {
    expect(() => JSON.stringify({ id: 1n })).toThrow();
    expect(() => JSON.stringify({ id: 1n }, bigintToStringReplacer)).not.toThrow();
  });
});

describe('CLI_ONLY command reachability (#2035)', () => {
  test('`calibration` is in CLI_ONLY so dispatch reaches its handler', () => {
    expect(CLI_ONLY.has('calibration')).toBe(true);
  });
});
