/**
 * v0.46.15 — EXECUTABLE pre-registered floors (outside-voice R2-14).
 *
 * The BrainBench CI gate is baseline-RELATIVE (HEAD run vs origin/master's
 * committed baseline) and a justified `--update-baseline` can bank any
 * movement — so the wave's pre-registered absolute floors were prose until
 * this test. It asserts them against the COMMITTED baseline: a future
 * justified bank that regresses below a floor now fails the unit suite,
 * not just a human reviewer's judgment.
 *
 * Floors are the v0.46.15 identity-wave pre-registrations (MINIMUMS — the
 * banked numbers exceed several of them; do not ratchet the floors to the
 * observed values without a new pre-registration):
 *   know_to_ask_failure_rate ≤ 0.05      false_fire_rate ≤ 0.03
 *   push_precision ≥ 0.95                source_isolation_violations = 0
 *   push_recall ≥ 0.95 / 0.72 / 0.52 (openclaw / claude-code / codex)
 *
 * openclaw floor 0.88 → 0.95 (2026-08 fix wave, new pre-registration): the
 * volunteer-arm fusion banked 1.0000 (96/96) at precision 1.0; the floor is
 * measured-minus-margin, not the observed value (CI runner variance rule).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CellMetrics = Record<string, number>;

const baseline = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'evals', 'brainbench', 'baselines', 'main.json'), 'utf8'),
) as { cells: Record<string, CellMetrics> };

function cell(harness: string, suite: string): CellMetrics {
  const c = baseline.cells[`${harness}/${suite}`];
  if (!c) throw new Error(`baseline cell missing: ${harness}/${suite}`);
  return c;
}

const HARNESSES = ['openclaw', 'claude-code', 'codex'] as const;
const PUSH_RECALL_FLOORS: Record<(typeof HARNESSES)[number], number> = {
  openclaw: 0.95,
  'claude-code': 0.72,
  codex: 0.52,
};

describe('pre-registered absolute floors (v0.46.15) hold in the committed baseline', () => {
  for (const h of HARNESSES) {
    test(`${h}: know_to_ask_failure_rate ≤ 0.05 and false_fire_rate ≤ 0.03`, () => {
      const m = cell(h, 'know-to-ask');
      expect(m.know_to_ask_failure_rate).toBeLessThanOrEqual(0.05);
      expect(m.false_fire_rate).toBeLessThanOrEqual(0.03);
    });

    test(`${h}: push_precision ≥ 0.95 and push_recall ≥ ${PUSH_RECALL_FLOORS[h]}`, () => {
      const m = cell(h, 'push');
      expect(m.push_precision).toBeGreaterThanOrEqual(0.95);
      expect(m.push_recall).toBeGreaterThanOrEqual(PUSH_RECALL_FLOORS[h]);
    });
  }

  test('source_isolation_violations = 0 in EVERY cell (hard floor)', () => {
    const keys = Object.keys(baseline.cells);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(baseline.cells[k].source_isolation_violations ?? 0).toBe(0);
    }
  });
});

/**
 * Injected-token CEILINGS (2026-08 fix wave, red-team): the volunteer-arm
 * rebank raised openclaw avg_injected_tokens ~17% — recall bought with
 * downstream context cost. The recall/precision floors alone can't see a
 * future gate regression that volunteers pages every turn (gold-adjacent
 * volunteers keep precision at 1.0 while cost climbs invisibly). Ceilings
 * are measured-plus-margin (~+30%) at the 2026-08 rebank; a justified bank
 * that exceeds one must consciously re-register the ceiling here, same
 * convention as the recall floors.
 */
const TOKEN_CEILINGS: Record<string, number> = {
  'openclaw/push': 76,
  'openclaw/know-to-ask': 58,
  'openclaw/continuity': 98,
  'claude-code/push': 66,
  'claude-code/know-to-ask': 50,
  'claude-code/continuity': 78,
  'codex/push': 72,
  'codex/know-to-ask': 59,
  'codex/continuity': 197,
};

describe('avg_injected_tokens ceilings hold in the committed baseline', () => {
  for (const [key, ceiling] of Object.entries(TOKEN_CEILINGS)) {
    test(`${key}: avg_injected_tokens ≤ ${ceiling}`, () => {
      const [harness, suite] = key.split('/');
      const m = cell(harness, suite);
      expect(m.avg_injected_tokens).toBeGreaterThan(0);
      expect(m.avg_injected_tokens).toBeLessThanOrEqual(ceiling);
    });
  }
});
