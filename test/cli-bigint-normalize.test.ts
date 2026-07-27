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
 *  - takeHitRowToHit: searchTakes/searchTakesVector coerce int8 driver rows
 *    (native BigInt) to the numeric TakeHit contract, so MCP `takes_search`
 *    doesn't crash the serializer the moment a query matches. (#2450 comments)
 */
import { describe, test, expect } from 'bun:test';
import { bigintToStringReplacer, CLI_ONLY } from '../src/cli.ts';
import { takeHitRowToHit } from '../src/core/utils.ts';
import { runCall } from '../src/commands/call.ts';
import type { BrainEngine } from '../src/core/engine.ts';

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

describe('takeHitRowToHit (#2450 — takes_search MCP path)', () => {
  test('coerces BigInt int8 columns to numbers per the TakeHit contract', () => {
    const hit = takeHitRowToHit({
      take_id: 42n, page_id: 7n, page_slug: 'people/alice-example', row_num: 3n,
      claim: 'Strong DX intuition', kind: 'take', holder: 'garry',
      weight: 0.8, score: 0.91,
    });
    expect(hit).toEqual({
      take_id: 42, page_id: 7, page_slug: 'people/alice-example', row_num: 3,
      claim: 'Strong DX intuition', kind: 'take', holder: 'garry',
      weight: 0.8, score: 0.91,
    });
    expect(() => JSON.stringify(hit)).not.toThrow();
  });

  test('a raw driver row with BigInt ids crashes plain stringify; the coerced hit does not', () => {
    const raw = { take_id: 1n, page_id: 2n, row_num: 0n };
    expect(() => JSON.stringify(raw)).toThrow();
    expect(() => JSON.stringify(takeHitRowToHit(raw))).not.toThrow();
  });
});

describe('runCall output exit is bigint-safe (#2450)', () => {
  test('prints an op result carrying a bigint instead of crashing', async () => {
    // `gbrain call` bypasses cli.ts's normalizer, so its own stringify must
    // carry the replacer. Stub just the surface runCall touches: --source
    // resolution (assertSourceExists) + the get_stats handler pass-through.
    const stub = {
      executeRaw: async (sql: string) =>
        sql.includes('FROM sources') ? [{ id: 'default' }] : [],
      getStats: async () => ({ pages: 42n, chunks: 7 }),
    } as unknown as BrainEngine;

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      // --source pins tier 1 of resolveSourceId so the test is hermetic
      // against GBRAIN_SOURCE / .gbrain-source on the host machine.
      await runCall(stub, ['--source', 'default', 'get_stats']);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(lines.join('\n'))).toEqual({ pages: '42', chunks: 7 });
  });
});
