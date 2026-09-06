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
import { MAX_BACKFILL_BATCH_THREADS } from '../src/core/google/types.ts';
import { withEnv } from './helpers/with-env.ts';

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

// ── backfillBatchThreads ─────────────────────────────────────────────────────
//
// Gmail initial-backfill batch size: g_backfill_batch_threads (config) wins,
// then GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS (env), else the default (25),
// always clamped to [1, MAX_BACKFILL_BATCH_THREADS].

describe('parseGoogleSourceConfig — backfillBatchThreads', () => {
  test('defaults to 25 when unset (config and env both absent)', async () => {
    await withEnv({ GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS: undefined }, async () => {
      const cfg = parseGoogleSourceConfig({ ...base }, DIR);
      expect(cfg.backfillBatchThreads).toBe(25);
    });
  });

  test('an explicit in-range config value is used verbatim', () => {
    const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: 100 }, DIR);
    expect(cfg.backfillBatchThreads).toBe(100);
  });

  test('clamps a config value above the cap down to MAX_BACKFILL_BATCH_THREADS', () => {
    const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: 999999 }, DIR);
    expect(cfg.backfillBatchThreads).toBe(MAX_BACKFILL_BATCH_THREADS);
  });

  test('zero/negative config values fall back to the default, like historyDays does', () => {
    // Mirrors the existing historyDays precedent (g_history_days: -5 → 90,
    // not clamped up to 1): a non-positive value is treated as "unset",
    // not "clamp to the floor."
    for (const bad of [0, -5, -1]) {
      const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: bad }, DIR);
      expect(cfg.backfillBatchThreads).toBe(25);
    }
  });

  test('floors a fractional config value', () => {
    const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: 12.9 }, DIR);
    expect(cfg.backfillBatchThreads).toBe(12);
  });

  test('falls back to the default on a non-number/invalid config value', () => {
    for (const bad of ['50', null, undefined, {}, NaN, Infinity]) {
      const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: bad }, DIR);
      expect(cfg.backfillBatchThreads).toBe(25);
    }
  });

  test('GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS env var is used when config is unset', async () => {
    await withEnv({ GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS: '200' }, async () => {
      const cfg = parseGoogleSourceConfig({ ...base }, DIR);
      expect(cfg.backfillBatchThreads).toBe(200);
    });
  });

  test('the env var is clamped too', async () => {
    await withEnv({ GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS: '10000' }, async () => {
      const cfg = parseGoogleSourceConfig({ ...base }, DIR);
      expect(cfg.backfillBatchThreads).toBe(MAX_BACKFILL_BATCH_THREADS);
    });
  });

  test('an invalid env var falls back to the default (25), not a crash', async () => {
    await withEnv({ GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS: 'not-a-number' }, async () => {
      const cfg = parseGoogleSourceConfig({ ...base }, DIR);
      expect(cfg.backfillBatchThreads).toBe(25);
    });
  });

  test('explicit config wins over the env var (most-specific-wins precedence)', async () => {
    await withEnv({ GBRAIN_GOOGLE_BACKFILL_BATCH_THREADS: '200' }, async () => {
      const cfg = parseGoogleSourceConfig({ ...base, g_backfill_batch_threads: 50 }, DIR);
      expect(cfg.backfillBatchThreads).toBe(50);
    });
  });
});
