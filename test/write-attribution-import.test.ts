/**
 * Foundations 2 (Lane C) import attribution on an unmanaged brain: the
 * moved-file rename importFromContent applies (frontmatter.id move evidence)
 * runs in maintenanceTransaction, so the page revision it advances names the
 * local maintenance principal instead of reading `unrecorded`.
 *
 * Protects the import writer family in docs/architecture/system-of-record.md.
 * Fails if the moved-file `updateSlug` leaves maintenanceTransaction. Runs on
 * PGLite, and on Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { revisionActor, unmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-import-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

describe('import attribution on an unmanaged brain', () => {
  test('a moved file renames its page in place and the advanced revision names the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const root = join(scratch, brain.sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      mkdirSync(join(root, 'archive'), { recursive: true });
      const body = '---\ntype: note\ntitle: Moved example\nid: moved-example-id\n---\nThe body travels with the file.\n';
      writeFileSync(join(root, 'notes/moved-example.md'), body);
      const first = await importFromFile(engine, join(root, 'notes/moved-example.md'), 'notes/moved-example.md',
        { sourceId: brain.sourceId, noEmbed: true });
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [brain.sourceId, first.slug]);

      renameSync(join(root, 'notes/moved-example.md'), join(root, 'archive/moved-example.md'));
      const moved = await importFromFile(engine, join(root, 'archive/moved-example.md'), 'archive/moved-example.md',
        { sourceId: brain.sourceId, noEmbed: true });

      expect(moved.slug).not.toBe(first.slug);
      const [renamed] = await engine.executeRaw<{ id: number; slug: string }>('SELECT id,slug FROM pages WHERE source_id=$1 AND id=$2', [brain.sourceId, id]);
      expect(renamed.slug).toBe(moved.slug);
      expect(await revisionActor(engine, brain.sourceId, moved.slug)).toEqual(brain.maintenance);
    }
  }, 120_000);
});
