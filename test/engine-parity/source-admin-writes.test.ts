/**
 * BrainEngine parity — the source admin writes that ran as raw SQL (batch 2 of the repair-on-Rust plan, push 4):
 * `gbrain sources set-cr-mode`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), `sources set-cr-mode`
 *    stores a source's contextual-retrieval override, clears it with `unset`, leaves the other sources alone, and
 *    exits 4 for an unknown id with nothing written; `getSource` and the engine-migration source read
 *    (`readMigrationRows('sources')`) return the stored override.
 *  - Regression: the command checked the id with `SELECT id FROM sources` and wrote with `UPDATE sources` through
 *    `executeRaw`, which a Rust brain refuses, so the override could not be set there; the Rust store also kept no
 *    override, so `getSource` and a migration off a Rust brain read null.
 *  - Why existing coverage misses it: test/sources-set-cr-mode.test.ts runs on PGLite only and reads the column back
 *    with raw SQL.
 *  - Seam: `process.exit` is stubbed to record the exit code. Real engines otherwise.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `gbrain sources <args>` with output silenced; returns the exit code it asked for, or null. */
async function cli(engine: BrainEngine, args: string[]): Promise<number | null> {
  const exit = process.exit;
  const { log, error } = console;
  let code: number | null = null;
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    code = n;
    throw new Error(`exit ${n}`);
  }) as never;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSources(engine, args);
  } catch (e) {
    if (code === null) throw e;
  } finally {
    process.exit = exit;
    console.log = log;
    console.error = error;
  }
  return code;
}

describe('engine parity: source admin writes', () => {
  parityTest('sources set-cr-mode sets, clears and refuses an unknown source; getSource and the migration read see it', {
    methods: ['setSourceContextualMode', 'getSource', 'readMigrationRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'side');
    const modes = async () => ({
      wiki: (await engine.getSource('wiki'))?.contextual_retrieval_mode ?? null,
      side: (await engine.getSource('side'))?.contextual_retrieval_mode ?? null,
    });
    const migrated = async () => Object.fromEntries((await engine.readMigrationRows('sources'))!.rows
      .map(r => [r.id as string, (r.contextual_retrieval_mode as string | null) ?? null]));
    const steps: Record<string, unknown> = {};
    steps.set = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'per_chunk_synopsis']), modes: await modes(), migrated: await migrated() };
    steps.reset = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'title']), modes: await modes() };
    steps.missing = { exit: await cli(engine, ['set-cr-mode', 'missing', 'none']), found: await engine.getSource('missing') };
    steps.cleared = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'unset']), modes: await modes(), migrated: await migrated() };
    expect(steps).toEqual({
      set: { exit: null, modes: { wiki: 'per_chunk_synopsis', side: null }, migrated: { default: null, side: null, wiki: 'per_chunk_synopsis' } },
      reset: { exit: null, modes: { wiki: 'title', side: null } },
      missing: { exit: 4, found: null },
      cleared: { exit: null, modes: { wiki: null, side: null }, migrated: { default: null, side: null, wiki: null } },
    });
    return steps;
  });
});
