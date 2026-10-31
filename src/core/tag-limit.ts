/**
 * #7052: the tag byte limit, checked by `classifyImportHold` (every content screen) and the segmented-page tag flip.
 */
import type { ContentHold } from './markdown.ts';

/**
 * The longest tag, in UTF-8 bytes, both btree indexes on `tags` store. A btree v4 entry is at most 2704 bytes
 * on an 8 kB page; `UNIQUE(page_id, tag)` spends 16 of them (tuple header, page_id, the text length word). Counting
 * bytes, not characters, keeps multibyte tags inside the bound; a longer tag failed the insert with error 54000.
 */
export const TAG_MAX_BYTES = 2688;

/** The `tag_too_long` hold for the first tag over `TAG_MAX_BYTES`, or null. Names the tag's position and size, never its text. */
export function tagLengthHold(tags: readonly string[]): ContentHold | null {
  const index = tags.findIndex(tag => Buffer.byteLength(tag, 'utf-8') > TAG_MAX_BYTES);
  if (index < 0) return null;
  return { code: 'tag_too_long', key: 'tags', message: `Tag ${index + 1} of ${tags.length} is ${Buffer.byteLength(tags[index]!, 'utf-8')} bytes; `
    + `a tag can be at most ${TAG_MAX_BYTES} bytes, so the page was not written. Shorten that tag or split it into shorter tags, then write the page again.` };
}
