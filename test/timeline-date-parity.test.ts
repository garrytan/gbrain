/**
 * Timeline and date read parity: the seven timeline/date methods return the
 * same rows, dates and counts on PGLite and Postgres (in-memory PGLite;
 * Postgres too when DATABASE_URL is set), across UTC day boundaries, DST
 * changes, dates near midnight and leap days, with the session TimeZone set
 * to UTC and to four other zones.
 *
 * Rust engine contract: the Rust engine must set TimeZone=UTC on every
 * session. Three outputs follow the session zone: an event's effective_date
 * text, the order of a plain row against an event on one day, and the default
 * "today" of getOnThisDay and getLastSeen. For the Rust comparison, those
 * cases run with the TypeScript engines pinned to UTC in test setup (the UTC
 * entries below). The TypeScript engines' own runtime zone is not changed here.
 *
 * 1. Protects: getTimelineForDate (day + ISO week), getSince, getOnThisDay,
 *    getLastSeen, getEffectiveDates, getPageTimestamps and
 *    addTimelineEntriesBatch give one answer per engine for the same brain and
 *    the same session zone. It also pins which outputs follow the session
 *    zone (an event's `effective_date` text, intra-day order of a plain row
 *    against an event, and the `current_date` default of getOnThisDay and
 *    getLastSeen) and which do not (day and week filters, leap-day matching,
 *    stored batch dates, returned Date instants). A third engine (the Rust
 *    engine) must match these pins.
 * 2. Fails when: an engine's statement drifts from the shared SQL in
 *    src/core/engine-sql/timeline.ts, a driver parses timestamptz or date
 *    values differently, week bounds move with the zone or DST, Feb 29 starts
 *    to surface on Feb 28 or Mar 1, or the batch insert stops dropping
 *    duplicate, missing-page or soft-deleted-page rows.
 * 3. Existing coverage: test/chronicle-timeline-reads.test.ts and
 *    test/timeline-date-batch.test.ts run on PGLite only and in one zone; no
 *    file compares the two engines side by side or sets a non-UTC session.
 * 4. Real seams: the engines' public methods. Rows are seeded with SQL so
 *    every date and instant is pinned; the session zone is set with
 *    set_config on a one-connection Postgres pool.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { testBackends, type TestBackend } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

/** UTC, a US DST zone, a zone whose spring DST change skips midnight, and the two zones 25 hours apart. */
const ZONES = ['UTC', 'America/Los_Angeles', 'America/Santiago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const;
type Zone = typeof ZONES[number];

const MEETING = 'meetings/dst-sync';
const ALICE = 'people/alice-example';
const ALICE_UNDERSCORE = 'people/al_ice-example';
const BOB = 'people/bob-example';
const E_EARLY = 'life/events/2026-03-08-early';
const E_LATE = 'life/events/2026-03-08-late';
const E_JUNE = 'life/events/2026-06-30-late';
const E_JULY = 'life/events/2026-07-01-midnight';

/** One case result per engine, compared at the end of the file. */
const seen = new Map<TestBackend, Record<string, unknown>>();
const backends = testBackends();

function record(kind: TestBackend, name: string, value: unknown): void {
  const run = seen.get(kind) ?? {};
  run[name] = value;
  seen.set(kind, run);
}

/** The row fields a reader sees, without per-database ids. */
function shape(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => [r.date, r.page_slug, r.event_slug ?? '-', r.effective_date ?? '-', r.kind ?? '-', r.summary].join(' | '));
}

function isoMap(map: Map<string, Date>): Record<string, string> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toISOString()]));
}

async function inZone<T>(engine: BrainEngine, zone: Zone, fn: () => Promise<T>): Promise<T> {
  await engine.executeRaw(`SELECT set_config('TimeZone', $1, false)`, [zone]);
  try {
    const out = await fn();
    const [{ tz }] = await engine.executeRaw<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    expect(tz).toBe(zone); // the reads ran on the session the zone was set on
    return out;
  } finally {
    await engine.executeRaw(`SELECT set_config('TimeZone', 'UTC', false)`);
  }
}

