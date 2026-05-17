/**
 * v0.36.0.0 (T5 / E2 expansion) — grade_takes ensemble tiebreaker tests.
 *
 * Tests cover:
 *  - aggregateEnsemble pure-function: 3/3 unanimous, 2/3 majority,
 *    1/1/1 disagreement, all-failed, 'unresolvable' tie-break preference
 *  - Phase: ensemble does NOT fire when useEnsemble=false (T4 default)
 *  - Phase: ensemble fires when single-model in borderline band [0.6, 0.95)
 *  - Phase: ensemble does NOT fire when single-model >= 0.95 (single sufficient)
 *  - Phase: ensemble does NOT fire when single-model < 0.6 (clearly unresolvable)
 *  - Phase: ensemble does NOT fire when single returns 'unresolvable'
 *  - Phase: 3/3 unanimous + min conf >= threshold + autoResolve → applies
 *  - Phase: 2/3 majority → cache only, NOT applied
 *  - Phase: 'unresolvable' winner from ensemble → cache only, NOT applied
 *  - Phase: ensemble cache row uses judge_model_id 'ensemble:<m1>+<m2>+<m3>'
 */

import { describe, test, expect } from 'bun:test';
import {
  runPhaseGradeTakes,
  __testing,
  type JudgeFn,
  type EvidenceRetrieverFn,
} from '../src/core/cycle/grade-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine, Take, TakeResolution } from '../src/core/engine.ts';

const { aggregateEnsemble } = __testing;

// ─── Mock engine (shared shape with grade-takes.test.ts) ───────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}
interface CapturedResolve {
  pageId: number;
  rowNum: number;
  resolution: TakeResolution;
}

function buildMockEngine(opts: { takes: Take[] }): {
  engine: BrainEngine;
  captured: CapturedSql[];
  resolves: CapturedResolve[];
} {
  const captured: CapturedSql[] = [];
  const resolves: CapturedResolve[] = [];
  const engine = {
    kind: 'pglite',
    async listTakes() {
      return opts.takes;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT verdict, confidence, applied FROM take_grade_cache')) return [];
      return [];
    },
    async resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
      resolves.push({ pageId, rowNum, resolution });
    },
  } as unknown as BrainEngine;
  return { engine, captured, resolves };
}

function buildTake(opts: { id: number; sinceDate: string }): Take {
  return {
    id: opts.id,
    page_id: 100 + opts.id,
    page_slug: `wiki/note-${opts.id}`,
    row_num: 1,
    claim: `claim ${opts.id}`,
    kind: 'bet',
    holder: 'garry',
    weight: 0.7,
    since_date: opts.sinceDate,
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
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  } as Take;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

// ─── aggregateEnsemble (pure) ───────────────────────────────────────

describe('aggregateEnsemble', () => {
  test('3/3 unanimous → agreement=3, minConfidence = min across models', () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: { verdict: 'correct', confidence: 0.92, reasoning: '' } },
      { modelId: 'b', verdict: { verdict: 'correct', confidence: 0.87, reasoning: '' } },
      { modelId: 'c', verdict: { verdict: 'correct', confidence: 0.95, reasoning: '' } },
    ]);
    expect(out.verdict).toBe('correct');
    expect(out.agreement).toBe(3);
    expect(out.minConfidence).toBeCloseTo(0.87, 5);
  });

  test('2/3 majority → agreement=2, minConfidence across the two', () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: { verdict: 'correct', confidence: 0.9, reasoning: '' } },
      { modelId: 'b', verdict: { verdict: 'correct', confidence: 0.8, reasoning: '' } },
      { modelId: 'c', verdict: { verdict: 'incorrect', confidence: 0.7, reasoning: '' } },
    ]);
    expect(out.verdict).toBe('correct');
    expect(out.agreement).toBe(2);
    expect(out.minConfidence).toBeCloseTo(0.8, 5);
  });

  test('1/1/1 disagreement → winner picked deterministically (non-unresolvable preferred)', () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: { verdict: 'correct', confidence: 0.9, reasoning: '' } },
      { modelId: 'b', verdict: { verdict: 'incorrect', confidence: 0.85, reasoning: '' } },
      { modelId: 'c', verdict: { verdict: 'unresolvable', confidence: 0.7, reasoning: '' } },
    ]);
    // Tie at agreement=1 among all three; non-unresolvable preferred; alpha
    // tiebreak: 'correct' < 'incorrect' < 'partial' < 'unresolvable' so
    // 'correct' wins.
    expect(out.verdict).toBe('correct');
    expect(out.agreement).toBe(1);
  });

  test("one 'unresolvable' doesn't tip a 2-vote majority toward the unresolvable label", () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: { verdict: 'unresolvable', confidence: 0.5, reasoning: '' } },
      { modelId: 'b', verdict: { verdict: 'correct', confidence: 0.9, reasoning: '' } },
      { modelId: 'c', verdict: { verdict: 'correct', confidence: 0.85, reasoning: '' } },
    ]);
    expect(out.verdict).toBe('correct');
    expect(out.agreement).toBe(2);
  });

  test('all failed → verdict=unresolvable with agreement=0 (no auto-apply path)', () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: null },
      { modelId: 'b', verdict: null },
      { modelId: 'c', verdict: null },
    ]);
    expect(out.verdict).toBe('unresolvable');
    expect(out.agreement).toBe(0);
    expect(out.modelVerdicts.every(m => m.failed)).toBe(true);
  });

  test('two failed + one verdict → agreement=1 with the lone verdict', () => {
    const out = aggregateEnsemble([
      { modelId: 'a', verdict: null },
      { modelId: 'b', verdict: { verdict: 'partial', confidence: 0.75, reasoning: '' } },
      { modelId: 'c', verdict: null },
    ]);
    expect(out.verdict).toBe('partial');
    expect(out.agreement).toBe(1);
    expect(out.minConfidence).toBeCloseTo(0.75, 5);
  });
});

