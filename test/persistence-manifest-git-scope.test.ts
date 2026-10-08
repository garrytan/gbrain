/**
 * #6099 (privacy): a Git checkout's writer manifest covers the files Git tracks, hashed from the working tree.
 * Gitignored files (secrets, build output) are never opened or hashed, so rebinding to a clean clone works
 * without copying them; a modified, missing or extra tracked file still refuses; a directory that is not a Git
 * checkout keeps the exact-copy manifest; a transfer an older release prepared in tree scope refuses with a
 * re-prepare fix instead of asking for ignored files; and migration v218 drops the legacy per-file maps.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isPhysicalRootMetadata } from '../src/core/persistence/physical-root.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { acceptWriterTransfer, getWorktreeBinding, prepareWriterTransfer, successorManifestMismatch, worktreeManifest } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { v218 } from '../src/core/schema-migrations/v218-purge-legacy-worktree-manifest-files.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function gitCheckout(root: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), '.env.local\nnode_modules/\n');
  writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
  writeFileSync(join(root, 'notes', 'acme-example.md'), '---\ntitle: Acme Example\n---\nA company.\n');
  writeFileSync(join(root, '.env.local'), 'API_TOKEN=not-a-real-token\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
}

test('git scope hashes tracked files only and never opens an ignored one', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-scope-'));
  try {
    const root = join(home, 'brain'); gitCheckout(root);
    // An unreadable ignored file would throw if it were opened.
    chmodSync(join(root, '.env.local'), 0o000);
    writeFileSync(join(root, 'notes', 'draft.md'), 'untracked, not ignored\n');
    const manifest = worktreeManifest(root);
    expect(manifest).toMatchObject({ scope: 'git', file_count: 3, untracked_count: 1 });
    const clone = join(home, 'clone'); execFileSync('git', ['clone', '-q', root, clone]);
    expect(worktreeManifest(clone).digest).toBe(manifest.digest);
    writeFileSync(join(clone, 'notes', 'alice-example.md'), 'changed\n');
    expect(worktreeManifest(clone).digest).not.toBe(manifest.digest);
    git(clone, 'checkout', '-q', '--', 'notes/alice-example.md');
    rmSync(join(clone, 'notes', 'acme-example.md'));
    expect(worktreeManifest(clone).digest).not.toBe(manifest.digest);
    // A plain directory nested inside an unrelated repository keeps the exact-copy tree scope.
    const nested = join(root, 'notes');
    expect(worktreeManifest(nested).scope).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('W4.4: a checkout Git cannot read refuses instead of hashing every file (ignored .env included)', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-damaged-'));
  try {
    const root = join(home, 'brain'); gitCheckout(root);
    writeFileSync(join(root, '.git', 'HEAD'), 'garbage\n');
    // An unreadable ignored file: a whole-tree fallback would open it.
    chmodSync(join(root, '.env.local'), 0o000);
    let thrown: unknown;
    try { worktreeManifest(root); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 'writer_manifest_unsafe' });
    expect((thrown as { fix?: { argv?: string[]; verify?: { argv?: string[] } } }).fix).toMatchObject({
      argv: ['git', '-C', realpathSync(root), 'status'], verify: { argv: ['git', '-C', realpathSync(root), 'rev-parse', '--show-toplevel'] } });
    // A plain directory (no .git) still takes the exact-copy tree scope.
    const plain = join(home, 'plain'); mkdirSync(plain); writeFileSync(join(plain, 'a.md'), 'a\n');
    expect(worktreeManifest(plain)).toMatchObject({ file_count: 1 });
    expect(worktreeManifest(plain).scope).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a tracked submodule or symlink refuses writer_manifest_unsafe', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-unsafe-'));
  try {
    const root = join(home, 'brain'); gitCheckout(root);
    execFileSync('ln', ['-s', 'alice-example.md', join(root, 'notes', 'link.md')]);
    git(root, 'add', 'notes/link.md');
    expect(() => worktreeManifest(root)).toThrow(expect.objectContaining({ code: 'writer_manifest_unsafe' }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an index entry that leaves the checkout refuses writer_manifest_unsafe and the outside file is never hashed', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-escape-'));
  try {
    const root = join(home, 'brain'); gitCheckout(root);
    writeFileSync(join(home, 'secret'), 'NOT-A-REAL-SECRET\n');
    // A hand-edited index (git itself refuses such paths) names ../secret instead of a same-length tracked path.
    mkdirSync(join(root, 'zz')); writeFileSync(join(root, 'zz', 'secret'), 'tracked\n'); git(root, 'add', 'zz/secret');
    const index = readFileSync(join(root, '.git', 'index'));
    const body = Buffer.from(index.subarray(0, index.length - 20).toString('latin1').replace('zz/secret', '../secret'), 'latin1');
    writeFileSync(join(root, '.git', 'index'), Buffer.concat([body, createHash('sha1').update(body).digest()]));
    expect(git(root, 'ls-files')).toContain('../secret');
    expect(() => worktreeManifest(root, { withFiles: true })).toThrow(expect.objectContaining({ code: 'writer_manifest_unsafe' }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a tree-scope transfer an older release prepared refuses with a re-prepare fix on a Git successor', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-rescope-'));
  try {
    const root = join(home, 'clone'); gitCheckout(root);
    const legacy = { digest: 'a'.repeat(64), file_count: 5 };
    const error = successorManifestMismatch('notes-example', root, legacy.digest, legacy, worktreeManifest(root, { scope: 'tree' }));
    expect(error).toMatchObject({ code: 'writer_manifest_rescope_required' });
    expect((error as { fix?: { argv: string[] } }).fix?.argv.slice(0, 6)).toEqual(['gbrain', 'sources', 'writer', 'transfer', 'prepare', 'notes-example']);
    expect(error.suggestion).toContain('Do not copy ignored files');
    const current = successorManifestMismatch('notes-example', root, 'b'.repeat(64), { ...legacy, scope: 'git' }, worktreeManifest(root));
    expect(current).toMatchObject({ code: 'writer_manifest_mismatch' });
    expect(current.suggestion).toContain('git clone');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const backend of testBackends()) describe(`#6099 git-scoped manifests (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

  async function fixture(run: (home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-manifest-git-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        if (backend === 'pglite') await resetPgliteState(engine as PGLiteEngine);
        await registerLocalWriter(engine, 'cli');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try { await run(home); } finally { await disposePersistenceConsumer(engine); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const sourceId = (name: string) => `${name}-${backend}`;

  test('set-path to a clean clone commits without the ignored files; a changed tracked file names its path', () => fixture(async home => {
    const id = sourceId('git-rebind');
    const root = join(home, 'brain'); gitCheckout(root);
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id, path: root })).toMatchObject({ state: 'committed' });
    const [stored] = await engine.executeRaw<{ manifest: Record<string, unknown> }>(
      'SELECT w.manifest FROM persistence_worktrees w JOIN persistence_source_bindings b ON b.worktree_id=w.id WHERE b.source_id=$1', [id]);
    expect(stored?.manifest).toMatchObject({ scope: 'git', file_count: 3 });
    expect(JSON.stringify(stored?.manifest)).not.toContain('.env.local');

    const dirty = join(home, 'dirty'); execFileSync('git', ['clone', '-q', root, dirty]);
    writeFileSync(join(dirty, 'notes', 'acme-example.md'), 'edited\n');
    await expect(runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: id, path: dirty }))
      .rejects.toMatchObject({ code: 'writer_manifest_mismatch', suggestion: expect.stringContaining('notes/acme-example.md') });

    const clone = join(home, 'clone'); execFileSync('git', ['clone', '-q', root, clone]);
    expect(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: id, path: clone })).toMatchObject({ state: 'committed' });
    expect((await getWorktreeBinding(engine, id))?.local_path).toBe(clone);
  }), 120_000);

  test('a directory that is not a Git checkout keeps exact-copy semantics', () => fixture(async home => {
    const id = sourceId('tree-rebind');
    const root = join(home, 'plain'); mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'alice-example.md'), 'one\n');
    writeFileSync(join(root, '.env.local'), 'API_TOKEN=not-a-real-token\n');
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id, path: root })).toMatchObject({ state: 'committed' });
    const partial = join(home, 'partial');
    cpSync(root, partial, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) && basename(path) !== '.env.local' });
    await expect(runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: id, path: partial })).rejects.toMatchObject({ code: 'writer_manifest_mismatch' });
    writeFileSync(join(partial, '.env.local'), 'API_TOKEN=not-a-real-token\n');
    expect(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: id, path: partial })).toMatchObject({ state: 'committed' });
  }), 120_000);

  test('an in-flight transfer prepared in tree scope before the upgrade refuses with a re-prepare fix; re-prepared, a clean clone accepts', () => fixture(async home => {
    const id = sourceId('legacy-transfer');
    const root = join(home, 'owner'); gitCheckout(root);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id, path: root });
    const prepared = await prepareWriterTransfer(engine, id);
    // What an older release stored: the tree-scope digest over every file, ignored ones included, without a scope.
    const legacy = worktreeManifest(root, { scope: 'tree' });
    expect(legacy.scope).toBeUndefined();
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [prepared.worktree_id, JSON.stringify(legacy)]);
    const clone = join(home, 'successor'); execFileSync('git', ['clone', '-q', root, clone]);
    await expect(acceptWriterTransfer(engine, id, clone, prepared.owner_epoch, legacy.digest)).rejects.toMatchObject({ code: 'writer_manifest_rescope_required' });
    const again = await prepareWriterTransfer(engine, id);
    expect(again.manifest).toMatchObject({ scope: 'git', file_count: 3 });
    await acceptWriterTransfer(engine, id, clone, again.owner_epoch, again.manifest.digest);
    expect((await getWorktreeBinding(engine, id))?.local_path).toBe(clone);
  }), 120_000);

  test('migration v218 drops legacy per-file manifest maps and keeps the count; a rerun changes nothing', () => fixture(async home => {
    const id = sourceId('legacy-map');
    const root = join(home, 'legacy'); gitCheckout(root);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id, path: root });
    const [binding] = await engine.executeRaw<{ worktree_id: string }>('SELECT worktree_id::text FROM persistence_source_bindings WHERE source_id=$1', [id]);
    const legacy = { digest: 'c'.repeat(64), files: { '.env.local': 'd'.repeat(64), 'notes/a.md': 'e'.repeat(64) }, canonical_stamp: 'stamp' };
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [binding!.worktree_id, JSON.stringify(legacy)]);
    await engine.executeRaw(`INSERT INTO persistence_topology_changes(principal_id,request_id,digest,operation,source_id,state,recovery)
      VALUES(gen_random_uuid(),gen_random_uuid(),'legacy','reclone',$1,'recovering',$2::text::jsonb)`,
      [id, JSON.stringify({ kind: 'clone', manifest: { digest: 'f'.repeat(64), files: { '.env.local': 'd'.repeat(64) } } })]);
    await engine.transaction(tx => tx.runMigration(v218.version, v218.sql));
    const [after] = await engine.executeRaw<{ manifest: Record<string, unknown> }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding!.worktree_id]);
    expect(after?.manifest).toEqual({ digest: 'c'.repeat(64), file_count: 2, canonical_stamp: 'stamp' });
    const [record] = await engine.executeRaw<{ manifest: Record<string, unknown> }>(`SELECT recovery->'manifest' AS manifest FROM persistence_topology_changes WHERE source_id=$1 AND digest='legacy'`, [id]);
    expect(record?.manifest).toEqual({ digest: 'f'.repeat(64), file_count: 1 });
    await engine.executeRaw(`DELETE FROM persistence_topology_changes WHERE source_id=$1 AND digest='legacy'`, [id]);
    await engine.transaction(tx => tx.runMigration(v218.version, v218.sql));
    const [again] = await engine.executeRaw<{ manifest: Record<string, unknown> }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding!.worktree_id]);
    expect(again?.manifest).toEqual(after!.manifest);
  }), 120_000);
});
