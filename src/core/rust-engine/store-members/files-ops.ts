/**
 * The files statements `gbrain files` and the file operations run (src/core/engine-sql/files-ops.ts), served from the
 * store's `files` records (rust/crates/gbrain-store/src/raw_files/ops.rs, rust/docs/store/raw_files.md). The two source
 * reads of the same module, `sourceIdExists` and `readSourceLocalPathForVerify`, are in files-sources.ts.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 *
 * A write's metadata crosses as the `JSON.stringify` text of an object. The SQL binds it through `executeRawJsonb`,
 * which refuses a top-level array and a non-scalar bind value, and merges only object into object; metadata that is
 * not an object, or a bind value of another kind (undefined, an object, a symbol), refuses by name rather than guess.
 * A text with a NUL byte refuses too, as files-sources.ts does.
 *
 * The readable reads send the caller's page policy when `excludePrivate` is true (`storePagePolicy`); PGLite renders
 * `privatePagesFilterForCaller` over the file's page, and the store applies it to the page by id and to every page
 * at the file's slug. A caller whose policy the store cannot read refuses with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';
import type { StoreBrain } from '../store.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

type Row = Record<string, unknown>;

/** A bind value PGLite's `executeRawJsonb` takes (`assertSqlValue`), as the store takes it: text, a number or null. */
function scalar(member: string, name: string, value: unknown): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    if (typeof value === 'string' && value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
    return value;
  }
  return refuseMember(member, `${name} that is not text, a number or null`);
}

function metadataText(member: string, metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) refuseMember(member, 'metadata that is not an object');
  return JSON.stringify(metadata);
}

/** The `FileSpec` of a write: the row's scalars (and its source and page, when it has them) and the metadata text. */
function fileSpec(member: string, scalars: object, metadata: unknown, withSource: boolean, withPage: boolean): Row {
  const row = scalars as Row;
  const out: Row = {
    page_slug: scalar(member, 'page_slug', row.page_slug), filename: scalar(member, 'filename', row.filename),
    storage_path: scalar(member, 'storage_path', row.storage_path), mime_type: scalar(member, 'mime_type', row.mime_type),
    size_bytes: scalar(member, 'size_bytes', row.size_bytes), content_hash: scalar(member, 'content_hash', row.content_hash),
    metadata: metadataText(member, metadata),
  };
  if (withSource) out.source_id = scalar(member, 'source_id', row.source_id);
  if (withPage) out.page_id = scalar(member, 'page_id', row.page_id);
  return out;
}

function text(member: string, name: string, value: string): string {
  if (value.includes('\0')) refuseMember(member, `${name} with a NUL byte`);
  return value;
}

/** The store policy of a readable read, null when it hides nothing. */
function policy(member: string, excludePrivate: boolean): unknown {
  return storePagePolicy(member, excludePrivate, { callerReaders: true }) ?? null;
}

function listRows(brain: StoreBrain, member: string, kind: 'verify'): Promise<Row[]> {
  return storeCall({ member }, async () => ((await brain.listFileRows(kind)) as Row[]).map(row => withDates(row, ['created_at'])));
}

export const listFileRowsForVerify: Member<'listFileRowsForVerify'> = brain => listRows(brain, 'listFileRowsForVerify', 'verify');

export const hasFileWithHash: Member<'hasFileWithHash'> = (brain, contentHash, storagePath) =>
  storeCall({ member: 'hasFileWithHash' }, () => brain.hasFileWithHash(text('hasFileWithHash', 'content hash', contentHash), text('hasFileWithHash', 'storage path', storagePath)));

export const upsertCliFileRow: Member<'upsertCliFileRow'> = async (brain, row, metadata) => {
  await storeCall({ member: 'upsertCliFileRow' }, () => brain.upsertFileRow('command', fileSpec('upsertCliFileRow', row, metadata, false, false)));
};

export const upsertRawFileRow: Member<'upsertRawFileRow'> = async (brain, row, metadata) => {
  await storeCall({ member: 'upsertRawFileRow' }, () => brain.upsertFileRow('command', fileSpec('upsertRawFileRow', row, metadata, true, false)));
};

