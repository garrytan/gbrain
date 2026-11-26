/**
 * Chunk reads beyond the core chunks members: one page of a page's chunks (BrainEngine getChunkPage), batched chunk
 * windows for evidence delivery (getChunkWindows), the pages with a body but no chunks
 * (countChunklessPagesWithContent, listChunklessPagesWithContent), the import's deleteChunksExcept, and the chunk reads
 * and deletes of src/core/engine-sql/chunk-reads.ts (findCodeDefinitions, listSymbolTypesForName, findCodeRefChunks,
 * countOversizedEmbedSkips, countOrphanChunks, countCodeChunkPages, codeChunksExist, hasUnsealedPages, currentCodeChunksExist,
 * listQualifiedSymbolNames, listSymbolLanguages, listSupportedChunkIds, listSymbolChunkIds, listWithdrawalChunks, deleteChunksForPages, listContextualModeCandidates,
 * resolveFrozenHits), and search dedup's segmented-region read (readSegmentRegions).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 *
 * getChunkPage and getChunkWindows model the page privacy policy (storePagePolicy, caller readers included) and the chunker-version fence of a
 * safe-chunk read (`requiresSafeChunks`, which an `excludePrivate` read asks for unless it says otherwise).
 *
 * The chunk-reads members model the source filter, the page privacy policy (storePagePolicy, a caller's reader identity
 * and private-readable grant included) and the live test of the
 * read policy (src/core/search/read-policy-sql.ts); resolveFrozenHits also models the trust floor and flag suppression
 * (`minTrust`, `suppressFlagged`). A safe-chunk read applies the chunker-version fence of `codeReadFilter` on the code
 * reads and `currentCodeChunksExist`, and of the frozen-hit read on resolveFrozenHits. The other chunk-reads members refuse a trust or flag option: no production caller passes one, so no store read was
 * built. getChunkPage and getChunkWindows ignore both, as their SQL does. See rust/docs/store/chunk_queries.md.
 */
