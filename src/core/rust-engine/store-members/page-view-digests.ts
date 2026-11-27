/**
 * The read-view digest cache of a segmented page (src/core/engine-sql/page-view-digests.ts) on a Rust brain.
 *
 * The store keeps no `page_view_digests` rows, so the cache is a permanent miss and a write stores nothing: a reader
 * recomputes the digest from the stored segments each time, which is what an empty cache does on a SQL brain. Nothing
 * a purge would have to delete is kept either (the fact purge's deletePageViewDigests has no rows to reach here).
 * The answers are the cache's own contract, not a refusal: the cache never changes what a read returns, only how
 * much it recomputes.
 */
import type { BrainEngine } from '../../engine.ts';
import type { StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The store keeps no digest cache, so no view is ever cached. */
export const readPageViewDigest: Member<'readPageViewDigest'> = async () => null;

/** The store keeps no digest cache, so there is nothing to store and no older revision to drop. */
export const writePageViewDigest: Member<'writePageViewDigest'> = async () => {};
