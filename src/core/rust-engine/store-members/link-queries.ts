/**
 * Link and graph members beyond the core links members: derived-link replacement (replaceDerivedLinks,
 * replaceDerivedLinksBatch), provenance-scoped deletes (removeLinksByPagesAndSource), provenance counts
 * (listLinkSources), the ranking signals (getBacklinkCounts, getAdjacencyBoosts), the relational walks
 * (relationalFanout, relationalChainHop), orphan detection (findOrphanPages), rewriteLinks (a no-op on every engine)
 * and the link reads of hybrid search's ranking stage (hasSupersedeEdges, supersedingPageSlugs, pagesLinkingTo; the
 * SQL is src/core/engine-sql/search-reads.ts), and the link reads of src/core/engine-sql/link-reads.ts (inboundLinkCoverage,
 * listJunkEntityHubs, countEntityPages, entityGraphCoverage, entityFeatureCoverage, countDatedMeetingPages, countForeignEdges, listLivePageSummaries, countInboundLinks, readEntityInboundEdges,
 * listLinkEndpointPages, listPagesTitledIn, probePageTypes, readLongPageSizes, wordLexemes, readLinkContextMatches, readLinkContextOriginPages).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 *
 * The store models the source filter, the page privacy policy (storePagePolicy), the trust floor and flag suppression
 * (`minTrust`, `suppressFlagged`: the page's stamped tier and its write-gate receipts) and the live test of the read
 * policy (src/core/search/read-policy-sql.ts). relationalFanout and relationalChainHop serve the temporal edge policy
 * (relationshipFilterSql, src/core/link-validity.ts) over the store's relationship rows, and also model `requireSafeChunks`
 * (the canonical chunk's safe fence and the chain's evidence text gate, `takesHoldersAllowList` included). A privacy
 * policy the store does not model or a temporal policy on another member refuses with `engine_capability_missing`. A derived-link
 * replacement serves every option PGLite takes: the origin snapshot and the line-grammar generation are checked before
 * the store call, and the wanted pages and the origin's temporal evidence (link-temporal-apply.ts) are written after it,
 * as separate store calls. See rust/docs/store/link_queries.md and rust/docs/store/link_temporal.md.
 */
import {
  DerivedLinkEndpointChangedError, DerivedLinkRepairRequiredError, DerivedLinkSettingsChangedError,
  type DerivedLinkBatchItem, type DerivedLinkOrigin, type DerivedLinkReplacementOptions,
} from '../../derived-links.ts';
import { sanitizeForJsonb } from '../../batch-rows.ts';
import { effectiveRangesEnabled, LINK_EXTRACTION_GENERATION_KEY } from '../../line-grammar.ts';
import type { RelationshipKey } from '../../link-relationships.ts';
import { relationshipFilterSql, type EdgeTemporalOpts } from '../../link-validity.ts';
import { applyTemporalEvidence } from '../../link-temporal-apply.ts';
import { possibleWantedRows } from '../../wanted-links-store.ts';
import type { LinkBatchInput } from '../../engine.ts';
import { assertPageRevision, PageRevisionConflictError, type PageSnapshot } from '../../page-state/types.ts';
import type {
  AdjacencyRow, ChainHopEdge, ChainHopOpts, PageReadPolicy, PageReadScope, RelationalFanoutOpts, RelationalFanoutRow,
} from '../../types.ts';
import type {
  EntityInboundEdgeRow, JunkEntityHubRow, LinkContextAsk, LinkContextMatch, LinkContextOriginPage, LinkEndpointPage, LivePageSummary,
  TitledPage,
} from '../../engine-sql/link-reads.ts';
import type { PageTypeProbe } from '../../engine-sql/cli-reads-ops.ts';
import type { LongPageSizeRow } from '../../search/long-page-sizes.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { CONNECTOR_SOURCE_KINDS } from '../../persistence/connector-kinds.ts';
import type { EntityTypeFilter } from '../../schema-pack/entity-types.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { getConfig } from './config.ts';
import { linkRelationshipKeysTouching, refreshOnStore, temporalStore } from './link-refresh.ts';
import { readPageSnapshot } from './pages.ts';
import { lockRegisteredSourceIds, replaceWantedLinkRows } from './wanted-links.ts';
import { HYBRID_BAG_KEYS, storePagePolicy } from './private-provenance.ts';
import { ownerWidened } from '../../search/private-visibility.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';

/** The read-policy keys the store models: the source filter. */
const SCOPE_KEYS = ['sourceId', 'sourceIds'] as const;
/** The source filter plus `excludePrivate`, the page policy `privatePagesFilterForCaller` (storePagePolicy). */
const POLICY_SCOPE_KEYS = [...SCOPE_KEYS, 'excludePrivate'] as const;
/**
 * Keys `pageReadFilter` never reads. The ranking reads ignore them, as the SQL engines do; the relational walks read
 * them for the canonical chunk's safe fence and relationalChainHop's evidence text gate (`chainTextGate`).
 */
