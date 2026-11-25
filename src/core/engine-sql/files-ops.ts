/**
 * The statements `gbrain files` (src/commands/files.ts) and the file operations (src/core/ops/files.ts) ran through
 * `executeRaw`, `executeRawJsonb` and the `sqlQueryForEngine` tag, each as a typed BrainEngine member. Each function runs
 * the statement its caller ran, with the same text and parameters, on the engine's own `executeRaw`; only its home moved
 * (pinned by test/files-ops-sites-sql-pin.test.ts, compared across engines by test/engine-parity/files-ops-sites.test.ts).
 * The upserts keep the files-table write path of `engine-sql/files.ts` (`upsertFile`) apart: these are the commands' own
 * rows, written through `executeRawJsonb` so the metadata binds as an object (#2339) and stamps the storage lane (#4910).
 *
 * Placeholders in the readable-file statements are hand-numbered in module constants (`$1` is the first bind even where
 * a `$2` precedes it in the text, as the old statements numbered them), so they stay out of the `sqlFragment` templates.
 */
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** A files row as `SELECT *` or a column list reads it; BIGINT sizes come back as bigint on Postgres. */
export type FileRecord = Record<string, unknown>;

/** The columns every files write names, before its source and page. */
export interface FileRowScalars { page_slug: string | null; filename: string; storage_path: string; mime_type: string | null; size_bytes: number; content_hash: string }

/** The jsonb metadata object a files write merges into the row. */
export type FileMetadata = Record<string, unknown>;

/** The old executeRawJsonb call took the engine; the home takes the engine's executeRaw. */
const jsonbOn = (raw: EngineRawRead) => ({ executeRaw: raw as never });

// ---------------------------------------------------------------------------------------------------------------------
// src/commands/files.ts
// ---------------------------------------------------------------------------------------------------------------------

/** Whether a row already holds this hash at this storage path (`gbrain files upload` and `sync` skip it). */
export async function hasFileWithHash(raw: EngineRawRead, contentHash: string, storagePath: string): Promise<boolean> {
  const rows = await raw('SELECT id FROM files WHERE content_hash = $1 AND storage_path = $2', [contentHash, storagePath]);
  return rows.length > 0;
}

/** `gbrain files verify`: every file by storage path, at most 1000. */
export async function listFileRowsForVerify(raw: EngineRawRead): Promise<FileRecord[]> {
  return raw<FileRecord>('SELECT * FROM files ORDER BY storage_path COLLATE "C" LIMIT 1000');
}

/** The checkout path of a source for `gbrain files verify`, null when it has none or no such source exists. A missing sources table throws, as the old statement did. */
export async function readSourceLocalPathForVerify(raw: EngineRawRead, sourceId: string): Promise<string | null> {
  const rows = await raw<{ local_path: unknown }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  return rows[0]?.local_path ? String(rows[0].local_path) : null;
}

/** The files write of `gbrain files upload` (standard and smart): inserts the row, bound to the live page at its slug in the default source, or, on the same storage path, takes the new hash, size and type, the page's id and slug (when the page exists) and merges the metadata. */
export async function upsertCliFileRow(raw: EngineRawRead, row: FileRowScalars, metadata: FileMetadata): Promise<void> {
  await executeRawJsonb(jsonbOn(raw), CLI_FILE_UPSERT_SQL,
    [row.page_slug, row.filename, row.storage_path, row.mime_type, row.size_bytes, row.content_hash], [metadata]);
}

/** The files write of the git lane of `gbrain files upload`: the same upsert naming the source the object belongs to. */
export async function upsertRawFileRow(raw: EngineRawRead, row: FileRowScalars & { source_id: string }, metadata: FileMetadata): Promise<void> {
  await executeRawJsonb(jsonbOn(raw), RAW_FILE_UPSERT_SQL,
    [row.source_id, row.page_slug, row.filename, row.storage_path, row.mime_type, row.size_bytes, row.content_hash], [metadata]);
}

