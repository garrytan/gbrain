import type { BrainEngine, FileRow, FileSpec } from './engine.ts';
import type { StorageBackend } from './storage.ts';

export interface PageImageQuotas {
  sourceBytes: number;
  sourceFiles: number;
  pageBytes: number;
  pageFiles: number;
  versionsPerFilename: number;
}

export class PageImageQuotaError extends Error {
  constructor(readonly quota: 'source' | 'page' | 'versions', message: string) {
    super(message);
    this.name = 'PageImageQuotaError';
  }
}

export class PageImageStorageIdentityError extends Error {
  constructor() {
    super('page image storage identity differs from the brain anchor');
    this.name = 'PageImageStorageIdentityError';
  }
}

const PAGE_IMAGE_STORAGE_IDENTITY_KEY = 'page_images.storage_identity';

/** Cheap fail-fast check; commitPageImage repeats this atomically under lock. */
export async function assertPageImageStorageIdentity(
  engine: Pick<BrainEngine, 'getConfig'>,
  storageIdentity: string,
): Promise<void> {
  const anchored = await engine.getConfig(PAGE_IMAGE_STORAGE_IDENTITY_KEY);
  if (anchored !== null && anchored !== storageIdentity) {
    throw new PageImageStorageIdentityError();
  }
}

async function anchorPageImageStorageIdentity(
  engine: Pick<BrainEngine, 'executeRaw'>,
  storageIdentity: string,
): Promise<void> {
  let [anchor] = await engine.executeRaw<{ value: string }>(
    `SELECT value FROM config WHERE key = $1 FOR UPDATE`,
    [PAGE_IMAGE_STORAGE_IDENTITY_KEY],
  );
  if (!anchor) {
    const identities = await engine.executeRaw<{ storage_identity: string }>(
      `SELECT storage_identity FROM (
         SELECT DISTINCT COALESCE(metadata->>'storage_identity', 'legacy') AS storage_identity
         FROM files
         WHERE metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend'
         UNION
         SELECT DISTINCT storage_identity FROM page_image_gc_queue
       ) existing_identities
       LIMIT 2`,
    );
    if (identities.some(row => row.storage_identity !== storageIdentity)) {
      throw new PageImageStorageIdentityError();
    }
    await engine.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [PAGE_IMAGE_STORAGE_IDENTITY_KEY, storageIdentity],
    );
    [anchor] = await engine.executeRaw<{ value: string }>(
      `SELECT value FROM config WHERE key = $1 FOR UPDATE`,
      [PAGE_IMAGE_STORAGE_IDENTITY_KEY],
    );
  }
  if (!anchor || anchor.value !== storageIdentity) {
    throw new PageImageStorageIdentityError();
  }
}

/**
 * Claim the immutable storage identity and persist the upload recovery intent
 * as one critical section. This must happen before object I/O: queuing first
 * would let two different backends race on an unanchored brain and leave
 * mutually-conflicting intents that neither writer can ever commit.
 */
export async function queuePageImageUploadIntent(
  engine: BrainEngine,
  storagePath: string,
  storageIdentity: string,
  sourceId: string,
): Promise<void> {
  await engine.transaction(async tx => {
    if (tx.kind === 'postgres') {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['gbrain-page-images']);
    }
    await anchorPageImageStorageIdentity(tx, storageIdentity);
    await queuePageImageGc(tx, storagePath, storageIdentity, sourceId, 'upload_pending');
  });
}

export interface PageImageCommitResult {
  file: FileRow;
  created: boolean;
  headChanged: boolean;
  previousImageRef?: string;
  version: number;
}

export interface CurrentPageImageSummary {
  filename: string;
  image_ref: string;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string;
  alt_text: string;
  version_count: number;
}

export interface PageImageGcRow extends FileRow {
  is_current: boolean;
}

export interface PageImageGcQueueItem {
  storage_path: string;
  storage_identity: string;
  source_id: string;
  reason: string;
  queued_at: Date;
  attempts: number;
  last_error: string | null;
}

