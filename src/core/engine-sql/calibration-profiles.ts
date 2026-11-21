/**
 * The `calibration_profiles` table (decide family, group B): the profile `gbrain calibration` and the MCP
 * `get_calibration_profile` op read, the row the `calibration_profile` cycle phase writes (and the "has anything
 * changed" check in front of it), the brainstorm health and orchestrator reads of a profile's bias tags, the
 * calibration freshness and voice-gate doctor reads, and the undo-wave delete. SQL once for both engines, so a store
 * that is not SQL serves the same members (rust/docs/store/calibration-profiles.md).
 *
 * Each statement is the one its caller ran through `executeRaw`. Optional filters are `$n IS NULL OR ...` terms of one
 * static statement, never composed text. Two edges the old statements left to the planner are fixed so the engines
 * agree: the newest row ties on `generated_at` break by `id DESC`, and `id` comes back as text (the callers coerced the
 * BIGSERIAL to a string).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The columns `gbrain calibration` reads. `id` is the BIGSERIAL as text; `generated_at` is a `Date`. */
export interface CalibrationProfileRow {
  id: string;
  source_id: string;
  holder: string;
  wave_version: string;
  generated_at: Date;
  published: boolean;
  total_resolved: number;
  brier: number | null;
  accuracy: number | null;
  partial_rate: number | null;
  grade_completion: number;
  pattern_statements: string[];
  active_bias_tags: string[];
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
  model_id: string;
}

/**
 * Which profile to read. `holder` unset reads any holder. `sourceIds` (when set, even empty: an empty list matches
 * nothing) wins over `sourceId`; an empty `sourceId` is no filter.
 */
export interface LatestCalibrationProfileSpec {
  holder?: string;
  sourceId?: string;
  sourceIds?: readonly string[];
}

/** One profile row as the cycle phase writes it; `cost_usd` and `judge_model_agreement` are always NULL. */
export interface CalibrationProfileInsert {
  sourceId: string;
  holder: string;
  totalResolved: number;
  brier: number | null;
  accuracy: number | null;
  partialRate: number | null;
  gradeCompletion: number;
  /** Written as JSONB (`$n::text::jsonb` of the serialized object). */
  domainScorecards: Record<string, unknown>;
  patternStatements: readonly string[];
  voiceGatePassed: boolean;
  voiceGateAttempts: number;
  activeBiasTags: readonly string[];
  modelId: string;
  /** The phase leaves these three to the column defaults (`now()`, the wave this table shipped in, false). */
  generatedAt?: Date;
  waveVersion?: string;
  published?: boolean;
}

/** The scorecard and model of the latest stored profile, to compare with a fresh scorecard. */
export interface CalibrationProfileUnchangedSpec {
  sourceId: string;
  holder: string;
  totalResolved: number;
  brier: number | null;
  accuracy: number | null;
  partialRate: number | null;
  modelId: string;
}

/** Profiles generated in the last 7 days, and how many of them fell back to the template (voice gate failed). */
export interface VoiceGateHealth {
  total: number;
  failures: number;
}

/** The newest profile (`generated_at DESC`, then `id DESC`) the filter allows, or null. */
export async function getLatestCalibrationProfile(tx: Raw, spec: LatestCalibrationProfileSpec): Promise<CalibrationProfileRow | null> {
  const sourceIds = spec.sourceIds ? [...spec.sourceIds] : null;
  const sourceId = sourceIds === null && spec.sourceId ? spec.sourceId : null;
  const rows = await tx.executeRaw<CalibrationProfileRow>(
    `SELECT id::text AS id, source_id, holder, wave_version, generated_at, published,
            total_resolved, brier, accuracy, partial_rate, grade_completion,
            pattern_statements, active_bias_tags,
            voice_gate_passed, voice_gate_attempts, model_id
       FROM calibration_profiles
      WHERE ($1::text IS NULL OR holder = $1)
        AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))
        AND ($3::text IS NULL OR source_id = $3)
      ORDER BY generated_at DESC, id DESC LIMIT 1`,
    [spec.holder ?? null, sourceIds, sourceId],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, id: String(row.id), generated_at: row.generated_at instanceof Date ? row.generated_at : new Date(row.generated_at) };
}

