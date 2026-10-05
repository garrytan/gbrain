import type { BrainEngine } from '../engine.ts';
import type { Chunk, ChunkInput, ResolvedColumn, PageKind } from '../types.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';
import { prepareMarkdownChunks } from '../markdown-chunks.ts';
import { prepareCodeChunks, installCodeChunkEdges } from '../code-chunks.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { assertPageRevision, PageRevisionConflictError, type PageSnapshot } from './types.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { digest } from '../persistence/digest.ts';
import { quoteIdentifier, resolveWriteColumnFromConfigRows, vectorCastSuffix } from '../search/embedding-column.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { belowSafeChunkFence } from '../search/safe-chunks.ts';
import { acceptedEmbeddingInputHashes, embeddingInputHash, hasRawEmbeddingInput, isContextualMode, plainEmbeddingTier, synopsisBodyHash,
  type EmbeddingInputContext, type EmbeddingTier } from '../embedding-input-hash.ts';

/**
 * Complete the searchable snapshot only after its sanitized chunks are installed.
 * `guarded` is this transaction's own read of the page under its guard, when
 * the caller has one and has not changed the page's revision or timeline since.
 */
export async function sealPageTextProjection(engine: BrainEngine, slug: string, sourceId: string, guarded?: PageSnapshot): Promise<void> {
  const current = guarded ?? await engine.readPageSnapshot(slug, { sourceId });
  if (!current) return;
  await engine.executeRaw(`UPDATE pages SET text_projection_revision=knowledge_revision,
    search_vector=setweight(to_tsvector('${getFtsLanguage()}',COALESCE(title,'')),'A') ||
      setweight(to_tsvector('${getFtsLanguage()}',$3::text),'C')
    WHERE source_id=$1 AND slug=$2 AND knowledge_revision=$4::uuid`,
  [sourceId, slug, sanitizeRemoteBody(current.page.timeline), current.revision]);
}

export interface ProjectionSnapshot {
  snapshot: PageSnapshot;
  chunks: Chunk[];
  indexingContext: string;
  embeddingModel: string | null;
  embeddingColumn: ResolvedColumn;
  maxChunkTokens: number;
  maxChunkTokensOverride?: number;
  pageKind: PageKind;
}

/** Canonical state can stay unchanged while another worker replaces its projection. */
export class PageProjectionConflictError extends PageRevisionConflictError {
  constructor(expected: string, current: string) {
    super(expected, current);
    this.name = 'PageProjectionConflictError';
    this.message = 'The page projection changed during preparation. Read its current snapshot before retrying.';
  }
}

/** The vector column and model a write targets; `model` is what a stored chunk's label and provenance are compared to. */
export async function embeddingWriteTarget(engine: Pick<BrainEngine, 'executeRaw'>): Promise<{ config: Array<{ key: string; value: string }>; model: string | null; column: ResolvedColumn; provenanceModel: string | null }> {
  // A missing config table reads as defaults, as upsertChunks' own resolution does.
  const config = await engine.executeRaw<{ key: string; value: string }>(
    "SELECT key,value FROM config WHERE key IN ('search_embedding_column','embedding_columns','embedding_model','embedding_dimensions','contextual_retrieval.mode') ORDER BY key") ?? [];
  let model = config.find(row => row.key === 'embedding_model')?.value ?? null;
  try { model = getEmbeddingModel(); } catch { /* Unconfigured gateway: retain the brain's recorded model. */ }
  const column = resolveWriteColumnFromConfigRows({
    searchEmbeddingColumn: config.find(row => row.key === 'search_embedding_column')?.value ?? null,
    embeddingColumnsJson: config.find(row => row.key === 'embedding_columns')?.value ?? null,
  });
  return { config, model, column, provenanceModel: column.name === 'embedding' ? model : column.embeddingModel };
}

/** Provenance inputs for one page's chunk set under a write target. */
export function embeddingInputContext(target: { column: ResolvedColumn; provenanceModel: string | null }, title: string,
  corpusGeneration: string | null, chunks: ReadonlyArray<{ chunk_text: string; chunk_source?: string | null }>): EmbeddingInputContext {
  return { column: target.column.name, model: target.provenanceModel, dimensions: target.column.dimensions, title, corpusGeneration,
    bodyHash: synopsisBodyHash(chunks) };
}

