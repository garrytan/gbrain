/**
 * The large-page write guard's read (BrainEngine readStoredBodyBytes; engine-sql/large-page.ts on the SQL engines):
 * a live page's stored body size, which a remote put_page measures before it is queued. The store answers a
 * segmented page's body_bytes and an inline page's UTF-8 body bytes, as the SQL does. Doc:
 * rust/docs/store/large-page.md.
 */
import { storeCall, type StoreMember } from './common.ts';

export const readStoredBodyBytes: StoreMember<[slug: string, sourceId: string], number | null> = async (brain, slug, sourceId) => {
  const bytes = await storeCall({ member: 'readStoredBodyBytes', slug, sourceId }, () => brain.readStoredBodyBytes(slug, sourceId));
  return bytes == null ? null : Number(bytes);
};
