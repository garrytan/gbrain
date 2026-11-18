/** Page members (BrainEngine getPage .. resolveSlugs, softDeletePage, restorePage, deletePage). */
import type { PageSnapshot } from '../../page-state/types.ts';
import type { PageWriteOptions, PageSnapshotOptions } from '../../page-state/types.ts';
import type { GetPageOpts, Page, PageFilters, PageInput, PageReadScope } from '../../types.ts';
import { toGetPage, toListPage, toPutPage, withIsoDates } from '../store-codec.ts';
import { sourceOriginScope } from '../../persistence/origin-guard.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

const READ_SCOPE = ['sourceId', 'sourceIds', 'includeDeleted'] as const;

export const readPageSnapshot: StoreMember<[slug: string, opts?: PageSnapshotOptions], PageSnapshot | null> = async (brain, slug, opts) => {
  const scope = takeOptions('readPageSnapshot', opts, READ_SCOPE);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'readPageSnapshot', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : { ...snapshot, page: toGetPage(snapshot.page) };
};

export const getPage: StoreMember<[slug: string, opts?: GetPageOpts], Page | null> = async (brain, slug, opts) => {
  const scope = takeOptions('getPage', opts, READ_SCOPE);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'getPage', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : toGetPage(snapshot.page);
};

/** The revision the page has now, for the error a rejected revision check throws. `null` when there is no page. */
async function currentRevision(brain: StoreBrain, slug: string, sourceId: string | undefined): Promise<string | null> {
  const snapshot = await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null);
  return snapshot?.revision ?? null;
}

export const putPage: StoreMember<[slug: string, page: PageInput, opts?: PageWriteOptions], Page> = async (brain, slug, page, opts) => {
  const options = takeOptions('putPage', opts, ['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force'], ['inline']);
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
