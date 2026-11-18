/**
 * Batch page reads and writes over the store's page_ops family (rust/docs/store/page_ops.md).
 *
 * Served: readPageSnapshotsBatch, findDuplicatePage, findDuplicatePages, deletePages, purgeDeletedPages, resolveSlugsByPaths,
 * softDeletePages, findPages, countPagesBy, getAllSlugs, listAllPageRefs, listPrefixSampledPages, listCorpusSample,
 * getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getPageTimestamps, getEffectiveDates, revertToVersion.
 * deletePages scrubs the eval candidates' retrieved slugs in the delete's transaction, as PGLite does.
 * purgeDeletedPages (also served) keeps the pages PGLite's atom and derived retirement holds keep, reading the `retired_by`
 * stamp on the page row, and removes and scrubs the rest as deletePages does (rust/docs/store/page_ops.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { DELETE_BATCH_SIZE } from '../../engine-constants.ts';
import type { FindPagesQuery, FoundPages } from '../../page-find.ts';
import type { PageCountQuery, PageCounts, TypeGrouper } from '../../page-counts.ts';
import { pageSnapshotKey, type PageSnapshotBatch } from '../../page-snapshot-batch.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { pickCanonicalOrigin } from '../../persistence/origin-guard.ts';
import { segmentedRevertRefusal } from '../../page-state/versions.ts';
import type { CorpusSampleOpts, DomainBankRow, DomainBankSampleOpts, PageReadScope } from '../../types.ts';
import { toGetPage } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { HYBRID_BAG_KEYS, storePagePolicy } from './private-provenance.ts';

/** PGLite's single-batch primitives throw a plain `Error` past `DELETE_BATCH_SIZE`; the caller chunks. */
function checkBatch(member: string, n: number): void {
  if (n > DELETE_BATCH_SIZE) throw new Error(`${member}: input size ${n} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`);
}

/**
 * A `PageReadScope` as the store reads it. Any scope object turns on PGLite's live filter (not deleted, not quarantined,
 * source not archived), so `live` says one was passed. The trust filters refuse when set: the store keeps no trust tiers.
 * `requireSafeChunks` changes nothing on these reads. `markerRead` is for the marker reads hybridSearch hands its whole
 * option bag: they also accept and ignore the bag's own keys (any other key still refuses) and serve `excludePrivate`
 * as the page policy `pageReadFilter` adds (private-provenance.ts `storePagePolicy`, which refuses a caller whose policy
 * is wider than the store's). The three marker reads (getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates) pass it.
 */
function readScope(member: string, opts: PageReadScope | undefined, markerRead = false): Record<string, unknown> {
  if (opts === undefined || opts === null) return {};
  for (const key of markerRead ? (['minTrust', 'suppressFlagged'] as const) : (['excludePrivate', 'minTrust', 'suppressFlagged'] as const)) {
    if (opts[key]) refuseMember(member, `option ${key}`);
  }
  const ignored = ['requireSafeChunks', 'excludePrivate', 'minTrust', 'suppressFlagged', ...(markerRead ? HYBRID_BAG_KEYS : [])];
  const taken = takeOptions(member, opts, ['sourceId', 'sourceIds'], ignored);
  const excludePrivate = markerRead ? storePagePolicy(member, opts.excludePrivate) : undefined;
  return { ...taken, live: true, ...(excludePrivate ? { excludePrivate } : {}) };
}

const reviveDate = (value: unknown): Date => new Date(String(value));

export const readPageSnapshotsBatch: StoreMember<
  [refs: ReadonlyArray<{ slug: string; sourceId: string }>, opts?: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean }],
  PageSnapshotBatch
