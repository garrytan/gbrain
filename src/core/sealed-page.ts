import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import type { ChunkInput, PageInput } from './types.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { validateSlug } from './utils.ts';
import { serverBuildCommit } from './build-provenance.ts';

export { __setServerBuildCommitForTests } from './build-provenance.ts';

export const CREATE_PAGE_PROTOCOL_VERSION = 'gbrain.create_page.v1';
const SEALED_PAGE_KIND = 'markdown';
const SEALED_SOURCE_KIND = 'mcp:create_page';
const SEALED_INGESTED_VIA = 'mcp:create_page';
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA1_RE = /^[a-f0-9]{40}$/;

export interface CanonicalPageProjection {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
}

export interface SealedPageReceipt {
  protocol_version: string;
  operation_id: string;
  source_id: string;
  slug: string;
  request_sha256: string;
  page_id: number;
  page_revision: number;
  canonical_page_sha256: string;
  canonical_projection: CanonicalPageProjection;
  committed_at: string;
  server_build_commit: string;
  receipt_id: string;
}

export interface PreparedSealedPage {
  operationId: string;
  sourceId: string;
  requestSha256: string;
  projection: CanonicalPageProjection;
  canonicalPageSha256: string;
  page: PageInput;
  chunks: ChunkInput[];
}

export class SealedPageError extends Error {
  constructor(public readonly code: 'idempotency_conflict' | 'page_conflict', message: string) {
    super(message);
    this.name = 'SealedPageError';
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalCreatePageRequestSha256(slug: string, content: string): string {
  return sha256(JSON.stringify({ slug: validateSlug(slug), content }));
}

export function assertExactSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
}

export function prepareSealedPage(input: {
  operationId: string;
  sourceId: string;
  slug: string;
  content: string;
  requestSha256: string;
}): PreparedSealedPage {
  assertExactSha256(input.operationId, 'operation_id');
  assertExactSha256(input.requestSha256, 'request_sha256');
  if (input.content.trim() === '') throw new TypeError('create_page content must not be empty');

  const slug = validateSlug(input.slug);
  const expectedRequestSha256 = canonicalCreatePageRequestSha256(slug, input.content);
  if (expectedRequestSha256 !== input.requestSha256) {
    throw new TypeError('request_sha256 does not match the canonical create_page request');
  }

  const parsed = parseMarkdown(input.content, `${slug}.md`);
  if (parsed.timeline?.trim()) {
    throw new TypeError('create_page timeline must be empty because it is outside canonical_projection');
  }
  const projection: CanonicalPageProjection = {
    slug,
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    frontmatter: sortJson(parsed.frontmatter ?? {}) as Record<string, unknown>,
  };
  const canonicalPageSha256 = sha256(canonicalJson(projection));
  const chunks: ChunkInput[] = [];
  if (parsed.compiled_truth.trim()) {
    for (const chunk of chunkText(parsed.compiled_truth)) {
      chunks.push({ chunk_index: chunks.length, chunk_text: chunk.text, chunk_source: 'compiled_truth' });
    }
  }


  return {
    operationId: input.operationId,
    sourceId: input.sourceId,
    requestSha256: input.requestSha256,
    projection,
    canonicalPageSha256,
    page: {
      type: parsed.type,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline ?? '',
      frontmatter: projection.frontmatter,
      content_hash: canonicalPageSha256,
      page_kind: SEALED_PAGE_KIND,
      source_kind: SEALED_SOURCE_KIND,
      ingested_via: SEALED_INGESTED_VIA,
    },
    chunks,
  };
}

function integrityError(message: string): Error {
  return new Error(`sealed page receipt integrity failure: ${message}`);
}

function exactProjection(value: unknown): CanonicalPageProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw integrityError('canonical_projection must be an object');
  }
  const projection = value as Record<string, unknown>;
  const expectedKeys = ['compiled_truth', 'frontmatter', 'slug', 'title', 'type'];
  const actualKeys = Object.keys(projection).sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
    throw integrityError('canonical_projection has an invalid shape');
  }
  for (const field of ['slug', 'type', 'title', 'compiled_truth'] as const) {
    if (typeof projection[field] !== 'string') {
      throw integrityError(`canonical_projection.${field} must be a string`);
    }
  }
  if (!projection.frontmatter || typeof projection.frontmatter !== 'object' || Array.isArray(projection.frontmatter)) {
    throw integrityError('canonical_projection.frontmatter must be an object');
  }
  return projection as unknown as CanonicalPageProjection;
}