import { SYMBOL_CHUNK_LOOKUP_LIMIT } from '../../engine-sql/chunk-reads.ts';
import { mapChunkWindowRows, type ChunkWindowOpts, type ChunkWindowPage, type ChunkWindowRequest } from '../../search/chunk-windows.ts';
import type { Chunk, ChunklessPageRow, PageReadScope } from '../../types.ts';
import { DEF_TYPES } from '../../chunkers/def-types.ts';
import type {
  CodeChunkScope, CodeDefinitionRow, CodeRefChunkRow, CodeSymbolQuery, ContextualModeCandidate, FrozenHitKey, FrozenHitRow,
  UnsealedPageScope, WithdrawalChunkKey, WithdrawalChunkRow,
} from '../../engine-sql/chunk-reads.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import { storePagePolicy } from './private-provenance.ts';
import { toChunk } from '../store-codec.ts';
import { TrustFloorError } from '../../engine-errors.ts';
import { namedSourceIds, refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

// The SQL engines never read these read-policy keys in these statements, so the store ignores them too. An MCP
// caller's policy carries `takesHoldersAllowList` into get_chunks; chunk reads have no takes to filter.
// `excludePrivate` (the page privacy filter) and `requireSafeChunks` (the chunker-version fence) are served.
const UNREAD_SCOPE = ['minTrust', 'suppressFlagged', 'takesHoldersAllowList'] as const;

type ChunkPage = { chunks: Chunk[]; total_chunks: number; max_chunk_index: number | null };

export const getChunkPage: StoreMember<[slug: string, opts: PageReadScope & { fromIndex: number; limit: number }], ChunkPage> =
  async (brain, slug, opts) => {
    const { sourceIds, sourceId, fromIndex, limit, excludePrivate } = takeOptions('getChunkPage', opts,
      ['sourceId', 'sourceIds', 'fromIndex', 'limit', 'excludePrivate', 'requireSafeChunks'], UNREAD_SCOPE) as
      { sourceId?: unknown; sourceIds?: unknown[]; fromIndex?: number; limit?: number; excludePrivate?: unknown };
    // The scope resolves as getChunks resolves it: `sourceIds` when not empty, else `sourceId` (default `default`). A
    // scope that names no source matches nothing, and a read over several sources reads the page in each.
    const requested = sourceIds?.length ? sourceIds : [sourceId ?? 'default'];
    const named = namedSourceIds(requested);
    if (named.length === 0) return { chunks: [], total_chunks: 0, max_chunk_index: null };
    const options = {
      sourceId: named[0]!, ...(named.length > 1 ? { sourceIds: named } : {}), fromIndex, limit,
      excludePrivate: storePagePolicy('getChunkPage', excludePrivate, { callerReaders: true }) ?? null,
      requireSafeChunks: requiresSafeChunks(opts),
    };
    const page: ChunkPage = await storeCall({ member: 'getChunkPage', slug }, () => brain.getChunkPage(slug, options));
    return { chunks: page.chunks.map((row) => toChunk(row)), total_chunks: page.total_chunks, max_chunk_index: page.max_chunk_index };
  };

export const getChunkWindows: StoreMember<[requests: ChunkWindowRequest[], opts: ChunkWindowOpts], ChunkWindowPage[]> =
  async (brain, requests, opts) => {
    // The SQL engines answer an empty request list before they read any option.
    if (requests.length === 0) return [];
    const options = takeOptions('getChunkWindows', opts,
      ['sourceId', 'sourceIds', 'chunkSources', 'maxRows', 'excludePrivate', 'requireSafeChunks'], UNREAD_SCOPE);
    // The SQL engines bind every request field into an int[]; a value that is not an integer is not guessed at.
    for (const r of requests) {
      if (![r.page_id, r.from_index, r.to_index, r.priority].every(Number.isSafeInteger)) refuseMember('getChunkWindows', 'a request field that is not an integer');
    }
    const maxRows = Math.max(0, Math.floor(opts.maxRows));
    if (!Number.isSafeInteger(maxRows)) refuseMember('getChunkWindows', 'a maxRows that is not a finite number');
    const wire = requests.map((r) => ({ page_id: r.page_id, from_index: r.from_index, to_index: r.to_index, priority: r.priority }));
    const rows: Record<string, unknown>[] =
      await storeCall({ member: 'getChunkWindows' }, () => brain.getChunkWindows(wire, {
        ...options, maxRows,
        excludePrivate: storePagePolicy('getChunkWindows', opts.excludePrivate, { callerReaders: true }) ?? null,
        requireSafeChunks: requiresSafeChunks(opts),
      }));
    return mapChunkWindowRows(rows, maxRows);
  };

export const countChunklessPagesWithContent: StoreMember<[opts?: { sourceId?: string }], number> = (brain, opts) => {
  const options = takeOptions('countChunklessPagesWithContent', opts, ['sourceId']);
  return storeCall({ member: 'countChunklessPagesWithContent' }, () => brain.countChunklessPagesWithContent(options));
};

export const listChunklessPagesWithContent: StoreMember<[opts?: { batchSize?: number; afterPageId?: number; sourceId?: string }], ChunklessPageRow[]> =
  (brain, opts) => {
    const options = takeOptions('listChunklessPagesWithContent', opts, ['batchSize', 'afterPageId', 'sourceId']);
    return storeCall({ member: 'listChunklessPagesWithContent' }, () => brain.listChunklessPagesWithContent(options));
  };

// ---------------------------------------------------------------------------------------------------------------------
// The chunk reads of src/core/engine-sql/chunk-reads.ts
// ---------------------------------------------------------------------------------------------------------------------

/** The read-policy keys these members model: the source filter, `allSources` and the page privacy policy. */
const POLICY_KEYS = ['sourceId', 'sourceIds', 'allSources', 'excludePrivate', 'requireSafeChunks'] as const;
/** `pageReadFilter` never reads it, so the SQL engines ignore it in these statements and the store does too. */
const UNREAD_BY_FILTER = ['takesHoldersAllowList'] as const;
/**
 * `pageReadFilter`'s trust floor and flag suppression. Only resolveFrozenHits takes them (assemble_evidence passes the
 * caller's floor); the other members have no caller that passes one and still refuse them.
 */
const TRUST_KEYS = ['minTrust', 'suppressFlagged'] as const;
const INT32_MAX = 2 ** 31 - 1;

/** Ids the SQL engines cast to `int[]`: an id that is not an int4 is refused rather than guessed at. */
function int32Ids(member: string, ids: readonly number[]): number[] {
  for (const id of ids) {
    if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) refuseMember(member, 'an id that is not a 32-bit integer');
  }
  return [...ids];
}

/**
 * The wire scope of `pageReadFilter`: the source filter (`codeReadFilter` drops `sourceId` under `allSources` when no
 * `sourceIds` is given), under `excludePrivate` the store page policy, and under a safe-chunk read
 * (`requiresSafeChunks`) the chunker-version fence.
 */
