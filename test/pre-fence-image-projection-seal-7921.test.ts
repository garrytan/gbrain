import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../src/core/page-state/projection-schema.ts';
import { drainProjections, projectionBacklog } from '../src/core/page-state/projections.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('a fileless pre-fence image with its importer chunk seals without reimport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-seal-7921-'));
  roots.push(root);
  const file = join(root, 'legacy.png');
  mkdirSync(root, { recursive: true });
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
  expect((await importImageFile(engine, file, 'legacy.png', { noEmbed: true })).status).toBe('imported');
  await engine.executeRaw("UPDATE pages SET chunker_version=3,source_path=NULL WHERE slug='legacy.png'");
  rmSync(file);
  for (const statement of PAGE_PROJECTION_ACTIVATION_SQL.split(';').map(part => part.trim()).filter(Boolean)) await engine.executeRaw(statement);

  expect(await projectionBacklog(engine)).toMatchObject({ pending: 0, sealable: 1, reimport: 0 });
  expect(await drainProjections(engine, { media: true })).toMatchObject({ sealed: 1, failed: [] });
  const [page] = await engine.executeRaw<{ chunker_version: number; sealed: boolean }>(
    "SELECT chunker_version,text_projection_revision=knowledge_revision AS sealed FROM pages WHERE slug='legacy.png'");
  expect(page).toEqual({ chunker_version: 4, sealed: true });
}, 120_000);
