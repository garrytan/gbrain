/**
 * v0.36.0.0 (T13 / E7) — nudge cooldown + threshold tests.
 *
 * Hermetic. Mock engine + injected stderr stream. No production stderr writes.
 *
 * Tests cover:
 *  - threshold gates: no profile, wrong holder, below conviction, no domain match
 *  - happy match path: above conviction + bias tag matches domain hint
 *  - cooldown: same pattern fired in last 14 days → silently skip
 *  - cooldown: same pattern fired > 14 days ago → fire (cooldown expired)
 *  - takeDomainHint: companies → hiring, macro/geography/tactics keywords match
 *  - resetNudgeCooldown: deletes rows for the take
 *  - log insertion captures (source_id, take_id, pattern, channel='stderr')
 */

import { describe, test, expect } from 'bun:test';
import {
  evaluateAndFireNudge,
  evaluateNudgeRule,
  takeDomainHint,
  checkCooldown,
  resetNudgeCooldown,
  buildNudgeText,
  NUDGE_COOLDOWN_DAYS,
  NUDGE_CONVICTION_THRESHOLD,
} from '../src/core/calibration/nudge.ts';
import type { CalibrationProfileRow } from '../src/commands/calibration.ts';
import type { BrainEngine, Take } from '../src/core/engine.ts';

function buildTake(overrides: Partial<Take> = {}): Take {
  return {
    id: 1,
    page_id: 100,
    page_slug: 'wiki/companies/acme-example',
    row_num: 1,
    claim: 'Marketplaces with cold-start liquidity always win.',
    kind: 'bet',
    holder: 'garry',
    weight: 0.85,
    since_date: '2026-05-17',
    until_date: null,
    source: null,
    superseded_by: null,
    active: true,
    resolved_at: null,
    resolved_outcome: null,
    resolved_quality: null,
    resolved_value: null,
    resolved_unit: null,
    resolved_source: null,
    resolved_by: null,
    created_at: '2026-05-17T00:00:00Z',
    updated_at: '2026-05-17T00:00:00Z',
    ...overrides,
  } as Take;
}

function buildProfile(activeBiasTags: string[], holder = 'garry'): CalibrationProfileRow {
  return {
    id: 1,
    source_id: 'default',
    holder,
    wave_version: 'v0.36.0.0',
    generated_at: '2026-05-17T00:00:00Z',
    published: false,
    total_resolved: 20,
    brier: 0.21,
    accuracy: 0.6,
    partial_rate: 0.1,
    grade_completion: 1.0,
    pattern_statements: ['some pattern'],
    active_bias_tags: activeBiasTags,
    voice_gate_passed: true,
    voice_gate_attempts: 1,
    model_id: 'claude-sonnet-4-6',
  };
}

interface SqlCall {
  sql: string;
  params: unknown[];
}

function buildMockEngine(opts: {
  cooldownRows?: number; // 1 = active cooldown, 0 = no cooldown
  deleteReturning?: number; // count of rows DELETE...RETURNING simulates
}): { engine: BrainEngine; sqls: SqlCall[] } {
  const sqls: SqlCall[] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      sqls.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT id FROM take_nudge_log')) {
        return new Array(opts.cooldownRows ?? 0).fill({ id: 1 }) as unknown as T[];
      }
      if (sql.includes('DELETE FROM take_nudge_log')) {
        return new Array(opts.deleteReturning ?? 0).fill({ id: 1 }) as unknown as T[];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, sqls };
}

// ─── takeDomainHint ─────────────────────────────────────────────────

describe('takeDomainHint', () => {
  test('companies/ slug → hiring', () => {
    expect(takeDomainHint(buildTake({ page_slug: 'wiki/companies/acme' }))).toBe('hiring');
  });

  test('people/ slug → founder-behavior', () => {
    expect(takeDomainHint(buildTake({ page_slug: 'wiki/people/alice' }))).toBe('founder-behavior');
  });

  test('macro keyword → macro', () => {
    expect(takeDomainHint(buildTake({ page_slug: 'wiki/macro/forecast' }))).toBe('macro');
  });

  test('geography keyword → geography', () => {
    expect(takeDomainHint(buildTake({ page_slug: 'wiki/geography/ny' }))).toBe('geography');
  });

  test('unrecognized slug → empty hint', () => {
    expect(takeDomainHint(buildTake({ page_slug: 'wiki/random/x' }))).toBe('');
  });
});

// ─── evaluateNudgeRule (pure) ───────────────────────────────────────

describe('evaluateNudgeRule', () => {
  test('no profile → matched=false with reason=no_profile', () => {
    expect(evaluateNudgeRule(buildTake(), null)).toEqual({ matched: false, reason: 'no_profile' });
  });

  test('wrong holder → matched=false with reason=wrong_holder', () => {
    const profile = buildProfile(['over-confident-hiring'], 'alice');
    expect(evaluateNudgeRule(buildTake({ holder: 'garry' }), profile).reason).toBe('wrong_holder');
  });

  test('conviction at threshold → matched=false (strict >)', () => {
    const profile = buildProfile(['over-confident-hiring']);
    expect(
      evaluateNudgeRule(buildTake({ weight: NUDGE_CONVICTION_THRESHOLD }), profile).reason,
    ).toBe('below_conviction_threshold');
  });

  test('no matching bias tag → matched=false with reason=no_matching_bias_tag', () => {
    const profile = buildProfile(['late-on-macro-tech']);
    expect(
      evaluateNudgeRule(buildTake({ page_slug: 'wiki/companies/acme' }), profile).reason,
    ).toBe('no_matching_bias_tag');
  });

  test('happy match: companies slug + hiring tag', () => {
    const profile = buildProfile(['over-confident-hiring']);
    const out = evaluateNudgeRule(buildTake({ page_slug: 'wiki/companies/acme' }), profile);
    expect(out.matched).toBe(true);
    expect(out.matchedTag).toBe('over-confident-hiring');
  });

  test('first-match-wins when multiple tags could match the hint', () => {
    const profile = buildProfile([
      'over-confident-hiring',
      'late-on-hiring-cycles',
    ]);
    const out = evaluateNudgeRule(buildTake({ page_slug: 'wiki/companies/acme' }), profile);
    expect(out.matchedTag).toBe('over-confident-hiring');
  });
});