function wireScope(member: string, o: Record<string, unknown>, code: boolean) {
  // A floor that is not text names no trust tier (the store's own refusal covers a text one): refuse it here the same way,
  // before the napi call turns a number into a decoding error (#10276).
  if (o.minTrust && typeof o.minTrust !== 'string') throw new TrustFloorError(o.minTrust);
  const dropSource = code && !!o.allSources && o.sourceIds === undefined;
  return {
    sourceId: dropSource ? undefined : o.sourceId,
    sourceIds: o.sourceIds,
    excludePrivate: storePagePolicy(member, o.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: (o.minTrust as string | undefined) || null,
    suppressFlagged: o.suppressFlagged === true,
    requireSafeChunks: requiresSafeChunks(o as PageReadScope),
  };
}

/** `sourceIds: []` makes `codeReadFilter` (and codeChunksExist) `FALSE`: no row. */
const namesNoSource = (o: Record<string, unknown>) => Array.isArray(o.sourceIds) && o.sourceIds.length === 0;

const lineOf = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function codeRow<T extends CodeDefinitionRow>(r: T): T {
  return { ...r, start_line: lineOf(r.start_line), end_line: lineOf(r.end_line) };
}

function symbolInput(member: string, symbol: string, opts: CodeSymbolQuery | undefined, withLimit: boolean) {
  const o = takeOptions(member, opts, [...POLICY_KEYS, 'language', ...(withLimit ? ['limit'] : [])], UNREAD_BY_FILTER);
  const scope = wireScope(member, o, true);
  return { o, input: { symbol, language: o.language ?? null, limit: o.limit ?? null, scope } };
}

export const findCodeDefinitions: StoreMember<[symbol: string, opts?: CodeSymbolQuery], CodeDefinitionRow[]> =
  async (brain, symbol, opts) => {
    const { o, input } = symbolInput('findCodeDefinitions', symbol, opts, true);
    if (namesNoSource(o)) return [];
    const rows: CodeDefinitionRow[] = await storeCall({ member: 'findCodeDefinitions' },
      () => brain.findCodeDefinitions({ ...input, limit: input.limit ?? 20, defTypes: [...DEF_TYPES, 'export statement'] }));
    return rows.map(codeRow);
  };

export const listSymbolTypesForName: StoreMember<[symbol: string, opts?: Omit<CodeSymbolQuery, 'limit'>], Array<string | null>> =
  async (brain, symbol, opts) => {
    const { o, input } = symbolInput('listSymbolTypesForName', symbol, opts, false);
    if (namesNoSource(o)) return [];
    return storeCall({ member: 'listSymbolTypesForName' }, () => brain.listSymbolTypesForName(input));
  };

export const findCodeRefChunks: StoreMember<[symbol: string, opts?: CodeSymbolQuery], CodeRefChunkRow[]> =
  async (brain, symbol, opts) => {
    const { o, input } = symbolInput('findCodeRefChunks', symbol, opts, true);
    if (namesNoSource(o)) return [];
    const rows: CodeRefChunkRow[] = await storeCall({ member: 'findCodeRefChunks' },
      () => brain.findCodeRefChunks({ ...input, limit: input.limit ?? 50 }));
    return rows.map(codeRow);
  };

export const countOversizedEmbedSkips: StoreMember<[maxBytes: number], { marked: number; chunkless: number }> =
  async (brain, maxBytes) => {
    const r: { marked: number; chunkless: number } = await storeCall({ member: 'countOversizedEmbedSkips' },
      () => brain.countOversizedEmbedSkips(Number(maxBytes)));
    return { marked: Number(r.marked), chunkless: Number(r.chunkless) };
  };

export const countOrphanChunks: StoreMember<[], number> =
  async (brain) => Number(await storeCall({ member: 'countOrphanChunks' }, () => brain.countOrphanChunks()));

export const countCodeChunkPages: StoreMember<[], { chunks: number; pages: number }> = async (brain) => {
  const r: { chunks: number; pages: number } = await storeCall({ member: 'countCodeChunkPages' }, () => brain.countCodeChunkPages());
  return { chunks: Number(r.chunks), pages: Number(r.pages) };
};

/** Any stored chunk of a live code page under `{ ...policy, sourceId }`; `pageReadFilter` reads no `allSources`. */
export const codeChunksExist: StoreMember<[sourceId: string | undefined, policy?: PageReadScope], boolean> =
  async (brain, sourceId, policy) => {
    const o = takeOptions('codeChunksExist', { ...policy, sourceId }, POLICY_KEYS.filter(k => k !== 'allSources'), UNREAD_BY_FILTER);
    if (namesNoSource(o)) return false;
    // pageReadFilter reads no safe-chunk key; only codeReadFilter does.
    const scope = { sourceId: o.sourceId, sourceIds: o.sourceIds, excludePrivate: storePagePolicy('codeChunksExist', o.excludePrivate, { callerReaders: true }) ?? null };
    return !!(await storeCall({ member: 'codeChunksExist' }, () => brain.codeChunksExist({ served: false, withSymbol: false, scope })));
  };

/**
 * Search's safe-index probe: a live page in scope below the chunker-version fence, under the type list and the
 * hard-excluded slug prefixes. `pageReadFilter` reads no `allSources` or safe-chunk key, so neither does the store.
 */
export const hasUnsealedPages: StoreMember<[scope: UnsealedPageScope], boolean> = async (brain, scope) => {
  const taken = takeOptions('hasUnsealedPages', scope, ['sourceId', 'sourceIds', 'excludePrivate', ...TRUST_KEYS, 'types', 'excludeSlugPrefixes'],
    ['allSources', 'requireSafeChunks', ...UNREAD_BY_FILTER]);
  if (namesNoSource(taken)) return false;
  const o = taken as UnsealedPageScope;
  const input = {
    scope: {
      sourceId: o.sourceId, sourceIds: o.sourceIds,
      excludePrivate: storePagePolicy('hasUnsealedPages', o.excludePrivate, { callerReaders: true }) ?? null,
      minTrust: o.minTrust || null, suppressFlagged: o.suppressFlagged === true,
    },
    types: o.types ?? null,
    excludeSlugPrefixes: o.excludeSlugPrefixes ?? [],
  };
  return !!(await storeCall({ member: 'hasUnsealedPages' }, () => brain.hasUnsealedPages(input)));
};

export const currentCodeChunksExist: StoreMember<[scope: CodeChunkScope, predicate: 'any' | 'with_symbol'], boolean> =
  async (brain, scope, predicate) => {
    const o = takeOptions('currentCodeChunksExist', scope, POLICY_KEYS, UNREAD_BY_FILTER);
    if (namesNoSource(o)) return false;
    const wire = wireScope('currentCodeChunksExist', o, true);
    return !!(await storeCall({ member: 'currentCodeChunksExist' },
      () => brain.codeChunksExist({ served: true, withSymbol: predicate === 'with_symbol', scope: wire })));
  };

export const listQualifiedSymbolNames: StoreMember<[sourceId: string, symbol: string, opts: { match: 'exact' | 'contains'; limit: number }], string[]> =
  async (brain, sourceId, symbol, opts) => {
    const limit = Math.max(0, Math.floor(opts.limit));
    if (!Number.isSafeInteger(limit)) refuseMember('listQualifiedSymbolNames', 'a limit that is not a finite number');
    return storeCall({ member: 'listQualifiedSymbolNames' },
      () => brain.listQualifiedSymbolNames({ sourceId, symbol, match: opts.match === 'contains' ? 'contains' : 'exact', limit }));
  };

export const listSymbolLanguages: StoreMember<[sourceId: string, qualified: string], string[]> = (brain, sourceId, qualified) =>
  storeCall({ member: 'listSymbolLanguages' }, () => brain.listSymbolLanguages({ sourceId, qualified }));

export const listSupportedChunkIds: StoreMember<[chunkIds: readonly number[], languages: readonly string[]], number[]> =
  async (brain, chunkIds, languages) => {
    const ids = [...chunkIds].map(Number);
    if (!ids.every(Number.isSafeInteger)) refuseMember('listSupportedChunkIds', 'a chunk id that is not an integer');
    if (ids.length === 0 || languages.length === 0) return [];
    return storeCall({ member: 'listSupportedChunkIds' }, () => brain.listSupportedChunkIds({ chunkIds: ids, languages: [...languages] }));
  };

/** In id order (deterministic); the SQL engines run master's statements, whose order past the limit is the plan's. */
export const listSymbolChunkIds: StoreMember<[lookup: 'near_symbol' | 'edge_targets', symbols: readonly string[], sourceId?: string], number[]> =
  async (brain, lookup, symbols, sourceId) => {
    if (symbols.length === 0) return [];
    return storeCall({ member: 'listSymbolChunkIds' }, () => brain.listSymbolChunkIds({
      symbols: lookup === 'near_symbol' ? [symbols[0]!] : [...symbols], sourceId: sourceId || null, limit: SYMBOL_CHUNK_LOOKUP_LIMIT }));
  };

export const listWithdrawalChunks: StoreMember<[sourceId: string, keys: WithdrawalChunkKey[], opts: { after: number; limit: number; subjects: string[] | null }], WithdrawalChunkRow[]> =
  async (brain, sourceId, keys, opts) => {
    if (!Number.isSafeInteger(opts.after) || !Number.isSafeInteger(opts.limit)) refuseMember('listWithdrawalChunks', 'an after or limit that is not an integer');
    const rows: WithdrawalChunkRow[] = await storeCall({ member: 'listWithdrawalChunks' }, () => brain.listWithdrawalChunks({
      sourceId, keys: keys.map(k => ({ subject: k.subject, patterns: k.patterns })), after: opts.after, limit: Math.max(0, opts.limit), subjects: opts.subjects,
    }));
    return rows.map(r => ({ ...r, id: Number(r.id), page_id: Number(r.page_id) }));
  };

export const deleteChunksForPages: StoreMember<[pageIds: readonly number[]], void> = async (brain, pageIds) => {
  const ids = int32Ids('deleteChunksForPages', pageIds);
  await storeCall({ member: 'deleteChunksForPages' }, () => brain.deleteChunksForPages(ids));
};

/** Unlike deleteChunks the slug is matched as written and the text seal is kept. */
export const deleteChunksExcept: StoreMember<[slug: string, keepIds: readonly number[], opts?: { sourceId?: string }], void> =
  async (brain, slug, keepIds, opts) => {
    const keep = int32Ids('deleteChunksExcept', keepIds);
    const { sourceId } = takeOptions('deleteChunksExcept', opts, ['sourceId']) as { sourceId?: string };
    await storeCall({ member: 'deleteChunksExcept', slug }, () => brain.deleteChunksExcept({ slug, keepIds: keep, sourceId: sourceId ?? 'default' }));
  };

export const listContextualModeCandidates: StoreMember<[sourceIds: string[]], ContextualModeCandidate[]> =
  async (brain, sourceIds) => {
    const rows: ContextualModeCandidate[] = await storeCall({ member: 'listContextualModeCandidates' },
      () => brain.listContextualModeCandidates(sourceIds.map(String)));
    return rows.map(r => ({ ...r, id: Number(r.id), chars: Number(r.chars) }));
  };

export const resolveFrozenHits: StoreMember<[hits: FrozenHitKey[], scope: PageReadScope], FrozenHitRow[]> =
  async (brain, hits, scope) => {
    if (hits.length === 0) return [];
    const o = takeOptions('resolveFrozenHits', scope, [...POLICY_KEYS.filter(k => k !== 'allSources'), ...TRUST_KEYS], UNREAD_BY_FILTER);
    const wire = wireScope('resolveFrozenHits', o, false);
    // The SQL engines bind chunk ids and ords into int[]; a value outside int4 is refused there.
    int32Ids('resolveFrozenHits', hits.flatMap(h => [h.chunk_id, h.ord]));
    const rows: FrozenHitRow[] = await storeCall({ member: 'resolveFrozenHits' }, () => brain.resolveFrozenHits({
      hits: hits.map(h => ({ source_id: String(h.source_id), slug: String(h.slug), chunk_id: h.chunk_id, ord: h.ord })), scope: wire,
    }));
    return rows.map(r => ({
      ...r,
      ord: Number(r.ord),
      page_id: Number(r.page_id),
      effective_date: r.effective_date === null || r.effective_date === undefined ? null : new Date(r.effective_date),
    }));
  };

/**
 * Where each search hit on a served segmented page starts in its body (`segmentRegions`, search/dedup.ts), from the
 * page's segment view instead of the SQL engines' manifest join. Rows are in chunk id order.
 */
export const readSegmentRegions: StoreMember<[hits: ReadonlyArray<{ pageId: number; chunkId: number }>], Array<{ chunk_id: number; byte_start: number }>> =
  async (brain, hits) => {
    if (hits.length === 0) return [];
    // The SQL engines bind the chunk ids into int[]; a value outside int4 is refused there.
    int32Ids('readSegmentRegions', hits.map(h => h.chunkId));
    const rows: Array<{ chunk_id: number | string; byte_start: number | string }> = await storeCall({ member: 'readSegmentRegions' },
      () => brain.readSegmentRegions(hits.map(h => ({ pageId: h.pageId, chunkId: h.chunkId }))));
    return rows.map(r => ({ chunk_id: Number(r.chunk_id), byte_start: Number(r.byte_start) }));
  };
