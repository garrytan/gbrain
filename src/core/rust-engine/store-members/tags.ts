/** Tag members (BrainEngine addTag, removeTag, getTags, pruneFrontmatterTags, addPageTagsById). */
import { namedSourceIds, storeCall, takeOptions, type StoreMember } from './common.ts';

export const addTag: StoreMember<[slug: string, tag: string, opts?: { sourceId?: string; tagSource?: 'frontmatter' }], void> = async (brain, slug, tag, opts) => {
  const scope = takeOptions('addTag', opts, ['sourceId', 'tagSource']);
  await storeCall({ member: 'addTag', slug, sourceId: scope.sourceId as string | undefined }, () => brain.addTag(slug, tag, scope));
};

export const removeTag: StoreMember<[slug: string, tag: string, opts?: { sourceId?: string }], void> = async (brain, slug, tag, opts) => {
  const scope = takeOptions('removeTag', opts, ['sourceId']);
  await storeCall({ member: 'removeTag', slug }, () => brain.removeTag(slug, tag, scope));
};

type GetTagsOpts = { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; liveOnly?: boolean };

/** Like PGLite: a federated grant reads the union of the sources' tags, an unscoped read reads `default`. */
export const getTags: StoreMember<[slug: string, opts?: GetTagsOpts], string[]> = async (brain, slug, opts) => {
  const scope = takeOptions('getTags', opts, ['sourceId', 'sourceIds', 'liveOnly']);
  // An id that names no source (an empty string) matches nothing in PGLite; the store would read it as "no scope".
  const sourceIds = namedSourceIds((scope.sourceIds as unknown[] | undefined)?.length ? (scope.sourceIds as unknown[]) : [scope.sourceId ?? 'default']);
  const tags = new Set<string>();
  for (const sourceId of sourceIds) {
    const found: string[] = await storeCall({ member: 'getTags', slug }, () =>
      scope.liveOnly === true
        ? brain.readPageSnapshot(slug, { sourceId }).then((snapshot: { tags: string[] } | null) => snapshot?.tags ?? [])
        : brain.getTags(slug, { sourceId }));
    for (const tag of found) tags.add(tag);
  }
  return [...tags].sort();
};

/** Removes the page's import-claimed tags that are not in `keep`; a missing page is no error. */
export const pruneFrontmatterTags: StoreMember<[slug: string, keep: readonly string[], opts?: { sourceId?: string }], void> = async (brain, slug, keep, opts) => {
  const scope = takeOptions('pruneFrontmatterTags', opts, ['sourceId']);
  await storeCall({ member: 'pruneFrontmatterTags', slug }, () => brain.pruneFrontmatterTags(slug, [...keep], scope));
};

export const addPageTagsById: StoreMember<[pageId: number, tags: readonly string[], opts?: { tagSource?: 'frontmatter' }], void> = async (brain, pageId, tags, opts) => {
  const scope = takeOptions('addPageTagsById', opts, ['tagSource']);
  await storeCall({ member: 'addPageTagsById' }, () => brain.addPageTagsById(pageId, [...tags], scope));
};
