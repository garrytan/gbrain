import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine, FileRow, SourceRow } from '../core/engine.ts';
import { getImageOcrModel, IMAGE_OCR_PROMPT_VERSION } from '../core/ai/gateway.ts';
import { assertOcrBudgetCapacity, inspectOcrBudgetCapacity, runOcrGated, type OcrBudgetCapacity, type OcrGatedResult } from '../core/import-file.ts';
import { isPathContained } from '../core/path-confine.ts';
import { assertValidSourceId } from '../core/source-id.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import { sanitizeText } from '../core/batch-rows.ts';

const MANIFEST_VERSION = 1;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SHA256_RE = /^(?:sha256:)?([a-f0-9]{64})$/i;

export interface FileOcrManifestRow {
  page_id: number;
  page_slug: string;
  file_id: number;
  storage_path: string;
  content_hash: string;
  size_bytes: number;
}

export interface FileOcrManifest {
  version: 1;
  source_id: string;
  model: string;
  prompt_version: string;
  rows: FileOcrManifestRow[];
}

export type FileOcrRowStatus = 'planned' | 'applied' | 'noop';

export interface FileOcrReceiptRow {
  file_id: number;
  canonical_file_id: number;
  page_id: number;
  status: FileOcrRowStatus;
  derived_chunk_index: number;
  source_content_hash: string;
  text_sha256?: string;
}

export interface FileOcrReceipt {
  version: 1;
  mode: 'dry-run' | 'apply';
  source_id: string;
  manifest_sha256: string;
  model: string;
  prompt_version: string;
  status: 'planned' | 'applied' | 'noop';
  counts: Record<FileOcrRowStatus, number>;
  rows: FileOcrReceiptRow[];
  ocr_budget: OcrBudgetCapacity;
}

interface FileOcrDeps {
  runOcrGated?: (engine: BrainEngine, bytes: Buffer, mime: string, expectedModel?: string) => Promise<OcrGatedResult>;
  getImageOcrModel?: typeof getImageOcrModel;
  now?: () => Date;
}

interface PreparedRow {
  manifest: FileOcrManifestRow;
  file: FileRow;
  source: SourceRow;
  mime: string;
  sourceHash: string;
  signature: string;
  canonicalFileId: number;
  priorReceipt: Record<string, unknown> | null;
  priorChunkText: string | null;
  priorChunkTextHash: string | null;
  priorChunkExists: boolean;
  priorChunkShapeValid: boolean;
  ownChunkExists: boolean;
  preflightNoop: boolean;
  extractedText?: string;
  textHash?: string;
}

interface LockedFile {
  file_id: number;
  content_hash: string;
  size_bytes: unknown;
  filename: string;
  storage_path: string;
  metadata: Record<string, unknown>;
}

interface LockedPage {
  page_id: number;
  slug: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSha256(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a SHA-256 string`);
  const match = value.match(SHA256_RE);
  if (!match) throw new Error(`${label} must contain exactly 64 hexadecimal SHA-256 characters`);
  return match[1].toLowerCase();
}

function normalizeRegisteredByteSize(value: unknown, label: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} must be a nonnegative safe integer`);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return Number(value);
}

