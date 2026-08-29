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

const patternsGenerator: PatternStatementsGenerator = async () => PATTERNS;
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

async function runPhase(engine: BrainEngine) {
  return runPhaseCalibrationProfile(buildCtx(engine), {
    holder: HOLDER,
    patternsGenerator,
    biasTagsGenerator,
    voiceGateJudge: passJudge,
  });
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
});
