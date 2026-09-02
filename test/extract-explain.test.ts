// Regression test: `gbrain extract --explain <kind> --json` must not crash
// on extract_rollup_7d's aggregate columns. Postgres's SUM(integer) returns
// bigint (halt_count/eval_pass_count/eval_fail_count/round_completed_count
// are all INT columns) — postgres.js surfaces that as JS `bigint`, which
// plain JSON.stringify cannot serialize. The fix casts those four SUM()
// results to ::text in SQL (so the intermediate shape is engine-consistent
// before it ever reaches JS — PGLite would otherwise return a plain
// `number` for the same query) and then Number()-coerces them for the
// --json output, matching `extract status --json` and doctor's
// extract_health (both already Number()-coerce the same columns) so all
// three surfaces agree on type. bigintToStringReplacer stays on the
// JSON.stringify call as a defense-in-depth backstop for the rest of the
// payload.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runExtractExplain } from '../src/commands/extract-explain.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { withEnv } from './helpers/with-env.ts';

let tmpDir: string;

beforeEach(() => {
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-explain-test-'));
});

afterEach(() => {
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

// A value past Number.MAX_SAFE_INTEGER (2^53 - 1). --json's rollup_7d now
// Number()-coerces this column like the plain-text path and
// extract-status.ts already do, so precision above 2^53 is not preserved
// here — the same trade-off the rest of the codebase already accepts for
// this column, in exchange for a consistent type across all three surfaces
// that read it. Used to pin the coercion itself: a string surviving
// untouched into --json output would be the regression.
const HALT_COUNT_STR = '9007199254740993';

// 'atoms' is a built-in cycle-phase kind (not pack-declared), so exercising
// it doesn't need prompt/fixture file resolution.
async function runAndCapture(engine: BrainEngine, extraArgs: string[] = []): Promise<string> {
  const logs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  try {
    await runExtractExplain(engine, ['--explain', 'atoms', ...extraArgs]);
  } finally {
    logSpy.mockRestore();
  }
  return logs.join('\n');
}

function stubEngine(rollupRow: Record<string, unknown>, capturedSql?: string[]): BrainEngine {
  return {
    executeRaw: async (sql: string) => {
      capturedSql?.push(sql);
      return [rollupRow];
    },
  } as unknown as BrainEngine;
}

/** An engine whose rollup query throws — the pre-v106 brain (no
 * extract_rollup_7d table yet) the command's try/catch exists for. */
function failingRollupEngine(): BrainEngine {
  return {
    executeRaw: async () => { throw new Error('relation "extract_rollup_7d" does not exist'); },
  } as unknown as BrainEngine;
}

describe('runExtractExplain — failing rollup query (pre-v106 brain)', () => {
  it('--json emits rollup_7d: null and still renders the rest of the envelope', async () => {
    let out = '';
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      out = await runAndCapture(failingRollupEngine(), ['--json']);
    });
    const parsed = JSON.parse(out);
    expect(parsed.kind).toBe('atoms');
    expect(parsed.rollup_7d).toBeNull();
  });

  it('text path prints "no runs recorded" instead of failing the command', async () => {
    let out = '';
    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      out = await runAndCapture(failingRollupEngine());
    });
    expect(out).toContain('Kind: atoms');
    expect(out).toContain('Last 7 days (rollup): no runs recorded');
  });
});