export const upsertSyncFileRow: Member<'upsertSyncFileRow'> = async (brain, row, metadata) => {
  await storeCall({ member: 'upsertSyncFileRow' }, () => brain.upsertFileRow('command', fileSpec('upsertSyncFileRow', row, metadata, false, false)));
};

export const upsertOpFileRow: Member<'upsertOpFileRow'> = async (brain, row, metadata) => {
  await storeCall({ member: 'upsertOpFileRow' }, () => brain.upsertFileRow('operation', fileSpec('upsertOpFileRow', row, metadata, true, true)));
};

export const registerFileRow: Member<'registerFileRow'> = (brain, row, metadata) =>
  storeCall({ member: 'registerFileRow' }, () => brain.registerFileRow(fileSpec('registerFileRow', row, metadata, true, true)));

export const readPageIdInSource: Member<'readPageIdInSource'> = (brain, slug, sourceId) =>
  storeCall({ member: 'readPageIdInSource' }, () => brain.readPageIdInSource(text('readPageIdInSource', 'slug', slug), text('readPageIdInSource', 'source id', sourceId)));

export const readFileOwner: Member<'readFileOwner'> = (brain, storagePath) =>
  storeCall({ member: 'readFileOwner' }, () => brain.readFileOwner(text('readFileOwner', 'storage path', storagePath)));

export const claimFilePage: Member<'claimFilePage'> = async (brain, storagePath, sourceId, pageId) => {
  const member = 'claimFilePage';
  await storeCall({ member }, () => brain.claimFilePage(text(member, 'storage path', storagePath), text(member, 'source id', sourceId), scalar(member, 'page id', pageId)));
};

export const countFilesRegisteredElsewhere: Member<'countFilesRegisteredElsewhere'> = (brain, identity) => {
  const member = 'countFilesRegisteredElsewhere';
  const spec = {
    storage_path: scalar(member, 'storage_path', identity.storage_path), page_slug: scalar(member, 'page_slug', identity.page_slug),
    filename: scalar(member, 'filename', identity.filename), source_id: scalar(member, 'source_id', identity.source_id),
    page_id: scalar(member, 'page_id', identity.page_id),
  };
  return storeCall({ member }, () => brain.countFilesRegisteredElsewhere(spec));
};

export const listReadableFileRows: Member<'listReadableFileRows'> = async (brain, slug, excludePrivate) => {
  const member = 'listReadableFileRows';
  const rows = await storeCall({ member }, () => brain.listReadableFiles('rows', slug === undefined ? undefined : text(member, 'slug', slug), policy(member, excludePrivate)));
  return (rows as Row[]).map(row => withDates(row, ['created_at']));
};

export const listReadableFilePaths: Member<'listReadableFilePaths'> = (brain, slug, excludePrivate) => {
  const member = 'listReadableFilePaths';
  return storeCall({ member }, () => brain.listReadableFiles('paths', slug === undefined ? undefined : text(member, 'slug', slug), policy(member, excludePrivate)));
};

export const readReadableFileForUrl: Member<'readReadableFileForUrl'> = (brain, storagePath, excludePrivate) => {
  const member = 'readReadableFileForUrl';
  return storeCall({ member }, () => brain.readReadableFile('url', text(member, 'storage path', storagePath), policy(member, excludePrivate)));
};

export const readReadableFileForVerify: Member<'readReadableFileForVerify'> = (brain, storagePath, excludePrivate) => {
  const member = 'readReadableFileForVerify';
  return storeCall({ member }, () => brain.readReadableFile('verify', text(member, 'storage path', storagePath), policy(member, excludePrivate)));
};

export const readReadablePageId: Member<'readReadablePageId'> = async (brain, slug, sourceId, excludePrivate) => {
  const member = 'readReadablePageId';
  const id = await storeCall({ member }, async () => (await brain.readReadablePageId(text(member, 'slug', slug), text(member, 'source id', sourceId), policy(member, excludePrivate))) as number | null);
  return id ?? undefined;
};

export const countUnreadableFilesAt: Member<'countUnreadableFilesAt'> = (brain, storagePath, excludePrivate) => {
  const member = 'countUnreadableFilesAt';
  return storeCall({ member }, () => brain.countUnreadableFilesAt(text(member, 'storage path', storagePath), policy(member, excludePrivate)));
};
