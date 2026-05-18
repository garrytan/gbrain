/**
 * v0.36.1.0 (T18 / D19) — A/B harness tests.
 *
 * Hermetic. Mock engine + injected thinkRunner + injected preferenceResolver.
 * No real LLM, no DB.
 *
 * Tests cover:
 *  - runAbTrial: calls thinkRunner TWICE (baseline + with-calibration)
 *  - row INSERT params match the supplied data
 *  - preferenceResolver receives both answers
 *  - buildAbReport: aggregates counts by preferred value
 *  - calibration_net_negative trigger: n >= 20, win rate < 45%
 *  - calibration_net_negative does NOT trigger when n < 20 (small-sample guard)
 *  - formatAbReport: zero-trials branch, decisive-trials breakdown
 */

import { describe, test, expect } from 'bun:test';
import {
  runAbTrial,
  buildAbReport,
  formatAbReport,
} from '../src/core/calibration/think-ab.ts';
import type { BrainEngine } from '../src/core/engine.ts';

interface SqlCall { sql: string; params: unknown[] }

function buildMockEngine(opts: {
  insertReturning?: { id: number };
  reportRows?: Array<{ preferred: string; count: number }>;
}): { engine: BrainEngine; sqls: SqlCall[] } {
  const sqls: SqlCall[] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      sqls.push({ sql, params: params ?? [] });
      if (sql.includes('INSERT INTO think_ab_results')) {
        return [opts.insertReturning ?? { id: 1 }] as unknown as T[];
      }
      if (sql.includes('FROM think_ab_results')) {
        return (opts.reportRows ?? []) as unknown as T[];
      }
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, sqls };
}

// ─── runAbTrial ─────────────────────────────────────────────────────

