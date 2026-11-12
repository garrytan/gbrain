/**
 * #8492 item 1: `materializedSnapshot` reads a segmented page's body at the generation its snapshot was read with.
 *
 * A snapshot holds one revision's title, frontmatter and withdrawal ledger; the drift check, the managed-sync freeze
 * screen and local-edit adoption compare a file with it read back whole. The body used to be read from the live
 * generation, so a replacement published after the snapshot gave the old metadata the new body. The snapshot's
 * generation is checked against the snapshot's own body_bytes, so a generation version retention pruned (its changed
 * tail swept, its unchanged prefix still live) never reads back as a short body. When the snapshot's generation can no
 * longer be read and the page has moved on, the read refuses `revision_conflict` (prepare again on a fresh snapshot);
 * an unreadable live generation still refuses `page_body_rows_unreadable`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { materializedSnapshot } from '../../src/core/persistence/segmented-apply.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const SLUG = 'notes/alice-example';
let engine: PGLiteEngine;

const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `- ${String(i).padStart(9, '0')} ${tag} acme-example journal line with enough text to fill a segment\n`).join('');
/** Over the inline bound, so the page is stored in segments; `tag` marks the generation's text. */
const file = (tag: string) => `---\ntitle: Alice Example ${tag}\ntype: concept\n---\n\n${tag} intro.\n\n${lines(tag, 16_000)}`;
/** The same prefix on every generation; only the last lines change. */
const tailFile = (tail: string) => `---\ntitle: Alice Example\ntype: concept\n---\n\nShared intro.\n\n${lines('shared', 16_000)}${lines(tail, 40)}`;
const page = async () => (await engine.executeRaw<{ id: number; body_storage: string; body_generation: number }>(
  'SELECT id, body_storage, body_generation FROM pages WHERE source_id=$1 AND slug=$2', ['default', SLUG]))[0]!;
const put = (content: string) => importFromContent(engine, SLUG, content, { sourceId: 'default', noEmbed: true });
const coordinated = (sql: string, params: unknown[]) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('versions.segmented_max_per_page', '50');
});

async function snapshotThenReplace() {
  await put(file('genone'));
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  expect({ storage: (await page()).body_storage, generation: snapshot.bodyGeneration }).toEqual({ storage: 'segmented', generation: 1 });
  await put(file('gentwo'));
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

test('a snapshot whose generation was pruned to its live prefix never reads back short', async () => {
  await engine.setConfig('versions.segmented_max_per_page', '1');
  await put(tailFile('tailone'));
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  const whole = (await materializedSnapshot(engine, snapshot))!.page.compiled_truth;
  expect(whole).toContain('tailone');
  await put(tailFile('tailtwo'));
  await put(tailFile('tailthree'));
  const { id } = await page();
  const [left] = await engine.executeRaw<{ versions: number; covered: number }>(`SELECT
    (SELECT count(*)::int FROM page_versions WHERE page_id=$1 AND body_generation=1) AS versions,
    (SELECT COALESCE(sum(byte_len), 0)::int FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=1 AND (gen_to IS NULL OR gen_to>1)) AS covered`, [id]);
  expect(left!.versions).toBe(0);
  expect(left!.covered).toBeGreaterThan(0);
  expect(left!.covered).toBeLessThan(Number(snapshot.page.body_bytes));
  const read = materializedSnapshot(engine, snapshot).then(s => s!.page.compiled_truth.length);
  await expect(read).rejects.toMatchObject({ code: 'revision_conflict' });
}, 180_000);

test('a snapshot whose generation is no longer readable refuses as a page that changed, not as unreadable rows', async () => {
  const snapshot = await snapshotThenReplace();
  await coordinated('DELETE FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NOT NULL', [(await page()).id]);
  const read = materializedSnapshot(engine, snapshot).then(s => s!.page.compiled_truth.slice(0, 12));
  await expect(read).rejects.toMatchObject({ code: 'revision_conflict' });
}, 120_000);

test('a snapshot of the live generation whose rows are unreadable still refuses page_body_rows_unreadable', async () => {
  await put(file('genone'));
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  await coordinated('DELETE FROM page_body_manifest WHERE page_id=$1 AND seq=1 AND staging_id IS NULL', [(await page()).id]);
  const read = materializedSnapshot(engine, snapshot).then(s => s!.page.compiled_truth.slice(0, 12));
  await expect(read).rejects.toMatchObject({ code: 'page_body_rows_unreadable' });
}, 120_000);
