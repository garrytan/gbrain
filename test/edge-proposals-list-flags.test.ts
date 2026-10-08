/**
 * #6249: `edge-proposals list` reads `--limit` and `--status` in both the
 * `--flag value` and `--flag=value` spellings. A malformed, missing or
 * out-of-range `--limit` is a usage error (`invalid_params`) before any query,
 * instead of reaching the database as `LIMIT NaN`; a valid value above 1000 is
 * still capped. `--status=applied` lists applied proposals instead of the
 * default set.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface Recorded { sql: string; params: unknown[] }

function recordingEngine(): { engine: BrainEngine; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const engine = {
    kind: 'pglite',
    executeRaw: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
  } as unknown as BrainEngine;
  return { engine, calls };
}

async function run(args: string[]): Promise<{ calls: Recorded[]; error: unknown }> {
  const { engine, calls } = recordingEngine();
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runEdgeProposals(engine, args);
    return { calls, error: undefined };
  } catch (error) {
    return { calls, error };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

describe('#6249 edge-proposals list --limit', () => {
  const bad: Array<[string, string | undefined]> = [
    ['abc', 'abc'], ['12abc', '12abc'], ['1.5', '1.5'], ['0', '0'], ['-2', '-2'],
    ['an unsafe integer', '9007199254740992'], ['a missing value', undefined], ['the next flag', '--json'],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name} in both spellings, on both query branches, before any query`, async () => {
      const spellings = [['--limit', ...(value === undefined ? [] : [value])], [`--limit=${value ?? ''}`]];
      for (const status of [[], ['--status', 'all']]) {
        for (const limit of spellings) {
          const { calls, error } = await run(['list', ...status, ...limit]);
          expect(error).toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--limit') });
          expect(calls).toEqual([]);
        }
      }
    });
  }

  const good: Array<[string[], number]> = [
    [[], 50], [['--limit', '5'], 5], [['--limit=7'], 7], [['--limit', '1000'], 1000],
    [['--limit', '5000'], 1000], [['--status', 'all', '--limit=7'], 7],
  ];
  for (const [args, limit] of good) {
    test(`${JSON.stringify(args)} queries with LIMIT ${limit}`, async () => {
      const { calls, error } = await run(['list', ...args]);
      expect(error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sql).toEndWith(`LIMIT ${limit}`);
    });
  }
});

describe('#6249 edge-proposals list --status', () => {
  test('--status=applied lists applied proposals', async () => {
    const { calls } = await run(['list', '--status=applied']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([['applied']]);
  });

  test('--status applied (separate value) still works', async () => {
    const { calls } = await run(['list', '--status', 'applied']);
    expect(calls[0]!.params).toEqual([['applied']]);
  });

  test('--status=all lists every status', async () => {
    const { calls } = await run(['list', '--status=all']);
    expect(calls[0]!.params).toEqual([]);
  });

  test('--status=bogus is refused before any query', async () => {
    const { calls } = await run(['list', '--status=bogus']);
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
  });
});
