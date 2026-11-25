/**
 * BrainEngine parity — extract bookkeeping writes: the two page reads an extract receipt write makes in its
 * transaction (readExtractReceiptSlot, readExtractReceiptSeal) and the extract_rollup_7d day upsert the extract
 * steps add their deltas with (upsertExtractRollupDay, through `upsertExtractRollup`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every arm stores the same day rows (counts, halt reason buckets, cost to `real` precision) for the
 *    same events, and reads the same slot and seal for the same page.
 *  - Regression: an arm that overwrites instead of adding loses a day's halts, so extract_health under-reports;
 *    one that drops the halt reason reads every halt as `unknown`; one that misreads the slot writes a receipt over
 *    a content page, or refuses a receipt it should rewrite.
 *  - Why existing coverage misses it: test/extract-rollup*.test.ts and the receipt tests run on PGLite and
 *    Postgres only, and each statement ran through `executeRaw`, which the Rust engine refuses (D18).
 *  - Seam: the rows are read back with SQL on the SQL arms and with the store's own row list on the Rust arm (no
 *    typed rollup read is in this branch); `updated_at` never compares across arms.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { upsertExtractRollup } from '../../src/core/extract/rollup-writer.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

interface DayRow { kind: string; source_id: string; day: string; cost_usd: string; counts: number[]; halt_reasons: Record<string, number> }

/** Fixture: the stored day rows on or after `since`, in (kind, source_id, day) order. */
async function dayRows(engine: BrainEngine, backend: ParityBackend, since: string): Promise<DayRow[]> {
  type Raw = { kind: string; source_id: string; day: string; cost_usd: number | string; halt_count: number; eval_fail_count: number;
    eval_pass_count: number; round_completed_count: number; expected_limit_count: number; rollup_write_failures: number;
    halt_reasons: Record<string, number> | string };
  const rows: Raw[] = backend === 'rust'
    ? await (engine as unknown as RustEngine).openStore('listExtractRollupDays').brain.listExtractRollupDays(since)
    : await engine.executeRaw<Raw>(
      `SELECT kind, source_id, day::text AS day, cost_usd, halt_count, eval_fail_count, eval_pass_count, round_completed_count,
         expected_limit_count, rollup_write_failures, halt_reasons FROM extract_rollup_7d WHERE day >= $1::date
       ORDER BY kind, source_id, day`, [since]);
  return rows.map(r => ({
    kind: r.kind, source_id: r.source_id, day: r.day, cost_usd: Math.fround(Number(r.cost_usd)).toPrecision(6),
    counts: [r.halt_count, r.eval_fail_count, r.eval_pass_count, r.round_completed_count, r.expected_limit_count, r.rollup_write_failures].map(Number),
    halt_reasons: typeof r.halt_reasons === 'string' ? JSON.parse(r.halt_reasons) : r.halt_reasons,
  }));
}

describe('engine parity: extract bookkeeping', () => {
  parityTest('the rollup upsert inserts a day row, adds each later event to it and counts halts under their reason', {
    methods: ['upsertExtractRollupDay'],
  }, async (engine, backend) => {
    const ok: boolean[] = [];
    const up = async (input: Parameters<typeof upsertExtractRollup>[1]) => ok.push((await upsertExtractRollup(engine, input)).ok);
    await up({ kind: 'facts', source_id: 'default', day: '2026-11-19', round_completed_delta: 1, cost_delta: 0.1 });
    await up({ kind: 'facts', source_id: 'default', day: '2026-11-19', halt_delta: 2, halt_reason: 'provider_rate_limit', cost_delta: 0.2 });
    await up({ kind: 'facts', source_id: 'default', day: '2026-11-19', halt_delta: 1, halt_reason: 'provider_rate_limit' });
    await up({ kind: 'facts', source_id: 'default', day: '2026-11-19', halt_delta: 4, expected_limit_delta: 1, eval_fail_delta: 1 });
    await up({ kind: 'facts', source_id: 'default', day: '2026-11-19', halt_delta: 1, halt_reason: 'item_error', failure_delta: 1 });
    await up({ kind: 'atoms', source_id: 'other', day: '2026-11-18', eval_pass_delta: 3 });
    await up({ kind: 'atoms', source_id: 'default', day: '2026-11-18', halt_delta: 0, halt_reason: 'provider_rate_limit' });
    await up({ kind: 'atoms', source_id: 'default', day: '2026-11-01', round_completed_delta: 1 });
    // The member itself, as the writer calls it: one more event on an existing row.
    await engine.upsertExtractRollupDay({ kind: 'atoms', source_id: 'other', day: '2026-11-18', cost_usd: 0.05, halt_count: 0,
      eval_fail_count: 0, eval_pass_count: 1, round_completed_count: 1, expected_limit_count: 0, rollup_write_failures: 0,
      halt_reason: null });
    return { ok, rows: await dayRows(engine, backend, '2026-11-10') };
  });

  parityTest('the receipt reads answer null for no page, the page a slug holds, and whether its chunks are sealed', {
    methods: ['readExtractReceiptSlot', 'readExtractReceiptSeal', 'putPage'],
  }, async (engine) => {
    const before = [await engine.readExtractReceiptSlot('default', 'notes/r'), await engine.readExtractReceiptSeal('default', 'notes/r', 4)];
    await engine.putPage('notes/r', { type: 'note' as never, title: 'r', compiled_truth: 'A note.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    return {
      before,
      slot: await engine.readExtractReceiptSlot('default', 'notes/r'),
      otherSource: await engine.readExtractReceiptSlot('elsewhere', 'notes/r'),
      sealedAboveTheVersion: await engine.readExtractReceiptSeal('default', 'notes/r', 32000),
    };
  });
});
