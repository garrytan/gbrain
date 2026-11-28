/** Page members (BrainEngine getPage .. resolveSlugs, softDeletePage, restorePage, deletePage). */
import type { PageSnapshot } from '../../page-state/types.ts';
import type { PageWriteOptions, PageSnapshotOptions } from '../../page-state/types.ts';
import type { GetPageOpts, Page, PageFilters, PageInput, PageReadScope } from '../../types.ts';
import { toListPage, toPutPage, withIsoDates } from '../store-codec.ts';
import { sourceOriginScope } from '../../persistence/origin-guard.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { overlaidSnapshot } from './page-withdrawals.ts';
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

/**
 * PGLite reads a page by its exact stored spelling. The store lowercases the slug it is asked for, so a slug with capitals
 * would find the lowercase page that PGLite's exact read misses (and `get` would add `resolved_slug`). A write stores the
 * slug lowercased, so such a read answers nothing, as on PGLite, once its options pass. A seeded store can still hold a
 * page under that exact spelling (seed/core.rs keeps the stored slug), which the lowercased read cannot open: the read
 * refuses, so a put or an existing-page write by that spelling stops before it writes a lowercase twin beside the page
 * (legacy-slug-put.ts) instead of reading "no page".
 */
const hasCapitals = (slug: string) => slug !== slug.toLowerCase();

async function capitalRead(brain: StoreBrain, member: string, slug: string, scope: Record<string, unknown>): Promise<null> {
  const sources = Array.isArray(scope.sourceIds) && scope.sourceIds.length ? { sourceIds: scope.sourceIds } : scope.sourceId ? { sourceId: scope.sourceId } : {};
  // The caller's page policy applies: a page it may not read stays unseen, so the refusal never tells it one exists.
  const policy = scope.excludePrivate ? { excludePrivate: scope.excludePrivate } : {};
  // Sorted by slug, the exact spelling comes before every longer slug it prefixes.
  const held: Array<{ slug: string }> = await storeCall({ member, slug }, () =>
    brain.listPages({ slugPrefix: slug, includeDeleted: true, sort: 'slug', limit: 1, ...sources, ...policy }));
  if (held.some((page) => page.slug === slug)) refuseMember(member, 'a page stored under a spelling with capitals');
  return null;
}

export const readPageSnapshot: StoreMember<[slug: string, opts?: PageSnapshotOptions], PageSnapshot | null> = async (brain, slug, opts) => {
  const scope = pageScope('readPageSnapshot', opts, READ_SCOPE);
  if (hasCapitals(slug)) return capitalRead(brain, 'readPageSnapshot', slug, scope);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'readPageSnapshot', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : overlaidSnapshot(brain, 'readPageSnapshot', snapshot);
};

/**
 * `readPolicyOpts` (get_write_attribution) also passes `requireSafeChunks` and `takesHoldersAllowList`. The SQL page
 * read (page-state/snapshot.ts) reads neither: they fence chunk and take reads, not the page row. The store ignores
 * them too.
 */
const GET_PAGE_UNREAD = ['requireSafeChunks', 'takesHoldersAllowList'] as const;

export const getPage: StoreMember<[slug: string, opts?: GetPageOpts], Page | null> = async (brain, slug, opts) => {
  const scope = pageScope('getPage', opts, READ_SCOPE, GET_PAGE_UNREAD);
  if (hasCapitals(slug)) return capitalRead(brain, 'getPage', slug, scope);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'getPage', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : (await overlaidSnapshot(brain, 'getPage', snapshot)).page;
};

/** The revision the page has now, for the error a rejected revision check throws. `null` when there is no page. */
async function currentRevision(brain: StoreBrain, slug: string, sourceId: string | undefined): Promise<string | null> {
  const snapshot = await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null);
  return snapshot?.revision ?? null;
}

