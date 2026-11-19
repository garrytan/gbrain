/**
 * BrainEngine parity: the doctor sync reads of engine-sql/doctor-sync.ts, which the sync checks and the readers they
 * share used to run through `engine.executeRaw` over `op_checkpoints`, `sources`, `pages`, `facts` and
 * `persistence_requests`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). The relations a Rust brain has no writer for (managed-sync
 *    cursors, failure rows and pass rows) read as the empty brain on every arm; the members the store serves are
 *    seeded through the engine's own writers.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status or message per
 *    backend: a Rust brain warned that its sync state "could not be read" where PGLite reported nothing to say.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('doctor sync reads', () => {
  parityTest(
    'the managed-sync cursor, orphan and durable-failure reads find no row on a brain nothing has written to',
    { methods: ['listManagedSyncCursorFailureRows', 'listManagedSyncOrphanRowsets', 'listDurableManagedSyncFailureKeys'] },
    async (engine) => {
      const empty = {
        cursors: await engine.listManagedSyncCursorFailureRows(null),
        cursorsScoped: await engine.listManagedSyncCursorFailureRows(['default']),
        orphans: await engine.listManagedSyncOrphanRowsets(null, 'moved'),
        orphansScoped: await engine.listManagedSyncOrphanRowsets(['default'], 'moved'),
        durable: await engine.listDurableManagedSyncFailureKeys(['default:1', 'default:2']),
      };
      const none = { cursors: [], failures: [], passes: [], retiredCursors: [], retiredFailures: [] };
      expect(empty).toEqual({ cursors: [], cursorsScoped: [], orphans: none, orphansScoped: none, durable: [] });
      return empty;
    },
  );
});
