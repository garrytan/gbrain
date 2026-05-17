/**
 * v0.36.0.0 (T7) — gbrain calibration CLI + get_calibration_profile MCP op tests.
 *
 * Hermetic. Mock engine + injected args.
 */

import { describe, test, expect } from 'bun:test';
import {
  getLatestProfile,
  getCalibrationProfileOp,
  formatProfileText,
  __testing,
  type CalibrationProfileRow,
} from '../src/commands/calibration.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { GBrainError } from '../src/core/types.ts';

const { parseArgs } = __testing;

function buildMockEngine(opts: { rows: CalibrationProfileRow[] }): {
  engine: BrainEngine;
  capturedSql: string[];
  capturedParams: unknown[][];
} {
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const engine = {
    kind: 'pglite',
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      capturedSql.push(sql);
      capturedParams.push(params ?? []);
      // SELECT first row matching holder + optional source filter
      const holder = (params ?? [])[0];
      const matching = opts.rows.filter(r => r.holder === holder);
      if ((params ?? []).length > 1) {
        const p2 = (params ?? [])[1];
        if (Array.isArray(p2)) {
          return matching.filter(r => (p2 as string[]).includes(r.source_id)) as unknown as T[];
        }
        return matching.filter(r => r.source_id === p2) as unknown as T[];
      }
      return matching as unknown as T[];
    },
  } as unknown as BrainEngine;
  return { engine, capturedSql, capturedParams };
}

function buildCtx(engine: BrainEngine, opts: { sourceId?: string; allowedSources?: string[] } = {}): OperationContext {
  const ctx: OperationContext = {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: opts.sourceId ?? 'default',
  };
  if (opts.allowedSources) ctx.auth = { allowedSources: opts.allowedSources } as never;
  return ctx;
}

function buildProfile(opts: Partial<CalibrationProfileRow> & { holder: string }): CalibrationProfileRow {
  return {
    id: 1,
    source_id: opts.source_id ?? 'default',
    holder: opts.holder,
    wave_version: 'v0.36.0.0',
    generated_at: '2026-05-17T15:00:00Z',
    published: opts.published ?? false,
    total_resolved: opts.total_resolved ?? 12,
    brier: opts.brier ?? 0.21,
    accuracy: opts.accuracy ?? 0.6,
    partial_rate: opts.partial_rate ?? 0.1,
    grade_completion: opts.grade_completion ?? 1.0,
    pattern_statements: opts.pattern_statements ?? ['You called early-stage tactics well — 8 of 10 held up.'],
    active_bias_tags: opts.active_bias_tags ?? ['over-confident-geography'],
    voice_gate_passed: opts.voice_gate_passed ?? true,
    voice_gate_attempts: opts.voice_gate_attempts ?? 1,
    model_id: 'claude-sonnet-4-6',
  };
}

// ─── parseArgs ──────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('empty args: defaults applied (no holder, no flags)', () => {
    expect(parseArgs([])).toEqual({ sub: undefined, opts: {} });
  });

  test('--holder <id>', () => {
    expect(parseArgs(['--holder', 'people/charlie-example']).opts.holder).toBe('people/charlie-example');
  });

  test('--json flag', () => {
    expect(parseArgs(['--json']).opts.json).toBe(true);
  });

  test('--regenerate flag', () => {
    expect(parseArgs(['--regenerate']).opts.regenerate).toBe(true);
  });

  test('--undo-wave <version>', () => {
    expect(parseArgs(['--undo-wave', 'v0.36.0.0']).opts.undoWave).toBe('v0.36.0.0');
  });

  test('ab-report subcommand', () => {
    expect(parseArgs(['ab-report']).opts.abReport).toBe(true);
  });
});

// ─── getLatestProfile ───────────────────────────────────────────────

