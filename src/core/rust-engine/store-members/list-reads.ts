/**
 * The page-list, slug-source, access and connector-status reads whose SQL ran in their callers through executeRaw
 * (engine-sql/list-reads.ts and the domain files named per member). Store side: rust/docs/store/list-reads.md.
 * readRetainedSources is the connector status's "retained" flag (persistence/connector-status.ts).
 */
import type { PageReadPolicy } from '../../types.ts';
import type { CardListQuery, CardRow, CompanyBrainEvidenceRows, PageSourceIdRow, ShelfPageRow, TargetProbeSqlRow } from '../../engine-sql/list-reads.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/**
 * A caller's read policy as the store's page read scope (`pageReadFilter` with its live filter, search/read-policy-sql.ts):
 * the source scope, the page policy (`storePagePolicy`, a caller's reader identity and private-readable grant included),
 * the trust floor and the flag suppression. `requireSafeChunks` and `takesHoldersAllowList` are not part of the filter.
 */
function policyScope(member: string, policy: PageReadPolicy | undefined): Record<string, unknown> {
  if (policy === undefined || policy === null) return { live: true };
  const taken = takeOptions(member, policy, ['sourceId', 'sourceIds', 'excludePrivate', 'minTrust', 'suppressFlagged'], ['requireSafeChunks', 'takesHoldersAllowList']);
  return {
    sourceId: taken.sourceId, sourceIds: taken.sourceIds, live: true,
    excludePrivate: storePagePolicy(member, taken.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: taken.minTrust || null,
    suppressFlagged: taken.suppressFlagged === true,
  };
}

export const listLiveSlugSourceIds: StoreMember<[slug: string], string[]> = async (brain, slug) =>
  (await storeCall({ member: 'listLiveSlugSourceIds' }, () => brain.listLiveSlugSourceIds(slug))) as string[];

export const readRetainedSources: StoreMember<[sourceIds: readonly string[]], string[]> = async (brain, sourceIds) =>
  (await storeCall({ member: 'readRetainedSources' }, () => brain.readRetainedSources([...sourceIds]))) as string[];

export const resolveChainAnchorRows: StoreMember<[slug: string, policy: PageReadPolicy], PageSourceIdRow[]> = async (brain, slug, policy) => {
  const rows = (await storeCall({ member: 'resolveChainAnchorRows' }, () => brain.resolveChainAnchorRows(slug, policyScope('resolveChainAnchorRows', policy)))) as PageSourceIdRow[];
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id }));
};

export const probeTargetRows: StoreMember<[slug: string, policy: PageReadPolicy, chunkManifest?: boolean], TargetProbeSqlRow[]> = async (brain, slug, policy, chunkManifest = true) =>
  (await storeCall({ member: 'probeTargetRows' }, () => brain.probeTargetRows(slug, policyScope('probeTargetRows', policy), chunkManifest !== false))) as TargetProbeSqlRow[];

export const readCompanyBrainEvidenceRows: StoreMember<[sourceId: string], CompanyBrainEvidenceRows> = async (brain, sourceId) =>
  (await storeCall({ member: 'readCompanyBrainEvidenceRows' }, () => brain.readCompanyBrainEvidenceRows(sourceId))) as CompanyBrainEvidenceRows;

export const listCardRows: StoreMember<[query: CardListQuery], { total: number; cards: CardRow[] }> = async (brain, query) => {
  const { sourceId, type, filters, policy, limit, offset } = takeOptions('listCardRows', query, ['sourceId', 'type', 'filters', 'policy', 'limit', 'offset']);
  const list = (await storeCall({ member: 'listCardRows' }, () => brain.listCardRows({
    sourceId, pageType: type, limit: Number(limit), offset: Number(offset),
    filters: takeOptions('listCardRows', filters ?? {}, ['store', 'status', 'onSourceMachine']),
    scope: policyScope('listCardRows', policy as PageReadPolicy | undefined),
  }))) as { total: number; cards: CardRow[] };
  return { total: Number(list.total), cards: list.cards };
};

export const readShelfPageRows: StoreMember<[sourceId: string], ShelfPageRow[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'readShelfPageRows' }, () => brain.readShelfPageRows(sourceId))) as ShelfPageRow[];
