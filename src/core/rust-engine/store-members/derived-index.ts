/**
 * The keyword index's doctor check and rebuild on the Rust engine (rust/crates/gbrain-store/src/keyword/index_health.rs;
 * rust/docs/store/keyword.md, "Doctor"): what `gbrain doctor` reports as `rust_derived_indexes` and what
 * `gbrain doctor --fix` runs. The core term postings are not checked or rebuilt.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = NonNullable<BrainEngine[K]> extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const checkDerivedIndexes: Member<'checkDerivedIndexes'> = async (brain, opts) =>
  storeCall({ member: 'checkDerivedIndexes' }, () => brain.checkDerivedIndexes(opts?.maxPages ?? null));

export const rebuildDerivedIndexes: Member<'rebuildDerivedIndexes'> = async (brain) =>
  storeCall({ member: 'rebuildDerivedIndexes' }, () => brain.rebuildDerivedIndexes());