/** The files write of `gbrain files sync`: the same upsert as `upsertCliFileRow`, without the page binding (it names no page id). */
export async function upsertSyncFileRow(raw: EngineRawRead, row: FileRowScalars, metadata: FileMetadata): Promise<void> {
  await executeRawJsonb(jsonbOn(raw), SYNC_FILE_UPSERT_SQL,
    [row.page_slug, row.filename, row.storage_path, row.mime_type, row.size_bytes, row.content_hash], [metadata]);
}

// ---------------------------------------------------------------------------------------------------------------------
// src/core/ops/files.ts
// ---------------------------------------------------------------------------------------------------------------------

/** Whether a source with this id exists. */
export async function sourceIdExists(raw: EngineRawRead, sourceId: string): Promise<boolean> {
  return (await raw('SELECT 1 FROM sources WHERE id = $1', [sourceId])).length > 0;
}

/** The id of the page at this slug in this source, null when it has none. */
export async function readPageIdInSource(raw: EngineRawRead, slug: string, sourceId: string): Promise<number | null> {
  const rows = await raw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
  return rows[0]?.id ?? null;
}

export interface FileOwnerRow { source_id: string; page_id: number | null; content_hash: string }

/** The source, page id and hash of the row at this storage path, null when none is stored. */
export async function readFileOwner(raw: EngineRawRead, storagePath: string): Promise<FileOwnerRow | null> {
  const rows = await raw<FileOwnerRow>('SELECT source_id, page_id, content_hash FROM files WHERE storage_path = $1', [storagePath]);
  return rows[0] ?? null;
}

/** Gives the row at this storage path to a source and page. */
export async function claimFilePage(raw: EngineRawRead, storagePath: string, sourceId: string, pageId: number): Promise<void> {
  await raw('UPDATE files SET source_id = $2, page_id = $3 WHERE storage_path = $1', [storagePath, sourceId, pageId]);
}

/** The files write of the file_upload operation: a conflict keeps the row's source and page when the new row names no page. */
export async function upsertOpFileRow(raw: EngineRawRead, row: FileRowScalars & { source_id: string; page_id: number | null }, metadata: FileMetadata): Promise<void> {
  await executeRawJsonb(jsonbOn(raw), OP_FILE_UPSERT_SQL,
    [row.page_slug, row.filename, row.storage_path, row.mime_type, row.size_bytes, row.content_hash, row.source_id, row.page_id], [metadata]);
}

// The readable-file predicates (GBRA-218): a caller under the read policy sees no file attached to a page it cannot read,
// by the page's id or by its slug in any source (a file row names its page loosely, so it fails closed).

/** The predicate over the files alias `f`: always true, or no file attached to a private page the caller cannot read. No values. */
function fileReadableSql(excludePrivate: boolean): string {
  return excludePrivate
    ? `NOT EXISTS (SELECT 1 FROM pages fp WHERE (fp.id = f.page_id OR fp.slug = f.page_slug) AND NOT ${privatePagesFilterForCaller('fp')})`
    : 'TRUE';
}

/** The predicate over the pages alias `fp`: always true, or the page is one the caller can read. No values. */
function pageReadableSql(excludePrivate: boolean): string {
  return excludePrivate ? privatePagesFilterForCaller('fp') : 'TRUE';
}

/** The filter of the file lists: every page, or the page bound as `$2` (the limit is `$1`). No values. */
function fileListFilterSql(slug: string | undefined): string {
  return slug === undefined ? 'TRUE' : 'f.page_slug = $2';
}

/** The order of the file lists: page then name across pages, name within one page. No values. */
function fileListOrderSql(slug: string | undefined): string {
  return slug === undefined ? 'page_slug COLLATE "C", filename COLLATE "C", id' : 'filename COLLATE "C", id';
}

/** The binds of a file list: the limit, then the page slug when one scopes it. */
function fileListParams(slug: string | undefined): unknown[] {
  return slug === undefined ? [FILE_LIST_LIMIT] : [FILE_LIST_LIMIT, slug];
}