describe('runAbTrial', () => {
  test('calls thinkRunner TWICE (baseline + with-calibration)', async () => {
    const { engine } = buildMockEngine({ insertReturning: { id: 42 } });
    let calls = 0;
    let withCalibrationCalls = 0;
    const thinkRunner = async (opts: { question: string; withCalibration: boolean }) => {
      calls++;
      if (opts.withCalibration) withCalibrationCalls++;
      return { answer: `answer ${calls}`, modelUsed: 'claude-sonnet-4-6' };
    };
    const preferenceResolver = async () => 'with_calibration' as const;
    const result = await runAbTrial({
      question: 'should we hire fast in NY?',
      engine,
      sourceId: 'default',
      thinkRunner,
      preferenceResolver,
    });
    expect(calls).toBe(2);
    expect(withCalibrationCalls).toBe(1);
    expect(result.preferred).toBe('with_calibration');
    expect(result.rowId).toBe(42);
  });

  test('preferenceResolver receives both answers as opts', async () => {
    const { engine } = buildMockEngine({});
    let received: { baseline: string; withCalibration: string } | undefined;
    const thinkRunner = async (opts: { withCalibration: boolean }) => ({
      answer: opts.withCalibration ? 'CAL_ANS' : 'BASE_ANS',
    });
    const preferenceResolver = async (input: { baseline: string; withCalibration: string }) => {
      received = input;
      return 'tie' as const;
    };
    await runAbTrial({
      question: 'q',
      engine,
      sourceId: 'default',
      thinkRunner,
      preferenceResolver,
    });
    expect(received).toEqual({ baseline: 'BASE_ANS', withCalibration: 'CAL_ANS' });
  });

  test('INSERT row carries question + both answers + preferred', async () => {
    const { engine, sqls } = buildMockEngine({});
    const thinkRunner = async (opts: { withCalibration: boolean }) => ({
      answer: opts.withCalibration ? 'with' : 'base',
    });
    const preferenceResolver = async () => 'baseline' as const;
    await runAbTrial({
      question: 'q1',
      engine,
      sourceId: 'tenant-a',
      thinkRunner,
      preferenceResolver,
      notes: 'first trial',
    });
    const insert = sqls.find(s => s.sql.includes('INSERT INTO think_ab_results'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('tenant-a');
    expect(insert!.params[1]).toBe('q1');
    expect(insert!.params[2]).toBe('base');
    expect(insert!.params[3]).toBe('with');
    expect(insert!.params[4]).toBe('baseline');
    expect(insert!.params[6]).toBe('first trial');
  });

  test('throws when thinkRunner not provided', async () => {
    const { engine } = buildMockEngine({});
    try {
      await runAbTrial({
        question: 'q',
        engine,
        sourceId: 'default',
        preferenceResolver: async () => 'tie' as const,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('thinkRunner');
    }
  });
});

// ─── buildAbReport ──────────────────────────────────────────────────

describe('buildAbReport', () => {
  test('zero trials → all counts 0, win rate null', async () => {
    const { engine } = buildMockEngine({ reportRows: [] });
    const report = await buildAbReport(engine);
    expect(report.total_trials).toBe(0);
    expect(report.baseline_wins).toBe(0);
    expect(report.with_calibration_wins).toBe(0);
    expect(report.with_calibration_win_rate).toBeNull();
    expect(report.net_negative).toBe(false);
  });

  test('aggregates counts by preferred value', async () => {
    const { engine } = buildMockEngine({
      reportRows: [
        { preferred: 'baseline', count: 6 },
        { preferred: 'with_calibration', count: 10 },
        { preferred: 'tie', count: 2 },
        { preferred: 'neither', count: 1 },
      ],
    });
    const report = await buildAbReport(engine);
    expect(report.total_trials).toBe(19);
    expect(report.baseline_wins).toBe(6);
    expect(report.with_calibration_wins).toBe(10);
    expect(report.ties).toBe(2);
    expect(report.neither).toBe(1);
    // win rate = with_calibration / decisive = 10 / (6+10) = 0.625
    expect(report.with_calibration_win_rate).toBeCloseTo(0.625, 5);
  });

  test('calibration_net_negative trigger: n >= 20 + win rate < 45%', async () => {
    const { engine } = buildMockEngine({
      reportRows: [
        { preferred: 'baseline', count: 14 },
        { preferred: 'with_calibration', count: 8 },
      ],
    });
    const report = await buildAbReport(engine);
    expect(report.decisive_trials).toBe(22);
    // win rate = 8/22 ≈ 0.36
    expect(report.net_negative).toBe(true);
  });

  test('calibration_net_negative does NOT trigger when n < 20 (small-sample guard)', async () => {
    const { engine } = buildMockEngine({
      reportRows: [
        { preferred: 'baseline', count: 9 },
        { preferred: 'with_calibration', count: 3 },
      ],
    });
    const report = await buildAbReport(engine);
    expect(report.decisive_trials).toBe(12);
    expect(report.net_negative).toBe(false);
  });

  test('calibration_net_negative does NOT trigger at exactly 45% win rate', async () => {
    const { engine } = buildMockEngine({
      reportRows: [
        { preferred: 'baseline', count: 11 },
        { preferred: 'with_calibration', count: 9 },
      ],
    });
    const report = await buildAbReport(engine);
    // win rate = 9/20 = 0.45 — boundary; NOT < 0.45
    expect(report.net_negative).toBe(false);
  });
});

// ─── formatAbReport ─────────────────────────────────────────────────

describe('formatAbReport', () => {
  test('zero trials → friendly empty-state message', () => {
    const out = formatAbReport({
      total_trials: 0,
      baseline_wins: 0,
      with_calibration_wins: 0,
      ties: 0,
      neither: 0,
      with_calibration_win_rate: null,
      net_negative: false,
      decisive_trials: 0,
    }, 30);
    expect(out).toContain('No data yet');
    expect(out).toContain('gbrain think --ab');
  });

  test('decisive-trials breakdown', () => {
    const out = formatAbReport({
      total_trials: 22,
      baseline_wins: 8,
      with_calibration_wins: 12,
      ties: 1,
      neither: 1,
      with_calibration_win_rate: 0.6,
      net_negative: false,
      decisive_trials: 20,
    }, 30);
    expect(out).toContain('Total trials: 22');
    expect(out).toContain('Baseline wins:');
    expect(out).toContain('60.0%');
    expect(out).toContain('n=20');
  });

  test('net_negative true → calibration_net_negative warning block', () => {
    const out = formatAbReport({
      total_trials: 22,
      baseline_wins: 14,
      with_calibration_wins: 8,
      ties: 0,
      neither: 0,
      with_calibration_win_rate: 0.36,
      net_negative: true,
      decisive_trials: 22,
    }, 30);
    expect(out).toContain('calibration_net_negative');
  });
});