> = async (brain, refs, opts) => {
  const { absentIsNull, ...options } = takeOptions('readPageSnapshotsBatch', opts, ['maxBytes', 'includeDeleted', 'absentIsNull']);
  const snapshots = new Map<string, PageSnapshot>();
  if (!refs.length) return { snapshots, covered: 0 };
  const batch: { covered: number; snapshots: Array<PageSnapshot | null> } = await storeCall({ member: 'readPageSnapshotsBatch' }, () =>
    brain.readPageSnapshotsBatch(refs.map((r) => ({ slug: r.slug, sourceId: r.sourceId })), options));
  for (const [i, snapshot] of batch.snapshots.entries()) {
    const ref = refs[i]!;
    const key = pageSnapshotKey(ref.sourceId, ref.slug);
    if (snapshot) {
      snapshots.set(key, { ...snapshot, page: toGetPage(snapshot.page) });
      continue;
    }
    // PGLite reads an absent ref again through readPageSnapshot (same exact key), unless absentIsNull; an empty
    // source id names no source there, while the store would widen it to every source.
    if (absentIsNull || ref.sourceId === '') continue;
    const again: PageSnapshot | null = await storeCall({ member: 'readPageSnapshotsBatch', slug: ref.slug }, () =>
      brain.readPageSnapshot(ref.slug, { sourceId: ref.sourceId, ...(options.includeDeleted ? { includeDeleted: true } : {}) }));
    if (again) snapshots.set(key, { ...again, page: toGetPage(again.page) });
  }
  return { snapshots, covered: batch.covered };
};

type DuplicateInput = { hash: string; frontmatterId?: string | null; excludeSlug?: string };

const toDuplicate = (row: { slug: string; id: number } | null): { slug: string; id: number } | null =>
  row === null ? null : { slug: row.slug, id: Number(row.id) };

export const findDuplicatePage: StoreMember<[sourceId: string, input: DuplicateInput], { slug: string; id: number } | null> = async (brain, sourceId, input) => {
  const query = takeOptions('findDuplicatePage', input, ['hash', 'frontmatterId', 'excludeSlug']);
  return toDuplicate(await storeCall({ member: 'findDuplicatePage' }, () => brain.findDuplicatePage(sourceId, query)));
};

export const findDuplicatePages: StoreMember<[sourceId: string, inputs: ReadonlyArray<DuplicateInput>], Array<{ slug: string; id: number } | null>> = async (
  brain,
  sourceId,
  inputs,
) => {
  if (!inputs.length) return [];
  const queries = inputs.map((input) => takeOptions('findDuplicatePages', input, ['hash', 'frontmatterId', 'excludeSlug']));
  const rows: Array<{ slug: string; id: number } | null> = await storeCall({ member: 'findDuplicatePages' }, () => brain.findDuplicatePages(sourceId, queries));
  return rows.map(toDuplicate);
};

export const deletePages: StoreMember<[slugs: string[], opts: { sourceId: string }], string[]> = async (brain, slugs, opts) => {
  if (slugs.length === 0) return [];
  checkBatch('deletePages', slugs.length);
  const options = takeOptions('deletePages', opts, ['sourceId']);
  // PGLite matches `source_id = $sourceId`; an absent or empty id names no source.
  if (typeof options.sourceId !== 'string' || options.sourceId === '') return [];
  return storeCall({ member: 'deletePages' }, () => brain.deletePages(slugs, options));
};

type PurgedPages = { slugs: string[]; count: number; pages?: { slug: string; source_id: string; deleted_at: Date }[] };

export const purgeDeletedPages: StoreMember<[olderThanHours: number, opts?: { dryRun?: boolean; excludeIds?: number[] }], PurgedPages> = async (
  brain,
  olderThanHours,
  opts,
) => {
  const { excludeIds, ...options } = takeOptions('purgeDeletedPages', opts, ['dryRun', 'excludeIds']);
  // PGLite filters on excludeIds only when the list is not empty.
  if (Array.isArray(excludeIds) && excludeIds.length) options.excludeIds = excludeIds;
  const out: { slugs: string[]; count: number; pages?: Array<{ slug: string; source_id: string; deleted_at: unknown }> } = await storeCall(
    { member: 'purgeDeletedPages' },
    () => brain.purgeDeletedPages(olderThanHours, options),
  );
  if (!out.pages) return { slugs: out.slugs, count: out.count };
  return { slugs: out.slugs, count: out.count, pages: out.pages.map((p) => ({ slug: p.slug, source_id: p.source_id, deleted_at: reviveDate(p.deleted_at) })) };
};

export const softDeletePages: StoreMember<[slugs: string[], opts: { sourceId: string }], string[]> = async (brain, slugs, opts) => {
  if (slugs.length === 0) return [];
  checkBatch('softDeletePages', slugs.length);
  const options = takeOptions('softDeletePages', opts, ['sourceId']);
  // PGLite matches `source_id = $sourceId`; an absent or empty id names no source.
  if (typeof options.sourceId !== 'string' || options.sourceId === '') return [];
  return storeCall({ member: 'softDeletePages' }, () => brain.softDeletePages(slugs, options));
};