const UNREAD_BY_FILTER = ['requireSafeChunks', 'takesHoldersAllowList'] as const;
/** `pageReadFilter`'s trust options: `pageEligibleSql` over the page's stamped tier and its write-gate receipts. */
const TRUST_KEYS = ['minTrust', 'suppressFlagged'] as const;
/** The policy keys plus the trust options, for the members whose SQL is `pageReadFilter` over the whole scope. */
const READ_SCOPE_KEYS = [...POLICY_SCOPE_KEYS, ...TRUST_KEYS] as const;
/** For relationalFanout the unread keys still turn the live filter on, through `hasReadPolicy`. */
const POLICY_KEYS = [...READ_SCOPE_KEYS, ...UNREAD_BY_FILTER] as const;
const INT32_MAX = 2 ** 31 - 1;

/** `hasReadPolicy` of read-policy-sql.ts over the options takeOptions kept (the refused keys are absent or false). */
function hasReadPolicy(opts: Record<string, unknown>): boolean {
  return !!((opts.sourceIds as unknown[] | undefined)?.length || opts.sourceId || opts.excludePrivate || opts.requireSafeChunks
    || opts.takesHoldersAllowList !== undefined || opts.minTrust || opts.suppressFlagged);
}

/** Ids the SQL engines cast to `int[]`: an id that is not an int4 is refused rather than guessed at. */
function int32Ids(member: string, ids: readonly number[], label?: string): number[] {
  for (const id of ids) {
    if (label && !Number.isSafeInteger(id)) throw new TypeError(`${label}: page id ${String(id)} is not an integer`);
    if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) refuseMember(member, 'a page id that is not a 32-bit integer');
  }
  return ids as number[];
}

/** A caller's reader identity and private-readable grant ride along in the page policy (storePagePolicy). */
const CALLER_READERS = { callerReaders: true } as const;

/** The wire scope: the source filter and, under `excludePrivate`, the store page policy (null otherwise). */
const scopeOf = (member: string, o: Record<string, unknown>) => ({
  sourceId: o.sourceId, sourceIds: o.sourceIds, excludePrivate: storePagePolicy(member, o.excludePrivate, CALLER_READERS) ?? null,
  minTrust: (o.minTrust as string | undefined) || null, suppressFlagged: o.suppressFlagged === true,
});

/**
 * `textGate` of readChainHop (src/core/search/read-enrichment.ts), decided here because it reads the caller: with
 * `requiresSafeChunks`, edge context needs a sealed evidence page with no facts / takes fence (`body`); the owner's own
 * direct call reads the stored context (ownerWidened), unless its credential names a holders list, which still skips
 * takes-bearing evidence (`takes`).
 */
function chainTextGate(opts: ChainHopOpts): 'body' | 'takes' | undefined {
  if (!requiresSafeChunks(opts)) return undefined;
  if (!ownerWidened()) return 'body';
  return opts.takesHoldersAllowList === undefined ? undefined : 'takes';
}

/**
 * The scope of a ranking read hybridSearch hands its whole option bag: the source filter, the page policy and the trust
 * options, plus the bag's own keys (ignored, as PGLite reads only the page policy out of the bag). `scoped` says a
 * policy object was passed at all, which turns on the live filter.
 */
function rankingScope(member: string, opts: PageReadPolicy | undefined): Record<string, unknown> {
  const options = takeOptions(member, opts, READ_SCOPE_KEYS, [...UNREAD_BY_FILTER, ...HYBRID_BAG_KEYS]);
  return { ...scopeOf(member, options), scoped: !!opts };
}

/**
 * Ids the SQL engines cast to `bigint[]`: a non-integer is refused (the cast fails there). An id below 1 or past
 * `Number.MAX_SAFE_INTEGER` names no page the store can hold, so it matches nothing, as in the SQL, and is dropped.
 */
function bigintIds(member: string, ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isInteger(id)) refuseMember(member, 'a page id that is not an integer');
  return ids.filter(id => id >= 1 && Number.isSafeInteger(id));
}

/** Ids already checked by `int32Ids`: an id below 1 names no page, so it matches nothing and is dropped. */
const pageIdsOnly = (ids: readonly number[]) => ids.filter(id => id >= 1);

// ---------------------------------------------------------------------------------------------------------------------
// Derived links
// ---------------------------------------------------------------------------------------------------------------------

