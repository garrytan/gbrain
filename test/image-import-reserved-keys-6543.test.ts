/**
 * #6543 D2: the image importer stops writing the parser-reserved `type`/`title` keys into an image page's stored
 * frontmatter (both live on the page columns already), so `stale_frontmatter_keys` converges on a multimodal brain.
 * The doctor message names the release that made the keys inert (v0.60.177.0) and, with several sources affected,
 * fixes with the all-sources preview instead of the first source only.
 *
 * Regression that fails it: the importer writing `type`/`title` again (doctor warns on a freshly imported PNG), or the
 * fix naming only the first source.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile } from '../src/core/import-file.ts';
import { staleFrontmatterKeysCheck } from '../src/commands/doctor/checks/frontmatter-keys.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'gbrain-6543-d2-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function source(): Promise<{ sourceId: string; root: string }> {
  const sourceId = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(dir, sourceId); mkdirSync(join(root, 'Media'), { recursive: true });
  writeFileSync(join(root, 'Media', 'IMG_1453.PNG'), PNG);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [sourceId, root]);
  return { sourceId, root };
}

test('an imported image page stores no reserved frontmatter key and doctor stale_frontmatter_keys is ok', async () => {
  const { sourceId, root } = await source();
  const result = await importImageFile(engine, join(root, 'Media', 'IMG_1453.PNG'), 'Media/IMG_1453.PNG', { sourceId, noEmbed: true });
  expect(result.status).toBe('imported');
  const [page] = await engine.executeRaw<{ type: string; title: string; frontmatter: Record<string, unknown> }>(
    'SELECT type, title, frontmatter FROM pages WHERE source_id=$1', [sourceId]);
  expect(page.type).toBe('image');
  expect(page.title).toBe('IMG_1453.PNG');
  expect(page.frontmatter).not.toHaveProperty('type');
  expect(page.frontmatter).not.toHaveProperty('title');
  expect(page.frontmatter).toMatchObject({ mime_type: 'image/png' });
  const check = await staleFrontmatterKeysCheck(engine, [sourceId]);
  expect(check.status).toBe('ok');
});

test('with several sources affected the doctor fix previews every source and the message names v0.60.177.0', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { sourceId } = await source();
    ids.push(sourceId);
    await engine.putPage('notes/legacy', { type: 'note', title: 'Legacy', compiled_truth: 'Body.', frontmatter: { title: 'Legacy' } }, { sourceId });
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"type\":\"note\"}'::jsonb WHERE source_id=$1", [sourceId]);
  }
  const check = await staleFrontmatterKeysCheck(engine, ids);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('v0.60.177.0');
  expect(check.message).not.toContain('v0.60.176.0');
  for (const id of ids) expect(check.message).toContain(`${id}: 1`);
  expect(check.fix?.argv).toEqual(['gbrain', 'repair', 'frontmatter-keys']);
});