function receiptIdFor(receipt: Omit<SealedPageReceipt, 'canonical_projection' | 'receipt_id'>): string {
  return sha256(canonicalJson(receipt));
}

function receiptFromRow(row: Record<string, unknown>): SealedPageReceipt {
  const committed = row.committed_at;
  const committedDate = committed instanceof Date ? committed : new Date(String(committed));
  if (Number.isNaN(committedDate.getTime())) throw integrityError('committed_at is invalid');
  const projection = exactProjection(row.canonical_projection);
  const receipt: SealedPageReceipt = {
    protocol_version: row.protocol_version as string,
    operation_id: row.operation_id as string,
    source_id: row.source_id as string,
    slug: row.slug as string,
    request_sha256: row.request_sha256 as string,
    page_id: Number(row.page_id),
    page_revision: Number(row.page_revision),
    canonical_page_sha256: row.canonical_page_sha256 as string,
    canonical_projection: projection,
    committed_at: committedDate.toISOString(),
    server_build_commit: row.server_build_commit as string,
    receipt_id: row.receipt_id as string,
  };
  if (receipt.protocol_version !== CREATE_PAGE_PROTOCOL_VERSION) throw integrityError('protocol_version is invalid');
  for (const field of ['operation_id', 'request_sha256', 'canonical_page_sha256', 'receipt_id'] as const) {
    try { assertExactSha256(receipt[field], field); }
    catch { throw integrityError(`${field} is invalid`); }
  }
  if (typeof receipt.source_id !== 'string' || typeof receipt.slug !== 'string') {
    throw integrityError('source_id and slug must be strings');
  }
  if (!Number.isSafeInteger(receipt.page_id) || receipt.page_id <= 0) throw integrityError('page_id is invalid');
  if (!Number.isSafeInteger(receipt.page_revision) || receipt.page_revision <= 0) throw integrityError('page_revision is invalid');
  if (typeof receipt.server_build_commit !== 'string' || !GIT_SHA1_RE.test(receipt.server_build_commit)) {
    throw integrityError('server_build_commit is invalid');
  }
  if (projection.slug !== receipt.slug) throw integrityError('projection slug differs from receipt slug');
  if (sha256(canonicalJson(projection)) !== receipt.canonical_page_sha256) {
    throw integrityError('canonical_page_sha256 does not match canonical_projection');
  }
  const expectedReceiptId = receiptIdFor({
    protocol_version: receipt.protocol_version,
    operation_id: receipt.operation_id,
    source_id: receipt.source_id,
    slug: receipt.slug,
    request_sha256: receipt.request_sha256,
    page_id: receipt.page_id,
    page_revision: receipt.page_revision,
    canonical_page_sha256: receipt.canonical_page_sha256,
    committed_at: receipt.committed_at,
    server_build_commit: receipt.server_build_commit,
  });
  if (expectedReceiptId !== receipt.receipt_id) throw integrityError('receipt_id does not match receipt fields');

  const persistedProjection = {
    slug: row.persisted_slug,
    type: row.persisted_type,
    title: row.persisted_title,
    compiled_truth: row.persisted_compiled_truth,
    frontmatter: sortJson(row.persisted_frontmatter ?? {}),
  };
  if (Number(row.persisted_page_id) !== receipt.page_id
    || row.persisted_source_id !== receipt.source_id
    || Number(row.persisted_revision) !== receipt.page_revision
    || row.persisted_content_hash !== receipt.canonical_page_sha256
    || row.persisted_timeline !== ''
    || row.persisted_page_kind !== SEALED_PAGE_KIND
    || row.persisted_source_kind !== SEALED_SOURCE_KIND
    || row.persisted_ingested_via !== SEALED_INGESTED_VIA
    || canonicalJson(persistedProjection) !== canonicalJson(projection)) {
    throw integrityError('receipt differs from the persisted page');
  }
  return receipt;
}

interface PersistedSealedChunk {
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  model: string;
  token_count: number | null;
  embedding_is_null: boolean;
  embedded_at: unknown;
  language: string | null;
  symbol_name: string | null;
  symbol_type: string | null;
  start_line: number | null;
  end_line: number | null;
  parent_symbol_path: string[] | null;
  doc_comment: string | null;
  symbol_name_qualified: string | null;
  search_vector_exact: boolean;
  modality: string;
  embedding_image_is_null: boolean;
  embedding_multimodal_is_null: boolean;
}

