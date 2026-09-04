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
import { nativeImageResult } from '../native-image-result.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { resolveExcludePrivatePages, isPrivatePage } from '../search/private-visibility.ts';
import { sniffContentType } from '../search/image-loader.ts';
import { isValidSourceId, ALL_SOURCES } from '../source-id.ts';
import { createStorage, type StorageBackend, type StorageConfig } from '../storage.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  enforceClientSlugFence,
  enforceSubagentSlugFence,
  resolveRequestedScope,
  validateFilename,
  validatePageSlug,
} from './context.ts';

const OWNED_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
type NativeImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const IMAGE_EXTENSIONS: Readonly<Record<string, NativeImageMime>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

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

function storageOrThrow(ctx: OperationContext): Promise<StorageBackend> {
  if (!ctx.config.storage) {
    throw new OperationError(
      'storage_error',
      'No storage backend configured — page image bytes cannot be stored or retrieved.',
      'Configure `storage` in your gbrain config (supabase | s3 | local), then retry.',
    );
  }
  return createStorage(ctx.config.storage as StorageConfig);
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
  sourceId: string,
  pageSlug: string,
  sha256: string,
  filename: string,
): string {
  // sourceId, pageSlug, and filename have already passed their canonical
  // validators. Including source + hash prevents the files table's global
  // storage_path uniqueness from colliding across sources and ensures an
  // update never overwrites bytes that an older row may still reference.
  return `images/${sourceId}/${pageSlug}/${sha256}/${filename}`;
}

function imageMetadata(row: FileRow): { storage: string | null; kind: string | null } {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    storage: typeof metadata.storage === 'string' ? metadata.storage : null,
    kind: typeof metadata.kind === 'string' ? metadata.kind : null,
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
  const belongsToPage = row.page_id === page.id || (row.page_id == null && row.page_slug === page.slug);
  if (!belongsToPage || row.source_id !== sourceId) return null;
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
    if (!target.ok || !plainLegacyImageRef(row.storage_path)) {
      throw new OperationError('not_found', 'Git-backed image is unavailable');
    }
    const imagePath = resolve(target.writeRoot, row.storage_path);
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
    let present = false;
    try {
      present = await storage.exists(row.storage_path);
    } catch (err) {
      throw new OperationError('storage_error', `Storage probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!present) throw new OperationError('not_found', 'Image metadata exists but its stored bytes are missing');
    try {
      bytes = await storage.download(row.storage_path);
    } catch (err) {
      throw new OperationError('storage_error', `Image download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { mimeType, sha256 } = validateStoredImage(row, bytes);
  return { bytes, mimeType, sha256, storagePath: row.storage_path };
}

const put_image: Operation = {
  name: 'put_image',
  description: 'Store a PNG, JPEG, or WebP page image through the configured files backend. Returns an opaque storage reference for get_image; identical retries are no-ops.',
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
    const storagePath = contentAddressedImagePath(sourceId, pageSlug, sha256, filename);
    const prior = (await ctx.engine.listFilesForPage(page.id))
      .filter(row => row.source_id === sourceId && row.filename === filename && imageMetadata(row).kind === 'page_image');
    const exact = prior.find(row => normalizeStoredHash(row.content_hash) === sha256);

    if (ctx.dryRun) {
      return {
        status: 'dry_run', source_id: sourceId, page_slug: pageSlug, filename,
        storage_path: storagePath, image_ref: storagePath, alt_text: altText,
        mime_type: mimeType, size_bytes: bytes.length, sha256,
      };
    }

    const storage = await storageOrThrow(ctx);
    if (exact) {
      let present = false;
      try { present = await storage.exists(exact.storage_path); } catch { /* upload below repairs uncertainty */ }
      const recordedAlt = typeof exact.metadata?.alt_text === 'string' ? exact.metadata.alt_text : exact.filename;
      if (present && recordedAlt === altText) {
        return {
          status: 'unchanged', source_id: sourceId, page_slug: pageSlug, filename,
          storage_path: exact.storage_path, image_ref: exact.storage_path, alt_text: altText,
          mime_type: mimeType, size_bytes: bytes.length, sha256,
        };
      }
      if (present) {
        await ctx.engine.upsertFile({
          source_id: sourceId,
          page_slug: pageSlug,
          page_id: page.id,
          filename,
          storage_path: exact.storage_path,
          mime_type: mimeType,
          size_bytes: bytes.length,
          content_hash: sha256,
          metadata: { storage: 'backend', kind: 'page_image', alt_text: altText },
        });
        return {
          status: 'updated', source_id: sourceId, page_slug: pageSlug, filename,
          storage_path: exact.storage_path, image_ref: exact.storage_path, alt_text: altText,
          mime_type: mimeType, size_bytes: bytes.length, sha256,
        };
      }
    }

    try {
      await storage.upload(storagePath, bytes, mimeType);
    } catch (err) {
      throw new OperationError('storage_error', `Image upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await ctx.engine.upsertFile({
        source_id: sourceId,
        page_slug: pageSlug,
        page_id: page.id,
        filename,
        storage_path: storagePath,
        mime_type: mimeType,
        size_bytes: bytes.length,
        content_hash: sha256,
        metadata: { storage: 'backend', kind: 'page_image', alt_text: altText },
      });
    } catch (err) {
      // Content-addressed keys are immutable. Keep a possible orphan instead
      // of deleting bytes another concurrent identical request may now own.
      throw new OperationError('database_error', `Image metadata write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      status: prior.length > 0 ? 'updated' : 'created',
      source_id: sourceId,
      page_slug: pageSlug,
      filename,
      storage_path: storagePath,
      image_ref: storagePath,
      alt_text: altText,
      mime_type: mimeType,
      size_bytes: bytes.length,
      sha256,
    };
  },
};

const get_image: Operation = {
  name: 'get_image',
  description: 'Return a page-owned image as a native MCP image content block. Reads the files backend first and supports only page-referenced legacy repository images as a read-only fallback.',
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

export const imageOperations: Operation[] = [put_image, get_image, search_by_image];
