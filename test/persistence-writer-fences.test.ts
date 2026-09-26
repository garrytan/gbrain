import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { addSource, removeSource, recloneIfMissing } from '../src/core/sources-ops.ts';
import { softDeleteSource, restoreSource, purgeExpiredSources } from '../src/core/destructive-guard.ts';
import { runGitHubSync } from '../src/core/github-source.ts';
import { runGoogleSync } from '../src/core/google/google-source.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import { pullRepo, cloneRepo } from '../src/core/git-remote.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { recordManagedRoots, registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { assertManagedFilesystemWrite, withFilesystemPublication } from '../src/core/persistence/filesystem-guard.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'writer-fence-example';
const home = mkdtempSync(join(tmpdir(), 'gbrain-writer-fences-'));
const root = join(home, '.gbrain', 'clones', sourceId);
beforeAll(async () => {
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'sentinel.md'), 'canonical sentinel');
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',
      [sourceId, root, JSON.stringify({ managed_clone: true, remote_url: 'https://example.com/brain.git' })]);
    await engine.executeRaw("INSERT INTO sources(id,name,archived,archive_expires_at) VALUES($1,$1,true,now()-interval '1 hour')", [`${sourceId}-expired`]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); await engine.disconnect();
  }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('unregistered source lifecycle and unsupported legacy writers refuse before deleting, cloning or provider work', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      // Managed lifecycle operations now exist, including authorized previews.
      // An unregistered caller must still fail before staging or provider work.
      for (const work of [
        () => removeSource(engine, { id: sourceId, dryRun: true }),
        () => removeSource(engine, { id: sourceId, yes: true }),
        () => recloneIfMissing(engine, sourceId),
        () => addSource(engine, { id: 'new-source', remoteUrl: 'https://example.com/brain.git' }),
        () => softDeleteSource(engine, sourceId), () => restoreSource(engine, sourceId),
      ]) await expect(work()).rejects.toMatchObject({ code: 'writer_registration_required' });
      const purge = await purgeExpiredSources(engine);
      expect(purge.purged).toEqual([]);
      expect(purge.blocked).toEqual([{ id: `${sourceId}-expired`, reason: 'This installation has no local writer registration.' }]);
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [`${sourceId}-expired`])).toHaveLength(1);
      expect(existsSync(join(home, '.gbrain', 'clones', 'new-source'))).toBe(false);
      for (const work of [
        () => runGitHubSync(engine, sourceId, {} as never, {} as never),
        () => runGoogleSync(engine, sourceId, {} as never, {} as never),
        () => importFromContent(engine, 'blocked', 'canonical material', { sourceId, noEmbed: true }),
        () => operationsByName.add_link!.handler({ engine, sourceId, remote: false, config: { engine: engine.kind }, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, { from: 'notes/example', to: 'notes/other' }),
        () => operationsByName.remove_link!.handler({ engine, sourceId, remote: false, config: { engine: engine.kind }, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, { from: 'notes/example', to: 'notes/other' }),
      ]) await expect(work()).rejects.toMatchObject({ code: 'writer_coordinator_required' });
      expect(readFileSync(join(root, 'sentinel.md'), 'utf8')).toBe('canonical sentinel');
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId])).toHaveLength(1);
    }
  });
});

test('free-text aliases and sync checkpoints require an authorized publication transaction', async () => {
  for (const engine of engines) {
    await expect(engine.executeRaw('INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES($1,$2,$3)',
      [sourceId, 'example alias', 'notes/example'])).rejects.toThrow('writer_coordinator_required');
    await expect(engine.executeRaw("UPDATE sources SET last_commit='unowned' WHERE id=$1", [sourceId])).rejects.toThrow('writer_coordinator_required');
    await expect(engine.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1', [sourceId])).rejects.toThrow('writer_coordinator_required');
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.executeRaw("UPDATE sources SET last_commit='owned' WHERE id=$1", [sourceId]);
      await tx.executeRaw('INSERT INTO page_aliases(source_id,alias_norm,slug) VALUES($1,$2,$3)', [sourceId, 'example alias', 'notes/example']);
    }));
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]))[0].last_commit).toBe('owned');
    await expect(engine.executeRaw("UPDATE sources SET last_commit='after-capability' WHERE id=$1", [sourceId])).rejects.toThrow('writer_coordinator_required');
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw('DELETE FROM page_aliases WHERE source_id=$1', [sourceId])));
  }
});

test('durable root records fence new processes, symlink aliases and separate user homes', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    recordManagedRoots(randomUUID(), [{ local_path: root, source_id: sourceId, topology_generation: 1 }]);
    const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, readdirSync(directory)[0])).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.gbrain-managed')).mode & 0o777).toBe(0o600);
    const alias = join(home, 'alias'); symlinkSync(root, alias, 'dir');
    for (const target of [root, join(home, '.gbrain', 'clones'), join(root, 'new-dir', 'page.md'), join(alias, 'page.md')]) {
      expect(() => assertManagedFilesystemWrite(target)).toThrow('managed canonical worktree');
    }
    expect(() => cloneRepo('https://example.com/brain.git', root)).toThrow('managed canonical worktree');
    expect(() => pullRepo(root)).toThrow('managed canonical worktree');
    await expect(hardenBrainRepo({ repoPath: root, sourceId })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    let inherited: (() => void) | undefined;
    await withFilesystemPublication([root], async () => {
      assertManagedFilesystemWrite(join(root, 'new.md'));
      inherited = () => assertManagedFilesystemWrite(join(root, 'new.md'));
    });
    expect(inherited).toThrow();
    const script = `import {assertManagedFilesystemWrite} from ${JSON.stringify(resolve('src/core/persistence/filesystem-guard.ts'))}; try { assertManagedFilesystemWrite(process.argv[1]); process.exit(3); } catch(e) { process.exit(e.code==='writer_coordinator_required' ? 0 : 4); }`;
    for (const childHome of [home, join(home, 'second-user')]) {
      const child = Bun.spawn([process.execPath, '-e', script, join(alias, 'new.md')], {
        env: { ...process.env, GBRAIN_HOME: childHome }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await child.exited).toBe(0);
    }
    writeFileSync(join(directory, 'broken.json'), '{');
    expect(() => registeredManagedRoots()).toThrow('records are unreadable');
    expect(existsSync(join(root, 'sentinel.md'))).toBe(true);
  });
});
