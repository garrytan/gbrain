/**
 * #6849: `sources remove --dry-run` and `sources set-path --dry-run` returned before the physical-root check the real
 * run makes in withTopologyLocks, so a recreated checkout passed the dry run and the real command refused
 * `recovery_required`. The dry run now runs the same check, read-only: no lock, stamp, reservation or row is written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const kind of testBackends()) describe(`#6849 lifecycle dry runs check the physical root (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-dry-root-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  test('a recreated checkout refuses the remove and set-path dry runs like the real run, and the dry runs write nothing', async () => {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `dry-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      const remove = () => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: source, dryRun: true });
      const setPath = () => runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: source, path: root, dryRun: true });
      expect(await remove()).toMatchObject({ dry_run: true, operation: 'remove', source_id: source });
      expect(await setPath()).toMatchObject({ dry_run: true, operation: 'rebind', source_id: source });

      const marker = join(root, PHYSICAL_ROOT_MARKER);
      const stamp = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(marker, JSON.stringify({ ...stamp, birth: (BigInt(stamp.birth) - 5_000_000_000n).toString() }), { mode: 0o600 });
      const markerBytes = readFileSync(marker, 'utf8');
      const reservationBytes = readFileSync(physicalRootReservationPath(root), 'utf8');
      const rows = async () => engine.executeRaw('SELECT b.*, w.state, w.owner_epoch FROM persistence_source_bindings b JOIN persistence_worktrees w ON w.id=b.worktree_id WHERE b.source_id=$1', [source]);
      const before = await rows();

      for (const run of [remove, setPath]) {
        const error = await run().then(() => null, (e: { code?: string; detail?: string; suggestion?: string }) => e);
        expect(error).toMatchObject({ code: 'recovery_required', detail: 'physical_root_directory_changed' });
        expect(error!.suggestion).toContain('--self-transfer --confirm-relocated-root');
      }
      expect(readFileSync(marker, 'utf8')).toBe(markerBytes);
      expect(readFileSync(physicalRootReservationPath(root), 'utf8')).toBe(reservationBytes);
      expect(await rows()).toEqual(before);
      expect(await getWorktreeBinding(engine, source)).toMatchObject({ local_path: root, state: 'active' });
      await disposePersistenceConsumer(engine);
    });
  }, 120_000);
});
