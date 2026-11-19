/**
 * `foresights extract timeline --source db` on PGLite refreshes planner statistics
 * every `import.analyze_every_pages` pages while it fills timeline_entries.
 *
 * Protects: the PGLite scale tier at 20k pages. The walk starts with an empty
 * timeline_entries and PGLite has no autovacuum, so without a refresh every
 * per-page read plans against the empty table and slows with each row: the
 * walk took 157 s at 10k pages and 655 s at 20k on the scale nightly, and
 * 34 s at 4k locally against 2.8 s with the refresh.
 * Fails when: the walk stops calling maybeRefreshPlannerStats, so
 * timeline_entries ends the walk with no pg_stats rows.
 * Why new: test/planner-stats-import.slow.test.ts covers import and managed
 * sync; nothing covered the database extract walk.
 * Seam: planner-stats __testing.hooks.onAnalyzed (observes, changes nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { __testing } from '../src/core/planner-stats.ts';

const PAGES = 301;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < PAGES; i++) {
    await engine.putPage(`notes/timeline-${i}`, {
      type: 'note', title: `Timeline ${i}`, compiled_truth: `Note ${i}.`, frontmatter: {},
      timeline: `- **2025-01-${String(1 + (i % 28)).padStart(2, '0')}** | Event ${i}\n- **2026-02-${String(1 + (i % 28)).padStart(2, '0')}** | Follow-up ${i}`,
    });
  }
}, 120_000);

afterAll(async () => {
  __testing.hooks.onAnalyzed = undefined;
  await engine.disconnect();
});

describe('database timeline walk keeps PGLite planner statistics fresh', () => {
  test('timeline_entries is analyzed during the walk, at the page cadence', async () => {
    await engine.setConfig('import.analyze_every_pages', '100');
    const analyzed: Array<{ table: string; rows: number }> = [];
    __testing.hooks.onAnalyzed = async (eng, event) => {
      if (event.reason !== 'extract') return;
      const [{ n }] = await eng.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM timeline_entries');
      analyzed.push({ table: event.table, rows: n });
    };

    const result = await extractTimelineFromDB(engine, { dryRun: false, jsonMode: true, quiet: true });

    expect(result.created).toBe(PAGES * 2);
    // The check after page 300 sees 300 pages' rows (600), the first count over the max(500, 10%) threshold.
    expect(analyzed.filter(a => a.table === 'timeline_entries').map(a => a.rows)).toEqual([(PAGES - 1) * 2]);
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'timeline_entries'");
    expect(n).toBeGreaterThan(0);
  }, 120_000);
});
