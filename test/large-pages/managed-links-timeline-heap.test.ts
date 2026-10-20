/**
 * Wave B PR 2 fix lane K (finding TR1): managed stale-link extraction (sync, extract --stale) over a segmented page
 * keeps, while it reads the body, only the canonical timeline entries no stored row records.
 *
 * 1. Protects: on an 8 MiB page of dated bullets whose rows are all stored, the extraction's canonical timeline read
 *    (storedCanonicalTimeline, then unrecordedCanonicalTimeline's filter inside the transaction) holds less than the
 *    page (heap after a full collection, sampled before each segment read, after each query with its rows held and
 *    with its result held, above the settled heap after a warm-up read of a small segmented page): the stored rows
 *    are walked in pages and held as key digests (TimelineKeySet), and the read keeps no entry. The full
 *    extractManagedStaleLinks run keeps no entry (canonicalTimelineWork.kept 0) and walks every stored row once per
 *    pass; with rows deleted, the read keeps exactly those entries and the extraction inserts them back.
 * 2. Fails when: storedCanonicalTimeline keeps every canonical entry of the body, or unrecordedCanonicalTimeline reads
 *    every stored row as one array (several times the page held, about 200 MiB at 24 MiB).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: the readSegmentTexts and executeRaw spies sample
 *    the heap after Bun.gc(true) (a heap sample, not time); the work counter counts entries and rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractTimelineFromDB } from '../../src/commands/extract-timeline-db.ts';
import { extractManagedStaleLinks } from '../../src/core/persistence/links-maintenance.ts';
import { canonicalTimelineWork, storedCanonicalTimeline, unrecordedCanonicalTimeline } from '../../src/core/persistence/canonical-projections.ts';
import { bodyUnread } from '../../src/core/page-body/page-shape.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MB = 1024 * 1024;
const SLUG = 'notes/managed-links-timeline';
const WARM_SLUG = 'notes/managed-links-timeline-warm-up';

const jsHeap = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed - usage.arrayBuffers;
};

/** A short truth, then about `bytes` of dated bullets with distinct summaries, no blank line. */
function bulletPage(bytes: number): { content: string; bullets: number } {
  const bullets: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = '- **20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Met acme-example about item ' + i + ' of the rollout plan ' + 'and its review '.repeat(8) + '\n';
    bullets.push(line);
    size += line.length;
  }
  return { content: '---\ntitle: Managed links timeline\ntype: note\n---\nA short truth.\n\n<!-- timeline -->\n\n' + bullets.join(''), bullets: bullets.length };
}