// ─── Phase integration: ensemble trigger conditions ─────────────────

describe('runPhaseGradeTakes ensemble — when does the tiebreaker fire?', () => {
  test('useEnsemble=false (T4 default): ensemble never fires', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'maybe' });
    let ensembleCalls = 0;
    const ensembleFn: JudgeFn = async () => {
      ensembleCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: '' };
    };
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: false,
      ensembleJudges: [
        { modelId: 'a', fn: ensembleFn },
        { modelId: 'b', fn: ensembleFn },
        { modelId: 'c', fn: ensembleFn },
      ],
    });
    expect(ensembleCalls).toBe(0);
    expect((result.details as Record<string, unknown>).ensemble_invoked).toBe(0);
  });

  test('useEnsemble=true + confidence in [0.6, 0.95): ensemble fires', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.75, reasoning: 'borderline' });
    let ensembleCalls = 0;
    const ensembleFn: JudgeFn = async () => {
      ensembleCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: '' };
    };
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [
        { modelId: 'openai:gpt-4o', fn: ensembleFn },
        { modelId: 'anthropic:claude-sonnet-4-6', fn: ensembleFn },
        { modelId: 'google:gemini-1.5-pro', fn: ensembleFn },
      ],
    });
    expect(ensembleCalls).toBe(3);
    expect((result.details as Record<string, unknown>).ensemble_invoked).toBe(1);
    expect((result.details as Record<string, unknown>).ensemble_unanimous).toBe(1);
  });

  test('useEnsemble=true + single-model >= 0.95: ensemble does NOT fire (single sufficient)', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.97, reasoning: 'high' });
    let ensembleCalls = 0;
    const ensembleFn: JudgeFn = async () => {
      ensembleCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: '' };
    };
    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [{ modelId: 'a', fn: ensembleFn }, { modelId: 'b', fn: ensembleFn }, { modelId: 'c', fn: ensembleFn }],
    });
    expect(ensembleCalls).toBe(0);
  });

  test('useEnsemble=true + single-model < 0.6: ensemble does NOT fire (clearly review-only)', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.4, reasoning: 'low' });
    let ensembleCalls = 0;
    const ensembleFn: JudgeFn = async () => {
      ensembleCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: '' };
    };
    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [{ modelId: 'a', fn: ensembleFn }, { modelId: 'b', fn: ensembleFn }, { modelId: 'c', fn: ensembleFn }],
    });
    expect(ensembleCalls).toBe(0);
  });

  test("useEnsemble=true + single-model returns 'unresolvable': ensemble does NOT fire", async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'unresolvable', confidence: 0.8, reasoning: 'no evidence' });
    let ensembleCalls = 0;
    const ensembleFn: JudgeFn = async () => {
      ensembleCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: '' };
    };
    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [{ modelId: 'a', fn: ensembleFn }, { modelId: 'b', fn: ensembleFn }, { modelId: 'c', fn: ensembleFn }],
    });
    expect(ensembleCalls).toBe(0);
  });
});