/**
 * Record provenance on freshly embedded chunks of a full import, built under
 * `tier`, and return the column the hash names so the write targets it
 * (undefined when nothing was freshly embedded). Reused vectors stay unrecorded.
 */
export async function stampEmbeddingInputs(engine: Pick<BrainEngine, 'executeRaw'>, chunks: ChunkInput[], fresh: ReadonlySet<number> | null,
  page: { title: string; tier: EmbeddingTier; corpusGeneration: string | null }): Promise<ResolvedColumn | undefined> {
  if (!chunks.some((chunk, i) => chunk.embedding && (!fresh || fresh.has(i)))) return undefined;
  const target = await embeddingWriteTarget(engine);
  const provenance = embeddingInputContext(target, page.title, page.corpusGeneration, chunks);
  chunks.forEach((chunk, i) => {
    if (chunk.embedding && (!fresh || fresh.has(i))) chunk.embedding_input_hash = embeddingInputHash(provenance, page.tier, chunk);
  });
  return target.column;
}

async function indexingContext(engine: BrainEngine, snapshot: PageSnapshot, maxChunkTokensOverride?: number): Promise<{ key: string; model: string | null; maxChunkTokens: number; column: ResolvedColumn; pageKind: PageKind; provenanceModel: string | null; corpusGeneration: string | null }> {
  const { config, model, column, provenanceModel } = await embeddingWriteTarget(engine);
  const maxChunkTokens = maxChunkTokensOverride ?? resolveMaxChunkTokens();
  const [projection] = await engine.executeRaw<{ chunker_version: number | null; corpus_generation: string | null }>(
    'SELECT chunker_version,corpus_generation FROM pages WHERE id=$1', [snapshot.page.id]);
  const [kind] = await engine.executeRaw<{ page_kind: PageKind }>('SELECT page_kind FROM pages WHERE id=$1', [snapshot.page.id]);
  if (!kind) throw new PageRevisionConflictError(snapshot.revision, null);
  return { key: digest({ config, mode: snapshot.page.contextual_retrieval_mode, model, column,
    maxChunkTokens, storedChunkerVersion: projection?.chunker_version ?? null, corpusGeneration: projection?.corpus_generation ?? null,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION, codeChunkerVersion: CHUNKER_VERSION, pageKind: kind.page_kind,
    ftsLanguage: getFtsLanguage() }), model, maxChunkTokens, column, pageKind: kind.page_kind, provenanceModel,
    corpusGeneration: projection?.corpus_generation ?? null };
}

/** A short guarded read binds the exact chunk set and title/body revision. */
export async function readProjectionSnapshot(engine: BrainEngine, slug: string, sourceId: string,
  opts: { allowUnsealed?: boolean; maxChunkTokens?: number; requireLiveSource?: boolean } = {}): Promise<ProjectionSnapshot | null> {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    return readGuardedProjectionSnapshot(tx, slug, sourceId, opts);
  });
}

/** readProjectionSnapshot for a caller whose transaction already holds the page guard. */
async function readGuardedProjectionSnapshot(tx: BrainEngine, slug: string, sourceId: string,
  opts: { allowUnsealed?: boolean; maxChunkTokens?: number; requireLiveSource?: boolean }): Promise<ProjectionSnapshot | null> {
  const snapshot = await tx.readPageSnapshot(slug, { sourceId, ...(opts.requireLiveSource && { requireLiveSource: true }) });
  if (!snapshot || (!opts.allowUnsealed && snapshot.page.text_projection_revision !== snapshot.revision)) return null;
  const context = await indexingContext(tx, snapshot, opts.maxChunkTokens);
  return { snapshot, chunks: await tx.getChunks(slug, { sourceId, includeUnsealed: true }), indexingContext: context.key,
    embeddingModel: context.model, embeddingColumn: context.column, maxChunkTokens: context.maxChunkTokens, maxChunkTokensOverride: opts.maxChunkTokens, pageKind: context.pageKind };
}