for (const kind of testBackends()) {
  describe('managed stale-link extraction timeline heap over a segmented page (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-links-timeline-'));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(dir, 'db') });
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * The JS heap after a full collection at a fresh event-loop turn, repeated until one frees nothing more, so garbage a
     * collection right after the warm-up left is gone.
     */
    async function settledHeap(): Promise<number> {
      let heap = Infinity;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setImmediate(resolve));
        Bun.gc(true);
        const next = jsHeap();
        if (next >= heap) return heap;
        heap = next;
      }
      return heap;
    }

    /**
     * The most JS heap held above the settled heap before `fn` (settledHeap), sampled after a full collection before each
     * segment read, after each query with its rows still held, and once more with its result still held. `warmUp` (the
     * same read over a small page) runs first unmeasured, so code it loads is not counted as held, and what a full
     * collection still finds of it (a stale stack slot keeps a query result) is small. A sample is measured against that
     * baseline only: heap the process frees later (warm-up garbage, JIT code) never counts as held by the read.
     */
    async function heldWhile(warmUp: () => Promise<unknown>, fn: () => Promise<unknown>): Promise<{ held: number; samples: number }> {
      await warmUp();
      const original = { readSegmentTexts: engine.readSegmentTexts.bind(engine), executeRaw: engine.executeRaw.bind(engine) };
      let peak = 0;
      let samples = 0;
      const sample = () => { Bun.gc(true); peak = Math.max(peak, jsHeap()); samples++; };
      const baseline = await settledHeap();
      engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => {
        sample();
        return original.readSegmentTexts(sourceId, shas);
      }) as BrainEngine['readSegmentTexts'];
      engine.executeRaw = (async (sql: string, params?: unknown[]) => {
        const rows = await original.executeRaw(sql, params);
        sample();
        return rows;
      }) as BrainEngine['executeRaw'];
      let result: unknown;
      try {
        result = await fn();
        sample();
      } finally {
        delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
        delete (engine as { executeRaw?: unknown }).executeRaw;
      }
      expect(result).toBeDefined();
      return { held: peak - baseline, samples };
    }

    test('an 8 MiB page of stored bullets: the canonical timeline read keeps no entry and holds less than the page', async () => {
      const root = join(dir, 'brain');
      mkdirSync(root, { recursive: true });
      const sourceId = 'links-' + kind;
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        const warmSourceId = sourceId + '-warm-up';
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [warmSourceId, join(dir, 'warm-up')]);
        const { content, bullets } = bulletPage(8 * MB);
        expect((await importFromContent(engine, SLUG, content, { sourceId, noEmbed: true })).status).toBe('imported');
        await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: sourceId, slugs: [SLUG] });
        expect((await importFromContent(engine, WARM_SLUG, bulletPage(MB + MB / 8).content, { sourceId: warmSourceId, noEmbed: true })).status).toBe('imported');
        await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: warmSourceId, slugs: [WARM_SLUG] });
        const rows = async () => (await engine.executeRaw<{ body_bytes: number; rows: number }>(
          'SELECT p.body_bytes, (SELECT count(*)::int FROM timeline_entries t WHERE t.page_id=p.id) AS rows FROM pages p WHERE p.slug=$2 AND p.source_id=$1', [sourceId, SLUG]))[0]!;
        const page = await rows();
        expect(page.rows).toBe(bullets);
        const bytes = Number(page.body_bytes);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId }))!;

        const warm = (await engine.readPageSnapshot(WARM_SLUG, { sourceId: warmSourceId }))!;
        expect(bodyUnread(warm.page)).toBe(true);
        const canonicalRead = (page: typeof snapshot.page, slug: string) => async () => {
          const canonical = await storedCanonicalTimeline(engine, page, slug);
          return { canonical, unrecorded: await unrecordedCanonicalTimeline(engine, Number(page.id), canonical, slug) };
        };
        const read = await heldWhile(canonicalRead(warm.page, WARM_SLUG), canonicalRead(snapshot.page, SLUG));
        console.log('[managed-links-timeline] ' + kind + ': ' + (read.held / MB).toFixed(1) + ' MiB held over ' + read.samples + ' samples of a '
          + (bytes / MB).toFixed(1) + ' MiB page with ' + bullets + ' rows');
        expect(read.samples).toBeGreaterThan(1);
        expect(read.held).toBeLessThan(bytes);

        const extract = () => extractManagedStaleLinks(engine, { sourceId, slugs: [SLUG], mentions: false });
        canonicalTimelineWork.storedRows = canonicalTimelineWork.kept = 0;
        expect((await extract()).timeline).toBe(0);
        expect(canonicalTimelineWork.kept).toBe(0);
        expect(canonicalTimelineWork.storedRows).toBe(2 * bullets);

        const gone = (await engine.executeRaw<{ id: number }>(
          'DELETE FROM timeline_entries WHERE id IN (SELECT t.id FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND p.source_id=$2 ORDER BY t.id LIMIT 7) RETURNING id',
          [SLUG, sourceId])).length;
        expect(gone).toBe(7);
        canonicalTimelineWork.storedRows = canonicalTimelineWork.kept = 0;
        expect((await extract()).timeline).toBe(7);
        expect(canonicalTimelineWork.kept).toBe(7);
        expect((await rows()).rows).toBe(bullets);
      });
    }, 1_200_000);
  });
}
