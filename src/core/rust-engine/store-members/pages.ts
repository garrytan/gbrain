/** Page members (BrainEngine getPage .. resolveSlugs, softDeletePage, restorePage, deletePage). */
import type { PageSnapshot } from '../../page-state/types.ts';
import type { PageWriteOptions, PageSnapshotOptions } from '../../page-state/types.ts';
import type { GetPageOpts, Page, PageFilters, PageInput, PageReadScope } from '../../types.ts';
import { toGetPage, toListPage, toPutPage, withIsoDates } from '../store-codec.ts';
import { overlayStoreSnapshot, storeNormalizer, type StoreSnapshot } from '../snapshot-overlay.ts';
import { assertOriginUnclaimed, sourceOriginScope } from '../../persistence/origin-guard.ts';
import type { SyncOriginScope } from '../../persistence/sync-origin.ts';
import type { BrainEngine } from '../../engine.ts';
import type { RustEngine } from '../../rust-engine.ts';
import { validateSlug } from '../../utils.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

const READ_SCOPE = ['sourceId', 'sourceIds', 'includeDeleted', 'excludePrivate', 'resolveAlias', 'requireUnambiguous',
  'requireLiveSource', 'preserveExactIdentity'] as const;

/**
 * The store scope of a page read: `excludePrivate` becomes the page policy (`privatePagesFilterForCaller('p')`, with the
 * caller's reader identity and private-readable grant), under which a hidden page reads as missing.
 */
function pageScope(member: string, opts: object | undefined, allowed: readonly string[], ignored: readonly string[] = []): Record<string, unknown> {
  const scope = takeOptions(member, opts, allowed, ignored);
  if ('excludePrivate' in scope) scope.excludePrivate = storePagePolicy(member, scope.excludePrivate, { callerReaders: true }) ?? null;
  return scope;
}

