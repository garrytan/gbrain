/**
 * Files (v0.27.1): binary asset metadata, one SQL implementation for both
 * engines (refactor wave 1, W1-extended). Statement text is PostgresEngine's
 * master text (SQL-text golden `sql-text/files.json`); PGLite runs the same
 * statements (docs/designs/refactor-wave-1/w1-inventory.md). Image bytes never
 * touch the DB (storage_path references a path inside the brain repo).
 * Identity is (source_id, storage_path); re-upsert with same content_hash is
 * a no-op, different content_hash overwrites in place. Reads were unscoped on
 * master (EO4 inventory): `LegacyUnscopedRead`.
 */
import type { FileRow, FileSpec } from '../engine.ts';
import { jsonbParam, type SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment } from './fragment.ts';

export async function upsertFile(exec: SqlExecutor, spec: FileSpec): Promise<{ id: number; created: boolean }> {
    const sourceId = spec.source_id ?? 'default';
    const metadata = spec.metadata ?? {};
    const { rows } = await exec.run<{ id: number; created: boolean }>(sqlFragment`
      INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES (${sourceId}, ${spec.page_slug ?? null}, ${spec.page_id ?? null}, ${spec.filename}, ${spec.storage_path}, ${spec.mime_type ?? null}, ${spec.size_bytes ?? null}, ${spec.content_hash}, ${jsonbParam(metadata)})
      ON CONFLICT (storage_path) DO UPDATE SET
        page_slug = EXCLUDED.page_slug,
        page_id = EXCLUDED.page_id,
        filename = EXCLUDED.filename,
        mime_type = EXCLUDED.mime_type,
        size_bytes = EXCLUDED.size_bytes,
        content_hash = EXCLUDED.content_hash,
        metadata = EXCLUDED.metadata
      RETURNING id, (xmax = 0) AS created
    `);
    if (rows.length === 0) throw new Error(`upsertFile returned no rows for ${spec.storage_path}`);
    return { id: rows[0].id, created: !!rows[0].created };
  }

export async function getFile(exec: LegacyUnscopedRead, sourceId: string, storagePath: string): Promise<FileRow | null> {
    const { rows } = await exec.run<FileRow>(sqlFragment`
      SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
      FROM files
      WHERE source_id = ${sourceId} AND storage_path = ${storagePath}
      LIMIT 1
    `);
    return rows.length > 0 ? rows[0] : null;
  }

export async function listFilesForPage(exec: LegacyUnscopedRead, pageId: number): Promise<FileRow[]> {
    const { rows } = await exec.run<FileRow>(sqlFragment`
      SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
      FROM files
      WHERE page_id = ${pageId}
      ORDER BY created_at ASC
    `);
    return rows;
  }
