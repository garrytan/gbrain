/**
 * Parity for a managed sync's freshness stamp (persistence/sync-pass-run.ts `stampManagedSourceFresh`): the step a managed
 * `gbrain sync` that found nothing new runs inside its coordinated-write transaction (sync-run.ts, a complete check that
 * found nothing; sync-pass-run.ts, an idle tick and an unchanged pass).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the stamp sets `last_sync_at` of a source still of the run's incarnation, and leaves a source of another incarnation,
 *    or an unknown source, as it was.
 *  - Regression: the stamp ran as raw SQL (`UPDATE sources SET last_sync_at=now() ...`), which the Rust engine refuses, so
 *    the step of a no-change managed sync failed on a Rust brain and its source kept reading as stale.
 *  - Why existing coverage misses it: import-folder-stamp.test.ts covers `markSourceSynced` alone; the managed sync suites
 *    run PGLite and Postgres only, and a Rust brain cannot activate managed persistence yet (managed-mode.ts reads its
 *    persistence row as not enabled), so no whole managed sync reaches the stamp on that arm.
 *  - Seam: the case calls the step the managed sync calls, inside the same coordinated-write transaction shape, rather
 *    than a whole managed sync. Times differ per run, so it compares whether the stamp is set, not its value.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { principalAttribution } from '../../src/core/persistence/attribution.ts';
import { stampManagedSourceFresh } from '../../src/core/persistence/sync-pass-run.ts';

const { parityTest } = parityArms(testBackends());

const OTHER_INCARNATION = 'f0000000-0000-4000-8000-000000000000';

/** The stamp step in a coordinated write of `sourceId`, as the managed sync runs it; `ok` or the refusal's code. */
async function stamp(engine: BrainEngine, sourceId: string, incarnation: string): Promise<string> {
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => stampManagedSourceFresh(tx, sourceId, incarnation),
    principalAttribution({ kind: 'local_cli', id: 'sync-stamp' })))
    .then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? String(e));
}

const stamped = async (engine: BrainEngine, sourceId: string) => (await engine.getSource(sourceId))?.last_sync_at != null;

describe('engine parity: a managed sync stamps its source fresh', () => {
  parityTest('the managed sync stamp sets last_sync_at only for the run\'s incarnation of the source', {
    methods: ['insertSource', 'readSourceMembership', 'getSource'],
  }, async (engine) => {
    await engine.insertSource({ id: 'stamp-a', name: 'stamp-a', local_path: null, config: {} });
    const incarnation = (await engine.readSourceMembership('stamp-a'))!.incarnation;
    const before = await stamped(engine, 'stamp-a');
    const other = await stamp(engine, 'stamp-a', OTHER_INCARNATION);
    const afterOther = await stamped(engine, 'stamp-a');
    const own = await stamp(engine, 'stamp-a', incarnation);
    const afterOwn = await stamped(engine, 'stamp-a');
    const unknown = await stamp(engine, 'no-such-source', incarnation);
    const out = { before, other, afterOther, own, afterOwn, unknown };
    expect(out).toEqual({ before: false, other: 'ok', afterOther: false, own: 'ok', afterOwn: true, unknown: 'ok' });
    return out;
  });
});
