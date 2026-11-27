/**
 * Batch page reads and writes over the store's page_ops family (rust/docs/store/page_ops.md).
 *
 * Served: readPageSnapshotsBatch, findDuplicatePage, findDuplicatePages, deletePages, purgeDeletedPages, resolveSlugsByPaths,
 * softDeletePages, findPages, countPagesBy, getAllSlugs, listAllPageRefs, listPrefixSampledPages, listCorpusSample, bumpPageRetrievals,
 * the atoms-restore reads listRestorableAtoms and countKeptAtomRetirements (page_ops/atom_restore.rs), the moved-pages reads
 * listLivePagesBySourcePaths, listLivePagesByFileName, listLivePagesSharingFrontmatterId, hasSegmentedHistory and
 * readLivePagesByIds (moved_page_reads.rs), the stale-atoms read listStaleAtoms (page_ops/stale_atoms.rs),
 * getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getPageTimestamps, getEffectiveDates, readAdmittedPageRefs, readAdmittedPageDateFields, readPageDateFieldsByIds,
 * readPageSynopses, readSeedTitleSlugs, revertToVersion.
 * deletePages scrubs the eval candidates' retrieved slugs in the delete's transaction, as PGLite does.
 * purgeDeletedPages (also served) keeps the pages PGLite's atom and derived retirement holds keep, reading the `retired_by`
 * stamp on the page row, and removes and scrubs the rest as deletePages does (rust/docs/store/page_ops.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { OwnerOnlyForm } from '../../access/owner-only.ts';
import { DELETE_BATCH_SIZE } from '../../engine-constants.ts';
import { assertPurgeAge, TrustFloorError } from '../../engine-errors.ts';
import type { FindPagesQuery, FoundPages } from '../../page-find.ts';
import type { PageCountQuery, PageCounts, TypeGrouper } from '../../page-counts.ts';
import { pageSnapshotKey, type PageSnapshotBatch } from '../../page-snapshot-batch.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { pickCanonicalOrigin } from '../../persistence/origin-guard.ts';
import { segmentedRevertRefusal } from '../../page-state/versions.ts';
import type { CorpusSampleOpts, DomainBankRow, DomainBankSampleOpts, PageReadPolicy, PageReadScope } from '../../types.ts';
import type { RestorableAtomRow } from '../../engine-sql/atom-restore-reads.ts';
import type { MovedPageRow } from '../../engine-sql/moved-page-reads.ts';
import type { StaleAtomRow } from '../../engine-sql/stale-atom-reads.ts';
import type { PageDateFieldsByIdRow, PageDateFieldsRow, PageRefRow, RelationalPageRow } from '../../engine-sql/relational-reads.ts';
import { toGetPage } from '../store-codec.ts';
import { overlayStoreSnapshots, storeNormalizer, type StoreSnapshot } from '../snapshot-overlay.ts';
import { storeErrorCode } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { HYBRID_BAG_KEYS, WHOKNOWS_KEYS, storePagePolicy } from './private-provenance.ts';
import type { MeetingPageRow } from '../../engine-sql/meeting-pages.ts';

/** PGLite's single-batch primitives throw a plain `Error` past `DELETE_BATCH_SIZE`; the caller chunks. */
function checkBatch(member: string, n: number): void {
  if (n > DELETE_BATCH_SIZE) throw new Error(`${member}: input size ${n} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`);
}

/** The page read policy keys (`PageReadPolicy`); a key the type gains and this list misses fails to compile. */
const READ_POLICY_KEYS = ['sourceId', 'sourceIds', 'excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged',
  'takesHoldersAllowList'] as const satisfies ReadonlyArray<keyof PageReadPolicy>;
const READ_POLICY_KEYS_COMPLETE: Exclude<keyof PageReadPolicy, (typeof READ_POLICY_KEYS)[number]> extends never ? true : never = true;
void READ_POLICY_KEYS_COMPLETE;

/**
 * A `PageReadScope` as the store reads it (`pageReadFilter`, search/read-policy-sql.ts). Any scope object turns on
 * PGLite's live filter (not deleted, not quarantined, source not archived), so `live` says one was passed.
 * `excludePrivate` applies the page policy (private-provenance.ts `storePagePolicy`), a caller's reader identity and
 * private-readable grant included; `minTrust` and `suppressFlagged`
 * apply the page's stored trust tier and its write-gate flag receipts (`pageEligibleSql`). `requireSafeChunks` and
 * `takesHoldersAllowList` change nothing on these reads. The marker reads (every member that uses this) are handed hybridSearch's whole option bag as
 * their policy, so they also accept and ignore the bag's own keys (`HYBRID_BAG_KEYS`, and whoknows' `WHOKNOWS_KEYS`); any other key still refuses.
 */