export const putPage: StoreMember<[slug: string, page: PageInput, opts?: PageWriteOptions], Page> = async (brain, slug, page, opts) => {
  const options = takeOptions('putPage', opts, ['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force', 'contextualRetrieval'], ['inline']);
  const sourceId = options.sourceId as string | undefined;
  // The store refuses a second live page of the source that records `source_path` (page_identity_changed), comparing
  // paths as written. A source-root source below its repository root also has the legacy repository-root spelling of
  // each path, which only the files on disk can settle (sameSyncOrigin), so such a source's path is not written here.
  if (page.source_path) await refuseLegacyOriginScope(brain, sourceId ?? 'default');
  // takeOptions drops an undefined `expectedRevision` (no check) and keeps `null` (the page must not exist); the store tells them apart.
  try {
    return toPutPage(await brain.putPage(slug, withIsoDates(page), { ...options, index: false }));
  } catch (error) {
    const current = isRevisionRejection(error) ? await currentRevision(brain, slug.toLowerCase(), sourceId) : null;
    throw mapStoreError(error, { member: 'putPage', slug, sourceId, expectedRevision: opts?.expectedRevision, currentRevision: current });
  }
};

async function refuseLegacyOriginScope(brain: StoreBrain, sourceId: string): Promise<void> {
  const sources: Array<{ id: string; local_path: string | null; config: Record<string, unknown> }> =
    await storeCall({ member: 'putPage', sourceId }, () => brain.listAllSources({ includeArchived: true }));
  const source = sources.find((row) => row.id === sourceId);
  const scope = source ? sourceOriginScope(sourceId, source.local_path, source.config?.slug_root_mode) : undefined;
  if (scope?.scope) refuseMember('putPage', 'source_path in a source-root source below its repository root');
}

export const deletePage: StoreMember<[slug: string, opts?: { sourceId?: string }], void> = async (brain, slug, opts) => {
  await storeCall({ member: 'deletePage', slug }, () => brain.deletePage(slug, takeOptions('deletePage', opts, ['sourceId'])));
};

export const softDeletePage: StoreMember<[slug: string, opts?: { sourceId?: string }], { slug: string } | null> = (brain, slug, opts) =>
  storeCall({ member: 'softDeletePage', slug }, () => brain.softDeletePage(slug, takeOptions('softDeletePage', opts, ['sourceId'])));

export const restorePage: StoreMember<[slug: string, opts?: { sourceId?: string }], boolean> = (brain, slug, opts) =>
  storeCall({ member: 'restorePage', slug }, () => brain.restorePage(slug, takeOptions('restorePage', opts, ['sourceId'])));

const LIST_FILTERS = ['type', 'tag', 'limit', 'offset', 'updated_after', 'updatedAfterKeyset', 'slugAfter', 'slugPrefix',
  'excludeSlugPrefixes', 'includeDeleted', 'sort', 'sourceId', 'sourceIds'] as const;

export const listPages: StoreMember<[filters?: PageFilters], Page[]> = async (brain, filters) => {
  // `listColumnsOnly` blanks the body and timeline in PGLite's rows, which the store does not do, so it refuses.
  const options = takeOptions('listPages', filters, LIST_FILTERS);
  const pages: Page[] = await storeCall({ member: 'listPages' }, () => brain.listPages(options));
  return pages.map((page) => toListPage(page));
};

/**
 * PGLite answers an exact live slug first and otherwise ranks titles and slugs by trigram similarity. The store has the
 * exact half; a name it cannot find exactly is refused, since "no exact page" is not "nothing resembles it".
 */
export const resolveSlugs: StoreMember<[partial: string, opts?: PageReadScope], string[]> = async (brain, partial, opts) => {
  const found: string[] = await storeCall({ member: 'resolveSlugs' }, () => brain.resolveSlugs(partial, takeOptions('resolveSlugs', opts, ['sourceId', 'sourceIds'])));
  if (found.length === 0) refuseMember('resolveSlugs', 'a name with no exact page needs trigram matching');
  return found;
};