function asFileRow(row: Record<string, unknown>): FileRow {
  const metadata = typeof row.metadata === 'string'
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: Number(row.id),
    source_id: String(row.source_id),
    page_slug: row.page_slug == null ? null : String(row.page_slug),
    page_id: row.page_id == null ? null : Number(row.page_id),
    filename: String(row.filename),
    storage_path: String(row.storage_path),
    mime_type: row.mime_type == null ? null : String(row.mime_type),
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    content_hash: String(row.content_hash),
    metadata,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/**
 * Atomically enforce source/page/version quotas, insert or refresh the
 * content-addressed files row, and move the explicit current head. Postgres
 * serialises page-image storage mutation with one transaction advisory lock;
 * PGLite's single-writer transaction provides the same invariant.
 */
export async function commitPageImage(
  engine: BrainEngine,
  spec: FileSpec & { source_id: string; page_id: number; page_slug: string; size_bytes: number },
  quotas: PageImageQuotas,
  beforeCommit?: () => Promise<void>,
): Promise<PageImageCommitResult> {
  return engine.transaction(async tx => {
    if (tx.kind === 'postgres') {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['gbrain-page-images']);
    }
    const storageIdentity = typeof spec.metadata?.storage_identity === 'string'
      ? spec.metadata.storage_identity
      : '';
    if (!storageIdentity) throw new PageImageStorageIdentityError();
    await anchorPageImageStorageIdentity(tx, storageIdentity);
    const pages = await tx.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE id = $1 AND source_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [spec.page_id, spec.source_id],
    );
    if (pages.length !== 1) throw new Error('owning page changed or was deleted before image commit');

    const existingRows = await tx.executeRaw<Record<string, unknown>>(
      `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type,
              size_bytes, content_hash, metadata, created_at
       FROM files
       WHERE storage_path = $1
       LIMIT 1 FOR UPDATE`,
      [spec.storage_path],
    );
    const headRows = await tx.executeRaw<{ file_id: number | string; storage_path: string }>(
      `SELECT h.file_id, f.storage_path
       FROM page_image_heads h JOIN files f ON f.id = h.file_id
       WHERE h.page_id = $1 AND h.source_id = $2 AND h.filename = $3
       LIMIT 1`,
      [spec.page_id, spec.source_id, spec.filename],
    );
    const previousHead = headRows[0];
    let existing = existingRows[0] ? asFileRow(existingRows[0]) : null;
    if (existing) {
      const metadata = existing.metadata ?? {};
      const compatible = existing.source_id === spec.source_id && existing.page_id === spec.page_id &&
        existing.filename === spec.filename && existing.content_hash === spec.content_hash &&
        metadata.kind === 'page_image' && metadata.storage === 'backend' &&
        metadata.storage_identity === storageIdentity;
      if (!compatible) throw new Error('storage_path collision belongs to a different image');
    }

    if (!existing) {
      const [usage] = await tx.executeRaw<{
        source_files: number | string; source_bytes: number | string;
        page_files: number | string; page_bytes: number | string; versions: number | string;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM files
             WHERE source_id = $1 AND page_id IS NOT NULL
               AND metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend') AS source_files,
           (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM files
             WHERE source_id = $1 AND page_id IS NOT NULL
               AND metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend') AS source_bytes,
           (SELECT COUNT(*)::int FROM files
             WHERE page_id = $2 AND source_id = $1
               AND metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend') AS page_files,
           (SELECT COALESCE(SUM(size_bytes), 0)::bigint FROM files
             WHERE page_id = $2 AND source_id = $1
               AND metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend') AS page_bytes,
           (SELECT COUNT(*)::int FROM files
             WHERE page_id = $2 AND source_id = $1 AND filename = $3
               AND metadata->>'kind' = 'page_image' AND metadata->>'storage' = 'backend') AS versions`,
        [spec.source_id, spec.page_id, spec.filename],
      );
      const sourceFiles = Number(usage?.source_files ?? 0);
      const sourceBytes = Number(usage?.source_bytes ?? 0);
      const pageFiles = Number(usage?.page_files ?? 0);
      const pageBytes = Number(usage?.page_bytes ?? 0);
      const versions = Number(usage?.versions ?? 0);
      if (versions >= quotas.versionsPerFilename) {
        throw new PageImageQuotaError('versions', `retained version limit ${quotas.versionsPerFilename} reached`);
      }
      if (pageFiles >= quotas.pageFiles || pageBytes + spec.size_bytes > quotas.pageBytes) {
        throw new PageImageQuotaError('page', 'page image quota exceeded');
      }
      if (sourceFiles >= quotas.sourceFiles || sourceBytes + spec.size_bytes > quotas.sourceBytes) {
        throw new PageImageQuotaError('source', 'source image quota exceeded');
      }
    }

    let fileId = existing?.id;
    let created = false;
    if (fileId === undefined) {
      const inserted = await tx.executeRaw<{ id: number | string }>(
        `INSERT INTO files
           (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)
         ON CONFLICT (storage_path) DO NOTHING
         RETURNING id`,
        [
          spec.source_id, spec.page_slug, spec.page_id, spec.filename, spec.storage_path,
          spec.mime_type ?? null, spec.size_bytes, spec.content_hash, JSON.stringify(spec.metadata ?? {}),
        ],
      );
      if (inserted[0]) {
        fileId = Number(inserted[0].id);
        created = true;
      } else {
        const collisionRows = await tx.executeRaw<Record<string, unknown>>(
          `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type,
                  size_bytes, content_hash, metadata, created_at
           FROM files WHERE storage_path = $1 LIMIT 1 FOR UPDATE`,
          [spec.storage_path],
        );
        const collision = collisionRows[0] ? asFileRow(collisionRows[0]) : null;
        const metadata = collision?.metadata ?? {};
        const compatible = collision?.source_id === spec.source_id && collision.page_id === spec.page_id &&
          collision.filename === spec.filename && collision.content_hash === spec.content_hash &&
          metadata.kind === 'page_image' && metadata.storage === 'backend' &&
          metadata.storage_identity === storageIdentity;
        if (!collision || !compatible) throw new Error('storage_path collision belongs to a different image');
        existing = collision;
        fileId = collision.id;
      }
    }
    if (fileId === undefined) throw new Error('image metadata insert returned no id');

    // The globally-unique metadata row is now either locked or reserved in
    // this transaction. A foreign path collision therefore fails before any
    // non-transactional backend write can replace another object's bytes.
    // Quotas and the durable upload intent also precede this storage I/O.
    if (beforeCommit) await beforeCommit();

    await tx.executeRaw(
      `UPDATE files SET page_slug = $1, page_id = $2, filename = $3, mime_type = $4,
                        size_bytes = $5, content_hash = $6, metadata = $7::text::jsonb
       WHERE id = $8 AND source_id = $9`,
      [
        spec.page_slug, spec.page_id, spec.filename, spec.mime_type ?? null,
        spec.size_bytes, spec.content_hash, JSON.stringify(spec.metadata ?? {}), fileId, spec.source_id,
      ],
    );
    await tx.executeRaw(
      `INSERT INTO page_image_heads (page_id, source_id, filename, file_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (page_id, filename) DO UPDATE SET
         source_id = EXCLUDED.source_id, file_id = EXCLUDED.file_id, updated_at = now()`,
      [spec.page_id, spec.source_id, spec.filename, fileId],
    );
    await tx.executeRaw(
      `DELETE FROM page_image_gc_queue WHERE storage_identity = $1 AND storage_path = $2`,
      [storageIdentity, spec.storage_path],
    );
    const [versionRow] = await tx.executeRaw<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM files
       WHERE source_id = $1 AND page_id = $2 AND filename = $3 AND metadata->>'kind' = 'page_image'`,
      [spec.source_id, spec.page_id, spec.filename],
    );
    const [stored] = await tx.executeRaw<Record<string, unknown>>(
      `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type,
              size_bytes, content_hash, metadata, created_at FROM files WHERE id = $1`,
      [fileId],
    );
    if (!stored) throw new Error('committed image row is missing');
    return {
      file: asFileRow(stored),
      created,
      headChanged: previousHead == null || Number(previousHead.file_id) !== fileId,
      ...(previousHead && previousHead.storage_path !== spec.storage_path
        ? { previousImageRef: previousHead.storage_path }
        : {}),
      version: Number(versionRow?.count ?? 1),
    };
  });
}

/** Bounded discovery: one explicit head per filename, never all versions. */
export async function listCurrentPageImages(
  engine: Pick<BrainEngine, 'executeRaw'>,
  pageId: number,
  sourceId: string,
  limit = 100,
): Promise<CurrentPageImageSummary[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT f.filename, f.storage_path AS image_ref, f.mime_type, f.size_bytes,
            f.content_hash AS sha256,
            COALESCE(f.metadata->>'alt_text', f.filename) AS alt_text,
            (SELECT COUNT(*)::int FROM files v
              WHERE v.page_id = h.page_id AND v.source_id = h.source_id
                AND v.filename = h.filename AND v.metadata->>'kind' = 'page_image') AS version_count
     FROM page_image_heads h JOIN files f ON f.id = h.file_id
     WHERE h.page_id = $1 AND h.source_id = $2 AND f.page_id = h.page_id
       AND f.source_id = h.source_id AND f.metadata->>'kind' = 'page_image'
     ORDER BY f.filename ASC
     LIMIT $3`,
    [pageId, sourceId, Math.max(1, Math.min(Math.floor(limit), 100))],
  );
  return rows.map(row => ({
    filename: String(row.filename),
    image_ref: String(row.image_ref),
    mime_type: row.mime_type == null ? null : String(row.mime_type),
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: String(row.sha256).replace(/^sha256:/, ''),
    alt_text: String(row.alt_text),
    version_count: Number(row.version_count),
  }));
}

export async function setPageImageHead(
  engine: Pick<BrainEngine, 'executeRaw'>,
  pageId: number,
  sourceId: string,
  filename: string,
  fileId: number,
): Promise<void> {
  const inserted = await engine.executeRaw<{ file_id: number | string }>(
    `INSERT INTO page_image_heads (page_id, source_id, filename, file_id, updated_at)
     SELECT $1, $2, $3, f.id, now()
     FROM files f
     WHERE f.id = $4 AND f.page_id = $1 AND f.source_id = $2
       AND f.filename = $3 AND f.metadata->>'kind' = 'page_image'
     ON CONFLICT (page_id, filename) DO UPDATE SET
       source_id = EXCLUDED.source_id, file_id = EXCLUDED.file_id, updated_at = now()
     RETURNING file_id`,
    [pageId, sourceId, filename, fileId],
  );
  if (inserted.length !== 1) {
    throw new Error('page image head target does not belong to the requested source, page, and filename');
  }
}

export async function listPageImagesForGc(
  engine: Pick<BrainEngine, 'executeRaw'>,
  cutoff: Date,
  sourceId?: string,
  limit = 100,
): Promise<PageImageGcRow[]> {
  const params: unknown[] = [cutoff.toISOString()];
  const sourceClause = sourceId ? `AND f.source_id = $2` : '';
  if (sourceId) params.push(sourceId);
  params.push(Math.max(1, Math.min(Math.floor(limit), 1000)));
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT f.id, f.source_id, f.page_slug, f.page_id, f.filename, f.storage_path,
            f.mime_type, f.size_bytes, f.content_hash, f.metadata, f.created_at,
            CASE WHEN h.file_id IS NULL THEN false ELSE true END AS is_current
     FROM files f LEFT JOIN page_image_heads h ON h.file_id = f.id
     WHERE f.metadata->>'kind' = 'page_image'
       AND f.metadata->>'storage' = 'backend'
       AND h.file_id IS NULL
       AND f.created_at < $1::timestamptz
       ${sourceClause}
     ORDER BY f.id ASC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(row => ({ ...asFileRow(row), is_current: row.is_current === true || row.is_current === 'true' }));
}

export async function countPageImagesForGc(
  engine: Pick<BrainEngine, 'executeRaw'>,
  cutoff: Date,
  sourceId?: string,
): Promise<number> {
  const params: unknown[] = [cutoff.toISOString()];
  const sourceClause = sourceId ? `AND f.source_id = $2` : '';
  if (sourceId) params.push(sourceId);
  const [row] = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
     FROM files f LEFT JOIN page_image_heads h ON h.file_id = f.id
     WHERE f.metadata->>'kind' = 'page_image'
       AND f.metadata->>'storage' = 'backend'
       AND h.file_id IS NULL
       AND f.created_at < $1::timestamptz
       ${sourceClause}`,
    params,
  );
  return Number(row?.count ?? 0);
}

export async function queuePageImageGc(
  engine: Pick<BrainEngine, 'executeRaw'>,
  storagePath: string,
  storageIdentity: string,
  sourceId: string,
  reason: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO page_image_gc_queue (storage_path, storage_identity, source_id, reason, queued_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (storage_identity, storage_path) DO UPDATE SET
       source_id = EXCLUDED.source_id, reason = EXCLUDED.reason, queued_at = now()`,
    [storagePath, storageIdentity, sourceId, reason],
  );
}

/** Queue and remove stale metadata in one transaction; current heads survive. */
export async function scheduleStalePageImagesForGc(
  engine: BrainEngine,
  cutoff: Date,
  sourceId?: string,
): Promise<string[]> {
  return engine.transaction(async tx => {
    if (tx.kind === 'postgres') {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['gbrain-page-images']);
    }
    const params: unknown[] = [cutoff.toISOString()];
    const sourceClause = sourceId ? `AND f.source_id = $2` : '';
    if (sourceId) params.push(sourceId);
    const rows = await tx.executeRaw<{
      id: number | string; storage_path: string; source_id: string; storage_identity: string;
    }>(
      `SELECT f.id, f.storage_path, f.source_id,
              COALESCE(f.metadata->>'storage_identity', 'legacy') AS storage_identity
       FROM files f LEFT JOIN page_image_heads h ON h.file_id = f.id
       WHERE f.metadata->>'kind' = 'page_image'
         AND f.metadata->>'storage' = 'backend'
         AND h.file_id IS NULL
         AND f.created_at < $1::timestamptz
         ${sourceClause}
       ORDER BY f.id ASC
       LIMIT 1000`,
      params,
    );
    for (const row of rows) {
      await queuePageImageGc(tx, row.storage_path, row.storage_identity, row.source_id, 'retention_prune');
      await tx.executeRaw(`DELETE FROM files WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM page_image_heads WHERE file_id = $1)`, [Number(row.id)]);
    }
    return rows.map(row => row.storage_path);
  });
}

export async function listPageImageGcQueue(
  engine: Pick<BrainEngine, 'executeRaw'>,
  limit = 1000,
  sourceId?: string,
): Promise<PageImageGcQueueItem[]> {
  const params: unknown[] = [];
  const sourceClause = sourceId ? `WHERE source_id = $1` : '';
  if (sourceId) params.push(sourceId);
  params.push(Math.max(1, Math.min(Math.floor(limit), 1000)));
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT storage_path, storage_identity, source_id, reason, queued_at, attempts, last_error
     FROM page_image_gc_queue ${sourceClause} ORDER BY queued_at ASC LIMIT $${params.length}`,
    params,
  );
  return rows.map(row => ({
    storage_path: String(row.storage_path),
    storage_identity: String(row.storage_identity),
    source_id: String(row.source_id),
    reason: String(row.reason),
    queued_at: row.queued_at instanceof Date ? row.queued_at : new Date(String(row.queued_at)),
    attempts: Number(row.attempts),
    last_error: row.last_error == null ? null : String(row.last_error),
  }));
}

export async function countPageImageGcQueue(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId?: string,
): Promise<number> {
  const [row] = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM page_image_gc_queue ${sourceId ? 'WHERE source_id = $1' : ''}`,
    sourceId ? [sourceId] : [],
  );
  return Number(row?.count ?? 0);
}

export async function drainPageImageGcItem(
  engine: BrainEngine,
  storage: StorageBackend,
  item: PageImageGcQueueItem,
  expectedStorageIdentity: string,
  recoverUploadIntentsQueuedBefore?: Date,
): Promise<'deleted' | 'retained' | 'deferred' | 'missing'> {
  return engine.transaction(async tx => {
    if (tx.kind === 'postgres') {
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['gbrain-page-images']);
    }
    const queueRows = await tx.executeRaw<{
      storage_path: string; reason: string; queued_at: Date | string;
    }>(
      `SELECT storage_path, reason, queued_at FROM page_image_gc_queue
       WHERE storage_identity = $1 AND storage_path = $2 FOR UPDATE`,
      [item.storage_identity, item.storage_path],
    );
    if (queueRows.length === 0) return 'missing';
    if (item.storage_identity !== expectedStorageIdentity) {
      throw new Error('queued object belongs to a different storage backend identity');
    }
    const queued = queueRows[0]!;
    const queuedAt = queued.queued_at instanceof Date
      ? queued.queued_at
      : new Date(String(queued.queued_at));
    const references = await tx.executeRaw<{ id: number | string }>(
      `SELECT id FROM files WHERE storage_path = $1 LIMIT 1`,
      [item.storage_path],
    );
    if (references.length > 0) {
      await tx.executeRaw(
        `DELETE FROM page_image_gc_queue WHERE storage_identity = $1 AND storage_path = $2`,
        [item.storage_identity, item.storage_path],
      );
      return 'retained';
    }
    // upload_pending is a write-ahead recovery record, not an ordinary
    // deletion request. The routine GC must never consume it while a writer
    // can still be between the committed intent and its locked upload. Only
    // an explicit, aged reconciliation may recover abandoned uploads.
    if (
      queued.reason === 'upload_pending' &&
      (!recoverUploadIntentsQueuedBefore || queuedAt >= recoverUploadIntentsQueuedBefore)
    ) {
      return 'deferred';
    }
    await storage.delete(item.storage_path);
    await tx.executeRaw(
      `DELETE FROM page_image_gc_queue WHERE storage_identity = $1 AND storage_path = $2`,
      [item.storage_identity, item.storage_path],
    );
    return 'deleted';
  });
}

export async function failPageImageGc(
  engine: Pick<BrainEngine, 'executeRaw'>,
  storagePath: string,
  storageIdentity: string,
  error: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE page_image_gc_queue SET attempts = attempts + 1, last_error = $3
     WHERE storage_path = $1 AND storage_identity = $2`,
    [storagePath, storageIdentity, error.slice(0, 1000)],
  );
}
