/**
 * Image operation cluster: native MCP page-image transport plus the v0.36
 * Phase 2 search_by_image op and its cluster-local budget/size config readers.
 * Operation constants stay module-private;
 * `imageOperations` below is spliced into the canonical `operations` array
 * in ../operations.ts at the cluster's original position (between the
 * search and tags spreads). Never import from '../operations.ts' here
 * (cycle).
 */

import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import type { BrainEngine, FileRow } from '../engine.ts';
import type { Page } from '../types.ts';
import { nativeImageResult, NATIVE_IMAGE_MAX_BYTES } from '../native-image-result.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { resolveExcludePrivatePages, isPrivatePage } from '../search/private-visibility.ts';
import { sniffContentType } from '../search/image-loader.ts';
import { isValidSourceId, ALL_SOURCES } from '../source-id.ts';
import {
  createStorage,
  pageImageStorageIdentity,
  type StorageBackend,
  type StorageConfig,
} from '../storage.ts';
import {
  assertPageImageStorageIdentity,
  commitPageImage,
  countPageImageGcQueue,
  countPageImagesForGc,
  drainPageImageGcItem,
  failPageImageGc,
  listPageImageGcQueue,
  listPageImagesForGc,
  PageImageQuotaError,
  PageImageStorageIdentityError,
  queuePageImageUploadIntent,
  scheduleStalePageImagesForGc,
  type PageImageQuotas,
} from '../page-image-storage.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { RateLimiter } from '../../mcp/rate-limit.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  enforceClientSlugFence,
  enforceSubagentSlugFence,
  resolveRequestedScope,
  validateFilename,
  validatePageSlug,
} from './context.ts';

const OWNED_IMAGE_MAX_BYTES = NATIVE_IMAGE_MAX_BYTES;
const DEFAULT_IMAGE_MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_SOURCE_FILES = 1000;
const DEFAULT_IMAGE_MAX_PAGE_BYTES = 128 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_PAGE_FILES = 100;
const DEFAULT_IMAGE_MAX_VERSIONS_PER_FILENAME = 20;
const IMAGE_WRITE_RATE_WINDOW_MS = 60 * 60 * 1000;
type NativeImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

let imageWriteLimiter = new RateLimiter({
  limit: positiveInteger(process.env.GBRAIN_MCP_IMAGE_WRITES_PER_HOUR) ?? 30,
  windowMs: IMAGE_WRITE_RATE_WINDOW_MS,
  lruCap: 5_000,
});

/** Test-only seam for deterministic per-client write-rate coverage. */
export function _resetImageWriteLimiterForTests(limit = 30): void {
  imageWriteLimiter = new RateLimiter({ limit, windowMs: IMAGE_WRITE_RATE_WINDOW_MS, lruCap: 5_000 });
}

const IMAGE_EXTENSIONS: Readonly<Record<string, NativeImageMime>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function configuredQuota(
  ctx: OperationContext,
  key: keyof NonNullable<OperationContext['config']['mcp']>,
  fallback: number,
): Promise<number> {
  const fullKey = `mcp.${String(key)}`;
  try {
    const dbValue = await ctx.engine.getConfig(fullKey);
    if (dbValue != null) return positiveInteger(dbValue) ?? fallback;
  } catch {
    // File plane below remains a safe, finite fallback.
  }
  return positiveInteger(ctx.config.mcp?.[key]) ?? fallback;
}

async function resolveImageQuotas(ctx: OperationContext): Promise<PageImageQuotas> {
  const [sourceBytes, sourceFiles, pageBytes, pageFiles, versionsPerFilename] = await Promise.all([
    configuredQuota(ctx, 'image_max_source_bytes', DEFAULT_IMAGE_MAX_SOURCE_BYTES),
    configuredQuota(ctx, 'image_max_source_files', DEFAULT_IMAGE_MAX_SOURCE_FILES),
    configuredQuota(ctx, 'image_max_page_bytes', DEFAULT_IMAGE_MAX_PAGE_BYTES),
    configuredQuota(ctx, 'image_max_page_files', DEFAULT_IMAGE_MAX_PAGE_FILES),
    configuredQuota(ctx, 'image_max_versions_per_filename', DEFAULT_IMAGE_MAX_VERSIONS_PER_FILENAME),
  ]);
  return { sourceBytes, sourceFiles, pageBytes, pageFiles, versionsPerFilename };
}

async function assertRemoteImagePublishingEnabled(ctx: OperationContext): Promise<void> {
  if (ctx.remote === false) return;
  let enabled = false;
  try {
    const dbValue = await ctx.engine.getConfig('mcp.publish_images');
    enabled = dbValue != null ? dbValue === 'true' : ctx.config.mcp?.publish_images === true;
  } catch {
    enabled = ctx.config.mcp?.publish_images === true;
  }
  if (enabled) return;
  const err = new OperationError(
    'permission_denied',
    'Remote page-image writes are not published by the brain owner.',
    'The owner can enable them with `gbrain config set mcp.publish_images true`.',
  );
  err.detail = 'config_key=mcp.publish_images';
  throw err;
}