/** No provider work under the guard. Delayed derived results lose to newer content. */
export async function installPageProjection(engine: BrainEngine, prepared: ProjectionSnapshot, chunks: ChunkInput[], opts: { seal?: boolean; signature?: string; preserveEmbeddings?: boolean; code?: Awaited<ReturnType<typeof prepareCodeChunks>> } = {}): Promise<void> {
  const { snapshot } = prepared;
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    assertPageRevision(current, { expectedRevision: snapshot.revision });
    const [source] = await tx.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived || current!.page.deleted_at) throw new PageRevisionConflictError(snapshot.revision, current!.revision);
    if (current!.sourceIncarnation !== snapshot.sourceIncarnation || current!.page.id !== snapshot.page.id) {
      throw new PageRevisionConflictError(snapshot.revision, current!.revision);
    }
    const stored = await tx.getChunks(slug, { sourceId, includeUnsealed: true });
    const context = await indexingContext(tx, current!, prepared.maxChunkTokensOverride);
    // getChunks omits vector payloads but includes identity, text/source, metadata
    // and embedding completion state. A newer installation must not be deleted,
    // even when its canonical revision stayed the same.
    if (current!.page.text_projection_revision !== snapshot.page.text_projection_revision
      || digest(stored) !== digest(prepared.chunks)
      || context.key !== prepared.indexingContext) {
      throw new PageProjectionConflictError(snapshot.revision, current!.revision);
    }
    if (opts.seal && opts.preserveEmbeddings) {
      const byIndex = new Map(chunks.map(chunk => [chunk.chunk_index, chunk]));
      const identity = (chunk: ChunkInput | Chunk) => [chunk.chunk_text, chunk.chunk_source,
        chunk.language ?? null, chunk.symbol_name ?? null, chunk.symbol_type ?? null,
        chunk.start_line ?? null, chunk.end_line ?? null, chunk.parent_symbol_path ?? null,
        chunk.doc_comment ?? null, chunk.symbol_name_qualified ?? null, chunk.modality ?? 'text'];
      const matching = stored.filter(chunk => {
        const next = byIndex.get(chunk.chunk_index);
        return next && digest(identity(chunk)) === digest(identity(next));
      }).map(chunk => chunk.id);
      await tx.executeRaw(`DELETE FROM content_chunks WHERE page_id=$1 AND NOT(id=ANY($2::int[]))`, [snapshot.page.id, matching]);
      // #5553: keep a vector only when its recorded embedding input equals the
      // input the current page would produce. A chunk with no record is kept
      // only where that input is its raw text; on a contextual page it is
      // nulled once and stamped by its re-embed.
      const mode = current!.page.contextual_retrieval_mode;
      const provenance = embeddingInputContext(context, current!.page.title, context.corpusGeneration, chunks);
      const recorded = await tx.executeRaw<{ id: number; chunk_index: number; embedding_input_hash: string | null }>(
        'SELECT id,chunk_index,embedding_input_hash FROM content_chunks WHERE page_id=$1', [snapshot.page.id]);
      const currentInput = recorded.filter(row => row.embedding_input_hash === null ? !isContextualMode(mode) && hasRawEmbeddingInput(provenance, byIndex.get(Number(row.chunk_index))!)
        : acceptedEmbeddingInputHashes(provenance, mode, byIndex.get(Number(row.chunk_index))!).includes(row.embedding_input_hash)).map(row => Number(row.id));
      await tx.executeRaw(`UPDATE content_chunks SET ${quoteIdentifier(context.column.name)}=NULL,
        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL WHERE page_id=$1 AND
        (model IS DISTINCT FROM $2 OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[])))`,
      [snapshot.page.id, context.provenanceModel, currentInput]);
    } else if (opts.seal) await tx.deleteChunks(slug, { sourceId });
    await tx.upsertChunks(slug, chunks, { sourceId, expectedRevision: snapshot.revision, embeddingColumn: context.column });
    if (opts.code) await installCodeChunkEdges(tx, slug, sourceId, opts.code);
    if (opts.seal) {
      await tx.executeRaw(`UPDATE pages SET chunker_version=$3
        WHERE source_id=$1 AND slug=$2`, [sourceId, slug, MARKDOWN_CHUNKER_VERSION]);
      await sealPageTextProjection(tx, slug, sourceId, current!);
      await tx.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [snapshot.sourceIncarnation, slug, snapshot.revision]);
    }
    if (opts.signature) await tx.setPageEmbeddingSignature(slug, { sourceId, signature: opts.signature });
  });
}

/**
 * Embedding-only updates require the same chunk identities and text, too.
 * `built` names the wrapping the vectors were built under when it is not the
 * page's plain re-embed convention (the contextual service's synopsis tier and
 * its corpus generation); it is recorded with each vector.
 */
