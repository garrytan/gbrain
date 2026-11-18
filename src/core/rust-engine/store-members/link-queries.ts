/**
 * Link and graph members beyond the core links members: derived-link replacement (replaceDerivedLinks,
 * replaceDerivedLinksBatch), provenance-scoped deletes (removeLinksByPagesAndSource), provenance counts
 * (listLinkSources), the ranking signals (getBacklinkCounts, getAdjacencyBoosts), the relational walks
 * (relationalFanout, relationalChainHop), orphan detection (findOrphanPages) and rewriteLinks (a no-op on every engine).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 *
 * The store models the source filter and the live test of the read policy (src/core/search/read-policy-sql.ts). A
 * privacy, trust, flag, safe-chunk or temporal policy refuses with `engine_capability_missing`, as does a derived-link
 * option that needs state the store does not keep (wanted pages, line-grammar ranges, temporal evidence). See
 * rust/docs/store/link_queries.md.
 */
import {
  DerivedLinkEndpointChangedError, DerivedLinkRepairRequiredError,
  type DerivedLinkBatchItem, type DerivedLinkOrigin, type DerivedLinkReplacementOptions,
} from '../../derived-links.ts';
import type { LinkBatchInput } from '../../engine.ts';
import { PageRevisionConflictError } from '../../page-state/types.ts';
import type {
  AdjacencyRow, ChainHopEdge, ChainHopOpts, PageReadScope, RelationalFanoutOpts, RelationalFanoutRow,
} from '../../types.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

/** The read-policy keys the store models: the source filter. */
const SCOPE_KEYS = ['sourceId', 'sourceIds'] as const;
/** Keys `pageReadFilter` never reads: the SQL engines ignore them in these statements, so the store does too. */
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
    const options = takeOptions('getBacklinkCounts', opts, SCOPE_KEYS, UNREAD_BY_FILTER);
    int32Ids('getBacklinkCounts', pageIds);
    const rows: Array<{ page_id: number; cnt: number }> = await storeCall({ member: 'getBacklinkCounts' },
      () => brain.getBacklinkCounts(pageIds, { ...scopeOf(options), scoped: !!opts }));
    for (const row of rows) result.set(Number(row.page_id), Number(row.cnt));
    return result;
  };

export const getAdjacencyBoosts: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, AdjacencyRow>> =
  async (brain, pageIds, opts) => {
    if (!pageIds.length) return new Map();
    int32Ids('getAdjacencyBoosts', pageIds, 'readAdjacencyBoosts');
    const options = takeOptions('getAdjacencyBoosts', opts, SCOPE_KEYS, UNREAD_BY_FILTER);
    const rows: Array<{ to_page_id: number; hits: number; cross_source_hits: number }> = await storeCall({ member: 'getAdjacencyBoosts' },
      () => brain.getAdjacencyBoosts(pageIds, { ...scopeOf(options), scoped: !!opts }));
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
    };
    return storeCall({ member: 'relationalChainHop' }, () => brain.relationalChainHop(ids, wire));
  };

type OrphanRow = { slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string };

export const findOrphanPages: StoreMember<[opts?: PageReadScope & { mode?: 'inbound' | 'islanded'; scopeInbound?: boolean }], OrphanRow[]> =
  (brain, opts) => {
    const options = takeOptions('findOrphanPages', opts, [...SCOPE_KEYS, 'mode', 'scopeInbound']);
    return storeCall({ member: 'findOrphanPages' }, () => brain.findOrphanPages(options));
  };
