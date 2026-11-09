/**
 * #8473: a page whose body holds only a protected takes fence is chunked to
 * nothing by the writer (the fence never reaches ordinary chunks), and the
 * writer seals that revision's empty projection. The chunkless predicate
 * looked only at raw body length, so embedding_state called the page
 * chunkless_healable and `embed --stale` planned a heal that can never
 * produce a chunk. A sealed revision with no chunks is empty; an unsealed
 * chunkless page and a sealed embed_skip page with no chunks (#7174) stay
 * healable. Deleting a page's chunks (deleteChunks, or a fragment replacement
 * with no chunks) voids the seal, so a page emptied that way stays healable.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readEmbeddingState } from '../src/core/embedding-state.ts';

let engine: PGLiteEngine;
const TAKES = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
  '|---|-------|------|-----|--------|-------|--------|', '| 1 | Acme Example ships this year | bet | alice-example | 0.7 | 2026-01 | notes |',
  '<!--- gbrain:takes:end -->'].join('\n');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM pages'); });

const state = async () => (await readEmbeddingState(engine, { mode: 'full' })).counts;

test('a page holding only a takes fence is empty, not healable', async () => {
  const written = await importFromContent(engine, 'notes/takes-only', `---\ntitle: Takes only\ntype: note\n---\n${TAKES}\n`, { noEmbed: true });
  expect(written.chunks).toBe(0);
  expect(await state()).toMatchObject({ chunkless_healable: 0, empty: 1 });
  expect(await engine.countChunklessPagesWithContent()).toBe(0);
  expect(await engine.listChunklessPagesWithContent()).toEqual([]);
});

const PROSE = '---\ntitle: Prose\ntype: note\n---\nA paragraph about acme-example.\n';
const sealed = async (slug: string) => (await engine.executeRaw<{ sealed: boolean }>(
  'SELECT (text_projection_revision = knowledge_revision) IS TRUE AS sealed FROM pages WHERE slug = $1', [slug]))[0]?.sealed;

test('a sealed page whose chunks deleteChunks removed stays healable', async () => {
  const written = await importFromContent(engine, 'notes/prose', PROSE, { noEmbed: true });
  expect(written.chunks).toBeGreaterThan(0);
  expect(await sealed('notes/prose')).toBe(true);
  await engine.deleteChunks('notes/prose');
  expect(await sealed('notes/prose')).toBe(false);
  expect(await state()).toMatchObject({ chunkless_healable: 1, empty: 0 });
  expect(await engine.countChunklessPagesWithContent()).toBe(1);
});

test('a sealed page emptied by a fragment chunk replacement stays healable', async () => {
  await importFromContent(engine, 'notes/prose', PROSE, { noEmbed: true });
  await engine.upsertChunks('notes/prose', []);
  expect(await sealed('notes/prose')).toBe(false);
  expect(await state()).toMatchObject({ chunkless_healable: 1, empty: 0 });
  expect(await engine.countChunklessPagesWithContent()).toBe(1);
});

test('deleteChunks on a page with no chunks keeps its empty seal', async () => {
  await importFromContent(engine, 'notes/takes-only', `---\ntitle: Takes only\ntype: note\n---\n${TAKES}\n`, { noEmbed: true });
  await engine.deleteChunks('notes/takes-only');
  expect(await sealed('notes/takes-only')).toBe(true);
  expect(await state()).toMatchObject({ chunkless_healable: 0, empty: 1 });
});

test('a sealed embed_skip page with no chunks stays healable (#7174)', async () => {
  await importFromContent(engine, 'notes/skipped', '---\ntitle: Skipped\ntype: note\n---\nA paragraph about acme-example.\n', { noEmbed: true });
  await engine.executeRaw("DELETE FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/skipped')");
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"embed_skip":{"reason":"oversized","bytes":700000}}'::jsonb WHERE slug = 'notes/skipped'`);
  await engine.executeRaw("UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = 'notes/skipped'");
  const [sealed] = await engine.executeRaw<{ sealed: boolean }>("SELECT text_projection_revision = knowledge_revision AS sealed FROM pages WHERE slug = 'notes/skipped'");
  expect(sealed?.sealed).toBe(true);
  expect(await state()).toMatchObject({ chunkless_healable: 1, empty: 0 });
});
