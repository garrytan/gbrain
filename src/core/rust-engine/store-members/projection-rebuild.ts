/**
 * A page's chunk reseal members (src/core/engine-sql/projection-rebuild.ts), served from
 * rust/crates/gbrain-store/src/persistence/projection_rebuild.rs: readChunkKeepState, clearUnkeptChunkVectors and
 * countPendingTextChunks. Each member sends the arguments of its BrainEngine member.
 *
 * The store keeps one vector column, `embedding`, so each member refuses any other column.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Projection reseal").
 */
import type { BrainEngine } from '../../engine.ts';
import type { KeepColumn } from '../../engine-sql/projection-rebuild.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function keepColumn(member: string, column: KeepColumn): { dimensions: number } {
  if (column.name !== 'embedding') refuseMember(member, `column ${column.name}; the store keeps embedding only`);
  return { dimensions: column.dimensions };
}

export const readChunkKeepState: Member<'readChunkKeepState'> = (brain, pageId, provenanceModel, column) => {
  const { dimensions } = keepColumn('readChunkKeepState', column);
  return storeCall({ member: 'readChunkKeepState' }, () => brain.readChunkKeepState(pageId, provenanceModel, dimensions));
};

export const clearUnkeptChunkVectors: Member<'clearUnkeptChunkVectors'> = async (brain, pageId, provenanceModel, column, currentIds) => {
  const { dimensions } = keepColumn('clearUnkeptChunkVectors', column);
  await storeCall({ member: 'clearUnkeptChunkVectors' }, () =>
    brain.clearUnkeptChunkVectors(pageId, provenanceModel, dimensions, [...currentIds]));
};

export const countPendingTextChunks: Member<'countPendingTextChunks'> = (brain, pageId, column) => {
  keepColumn('countPendingTextChunks', column);
  return storeCall({ member: 'countPendingTextChunks' }, () => brain.countPendingTextChunks(pageId));
};