function parseManifest(raw: string): FileOcrManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('files ocr manifest must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('files ocr manifest must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['model', 'prompt_version', 'rows', 'source_id', 'version'])) {
    throw new Error('files ocr manifest must contain only version, source_id, model, prompt_version, and rows');
  }
  if (obj.version !== MANIFEST_VERSION) throw new Error(`files ocr manifest version must be ${MANIFEST_VERSION}`);
  assertValidSourceId(obj.source_id);
  if (typeof obj.model !== 'string' || obj.model.length === 0) throw new Error('files ocr manifest model must be non-empty');
  if (obj.prompt_version !== IMAGE_OCR_PROMPT_VERSION) {
    throw new Error(`files ocr manifest prompt_version must be ${IMAGE_OCR_PROMPT_VERSION}`);
  }
  if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
    throw new Error('files ocr manifest rows must be a non-empty array');
  }

  const seenFileIds = new Set<number>();
  const seenStoragePaths = new Set<string>();
  const rows = obj.rows.map((rawRow, index): FileOcrManifestRow => {
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      throw new Error(`files ocr manifest row ${index} must be an object`);
    }
    const row = rawRow as Record<string, unknown>;
    const rowKeys = Object.keys(row).sort();
    const expectedKeys = ['content_hash', 'file_id', 'page_id', 'page_slug', 'size_bytes', 'storage_path'];
    if (JSON.stringify(rowKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`files ocr manifest row ${index} must contain exactly ${expectedKeys.join(', ')}`);
    }
    if (!Number.isSafeInteger(row.file_id) || Number(row.file_id) <= 0 || Number(row.file_id) > 2_147_483_647) {
      throw new Error(`files ocr manifest row ${index} file_id must be a positive 32-bit integer`);
    }
    if (!Number.isSafeInteger(row.page_id) || Number(row.page_id) <= 0) {
      throw new Error(`files ocr manifest row ${index} page_id must be a positive integer`);
    }
    if (!Number.isSafeInteger(row.size_bytes) || Number(row.size_bytes) <= 0) {
      throw new Error(`files ocr manifest row ${index} size_bytes must be a positive safe integer`);
    }
    if (Number(row.size_bytes) > MAX_IMAGE_BYTES) {
      throw new Error(`files ocr manifest row ${index} size_bytes exceeds ${MAX_IMAGE_BYTES}`);
    }
    if (typeof row.page_slug !== 'string' || row.page_slug.length === 0) {
      throw new Error(`files ocr manifest row ${index} page_slug must be non-empty`);
    }
    if (typeof row.storage_path !== 'string' || row.storage_path.length === 0) {
      throw new Error(`files ocr manifest row ${index} storage_path must be non-empty`);
    }
    const fileId = Number(row.file_id);
    if (seenFileIds.has(fileId)) throw new Error(`files ocr manifest contains duplicate file_id ${fileId}`);
    if (seenStoragePaths.has(row.storage_path)) throw new Error('files ocr manifest contains a duplicate storage_path');
    seenFileIds.add(fileId);
    seenStoragePaths.add(row.storage_path);
    return {
      page_id: Number(row.page_id),
      page_slug: row.page_slug,
      file_id: fileId,
      storage_path: row.storage_path,
      content_hash: normalizeSha256(row.content_hash, `files ocr manifest row ${index} content_hash`),
      size_bytes: Number(row.size_bytes),
    };
  });
  return { version: 1, source_id: obj.source_id, model: obj.model, prompt_version: obj.prompt_version, rows };
}

function containsReadwiseLineage(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return /\breadwise\b/i.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsReadwiseLineage(item, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /readwise/i.test(key) || containsReadwiseLineage(nested, seen));
}

function assertNotReadwise(
  source: Pick<SourceRow, 'id' | 'name' | 'config' | 'local_path'>,
  page: { slug: string; title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> },
  file: Pick<FileRow, 'metadata' | 'filename' | 'storage_path'> & { id?: number; file_id?: number },
): void {
  if (
    containsReadwiseLineage(source.id) ||
    containsReadwiseLineage(source.name) ||
    containsReadwiseLineage(source.config) ||
    containsReadwiseLineage(source.local_path) ||
    containsReadwiseLineage(page) ||
    containsReadwiseLineage(file.metadata) ||
    containsReadwiseLineage(file.filename) ||
    containsReadwiseLineage(file.storage_path)
  ) {
    throw new Error(`files ocr excludes Readwise lineage (file_id=${file.id ?? file.file_id ?? 'unknown'})`);
  }
}

function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('files ocr accepts only PNG, JPEG, or WebP magic bytes');
}

function candidateLocalPaths(
  source: Pick<SourceRow, 'local_path'>,
  file: Pick<FileRow, 'metadata' | 'storage_path'>,
): string[] {
  if (!source.local_path) return [];
  const metadata = file.metadata ?? {};
  const values = [metadata.source_asset, metadata.original_path, metadata.local_path, metadata.path, file.storage_path];
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const candidate = isAbsolute(value) ? value : join(source.local_path, value);
    if (!paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

async function assertSymlinkFreeContainedPath(root: string, candidate: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`files ocr local path escapes source root (file_id path rejected)`);
  }
  let cursor = absoluteRoot;
  const segments = rel ? rel.split(sep) : [];
  for (const segment of ['', ...segments]) {
    if (segment) cursor = join(cursor, segment);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('files ocr rejects symlinks in the local asset path');
  }
  if (!isPathContained(absoluteCandidate, absoluteRoot)) {
    throw new Error('files ocr local asset failed realpath containment');
  }
}