export const resolveSlugsByPaths: StoreMember<[paths: string[], opts: { sourceId: string }], Map<string, string>> = async (brain, paths, opts) => {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  checkBatch('resolveSlugsByPaths', paths.length);
  const options = takeOptions('resolveSlugsByPaths', opts, ['sourceId']);
  if (typeof options.sourceId !== 'string' || options.sourceId === '') return out;
  const rows: Array<{ slug: string; source_path: string; live: boolean }> = await storeCall({ member: 'resolveSlugsByPaths' }, () =>
    brain.resolveSlugsByPaths(paths, options));
  for (const path of new Set(rows.map((r) => r.source_path))) {
    const claimants = rows.filter((r) => r.source_path === path);
    const live = claimants.filter((r) => r.live);
    const picked = pickCanonicalOrigin(live.length ? live : claimants, path);
    if (picked && !('ambiguous' in picked)) out.set(path, picked.slug);
  }
  return out;
};

export const findPages: StoreMember<[query: FindPagesQuery], FoundPages> = async (brain, query) => {
  const taken = takeOptions('findPages', query, ['pattern', 'types', 'limit', 'sourceId', 'sourceIds', 'excludeSlugPrefixes']);
  const pattern = query.pattern;
  const found: FoundPages = await storeCall({ member: 'findPages' }, () =>
    brain.findPages({ ...taken, pattern: { kind: pattern.kind, like: pattern.like }, limit: Math.max(0, Math.trunc(Number(query.limit))) }));
  return { rows: found.rows, total: Number(found.total) };
};

/**
 * The ISO form the store reads for `since`, or a refusal. PGLite casts any Postgres timestamp text; the members serve
 * the forms callers pass (an ISO instant, a date), read in UTC as PGLite's session is.
 */