/**
 * Whether the latest profile of the source and holder (`generated_at DESC, id DESC`) already holds this scorecard and
 * model. The REAL columns compare as `$n::real`; a missing profile reads as false.
 */
export async function isCalibrationProfileUnchanged(tx: Raw, spec: CalibrationProfileUnchangedSpec): Promise<boolean> {
  const rows = await tx.executeRaw<{ unchanged: boolean | null }>(
    `SELECT COALESCE(total_resolved = $3 AND brier IS NOT DISTINCT FROM $4::real AND accuracy IS NOT DISTINCT FROM $5::real
                AND partial_rate IS NOT DISTINCT FROM $6::real AND model_id = $7, false) AS unchanged
       FROM calibration_profiles WHERE source_id = $1 AND holder = $2
      ORDER BY generated_at DESC, id DESC LIMIT 1`,
    [spec.sourceId, spec.holder, spec.totalResolved, spec.brier, spec.accuracy, spec.partialRate, spec.modelId],
  );
  return rows[0]?.unchanged === true;
}

/** Insert one profile. A source that does not exist, or a column out of range, refuses as the table's constraints do. */
export async function insertCalibrationProfile(tx: Raw, row: CalibrationProfileInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO calibration_profiles (
       source_id, holder, generated_at, published,
       total_resolved, brier, accuracy, partial_rate, grade_completion,
       domain_scorecards, pattern_statements,
       voice_gate_passed, voice_gate_attempts,
       active_bias_tags, model_id, cost_usd, judge_model_agreement, wave_version
     ) VALUES ($1, $2, COALESCE($14::timestamptz, now()), COALESCE($15::boolean, false),
               $3, $4, $5, $6, $7,
               $8::text::jsonb, $9::text[],
               $10, $11,
               $12::text[], $13, NULL, NULL, COALESCE($16::text, 'v0.36.1.0'))`,
    [
      row.sourceId,
      row.holder,
      row.totalResolved,
      row.brier,
      row.accuracy,
      row.partialRate,
      row.gradeCompletion,
      JSON.stringify(row.domainScorecards),
      [...row.patternStatements],
      row.voiceGatePassed,
      row.voiceGateAttempts,
      [...row.activeBiasTags],
      row.modelId,
      row.generatedAt ?? null,
      row.published ?? null,
      row.waveVersion ?? null,
    ],
  );
}

/** The doctor's voice-gate read: profiles of the last 7 days (of `sourceIds` when set; an empty list matches nothing). */
export async function readVoiceGateHealth(tx: Raw, spec: { sourceIds?: readonly string[] }): Promise<VoiceGateHealth> {
  const rows = await tx.executeRaw<{ total: number | string; failures: number | string }>(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(CASE WHEN voice_gate_passed = false THEN 1 ELSE 0 END), 0)::int AS failures
       FROM calibration_profiles
      WHERE generated_at >= (now() - INTERVAL '7 days')
        AND ($1::text[] IS NULL OR source_id = ANY($1::text[]))`,
    [spec.sourceIds ? [...spec.sourceIds] : null],
  );
  return { total: Number(rows[0]?.total ?? 0), failures: Number(rows[0]?.failures ?? 0) };
}

/** `undo-wave`: how many profiles a wave wrote (`dryRun`), or delete them and say how many went. */
export async function purgeCalibrationProfilesByWave(tx: Raw, spec: { waveVersion: string; dryRun: boolean }): Promise<number> {
  if (spec.dryRun) {
    const counted = await tx.executeRaw<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM calibration_profiles WHERE wave_version = $1`,
      [spec.waveVersion],
    );
    return Number(counted[0]?.count ?? 0);
  }
  const deleted = await tx.executeRaw<{ id: number | string }>(
    `DELETE FROM calibration_profiles WHERE wave_version = $1 RETURNING id`,
    [spec.waveVersion],
  );
  return deleted.length;
}
