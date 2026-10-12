/**
 * #6529: `image_embedding_coverage` doctor check. Text coverage hid the image
 * side of search: image pages carry a text vector (caption or OCR projection),
 * so `embed_coverage_pct` read as done while 99% of them had no
 * `embedding_image`. The check reports image pages without an image vector,
 * image pages whose `source_path` was never recorded, and the images managed
 * sync still holds as `managed_image_sync_unsupported`, apart from text coverage.
 *
 * Both engines (PGLite in-memory; Postgres when DATABASE_URL is set). No provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { imageEmbeddingCoverageCheck } from '../src/commands/doctor/checks/image-embedding-coverage.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'gbrain-6529-doctor-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

async function source(engine: BrainEngine) {
  const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(dir, sourceId); mkdirSync(join(root, 'photos'), { recursive: true });
  writeFileSync(join(root, 'photos', 'a.png'), PNG);
  writeFileSync(join(root, 'photos', 'b.png'), Buffer.concat([PNG, Buffer.from([0])]));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  return { sourceId, root };
}

describe('image_embedding_coverage doctor check', () => {
  test('image pages without an image vector, without source_path, and held images are counted apart from text coverage', async () => {
    for (const engine of engines) {
      const { sourceId, root } = await source(engine);
      for (const name of ['a', 'b']) expect((await importImageFile(engine, join(root, 'photos', `${name}.png`), `photos/${name}.png`, { sourceId, noEmbed: true })).status).toBe('imported');
      await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id=$1 AND slug='photos/b.png'", [sourceId]);
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
      const now = new Date().toISOString();
      await writeGitHold(engine, { source_id: sourceId, incarnation, path: 'photos/c.png', source_path: 'photos/c.png', slug: 'photos/c.png', page_id: null,
        code: 'managed_image_sync_unsupported', message: 'photos/c.png is an image, which managed sync does not import yet.', upstream_version: null,
        observed_at: now, run_id: null, mode: 'managed', meta: { recovery_version: 1 } });

      const on = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => imageEmbeddingCoverageCheck(engine));
      expect(on.name).toBe('image_embedding_coverage');
      expect(on.status).toBe('warn');
      expect(on.details).toMatchObject({ image_pages: 2, without_image_vector: 2, null_source_path: 1, unsupported_holds: 1, multimodal: true });
      expect(on.message).toContain('2 of 2 image page(s) have no image vector');
      expect(on.message).toContain('gbrain embed --stale --images');
      expect(on.message).toContain('1 held as managed_image_sync_unsupported');
      expect(on.message).toContain('1 with no recorded source_path');

      const off = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => imageEmbeddingCoverageCheck(engine));
      expect(off.status).toBe('ok');
      expect(off.details).toMatchObject({ image_pages: 2, without_image_vector: 2, multimodal: false });
      expect(off.message).toContain('GBRAIN_EMBEDDING_MULTIMODAL');

      await engine.executeRaw("DELETE FROM pages WHERE source_id=$1", [sourceId]);
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE fingerprint LIKE $1', [`${sourceId}:%`]);
    }
    expect(categorizeCheck('image_embedding_coverage')).toBe('brain');
  }, 120_000);

  test('a brain with no image pages is ok without naming a sweep', async () => {
    for (const engine of engines) {
      const check = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => imageEmbeddingCoverageCheck(engine));
      expect(check.status).toBe('ok');
      expect(check.details).toMatchObject({ image_pages: 0, without_image_vector: 0 });
      expect(check.message).not.toContain('embed --stale --images');
    }
  }, 60_000);
});
