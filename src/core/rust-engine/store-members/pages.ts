/** Page members (BrainEngine getPage .. resolveSlugs, softDeletePage, restorePage, deletePage). */
import type { PageSnapshot } from '../../page-state/types.ts';
import type { PageWriteOptions, PageSnapshotOptions } from '../../page-state/types.ts';
import type { GetPageOpts, Page, PageFilters, PageInput, PageReadScope } from '../../types.ts';
import { toPage, withIsoDates } from '../store-codec.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

const READ_SCOPE = ['sourceId', 'sourceIds', 'includeDeleted'] as const;

export const readPageSnapshot: StoreMember<[slug: string, opts?: PageSnapshotOptions], PageSnapshot | null> = async (brain, slug, opts) => {
  const scope = takeOptions('readPageSnapshot', opts, READ_SCOPE);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'readPageSnapshot', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : { ...snapshot, page: toPage(snapshot.page) };
};

export const getPage: StoreMember<[slug: string, opts?: GetPageOpts], Page | null> = async (brain, slug, opts) => {
  const scope = takeOptions('getPage', opts, READ_SCOPE);
  const snapshot: PageSnapshot | null = await storeCall({ member: 'getPage', slug }, () => brain.readPageSnapshot(slug, scope));
  return snapshot === null ? null : toPage(snapshot.page);
};

/** The revision the page has now, for the error a rejected revision check throws. `null` when there is no page. */
async function currentRevision(brain: StoreBrain, slug: string, sourceId: string | undefined): Promise<string | null> {
  const snapshot = await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null);
  return snapshot?.revision ?? null;
}

export const putPage: StoreMember<[slug: string, page: PageInput, opts?: PageWriteOptions], Page> = async (brain, slug, page, opts) => {
  const options = takeOptions('putPage', opts, ['sourceId', 'allowEmptyOverwrite', 'expectedRevision', 'force'], ['inline']);
  const sourceId = options.sourceId as string | undefined;
  // takeOptions drops an undefined `expectedRevision` (no check) and keeps `null` (the page must not exist); the store tells them apart.
  try {
    return toPage(await brain.putPage(slug, withIsoDates(page), options));
  } catch (error) {
    const current = isRevisionRejection(error) ? await currentRevision(brain, slug.toLowerCase(), sourceId) : null;
    throw mapStoreError(error, { member: 'putPage', slug, sourceId, expectedRevision: opts?.expectedRevision, currentRevision: current });
  }
};

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
  // `listColumnsOnly` asks for fewer columns; the full row is a superset, so it changes nothing here.
  const options = takeOptions('listPages', filters, LIST_FILTERS, ['listColumnsOnly']);
  const pages: Page[] = await storeCall({ member: 'listPages' }, () => brain.listPages(options));
  return pages.map((page) => toPage(page));
};

export const resolveSlugs: StoreMember<[partial: string, opts?: PageReadScope], string[]> = (brain, partial, opts) =>
  storeCall({ member: 'resolveSlugs' }, () => brain.resolveSlugs(partial, takeOptions('resolveSlugs', opts, ['sourceId', 'sourceIds'])));