async function insertPage(engine: BrainEngine, p: {
  slug: string; type: string; sourceId?: string; effectiveDate?: string | null;
  frontmatter?: object; createdAt?: string; updatedAt?: string; deleted?: boolean;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $2, $4::timestamptz, $5::text::jsonb,
             COALESCE($6::timestamptz, '2026-01-01T00:00:00Z'), COALESCE($7::timestamptz, '2026-01-01T00:00:00Z'),
             CASE WHEN $8::boolean THEN '2026-01-02T00:00:00Z'::timestamptz END)
     RETURNING id`,
    [p.sourceId ?? 'default', p.slug, p.type, p.effectiveDate ?? null, JSON.stringify(p.frontmatter ?? {}),
      p.createdAt ?? null, p.updatedAt ?? null, p.deleted === true],
  );
  return Number(rows[0].id);
}

async function insertEntry(engine: BrainEngine, pageId: number, date: string, summary: string, eventId?: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
     VALUES ($1, $2::date, $3, $4, '', $5)`,
    [pageId, date, eventId ? `life-chronicle:event:${eventId}` : 'parity', summary, eventId ?? null],
  );
}


/**
 * The latest earlier date with the same month and day as `day` (a SQL date expression): one year back, or four
 * from a Feb 29, so the current-date anniversary fixture holds on a leap day too.
 */
function anniversarySql(day: string): string {
  return `(CASE WHEN to_char(${day}, 'MM-DD') = '02-29' THEN ${day} - interval '4 years' ELSE ${day} - interval '1 year' END)::date`;
}

async function seed(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`);
  const meeting = await insertPage(engine, { slug: MEETING, type: 'meeting' });
  const alice = await insertPage(engine, { slug: ALICE, type: 'person' });
  await insertPage(engine, { slug: ALICE_UNDERSCORE, type: 'person' });
  const bob = await insertPage(engine, { slug: BOB, type: 'person' });
  // US spring-forward day (2026-03-08, clocks jump at 10:00Z). The early event
  // is 2026-03-07 21:00 in Los Angeles; the late one is 03:30 PDT.
  const early = await insertPage(engine, {
    slug: E_EARLY, type: 'event', effectiveDate: '2026-03-08T05:00:00Z',
    frontmatter: { event: { kind: 'meeting', who: [`[[${ALICE}|Alice]]`] } },
  });
  const late = await insertPage(engine, {
    slug: E_LATE, type: 'event', effectiveDate: '2026-03-08T10:30:00Z',
    frontmatter: { event: { kind: 'call', who: [ALICE] } },
  });
  // One second before and exactly at a UTC midnight.
  const june = await insertPage(engine, {
    slug: E_JUNE, type: 'event', effectiveDate: '2026-06-30T23:59:59Z',
    frontmatter: { event: { kind: 'meeting', who: [ALICE, '[[people/alXice-example]]'] } },
  });
  const july = await insertPage(engine, {
    slug: E_JULY, type: 'event', effectiveDate: '2026-07-01T00:00:00Z',
    frontmatter: { event: { kind: 'call', who: [`[[${ALICE}]]`] } },
  });
  await insertEntry(engine, meeting, '2026-03-02', 'Monday before the DST change');
  await insertEntry(engine, meeting, '2026-03-08', 'Plain DST-day note');
  await insertEntry(engine, meeting, '2026-03-08', 'Early DST-day event', early);
  await insertEntry(engine, meeting, '2026-03-08', 'Late DST-day event', late);
  await insertEntry(engine, meeting, '2026-03-09', 'Monday after the DST change');
  await insertEntry(engine, meeting, '2026-08-31', 'Santiago week start');
  await insertEntry(engine, meeting, '2026-09-06', 'Santiago DST day (no local midnight)');
  await insertEntry(engine, meeting, '2026-09-07', 'Santiago next Monday');
  await insertEntry(engine, meeting, '2026-11-01', 'US DST end day');
  await insertEntry(engine, meeting, '2026-11-02', 'Monday after DST end');
  await insertEntry(engine, alice, '2026-06-30', 'Alice late June note');
  await insertEntry(engine, meeting, '2026-06-30', 'Late June event', june);
  await insertEntry(engine, alice, '2026-07-01', 'Alice July note');
  await insertEntry(engine, meeting, '2026-07-01', 'Midnight July event', july);
  for (const d of ['2020-02-29', '2023-03-01', '2024-02-29', '2025-02-28', '2025-03-01', '2028-02-29']) {
    await insertEntry(engine, alice, d, `Alice on ${d}`);
  }
  // `today` and its latest earlier anniversary in the zone furthest ahead of UTC.
  // Pacific/Pago_Pago is 25 hours behind it, so its `current_date` is always
  // at least one day earlier.
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail) VALUES
       ($1, (now() AT TIME ZONE 'Pacific/Kiritimati')::date, 'parity', 'Bob today in Kiritimati', ''),
       ($1, ${anniversarySql("(now() AT TIME ZONE 'Pacific/Kiritimati')::date")}, 'parity', 'Bob a year ago in Kiritimati', '')`,
    [bob],
  );
  // getEffectiveDates / getPageTimestamps fixtures.
  await insertPage(engine, { slug: 'dates/leap-evening', type: 'note', effectiveDate: '2024-02-29T23:30:00-08:00', updatedAt: '2026-02-01T00:00:00Z' });
  await insertPage(engine, { slug: 'dates/no-effective', type: 'note', updatedAt: '2026-03-08T09:59:59.999Z', createdAt: '2025-01-01T00:00:00Z' });
  await insertPage(engine, { slug: 'dates/micros', type: 'note', effectiveDate: '2026-03-08T10:00:00.123456Z' });
  await insertPage(engine, { slug: 'dates/dup', type: 'note', updatedAt: '2026-04-01T00:00:00Z' });
  await insertPage(engine, { slug: 'dates/dup', type: 'note', sourceId: 'other', updatedAt: '2026-05-01T00:00:00Z' });
  await insertPage(engine, { slug: 'dates/deleted', type: 'note', effectiveDate: '2026-01-05T00:00:00Z', deleted: true });
  // addTimelineEntriesBatch fixtures.
  await insertPage(engine, { slug: 'batch/a', type: 'note' });
  await insertPage(engine, { slug: 'batch/a', type: 'note', sourceId: 'other' });
  await insertPage(engine, { slug: 'batch/gone', type: 'note', deleted: true });
}

