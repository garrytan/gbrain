/**
 * The scoped contradiction reader's live re-reads (BrainEngine listLiveChunksByIds, listLiveTakesByIds; SQL in
 * src/core/engine-sql/contradictions-cycle.ts). The read policy crosses as the chunk reads' page scope (chunk-queries.ts):
 * the source filter, the store page policy under `excludePrivate` (storePagePolicy, caller readers included), the page
 * trust floor and flag suppression, and the safe-chunk fence of a chunk read. A take adds its holder allow-list, its own
 * owner-only form under `excludePrivate` and its row floor. Contract: rust/docs/store/live-rereads.md.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { LiveChunkRow, LiveTakeRow } from '../../engine-sql/contradictions-cycle.ts';
import type { PageReadPolicy } from '../../types.ts';
import type { TrustTier } from '../../trust/tier.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import { ownerOnlyTakeAllowedSql } from '../../search/private-visibility.ts';
import { ownerOnlyFormIn, storePagePolicy } from './private-provenance.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

const SCOPE_KEYS = ['sourceId', 'sourceIds', 'excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;

/** The page scope of `pageReadFilter(p, policy, live)`; `minTrust` is the page floor the statement applies. */
function pageScope(member: string, o: Record<string, unknown>, minTrust: unknown, safe: boolean) {
  return {
    sourceId: o.sourceId,
    sourceIds: o.sourceIds,
    excludePrivate: storePagePolicy(member, o.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: (minTrust as string | undefined) || null,
    suppressFlagged: o.suppressFlagged === true,
    requireSafeChunks: safe,
  };
}

const ids = (values: readonly number[]) => values.map(Number);

export const listLiveChunksByIds: StoreMember<[ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined], LiveChunkRow[]> =
  async (brain, chunkIds, policy, floor) => {
    // pageReadFilter never reads the holder allow-list, so the SQL engines ignore it here.
    const o = takeOptions('listLiveChunksByIds', policy, [...SCOPE_KEYS], ['takesHoldersAllowList']);
    if (chunkIds.length === 0) return [];
    // The statement merges the call's floor over the policy's own (`{ ...policy, minTrust: floor }`).
    const scope = pageScope('listLiveChunksByIds', o, floor || o.minTrust, requiresSafeChunks(policy));
    return storeCall({ member: 'listLiveChunksByIds' }, () => brain.listLiveChunksByIds({ ids: ids(chunkIds), scope }));
  };

export const listLiveTakesByIds: StoreMember<[ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined], LiveTakeRow[]> =
  async (brain, takeIds, policy, floor) => {
    // pageReadFilter never reads the safe-chunk fence, so a take re-read ignores it.
    const o = takeOptions('listLiveTakesByIds', policy, [...SCOPE_KEYS, 'takesHoldersAllowList']);
    if (takeIds.length === 0) return [];
    const holders = o.takesHoldersAllowList as string[] | undefined;
    const input = {
      ids: ids(takeIds),
      scope: pageScope('listLiveTakesByIds', o, o.minTrust, false),
      holders: holders === undefined ? null : [...holders],
      ownerOnly: o.excludePrivate ? ownerOnlyFormIn(ownerOnlyTakeAllowedSql('t'), 'takes', 't') : 'off',
      floor: floor || null,
    };
    return storeCall({ member: 'listLiveTakesByIds' }, () => brain.listLiveTakesByIds(input));
  };
