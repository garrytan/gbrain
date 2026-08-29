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
