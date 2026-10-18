/**
 * PR 2 fix lane J1: link/timeline extraction lists, extracts and stamps a
 * segmented page.
 *
 * 1. Protects: listStalePagesForExtraction lists exactly the pages
 *    countStalePagesForExtraction counts, inline and segmented alike, so the
 *    stale count doctor and sync status report is work an extractor does;
 *    `extract --stale` (unmanaged) reads a segmented page's links and dated
 *    lines block by block, writes its edge and timeline row and stamps it;
 *    the managed stale-links pass (no slugs given) finds and stamps one too.
 *    After either pass the count is 0.
 * 2. Fails when: the list filters segmented pages out while the count keeps
 *    them (the count stays 1 forever), or the unmanaged sweep reads a
 *    segmented page's body as one string (page_body_segmented) or as empty.
 * 3. Why existing coverage misses it: the segmented extraction tests pass the
 *    page's slug explicitly (`extract --slugs`, the managed pass's `slugs`),
 *    which never consults the stale list.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { effectiveLinkExtractorWatermark } from '../../src/core/link-extraction-watermark.ts';
import { extractManagedStaleLinks } from '../../src/core/persistence/links-maintenance.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-extract-stale-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

/** About 1.2 MiB: a link to the target early and a dated bullet at the end. */
const segmentedNote = (seed: number) => `---\ntype: note\ntitle: Segmented note\n---\n\nSee [[people/alice-example]].\n\n`
  + `${conversationBody(1_200_000, { seed })}\n\n## Timeline\n\n- **2026-03-04** | Kickoff with Alice\n`;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function staleState(engine: BrainEngine, sourceId: string): Promise<{ count: number; listed: string[] }> {
  const versionTs = await effectiveLinkExtractorWatermark(engine);
  const count = await engine.countStalePagesForExtraction({ sourceId, versionTs });
  const listed: string[] = [];
  for (let afterPageId = 0; ;) {
    const rows = await engine.listStalePagesForExtraction({ batchSize: 1, afterPageId, sourceId, versionTs });
    if (!rows.length) break;
    listed.push(...rows.map(row => row.slug));
    afterPageId = rows[rows.length - 1]!.id;
  }
  return { count, listed: listed.sort() };
}

async function extractedState(engine: BrainEngine, sourceId: string, slug: string) {
  const [page] = await engine.executeRaw<{ id: number; body_storage: string; stamped: boolean }>(
    'SELECT id, body_storage, links_extracted_at IS NOT NULL AS stamped FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  const links = await engine.executeRaw<{ slug: string }>('SELECT t.slug FROM links l JOIN pages t ON t.id=l.to_page_id WHERE l.from_page_id=$1 ORDER BY t.slug', [page!.id]);
  const timeline = await engine.executeRaw<{ date: string; summary: string }>(
    "SELECT to_char(date,'YYYY-MM-DD') AS date, summary FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL ORDER BY date", [page!.id]);
  return { body_storage: page!.body_storage, stamped: page!.stamped, links: links.map(row => row.slug), timeline };
}

/** Drop the derived rows of a source's pages and their extraction stamps, so every page needs extraction again. */
async function unextract(engine: BrainEngine, sourceId: string): Promise<void> {
  await engine.executeRaw('DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
  await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]);
  await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [sourceId]);
}

describe('segmented pages in the extraction stale list', () => {
  test('unmanaged: the list matches the count over inline and segmented pages, and extract --stale drains both', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = `xstale-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
      await engine.setConfig('pages.segmented_storage', 'off');
      await importFromContent(engine, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\n---\n\nAlice fixture.\n', { sourceId, noEmbed: true });
      await importFromContent(engine, 'notes/inline', '---\ntype: note\ntitle: Inline\n---\n\nSee [[people/alice-example]].\n', { sourceId, noEmbed: true });
      await engine.setConfig('pages.segmented_storage', 'on');
      expect(await importFromContent(engine, 'notes/segmented', segmentedNote(81), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
      await unextract(engine, sourceId);

      expect((await extractedState(engine, sourceId, 'notes/segmented')).body_storage).toBe('segmented');
      const before = await staleState(engine, sourceId);
      expect(before.listed).toEqual(['notes/inline', 'notes/segmented', 'people/alice-example']);
      expect(before.count).toBe(before.listed.length);

      const result = await extractStaleFromDB(engine, { sourceIdFilter: sourceId, quiet: true, dryRun: false, jsonMode: false, catchUp: true });
      expect(result.pagesProcessed).toBe(3);
      expect(await staleState(engine, sourceId)).toEqual({ count: 0, listed: [] });
      expect(await extractedState(engine, sourceId, 'notes/segmented')).toEqual({ body_storage: 'segmented', stamped: true,
        links: ['people/alice-example'], timeline: [{ date: '2026-03-04', summary: 'Kickoff with Alice' }] });
      expect((await extractedState(engine, sourceId, 'notes/inline')).links).toEqual(['people/alice-example']);
    }
  }), 600_000);

  test('managed: the stale-links pass without slugs lists, links and stamps a segmented page', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = `xstale-m-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice fixture.', timeline: '', frontmatter: {} }, { sourceId });
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        writeFileSync(join(root, 'notes/segmented.md'), segmentedNote(82));
        expect(await importManagedFile(engine, join(root, 'notes/segmented.md'), 'notes/segmented.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
        // The writer guard refuses direct derived-row writes while the brain is managed; the reset runs with it off.
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await unextract(engine, sourceId);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const before = await staleState(engine, sourceId);
        expect(before.listed).toEqual(['notes/segmented', 'people/alice-example']);
        expect(before.count).toBe(before.listed.length);

        const result = await extractManagedStaleLinks(engine, { sourceId, mentions: false });
        expect(result).toMatchObject({ pages: 2, skipped: 0, remaining: 0, timeline: 1 });
        expect(await staleState(engine, sourceId)).toEqual({ count: 0, listed: [] });
        expect(await extractedState(engine, sourceId, 'notes/segmented')).toEqual({ body_storage: 'segmented', stamped: true,
          links: ['people/alice-example'], timeline: [{ date: '2026-03-04', summary: 'Kickoff with Alice' }] });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    }
  }), 600_000);
});
