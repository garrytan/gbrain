/**
 * v0.36.1.0 (T17 / D18 CDX-3) — undo-wave reversal tests.
 *
 * Hermetic. Mock engine wired to return canned row sets for each step.
 *
 * Tests cover:
 *  - dry-run: counts without writing
 *  - happy path: all 4 steps execute + return counts
 *  - resolved_by filter: only this wave's auto-grade is reverted; manual
 *    resolutions are NOT touched
 *  - empty wave: zero counts when no matching rows
 *  - take_grade_cache audit marked applied=false post-undo
 *  - gstack scrub: attempted only when --scrub-gstack passed
 */

import { describe, test, expect } from 'bun:test';
import { undoWave } from '../src/core/calibration/undo-wave.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface MockEngineState {
  // SELECT distinct take_id results
  targetTakeIds: number[];
  // takes UPDATE...RETURNING ids
  revertedTakes: number[];
  // dry-run counts
  resolutionCount: number;
  gradeCacheCount: number;
  profilesCount: number;
  nudgesCount: number;
  // non-dry-run RETURNING shapes
  gradeCacheRows: number[];
  profilesRows: number[];
  nudgesRows: number[];
}

interface SqlCall { sql: string; params: unknown[] }

function buildMockEngine(state: Partial<MockEngineState>): { engine: BrainEngine; sqls: SqlCall[] } {
  const sqls: SqlCall[] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      sqls.push({ sql, params: params ?? [] });
      // SELECT distinct take_id
      if (sql.includes('SELECT DISTINCT take_id FROM take_grade_cache')) {
        return (state.targetTakeIds ?? []).map(id => ({ take_id: id })) as unknown as T[];
      }
      // dry-run count: takes
      if (sql.includes('FROM takes') && sql.includes('COUNT(*)')) {
        return [{ count: state.resolutionCount ?? 0 } as unknown as T];
      }
      // UPDATE takes... RETURNING
      if (sql.includes('UPDATE takes')) {
        return (state.revertedTakes ?? []).map(id => ({ id })) as unknown as T[];
      }
      // dry-run count: take_grade_cache
      if (sql.includes('FROM take_grade_cache') && sql.includes('COUNT(*)')) {
        return [{ count: state.gradeCacheCount ?? 0 } as unknown as T];
      }
      // UPDATE take_grade_cache
      if (sql.includes('UPDATE take_grade_cache')) {
        return (state.gradeCacheRows ?? []).map(take_id => ({ take_id })) as unknown as T[];
      }
      // dry-run count: calibration_profiles
      if (sql.includes('FROM calibration_profiles') && sql.includes('COUNT(*)')) {
        return [{ count: state.profilesCount ?? 0 } as unknown as T];
      }
      // DELETE calibration_profiles RETURNING
      if (sql.includes('DELETE FROM calibration_profiles')) {
        return (state.profilesRows ?? []).map(id => ({ id })) as unknown as T[];
      }
      // dry-run count: take_nudge_log
      if (sql.includes('FROM take_nudge_log') && sql.includes('COUNT(*)')) {
        return [{ count: state.nudgesCount ?? 0 } as unknown as T];
      }
      // DELETE take_nudge_log RETURNING
      if (sql.includes('DELETE FROM take_nudge_log')) {
        return (state.nudgesRows ?? []).map(id => ({ id })) as unknown as T[];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, sqls };
}

describe('undoWave — dry-run posture', () => {
  test('dryRun=true returns counts without UPDATE/DELETE', async () => {
    const { engine, sqls } = buildMockEngine({
      targetTakeIds: [1, 2, 3],
      resolutionCount: 2,
      gradeCacheCount: 3,
      profilesCount: 1,
      nudgesCount: 8,
    });
    const out = await undoWave(engine, { waveVersion: 'v0.36.1.0', dryRun: true });
    expect(out.dry_run).toBe(true);
    expect(out.resolutions_reverted).toBe(2);
    expect(out.grade_cache_unapplied).toBe(3);
    expect(out.profiles_deleted).toBe(1);
    expect(out.nudges_purged).toBe(8);
    // NO UPDATE/DELETE SQL emitted on dry-run.
    expect(sqls.find(s => s.sql.includes('UPDATE takes'))).toBeUndefined();
    expect(sqls.find(s => s.sql.includes('DELETE FROM'))).toBeUndefined();
    expect(sqls.find(s => s.sql.includes('UPDATE take_grade_cache'))).toBeUndefined();
  });
});

