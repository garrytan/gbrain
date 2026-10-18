import type { BrainEngine } from '../engine.ts';
import type { ChunkInput, PageReadScope } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';

/** First markdown index built from the strict full-body fence sanitizer. */
export const SAFE_FENCE_CHUNKER_VERSION = 4;

const PROTECTED_MARKER = '<!--- gbrain:(facts|takes):(begin|end) -->';

export function hasProtectedBody(text: string): boolean {
  return new RegExp(PROTECTED_MARKER).test(text);
}

/** Expression and aliases are internal SQL, never caller-supplied values. */
export function protectedTextFilter(expression: string): string {
  return `COALESCE(${expression}, '') ~ '${PROTECTED_MARKER}'`;
}

/**
 * Fixed SQL aliases only. Check full bodies because fragments can lose markers.
 * A segmented page has no body columns: its `body_flags.has_protected` (set by
 * the ingest from the segmenter's regions) decides, and a page without the
 * flag counts as protected (fail closed).
 */
export function protectedBodyFilter(alias: string): string {
  return `(CASE WHEN ${alias}.body_storage = 'segmented' THEN ${alias}.body_flags->>'has_protected' IS DISTINCT FROM 'false'
    ELSE (${protectedTextFilter(`${alias}.compiled_truth`)} OR ${protectedTextFilter(`${alias}.timeline`)}) END)`;
}

/** A body-only write cannot certify old fragments, even after fence removal. */
export function bodyWriteChunkVersion(compiledTruth: string, timeline: string): string {
  return `CASE WHEN pages.compiled_truth IS NOT DISTINCT FROM ${compiledTruth}
    AND pages.timeline IS NOT DISTINCT FROM ${timeline} THEN pages.chunker_version
    WHEN pages.chunker_version < 0 OR ${protectedBodyFilter('pages')}
      OR ${protectedTextFilter(compiledTruth)} OR ${protectedTextFilter(timeline)} THEN -1
    ELSE LEAST(COALESCE(pages.chunker_version, 0), ${SAFE_FENCE_CHUNKER_VERSION - 1}) END`;
}

export function requiresSafeChunks(scope?: PageReadScope): boolean {
  return scope?.requireSafeChunks ?? scope?.excludePrivate ?? false;
}

/** Every user sees projections only from the current canonical revision. */
export function currentTextProjectionFilter(alias: string): string {
  return `(${alias}.text_projection_revision = ${alias}.knowledge_revision) IS TRUE`;
}

/**
 * Wave B: the chunk row belongs to its page's live body: an inline row
 * (`body_generation IS NULL`) of a page that is not segmented, or a segmented
 * row at or below the page's generation whose occurrence has a live manifest
 * row. Staged rows (above the page's generation), rows of retired occurrences
 * (closed by a flip or a demotion, deleted later when the flip deferred their
 * retirement) and rows of a preparation that never published are invisible
 * whether or not they were deleted yet. The manifest probe is one primary-key
 * lookup per segmented row; `page` must expose `body_storage` and `body_generation`.
 * `manifest: false` (chunkManifestReads) drops the segmented branch, which then
 * matches no row the reader can see.
 */
export function chunkGenerationFilter(page: string, chunk: string, manifest = true): string {
  if (!manifest) return `(${chunk}.body_generation IS NULL AND ${page}.body_storage <> 'segmented')`;
  return `((${chunk}.body_generation IS NULL AND ${page}.body_storage <> 'segmented')
       OR (${chunk}.body_generation <= ${page}.body_generation
           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = ${chunk}.page_id AND lm.occurrence_id = ${chunk}.occurrence_id
             AND lm.staging_id IS NULL AND lm.gen_from <= ${page}.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > ${page}.body_generation))))`;
}

/** `chunkGenerationFilter` for a statement that has no page row joined. */
export function chunkGenerationProbe(chunk: string, manifest = true): string {
  return `EXISTS (SELECT 1 FROM pages gp WHERE gp.id = ${chunk}.page_id AND ${chunkGenerationFilter('gp', chunk, manifest)})`;
}

