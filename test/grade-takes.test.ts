/**
 * v0.36.1.0 (T4) — grade_takes phase unit tests.
 *
 * Pure structural tests against a mock BrainEngine + injected judge +
 * injected evidence retriever. No real LLM gateway, no PGLite.
 *
 * Tests cover:
 *  - happy path: judge produces verdict, lands in take_grade_cache
 *  - auto-resolve disabled by default (D17): even high-confidence verdicts
 *    DO NOT apply to canonical takes
 *  - auto-resolve enabled + confidence above threshold: engine.resolveTake fires
 *  - auto-resolve enabled + confidence below threshold: verdict cached, NOT applied
 *  - 'unresolvable' verdict NEVER auto-applies even at confidence=1.0
 *  - cache hit path: skip already-graded (take, prompt, judge, evidence_sig)
 *  - takes that are too recent are skipped
 *  - judge throw on a single take logs warning + phase continues
 *  - parseJudgeOutput unit tests
 *  - takeIsOldEnough unit tests
 */

import { describe, test, expect } from 'bun:test';
import {
  runPhaseGradeTakes,
  parseJudgeOutput,
  evidenceSignature,
  takeIsOldEnough,
  GRADE_TAKES_PROMPT_VERSION,
  type JudgeFn,
  type EvidenceRetrieverFn,
} from '../src/core/cycle/grade-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine, Take, TakeResolution } from '../src/core/engine.ts';

// ─── Mock engine ────────────────────────────────────────────────────

interface CapturedSql {
  sql: string;
  params: unknown[];
}
interface CapturedResolve {
  pageId: number;
  rowNum: number;
  resolution: TakeResolution;
}

function buildMockEngine(opts: {
  takes: Take[];
  cachedGrades?: Set<string>; // composite-key strings already in take_grade_cache
}): { engine: BrainEngine; captured: CapturedSql[]; resolves: CapturedResolve[] } {
  const captured: CapturedSql[] = [];
  const resolves: CapturedResolve[] = [];
  const cached = opts.cachedGrades ?? new Set<string>();

  const engine = {
    kind: 'pglite',
    async listTakes() {
      return opts.takes;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      if (sql.includes('SELECT verdict, confidence, applied FROM take_grade_cache')) {
        const [takeId, pv, model, sig] = params ?? [];
        const key = `${takeId}|${pv}|${model}|${sig}`;
        if (cached.has(key)) return [{ verdict: 'correct', confidence: 0.99, applied: false } as unknown as T];
        return [];
      }
      return [];
    },
    async resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
      resolves.push({ pageId, rowNum, resolution });
    },
  } as unknown as BrainEngine;

  return { engine, captured, resolves };
}

