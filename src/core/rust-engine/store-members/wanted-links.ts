/**
 * Wanted-link writes (BrainEngine lockRegisteredSourceIds and replaceWantedLinkRows), served by gbrain-store
 * `wanted_links`, and the wanted-pages read (BrainEngine listWantedPages, napi `brain.listWantedPages`). The store
 * returns rows already in WantedPageRow shape; `excludePrivate: true` stays a typed refusal (the store has no
 * visibility filter), so callers that need it keep the SQL path.
 * Keys, cascade and what the store refuses: rust/docs/store/wanted-links.md.
 */
import type { WantedLinkRowsReplacement } from '../../engine.ts';
import type { WantedPageRow } from '../../engine-sql/cli-reads-ops.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const lockRegisteredSourceIds: StoreMember<[sourceIds: readonly string[]], string[]> = async (brain, sourceIds) =>
  sourceIds.length === 0 ? [] : storeCall({ member: 'lockRegisteredSourceIds' }, () => brain.lockRegisteredSourceIds([...sourceIds]));

export const replaceWantedLinkRows: StoreMember<[origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement], number> =
  (brain, origin, replacement) =>
    storeCall({ member: 'replaceWantedLinkRows', sourceId: origin.sourceId }, () => brain.replaceWantedLinkRows(
      { pageId: origin.pageId, sourceId: origin.sourceId },
      { rows: [...replacement.rows], producers: [...replacement.producers], readAt: replacement.readAt ?? null }));

type WantedPagesOptions = { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number };

export const listWantedPages: StoreMember<[opts: WantedPagesOptions], { total: number; rows: WantedPageRow[] }> = (brain, opts) => {
  const query = takeOptions('listWantedPages', opts, ['sourceId', 'sourceIds', 'limit', 'offset']);
  return storeCall({ member: 'listWantedPages' }, () => brain.listWantedPages(query));
};
