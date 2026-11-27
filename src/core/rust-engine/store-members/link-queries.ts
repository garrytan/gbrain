/**
 * Link and graph members beyond the core links members: derived-link replacement (replaceDerivedLinks,
 * replaceDerivedLinksBatch), provenance-scoped deletes (removeLinksByPagesAndSource), provenance counts
 * (listLinkSources), the ranking signals (getBacklinkCounts, getAdjacencyBoosts), the relational walks
 * (relationalFanout, relationalChainHop), orphan detection (findOrphanPages), rewriteLinks (a no-op on every engine)
 * and the link reads of hybrid search's ranking stage (hasSupersedeEdges, supersedingPageSlugs, pagesLinkingTo; the
 * SQL is src/core/engine-sql/search-reads.ts).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 *
 * The store models the source filter and the live test of the read policy (src/core/search/read-policy-sql.ts), and
 * for getBacklinkCounts, getAdjacencyBoosts and supersedingPageSlugs the page policy `excludePrivate` adds, over every
 * page the read judges (the target, the linking page and the page that authored the edge). relationalFanout and
 * relationalChainHop also model `requireSafeChunks` (the canonical chunk's safe fence and the chain's evidence text gate,
 * `takesHoldersAllowList` included). Any other privacy, trust, flag, safe-chunk or temporal policy refuses with `engine_capability_missing`, as does `excludePrivate` on the other
 * members and a derived-link option that needs state the store does not keep (wanted pages, line-grammar ranges,
 * temporal evidence). See rust/docs/store/link_queries.md.
 */
import {
  DerivedLinkEndpointChangedError, DerivedLinkRepairRequiredError,
  type DerivedLinkBatchItem, type DerivedLinkOrigin, type DerivedLinkReplacementOptions,
} from '../../derived-links.ts';
import type { LinkBatchInput } from '../../engine.ts';
import { PageRevisionConflictError } from '../../page-state/types.ts';
import type {
  AdjacencyRow, ChainHopEdge, ChainHopOpts, PageReadPolicy, PageReadScope, RelationalFanoutOpts, RelationalFanoutRow,
} from '../../types.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { HYBRID_BAG_KEYS, storePagePolicy } from './private-provenance.ts';
import { ownerWidened } from '../../search/private-visibility.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import type { LinkEndpointPage } from '../../engine-sql/link-reads.ts';

/** The read-policy keys the store models: the source filter. */
const SCOPE_KEYS = ['sourceId', 'sourceIds'] as const;
/**
 * Keys `pageReadFilter` never reads. The ranking reads ignore them, as the SQL engines do; the relational walks read
 * them for the canonical chunk's safe fence and relationalChainHop's evidence text gate (`chainTextGate`).
 */
const UNREAD_BY_FILTER = ['requireSafeChunks', 'takesHoldersAllowList'] as const;
/** For relationalFanout the unread keys still turn the live filter on, through `hasReadPolicy`. */
const POLICY_KEYS = [...SCOPE_KEYS, ...UNREAD_BY_FILTER] as const;
const INT32_MAX = 2 ** 31 - 1;

/** `hasReadPolicy` of read-policy-sql.ts over the options takeOptions kept (the refused keys are absent or false). */
function hasReadPolicy(opts: Record<string, unknown>): boolean {
  return !!((opts.sourceIds as unknown[] | undefined)?.length || opts.sourceId || opts.requireSafeChunks
    || opts.takesHoldersAllowList !== undefined);
}

/** Ids the SQL engines cast to `int[]`: an id that is not an int4 is refused rather than guessed at. */
function int32Ids(member: string, ids: readonly number[], label?: string): number[] {
  for (const id of ids) {
    if (label && !Number.isSafeInteger(id)) throw new TypeError(`${label}: page id ${String(id)} is not an integer`);
    if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) refuseMember(member, 'a page id that is not a 32-bit integer');
  }
  return ids as number[];
}