function buildTake(opts: Partial<Take> & { id: number; sinceDate: string | null }): Take {
  return {
    id: opts.id,
    page_id: opts.page_id ?? 100 + opts.id,
    page_slug: opts.page_slug ?? `wiki/note-${opts.id}`,
    row_num: opts.row_num ?? 1,
    claim: opts.claim ?? `claim ${opts.id}`,
    kind: opts.kind ?? 'bet',
    holder: opts.holder ?? 'garry',
    weight: opts.weight ?? 0.7,
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

// ─── parseJudgeOutput ───────────────────────────────────────────────

describe('parseJudgeOutput', () => {
  test('parses clean JSON verdict', () => {
    const raw = '{"verdict":"correct","confidence":0.92,"reasoning":"PG essay timing held up"}';
    const out = parseJudgeOutput(raw);
    expect(out).not.toBeNull();
    expect(out!.verdict).toBe('correct');
    expect(out!.confidence).toBe(0.92);
    expect(out!.reasoning).toBe('PG essay timing held up');
  });

  test('strips markdown fence', () => {
    const raw = '```json\n{"verdict":"partial","confidence":0.6,"reasoning":"mixed"}\n```';
    expect(parseJudgeOutput(raw)?.verdict).toBe('partial');
  });

  test('clamps confidence to [0,1]', () => {
    expect(parseJudgeOutput('{"verdict":"correct","confidence":2,"reasoning":"x"}')?.confidence).toBe(1);
    expect(parseJudgeOutput('{"verdict":"correct","confidence":-1,"reasoning":"x"}')?.confidence).toBe(0);
  });

  test('returns null on invalid verdict label', () => {
    expect(parseJudgeOutput('{"verdict":"maybe","confidence":0.5,"reasoning":"x"}')).toBeNull();
  });

  test('returns null on missing fields', () => {
    expect(parseJudgeOutput('{"verdict":"correct"}')).toBeNull();
  });

  test('returns null on garbage input', () => {
    expect(parseJudgeOutput('not json at all')).toBeNull();
    expect(parseJudgeOutput('')).toBeNull();
  });

  test('truncates reasoning longer than 400 chars', () => {
    const longReason = 'x'.repeat(600);
    const raw = `{"verdict":"correct","confidence":0.9,"reasoning":"${longReason}"}`;
    expect(parseJudgeOutput(raw)?.reasoning.length).toBe(400);
  });
});

// ─── evidenceSignature ──────────────────────────────────────────────

describe('evidenceSignature', () => {
  test('is deterministic over (evidence, judge_model_id) tuple', () => {
    expect(evidenceSignature('e1', 'm1')).toBe(evidenceSignature('e1', 'm1'));
  });

  test('different evidence → different sig', () => {
    expect(evidenceSignature('e1', 'm1')).not.toBe(evidenceSignature('e2', 'm1'));
  });

  test('different judge → different sig (judge swap invalidates cache)', () => {
    expect(evidenceSignature('e1', 'm1')).not.toBe(evidenceSignature('e1', 'm2'));
  });
});

// ─── takeIsOldEnough ────────────────────────────────────────────────

describe('takeIsOldEnough', () => {
  test('returns true when since_date is older than minAgeMonths', () => {
    const take = buildTake({ id: 1, sinceDate: '2023-01-01' });
    expect(takeIsOldEnough(take, 6, new Date('2024-01-01'))).toBe(true);
  });

  test('returns false when since_date is recent', () => {
    const take = buildTake({ id: 1, sinceDate: '2023-11-15' });
    expect(takeIsOldEnough(take, 6, new Date('2024-01-01'))).toBe(false);
  });

  test('returns false when since_date is null', () => {
    const take = buildTake({ id: 1, sinceDate: null });
    expect(takeIsOldEnough(take, 6, new Date('2024-01-01'))).toBe(false);
  });

  test('tolerates YYYY-MM format', () => {
    const take = buildTake({ id: 1, sinceDate: '2023-01' });
    expect(takeIsOldEnough(take, 6, new Date('2024-01-01'))).toBe(true);
  });

  test('returns false on unparseable since_date', () => {
    const take = buildTake({ id: 1, sinceDate: 'never' });
    expect(takeIsOldEnough(take, 6, new Date('2024-01-01'))).toBe(false);
  });
});

// ─── Phase integration ──────────────────────────────────────────────

describe('runPhaseGradeTakes — phase integration', () => {
  test('happy path: judge produces verdict, lands in take_grade_cache (applied=false default)', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, captured, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.98, reasoning: 'evidence held' });
    const evidenceRetriever: EvidenceRetrieverFn = async () => 'mock evidence body';

    const result = await runPhaseGradeTakes(buildCtx(engine), { judge, evidenceRetriever });

    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.takes_scanned).toBe(1);
    expect(details.verdicts_written).toBe(1);
    expect(details.auto_applied).toBe(0); // D17 default: auto-resolve OFF

    const inserts = captured.filter(c => c.sql.includes('INSERT INTO take_grade_cache'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params[4]).toBe('correct'); // verdict
    expect(inserts[0]!.params[5]).toBe(0.98); // confidence
    expect(inserts[0]!.params[6]).toBe(false); // applied=false (auto-resolve OFF)
    expect(resolves).toHaveLength(0); // no canonical mutation
  });

  test('D17: auto-resolve OFF by default — even high-confidence verdict does NOT mutate takes', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 1.0, reasoning: 'certain' });
    const result = await runPhaseGradeTakes(buildCtx(engine), { judge });
    const details = result.details as Record<string, unknown>;
    expect(details.auto_resolve).toBe(false);
    expect(details.auto_applied).toBe(0);
    expect(resolves).toHaveLength(0);
  });

  test('D12 conservative threshold: auto-resolve ON, confidence>=0.95 → applies', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'incorrect', confidence: 0.96, reasoning: 'contradicted' });
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      autoResolve: true,
      autoResolveThreshold: 0.95,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.auto_applied).toBe(1);
    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.resolution.quality).toBe('incorrect');
    expect(resolves[0]!.resolution.resolvedBy).toBe('gbrain:grade_takes');
  });

  test('auto-resolve ON but confidence below threshold → cached only, NOT applied', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, captured, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'correct', confidence: 0.85, reasoning: 'leaning yes' });
    const result = await runPhaseGradeTakes(buildCtx(engine), {
      judge,
      autoResolve: true,
      autoResolveThreshold: 0.95,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.auto_applied).toBe(0);
    expect(resolves).toHaveLength(0);
    const insert = captured.find(c => c.sql.includes('INSERT INTO take_grade_cache'));
    expect(insert!.params[6]).toBe(false); // applied=false
  });

  test('unresolvable verdict NEVER auto-applies even at confidence=1.0', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const { engine, resolves } = buildMockEngine({ takes });
    const judge: JudgeFn = async () => ({ verdict: 'unresolvable', confidence: 1.0, reasoning: 'no evidence yet' });
    await runPhaseGradeTakes(buildCtx(engine), { judge, autoResolve: true, autoResolveThreshold: 0.95 });
    expect(resolves).toHaveLength(0);
  });

  test('cache hit: (take, prompt, judge, evidence_sig) match → skip', async () => {
    const takes = [buildTake({ id: 1, sinceDate: '2023-01-01' })];
    const sig = evidenceSignature('mock evidence body', 'claude-sonnet-4-6');
    const cached = new Set([`1|${GRADE_TAKES_PROMPT_VERSION}|claude-sonnet-4-6|${sig}`]);
    const { engine } = buildMockEngine({ takes, cachedGrades: cached });
    let judgeCalls = 0;
    const judge: JudgeFn = async () => {
      judgeCalls++;
      return { verdict: 'correct', confidence: 0.9, reasoning: 'x' };
    };
    const evidenceRetriever: EvidenceRetrieverFn = async () => 'mock evidence body';
    const result = await runPhaseGradeTakes(buildCtx(engine), { judge, evidenceRetriever });
    expect(judgeCalls).toBe(0);
    const details = result.details as Record<string, unknown>;
    expect(details.cache_hits).toBe(1);
  });

  test('too-recent takes are skipped (minAgeMonths gate)', async () => {
    const recentDate = new Date();
    recentDate.setMonth(recentDate.getMonth() - 2);
    const takes = [buildTake({ id: 1, sinceDate: recentDate.toISOString().slice(0, 10) })];
    const { engine } = buildMockEngine({ takes });
    let judgeCalls = 0;
    const judge: JudgeFn = async () => {
      judgeCalls++;
      return { verdict: 'correct', confidence: 1.0, reasoning: 'x' };
    };
    const result = await runPhaseGradeTakes(buildCtx(engine), { judge, minAgeMonths: 6 });
    expect(judgeCalls).toBe(0);
    const details = result.details as Record<string, unknown>;
    expect(details.too_recent).toBe(1);
  });

  test('judge throw on a single take logs warning + phase continues', async () => {
    const takes = [
      buildTake({ id: 1, sinceDate: '2023-01-01' }),
      buildTake({ id: 2, sinceDate: '2023-01-01' }),
    ];
    const { engine } = buildMockEngine({ takes });
    let calls = 0;
    const judge: JudgeFn = async () => {
      calls++;
      if (calls === 1) throw new Error('judge timeout');
      return { verdict: 'correct', confidence: 0.9, reasoning: 'second succeeded' };
    };
    const result = await runPhaseGradeTakes(buildCtx(engine), { judge });
    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.verdicts_written).toBe(1);
    expect((details.warnings as string[]).length).toBeGreaterThan(0);
    expect((details.warnings as string[])[0]).toContain('judge timeout');
  });
});
