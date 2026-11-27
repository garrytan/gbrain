/**
 * Group 5 facts members, the plain reads of a purge's scan and receipt (src/core/engine-sql/facts-purge.ts), served from
 * the facts store (rust/crates/gbrain-store/src/facts/purge_receipt.rs).
 *
 * `readPurgeSourceLocalPath` and `readPurgeReceiptSourcePath` read the source's checkout through the store's
 * `readSourceLocalPath`. `vacuumPurgedTables` has nothing to compact in a store and resolves once the store is open. A
 * number that PGLite binds as `LIMIT` or `int[]` and the store cannot read the same way (a fraction, a negative limit)
 * refuses rather than guess at PGLite's cast error. `listNearestFactsForPurge` is the probe's vector read.
 * `listBeliefEventsForPurgeProbe` is served by belief-purge.ts, as a keyset read of the store's `belief_events`.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** A `LIMIT` the store reads: a non-negative integer. */
function requireCount(member: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) refuseMember(member, 'a limit that is not a non-negative integer');
}

export const readPurgeReceiptSourcePath: Member<'readPurgeReceiptSourcePath'> = (brain, sourceId) =>
  storeCall({ member: 'readPurgeReceiptSourcePath' }, () => brain.readSourceLocalPath(sourceId));

export const listFactContextsForPurgeProbe: Member<'listFactContextsForPurgeProbe'> = (brain, sourceId, after) =>
  storeCall({ member: 'listFactContextsForPurgeProbe' }, () => brain.listFactContextsForPurgeProbe({ sourceId, after }));

/** `withQueryCache` names a table the store does not keep; the store has nothing to vacuum either way. */
export const vacuumPurgedTables: Member<'vacuumPurgedTables'> = (brain) =>
  storeCall({ member: 'vacuumPurgedTables' }, async () => { await brain.vacuumPurgedTables(); });

export const listPageProseHits: Member<'listPageProseHits'> = (brain, store, sourceId, loweredNeedles) =>
  storeCall({ member: 'listPageProseHits' }, () => brain.listPageProseHits({ store, sourceId, needles: loweredNeedles }));

export const countPurgeFingerprintResidue: Member<'countPurgeFingerprintResidue'> = (brain, sourceId, factHash, subject) =>
  storeCall({ member: 'countPurgeFingerprintResidue' }, () => brain.countPurgeFingerprintResidue({ sourceId, factHash, subject }));

