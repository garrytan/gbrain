/**
 * The decide family statements of BrainEngine: calibration profiles, proposals and the decide store.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as CalibrationProfilesSql from '../engine-sql/calibration-profiles.ts';

export interface DecideMembers {
  // Decide family, group B: calibration profiles (engine-sql/calibration-profiles.ts).
  /** The newest calibration profile (`generated_at DESC`, then `id DESC`) of `holder` (any holder when unset) in `sourceIds` (an empty list matches nothing) or else `sourceId`; null when none. `id` is the BIGSERIAL as text. */
  getLatestCalibrationProfile(spec: CalibrationProfilesSql.LatestCalibrationProfileSpec): Promise<CalibrationProfilesSql.CalibrationProfileRow | null>;
  /** Insert one calibration profile (the `calibration_profile` cycle phase's write). The source must exist; `generatedAt`, `waveVersion` and `published` default to now, `v0.36.1.0` and false. */
  insertCalibrationProfile(row: CalibrationProfilesSql.CalibrationProfileInsert): Promise<void>;
  /** `undo-wave`: how many profiles `waveVersion` wrote (`dryRun`), or delete them and return how many went. */
  purgeCalibrationProfilesByWave(spec: { waveVersion: string; dryRun: boolean }): Promise<number>;
}