// ─── Phase integration: ensemble auto-apply rules ───────────────────

describe('runPhaseGradeTakes ensemble — auto-apply rules', () => {
  test('3/3 unanimous + min conf >= 0.85 + autoResolve=true → applies', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves, captured } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'borderline' });
    const eA: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.92, reasoning: '' });
    const eB: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.87, reasoning: '' });
    const eC: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.95, reasoning: '' });

    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [
        { modelId: 'openai:gpt-4o', fn: eA },
        { modelId: 'anthropic:claude-sonnet-4-6', fn: eB },
        { modelId: 'google:gemini-1.5-pro', fn: eC },
      ],
      autoResolve: true,
      ensembleThreshold: 0.85,
    });

    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.resolution.quality).toBe('correct');
    const insert = captured.find(c => c.sql.includes('INSERT INTO take_grade_cache'));
    expect(insert!.params[2]).toBe('ensemble:openai:gpt-4o+anthropic:claude-sonnet-4-6+google:gemini-1.5-pro');
    expect(insert!.params[6]).toBe(true); // applied=true
  });

  test('2/3 majority + autoResolve=true → cache only, NOT applied', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves, captured } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'borderline' });
    const eA: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.9, reasoning: '' });
    const eB: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.88, reasoning: '' });
    const eC: JudgeFn = async () => ({ verdict: 'incorrect', confidence: 0.85, reasoning: '' });

    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [
        { modelId: 'a', fn: eA },
        { modelId: 'b', fn: eB },
        { modelId: 'c', fn: eC },
      ],
      autoResolve: true,
      ensembleThreshold: 0.85,
    });

    expect(resolves).toHaveLength(0);
    const insert = captured.find(c => c.sql.includes('INSERT INTO take_grade_cache'));
    expect(insert!.params[6]).toBe(false); // applied=false
    expect(insert!.params[4]).toBe('correct'); // ensemble winner persisted
  });

  test('3/3 unanimous but min conf BELOW threshold → cache only, NOT applied', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'borderline' });
    const eA: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.83, reasoning: '' });
    const eB: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.84, reasoning: '' });
    const eC: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.82, reasoning: '' });

    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [
        { modelId: 'a', fn: eA },
        { modelId: 'b', fn: eB },
        { modelId: 'c', fn: eC },
      ],
      autoResolve: true,
      ensembleThreshold: 0.85,
    });
    expect(resolves).toHaveLength(0);
  });

  test('one ensemble judge throws → that slot is null but rest aggregate (Promise.allSettled)', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'borderline' });
    const eA: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.9, reasoning: '' });
    const eB: JudgeFn = async () => {
      throw new Error('gemini timeout');
    };
    const eC: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.92, reasoning: '' });

    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [
        { modelId: 'a', fn: eA },
        { modelId: 'b', fn: eB },
        { modelId: 'c', fn: eC },
      ],
      autoResolve: true,
      ensembleThreshold: 0.85,
    });
    // Only 2/3 survived → not unanimous → cache only, NOT applied.
    expect(resolves).toHaveLength(0);
  });

  test('ensembleJudges empty array: ensemble path skipped even when useEnsemble=true', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, captured } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.7, reasoning: 'borderline' });
    await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      useEnsemble: true,
      ensembleJudges: [],
    });
    const insert = captured.find(c => c.sql.includes('INSERT INTO take_grade_cache'));
    expect(insert!.params[2]).toBe('claude-sonnet-4-6'); // single-judge model id
  });
});