describe('runExtractExplain --json', () => {
  it('casts the four INT-aggregate SUM() columns to ::text in the query itself', async () => {
    // Pins the actual fix (not just that already-stringified stub data
    // serializes fine): the query text must cast halt_count/eval_pass_count/
    // eval_fail_count/round_completed_count, so both PGLite and Postgres
    // return the identical JSON shape for --json. cost_usd is REAL, not
    // INT, so it must NOT be cast (SUM(REAL) was never a bigint risk).
    const capturedSql: string[] = [];
    const engine = stubEngine({
      cost_7d_usd: 0,
      eval_pass_count: '0',
      eval_fail_count: '0',
      halt_count: '0',
      round_completed_count: '0',
      last_updated_at: null,
    }, capturedSql);

    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await runAndCapture(engine, ['--json']);
    });

    expect(capturedSql).toHaveLength(1);
    const sql = capturedSql[0];
    for (const col of ['eval_pass_count', 'eval_fail_count', 'halt_count', 'round_completed_count']) {
      expect(sql).toMatch(new RegExp(`SUM\\(${col}\\)::text`));
    }
    expect(sql).not.toMatch(/SUM\(cost_usd\)::text/);
  });

  it('Number()-coerces the ::text-cast rollup columns for --json (matches extract-status.ts)', async () => {
    // The fixed query returns cost_7d_usd as a plain number (cost_usd is
    // REAL, no cast needed) and the four INT-aggregate columns as ::text
    // strings. --json then Number()-coerces those four so rollup_7d's
    // shape matches `extract status --json` and doctor's extract_health
    // instead of leaving them as engine-internal ::text strings.
    const engine = stubEngine({
      cost_7d_usd: 12.5,
      eval_pass_count: '0',
      eval_fail_count: '0',
      halt_count: HALT_COUNT_STR,
      round_completed_count: '5',
      last_updated_at: '2026-08-24T16:25:18.409Z',
    });

    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const output = await runAndCapture(engine, ['--json']);
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(parsed.rollup_7d.halt_count).toBe(Number(HALT_COUNT_STR));
      expect(typeof parsed.rollup_7d.halt_count).toBe('number');
      expect(parsed.rollup_7d.round_completed_count).toBe(5);
      expect(parsed.rollup_7d.cost_7d_usd).toBe(12.5);
    });
  });

  it('does not throw if a bigint reaches this object anyway (defense-in-depth: Number() + bigintToStringReplacer)', async () => {
    // Simulates a driver/engine that doesn't honor the ::text cast the way
    // Postgres does, or a future column added without one. The --json
    // branch's Number() coercion already handles a raw bigint safely here;
    // bigintToStringReplacer remains the backstop for any OTHER field that
    // might carry a raw bigint into this object.
    const engine = stubEngine({
      cost_7d_usd: 12.5,
      eval_pass_count: 0n,
      eval_fail_count: 0n,
      halt_count: BigInt(HALT_COUNT_STR),
      round_completed_count: 5n,
      last_updated_at: '2026-08-24T16:25:18.409Z',
    });

    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const output = await runAndCapture(engine, ['--json']);
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(parsed.rollup_7d.halt_count).toBe(Number(HALT_COUNT_STR));
    });
  });

  it('handles the no-matching-rows case (SUM() over zero rows returns one row of NULLs, not zero rows)', async () => {
    const engine = stubEngine({
      cost_7d_usd: null,
      eval_pass_count: null,
      eval_fail_count: null,
      halt_count: null,
      round_completed_count: null,
      last_updated_at: null,
    });

    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const jsonOutput = await runAndCapture(engine, ['--json']);
      expect(() => JSON.parse(jsonOutput)).not.toThrow();
      const parsed = JSON.parse(jsonOutput);
      // Number(null) || 0, matching extract-status.ts's convention for the
      // same zero-matching-rows shape. cost_7d_usd is untouched (never a
      // bigint risk), so it stays null rather than being zeroed.
      expect(parsed.rollup_7d.halt_count).toBe(0);
      expect(parsed.rollup_7d.cost_7d_usd).toBeNull();

      const textOutput = await runAndCapture(engine);
      expect(textOutput).toContain('halts:');
    });
  });

  it('plain-text path is unaffected (no --json, still prints the halt rate)', async () => {
    const engine = stubEngine({
      cost_7d_usd: 12.5,
      eval_pass_count: '0',
      eval_fail_count: '0',
      halt_count: HALT_COUNT_STR,
      round_completed_count: '5',
      last_updated_at: '2026-08-24T16:25:18.409Z',
    });

    await withEnv({ GBRAIN_HOME: tmpDir, GBRAIN_SCHEMA_PACK: undefined }, async () => {
      const output = await runAndCapture(engine);
      expect(output).toContain('halts:');
      expect(output).toContain('rounds_completed:');
    });
  });
});
