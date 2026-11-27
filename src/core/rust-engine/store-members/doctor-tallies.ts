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
