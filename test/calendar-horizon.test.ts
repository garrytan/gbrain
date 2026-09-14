/**
 * Unit and integration tests for Google Calendar horizon containment,
 * provider recurrence classification, and shared consumer gates.
 *
 * Covers core recurrence classification, horizon containment, and consumer gate criteria:
 * 1. Calendar day arithmetic across month/year/leap boundaries.
 * 2. Cutoff instant conversion across DST transitions (spring-forward, fall-back, UTC-12, UTC+14).
 * 3. Timezone validation: missing timezone fails closed with NO UTC fallback; invalid timezone fails closed.
 * 4. Timed-event instant precision vs all-day calendar date semantics.
 * 5. Horizon parity between source configuration (g_future_days) and consumers (horizon_days).
 * 6. 5-state consumer discrimination (non-calendar meeting, past calendar, near-future calendar,
 *    beyond-horizon explicit one-off, beyond-horizon legacy-unknown).
 * 7. Consumer gates: Facts backstop, Chronicle backstop, Meeting timeline extraction, Advisor gap.
 * 8. Search recency: JS neutral factor 1.0 for future dates; SQL future CASE branch avoiding negative/zero denominator.
 * 9. Ingestion & reconcile: recurring series within vs beyond window, reschedule beyond window removing old path,
 *    cancellation tombstone without start date, out-of-window single delta preserved across sidecar rollover,
 *    durable 410 degradation marker surfaced in google status, and independent crash-safe durability.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addCalendarDays,
  getCutoffInstantMs,
  getCalendarDatePartsInTz,
  validateIanaTimeZone,
  isValidGregorianDate,
  isEventBeyondFutureHorizon,
  classifyCalendarEvent,
} from '../src/core/calendar-horizon.ts';

import { isFactsBackstopEligible } from '../src/core/facts/eligibility.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import { applyRecencyBoost } from '../src/core/search/hybrid.ts';
import { buildRecencyComponentSql } from '../src/core/search/sql-ranking.ts';
import { DEFAULT_FALLBACK } from '../src/core/search/recency-decay.ts';
import { calendarRelPath, renderCalendarEventPage } from '../src/core/google/google-render.ts';
import type { CalendarEventData } from '../src/core/google/types.ts';
import {
  googleStateFile,
  parseGoogleSourceConfig,
  readGoogleState,
  runGoogleSync,
} from '../src/core/google/google-source.ts';
import { runGoogleStatus } from '../src/commands/google.ts';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  type CredentialEntry,
  type CredentialMeta,
  type CredentialVault,
  type ProviderClientRecord,
  redactEntry,
} from '../src/core/creds/vault.ts';
import type { FetchImpl } from '../src/core/google/google-clients.ts';

// ── In-Memory Vault for E2E Tests ──────────────────────────────────────────

class MockVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string): Promise<CredentialEntry | null> {
    return this.entries.get(id) ?? null;
  }
  async put(entry: CredentialEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async list(filter?: { provider?: string }): Promise<CredentialMeta[]> {
    const all = Array.from(this.entries.values());
    return all
      .filter((e) => !filter?.provider || e.provider === filter.provider)
      .map(redactEntry);
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.clients.get(provider) ?? null;
  }
  async putClient(client: ProviderClientRecord): Promise<void> {
    this.clients.set(client.provider, client);
  }
  async deleteClient(provider: string): Promise<boolean> {
    return this.clients.delete(provider);
  }
}

function makeVault(): MockVault {
  const v = new MockVault();
  v.putClient({ provider: 'google', client_id: 'cid', client_secret: 'sec', created_at: new Date().toISOString() });
  v.put({
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 'valid-tok',
      refresh_token: 'ref-tok',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    meta: {
      account: 'a@example.com',
      sendas_aliases: ['a@example.com'],
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      connected_at: new Date().toISOString(),
      client_id: 'cid',
    },
  });
  return v;
}

// ── Shared Engine for Integration Tests ────────────────────────────────────

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '7');
});

// ── 1. Pure Calendar Date Arithmetic & Validation ──────────────────────────

describe('calendar-horizon pure units', () => {
  test('validateIanaTimeZone accepts valid IANA zones and rejects invalid/empty', () => {
    expect(validateIanaTimeZone('America/New_York')).toBe('America/New_York');
    expect(validateIanaTimeZone('UTC')).toBe('UTC');
    expect(validateIanaTimeZone('Europe/London')).toBe('Europe/London');
    expect(validateIanaTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(validateIanaTimeZone('Pacific/Kiritimati')).toBe('Pacific/Kiritimati');
    expect(validateIanaTimeZone('Etc/GMT+12')).toBe('Etc/GMT+12');

    // Invalid or missing timezones must throw (fail closed)
    expect(() => validateIanaTimeZone('Invalid/Zone')).toThrow();
    expect(() => validateIanaTimeZone('')).toThrow();
    expect(() => validateIanaTimeZone('   ')).toThrow();
    expect(() => validateIanaTimeZone(null as unknown as string)).toThrow();
  });

  test('addCalendarDays handles month, year, and leap-year boundaries deterministically', () => {
    // Normal day addition
    expect(addCalendarDays(2026, 3, 1, 10)).toEqual({ year: 2026, month: 3, day: 11, dateStr: '2026-03-11' });

    // Month rollovers
    expect(addCalendarDays(2026, 1, 31, 1)).toEqual({ year: 2026, month: 2, day: 1, dateStr: '2026-02-01' });
    expect(addCalendarDays(2026, 4, 30, 1)).toEqual({ year: 2026, month: 5, day: 1, dateStr: '2026-05-01' });

    // Leap year (2024 is leap year: Feb 28 + 1 = Feb 29; Feb 29 + 1 = Mar 1)
    expect(addCalendarDays(2024, 2, 28, 1)).toEqual({ year: 2024, month: 2, day: 29, dateStr: '2024-02-29' });
    expect(addCalendarDays(2024, 2, 29, 1)).toEqual({ year: 2024, month: 3, day: 1, dateStr: '2024-03-01' });

    // Non-leap year (2025: Feb 28 + 1 = Mar 1)
    expect(addCalendarDays(2025, 2, 28, 1)).toEqual({ year: 2025, month: 3, day: 1, dateStr: '2025-03-01' });

    // Year rollover
    expect(addCalendarDays(2026, 12, 31, 1)).toEqual({ year: 2027, month: 1, day: 1, dateStr: '2027-01-01' });
    expect(addCalendarDays(2027, 1, 1, -1)).toEqual({ year: 2026, month: 12, day: 31, dateStr: '2026-12-31' });
  });

  test('getCutoffInstantMs handles spring-forward (23h) and fall-back (25h) DST transitions', () => {
    // In America/New_York:
    // Spring forward: Sunday, March 8, 2026 (23-hour day; UTC-5 to UTC-4)
    // Starting March 7, 2026 12:00:00-05:00, adding 2 calendar days -> cutoff day is March 9, 2026.
    // Cutoff instant is midnight of March 10, 2026 in America/New_York (00:00:00 EDT = 04:00:00.000Z).
    const march7NoonMs = Date.parse('2026-03-07T12:00:00-05:00');
    const cutoffSpringMs = getCutoffInstantMs(march7NoonMs, 2, 'America/New_York');
    expect(new Date(cutoffSpringMs).toISOString()).toBe('2026-03-10T04:00:00.000Z');

    // Fall back: Sunday, November 1, 2026 (25-hour day; UTC-4 to UTC-5)
    // Starting October 31, 2026 12:00:00-04:00, adding 2 calendar days -> cutoff day is November 2, 2026.
    // Cutoff instant is midnight of November 3, 2026 in America/New_York (00:00:00 EST = 05:00:00.000Z).
    const oct31NoonMs = Date.parse('2026-10-31T12:00:00-04:00');
    const cutoffFallMs = getCutoffInstantMs(oct31NoonMs, 2, 'America/New_York');
    expect(new Date(cutoffFallMs).toISOString()).toBe('2026-11-03T05:00:00.000Z');
  });

  test('getCutoffInstantMs handles UTC-12 and UTC+14 extreme timezone boundaries', () => {
    const refMs = Date.parse('2026-06-15T12:00:00Z');

    // Pacific/Kiritimati (UTC+14): at 2026-06-15T12:00:00Z, local time is 2026-06-16 02:00:00.
    // Cutoff date with futureDays=1 is 2026-06-17.
    // Midnight of 2026-06-18 local time is 2026-06-17T10:00:00.000Z.
    const cutoffKiritimati = getCutoffInstantMs(refMs, 1, 'Pacific/Kiritimati');
    expect(new Date(cutoffKiritimati).toISOString()).toBe('2026-06-17T10:00:00.000Z');

    // Etc/GMT+12 (UTC-12): at 2026-06-15T12:00:00Z, local time is 2026-06-15 00:00:00.
    // Cutoff date with futureDays=1 is 2026-06-16.
    // Midnight of 2026-06-17 local time is 2026-06-17T12:00:00.000Z.
    const cutoffGmt12 = getCutoffInstantMs(refMs, 1, 'Etc/GMT+12');
    expect(new Date(cutoffGmt12).toISOString()).toBe('2026-06-17T12:00:00.000Z');
  });

  test('isEventBeyondFutureHorizon correctly bounds all-day events at timezone boundaries', () => {
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const futureDays = 10;
    const tz = 'America/New_York'; // today in NY is 2026-06-15; cutoff is 2026-06-25

    // Exactly on cutoff day
    expect(isEventBeyondFutureHorizon({ startIso: '2026-06-25', allDay: true, startDate: '2026-06-25' }, futureDays, tz, nowMs)).toBe(false);

    // 1 day beyond cutoff day
    expect(isEventBeyondFutureHorizon({ startIso: '2026-06-26', allDay: true, startDate: '2026-06-26' }, futureDays, tz, nowMs)).toBe(true);

    // Timed event precision against cutoff instant
    const cutoffInstantMs = getCutoffInstantMs(nowMs, futureDays, tz); // 2026-06-26 00:00:00 NY = 2026-06-26T04:00:00.000Z
    expect(isEventBeyondFutureHorizon({ startIso: new Date(cutoffInstantMs - 1000).toISOString(), allDay: false }, futureDays, tz, nowMs)).toBe(false);
    expect(isEventBeyondFutureHorizon({ startIso: new Date(cutoffInstantMs).toISOString(), allDay: false }, futureDays, tz, nowMs)).toBe(true);
  });

  test('Fallback DST discriminator: fixed (futureDays + 1) misses final accepted hour, but buffered query returns it and local gate admits it', () => {
    // In America/New_York, DST fall-back occurs on Sunday, November 1, 2026 (25-hour day).
    // Let nowMs be Sunday Nov 1 at 00:15:00 EDT (04:15:00Z).
    const nowMs = Date.parse('2026-11-01T00:15:00-04:00');
    const futureDays = 1;
    const tz = 'America/New_York';

    // In local NY time, today is 2026-11-01. Horizon ends at the end of 2026-11-02 (Monday).
    // The exact cutoff instant is start of Tuesday, Nov 3 (00:00:00 EST = 2026-11-03T05:00:00.000Z).
    const cutoffInstantMs = getCutoffInstantMs(nowMs, futureDays, tz);
    expect(new Date(cutoffInstantMs).toISOString()).toBe('2026-11-03T05:00:00.000Z');

    // Fixed duration (futureDays + 1) * 24h = 48h from nowMs:
    const fixedTimeMaxMs = nowMs + (futureDays + 1) * 86_400_000;
    expect(new Date(fixedTimeMaxMs).toISOString()).toBe('2026-11-03T04:15:00.000Z'); // 23:15:00 EST on Monday

    // Event A: Recurring meeting on Monday evening at 23:30:00 EST (2026-11-03T04:30:00.000Z).
    // This is within the accepted local horizon (starts before cutoff 2026-11-03T05:00:00.000Z).
    const eventA = {
      startIso: '2026-11-02T23:30:00-05:00',
      allDay: false,
      recurringEventId: 'weekly_team_sync',
      recurrence: 'recurring' as const,
    };
    const eventAMs = Date.parse(eventA.startIso);

    // DISCRIMINATOR: Fixed (N + 1) misses Event A because eventAMs > fixedTimeMaxMs!
    expect(eventAMs).toBeGreaterThan(fixedTimeMaxMs);

    // Conservative buffered query envelope (futureDays + 2) * 24h = 72h from nowMs:
    const bufferedTimeMaxMs = nowMs + (futureDays + 2) * 86_400_000;
    expect(new Date(bufferedTimeMaxMs).toISOString()).toBe('2026-11-04T04:15:00.000Z');

    // Buffered provider query captures Event A:
    expect(eventAMs).toBeLessThan(bufferedTimeMaxMs);

    // Authoritative local gate admits Event A:
    expect(isEventBeyondFutureHorizon(eventA, futureDays, tz, nowMs)).toBe(false);

    // Event B: Extra recurrence on Tuesday morning at 10:00:00 EST (2026-11-03T15:00:00.000Z).
    // Returned by the buffered provider query because it is < bufferedTimeMaxMs.
    const eventB = {
      startIso: '2026-11-03T10:00:00-05:00',
      allDay: false,
      recurringEventId: 'weekly_team_sync',
      recurrence: 'recurring' as const,
    };
    const eventBMs = Date.parse(eventB.startIso);
    expect(eventBMs).toBeLessThan(bufferedTimeMaxMs);

    // DISCRIMINATOR: Authoritative local gate REJECTS Event B (beyond local horizon)!
    expect(isEventBeyondFutureHorizon(eventB, futureDays, tz, nowMs)).toBe(true);
  });
});

// ── 2. Five-State Event Classification & Binding Contract Defect Fixes ────

describe('classifyCalendarEvent 5-state discrimination and defect fixes', () => {
  const nowMs = Date.parse('2026-06-15T12:00:00Z');

  test('State 1: Ordinary non-calendar meeting is not a calendar event and remains eligible', () => {
    const res = classifyCalendarEvent({
      slug: 'meetings/2026-06-15-design-sync.md',
      type: 'meeting',
      frontmatter: {
        title: 'Design sync with Teio',
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(false);
    expect(res.beyondFutureHorizon).toBe(false);
    expect(res.isFuture).toBe(false);
    expect(res.valid).toBe(true);
  });

  test('State 2: Past Google calendar event', () => {
    const res = classifyCalendarEvent({
      slug: 'calendar/2026/05/2026-05-10-past-retro.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_past_001',
        start: '2026-05-10T14:00:00Z',
        end: '2026-05-10T15:00:00Z',
        timezone: 'America/New_York',
        recurrence: 'single',
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(true);
    expect(res.recurrenceKind).toBe('single');
    expect(res.isFuture).toBe(false);
    expect(res.beyondFutureHorizon).toBe(false);
    expect(res.valid).toBe(true);
  });

  test('State 3: Near-future Google calendar event within horizon', () => {
    const res = classifyCalendarEvent({
      slug: 'calendar/2026/06/2026-06-20-team-sync.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_near_002',
        start: '2026-06-20T14:00:00Z',
        end: '2026-06-20T15:00:00Z',
        timezone: 'America/New_York',
        recurrence: 'recurring',
        recurring_event_id: 'series_002',
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(true);
    expect(res.recurrenceKind).toBe('recurring');
    expect(res.isFuture).toBe(true);
    expect(res.beyondFutureHorizon).toBe(false);
    expect(res.valid).toBe(true);
  });

  test('State 4: Beyond-horizon explicit one-off (single)', () => {
    const res = classifyCalendarEvent({
      slug: 'calendar/2026/11/2026-11-20-annual-summit.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_far_003',
        start: '2026-11-20T14:00:00Z',
        end: '2026-11-20T15:00:00Z',
        timezone: 'America/New_York',
        recurrence: 'single',
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(true);
    expect(res.recurrenceKind).toBe('single');
    expect(res.isFuture).toBe(true);
    expect(res.beyondFutureHorizon).toBe(true);
    expect(res.valid).toBe(true);
  });

  test('State 5: Beyond-horizon legacy-unknown event (missing recurrence metadata)', () => {
    const res = classifyCalendarEvent({
      slug: 'calendar/2029/09/2029-09-15-phantom.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_legacy_004',
        start: '2029-09-15T10:00:00Z',
        end: '2029-09-15T11:00:00Z',
        timezone: 'America/New_York',
        // No recurrence or recurring_event_id!
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(true);
    expect(res.recurrenceKind).toBe('unknown');
    expect(res.isFuture).toBe(true);
    expect(res.beyondFutureHorizon).toBe(true);
    expect(res.valid).toBe(true);
  });

  test('Binding Defect 1: Missing timezone fails closed with NO UTC fallback', () => {
    const res = classifyCalendarEvent({
      slug: 'calendar/2026/06/2026-06-20-no-tz.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_notz_005',
        start: '2026-06-20T14:00:00Z',
        // timezone missing
      },
      nowMs,
    });
    expect(res.isCalendar).toBe(true);
    expect(res.valid).toBe(false);
    expect(res.beyondFutureHorizon).toBe(true);
    expect(res.isFuture).toBe(true);
    expect(res.error).toContain('no UTC fallback');
  });

  test('Binding Defect 2: Timed events preserve instant precision and do not collapse to date-only', () => {
    // A timed meeting starting in 2 hours on the SAME calendar day
    const twoHoursFromNow = new Date(nowMs + 2 * 3600 * 1000).toISOString();
    const res = classifyCalendarEvent({
      slug: 'calendar/2026/06/2026-06-15-later-today.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_today_006',
        start: twoHoursFromNow,
        end: new Date(nowMs + 3 * 3600 * 1000).toISOString(),
        timezone: 'America/New_York',
        recurrence: 'single',
      },
      nowMs,
    });
    expect(res.valid).toBe(true);
    // Instant precision preserves that this meeting is in the future!
    expect(res.isFuture).toBe(true);
    expect(res.beyondFutureHorizon).toBe(false);

    // True all-day event for today: start_date is today, so isFuture is false
    const allDayRes = classifyCalendarEvent({
      slug: 'calendar/2026/06/2026-06-15-all-day.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_today_007',
        all_day: true,
        start_date: '2026-06-15',
        timezone: 'America/New_York',
        recurrence: 'single',
      },
      nowMs,
    });
    expect(allDayRes.valid).toBe(true);
    expect(allDayRes.isFuture).toBe(false);
  });

  test('Binding Defect 4: Consumer horizon parity with configured g_future_days via horizon_days', () => {
    // Event at +75 days from nowMs (now is 2026-06-15, +75 days is 2026-08-29)
    const future75DaysIso = new Date(nowMs + 75 * 86400000).toISOString();

    // Default horizon (60 days) -> beyond future horizon
    const defaultRes = classifyCalendarEvent({
      slug: 'calendar/2026/08/2026-08-29-future.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_75d_008',
        start: future75DaysIso,
        timezone: 'America/New_York',
        recurrence: 'single',
      },
      nowMs,
    });
    expect(defaultRes.beyondFutureHorizon).toBe(true);

    // Configured horizon (90 days) emitted in frontmatter as horizon_days -> inside horizon
    const configuredRes = classifyCalendarEvent({
      slug: 'calendar/2026/08/2026-08-29-future.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_75d_008',
        start: future75DaysIso,
        timezone: 'America/New_York',
        recurrence: 'single',
        horizon_days: 90,
      },
      nowMs,
    });
    expect(configuredRes.beyondFutureHorizon).toBe(false);
  });

  test('Malformed or missing structured dates fail closed without mutation or crash', () => {
    const malformedStart = classifyCalendarEvent({
      slug: 'calendar/2026/06/malformed.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_bad_009',
        start: 'not-a-valid-timestamp',
        timezone: 'America/New_York',
      },
      nowMs,
    });
    expect(malformedStart.valid).toBe(false);
    expect(malformedStart.beyondFutureHorizon).toBe(true);
    expect(malformedStart.isFuture).toBe(true);

    const missingStart = classifyCalendarEvent({
      slug: 'calendar/2026/06/missing.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_bad_010',
        timezone: 'America/New_York',
      },
      nowMs,
    });
    expect(missingStart.valid).toBe(false);
    expect(missingStart.beyondFutureHorizon).toBe(true);
    expect(missingStart.isFuture).toBe(true);
  });

  test('Real Gregorian date validation: impossible dates (2026-99-99, 2025-02-29, 2026-04-31) fail closed', () => {
    // Pure helper checks
    expect(isValidGregorianDate('2026-99-99')).toBe(false);
    expect(isValidGregorianDate('2025-02-29')).toBe(false); // 2025 is not a leap year
    expect(isValidGregorianDate('2024-02-29')).toBe(true);  // 2024 is a leap year
    expect(isValidGregorianDate('2000-02-29')).toBe(true);  // 2000 is a 400-year leap year
    expect(isValidGregorianDate('1900-02-29')).toBe(false); // 1900 is century non-leap
    expect(isValidGregorianDate('2026-04-31')).toBe(false); // April has 30 days
    expect(isValidGregorianDate('2026-02-30')).toBe(false);
    expect(isValidGregorianDate('2026-06-15')).toBe(true);
    expect(isValidGregorianDate('not-a-date')).toBe(false);
    expect(isValidGregorianDate('')).toBe(false);

    // classifyCalendarEvent: all-day impossible dates fail closed
    const allDayBad1 = classifyCalendarEvent({
      slug: 'calendar/2026/99/bad.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_greg_1',
        all_day: true,
        start_date: '2026-99-99',
        timezone: 'America/New_York',
      },
      nowMs,
    });
    expect(allDayBad1.valid).toBe(false);
    expect(allDayBad1.beyondFutureHorizon).toBe(true);
    expect(allDayBad1.isFuture).toBe(true);
    expect(allDayBad1.error).toContain('non-Gregorian');

    const allDayBad2 = classifyCalendarEvent({
      slug: 'calendar/2025/02/bad-leap.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_greg_2',
        all_day: true,
        start_date: '2025-02-29',
        timezone: 'America/New_York',
      },
      nowMs,
    });
    expect(allDayBad2.valid).toBe(false);
    expect(allDayBad2.beyondFutureHorizon).toBe(true);
    expect(allDayBad2.isFuture).toBe(true);

    // classifyCalendarEvent: timed event with impossible Gregorian date fails closed
    const timedBad = classifyCalendarEvent({
      slug: 'calendar/2026/99/bad-timed.md',
      type: 'meeting',
      frontmatter: {
        type: 'meeting',
        event_id: 'cal_greg_3',
        start: '2026-99-99T10:00:00Z',
        timezone: 'America/New_York',
      },
      nowMs,
    });
    expect(timedBad.valid).toBe(false);
    expect(timedBad.beyondFutureHorizon).toBe(true);
    expect(timedBad.isFuture).toBe(true);

    // isEventBeyondFutureHorizon: impossible dates fail closed (return true)
    expect(isEventBeyondFutureHorizon({ startIso: '2026-99-99', allDay: true, startDate: '2026-99-99' }, 60, 'America/New_York', nowMs)).toBe(true);
    expect(isEventBeyondFutureHorizon({ startIso: '2025-02-29', allDay: true, startDate: '2025-02-29' }, 60, 'America/New_York', nowMs)).toBe(true);
    expect(isEventBeyondFutureHorizon({ startIso: '2026-99-99T10:00:00Z', allDay: false }, 60, 'America/New_York', nowMs)).toBe(true);
  });
});

// ── 3. Shared Consumer Gates ───────────────────────────────────────────────

describe('consumer gates containment across all 5 states', () => {
  const nowMs = Date.parse('2026-06-15T12:00:00Z');
  const validTz = 'America/New_York';

  const nonCalendarMeeting = {
    slug: 'meetings/2026-06-15-one-on-one.md',
    type: 'meeting' as const,
    compiled_truth: 'A long enough body for meeting notes between colleagues discussing plans.'.repeat(2),
    frontmatter: { title: '1:1 Sync' },
  };

  const pastCalendarEvent = {
    slug: 'calendar/2026/05/2026-05-10-retro.md',
    type: 'meeting' as const,
    compiled_truth: 'Discussion on previous sprint results and action items.'.repeat(3),
    frontmatter: {
      type: 'meeting',
      event_id: 'past_cal_1',
      start: '2026-05-10T14:00:00Z',
      timezone: validTz,
      recurrence: 'single',
    },
  };

  const nearFutureCalendarEvent = {
    slug: 'calendar/2026/06/2026-06-20-planning.md',
    type: 'meeting' as const,
    compiled_truth: 'Agenda for upcoming quarter planning and roadmap deliverables.'.repeat(3),
    frontmatter: {
      type: 'meeting',
      event_id: 'near_cal_2',
      start: '2026-06-20T14:00:00Z',
      timezone: validTz,
      recurrence: 'recurring',
    },
  };

  const beyondHorizonOneOff = {
    slug: 'calendar/2026/11/2026-11-20-summit.md',
    type: 'meeting' as const,
    compiled_truth: 'Annual industry summit keynote and panel discussions.'.repeat(3),
    frontmatter: {
      type: 'meeting',
      event_id: 'far_cal_3',
      start: '2026-11-20T14:00:00Z',
      timezone: validTz,
      recurrence: 'single',
    },
  };

  const beyondHorizonLegacy = {
    slug: 'calendar/2029/09/2029-09-15-phantom.md',
    type: 'meeting' as const,
    compiled_truth: 'Phantom recurrence instance from long past series.'.repeat(3),
    frontmatter: {
      type: 'meeting',
      event_id: 'phantom_cal_4',
      start: '2029-09-15T14:00:00Z',
      timezone: validTz,
    },
  };

  test('Facts Backstop: admits non-calendar, past, and near-future; rejects beyond-horizon single, legacy, and malformed', () => {
    // Non-calendar meeting -> ELIGIBLE
    expect(isFactsBackstopEligible(nonCalendarMeeting.slug, nonCalendarMeeting).ok).toBe(true);

    // Past calendar event -> ELIGIBLE
    expect(isFactsBackstopEligible(pastCalendarEvent.slug, pastCalendarEvent).ok).toBe(true);

    // Near future calendar event -> ELIGIBLE (facts extracts commitments/prep)
    expect(isFactsBackstopEligible(nearFutureCalendarEvent.slug, nearFutureCalendarEvent).ok).toBe(true);

    // Beyond-horizon explicit one-off -> REJECTED
    const resFar = isFactsBackstopEligible(beyondHorizonOneOff.slug, beyondHorizonOneOff);
    expect(resFar.ok).toBe(false);
    if (!resFar.ok) expect(resFar.reason).toBe('calendar_beyond_future_horizon');

    // Beyond-horizon legacy unknown -> REJECTED
    const resLegacy = isFactsBackstopEligible(beyondHorizonLegacy.slug, beyondHorizonLegacy);
    expect(resLegacy.ok).toBe(false);
    if (!resLegacy.ok) expect(resLegacy.reason).toBe('calendar_beyond_future_horizon');

    // Malformed timezone / date -> REJECTED
    const resBad = isFactsBackstopEligible('calendar/bad.md', {
      type: 'meeting',
      compiled_truth: 'Long enough body text for testing purposes.'.repeat(3),
      frontmatter: { type: 'meeting', event_id: 'bad_1', start: '2026-06-20T14:00:00Z' /* no tz */ },
    });
    expect(resBad.ok).toBe(false);
    if (!resBad.ok) expect(resBad.reason).toBe('calendar_beyond_future_horizon');
  });

  test('Chronicle Backstop: admits non-calendar and past; rejects ALL future calendar events and malformed', () => {
    // Non-calendar meeting -> ELIGIBLE
    expect(isChronicleEligible({
      type: nonCalendarMeeting.type,
      slug: nonCalendarMeeting.slug,
      body: nonCalendarMeeting.compiled_truth,
      frontmatter: nonCalendarMeeting.frontmatter,
      nowMs,
    }).ok).toBe(true);

    // Past calendar event -> ELIGIBLE
    expect(isChronicleEligible({
      type: pastCalendarEvent.type,
      slug: pastCalendarEvent.slug,
      body: pastCalendarEvent.compiled_truth,
      frontmatter: pastCalendarEvent.frontmatter,
      nowMs,
    }).ok).toBe(true);

    // Near future calendar event -> REJECTED (Life Chronicle only records completed history!)
    const resNear = isChronicleEligible({
      type: nearFutureCalendarEvent.type,
      slug: nearFutureCalendarEvent.slug,
      body: nearFutureCalendarEvent.compiled_truth,
      frontmatter: nearFutureCalendarEvent.frontmatter,
      nowMs,
    });
    expect(resNear.ok).toBe(false);
    if (!resNear.ok) expect(resNear.reason).toBe('calendar_future');

    // Far future -> REJECTED
    expect(isChronicleEligible({
      type: beyondHorizonOneOff.type,
      slug: beyondHorizonOneOff.slug,
      body: beyondHorizonOneOff.compiled_truth,
      frontmatter: beyondHorizonOneOff.frontmatter,
      nowMs,
    }).ok).toBe(false);

    // Legacy beyond horizon -> REJECTED
    expect(isChronicleEligible({
      type: beyondHorizonLegacy.type,
      slug: beyondHorizonLegacy.slug,
      body: beyondHorizonLegacy.compiled_truth,
      frontmatter: beyondHorizonLegacy.frontmatter,
      nowMs,
    }).ok).toBe(false);
  });

  test('Advisor Chronicle Coverage Gap: uses occurrence date, excludes future events, and handles malformed dates safely', async () => {
    // 1. Clean state -> no findings
    const ctx: AdvisorContext = { engine, remote: false } as unknown as AdvisorContext;
    expect(await collectChronicle.collect(ctx)).toHaveLength(0);

    // 2. Put a future calendar meeting page in DB
    await engine.putPage(nearFutureCalendarEvent.slug, {
      type: 'meeting',
      title: 'Near Future Planning',
      compiled_truth: nearFutureCalendarEvent.compiled_truth,
      frontmatter: nearFutureCalendarEvent.frontmatter,
    });

    // 3. Put a malformed calendar meeting page in DB
    await engine.putPage('calendar/malformed.md', {
      type: 'meeting',
      title: 'Malformed Event',
      compiled_truth: 'Some body text',
      frontmatter: { type: 'meeting', event_id: 'bad_99', start: 'garbage-date' },
    });

    // 4. Collect chronicle findings: future meeting must NOT report a chronicle coverage gap
    const findings = await collectChronicle.collect(ctx);
    const gapFinding = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gapFinding).toBeUndefined();
  });
});

