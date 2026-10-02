/**
 * #5790 scale record: a 50,000-file worktree on both engines. Records the
 * duration and peak RSS of `sources add`, `claim` and writer transfer prepare
 * and accept with the fixture's total bytes. No duration gate (DX-O10); the
 * stored manifest and peak RSS growth carry ceilings set from measurement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isPhysicalRootMetadata } from '../../src/core/persistence/physical-root.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { reviewedWriterIntent } from '../helpers/writer-admin-intent.ts';
import { withEnv } from '../helpers/with-env.ts';
import { writeLargeWorktree } from '../helpers/large-worktree.ts';

const FILES = 50_000;
const STORED_MANIFEST_CEILING_BYTES = 4096;
const PEAK_RSS_GROWTH_CEILING_MB = 1024;
const databaseUrl = requirePostgresTestDatabase();
const directory = mkdtempSync(join(tmpdir(), 'gbrain-50k-manifest-'));
const template = join(directory, 'template');
let totalBytes = 0;
beforeAll(() => { totalBytes = writeLargeWorktree(template, FILES); }, 300_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }), 300_000);

const peakRssMb = () => process.resourceUsage().maxRSS / 1024;
async function measured<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; peak_rss_mb: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - started), peak_rss_mb: Math.round(peakRssMb()) };
}
const copy = (to: string) => cpSync(template, to, { recursive: true, filter: path => !isPhysicalRootMetadata(basename(path)) });

for (const backend of ['postgres', 'pglite'] as const) describe(`50,000-file worktree (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

  test('sources add, claim and writer transfer commit with a compact manifest', async () => {
    const home = join(directory, backend);
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const rssBefore = peakRssMb();
      const added = join(home, 'added'), claimed = join(home, 'claimed'), successor = join(home, 'successor');
      copy(added); copy(claimed); copy(successor);
      const add = await measured(() => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'scale-added', path: added }));
      expect(add.value).toMatchObject({ state: 'committed' });
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['scale-claimed', claimed]);
      });
      const claim = await measured(() => claimWorktree(engine, 'scale-claimed', claimed));
      const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
        runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) }) as Promise<any>;
      const prepare = await measured(() => administer('writer_transfer_prepare', { source_id: 'scale-claimed' }));
      expect(prepare.value.manifest.file_count).toBe(FILES);
      const accept = await measured(() => administer('writer_transfer_accept', { source_id: 'scale-claimed', path: successor,
        expected_epoch: prepare.value.owner_epoch, manifest: prepare.value.manifest.digest }));
      expect(accept.value).toMatchObject({ transferred: true });
      expect((await getWorktreeBinding(engine, 'scale-claimed'))!.local_path).toBe(successor);
      const rows = await engine.executeRaw<{ manifest: unknown }>('SELECT manifest FROM persistence_worktrees WHERE manifest IS NOT NULL');
      expect(rows).toHaveLength(2);
      for (const { manifest } of rows) {
        const stored = typeof manifest === 'string' ? JSON.parse(manifest) : manifest as Record<string, unknown>;
        expect(stored).toMatchObject({ file_count: FILES });
        expect(stored.files).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(STORED_MANIFEST_CEILING_BYTES);
      }
      const record = { backend, files: FILES, total_bytes: totalBytes,
        add: { ms: add.ms, peak_rss_mb: add.peak_rss_mb }, claim: { ms: claim.ms, peak_rss_mb: claim.peak_rss_mb },
        transfer_prepare: { ms: prepare.ms, peak_rss_mb: prepare.peak_rss_mb }, transfer_accept: { ms: accept.ms, peak_rss_mb: accept.peak_rss_mb },
        peak_rss_growth_mb: Math.round(peakRssMb() - rssBefore) };
      console.log(`[5790-scale] ${JSON.stringify(record)}`);
      expect(record.peak_rss_growth_mb).toBeLessThan(PEAK_RSS_GROWTH_CEILING_MB);
    });
  }, 600_000);
});
