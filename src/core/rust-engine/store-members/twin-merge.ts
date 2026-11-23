/**
 * The row moves of the twin merge (engine-sql/twin-merge.ts), served from twin_merge.rs: listPageRelationshipKeys,
 * moveTwinRelations, moveTwinPageRows, moveTwinFacts and recordSlugRename. Each is one store write (or read), so a
 * refusal keeps nothing; the fact move goes through the store's fact writer, so the trust stamp, the withdrawal guard
 * and the unique indexes run as their triggers and indexes do on SQL.
 *
 * A page id binds as `int` on SQL, so an id that is not a positive integer refuses rather than guess at its cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function pageIds(member: string, ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id) || id <= 0) refuseMember(member, 'a page id that is not a positive integer');
  return [...ids];
}

export const listPageRelationshipKeys: Member<'listPageRelationshipKeys'> = (brain, ids) =>
  storeCall({ member: 'listPageRelationshipKeys' }, () => brain.listPageRelationshipKeys(pageIds('listPageRelationshipKeys', ids)));

export const moveTwinRelations: Member<'moveTwinRelations'> = (brain, twinId, survivorId) => {
  pageIds('moveTwinRelations', [twinId, survivorId]);
  return storeCall({ member: 'moveTwinRelations' }, () => brain.moveTwinRelations(twinId, survivorId));
};

export const moveTwinPageRows: Member<'moveTwinPageRows'> = (brain, pair) => {
  pageIds('moveTwinPageRows', [pair.twinId, pair.survivorId]);
  return storeCall({ member: 'moveTwinPageRows' }, () => brain.moveTwinPageRows({ sourceId: pair.sourceId, twinId: pair.twinId,
    survivorId: pair.survivorId, twinSlug: pair.twinSlug, survivorSlug: pair.survivorSlug }));
};

export const moveTwinFacts: Member<'moveTwinFacts'> = (brain, sourceId, twinSlug, survivorSlug) =>
  storeCall({ member: 'moveTwinFacts' }, () => brain.moveTwinFacts(sourceId, twinSlug, survivorSlug));

export const recordSlugRename: Member<'recordSlugRename'> = async (brain, sourceId, oldSlug, newSlug) => {
  await storeCall({ member: 'recordSlugRename' }, () => brain.recordSlugRename(sourceId, oldSlug, newSlug));
};