describe('undoWave — happy path', () => {
  test('all 4 steps execute + return counts', async () => {
    const { engine, sqls } = buildMockEngine({
      targetTakeIds: [10, 11, 12],
      revertedTakes: [10, 11], // 12 was overridden by a manual resolve, skipped
      gradeCacheRows: [10, 11, 12],
      profilesRows: [101],
      nudgesRows: [201, 202, 203, 204],
    });
    const out = await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    expect(out.dry_run).toBe(false);
    expect(out.resolutions_reverted).toBe(2);
    expect(out.grade_cache_unapplied).toBe(3);
    expect(out.profiles_deleted).toBe(1);
    expect(out.nudges_purged).toBe(4);
    expect(out.gstack_scrub_attempted).toBe(false); // not opted in
    // Verify wave_version parameter threaded everywhere.
    const insertWaveParams = sqls.filter(s => Array.isArray(s.params) && (s.params as unknown[])[0] === 'v0.36.1.0');
    expect(insertWaveParams.length).toBeGreaterThan(2);
  });

  test('resolved_by filter: UPDATE takes scoped to wave-applied resolutions only', async () => {
    const { engine, sqls } = buildMockEngine({
      targetTakeIds: [1, 2],
      revertedTakes: [1, 2],
    });
    await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    const updateCall = sqls.find(s => s.sql.includes('UPDATE takes'));
    expect(updateCall).toBeDefined();
    // resolved_by parameter is $2 = 'gbrain:grade_takes' (default label)
    expect(updateCall!.params[1]).toBe('gbrain:grade_takes');
  });

  test('custom resolvedByLabel is honored', async () => {
    const { engine, sqls } = buildMockEngine({
      targetTakeIds: [1],
      revertedTakes: [1],
    });
    await undoWave(engine, { waveVersion: 'v0.36.1.0', resolvedByLabel: 'gbrain:grade_takes-custom' });
    const updateCall = sqls.find(s => s.sql.includes('UPDATE takes'));
    expect(updateCall!.params[1]).toBe('gbrain:grade_takes-custom');
  });
});

describe('undoWave — empty wave', () => {
  test('zero counts when no matching rows', async () => {
    const { engine } = buildMockEngine({
      targetTakeIds: [],
      revertedTakes: [],
      gradeCacheRows: [],
      profilesRows: [],
      nudgesRows: [],
    });
    const out = await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    expect(out.resolutions_reverted).toBe(0);
    expect(out.grade_cache_unapplied).toBe(0);
    expect(out.profiles_deleted).toBe(0);
    expect(out.nudges_purged).toBe(0);
  });

  test('idempotent: re-running undo finds nothing', async () => {
    const { engine } = buildMockEngine({});
    const out1 = await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    const out2 = await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    expect(out1.resolutions_reverted).toBe(0);
    expect(out2.resolutions_reverted).toBe(0);
  });
});

describe('undoWave — wave_version parameter is threaded through all queries', () => {
  test('queries use the supplied wave version', async () => {
    const { engine, sqls } = buildMockEngine({});
    await undoWave(engine, { waveVersion: 'v0.36.1.0' });
    const waveVersionUsedAsParam0 = sqls.filter(s => s.params[0] === 'v0.36.1.0').length;
    expect(waveVersionUsedAsParam0).toBeGreaterThanOrEqual(3);
  });

  test('different wave versions DO NOT collide', async () => {
    const { engine, sqls } = buildMockEngine({});
    await undoWave(engine, { waveVersion: 'v0.37.0.0' });
    expect(sqls.find(s => s.params[0] === 'v0.37.0.0')).toBeDefined();
    expect(sqls.find(s => s.params[0] === 'v0.36.1.0')).toBeUndefined();
  });
});
