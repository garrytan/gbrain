/**
 * #8492 item 1: `materializedSnapshot` reads a segmented page's body at the generation its snapshot was read with.
 *
 * A snapshot holds one revision's title, frontmatter and withdrawal ledger; the drift check, the managed-sync freeze
 * screen and local-edit adoption compare a file with it read back whole. The body used to be read from the live
 * generation, so a replacement published after the snapshot gave the old metadata the new body. When the snapshot's
 * generation can no longer be read, the read refuses `page_body_rows_unreadable` instead of answering with the new body.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { materializedSnapshot } from '../../src/core/persistence/segmented-apply.ts';

const SLUG = 'notes/alice-example';
let engine: PGLiteEngine;

/** Over the inline bound, so the page is stored in segments; `tag` marks the generation's text. */
const file = (tag: string) => `---\ntitle: Alice Example ${tag}\ntype: concept\n---\n\n${tag} intro.\n\n${
  Array.from({ length: 16_000 }, (_, i) => `- ${String(i).padStart(9, '0')} ${tag} acme-example journal line with enough text to fill a segment\n`).join('')}`;
const page = async () => (await engine.executeRaw<{ id: number; body_storage: string; body_generation: number }>(
  'SELECT id, body_storage, body_generation FROM pages WHERE source_id=$1 AND slug=$2', ['default', SLUG]))[0]!;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

async function snapshotThenReplace() {
  await importFromContent(engine, SLUG, file('genone'), { sourceId: 'default', noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  expect({ storage: (await page()).body_storage, generation: snapshot.bodyGeneration }).toEqual({ storage: 'segmented', generation: 1 });
  await importFromContent(engine, SLUG, file('gentwo'), { sourceId: 'default', noEmbed: true });
  expect(Number((await page()).body_generation)).toBe(2);
  return snapshot;
}

test('a snapshot read back whole keeps its own generation\'s body after a replacement is published', async () => {
  const snapshot = await snapshotThenReplace();
  const read = (await materializedSnapshot(engine, snapshot))!;
  expect(read.page.title).toBe('Alice Example genone');
  expect(read.page.compiled_truth.startsWith('genone intro.')).toBe(true);
  expect(read.page.compiled_truth).not.toContain('gentwo');
}, 120_000);

test('a snapshot whose generation is no longer readable refuses instead of reading the newer body', async () => {
  const snapshot = await snapshotThenReplace();
  await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NOT NULL', [(await page()).id]);
  const read = materializedSnapshot(engine, snapshot).then(s => s!.page.compiled_truth.slice(0, 12));
  await expect(read).rejects.toMatchObject({ code: 'page_body_rows_unreadable' });
}, 120_000);
