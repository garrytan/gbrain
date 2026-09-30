/**
 * v0.42.x — Life Chronicle getLastSeen, LIVE Postgres engine (#2390 follow-up).
 *
 * Parity coverage for the PGLite regression in
 * test/chronicle-timeline-reads.test.ts: getLastSeen must bound to
 * `te.date <= COALESCE(asof, current_date)` so a future-dated chronicle
 * event (a scheduled calendar-event) is NOT reported as "seen today".
 *
 * Uses the canonical e2e harness (setupDB/teardownDB/getEngine); gated by
 * DATABASE_URL via hasDatabase() and skips cleanly when unset, per the repo
 * E2E lifecycle. Seeds its own fixtures via direct SQL, mirroring the PGLite
 * test, then asserts the same fail-before / pass-after behavior on Postgres.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/chronicle-last-seen-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;
const ids: Record<string, number> = {};

async function insertPage(opts: {
  slug: string; type: string; sourceId?: string;
  effectiveDate?: string | null; frontmatter?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::text::jsonb)
     RETURNING id`,
    [opts.sourceId ?? 'default', opts.slug, opts.type, opts.slug,
      opts.effectiveDate ?? null, opts.frontmatter ?? '{}'],
  );
  return rows[0].id;
}

async function insertProjection(depthId: number, eventId: number, date: string, summary: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
     VALUES ($1, $2::date, $3, $4, '', $5)`,
    [depthId, date, `life-chronicle:event:${eventId}`, summary, eventId],
  );
}

d('getLastSeen (live Postgres) bounds to <= asof/today', () => {
  beforeAll(async () => {
    engine = await setupDB();

    ids.meeting = await insertPage({ slug: 'meetings/2026-06-18-sync', type: 'meeting' });
    await insertPage({ slug: 'people/sarah-chen', type: 'person' });
    // Past events for Sarah: 06-18 15:30 (commitment) and 06-20 10:00 (decision).
    ids.e1 = await insertPage({ slug: 'life/events/2026-06-18-001', type: 'event', effectiveDate: '2026-06-18T15:30:00Z', frontmatter: '{"event":{"who":["people/sarah-chen"],"kind":"commitment"}}' });
    ids.e3 = await insertPage({ slug: 'life/events/2026-06-20-001', type: 'event', effectiveDate: '2026-06-20T10:00:00Z', frontmatter: '{"event":{"who":["people/sarah-chen"],"kind":"decision"}}' });
    await insertProjection(ids.meeting, ids.e1, '2026-06-18', 'Sarah committed to Q3');
    await insertProjection(ids.meeting, ids.e3, '2026-06-20', 'Decision on launch');
    // Future event: a scheduled Q3 launch on 2026-08-01.
    ids.fut = await insertPage({ slug: 'life/events/2026-08-01-fut', type: 'event', effectiveDate: '2026-08-01T10:00:00Z', frontmatter: '{"event":{"who":["people/sarah-chen"],"kind":"event"}}' });
    await insertProjection(ids.meeting, ids.fut, '2026-08-01', 'Planned Q3 launch');
    // Exact who matching: kim-example-2's sighting must not count for the
    // kim-example prefix, nor axb-example's for the a_b-example underscore.
    await insertPage({ slug: 'people/kim-example', type: 'person' });
    ids.kim2 = await insertPage({ slug: 'life/events/2026-06-19-kim2', type: 'event', effectiveDate: '2026-06-19T10:00:00Z', frontmatter: '{"event":{"who":["people/kim-example-2","people/axb-example"],"kind":"meeting"}}' });
    await insertProjection(ids.meeting, ids.kim2, '2026-06-19', 'Sync with kim 2');
    ids.kimLink = await insertPage({ slug: 'life/events/2026-06-10-kim', type: 'event', effectiveDate: '2026-06-10T10:00:00Z', frontmatter: '{"event":{"who":["[[people/kim-example|Kim]]"],"kind":"meeting"}}' });
    await insertProjection(ids.meeting, ids.kimLink, '2026-06-10', 'Sync with kim');
    // Day ordering: a 23:30 New York event projected on 06-21 (03:30 UTC on
    // 06-22) must not outrank dave's own row dated 06-22.
    ids.dave = await insertPage({ slug: 'people/dave-example', type: 'person' });
    ids.late = await insertPage({ slug: 'life/events/2026-06-21-late', type: 'event', effectiveDate: '2026-06-22T03:30:00Z', frontmatter: '{"event":{"who":["people/dave-example"],"kind":"call"}}' });
    await insertProjection(ids.meeting, ids.late, '2026-06-21', 'Late call');
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES ($1, '2026-06-22'::date, 'manual', 'spoke at startup-1', '')`,
      [ids.dave],
    );
  });

  afterAll(async () => { await teardownDB(); });

  test('future event does not read as last-seen; asof after it lets it through', async () => {
    // asof BEFORE the future event → last-seen is the most recent PAST event.
    const seen = await engine.getLastSeen('people/sarah-chen', { asof: '2026-06-25', sourceId: 'default' });
    expect(seen.last_date).toBe('2026-06-20'); // NOT 2026-08-01
    expect(seen.days_ago).toBe(5);             // NOT 0

    // asof AFTER the future event → it is now in-bound and becomes last-seen.
    const later = await engine.getLastSeen('people/sarah-chen', { asof: '2026-08-02', sourceId: 'default' });
    expect(later.last_date).toBe('2026-08-01');
    expect(later.days_ago).toBe(1);
  });

  test('who matches the exact slug or a wikilink to it, never a substring or LIKE wildcard', async () => {
    const kim = await engine.getLastSeen('people/kim-example', { asof: '2026-06-25', sourceId: 'default' });
    expect(kim.last_date).toBe('2026-06-10');
    const underscore = await engine.getLastSeen('people/a_b-example', { asof: '2026-06-25', sourceId: 'default' });
    expect(underscore.last_date).toBeNull();
  });

  test('the newest projected day wins over a later instant on the previous local day', async () => {
    const dave = await engine.getLastSeen('people/dave-example', { asof: '2026-06-22', sourceId: 'default' });
    expect(dave.last_date).toBe('2026-06-22');
    expect(dave.days_ago).toBe(0);
  });
});
