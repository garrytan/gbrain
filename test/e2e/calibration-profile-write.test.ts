/**
 * End-to-end pin for the calibration_profiles write (D3 companion).
 *
 * `runPhaseCalibrationProfile` persists `domain_scorecards` through the
 * doctrine-blessed positional shape `$8::text::jsonb` and
 * `pattern_statements` through `$9::text[]`. The propose_takes siblings in
 * the same directory shipped the uncast variant of this bind and
 * double-encoded on real Postgres (#2339 class), so this test pins the
 * calibration write on BOTH engines:
 *
 *  - PGLite (always runs): the phase completes end-to-end against a real
 *    embedded engine (not the unit tests' mock) and the row lands.
 *  - Live Postgres (DATABASE_URL-gated): `jsonb_typeof(domain_scorecards)`
 *    is 'object' — never a double-encoded 'string' — and the `$9::text[]`
 *    bind round-trips as a real Postgres array.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import { runPhaseCalibrationProfile, type PatternStatementsGenerator, type BiasTagsGenerator } from '../../src/core/cycle/calibration-profile.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { VoiceGateJudge } from '../../src/core/calibration/voice-gate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';

const HOLDER = 'calib-holder-e2e';
const PATTERNS = [
  'You called early-stage tactics well — 8 of 10 held up.',
  'Geography is your blind spot — 4 of 6 missed.',
];

let generatorCalls = 0;
const patternsGenerator: PatternStatementsGenerator = async () => { generatorCalls++; return PATTERNS; };
const biasTagsGenerator: BiasTagsGenerator = async () => ['over-confident-geography'];
const passJudge: VoiceGateJudge = async () => ({ verdict: 'conversational', reason: 'fine' });

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

/** Seed one page with 5 resolved bets for HOLDER (3 correct, 2 incorrect). */
async function seedResolvedTakes(engine: BrainEngine, slug: string): Promise<void> {
  const page = await engine.putPage(slug, {
    type: 'analysis',
    title: 'Calibration seed',
    compiled_truth: 'Seed page for resolved takes.',
    timeline: '',
  });
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    page_id: page.id,
    row_num: n,
    claim: `Seed claim ${n}`,
    kind: 'bet' as const,
    holder: HOLDER,
    weight: 0.6,
  }));
  await engine.addTakesBatch(rows);
  for (const n of [1, 2, 3, 4, 5]) {
    await engine.resolveTake(page.id, n, {
      quality: n <= 3 ? 'correct' : 'incorrect',
      resolvedBy: 'test',
    });
  }
}

async function runPhase(engine: BrainEngine, extra: { model?: string } = {}) {
  return runPhaseCalibrationProfile(buildCtx(engine), {
    holder: HOLDER,
    patternsGenerator,
    biasTagsGenerator,
    voiceGateJudge: passJudge,
    ...extra,
  });
}

/**
 * GBRA-177: a pass on an unchanged scorecard (resolved count, Brier, accuracy,
 * partial rate and model all equal the latest stored profile's) makes no model
 * call and writes no row; a change to any of them regenerates. Runs after the lane's first profile is written.
 */
async function expectUnchangedSkip(engine: BrainEngine, slug: string): Promise<void> {
  const rows = async () => Number((await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM calibration_profiles WHERE holder = $1', [HOLDER]))[0]!.n);
  const before = await rows();
  generatorCalls = 0;
  const again = await runPhase(engine);
  expect(again.status).toBe('ok');
  expect(again.details as Record<string, unknown>).toMatchObject({ profile_written: false, skipped: 'unchanged_scorecard' });
  expect(generatorCalls).toBe(0);
  expect(await rows()).toBe(before);
  expect(((await runPhase(engine, { model: 'anthropic:claude-opus-4-7' })).details as Record<string, unknown>).profile_written).toBe(true);
  expect(((await runPhase(engine, { model: 'anthropic:claude-opus-4-7' })).details as Record<string, unknown>).profile_written).toBe(false);
  const page = await engine.getPage(slug);
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 6, claim: 'Seed claim 6', kind: 'bet' as const, holder: HOLDER, weight: 0.6 }]);
  await engine.resolveTake(page!.id, 6, { quality: 'correct', resolvedBy: 'test' });
  expect(((await runPhase(engine, { model: 'anthropic:claude-opus-4-7' })).details as Record<string, unknown>).profile_written).toBe(true);
  expect(generatorCalls).toBe(2);
  expect(await rows()).toBe(before + 2);
}