export async function installPageEmbeddings(engine: BrainEngine, prepared: ProjectionSnapshot, chunks: ChunkInput[], signature?: string,
  built?: { tier: EmbeddingTier; corpusGeneration?: string | null }): Promise<boolean> {
  const { snapshot } = prepared;
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    if (!current || current.page.deleted_at || current.revision !== snapshot.revision || current.sourceIncarnation !== snapshot.sourceIncarnation || current.page.id !== snapshot.page.id
      || current.page.text_projection_revision !== current.revision) return false;
    const [source] = await tx.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) return false;
    const context = await indexingContext(tx, current, prepared.maxChunkTokensOverride);
    if (context.key !== prepared.indexingContext) return false;
    const stored = await tx.getChunks(slug, { sourceId, includeUnsealed: true });
    if (stored.length !== prepared.chunks.length || stored.some((c, i) => c.id !== prepared.chunks[i].id
      || c.chunk_index !== prepared.chunks[i].chunk_index || c.chunk_text !== prepared.chunks[i].chunk_text)) return false;
    const byIndex = new Map(stored.map(chunk => [chunk.chunk_index, chunk]));
    if (chunks.some(chunk => !byIndex.has(chunk.chunk_index) || byIndex.get(chunk.chunk_index)!.chunk_text !== chunk.chunk_text
      || byIndex.get(chunk.chunk_index)!.chunk_source !== chunk.chunk_source)) return false;
    // Use the checked descriptor: config writes do not take the page guard,
    // so resolving again could send these vectors to a different model's column.
    const column = context.column;
    const tier = built?.tier ?? plainEmbeddingTier(current.page.contextual_retrieval_mode);
    const provenance = embeddingInputContext(context, current.page.title,
      built?.corpusGeneration !== undefined ? built.corpusGeneration : context.corpusGeneration, stored);
    // This is deliberately UPDATE-only: a late embed can never replace text,
    // chunk identity, metadata, or membership in the installed projection.
    for (const chunk of chunks) {
      if (!chunk.embedding && !chunk.embedding_image) continue;
      const original = byIndex.get(chunk.chunk_index)!;
      const vector = chunk.embedding ? `[${Array.from(chunk.embedding).join(',')}]` : null;
      const image = chunk.embedding_image ? `[${Array.from(chunk.embedding_image).join(',')}]` : null;
      await tx.executeRaw(`UPDATE content_chunks SET
        ${quoteIdentifier(column.name)}=CASE WHEN $2::text IS NULL THEN ${quoteIdentifier(column.name)} ELSE $2${vectorCastSuffix(column)} END,
        embedding_image=CASE WHEN $3::text IS NULL THEN embedding_image ELSE $3::vector END,
        embedding_input_hash=CASE WHEN $2::text IS NULL THEN embedding_input_hash ELSE $7 END,
        embedded_at=now(),embedded_text_hash=md5(chunk_text),model=COALESCE($4,model)
        WHERE id=$1 AND page_id=$5 AND chunk_text=$6`,
      // Bind the full provider:model captured before the provider call. Keeping
      // an old label on a new vector prevents provenance-complete migration.
      [original.id, vector, image, chunk.model ?? (vector ? prepared.embeddingModel : null), snapshot.page.id, original.chunk_text,
        embeddingInputHash(provenance, tier, original)]);
    }
    if (signature) await tx.setPageEmbeddingSignature(slug, { sourceId, signature });
    return true;
  });
}

/** Queue the latest revision even when its worktree owner is unavailable. */
export async function queuePageProjection(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, reason: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId, slug, reason]);
}

/** #5050/#5247: whether a live page's installed chunks predate the safe-chunk fence. */
export async function projectionBelowSafeFence(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ chunker_version: number | null }>(
    'SELECT chunker_version FROM pages WHERE id=$1 AND deleted_at IS NULL', [pageId]) ?? [];
  return row !== undefined && belowSafeChunkFence(row.chunker_version === null ? null : Number(row.chunker_version));
}

/**
 * #5050/#5247: re-seal a page chunked before the safe-chunk fence from its
 * unchanged canonical body. Projection-only: no page write, version, journal
 * admission or lifetime ID; vectors of unchanged inputs are kept. Returns the
 * chunks left without a vector (the re-seal's embedding work), or null when
 * the page is gone or already sealed at the fence; a concurrent change
 * surfaces as PageRevisionConflictError.
 */