describe('getLatestProfile', () => {
  test('returns the row when holder matches', async () => {
    const { engine } = buildMockEngine({ rows: [buildProfile({ holder: 'garry' })] });
    const profile = await getLatestProfile(engine, { holder: 'garry', sourceId: 'default' });
    expect(profile).not.toBeNull();
    expect(profile!.holder).toBe('garry');
  });

  test('returns null when no profile exists', async () => {
    const { engine } = buildMockEngine({ rows: [] });
    const profile = await getLatestProfile(engine, { holder: 'unknown', sourceId: 'default' });
    expect(profile).toBeNull();
  });

  test('source-scoped query: scalar sourceId filters to that source', async () => {
    const rows = [
      buildProfile({ holder: 'garry', source_id: 'default' }),
      buildProfile({ holder: 'garry', source_id: 'tenant-b' }),
    ];
    const { engine } = buildMockEngine({ rows });
    const profile = await getLatestProfile(engine, { holder: 'garry', sourceId: 'tenant-b' });
    expect(profile!.source_id).toBe('tenant-b');
  });

  test('federated array filters to any of the listed sources', async () => {
    const rows = [
      buildProfile({ holder: 'garry', source_id: 'tenant-a' }),
      buildProfile({ holder: 'garry', source_id: 'tenant-c' }),
    ];
    const { engine, capturedSql, capturedParams } = buildMockEngine({ rows });
    await getLatestProfile(engine, { holder: 'garry', sourceIds: ['tenant-a', 'tenant-b'] });
    expect(capturedSql[0]).toContain('= ANY($2::text[])');
    expect(capturedParams[0]![1]).toEqual(['tenant-a', 'tenant-b']);
  });

  test('no source filter when neither sourceId nor sourceIds is passed', async () => {
    const { engine, capturedSql } = buildMockEngine({ rows: [] });
    await getLatestProfile(engine, { holder: 'garry' });
    // SELECT clause names the column but WHERE clause omits source_id filter.
    expect(capturedSql[0]).not.toContain('AND source_id');
  });
});

// ─── formatProfileText ──────────────────────────────────────────────

describe('formatProfileText', () => {
  test('null profile prints helpful cold-brain message', () => {
    const out = formatProfileText(null, 'garry');
    expect(out).toContain('No calibration profile yet');
    expect(out).toContain('gbrain dream --phase calibration_profile');
  });

  test('happy profile prints Brier + accuracy + patterns + bias tags', () => {
    const p = buildProfile({ holder: 'garry' });
    const out = formatProfileText(p, 'garry');
    expect(out).toContain('holder: garry');
    expect(out).toContain('Brier:');
    expect(out).toContain('Pattern statements:');
    expect(out).toContain('• You called early-stage tactics');
    expect(out).toContain('Active bias tags: over-confident-geography');
  });

  test('partial-grade row prints "60% graded" note', () => {
    const p = buildProfile({ holder: 'garry', grade_completion: 0.6 });
    const out = formatProfileText(p, 'garry');
    expect(out).toContain('60% graded');
  });

  test('voice-gate-failed row prints template-fallback note', () => {
    const p = buildProfile({ holder: 'garry', voice_gate_passed: false, voice_gate_attempts: 2 });
    const out = formatProfileText(p, 'garry');
    expect(out).toContain('voice gate fell back to template');
  });

  test('published=true is annotated', () => {
    const p = buildProfile({ holder: 'garry', published: true });
    const out = formatProfileText(p, 'garry');
    expect(out).toContain('published to mounts');
  });
});

// ─── getCalibrationProfileOp ────────────────────────────────────────

describe('getCalibrationProfileOp (MCP)', () => {
  test('defaults holder to "garry" when omitted', async () => {
    const { engine } = buildMockEngine({ rows: [buildProfile({ holder: 'garry' })] });
    const ctx = buildCtx(engine);
    const result = await getCalibrationProfileOp(ctx, {});
    expect(result?.holder).toBe('garry');
  });

  test('routes through sourceScopeOpts: scalar source-bound client gets source-scoped result', async () => {
    const rows = [
      buildProfile({ holder: 'garry', source_id: 'default' }),
      buildProfile({ holder: 'garry', source_id: 'tenant-b' }),
    ];
    const { engine } = buildMockEngine({ rows });
    const ctx = buildCtx(engine, { sourceId: 'tenant-b' });
    const result = await getCalibrationProfileOp(ctx, {});
    expect(result?.source_id).toBe('tenant-b');
  });

  test('federated read scope sees the union of allowed sources', async () => {
    const rows = [
      buildProfile({ holder: 'garry', source_id: 'tenant-a' }),
      buildProfile({ holder: 'garry', source_id: 'tenant-z' }),
    ];
    const { engine } = buildMockEngine({ rows });
    const ctx = buildCtx(engine, { allowedSources: ['tenant-a', 'tenant-b'] });
    const result = await getCalibrationProfileOp(ctx, {});
    // tenant-a is in the federated set → returns it; tenant-z is not → filtered out
    expect(result?.source_id).toBe('tenant-a');
  });

  test('returns null for unknown holder without throwing', async () => {
    const { engine } = buildMockEngine({ rows: [] });
    const ctx = buildCtx(engine);
    expect(await getCalibrationProfileOp(ctx, { holder: 'people/nobody' })).toBeNull();
  });

  test('throws on empty/non-string holder', async () => {
    const { engine } = buildMockEngine({ rows: [] });
    const ctx = buildCtx(engine);
    try {
      await getCalibrationProfileOp(ctx, { holder: '' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GBrainError);
      expect((err as GBrainError).problem).toBe('INVALID_HOLDER');
    }
  });
});
