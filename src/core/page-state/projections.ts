import type { BrainEngine } from '../engine.ts';
import type { ProgressReporter } from '../progress.ts';
import type { Chunk, ChunkInput, ResolvedColumn, PageKind } from '../types.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';
import { prepareMarkdownChunks } from '../markdown-chunks.ts';
import { loadFenceChunkOverlay, type FenceChunkOverlay } from '../eligibility/fence-overlay.ts';
import { prepareCodeChunks, installCodeChunkEdges } from '../code-chunks.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { assertPageRevision, PageRevisionConflictError, type PageSnapshot } from './types.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { digest } from '../persistence/digest.ts';
import { quoteIdentifier, resolveWriteColumnFromConfigRows, vectorCastSuffix } from '../search/embedding-column.ts';
import { getFtsLanguage, pageSearchVectorSql } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { jsonRowBatches } from '../batch-rows.ts';
import { refreshProjectionStatistics } from '../search/projection-statistics.ts';
import { belowSafeChunkFence, movableChunkSql } from '../search/safe-chunks.ts';
import { acceptedEmbeddingInputHashes, embeddingInputHash, plainEmbeddingTier, synopsisBodyHash,
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
    search_vector=${pageSearchVectorSql('title', '$3')}
    WHERE source_id=$1 AND slug=$2 AND knowledge_revision=$4::uuid`,
  [sourceId, slug, sanitizeRemoteBody(current.page.timeline), current.revision]);
}

/**
 * A coordinated import's one closing page write: the chunker version its apply
 * deferred (`PreparedImportApplied.chunkerSeal`) and, when `live` is the page at
 * its current revision, the text seal `sealPageTextProjection` would write. The
 * chunker version is stamped whatever the revision, as the deferred seal was.
 */
export async function sealImportedPage(engine: BrainEngine, slug: string, sourceId: string, live: PageSnapshot | null,
  chunkerSeal: number, pageId?: number): Promise<void> {
  const rows = await engine.executeRaw<{ id: number }>(`UPDATE pages SET chunker_version=$5,
    text_projection_revision=CASE WHEN knowledge_revision=$4::uuid THEN knowledge_revision ELSE text_projection_revision END,
    search_vector=CASE WHEN knowledge_revision=$4::uuid THEN ${pageSearchVectorSql('title', '$3')} ELSE search_vector END
    WHERE source_id=$1 AND slug=$2 RETURNING id`,
  [sourceId, slug, live ? sanitizeRemoteBody(live.page.timeline) : '', live?.revision ?? null, chunkerSeal]);
  if (rows.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
  if (pageId !== undefined && Number(rows[0]!.id) !== Number(pageId)) throw new Error(`Page ${slug} (source=${sourceId}) is not the page this transaction wrote`);
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
  /** #5575 ENG-1: held, purged and below-page-tier fence rows, read with the snapshot. */
  fenceOverlay?: FenceChunkOverlay;
}

export type ProjectionConflictField = 'text_projection_revision' | 'chunk_digest' | 'indexing_context';

/** Canonical state can stay unchanged while another worker replaces its projection. */
export class PageProjectionConflictError extends PageRevisionConflictError {
  constructor(expected: string, current: string, readonly changed: readonly ProjectionConflictField[], readonly slug: string, readonly sourceId: string) {
    super(expected, current);
    this.name = 'PageProjectionConflictError';
    this.message = `The search projection of ${slug} (source ${sourceId}) changed during preparation (${changed.join(', ')}) at the same page revision; nothing was installed. Re-read its current snapshot before retrying.`;
  }
}

/**
 * The loser of a concurrent projection installation re-reads and prepares
 * again: `attempt` must capture a fresh snapshot on every call. At most three
 * retries with jitter, so two reinstalling writers cannot livelock; the last
 * conflict is rethrown (`page_projection_conflict` on the wire).
 */
export async function retryProjectionConflict<T>(attempt: () => Promise<T>, random: () => number = Math.random): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return await attempt(); } catch (error) {
      if (!(error instanceof PageProjectionConflictError) || retry === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.floor(random() * 20 * (retry + 1))));
    }
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
  const fenceOverlay = context.pageKind === 'markdown' ? await loadFenceChunkOverlay(tx, { sourceId, slug, compiled_truth: snapshot.page.compiled_truth, timeline: snapshot.page.timeline }) : undefined;
  return { snapshot, chunks: await tx.getChunks(slug, { sourceId, includeUnsealed: true }), indexingContext: context.key,
    embeddingModel: context.model, embeddingColumn: context.column, maxChunkTokens: context.maxChunkTokens, maxChunkTokensOverride: opts.maxChunkTokens, pageKind: context.pageKind,
    ...(fenceOverlay ? { fenceOverlay } : {}) };
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
    const changed: ProjectionConflictField[] = [
      ...(current!.page.text_projection_revision !== snapshot.page.text_projection_revision ? ['text_projection_revision' as const] : []),
      ...(digest(stored) !== digest(prepared.chunks) ? ['chunk_digest' as const] : []),
      ...(context.key !== prepared.indexingContext ? ['indexing_context' as const] : []),
    ];
    if (changed.length) throw new PageProjectionConflictError(snapshot.revision, current!.revision, changed, slug, sourceId);
    if (opts.seal && opts.preserveEmbeddings) {
      // #5553: keep a vector only when its recorded embedding input equals the
      // input the current page would produce. A chunk with no record is kept
      // only in the pre-contextual NULL mode; explicit none may have inherited
      // an old title vector, so its missing proof cannot authorize retention.
      // On a contextual page it is
      // nulled once and stamped by its re-embed.
      const mode = current!.page.contextual_retrieval_mode;
      const provenance = embeddingInputContext(context, current!.page.title, context.corpusGeneration, chunks);
      const col = quoteIdentifier(context.column.name);
      const recorded = new Map((await tx.executeRaw<{ id: number; embedding_input_hash: string | null; movable: boolean }>(
        `SELECT id,embedding_input_hash,${movableChunkSql(col)} AND model IS NOT DISTINCT FROM $2 AS movable FROM content_chunks WHERE page_id=$1`,
        [snapshot.page.id, context.provenanceModel])).map(row => [Number(row.id), row]));
      const currentInput = (chunk: Chunk) => {
        const hash = recorded.get(Number(chunk.id))?.embedding_input_hash ?? null;
        return hash === null ? mode == null : acceptedEmbeddingInputHashes(provenance, mode, chunk).includes(hash);
      };
      // A4: a chunk unchanged at its index stays; one the new projection holds at
      // another index stays too when its vector is current, and upsertChunks moves
      // the row there, so a top insert re-embeds only the chunks whose text changed.
      const identity = (chunk: ChunkInput | Chunk) => digest([chunk.chunk_text, chunk.chunk_source,
        chunk.language ?? null, chunk.symbol_name ?? null, chunk.symbol_type ?? null,
        chunk.start_line ?? null, chunk.end_line ?? null, chunk.parent_symbol_path ?? null,
        chunk.doc_comment ?? null, chunk.symbol_name_qualified ?? null, chunk.modality ?? 'text']);
      // Repair missing code metadata without discarding a vector for identical input.
      // Populated metadata that disagrees still changes identity. Prefer the same
      // index and refuse ambiguous moved matches; vector/model/input checks below
      // continue to apply before any row is retained at a different index.
      const metadata = ['language', 'symbol_name', 'symbol_type', 'start_line', 'end_line',
        'parent_symbol_path', 'doc_comment', 'symbol_name_qualified'] as const;
      const repairKey = (chunk: ChunkInput | Chunk) => digest([chunk.chunk_text, chunk.chunk_source, chunk.modality ?? 'text']);
      const repairCandidates = new Map<string, ChunkInput[]>();
      if (opts.code) for (const chunk of chunks) {
        const key = repairKey(chunk), group = repairCandidates.get(key) ?? [];
        group.push(chunk); repairCandidates.set(key, group);
      }
      const repairedIdentities = new Map<number, string>();
      const storedIdentity = (chunk: Chunk): string => {
        const cached = repairedIdentities.get(chunk.id);
        if (cached) return cached;
        if (!opts.code) return identity(chunk);
        const matches = (repairCandidates.get(repairKey(chunk)) ?? []).filter(next => metadata.every(key => chunk[key] == null || digest(chunk[key]) === digest(next[key] ?? null)));
        const sameIndex = matches.find(next => next.chunk_index === chunk.chunk_index);
        const value = identity(sameIndex ?? (matches.length === 1 ? matches[0]! : chunk));
        repairedIdentities.set(chunk.id, value);
        return value;
      };
      const atIndex = new Map(chunks.map(chunk => [chunk.chunk_index, identity(chunk)]));
      const elsewhere = new Map<string, number>();
      for (const chunk of chunks) elsewhere.set(identity(chunk), (elsewhere.get(identity(chunk)) ?? 0) + 1);
      const inPlace = stored.filter(chunk => atIndex.get(chunk.chunk_index) === storedIdentity(chunk));
      for (const chunk of inPlace) elsewhere.set(storedIdentity(chunk), elsewhere.get(storedIdentity(chunk))! - 1);
      const moved = stored.filter(chunk => {
        const left = elsewhere.get(storedIdentity(chunk)) ?? 0;
        if (atIndex.get(chunk.chunk_index) === storedIdentity(chunk) || left <= 0
          || !recorded.get(Number(chunk.id))?.movable || !currentInput(chunk)) return false;
        elsewhere.set(storedIdentity(chunk), left - 1);
        return true;
      });
      const kept = [...inPlace, ...moved];
      await tx.executeRaw(`DELETE FROM content_chunks WHERE page_id=$1 AND NOT(id=ANY($2::int[]))`, [snapshot.page.id, kept.map(chunk => chunk.id)]);
      await tx.executeRaw(`UPDATE content_chunks SET ${col}=NULL,
        embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL,
        embedding_pending_since=COALESCE(embedding_pending_since,now()) WHERE page_id=$1 AND
        (model IS DISTINCT FROM $2 OR embedded_text_hash <> md5(chunk_text) OR NOT(id=ANY($3::int[])))`,
      [snapshot.page.id, context.provenanceModel, kept.filter(currentInput).map(chunk => Number(chunk.id))]);
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

/** What `installPageEmbeddings` committed. */
export interface PageEmbeddingInstall {
  /** Offered vectors committed (each onto every current row holding its chunk text and source). */
  installed: number;
  /**
   * The page still holds the chunk set the vectors were prepared from (same
   * indices, text and sources) and every offered vector committed, so completion stamps (the embedding
   * signature, a title-tier restamp, an effect's completion) describe it.
   */
  complete: boolean;
}

/**
 * A4: a late vector commits by chunk content, not by page revision. Each
 * offered vector lands on the current rows holding its exact chunk text and
 * source (any id or index) when the embedding input it was built for (the
 * captured title, tier, corpus generation and, for synopsis vectors, the
 * captured body hash) is still the input the current page accepts
 * (`acceptedEmbeddingInputHashes`, #5553); a vector whose chunk left the page or
 * whose context moved (title edit, synopsis body change) is dropped. So an
 * embed of a live, growing page converges instead of being discarded on every
 * append. A deleted page, an archived or recreated source, another page id, an
 * unsealed projection or a changed indexing context (model, column, mode,
 * corpus generation) refuses everything. `built` names the wrapping the vectors
 * were built under when it is not the page's plain re-embed convention (the
 * contextual service's synopsis tier and the corpus generation it stamps next);
 * that publication describes the whole page, so it installs only when complete.
 * UPDATE-only, in bounded batches: a late embed never replaces text, chunk
 * identity, metadata or membership.
 */
export async function installPageEmbeddings(engine: BrainEngine, prepared: ProjectionSnapshot, chunks: ChunkInput[], signature?: string,
  built?: { tier: EmbeddingTier; corpusGeneration?: string | null }): Promise<PageEmbeddingInstall> {
  const { snapshot } = prepared;
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  const refused: PageEmbeddingInstall = { installed: 0, complete: false };
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    if (!current || current.page.deleted_at || current.sourceIncarnation !== snapshot.sourceIncarnation || current.page.id !== snapshot.page.id
      || current.page.text_projection_revision !== current.revision) return refused;
    const [source] = await tx.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) return refused;
    const context = await indexingContext(tx, current, prepared.maxChunkTokensOverride);
    if (context.key !== prepared.indexingContext) return refused;
    const stored = await tx.getChunks(slug, { sourceId, includeUnsealed: true });
    const key = (chunk: { chunk_text: string; chunk_source?: string | null }) => `${chunk.chunk_source}\0${chunk.chunk_text}`;
    const rows = new Map<string, number[]>();
    for (const chunk of stored) {
      const ids = rows.get(key(chunk));
      if (ids) ids.push(chunk.id);
      else rows.set(key(chunk), [chunk.id]);
    }
    // Use the checked descriptor: config writes do not take the page guard,
    // so resolving again could send these vectors to a different model's column.
    const column = context.column;
    const mode = current.page.contextual_retrieval_mode;
    const tier = built?.tier ?? plainEmbeddingTier(mode);
    const generation = built?.corpusGeneration !== undefined ? built.corpusGeneration : context.corpusGeneration;
    const capturedInput = embeddingInputContext(context, snapshot.page.title, generation, prepared.chunks);
    const currentInput = embeddingInputContext(context, current.page.title, generation, stored);
    const accepted = new Map<string, { ids: number[]; hash: string; chunk: ChunkInput }>();
    let installed = 0;
    let dropped = 0;
    for (const chunk of chunks) {
      if (!chunk.embedding && !chunk.embedding_image) continue;
      const ids = rows.get(key(chunk));
      const hash = embeddingInputHash(capturedInput, tier, chunk);
      const currentHashes = built ? [embeddingInputHash(currentInput, built.tier, chunk)] : acceptedEmbeddingInputHashes(currentInput, mode, chunk);
      if (!ids || (chunk.embedding && !currentHashes.includes(hash))) { dropped++; continue; }
      installed++;
      if (!accepted.has(key(chunk))) accepted.set(key(chunk), { ids, hash, chunk });
    }
    const complete = dropped === 0 && stored.length === prepared.chunks.length && stored.every((c, i) => c.chunk_index === prepared.chunks[i].chunk_index && c.chunk_text === prepared.chunks[i].chunk_text && c.chunk_source === prepared.chunks[i].chunk_source);
    if (built && !complete) return refused;
    const updates = [...accepted.values()].flatMap(({ ids, hash, chunk }) => ids.map(id => ({ id, hash, chunk })));
    const col = quoteIdentifier(column.name);
    for (const batch of jsonRowBatches(updates, ({ id, hash, chunk }) => ({
      id,
      chunk_text: chunk.chunk_text,
      embedding: chunk.embedding ? `[${Array.from(chunk.embedding).join(',')}]` : null,
      image: chunk.embedding_image ? `[${Array.from(chunk.embedding_image).join(',')}]` : null,
      // Bind the full provider:model captured before the provider call. Keeping
      // an old label on a new vector prevents provenance-complete migration.
      model: chunk.model ?? (chunk.embedding ? prepared.embeddingModel : null),
      input_hash: hash,
    }))) {
      await tx.executeRaw(`UPDATE content_chunks SET
        ${col}=CASE WHEN v.embedding IS NULL THEN content_chunks.${col} ELSE v.embedding${vectorCastSuffix(column)} END,
        embedding_image=CASE WHEN v.image IS NULL THEN content_chunks.embedding_image ELSE v.image::vector END,
        embedding_input_hash=CASE WHEN v.embedding IS NULL THEN content_chunks.embedding_input_hash ELSE v.input_hash END,
        embedded_at=now(),embedded_text_hash=md5(content_chunks.chunk_text),model=COALESCE(v.model,content_chunks.model),
        embedding_pending_since=CASE WHEN v.embedding IS NULL THEN content_chunks.embedding_pending_since ELSE NULL END
        FROM jsonb_to_recordset($2::text::jsonb) AS v(id int, chunk_text text, embedding text, image text, model text, input_hash text)
        WHERE content_chunks.id=v.id AND content_chunks.page_id=$1 AND content_chunks.chunk_text=v.chunk_text`, [snapshot.page.id, batch]);
    }
    if (signature && complete) await tx.setPageEmbeddingSignature(slug, { sourceId, signature });
    return { installed, complete };
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
  return { chunks: await prepareMarkdownChunks(page, prepared.maxChunkTokens, prepared.fenceOverlay), code: undefined };
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
  /** Only rows whose queue reason is one of these. */
  reasons?: readonly string[];
  /** Only these pages of one source. */
  pages?: { sourceId: string; slugs: readonly string[] };
  /** Receives each failed page; without it a generic stderr line is printed. */
  onFailure?: (failure: ProjectionRebuildFailure) => void;
  /**
   * Receives each queue row this call consumed without a rebuild: `removed`
   * (a stale row deleted under the page guard) or `deferred` (a page whose
   * revision moved during its install, stamped `updated_at=now()` so a run
   * bounded by `notAfter` does not try it again). Progress, unlike a bare
   * `superseded` no-op.
   */
  onHeal?: (heal: { kind: 'removed' | 'deferred'; source_id: string; slug: string }) => void;
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

/**
 * Bounded and keyless. Unsupported media remains queued for its source importer.
 *
 * A queue row that no longer matches its live page is healed under the page
 * guard (PR #6400 (b)), with a compare-and-set on the exact
 * (source_incarnation, slug, revision) this call listed, so a newer row the
 * `pages` trigger queued meanwhile survives: a row of a dead incarnation is
 * deleted (never re-keyed onto the live one, which has its own rows); a row
 * whose revision is stale under the live incarnation is deleted when the page
 * is already projected, else re-keyed to the live `knowledge_revision` and
 * rebuilt in the same pass. A row another worker consumed is a no-op
 * (`superseded`). A page whose revision moves during its install is deferred
 * by `updated_at` and reported through `onFailure` once per run.
 */
export async function rebuildPendingPageProjections(engine: BrainEngine, limit = 20, opts: ProjectionRebuildOptions = {}): Promise<{ rebuilt: number; superseded: number }> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const params: unknown[] = [Math.max(1, Math.min(limit, 100))];
  const filters: string[] = [];
  if (opts.retryCooldown) filters.push(PROJECTION_RETRY_READY_SQL);
  if (opts.notAfter !== undefined) { params.push(opts.notAfter); filters.push(`j.updated_at<=$${params.length}::text::timestamptz`); }
  if (opts.reasons) { params.push(opts.reasons); filters.push(`j.reason=ANY($${params.length}::text[])`); }
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
    const observed = [job.source_incarnation, job.slug, job.revision];
    try {
      const prepared = await engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: job.source_id, slug: job.slug }]);
        const pending = await tx.executeRaw(`SELECT 1 FROM page_projection_jobs
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, observed);
        if (!pending.length) return null;
        const read = await readGuardedProjectionSnapshot(tx, job.slug, job.source_id, { allowUnsealed: true });
        if (!read) return null;
        const { snapshot } = read;
        if (snapshot.sourceIncarnation === job.source_incarnation && snapshot.revision === job.revision) return read;
        if (snapshot.sourceIncarnation !== job.source_incarnation || snapshot.page.text_projection_revision === snapshot.revision) {
          await tx.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', observed);
          return 'removed';
        }
        await tx.executeRaw(`UPDATE page_projection_jobs SET revision=$4::uuid,updated_at=now()
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [...observed, snapshot.revision]);
        return read;
      });
      if (!prepared) { superseded++; continue; }
      if (prepared === 'removed') { superseded++; opts.onHeal?.({ kind: 'removed', source_id: job.source_id, slug: job.slug }); continue; }
      const projection = await preparePageProjection(prepared);
      await installPageProjection(engine, prepared, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
      rebuilt++;
    } catch (error) {
      if (!(error instanceof PageRevisionConflictError)) {
        await engine.executeRaw(`UPDATE page_projection_jobs SET reason='rebuild_failed',updated_at=now()
          WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, observed);
        if (opts.onFailure) opts.onFailure({ source_id: job.source_id, slug: job.slug, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) });
        else process.stderr.write('[gbrain] Projection rebuild failed; work remains queued. Inspect projection readiness and the recorded source path.\n');
        continue;
      }
      // The page moved under its install: defer the exact row this call listed
      // (a newer trigger-queued row already carries its own stamp) and report it.
      const deferred = await engine.executeRaw(`UPDATE page_projection_jobs SET updated_at=now()
        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid RETURNING slug`, observed);
      if (!deferred.length) { superseded++; continue; }
      opts.onHeal?.({ kind: 'deferred', source_id: job.source_id, slug: job.slug });
      opts.onFailure?.({ source_id: job.source_id, slug: job.slug, reason: `revision_conflict: ${error.message.split('\n')[0].slice(0, 280)}` });
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

