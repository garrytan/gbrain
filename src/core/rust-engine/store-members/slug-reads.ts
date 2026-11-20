/**
 * Slug reads that order by byte (SQL in engine-sql/collate-slug-reads.ts), served from the page records
 * (rust/crates/gbrain-store/src/slug_reads.rs, rust/docs/store/slug_reads.md).
 */
import type { ExportPageRow, TypeScope } from '../../engine-sql/collate-slug-reads.ts';
import { toGetPage } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The slug of the live page that records `path` as its origin: the lowest source by byte, then the lowest slug; null when none does. */
export const resolveLiveSlugByPath: StoreMember<[path: string], string | null> = (brain, path) =>
  storeCall({ member: 'resolveLiveSlugByPath' }, () => brain.resolveLiveSlugByPath(path));

/** The ids of the unarchived sources that hold a live page at `slug`, in byte order. */
export const listUnarchivedSlugSources: StoreMember<[slug: string], string[]> = (brain, slug) =>
  storeCall({ member: 'listUnarchivedSlugSources' }, () => brain.listUnarchivedSlugSources(slug));

function scopeArg(member: string, scope: TypeScope): TypeScope {
  if (scope.sourceIds !== undefined && !Array.isArray(scope.sourceIds)) refuseMember(member, 'sourceIds that is not a list');
  return { sourceId: scope.sourceId, sourceIds: scope.sourceIds };
}

/** How many live pages in scope carry each stored type; the store answers in type byte order, the SQL leaves the order open. */
export const countLivePageTypes: StoreMember<[scope: TypeScope], Array<{ type: string | null; n: string }>> = (brain, scope) =>
  storeCall({ member: 'countLivePageTypes' }, () => brain.countLivePageTypes(scopeArg('countLivePageTypes', scope)));

/** The live pages in scope with an empty type or one of `types`, by source then slug in byte order. */
export const listTypeOrphanPages: StoreMember<
  [opts: { scope: TypeScope; types: readonly string[]; limit: number }],
  Array<{ slug: string; source_id: string; type: string | null }>
> = (brain, opts) => {
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 0) refuseMember('listTypeOrphanPages', 'a limit that is not a whole number of at least 0');
  return storeCall({ member: 'listTypeOrphanPages' }, () => brain.listTypeOrphanPages({
    scope: scopeArg('listTypeOrphanPages', opts.scope), types: [...opts.types], limit: opts.limit }));
};

/** The live pages of the ids with their tags in byte order; an id that is not a whole number refuses rather than guess at the `bigint[]` cast. */
export const readExportPageRows: StoreMember<[ids: readonly string[]], ExportPageRow[]> = async (brain, ids) => {
  if (ids.some((id) => !/^[0-9]{1,15}$/.test(String(id)))) refuseMember('readExportPageRows', 'an id that is not a whole number');
  const rows: ExportPageRow[] = await storeCall({ member: 'readExportPageRows' }, () => brain.readExportPageRows(ids.map(Number)));
  return rows.map((r) => ({ page: toGetPage(r.page), tags: r.tags }));
};