function imageSourceId(ctx: OperationContext, raw: unknown, mode: 'read' | 'write'): string {
  let sourceId = ctx.sourceId;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string' || raw === ALL_SOURCES || !isValidSourceId(raw)) {
      throw new OperationError(
        'invalid_params',
        `${mode === 'write' ? 'put_image' : 'get_image'}: source_id must name exactly one registered source`,
      );
    }
    sourceId = raw;
  }

  if (ctx.remote !== false) {
    if (mode === 'write') {
      const authority = ctx.auth?.sourceId ?? ctx.sourceId;
      if (sourceId !== authority) {
        throw new OperationError('permission_denied', `source '${sourceId}' is outside your write authority`);
      }
    } else {
      const allowed = ctx.auth?.allowedSources;
      const scalar = ctx.auth?.sourceId ?? ctx.sourceId;
      const permitted = allowed && allowed.length > 0 ? allowed.includes(sourceId) : sourceId === scalar;
      if (!permitted) {
        throw new OperationError('permission_denied', `source '${sourceId}' is outside your read authority`);
      }
    }
  }
  return sourceId;
}

function strictBase64Image(
  encoded: string,
  declaredMime: string,
  filename: string,
): { bytes: Buffer; mimeType: NativeImageMime; sha256: string } {
  if (encoded.length === 0 || encoded.length > Math.ceil(OWNED_IMAGE_MAX_BYTES / 3) * 4 + 4) {
    throw new OperationError('invalid_params', `Image exceeds the ${OWNED_IMAGE_MAX_BYTES}-byte limit`);
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new OperationError('invalid_params', 'content_base64 is not strict RFC 4648 base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > OWNED_IMAGE_MAX_BYTES || bytes.toString('base64') !== encoded) {
    throw new OperationError('invalid_params', 'content_base64 is malformed or exceeds the image limit');
  }
  const mimeType = validateImageBytes(bytes, filename);
  if (declaredMime !== mimeType) {
    throw new OperationError(
      'invalid_params',
      `Image signature is ${mimeType}, but mime_type declares ${declaredMime}`,
    );
  }
  return { bytes, mimeType, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function validateImageBytes(bytes: Buffer, filename: string): NativeImageMime {
  if (bytes.length === 0 || bytes.length > OWNED_IMAGE_MAX_BYTES) {
    throw new OperationError('invalid_params', `Image exceeds the ${OWNED_IMAGE_MAX_BYTES}-byte limit`);
  }
  let mimeType: NativeImageMime;
  try {
    mimeType = sniffContentType(bytes);
  } catch (err) {
    throw new OperationError('invalid_params', err instanceof Error ? err.message : String(err));
  }
  const expected = IMAGE_EXTENSIONS[extname(filename).toLowerCase()];
  if (!expected) {
    throw new OperationError('invalid_params', 'filename extension must be .png, .jpg, .jpeg, or .webp');
  }
  if (expected !== mimeType) {
    throw new OperationError('invalid_params', 'Image extension does not match its actual signature');
  }
  return mimeType;
}

interface ResolvedPageImageStorage {
  backend: StorageBackend;
  identity: string;
  namespace: string;
}

function storageDescriptorOrThrow(ctx: OperationContext): {
  config: StorageConfig;
  namespace: string;
} {
  if (!ctx.config.storage) {
    throw new OperationError(
      'storage_error',
      'No storage backend configured — page image bytes cannot be stored or retrieved.',
      'Configure `storage` in your gbrain config (supabase | s3 | local), then retry.',
    );
  }
  const config = ctx.config.storage as StorageConfig;
  const namespace = typeof config.namespace === 'string' ? config.namespace.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(namespace)) {
    throw new OperationError(
      'storage_error',
      'Page-image storage requires a stable, brain-exclusive storage.namespace.',
      'Set storage.namespace to a lowercase identifier (letters, digits, underscore, dash; max 64) and keep the backend, bucket, and namespace immutable.',
    );
  }
  if (typeof config.bucket !== 'string' || config.bucket.length === 0) {
    throw new OperationError('storage_error', 'Page-image storage requires a non-empty storage.bucket.');
  }
  return { config, namespace };
}

async function storageOrThrow(ctx: OperationContext): Promise<ResolvedPageImageStorage> {
  const descriptor = storageDescriptorOrThrow(ctx);
  try {
    const backend = await createStorage(descriptor.config);
    const identity = pageImageStorageIdentity(descriptor.config, descriptor.namespace, backend);
    await assertPageImageStorageIdentity(ctx.engine, identity);
    return { backend, identity, namespace: descriptor.namespace };
  } catch (err) {
    ctx.logger.error(`[page-image-storage] configuration check failed (${err instanceof Error ? err.name : 'unknown'})`);
    if (err instanceof PageImageStorageIdentityError) {
      throw storageIdentityMismatchError();
    }
    throw new OperationError('storage_error', 'Page-image storage configuration could not be initialized.');
  }
}

function backendOperationError(
  ctx: OperationContext,
  action: 'probe' | 'upload' | 'download',
  err: unknown,
): OperationError {
  ctx.logger.error(`[page-image-storage] ${action} failed (${err instanceof Error ? err.name : 'unknown'})`);
  return new OperationError('storage_error', `Image storage ${action} failed.`);
}

function storageIdentityMismatchError(): OperationError {
  return new OperationError(
    'storage_error',
    'Page-image storage configuration differs from this brain\'s immutable storage identity.',
    'Restore the original backend locator, bucket, and namespace, or perform an explicit storage migration.',
  );
}

async function pageOrThrow(
  ctx: OperationContext,
  pageSlug: string,
  sourceId: string,
  mode: 'read' | 'write',
): Promise<Page> {
  const page = await ctx.engine.getPage(pageSlug, { sourceId });
  if (!page || (
    mode === 'read' &&
    await resolveExcludePrivatePages(ctx.engine, ctx.remote) &&
    isPrivatePage(page.frontmatter)
  )) {
    throw new OperationError('page_not_found', `Page not found in source '${sourceId}': ${pageSlug}`);
  }
  return page;
}

function contentAddressedImagePath(
  namespace: string,
  sourceId: string,
  pageId: number,
  pageSlug: string,
  sha256: string,
  filename: string,
): string {
  // sourceId, pageSlug, and filename have already passed their canonical
  // validators. Including source + hash prevents the files table's global
  // storage_path uniqueness from colliding across sources and ensures an
  // update never overwrites bytes that an older row may still reference.
  return `images/v1/${namespace}/${sourceId}/${pageId}/${pageSlug}/${sha256}/${filename}`;
}

function imageMetadata(row: FileRow): {
  storage: string | null;
  kind: string | null;
  gitPath: string | null;
  storageIdentity: string | null;
} {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    storage: typeof metadata.storage === 'string' ? metadata.storage : null,
    kind: typeof metadata.kind === 'string' ? metadata.kind : null,
    gitPath: typeof metadata.git_path === 'string' ? metadata.git_path : null,
    storageIdentity: typeof metadata.storage_identity === 'string' ? metadata.storage_identity : null,
  };
}

async function officialImageRow(
  ctx: OperationContext,
  page: Page,
  sourceId: string,
  imageRef: string,
): Promise<FileRow | null> {
  const row = await ctx.engine.getFile(sourceId, imageRef);
  if (!row) return null;
  if (row.source_id !== sourceId) return null;
  // New page_image rows are identity-bound to the immutable page id. A
  // deleted page leaves page_id NULL via ON DELETE SET NULL; recreating the
  // same slug must never resurrect its prior attachments. Trusted local
  // callers retain a narrow compatibility lane for official legacy git rows.
  if (row.page_id !== page.id) {
    const legacyLocalGit = ctx.remote === false && row.page_id == null &&
      row.page_slug === page.slug && imageMetadata(row).storage === 'git';
    if (!legacyLocalGit) return null;
  }
  return row;
}

function normalizeStoredHash(hash: string): string {
  return hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
}

function validateStoredImage(row: FileRow, bytes: Buffer): { mimeType: NativeImageMime; sha256: string } {
  let mimeType: NativeImageMime;
  try {
    mimeType = validateImageBytes(bytes, row.filename);
  } catch (err) {
    throw new OperationError('storage_error', `Stored image is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (row.size_bytes != null && Number(row.size_bytes) !== bytes.length) {
    throw new OperationError('storage_error', 'Stored image size metadata does not match its bytes');
  }
  if (row.mime_type && row.mime_type !== mimeType) {
    throw new OperationError('storage_error', 'Stored image MIME metadata does not match its bytes');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (row.content_hash && normalizeStoredHash(row.content_hash) !== sha256) {
    throw new OperationError('storage_error', 'Stored image failed its SHA-256 integrity check');
  }
  return { mimeType, sha256 };
}

function plainLegacyImageRef(imageRef: string): boolean {
  return !(
    imageRef.length === 0 || imageRef.length > 2048 || imageRef.includes('\0') ||
    imageRef.includes('\\') || imageRef.includes('?') || imageRef.includes('#') ||
    isAbsolute(imageRef) || /^[a-z][a-z0-9+.-]*:/i.test(imageRef) ||
    /%(?:2e|2f|5c)/i.test(imageRef)
  );
}

function pageReferencesLegacyImage(page: Page, imageRef: string): boolean {
  const markdown = `${page.compiled_truth}\n${page.timeline ?? ''}`;
  const imagePattern = /!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n)]*\)))?\s*\)/g;
  for (const match of markdown.matchAll(imagePattern)) {
    if ((match[1] ?? match[2]) === imageRef) return true;
  }
  return false;
}

async function readLegacyImage(
  ctx: OperationContext,
  page: Page,
  sourceId: string,
  imageRef: string,
): Promise<{ bytes: Buffer; mimeType: NativeImageMime; sha256: string; storagePath: string }> {
  const { existsSync, lstatSync, readFileSync, statSync } = await import('node:fs');
  // Compatibility is deliberately read-only and page-bound: an arbitrary
  // path elsewhere in the same source is not readable merely because the
  // caller can name a public page. The requested page must carry this exact
  // Markdown image destination.
  if (!plainLegacyImageRef(imageRef) || !pageReferencesLegacyImage(page, imageRef)) {
    throw new OperationError('not_found', 'Image is not attached to the requested page');
  }
  const target = await resolvePageWriteTarget(ctx.engine, page.slug, sourceId);
  if (!target.ok) {
    throw new OperationError('not_found', 'Image is not available from the configured files backend');
  }
  const imagePath = resolve(dirname(target.filePath), imageRef);
  if (!isWriteTargetContained(imagePath, target.sourceRoot)) {
    throw new OperationError('permission_denied', 'image_ref escapes the owning source');
  }
  if (!existsSync(imagePath) || lstatSync(imagePath).isSymbolicLink() || !statSync(imagePath).isFile()) {
    throw new OperationError('not_found', 'Image not found in the owning source');
  }
  const stat = statSync(imagePath);
  if (stat.size > OWNED_IMAGE_MAX_BYTES) {
    throw new OperationError('invalid_params', `Image exceeds the ${OWNED_IMAGE_MAX_BYTES}-byte read limit`);
  }
  const bytes = readFileSync(imagePath);
  const mimeType = validateImageBytes(bytes, imagePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, mimeType, sha256, storagePath: imageRef };
}

async function readOfficialImage(
  ctx: OperationContext,
  row: FileRow,
  sourceId: string,
  pageSlug: string,
): Promise<{ bytes: Buffer; mimeType: NativeImageMime; sha256: string; storagePath: string }> {
  if (row.size_bytes != null && Number(row.size_bytes) > OWNED_IMAGE_MAX_BYTES) {
    throw new OperationError('invalid_params', `Image exceeds the ${OWNED_IMAGE_MAX_BYTES}-byte read limit`);
  }
  let bytes: Buffer;
  if (imageMetadata(row).storage === 'git') {
    const { existsSync, lstatSync, readFileSync, statSync } = await import('node:fs');
    const target = await resolvePageWriteTarget(ctx.engine, pageSlug, sourceId);
    const gitPath = imageMetadata(row).gitPath ?? row.storage_path;
    if (!target.ok || !plainLegacyImageRef(gitPath)) {
      throw new OperationError('not_found', 'Git-backed image is unavailable');
    }
    // Imported image paths are source-root relative in both local_path and
    // managed .sources/<id> topologies. writeRoot is page-specific and would
    // incorrectly double-prefix paths for managed sources.
    const imagePath = resolve(target.sourceRoot, gitPath);
    if (!isWriteTargetContained(imagePath, target.sourceRoot)) {
      throw new OperationError('permission_denied', 'Git-backed image escapes the owning source');
    }
    if (!existsSync(imagePath) || lstatSync(imagePath).isSymbolicLink() || !statSync(imagePath).isFile()) {
      throw new OperationError('not_found', 'Git-backed image is missing');
    }
    if (statSync(imagePath).size > OWNED_IMAGE_MAX_BYTES) {
      throw new OperationError('invalid_params', `Image exceeds the ${OWNED_IMAGE_MAX_BYTES}-byte read limit`);
    }
    bytes = readFileSync(imagePath);
  } else {
    const storage = await storageOrThrow(ctx);
    if (imageMetadata(row).storageIdentity !== storage.identity) {
      throw new OperationError(
        'storage_error',
        'Image metadata belongs to a different storage backend identity.',
        'Restore the immutable backend/bucket/namespace configuration used when the image was written.',
      );
    }
    let present = false;
    try {
      present = await storage.backend.exists(row.storage_path);
    } catch (err) {
      throw backendOperationError(ctx, 'probe', err);
    }
    if (!present) throw new OperationError('not_found', 'Image metadata exists but its stored bytes are missing');
    try {
      bytes = await storage.backend.download(row.storage_path, OWNED_IMAGE_MAX_BYTES);
    } catch (err) {
      throw backendOperationError(ctx, 'download', err);
    }
  }
  const { mimeType, sha256 } = validateStoredImage(row, bytes);
  return { bytes, mimeType, sha256, storagePath: row.storage_path };
}

const put_image: Operation = {
  name: 'put_image',
  description: 'Store a PNG, JPEG, or WebP page image through the configured files backend. Remote writes require the owner gate mcp.publish_images. Returns get_image_args for lossless retrieval; identical retries are no-ops and finite source/page/version quotas bound retained objects.',
  publishGateKey: 'mcp.publish_images',
  params: {
    page_slug: { type: 'string', required: true, description: 'Canonical page slug that owns the image.' },
    filename: { type: 'string', required: true, description: 'Image filename (.png, .jpg, .jpeg, or .webp); no path components.' },
    content_base64: { type: 'string', required: true, description: 'Strict base64 image bytes. Maximum decoded size: 8 MiB.' },
    mime_type: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp'], description: 'Declared MIME type; must match both file extension and magic bytes.' },
    alt_text: { type: 'string', description: 'Optional alternative text (maximum 500 characters).' },
    source_id: { type: 'string', description: 'Single source that owns the page. Defaults to the caller write source.' },
  },
  mutating: true,
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (ctx, p) => {
    await assertRemoteImagePublishingEnabled(ctx);
    const pageSlug = p.page_slug as string;
    const filename = p.filename as string;
    const declaredMime = p.mime_type as string;
    const altText = p.alt_text === undefined ? filename : p.alt_text;
    if (typeof altText !== 'string' || altText.length > 500 || /[\r\n]/.test(altText)) {
      throw new OperationError('invalid_params', 'alt_text must be a single line of at most 500 characters');
    }
    validatePageSlug(pageSlug);
    validateFilename(filename);
    if (filename.includes('/') || filename.includes('\\')) {
      throw new OperationError('invalid_params', 'filename must not contain path components');
    }
    enforceSubagentSlugFence(ctx, pageSlug, 'put_image');
    enforceClientSlugFence(ctx, pageSlug, 'put_image');
    const sourceId = imageSourceId(ctx, p.source_id, 'write');
    const { bytes, mimeType, sha256 } = strictBase64Image(p.content_base64 as string, declaredMime, filename);
    const page = await pageOrThrow(ctx, pageSlug, sourceId, 'write');
    const storageDescriptor = storageDescriptorOrThrow(ctx);
    const storagePath = contentAddressedImagePath(
      storageDescriptor.namespace, sourceId, page.id, pageSlug, sha256, filename,
    );
    const candidate = await ctx.engine.getFile(sourceId, storagePath);
    const exact = candidate?.page_id === page.id && candidate.filename === filename &&
      normalizeStoredHash(candidate.content_hash) === sha256 && imageMetadata(candidate).kind === 'page_image'
      ? candidate
      : null;
    const [state] = await ctx.engine.executeRaw<{
      storage_path: string | null; file_id: number | string | null; version_count: number | string;
    }>(
      `SELECT h.file_id, f.storage_path,
              (SELECT COUNT(*)::int FROM files v
                WHERE v.page_id = $1 AND v.source_id = $2 AND v.filename = $3
                  AND v.metadata->>'kind' = 'page_image') AS version_count
       FROM (SELECT 1) seed
       LEFT JOIN page_image_heads h ON h.page_id = $1 AND h.source_id = $2 AND h.filename = $3
       LEFT JOIN files f ON f.id = h.file_id`,
      [page.id, sourceId, filename],
    );
    const currentRef = state?.storage_path ?? null;
    const versionCount = Number(state?.version_count ?? 0);

    if (ctx.dryRun) {
      return {
        status: 'dry_run', source_id: sourceId, page_slug: pageSlug, filename,
        storage_path: storagePath, image_ref: storagePath, alt_text: altText,
        mime_type: mimeType, size_bytes: bytes.length, sha256,
        version: exact ? versionCount : versionCount + 1,
        ...(currentRef && currentRef !== storagePath ? { previous_image_ref: currentRef } : {}),
        get_image_args: { page_slug: pageSlug, image_ref: storagePath, source_id: sourceId },
      };
    }

    const storage = await storageOrThrow(ctx);
    let objectHealthy = false;
    let exactNoop = false;
    let repairedObject = false;
    if (exact) {
      try {
        if (
          imageMetadata(exact).storageIdentity === storage.identity &&
          await storage.backend.exists(exact.storage_path)
        ) {
          const stored = await storage.backend.download(exact.storage_path, OWNED_IMAGE_MAX_BYTES);
          validateStoredImage(exact, stored);
          objectHealthy = true;
        }
      } catch { /* upload below repairs missing, oversized, or corrupt bytes */ }
      const recordedAlt = typeof exact.metadata.alt_text === 'string' ? exact.metadata.alt_text : exact.filename;
      if (objectHealthy && currentRef === storagePath && recordedAlt === altText) {
        exactNoop = true;
      }
    }

    if (ctx.remote !== false && !exactNoop) {
      const principal = ctx.auth?.clientId ?? `source:${sourceId}`;
      const rate = imageWriteLimiter.check(principal);
      if (!rate.allowed) {
        const err = new OperationError(
          'rate_limited',
          'Remote image write rate exceeded.',
          `Retry after ${rate.retryAfter ?? 60} seconds.`,
        );
        err.detail = `retry_after=${rate.retryAfter ?? 60}`;
        throw err;
      }
    }

    let uploadBeforeCommit: (() => Promise<void>) | undefined;
    if (!objectHealthy) {
      try {
        // Durable intent precedes object creation. commitPageImage holds the
        // same lock as GC while running the upload and commits metadata plus
        // intent removal atomically; a crash leaves this row for later GC.
        await queuePageImageUploadIntent(ctx.engine, storagePath, storage.identity, sourceId);
        uploadBeforeCommit = async () => {
          try {
            await storage.backend.upload(storagePath, bytes, mimeType);
          } catch (err) {
            throw backendOperationError(ctx, 'upload', err);
          }
        };
        repairedObject = exact !== null;
      } catch (err) {
        if (err instanceof OperationError) throw err;
        if (err instanceof PageImageStorageIdentityError) throw storageIdentityMismatchError();
        ctx.logger.error(`[page-image-storage] upload intent write failed (${err instanceof Error ? err.name : 'unknown'})`);
        throw new OperationError('database_error', 'Image upload intent write failed.');
      }
    }

    const quotas = await resolveImageQuotas(ctx);
    let committed: Awaited<ReturnType<typeof commitPageImage>>;
    try {
      committed = await commitPageImage(ctx.engine, {
        source_id: sourceId,
        page_slug: pageSlug,
        page_id: page.id,
        filename,
        storage_path: storagePath,
        mime_type: mimeType,
        size_bytes: bytes.length,
        content_hash: sha256,
        metadata: {
          storage: 'backend', kind: 'page_image', alt_text: altText,
          storage_identity: storage.identity,
        },
      }, quotas, uploadBeforeCommit);
    } catch (err) {
      if (err instanceof PageImageQuotaError) {
        const hint = err.quota === 'versions'
          ? 'Reuse an existing image_ref, prune retained versions, or review mcp.image_max_versions_per_filename.'
          : err.quota === 'page'
            ? 'Prune retained versions or review mcp.image_max_page_files and mcp.image_max_page_bytes.'
            : 'Prune retained versions or review mcp.image_max_source_files and mcp.image_max_source_bytes.';
        throw new OperationError('storage_error', `Image ${err.quota} quota exceeded for '${filename}'.`, hint);
      }
      if (err instanceof PageImageStorageIdentityError) {
        throw storageIdentityMismatchError();
      }
      if (err instanceof OperationError) throw err;
      ctx.logger.error(`[page-image-storage] metadata write failed (${err instanceof Error ? err.name : 'unknown'})`);
      throw new OperationError('database_error', 'Image metadata write failed.');
    }

    const status = repairedObject
      ? 'updated'
      : exactNoop && !committed.created && !committed.headChanged
      ? 'unchanged'
      : committed.created
      ? (committed.previousImageRef ? 'updated' : 'created')
      : (committed.headChanged ? 'updated' : 'unchanged');
    return {
      status,
      source_id: sourceId,
      page_slug: pageSlug,
      filename,
      storage_path: storagePath,
      image_ref: storagePath,
      alt_text: altText,
      mime_type: mimeType,
      size_bytes: bytes.length,
      sha256,
      version: committed.version,
      ...(committed.previousImageRef ? { previous_image_ref: committed.previousImageRef } : {}),
      get_image_args: { page_slug: pageSlug, image_ref: storagePath, source_id: sourceId },
    };
  },
};

const get_image: Operation = {
  name: 'get_image',
  description: 'Return a page-owned image as a native MCP image content block. Remote callers may read only official files rows bound to the current page id; trusted local callers retain a read-only legacy Markdown fallback.',
  params: {
    page_slug: { type: 'string', required: true, description: 'Canonical page slug that owns or references the image.' },
    image_ref: { type: 'string', required: true, description: 'Opaque storage_path returned by put_image, or an existing Markdown image path referenced by the page.' },
    source_id: { type: 'string', description: 'Single source that owns the page. Defaults to the caller read source.' },
  },
  scope: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (ctx, p) => {
    const pageSlug = p.page_slug as string;
    const imageRef = p.image_ref as string;
    validatePageSlug(pageSlug);
    if (imageRef.length === 0 || imageRef.length > 2048 || imageRef.includes('\0')) {
      throw new OperationError('invalid_params', 'image_ref must be a non-empty storage reference of at most 2048 characters');
    }
    const sourceId = imageSourceId(ctx, p.source_id, 'read');
    const page = await pageOrThrow(ctx, pageSlug, sourceId, 'read');
    const row = await officialImageRow(ctx, page, sourceId, imageRef);
    if (!row && ctx.remote !== false) {
      throw new OperationError('not_found', 'Image is not attached to the requested page');
    }
    const image = row
      ? await readOfficialImage(ctx, row, sourceId, pageSlug)
      : await readLegacyImage(ctx, page, sourceId, imageRef);

    return nativeImageResult({
      source_id: sourceId,
      page_slug: pageSlug,
      image_ref: image.storagePath,
      storage_path: row?.storage_path,
      storage: row ? imageMetadata(row).storage ?? 'backend' : 'legacy_git',
      mime_type: image.mimeType,
      size_bytes: image.bytes.length,
      sha256: image.sha256,
    }, { bytes: image.bytes, mimeType: image.mimeType });
  },
};

const prune_page_images: Operation = {
  name: 'prune_page_images',
  description: 'Operator-only reconciliation for stale page-image versions and the durable object-deletion queue. Dry-run reports candidates; mutation deletes metadata first, then backend objects idempotently.',
  params: {
    retention_days: { type: 'number', description: 'Delete non-current backend versions older than this many days (default 30, range 1..3650).' },
    source_id: { type: 'string', description: 'Optional single source filter for newly scheduled stale versions.' },
    recover_upload_intents_older_than_minutes: {
      type: 'number',
      description: 'Explicitly recover abandoned upload_pending objects older than this many minutes (range 15..10080). Omit during ordinary GC.',
    },
  },
  scope: 'admin',
  localOnly: true,
  mutating: true,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async (ctx, p) => {
    const retentionDays = p.retention_days === undefined ? 30 : Number(p.retention_days);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new OperationError('invalid_params', 'retention_days must be an integer from 1 to 3650');
    }
    const sourceId = p.source_id === undefined ? undefined : String(p.source_id);
    if (sourceId !== undefined && (sourceId === ALL_SOURCES || !isValidSourceId(sourceId))) {
      throw new OperationError('invalid_params', 'source_id must name one registered source');
    }
    const recoverMinutes = p.recover_upload_intents_older_than_minutes === undefined
      ? undefined
      : Number(p.recover_upload_intents_older_than_minutes);
    if (
      recoverMinutes !== undefined &&
      (!Number.isInteger(recoverMinutes) || recoverMinutes < 15 || recoverMinutes > 10_080)
    ) {
      throw new OperationError(
        'invalid_params',
        'recover_upload_intents_older_than_minutes must be an integer from 15 to 10080',
      );
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const recoverUploadIntentsQueuedBefore = recoverMinutes === undefined
      ? undefined
      : new Date(Date.now() - recoverMinutes * 60 * 1000);
    const [candidateCount, candidates, queuedCount, queuedBefore] = await Promise.all([
      countPageImagesForGc(ctx.engine, cutoff, sourceId),
      listPageImagesForGc(ctx.engine, cutoff, sourceId, 100),
      countPageImageGcQueue(ctx.engine, sourceId),
      listPageImageGcQueue(ctx.engine, 100, sourceId),
    ]);
    if (ctx.dryRun) {
      return {
        status: 'dry_run', retention_days: retentionDays, cutoff: cutoff.toISOString(),
        candidate_count: candidateCount,
        candidate_returned: candidates.length,
        candidate_truncated: candidateCount > candidates.length,
        candidates: candidates.map(row => row.storage_path),
        queued_count: queuedCount,
        queued_returned: queuedBefore.length,
        queued_truncated: queuedCount > queuedBefore.length,
        queued: queuedBefore.map(row => row.storage_path),
        recover_upload_intents_older_than_minutes: recoverMinutes ?? null,
        recoverable_upload_intents: recoverUploadIntentsQueuedBefore
          ? queuedBefore.filter(row =>
              row.reason === 'upload_pending' && row.queued_at < recoverUploadIntentsQueuedBefore,
            ).map(row => row.storage_path)
          : [],
      };
    }

    const storage = await storageOrThrow(ctx);
    const scheduled = await scheduleStalePageImagesForGc(ctx.engine, cutoff, sourceId);
    const queue = await listPageImageGcQueue(ctx.engine, 1000, sourceId);
    const deleted: string[] = [];
    const retained: string[] = [];
    const deferred: string[] = [];
    const failed: Array<{ storage_path: string; error: string }> = [];
    for (const item of queue) {
      try {
        const result = await drainPageImageGcItem(
          ctx.engine, storage.backend, item, storage.identity,
          recoverUploadIntentsQueuedBefore,
        );
        if (result === 'deleted') deleted.push(item.storage_path);
        else if (result === 'retained') retained.push(item.storage_path);
        else if (result === 'deferred') deferred.push(item.storage_path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failPageImageGc(ctx.engine, item.storage_path, item.storage_identity, message);
        failed.push({ storage_path: item.storage_path, error: message });
      }
    }
    return {
      status: failed.length === 0 ? 'complete' : 'partial',
      retention_days: retentionDays,
      scheduled_count: scheduled.length,
      deleted_count: deleted.length,
      retained_count: retained.length,
      deferred_count: deferred.length,
      failed_count: failed.length,
      deleted: deleted.slice(0, 100),
      retained: retained.slice(0, 100),
      deferred: deferred.slice(0, 100),
      failed: failed.slice(0, 100),
      queue_batch_limit: 1000,
      rollback: 'Restore the database and object-storage backup captured before pruning.',
    };
  },
};

// --- v0.36 Phase 2: search_by_image (image-as-query) ---

const search_by_image: Operation = {
  name: 'search_by_image',
  description:
    'v0.36 cross-modal Phase 2: image-as-query retrieval. Accepts a local path (CLI), data: URI, or http(s):// URL ' +
    '(SSRF-defended). Returns visually-similar image chunks plus any OCR text they carry. Optional `query` text ' +
    'refinement merges via weighted RRF (D13 hybrid intersect). True image→full-text-knowledge requires Phase 3 ' +
    '(`gbrain reindex --multimodal` + `search.unified_multimodal: true`).',
  params: {
    image_path: { type: 'string', description: 'Absolute path to image (local CLI callers only — rejected for remote MCP per D18).' },
    image_url: { type: 'string', description: 'http(s):// URL to image. SSRF-defended; max 3 redirect hops; 10MB cap.' },
    image_data: { type: 'string', description: 'Base64-encoded image bytes (preferred for remote MCP callers). PNG/JPEG/WebP only.' },
    image_mime: { type: 'string', description: 'Optional MIME hint when ambiguous. Magic-byte sniff is authoritative.' },
    query: { type: 'string', description: 'Optional text refinement; runs hybrid intersect via D13 weighted RRF.' },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
  },
  scope: 'read',
  // NOT localOnly: remote MCP callers can pass image_url or image_data
  // (subject to D18 image_path ban + D12 size cap + D23-#6 spend cap).
  handler: async (ctx, p) => {
    const imagePath = p.image_path as string | undefined;
    const imageUrl = p.image_url as string | undefined;
    const imageData = p.image_data as string | undefined;
    const imageMime = (p.image_mime as string) || undefined;
    const queryRefinement = p.query as string | undefined;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;

    // D18 P0 — remote callers cannot pass image_path. Rejecting at handler
    // entry, before any file I/O fires. validateParams catches it too at the
    // dispatch layer; this is defense-in-depth.
    if (ctx.remote === true && imagePath) {
      throw new Error(
        'permission_denied: image_path is not permitted for remote callers (D18). ' +
        'Use image_url or image_data instead.',
      );
    }

    if (!imagePath && !imageUrl && !imageData) {
      throw new Error('search_by_image requires one of: image_path, image_url, image_data');
    }
    if ([imagePath, imageUrl, imageData].filter(Boolean).length > 1) {
      throw new Error('search_by_image accepts only one of: image_path, image_url, image_data');
    }

    // D23-#6 — remote OAuth clients are charged through the durable
    // reserve-then-settle ledger below. Local CLI callers bypass the cap
    // (clientId="") because they use their own provider credentials.
    const clientId = (ctx.remote === true ? (ctx.auth?.clientId ?? '') : '');

    // Resolve image bytes via the SSRF-defended loader. For remote callers,
    // tighter byte cap.
    const remoteCap = await getRemoteMaxBytes(ctx.engine);
    const localCap = await getLocalMaxBytes(ctx.engine);
    const cap = ctx.remote === true ? remoteCap : localCap;
    const { loadImageInput } = await import('../search/image-loader.ts');
    const loaded = await loadImageInput(
      (imagePath ?? imageUrl ?? `data:${imageMime ?? 'image/png'};base64,${imageData}`)!,
      { maxBytes: cap },
    );

    // Resolve source-scope through the single trust+grant resolver. Pre-fix
    // this branch computed resolvedSourceId then spread sourceScopeOpts(ctx)
    // after it (double-application: the spread silently won, and `__all__`
    // didn't opt out for local callers with ctx.sourceId set). One resolver,
    // one spread — `__all__` spans the brain only for trusted local callers.
    const imageSourceScope = resolveRequestedScope(ctx, sourceIdParam);

    // Reserve immediately before entering the paid search routine. Validation,
    // image loading, and scope resolution happen first so known no-charge
    // failures do not strand reservations. An ambiguous provider failure is
    // settled at this operation's fixed-price upper bound below; pessimistic
    // accounting is safer than reopening daily headroom after the TTL.
    let spendReservationId: string | null = null;
    let estimatedSpendCents = 0;
    if (clientId) {
      const { VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS } = await import('../spend-log.ts');
      const { reserve } = await import('../minions/budget-meter.ts');
      const calls = 1 + (queryRefinement ? 1 : 0);
      estimatedSpendCents = VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS * calls;
      const budgetUsd = await getDailyImageBudgetUsd(ctx.engine);
      const reservation = await reserve(ctx.engine, {
        clientId,
        estimatedCents: estimatedSpendCents,
        capCents: budgetUsd * 100,
        provider: 'voyage',
        model: 'voyage-multimodal-3',
      });
      spendReservationId = reservation.reservationId;
    }

    const { searchByImage } = await import('../search/by-image.ts');
    let results: Awaited<ReturnType<typeof searchByImage>>;
    try {
      results = await searchByImage(
        ctx.engine,
        { base64: loaded.base64, mime: loaded.contentType },
        {
          limit: (p.limit as number) || 20,
          offset: (p.offset as number) || 0,
          query: queryRefinement,
          ...imageSourceScope,
        },
      );
    } catch (providerError) {
      if (spendReservationId) {
        const { settle } = await import('../minions/budget-meter.ts');
        try {
          await settle(
            ctx.engine,
            spendReservationId,
            estimatedSpendCents,
            'search_by_image_error_pessimistic',
            ctx.auth?.clientName ?? null,
          );
        } catch (accountingError) {
          throw new AggregateError(
            [providerError, accountingError],
            'search_by_image provider call failed and its spend reservation could not be settled',
          );
        }
      }
      throw providerError;
    }

    // Settlement and the spend-log mirror commit in one transaction. A
    // database/accounting failure blocks the response and leaves the pending
    // reservation holding headroom rather than returning an unmetered success.
    if (spendReservationId) {
      const { settle } = await import('../minions/budget-meter.ts');
      await settle(
        ctx.engine,
        spendReservationId,
        estimatedSpendCents,
        'search_by_image',
        ctx.auth?.clientName ?? null,
      );
    }

    return results;
  },
  cliHints: { name: 'search-by-image' },
};

async function getDailyImageBudgetUsd(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.daily_budget_usd_per_client');
    if (v == null) return 5; // default $5
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 5;
  } catch {
    return 5;
  }
}

async function getLocalMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.max_bytes');
    if (v == null) return 10 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

async function getRemoteMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.remote_max_bytes');
    if (v == null) return 2 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024;
  } catch {
    return 2 * 1024 * 1024;
  }
}

export const imageOperations: Operation[] = [put_image, get_image, prune_page_images, search_by_image];