for (const kind of backends) {
  describe(`timeline and date reads (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let laOpen: { sessionSecs: number; processSecs: number } | undefined;
    let openZone: { source: string } | undefined;

    beforeAll(async () => {
      // One pooled connection, so a session set_config reaches every read.
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 1));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      [openZone] = await engine.executeRaw<{ source: string }>(`SELECT source FROM pg_settings WHERE name = 'TimeZone'`);
      await engine.executeRaw(`SELECT set_config('TimeZone', 'UTC', false)`);
      await seed(engine);
      if (kind === 'pglite') {
        // A second PGLite opened while the process zone is Los Angeles.
        await withEnv({ TZ: 'America/Los_Angeles' }, async () => {
          const local = new PGLiteEngine();
          await local.connect({ engine: 'pglite' } as never);
          try {
            const [r] = await local.executeRaw<{ secs: number }>(`SELECT EXTRACT(TIMEZONE FROM now())::int AS secs`);
            laOpen = { sessionSecs: Number(r.secs), processSecs: -new Date().getTimezoneOffset() * 60 };
          } finally {
            await local.disconnect();
          }
        });
      }
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('getTimelineForDate reads one stored day; rows near a UTC midnight never move to the next day', async () => {
      const out: Record<string, string[]> = {};
      for (const zone of ZONES) {
        out[zone] = await inZone(engine, zone, async () => [
          ...shape(await engine.getTimelineForDate('2026-06-30') as never).map((r) => `06-30: ${r.split(' | ').slice(0, 3).join(' | ')}`),
          ...shape(await engine.getTimelineForDate('2026-07-01') as never).map((r) => `07-01: ${r.split(' | ').slice(0, 3).join(' | ')}`),
        ]);
      }
      for (const zone of ZONES) expect({ zone, rows: [...out[zone]].sort() }).toEqual({ zone, rows: [...out.UTC].sort() });
      expect([...out.UTC].sort()).toEqual([
        `06-30: 2026-06-30 | ${MEETING} | ${E_JUNE}`,
        `06-30: 2026-06-30 | ${ALICE} | -`,
        `07-01: 2026-07-01 | ${MEETING} | ${E_JULY}`,
        `07-01: 2026-07-01 | ${ALICE} | -`,
      ]);
      record(kind, 'dayNearMidnight', out);
    });

    test('ISO week bounds are Monday to Sunday in every zone, across both DST changes and a midnight-skipping change', async () => {
      const weeks: Record<string, Record<string, string[]>> = {};
      const days = ['2026-03-08', '2026-03-09', '2026-09-06', '2026-09-07', '2026-11-01', '2026-11-02', '2024-02-29'];
      for (const zone of ZONES) {
        weeks[zone] = {};
        await inZone(engine, zone, async () => {
          for (const d of days) {
            weeks[zone][d] = [...new Set((await engine.getTimelineForDate(d, { week: true })).map((r) => r.date))].sort();
          }
        });
      }
      for (const zone of ZONES) expect({ zone, weeks: weeks[zone] }).toEqual({ zone, weeks: weeks.UTC });
      expect(weeks.UTC).toEqual({
        '2026-03-08': ['2026-03-02', '2026-03-08'], // Sunday of spring-forward closes its week
        '2026-03-09': ['2026-03-09'],
        '2026-09-06': ['2026-08-31', '2026-09-06'], // Santiago has no 00:00 on this day
        '2026-09-07': ['2026-09-07'],
        '2026-11-01': ['2026-11-01'],
        '2026-11-02': ['2026-11-02'],
        '2024-02-29': ['2024-02-29'],
      });
      record(kind, 'weekBounds', weeks);
    });

    test('an event effective_date renders in the session zone, and intra-day order of a plain row against an event follows the zone', async () => {
      const out: Record<string, string[]> = {};
      for (const zone of ZONES) out[zone] = await inZone(engine, zone, async () => shape(await engine.getTimelineForDate('2026-03-08') as never));
      expect(out).toEqual({
        // Plain rows sort at local midnight of their day; events at their instant.
        UTC: [
          `2026-03-08 | ${MEETING} | - | - | - | Plain DST-day note`,
          `2026-03-08 | ${MEETING} | ${E_EARLY} | 2026-03-08 05:00:00+00 | meeting | Early DST-day event`,
          `2026-03-08 | ${MEETING} | ${E_LATE} | 2026-03-08 10:30:00+00 | call | Late DST-day event`,
        ],
        'America/Los_Angeles': [
          `2026-03-08 | ${MEETING} | ${E_EARLY} | 2026-03-07 21:00:00-08 | meeting | Early DST-day event`,
          `2026-03-08 | ${MEETING} | - | - | - | Plain DST-day note`,
          `2026-03-08 | ${MEETING} | ${E_LATE} | 2026-03-08 03:30:00-07 | call | Late DST-day event`,
        ],
        'America/Santiago': [
          `2026-03-08 | ${MEETING} | - | - | - | Plain DST-day note`,
          `2026-03-08 | ${MEETING} | ${E_EARLY} | 2026-03-08 02:00:00-03 | meeting | Early DST-day event`,
          `2026-03-08 | ${MEETING} | ${E_LATE} | 2026-03-08 07:30:00-03 | call | Late DST-day event`,
        ],
        'Pacific/Kiritimati': [
          `2026-03-08 | ${MEETING} | - | - | - | Plain DST-day note`,
          `2026-03-08 | ${MEETING} | ${E_EARLY} | 2026-03-08 19:00:00+14 | meeting | Early DST-day event`,
          `2026-03-08 | ${MEETING} | ${E_LATE} | 2026-03-09 00:30:00+14 | call | Late DST-day event`,
        ],
        'Pacific/Pago_Pago': [
          `2026-03-08 | ${MEETING} | ${E_EARLY} | 2026-03-07 18:00:00-11 | meeting | Early DST-day event`,
          `2026-03-08 | ${MEETING} | ${E_LATE} | 2026-03-07 23:30:00-11 | call | Late DST-day event`,
          `2026-03-08 | ${MEETING} | - | - | - | Plain DST-day note`,
        ],
      });
      record(kind, 'zoneDependentOrderAndText', out);
    });

    test('getSince filters on the stored day and the event kind; the result set is the same in every zone (meeting page rows)', async () => {
      const out: Record<string, { all: string[]; meeting: string[] }> = {};
      for (const zone of ZONES) {
        out[zone] = await inZone(engine, zone, async () => ({
          all: (await engine.getSince('2026-11-01')).filter((r) => r.page_slug === MEETING).map((r) => `${r.date} ${r.summary}`),
          meeting: (await engine.getSince('2026-03-08', { kind: 'meeting' })).map((r) => `${r.date} ${r.event_slug}`),
        }));
      }
      for (const zone of ZONES) expect({ zone, all: out[zone].all, meeting: out[zone].meeting }).toEqual({ zone, ...out.UTC });
      expect(out.UTC).toEqual({
        all: ['2026-11-01 US DST end day', '2026-11-02 Monday after DST end'],
        meeting: [`2026-03-08 ${E_EARLY}`, `2026-06-30 ${E_JUNE}`],
      });
      record(kind, 'since', out);
    });

    test('getOnThisDay: Feb 29 entries surface only on a Feb 29; Feb 28 and Mar 1 of other years never show them', async () => {
      const out: Record<string, Record<string, string[]>> = {};
      for (const zone of ZONES) {
        out[zone] = await inZone(engine, zone, async () => {
          const r: Record<string, string[]> = {};
          for (const d of ['2028-02-29', '2032-02-29', '2027-02-28', '2027-03-01', '2025-03-01']) {
            r[d] = (await engine.getOnThisDay({ date: d })).map((x) => x.date);
          }
          return r;
        });
      }
      for (const zone of ZONES) expect({ zone, days: out[zone] }).toEqual({ zone, days: out.UTC });
      expect(out.UTC).toEqual({
        '2028-02-29': ['2024-02-29', '2020-02-29'], // strictly before the target; newest first
        '2032-02-29': ['2028-02-29', '2024-02-29', '2020-02-29'],
        '2027-02-28': ['2025-02-28'],
        '2027-03-01': ['2025-03-01', '2023-03-01'],
        '2025-03-01': ['2023-03-01'],
      });
      record(kind, 'onThisDayLeap', out);
    });

    test('getLastSeen: day math across DST and leap day, wikilink and LIKE-escape matching, and a zone-dependent tie on one day', async () => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const zone of ZONES) {
        out[zone] = await inZone(engine, zone, async () => ({
          dst: await engine.getLastSeen(ALICE, { asof: '2026-03-09' }),
          leap: await engine.getLastSeen(ALICE, { asof: '2024-03-01' }),
          yearGap: await engine.getLastSeen(ALICE, { asof: '2024-02-28' }),
          june: await engine.getLastSeen(ALICE, { asof: '2026-06-30' }),
          july: await engine.getLastSeen(ALICE, { asof: '2026-07-01' }),
          underscore: await engine.getLastSeen(ALICE_UNDERSCORE, { asof: '2026-12-31' }),
        }));
      }
      const fixed = (r: Record<string, unknown>): Record<string, unknown> => ({ ...r, july: undefined });
      for (const zone of ZONES) expect({ zone, ...fixed(out[zone]) }).toEqual({ zone, ...fixed(out.UTC) });
      expect(fixed(out.UTC)).toEqual({
        dst: { entity_slug: ALICE, last_date: '2026-03-08', last_event_slug: E_LATE, days_ago: 1 },
        leap: { entity_slug: ALICE, last_date: '2024-02-29', last_event_slug: null, days_ago: 1 },
        yearGap: { entity_slug: ALICE, last_date: '2023-03-01', last_event_slug: null, days_ago: 364 },
        june: { entity_slug: ALICE, last_date: '2026-06-30', last_event_slug: E_JUNE, days_ago: 0 },
        july: undefined,
        underscore: { entity_slug: ALICE_UNDERSCORE, last_date: null, last_event_slug: null, days_ago: null },
      });
      // 2026-07-01: Alice's own plain row (local midnight) against the event at
      // 00:00Z. Equal instants in UTC, so the newer row id (the event) wins.
      expect(Object.fromEntries(ZONES.map((z) => [z, (out[z].july as { last_event_slug: string | null }).last_event_slug]))).toEqual({
        UTC: E_JULY,
        'America/Los_Angeles': null,
        'America/Santiago': null,
        'Pacific/Kiritimati': E_JULY,
        'Pacific/Pago_Pago': null,
      });
      record(kind, 'lastSeen', out);
    });

    test('with no date, getOnThisDay and getLastSeen use the session zone\'s current_date', async () => {
      const ahead = await inZone(engine, 'Pacific/Kiritimati', async () => ({
        lastSeen: await engine.getLastSeen(BOB),
        onThisDay: (await engine.getOnThisDay()).filter((r) => r.page_slug === BOB).map((r) => r.summary),
      }));
      const behind = await inZone(engine, 'Pacific/Pago_Pago', async () => ({
        lastSeen: await engine.getLastSeen(BOB),
        onThisDay: (await engine.getOnThisDay()).filter((r) => r.page_slug === BOB).map((r) => r.summary),
      }));
      const [{ today }] = await engine.executeRaw<{ today: string }>(`SELECT ((now() AT TIME ZONE 'Pacific/Kiritimati')::date)::text AS today`);
      expect(ahead).toEqual({
        lastSeen: { entity_slug: BOB, last_date: today, last_event_slug: null, days_ago: 0 },
        onThisDay: ['Bob a year ago in Kiritimati'],
      });
      expect(behind.lastSeen.last_date === null || behind.lastSeen.last_date < today).toBe(true);
      expect(behind.onThisDay).toEqual([]);
      record(kind, 'currentDateDefault', { ahead: { ...ahead, lastSeen: { ...ahead.lastSeen, last_date: 'today' } }, behind: { ...behind, lastSeen: { ...behind.lastSeen, last_date: behind.lastSeen.last_date ? 'earlier' : null } } });
    });

    test('the anniversary fixture keeps the same month and day on a leap day and on an ordinary day', async () => {
      const [row] = await engine.executeRaw<{ leap: string; plain: string }>(
        `SELECT ${anniversarySql("'2028-02-29'::date")}::text AS leap, ${anniversarySql("'2026-11-17'::date")}::text AS plain`);
      expect(row).toEqual({ leap: '2024-02-29', plain: '2025-11-17' });
    });

    test('getEffectiveDates and getPageTimestamps return the same instants in every zone, at millisecond precision', async () => {
      const refs = ['dates/leap-evening', 'dates/no-effective', 'dates/micros', 'dates/deleted', 'dates/missing'].map((slug) => ({ slug, source_id: 'default' }));
      refs.push({ slug: 'dates/dup', source_id: 'other' });
      const out: Record<string, { effective: Record<string, string>; timestamps: Record<string, string>; dupCount: number }> = {};
      for (const zone of ZONES) {
        out[zone] = await inZone(engine, zone, async () => {
          const timestamps = isoMap(await engine.getPageTimestamps(['dates/leap-evening', 'dates/no-effective', 'dates/missing']));
          const dup = await engine.getPageTimestamps(['dates/dup']);
          return { effective: isoMap(await engine.getEffectiveDates(refs)), timestamps, dupCount: dup.size };
        });
      }
      for (const zone of ZONES) expect({ zone, ...out[zone] }).toEqual({ zone, ...out.UTC });
      expect(out.UTC).toEqual({
        effective: {
          'default::dates/deleted': '2026-01-05T00:00:00.000Z', // unscoped reads do not hide soft-deleted pages
          'default::dates/leap-evening': '2024-03-01T07:30:00.000Z',
          'default::dates/micros': '2026-03-08T10:00:00.123Z',
          'default::dates/no-effective': '2026-03-08T09:59:59.999Z',
          'other::dates/dup': '2026-05-01T00:00:00.000Z',
        },
        timestamps: {
          'dates/leap-evening': '2026-02-01T00:00:00.000Z', // updated_at, never effective_date
          'dates/no-effective': '2026-03-08T09:59:59.999Z',
        },
        // Slug-keyed across sources: two pages collapse to one key, and the
        // statement has no ORDER BY, so which source wins is unspecified.
        dupCount: 1,
      });
      record(kind, 'dateMaps', out);
    });

    test('addTimelineEntriesBatch: empty, duplicate, missing-page, soft-deleted-page and cross-source rows', async () => {
      const read = async () => (await engine.executeRaw<{ row: string }>(
        `SELECT p.source_id || ':' || p.slug || ' ' || te.date::text || ' ' || te.source || ' ' || te.summary AS row
         FROM timeline_entries te JOIN pages p ON p.id = te.page_id
         WHERE p.slug IN ('batch/a', 'batch/gone') ORDER BY 1`,
      )).map((r) => r.row);
      const batch = [
        { slug: 'batch/a', date: '2026-03-08', summary: 'same', source: 's1' },
        { slug: 'batch/a', date: '2026-03-08', summary: 'same', source: 's1' }, // in-batch duplicate
        { slug: 'batch/a', date: '2026-03-08', summary: 'same', source: 's2' }, // other source label: a new row
        { slug: 'batch/a', date: '2026-03-08', summary: 'same', source: 's1', source_id: 'other' },
        { slug: 'batch/missing', date: '2026-03-08', summary: 'dropped' },
        { slug: 'batch/gone', date: '2026-03-08', summary: 'dropped' },
      ];
      const counts = {
        empty: await engine.addTimelineEntriesBatch([]),
        first: await engine.addTimelineEntriesBatch(batch),
        rerun: await engine.addTimelineEntriesBatch(batch),
        // Day part only: the offset and time of a timestamp string are ignored,
        // in any session zone (a Date goes through JSON as its UTC ISO string).
        laSession: await inZone(engine, 'America/Los_Angeles', () => engine.addTimelineEntriesBatch([
          { slug: 'batch/a', date: '2026-03-08T23:30:00-08:00', summary: 'late evening with offset' },
          { slug: 'batch/a', date: new Date('2026-03-09T04:00:00Z') as never, summary: 'Date object' },
          { slug: 'batch/a', date: '2024-02-29', summary: 'leap day' },
        ])),
      };
      const before = await read();
      const invalid = await engine.addTimelineEntriesBatch([
        { slug: 'batch/a', date: '2026-03-10', summary: 'valid row in a bad batch' },
        { slug: 'batch/a', date: '2025-02-29', summary: 'not a date' },
      ]).then(() => 'resolved', (e: Error) => /out of range/.test(e.message) ? 'rejected: out of range' : `rejected: ${e.message}`);
      const after = await read();
      expect({ counts, invalid, unchanged: after.length === before.length }).toEqual({
        counts: { empty: 0, first: 3, rerun: 0, laSession: 3 },
        invalid: 'rejected: out of range', // one bad date rejects the whole batch
        unchanged: true,
      });
      expect(after).toEqual([
        'default:batch/a 2024-02-29  leap day',
        'default:batch/a 2026-03-08  late evening with offset',
        'default:batch/a 2026-03-08 s1 same',
        'default:batch/a 2026-03-08 s2 same',
        'default:batch/a 2026-03-09  Date object',
        'other:batch/a 2026-03-08 s1 same',
      ]);
      record(kind, 'batch', { counts, invalid, rows: after });
    });

    test('default session zone: neither engine pins one', async () => {
      if (kind === 'postgres') {
        // At open the session zone still comes from the server, database or
        // role setting: the engine sent no TimeZone startup option or SET.
        expect(['client', 'session']).not.toContain(openZone!.source);
        return;
      }
      // PGLite takes the process's zone at open: its session offset equals the process offset.
      expect(laOpen).toBeDefined();
      expect(laOpen!.sessionSecs).toBe(laOpen!.processSecs);
      expect(laOpen!.sessionSecs).not.toBe(0);
    }, 60_000);
  });
}

describe('timeline and date reads: engines agree', () => {
  test('every case returned the same result on every engine that ran', () => {
    const runs = backends.filter((b) => seen.has(b)).map((b) => seen.get(b)!);
    expect(runs.length).toBe(backends.length);
    for (const run of runs) {
      for (const name of Object.keys(runs[0])) expect({ name, got: run[name] }).toEqual({ name, got: runs[0][name] });
      expect(Object.keys(run).sort()).toEqual(Object.keys(runs[0]).sort());
    }
  });
});
