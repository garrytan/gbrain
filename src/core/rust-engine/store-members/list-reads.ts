/**
 * The page-list, slug-source, access and connector-status reads whose SQL ran in their callers through executeRaw
 * (engine-sql/list-reads.ts and the domain files named per member). Store side: rust/docs/store/list-reads.md.
 * readRetainedSources is the connector status's "retained" flag (persistence/connector-status.ts).
 */
import type { PageReadPolicy } from '../../types.ts';
import type { AttendanceWindowRow, CardFindQuery, CardHitRow, CardListQuery, ChatCensusRow, PredictionLedgerEvent, PredictionQuery, PredictionRow, TakeGradeRow, TakeHorizonRow, WhoCanReadRow, CardRow, CompanyBrainEvidenceRows, MentionScanLinkRow, MentionScanPageRow, PageBodyRow, PageSourceIdRow, RetypeProbeQuery, ShelfPageRow, SourceIdScope, TargetProbeSqlRow } from '../../engine-sql/list-reads.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { memberAccessPolicy } from './access-policies.ts';
import { storePagePolicy, storePageTextPolicy } from './private-provenance.ts';
import { currentCallerAccess, privatePagesFilterFragment, sqlAppliedSets } from '../../search/private-visibility.ts';
import type { OwnerOnlyForm } from '../../access/owner-only.ts';
import type { BeliefCoverageEventRow } from '../../engine-sql/belief-ledger.ts';

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

/**
 * The chat census. The SQL engines filter with `privatePagesFilterFragmentFast`, which never reads the caller: it is the
 * no-caller private-page rule (`privatePagesFilterFragment`) with a cheap first test for pages every rule admits, so the
 * store applies that rule's page policy (`noReaders`).
 */
export const readChatCensusRows: StoreMember<[sourceIds: readonly string[], chatTypes: readonly string[], dmTypes: readonly string[], hidePrivate: boolean], ChatCensusRow[]> = async (brain, sourceIds, chatTypes, dmTypes, hidePrivate) => {
  const excludePrivate = hidePrivate ? storePageTextPolicy('readChatCensusRows', () => privatePagesFilterFragment('p'), { noReaders: true, fragment: 'plain' }) : null;
  return (await storeCall({ member: 'readChatCensusRows' }, () => brain.readChatCensusRows({ sourceIds: [...sourceIds], chatTypes: [...chatTypes], dmTypes: [...dmTypes], excludePrivate }))) as ChatCensusRow[];
};

export const readWhoCanReadRows: StoreMember<[slug: string, sourceId: string | undefined, form: OwnerOnlyForm], WhoCanReadRow[]> = async (brain, slug, sourceId, form) =>
  (await storeCall({ member: 'readWhoCanReadRows' }, () => brain.readWhoCanReadRows(slug, sourceId || null, form === 'closed' ? 'closed' : 'fn'))) as WhoCanReadRow[];

/**
 * The SQL empties a whole identity or satisfied set when any entry of it is invalid (readersAllowedSql, folderRulesAllowedSql), so
 * both members send the store the sets the SQL applies (`sqlAppliedSets`), never the raw ones: the store matches entries one by one.
 * An identity emptied that way is judged by the store with no satisfied rules, as `satisfiedFor` does for an empty identity.
 */
export const readPageAccessAllowed: StoreMember<[sourceId: string, slug: string, identity: readonly string[]], boolean> = async (brain, sourceId, slug, identity) => {
  const access = currentCallerAccess();
  const applied = sqlAppliedSets(identity, access.satisfiedRuleIds);
  const policy = memberAccessPolicy(applied.identity, applied.satisfiedRuleIds, identity);
  return (await storeCall({ member: 'readPageAccessAllowed' }, () => brain.readPageAccessAllowed(sourceId, slug, applied.identity, policy))) === true;
};

export const readPageFolderRulesAllowed: StoreMember<[sourceId: string, slug: string, satisfied: readonly string[]], boolean> = async (brain, sourceId, slug, satisfied) => {
  const { satisfiedRuleIds } = sqlAppliedSets([], satisfied);
  const policy = memberAccessPolicy(null, satisfiedRuleIds);
  return (await storeCall({ member: 'readPageFolderRulesAllowed' }, () => brain.readPageFolderRulesAllowed(sourceId, slug, satisfiedRuleIds, policy))) === true;
};

export const countLineageClosingRules: StoreMember<[ruleIds: readonly string[], sourceId: string], number> = async (brain, ruleIds, sourceId) =>
  Number(await storeCall({ member: 'countLineageClosingRules' }, () => brain.countLineageClosingRules([...ruleIds], sourceId)));

/**
 * The store's op checkpoint record of (op, fingerprint) as its completed-keys array: `brain.readOpCheckpointRecords` reads
 * the first completed key (`completed_keys->0`); the connector cursor rows hold exactly one, so the array is that key.
 */
export const readOpCheckpointCompletedKeys: StoreMember<[op: string, fingerprint: string], unknown[] | null> = async (brain, op, fingerprint) => {
  const found = (await storeCall({ member: 'readOpCheckpointCompletedKeys' }, () => brain.readOpCheckpointRecords(op, [fingerprint]))) as unknown[];
  return found.length ? (found[0] === null ? [] : [found[0]]) : null;
};

export const readForecastPredictions: StoreMember<[q: PredictionQuery], PredictionRow[]> = async (brain, q) => {
  const { sourceIds, holder, about, since, until } = takeOptions('readForecastPredictions', q, ['sourceIds', 'holder', 'about', 'since', 'until']);
  return (await storeCall({ member: 'readForecastPredictions' }, () => brain.readForecastPredictions({ sourceIds, holder, about, since, until }))) as PredictionRow[];
};

export const readPredictionLedgerEvents: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], PredictionLedgerEvent[]> = async (brain, sourceIds, slugs) =>
  (await storeCall({ member: 'readPredictionLedgerEvents' }, () => brain.readPredictionLedgerEvents([...sourceIds], [...slugs]))) as PredictionLedgerEvent[];

/**
 * No horizons and no grades: the store keeps no `take_horizons` or `take_grade_cache` rows. Their writers
 * (`gbrain takes horizon set|clear|scan --apply`, the grade_takes cycle phase, `gbrain calibration --undo-wave`) run raw
 * SQL, which a Rust brain refuses with engine_capability_missing, so no such row can exist.
 */
export const readTakeHorizonRows: StoreMember<[takeIds: readonly number[] | null], TakeHorizonRow[]> = async () => [];
export const readLatestTakeGrades: StoreMember<[takeIds: readonly number[]], TakeGradeRow[]> = async () => [];

export const readBeliefCoverageEvents: StoreMember<[sourceId: string], BeliefCoverageEventRow[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'readBeliefCoverageEvents' }, () => brain.readBeliefCoverageEvents(sourceId))) as BeliefCoverageEventRow[];

export const findCardRows: StoreMember<[q: CardFindQuery], CardHitRow[]> = async (brain, q) => {
  const { sourceId, type, query, aliasNorm, terms, filters, policy } = takeOptions('findCardRows', q, ['sourceId', 'type', 'query', 'aliasNorm', 'terms', 'filters', 'policy']);
  return (await storeCall({ member: 'findCardRows' }, () => brain.findCardRows({
    sourceId, pageType: type, query, aliasNorm, terms: [...(terms as string[])],
    filters: takeOptions('findCardRows', filters ?? {}, ['store', 'status', 'onSourceMachine']),
    scope: policyScope('findCardRows', policy as PageReadPolicy | undefined),
  }))) as CardHitRow[];
};
