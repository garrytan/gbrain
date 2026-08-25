/**
 * #4485 — `copyPageToTarget` called `getTimeline` with no limit, and both
 * engines default that read to LIMIT 100 (newest-first). Any page with a
 * longer history silently lost everything past its newest 100 timeline
 * entries on engine migration — no error, no summary line, no retry path
 * (the page was checkpointed as fully copied).
 *
 * The copy now passes an explicit unbounded limit, and the end-of-run
 * verify step compares total source-vs-target timeline counts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget, COPIED_TIMELINE_COUNT_SQL } from '../src/commands/migrate-engine.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  target = new PGLiteEngine();
  await target.connect({});
  await target.initSchema();
});

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
});

describe('copyPageToTarget — full timeline copy (#4485)', () => {
  test('a page with more than 100 timeline entries migrates ALL of them', async () => {
    await source.putPage('people/long-history', {
      type: 'person', title: 'Long History', compiled_truth: 'body', timeline: '', frontmatter: {},
    });
    const TOTAL = 130;
    for (let i = 0; i < TOTAL; i++) {
      // Spread across distinct dates so DESC-ordering + LIMIT actually drops
      // the oldest entries under the old behavior.
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
      await source.addTimelineEntry('people/long-history', {
        date: `2024-${month}-${day}`,
        source: 'test',
        summary: `entry ${i}`,
      });
    }

    const page = await source.getPage('people/long-history');
    expect(page).not.toBeNull();
    const counts = await copyPageToTarget(source, target, page!);
    expect(counts.timeline_entries).toBe(TOTAL);

    const copied = await target.getTimeline('people/long-history', { limit: 1000 });
    expect(copied.length).toBe(TOTAL);
  }, 60000);

  test('wave-g: verify parity count is scoped to live pages — soft-deleted timeline rows excluded', async () => {
    // The migration copies listPages() output (soft-deleted excluded), so a
    // soft-deleted source page that still owns timeline rows must NOT count
    // toward the source side of the parity check (false WARN pre-fix).
    await source.putPage('people/gone-example', {
      type: 'person', title: 'Gone', compiled_truth: 'body', timeline: '', frontmatter: {},
    });
    await source.addTimelineEntry('people/gone-example', {
      date: '2024-01-01', source: 'test', summary: 'orphaned-by-soft-delete',
    });
    const before = Number((await source.executeRaw<{ count: string }>(COPIED_TIMELINE_COUNT_SQL))[0].count);
    await source.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/gone-example'`);
    const whole = Number((await source.executeRaw<{ count: string }>(
      'SELECT count(*)::text AS count FROM timeline_entries'))[0].count);
    const scoped = Number((await source.executeRaw<{ count: string }>(COPIED_TIMELINE_COUNT_SQL))[0].count);
    expect(scoped).toBe(before - 1); // the soft-deleted page's row left the copied set
    expect(whole).toBe(before);      // whole-table count still includes it (the old false-WARN source)
  }, 60000);
});