function readScope(member: string, opts: PageReadScope | undefined): Record<string, unknown> {
  if (opts === undefined || opts === null) return {};
  const taken = takeOptions(member, opts, ['sourceId', 'sourceIds', 'excludePrivate', 'minTrust', 'suppressFlagged'], ['requireSafeChunks', 'takesHoldersAllowList', ...HYBRID_BAG_KEYS, ...WHOKNOWS_KEYS]);
  // A floor that is not text names no trust tier: refuse it as the store does for text, before the napi decode (#10276).
  if (taken.minTrust && typeof taken.minTrust !== 'string') throw new TrustFloorError(taken.minTrust);
  return {
    sourceId: taken.sourceId, sourceIds: taken.sourceIds, live: true,
    excludePrivate: storePagePolicy(member, taken.excludePrivate, { callerReaders: true }) ?? null,
    minTrust: taken.minTrust || null,
    suppressFlagged: taken.suppressFlagged === true,
  };
}

const reviveDate = (value: unknown): Date => new Date(String(value));

export const readPageSnapshotsBatch: StoreMember<
  [refs: ReadonlyArray<{ slug: string; sourceId: string }>, opts?: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean }],
  PageSnapshotBatch
> = async (brain, refs, opts) => {
  const { absentIsNull, ...options } = takeOptions('readPageSnapshotsBatch', opts, ['maxBytes', 'includeDeleted', 'absentIsNull']);
  const snapshots = new Map<string, PageSnapshot>();
  if (!refs.length) return { snapshots, covered: 0 };
  const stored = new Map<string, StoreSnapshot>();
  const batch: { covered: number; snapshots: Array<StoreSnapshot | null> } = await storeCall({ member: 'readPageSnapshotsBatch' }, () =>
    brain.readPageSnapshotsBatch(refs.map((r) => ({ slug: r.slug, sourceId: r.sourceId })), options));
  for (const [i, snapshot] of batch.snapshots.entries()) {
    const ref = refs[i]!;
    const key = pageSnapshotKey(ref.sourceId, ref.slug);
    if (snapshot) {
      stored.set(key, { ...snapshot, page: toGetPage(snapshot.page) });
      continue;
    }
    // PGLite reads an absent ref again through readPageSnapshot (same exact key), unless absentIsNull; an empty
    // source id names no source there, while the store would widen it to every source.
    if (absentIsNull || ref.sourceId === '') continue;
    const again: StoreSnapshot | null = await storeCall({ member: 'readPageSnapshotsBatch', slug: ref.slug }, () =>
      brain.readPageSnapshot(ref.slug, { sourceId: ref.sourceId, ...(options.includeDeleted ? { includeDeleted: true } : {}) }));
    if (again) stored.set(key, { ...again, page: toGetPage(again.page) });
  }
  // One overlay of every page, the store normalizing the fence text of those with ledger rows to apply in one call.
  const overlaid = await overlayStoreSnapshots(storeNormalizer(brain), [...stored.values()]);
  [...stored.keys()].forEach((key, i) => snapshots.set(key, overlaid[i]!));
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
  // The same typed refusal as the SQL engines (the store refuses the same inputs with code invalid_argument too).
  assertPurgeAge(olderThanHours);
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
  const { untrusted, ...taken } = takeOptions('findPages', query,
    ['pattern', 'types', 'limit', 'sourceId', 'sourceIds', 'excludeSlugPrefixes', 'untrusted']);
  const pattern = query.pattern;
  // PGLite applies an untrusted policy (any object) as a live page read filter; the store reads it as a read scope.
  const policy = untrusted ? readScope('findPages', untrusted as PageReadScope) : null;
  const found: FoundPages = await storeCall({ member: 'findPages' }, () => brain.findPages({
    ...taken, pattern: { kind: pattern.kind, like: pattern.like }, limit: Math.max(0, Math.trunc(Number(query.limit))), untrusted: policy,
  }));
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

/** Records now as each page's retrieval time, 5-minute throttled (gbrain-store `page_ops/retrievals.rs`). */
export const bumpPageRetrievals: StoreMember<[pageIds: number[]], void> = async (brain, ids) => {
  if (!ids.length) return;
  await storeCall({ member: 'bumpPageRetrievals' }, () => brain.bumpPageRetrievals(pageIds('bumpPageRetrievals', ids)));
};

export const getContentFlagsByPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { reason: string; detail: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getContentFlagsByPageIds', opts);
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
  const scope = readScope('getUnverifiedExtractionPageIds', opts);
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
  const scope = readScope('getEffectiveDates', opts);
  const rows: Array<{ slug: string; source_id: string; ts: string }> = await storeCall({ member: 'getEffectiveDates' }, () =>
    brain.getEffectiveDates(refs.map((r) => ({ slug: r.slug, source_id: r.source_id })), scope));
  return new Map(rows.map((r) => [`${r.source_id}::${r.slug}`, reviveDate(r.ts)]));
};

/**
 * The relational recall arm's seed admit read (engine-sql/relational-reads.ts): the refs whose live page `policy`
 * admits, always under the live filter, as the SQL statement sets it.
 */
export const readAdmittedPageRefs: StoreMember<[refs: readonly PageRefRow[], policy: PageReadPolicy], PageRefRow[]> = async (brain, refs, policy) => {
  if (!refs.length) return [];
  const scope = readScope('readAdmittedPageRefs', policy ?? {});
  const rows: PageRefRow[] = await storeCall({ member: 'readAdmittedPageRefs' }, () =>
    brain.readAdmittedPageRefs(refs.map((r) => ({ source_id: r.source_id, slug: r.slug })), scope));
  return rows.map((r) => ({ source_id: r.source_id, slug: r.slug }));
};

/**
 * The observed-date page read (engine-sql/relational-reads.ts, search/evidence-date.ts): the frontmatter and import
 * filename of the refs' live pages `policy` admits, always under the live filter, as the SQL statement sets it.
 */
export const readAdmittedPageDateFields: StoreMember<[refs: readonly PageRefRow[], policy: PageReadPolicy], PageDateFieldsRow[]> = async (brain, refs, policy) => {
  if (!refs.length) return [];
  const scope = readScope('readAdmittedPageDateFields', policy ?? {});
  const rows: PageDateFieldsRow[] = await storeCall({ member: 'readAdmittedPageDateFields' }, () =>
    brain.readAdmittedPageDateFields(refs.map((r) => ({ source_id: r.source_id, slug: r.slug })), scope));
  return rows.map((r) => ({ source_id: r.source_id, slug: r.slug, frontmatter: r.frontmatter, import_filename: r.import_filename ?? null }));
};

/** The date header's page read by id (engine-sql/relational-reads.ts, search/evidence-date.ts loadPageDateHeaders). */
export const readPageDateFieldsByIds: StoreMember<[ids: readonly number[]], PageDateFieldsByIdRow[]> = async (brain, ids) => {
  if (!ids.length) return [];
  if (!ids.every(Number.isSafeInteger)) refuseMember('readPageDateFieldsByIds', 'a page id that is not an integer');
  const rows: PageDateFieldsByIdRow[] = await storeCall({ member: 'readPageDateFieldsByIds' }, () => brain.readPageDateFieldsByIds([...ids]));
  return rows.map((r) => ({ id: r.id, slug: r.slug, frontmatter: r.frontmatter, import_filename: r.import_filename ?? null }));
};

/**
 * The relational recall arm's hydrate read (engine-sql/relational-reads.ts): the refs' pages `policy` admits and the
 * search visibility clause shows, with the first 65536 code points of the body as `synopsis`.
 */
export const readPageSynopses: StoreMember<[refs: readonly PageRefRow[], policy?: PageReadPolicy], RelationalPageRow[]> = async (brain, refs, policy) => {
  if (!refs.length) return [];
  const scope = readScope('readPageSynopses', policy ?? {});
  const rows: RelationalPageRow[] = await storeCall({ member: 'readPageSynopses' }, () =>
    brain.readPageSynopses(refs.map((r) => ({ source_id: r.source_id, slug: r.slug })), scope));
  return rows.map((r) => ({
    page_id: Number(r.page_id), slug: r.slug, source_id: r.source_id, title: r.title, type: r.type, synopsis: r.synopsis ?? null,
  }));
};

/** The relational recall arm's title seed (engine-sql/relational-reads.ts): at most two live, unretired typed pages. */
export const readSeedTitleSlugs: StoreMember<[sourceId: string, types: readonly string[], title: string], string[]> = async (brain, sourceId, types, title) => {
  if (!types.length) return [];
  return storeCall({ member: 'readSeedTitleSlugs' }, () => brain.readSeedTitleSlugs(sourceId, [...types], title));
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

/** The restorable re-extraction retirements of the sources (or atom `atomId`), by id (page_ops/atom_restore.rs). */
export const listRestorableAtoms: StoreMember<[sourceIds: readonly string[], atomId: number | null], RestorableAtomRow[]> = async (brain, sourceIds, atomId) => {
  if (atomId !== null && !Number.isSafeInteger(atomId)) refuseMember('listRestorableAtoms', 'an atom id that is not an integer');
  const rows: RestorableAtomRow[] = await storeCall({ member: 'listRestorableAtoms' }, () => brain.listRestorableAtoms([...sourceIds], atomId));
  return rows.map(row => ({ ...row, id: Number(row.id), origin_page_id: row.origin_page_id == null ? null : Number(row.origin_page_id),
    version_id: row.version_id == null ? null : Number(row.version_id) }));
};

export const countKeptAtomRetirements: StoreMember<[sourceIds: readonly string[]], { origin_gone: number; replaced: number; older_generation: number }> = async (brain, sourceIds) => {
  const row: { origin_gone: number; replaced: number; older_generation: number } = await storeCall({ member: 'countKeptAtomRetirements' }, () => brain.countKeptAtomRetirements([...sourceIds]));
  return { origin_gone: Number(row.origin_gone), replaced: Number(row.replaced), older_generation: Number(row.older_generation) };
};

function wholeNumber(member: string, what: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `${what} that is not an integer`);
}

const movedRow = (r: MovedPageRow): MovedPageRow => ({ id: Number(r.id), slug: r.slug, revision: String(r.revision), source_path: r.source_path ?? null });

export const listLivePagesBySourcePaths: StoreMember<[sourceId: string, excludeId: number, paths: readonly string[]], MovedPageRow[]> = async (brain, sourceId, excludeId, paths) => {
  wholeNumber('listLivePagesBySourcePaths', 'a page id', excludeId);
  const rows: MovedPageRow[] = await storeCall({ member: 'listLivePagesBySourcePaths', sourceId }, () => brain.listLivePagesBySourcePaths(sourceId, excludeId, [...paths]));
  return rows.map(movedRow);
};

export const listLivePagesByFileName: StoreMember<[sourceId: string, excludeId: number, name: string], Array<{ slug: string; source_path: string }>> = (brain, sourceId, excludeId, name) => {
  wholeNumber('listLivePagesByFileName', 'a page id', excludeId);
  return storeCall({ member: 'listLivePagesByFileName', sourceId }, () => brain.listLivePagesByFileName(sourceId, excludeId, name));
};

/** The live page of the source holding the meeting, lowest id first, or null (engine-sql/meeting-pages.ts; rust/crates/gbrain-store/src/meeting_pages.rs). */
export const readMeetingPage: StoreMember<[sourceId: string, meetingId: string], MeetingPageRow | null> = (brain, sourceId, meetingId) =>
  storeCall({ member: 'readMeetingPage', sourceId }, () => brain.readMeetingPage(sourceId, meetingId)) as Promise<MeetingPageRow | null>;

/** At most two live person pages of the source an attendee name can mean (engine-sql/attendance-pages.ts; meeting_pages.rs). */
export const listAttendanceMatches: StoreMember<[sourceId: string, slugs: readonly string[], name: string], string[]> = (brain, sourceId, slugs, name) =>
  storeCall({ member: 'listAttendanceMatches', sourceId }, () => brain.listAttendanceMatches(sourceId, [...slugs], name)) as Promise<string[]>;

export const listLivePagesSharingFrontmatterId: StoreMember<[sourceId: string, pageId: number], string[]> = (brain, sourceId, pageId) => {
  wholeNumber('listLivePagesSharingFrontmatterId', 'a page id', pageId);
  return storeCall({ member: 'listLivePagesSharingFrontmatterId', sourceId }, () => brain.listLivePagesSharingFrontmatterId(sourceId, pageId));
};

export const hasSegmentedHistory: StoreMember<[pageId: number], boolean> = (brain, pageId) => {
  wholeNumber('hasSegmentedHistory', 'a page id', pageId);
  return storeCall({ member: 'hasSegmentedHistory' }, () => brain.hasSegmentedHistory(pageId));
};

export const readLivePagesByIds: StoreMember<[sourceId: string, ids: readonly number[]], MovedPageRow[]> = async (brain, sourceId, ids) => {
  for (const id of ids) wholeNumber('readLivePagesByIds', 'a page id', id);
  const rows: MovedPageRow[] = await storeCall({ member: 'readLivePagesByIds', sourceId }, () => brain.readLivePagesByIds(sourceId, [...ids]));
  return rows.map(movedRow);
};

/** The stale atoms of the sources (or atom `atomId`), origin-gone first, then by id (page_ops/stale_atoms.rs). */
export const listStaleAtoms: StoreMember<[sourceIds: readonly string[], atomId: number | null], StaleAtomRow[]> = async (brain, sourceIds, atomId) => {
  if (atomId !== null) wholeNumber('listStaleAtoms', 'an atom id', atomId);
  const rows: StaleAtomRow[] = await storeCall({ member: 'listStaleAtoms' }, () => brain.listStaleAtoms([...sourceIds], atomId));
  return rows.map(row => ({ ...row, id: Number(row.id), origin_page_id: row.origin_page_id == null ? null : Number(row.origin_page_id), chars: Number(row.chars) }));
};

/** The slugs of the source's markdown pages, soft-deleted pages included, by byte order. */
export const listMarkdownPageSlugs: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  await storeCall({ member: 'listMarkdownPageSlugs' }, () => brain.listMarkdownPageSlugs(sourceId)) as string[];
