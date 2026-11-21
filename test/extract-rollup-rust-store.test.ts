/**
 * The extract rollup on the Rust store (`upsertExtractRollup`, rust/crates/gbrain-store/src/facts/extract_rollup.rs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same events written through `upsertExtractRollup` (both statement forms) read back the same 7-day
 *    summary per kind and the same recorded halt reasons on PGLite (doctor's rollup SQL) and on the Rust store (its
 *    `readExtractRollup7d` and `listRecordedHaltReasons7d` reads), with GBRAIN_TEST_RUST_ARM=1.
 *  - Regression: doctor's `extract_health` check reads these rows. Before this file the Rust member wrote nothing, so
 *    a Rust brain had no rollup rows. A store that drops an event, adds a reason on the pre-v141 form, counts a day
 *    older than 7 days or sums cost as a double answers differently.
 *  - Why existing coverage misses it: the parity cases cannot read the table (it has no typed read on this branch, and
 *    the cases never call `executeRaw`), and the extract-rollup-*.test.ts files run on the SQL engines only.
 *  - Seam: the Rust reads are the store's napi functions (`openStore(...).brain`); the PGLite reads are the doctor
 *    statements. The reads move behind typed members when the doctor members land.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { RustEngine } from '../src/core/rust-engine.ts';
import type { ExtractRollupRow } from '../src/core/engine-sql/extract-bookkeeping.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const row = (kind: string, back: number, over: Partial<ExtractRollupRow> = {}): ExtractRollupRow => ({
  kind, sourceId: 'default', day: day(back), cost: 0, halts: 0, evalFails: 0, evalPasses: 0, completed: 0,
  expectedLimits: 0, failures: 0, reason: null, ...over,
});

/** Events over two kinds: reasons, no reason, the pre-v141 form, a day out of the window and float costs. */
async function writeEvents(engine: BrainEngine): Promise<void> {
  await engine.upsertExtractRollup(row('facts', 0, { halts: 2, reason: 'provider_auth', cost: 0.1 }));
  await engine.upsertExtractRollup(row('facts', 0, { halts: 1, reason: 'provider_auth', cost: 0.2 }));
  await engine.upsertExtractRollup(row('facts', 3, { halts: 1, cost: 0.7, failures: 1 }));
  await engine.upsertExtractRollup(row('facts', 0, { evalPasses: 4, evalFails: 1, expectedLimits: 2, completed: 3 }));
  await engine.upsertExtractRollup(row('facts', 9, { halts: 5, reason: 'provider_rate_limit', cost: 9 }));
  await engine.upsertExtractRollup(row('atoms', 7, { completed: 1, cost: 1e-7 }));
  await engine.upsertExtractRollup(row('atoms', 2, { halts: 1, expectedLimits: 2, reason: 'provider_auth' }), 'pre_v141');
  await engine.upsertExtractRollup(row('atoms', 2, { halts: 1, reason: 'item_error' }));
}

const SUMMARY_SQL = `SELECT kind, SUM(cost_usd) AS cost_7d_usd, SUM(eval_pass_count) AS eval_pass_count,
    SUM(eval_fail_count) AS eval_fail_count, SUM(halt_count) AS halt_count, SUM(round_completed_count) AS round_completed_count,
    SUM(expected_limit_count) AS expected_limit_count, SUM(rollup_write_failures) AS rollup_write_failures,
    MAX(updated_at) AS last_updated_at, CURRENT_DATE - MAX(day) FILTER (WHERE halt_count > 0) AS last_halt_age_days
  FROM extract_rollup_7d WHERE day >= CURRENT_DATE - 7 GROUP BY kind ORDER BY kind`;
const REASONS_SQL = `SELECT r.kind, e.key AS reason, SUM(e.value::int) AS n
  FROM extract_rollup_7d r, jsonb_each_text(r.halt_reasons) e WHERE r.day >= CURRENT_DATE - 7
  GROUP BY r.kind, e.key ORDER BY r.kind, e.key`;

type Read = { summary: Record<string, unknown>[]; reasons: Record<string, unknown>[] };

/** Numbers as numbers and the write time as its presence, so text and bigint drivers compare. */
function normalize({ summary, reasons }: Read): Read {
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    summary: summary.map(({ last_updated_at, kind, ...rest }) => ({
      kind, written: last_updated_at !== null && !Number.isNaN(new Date(last_updated_at as string).getTime()),
      ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, num(v)])),
    })),
    reasons: reasons.map(r => ({ kind: r.kind, reason: r.reason, n: num(r.n) })),
  };
}

let pglite: PGLiteEngine;
beforeAll(async () => { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }, 120_000);
afterAll(async () => { await pglite.disconnect(); });

async function pgliteRead(): Promise<Read> {
  return { summary: await pglite.executeRaw(SUMMARY_SQL, []), reasons: await pglite.executeRaw(REASONS_SQL, []) };
}

describe('extract rollup on the Rust store', () => {
  test('PGLite: the events read back as doctor sums them', async () => {
    await writeEvents(pglite);
    const read = normalize(await pgliteRead());
    expect(read.summary.map(r => [r.kind, r.halt_count, r.expected_limit_count, r.last_halt_age_days])).toEqual([
      ['atoms', 4, 0, 2], ['facts', 4, 2, 0],
    ]);
    expect(read.reasons).toEqual([
      { kind: 'atoms', reason: 'item_error', n: 1 }, { kind: 'facts', reason: 'provider_auth', n: 3 },
    ]);
  });

  test.if(rustArmRequested())('Rust: the same events read back the same summary and reasons as PGLite', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      await writeEvents(engine as unknown as BrainEngine);
      const brain = (engine as RustEngine).openStore('readExtractRollup7d').brain;
      const rust = normalize({
        summary: await brain.readExtractRollup7d({ withExpected: true }),
        reasons: await brain.listRecordedHaltReasons7d(),
      });
      expect(rust).toEqual(normalize(await pgliteRead()));
      const noExpected = await brain.readExtractRollup7d({ withExpected: false });
      expect(noExpected.map((r: { expected_limit_count: number }) => r.expected_limit_count)).toEqual([0, 0]);
      await expect(engine.upsertExtractRollup(row('facts', 0, { halts: 2 ** 31 - 1 }))).rejects.toThrow();
      await expect(engine.upsertExtractRollup(row('facts', 0, { day: '2026-02-30' }))).rejects.toThrow();
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  }, 120_000);
});
