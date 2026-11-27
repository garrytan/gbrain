/**
 * Wanted-link writes (BrainEngine lockRegisteredSourceIds and replaceWantedLinkRows), served by gbrain-store
 * `wanted_links`. Keys, cascade and what the store refuses: rust/docs/store/wanted-links.md.
 */
import type { WantedLinkRowsReplacement } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

export const lockRegisteredSourceIds: StoreMember<[sourceIds: readonly string[]], string[]> = async (brain, sourceIds) =>
  sourceIds.length === 0 ? [] : storeCall({ member: 'lockRegisteredSourceIds' }, () => brain.lockRegisteredSourceIds([...sourceIds]));

export const replaceWantedLinkRows: StoreMember<[origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement], number> =
  (brain, origin, replacement) =>
    storeCall({ member: 'replaceWantedLinkRows', sourceId: origin.sourceId }, () => brain.replaceWantedLinkRows(
      { pageId: origin.pageId, sourceId: origin.sourceId },
      { rows: [...replacement.rows], producers: [...replacement.producers], readAt: replacement.readAt ?? null }));
