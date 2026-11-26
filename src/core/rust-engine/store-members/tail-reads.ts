/**
 * The last family-tail reads (rust/crates/gbrain-store/src/tail_reads.rs): the scoped contradiction reader's live
 * re-reads (listLiveChunksByIds, listLiveTakesByIds, src/core/engine-sql/contradictions-cycle.ts) and the version
 * history's page read (readPagesForVersionHistory, src/core/engine-sql/admin-reads.ts). rust/docs/store/tail_reads.md
 * maps each statement.
 *
 * The page policy crosses as the chunk family's wire scope: the source filter, under `excludePrivate` the store page
 * policy (storePagePolicy, caller readers included), and the page trust floor and flag suppression. The SQL engines bind
 * chunk ids as `int[]` and take and page ids as `bigint[]`; an id that does not fit is refused rather than guessed at.
 *
 * Export only BrainEngine members from this file (index.ts spreads the module into STORE_MEMBERS); helpers stay
 * unexported.
 */
import type * as AdminReadsSql from '../../engine-sql/admin-reads.ts';
import type * as ContradictionsCycleSql from '../../engine-sql/contradictions-cycle.ts';
import type { TrustTier } from '../../trust/tier.ts';
import type { PageReadPolicy } from '../../types.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/** The `PageReadScope` keys `pageReadFilter` reads. */
const SCOPE_KEYS = ['sourceId', 'sourceIds', 'excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;
const INT32_MAX = 2 ** 31 - 1;

/** Ids for an `int[]` bind (`int32`) or a `bigint[]` bind. */
function boundIds(member: string, ids: readonly number[], int32: boolean): number[] {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || (int32 && Math.abs(id) > INT32_MAX)) {
      refuseMember(member, `an id that is not a ${int32 ? '32' : '64'}-bit integer`);
    }
  }
  return [...ids];
}

/** The wire scope of `pageReadFilter(.., live = true)`; `minTrust` replaces the policy's page floor when given. */
function wireScope(member: string, o: Record<string, unknown>, minTrust: unknown) {
  return {
    sourceId: o.sourceId,
    sourceIds: o.sourceIds,
    excludePrivate: storePagePolicy(member, o.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: (minTrust as string | undefined) || null,
    suppressFlagged: o.suppressFlagged === true,
  };
}

const numbered = <T extends { id: number | string; page_id?: number | string }>(r: T): T =>
  ({ ...r, id: Number(r.id), ...(r.page_id === undefined ? {} : { page_id: Number(r.page_id) }) });

export const listLiveChunksByIds: StoreMember<
  [ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined], ContradictionsCycleSql.LiveChunkRow[]
> = async (brain, ids, policy, floor) => {
  // `pageReadFilter` never reads the holder allow-list, so the chunk re-read ignores it as the SQL does.
  const o = takeOptions('listLiveChunksByIds', policy, SCOPE_KEYS, ['takesHoldersAllowList']);
  const input = {
    ids: boundIds('listLiveChunksByIds', ids, true),
    scope: wireScope('listLiveChunksByIds', o, floor || o.minTrust),
    requireSafeChunks: requiresSafeChunks(o as PageReadPolicy),
  };
  const rows: ContradictionsCycleSql.LiveChunkRow[] = await storeCall({ member: 'listLiveChunksByIds' },
    () => brain.listLiveChunksByIds(input));
  return rows.map(numbered);
};

export const listLiveTakesByIds: StoreMember<
  [ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined], ContradictionsCycleSql.LiveTakeRow[]
> = async (brain, ids, policy, floor) => {
  // The take re-read adds no safe-chunk fence: `requireSafeChunks` is never read there.
  const o = takeOptions('listLiveTakesByIds', policy, [...SCOPE_KEYS, 'takesHoldersAllowList']);
  const holders = o.takesHoldersAllowList;
  const input = {
    ids: boundIds('listLiveTakesByIds', ids, false),
    scope: wireScope('listLiveTakesByIds', o, o.minTrust),
    // A null list binds `= ANY(NULL)` in the SQL engines: it admits no holder, as an empty list does.
    holders: holders === undefined ? null : ((holders as unknown[] | null) ?? []).map(String),
    floor: floor || null,
  };
  const rows: ContradictionsCycleSql.LiveTakeRow[] = await storeCall({ member: 'listLiveTakesByIds' },
    () => brain.listLiveTakesByIds(input));
  return rows.map(r => ({ ...numbered(r), row_num: Number(r.row_num) }));
};

export const readPagesForVersionHistory: StoreMember<[pageIds: number[]], AdminReadsSql.VersionPageRow[]> =
  async (brain, pageIds) => {
    const ids = boundIds('readPagesForVersionHistory', pageIds, false);
    const rows: AdminReadsSql.VersionPageRow[] = await storeCall({ member: 'readPagesForVersionHistory' },
      () => brain.readPagesForVersionHistory(ids));
    return rows.map(numbered);
  };