// ─── checkCooldown ──────────────────────────────────────────────────

describe('checkCooldown', () => {
  test('returns true when a recent row exists', async () => {
    const { engine } = buildMockEngine({ cooldownRows: 1 });
    expect(await checkCooldown(engine, 1, 'over-confident-hiring')).toBe(true);
  });

  test('returns false when no recent row', async () => {
    const { engine } = buildMockEngine({ cooldownRows: 0 });
    expect(await checkCooldown(engine, 1, 'over-confident-hiring')).toBe(false);
  });

  test('cutoff date param is NUDGE_COOLDOWN_DAYS ago', async () => {
    const { engine, sqls } = buildMockEngine({});
    await checkCooldown(engine, 1, 'tag');
    const cutoffISO = sqls[0]!.params[2] as string;
    const cutoff = new Date(cutoffISO).getTime();
    const expected = Date.now() - NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(1000); // within 1s
  });
});

// ─── evaluateAndFireNudge ───────────────────────────────────────────

describe('evaluateAndFireNudge', () => {
  test('happy path: matches + no cooldown → fires + writes log + returns text', async () => {
    const { engine, sqls } = buildMockEngine({ cooldownRows: 0 });
    const profile = buildProfile(['over-confident-hiring']);
    let stderrWrites = '';
    const stderr = { write: (s: string) => { stderrWrites += s; } };
    const out = await evaluateAndFireNudge({
      engine,
      take: buildTake({ page_slug: 'wiki/companies/acme' }),
      profile,
      sourceId: 'default',
      stderr,
    });
    expect(out.shouldFire).toBe(true);
    expect(out.matchedTag).toBe('over-confident-hiring');
    expect(stderrWrites).toContain('[gbrain]');
    expect(stderrWrites).toContain('over-confident-hiring');
    const insertCall = sqls.find(s => s.sql.includes('INSERT INTO take_nudge_log'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params).toEqual(['default', 1, 'over-confident-hiring', 'stderr']);
  });

  test('cooldown active → silently skips, no insert, no stderr', async () => {
    const { engine, sqls } = buildMockEngine({ cooldownRows: 1 });
    const profile = buildProfile(['over-confident-hiring']);
    let stderrWrites = '';
    const stderr = { write: (s: string) => { stderrWrites += s; } };
    const out = await evaluateAndFireNudge({
      engine,
      take: buildTake({ page_slug: 'wiki/companies/acme' }),
      profile,
      sourceId: 'default',
      stderr,
    });
    expect(out.shouldFire).toBe(false);
    expect(out.reason).toBe('cooldown_active');
    expect(stderrWrites).toBe('');
    expect(sqls.find(s => s.sql.includes('INSERT'))).toBeUndefined();
  });

  test('no profile → silently skips with reason=no_profile', async () => {
    const { engine } = buildMockEngine({});
    const out = await evaluateAndFireNudge({
      engine,
      take: buildTake(),
      profile: null,
      sourceId: 'default',
    });
    expect(out.shouldFire).toBe(false);
    expect(out.reason).toBe('no_profile');
  });

  test('below conviction threshold → silently skips', async () => {
    const { engine, sqls } = buildMockEngine({});
    const profile = buildProfile(['over-confident-hiring']);
    const out = await evaluateAndFireNudge({
      engine,
      take: buildTake({ weight: 0.6, page_slug: 'wiki/companies/acme' }),
      profile,
      sourceId: 'default',
    });
    expect(out.shouldFire).toBe(false);
    expect(out.reason).toBe('below_conviction_threshold');
    // No cooldown query, no INSERT — both gated above the cooldown probe.
    expect(sqls.find(s => s.sql.includes('SELECT id FROM take_nudge_log'))).toBeUndefined();
  });
});

// ─── buildNudgeText ─────────────────────────────────────────────────

describe('buildNudgeText', () => {
  test('contains the matched tag for hush command', () => {
    const out = buildNudgeText({ matchedTag: 'over-confident-geography', conviction: 0.85 });
    expect(out).toContain('over-confident-geography');
    expect(out).toContain('gbrain takes nudge --hush over-confident-geography');
  });

  test('contains the conviction value', () => {
    const out = buildNudgeText({ matchedTag: 'over-confident-hiring', conviction: 0.92 });
    expect(out).toContain('0.92');
  });
});

// ─── resetNudgeCooldown ─────────────────────────────────────────────

describe('resetNudgeCooldown', () => {
  test('deletes rows for the take; returns count', async () => {
    const { engine, sqls } = buildMockEngine({ deleteReturning: 3 });
    const out = await resetNudgeCooldown(engine, 42);
    expect(out.deleted).toBe(3);
    expect(sqls[0]!.sql).toContain('DELETE FROM take_nudge_log');
    expect(sqls[0]!.params).toEqual([42]);
  });

  test('returns 0 when no rows to delete (idempotent)', async () => {
    const { engine } = buildMockEngine({ deleteReturning: 0 });
    expect((await resetNudgeCooldown(engine, 99)).deleted).toBe(0);
  });
});
