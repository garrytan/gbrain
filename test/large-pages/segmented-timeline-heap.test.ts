/**
 * Wave B PR 2 fix lane H (finding H3): the maintenance timeline passes over a segmented page compare its blocks
 * against the page's stored timeline rows as they stream, instead of keeping every entry the body yields.
 *
 * 1. Protects: on an 18 MiB page of dated bullets whose rows are all stored, the prune pass (timeline retraction) and
 *    the managed publication's plan (gbrain extract timeline --source db on a managed brain, the sweep's publication)
 *    keep, while they read the body, only what differs from the stored rows: the heap after a full collection, sampled
 *    before each segment read, stays under the page's bytes: one key digest per stored row (TimelineKeySet), not every
 *    parsed entry, key and canonical entry (2.4-7.9 MiB held at 18 MiB, against 22-51 MiB before).
 * 2. Fails when: segmentedTimelineText keeps every parsed entry and every key, and storedCanonicalTimeline every
 *    canonical entry, until the plan ends (the heap held grows to several times the page).
 * Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: the readSegmentTexts spy samples the heap after
 * Bun.gc(true) (a heap sample, not time).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractTimelineFromDB } from '../../src/commands/extract-timeline-db.ts';
import { pruneTimelineOrphans } from '../../src/core/timeline-extract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MB = 1024 * 1024;

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
  return { content: '---\ntitle: Heap timeline\ntype: note\n---\nA short truth.\n\n<!-- timeline -->\n\n' + bullets.join(''), bullets: bullets.length };
}

for (const kind of testBackends()) {
  describe('maintenance timeline heap over a segmented page (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-timeline-heap-'));

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
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * The most JS heap held above the heap before `fn`, sampled after a full collection before each segment read: heap
     * used less ArrayBuffer backing stores, which the drivers' read buffers (grown to the largest segment response) and
     * PGLite's memory dominate; entries, keys and rows are JS objects and strings. `fn` runs once first unmeasured, so
     * the code it loads and compiles is not counted as held.
     */
    async function heldWhile(fn: () => Promise<unknown>): Promise<{ held: number; samples: number }> {
      await fn();
      const original = engine.readSegmentTexts.bind(engine);
      let peak = 0;
      let samples = 0;
      engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => {
        Bun.gc(true);
        peak = Math.max(peak, jsHeap());
        samples++;
        return original(sourceId, shas);
      }) as BrainEngine['readSegmentTexts'];
      Bun.gc(true);
      const base = jsHeap();
      try {
        await fn();
      } finally {
        delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
      }
      return { held: peak - base, samples };
    }

    test('an 18 MiB page of stored bullets: prune and the managed plan hold less than the page while they read it', async () => {
      const root = join(dir, 'brain');
      mkdirSync(root, { recursive: true });
      const sourceId = 'heap-' + kind;
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        const { content, bullets } = bulletPage(18 * MB);
        expect((await importFromContent(engine, 'notes/heap-timeline', content, { sourceId, noEmbed: true })).status).toBe('imported');
        await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: sourceId, slugs: ['notes/heap-timeline'] });
        const [page] = await engine.executeRaw<{ body_bytes: number; rows: number }>(
          "SELECT p.body_bytes, (SELECT count(*)::int FROM timeline_entries t WHERE t.page_id=p.id) AS rows FROM pages p WHERE p.slug='notes/heap-timeline' AND p.source_id=$1", [sourceId]);
        expect(page!.rows).toBe(bullets);
        const bytes = Number(page!.body_bytes);

        const prune = await heldWhile(() => pruneTimelineOrphans(engine, { sourceId, dryRun: true }));
        console.log('[timeline-heap] ' + kind + ' prune: ' + (prune.held / MB).toFixed(1) + ' MiB held over ' + prune.samples + ' segment reads of a ' + (bytes / MB).toFixed(1) + ' MiB page with ' + bullets + ' rows');

        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try {
          const plan = await heldWhile(() => extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: sourceId, slugs: ['notes/heap-timeline'] }));
          console.log('[timeline-heap] ' + kind + ' managed plan: ' + (plan.held / MB).toFixed(1) + ' MiB held over ' + plan.samples + ' segment reads');
          expect(plan.samples).toBeGreaterThan(0);
          expect(plan.held).toBeLessThan(bytes);
        } finally {
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
        expect(prune.samples).toBeGreaterThan(0);
        expect(prune.held).toBeLessThan(bytes);
      });
    }, 1_200_000);
  });
}
