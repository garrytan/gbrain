/**
 * Wave B PR 2 fix lane H (finding H2): the sweep's links/timeline pass over deferred and budgeted segmented pages.
 *
 * 1. Protects: (a) a deferred segmented page is left out of the pass's page query, so the pages behind it (older,
 *    inline ones included) are still reached when the newest batchLimit stale pages are deferred; (b) a segmented
 *    page that stops after other work of the sweep spent the budget is left for the next sweep, not deferred until
 *    it changes, and the next sweep extracts it; (c) on a managed brain the timeline publication's planning read
 *    asks the sweep budget before each segment, so a page whose publication does not fit stops there and is deferred;
 *    one that fits is read twice by the publication (its plan, the coordinator's apply), each read once.
 * 2. Fails when: (a) deferred pages are filtered after LIMIT batchLimit (sweep 2 gives linksExtracted 0 and only
 *    segmented_page_deferred); (b) any stopped page is deferred (the small page stays unextracted after a sweep with
 *    budget to spare); (c) publishManagedPageTimeline reads the page about four times with no budget, so the pass
 *    reads far past it, and seven times the page with budget to spare instead of five.
 * Seams: the sweep's clock (opts.now) advances with segmentedPassWork.bytes, plus a fixed charge per inline page
 * read through a getPage wrapper, so the budget is a work budget and no machine load moves it.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runMaintenanceSweep, _resetDeferredSegmentedPagesForTests } from '../../src/core/sweep.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MB = 1024 * 1024;
/** Clock ms per segmented byte read. */
const BYTES_PER_MS = 1024;

/** About `bytes` of paragraphs (the first names the person page), then `bullets` dated bullets in the timeline. */
function segmentedPage(title: string, bytes: number, bullets: number): string {
  const paras: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const p = 'Paragraph ' + i + ' notes that the widget plan moved again; the team met ' + (i === 0 ? '[[people/alice-example]]' : 'the vendor') + ' to review the ' + 'rollout '.repeat(40) + '\n\n';
    paras.push(p);
    size += p.length;
  }
  const timeline = Array.from({ length: bullets }, (_, i) => '- **2025-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Review ' + i + ' of the widget plan').join('\n');
  return '---\ntype: note\ntitle: ' + title + '\n---\n' + paras.join('') + '<!-- timeline -->\n\n' + timeline + '\n';
}

const inlinePage = (i: number) => '---\ntype: note\ntitle: Inline ' + i + '\n---\nMet [[people/alice-example]] about item ' + i + '.\n';

