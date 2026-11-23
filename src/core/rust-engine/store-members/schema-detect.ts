/**
 * The `gbrain schema detect` page-shape reads (src/core/engine-sql/schema-detect.ts), served from the Rust store
 * (rust/crates/gbrain-store/src/schema_detect.rs): `pageTypeTotals`, `pagePrefixSamples` and
 * `countPagesByTypeForSource`. See rust/docs/store/schema_detect.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const pageTypeTotals: Member<'pageTypeTotals'> = (brain, sourceId) =>
  storeCall({ member: 'pageTypeTotals' }, () => brain.pageTypeTotals({ sourceId }));

export const pagePrefixSamples: Member<'pagePrefixSamples'> = (brain, sourceId, minPages, limit) =>
  storeCall({ member: 'pagePrefixSamples' }, () => brain.pagePrefixSamples({ sourceId, minPages, limit }));

export const countPagesByTypeForSource: Member<'countPagesByTypeForSource'> = (brain, sourceId, limit) =>
  storeCall({ member: 'countPagesByTypeForSource' }, () => brain.countPagesByTypeForSource({ sourceId, limit }));