async function sealedChunkModelDefault(engine: BrainEngine): Promise<string> {
  const rows = await engine.executeRaw<{ column_default: string }>(
    `SELECT COALESCE(column_default, '') AS column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'content_chunks'
        AND column_name = 'model'`,
  );
  const definition = rows[0]?.column_default ?? '';
  const match = definition.match(/^'((?:[^']|'')*)'(?:::[\w\s.\[\]"]+)?$/);
  if (!match) throw integrityError('content_chunks.model lacks an exact text default');
  return match[1].replace(/''/g, "'");
}

async function assertPersistedChunksExact(
  engine: BrainEngine,
  pageId: number,
  compiledTruth: string,
): Promise<void> {
  const model = await sealedChunkModelDefault(engine);
  const expected = compiledTruth.trim()
    ? chunkText(compiledTruth).map((chunk, chunkIndex): PersistedSealedChunk => ({
        chunk_index: chunkIndex,
        chunk_text: chunk.text,
        chunk_source: 'compiled_truth',
        model,
        token_count: null,
        embedding_is_null: true,
        embedded_at: null,
        language: null,
        symbol_name: null,
        symbol_type: null,
        start_line: null,
        end_line: null,
        parent_symbol_path: null,
        doc_comment: null,
        symbol_name_qualified: null,
        search_vector_exact: true,
        modality: 'text',
        embedding_image_is_null: true,
        embedding_multimodal_is_null: true,
      }))
    : [];
  const actual = await engine.executeRaw<PersistedSealedChunk>(
    `SELECT chunk_index, chunk_text, chunk_source, model, token_count,
            embedding IS NULL AS embedding_is_null, embedded_at,
            language, symbol_name, symbol_type, start_line, end_line,
            parent_symbol_path, doc_comment, symbol_name_qualified,
            search_vector = setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A')
              || setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A')
              || setweight(to_tsvector('english', chunk_text), 'B') AS search_vector_exact,
            modality, embedding_image IS NULL AS embedding_image_is_null,
            embedding_multimodal IS NULL AS embedding_multimodal_is_null
       FROM content_chunks
      WHERE page_id = $1
      ORDER BY chunk_index, id`,
    [pageId],
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw integrityError('persisted chunks differ from deterministic page chunks');
  }
}