/** `derivedLinkRows` of derived-links.ts (not exported there): the same checks, messages and normalization. */
function derivedLinkRows(origin: DerivedLinkOrigin, links: LinkBatchInput[], opts: DerivedLinkReplacementOptions) {
  const producers = ['markdown', 'wikilink-resolved', ...(opts.includeFrontmatter === false ? [] : ['frontmatter'])];
  const unique = new Map<string, LinkBatchInput>();
  for (const link of links) {
    const producer = link.link_source ?? 'markdown';
    if (!producers.includes(producer)) throw new TypeError(`Only selected derived link producers can be replaced (got: ${JSON.stringify(producer)}, allowed: ${producers.join(', ')})`);
    if ((link.origin_slug && link.origin_slug !== origin.slug)
      || (link.origin_source_id && link.origin_source_id !== origin.sourceId)) {
      throw new TypeError('Derived link origin does not match the replacement scope');
    }
    const reversedAttendance = (producer === 'markdown' || producer === 'wikilink-resolved') && link.link_type === 'attended'
      && link.origin_slug === origin.slug && link.origin_source_id === origin.sourceId
      && (link.from_slug !== origin.slug || (link.from_source_id ?? origin.sourceId) !== origin.sourceId)
      && link.to_slug === origin.slug && (link.to_source_id ?? origin.sourceId) === origin.sourceId;
    const row = { ...link, link_source: producer, origin_slug: producer === 'frontmatter' || reversedAttendance ? origin.slug : undefined, origin_source_id: origin.sourceId,
      from_source_id: link.from_source_id ?? origin.sourceId, to_source_id: link.to_source_id ?? origin.sourceId };
    if (producer !== 'frontmatter' && !reversedAttendance && (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId)) {
      throw new TypeError('Markdown links must originate at the replaced page');
    }
    if (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId) {
      if (row.to_slug !== origin.slug || row.to_source_id !== origin.sourceId) throw new TypeError('Derived links must reference their origin');
    }
    const key = JSON.stringify([row.from_source_id, row.from_slug, row.to_source_id, row.to_slug, row.link_type ?? '', producer]);
    if (!unique.has(key)) unique.set(key, row);
  }
  return { producers, rows: [...unique.values()] };
}

/**
 * One origin as the store reads it. `lineGrammar`, `wanted` and `temporalBody` are applied around the store call
 * (prepareDerived, finishDerived); `semanticsPrimed` changes nothing here, since the relation semantics live in this
 * process.
 */
function derivedItem(member: string, origin: DerivedLinkOrigin, links: LinkBatchInput[], opts: DerivedLinkReplacementOptions | undefined) {
  const options = takeOptions(member, opts, ['includeFrontmatter', 'preserveExisting', 'includeLegacyNullProducer', 'expectedEndpoints',
    'lineGrammar', 'wanted', 'temporalBody'], ['semanticsPrimed']) as DerivedLinkReplacementOptions;
  const { producers, rows } = derivedLinkRows(origin, links, opts ?? {});
  return {
    origin: { slug: origin.slug, sourceId: origin.sourceId, expectedRevision: origin.expectedRevision ?? undefined, sourceIncarnation: origin.sourceIncarnation },
    producers,
    rows,
    includeFrontmatter: options.includeFrontmatter !== false,
    preserveExisting: !!options.preserveExisting,
    includeLegacyNullProducer: options.includeLegacyNullProducer !== false,
    expectedEndpoints: options.expectedEndpoints ?? [],
  };
}

/** The `invalid_state` prefixes the store's derived-link checks reject with, mapped onto the SQL engines' errors. */
const DERIVED_ERRORS: Record<string, () => Error> = {
  bad_revision: () => new TypeError('expectedRevision must be a UUID revision'),
  origin_changed: () => new Error('Derived link origin changed or was deleted'),
  provenance_required: () => new DerivedLinkRepairRequiredError(),
  endpoint_missing: () => new DerivedLinkEndpointChangedError('A derived link endpoint changed or was deleted'),
  endpoint_changed: () => new DerivedLinkEndpointChangedError('A derived link endpoint changed after type resolution'),
  attendance_origin: () => new TypeError('Canonical attendance requires a meeting origin and revision-bound person endpoints'),
  attendance_person: () => new TypeError('Canonical attendance requires person endpoints'),
  not_persisted: () => new Error('Derived link replacement did not persist every candidate'),
};

type Counts = { created: number; removed: number };

/** The origin read and its relationship keys, taken before the store call; null when there is no origin to publish. */
type Prepared = { snapshot: PageSnapshot; keysBefore: RelationshipKey[] };

/**
 * The checks PGLite runs under its guards before publishing (derived-links.ts): the line-grammar generation, then the
 * origin read (the caller's snapshot or a fresh one) against the expected revision and incarnation. The store checks
 * the origin again inside its call. Also reads the origin's relationship keys before the write.
 */
async function prepareDerived(brain: StoreBrain, origins: DerivedLinkOrigin[], opts: Array<DerivedLinkReplacementOptions | undefined>): Promise<Prepared[]> {
  if (opts.some(o => o?.lineGrammar)) {
    const generation = await getConfig(brain, LINK_EXTRACTION_GENERATION_KEY);
    if (opts.some(o => o?.lineGrammar && o.lineGrammar.generation !== (generation ?? null))) throw new DerivedLinkSettingsChangedError();
  }
  const temporal = temporalStore(brain);
  const prepared: Prepared[] = [];
  for (const origin of origins) {
    const snapshot = origin.snapshot !== undefined ? origin.snapshot : await readPageSnapshot(brain, origin.slug, { sourceId: origin.sourceId });
    assertPageRevision(snapshot, { expectedRevision: origin.expectedRevision });
    if (!snapshot || snapshot.sourceIncarnation !== origin.sourceIncarnation || snapshot.page.deleted_at) {
      throw new Error('Derived link origin changed or was deleted');
    }
    prepared.push({ snapshot, keysBefore: await temporal.linkRelationshipKeysForOrigin(Number(snapshot.page.id)) });
  }
  return prepared;
}

