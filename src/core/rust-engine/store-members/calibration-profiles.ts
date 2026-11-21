/**
 * Calibration profile members (BrainEngine getLatestCalibrationProfile, isCalibrationProfileUnchanged,
 * insertCalibrationProfile, readVoiceGateHealth, purgeCalibrationProfilesByWave). The store keeps the
 * `calibration_profiles` rows (rust/docs/store/calibration-profiles.md); timestamps cross the binding as ISO strings
 * and come back as `Date`s, and `id` is text.
 */
import type {
  CalibrationProfileInsert, CalibrationProfileRow, CalibrationProfileUnchangedSpec, LatestCalibrationProfileSpec, VoiceGateHealth,
} from '../../engine-sql/calibration-profiles.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

export const getLatestCalibrationProfile: StoreMember<[spec: LatestCalibrationProfileSpec], CalibrationProfileRow | null> = async (brain, spec) => {
  // `sourceIds` (even empty) wins over `sourceId`, and an empty `sourceId` is no filter, as the SQL reads them.
  const scope = {
    holder: spec.holder ?? undefined,
    sourceIds: spec.sourceIds ? [...spec.sourceIds] : undefined,
    sourceId: spec.sourceIds ? undefined : spec.sourceId || undefined,
  };
  const row: CalibrationProfileRow | null = await storeCall({ member: 'getLatestCalibrationProfile' }, () => brain.getLatestCalibrationProfile(scope));
  return row ? withDates(row, ['generated_at']) : null;
};

export const isCalibrationProfileUnchanged: StoreMember<[spec: CalibrationProfileUnchangedSpec], boolean> = (brain, spec) =>
  storeCall({ member: 'isCalibrationProfileUnchanged' }, () => brain.isCalibrationProfileUnchanged(spec));

export const insertCalibrationProfile: StoreMember<[row: CalibrationProfileInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertCalibrationProfile' }, () => brain.insertCalibrationProfile({
    ...row,
    generatedAt: row.generatedAt instanceof Date ? row.generatedAt.toISOString() : row.generatedAt,
  }));
};

export const readVoiceGateHealth: StoreMember<[spec: { sourceIds?: readonly string[] }], VoiceGateHealth> = (brain, spec) =>
  storeCall({ member: 'readVoiceGateHealth' }, () => brain.readVoiceGateHealth(spec.sourceIds ? [...spec.sourceIds] : undefined));

export const purgeCalibrationProfilesByWave: StoreMember<[spec: { waveVersion: string; dryRun: boolean }], number> = (brain, spec) =>
  storeCall({ member: 'purgeCalibrationProfilesByWave' }, () => brain.purgeCalibrationProfilesByWave(spec.waveVersion, spec.dryRun));