async function findReceipt(engine: BrainEngine, operationId: string): Promise<SealedPageReceipt | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT r.protocol_version, r.operation_id, r.source_id, r.slug, r.request_sha256,
            r.page_id, r.page_revision, r.canonical_page_sha256, r.canonical_projection,
            r.committed_at, r.server_build_commit, r.receipt_id,
            p.id AS persisted_page_id, p.source_id AS persisted_source_id,
            p.slug AS persisted_slug, p.type AS persisted_type, p.title AS persisted_title,
            p.compiled_truth AS persisted_compiled_truth, p.frontmatter AS persisted_frontmatter,
            p.timeline AS persisted_timeline, p.content_hash AS persisted_content_hash,
            p.page_kind AS persisted_page_kind, p.source_kind AS persisted_source_kind,
            p.ingested_via AS persisted_ingested_via,
            p.generation AS persisted_revision
       FROM sealed_page_receipts r
       JOIN pages p ON p.id = r.page_id
      WHERE r.operation_id = $1`,
    [operationId],
  );
  if (rows.length === 0) return null;
  const receipt = receiptFromRow(rows[0]);
  await assertPersistedChunksExact(engine, receipt.page_id, receipt.canonical_projection.compiled_truth);
  return receipt;
}

function sameRequest(receipt: SealedPageReceipt, input: PreparedSealedPage): boolean {
  return receipt.source_id === input.sourceId
    && receipt.slug === input.projection.slug
    && receipt.request_sha256 === input.requestSha256
    && receipt.canonical_page_sha256 === input.canonicalPageSha256
    && canonicalJson(receipt.canonical_projection) === canonicalJson(input.projection);
}

async function classifyCommittedConflict(
  engine: BrainEngine,
  input: PreparedSealedPage,
): Promise<{ status: 'matched'; receipt: SealedPageReceipt }> {
  const receipt = await findReceipt(engine, input.operationId);
  if (receipt) {
    if (sameRequest(receipt, input)) return { status: 'matched', receipt };
    throw new SealedPageError('idempotency_conflict', 'operation_id is already bound to a different canonical request');
  }
  const pages = await engine.executeRaw<{ id: number }>(
    'SELECT id FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1',
    [input.sourceId, input.projection.slug],
  );
  if (pages.length > 0) {
    throw new SealedPageError('page_conflict', 'slug already exists and cannot be claimed by create_page');
  }
  throw new Error('create_page transaction conflicted without a persisted receipt or page');
}

export async function createSealedPageTransactional(
  engine: BrainEngine,
  input: PreparedSealedPage,
): Promise<{ status: 'created' | 'matched'; receipt: SealedPageReceipt }> {
  try {
    return await engine.transaction(async (tx) => {
      const existingReceipt = await findReceipt(tx, input.operationId);
      if (existingReceipt) {
        if (sameRequest(existingReceipt, input)) return { status: 'matched' as const, receipt: existingReceipt };
        throw new SealedPageError('idempotency_conflict', 'operation_id is already bound to a different canonical request');
      }

      const existingPage = await tx.executeRaw<{ id: number }>(
        'SELECT id FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1',
        [input.sourceId, input.projection.slug],
      );
      if (existingPage.length > 0) {
        throw new SealedPageError('page_conflict', 'slug already exists and cannot be claimed by create_page');
      }

      const pageRows = await tx.executeRaw<{ id: number; generation: number }>(
        `INSERT INTO pages
          (source_id, slug, type, page_kind, title, compiled_truth, timeline,
           frontmatter, content_hash, source_kind, ingested_via, ingested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb,
                 $9, $10, $11, now())
         RETURNING id, generation`,
        [
          input.sourceId,
          input.projection.slug,
          input.page.type,
          SEALED_PAGE_KIND,
          input.page.title,
          input.page.compiled_truth,
          input.page.timeline ?? '',
          canonicalJson(input.projection.frontmatter),
          input.canonicalPageSha256,
          SEALED_SOURCE_KIND,
          SEALED_INGESTED_VIA,
        ],
      );
      const pageId = Number(pageRows[0].id);
      const pageRevision = Number(pageRows[0].generation);

      for (const chunk of input.chunks) {
        await tx.executeRaw(
          `INSERT INTO content_chunks
             (page_id, chunk_index, chunk_text, chunk_source, embedding, embedded_at, modality)
           VALUES ($1, $2, $3, $4, NULL, NULL, 'text')`,
          [pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source],
        );
      }

      const committedAt = new Date().toISOString();
      const buildCommit = await serverBuildCommit();
      const receiptId = receiptIdFor({
        protocol_version: CREATE_PAGE_PROTOCOL_VERSION,
        operation_id: input.operationId,
        source_id: input.sourceId,
        slug: input.projection.slug,
        request_sha256: input.requestSha256,
        page_id: pageId,
        page_revision: pageRevision,
        canonical_page_sha256: input.canonicalPageSha256,
        committed_at: committedAt,
        server_build_commit: buildCommit,
      });
      assertExactSha256(receiptId, 'receipt_id');

      await tx.executeRaw<Record<string, unknown>>(
        `INSERT INTO sealed_page_receipts
          (protocol_version, operation_id, source_id, slug, request_sha256,
           page_id, page_revision, canonical_page_sha256, canonical_projection,
           committed_at, server_build_commit, receipt_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb,
                 $10::timestamptz, $11, $12)
         RETURNING operation_id`,
        [
          CREATE_PAGE_PROTOCOL_VERSION,
          input.operationId,
          input.sourceId,
          input.projection.slug,
          input.requestSha256,
          pageId,
          pageRevision,
          input.canonicalPageSha256,
          canonicalJson(input.projection),
          committedAt,
          buildCommit,
          receiptId,
        ],
      );
      const receipt = await findReceipt(tx, input.operationId);
      if (!receipt) throw integrityError('inserted receipt cannot be read back');
      return { status: 'created' as const, receipt };
    });
  } catch (error) {
    if (error instanceof SealedPageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/unique|duplicate|sealed page/i.test(message)) {
      return await classifyCommittedConflict(engine, input);
    }
    throw error;
  }
}