const CHUNK_MANIFEST_ACCESS_SQL = `-- chunk-visibility-ok: whether any chunk row of a segmented body exists, no row is returned
SELECT has_table_privilege('page_body_manifest', 'SELECT') AS readable,
  NOT has_table_privilege('page_body_manifest', 'SELECT')
    AND (EXISTS (SELECT 1 FROM content_chunks WHERE body_generation IS NOT NULL)
      OR EXISTS (SELECT 1 FROM content_chunks WHERE occurrence_id IS NOT NULL)) AS segmented`;
const manifestReadable = new WeakSet<object>();

/**
 * Whether a read's chunk statements name `page_body_manifest`. Postgres checks the privilege on every relation a
 * statement names, matched or not, so a role without SELECT on it (docs/ENGINES.md, "Segmented page tables") would
 * fail every chunk read with 42501 although no page is segmented. True on PGLite, for a role that may read the
 * manifest (kept per engine: a transaction clone probes again, so its SET LOCAL ROLE counts) and for a role that sees
 * a chunk row of a segmented body (`body_generation` or `occurrence_id` set, both partial-indexed), which then gets
 * 42501 as documented. Otherwise every chunk row the role sees is an inline row, and the manifest-free forms of
 * chunkGenerationFilter, chunkGenerationProbe and chunkManifestJoin select exactly the rows the full forms would.
 * `db` runs the probe: a scoped read passes its transaction, so the probe sees the rows that read sees.
 */
export async function chunkManifestReads(engine: Pick<BrainEngine, 'kind' | 'executeRaw'>, db: Pick<BrainEngine, 'executeRaw'> = engine): Promise<boolean> {
  if (engine.kind !== 'postgres' || manifestReadable.has(engine)) return true;
  const [access] = await db.executeRaw<{ readable: boolean; segmented: boolean }>(CHUNK_MANIFEST_ACCESS_SQL);
  if (access?.readable) manifestReadable.add(engine);
  return access?.readable === true || access?.segmented === true;
}

/**
 * Search-facing chunk visibility: the current text projection and the live body generation. A sealed page holds no
 * rows of a retired occurrence (the flip deletes them in its transaction, or leaves the page unsealed until the
 * projection job has), so the row predicate needs no manifest probe, whose per-row cost moved vector search off its
 * HNSW plan (test/e2e/vector-chunk-statistics-postgres.test.ts).
 */
export function chunkVisibleFilter(page: string, chunk: string): string {
  return `(${currentTextProjectionFilter(page)}
       AND (${chunk}.body_generation IS NULL OR ${chunk}.body_generation <= ${page}.body_generation))`;
}

/**
 * The live manifest row of a segmented chunk (no row for an inline chunk), for
 * `chunkDocumentOrder`. LEFT JOIN text; `page` must expose `body_generation`.
 * `readsManifest: false` (chunkManifestReads) joins no row, as for an inline chunk.
 */
export function chunkManifestJoin(page: string, chunk: string, manifest: string, readsManifest = true): string {
  if (!readsManifest) return `LEFT JOIN (SELECT NULL::bigint AS byte_start) ${manifest} ON false`;
  return `LEFT JOIN page_body_manifest ${manifest} ON ${chunk}.occurrence_id IS NOT NULL
       AND ${manifest}.page_id = ${chunk}.page_id AND ${manifest}.occurrence_id = ${chunk}.occurrence_id
       AND ${manifest}.staging_id IS NULL AND ${manifest}.gen_from <= ${page}.body_generation
       AND (${manifest}.gen_to IS NULL OR ${manifest}.gen_to > ${page}.body_generation)`;
}

/** Document order: (manifest byte_start, local_ordinal) for segmented rows; inline rows keep chunk_index order. */
export function chunkDocumentOrder(chunk: string, manifest: string): string {
  return `${manifest}.byte_start, ${chunk}.local_ordinal, ${chunk}.chunk_index`;
}

/** A page of any kind chunked before the fence; remote reads withhold it until it is re-sealed. */
export function belowSafeChunkFence(chunkerVersion: number | null | undefined): boolean {
  return (chunkerVersion ?? 0) < SAFE_FENCE_CHUNKER_VERSION;
}