async function loadImageBytes(
  source: Pick<SourceRow, 'local_path'>,
  file: Pick<FileRow, 'id' | 'metadata' | 'storage_path'>,
): Promise<{ bytes: Buffer; mime: string }> {
  for (const candidate of candidateLocalPaths(source, file)) {
    const stat = await lstat(candidate).catch(() => null);
    if (!stat) continue;
    if (!source.local_path) continue;
    await assertSymlinkFreeContainedPath(source.local_path, candidate);
    if (!stat.isFile()) throw new Error(`files ocr local asset is not a regular file (file_id=${file.id})`);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`files ocr image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const bytes = await readFile(candidate);
    return { bytes, mime: sniffImageMime(bytes) };
  }

  throw new Error(`files ocr requires a symlink-free local source-root asset for file_id=${file.id}`);
}

async function loadVerifiedImageBytes(
  source: Pick<SourceRow, 'local_path'>,
  file: Pick<FileRow, 'id' | 'metadata' | 'storage_path'>,
  row: FileOcrManifestRow,
  phase = '',
): Promise<{ bytes: Buffer; mime: string }> {
  const loaded = await loadImageBytes(source, file);
  const prefix = phase ? `${phase} ` : '';
  if (loaded.bytes.length !== row.size_bytes) {
    throw new Error(`files ocr ${prefix}byte size mismatch for file_id=${row.file_id}`);
  }
  if (sha256(loaded.bytes) !== row.content_hash) {
    throw new Error(`files ocr ${prefix}byte hash mismatch for file_id=${row.file_id}`);
  }
  return loaded;
}

function receiptFromMetadata(file: FileRow): Record<string, unknown> | null {
  const value = file.metadata?.ocr;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyCounts(): Record<FileOcrRowStatus, number> {
  return { planned: 0, applied: 0, noop: 0 };
}

function summarizeStatus(counts: Record<FileOcrRowStatus, number>, mode: 'dry-run' | 'apply'): FileOcrReceipt['status'] {
  if (mode === 'dry-run') return 'planned';
  return counts.applied > 0 ? 'applied' : 'noop';
}

function matchesIdentity(file: FileRow | null, row: FileOcrManifestRow, sourceId: string): file is FileRow {
  return !!file &&
    file.id === row.file_id &&
    file.source_id === sourceId &&
    file.page_id === row.page_id &&
    file.page_slug === row.page_slug &&
    file.storage_path === row.storage_path &&
    normalizeRegisteredByteSize(file.size_bytes, 'stored file size_bytes') === row.size_bytes &&
    normalizeSha256(file.content_hash, 'stored file content_hash') === row.content_hash;
}

async function prepareRows(
  engine: BrainEngine,
  manifest: FileOcrManifest,
  model: string,
): Promise<PreparedRow[]> {
  const source = (await engine.listAllSources()).find(row => row.id === manifest.source_id);
  if (!source) throw new Error(`files ocr source does not exist: ${manifest.source_id}`);

  const prepared: PreparedRow[] = [];
  for (const row of manifest.rows) {
    const page = await engine.getPage(row.page_slug, { sourceId: manifest.source_id });
    const file = await engine.getFile(manifest.source_id, row.storage_path);
    if (!page || page.id !== row.page_id || !matchesIdentity(file, row, manifest.source_id)) {
      throw new Error(`files ocr manifest identity mismatch for file_id=${row.file_id}`);
    }
    if (!isPlainRecord(file.metadata)) {
      throw new Error(`files ocr refuses non-object metadata for file_id=${row.file_id}`);
    }
    if (!file.mime_type?.startsWith('image/')) {
      throw new Error(`files ocr file_id=${row.file_id} is not registered as an image`);
    }
    assertNotReadwise(source, page, file);
    const loaded = await loadVerifiedImageBytes(source, file, row);
    const sourceHash = row.content_hash;
    const signature = sha256(JSON.stringify({
      version: MANIFEST_VERSION,
      source_content_hash: sourceHash,
      model,
      prompt_version: IMAGE_OCR_PROMPT_VERSION,
    }));
    prepared.push({
      manifest: row,
      file,
      source,
      mime: loaded.mime,
      sourceHash,
      signature,
      canonicalFileId: row.file_id,
      priorReceipt: receiptFromMetadata(file),
      priorChunkText: null,
      priorChunkTextHash: null,
      priorChunkExists: false,
      priorChunkShapeValid: false,
      ownChunkExists: false,
      preflightNoop: false,
    });
  }
  const groups = new Map<string, PreparedRow[]>();
  for (const row of prepared) {
    const key = `${row.manifest.page_id}:${row.sourceHash}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const registered = (await engine.listFilesForPage(group[0].manifest.page_id)).filter(file =>
      file.source_id === manifest.source_id &&
      normalizeSha256(file.content_hash, 'stored file content_hash') === group[0].sourceHash);
    const manifestIds = new Set(group.map(row => row.manifest.file_id));
    const omitted = registered.filter(file => !manifestIds.has(file.id));
    if (omitted.length > 0) {
      throw new Error(`files ocr manifest omits ${omitted.length} same-page duplicate file row(s)`);
    }
    const canonicalFileId = Math.min(...registered.map(file => file.id));
    const page = group[0].manifest;
    const indexes = [...new Set([-canonicalFileId, ...group.map(row => -row.manifest.file_id)])];
    const chunkRows = await engine.executeRaw<{
      chunk_index: number; chunk_text: string; chunk_source: string; modality: string; model: string | null;
    }>(
      `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.modality, cc.model FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.id = $1 AND p.slug = $2 AND p.source_id = $3
         AND cc.chunk_index = ANY($4::int[])`,
      [page.page_id, page.page_slug, manifest.source_id, indexes],
    );
    const canonicalChunk = chunkRows.find(chunk => chunk.chunk_index === -canonicalFileId)?.chunk_text ?? null;
    const canonicalRow = chunkRows.find(chunk => chunk.chunk_index === -canonicalFileId);
    for (const row of group) {
      row.canonicalFileId = canonicalFileId;
      row.priorChunkText = canonicalChunk;
      row.priorChunkTextHash = canonicalChunk === null ? null : sha256(canonicalChunk);
      row.priorChunkExists = canonicalRow !== undefined;
      row.priorChunkShapeValid = canonicalRow?.chunk_source === 'image_asset' &&
        canonicalRow.modality === 'text' && canonicalRow.model === model;
      row.ownChunkExists = chunkRows.some(chunk => chunk.chunk_index === -row.manifest.file_id);
    }
  }
  for (const row of prepared) row.preflightNoop = isNoop(row);
  return prepared;
}

