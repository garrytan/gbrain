import type { BrainEngine } from '../engine.ts';
import type { Chunk, ChunkInput, ResolvedColumn } from '../types.ts';
import { chunkText, MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { assertPageRevision, PageRevisionConflictError, type PageSnapshot } from './types.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { digest } from '../persistence/digest.ts';
import { quoteIdentifier, resolveWriteColumnFromConfigRows, vectorCastSuffix } from '../search/embedding-column.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';

/** Complete the searchable snapshot only after its sanitized chunks are installed. */
export async function sealPageTextProjection(engine: BrainEngine, slug: string, sourceId: string): Promise<void> {
  const current = await engine.readPageSnapshot(slug, { sourceId });
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
  maxChunkTokens: number;
  maxChunkTokensOverride?: number;
}

/** Canonical state can stay unchanged while another worker replaces its projection. */
export class PageProjectionConflictError extends PageRevisionConflictError {
  constructor(expected: string, current: string) {
    super(expected, current);
    this.name = 'PageProjectionConflictError';
    this.message = 'The page projection changed during preparation. Read its current snapshot before retrying.';
  }
}

async function indexingContext(engine: BrainEngine, snapshot: PageSnapshot, maxChunkTokensOverride?: number): Promise<{ key: string; model: string | null; maxChunkTokens: number; column: ResolvedColumn }> {
  const config = await engine.executeRaw<{ key: string; value: string }>(
    "SELECT key,value FROM config WHERE key IN ('search_embedding_column','embedding_columns','embedding_model','embedding_dimensions','contextual_retrieval.mode') ORDER BY key");
  let model = config.find(row => row.key === 'embedding_model')?.value ?? null;
  try { model = getEmbeddingModel(); } catch { /* Unconfigured gateway: retain the brain's recorded model. */ }
  const maxChunkTokens = maxChunkTokensOverride ?? resolveMaxChunkTokens();
  const column = resolveWriteColumnFromConfigRows({
    searchEmbeddingColumn: config.find(row => row.key === 'search_embedding_column')?.value ?? null,
    embeddingColumnsJson: config.find(row => row.key === 'embedding_columns')?.value ?? null,
  });
  const [projection] = await engine.executeRaw<{ chunker_version: number | null; corpus_generation: string | null }>(
    'SELECT chunker_version,corpus_generation FROM pages WHERE id=$1', [snapshot.page.id]);
  return { key: digest({ config, mode: snapshot.page.contextual_retrieval_mode, model, column,
    maxChunkTokens, storedChunkerVersion: projection?.chunker_version ?? null, corpusGeneration: projection?.corpus_generation ?? null,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION, ftsLanguage: getFtsLanguage() }), model, maxChunkTokens, column };
}

/** A short guarded read binds the exact chunk set and title/body revision. */
export async function readProjectionSnapshot(engine: BrainEngine, slug: string, sourceId: string,
  opts: { allowUnsealed?: boolean; maxChunkTokens?: number } = {}): Promise<ProjectionSnapshot | null> {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const snapshot = await tx.readPageSnapshot(slug, { sourceId });
    if (!snapshot || (!opts.allowUnsealed && snapshot.page.text_projection_revision !== snapshot.revision)) return null;
    const context = await indexingContext(tx, snapshot, opts.maxChunkTokens);
    return { snapshot, chunks: await tx.getChunks(slug, { sourceId, includeUnsealed: true }), indexingContext: context.key,
      embeddingModel: context.model, maxChunkTokens: context.maxChunkTokens, maxChunkTokensOverride: opts.maxChunkTokens };
  });
}

/** No provider work under the guard. Delayed derived results lose to newer content. */
export async function installPageProjection(engine: BrainEngine, prepared: ProjectionSnapshot, chunks: ChunkInput[], opts: { seal?: boolean; signature?: string; preserveEmbeddings?: boolean } = {}): Promise<void> {
  const { snapshot } = prepared;
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    assertPageRevision(current, { expectedRevision: snapshot.revision });
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
    if (opts.seal && !opts.preserveEmbeddings) await tx.deleteChunks(slug, { sourceId });
    await tx.upsertChunks(slug, chunks, { sourceId, expectedRevision: snapshot.revision, embeddingColumn: context.column });
    if (opts.seal) {
      await tx.executeRaw(`UPDATE pages SET chunker_version=$3
        WHERE source_id=$1 AND slug=$2`, [sourceId, slug, MARKDOWN_CHUNKER_VERSION]);
      await sealPageTextProjection(tx, slug, sourceId);
      await tx.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid', [snapshot.sourceIncarnation, slug, snapshot.revision]);
    }
    if (opts.signature) await tx.setPageEmbeddingSignature(slug, { sourceId, signature: opts.signature });
  });
}

/** Embedding-only updates require the same chunk identities and text, too. */
export async function installPageEmbeddings(engine: BrainEngine, prepared: ProjectionSnapshot, chunks: ChunkInput[], signature?: string): Promise<boolean> {
  const { snapshot } = prepared;
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId });
    if (!current || current.revision !== snapshot.revision || current.sourceIncarnation !== snapshot.sourceIncarnation || current.page.id !== snapshot.page.id
      || current.page.text_projection_revision !== current.revision) return false;
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
        embedded_at=now(),embedded_text_hash=md5(chunk_text),model=COALESCE($4,model)
        WHERE id=$1 AND page_id=$5 AND chunk_text=$6`,
      // Bind the full provider:model captured before the provider call. Keeping
      // an old label on a new vector prevents provenance-complete migration.
      [original.id, vector, image, chunk.model ?? (vector ? prepared.embeddingModel : null), snapshot.page.id, original.chunk_text]);
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

/** Bounded and keyless. Code/image pages retain queued work for their source importer. */
export async function rebuildPendingPageProjections(engine: BrainEngine, limit = 20): Promise<{ rebuilt: number; superseded: number }> {
  const jobs = await engine.executeRaw<{ source_id: string; source_incarnation: string; slug: string; revision: string; page_kind: string }>(`SELECT s.id AS source_id,j.source_incarnation,j.slug,j.revision,p.page_kind
    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug
    WHERE p.deleted_at IS NULL AND p.page_kind='markdown'
    ORDER BY j.updated_at,j.source_incarnation,j.slug LIMIT $1`, [Math.max(1, Math.min(limit, 100))]);
  let rebuilt = 0;
  let superseded = 0;
  for (const job of jobs) {
    const prepared = await engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: job.source_id, slug: job.slug }]);
      const pending = await tx.executeRaw(`SELECT 1 FROM page_projection_jobs
        WHERE source_incarnation=$1::uuid AND slug=$2 AND revision=$3::uuid`, [job.source_incarnation, job.slug, job.revision]);
      if (!pending.length) return null;
      return readProjectionSnapshot(tx, job.slug, job.source_id, { allowUnsealed: true });
    });
    if (!prepared) { superseded++; continue; }
    const chunks: ChunkInput[] = [];
    for (const field of ['compiled_truth', 'timeline'] as const) {
      for (const chunk of chunkText(sanitizeRemoteBody(prepared.snapshot.page[field]), { maxTokens: prepared.maxChunkTokens })) {
        chunks.push({ chunk_index: chunks.length, chunk_text: chunk.text, chunk_source: field });
      }
    }
    try {
      await installPageProjection(engine, prepared, chunks, { seal: true });
      rebuilt++;
    } catch (error) {
      if (!(error instanceof PageRevisionConflictError)) throw error;
      superseded++;
    }
  }
  return { rebuilt, superseded };
}
