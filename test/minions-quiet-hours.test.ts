/**
 * Quiet-hours + stagger tests — pure primitives + migration verification.
 *
 * Worker-loop integration (claim → release on quiet verdict) is covered by
 * the existing Minions resilience E2E when combined with this unit coverage:
 * the worker path only reads the evaluator result, and the evaluator is
 * exhaustively tested here.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';

import {
  evaluateQuietHours,
  localHour,
  type QuietHoursConfig,
} from '../src/core/minions/quiet-hours.ts';
import { staggerMinuteOffset, staggerSecondOffset } from '../src/core/minions/stagger.ts';

// ---------------------------------------------------------------------------
// Pure: evaluateQuietHours
// ---------------------------------------------------------------------------

describe('evaluateQuietHours', () => {
  const tz = 'UTC'; // deterministic across CI

  test('null config → allow', () => {
    expect(evaluateQuietHours(null)).toBe('allow');
  });

  test('undefined config → allow', () => {
    expect(evaluateQuietHours(undefined)).toBe('allow');
  });

  test('invalid config (out-of-range hour) → allow (fail-open)', () => {
    expect(evaluateQuietHours({ start: 99, end: 1, tz })).toBe('allow');
  });

  test('invalid config (zero-width) → allow', () => {
    expect(evaluateQuietHours({ start: 3, end: 3, tz })).toBe('allow');
  });

  test('invalid tz → allow (fail-open)', () => {
    expect(evaluateQuietHours({ start: 22, end: 6, tz: 'Not/A_Real_TZ' })).toBe('allow');
  });

  test('straight-line window: inside → defer by default', () => {
    // 02:00 UTC
    const when = new Date(Date.UTC(2026, 0, 1, 2, 0, 0));
    const cfg: QuietHoursConfig = { start: 1, end: 5, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('defer');
  });

  test('straight-line window: outside → allow', () => {
    const when = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const cfg: QuietHoursConfig = { start: 1, end: 5, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('allow');
  });

  test('straight-line window: end is exclusive', () => {
    const when = new Date(Date.UTC(2026, 0, 1, 5, 0, 0));
    const cfg: QuietHoursConfig = { start: 1, end: 5, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('allow');
  });

  test('wrap-around window: inside (after midnight) → defer', () => {
    // 01:00 UTC, window 22:00 - 07:00
    const when = new Date(Date.UTC(2026, 0, 1, 1, 0, 0));
    const cfg: QuietHoursConfig = { start: 22, end: 7, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('defer');
  });

  test('wrap-around window: inside (before midnight) → defer', () => {
    // 23:30 UTC, window 22:00 - 07:00
    const when = new Date(Date.UTC(2026, 0, 1, 23, 30, 0));
    const cfg: QuietHoursConfig = { start: 22, end: 7, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('defer');
  });

  test('wrap-around window: outside → allow', () => {
    // 10:00 UTC, window 22:00 - 07:00
    const when = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const cfg: QuietHoursConfig = { start: 22, end: 7, tz };
    expect(evaluateQuietHours(cfg, when)).toBe('allow');
  });

  test('policy "skip" returns skip verdict', () => {
    const when = new Date(Date.UTC(2026, 0, 1, 2, 0, 0));
    const cfg: QuietHoursConfig = { start: 1, end: 5, tz, policy: 'skip' };
    expect(evaluateQuietHours(cfg, when)).toBe('skip');
  });

  test('timezone difference changes window position', () => {
    // 14:00 UTC = 09:00 LA (PDT in summer). If the config is start:22 end:7 in LA,
    // 14:00 UTC is outside → allow.
    const when = new Date(Date.UTC(2026, 5, 15, 14, 0, 0)); // June → PDT
    const cfg: QuietHoursConfig = { start: 22, end: 7, tz: 'America/Los_Angeles' };
    expect(evaluateQuietHours(cfg, when)).toBe('allow');
  });

  test('timezone difference puts job inside window', () => {
    // 06:00 UTC = 22:00 prev day in LA (summer, PDT offset -7).
    // Wait — 06:00 UTC in June = 23:00 previous day LA (UTC-7).
    // Config start:22 end:7 → 23:00 is inside → defer.
    const when = new Date(Date.UTC(2026, 5, 15, 6, 0, 0));
    const cfg: QuietHoursConfig = { start: 22, end: 7, tz: 'America/Los_Angeles' };
    expect(evaluateQuietHours(cfg, when)).toBe('defer');
  });
});

describe('localHour', () => {
  test('UTC formatting matches Date.getUTCHours', () => {
    const when = new Date(Date.UTC(2026, 0, 1, 15, 30, 0));
    expect(localHour(when, 'UTC')).toBe(15);
  });

  test('invalid tz returns null', () => {
    expect(localHour(new Date(), 'Not/Real')).toBeNull();
  });

  test('LA timezone shifts hour correctly (winter PST = UTC-8)', () => {
    // Noon UTC in January = 04:00 LA
    const when = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(localHour(when, 'America/Los_Angeles')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Pure: staggerMinuteOffset
// ---------------------------------------------------------------------------

describe('staggerMinuteOffset', () => {
  test('empty or non-string → 0', () => {
    expect(staggerMinuteOffset('')).toBe(0);
    // @ts-expect-error: runtime guard
    expect(staggerMinuteOffset(null)).toBe(0);
  });

  test('returns 0–59', () => {
    for (const k of ['social-radar', 'x-ingest', 'perplexity', 'sync-all']) {
      const v = staggerMinuteOffset(k);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(60);
    }
  });

  test('deterministic: same key always same offset', () => {
    const a = staggerMinuteOffset('social-radar');
    const b = staggerMinuteOffset('social-radar');
    expect(a).toBe(b);
  });

  test('different keys produce different offsets (most of the time)', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const offsets = new Set(keys.map(staggerMinuteOffset));
    // With 10 distinct keys and 60 buckets, expect at least 5 unique
    // (collision rate stays well under 50% at this small sample size)
    expect(offsets.size).toBeGreaterThanOrEqual(5);
  });

  test('second offset is 60x minute offset', () => {
    const key = 'social-radar';
    expect(staggerSecondOffset(key)).toBe(staggerMinuteOffset(key) * 60);
  });
});

// ---------------------------------------------------------------------------
// Schema migration v12 applies
// ---------------------------------------------------------------------------

describe('schema migration v12 — minion_quiet_hours_stagger', () => {
  let engine: BrainEngine;
  let dbDir: string;

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'm12-'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbDir });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('minion_jobs has quiet_hours column', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'minion_jobs' AND column_name = 'quiet_hours'`,
    );
    expect(rows.length).toBe(1);
  });

  test('minion_jobs has stagger_key column', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'minion_jobs' AND column_name = 'stagger_key'`,
    );
    expect(rows.length).toBe(1);
  });

  test('stagger_key index exists', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'minion_jobs' AND indexname = 'idx_minion_jobs_stagger_key'`,
    );
    expect(rows.length).toBe(1);
  });
});