// ── 4. Search Recency Boost Controls (JS & SQL) ───────────────────────────

describe('search recency controls (JS & SQL)', () => {
  test('JS applyRecencyBoost gives neutral factor 1.0 to future dates without negative distortion', () => {
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const pastDate = new Date(nowMs - 7 * 86400000); // 7 days old
    const futureDate = new Date(nowMs + 14 * 86400000); // 14 days in future

    const results = [
      { slug: 'calendar/past.md', score: 10.0, source_id: 'gsrc' } as any,
      { slug: 'calendar/future.md', score: 10.0, source_id: 'gsrc' } as any,
    ];

    const dates = new Map<string, Date>([
      ['gsrc::calendar/past.md', pastDate],
      ['gsrc::calendar/future.md', futureDate],
    ]);

    const decayMap = {
      'calendar/': { halflifeDays: 14, coefficient: 1.0 },
    };

    applyRecencyBoost(results, dates, 'on', decayMap, DEFAULT_FALLBACK, nowMs);

    // Past date receives recency boost: factor > 1.0 (1.0 + 1.0 * 14 / (14 + 7) = 1.666)
    expect(results[0].recency_boost).toBeGreaterThan(1.0);
    expect(results[0].score).toBeGreaterThan(10.0);

    // Future date receives neutral recency boost factor 1.0; score is unchanged!
    expect(results[1].recency_boost).toBe(1.0);
    expect(results[1].score).toBe(10.0);
  });

  test('SQL buildRecencyComponentSql protects future dates from negative denominator and division by zero', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.effective_date',
      decayMap: {
        'calendar/': { halflifeDays: 14, coefficient: 1.0 },
      },
      fallback: DEFAULT_FALLBACK,
    });

    // The CASE expression MUST short-circuit future dates to 0.0 before denominator evaluation
    expect(sql).toContain('CASE WHEN p.effective_date > NOW() THEN 0.0');
    expect(sql).toContain("WHEN p.slug LIKE 'calendar/%' THEN 1 * 14.0 / (14.0 + EXTRACT(EPOCH FROM (NOW() - p.effective_date)) / 86400.0)");
  });
});

