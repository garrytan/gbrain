/**
 * Wave B PR 2 fix lane C1 (findings C5, C6): the maintenance sweep's links/timeline pass over a segmented page.
 *
 * 1. Protects (C5): a segmented page never shares a batch with the inline pages, and its reads ask the sweep budget
 *    before each segment: a page that does not fit stops at a segment bound and is deferred (unstamped, skipped by
 *    later sweeps in this process until it changes) while every inline page in the batch still links; a page that
 *    fits is read at most three times (its role phrases, the first extraction with its timeline entries, the typed
 *    extraction) instead of five. (C6) The timeline entries the pass keeps until publication are copies, so they do
 *    not keep the page's blocks alive.
 * 2. Fails when: the segmented page is one unbounded sweep item processed first, so it reads its whole body several
 *    times past the budget and the inline pages behind it get nothing (linksExtracted 0, budget_exhausted); or each
 *    parsed entry pins its block until the batch publishes.
 * Seams: the sweep's clock (opts.now) advances only with segmentedPassWork.bytes, the bytes the segmented reads take,
 * so the budget is a byte budget here and no machine load moves it; the heap is sampled after a full collection
 * when the pass opens its publication transactions (engine.transaction), with the batch's timeline rows alive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runMaintenanceSweep, _resetDeferredSegmentedPagesForTests } from '../../src/core/sweep.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MB = 1024 * 1024;
/** Clock ms per segmented byte read: a budget of B ms lets the pass read B x BYTES_PER_MS bytes. */
const BYTES_PER_MS = 1024;

/**
 * About `bytes` of paragraphs (the first names the person page), a dated bullet after every `every` paragraphs (so every block
 * holds timeline entries), and `bullets` dated bullets in the timeline.
 */
function segmentedPage(title: string, bytes: number, bullets: number, every = 0): string {
  const paras: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const p = 'Paragraph ' + i + ' notes that the widget plan moved again; the team met ' + (i === 0 ? '[[people/alice-example]]' : 'the vendor') + ' to review the ' + 'rollout '.repeat(40) + '\n\n'
      + (every && i % every === every - 1 ? '- **2024-0' + (1 + (i % 9)) + '-2' + (i % 10) + '** | Body review ' + i + '\n\n' : '');
    paras.push(p);
    size += p.length;
  }
  const timeline = Array.from({ length: bullets }, (_, i) => '- **2025-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Review ' + i + ' of the widget plan').join('\n');
  return '---\ntype: note\ntitle: ' + title + '\n---\n' + paras.join('') + '<!-- timeline -->\n\n' + timeline + '\n';
}

const inlinePage = (i: number) => '---\ntype: note\ntitle: Inline ' + i + '\n---\nMet [[people/alice-example]] about item ' + i + '.\n';

for (const kind of testBackends()) {
  describe('sweep links/timeline over a segmented page (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let start = 0;
    const now = () => start + segmentedPassWork.bytes / BYTES_PER_MS;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Fixture.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    }, 120_000);

    afterAll(async () => { await close(); });

    beforeEach(() => {
      _resetDeferredSegmentedPagesForTests();
      segmentedPassWork.bytes = 0;
      start = 1_000_000;
    });

    const stamped = async (slug: string) => (await engine.executeRaw<{ at: unknown }>('SELECT links_extracted_at AS at FROM pages WHERE slug=$1', [slug]))[0]?.at ?? null;
    const bodyBytes = async (slug: string) => Number((await engine.executeRaw<{ n: unknown }>('SELECT body_bytes AS n FROM pages WHERE slug=$1', [slug]))[0]!.n);

    test('a segmented page over the budget is deferred at a segment bound and the inline pages still link', async () => {
      for (let i = 0; i < 3; i++) await importFromContent(engine, 'notes/inline-' + i, inlinePage(i), { sourceId: 'default', noEmbed: true });
      expect((await importFromContent(engine, 'notes/too-large', segmentedPage('Too large', 6 * MB, 50), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const budgetMs = (2 * MB) / BYTES_PER_MS;
      const r = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 20, now });
      console.log('[segmented-sweep] ' + kind + ' over budget: ' + segmentedPassWork.bytes + ' bytes read, report ' + JSON.stringify({ linksExtracted: r.linksExtracted, skipped: r.skipped }));
      expect(r.linksExtracted).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < 3; i++) expect(await stamped('notes/inline-' + i)).not.toBeNull();
      expect(r.skipped.map(s => s.reason)).toContain('budget_deferred:segmented_page');
      expect(segmentedPassWork.bytes).toBeLessThanOrEqual(budgetMs * BYTES_PER_MS + SEGMENT_MAX_BYTES);
      expect(await stamped('notes/too-large')).toBeNull();

      segmentedPassWork.bytes = 0;
      const again = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs, batchLimit: 20, now });
      expect(again.skipped.map(s => s.reason)).toContain('segmented_page_deferred');
      expect(segmentedPassWork.bytes).toBe(0);
    }, 300_000);

    test('a segmented page that fits is read at most three times, and its kept timeline entries pin no block', async () => {
      await engine.executeRaw("UPDATE pages SET links_extracted_at = now() WHERE slug <> 'notes/fits'");
      const content = segmentedPage('Fits', 20 * MB, 400, 16);
      const bodyBullets = content.split('| Body review ').length - 1;
      expect((await importFromContent(engine, 'notes/fits', content, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const bytes = await bodyBytes('notes/fits');
      let peak = 0;
      const transaction = engine.transaction.bind(engine);
      engine.transaction = (async (fn: Parameters<BrainEngine['transaction']>[0]) => {
        Bun.gc(true);
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        return transaction(fn);
      }) as BrainEngine['transaction'];
      Bun.gc(true);
      const base = process.memoryUsage().heapUsed;
      let r: Awaited<ReturnType<typeof runMaintenanceSweep>>;
      try { r = await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs: 1_000_000, batchLimit: 20, now }); } finally { engine.transaction = transaction; }
      const held = peak - base;
      console.log('[segmented-sweep] ' + kind + ' fits: ' + segmentedPassWork.bytes + ' bytes read for a ' + bytes + '-byte page ('
        + (segmentedPassWork.bytes / bytes).toFixed(2) + ' reads), heap held ' + (held / MB).toFixed(1) + ' MiB, report ' + JSON.stringify({ links: r!.linksExtracted, timeline: r!.timelineExtracted, skipped: r!.skipped }));
      expect(await stamped('notes/fits')).not.toBeNull();
      expect(peak).toBeGreaterThan(0);
      expect(r!.timelineExtracted).toBeGreaterThan(0);
      const rows = await engine.executeRaw<{ n: unknown }>("SELECT count(*) AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug='notes/fits'");
      expect(Number(rows[0]!.n)).toBe(400 + bodyBullets);
      expect(segmentedPassWork.bytes).toBeLessThanOrEqual(3 * bytes);
      expect(held).toBeLessThan(bytes / 2);
    }, 600_000);
  });
}