/** After the store call: the origin's wanted pages, then its temporal evidence and relationship state. */
async function finishDerived(brain: StoreBrain, prepared: Prepared, item: ReturnType<typeof derivedItem>, opts: DerivedLinkReplacementOptions | undefined): Promise<void> {
  const { snapshot, keysBefore } = prepared;
  const pageId = Number(snapshot.page.id);
  const sourceId = item.origin.sourceId;
  const wanted = opts?.wanted;
  if (wanted?.producers.length) {
    if (!wanted.readAt && wanted.rows.some(row => row.ref_kind === 'name')) {
      throw new Error('replaceWantedLinks: name rows need the readAt taken before the extraction read');
    }
    const rows = (await possibleWantedRows({ lockRegisteredSourceIds: ids => lockRegisteredSourceIds(brain, ids) }, sourceId,
      wanted.rows.filter(row => wanted.producers.includes(row.producer)))).map(row => ({ ...row, context: sanitizeForJsonb(row.context) }));
    await replaceWantedLinkRows(brain, { pageId, sourceId }, { rows, producers: wanted.producers, readAt: wanted.readAt });
  }
  const inlineRanges = opts?.lineGrammar ? opts.lineGrammar.effectiveRanges : await effectiveRangesEnabled({ getConfig: key => getConfig(brain, key) });
  await applyTemporalEvidence(temporalStore(brain), snapshot.page, item.rows, keysBefore, { inlineRanges, body: opts?.temporalBody });
}

/** One store call for every origin (one transaction); a rejection maps onto the error the SQL engines throw. */
async function publish(brain: StoreBrain, member: string, origins: DerivedLinkOrigin[], items: ReturnType<typeof derivedItem>[]): Promise<Counts[]> {
  try {
    return await brain.replaceDerivedLinks(items);
  } catch (error) {
    const code = storeErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'revision_conflict') {
      const m = /item=(\d+) current=(\S+)/.exec(message);
      if (m) {
        const current = m[2] === 'null' ? null : m[2]!;
        throw new PageRevisionConflictError(origins[Number(m[1])]?.expectedRevision, current);
      }
    }
    if (code === 'invalid_state') {
      const make = DERIVED_ERRORS[message.split(':')[0]!];
      if (make) throw make();
    }
    throw mapStoreError(error, { member });
  }
}

export const replaceDerivedLinks: StoreMember<[origin: DerivedLinkOrigin, links: LinkBatchInput[], opts?: DerivedLinkReplacementOptions], Counts> =
  async (brain, origin, links, opts) => {
    // Wanted rows lock registered sources (lockRegisteredSourceIds) after the store publish commits: assert first, so a
    // store without serialized_transactions refuses before the replacement is written.
    if (opts?.wanted?.producers.length) assertStoreSerializedTransactions(brain, 'replaceDerivedLinks.wanted');
    const item = derivedItem('replaceDerivedLinks', origin, links, opts);
    const [prepared] = await prepareDerived(brain, [origin], [opts]);
    const [result] = await publish(brain, 'replaceDerivedLinks', [origin], [item]);
    await finishDerived(brain, prepared!, item, opts);
    return result!;
  };

export const replaceDerivedLinksBatch: StoreMember<[items: readonly DerivedLinkBatchItem[]], Counts[]> =
  async (brain, items) => {
    const wire = items.map(item => derivedItem('replaceDerivedLinksBatch', item.origin, item.links, item.opts));
    if (!wire.length) return [];
    if (items.some(item => item.opts?.wanted?.producers.length)) assertStoreSerializedTransactions(brain, 'replaceDerivedLinksBatch.wanted');
    const prepared = await prepareDerived(brain, items.map(item => item.origin), items.map(item => item.opts));
    const results = await publish(brain, 'replaceDerivedLinksBatch', items.map(item => item.origin), wire);
    for (const [i, item] of items.entries()) await finishDerived(brain, prepared[i]!, wire[i]!, item.opts);
    return results;
  };

// ---------------------------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------------------------

type KeepPair = { from_slug: string; from_source_id: string; to_slug: string; to_source_id: string };