export const readPageSnapshot: StoreMember<[slug: string, opts?: PageSnapshotOptions], PageSnapshot | null> = async (brain, slug, opts) => {
  const scope = pageScope('readPageSnapshot', opts, READ_SCOPE);
  const snapshot: StoreSnapshot | null = await storeCall({ member: 'readPageSnapshot', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : overlayStoreSnapshot(storeNormalizer(brain), { ...snapshot, page: toGetPage(snapshot.page) });
};

/**
 * `readPolicyOpts` (get_write_attribution) also passes `requireSafeChunks` and `takesHoldersAllowList`. The SQL page
 * read (page-state/snapshot.ts) reads neither: they fence chunk and take reads, not the page row. The store ignores
 * them too.
 */
const GET_PAGE_UNREAD = ['requireSafeChunks', 'takesHoldersAllowList'] as const;

export const getPage: StoreMember<[slug: string, opts?: GetPageOpts], Page | null> = async (brain, slug, opts) => {
  const scope = pageScope('getPage', opts, READ_SCOPE, GET_PAGE_UNREAD);
  const snapshot: StoreSnapshot | null = await storeCall({ member: 'getPage', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : (await overlayStoreSnapshot(storeNormalizer(brain), { ...snapshot, page: toGetPage(snapshot.page) })).page;
};

/** The revision the page has now, for the error a rejected revision check throws. `null` when there is no page. */
async function currentRevision(brain: StoreBrain, slug: string, sourceId: string | undefined): Promise<string | null> {
  const snapshot = await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null);
  return snapshot?.revision ?? null;
}

export const putPage = async function putPage(this: RustEngine, brain: StoreBrain, slug: string, page: PageInput, opts?: PageWriteOptions): Promise<Page> {
  const options = takeOptions('putPage', opts, ['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force', 'contextualRetrieval'], ['inline']);
  const sourceId = options.sourceId as string | undefined;
  // The store refuses a second live page of the source that records `source_path`, comparing paths as written. A source-root
  // source below its repository root also has the legacy repository-root spelling of each path, which only the files on disk
  // can settle (sameSyncOrigin). While managed mode is held (this engine does not report managed_persistence) such a source's
  // path is not written here. Where it is served, the origin guard the SQL engines run inside putPage (assertOriginUnclaimed,
  // on the typed origin reads) runs in the write's own transaction first.
  if (page.source_path) {
    const scope = await legacyOriginScope(brain, sourceId ?? 'default');
    if (scope?.scope) {
      if (!this.capabilities.has('managed_persistence')) refuseMember('putPage', 'source_path in a source-root source below its repository root');
      if (!this._txScope) return this.transaction(tx => tx.putPage(slug, page, opts));
      await assertOriginUnclaimed(this as unknown as BrainEngine, { sourceId: sourceId ?? 'default', slug: validateSlug(slug), sourcePath: page.source_path, revive: true, scope });
    }
  }
  // takeOptions drops an undefined `expectedRevision` (no check) and keeps `null` (the page must not exist); the store tells them apart.
  try {
    return toPutPage(await brain.putPage(slug, withIsoDates(page), { ...options, index: false }));
  } catch (error) {
    const current = isRevisionRejection(error) ? await currentRevision(brain, slug.toLowerCase(), sourceId) : null;
    throw mapStoreError(error, { member: 'putPage', slug, sourceId, expectedRevision: opts?.expectedRevision, currentRevision: current });
  }
};

async function legacyOriginScope(brain: StoreBrain, sourceId: string): Promise<SyncOriginScope | undefined> {
  const sources: Array<{ id: string; local_path: string | null; config: Record<string, unknown> }> =
    await storeCall({ member: 'putPage', sourceId }, () => brain.listAllSources({ includeArchived: true }));
  const source = sources.find((row) => row.id === sourceId);
  return source ? sourceOriginScope(sourceId, source.local_path, source.config?.slug_root_mode) : undefined;
}

export const deletePage: StoreMember<[slug: string, opts?: { sourceId?: string }], void> = async (brain, slug, opts) => {
  await storeCall({ member: 'deletePage', slug }, () => brain.deletePage(slug, takeOptions('deletePage', opts, ['sourceId'])));
};

export const softDeletePage: StoreMember<[slug: string, opts?: { sourceId?: string }], { slug: string } | null> = (brain, slug, opts) =>
  storeCall({ member: 'softDeletePage', slug }, () => brain.softDeletePage(slug, takeOptions('softDeletePage', opts, ['sourceId'])));

export const restorePage: StoreMember<[slug: string, opts?: { sourceId?: string }], boolean> = (brain, slug, opts) =>
  storeCall({ member: 'restorePage', slug }, () => brain.restorePage(slug, takeOptions('restorePage', opts, ['sourceId'])));

const LIST_FILTERS = ['type', 'tag', 'limit', 'offset', 'updated_after', 'updatedAfterKeyset', 'slugAfter', 'slugPrefix',
  'excludeSlugPrefixes', 'includeDeleted', 'sort', 'sourceId', 'sourceIds', 'excludePrivate', 'listColumnsOnly', 'omitBodies'] as const;

/**
 * A page as PGLite's `listPages({ listColumnsOnly: true })` row reads: only the list columns (id, source, slug, type,
 * title, dates, effective date, a segmented body's storage and size), with a blank body and timeline and empty
 * frontmatter. `content_hash` and `emotional_weight` are present and undefined, as rowToPage leaves them when the list
 * columns omit them. Every other page field is absent.
 */
function listColumns(page: Page, keepFrontmatter = false): Page {
  const { id, source_id, slug, type, title, created_at, updated_at, updated_at_iso, deleted_at, effective_date,
    effective_date_source, body_storage, body_bytes } = page;
  return {
    id, source_id, slug, type, title, compiled_truth: '', timeline: '', frontmatter: keepFrontmatter ? page.frontmatter : {}, content_hash: undefined,
    emotional_weight: undefined, created_at, updated_at,
    ...(updated_at_iso !== undefined && { updated_at_iso }),
    ...(deleted_at !== undefined && { deleted_at }),
    ...(effective_date !== undefined && { effective_date }),
    ...(effective_date_source !== undefined && { effective_date_source }),
    ...(body_storage === 'segmented' && { body_storage, body_bytes }),
  };
}

export const listPages: StoreMember<[filters?: PageFilters], Page[]> = async (brain, filters) => {
  // The store reads whole pages; `listColumnsOnly` keeps PGLite's list projection of each (listColumns), and `omitBodies`
  // (#10302, household scans) the same projection with the frontmatter kept.
  const { listColumnsOnly, omitBodies, ...options } = pageScope('listPages', filters, LIST_FILTERS);
  const pages: Page[] = await storeCall({ member: 'listPages' }, () => brain.listPages(options));
  return pages.map((page) => (listColumnsOnly === true ? listColumns(toListPage(page))
    : omitBodies === true ? listColumns(toListPage(page), true) : toListPage(page)));
};

/**
 * An exact live slug first, otherwise up to five trigram-similar titles or slugs containing the name, as PGLite
 * ranks them (the store's `pg_trgm` port: same similarity, same 0.3 threshold, ties by slug then source).
 */
export const resolveSlugs: StoreMember<[partial: string, opts?: PageReadScope], string[]> = async (brain, partial, opts) => {
  // PGLite's resolveSlugs reads only the source scope and excludePrivate; the rest of a read policy has no effect there.
  const scope = pageScope('resolveSlugs', opts, ['sourceId', 'sourceIds', 'excludePrivate'], ['requireSafeChunks', 'takesHoldersAllowList', 'minTrust', 'suppressFlagged']);
  const found: string[] = await storeCall({ member: 'resolveSlugs' }, () => brain.resolveSlugs(partial, scope));
  return found;
};