/** The most files one list returns, so one page with many attachments cannot flood a caller. */
export const FILE_LIST_LIMIT = 100;

/** The hand-numbered binds of the readable statements, kept out of the fragment templates. */
const LIMIT_SQL = 'LIMIT $1';
const STORAGE_PATH_EQ_SQL = 'storage_path = $1';
const FILE_STORAGE_PATH_EQ_SQL = 'f.storage_path = $1';
const PAGE_AT_SLUG_AND_SOURCE_SQL = 'fp.slug = $1 AND fp.source_id = $2';

/** file_list: the files of the page (or every page) the caller can read, at most 100. */
export async function listReadableFileRows(raw: EngineRawRead, slug: string | undefined, excludePrivate: boolean): Promise<FileRecord[]> {
  const { text } = renderFragment(sqlFragment`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${trustedSql(fileListFilterSql(slug))}) AND ${trustedSql(fileReadableSql(excludePrivate))}
      ORDER BY ${trustedSql(fileListOrderSql(slug))} ${trustedSql(LIMIT_SQL)}`);
  return raw<FileRecord>(text, fileListParams(slug));
}

/** file_url: the stored path, type and size of the file at this path when the caller can read it, else null. */
export async function readReadableFileForUrl(raw: EngineRawRead, storagePath: string, excludePrivate: boolean): Promise<FileRecord | null> {
  const { text } = renderFragment(sqlFragment`SELECT storage_path, mime_type, size_bytes FROM files f
      WHERE ${trustedSql(STORAGE_PATH_EQ_SQL)} AND ${trustedSql(fileReadableSql(excludePrivate))}`);
  const rows = await raw<FileRecord>(text, [storagePath]);
  return rows[0] ?? null;
}

/** file_register: the id of the page at this slug in this source when the caller can read it, undefined when it cannot or none exists. */
export async function readReadablePageId(raw: EngineRawRead, slug: string, sourceId: string, excludePrivate: boolean): Promise<number | undefined> {
  const { text } = renderFragment(sqlFragment`SELECT fp.id FROM pages fp WHERE ${trustedSql(PAGE_AT_SLUG_AND_SOURCE_SQL)}
    AND ${trustedSql(pageReadableSql(excludePrivate))}`);
  const rows = await raw<{ id: number }>(text, [slug, sourceId]);
  return rows[0]?.id;
}

/** file_register: how many rows at this storage path the caller cannot read (0 when none exists). */
export async function countUnreadableFilesAt(raw: EngineRawRead, storagePath: string, excludePrivate: boolean): Promise<number> {
  const { text } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM files f WHERE ${trustedSql(FILE_STORAGE_PATH_EQ_SQL)} AND NOT (${trustedSql(fileReadableSql(excludePrivate))})`);
  const rows = await raw<{ n: number }>(text, [storagePath]);
  return Number(rows[0]!.n);
}

export interface RegisteredFileIdentity { storage_path: string; page_slug: string | null; filename: string; source_id: string; page_id: number | null }

/** file_register: how many rows at this storage path differ from this page, filename, source or page id (0 when none exists or all match). */
export async function countFilesRegisteredElsewhere(raw: EngineRawRead, identity: RegisteredFileIdentity): Promise<number> {
  const rows = await raw<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE storage_path = $1
      AND (page_slug IS DISTINCT FROM $2 OR filename <> $3 OR source_id IS DISTINCT FROM $4 OR page_id IS DISTINCT FROM $5)`,
    [identity.storage_path, identity.page_slug, identity.filename, identity.source_id, identity.page_id]);
  return Number(rows[0]!.n);
}

/** file_register: records the row, or refreshes it when the same page, filename, source and page id hold it; false when another identity holds the path (nothing written). */
export async function registerFileRow(raw: EngineRawRead, row: FileRowScalars & { source_id: string; page_id: number | null }, metadata: FileMetadata): Promise<boolean> {
  const written = await executeRawJsonb(jsonbOn(raw), REGISTER_FILE_SQL,
    [row.page_slug, row.filename, row.storage_path, row.mime_type, row.size_bytes, row.content_hash, row.source_id, row.page_id], [metadata]);
  return written.length > 0;
}

