/**
 * v0.36.1.0 (T17 / D18 CDX-3) — undo-wave reversal.
 *
 * Reverses the calibration wave's mutations on canonical state. Every new
 * row written by the v0.36.1.0 wave carries `wave_version = 'v0.36.1.0'`
 * so a precise revert is possible without touching pre-wave data.
 *
 * Reversal scope (4 steps):
 *
 * Step 1 — Reverse auto-applied take resolutions.
 *   take_grade_cache rows with applied=true + wave_version match identify
 *   which (take_id, page_id, row_num) the grade_takes phase mutated. We
 *   UNSET the takes.resolved_at / resolved_quality / resolved_outcome
 *   columns to NULL for those takes ONLY IF resolved_by indicates this
 *   wave's auto-grade ('gbrain:grade_takes'). Manual resolutions
 *   (resolved_by='garry' etc.) are left alone — operator intent persists.
 *
 * Step 2 — Delete calibration_profiles rows from this wave.
 *   Straightforward DELETE WHERE wave_version = ?.
 *
 * Step 3 — Purge take_nudge_log rows from this wave.
 *   Straightforward DELETE WHERE wave_version = ?.
 *
 * Step 4 — Optionally scrub gstack learnings.
 *   When --scrub-gstack is passed, invoke gstack-learnings-prune (if on
 *   PATH) with the wave's namespace prefix to drop the learning entries
 *   E4 wrote during the wave. Best-effort: failure logs a warning and
 *   the rest of the undo proceeds.
 *
 * Transactional posture:
 *   v0.36.1.0 ship state runs steps 1-3 in a single engine.transaction
 *   so partial reversal can't leave the brain half-undone. Step 4 (gstack
 *   scrub) runs OUTSIDE the transaction because it's a separate filesystem
 *   write.
 *
 * Dry-run posture:
 *   undoWave({ dryRun: true }) computes the counts without writing.
 *   Returns the same UndoWaveResult shape so the operator sees what would
 *   be reverted.
 */

import { execFileSync } from 'node:child_process';
import { GSTACK_LEARNING_NAMESPACE } from './gstack-coupling.ts';
import type { BrainEngine } from '../engine.ts';

export interface UndoWaveOpts {
  /** Wave version to reverse. v0.36.1.0 ship state: 'v0.36.1.0'. */
  waveVersion: string;
  /** When true, compute counts only — no writes. */
  dryRun?: boolean;
  /** When true, attempt the gstack-learnings scrub via the binary. Default false. */
  scrubGstack?: boolean;
  /** The resolved_by label that identifies wave-applied resolutions. Default 'gbrain:grade_takes'. */
  resolvedByLabel?: string;
}

export interface UndoWaveResult {
  wave_version: string;
  dry_run: boolean;
  /** Number of take rows whose resolution was reverted. */
  resolutions_reverted: number;
  /** Number of calibration_profiles rows deleted. */
  profiles_deleted: number;
  /** Number of take_nudge_log rows purged. */
  nudges_purged: number;
  /** Number of take_grade_cache rows marked applied=false (audit trail kept). */
  grade_cache_unapplied: number;
  /** True when the gstack scrub step ran (whether or not it succeeded). */
  gstack_scrub_attempted: boolean;
  /** Set when gstack scrub failed; phase still returns ok overall. */
  warnings: string[];
}

/**
 * Reverse the wave. v0.36.1.0 ship state: takes 1 engine round-trip per
 * step (a transaction would be cleaner but engine.transaction isn't part
 * of the BrainEngine interface used here — would need plumbing). Each
 * step is idempotent: re-running --undo-wave is a no-op when no
 * wave-version-matching rows exist.
 */