// ── 5. End-to-End Ingestion, Reschedule, Sidecar, and 410 Recovery ─────────

describe('google calendar source ingestion and reconcile lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gsrc-cal-horizon-'));
  const vault = makeVault();

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface FakeCalApi {
    events: any[];
    deltaEvents: any[];
    timeZone: string;
    expireSyncToken: boolean;
    calls: string[];
  }

  function makeFakeApi(): FakeCalApi {
    return {
      events: [],
      deltaEvents: [],
      timeZone: 'America/New_York',
      expireSyncToken: false,
      calls: [],
    };
  }

  function buildFetch(api: FakeCalApi): FetchImpl {
    return async (url: string) => {
      const u = new URL(url);
      api.calls.push(u.pathname + (u.search ? u.search : ''));
      if (u.pathname.includes('/token')) {
        return new Response(JSON.stringify({
          access_token: 'refreshed-tok',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname.includes('/calendars/')) {
        if (u.searchParams.get('syncToken')) {
          if (api.expireSyncToken) {
            return new Response(JSON.stringify({ error: { code: 410, message: 'Sync token expired' } }), {
              status: 410,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({
            timeZone: api.timeZone,
            items: api.deltaEvents,
            nextSyncToken: 'cal-sync-delta-token',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          timeZone: api.timeZone,
          items: api.events,
          nextSyncToken: 'cal-sync-initial-token',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unhandled' }), { status: 400 });
    };
  }

  test('All-day page file path derives from raw start_date (YYYY-MM-DD)', () => {
    const ev: CalendarEventData = {
      id: 'allday001',
      account: 'a@example.com',
      summary: 'Offsite Meeting',
      description: '',
      location: null,
      startIso: '2026-07-04T00:00:00Z',
      startDate: '2026-07-04',
      endIso: '2026-07-05T00:00:00Z',
      allDay: true,
      status: 'confirmed',
      organizer: 'a@example.com',
      attendees: [],
      htmlLink: null,
      hangoutLink: null,
      timeZone: 'America/New_York',
    };
    const rel = calendarRelPath(ev);
    expect(rel).toBe('calendar/2026/07/2026-07-04-offsite-meeting-047f54d1.md');

    const rendered = renderCalendarEventPage(ev);
    expect(rendered).not.toBeNull();
    expect(rendered!.markdown).toContain('start_date: "2026-07-04"');
    expect(rendered!.markdown).toContain('timezone: "America/New_York"');
    expect(rendered!.markdown).toContain('all_day: true');
  });

  async function insertGoogleSource(sourceDir: string, extraCfg: Record<string, unknown> = {}): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
      [
        'gsrc',
        'Google',
        sourceDir,
        JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_services: 'calendar', g_dir: sourceDir, ...extraCfg }),
      ],
    );
  }

  test('Rescheduled instance moving beyond horizon deletes old page from disk and DB', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gsrc-resched-'));
    const api = makeFakeApi();
    const nowMs = Date.now();

    // Instance initially near term (+5 days)
    const inWindowStart = new Date(nowMs + 5 * 86400000).toISOString();
    api.events = [
      {
        id: 'series_inst_1',
        summary: 'Sprint Grooming',
        status: 'confirmed',
        start: { dateTime: inWindowStart },
        end: { dateTime: new Date(Date.parse(inWindowStart) + 3600000).toISOString() },
        organizer: { email: 'a@example.com' },
        attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
        recurringEventId: 'series_parent',
      },
    ];

    try {
      await insertGoogleSource(testDir, { g_future_days: 60 });
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, async () => {
        const cfg = parseGoogleSourceConfig({
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'calendar',
          g_future_days: 60,
          g_dir: testDir,
        }, testDir);

        // Initial sync -> event is materialized
        const res1 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(res1.status).toBe('first_sync');
        expect(res1.added).toBe(1);

        const rows1 = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`);
        expect(rows1.length).toBe(1);

        // Now event is rescheduled to +120 days (beyond 60-day horizon)
        const beyondWindowStart = new Date(nowMs + 120 * 86400000).toISOString();
        api.deltaEvents = [
          {
            id: 'series_inst_1',
            summary: 'Sprint Grooming',
            status: 'confirmed',
            start: { dateTime: beyondWindowStart },
            end: { dateTime: new Date(Date.parse(beyondWindowStart) + 3600000).toISOString() },
            organizer: { email: 'a@example.com' },
            attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
            recurringEventId: 'series_parent',
          },
        ];

        // Incremental sync receives the rescheduled instance:
        // Must DELETE the old in-window page because the event has moved outside the horizon!
        const res2 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(res2.deleted).toBe(1);

        const rows2 = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`);
        expect(rows2.length).toBe(0);
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('Cancellation tombstone without start date removes existing page cleanly', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gsrc-cancel-'));
    const api = makeFakeApi();
    const nowMs = Date.parse('2026-06-15T12:00:00Z');

    api.events = [
      {
        id: 'cancel_event_1',
        summary: 'Roadmap Discussion',
        status: 'confirmed',
        start: { dateTime: new Date(nowMs + 10 * 86400000).toISOString() },
        end: { dateTime: new Date(nowMs + 10 * 86400000 + 3600000).toISOString() },
        organizer: { email: 'a@example.com' },
        attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
      },
    ];

    try {
      await insertGoogleSource(testDir);
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, async () => {
        const cfg = parseGoogleSourceConfig({
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'calendar',
          g_dir: testDir,
        }, testDir);

        await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect((await engine.executeRaw(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`)).length).toBe(1);

        // Cancellation tombstone from Google Calendar API: carries id + status: cancelled, NO start/end!
        api.deltaEvents = [
          {
            id: 'cancel_event_1',
            status: 'cancelled',
          },
        ];

        const res2 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(res2.deleted).toBe(1);
        expect((await engine.executeRaw(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`)).length).toBe(0);
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('Out-of-window single delta is admitted and preserved across 24h sidecar rollover', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gsrc-rollover-'));
    const api = makeFakeApi();
    const nowMs = Date.parse('2026-06-15T12:00:00Z');

    try {
      await insertGoogleSource(testDir, { g_future_days: 60 });
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, async () => {
        const cfg = parseGoogleSourceConfig({
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'calendar',
          g_future_days: 60,
          g_dir: testDir,
        }, testDir);

        // 1. Initial sync with no events
        await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);

        // 2. Incremental sync delivers an out-of-window explicit one-off at +75 days (single event)
        const outOfWindowIso = new Date(nowMs + 75 * 86400000).toISOString();
        api.deltaEvents = [
          {
            id: 'single_out_window_1',
            summary: 'Late Summer Summit',
            status: 'confirmed',
            start: { dateTime: outOfWindowIso },
            end: { dateTime: new Date(Date.parse(outOfWindowIso) + 3600000).toISOString() },
            organizer: { email: 'a@example.com' },
            attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
            recurrence: undefined, // single event
          },
        ];

        const res2 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(res2.added).toBe(1);
        expect((await engine.executeRaw(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`)).length).toBe(1);

        // 3. Fast-forward state timestamp by 25h so 24h sidecar rollover triggers
        const state = readGoogleState(testDir);
        state.calendar_last_window_sync_ms = Date.now() - 25 * 3600 * 1000;
        writeFileSync(googleStateFile(testDir), JSON.stringify(state, null, 2), 'utf-8');

        // Sidecar discovery pass window only returns in-window events (empty here)
        api.deltaEvents = [];
        api.events = [];

        // 4. Run sync again: sidecar runs, but MUST NOT perform absence-based deletion of the out-of-window event!
        const res3 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(res3.deleted).toBe(0);

        // Single out-of-window event remains preserved in storage!
        const remaining = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL`);
        expect(remaining.length).toBe(1);
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function captureStdout(fn: () => Promise<void>): Promise<string> {
    const orig = process.stdout.write;
    let out = '';
    process.stdout.write = ((chunk: any) => {
      out += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as any;
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    return out;
  }

  test('Durable 410 degradation marker is persisted in state and surfaced in google status', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gsrc-410-status-'));
    const api = makeFakeApi();

    try {
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, async () => {
        const cfg = parseGoogleSourceConfig({
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'calendar',
          g_dir: testDir,
        }, testDir);

        // Insert source into DB so `gbrain google status` can inspect linked sources
        await engine.executeRaw(
          `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
          ['gsrc', 'Google', testDir, JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_dir: testDir })],
        );

        // Initial sync banks token
        await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);
        expect(readGoogleState(testDir).calendar_degraded).toBeFalsy();

        // 1. Initial healthy status path: JSON & human text report connected and healthy
        const jsonOut1 = await captureStdout(() => runGoogleStatus(['--json', '--no-probe'], engine, vault));
        const parsed1 = JSON.parse(jsonOut1);
        expect(parsed1.status).toBe('connected');
        expect(parsed1.linked_sources[0].calendar_degraded).toBe(false);

        const textOut1 = await captureStdout(() => runGoogleStatus(['--no-probe'], engine, vault));
        expect(textOut1).toContain('Linked sources: gsrc\n');
        expect(textOut1).not.toContain('degraded');

        // Expire token (HTTP 410)
        api.expireSyncToken = true;
        const res2 = await runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true }, buildFetch(api), vault);

        // Status is partial and calendar_degraded is durably written to state file
        expect(res2.status).toBe('partial');
        expect(readGoogleState(testDir).calendar_degraded).toBe(true);

        // 2. HTTP 410 degraded status path: JSON & human text report degraded with 410 recovery reason
        const jsonOut2 = await captureStdout(() => runGoogleStatus(['--json', '--no-probe'], engine, vault));
        const parsed2 = JSON.parse(jsonOut2);
        expect(parsed2.status).toBe('degraded');
        expect(parsed2.linked_sources[0].calendar_degraded).toBe(true);

        const textOut2 = await captureStdout(() => runGoogleStatus(['--no-probe'], engine, vault));
        expect(textOut2).toContain('Linked sources: gsrc (degraded: calendar retained-store 410 recovery)');

        // 3. Read-state failure outcome (corrupt state file): must NOT silently report healthy
        writeFileSync(googleStateFile(testDir), 'corrupt-unparseable-json', 'utf-8');
        const jsonOut3 = await captureStdout(() => runGoogleStatus(['--json', '--no-probe'], engine, vault));
        const parsed3 = JSON.parse(jsonOut3);
        expect(parsed3.status).toBe('degraded');
        expect(parsed3.linked_sources[0].calendar_degraded).toBe(true);
        expect(parsed3.linked_sources[0].state_error).toContain('failed to read state');

        const textOut3 = await captureStdout(() => runGoogleStatus(['--no-probe'], engine, vault));
        expect(textOut3).toContain('gsrc (degraded: failed to read state:');

        // 4. Missing directory outcome: must NOT silently report healthy
        const missingDir = join(tmpdir(), `missing-gsrc-dir-${Date.now()}`);
        await engine.executeRaw(
          `UPDATE sources SET config = $1::text::jsonb WHERE id = 'gsrc'`,
          [JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_dir: missingDir })],
        );
        const jsonOut4 = await captureStdout(() => runGoogleStatus(['--json', '--no-probe'], engine, vault));
        const parsed4 = JSON.parse(jsonOut4);
        expect(parsed4.status).toBe('degraded');
        expect(parsed4.linked_sources[0].calendar_degraded).toBe(true);
        expect(parsed4.linked_sources[0].state_error).toContain('does not exist');

        const textOut4 = await captureStdout(() => runGoogleStatus(['--no-probe'], engine, vault));
        expect(textOut4).toContain('gsrc (degraded: source directory does not exist:');
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('Fall-back DST discovery: bootstrap buffered query returns final accepted hour and local gate admits it while rejecting extra beyond-horizon recurrence', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gsrc-dst-fallback-'));
    const api = makeFakeApi();
    const origDateNow = Date.now;
    const nowMs = Date.parse('2026-11-01T00:15:00-04:00'); // Sunday Nov 1 fall-back day at 00:15 EDT (04:15Z)

    try {
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, async () => {
        const cfg = parseGoogleSourceConfig({
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'calendar',
          g_dir: testDir,
          g_future_days: 1, // 1 future day horizon: Sunday Nov 1 + Monday Nov 2
        }, testDir);

        await engine.executeRaw(
          `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
          ['gsrc-dst', 'Google', testDir, JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_dir: testDir, g_future_days: 1 })],
        );

        // Event A: in-horizon recurring event at 23:30 on Monday Nov 2 (hour 48.25 after nowMs across fall-back)
        const eventA = {
          id: 'evt_monday_late',
          summary: 'Monday Late Sync',
          start: { dateTime: '2026-11-02T23:30:00-05:00' },
          end: { dateTime: '2026-11-02T23:55:00-05:00' },
          recurringEventId: 'weekly_recurrence',
          status: 'confirmed',
        };

        // Event B: beyond-horizon recurring event on Tuesday Nov 3 at 10:00 EST
        const eventB = {
          id: 'evt_tuesday_morning',
          summary: 'Tuesday Standup',
          start: { dateTime: '2026-11-03T10:00:00-05:00' },
          end: { dateTime: '2026-11-03T10:30:00-05:00' },
          recurringEventId: 'weekly_recurrence',
          status: 'confirmed',
        };

        api.events = [eventA, eventB];

        // Mock Date.now during sweep and keep token valid
        Date.now = () => nowMs;
        const cred = await vault.get('google:a@example.com');
        if (cred) {
          cred.secret.expiry = new Date(nowMs + 3600000).toISOString();
          await vault.put(cred);
        }

        const res = await runGoogleSync(engine, 'gsrc-dst', cfg, { sourceId: 'gsrc-dst', noEmbed: true, noExtract: true }, buildFetch(api), vault);

        // Verify the provider query used the buffered (N + 2) envelope
        const listCall = api.calls.find((c) => c.includes('/events?'));
        expect(listCall).toBeDefined();
        const callUrl = new URL(`https://example.com${listCall}`);
        const timeMaxParam = callUrl.searchParams.get('timeMax');
        expect(timeMaxParam).toBe('2026-11-04T04:15:00.000Z'); // nowMs + 72h

        // Proves fixed (N + 1) timeMax (2026-11-03T04:15:00.000Z) would have preceded Event A (2026-11-03T04:30:00.000Z)
        const fixedTimeMaxStr = new Date(nowMs + 2 * 86_400_000).toISOString();
        expect(fixedTimeMaxStr).toBe('2026-11-03T04:15:00.000Z');
        expect(Date.parse(eventA.start.dateTime)).toBeGreaterThan(Date.parse(fixedTimeMaxStr));

        // Event A was admitted and imported!
        const importedRows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE source_id = 'gsrc-dst' AND deleted_at IS NULL`,
        );
        expect(importedRows.length).toBe(1);
        expect(importedRows[0].slug).toContain('monday-late-sync');

        // Event B (beyond horizon recurrence returned in buffered query) was rejected by the local gate!
        const bRows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE source_id = 'gsrc-dst' AND slug LIKE '%tuesday-standup%'`,
        );
        expect(bRows.length).toBe(0);
      });
    } finally {
      Date.now = origDateNow;
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