export const removeLinksByPagesAndSource: StoreMember<[pages: Array<{ slug: string; source_id: string }>, opts: { linkSource: string; keepTypedNerPairs?: KeepPair[] }], number> =
  async (brain, pages, opts) => {
    if (pages.length === 0) return 0;
    const options = takeOptions('removeLinksByPagesAndSource', opts, ['linkSource', 'keepTypedNerPairs']);
    const wire = pages.map(p => ({ slug: p.slug, source_id: p.source_id }));
    const before = await linkRelationshipKeysTouching(brain, 'removeLinksByPagesAndSource', { fromPages: wire });
    const removed: number = await storeCall({ member: 'removeLinksByPagesAndSource' }, () => brain.removeLinksByPagesAndSource(wire, options));
    if (removed) await refreshOnStore(brain, before);
    return removed;
  };

export const listLinkSources: StoreMember<[opts?: { sourceId?: string; sourceIds?: string[] }], Array<{ link_source: string | null; count: number }>> =
  (brain, opts) => {
    const options = takeOptions('listLinkSources', opts, SCOPE_KEYS);
    return storeCall({ member: 'listLinkSources' }, () => brain.listLinkSources(options));
  };

export const rewriteLinks: StoreMember<[oldSlug: string, newSlug: string], void> = async () => {
  // Links reference page ids, so a slug rename leaves them valid; both SQL engines resolve without a statement.
};

// ---------------------------------------------------------------------------------------------------------------------
// Ranking signals and walks
// ---------------------------------------------------------------------------------------------------------------------

export const getBacklinkCounts: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, number>> =
  async (brain, pageIds, opts) => {
    const result = new Map(pageIds.map(id => [id, 0]));
    if (!pageIds.length) return result;
    const scope = rankingScope('getBacklinkCounts', opts);
    int32Ids('getBacklinkCounts', pageIds);
    const rows: Array<{ page_id: number; cnt: number }> = await storeCall({ member: 'getBacklinkCounts' },
      () => brain.getBacklinkCounts(pageIds, scope));
    for (const row of rows) result.set(Number(row.page_id), Number(row.cnt));
    return result;
  };

export const getAdjacencyBoosts: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, AdjacencyRow>> =
  async (brain, pageIds, opts) => {
    if (!pageIds.length) return new Map();
    int32Ids('getAdjacencyBoosts', pageIds, 'readAdjacencyBoosts');
    const scope = rankingScope('getAdjacencyBoosts', opts);
    const rows: Array<{ to_page_id: number; hits: number; cross_source_hits: number }> = await storeCall({ member: 'getAdjacencyBoosts' },
      () => brain.getAdjacencyBoosts(pageIds, scope));
    return new Map(rows.map(row => [Number(row.to_page_id), { hits: Number(row.hits), cross_source_hits: Number(row.cross_source_hits) }]));
  };

/**
 * `temporal` as `temporalWalkFilter` and readChainHop read it: the walk's own `excludePrivate`
 * picks the relationship scope. Rendering the SQL fragment first throws the same TypeError on a
 * date that is not a calendar day.
 */
function walkTemporal(opts: Pick<RelationalFanoutOpts, 'temporal' | 'excludePrivate'> | undefined) {
  const t = opts?.temporal;
  if (!t) return undefined;
  const temporal: EdgeTemporalOpts = { status: t.status, asOf: t.asOf, during: t.during, disabled: t.disabled, excludePrivate: !!opts.excludePrivate };
  relationshipFilterSql('l', temporal);
  return temporal;
}

export const relationalFanout: StoreMember<[seeds: string[], opts?: RelationalFanoutOpts], RelationalFanoutRow[]> =
  async (brain, seeds, opts) => {
    if (!seeds?.length) return [];
    const options = takeOptions('relationalFanout', opts,
      [...POLICY_KEYS, 'seedRefs', 'linkTypes', 'direction', 'depth', 'includeMentions', 'limit', 'temporal']);
    const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    // The SQL engines bind both into integer comparisons; a fraction or NaN is not guessed at.
    if (!Number.isInteger(depth) || !Number.isInteger(limit)) refuseMember('relationalFanout', 'a depth or limit that is not an integer');
    const wire = {
      ...scopeOf('relationalFanout', options),
      scoped: hasReadPolicy(options),
      seedRefs: opts?.seedRefs?.map(ref => ({ source_id: ref.source_id, slug: ref.slug })),
      linkTypes: opts?.linkTypes ?? undefined,
      direction: opts?.direction ?? 'both',
      depth,
      includeMentions: !!opts?.includeMentions,
      limit,
      temporal: walkTemporal(opts),
      requireSafeChunks: requiresSafeChunks(opts),
    };
    return storeCall({ member: 'relationalFanout' }, () => brain.relationalFanout(seeds, wire));
  };