export async function resealSafeChunks(engine: BrainEngine, slug: string, sourceId: string): Promise<{ pendingChunks: number; pendingChars: number } | null> {
  const prepared = await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true, requireLiveSource: true });
  if (!prepared || prepared.snapshot.page.deleted_at || !['markdown', 'code'].includes(prepared.pageKind)) return null;
  if (!await projectionBelowSafeFence(engine, prepared.snapshot.page.id)
    && prepared.snapshot.page.text_projection_revision === prepared.snapshot.revision) return null;
  const projection = await preparePageProjection(prepared);
  await installPageProjection(engine, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
  const [pending] = await engine.executeRaw<{ chunks: number; chars: number }>(`SELECT COUNT(*)::int AS chunks,
    COALESCE(SUM(length(chunk_text)),0)::int AS chars FROM content_chunks
    WHERE page_id=$1 AND ${quoteIdentifier(prepared.embeddingColumn.name)} IS NULL AND modality='text'`, [prepared.snapshot.page.id]);
  return { pendingChunks: Number(pending?.chunks ?? 0), pendingChars: Number(pending?.chars ?? 0) };
}

export async function preparePageProjection(prepared: ProjectionSnapshot) {
  const page = prepared.snapshot.page;
  if (prepared.pageKind === 'code') {
    const path = typeof page.frontmatter.file === 'string' ? page.frontmatter.file : page.source_path;
    if (!path) throw new Error('Code projection requires a recorded source path. Restore frontmatter.file or source_path before retrying.');
    const code = await prepareCodeChunks(page, path);
    return { chunks: code.chunks, code };
  }
  if (prepared.pageKind !== 'markdown') throw new Error('This page kind requires its source importer.');
  return { chunks: await prepareMarkdownChunks(page, prepared.maxChunkTokens), code: undefined };
}

// The job queue is usually empty or small while pages grows without bound, so
// these reads walk jobs and probe sources/pages per job. The OFFSET 0 fences
// keep the planner from turning the probes back into a scan of pages; PGLite
// has no autovacuum to give it accurate queue statistics.
const PROJECTION_JOB_PROBES = `CROSS JOIN LATERAL (SELECT s.id FROM sources s
      WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s
    CROSS JOIN LATERAL (SELECT p.page_kind FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug
      AND p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') OFFSET 0) p`;

/**
 * Rebuilds between statistics refreshes, per engine. Like autovacuum's analyze
 * threshold, a refresh is due once 50 rows plus 10% of the table changed; a
 * process's first drained rebuild always refreshes.
 */
const statisticsDebt = new WeakMap<BrainEngine, { rebuilt: number; rows: number | null }>();

/**
 * #5401: a failed rebuild waits this long before the resident retries it. One
 * fragment over `page_projection_jobs j`, shared by the consumer's idle probe
 * and the resident's selector.
 */
export const PROJECTION_RETRY_READY_SQL = "(j.reason IS DISTINCT FROM 'rebuild_failed' OR j.updated_at<now()-interval '30 seconds')";

export interface ProjectionRebuildFailure { source_id: string; slug: string; reason: string }

export interface ProjectionRebuildOptions {
  /** Stop starting new pages once this many milliseconds have passed since the call began; the first page always starts. */
  deadlineMs?: number;
  /** Injectable clock in milliseconds, for the deadline. */
  now?: () => number;
  /**
   * Only rows last queued or failed at or before this database instant (text,
   * cast in SQL so microseconds survive). A caller that waits for the database
   * clock to pass it tries each row at most once per run.
   */
  notAfter?: string;
  /** Skip failed rows inside their retry window (PROJECTION_RETRY_READY_SQL). */
  retryCooldown?: boolean;
  /** Only these pages of one source. */
  pages?: { sourceId: string; slugs: readonly string[] };
  /** Receives each failed page; without it a generic stderr line is printed. */
  onFailure?: (failure: ProjectionRebuildFailure) => void;
}

