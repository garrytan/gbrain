/**
 * The `gbrain schema detect` page-shape reads (src/core/engine-sql/schema-detect.ts), served from the Rust store
 * (rust/crates/gbrain-store/src/schema_detect.rs): `pageTypeTotals`, `pagePrefixSamples` and
 * `countPagesByTypeForSource`, and the schema-pack path-prefix probes `countLivePagesAtPathPrefix` and
 * `probeUntypedPathPrefix`. See rust/docs/store/schema_detect.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const pageTypeTotals: Member<'pageTypeTotals'> = (brain, sourceId) =>
  storeCall({ member: 'pageTypeTotals' }, () => brain.pageTypeTotals({ sourceId }));

/** The schema-pack path-prefix probes (schema_detect.rs): LIKE '<prefix>%' over every live page's source path. */
export const countLivePagesAtPathPrefix: Member<'countLivePagesAtPathPrefix'> = (brain, prefix) =>
  storeCall({ member: 'countLivePagesAtPathPrefix' }, () => brain.countLivePagesAtPathPrefix({ prefix })) as Promise<number>;

export const probeUntypedPathPrefix: Member<'probeUntypedPathPrefix'> = (brain, prefix, sourceId) =>
  storeCall({ member: 'probeUntypedPathPrefix', sourceId }, () => brain.probeUntypedPathPrefix({ prefix, sourceId: sourceId || null })) as Promise<{ count: number; sample: string[] }>;

export const pagePrefixSamples: Member<'pagePrefixSamples'> = (brain, sourceId, minPages, limit) =>
  storeCall({ member: 'pagePrefixSamples' }, () => brain.pagePrefixSamples({ sourceId, minPages, limit }));

export const countPagesByTypeForSource: Member<'countPagesByTypeForSource'> = (brain, sourceId, limit) =>
  storeCall({ member: 'countPagesByTypeForSource' }, () => brain.countPagesByTypeForSource({ sourceId, limit }));
