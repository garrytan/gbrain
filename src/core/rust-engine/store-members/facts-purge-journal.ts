/**
 * Group 5 facts members, the purge statements over the write journal and the change-reason tombstones
 * (src/core/engine-sql/facts-purge.ts), served from the facts store (rust/crates/gbrain-store/src/facts/purge_journal.rs).
 *
 * The Git effect reads take no row lock: a store write runs alone. A page id that PGLite binds as `int` and the store
 * cannot read the same way (a fraction) refuses rather than guess at PGLite's cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readDeletePageRequest: Member<'readDeletePageRequest'> = (brain, sourceId, requestId) =>
  storeCall({ member: 'readDeletePageRequest' }, () => brain.readDeletePageRequest({ sourceId, requestId }));

export const listPurgeEffects: Member<'listPurgeEffects'> = (brain, requestId) =>
  storeCall({ member: 'listPurgeEffects' }, () => brain.listPurgeEffects({ requestId }));
