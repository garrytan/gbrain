/**
 * Wave B PR 1 (spec 1.5): a segmented page's body is unreachable as one string.
 *
 * 1. Protects: every engine read that returns a `Page` gives a segmented page body
 *    fields that throw `page_body_segmented` (property read, spread, JSON.stringify,
 *    assignment), so no caller sees '' where a multi-megabyte body lives; old-shape
 *    body writes over a segmented row are refused; every whole-body writer (spec top-25
 *    rows 11 and 13-19) refuses before it writes, leaving segments, manifest, body_generation
 *    and content_hash as they were. Inline pages read exactly as before.
 * 2. Fails when: a read path builds a segmented page without the guard, a writer
 *    reaches the database or the file before refusing, or get_page body:'none' stops
 *    answering a segmented page from body_bytes.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { materializePageSnapshot } from '../../src/core/page-state/materialize.ts';
import { writeTimelineEntryThrough } from '../../src/core/timeline-write-through.ts';
import { preserveCanonicalFences } from '../../src/core/cycle/concept-publication.ts';
import { assertInlineBody, isSegmentedPage, pageBodyBytes } from '../../src/core/page-body/page-shape.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';
import { createSegmentedPage, cutAtLines, segmentedPageState } from '../helpers/segmented-page.ts';

const SLUG = 'notes/segmented-example';
const INLINE = 'notes/inline-example';
const line = (i: number) => `- ${String(i).padStart(7, '0')} acme-example journal line with enough text to fill a segment quickly\n`;
const TRUTH = `# Segmented example\n\n${Array.from({ length: 30_000 }, (_, i) => line(i)).join('')}`;
const TIMELINE = `- **2026-10-01** | first entry\n- **2026-10-02** | second entry\n`;

/** Asserts `run` throws the typed page_body_segmented error. */
function expectSegmented(run: () => unknown): void {
  let error: unknown;
  try { run(); } catch (e) { error = e; }
  expect((error as { code?: string } | undefined)?.code).toBe('page_body_segmented');
}
/** Asserts `run` rejects with page_body_segmented raised at `site` (the writer's own guard, not a later getter). */
async function expectSegmentedAsync(run: () => Promise<unknown>, site: string): Promise<void> {
  let error: unknown;
  try { await run(); } catch (e) { error = e; }
  expect((error as { code?: string } | undefined)?.code).toBe('page_body_segmented');
  expect((error as Error).message.startsWith(`${site}: `)).toBe(true);
}
function expectUnreachable(page: object): void {
  expect(isSegmentedPage(page as never)).toBe(true);
  expectSegmented(() => (page as { compiled_truth: string }).compiled_truth);
  expectSegmented(() => (page as { timeline: string }).timeline);
  expectSegmented(() => ({ ...page }));
  expectSegmented(() => JSON.stringify(page));
  expectSegmented(() => structuredClone(page));
  expectSegmented(() => { (page as { compiled_truth: string }).compiled_truth = ''; });
}