/**
 * A body write that removes a protected fence leaves `chunker_version < 0`
 * (bodyWriteChunkVersion): the stored text lost its marker, but the source
 * behind it (an image's pixels) did not, so only a fresh attestation counts.
 */
/** #6803: the importer's refusal of a distrusted image without a successful fresh OCR pass; the sweep counts it as `ocr_required`. */
export const OCR_REQUIRED_ERROR = 'This image had protected OCR, so indexing it requires successful fresh OCR. Enable OCR and reimport the image.';

export async function provenanceDistrusted(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ chunker_version: number | null }>('SELECT chunker_version FROM pages WHERE id = $1', [pageId]);
  return (row?.chunker_version ?? 0) < 0;
}

/**
 * Older fragments lack trustworthy provenance, even if markers were removed
 * later. `pages.chunker_version` is `smallint NOT NULL` at head on both
 * engines (v054), so the bare column compares and keeps its statistics (#6632:
 * a COALESCE gets the default 1/3 selectivity and misleads the count plan).
 */
export function safeChunksFilter(alias: string): string {
  return `${alias}.chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION}`;
}

/**
 * Preserve an existing seal for an embedding-only refresh of the exact chunk
 * snapshot. Additions, removals and textual metadata changes invalidate before
 * the first mutation, including partial failures outside an import transaction.
 * Both engines canonicalize chunk_text before calling, and persist/hash those
 * same bytes. Identity and enum fields retain their existing rejection policy.
 *
 * One statement per encoded batch of the incoming set (`jsonRowBatches`), so a
 * large page is compared without one whole-page JSON document; each statement
 * also checks for stored chunks missing from the complete incoming index set.
 * The caller stops at the first statement that invalidates (RETURNING id).
 */
export function* chunkWriteInvalidations(pageId: number, chunks: ChunkInput[]): Generator<{ sql: string; params: unknown[] }> {
  const metadata = ['language', 'symbol_name', 'symbol_type', 'start_line', 'end_line', 'parent_symbol_path', 'doc_comment', 'symbol_name_qualified'] as const;
  // chunk-visibility-ok: inline chunk write invalidation; segmented pages stage rows through stageSegmentChunks
  const sql = `UPDATE pages SET chunker_version = -1 WHERE id = $1 AND (
      NOT (${safeChunksFilter('pages')})
      OR EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = $1 AND cc.chunk_index <> ALL($3::int[]))
      OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS incoming(
          chunk_index int, chunk_text text, chunk_source text, modality text,
          language text, symbol_name text, symbol_type text, start_line int,
          end_line int, parent_symbol_path text[], doc_comment text, symbol_name_qualified text)
        LEFT JOIN content_chunks cc ON cc.page_id = $1 AND cc.chunk_index = incoming.chunk_index
        WHERE cc.id IS NULL
          OR cc.chunk_text IS DISTINCT FROM incoming.chunk_text
          OR cc.chunk_source IS DISTINCT FROM incoming.chunk_source
          OR cc.modality IS DISTINCT FROM COALESCE(incoming.modality, 'text')
          ${metadata.map(key => `OR cc.${key} IS DISTINCT FROM COALESCE(incoming.${key}, cc.${key})`).join('\n          ')}
      )) RETURNING id`;
  const indices = chunks.map(chunk => chunk.chunk_index);
  const batches = jsonRowBatches(chunks, chunk => Object.fromEntries(
    ['chunk_index', 'chunk_text', 'chunk_source', 'modality', ...metadata].map(key => [key, chunk[key as keyof ChunkInput] ?? null])));
  let sent = false;
  for (const batch of batches) {
    sent = true;
    yield { sql, params: [pageId, batch, indices] };
  }
  if (!sent) yield { sql, params: [pageId, '[]', indices] };
}

/**
 * A stored row whose vector provably describes its own text (#4246), the only
 * rows a content-keyed rebuild moves to a new index. `col` is a quoted column.
 */
export function movableChunkSql(col: string): string {
  return `(${col} IS NOT NULL AND embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text))`;
}
