/**
 * #5200 (W14 P1.4): retiring a source (archive / remove / purge) compares no
 * bytes, so it must not walk and hash the canonical checkout; before, a
 * symlink that appeared in the checkout after the claim made every retire
 * refuse `writer_manifest_unsafe` while the dry run said it would succeed.
 * Retire now refreshes `manifest.canonical_stamp` in place and the dry run
 * reports `manifest_required: false`. Operations that compare or record bytes
 * (claim, rebind) still hash, and their refusal no longer talks about a
 * "transfer" when raised from a claim.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) describe(`retire a source whose checkout grew a symlink (${flavor})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (flavor === 'postgres') { const pg = await isolatedPersistencePostgres(databaseUrl!); engine = pg.engine; closePostgres = pg.close; }
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (closePostgres) await closePostgres(); else await engine.disconnect(); });

  const manifest = async (source: string) => (await engine.executeRaw<{ manifest: Record<string, unknown> | string | null }>(
    `SELECT w.manifest FROM persistence_worktrees w JOIN persistence_source_bindings b ON b.worktree_id=w.id WHERE b.source_id=$1`, [source]))
    .map(r => typeof r.manifest === 'string' ? JSON.parse(r.manifest) as Record<string, unknown> : r.manifest)[0] ?? null;
  const recorded = async (source: string) => { const m = await manifest(source); if (!m) throw new Error(`no manifest for ${source}`); return m; };

  /** Claims the source (managed, so the claim records a manifest) at a symlink-free checkout, then drops a symlink into it. */
  async function fixture(source: string, run: (home: string, checkout: string) => Promise<void>, opts: { classicClaim?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-symlink-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        if (flavor === 'pglite') await resetPgliteState(engine as PGLiteEngine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await registerLocalWriter(engine, 'cli');
        const checkout = join(home, 'profile');
        mkdirSync(checkout);
        writeFileSync(join(checkout, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, checkout]);
        if (opts.classicClaim) await claimWorktree(engine, source, checkout);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        if (!opts.classicClaim) await claimWorktree(engine, source, checkout);
        writeFileSync(join(home, 'outside.md'), 'linked\n');
        symlinkSync(join(home, 'outside.md'), join(checkout, 'linked.md'));
        try { await run(home, checkout); }
        finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
        }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test('archive and purge skip the manifest walk, refresh canonical_stamp in place and agree with their dry runs', () => fixture('linked-profile', async () => {
    const before = await recorded('linked-profile');
    expect(typeof before.digest).toBe('string');
    // A stale stamp written over the claim's makes the in-place refresh observable.
    await engine.executeRaw(`UPDATE persistence_worktrees SET manifest=manifest||'{"canonical_stamp":"stale"}'::jsonb WHERE id IN (SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1)`, ['linked-profile']);

    const preview = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'linked-profile', dryRun: true });
    expect(preview).toMatchObject({ dry_run: true, operation: 'archive', manifest_required: false });

    const archived = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'linked-profile' });
    expect(archived).toMatchObject({ operation: 'archive', source_id: 'linked-profile' });
    expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', ['linked-profile']))[0].archived).toBe(true);
    const after = await recorded('linked-profile');
    expect(after.digest).toBe(before.digest);
    expect(after.file_count).toBe(before.file_count);
    expect(typeof after.canonical_stamp).toBe('string');
    expect(after.canonical_stamp).not.toBe('stale');

    const purgePreview = await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: 'linked-profile', confirmDestructive: true, dryRun: true });
    expect(purgePreview).toMatchObject({ dry_run: true, operation: 'purge', manifest_required: false });
    const purged = await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: 'linked-profile', confirmDestructive: true });
    expect(purged).toMatchObject({ operation: 'purge', pages_deleted: 0 });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['linked-profile'])).toEqual([]);
  }), 60_000);

  test('remove skips the walk too', () => fixture('linked-remove', async () => {
    expect(await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'linked-remove', confirmDestructive: true, dryRun: true }))
      .toMatchObject({ dry_run: true, operation: 'remove', manifest_required: false });
    const removed = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'linked-remove', confirmDestructive: true });
    expect(removed).toMatchObject({ operation: 'remove', pages_deleted: 0 });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['linked-remove'])).toEqual([]);
  }), 60_000);

  test('a binding claimed before activation has no digest yet: the retire records that first manifest and its dry run says so', () => fixture('classic-profile', async () => {
    expect(await manifest('classic-profile')).toBeNull();
    expect(await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'classic-profile', dryRun: true }))
      .toMatchObject({ dry_run: true, operation: 'archive', manifest_required: true });
    const error = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'classic-profile' }).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'writer_manifest_unsafe' });
    rmSync(join(process.env.GBRAIN_HOME!, 'profile', 'linked.md'));
    await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'classic-profile' });
    expect(typeof (await recorded('classic-profile')).digest).toBe('string');
  }, { classicClaim: true }), 60_000);

  test('rebind still hashes: the symlink refuses, and the refusal does not call a non-transfer step a transfer', () => fixture('linked-rebind', async home => {
    const next = join(home, 'next');
    mkdirSync(next);
    writeFileSync(join(next, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
    expect(await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'linked-rebind', path: next, dryRun: true }))
      .toMatchObject({ dry_run: true, operation: 'rebind', manifest_required: true });
    const error = await runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId: 'linked-rebind', path: next }).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'writer_manifest_unsafe' });
    expect(error.message).not.toContain('transfer');
    expect(error.suggestion).toContain('linked.md');
    expect(error.suggestion).not.toContain('transfer step');
  }), 60_000);
});
