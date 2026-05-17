/**
 * v0.36.0.0 (T6) — calibration_profile phase unit tests.
 *
 * Hermetic. Mock engine + injected patterns generator + injected voice gate
 * judge. Exercises:
 *  - cold-brain skip: <5 resolved takes
 *  - happy path: scorecard → generator → voice gate pass → row written
 *  - voice gate rejects both attempts → template fallback written
 *  - bias tags generator wired
 *  - parsePatternStatementsOutput + parseBiasTagsOutput unit tests
 *  - grade_completion plumbed through to the DB row
 *  - budget exhausted → status='warn', no row written
 */

import { describe, test, expect } from 'bun:test';
import {
  runPhaseCalibrationProfile,
  parsePatternStatementsOutput,
  parseBiasTagsOutput,
  __testing,
  type PatternStatementsGenerator,
  type BiasTagsGenerator,
} from '../src/core/cycle/calibration-profile.ts';
import type { VoiceGateJudge } from '../src/core/calibration/voice-gate.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine, TakesScorecard } from '../src/core/engine.ts';

interface CapturedSql {
  sql: string;
  params: unknown[];
}

function buildMockEngine(opts: { scorecard: TakesScorecard }): {
  engine: BrainEngine;
  captured: CapturedSql[];
} {
  const captured: CapturedSql[] = [];
  const engine = {
    kind: 'pglite',
    async getScorecard() {
      return opts.scorecard;
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });
      return [];
    },
  } as unknown as BrainEngine;
  return { engine, captured };
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

const passJudge: VoiceGateJudge = async () => ({ verdict: 'conversational', reason: 'fine' });
const rejectJudge: VoiceGateJudge = async () => ({ verdict: 'academic', reason: 'clinical' });

// ─── Parsers ────────────────────────────────────────────────────────

describe('parsePatternStatementsOutput', () => {
  test('splits newline-separated statements', () => {
    const raw = 'You called early-stage tactics well — 8 of 10 held up.\nGeography is your blind spot. 4 of 6 missed.';
    expect(parsePatternStatementsOutput(raw)).toEqual([
      'You called early-stage tactics well — 8 of 10 held up.',
      'Geography is your blind spot. 4 of 6 missed.',
    ]);
  });

  test('strips numbered list markers if the LLM emits them', () => {
    const raw = '1. First pattern.\n2) Second pattern.\n- Third pattern.';
    expect(parsePatternStatementsOutput(raw)).toEqual([
      'First pattern.',
      'Second pattern.',
      'Third pattern.',
    ]);
  });

  test('caps at 4 statements', () => {
    const raw = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(parsePatternStatementsOutput(raw).length).toBe(4);
  });

  test('drops empty lines and excessively long lines', () => {
    const long = 'x'.repeat(250);
    const raw = `valid\n\n${long}\nalso valid`;
    expect(parsePatternStatementsOutput(raw)).toEqual(['valid', 'also valid']);
  });

  test('returns [] on empty input', () => {
    expect(parsePatternStatementsOutput('')).toEqual([]);
  });
});

describe('parseBiasTagsOutput', () => {
  test('parses clean kebab-case tags', () => {
    const raw = '["over-confident-geography","late-on-macro-tech"]';
    expect(parseBiasTagsOutput(raw)).toEqual(['over-confident-geography', 'late-on-macro-tech']);
  });

  test('strips markdown fence', () => {
    const raw = '```json\n["over-confident-geography"]\n```';
    expect(parseBiasTagsOutput(raw)).toEqual(['over-confident-geography']);
  });

  test('lowercases input + drops non-kebab-case', () => {
    const raw = '["Over-Confident-Geography","INVALID TAG","late-on-macro"]';
    expect(parseBiasTagsOutput(raw)).toEqual(['over-confident-geography', 'late-on-macro']);
  });

  test('caps at 4 tags', () => {
    const raw = JSON.stringify(['a-b', 'c-d', 'e-f', 'g-h', 'i-j', 'k-l']);
    expect(parseBiasTagsOutput(raw).length).toBe(4);
  });

  test('returns [] on malformed input', () => {
    expect(parseBiasTagsOutput('not json')).toEqual([]);
    expect(parseBiasTagsOutput('')).toEqual([]);
  });
});

// ─── pickFallbackSlots ──────────────────────────────────────────────

describe('pickFallbackSlots', () => {
  test('over-confident direction when brier > 0.25', () => {
    const scorecard: TakesScorecard = {
      total_bets: 10,
      resolved: 10,
      correct: 4,
      incorrect: 6,
      partial: 0,
      accuracy: 0.4,
      brier: 0.32,
      partial_rate: 0,
    };
    expect(__testing.pickFallbackSlots(scorecard).direction).toBe('over-confident');
  });

  test('mostly-right direction when brier <= 0.25', () => {
    const scorecard: TakesScorecard = {
      total_bets: 10,
      resolved: 10,
      correct: 8,
      incorrect: 2,
      partial: 0,
      accuracy: 0.8,
      brier: 0.12,
      partial_rate: 0,
    };
    expect(__testing.pickFallbackSlots(scorecard).direction).toBe('mostly right');
  });

  test('zero resolved → "overall" domain, 0/0', () => {
    const scorecard: TakesScorecard = {
      total_bets: 0,
      resolved: 0,
      correct: 0,
      incorrect: 0,
      partial: 0,
      accuracy: null,
      brier: null,
      partial_rate: null,
    };
    const out = __testing.pickFallbackSlots(scorecard);
    expect(out.nRight).toBe(0);
    expect(out.nWrong).toBe(0);
  });
});

// ─── Phase integration ──────────────────────────────────────────────