function sinceIso(since: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(since)) return since;
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return `${since}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([+-]\d{2}:?\d{2})$/.test(since)) {
    const date = new Date(since);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return refuseMember('countPagesBy', `since ${JSON.stringify(since)}`);
}

export const countPagesBy: StoreMember<[query: PageCountQuery, groupTypes?: TypeGrouper], PageCounts> = async (brain, query, groupTypes) => {
  const taken = takeOptions('countPagesBy', query, ['sourceId', 'sourceIds', 'since']);
  // PGLite's `since` is a truthiness test: an empty string adds no bound.
  if (typeof taken.since === 'string' && taken.since !== '') taken.since = sinceIso(taken.since);
  else delete taken.since;
  const plain: PageCounts = await storeCall({ member: 'countPagesBy' }, () => brain.countPagesBy(taken));
  if (!groupTypes) return plain;
  const types = [...new Set(plain.bySourceType.map((row) => row.type))];
  const groups = groupTypes(types);
  // unnest pads a short group list with NULL, which PGLite reports as ''.
  const typeGroups = Object.fromEntries(types.map((type, i) => [type, groups[i] ?? '']));
  const grouped: PageCounts = await storeCall({ member: 'countPagesBy' }, () => brain.countPagesBy({ ...taken, typeGroups }));
  return { ...grouped, bySourceType: plain.bySourceType };
};

export const getAllSlugs: StoreMember<[opts?: { sourceId?: string }], Set<string>> = async (brain, opts) => {
  const options = takeOptions('getAllSlugs', opts, ['sourceId']);
  const slugs: string[] = await storeCall({ member: 'getAllSlugs' }, () => brain.getAllSlugs(options));
  return new Set(slugs);
};

export const listAllPageRefs: StoreMember<[], Array<{ slug: string; source_id: string; updated_at: Date }>> = async (brain) => {
  const rows: Array<{ slug: string; source_id: string; updated_at: string }> = await storeCall({ member: 'listAllPageRefs' }, () => brain.listAllPageRefs());
  return rows.map((r) => ({ slug: r.slug, source_id: r.source_id, updated_at: reviveDate(r.updated_at) }));
};

type StoreBankRow = Omit<DomainBankRow, 'last_retrieved_at'> & { last_retrieved_at: string | null };

const toDomainBankRow = (row: StoreBankRow): DomainBankRow => ({
  slug: row.slug,
  source_id: row.source_id,
  prefix: row.prefix,
  page_id: Number(row.page_id),
  title: row.title,
  compiled_truth: row.compiled_truth ?? '',
  connection_count: Number(row.connection_count),
  last_retrieved_at: row.last_retrieved_at == null ? null : reviveDate(row.last_retrieved_at),
  representative_chunk_id: row.representative_chunk_id == null ? null : Number(row.representative_chunk_id),
});

export const listPrefixSampledPages: StoreMember<[opts: DomainBankSampleOpts], DomainBankRow[]> = async (brain, opts) => {
  const options = takeOptions('listPrefixSampledPages', opts, ['prefixes', 'excludeSlugs', 'staleBias', 'staleThresholdDays', 'sourceId', 'sourceIds']);
  if (!opts.prefixes.length) return [];
  const rows: StoreBankRow[] = await storeCall({ member: 'listPrefixSampledPages' }, () => brain.listPrefixSampledPages(options));
  return rows.map(toDomainBankRow);
};

export const listCorpusSample: StoreMember<[opts: CorpusSampleOpts], DomainBankRow[]> = async (brain, opts) => {
  const options = takeOptions('listCorpusSample', opts, ['n', 'excludeSlugs', 'seed', 'sourceId', 'sourceIds']);
  if (!(opts.n > 0)) return [];
  if (typeof options.seed === 'number') options.seed = Math.max(-1, Math.min(1, options.seed));
  else delete options.seed;
  const rows: StoreBankRow[] = await storeCall({ member: 'listCorpusSample' }, () => brain.listCorpusSample(options));
  return rows.map(toDomainBankRow);
};

/** Page ids as the store reads them: integers only, as Postgres's `int[]` cast requires. */
function pageIds(member: string, ids: number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) throw new TypeError(`${member}: page id ${String(id)} is not an integer`);
  return ids;
}

export const getContentFlagsByPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { reason: string; detail: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getContentFlagsByPageIds', opts, true);
  const rows: Array<{ id: number; reason: string; detail: string }> = await storeCall({ member: 'getContentFlagsByPageIds' }, () =>
    brain.getContentFlagsByPageIds(pageIds('getContentFlagsByPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { reason: r.reason, detail: r.detail }]));
};

export const getUnverifiedExtractionPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { unverified: boolean; status: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getUnverifiedExtractionPageIds', opts, true);
  const rows: Array<{ id: number; status: string; unverified: boolean }> = await storeCall({ member: 'getUnverifiedExtractionPageIds' }, () =>
    brain.getUnverifiedExtractionPageIds(pageIds('getUnverifiedExtractionPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { unverified: r.unverified === true, status: r.status }]));
};

export const getPageTimestamps: StoreMember<[slugs: string[]], Map<string, Date>> = async (brain, slugs) => {
  if (slugs.length === 0) return new Map();
  const rows: Array<{ slug: string; ts: string }> = await storeCall({ member: 'getPageTimestamps' }, () => brain.getPageTimestamps(slugs));
  return new Map(rows.map((r) => [r.slug, reviveDate(r.ts)]));
};

export const getEffectiveDates: StoreMember<[refs: Array<{ slug: string; source_id: string }>, opts?: PageReadScope], Map<string, Date>> = async (
  brain,
  refs,
  opts,
) => {
  if (!refs.length) return new Map();
  const scope = readScope('getEffectiveDates', opts, true);
  const rows: Array<{ slug: string; source_id: string; ts: string }> = await storeCall({ member: 'getEffectiveDates' }, () =>
    brain.getEffectiveDates(refs.map((r) => ({ slug: r.slug, source_id: r.source_id })), scope));
  return new Map(rows.map((r) => [`${r.source_id}::${r.slug}`, reviveDate(r.ts)]));
};

export const revertToVersion: StoreMember<[slug: string, versionId: number, opts?: { sourceId?: string }], void> = async (brain, slug, versionId, opts) => {
  const options = takeOptions('revertToVersion', opts, ['sourceId']);
  if (!Number.isSafeInteger(versionId)) throw new TypeError(`revertToVersion: version id ${String(versionId)} is not an integer`);
  try {
    await storeCall({ member: 'revertToVersion', slug }, () => brain.revertToVersion(slug, versionId, options));
  } catch (error) {
    // The store refuses a segmented page or version before it writes; PGLite throws this OperationError.
    if (storeErrorCode(error) === 'page_body_segmented') throw segmentedRevertRefusal(slug, versionId);
    throw error;
  }
};