export const relationalChainHop: StoreMember<[frontierPageIds: number[], opts: ChainHopOpts], ChainHopEdge[]> =
  async (brain, frontierPageIds, opts) => {
    if (!frontierPageIds.length || !opts.linkTypes.length) return [];
    const ids = int32Ids('relationalChainHop', [...new Set(frontierPageIds)], 'readChainHop');
    const options = takeOptions('relationalChainHop', opts,
      [...READ_SCOPE_KEYS, 'linkTypes', 'toward', 'subjectTypes', 'objectTypes', 'degreeLinkTypes', 'neighborCap', 'temporal'], UNREAD_BY_FILTER);
    const cap = Math.max(1, Math.min(opts.neighborCap, 1000));
    if (!Number.isInteger(cap)) refuseMember('relationalChainHop', 'a neighborCap that is not an integer');
    const wire = {
      ...scopeOf('relationalChainHop', options),
      linkTypes: opts.linkTypes, toward: opts.toward, subjectTypes: opts.subjectTypes, objectTypes: opts.objectTypes,
      degreeLinkTypes: opts.degreeLinkTypes, neighborCap: cap, temporal: walkTemporal(opts),
      requireSafeChunks: requiresSafeChunks(opts), textGate: chainTextGate(opts),
    };
    return storeCall({ member: 'relationalChainHop' }, () => brain.relationalChainHop(ids, wire));
  };

type OrphanRow = { slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string };

export const findOrphanPages: StoreMember<[opts?: PageReadScope & { mode?: 'inbound' | 'islanded'; scopeInbound?: boolean }], OrphanRow[]> =
  (brain, opts) => {
    const options = takeOptions('findOrphanPages', opts, [...POLICY_SCOPE_KEYS, 'mode', 'scopeInbound']);
    const wire = { ...options, excludePrivate: storePagePolicy('findOrphanPages', options.excludePrivate, CALLER_READERS) ?? null };
    return storeCall({ member: 'findOrphanPages' }, () => brain.findOrphanPages(wire));
  };

// ---------------------------------------------------------------------------------------------------------------------
// Search reads (src/core/engine-sql/search-reads.ts)
// ---------------------------------------------------------------------------------------------------------------------

export const hasSupersedeEdges: StoreMember<[], boolean> = async (brain) =>
  storeCall({ member: 'hasSupersedeEdges' }, () => brain.hasSupersedeEdges());

/**
 * Superseded page id → the slug of a live page in the same source that supersedes it. A policy (any object, as the
 * SQL's `policy ?` test) turns on the live filter for both pages and the link's origin page; the first row per id wins.
 */
export const supersedingPageSlugs: StoreMember<[pageIds: number[], policy?: PageReadPolicy], Map<number, string>> =
  async (brain, pageIds, policy) => {
    const result = new Map<number, string>();
    if (pageIds.length === 0) return result;
    const scope = rankingScope('supersedingPageSlugs', policy);
    const ids = bigintIds('supersedingPageSlugs', pageIds);
    const rows: Array<{ to_page_id: number; by_slug: string }> = await storeCall({ member: 'supersedingPageSlugs' },
      () => brain.supersedingPageSlugs(ids, scope));
    for (const row of rows) {
      const id = Number(row.to_page_id);
      if (!result.has(id)) result.set(id, row.by_slug);
    }
    return result;
  };

/** The pages among `fromIds` with a ranking link to a page in `toIds`. */
export const pagesLinkingTo: StoreMember<[fromIds: number[], toIds: number[]], number[]> =
  async (brain, fromIds, toIds) => {
    const from = pageIdsOnly(int32Ids('pagesLinkingTo', fromIds));
    const to = pageIdsOnly(int32Ids('pagesLinkingTo', toIds));
    const rows: number[] = await storeCall({ member: 'pagesLinkingTo' }, () => brain.pagesLinkingTo(from, to));
    return rows.map(Number);
  };

// ---------------------------------------------------------------------------------------------------------------------
// Link reads (src/core/engine-sql/link-reads.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Live pages, and live pages some link points at; `sourceIds` (even empty) filters both. */
export const inboundLinkCoverage: StoreMember<[opts?: { sourceIds?: string[] }], { livePages: number; linkedPages: number }> =
  async (brain, opts) => {
    const r: { livePages: number; linkedPages: number } = await storeCall({ member: 'inboundLinkCoverage' },
      () => brain.inboundLinkCoverage({ sourceIds: opts?.sourceIds ?? null }));
    return { livePages: Number(r.livePages), linkedPages: Number(r.linkedPages) };
  };

/** High-degree, low-content live pages (doctor junk_entity_hubs); the connector kinds are CONNECTOR_SOURCE_KINDS. */
export const listJunkEntityHubs: StoreMember<[opts: { edgeThreshold: number; maxChunks: number; limit: number }], JunkEntityHubRow[]> =
  async (brain, opts) => {
    for (const [key, value] of Object.entries(opts)) {
      if (!Number.isSafeInteger(value)) refuseMember('listJunkEntityHubs', `a ${key} that is not an integer`);
    }
    if (opts.limit < 0) refuseMember('listJunkEntityHubs', 'a negative limit');
    const rows: JunkEntityHubRow[] = await storeCall({ member: 'listJunkEntityHubs' },
      () => brain.listJunkEntityHubs({ ...opts, connectorKinds: [...CONNECTOR_SOURCE_KINDS] }));
    return rows.map(r => ({ ...r, edges: Number(r.edges), chunks: Number(r.chunks) }));
  };

