/**
 * D7 — upsertEventProjection parity (Life Chronicle, #2390).
 *
 * The projection writer INSERT..SELECTs from a depth-page × event-page pair
 * and upserts on the D1-pinned PARTIAL unique index
 * (idx_timeline_event_dedup ON timeline_entries(event_page_id, date) WHERE
 * event_page_id IS NOT NULL). Postgres composes via sql``; PGLite via
 * positional $N. On real Postgres a missing/mis-shaped partial index makes
 * the `ON CONFLICT ... WHERE event_page_id IS NOT NULL` arm ERROR outright —
 * PGLite alone can't prove the production migration carries it.
 *
 * Contract pinned here (identical on both engines):
 *   - same (event, date) twice → { projected: true } both times, exactly ONE
 *     timeline_entries row, summary/detail updated IN PLACE (same row id);
 *   - missing depth page, missing event page, or out-of-scope sourceId →
 *     { projected: false } and NO row;
 *   - same event on a DIFFERENT date → a second row (the dedup key is
 *     (event_page_id, date), not event alone);
 *   - the unscoped/trusted chronicle read (getTimelineForDate) returns the
 *     identical projected row shape — exercised UNSCOPED deliberately: the
 *     scope-aware `ep` join variants are covered by the scope suites.
 *
 * Gated by DATABASE_URL — skips gracefully without a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

const DEPTH_SLUG = 'life/diary/2026-06-01';
const EVENT_SLUG = 'life/events/2026-06-01-standup';
const EVENT_SOURCE = `life-chronicle:event:${EVENT_SLUG}`;
const DATE_1 = '2026-06-01';
const DATE_2 = '2026-06-02';

async function seedChronicle(eng: BrainEngine) {
  await eng.putPage(DEPTH_SLUG, {
    type: 'note', title: 'Diary 2026-06-01', compiled_truth: 'diary body', timeline: '',
  });
  await eng.putPage(EVENT_SLUG, {
    type: 'event', title: 'Standup', compiled_truth: 'event body', timeline: '',
    frontmatter: { event: { kind: 'standup', who: ['people/alice-example'] } },
  });
}

/** Projection rows for one event source string, id-free except within-engine. */
async function projectionRows(eng: BrainEngine, source: string) {
  return eng.executeRaw<{ id: number; date: string; summary: string; detail: string }>(
    `SELECT id, date::text AS date, summary, detail
       FROM timeline_entries
      WHERE source = $1
      ORDER BY date ASC`,
    [source],
  );
}

describeBoth('Engine parity — upsertEventProjection (D7)', () => {
  let pgEngine: BrainEngine;
  let pgliteEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = await setupDB();
    await seedChronicle(pgEngine);
    pgliteEngine = new PGLiteEngine();
    await pgliteEngine.connect({});
    await pgliteEngine.initSchema();
    await seedChronicle(pgliteEngine);
  }, 90_000);

  afterAll(async () => {
    await pgliteEngine.disconnect();
    await teardownDB();
  }, 30_000);

  test('same (event, date) twice → projected:true both times, ONE row, summary updated in place', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const first = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: EVENT_SLUG, date: DATE_1,
        summary: 'standup v1', detail: 'detail v1',
      });
      expect(first).toEqual({ projected: true });

      const afterFirst = await projectionRows(eng, EVENT_SOURCE);
      expect(afterFirst.length).toBe(1);
      expect(afterFirst[0].summary).toBe('standup v1');
      const rowId = afterFirst[0].id;

      // Second upsert with the SAME (event, date): the partial unique index
      // routes it to DO UPDATE — projected stays true, no second row.
      const second = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: EVENT_SLUG, date: DATE_1,
        summary: 'standup v2', detail: 'detail v2',
      });
      expect(second).toEqual({ projected: true });

      const afterSecond = await projectionRows(eng, EVENT_SOURCE);
      expect(afterSecond.length).toBe(1);
      // Updated IN PLACE: same row id, new summary/detail.
      expect(afterSecond[0].id).toBe(rowId);
      expect(afterSecond[0].summary).toBe('standup v2');
      expect(afterSecond[0].detail).toBe('detail v2');
      expect(afterSecond[0].date).toBe(DATE_1);
    }
  });

  test('unscoped chronicle read-back: identical projected row shape on both engines', async () => {
    const norm = (rows: Awaited<ReturnType<BrainEngine['getTimelineForDate']>>) =>
      rows.map((r) => ({
        date: r.date,
        summary: r.summary,
        detail: r.detail,
        source: r.source,
        page_slug: r.page_slug,
        event_slug: r.event_slug,
        effective_date: r.effective_date ?? null,
        kind: r.kind,
        // ids are engine-local serials; pin numeric type, not value.
        ids_numeric: typeof r.page_id === 'number' && typeof r.event_page_id === 'number',
      }));

    const pg = norm(await pgEngine.getTimelineForDate(DATE_1));
    const pglite = norm(await pgliteEngine.getTimelineForDate(DATE_1));
    expect(pg).toEqual(pglite);
    expect(pg).toEqual([{
      date: DATE_1,
      summary: 'standup v2',
      detail: 'detail v2',
      source: EVENT_SOURCE,
      page_slug: DEPTH_SLUG,
      event_slug: EVENT_SLUG,
      effective_date: null,
      kind: 'standup', // frontmatter->'event'->>'kind' projected via the ep join
      ids_numeric: true,
    }]);
  });

  test('missing depth page, missing event page, or out-of-scope sourceId → projected:false, no row', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      // Ghost event page.
      const ghostEvent = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: 'life/events/ghost-event', date: DATE_1,
        summary: 'never lands',
      });
      expect(ghostEvent).toEqual({ projected: false });
      expect(await projectionRows(eng, 'life-chronicle:event:life/events/ghost-event')).toEqual([]);

      // Ghost depth page.
      const ghostDepth = await eng.upsertEventProjection({
        depthSlug: 'life/diary/ghost-day', eventSlug: EVENT_SLUG, date: '2026-06-09',
        summary: 'never lands either',
      });
      expect(ghostDepth).toEqual({ projected: false });

      // Both pages exist — but only in 'default'. A foreign sourceId scopes
      // the page lookups to nothing → no insert, no error.
      const wrongSource = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: EVENT_SLUG, date: '2026-06-09',
        summary: 'scoped away', sourceId: 'proj-ghost-source',
      });
      expect(wrongSource).toEqual({ projected: false });

      // No stray rows appeared for the real event beyond the DATE_1 row.
      expect((await projectionRows(eng, EVENT_SOURCE)).map((r) => r.date)).toEqual([DATE_1]);
    }
  });

  test('same event on a different date is a distinct row (dedup key is (event_page_id, date))', async () => {
    for (const eng of [pgEngine, pgliteEngine]) {
      const other = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: EVENT_SLUG, date: DATE_2,
        summary: 'standup day two',
      });
      expect(other).toEqual({ projected: true });

      // Replay the second date too — still upsert-in-place, still 2 rows total.
      const replay = await eng.upsertEventProjection({
        depthSlug: DEPTH_SLUG, eventSlug: EVENT_SLUG, date: DATE_2,
        summary: 'standup day two rev',
      });
      expect(replay).toEqual({ projected: true });

      const rows = await projectionRows(eng, EVENT_SOURCE);
      expect(rows.map((r) => `${r.date}:${r.summary}`)).toEqual([
        `${DATE_1}:standup v2`,
        `${DATE_2}:standup day two rev`,
      ]);
    }
  });
});
