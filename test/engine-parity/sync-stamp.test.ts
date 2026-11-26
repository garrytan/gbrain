/**
 * Parity for a managed sync's freshness stamp (persistence/sync-pass-run.ts `stampManagedSourceFresh`): the step a managed
 * `gbrain sync` that found nothing new runs inside its coordinated-write transaction (sync-run.ts, a complete check that
 * found nothing; sync-pass-run.ts, an idle tick and an unchanged pass).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the stamp sets `last_sync_at` of a source still of the run's incarnation, and leaves a source of another incarnation,
 *    or an unknown source, as it was.
 *  - Regression: the stamp ran as raw SQL (`UPDATE sources SET last_sync_at=now() ...`), which the Rust engine refuses
 *    (engine_capability_missing), so the step of a no-change managed sync failed on a Rust brain and its source kept
 *    reading as stale. The step now calls `markSourceSynced(sourceId, { incarnation })`.
 *  - Whole managed sync: a reviewed claim and activate, then `performSync` twice on a one-note Git checkout. The first
 *    sync imports the note and stamps `last_sync_at`; the second finds nothing new, answers `up_to_date` and moves the
 *    stamp. A Rust brain activates, but its managed sync refuses by name before discovery (performManagedSync,
 *    capability managed_persistence: refused by design on Rust, B2), so the Rust arm counts that case as a named stop
 *    and checks that nothing was imported or stamped. The day Rust carries managed sync, the stop turns into a failure
 *    ("no longer stops on a refusal") and the case must compare equal.
 *  - Why existing coverage misses it: import-folder-stamp.test.ts covers `markSourceSynced` alone, and the managed sync
 *    suites run PGLite and Postgres only.
 *  - Seam: the first case calls the step the managed sync calls, inside the same coordinated-write transaction shape.
 *    The second runs the whole sync with no seam. Times differ per run, so the cases compare whether the stamp is set
 *    or later, never its value.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { readPersistenceBrain } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
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
    methods: ['insertSource', 'readSourceMembership', 'getSource', 'markSourceSynced'],
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

  parityTest('a whole managed sync imports the checkout, then a no-change sync answers up_to_date and moves last_sync_at', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'writerReleaseStore', 'getSource', 'markSourceSynced'],
    requires: 'managed_persistence',
    timeout: 180_000,
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sync-stamp-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'checkout');
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
        await createSource(engine, backend, 'work', {}, root);
        try {
          const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
          await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
          await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
          const managed = (await readPersistenceBrain(engine)).enabled;
          // The raw error rides along unseen by toEqual, so the Rust arm can rethrow its typed refusal.
          const sync = () => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true })
            .then(r => ({ status: r.status as string }), (error: { code?: string }) =>
              Object.defineProperty({ status: `refused: ${error?.code ?? String(error)}` }, 'error', { value: error, enumerable: false }));
          const first = await sync();
          // With the hold lifted on this test engine (GBRAIN_TEST_RUST_MANAGED=1, rust-managed.ts) the sync runs for real;
          // a step it still meets that the Rust store does not serve ends the case as stopped, never as equal (LM slice 2).
          const lifted = backend === 'rust' && engine.capabilities?.has('managed_persistence') === true;
          const firstError = (first as { error?: { code?: string } }).error;
          if (lifted && firstError?.code === 'engine_capability_missing') throw firstError;
          if (backend === 'rust' && !lifted) {
            // Named stop, by design (Garry, B2, Nov 22): managed_persistence refused by design on Rust (B2) until the
            // Rust engine carries managed mode. The brain activates, and its first managed sync refuses by name at
            // performManagedSync (sync-run.ts, requireManagedPersistence) before discovery, so nothing is imported or
            // stamped. A capability refusal takes the in-test pin (harness.ts: assert the refusal, rethrow it), so the
            // Rust arm counts the case as stopped and never as equal.
            const refusal = (first as { error?: { detail?: unknown } }).error;
            const stopped = { managed, first: first.status, page: (await engine.getPage('notes/alice-example', { sourceId: 'work' })) !== null,
              stamped: (await engine.getSource('work'))?.last_sync_at != null,
              managedPersistence: String(refusal?.detail ?? '').includes('capability=managed_persistence') };
            expect(stopped, 'managed_persistence refused by design on Rust (B2)').toEqual(
              { managed: true, first: 'refused: engine_capability_missing', page: false, stamped: false, managedPersistence: true });
            throw refusal;
          }
          const title = (await engine.getPage('notes/alice-example', { sourceId: 'work' }))?.title ?? null;
          const firstStamp = (await engine.getSource('work'))?.last_sync_at ?? null;
          // last_sync_at is the database clock; wait past its resolution so a second stamp reads as later.
          await Bun.sleep(1100);
          const second = await sync();
          const secondStamp = (await engine.getSource('work'))?.last_sync_at ?? null;
          const moved = firstStamp !== null && secondStamp !== null && new Date(secondStamp).getTime() > new Date(firstStamp).getTime();
          const out = { managed, first: ['first_sync', 'synced'].includes(first.status) ? 'imported' : first.status, title,
            stampedFirst: firstStamp !== null, second: second.status, moved };
          expect(out).toEqual({ managed: true, first: 'imported', title: 'Alice Example', stampedFirst: true, second: 'up_to_date', moved: true });
          return out;
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
