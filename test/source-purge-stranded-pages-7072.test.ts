/**
 * #7072: a source delete never leaves live pages behind with no `sources` row.
 *
 * Every source delete removes the source's pages through the pages -> sources
 * ON DELETE CASCADE foreign key. On a brain where that cascade does not run (the
 * foreign key is missing), the expired-archive purge used to delete the sources
 * row anyway and leave every page of the source live, unwritable and outside
 * every per-source audit (`extract links` then reports them as
 * `skipped_unknown_source`). The purge now refuses that source with
 * `source_pages_remain` and changes nothing; a brain whose cascade runs still
 * purges as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { purgeExpiredSources, softDeleteSource } from '../src/core/destructive-guard.ts';
import { deleteSourceRow } from '../src/core/source-delete.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;

async function dropPagesSourceForeignKey(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = 'pages'::regclass AND confrelid = 'sources'::regclass`);
  for (const { conname } of rows) await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT "${conname}"`);
}

async function seedExpiredArchive(engine: BrainEngine, id: string, pages: number): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
  for (let i = 0; i < pages; i++) {
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) VALUES ($1, $2, 'note', $2)`, [id, `notes/page-${i}`]);
  }
  await softDeleteSource(engine, id);
  await engine.executeRaw(`UPDATE sources SET archive_expires_at = now() - interval '1 hour' WHERE id = $1`, [id]);
}

const count = async (engine: BrainEngine, sql: string, id: string) =>
  Number((await engine.executeRaw<{ n: string }>(sql, [id]))[0]!.n);
const sourceRows = (engine: BrainEngine, id: string) => count(engine, 'SELECT count(*)::text AS n FROM sources WHERE id = $1 AND archived', id);
const pageRows = (engine: BrainEngine, id: string) => count(engine, 'SELECT count(*)::text AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL', id);

for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) {
  describe(`#7072 source delete without a pages cascade (${flavor})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      if (flavor === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(databaseUrl!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 180_000);

    afterAll(async () => {
      if (!engine) return;
      await disposePersistenceConsumer(engine);
      if (closePostgres) await closePostgres();
      else await engine.disconnect();
    });

    test('a healthy brain still purges the expired archive with its pages', async () => {
      await seedExpiredArchive(engine, 'source-a', 2);
      const { purged, blocked } = await purgeExpiredSources(engine);
      expect({ purged, blocked }).toEqual({ purged: ['source-a'], blocked: [] });
      expect(await count(engine, 'SELECT count(*)::text AS n FROM pages WHERE source_id = $1', 'source-a')).toBe(0);
    });

    test('unmanaged: the expired-archive purge refuses the source and keeps its pages and row', async () => {
      await dropPagesSourceForeignKey(engine);
      await seedExpiredArchive(engine, 'source-b', 3);
      await seedExpiredArchive(engine, 'source-c', 0);
      const { purged, blocked } = await purgeExpiredSources(engine);
      expect(purged).toEqual(['source-c']);
      expect(blocked.map(b => [b.id, b.code, b.fix?.command])).toEqual([['source-b', 'source_pages_remain', 'gbrain doctor --json']]);
      expect(blocked[0]!.reason).toContain('3 page(s)');
      expect(await sourceRows(engine, 'source-b')).toBe(1);
      expect(await pageRows(engine, 'source-b')).toBe(3);

      await expect(deleteSourceRow(engine, 'source-b')).rejects.toMatchObject({ code: 'source_pages_remain' });
      expect(await sourceRows(engine, 'source-b')).toBe(1);
    });

    test('managed: the lifecycle purge rolls back and the sweep reports it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-7072-'));
      try {
        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          if (flavor === 'pglite') await resetPgliteState(engine as PGLiteEngine);
          await registerLocalWriter(engine, 'cli');
          await dropPagesSourceForeignKey(engine);
          const root = join(home, 'canonical');
          mkdirSync(root);
          writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
          await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', ['source-d', root]);
          await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title) VALUES ('source-d', 'example', 'note', 'Example')`);
          await claimWorktree(engine, 'source-d', root);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'source-d' });
          await engine.executeRaw(`UPDATE sources SET archived_at = now() - interval '73 hours', archive_expires_at = now() - interval '1 hour' WHERE id = 'source-d'`);

          await expect(runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: 'source-d', confirmDestructive: true, expiredOnly: true }))
            .rejects.toMatchObject({ code: 'source_pages_remain' });
          const { purged, blocked } = await purgeExpiredSources(engine);
          expect(purged).toEqual([]);
          expect(blocked.filter(b => b.id === 'source-d').map(b => [b.id, b.code])).toEqual([['source-d', 'source_pages_remain']]);
          expect(await sourceRows(engine, 'source-d')).toBe(1);
          expect(await pageRows(engine, 'source-d')).toBe(1);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
