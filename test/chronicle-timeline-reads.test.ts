/**
 * v0.42.x — Life Chronicle (#2390) timeline read methods (Phase A.2).
 * Runs against PGLite in-memory. Covers getTimelineForDate (day + ISO week),
 * getSince (+ kind filter), getLastSeen (own page + via event `who`),
 * intra-day ordering by event effective_date, source isolation, read-time
 * hiding of soft-deleted event projections, and the (event_page_id, date)
 * dedup index.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
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

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  ids.meeting = await insertPage({ slug: 'meetings/2026-06-18-sync', type: 'meeting' });
  await insertPage({ slug: 'people/sarah-chen', type: 'person' });
  // 06-18: event2 at 09:00 (Bob), event1 at 15:30 (Sarah, commitment).
  ids.e1 = await insertPage({ slug: 'life/events/2026-06-18-001', type: 'event', effectiveDate: '2026-06-18T15:30:00Z', frontmatter: '{"event":{"who":["people/sarah-chen"],"kind":"commitment"}}' });
  ids.e2 = await insertPage({ slug: 'life/events/2026-06-18-002', type: 'event', effectiveDate: '2026-06-18T09:00:00Z', frontmatter: '{"event":{"who":["people/bob"],"kind":"meeting"}}' });
  // 06-20 (same ISO week as 06-18): event3 (Sarah, decision).
  ids.e3 = await insertPage({ slug: 'life/events/2026-06-20-001', type: 'event', effectiveDate: '2026-06-20T10:00:00Z', frontmatter: '{"event":{"who":["people/sarah-chen"],"kind":"decision"}}' });
  await insertProjection(ids.meeting, ids.e1, '2026-06-18', 'Sarah committed to Q3');
  await insertProjection(ids.meeting, ids.e2, '2026-06-18', 'Bob standup');
  await insertProjection(ids.meeting, ids.e3, '2026-06-20', 'Decision on launch');

  // Other-source event (isolation fixture).
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`);
  const otherMeeting = await insertPage({ slug: 'meetings/o', type: 'meeting', sourceId: 'other' });
  ids.eOther = await insertPage({ slug: 'life/events/2026-06-18-099', type: 'event', sourceId: 'other', effectiveDate: '2026-06-18T12:00:00Z', frontmatter: '{"event":{"who":["people/zed"],"kind":"meeting"}}' });
  await insertProjection(otherMeeting, ids.eOther, '2026-06-18', 'Other-source event');
});

afterAll(async () => { await engine.disconnect(); });

describe('Life Chronicle timeline reads', () => {
  test('getTimelineForDate orders intra-day by event effective_date', async () => {
    const rows = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(rows.map(r => r.event_slug)).toEqual([
      'life/events/2026-06-18-002', // 09:00 first
      'life/events/2026-06-18-001', // 15:30 second
    ]);
    expect(rows[0].page_slug).toBe('meetings/2026-06-18-sync'); // backlink = depth page
    expect(rows[1].kind).toBe('commitment');
  });

  test('week expansion pulls the whole ISO week', async () => {
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const week = await engine.getTimelineForDate('2026-06-18', { week: true, sourceId: 'default' });
    expect(day.length).toBe(2);
    expect(week.length).toBe(3); // adds 06-20 (same Mon–Sun week)
    expect(week[week.length - 1].event_slug).toBe('life/events/2026-06-20-001');
  });

  test('getSince filters by lower-bound date and event kind', async () => {
    const since19 = await engine.getSince('2026-06-19', { sourceId: 'default' });
    expect(since19.map(r => r.event_slug)).toEqual(['life/events/2026-06-20-001']);
    const commitments = await engine.getSince('2026-06-18', { kind: 'commitment', sourceId: 'default' });
    expect(commitments.map(r => r.event_slug)).toEqual(['life/events/2026-06-18-001']);
  });

  test('getLastSeen finds the entity via event who, with days_ago', async () => {
    const seen = await engine.getLastSeen('people/sarah-chen', { asof: '2026-06-25', sourceId: 'default' });
    expect(seen.last_date).toBe('2026-06-20');
    expect(seen.last_event_slug).toBe('life/events/2026-06-20-001');
    expect(seen.days_ago).toBe(5);
    const never = await engine.getLastSeen('people/nobody', { asof: '2026-06-25', sourceId: 'default' });
    expect(never.last_date).toBeNull();
    expect(never.days_ago).toBeNull();
  });

  test('source isolation: default scope excludes other-source events', async () => {
    const def = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(def.some(r => r.event_slug === 'life/events/2026-06-18-099')).toBe(false);
    const other = await engine.getTimelineForDate('2026-06-18', { sourceId: 'other' });
    expect(other.map(r => r.event_slug)).toEqual(['life/events/2026-06-18-099']);
  });

  test('(event_page_id, date) dedup index rejects a duplicate projection', async () => {
    await expect(
      insertProjection(ids.meeting, ids.e1, '2026-06-18', 'dup'),
    ).rejects.toThrow();
  });

  test('soft-deleting an event page hides it from reads (read-time, not doctor)', async () => {
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [ids.e3]);
    const since19 = await engine.getSince('2026-06-19', { sourceId: 'default' });
    expect(since19.length).toBe(0); // event3 hidden
    const seen = await engine.getLastSeen('people/sarah-chen', { asof: '2026-06-25', sourceId: 'default' });
    expect(seen.last_date).toBe('2026-06-18'); // falls back to event1
  });
});
