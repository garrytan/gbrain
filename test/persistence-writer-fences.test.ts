import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { addSource, removeSource, recloneIfMissing } from '../src/core/sources-ops.ts';
import { softDeleteSource, restoreSource, purgeExpiredSources } from '../src/core/destructive-guard.ts';
import { runGitHubSync } from '../src/core/github-source.ts';
import { runGoogleSync } from '../src/core/google/google-source.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { pullRepo, cloneRepo } from '../src/core/git-remote.ts';
import { hardenBrainRepo } from '../src/core/brain-repo-durability.ts';
import { recordManagedRoots, registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { assertManagedFilesystemWrite, withFilesystemPublication } from '../src/core/persistence/filesystem-guard.ts';
// Namespace import: a missing export fails only the tests that use it.
import * as guard from '../src/core/persistence/filesystem-guard.ts';
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
    // Non-git managed root: there is nothing to opt in, so the retained refusal stays (managed git roots take the opt-in-only profile).
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

/** A managed GIT worktree under an isolated home, recorded the way activation records it. */
function managedGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-git-fence-'));
  const gitHome = join(dir, 'home');
  const worktree = join(gitHome, '.gbrain', 'clones', 'git-fence-example');
  mkdirSync(worktree, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { stdio: 'ignore' });
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t.t'); run('config', 'user.name', 'tester');
  writeFileSync(join(worktree, 'README.md'), 'init\n'); run('add', 'README.md'); run('commit', '-qm', 'init');
  return { dir, gitHome, worktree, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('isManagedFilesystemPath is the exact predicate assertManagedFilesystemWrite enforces', async () => {
  const f = managedGitFixture();
  try {
    await withEnv({ GBRAIN_HOME: f.gitHome }, async () => {
      recordManagedRoots(randomUUID(), [{ local_path: f.worktree, source_id: 'git-fence-example', topology_generation: 1 }]);
      const alias = join(f.dir, 'alias'); symlinkSync(f.worktree, alias, 'dir');
      const unmanaged = join(f.dir, 'elsewhere'); mkdirSync(unmanaged);
      const targets = [f.worktree, join(f.worktree, 'notes', 'page.md'), join(f.worktree, '.git', 'config'),
        join(f.worktree, '.git', 'hooks', 'post-commit'), join(alias, 'page.md'), join(f.gitHome, '.gbrain', 'clones'), join(unmanaged, 'page.md'), unmanaged];
      const expected = [true, true, true, true, true, true, false, false];
      expect(targets.map(target => guard.isManagedFilesystemPath(target))).toEqual(expected);
      for (const [index, target] of targets.entries()) {
        if (expected[index]) expect(() => assertManagedFilesystemWrite(target)).toThrow('managed canonical worktree');
        else expect(() => assertManagedFilesystemWrite(target)).not.toThrow();
      }
      // A held publication capability changes the guard verdict, never the predicate.
      await withFilesystemPublication([f.worktree], async () => {
        expect(() => assertManagedFilesystemWrite(join(f.worktree, 'notes', 'page.md'))).not.toThrow();
        expect(guard.isManagedFilesystemPath(join(f.worktree, 'notes', 'page.md'))).toBe(true);
      });
      expect(() => assertManagedFilesystemWrite(join(f.worktree, 'notes', 'page.md'))).toThrow('managed canonical worktree');
    });
  } finally { f.cleanup(); }
});

test('an unreadable managed-root registry makes the predicate throw instead of guessing', async () => {
  const f = managedGitFixture();
  try {
    await withEnv({ GBRAIN_HOME: f.gitHome }, async () => {
      const registry = join(f.gitHome, '.gbrain', 'persistence', 'managed-roots');
      mkdirSync(registry, { recursive: true }); writeFileSync(join(registry, 'broken.json'), '{');
      expect(() => guard.isManagedFilesystemPath(join(f.dir, 'elsewhere', 'page.md'))).toThrow('records are unreadable');
    });
  } finally { f.cleanup(); }
});

test('managed git harden only opts in: the fence still refuses scripts, rules, pages and hooks afterwards', async () => {
  const f = managedGitFixture();
  try {
    await withEnv({ GBRAIN_HOME: f.gitHome, HOME: f.gitHome }, async () => {
      recordManagedRoots(randomUUID(), [{ local_path: f.worktree, source_id: 'git-fence-example', topology_generation: 1 }]);
      const report = await hardenBrainRepo({ repoPath: f.worktree, sourceId: 'git-fence-example', verify: false, installCron: false });
      expect(report.steps.find(step => step.step === 'outbox')).toMatchObject({ status: 'fixed' });
      expect(existsSync(join(f.worktree, 'scripts'))).toBe(false);
      expect(existsSync(join(f.worktree, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(f.worktree, '.git', 'hooks', 'post-commit'))).toBe(false);
      for (const target of [join(f.worktree, 'scripts', 'brain-commit-push.sh'), join(f.worktree, 'AGENTS.md'), join(f.worktree, 'RESOLVER.md'),
        join(f.worktree, 'notes', 'page.md'), join(f.worktree, '.git', 'hooks', 'post-commit')]) {
        expect(() => assertManagedFilesystemWrite(target)).toThrow('managed canonical worktree');
      }
    });
  } finally { f.cleanup(); }
});