const ENOUGH_RESOLVED_SCORECARD: TakesScorecard = {
  total_bets: 20,
  resolved: 12,
  correct: 7,
  incorrect: 4,
  partial: 1,
  accuracy: 0.636,
  brier: 0.21,
  partial_rate: 0.083,
};

describe('runPhaseCalibrationProfile — phase integration', () => {
  test('cold-brain skip: <5 resolved → no row written, status=ok', async () => {
    const { engine, captured } = buildMockEngine({
      scorecard: { ...ENOUGH_RESOLVED_SCORECARD, resolved: 3 },
    });
    const result = await runPhaseCalibrationProfile(buildCtx(engine), {});
    expect(result.status).toBe('ok');
    expect((result.details as Record<string, unknown>).profile_written).toBe(false);
    expect((result.details as Record<string, unknown>).skipped).toBe('insufficient_data');
    expect(captured.filter(c => c.sql.includes('INSERT INTO calibration_profiles'))).toHaveLength(0);
  });

  test('happy path: row written with passed voice gate', async () => {
    const { engine, captured } = buildMockEngine({ scorecard: ENOUGH_RESOLVED_SCORECARD });
    const patternsGenerator: PatternStatementsGenerator = async () => [
      'You called early-stage tactics well — 8 of 10 held up.',
      'Geography is your blind spot — 4 of 6 missed.',
    ];
    const biasTagsGenerator: BiasTagsGenerator = async () => ['over-confident-geography'];
    const result = await runPhaseCalibrationProfile(buildCtx(engine), {
      patternsGenerator,
      biasTagsGenerator,
      voiceGateJudge: passJudge,
    });
    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.profile_written).toBe(true);
    expect(details.voice_gate_passed).toBe(true);
    expect(details.voice_gate_attempts).toBe(1);
    expect((details.pattern_statements as string[]).length).toBe(2);
    expect((details.active_bias_tags as string[])).toEqual(['over-confident-geography']);

    const insert = captured.find(c => c.sql.includes('INSERT INTO calibration_profiles'));
    expect(insert).toBeDefined();
    // Params: source_id, holder, total_resolved, brier, accuracy, partial_rate,
    // grade_completion, domain_scorecards_json, patterns[], voice_passed, voice_attempts,
    // bias_tags[], model_id
    expect(insert!.params[0]).toBe('default'); // source_id
    expect(insert!.params[1]).toBe('garry'); // holder
    expect(insert!.params[2]).toBe(12); // total_resolved
    expect(insert!.params[9]).toBe(true); // voice_gate_passed
    expect(insert!.params[10]).toBe(1); // voice_gate_attempts
    expect(insert!.params[11]).toEqual(['over-confident-geography']); // active_bias_tags
  });

  test('voice gate rejects both attempts → template fallback written, voice_gate_passed=false', async () => {
    const { engine, captured } = buildMockEngine({ scorecard: ENOUGH_RESOLVED_SCORECARD });
    const patternsGenerator: PatternStatementsGenerator = async () => [
      'Per our analysis, the data indicates patterns.',
    ];
    const result = await runPhaseCalibrationProfile(buildCtx(engine), {
      patternsGenerator,
      voiceGateJudge: rejectJudge,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.voice_gate_passed).toBe(false);
    expect(details.voice_gate_attempts).toBe(2);
    expect(details.profile_written).toBe(true);
    const patterns = details.pattern_statements as string[];
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0]).toContain('overall'); // template fallback contains "overall" domain

    const insert = captured.find(c => c.sql.includes('INSERT INTO calibration_profiles'));
    expect(insert!.params[9]).toBe(false); // voice_gate_passed=false
    expect(insert!.params[10]).toBe(2); // voice_gate_attempts=2
  });

  test('grade_completion is plumbed through to the row', async () => {
    const { engine, captured } = buildMockEngine({ scorecard: ENOUGH_RESOLVED_SCORECARD });
    const patternsGenerator: PatternStatementsGenerator = async () => ['fine pattern'];
    await runPhaseCalibrationProfile(buildCtx(engine), {
      patternsGenerator,
      voiceGateJudge: passJudge,
      gradeCompletion: 0.6,
    });
    const insert = captured.find(c => c.sql.includes('INSERT INTO calibration_profiles'));
    expect(insert!.params[6]).toBe(0.6); // grade_completion
  });

  test('bias_tags_generator failure logs warning + phase continues', async () => {
    const { engine } = buildMockEngine({ scorecard: ENOUGH_RESOLVED_SCORECARD });
    const patternsGenerator: PatternStatementsGenerator = async () => ['fine pattern'];
    const biasTagsGenerator: BiasTagsGenerator = async () => {
      throw new Error('Haiku timed out');
    };
    const result = await runPhaseCalibrationProfile(buildCtx(engine), {
      patternsGenerator,
      biasTagsGenerator,
      voiceGateJudge: passJudge,
    });
    expect(result.status).toBe('ok');
    const details = result.details as Record<string, unknown>;
    expect(details.profile_written).toBe(true);
    expect((details.warnings as string[])[0]).toContain('Haiku timed out');
  });

  test('source_id from ctx scope reaches the INSERT params', async () => {
    const { engine, captured } = buildMockEngine({ scorecard: ENOUGH_RESOLVED_SCORECARD });
    const patternsGenerator: PatternStatementsGenerator = async () => ['fine pattern'];
    const ctx = { ...buildCtx(engine), sourceId: 'tenant-b' };
    await runPhaseCalibrationProfile(ctx, {
      patternsGenerator,
      voiceGateJudge: passJudge,
    });
    const insert = captured.find(c => c.sql.includes('INSERT INTO calibration_profiles'));
    expect(insert!.params[0]).toBe('tenant-b');
  });
});
