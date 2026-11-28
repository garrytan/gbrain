/**
 * The page seal read of the import path (BrainEngine getPageSealState), served by gbrain-store `import_members`.
 */
import { storeCall, type StoreMember } from './common.ts';

/** `{ chunker_version }` of a live, unsegmented page (0 when it has none), or null. */
export const getPageSealState: StoreMember<[pageId: number], { chunker_version: number | null } | null> = async (brain, pageId) => {
  const version = await storeCall({ member: 'getPageSealState' }, () => brain.getPageSealState(pageId)) as number | null;
  return version === null ? null : { chunker_version: version };
};
