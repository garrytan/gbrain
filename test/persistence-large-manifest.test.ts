/**
 * #5790: stored worktree manifests carry a digest and a file count instead of
 * the per-file map, so brains past ~10k files can be added, claimed, rebound,
 * archived, removed, cloned, recloned and transferred.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isPhysicalRootMetadata } from '../src/core/persistence/physical-root.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding, worktreeManifest } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { topologyPrincipal } from '../src/core/persistence/topology-locks.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { largeBareRepository, writeLargeWorktree } from './helpers/large-worktree.ts';

const FILES = 12_000;
const REMOTE = 'https://example.invalid/large-brain.git';

for (const backend of testBackends()) describe(`large worktree manifests (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

  async function fixture(run: (home: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-large-manifest-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await resetPgliteState(engine as PGLiteEngine);
        await registerLocalWriter(engine, 'cli');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try { await run(home); } finally { await disposePersistenceConsumer(engine); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  async function storedManifest(sourceId: string) {
    const [row] = await engine.executeRaw<{ manifest: Record<string, unknown> | string | null }>(`SELECT w.manifest FROM persistence_worktrees w
      JOIN persistence_source_bindings b ON b.worktree_id=w.id WHERE b.source_id=$1`, [sourceId]);
    return typeof row?.manifest === 'string' ? JSON.parse(row.manifest) : row?.manifest ?? null;
  }
  async function expectCompact(sourceId: string, root: string, count = FILES) {
    const manifest = await storedManifest(sourceId);
    expect(manifest).toMatchObject({ digest: worktreeManifest(root).digest, file_count: count });
    expect(manifest.files).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(4096);
    return manifest;
  }
  const insertSource = (id: string, path: string) => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, path]);
  });
  const copyWorktree = (from: string, to: string) => cpSync(from, to, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) && basename(path) !== '.git' });

  test('a 12k-file source can be added, claimed, rebound, archived, restored and removed', () => fixture(async home => {
    const root = join(home, 'added');
    writeLargeWorktree(root, FILES);
    expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'large-added', path: root })).toMatchObject({ state: 'committed' });
    await expectCompact('large-added', root);

    const claimed = join(home, 'claimed');
    writeLargeWorktree(claimed, FILES);
    await insertSource('large-claimed', claimed);
    expect((await claimWorktree(engine, 'large-claimed', claimed)).local_path).toBe(claimed);
    await expectCompact('large-claimed', claimed);

    const candidate = join(home, 'candidate');
    copyWorktree(root, candidate);
    const deleted = join(candidate, 'notes', 'batch-000', 'example-note-000007.md');
    rmSync(deleted);
    await expect(runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'large-added', path: candidate })).rejects.toMatchObject({ code: 'writer_manifest_mismatch' });
    cpSync(join(root, 'notes', 'batch-000', 'example-note-000007.md'), deleted);
    expect(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'large-added', path: candidate })).toMatchObject({ state: 'committed' });
    expect((await getWorktreeBinding(engine, 'large-added'))!.local_path).toBe(candidate);
    await expectCompact('large-added', candidate);

    expect(await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'large-added' })).toMatchObject({ state: 'committed' });
    expect(await runManagedSourceLifecycle(engine, { operation: 'restore', sourceId: 'large-added' })).toMatchObject({ state: 'committed' });
    expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'large-added', confirmDestructive: true })).toMatchObject({ state: 'committed', storage_retained: true });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['large-added'])).toHaveLength(0);
  }), 240_000);

  test('a 12k-file repository clones and reclones from a local bare repository', () => fixture(async home => {
    const bare = largeBareRepository(home, FILES);
    const target = join(home, 'cloned');
    const clone = async (_url: string, stage: string) => { execFileSync('git', ['clone', '--quiet', bare, stage], { stdio: 'ignore' }); };
    const principal = await topologyPrincipal(engine);
    const add = { operation: 'add' as const, sourceId: 'large-clone', path: target, remoteUrl: REMOTE, requestId: randomUUID() };
    expect(await runManagedSourceClone(engine, add, principal, add.requestId, { ...add, requestId: undefined, dryRun: undefined }, { clone }))
      .toMatchObject({ state: 'committed', cloned: true });
    await expectCompact('large-clone', target);
    const reclone = { operation: 'reclone' as const, sourceId: 'large-clone', requestId: randomUUID() };
    expect(await runManagedSourceClone(engine, reclone, principal, reclone.requestId, { ...reclone, requestId: undefined, dryRun: undefined }, { clone }))
      .toMatchObject({ state: 'committed', cloned: true });
    await expectCompact('large-clone', target);
    expect(readdirSync(home).some(name => name.includes('gbrain-old') || name.startsWith('.gbrain-clone'))).toBe(false);
  }), 240_000);

  test('a legacy manifest with a per-file map past 1 MiB is accepted by reclone recovery and compacted', () => fixture(async home => {
    const bare = largeBareRepository(home, 20);
    const target = join(home, 'cloned');
    const clone = async (_url: string, stage: string) => { execFileSync('git', ['clone', '--quiet', bare, stage], { stdio: 'ignore' }); };
    const principal = await topologyPrincipal(engine);
    const add = { operation: 'add' as const, sourceId: 'legacy-clone', path: target, remoteUrl: REMOTE, requestId: randomUUID() };
    await runManagedSourceClone(engine, add, principal, add.requestId, { ...add, requestId: undefined, dryRun: undefined }, { clone });
    await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'legacy-clone' });
    const current = await storedManifest('legacy-clone');
    const files = Object.fromEntries(Array.from({ length: FILES }, (_, i) => [`notes/legacy/example-note-${String(i).padStart(6, '0')}.md`, 'f'.repeat(64)]));
    const legacy = { digest: current.digest, files, canonical_stamp: current.canonical_stamp };
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(1_048_576);
    const binding = (await getWorktreeBinding(engine, 'legacy-clone'))!;
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [binding.worktree_id, JSON.stringify(legacy)]);
    rmSync(target, { recursive: true, force: true });
    const reclone = { operation: 'reclone' as const, sourceId: 'legacy-clone', requestId: randomUUID() };
    expect(await runManagedSourceClone(engine, reclone, principal, reclone.requestId, { ...reclone, requestId: undefined, dryRun: undefined }, { clone }))
      .toMatchObject({ state: 'committed', cloned: true });
    await expectCompact('legacy-clone', target, 20);
  }), 240_000);

  test('writer transfer prepare and accept, including self-transfer, commit at 12k files', () => fixture(async home => {
    const root = join(home, 'owner');
    writeLargeWorktree(root, FILES);
    await insertSource('large-transfer', root);
    await claimWorktree(engine, 'large-transfer', root);
    const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) }) as Promise<any>;

    const self = await administer('writer_transfer_prepare', { source_id: 'large-transfer', self_transfer: true });
    expect(self.manifest).toEqual({ digest: worktreeManifest(root).digest, file_count: FILES });
    const draining = await storedManifest('large-transfer');
    expect(draining.files).toBeUndefined();
    expect(draining).toMatchObject({ digest: self.manifest.digest, file_count: FILES, self_transfer: expect.any(Object) });
    expect(await administer('writer_transfer_accept', { source_id: 'large-transfer', path: root, expected_epoch: self.owner_epoch, manifest: self.manifest.digest, self_transfer: true }))
      .toMatchObject({ transferred: true });

    const successor = join(home, 'successor');
    copyWorktree(root, successor);
    const prepared = await administer('writer_transfer_prepare', { source_id: 'large-transfer' });
    expect(prepared.manifest).toEqual({ digest: self.manifest.digest, file_count: FILES });
    expect(await administer('writer_transfer_accept', { source_id: 'large-transfer', path: successor, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest }))
      .toMatchObject({ transferred: true, binding: { local_path: successor, state: 'active' } });
    expect((await getWorktreeBinding(engine, 'large-transfer'))!.owner_epoch).toBe('3');
  }), 240_000);

  test('an administrative preview taken before a manifest rewrite refuses afterwards', () => fixture(async home => {
    const root = join(home, 'owner');
    mkdirSync(root);
    writeLargeWorktree(root, 20);
    await insertSource('rewritten', root);
    await claimWorktree(engine, 'rewritten', root);
    const binding = (await getWorktreeBinding(engine, 'rewritten'))!;
    const { digest } = worktreeManifest(root);
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [binding.worktree_id, JSON.stringify({ digest, files: { 'example.md': 'f'.repeat(64) } })]);
    const preview = await reviewedWriterIntent(engine, 'writer_transfer_prepare');
    await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [binding.worktree_id, JSON.stringify({ digest, file_count: 20 })]);
    await expect(runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: 'rewritten', ...preview })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    expect((await getWorktreeBinding(engine, 'rewritten'))!.state).toBe('active');
  }), 120_000);
});
