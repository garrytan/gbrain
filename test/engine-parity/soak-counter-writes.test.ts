/**
 * BrainEngine parity: the soak counters' write (addSoakCounterEvent, engine-sql/soak-counters.ts) and its reader
 * (readSoakCounterRows), driven through `gbrain repair --apply`, which records a soak intervention on every apply.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after `gbrain repair request-indexes --apply` twice and `gbrain repair file-drift --apply` once, doctor's
 *    soak counters read repair_apply 2 and file_drift_apply 1 on PGLite, Postgres (DATABASE_URL, en_US.utf8) and Rust
 *    (GBRAIN_TEST_RUST_ARM=1); a counter added to a day that already holds another keeps both.
 *  - Regression: on the parent the write ran raw SQL inside `.catch(() => undefined)` and the reader answered [] on Rust,
 *    so a Rust brain counted 0 interventions after every repair apply, with no sign.
 *  - Why existing coverage misses it: the soak counter tests run on PGLite only, where the raw statement succeeds.
 *  - Seam: none. The repair command runs as the CLI runs it; a file-drift apply refuses after it records its decision on
 *    every arm, and the case keeps that refusal's code.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { readSoakCounters, SOAK_COUNTERS_OP } from '../../src/core/persistence/soak-counters.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';

const arms = parityArms(testBackends());
const parityTest: typeof arms.parityTest = (name, opts, scenario) => arms.parityTest(name, opts, async (engine, ...rest) => {
  try { return await scenario(engine, ...rest); } finally { await disposePersistenceConsumer(engine); }
});

/** Runs `gbrain repair <args> --json` with stdout captured; answers the refusal's code when the command refuses. */
async function repair(engine: BrainEngine, args: string[]): Promise<string> {
  const { runRepairCommand } = await import('../../src/commands/repair.ts');
  const original = console.log, write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runRepairCommand(engine, [...args, '--json']);
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    console.log = original;
    process.stdout.write = write;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

describe('engine parity: soak counter writes', () => {
  parityTest('gbrain repair --apply counts its interventions and content decisions in the soak counters on every engine', {
    methods: ['addSoakCounterEvent', 'readSoakCounterRows'], timeout: 60_000,
  }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-soak-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, GBRAIN_INTERACTIVE: '0', CI: '1' }, async () => {
        _resetCliExitVerdictForTests();
        const runs = [
          await repair(engine, ['request-indexes', '--apply']),
          await repair(engine, ['request-indexes', '--apply']),
          await repair(engine, ['file-drift', '--apply', '--all-drifted']),
        ];
        const counters = await readSoakCounters(engine);
        const out = { runs, interventions: counters.interventions, decisions: counters.content_decisions, days: counters.by_day.map(d => ({ ...d, day: d.day === today() ? 'today' : d.day })) };
        expect(out.interventions.repair_apply).toBe(2);
        expect(out.decisions.file_drift_apply).toBe(1);
        expect(out.days).toEqual([{ day: 'today', interventions: 2, content_decisions: 1 }]);
        return out;
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('addSoakCounterEvent creates the day row, adds to a counter, and keeps the other counters of the day', {
    methods: ['addSoakCounterEvent', 'readSoakCounterRows'],
  }, async (engine) => {
    await engine.addSoakCounterEvent(SOAK_COUNTERS_OP, '2026-01-02', 'repair_apply', 1);
    await engine.addSoakCounterEvent(SOAK_COUNTERS_OP, '2026-01-02', 'repair_apply', 3);
    await engine.addSoakCounterEvent(SOAK_COUNTERS_OP, '2026-01-02', 'needs_human', 2);
    await engine.addSoakCounterEvent(SOAK_COUNTERS_OP, '2026-01-03', 'retry_held', 1);
    const rows = await engine.readSoakCounterRows(SOAK_COUNTERS_OP, ['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-02']);
    const byDay = Object.fromEntries(rows.map(r => [String(r.day), r]));
    expect(byDay).toEqual({
      '2026-01-02': { day: '2026-01-02', repair_apply: 4, needs_human: 2 },
      '2026-01-03': { day: '2026-01-03', retry_held: 1 },
    });
    return byDay;
  });
});