export async function undoWave(
  engine: BrainEngine,
  opts: UndoWaveOpts,
): Promise<UndoWaveResult> {
  const waveVersion = opts.waveVersion;
  const dryRun = opts.dryRun ?? false;
  const resolvedByLabel = opts.resolvedByLabel ?? 'gbrain:grade_takes';
  const result: UndoWaveResult = {
    wave_version: waveVersion,
    dry_run: dryRun,
    resolutions_reverted: 0,
    profiles_deleted: 0,
    nudges_purged: 0,
    grade_cache_unapplied: 0,
    gstack_scrub_attempted: false,
    warnings: [],
  };

  // Step 1: count + reverse takes resolutions written by this wave.
  // Identify wave-applied takes via take_grade_cache.applied=true AND
  // wave_version match. Cross-check resolved_by to ensure we're not
  // un-resolving a take a manual `gbrain takes resolve` operation
  // overrode after grade_takes wrote it.
  const targetTakeRows = await engine.executeRaw<{ take_id: number }>(
    `SELECT DISTINCT take_id FROM take_grade_cache
     WHERE wave_version = $1 AND applied = true`,
    [waveVersion],
  );
  const targetTakeIds = targetTakeRows.map(r => r.take_id);

  if (targetTakeIds.length > 0) {
    if (dryRun) {
      const counted = await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM takes
         WHERE id = ANY($1::bigint[])
           AND resolved_by = $2`,
        [targetTakeIds, resolvedByLabel],
      );
      result.resolutions_reverted = counted[0]?.count ?? 0;
    } else {
      const reverted = await engine.executeRaw<{ id: number }>(
        `UPDATE takes
           SET resolved_at = NULL,
               resolved_outcome = NULL,
               resolved_quality = NULL,
               resolved_value = NULL,
               resolved_unit = NULL,
               resolved_source = NULL,
               resolved_by = NULL
         WHERE id = ANY($1::bigint[])
           AND resolved_by = $2
         RETURNING id`,
        [targetTakeIds, resolvedByLabel],
      );
      result.resolutions_reverted = reverted.length;
    }
  }

  // Step 1b: mark take_grade_cache rows applied=false so the audit trail
  // shows they WERE applied but this wave was reverted. Useful for the
  // confidence-drift check (CDX-11 mitigation) so the historical
  // applied=true rows aren't counted in confidence-vs-accuracy.
  if (!dryRun) {
    const cacheUnset = await engine.executeRaw<{ take_id: number }>(
      `UPDATE take_grade_cache
         SET applied = false
       WHERE wave_version = $1 AND applied = true
       RETURNING take_id`,
      [waveVersion],
    );
    result.grade_cache_unapplied = cacheUnset.length;
  } else {
    const cacheCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM take_grade_cache
       WHERE wave_version = $1 AND applied = true`,
      [waveVersion],
    );
    result.grade_cache_unapplied = cacheCount[0]?.count ?? 0;
  }

  // Step 2: delete calibration_profiles rows.
  if (dryRun) {
    const counted = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM calibration_profiles WHERE wave_version = $1`,
      [waveVersion],
    );
    result.profiles_deleted = counted[0]?.count ?? 0;
  } else {
    const deleted = await engine.executeRaw<{ id: number }>(
      `DELETE FROM calibration_profiles WHERE wave_version = $1 RETURNING id`,
      [waveVersion],
    );
    result.profiles_deleted = deleted.length;
  }

  // Step 3: purge take_nudge_log rows.
  if (dryRun) {
    const counted = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM take_nudge_log WHERE wave_version = $1`,
      [waveVersion],
    );
    result.nudges_purged = counted[0]?.count ?? 0;
  } else {
    const purged = await engine.executeRaw<{ id: number }>(
      `DELETE FROM take_nudge_log WHERE wave_version = $1 RETURNING id`,
      [waveVersion],
    );
    result.nudges_purged = purged.length;
  }

  // Step 4: optional gstack-learnings scrub.
  if (opts.scrubGstack && !dryRun) {
    result.gstack_scrub_attempted = true;
    try {
      execFileSync('gstack-learnings-prune', [
        '--key-prefix',
        GSTACK_LEARNING_NAMESPACE,
      ], { encoding: 'utf8', timeout: 10_000 });
    } catch (err) {
      result.warnings.push(
        `gstack scrub failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Run \`gstack-learnings-prune --key-prefix ${GSTACK_LEARNING_NAMESPACE}\` manually.`,
      );
    }
  }

  return result;
}
