/**
 * Wave B PR 2 lane 2e (spec 8, full-pass mode): the unmanaged derived passes
 * read a segmented page block by block instead of skipping it or reading its
 * NULL body columns.
 *
 * 1. Protects: on a segmented page whose links, dated bullets, takes fence and
 *    entity mentions sit past its first segment,
 *    - the mention pass links it and records it scanned (it used to stay due);
 *    - extract takes (db) indexes its fence rows;
 *    - extract timeline (db) inserts its dated rows;
 *    - the maintenance sweep extracts its links and timeline (it used to skip
 *      `page_body_segmented:links_timeline`);
 *    - source link reconciliation publishes its links (it used to fail the page
 *      `page_body_segmented`);
 *    - the timeline orphan prune keeps a row the segmented body still holds
 *      (it read the NULL columns as the text `null` and retracted rows an
 *      earlier inline version produced).
 * 2. Fails when: a pass skips segmented pages again, reads `compiled_truth`
 *    of a segmented row, or a block reader loses a bullet or a fence.
 * 3. Why existing coverage misses it: segmented-derived-work.test.ts covers the
 *    managed paths; these unmanaged walkers had no segmented page.
 * Seams: none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runMentionPass } from '../../src/core/mentions/pass.ts';
import { extractTakesFromDb } from '../../src/core/cycle/extract-takes.ts';
import { extractTimelineFromDB } from '../../src/commands/extract-timeline-db.ts';
import { runMaintenanceSweep } from '../../src/core/sweep.ts';
import { reconcileSourceLinks } from '../../src/core/link-reconciliation.ts';
import { pruneTimelineOrphans } from '../../src/core/timeline-extract.ts';
import { loadActivePackForLocalEngine } from '../../src/core/schema-pack/best-effort.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const SLUG = 'notes/segmented-passes';
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

/** ~2.6 MiB: every derived input sits after the first ~1.2 MiB of conversation. */
function page(opts: { bullets?: string[] } = {}): string {
  const bullets = opts.bullets ?? ['- **2026-03-04** | Kickoff with [[people/alice-example]]', '- **2026-04-05** | Pricing review'];
  return `---\ntype: note\ntitle: Passes\n---\n\n${conversationBody(1_200_000, { seed: 31 })}\n\n## Notes\n\n`
    + `Met [[people/alice-example]]; Alice Example works at [Acme Example](../companies/acme-example.md).\n\n`
    + `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n`
    + `| 1 | Acme ships quarterly | fact | world | 1.0 | 2026-01 | notes |\n${TAKES_FENCE_END}\n\n`
    + `${conversationBody(1_200_000, { seed: 32 })}\n\n## Timeline\n\n${bullets.join('\n')}\n`;
}

const pageId = async (engine: BrainEngine) => Number((await engine.executeRaw<{ id: number }>(
  "SELECT id FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0]!.id);
const linkTargets = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; link_source: string }>(
  `SELECT DISTINCT t.slug, l.link_source FROM links l JOIN pages t ON t.id=l.to_page_id WHERE l.from_page_id=$1 ORDER BY t.slug, l.link_source`,
  [await pageId(engine)]));
const timelineRows = async (engine: BrainEngine) => (await engine.executeRaw<{ date: string; summary: string }>(
  `SELECT to_char(date,'YYYY-MM-DD') AS date, summary FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL ORDER BY date`, [await pageId(engine)]));

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

beforeEach(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM pages');
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('auto_link', 'false');
    for (const [slug, type, title] of [['people/alice-example', 'person', 'Alice Example'], ['companies/acme-example', 'company', 'Acme Example']] as const) {
      await engine.putPage(slug, { type, title, compiled_truth: `${title} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    }
    expect(await importFromContent(engine, SLUG, page(), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    expect((await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE slug=$1", [SLUG]))[0]!.body_storage).toBe('segmented');
    await engine.executeRaw('DELETE FROM links WHERE from_page_id=$1', [await pageId(engine)]);
    await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [await pageId(engine)]);
    await engine.executeRaw('DELETE FROM takes WHERE page_id=$1', [await pageId(engine)]);
  }
}, 300_000);

describe('unmanaged derived passes on a segmented page', () => {
  test('the mention pass links the segmented page and records it scanned', async () => {
    for (const engine of engines) {
      await engine.setConfig('auto_link', 'true');
      const result = await runMentionPass(engine, { sourceId: 'default' });
      expect(result.state).toBe('complete');
      expect((await linkTargets(engine)).filter(link => link.link_source === 'mentions').map(link => link.slug))
        .toEqual(['companies/acme-example', 'people/alice-example']);
      const [state] = await engine.executeRaw<{ scanned: boolean }>('SELECT mention_revision IS NOT NULL AS scanned FROM page_mention_state WHERE page_id=$1', [await pageId(engine)]);
      expect(state?.scanned).toBe(true);
    }
  }, 300_000);

  test('extract takes (db) indexes the fence rows of the segmented page', async () => {
    for (const engine of engines) {
      const result = await extractTakesFromDb(engine, { slugs: [SLUG] });
      expect(result).toMatchObject({ pagesWithTakes: 1, takesUpserted: 1, warnings: [] });
      expect(await engine.executeRaw('SELECT row_num, claim FROM takes WHERE page_id=$1', [await pageId(engine)]))
        .toEqual([{ row_num: 1, claim: 'Acme ships quarterly' }]);
    }
  }, 300_000);

  test('extract timeline (db) inserts the dated rows of the segmented page', async () => {
    for (const engine of engines) {
      const result = await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'default', slugs: [SLUG] });
      expect(result.refused).toBe(0);
      expect(await timelineRows(engine)).toEqual([{ date: '2026-03-04', summary: 'Kickoff with [[people/alice-example]]' }, { date: '2026-04-05', summary: 'Pricing review' }]);
    }
  }, 300_000);

  test('the maintenance sweep extracts the links and timeline of the segmented page', async () => {
    for (const engine of engines) {
      await engine.setConfig('auto_link', 'true');
      const report = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs: 120_000 });
      expect(report.skipped.map(skip => skip.reason)).not.toContain('page_body_segmented:links_timeline');
      expect(report.timelineExtracted).toBe(2);
      expect((await linkTargets(engine)).map(link => link.slug)).toContain('people/alice-example');
      expect((await linkTargets(engine)).map(link => link.slug)).toContain('companies/acme-example');
    }
  }, 300_000);

  test('source link reconciliation publishes the links of the segmented page', async () => {
    for (const engine of engines) {
      const pack = (await loadActivePackForLocalEngine(engine, { sourceId: 'default' }))!.manifest;
      const result = await reconcileSourceLinks(engine, 'default', { pack });
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect((await linkTargets(engine)).map(link => link.slug)).toEqual(expect.arrayContaining(['companies/acme-example', 'people/alice-example']));
    }
  }, 300_000);

  test('the timeline orphan prune keeps a row the segmented body still holds', async () => {
    for (const engine of engines) {
      // An earlier inline version produced both rows; the segmented page still holds both bullets.
      await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline, frontmatter)
        VALUES ($1, '## Timeline\n\n- **2026-03-04** | Kickoff with [[people/alice-example]]\n- **2026-04-05** | Pricing review', '', '{}'::jsonb)`, [await pageId(engine)]);
      await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'default', slugs: [SLUG] });
      expect(await timelineRows(engine)).toHaveLength(2);
      const pruned = await pruneTimelineOrphans(engine, { sourceId: 'default', dryRun: false });
      expect(pruned.removed).toBe(0);
      expect(await timelineRows(engine)).toHaveLength(2);
    }
  }, 300_000);
});