/** Live entity pages: unquarantined ones with `excludeQuarantined` (which ignores `sourceId`, as the SQL does). */
export const countEntityPages: StoreMember<[filter: EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }], number> =
  async (brain, filter, opts) => Number(await storeCall({ member: 'countEntityPages' },
    () => brain.countEntityPages({ filter, sourceId: opts?.sourceId || null, excludeQuarantined: !!opts?.excludeQuarantined })));

/** Entity graph coverage over the eligible entity pages; the store always has the one row. */
export const entityGraphCoverage: StoreMember<[filter: EntityTypeFilter], { entities: number; connected: number; withTimeline: number } | null> =
  async (brain, filter) => {
    const r: { entities: number; connected: number; withTimeline: number } = await storeCall({ member: 'entityGraphCoverage' },
      () => brain.entityGraphCoverage({ filter }));
    return { entities: Number(r.entities), connected: Number(r.connected), withTimeline: Number(r.withTimeline) };
  };

/**
 * How many live unquarantined entity pages there are and how many have an inbound link or a timeline entry. The store
 * reads every page. A 100 percent sample draws every row (TABLESAMPLE BERNOULLI (100)), so it is served as the whole
 * population; a lower percent is a random draw no other engine can match, so it refuses by name. Doctor and onboard
 * ask for a sample only on Postgres. A malformed percent fails with the SQL engines' message (engine-sql/link-reads.ts).
 */
export const entityFeatureCoverage: StoreMember<[filter: EntityTypeFilter, feature: 'links' | 'timeline', opts?: { samplePercent?: number }], { sampleSize: number; matched: number }> =
  async (brain, filter, feature, opts) => {
    if (feature !== 'links' && feature !== 'timeline') refuseMember('entityFeatureCoverage', `the feature ${String(feature)}`);
    const pct = opts?.samplePercent;
    if (pct !== undefined && !(Number.isFinite(pct) && pct > 0 && pct <= 100)) {
      throw new Error(`entityFeatureCoverage: samplePercent must be a number in (0, 100], got ${String(pct)}`);
    }
    if (pct !== undefined && pct !== 100) refuseMember('entityFeatureCoverage', `a TABLESAMPLE of ${pct} percent (a random draw; the store reads every page)`);
    const r: { sampleSize: number; matched: number } = await storeCall({ member: 'entityFeatureCoverage' },
      () => brain.entityFeatureCoverage({ filter, feature }));
    return { sampleSize: Number(r.sampleSize), matched: Number(r.matched) };
  };

/** Live meeting pages with an effective date. */
export const countDatedMeetingPages: StoreMember<[], number> =
  async (brain) => Number(await storeCall({ member: 'countDatedMeetingPages' }, () => brain.countDatedMeetingPages()));

/** Links of the page whose other end is in another source. */
export const countForeignEdges: StoreMember<[slug: string, sourceId: string, direction: 'in' | 'out' | 'both'], number> =
  async (brain, slug, sourceId, direction) => Number(await storeCall({ member: 'countForeignEdges' },
    () => brain.countForeignEdges({ slug, sourceId, direction })));

/** Every page that is not soft-deleted and `scope` reads; the store returns them in page id order. */
export const listLivePageSummaries: StoreMember<[scope?: PageReadScope], LivePageSummary[]> =
  async (brain, scope) => {
    const options = takeOptions('listLivePageSummaries', scope, READ_SCOPE_KEYS, UNREAD_BY_FILTER);
    const rows: LivePageSummary[] = await storeCall({ member: 'listLivePageSummaries' },
      () => brain.listLivePageSummaries({ ...scopeOf('listLivePageSummaries', options), scoped: true }));
    return rows.map(r => ({ slug: r.slug, type: r.type, quarantined: !!r.quarantined }));
  };

/** The entity card's backlink count; `excludePrivate` is the page policy (storePagePolicy). */
export const countInboundLinks: StoreMember<[slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }], number> =
  async (brain, slug, sourceId, opts) => {
    const excludePrivate = storePagePolicy('countInboundLinks', opts.excludePrivate, CALLER_READERS) ?? null;
    return Number(await storeCall({ member: 'countInboundLinks' },
      () => brain.countInboundLinks({ slug, sourceId, excludePrivate, originSameSource: !!opts.originSameSource })));
  };

/** The entity card's incoming edges: the links countInboundLinks counts, by link id, with raw temporal columns. */
export const readEntityInboundEdges: StoreMember<[slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }], EntityInboundEdgeRow[]> =
  async (brain, slug, sourceId, opts) => {
    const excludePrivate = storePagePolicy('readEntityInboundEdges', opts.excludePrivate, CALLER_READERS) ?? null;
    const rows: EntityInboundEdgeRow[] = await storeCall({ member: 'readEntityInboundEdges' },
      () => brain.readEntityInboundEdges({ slug, sourceId, excludePrivate, originSameSource: !!opts.originSameSource }));
    // The store prints timestamps as ISO text; Postgres returns them as Date (timestamptz).
    const at = (v: Date | string | null) => v == null ? null : new Date(v);
    return rows.map(r => ({ ...r, temporal_recorded_at: at(r.temporal_recorded_at), temporal_retired_at: at(r.temporal_retired_at) }));
  };