/** #6286: queued projections are rebuilt in batches of this many pages. */
const DRAIN_BATCH = 100;

export interface ProjectionDrainResult {
  rebuilt: number;
  superseded: number;
  failed: ProjectionRebuildFailure[];
  remaining: number;
  limited: boolean;
}

export async function drainProjections(engine: BrainEngine, opts: { limit?: number; progress?: ProgressReporter; reasons?: readonly string[] } = {}): Promise<ProjectionDrainResult> {
  const [{ runStart }] = await engine.executeRaw<{ runStart: string }>('SELECT now()::text AS "runStart"');
  // PGLite's clock can be coarse: wait until it passes the run start, so a page
  // that fails in this run is stamped after it and is not tried again.
  while (!(await engine.executeRaw<{ passed: boolean }>('SELECT now()>$1::text::timestamptz AS passed', [runStart]))[0]?.passed) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const total = (await projectionBacklog(engine)).pending;
  opts.progress?.start('projections.drain', opts.limit === undefined ? total : Math.min(total, opts.limit));
  const failed: ProjectionRebuildFailure[] = [];
  let rebuilt = 0;
  let superseded = 0;
  let tried = 0;
  try {
    // Continue while a batch rebuilt, removed, failed or durably deferred a
    // row; stop on a no-op batch. A bare `superseded` row (another worker
    // consumed it) is not progress, so one row can never spin the drain.
    while (opts.limit === undefined || tried < opts.limit) {
      let healed = 0;
      let failedNow = 0;
      const batch = await rebuildPendingPageProjections(engine, Math.min(DRAIN_BATCH, (opts.limit ?? Infinity) - tried),
        { notAfter: runStart, reasons: opts.reasons, onHeal: () => { healed++; },
          onFailure: failure => { failed.push(failure); if (!failure.reason.startsWith('revision_conflict:')) failedNow++; } });
      rebuilt += batch.rebuilt;
      superseded += batch.superseded;
      const progressed = batch.rebuilt + healed + failedNow;
      if (progressed === 0) break;
      tried += progressed;
      opts.progress?.tick(progressed, `${rebuilt} rebuilt, ${failed.length} failed`);
    }
  } finally {
    opts.progress?.finish();
  }
  const remaining = (await projectionBacklog(engine)).pending;
  return { rebuilt, superseded, failed, remaining, limited: opts.limit !== undefined && tried >= opts.limit && remaining > 0 };
}