/** Live Markdown and code rows a rebuild can take, and how many of them last failed. */
export async function projectionBacklog(engine: Pick<BrainEngine, 'executeRaw'>): Promise<{ pending: number; failed: number; oldest_age_seconds: number | null }> {
  const [row] = await engine.executeRaw<{ pending: number; failed: number; oldest: number | null }>(`SELECT COUNT(*)::int AS pending,
      COUNT(*) FILTER (WHERE j.reason='rebuild_failed')::int AS failed,
      EXTRACT(EPOCH FROM now()-MIN(j.updated_at))::float8 AS oldest
    FROM page_projection_jobs j ${PROJECTION_JOB_PROBES}`);
  const oldest = row?.oldest === null || row?.oldest === undefined ? null : Math.max(0, Math.floor(Number(row.oldest)));
  return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0), oldest_age_seconds: oldest };
}

/** Bounded and keyless. Unsupported media remains queued for its source importer. */
export async function rebuildPendingPageProjections(engine: BrainEngine, limit = 20, opts: ProjectionRebuildOptions = {}): Promise<{ rebuilt: number; superseded: number }> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const params: unknown[] = [Math.max(1, Math.min(limit, 100))];
  const filters: string[] = [];
  if (opts.retryCooldown) filters.push(PROJECTION_RETRY_READY_SQL);
  if (opts.notAfter !== undefined) { params.push(opts.notAfter); filters.push(`j.updated_at<=$${params.length}::text::timestamptz`); }
  if (opts.pages) { params.push(opts.pages.slugs); filters.push(`j.slug=ANY($${params.length}::text[])`); }
  const sourceFilter = opts.pages ? `WHERE s.id=$${params.push(opts.pages.sourceId)}` : '';
  const jobs = await engine.executeRaw<{ source_id: string; source_incarnation: string; slug: string; revision: string; page_kind: string }>(`SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind
    FROM (SELECT source_incarnation,slug,revision,updated_at FROM page_projection_jobs j
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY updated_at,source_incarnation,slug OFFSET 0) j
    ${PROJECTION_JOB_PROBES} ${sourceFilter}
    ORDER BY j.updated_at,j.source_incarnation,j.slug LIMIT $1`, params);
  let rebuilt = 0;
  let superseded = 0;
  for (const [index, job] of jobs.entries()) {
    if (opts.deadlineMs !== undefined && index > 0 && now() - startedAt >= opts.deadlineMs) break;
    try {
      const prepared = await engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: job.source_id, slug: job.slug }]);
        const pending = await tx.executeRaw(`SELECT 1 FROM page_projection_jobs
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.source_incarnation, job.slug, job.revision]);
        if (!pending.length) return null;
        return readGuardedProjectionSnapshot(tx, job.slug, job.source_id, { allowUnsealed: true });
      });
      if (!prepared || prepared.snapshot.sourceIncarnation !== job.source_incarnation || prepared.snapshot.revision !== job.revision) { superseded++; continue; }
      const projection = await preparePageProjection(prepared);
      await installPageProjection(engine, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
      rebuilt++;
    } catch (error) {
      if (!(error instanceof PageRevisionConflictError)) {
        await engine.executeRaw(`UPDATE page_projection_jobs SET reason='rebuild_failed',updated_at=now()
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.source_incarnation, job.slug, job.revision]);
        if (opts.onFailure) opts.onFailure({ source_id: job.source_id, slug: job.slug, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) });
        else process.stderr.write('[gbrain] Projection rebuild failed; work remains queued. Inspect projection readiness and the recorded source path.\n');
        continue;
      }
      superseded++;
    }
  }
  if (rebuilt > 0) {
    const debt = statisticsDebt.get(engine);
    const owed = { rebuilt: (debt?.rebuilt ?? 0) + rebuilt, rows: debt?.rows ?? null };
    statisticsDebt.set(engine, owed);
    if (owed.rows !== null && owed.rebuilt < 50 + owed.rows * 0.1) return { rebuilt, superseded };
    const remaining = await engine.executeRaw(`SELECT 1 FROM page_projection_jobs j
      ${PROJECTION_JOB_PROBES}
      WHERE j.reason<>'rebuild_failed' LIMIT 1`);
    if (!remaining.length) {
      await refreshProjectionStatistics(engine);
      const [pages] = await engine.executeRaw<{ rows: number }>("SELECT GREATEST(reltuples,0)::float8 AS rows FROM pg_class WHERE oid='pages'::regclass");
      statisticsDebt.set(engine, { rebuilt: 0, rows: Number(pages?.rows ?? 0) });
    }
  }
  return { rebuilt, superseded };
}
