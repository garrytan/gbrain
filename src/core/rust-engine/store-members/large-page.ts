/**
 * The large-page reads. readStoredBodyBytes is the write guard's read (BrainEngine readStoredBodyBytes; engine-sql/large-page.ts on the SQL engines):
 * a live page's stored body size, which a remote put_page measures before it is queued. The store answers a
 * segmented page's body_bytes and an inline page's UTF-8 body bytes, as the SQL does. listPageSizeRows is the sync
 * receipt's size-state read; the store keeps no embedding budget rows, so `state` and `reason` are null. Doc:
 * rust/docs/store/large-page.md.
 */
import type { PageSizeRow } from '../../engine-sql/large-page.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readStoredBodyBytes: StoreMember<[slug: string, sourceId: string], number | null> = async (brain, slug, sourceId) => {
  const bytes = await storeCall({ member: 'readStoredBodyBytes', slug, sourceId }, () => brain.readStoredBodyBytes(slug, sourceId));
  return bytes == null ? null : Number(bytes);
};

export const listPageSizeRows: StoreMember<[sourceId: string, opts: { inlineMaxBytes: number; slugs: readonly string[] | null }], PageSizeRow[]> = async (brain, sourceId, opts) => {
  if (opts.slugs?.length === 0) return [];
  const rows: Array<Omit<PageSizeRow, 'bytes'> & { bytes: number | string | null }> = await storeCall({ member: 'listPageSizeRows', sourceId },
    () => brain.listPageSizeRows(sourceId, opts.inlineMaxBytes, opts.slugs === null ? null : [...opts.slugs]));
  return rows.map(row => ({ ...row, bytes: row.bytes == null ? null : Number(row.bytes) }));
};
