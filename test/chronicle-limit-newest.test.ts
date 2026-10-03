/**
 * Life Chronicle reads under a limit keep the NEWEST rows of their window and
 * still return them in chronological order. Before the fix the reads sorted
 * ASC and then applied LIMIT, so a truncated `chronicle_since`/`chronicle_day`
 * dropped the most recent rows, and `volunteer_chronicle` ("the recent
 * timeline") returned the oldest rows of its lookback window.
 * Runs against PGLite in-memory.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadChronicleContext } from '../src/core/context/chronicle-context.ts';

let engine: PGLiteEngine;

async function insertPage(slug: string, type: string, sourceId: string, effectiveDate?: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date)
     VALUES ($1, $2, $3, $2, $4::timestamptz) RETURNING id`,
    [sourceId, slug, type, effectiveDate ?? null],
  );
  return rows[0].id;
}

async function insertRow(pageId: number, date: string, summary: string, eventPageId?: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
     VALUES ($1, $2::date, 'test', $3, '', $4)`,
    [pageId, date, summary, eventPageId ?? null],
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Source 'default': one plain row a day 2026-07-01..07-10, a second plain
  // row on 07-09 (same-day tie, broken by id), and three events on 07-10
  // whose instants order them after that day's plain row.
  const notes = await insertPage('notes/daily', 'note', 'default');
  for (let d = 1; d <= 10; d++) {
    await insertRow(notes, `2026-07-${String(d).padStart(2, '0')}`, `day ${d}`);
  }
  await insertRow(notes, '2026-07-09', 'day 9, second row');
  for (const [hhmm, label] of [['08:00', 'morning'], ['12:00', 'noon'], ['17:00', 'evening']] as const) {
    const ev = await insertPage(`life/events/2026-07-10-${label}`, 'event', 'default', `2026-07-10T${hhmm}:00Z`);
    await insertRow(notes, '2026-07-10', label, ev);
  }

  // Source 'recent': one row a day for the last 7 days (volunteer_chronicle).
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('recent', 'Recent') ON CONFLICT (id) DO NOTHING`);
  const recent = await insertPage('notes/recent', 'note', 'recent');
  for (let d = 6; d >= 0; d--) await insertRow(recent, isoDaysAgo(d), `${d} days ago`);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('chronicle reads keep the newest rows under a limit', () => {
  test('getSince returns the newest N rows, oldest first', async () => {
    const rows = await engine.getSince('2026-07-01', { sourceId: 'default', limit: 3 });
    expect(rows.map(r => r.summary)).toEqual(['morning', 'noon', 'evening']);
  });

  test('every getSince limit equals the tail of the unlimited read', async () => {
    const all = await engine.getSince('2026-07-01', { sourceId: 'default' });
    expect(all.length).toBe(14);
    expect(all[0].summary).toBe('day 1');
    expect(all.slice(-5).map(r => r.summary)).toEqual(['day 9, second row', 'day 10', 'morning', 'noon', 'evening']);
    for (let n = 1; n <= all.length; n++) {
      const limited = await engine.getSince('2026-07-01', { sourceId: 'default', limit: n });
      expect(limited.map(r => r.summary)).toEqual(all.slice(-n).map(r => r.summary));
    }
  });

  test('getSince row shape does not grow the sort keys', async () => {
    const [row] = await engine.getSince('2026-07-10', { sourceId: 'default', limit: 1 });
    expect(Object.keys(row).sort()).toEqual([
      'date', 'detail', 'effective_date', 'event_page_id', 'event_slug',
      'kind', 'page_id', 'page_slug', 'source', 'summary',
    ]);
    expect(row.event_slug).toBe('life/events/2026-07-10-evening');
  });

  test('getTimelineForDate keeps the latest rows of the day, in time order', async () => {
    const day = await engine.getTimelineForDate('2026-07-10', { sourceId: 'default', limit: 2 });
    expect(day.map(r => r.summary)).toEqual(['noon', 'evening']);
    const full = await engine.getTimelineForDate('2026-07-10', { sourceId: 'default' });
    expect(full.map(r => r.summary)).toEqual(['day 10', 'morning', 'noon', 'evening']);
  });

  test('a truncated ISO week drops its earliest rows, not its latest', async () => {
    // 2026-07-08 is a Wednesday: week = Mon 07-06 .. Sun 07-12 (9 rows).
    const week = await engine.getTimelineForDate('2026-07-08', { week: true, sourceId: 'default', limit: 4 });
    expect(week.map(r => r.summary)).toEqual(['day 10', 'morning', 'noon', 'evening']);
  });

  test('volunteer_chronicle recent_timeline is the most recent rows of the window', async () => {
    const ctx = await loadChronicleContext(engine, { days: 7, limit: 3, sourceId: 'recent' });
    expect(ctx.recent_timeline.map(r => r.date)).toEqual([isoDaysAgo(2), isoDaysAgo(1), isoDaysAgo(0)]);
  });
});
