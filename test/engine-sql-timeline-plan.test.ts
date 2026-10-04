/**
 * Cat7-1: the unscoped `getTimeline` read keeps a planner-proof shape.
 *
 * Protects: once planner statistics exist (F4b's automatic ANALYZE), the
 * unscoped read still reaches `pages` only through full `(source_id, slug)`
 * index probes, and it still returns every same-slug page's entries across
 * sources.
 * Fails when: the read filters `pages` by slug alone, so with statistics the
 * planner drives from pages and scans all of `pages_source_slug_key` (no index
 * leads with slug): gbrain-evals' Cat 7 get_timeline at 1,000 pages doubled.
 * Seams: none; in-memory PGLite (the SQL is shared with Postgres, whose plan
 * is pinned in test/e2e/engine-parity.test.ts).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { timelinePageScans } from './helpers/timeline-plan.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO pages (slug, type, title) SELECT 'people/person-' || g, 'person', 'Person ' || g FROM generate_series(0, 999) g`);
  await engine.putPage('people/person-7', { type: 'person', title: 'Person 7 (beta)', compiled_truth: 'beta copy' }, { sourceId: 'beta' });
  await engine.addTimelineEntry('people/person-7', { date: '2026-02-02', source: 'notes', summary: 'default event' });
  await engine.addTimelineEntry('people/person-7', { date: '2026-03-03', source: 'notes', summary: 'beta event' }, { sourceId: 'beta' });
  await engine.executeRaw('ANALYZE sources, pages, timeline_entries');
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('with planner statistics the unscoped read probes pages by (source_id, slug), never by slug alone', async () => {
  for (const slug of ['people/person-7', 'people/person-500']) {
    const scans = await timelinePageScans(engine, slug);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan.node).toMatch(/Index/);
      expect(scan.cond).toContain('source_id');
      expect(scan.cond).toContain('slug');
    }
  }
});

test('the unscoped read returns every same-slug page across sources; scoped reads stay in scope', async () => {
  expect((await engine.getTimeline('people/person-7')).map(e => e.summary)).toEqual(['beta event', 'default event']);
  expect((await engine.getTimeline('people/person-7', { sourceId: 'beta' })).map(e => e.summary)).toEqual(['beta event']);
  expect((await engine.getTimeline('people/person-7', { sourceIds: ['default'] })).map(e => e.summary)).toEqual(['default event']);
  expect(await engine.getTimeline('people/person-500')).toEqual([]);
});