describe('cutAtLines', () => {
  test('cuts at line ends into pieces of at most SEGMENT_MAX_BYTES and loses nothing', () => {
    const pieces = cutAtLines(TRUTH);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(TRUTH);
    for (const piece of pieces) expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    for (const piece of pieces.slice(0, -1)) expect(piece.endsWith('\n')).toBe(true);
  });
});

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: a segmented page body is unreachable`, () => {
    let engine: BrainEngine;
    let pageId: number;
    let fixture: string;
    let cli: LocalRegistration;
    const sourceId = `segmented-unreachable-${kind}-${process.pid}`;

    beforeAll(async () => {
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      fixture = mkdtempSync(join(tmpdir(), 'gb-segmented-unreachable-'));
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
      ({ id: pageId } = await createSegmentedPage(engine, { slug: SLUG, sourceId, truth: TRUTH, timeline: TIMELINE }));
      await engine.putPage(INLINE, { type: 'note', title: 'Inline', compiled_truth: 'Inline body.', timeline: '', frontmatter: {} }, { sourceId });
      cli = await registerLocalWriter(engine, 'cli');
    }, 120_000);

    afterAll(async () => {
      try {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
        await engine.executeRaw('DELETE FROM page_segment_texts WHERE source_id=$1', [sourceId]);
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      } finally {
        await engine.disconnect();
        rmSync(fixture, { recursive: true, force: true });
      }
    }, 60_000);

    const state = () => segmentedPageState(engine, pageId, sourceId);
    const call = (name: string, params: Record<string, unknown>) => withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
      const response = await withVerifiedLocalRegistration(engine, cli, () => dispatchToolCall(engine, name, params, {
        remote: false, config: { engine: kind }, sourceId, logger: { info() {}, warn() {}, error() {} },
      }));
      return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
    });

    test('the fixture is a segmented page with NULL body columns and its bytes in segments', async () => {
      const s = await state();
      expect(s).toMatchObject({ body_storage: 'segmented', body_generation: 1, compiled_truth: null, timeline: null,
        body_bytes: Buffer.byteLength(TRUTH) + Buffer.byteLength(TIMELINE) });
      expect(s.manifest.length).toBe(cutAtLines(TRUTH).length + cutAtLines(TIMELINE).length);
    });

    test('getPage, readPageSnapshot, readPageSnapshotsBatch and listPages return the page with throwing body fields', async () => {
      expectUnreachable((await engine.getPage(SLUG, { sourceId }))!);
      expectUnreachable((await engine.readPageSnapshot(SLUG, { sourceId }))!.page);
      const batch = await engine.readPageSnapshotsBatch([{ slug: SLUG, sourceId }]);
      expectUnreachable([...batch.snapshots.values()][0]!.page);
      const listed = await engine.listPages({ sourceId });
      expectUnreachable(listed.find(p => p.slug === SLUG)!);
      const columnsOnly = await engine.listPages({ sourceId, listColumnsOnly: true });
      expectUnreachable(columnsOnly.find(p => p.slug === SLUG)!);
    });

    test('size and storage stay readable; an inline page reads exactly as before', async () => {
      const page = (await engine.getPage(SLUG, { sourceId }))!;
      expect(page.body_storage).toBe('segmented');
      expect(pageBodyBytes(page)).toBe(Buffer.byteLength(TRUTH) + Buffer.byteLength(TIMELINE));
      expect(page.slug).toBe(SLUG);
      const inline = (await engine.getPage(INLINE, { sourceId }))!;
      expect(isSegmentedPage(inline)).toBe(false);
      expect(() => assertInlineBody(inline, 'test')).not.toThrow();
      expect(JSON.parse(JSON.stringify(inline))).toMatchObject({ compiled_truth: 'Inline body.', timeline: '' });
      expect({ ...inline }.compiled_truth).toBe('Inline body.');
    });

    test('get_page body:none answers from body_bytes; a whole-body read refuses with page_body_segmented', async () => {
      const none = await call('get_page', { slug: SLUG, body: 'none' });
      expect(none).toMatchObject({ slug: SLUG, body: 'none', body_storage: 'segmented', size: { body_bytes: Buffer.byteLength(TRUTH) + Buffer.byteLength(TIMELINE) } });
      expect(none).not.toHaveProperty('compiled_truth');
      expect(await call('get_page', { slug: SLUG, body: 'full' })).toMatchObject({ error: 'page_body_segmented' });
      const listed = await call('list_pages', { limit: 10 });
      expect(JSON.stringify(listed)).toContain(SLUG);
    });

    test('the CHECK refuses an old-shape body write over a segmented row', async () => {
      const before = await state();
      await expect(engine.putPage(SLUG, { type: 'note', title: SLUG, compiled_truth: 'replacement', timeline: '', frontmatter: {} }, { sourceId })).rejects.toThrow();
      await expect(engine.putPage(SLUG, { type: 'note', title: SLUG, compiled_truth: '', timeline: '', frontmatter: {} }, { sourceId })).rejects.toThrow(/segmented/);
      await expect(engine.refreshPageBody(SLUG, sourceId, 'replacement', '', 'x'.repeat(64))).rejects.toThrow();
      expect(await state()).toEqual(before);
    });

    test('mutation probe: every whole-body writer refuses before writing', async () => {
      const before = await state();
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId }))!;
      // Rows 15-18: preparers render the page as markdown before writing anything.
      expectSegmented(() => serializePageToMarkdown(snapshot.page, snapshot.tags));
      // Row 13: the withdrawal materializer.
      await expectSegmentedAsync(() => materializePageSnapshot(engine, snapshot), 'materializePageSnapshot');
      // Row 11: timeline write-through refuses before touching the file or the row (it reports failures as an outcome).
      const brain = join(fixture, 'brain');
      mkdirSync(join(brain, 'notes'), { recursive: true });
      const file = join(brain, `${SLUG}.md`);
      writeFileSync(file, `---\ntype: note\ntitle: ${SLUG}\n---\n\n${TRUTH}\n<!-- timeline -->\n${TIMELINE}`);
      const fileBefore = readFileSync(file, 'utf8');
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [sourceId, brain]);
      try {
        const outcome = await writeTimelineEntryThrough(engine, SLUG, sourceId, { date: '2026-10-03', summary: 'probe' });
        expect(outcome).toMatchObject({ handled: false });
        expect((outcome as { error?: string }).error).toContain('stores its body in segments');
      } finally {
        await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [sourceId]);
      }
      expect(readFileSync(file, 'utf8')).toBe(fileBefore);
      // Row 19: concept and enrich fence preservation.
      expectSegmented(() => preserveCanonicalFences(snapshot.page, '# replacement\n'));
      // Row 12 (tag and timeline writes through the persistence coordinator) writes segmented pages now: a tag as a
      // metadata flip, a timeline entry through the put path within 24 MiB (segmented-semantic-writes.test.ts).
      expect(await state()).toEqual(before);
    });

    test('mutation probe: forget_fact records the withdrawal and leaves the segmented body alone', async () => {
      const before = await state();
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (fact, source, source_id, entity_slug, source_markdown_slug, visibility)
        VALUES ('acme-example ships widgets', 'fixture', $1, $2, $2, 'private') RETURNING id`, [sourceId, SLUG]);
      const out = await call('forget_fact', { id: Number(fact!.id), request_id: randomUUID() });
      expect(out).toMatchObject({ state: 'committed', expired: true });
      expect(await state()).toEqual(before);
    });
  });
}
