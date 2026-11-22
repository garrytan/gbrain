/**
 * Raw source data and files attached to pages (BrainEngine putRawData, getRawData, upsertFile, getFile,
 * listFilesForPage). The store keeps the `raw_data` and `files` rows (rust/docs/store/raw_files.md). JSONB values
 * cross the binding as the `JSON.stringify` text PGLite binds, so `undefined` members and `toJSON` values behave the
 * same; timestamps come back as ISO strings and leave here as `Date`s.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { FileRow, FileSpec } from '../../engine.ts';
import type { PageReadScope, RawData } from '../../types.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

/** `JSON.stringify(value)`, or null where it gives `undefined` (PGLite then binds SQL NULL). */
function jsonText(value: unknown): string | null {
  return JSON.stringify(value) ?? null;
}

/** The store's `page_not_found` carries PGLite's message; PGLite throws it as a plain `Error`. */
function plainNotFound(error: unknown): unknown {
  if (error instanceof Error && (error as { code?: unknown }).code === 'page_not_found') return new Error(error.message);
  return error;
}

export const putRawData: StoreMember<[slug: string, source: string, data: object, opts?: { sourceId?: string }], void> =
  async (brain, slug, source, data, opts) => {
    // PGLite scopes the page lookup only when sourceId is truthy.
    const options = opts?.sourceId ? { sourceId: opts.sourceId } : {};
    try {
      await storeCall({ member: 'putRawData', slug }, () => brain.putRawData(slug, source ?? null, jsonText(data), options));
    } catch (error) {
      throw plainNotFound(error);
    }
  };

export const getRawData: StoreMember<[slug: string, source?: string, opts?: PageReadScope & { includeDeleted?: boolean }], RawData[]> =
  async (brain, slug, source, opts) => {
    // PGLite's getRawData reads only these four options; the rest of PageReadScope changes nothing there.
    if (opts?.excludePrivate) refuseMember('getRawData', 'option excludePrivate');
    const scope = takeOptions('getRawData', opts, ['sourceId', 'sourceIds', 'includeDeleted'], ['excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged']);
    const rows: RawData[] = await storeCall({ member: 'getRawData', slug }, () => brain.getRawData(slug, source || null, scope));
    return rows.map((row) => withDates(row, ['fetched_at']));
  };

export const upsertFile: StoreMember<[spec: FileSpec], { id: number; created: boolean }> = (brain, spec) =>
  storeCall({ member: 'upsertFile' }, () => brain.upsertFile({ ...spec, metadata: jsonText(spec?.metadata ?? {}) }));

export const getFile: StoreMember<[sourceId: string, storagePath: string], FileRow | null> = async (brain, sourceId, storagePath) => {
  const row: FileRow | null = await storeCall({ member: 'getFile' }, () => brain.getFile(sourceId, storagePath));
  return row === null ? null : withDates(row, ['created_at']);
};

export const listFilesForPage: StoreMember<[pageId: number], FileRow[]> = async (brain, pageId) => {
  const rows: FileRow[] = await storeCall({ member: 'listFilesForPage' }, () => brain.listFilesForPage(pageId));
  return rows.map((row) => withDates(row, ['created_at']));
};