/** file_verify: the size and hash of the file at this path when the caller can read it, else null. */
export async function readReadableFileForVerify(raw: EngineRawRead, storagePath: string, excludePrivate: boolean): Promise<{ size_bytes: unknown; content_hash: string } | null> {
  const { text } = renderFragment(sqlFragment`SELECT size_bytes, content_hash FROM files f WHERE ${trustedSql(FILE_STORAGE_PATH_EQ_SQL)} AND ${trustedSql(fileReadableSql(excludePrivate))}`);
  const rows = await raw<{ size_bytes: unknown; content_hash: string }>(text, [storagePath]);
  return rows[0] ?? null;
}

/** file_verify: the storage paths (and pages) the caller can read, for the page or every page, at most 100. */
export async function listReadableFilePaths(raw: EngineRawRead, slug: string | undefined, excludePrivate: boolean): Promise<Array<{ storage_path: string; page_slug: string | null }>> {
  const { text } = renderFragment(sqlFragment`SELECT storage_path, page_slug FROM files f
      WHERE (${trustedSql(fileListFilterSql(slug))}) AND ${trustedSql(fileReadableSql(excludePrivate))} ORDER BY storage_path COLLATE "C" ${trustedSql(LIMIT_SQL)}`);
  return raw<{ storage_path: string; page_slug: string | null }>(text, fileListParams(slug));
}

// ---------------------------------------------------------------------------------------------------------------------
// The upsert statements, one text per call site family (their indentation differs, so each stays its own).
// ---------------------------------------------------------------------------------------------------------------------

/** Upsert of `gbrain files upload` and the smart upload (uploadFile, uploadRaw smart path): the merge text of FILES_METADATA_MERGE_SQL inlined. */
const CLI_FILE_UPSERT_SQL = `INSERT INTO files (page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
     VALUES ($1, (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL), $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (storage_path) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       size_bytes = EXCLUDED.size_bytes,
       mime_type = EXCLUDED.mime_type,
       page_id = COALESCE(EXCLUDED.page_id, files.page_id),
       page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
       metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;

/** Upsert of the git lane of `gbrain files upload` (uploadRaw): names the source first. */
const RAW_FILE_UPSERT_SQL = `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, (SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL), $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         page_id = COALESCE(EXCLUDED.page_id, files.page_id),
         page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;

/** Upsert of `gbrain files sync` (syncFiles); indented one level deeper than the two above, so its text stays its own. */
const SYNC_FILE_UPSERT_SQL = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;

/** Upsert of the file_upload operation: a conflict takes the caller's source and page only when the new row names a page. */
const OP_FILE_UPSERT_SQL = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, source_id, page_id, metadata)
         VALUES (COALESCE((SELECT p.slug FROM pages p WHERE p.id = $8 FOR SHARE), $1), $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (storage_path) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           size_bytes = EXCLUDED.size_bytes,
           mime_type = EXCLUDED.mime_type,
           source_id = CASE WHEN EXCLUDED.page_id IS NULL THEN files.source_id ELSE EXCLUDED.source_id END,
           page_id = COALESCE(EXCLUDED.page_id, files.page_id),
           page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
           metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;

/** Insert of the file_register operation: a conflict refreshes the row only when the page, name, source and page id are the same; RETURNING 1 says it wrote. */
const REGISTER_FILE_SQL = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, source_id, page_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata
       WHERE files.page_slug IS NOT DISTINCT FROM EXCLUDED.page_slug AND files.filename = EXCLUDED.filename
         AND files.source_id IS NOT DISTINCT FROM EXCLUDED.source_id AND files.page_id IS NOT DISTINCT FROM EXCLUDED.page_id
       RETURNING 1`;
