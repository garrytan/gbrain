/**
 * BrainEngine parity — the connect gate's persistence reads (engine-sql/connect-gate.ts): the persistence table
 * probe, the managed root bindings, the graduation custody row and the committed writer deactivations.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: hasPersistenceTable, listManagedRootBindings, readGraduationGateRow and listRetiredDeactivations
 *    answer the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) for a fresh, unmanaged brain: every persistence table is present, the roots are
 *    the sources with a local path (archived ones too) with no worktree, there is no custody row (with or without
 *    the run setting) and no retired deactivation. Once an unmanaged claim binds a worktree on this host
 *    (worktreeClaimStore), the roots add that worktree's root for each source bound under it.
 *  - Regression: an engine that answers one of these differently either refuses every connect and every write's
 *    admission (a custody row that is not there, a missing table read as an error) or records the wrong managed
 *    roots (a source path dropped, an archived checkout no longer guarded); the Rust engine has no SQL, so each
 *    statement has to exist as a typed member.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside filesystem-guard.ts,
 *    graduation-schema.ts, graduation-custody.ts and deactivation.ts, which the parity cases cannot call (D18), and
 *    the Rust engine skipped two of them with a raw-SQL capability check.
 *    The last two cases run the gates themselves (the connect row, the connect check, the table probe and the
 *    retired-marker cleanup), which read through these members on every arm.
 *  - Seam: none. Real engines, typed reads only; sources are made and archived through the harness fixtures, and an
 *    incarnation is compared with the one `readSourceIncarnation` reports.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { cleanupRetiredManagedMarkers } from '../../src/core/persistence/deactivation.ts';
import { assertGraduationConnectAllowed } from '../../src/core/persistence/graduation-custody.ts';
import { graduationTablePresent, readGraduationConnectRow } from '../../src/core/persistence/graduation-schema.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST = '00000000-0000-4000-8000-0000000000a1';
const OTHER_HOST = '00000000-0000-4000-8000-0000000000b2';

describe('engine parity: connect gate persistence reads', () => {
  parityTest('hasPersistenceTable finds every persistence table the connect gate probes', {
    methods: ['hasPersistenceTable'],
  }, async (engine) => {
    const answers = {
      brain: await engine.hasPersistenceTable('persistence_brain'),
      topology: await engine.hasPersistenceTable('persistence_topology_changes'),
      graduation: await engine.hasPersistenceTable('persistence_graduation'),
    };
    expect(answers).toEqual({ brain: true, topology: true, graduation: true });
    return answers;
  });

  parityTest('listManagedRootBindings lists every source with a local path, archived ones too, with no worktree', {
    methods: ['listManagedRootBindings', 'readSourceIncarnation'],
  }, async (engine, backend) => {
    const before = await engine.listManagedRootBindings(HOST);
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    await createSource(engine, backend, 'nopath');
    await archiveSource(engine, backend, 'beta');
    const rows = sorted(await engine.listManagedRootBindings(HOST), (r) => r.source_id);
    const view = [];
    for (const row of rows) {
      const incarnation = (await engine.readSourceIncarnation(row.source_id))?.incarnation;
      view.push({ ...row, source_incarnation: row.source_incarnation === incarnation ? 'matches' : row.source_incarnation });
    }
    const answers = { before, rows: view };
    expect(answers).toEqual({
      before: [],
      rows: [
        { local_path: '/srv/brain/alpha', source_id: 'alpha', source_incarnation: 'matches', worktree_id: null, topology_generation: null },
        { local_path: '/srv/brain/beta', source_id: 'beta', source_incarnation: 'matches', worktree_id: null, topology_generation: null },
      ],
    });
    return answers;
  });

  // An unmanaged claim binds a worktree on this host (worktreeClaimStore, as persistence/ownership.ts claimWorktree
  // does): the host's bound sources come first in the UNION, at the worktree's root, next to the source's own path row.
  parityTest('listManagedRootBindings adds this host\'s claimed worktree roots and leaves another host with the path rows', {
    methods: ['listManagedRootBindings', 'worktreeClaimStore', 'readSourceIncarnation'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work', {}, '/srv/brain/root/work');
    const worktreeId = randomUUID();
    await claimWorktreeBinding(engine, async store => {
      const source = await store.lockSource('work');
      await store.insertWorktree({ id: worktreeId, ownerHostId: HOST, ownerEpoch: 1 });
      await store.insertHostBinding({ worktreeId, hostId: HOST, localPath: '/srv/brain/root', coordinationPath: '/srv/brain/coord' });
      await store.insertSourceBinding({ sourceId: 'work', incarnation: source!.incarnation, worktreeId, relativePath: 'work' });
    });
    const incarnation = (await engine.readSourceIncarnation('work'))?.incarnation;
    const view = (rows: Awaited<ReturnType<BrainEngine['listManagedRootBindings']>>) => sorted(rows.map(row => ({
      ...row, source_incarnation: row.source_incarnation === incarnation ? 'matches' : row.source_incarnation,
      worktree_id: row.worktree_id === worktreeId ? 'claimed' : row.worktree_id,
      topology_generation: row.topology_generation == null ? null : String(row.topology_generation),
    })), (r) => r.local_path);
    const answers = { host: view(await engine.listManagedRootBindings(HOST)), otherHost: view(await engine.listManagedRootBindings(OTHER_HOST)) };
    const pathRow = { local_path: '/srv/brain/root/work', source_id: 'work', source_incarnation: 'matches', worktree_id: null, topology_generation: null };
    expect(answers).toEqual({
      host: [{ local_path: '/srv/brain/root', source_id: 'work', source_incarnation: 'matches', worktree_id: 'claimed', topology_generation: '1' }, pathRow],
      otherHost: [pathRow],
    });
    return answers;
  });

  parityTest('readGraduationGateRow finds no custody row on a brain no graduation touched, with or without the run setting', {
    methods: ['readGraduationGateRow'],
  }, async (engine) => {
    const answers = {
      connect: await engine.readGraduationGateRow(),
      admission: await engine.readGraduationGateRow({ withRunSetting: true }),
    };
    expect(answers).toEqual({ connect: null, admission: null });
    return answers;
  });

  parityTest('listRetiredDeactivations is empty on a brain that was never managed', {
    methods: ['listRetiredDeactivations'],
  }, async (engine) => {
    const rows = await engine.listRetiredDeactivations();
    expect(rows).toEqual([]);
    return rows;
  });

  parityTest('the graduation connect gate admits a brain no graduation touched', {
    methods: ['readGraduationGateRow', 'hasPersistenceTable'],
  }, async (engine) => {
    const answers = {
      row: await readGraduationConnectRow(engine),
      allowed: await assertGraduationConnectAllowed(engine, {}).then(() => true),
      table: await graduationTablePresent(engine),
    };
    expect(answers).toEqual({ row: null, allowed: true, table: true });
    return answers;
  });

  parityTest('retired managed-marker cleanup has nothing to clean on a brain that was never managed', {
    methods: ['hasPersistenceTable', 'listRetiredDeactivations'],
  }, async (engine) => {
    const report = await cleanupRetiredManagedMarkers(engine);
    expect(report).toEqual({ state: 'cleared', removed: [], pending: [] });
    return report;
  });
});
