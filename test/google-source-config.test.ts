/**
 * google-source-config — pure parsing of a google source's stored config.
 *
 * No engine, no vault, no network: parseGoogleSourceConfig is a total function
 * over the config JSON, and the defaults it picks decide what a sweep actually
 * reads. The calendar cases matter because an unset g_calendar_id must keep
 * sweeping `primary` — that is the pre-existing behavior every already-running
 * source depends on.
 *
 * Synthetic data only: example.com addresses, fake calendar ids.
 */
import { describe, expect, test } from 'bun:test';

import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { CALENDAR_HORIZON_DAYS, CalendarSyncWindow } from '../src/core/google/calendar-window.ts';

const DIR = '/tmp/gbrain-test-google-dir';
const base = { kind: 'google', g_account: 'A@Example.com', g_services: 'calendar' };

describe('parseGoogleSourceConfig — calendar selection', () => {
  test('defaults to primary when g_calendar_id is absent', () => {
    const cfg = parseGoogleSourceConfig({ ...base }, DIR);
    expect(cfg.calendarId).toBe('primary');
  });

  test('carries a secondary calendar id through verbatim', () => {
    const id = 'family0123456789@group.calendar.google.com';
    const cfg = parseGoogleSourceConfig({ ...base, g_calendar_id: id }, DIR);
    expect(cfg.calendarId).toBe(id);
  });

  test('trims surrounding whitespace on the id', () => {
    const cfg = parseGoogleSourceConfig(
      { ...base, g_calendar_id: '  sub@import.calendar.google.com  ' },
      DIR,
    );
    expect(cfg.calendarId).toBe('sub@import.calendar.google.com');
  });

  test('falls back to primary on empty, whitespace, or non-string ids', () => {
    for (const bad of ['', '   ', 42, null, undefined, {}]) {
      const cfg = parseGoogleSourceConfig({ ...base, g_calendar_id: bad }, DIR);
      expect(cfg.calendarId).toBe('primary');
    }
  });

  test('calendar selection does not disturb the other parsed fields', () => {
    const cfg = parseGoogleSourceConfig(
      { ...base, g_calendar_id: 'x@group.calendar.google.com', g_history_days: 30 },
      DIR,
    );
    expect(cfg.account).toBe('a@example.com'); // lowercased
    expect(cfg.services).toEqual(['calendar']);
    expect(cfg.historyDays).toBe(30);
    expect(cfg.dir).toBe(DIR);
    expect(cfg.access).toBe('vault');
  });
});

describe('parseGoogleSourceConfig — g_future_days (#5442)', () => {
  test('is absent by default (existing sources keep their connector identity) and the window then reaches 60 days ahead', () => {
    const cfg = parseGoogleSourceConfig({ ...base }, DIR);
    expect(cfg.futureDays).toBeUndefined();
    expect(new CalendarSyncWindow(0, 1, cfg.futureDays ?? CALENDAR_HORIZON_DAYS).ceilMs).toBe(60 * 86_400_000);
  });

  test('accepts 1..3650 whole days and floors fractions', () => {
    expect(parseGoogleSourceConfig({ ...base, g_future_days: 1 }, DIR).futureDays).toBe(1);
    expect(parseGoogleSourceConfig({ ...base, g_future_days: 180.9 }, DIR).futureDays).toBe(180);
    expect(parseGoogleSourceConfig({ ...base, g_future_days: 3650 }, DIR).futureDays).toBe(3650);
  });

  test('ignores zero, negative, too large, NaN or non-numeric values (the default horizon applies)', () => {
    for (const bad of [0, -5, 5000, Number.NaN, '90', null, undefined, {}]) {
      expect(parseGoogleSourceConfig({ ...base, g_future_days: bad }, DIR).futureDays).toBeUndefined();
    }
  });
});
