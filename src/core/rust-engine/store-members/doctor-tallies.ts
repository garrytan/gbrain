/**
 * The doctor tallies (src/core/engine-sql/doctor-tallies.ts) on the Rust engine, served from the store
 * (rust/crates/gbrain-store/src/cli_reads/doctor_tallies.rs, rust/docs/store/cli-reads-doctor-tallies.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const countLiveSegmentedPages: Member<'countLiveSegmentedPages'> = async (brain, opts) =>
  Number(await storeCall({ member: 'countLiveSegmentedPages' }, () => brain.countLiveSegmentedPages(opts?.projectionPending === true)));

export const countValidityLapsedFacts: Member<'countValidityLapsedFacts'> = async (brain) =>
  Number(await storeCall({ member: 'countValidityLapsedFacts' }, () => brain.countValidityLapsedFacts()));

export const countOrphanEventProjections: Member<'countOrphanEventProjections'> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countOrphanEventProjections' }, () => brain.countOrphanEventProjections(sourceIds ? [...sourceIds] : undefined)));

// The calibration doctor counts (src/core/engine-sql/doctor-reads.ts), served from the store
// (rust/crates/gbrain-store/src/cli_reads/doctor.rs, rust/docs/store/cli-reads-doctor.md). `[]` names no source.

export const countContextualCoverage: Member<'countContextualCoverage'> = async (brain, chunkerVersion, sourceIds) => {
  const row = await storeCall({ member: 'countContextualCoverage' }, () => brain.countContextualCoverage(chunkerVersion, sourceIds ? [...sourceIds] : undefined));
  return { chunker_drift: Number(row.chunker_drift), unsealed: Number(row.unsealed), unsealed_code: Number(row.unsealed_code), mode_null: Number(row.mode_null) };
};

export const countAbandonedTakes: Member<'countAbandonedTakes'> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countAbandonedTakes' }, () => brain.countAbandonedTakes(sourceIds ? [...sourceIds] : undefined)));

export const countAppliedTakeGrades: Member<'countAppliedTakeGrades'> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countAppliedTakeGrades' }, () => brain.countAppliedTakeGrades(sourceIds ? [...sourceIds] : undefined)));
