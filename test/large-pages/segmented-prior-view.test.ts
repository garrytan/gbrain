/**
 * Wave B PR 2 fix lane C1 (finding C4): a write over a segmented prior reads its body once and keeps no copy of its
 * timeline.
 *
 * 1. Protects: the write path's three prior-view calls for one snapshot (materializeTimeline, timelineRowsToRemove,
 *    prepareCanonicalProjections) read the prior segmented body once between them (the view is cached for the
 *    snapshot and its stored rows), in one pass for the timeline and both takes fields; while the view is alive the
 *    heap holds one flag per stored row, not the prior body's timeline entries; and the rows a write drops are still
 *    reported removed.
 * 2. Fails when: each call rebuilds the view and each view reads the body twice (six reads per write), or the view
 *    keeps every entry of the prior body (key, summary, detail and slug copies: 12.8x the body for a 6 MiB page).
 * Seams: segmentedPassWork.bytes (segment-blocks.ts) counts bytes read; the heap is sampled after a full collection
 * when classification first reads the new body, with the prior view built and alive, against a baseline taken after a
 * warm-up call on another snapshot and one small statement on every pooled connection. The pool hands statements out in
 * turn, so the warm-up and the measured call end on different connections: a connection that kept its last segment
 * read (its receive buffer, or the statement and its rows) held up to 3 MiB of the prior body that the baseline did not,
 * so the driver keeps neither (vendor/postgres connection.js). The warm-up's new body is small: an in-flight concurrent
 * JIT compilation keeps the values its profiles saw alive as a GC root outside the heap graph, so a sliced line of the
 * warm-up's text could pin that whole text at the sample and not at the baseline (with the 6 MiB new body, its
 * sanitized copy: 8.4 MiB held in about one run in ten).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { materializeTimeline, prepareCanonicalProjections, timelineRowsToRemove } from '../../src/core/persistence/canonical-projections.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MB = 1024 * 1024;
const SLUG = 'notes/prior-view';
const KEPT_ROWS = 50;
const DROPPED = 10;

function bullet(i: number): string {
  return '- **20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Met acme-example about item ' + i + ' and the widget plan';
}

/** A short truth and about 6 MiB of dated bullets. */
function page(from: number, count: number): string {
  return '---\ntitle: Prior view\ntype: note\n---\nA short truth.\n\n<!-- timeline -->\n\n' + Array.from({ length: count }, (_, i) => bullet(from + i)).join('\n') + '\n';
}

const BULLETS = Math.ceil(6 * MB / 80);

for (const kind of testBackends()) {
  describe('prior view of a segmented page (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let bodyBytes = 0;

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
      expect((await importFromContent(engine, SLUG, page(0, BULLETS), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const [row] = await engine.executeRaw<{ id: number; body_bytes: number; body_storage: string }>('SELECT id, body_bytes, body_storage FROM pages WHERE slug=$1', [SLUG]);
      expect(row!.body_storage).toBe('segmented');
      bodyBytes = Number(row!.body_bytes);
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [row!.id]);
      for (let i = 0; i < KEPT_ROWS; i++) {
        const date = '20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10);
        await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES ($1, $2::date, 'markdown', $3, '')",
          [row!.id, date, 'Met acme-example about item ' + i + ' and the widget plan']);
      }
    }, 300_000);

    afterAll(async () => { await close(); });

    test('the three prior-view calls of one write read the prior body once', async () => {
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      const next = parseMarkdown(page(DROPPED, BULLETS - DROPPED), SLUG);
      segmentedPassWork.bytes = 0;
      await materializeTimeline(engine, next, SLUG, snapshot, 'editing');
      expect((await timelineRowsToRemove(engine, next, snapshot, SLUG, 'editing'))?.count).toBe(DROPPED);
      await prepareCanonicalProjections(engine, next, SLUG, 'default', snapshot, 'editing');
      console.log('[segmented-prior-view] ' + kind + ': ' + segmentedPassWork.bytes + ' bytes read for a ' + bodyBytes + '-byte prior (' + (segmentedPassWork.bytes / bodyBytes).toFixed(2) + ' reads)');
      expect(segmentedPassWork.bytes).toBeLessThanOrEqual(bodyBytes);
    }, 300_000);

    test('while the prior view is alive the heap holds no copy of the prior timeline', async () => {
      const parsed = parseMarkdown(page(DROPPED, BULLETS - DROPPED), SLUG);
      const warm = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      const small = parseMarkdown(page(DROPPED, KEPT_ROWS - DROPPED), SLUG);
      expect((await timelineRowsToRemove(engine, small, warm, SLUG, 'editing'))?.count).toBe(DROPPED);
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      let peak = 0;
      const body = { compiled_truth: parsed.compiled_truth, get timeline() {
        Bun.gc(true);
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        return parsed.timeline;
      } };
      await Promise.all(Array.from({ length: 8 }, () => engine.executeRaw('SELECT 1')));
      Bun.gc(true);
      const base = process.memoryUsage().heapUsed;
      expect((await timelineRowsToRemove(engine, body, snapshot, SLUG, 'editing'))?.count).toBe(DROPPED);
      const held = peak - base;
      console.log('[segmented-prior-view] ' + kind + ': heap held with the prior view alive ' + (held / MB).toFixed(1) + ' MiB for a ' + (bodyBytes / MB).toFixed(1) + ' MiB prior');
      expect(peak).toBeGreaterThan(0);
      expect(held).toBeLessThan(bodyBytes);
    }, 300_000);
  });
}