function isNoop(row: PreparedRow): boolean {
  const receipt = row.priorReceipt;
  if (!receipt || receipt.signature !== row.signature) return false;
  if (receipt.schema !== 'gbrain.ocr-derived-text' || receipt.version !== 1) return false;
  if (receipt.canonical_file_id !== row.canonicalFileId) return false;
  if (receipt.derived_chunk_index !== -row.canonicalFileId) return false;
  if (row.manifest.file_id !== row.canonicalFileId && row.ownChunkExists) return false;
  if (receipt.status === 'empty') return !row.priorChunkExists;
  return receipt.status === 'succeeded' &&
    row.priorChunkShapeValid &&
    typeof receipt.text_sha256 === 'string' &&
    receipt.text_sha256 === row.priorChunkTextHash;
}

function cachedTextRow(prepared: PreparedRow[], group: PreparedRow[]): PreparedRow | undefined {
  return prepared.find(candidate =>
    candidate.manifest.page_id === group[0].manifest.page_id &&
    candidate.sourceHash === group[0].sourceHash &&
    candidate.priorChunkText !== null &&
    candidate.priorReceipt?.signature === candidate.signature &&
    candidate.priorReceipt?.text_sha256 === candidate.priorChunkTextHash);
}

async function applyPreparedRows(
  engine: BrainEngine,
  sourceId: string,
  rows: PreparedRow[],
  model: string,
  now: Date,
): Promise<FileOcrReceiptRow[]> {
  return engine.transaction(async tx => {
    const sourceRows = await tx.executeRaw<{ id: string; name: string; config: Record<string, unknown>; local_path: string | null }>(
      `SELECT id, name, config, local_path FROM sources WHERE id = $1 FOR UPDATE`, [sourceId],
    );
    if (sourceRows.length !== 1) throw new Error(`files ocr apply source identity mismatch: ${sourceId}`);
    const lockedPages = new Map<number, LockedPage>();
    const pageRows = [...new Map(rows.map(row => [row.manifest.page_id, row])).values()]
      .sort((a, b) => a.manifest.page_id - b.manifest.page_id);
    for (const row of pageRows) {
      const live = await tx.executeRaw<LockedPage>(
        `SELECT id AS page_id, slug, title, compiled_truth, timeline, frontmatter FROM pages
          WHERE id = $1 AND slug = $2 AND source_id = $3 AND deleted_at IS NULL FOR UPDATE`,
        [row.manifest.page_id, row.manifest.page_slug, sourceId],
      );
      if (live.length !== 1) throw new Error(`files ocr apply page identity mismatch for page_id=${row.manifest.page_id}`);
      lockedPages.set(row.manifest.page_id, live[0]);
    }
    const locked = new Map<number, LockedFile>();
    for (const row of [...rows].sort((a, b) => a.manifest.file_id - b.manifest.file_id)) {
      const live = await tx.executeRaw<LockedFile>(
        `SELECT id AS file_id, content_hash, size_bytes, filename, storage_path, metadata FROM files
          WHERE id = $1 AND source_id = $2 AND page_id = $3 AND page_slug = $4 AND storage_path = $5 FOR UPDATE`,
        [row.manifest.file_id, sourceId, row.manifest.page_id, row.manifest.page_slug, row.manifest.storage_path],
      );
      if (live.length !== 1 || normalizeRegisteredByteSize(live[0].size_bytes, 'stored file size_bytes') !== row.manifest.size_bytes ||
        normalizeSha256(live[0].content_hash, 'stored file content_hash') !== row.manifest.content_hash) {
        throw new Error(`files ocr apply identity mismatch for file_id=${row.manifest.file_id}`);
      }
      if (!isPlainRecord(live[0].metadata)) {
        throw new Error(`files ocr apply file metadata is not an object for file_id=${row.manifest.file_id}`);
      }
      locked.set(row.manifest.file_id, live[0]);
    }
    for (const row of rows) {
      const page = lockedPages.get(row.manifest.page_id)!;
      const file = locked.get(row.manifest.file_id)!;
      assertNotReadwise(sourceRows[0], page, file);
      const loaded = await loadVerifiedImageBytes(sourceRows[0], {
        id: file.file_id,
        metadata: file.metadata,
        storage_path: file.storage_path,
      }, row.manifest, 'apply-time');
      if (loaded.mime !== row.mime) {
        throw new Error(`files ocr apply-time MIME mismatch for file_id=${row.manifest.file_id}`);
      }
    }

    const groups = new Map<string, PreparedRow[]>();
    for (const row of rows) {
      const key = `${row.manifest.page_id}:${row.sourceHash}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const anchor = group[0];
      const members = await tx.executeRaw<{ id: number }>(
        `SELECT id FROM files
          WHERE source_id = $1 AND page_id = $2 AND page_slug = $3
            AND regexp_replace(lower(content_hash), '^sha256:', '') = $4
          ORDER BY id FOR UPDATE`,
        [sourceId, anchor.manifest.page_id, anchor.manifest.page_slug, anchor.sourceHash],
      );
      const expected = group.map(row => row.manifest.file_id).sort((a, b) => a - b);
      const actual = members.map(member => member.id);
      if (JSON.stringify(actual) !== JSON.stringify(expected) || actual[0] !== anchor.canonicalFileId) {
        throw new Error(`files ocr apply duplicate membership drift for page_id=${anchor.manifest.page_id}`);
      }
    }

    for (const row of rows.filter(candidate => candidate.preflightNoop)) {
      const file = locked.get(row.manifest.file_id)!;
      const receiptValue = file.metadata.ocr;
      const receipt = isPlainRecord(receiptValue) ? receiptValue : null;
      const chunkIndex = -row.canonicalFileId;
      const chunk = await tx.executeRaw<{ chunk_text: string; chunk_source: string; modality: string; model: string | null }>(
        `SELECT chunk_text, chunk_source, modality, model FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
        [row.manifest.page_id, chunkIndex],
      );
      const chunkExists = chunk.length > 0;
      const chunkHash = chunkExists ? sha256(chunk[0].chunk_text) : null;
      const shapeValid = chunk[0]?.chunk_source === 'image_asset' && chunk[0]?.modality === 'text' && chunk[0]?.model === model;
      const ownExtra = row.manifest.file_id !== row.canonicalFileId &&
        (await tx.executeRaw(`SELECT 1 FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
          [row.manifest.page_id, -row.manifest.file_id])).length > 0;
      const stillNoop = receipt?.signature === row.signature && receipt.schema === 'gbrain.ocr-derived-text' && receipt.version === 1 &&
        receipt.canonical_file_id === row.canonicalFileId && receipt.derived_chunk_index === chunkIndex && !ownExtra &&
        ((receipt.status === 'empty' && !chunkExists) ||
          (receipt.status === 'succeeded' && shapeValid && receipt.text_sha256 === chunkHash));
      if (!stillNoop) throw new Error(`files ocr apply preflight-noop drift for file_id=${row.manifest.file_id}`);
    }

    const results: FileOcrReceiptRow[] = [];
    for (const row of rows) {
      if (row.preflightNoop) {
        results.push({
          file_id: row.manifest.file_id,
          canonical_file_id: row.canonicalFileId,
          page_id: row.manifest.page_id,
          status: 'noop',
          derived_chunk_index: -row.canonicalFileId,
          source_content_hash: row.sourceHash,
          ...(typeof row.priorReceipt?.text_sha256 === 'string' ? { text_sha256: row.priorReceipt.text_sha256 } : {}),
        });
        continue;
      }
      const chunkIndex = -row.canonicalFileId;
      const text = row.extractedText?.trim() ?? '';
      const textHash = row.textHash ?? sha256(text);
      const current = await tx.getFile(sourceId, row.manifest.storage_path);
      const currentReceipt = current ? receiptFromMetadata(current) : null;
      const currentChunk = await tx.executeRaw<{ chunk_text: string; chunk_source: string; modality: string; model: string | null }>(
        `SELECT chunk_text, chunk_source, modality, model FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
        [row.manifest.page_id, chunkIndex],
      );
      const currentChunkExists = currentChunk.length > 0;
      const currentChunkHash = currentChunkExists ? sha256(currentChunk[0].chunk_text) : null;
      const currentChunkShapeValid = currentChunk[0]?.chunk_source === 'image_asset' &&
        currentChunk[0]?.modality === 'text' && currentChunk[0]?.model === model;
      if (
        currentReceipt?.signature === row.signature &&
        currentReceipt.schema === 'gbrain.ocr-derived-text' && currentReceipt.version === 1 &&
        currentReceipt.canonical_file_id === row.canonicalFileId &&
        currentReceipt.derived_chunk_index === chunkIndex &&
        ((currentReceipt.status === 'empty' && !currentChunkExists) ||
          (currentReceipt.status === 'succeeded' && currentChunkShapeValid && currentReceipt.text_sha256 === currentChunkHash)) &&
        !(row.manifest.file_id !== row.canonicalFileId &&
          (await tx.executeRaw(`SELECT 1 FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
            [row.manifest.page_id, -row.manifest.file_id])).length > 0)
      ) {
        results.push({
          file_id: row.manifest.file_id,
          canonical_file_id: row.canonicalFileId,
          page_id: row.manifest.page_id,
          status: 'noop',
          derived_chunk_index: chunkIndex,
          source_content_hash: row.sourceHash,
          ...(typeof currentReceipt.text_sha256 === 'string' ? { text_sha256: currentReceipt.text_sha256 } : {}),
        });
        continue;
      }

      if (row.manifest.file_id !== row.canonicalFileId) {
        await tx.executeRaw(
          `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
          [row.manifest.page_id, -row.manifest.file_id],
        );
      } else if (text) {
        // Delete+insert deliberately clears every embedding column on changed
        // OCR text without interpolating a registry-selected identifier.
        await tx.executeRaw(
          `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
          [row.manifest.page_id, chunkIndex],
        );
        await tx.executeRaw(
          `INSERT INTO content_chunks
             (page_id, chunk_index, chunk_text, chunk_source, model, token_count, modality)
           VALUES ($1, $2, $3, 'image_asset', $4, $5, 'text')`,
          [row.manifest.page_id, chunkIndex, text, model, Math.ceil(text.length / 4)],
        );
      } else {
        await tx.executeRaw(
          `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index = $2`,
          [row.manifest.page_id, chunkIndex],
        );
      }

      const ocrReceipt = {
        schema: 'gbrain.ocr-derived-text',
        version: 1,
        status: text ? 'succeeded' : 'empty',
        source_content_hash: row.sourceHash,
        source_byte_count: row.manifest.size_bytes,
        sniffed_mime: row.mime,
        text_sha256: textHash,
        derived_chunk_index: chunkIndex,
        model,
        prompt_version: IMAGE_OCR_PROMPT_VERSION,
        signature: row.signature,
        canonical_file_id: row.canonicalFileId,
        first_extracted_at: typeof currentReceipt?.first_extracted_at === 'string'
          ? currentReceipt.first_extracted_at
          : now.toISOString(),
      };
      const updated = await executeRawJsonb<{ id: number }>(
        tx,
        `UPDATE files
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ocr}', $6::jsonb, true)
         WHERE id = $1 AND source_id = $2 AND page_id = $3 AND page_slug = $4 AND content_hash = $5
         RETURNING id`,
        [row.manifest.file_id, sourceId, row.manifest.page_id, row.manifest.page_slug, locked.get(row.manifest.file_id)!.content_hash],
        [ocrReceipt],
      );
      if (updated.length !== 1) {
        throw new Error(`files ocr identity changed during apply for file_id=${row.manifest.file_id}`);
      }
      results.push({
        file_id: row.manifest.file_id,
        canonical_file_id: row.canonicalFileId,
        page_id: row.manifest.page_id,
        status: 'applied',
        derived_chunk_index: chunkIndex,
        source_content_hash: row.sourceHash,
        text_sha256: textHash,
      });
    }
    return results;
  });
}

export async function runFilesOcr(
  engine: BrainEngine,
  args: string[],
  deps: FileOcrDeps = {},
): Promise<FileOcrReceipt> {
  if (args.includes('--all')) throw new Error('files ocr does not support --all');
  let manifestPath: string | null = null;
  let expectedManifestHash: string | null = null;
  let applying = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--manifest', '--manifest-sha256', '--apply'].includes(flag)) {
      throw new Error(`files ocr unknown argument: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`files ocr duplicate flag: ${flag}`);
    seen.add(flag);
    if (flag === '--apply') {
      applying = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`files ocr missing value for ${flag}`);
    if (flag === '--manifest') manifestPath = value;
    else expectedManifestHash = normalizeSha256(value, '--manifest-sha256');
  }
  if (!manifestPath || !expectedManifestHash) {
    throw new Error('Usage: gbrain files ocr --manifest <path> --manifest-sha256 <hex> [--apply]');
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestHash = sha256(manifestBytes);
  if (manifestHash !== expectedManifestHash) throw new Error('files ocr manifest SHA-256 mismatch');
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  const model = (deps.getImageOcrModel ?? getImageOcrModel)();
  if (model !== manifest.model) throw new Error(`files ocr runtime model does not match manifest model`);
  const mode = applying ? 'apply' : 'dry-run';
  const prepared = await prepareRows(engine, manifest, model);

  if (mode === 'dry-run') {
    const pendingGroups = new Map<string, PreparedRow[]>();
    for (const row of prepared.filter(candidate => !isNoop(candidate))) {
      const key = `${row.manifest.page_id}:${row.sourceHash}`;
      pendingGroups.set(key, [...(pendingGroups.get(key) ?? []), row]);
    }
    const providerCount = [...pendingGroups.values()].filter(group => !cachedTextRow(prepared, group)).length;
    const ocrBudget = await inspectOcrBudgetCapacity(engine, providerCount);
    const rows = prepared.map(row => ({
      file_id: row.manifest.file_id,
      canonical_file_id: row.canonicalFileId,
      page_id: row.manifest.page_id,
      status: isNoop(row) ? 'noop' as const : 'planned' as const,
      derived_chunk_index: -row.canonicalFileId,
      source_content_hash: row.sourceHash,
    }));
    const counts = emptyCounts();
    for (const row of rows) counts[row.status]++;
    const receipt: FileOcrReceipt = {
      version: 1,
      mode,
      source_id: manifest.source_id,
      manifest_sha256: manifestHash,
      model,
      prompt_version: IMAGE_OCR_PROMPT_VERSION,
      status: counts.planned > 0 ? 'planned' : 'noop',
      counts,
      rows,
      ocr_budget: ocrBudget,
    };
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  }

  const pending = prepared.filter(row => !isNoop(row));
  const runOcr = deps.runOcrGated ?? runOcrGated;
  // All provider work finishes before the transaction. A provider failure can
  // therefore never leave a half-applied manifest.
  const pendingGroups = new Map<string, PreparedRow[]>();
  for (const row of pending) {
    const key = `${row.manifest.page_id}:${row.sourceHash}`;
    const group = pendingGroups.get(key) ?? [];
    group.push(row);
    pendingGroups.set(key, group);
  }
  const providerGroups: PreparedRow[][] = [];
  for (const group of pendingGroups.values()) {
    const cached = cachedTextRow(prepared, group);
    if (cached?.priorChunkText !== null && cached?.priorChunkText !== undefined) {
      for (const row of group) {
        row.extractedText = cached.priorChunkText;
        row.textHash = cached.priorChunkTextHash ?? sha256(cached.priorChunkText);
      }
      continue;
    }
    providerGroups.push(group);
  }
  const ocrBudget = await assertOcrBudgetCapacity(engine, providerGroups.length);
  for (const group of providerGroups) {
    const row = group[0];
    const loaded = await loadVerifiedImageBytes(row.source, row.file, row.manifest, 'provider-time');
    let result: OcrGatedResult;
    try {
      result = await runOcr(engine, loaded.bytes, loaded.mime, model);
    } catch {
      throw new Error(`files ocr provider failed for file_id=${row.manifest.file_id}`);
    }
    if (result.status === 'succeeded') {
      row.extractedText = sanitizeText(result.text).trim();
      if (containsReadwiseLineage(row.extractedText)) {
        throw new Error(`files ocr excludes Readwise lineage found in extracted text for file_id=${row.manifest.file_id}`);
      }
    } else if (result.status === 'empty') {
      row.extractedText = '';
    } else {
      throw new Error(`files ocr aborted before apply: ${result.status}`);
    }
    row.textHash = sha256(row.extractedText);
    for (const duplicate of group.slice(1)) {
      duplicate.extractedText = row.extractedText;
      duplicate.textHash = row.textHash;
    }
  }

  const applied = await applyPreparedRows(
    engine,
    manifest.source_id,
    prepared,
    model,
    (deps.now ?? (() => new Date()))(),
  );
  const appliedById = new Map(applied.map(row => [row.file_id, row]));
  const rows: FileOcrReceiptRow[] = prepared.map(row => appliedById.get(row.manifest.file_id) ?? ({
    file_id: row.manifest.file_id,
    canonical_file_id: row.canonicalFileId,
    page_id: row.manifest.page_id,
    status: 'noop',
    derived_chunk_index: -row.canonicalFileId,
    source_content_hash: row.sourceHash,
    ...(typeof row.priorReceipt?.text_sha256 === 'string' ? { text_sha256: row.priorReceipt.text_sha256 } : {}),
  }));
  const counts = emptyCounts();
  for (const row of rows) counts[row.status]++;
  const receipt: FileOcrReceipt = {
    version: 1,
    mode,
    source_id: manifest.source_id,
    manifest_sha256: manifestHash,
    model,
    prompt_version: IMAGE_OCR_PROMPT_VERSION,
    status: summarizeStatus(counts, mode),
    counts,
    rows,
    ocr_budget: ocrBudget,
  };
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}