/** Automatic link preparation's endpoint pages: the origin source's rows first. */
export const listLinkEndpointPages: StoreMember<[sourceId: string, slugs: string[], crossSourceSlugs: string[]], LinkEndpointPage[]> =
  async (brain, sourceId, slugs, crossSourceSlugs) => storeCall({ member: 'listLinkEndpointPages' },
    () => brain.listLinkEndpointPages({ sourceId, slugs, crossSourceSlugs }));

/** The entity anchor's titled pages: by source id and slug, at most 50. */
export const listPagesTitledIn: StoreMember<[queryLower: string, scope: PageReadScope], TitledPage[]> =
  async (brain, queryLower, scope) => {
    const options = takeOptions('listPagesTitledIn', scope, READ_SCOPE_KEYS, UNREAD_BY_FILTER);
    const rows: TitledPage[] = await storeCall({ member: 'listPagesTitledIn' },
      () => brain.listPagesTitledIn({ queryLower, scope: { ...scopeOf('listPagesTitledIn', options), scoped: true } }));
    return rows.map(r => ({ ...r, id: Number(r.id) }));
  };

/** search's type-filter probe: each set's presence among the live pages `scope` reads, and their types when one has none. */
export const probePageTypes: StoreMember<[sets: readonly (readonly string[])[], scope: PageReadScope], PageTypeProbe> =
  async (brain, sets, scope) => {
    const options = takeOptions('probePageTypes', scope, READ_SCOPE_KEYS, UNREAD_BY_FILTER);
    const out: { present: boolean[]; available: string[] | null } = await storeCall({ member: 'probePageTypes' },
      () => brain.probePageTypes({ sets: sets.map(set => [...set]), scope: { ...scopeOf('probePageTypes', options), scoped: true } }));
    return { present: out.present.map(Boolean), available: out.available ?? null };
  };

/**
 * The long-page size preflight: each page in `ids` that the scope serves (live, served projection, safe chunks when the
 * scope requires them), with its stored body length. An id the SQL's int[] cast rejects is an error there, not a refusal.
 */
export const readLongPageSizes: StoreMember<[ids: readonly number[], scope: PageReadScope, opts: { includeTimeline: boolean }], LongPageSizeRow[]> =
  async (brain, ids, scope, opts) => {
    const options = takeOptions('readLongPageSizes', scope, [...READ_SCOPE_KEYS, 'requireSafeChunks'], ['takesHoldersAllowList']);
    for (const id of ids) if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) throw new TypeError(`readLongPageSizes: page id ${String(id)} is not a 32-bit integer`);
    const rows: LongPageSizeRow[] = await storeCall({ member: 'readLongPageSizes' }, () => brain.readLongPageSizes({
      ids: [...ids], includeTimeline: opts.includeTimeline === true, safeChunks: requiresSafeChunks(options),
      scope: { ...scopeOf('readLongPageSizes', options), scoped: true },
    }));
    return rows.map(r => ({ id: Number(r.id), chars: Number(r.chars), bytes: Number(r.bytes) }));
  };

/** Each word to its English lexemes; another full-text configuration refuses (the store has only English). */
export const wordLexemes: StoreMember<[words: string[]], Map<string, string[]>> =
  async (brain, words) => {
    if (getFtsLanguage() !== 'english') refuseMember('wordLexemes', `the ${getFtsLanguage()} text search configuration`);
    const rows: Array<{ w: string; lexemes: string[] }> = await storeCall({ member: 'wordLexemes' }, () => brain.wordLexemes(words));
    return new Map(rows.map(r => [r.w, r.lexemes]));
  };

/** The stored link rows behind returned link contexts (worldLinkContexts): in ask order, then link id order. */
export const readLinkContextMatches: StoreMember<[asks: readonly LinkContextAsk[]], LinkContextMatch[]> =
  async (brain, asks) => {
    if (asks.length === 0) return [];
    const rows: LinkContextMatch[] = await storeCall({ member: 'readLinkContextMatches' }, () => brain.readLinkContextMatches(asks));
    return rows.map(r => ({ ...r, i: Number(r.i), page_id: r.page_id == null ? null : Number(r.page_id) }));
  };

/** The origin page bodies worldLinkContexts reads, segmented pages left out: by id. */
export const readLinkContextOriginPages: StoreMember<[ids: readonly number[]], LinkContextOriginPage[]> =
  async (brain, ids) => {
    if (ids.length === 0) return [];
    const rows: LinkContextOriginPage[] = await storeCall({ member: 'readLinkContextOriginPages' },
      () => brain.readLinkContextOriginPages(ids.map(Number)));
    return rows.map(r => ({ ...r, id: Number(r.id) }));
  };
