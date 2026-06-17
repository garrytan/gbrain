/**
 * v0.29.1 — recency-decay map + buildRecencyComponentSql tests.
 *
 * Pure functions, no DB. Fast unit tests. Cover the full env / yaml / merge
 * resolution chain plus the SQL CASE shape (longest-prefix-match, evergreen
 * short-circuit, injection-safe NowExpr).
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_RECENCY_DECAY,
  DEFAULT_FALLBACK,
  RecencyDecayParseError,
  parseRecencyDecayEnv,
  parseRecencyDecayYaml,
  resolveRecencyDecayMap,
} from '../src/core/search/recency-decay.ts';
import { buildRecencyComponentSql } from '../src/core/search/sql-ranking.ts';

describe('parseRecencyDecayEnv', () => {
  test('empty / undefined → empty map', () => {
    expect(parseRecencyDecayEnv(undefined)).toEqual({});
    expect(parseRecencyDecayEnv('')).toEqual({});
  });

  test('single triple', () => {
    expect(parseRecencyDecayEnv('daily/:7:1.5')).toEqual({
      'daily/': { halflifeDays: 7, coefficient: 1.5 },
    });
  });

  test('multiple triples comma-separated', () => {
    const out = parseRecencyDecayEnv('daily/:7:1.5,concepts/:0:0,custom/:30:0.5');
    expect(out['daily/']).toEqual({ halflifeDays: 7, coefficient: 1.5 });
    expect(out['concepts/']).toEqual({ halflifeDays: 0, coefficient: 0 });
    expect(out['custom/']).toEqual({ halflifeDays: 30, coefficient: 0.5 });
  });

  test('throws on missing field', () => {
    expect(() => parseRecencyDecayEnv('daily/:7')).toThrow(RecencyDecayParseError);
    expect(() => parseRecencyDecayEnv('daily/')).toThrow(RecencyDecayParseError);
  });

  test('throws on negative halflife', () => {
    expect(() => parseRecencyDecayEnv('daily/:-1:1.5')).toThrow(RecencyDecayParseError);
  });

  test('throws on negative coefficient', () => {
    expect(() => parseRecencyDecayEnv('daily/:7:-0.1')).toThrow(RecencyDecayParseError);
  });

  test('throws on non-numeric values', () => {
    expect(() => parseRecencyDecayEnv('daily/:abc:1.5')).toThrow(RecencyDecayParseError);
  });

  test('throws on empty prefix', () => {
    expect(() => parseRecencyDecayEnv(':7:1.5')).toThrow(RecencyDecayParseError);
  });
});

describe('parseRecencyDecayYaml', () => {
  test('null / undefined / empty → empty map', () => {
    expect(parseRecencyDecayYaml(null)).toEqual({});
    expect(parseRecencyDecayYaml(undefined)).toEqual({});
    expect(parseRecencyDecayYaml({})).toEqual({});
  });

  test('valid recency block', () => {
    const out = parseRecencyDecayYaml({
      recency: {
        'daily/': { halflifeDays: 14, coefficient: 1.5 },
        'concepts/': { halflifeDays: 0, coefficient: 0 },
      },
    });
    expect(out['daily/']).toEqual({ halflifeDays: 14, coefficient: 1.5 });
    expect(out['concepts/']).toEqual({ halflifeDays: 0, coefficient: 0 });
  });

  test('throws on bad halflifeDays', () => {
    expect(() =>
      parseRecencyDecayYaml({ recency: { 'daily/': { halflifeDays: -1, coefficient: 1.0 } } }),
    ).toThrow(RecencyDecayParseError);
  });

  test('throws on non-object entry', () => {
    expect(() =>
      parseRecencyDecayYaml({ recency: { 'daily/': 'invalid' } }),
    ).toThrow(RecencyDecayParseError);
  });
});

describe('resolveRecencyDecayMap merge precedence', () => {
  test('defaults baseline', () => {
    const m = resolveRecencyDecayMap({});
    expect(m['concepts/']).toEqual({ halflifeDays: 0, coefficient: 0 });
    expect(m['daily/']).toEqual({ halflifeDays: 14, coefficient: 1.5 });
  });

  test('env overrides defaults', () => {
    const m = resolveRecencyDecayMap({ envValue: 'daily/:30:0.5' });
    expect(m['daily/']).toEqual({ halflifeDays: 30, coefficient: 0.5 });
  });

  test('yaml + env: env wins', () => {
    const m = resolveRecencyDecayMap({
      yaml: { recency: { 'daily/': { halflifeDays: 7, coefficient: 2.0 } } },
      envValue: 'daily/:30:0.5',
    });
    expect(m['daily/']).toEqual({ halflifeDays: 30, coefficient: 0.5 });
  });

  test('caller wins over env', () => {
    const m = resolveRecencyDecayMap({
      envValue: 'daily/:30:0.5',
      caller: { 'daily/': { halflifeDays: 1, coefficient: 5.0 } },
    });
    expect(m['daily/']).toEqual({ halflifeDays: 1, coefficient: 5.0 });
  });
});

describe('buildRecencyComponentSql', () => {
  const mini = {
    'concepts/': { halflifeDays: 0, coefficient: 0 },
    'daily/':    { halflifeDays: 14, coefficient: 1.5 },
    'media/':    { halflifeDays: 90, coefficient: 0.5 },
  };

  test('emits CASE expression with longest-prefix-first ordering', () => {
    const longerFirst = {
      'media/articles/': { halflifeDays: 60, coefficient: 0.5 },
      'media/':          { halflifeDays: 90, coefficient: 0.4 },
    };
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: longerFirst,
      fallback: DEFAULT_FALLBACK,
    });
    const idxLong = sql.indexOf("'media/articles/%'");
    const idxShort = sql.indexOf("'media/%'");
    expect(idxLong).toBeGreaterThan(0);
    expect(idxShort).toBeGreaterThan(0);
    expect(idxLong).toBeLessThan(idxShort);
  });

  test('evergreen short-circuit emits literal 0', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: mini,
      fallback: DEFAULT_FALLBACK,
    });
    expect(sql).toContain("WHEN p.slug LIKE 'concepts/%' THEN 0");
  });

  test('non-zero branches include EXTRACT(EPOCH ...)', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: mini,
      fallback: DEFAULT_FALLBACK,
    });
    expect(sql).toContain('EXTRACT(EPOCH FROM (NOW() - p.updated_at)) / 86400.0');
    expect(sql).toContain('1.5 * 14.0 / (14.0 + EXTRACT(EPOCH');
  });

  test('NowExpr.fixed is escaped (single-quote doubling) and timestamptz-cast', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: { 'daily/': { halflifeDays: 7, coefficient: 1.0 } },
      fallback: DEFAULT_FALLBACK,
      now: { kind: 'fixed', isoUtc: "2026-05-04T00:00:00Z" },
    });
    expect(sql).toContain("'2026-05-04T00:00:00Z'::timestamptz");
    expect(sql).not.toContain('NOW()');
  });

  test('NowExpr.fixed with embedded single quote is doubled (injection defense)', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: { 'daily/': { halflifeDays: 7, coefficient: 1.0 } },
      fallback: DEFAULT_FALLBACK,
      now: { kind: 'fixed', isoUtc: "2026'; DROP TABLE pages;--" },
    });
    // The malicious quote must be doubled to ''.
    expect(sql).toContain("''");
    expect(sql).not.toContain("DROP TABLE'");
  });

  test('empty decayMap → only fallback ELSE branch', () => {
    const sql = buildRecencyComponentSql({
      slugColumn: 'p.slug',
      dateExpr: 'p.updated_at',
      decayMap: {},
      fallback: { halflifeDays: 30, coefficient: 1.0 },
    });
    expect(sql).not.toContain('CASE');
    expect(sql).toContain('1 * 30.0 / (30.0 +');
  });
});

describe('DEFAULT_RECENCY_DECAY composition', () => {
  test('does not contain fork-specific names (no openclaw/, no wintermute/)', () => {
    const keys = Object.keys(DEFAULT_RECENCY_DECAY);
    for (const k of keys) {
      expect(k.includes('openclaw')).toBe(false);
      expect(k.includes('wintermute')).toBe(false);
    }
  });

  test('concepts/ is evergreen (halflifeDays = 0)', () => {
    expect(DEFAULT_RECENCY_DECAY['concepts/']?.halflifeDays).toBe(0);
  });

  test('daily/ has aggressive decay', () => {
    expect(DEFAULT_RECENCY_DECAY['daily/']?.halflifeDays).toBeLessThan(30);
    expect(DEFAULT_RECENCY_DECAY['daily/']?.coefficient).toBeGreaterThan(1);
  });
});