const scopeOf = (o: Record<string, unknown>) => ({ sourceId: o.sourceId, sourceIds: o.sourceIds });

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
 * The scope of a ranking read hybridSearch hands its whole option bag: the source filter, the bag's own keys (ignored,
 * as PGLite reads only the page policy out of the bag) and `excludePrivate` as the page policy `pageReadFilter` adds
 * (private-provenance.ts `storePagePolicy`, which refuses a caller whose policy is wider than the store's). The trust
 * filters still refuse. `scoped` says a policy object was passed at all, which turns on the live filter.
 */
function rankingScope(member: string, opts: PageReadPolicy | undefined): Record<string, unknown> {
  const options = takeOptions(member, opts, SCOPE_KEYS, [...UNREAD_BY_FILTER, 'excludePrivate', ...HYBRID_BAG_KEYS]);
  const excludePrivate = storePagePolicy(member, opts?.excludePrivate);
  return { ...scopeOf(options), scoped: !!opts, ...(excludePrivate ? { excludePrivate } : {}) };
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

/** One origin as the store reads it, after the options the store cannot honour refused. */
function derivedItem(member: string, origin: DerivedLinkOrigin, links: LinkBatchInput[], opts: DerivedLinkReplacementOptions | undefined) {
  const options = takeOptions(member, opts, ['includeFrontmatter', 'preserveExisting', 'includeLegacyNullProducer', 'expectedEndpoints'],
    ['semanticsPrimed']) as DerivedLinkReplacementOptions;
  if (origin.snapshot !== undefined) refuseMember(member, 'a caller-read origin snapshot');
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
    const item = derivedItem('replaceDerivedLinks', origin, links, opts);
    const [result] = await publish(brain, 'replaceDerivedLinks', [origin], [item]);
    return result!;
  };

export const replaceDerivedLinksBatch: StoreMember<[items: readonly DerivedLinkBatchItem[]], Counts[]> =
  async (brain, items) => {
    const wire = items.map(item => derivedItem('replaceDerivedLinksBatch', item.origin, item.links, item.opts));
    if (!wire.length) return [];
    return publish(brain, 'replaceDerivedLinksBatch', items.map(item => item.origin), wire);
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
    return storeCall({ member: 'removeLinksByPagesAndSource' }, () => brain.removeLinksByPagesAndSource(wire, options));
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

export const relationalFanout: StoreMember<[seeds: string[], opts?: RelationalFanoutOpts], RelationalFanoutRow[]> =
  async (brain, seeds, opts) => {
    if (!seeds?.length) return [];
    const options = takeOptions('relationalFanout', opts,
      [...POLICY_KEYS, 'seedRefs', 'linkTypes', 'direction', 'depth', 'includeMentions', 'limit']);
    const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    // The SQL engines bind both into integer comparisons; a fraction or NaN is not guessed at.
    if (!Number.isInteger(depth) || !Number.isInteger(limit)) refuseMember('relationalFanout', 'a depth or limit that is not an integer');
    const wire = {
      ...scopeOf(options),
      scoped: hasReadPolicy(options),
      seedRefs: opts?.seedRefs?.map(ref => ({ source_id: ref.source_id, slug: ref.slug })),
      linkTypes: opts?.linkTypes ?? undefined,
      direction: opts?.direction ?? 'both',
      depth,
      includeMentions: !!opts?.includeMentions,
      limit,
      requireSafeChunks: requiresSafeChunks(opts),
    };
    return storeCall({ member: 'relationalFanout' }, () => brain.relationalFanout(seeds, wire));
  };

export const relationalChainHop: StoreMember<[frontierPageIds: number[], opts: ChainHopOpts], ChainHopEdge[]> =
  async (brain, frontierPageIds, opts) => {
    if (!frontierPageIds.length || !opts.linkTypes.length) return [];
    const ids = int32Ids('relationalChainHop', [...new Set(frontierPageIds)], 'readChainHop');
    const options = takeOptions('relationalChainHop', opts,
      [...SCOPE_KEYS, 'linkTypes', 'toward', 'subjectTypes', 'objectTypes', 'degreeLinkTypes', 'neighborCap'], UNREAD_BY_FILTER);
    const cap = Math.max(1, Math.min(opts.neighborCap, 1000));
    if (!Number.isInteger(cap)) refuseMember('relationalChainHop', 'a neighborCap that is not an integer');
    const wire = {
      ...scopeOf(options),
      linkTypes: opts.linkTypes, toward: opts.toward, subjectTypes: opts.subjectTypes, objectTypes: opts.objectTypes,
      degreeLinkTypes: opts.degreeLinkTypes, neighborCap: cap,
      requireSafeChunks: requiresSafeChunks(opts), textGate: chainTextGate(opts),
    };
    return storeCall({ member: 'relationalChainHop' }, () => brain.relationalChainHop(ids, wire));
  };

type OrphanRow = { slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string };

export const findOrphanPages: StoreMember<[opts?: PageReadScope & { mode?: 'inbound' | 'islanded'; scopeInbound?: boolean }], OrphanRow[]> =
  (brain, opts) => {
    const options = takeOptions('findOrphanPages', opts, [...SCOPE_KEYS, 'mode', 'scopeInbound']);
    return storeCall({ member: 'findOrphanPages' }, () => brain.findOrphanPages(options));
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

/** Automatic link preparation's endpoint pages: the origin source's rows first. */
export const listLinkEndpointPages: StoreMember<[sourceId: string, slugs: string[], crossSourceSlugs: string[]], LinkEndpointPage[]> =
  async (brain, sourceId, slugs, crossSourceSlugs) => storeCall({ member: 'listLinkEndpointPages' },
    () => brain.listLinkEndpointPages({ sourceId, slugs, crossSourceSlugs }));