for (const kind of testBackends()) {
  describe('sweep deferral of segmented pages (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let start = 0;
    let charged = 0;
    const now = () => start + segmentedPassWork.bytes / BYTES_PER_MS + charged;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-deferral-'));

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(dir, 'db') });
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      _resetDeferredSegmentedPagesForTests();
      segmentedPassWork.bytes = 0;
      charged = 0;
      start = 1_000_000;
      // Every page written so far counts as extracted (links_extracted_at a day ahead), so each test sweeps its own pages.
      await engine.executeRaw("UPDATE pages SET links_extracted_at = now() + interval '1 day'");
    });

    /** The sweep's stamp: a links_extracted_at the sweep wrote (not the day-ahead one beforeEach set), or null. */
    const stamped = async (slug: string, sourceId = 'default') => (await engine.executeRaw<{ at: unknown }>(
      "SELECT links_extracted_at AS at FROM pages WHERE slug=$1 AND source_id=$2 AND links_extracted_at < now() + interval '1 hour'", [slug, sourceId]))[0]?.at ?? null;
    const reasons = (r: { skipped: Array<{ reason: string }> }) => r.skipped.map(s => s.reason);

    test('(a) a deferred page does not take the batch slots of the older pages behind it', async () => {
      expect((await importFromContent(engine, 'notes/older-inline', inlinePage(0), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      await Bun.sleep(5);
      expect((await importFromContent(engine, 'notes/deferred-large', segmentedPage('Deferred large', 6 * MB, 50), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const budgetMs = (2 * MB) / BYTES_PER_MS;
      const first = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 1, now });
      expect(reasons(first)).toContain('budget_deferred:segmented_page');
      expect(await stamped('notes/deferred-large')).toBeNull();

      segmentedPassWork.bytes = 0;
      const second = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 1, now });
      console.log('[sweep-deferral] ' + kind + ' (a) second sweep: ' + JSON.stringify({ links: second.linksExtracted, skipped: second.skipped }));
      expect(reasons(second)).toContain('segmented_page_deferred');
      expect(segmentedPassWork.bytes).toBe(0);
      expect(second.linksExtracted).toBeGreaterThanOrEqual(1);
      expect(await stamped('notes/older-inline')).not.toBeNull();
    }, 300_000);

    test('(b) a page stopped after inline work spent the budget is left for the next sweep, which extracts it', async () => {
      for (let i = 1; i <= 3; i++) expect((await importFromContent(engine, 'notes/busy-inline-' + i, inlinePage(i), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      expect((await importFromContent(engine, 'notes/small-segmented', segmentedPage('Small segmented', 2 * MB, 20), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const budgetMs = (10 * MB) / BYTES_PER_MS;
      const perInline = (budgetMs - (MB / 2) / BYTES_PER_MS) / 3;
      const getPage = engine.getPage.bind(engine);
      engine.getPage = (async (slug: string, opts?: Parameters<BrainEngine['getPage']>[1]) => {
        if (slug.startsWith('notes/busy-inline-')) charged += perInline;
        return getPage(slug, opts);
      }) as BrainEngine['getPage'];
      try {
        const first = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 20, now });
        console.log('[sweep-deferral] ' + kind + ' (b) first sweep: ' + segmentedPassWork.bytes + ' bytes, ' + JSON.stringify({ links: first.linksExtracted, skipped: first.skipped }));
        for (let i = 1; i <= 3; i++) expect(await stamped('notes/busy-inline-' + i)).not.toBeNull();
        expect(await stamped('notes/small-segmented')).toBeNull();
        expect(reasons(first)).not.toContain('budget_deferred:segmented_page');

        segmentedPassWork.bytes = 0;
        charged = 0;
        const second = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 20, now });
        console.log('[sweep-deferral] ' + kind + ' (b) second sweep: ' + segmentedPassWork.bytes + ' bytes, ' + JSON.stringify({ links: second.linksExtracted, skipped: second.skipped }));
        expect(reasons(second)).not.toContain('segmented_page_deferred');
        expect(await stamped('notes/small-segmented')).not.toBeNull();
      } finally {
        delete (engine as { getPage?: unknown }).getPage;
      }
    }, 300_000);

    test('(c) managed: the timeline publication reads under the sweep budget and a page that does not fit is deferred', async () => {
      const root = join(dir, 'brain-' + kind);
      mkdirSync(root, { recursive: true });
      const sourceId = 'deferral-' + kind;
      await withEnv({ GBRAIN_HOME: join(dir, 'home-' + kind), GBRAIN_AUDIT_DIR: join(dir, 'audit-' + kind) }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId });
        expect((await importFromContent(engine, 'notes/managed-large', segmentedPage('Managed large', 3 * MB, 40), { sourceId, noEmbed: true })).status).toBe('imported');
        const [page] = await engine.executeRaw<{ body_bytes: number; body_storage: string }>('SELECT body_bytes, body_storage FROM pages WHERE slug=$1 AND source_id=$2', ['notes/managed-large', sourceId]);
        expect(page!.body_storage).toBe('segmented');
        const bytes = Number(page!.body_bytes);
        await engine.executeRaw("UPDATE pages SET links_extracted_at = now() + interval '1 day' WHERE source_id=$1 AND slug='people/alice-example'", [sourceId]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try {
          // Room for the extraction's three reads and half of the publication's planning read.
          const budgetMs = (3.5 * bytes) / BYTES_PER_MS;
          const r = await runMaintenanceSweep(engine, { sourceId, budgetMs, batchLimit: 20, now });
          console.log('[sweep-deferral] ' + kind + ' (c) managed, over budget: ' + segmentedPassWork.bytes + ' bytes for a ' + bytes + '-byte page, ' + JSON.stringify({ timeline: r.timelineExtracted, skipped: r.skipped }));
          expect(reasons(r)).not.toContain('links_timeline_error');
          expect(reasons(r)).not.toContain('timeline_publish_failed');
          expect(segmentedPassWork.bytes).toBeLessThanOrEqual(3.5 * bytes + SEGMENT_MAX_BYTES);
          expect(reasons(r)).toContain('budget_deferred:segmented_page');
          expect(await stamped('notes/managed-large', sourceId)).toBeNull();

          // With budget to spare the publication reads the page twice (its plan, then the coordinator's apply).
          _resetDeferredSegmentedPagesForTests();
          segmentedPassWork.bytes = 0;
          const fits = await runMaintenanceSweep(engine, { sourceId, budgetMs: (100 * bytes) / BYTES_PER_MS, batchLimit: 20, now });
          console.log('[sweep-deferral] ' + kind + ' (c) managed, fits: ' + segmentedPassWork.bytes + ' bytes (' + (segmentedPassWork.bytes / bytes).toFixed(2) + ' reads), ' + JSON.stringify({ timeline: fits.timelineExtracted, skipped: fits.skipped }));
          expect(fits.timelineExtracted).toBe(40);
          expect(await stamped('notes/managed-large', sourceId)).not.toBeNull();
          expect(segmentedPassWork.bytes).toBeLessThanOrEqual(5 * bytes);
        } finally {
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    }, 300_000);
  });
}
