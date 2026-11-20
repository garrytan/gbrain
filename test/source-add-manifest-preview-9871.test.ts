import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { executeSourceLifecycle } from '../src/commands/sources-lifecycle.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, rel: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) result[rel] = `link:${readlinkSync(path)}`;
    else if (info.isDirectory()) {
      result[rel] = 'directory';
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${rel}/${name}`);
    } else result[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  visit(root, '');
  return result;
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-C', root, ...args], { stdio: 'pipe' });
}

for (const backend of testBackends()) describe(`#9871 source add manifest preview (${backend})`, () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-add-preview-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });
  async function fixture(run: (root: string, source: string) => Promise<void>) {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      localHostId();
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const source = `preview-${randomUUID().slice(0, 8)}`, root = join(home, source);
      mkdirSync(root);
      try { await run(root, source); } finally { await disposePersistenceConsumer(engine); }
    });
  }
  async function rows() {
    const result: Record<string, unknown> = {};
    for (const table of ['sources', 'persistence_source_bindings', 'persistence_host_bindings', 'persistence_worktrees', 'persistence_topology_changes', 'persistence_requests']) {
      result[table] = await engine.executeRaw(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`);
    }
    return result;
  }

  test('a tracked symlink outside the named folder refuses both preview and add, naming the enclosing checkout', () => fixture(async (root, source) => {
    const path = join(root, 'run', 'pages'); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'page.md'), '# Page\n');
    git(root, 'init', '-q');
    symlinkSync('run/pages/page.md', join(root, 'tool'));
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
    const before = await rows(), bytes = tree(home), checkout = tree(root);
    for (const dryRun of [true, false]) {
      const run = dryRun
        ? executeSourceLifecycle(engine, parseSourceLifecycleArgs(['add', source, '--path', path, '--force', '--no-federated', '--dry-run', '--json']))
        : runManagedSourceLifecycle(engine, managedSourceAddInput({ id: source, localPath: path, force: true, federated: false }));
      const error = await run.then(() => null, error => error);
      expect(error).toMatchObject({ code: 'writer_manifest_unsafe' });
      expect(error.message).toContain(root);
      expect(error.suggestion).toContain('tool');
      expect(error.suggestion).toContain('outside');
      expect(await rows()).toEqual(before);
      // Apply may create coordination lock directories, but never checkout bytes or a source binding.
      expect(tree(root)).toEqual(checkout);
      if (dryRun) expect(tree(home)).toEqual(bytes);
    }
  }));

  test('a safe nested checkout preview discloses the whole-repository binding and does not enroll it', () => fixture(async (root, source) => {
    const path = join(root, 'pages'); mkdirSync(path);
    writeFileSync(join(path, 'page.md'), '# Page\n');
    writeFileSync(join(root, 'README'), 'Other repository content\n');
    git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
    const before = await rows(), bytes = tree(home);
    const result = await executeSourceLifecycle(engine, parseSourceLifecycleArgs(['add', source, '--path', path, '--force', '--no-federated', '--dry-run', '--json']));
    expect(result).toMatchObject({ dry_run: true, path, worktree_path: root, manifest_scope: 'git' });
    expect(String(result.warning)).toContain('outside');
    expect(await rows()).toEqual(before); expect(tree(home)).toEqual(bytes);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path });
    expect(await getWorktreeBinding(engine, source)).toMatchObject({ local_path: root, relative_path: 'pages' });
  }));

  test('preview success is not reused when a tracked symlink appears before apply', () => fixture(async (root, source) => {
    writeFileSync(join(root, 'page.md'), '# Page\n');
    git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root, dryRun: true });
    symlinkSync('page.md', join(root, 'late-link')); git(root, 'add', 'late-link');
    await expect(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root })).rejects.toMatchObject({ code: 'writer_manifest_unsafe' });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [source])).toEqual([]);
  }));

  test('an existing enclosing worktree is checked and reported, not only a nested repository', () => fixture(async (root, source) => {
    const first = join(root, 'first'), nested = join(root, 'nested');
    mkdirSync(first); mkdirSync(nested);
    writeFileSync(join(first, 'page.md'), '# First\n');
    git(root, 'init', '-q'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'outer');
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: `${source}-old`, path: first });
    writeFileSync(join(nested, 'page.md'), '# Nested\n');
    git(nested, 'init', '-q'); git(nested, 'add', '.'); git(nested, 'commit', '-qm', 'inner');
    const before = await rows(), bytes = tree(home);
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: nested, dryRun: true })).toMatchObject({ worktree_path: root, manifest_scope: 'git' });
    expect(await rows()).toEqual(before); expect(tree(home)).toEqual(bytes);
    symlinkSync('first/page.md', join(root, 'outer-link')); git(root, 'add', 'outer-link');
    const afterEdit = await rows(), editedBytes = tree(home), editedCheckout = tree(root);
    for (const dryRun of [true, false]) {
      await expect(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: nested, dryRun })).rejects.toMatchObject({ code: 'writer_manifest_unsafe' });
      expect(await rows()).toEqual(afterEdit);
      expect(tree(root)).toEqual(editedCheckout);
      if (dryRun) expect(tree(home)).toEqual(editedBytes);
    }
  }));

  test('plain directories remain tree-scoped and missing create-directory previews do not create files', () => fixture(async (root, source) => {
    writeFileSync(join(root, 'page.md'), '# Page\n');
    const before = await rows(), bytes = tree(home);
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: source, path: root, dryRun: true })).toMatchObject({ worktree_path: root, manifest_scope: 'tree' });
    const missing = join(home, `${source}-missing`);
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: `${source}-new`, path: missing, createDirectory: true, dryRun: true })).toMatchObject({ dry_run: true, worktree_path: missing });
    expect(existsSync(missing)).toBe(false); expect(await rows()).toEqual(before); expect(tree(home)).toEqual(bytes);
  }));
});
