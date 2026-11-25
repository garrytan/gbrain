/**
 * Parity for the managed connector sync's freshness stamp (persistence/connector-sync.ts `stampConnectorFresh`): the step a
 * managed connector run takes inside its transaction when its checkpoint save is skipped (`stampFreshness`, in a
 * coordinated write) and when the coordinator publishes a fresh `connector_v2_checkpoint` request.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the stamp sets `last_sync_at` of a source still of the run's incarnation, sets `newest_content_at` when the run saw
 *    newer content and keeps the stored value when it did not (null or absent), and leaves a source of another
 *    incarnation, or an unknown source, as it was.
 *  - Regression: the stamp ran as raw SQL (`UPDATE sources SET last_sync_at=now(),newest_content_at=COALESCE(...) ...`),
 *    which the Rust engine refuses, so a managed connector run's freshness stamp and its checkpoint publication failed
 *    on a Rust brain.
 *  - Why existing coverage misses it: import-folder-stamp.test.ts covers `markSourceSynced` alone; the managed connector
 *    suites run PGLite and Postgres only, and a Rust brain cannot activate managed persistence yet (managed-mode.ts reads
 *    its persistence row as not enabled), so no whole managed connector run reaches the stamp on that arm.
 *  - Seam: the cases call the step the connector sync calls, inside the same transaction shapes (a coordinated write, and
 *    a plain transaction as the publication's apply runs it), rather than a whole managed connector run. Sync times
 *    differ per run, so the cases compare whether the stamp is set, not its value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { principalAttribution } from '../../src/core/persistence/attribution.ts';
import { stampConnectorFresh } from '../../src/core/persistence/connector-sync.ts';

const { parityTest } = parityArms(testBackends());

const OTHER_INCARNATION = 'f0000000-0000-4000-8000-000000000000';

/** A refusal's code, so a failing arm names the reason; `ok` when the step ran. */
const outcome = (run: Promise<unknown>) => run.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? String(e));

/** The stamp in a coordinated write of `sourceId`, as `stampFreshness` runs it. */
const coordinated = (engine: BrainEngine, sourceId: string, incarnation: string, newest?: string | null) =>
  outcome(engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => stampConnectorFresh(tx, sourceId, incarnation, newest),
    principalAttribution({ kind: 'local_cli', id: 'connector-stamp' }))));

/** The stamp in a plain transaction, as the `connector_v2_checkpoint` publication's apply runs it. */
const inTransaction = (engine: BrainEngine, sourceId: string, incarnation: string, newest?: string | null) =>
  outcome(engine.transaction(tx => stampConnectorFresh(tx, sourceId, incarnation, newest)));

/** The source's two stamps: whether the sync time is set, and the newest content time as ISO text. */
async function stamps(engine: BrainEngine, sourceId: string): Promise<{ synced: boolean; newest: string | null }> {
  const synced = (await engine.getSource(sourceId))?.last_sync_at != null;
  const at = (await engine.listSourceRecords()).find(r => r.id === sourceId)?.newest_content_at;
  return { synced, newest: at === null || at === undefined ? null : new Date(at).toISOString() };
}

describe('engine parity: a managed connector run stamps its source fresh', () => {
  parityTest('the connector stamp in a coordinated write sets the sync and newest content times only for the run\'s incarnation', {
    methods: ['markSourceSynced', 'readSourceMembership', 'getSource', 'listSourceRecords'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'feed-c', {}, '/srv/brain/feed-c');
    const incarnation = (await engine.readSourceMembership('feed-c'))!.incarnation;
    const before = await stamps(engine, 'feed-c');
    const other = await coordinated(engine, 'feed-c', OTHER_INCARNATION, '2027-01-01T00:00:00.000Z');
    const afterOther = await stamps(engine, 'feed-c');
    const own = await coordinated(engine, 'feed-c', incarnation, '2026-03-04T05:06:07.000Z');
    const afterOwn = await stamps(engine, 'feed-c');
    // A run that saw nothing newer keeps the stored newest content time.
    const absent = await coordinated(engine, 'feed-c', incarnation);
    const afterAbsent = await stamps(engine, 'feed-c');
    const unknown = await coordinated(engine, 'no-such-source', incarnation, '2026-03-04T05:06:07.000Z');
    const out = { before, other, afterOther, own, afterOwn, absent, afterAbsent, unknown };
    expect(out).toEqual({
      before: { synced: false, newest: null },
      other: 'ok', afterOther: { synced: false, newest: null },
      own: 'ok', afterOwn: { synced: true, newest: '2026-03-04T05:06:07.000Z' },
      absent: 'ok', afterAbsent: { synced: true, newest: '2026-03-04T05:06:07.000Z' },
      unknown: 'ok',
    });
    return out;
  });

  parityTest('the connector stamp of a fresh checkpoint publication sets the times and keeps the newest content time for null', {
    methods: ['markSourceSynced', 'readSourceMembership', 'getSource', 'listSourceRecords'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'feed-d', {}, '/srv/brain/feed-d');
    const incarnation = (await engine.readSourceMembership('feed-d'))!.incarnation;
    const first = await inTransaction(engine, 'feed-d', incarnation, null);
    const afterFirst = await stamps(engine, 'feed-d');
    // An offset converts as the ::timestamptz cast does.
    const offset = await inTransaction(engine, 'feed-d', incarnation, '2026-05-06T09:08:09+02:00');
    const afterOffset = await stamps(engine, 'feed-d');
    const kept = await inTransaction(engine, 'feed-d', incarnation, null);
    const afterKept = await stamps(engine, 'feed-d');
    const other = await inTransaction(engine, 'feed-d', OTHER_INCARNATION, '2027-01-01T00:00:00.000Z');
    const afterOther = await stamps(engine, 'feed-d');
    const out = { first, afterFirst, offset, afterOffset, kept, afterKept, other, afterOther };
    expect(out).toEqual({
      first: 'ok', afterFirst: { synced: true, newest: null },
      offset: 'ok', afterOffset: { synced: true, newest: '2026-05-06T07:08:09.000Z' },
      kept: 'ok', afterKept: { synced: true, newest: '2026-05-06T07:08:09.000Z' },
      other: 'ok', afterOther: { synced: true, newest: '2026-05-06T07:08:09.000Z' },
    });
    return out;
  });
});
