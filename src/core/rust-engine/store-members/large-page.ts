/**
 * The large-page write guard's read (BrainEngine readStoredBodyBytes; engine-sql/large-page.ts on the SQL engines):
 * a live page's stored body size, which a remote put_page measures before it is queued. The store answers a
 * segmented page's body_bytes and an inline page's UTF-8 body bytes, as the SQL does. Doc:
 * rust/docs/store/large-page.md.
 *
 * readPageBodySizes is append_page's read after its write: the page's body and truth sizes by id, deleted or not.
 */
import type { PageBodySizes } from '../../engine-sql/large-page.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readStoredBodyBytes: StoreMember<[slug: string, sourceId: string], number | null> = async (brain, slug, sourceId) => {
  const bytes = await storeCall({ member: 'readStoredBodyBytes', slug, sourceId }, () => brain.readStoredBodyBytes(slug, sourceId));
  return bytes == null ? null : Number(bytes);
};

export const readPageBodySizes: StoreMember<[pageId: number], PageBodySizes | null> = async (brain, pageId) => {
  if (!Number.isSafeInteger(pageId)) throw new TypeError(`readPageBodySizes: pageId must be an integer, got ${String(pageId)}`);
  const sizes = await storeCall({ member: 'readPageBodySizes' }, () => brain.readPageBodySizes(pageId)) as { bytes: unknown; truth: unknown } | null;
  if (sizes == null) return null;
  return { bytes: sizes.bytes == null ? null : Number(sizes.bytes), truth: sizes.truth == null ? null : Number(sizes.truth) };
};