// ─── PGLite lane (always runs) ──────────────────────────────────────

describe('calibration_profile write — PGLite end-to-end', () => {
  let pglite: PGLiteEngine;

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await seedResolvedTakes(pglite, 'calib/seed-pglite');
  });

  afterAll(async () => {
    await pglite.disconnect();
  });

  test('phase runs end-to-end and the profile row lands', async () => {
    const result = await runPhase(pglite);
    expect(result.error?.message ?? '').toBe('');
    expect(result.status).toBe('ok');
    expect((result.details as Record<string, unknown>).profile_written).toBe(true);

    const rows = await pglite.executeRaw<{
      total_resolved: number;
      kind: string;
      n_patterns: number | null;
      first_pattern: string | null;
    }>(
      `SELECT total_resolved,
              jsonb_typeof(domain_scorecards) AS kind,
              array_length(pattern_statements, 1) AS n_patterns,
              pattern_statements[1] AS first_pattern
         FROM calibration_profiles
        WHERE holder = $1`,
      [HOLDER],
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.total_resolved)).toBe(5);
    expect(rows[0]!.kind).toBe('object');
    expect(Number(rows[0]!.n_patterns)).toBe(2);
    expect(rows[0]!.first_pattern).toBe(PATTERNS[0]!);
  });

  test('an unchanged scorecard makes no model call and writes no row; a changed input regenerates', async () => {
    await expectUnchangedSkip(pglite, 'calib/seed-pglite');
  });
});

// ─── Live Postgres lane (DATABASE_URL-gated) ────────────────────────

const skipPg = !hasDatabase();
const describeIfDB = skipPg ? describe.skip : describe;

describeIfDB('calibration_profile write — Postgres jsonb/text[] binds', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
    // calibration_profiles is not in the helpers' truncate list.
    await engine.executeRaw(`DELETE FROM calibration_profiles WHERE holder = $1`, [HOLDER]);
    await seedResolvedTakes(engine, 'calib/seed-postgres');
  });

  afterAll(async () => {
    await teardownDB();
  });

  test('domain_scorecards is a jsonb object and pattern_statements a real text[]', async () => {
    const result = await runPhase(engine);
    expect(result.error?.message ?? '').toBe('');
    expect(result.status).toBe('ok');
    expect((result.details as Record<string, unknown>).profile_written).toBe(true);

    const rows = await engine.executeRaw<{
      kind: string;
      n_patterns: number | null;
      first_pattern: string | null;
      patterns: string[];
      total_resolved: number;
    }>(
      `SELECT jsonb_typeof(domain_scorecards) AS kind,
              array_length(pattern_statements, 1) AS n_patterns,
              pattern_statements[1] AS first_pattern,
              pattern_statements AS patterns,
              total_resolved
         FROM calibration_profiles
        WHERE holder = $1`,
      [HOLDER],
    );
    expect(rows.length).toBe(1);
    // The double-encode failure mode is jsonb_typeof = 'string'.
    expect(rows[0]!.kind).toBe('object');
    expect(Number(rows[0]!.total_resolved)).toBe(5);
    // The $9::text[] bind must round-trip as a REAL array, not a stringified one.
    expect(Number(rows[0]!.n_patterns)).toBe(2);
    expect(rows[0]!.first_pattern).toBe(PATTERNS[0]!);
    expect(Array.isArray(rows[0]!.patterns)).toBe(true);
    expect(rows[0]!.patterns).toEqual(PATTERNS);
  });

  test('an unchanged scorecard makes no model call and writes no row; a changed input regenerates', async () => {
    await expectUnchangedSkip(engine, 'calib/seed-postgres');
  });
});
