/**
 * The page seal read of the import path (BrainEngine getPageSealState), served by gbrain-store `import_members`.
 */
import { storeCall, type StoreMember } from './common.ts';
import type { ChunkMove } from '../../page-state/chunk-moves.ts';

/** `{ chunker_version }` of a live, unsegmented page (0 when it has none), or null. */
export const getPageSealState: StoreMember<[pageId: number], { chunker_version: number | null } | null> = async (brain, pageId) => {
  const version = await storeCall({ member: 'getPageSealState' }, () => brain.getPageSealState(pageId)) as number | null;
  return version === null ? null : { chunker_version: version };
};

/** Each wave goes to the store with only the columns the UPDATE reads: the id, the target and the span. */
export const moveChunkIndexes: StoreMember<[pageId: number, waves: readonly (readonly ChunkMove[])[]], void> = async (brain, pageId, waves) => {
  await storeCall({ member: 'moveChunkIndexes' }, () => brain.moveChunkIndexes(pageId, waves.map(wave => wave.map(move => ({
    id: move.id, to: move.to, projected_byte_start: move.projected_byte_start ?? null, projected_byte_end: move.projected_byte_end ?? null,
  })))));
};
