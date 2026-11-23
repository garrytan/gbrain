/**
 * The twin-merge moves on the Rust store (engine-sql/twin-merge-moves.ts): `moveTwinRelationships`,
 * `moveTwinPageChildren`, `moveTwinFacts` (repair_twin_merge.rs) and `movePageVersions` (the moved-pages fold's version
 * move, repair_versions.rs). Each is one store write that runs inside the engine's transaction. Ids come back as numbers;
 * the relationship keys, the moved link ids, the moved tags (the twin's tag order) and the moved fact ids come back in the
 * store's own deterministic order, where the SQL engines' order is unspecified. `mergeTwinInto` runs them on a Rust brain
 * together with the fact rekey members (ontology-repair.ts).
 * rust/docs/store/repair-bookkeeping.md.
 */
import type { RelationshipKey } from '../../link-relationships.ts';
import type { TwinMergeIds, TwinPageChildrenMove, TwinRelationshipMoves } from '../../engine-sql/twin-merge-moves.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const pageId = (member: string, name: string, value: number): number => {
  if (!Number.isInteger(value)) refuseMember(member, `${name} is not an integer page id`);
  return value;
};

const keys = (rows: unknown): RelationshipKey[] => (rows as RelationshipKey[]).map(row => ({
  from_page_id: Number(row.from_page_id), to_page_id: Number(row.to_page_id), link_type: row.link_type,
}));

export const movePageVersions: StoreMember<[fromPageId: number, toPageId: number], number[]> = async (brain, fromPageId, toPageId) =>
  ((await storeCall({ member: 'movePageVersions' }, () => brain.movePageVersions(fromPageId, toPageId))) as unknown[]).map(Number);

export const moveTwinRelationships: StoreMember<[ids: TwinMergeIds], TwinRelationshipMoves> = async (brain, ids) => {
  const sent = { twinId: pageId('moveTwinRelationships', 'twinId', ids.twinId), survivorId: pageId('moveTwinRelationships', 'survivorId', ids.survivorId) };
  const moved = await storeCall({ member: 'moveTwinRelationships' }, () => brain.moveTwinRelationships(sent)) as
    { before: unknown; after: unknown; linksMoved: unknown[]; transitionsMoved: number; deduplicated: number };
  return { before: keys(moved.before), after: keys(moved.after), linksMoved: moved.linksMoved.map(Number),
    transitionsMoved: Number(moved.transitionsMoved), deduplicated: Number(moved.deduplicated) };
};

export const moveTwinPageChildren: StoreMember<[move: TwinPageChildrenMove], string[]> = async (brain, move) => {
  const sent = { twinId: pageId('moveTwinPageChildren', 'twinId', move.twinId), survivorId: pageId('moveTwinPageChildren', 'survivorId', move.survivorId),
    sourceId: move.sourceId, twinSlug: move.twinSlug, survivorSlug: move.survivorSlug };
  return await storeCall({ member: 'moveTwinPageChildren', sourceId: move.sourceId }, () => brain.moveTwinPageChildren(sent)) as string[];
};

export const moveTwinFacts: StoreMember<[sourceId: string, twinSlug: string, survivorSlug: string], number[]> = async (brain, sourceId, twinSlug, survivorSlug) =>
  ((await storeCall({ member: 'moveTwinFacts', sourceId }, () => brain.moveTwinFacts(sourceId, twinSlug, survivorSlug))) as unknown[]).map(Number);
