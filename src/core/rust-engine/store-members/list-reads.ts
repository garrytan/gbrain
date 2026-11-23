/**
 * The page-list, slug-source, access and connector-status reads whose SQL ran in their callers through executeRaw
 * (engine-sql/list-reads.ts and the domain files named per member). Store side: rust/docs/store/list-reads.md.
 * readRetainedSources is the connector status's "retained" flag (persistence/connector-status.ts).
 */
import type { PageReadPolicy } from '../../types.ts';
import type { AttendanceWindowRow, CardListQuery, CardRow, CompanyBrainEvidenceRows, MentionScanLinkRow, MentionScanPageRow, PageBodyRow, PageSourceIdRow, RetypeProbeQuery, ShelfPageRow, SourceIdScope, TargetProbeSqlRow } from '../../engine-sql/list-reads.ts';
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

export const readFirstLiveSlugAtPath: StoreMember<[path: string], string | null> = async (brain, path) =>
  ((await storeCall({ member: 'readFirstLiveSlugAtPath' }, () => brain.readFirstLiveSlugAtPath(path))) as string | null) || null;

export const listPathTwinSlugs: StoreMember<[sourceId: string, paths: readonly string[]], Array<{ source_path: string; slugs: string[] }>> = async (brain, sourceId, paths) =>
  (await storeCall({ member: 'listPathTwinSlugs' }, () => brain.listPathTwinSlugs(sourceId, [...paths]))) as Array<{ source_path: string; slugs: string[] }>;

export const listLiveSlugOrigins: StoreMember<[slugs: readonly string[], sourceId?: string], Array<{ slug: string; source_path: string | null }>> = async (brain, slugs, sourceId) =>
  (await storeCall({ member: 'listLiveSlugOrigins' }, () => brain.listLiveSlugOrigins([...slugs], sourceId ?? null))) as Array<{ slug: string; source_path: string | null }>;

export const probeRetypeRows: StoreMember<[query: RetypeProbeQuery], { count: number; sample: string[] }> = async (brain, query) => {
  const taken = takeOptions('probeRetypeRows', query, ['fromType', 'pathFilter', 'slugFilter', 'sourceId']);
  // The SQL skips a filter whose value is empty, so an empty pattern or source filters nothing.
  const probe = (await storeCall({ member: 'probeRetypeRows' }, () => brain.probeRetypeRows({ fromType: taken.fromType,
    pathFilter: taken.pathFilter || null, slugFilter: taken.slugFilter || null, sourceId: taken.sourceId || null }))) as { count: number; sample: string[] };
  return { count: Number(probe.count), sample: probe.sample };
};

export const listAliasCandidatePages: StoreMember<[type: string, sourceId: string, limit: number], PageBodyRow[]> = async (brain, type, sourceId, limit) =>
  (await storeCall({ member: 'listAliasCandidatePages' }, () => brain.listAliasCandidatePages(type, sourceId, limit))) as PageBodyRow[];

export const listLinkCandidatePages: StoreMember<[type: string, sourceId: string | undefined, limit: number], PageBodyRow[]> = async (brain, type, sourceId, limit) =>
  (await storeCall({ member: 'listLinkCandidatePages' }, () => brain.listLinkCandidatePages(type, sourceId || null, limit))) as PageBodyRow[];

export const countLivePagesByType: StoreMember<[scope: SourceIdScope], Array<{ type: string | null; n: string }>> = async (brain, scope) =>
  (await storeCall({ member: 'countLivePagesByType' }, () => brain.countLivePagesByType(takeOptions('countLivePagesByType', scope, ['sourceId', 'sourceIds'])))) as Array<{ type: string | null; n: string }>;

export const listTypeOrphanRows: StoreMember<[scope: SourceIdScope, undeclared: readonly string[], limit: number], Array<{ slug: string; source_id: string; type: string | null }>> = async (brain, scope, undeclared, limit) =>
  (await storeCall({ member: 'listTypeOrphanRows' }, () => brain.listTypeOrphanRows(takeOptions('listTypeOrphanRows', scope, ['sourceId', 'sourceIds']), [...undeclared], limit))) as Array<{ slug: string; source_id: string; type: string | null }>;

export const readStaleMentionScan: StoreMember<[limit: number], { pages: MentionScanPageRow[]; links: MentionScanLinkRow[] }> = async (brain, limit) =>
  (await storeCall({ member: 'readStaleMentionScan' }, () => brain.readStaleMentionScan(limit))) as { pages: MentionScanPageRow[]; links: MentionScanLinkRow[] };

export const readClockMillisText: StoreMember<[], string> = async (brain) =>
  (await storeCall({ member: 'readClockMillisText' }, () => brain.readClockMillisText())) as string;

export const listLiveSourceIncarnations: StoreMember<[ids: readonly string[]], Array<{ id: string; incarnation: string }>> = async (brain, ids) =>
  (await storeCall({ member: 'listLiveSourceIncarnations' }, () => brain.listLiveSourceIncarnations([...ids]))) as Array<{ id: string; incarnation: string }>;

export const readAttendanceWindow: StoreMember<[sourceId: string, afterSlug: string, limit: number], AttendanceWindowRow[]> = async (brain, sourceId, afterSlug, limit) =>
  (await storeCall({ member: 'readAttendanceWindow' }, () => brain.readAttendanceWindow(sourceId, afterSlug, limit))) as AttendanceWindowRow[];

export const listEmailAliasPages: StoreMember<[aliasNorm: string, sourceId: string], Array<{ slug: string; source_id: string }>> = async (brain, aliasNorm, sourceId) =>
  (await storeCall({ member: 'listEmailAliasPages' }, () => brain.listEmailAliasPages(aliasNorm, sourceId))) as Array<{ slug: string; source_id: string }>;

/**
 * No upload session: the store keeps no `page_body_stagings` row of kind `upload` (the session insert of
 * persistence/page-upload.ts runs raw SQL, which a Rust brain refuses), so no session exists to find.
 */
export const readUploadSessionByRequest: StoreMember<[principalKind: string, principalId: string, clientRequestId: string], Record<string, unknown> | null> = async () => null;

export const readSourceIncarnationArchived: StoreMember<[sourceId: string], { incarnation: string; archived: boolean } | null> = async (brain, sourceId) => {
  const row = (await storeCall({ member: 'readSourceIncarnationArchived' }, () => brain.readSourceState(sourceId))) as { incarnation: string; archived: boolean } | null;
  return row ? { incarnation: row.incarnation, archived: row.archived } : null;
};

/** The store's member records (every member not removed, `brain.readAccessMembers`) that are labelled-only and enabled, by id in byte order. */
export const listEnabledLabelledOnlyMemberIds: StoreMember<[], string[]> = async (brain) => {
  const rows = (await storeCall({ member: 'listEnabledLabelledOnlyMemberIds' }, () => brain.readAccessMembers({}))) as
    Array<{ id: string; labelled_only: boolean; disabled_at: unknown; tombstoned_at: unknown }>;
  return rows.filter(r => r.labelled_only === true && r.disabled_at == null && r.tombstoned_at == null).map(r => r.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
