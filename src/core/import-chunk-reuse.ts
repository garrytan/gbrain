/**
 * A13 vector reuse for one Markdown page import, shared by the inline import
 * (before its transaction, onto the chunks it will embed) and the prepared
 * publish (inside its publication transaction, under the page guard).
 */
import type { BrainEngine } from './engine.ts';
import { embeddingWriteTarget, embeddingInputContext } from './page-state/projections.ts';
import { canReuseMarkdownVector, planEmbeddingReuse } from './embed-reuse.ts';
import { modeRequiresSynopsis } from './embedding-context.ts';
import type { Chunk, ChunkInput, CRMode } from './types.ts';
import type { SegmentChunkInput } from './page-body/types.ts';
import { quoteIdentifier } from './search/embedding-column.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { parseEmbedding } from './utils.ts';
import { segmentSynopsisInputHashes, segmentSynopsisLead } from './page-body/segment-synopsis.ts';

/**
 * A stored row an import keeps: its id and the index it holds now (a kept row whose new chunk sits elsewhere moves
 * there). `vector`: the row holds one, so moving it is a vector-index write (page-state/chunk-moves.ts).
 */
export interface KeptChunkRow { id: number; chunk_index: number; vector: boolean }

/**
 * A13 reuse for one page import: copies each stored vector the reuse gate
 * admits onto its matching new chunk in `into`, and maps the chunk's index to
 * the stored row when that row already holds exactly what the chunk would
 * insert, at any index (#7172: an entry inserted above it shifts its index, not
 * its content), so an import can keep it, else to null. A stored row at the
 * chunk's own index is matched first. With `keepUnembedded` (the
 * in-transaction pass), an identical stored row with no vector at the same
 * index also maps to its row when the new chunk carries no vector. A prepared
 * import reuses nothing from a page stored under per-chunk synopsis.
 */
export async function reuseStoredChunkVectors(
  exec: BrainEngine,
  into: ChunkInput[],
  { slug, sourceId, title, corpusGeneration, tier, prepared, keepUnembedded = false }: { slug: string; sourceId: string; title: string; corpusGeneration: string | null; tier: 'title' | 'none'; prepared: boolean; keepUnembedded?: boolean },
): Promise<Map<number, KeptChunkRow | null>> {
  const reused = new Map<number, KeptChunkRow | null>();
  const target = await embeddingWriteTarget(exec);
  const provenance = embeddingInputContext(target, title, corpusGeneration, into);
  const rows = await exec.executeRaw<{ chunk_index: number; embedding_input_hash: string | null; contextual_retrieval_mode: string | null; text_only: boolean; unembedded: boolean }>(
    `SELECT c.chunk_index, c.embedding_input_hash, p.contextual_retrieval_mode,
        c.embedding_image IS NULL AND c.embedding_multimodal IS NULL AND c.embedded_text_hash = md5(c.chunk_text) AS text_only,
        c.embedding IS NULL AND c.embedding_image IS NULL AND c.embedding_multimodal IS NULL
          AND c.embedding_input_hash IS NULL AND c.embedded_text_hash IS NULL AS unembedded
      FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE p.source_id = $1 AND p.slug = $2`, [sourceId, slug]);
  if (rows.length === 0) return reused;
  // A page stored under per-chunk synopsis re-embeds every chunk on its next
  // prepared edit: its vectors carry synopses this import does not recompute.
  if (prepared && rows[0]!.contextual_retrieval_mode && modeRequiresSynopsis(rows[0]!.contextual_retrieval_mode as CRMode)) return reused;
  const recorded = new Map(rows.map(row => [Number(row.chunk_index), row.embedding_input_hash]));
  const textOnly = new Set(rows.filter(row => row.text_only).map(row => Number(row.chunk_index)));
  // Reuse is keyed on chunk source + text, so a stored chunk's current-input
  // hash is the hash its matching new chunk would record.
  const all = await exec.getChunks(slug, { sourceId, includeEmbedding: true, requireSafeChunks: true });
  const stored = all.filter(chunk => chunk.embedding && canReuseMarkdownVector(recorded.get(chunk.chunk_index), rows[0]!.contextual_retrieval_mode, tier, provenance, chunk));
  const identity = (chunk: ChunkInput | Chunk) => JSON.stringify([chunk.chunk_text, chunk.chunk_source,
    chunk.language ?? null, chunk.symbol_name ?? null, chunk.symbol_type ?? null, chunk.start_line ?? null, chunk.end_line ?? null,
    chunk.parent_symbol_path ?? null, chunk.doc_comment ?? null, chunk.symbol_name_qualified ?? null, chunk.modality ?? 'text']);
  const key = (chunk: { chunk_source?: string | null; chunk_text: string }) => `${chunk.chunk_source}\0${chunk.chunk_text}`;
  // A stored row at the chunk's own index first, then FIFO by source + text: one page can hold two identical chunks.
  const atIndex = new Map(stored.map(chunk => [chunk.chunk_index, chunk]));
  const matches = new Map<number, Chunk>();
  into.forEach((chunk, i) => { const row = atIndex.get(chunk.chunk_index); if (row && key(row) === key(chunk)) matches.set(i, row); });
  const taken = new Set([...matches.values()].map(row => row.id));
  const byKey = new Map<string, Chunk[]>();
  for (const row of stored) if (!taken.has(row.id)) byKey.set(key(row), [...(byKey.get(key(row)) ?? []), row]);
  into.forEach((chunk, i) => { const row = matches.has(i) ? undefined : byKey.get(key(chunk))?.shift(); if (row) matches.set(i, row); });
  for (const [i, row] of matches) {
    into[i].embedding = row.embedding as Float32Array;
    into[i].token_count = row.token_count ?? undefined;
    if (row.model) into[i].model = row.model;
    // The stored row already holds exactly what this chunk would insert (identity, vector, recorded input and text
    // hash, no image or multimodal vector the insert would drop), so it can stay, moved to this chunk's index.
    reused.set(i, recorded.get(row.chunk_index) != null && textOnly.has(row.chunk_index) && identity(row) === identity(into[i]) ? { id: row.id, chunk_index: row.chunk_index, vector: true } : null);
  }
  // A stored row that never got a vector stays in place under a new chunk that
  // will not get one either (a --no-embed or deferred write): the same upsert
  // over it would keep it as it is.
  if (keepUnembedded) {
    const unembedded = new Set(rows.filter(row => row.unembedded).map(row => Number(row.chunk_index)));
    const byIndex = new Map(into.map((chunk, i) => [chunk.chunk_index, i]));
    for (const row of all) {
      const i = byIndex.get(row.chunk_index);
      if (i === undefined || reused.has(i) || into[i]!.embedding || !unembedded.has(row.chunk_index)) continue;
      if (identity(row) === identity(into[i]!)) reused.set(i, { id: row.id, chunk_index: row.chunk_index, vector: false });
    }
  }
  return reused;
}

/**
 * Wave B: vector reuse for a segmented write, scoped to the live chunk rows of
 * the occurrences the write retires (never the whole page): one statement
 * reads those rows with their vectors, the same gate as
 * `reuseStoredChunkVectors` admits each (recorded input hash for the write's
 * tier), and each admitted vector is copied, with its recorded input, onto the
 * new chunk with the same source and text (`chunk_source\0chunk_text`, FIFO for
 * duplicates); on a page stored under per-chunk synopsis, onto the new chunk
 * whose synopsis input hashes to the recorded one (its window is unchanged). So an
 * unchanged chunk inside a rewritten tail keeps its vector and only new text
 * reaches the provider. Returns how many chunks got one.
 */
export async function reuseSegmentChunkVectors(exec: BrainEngine, { pageId, retiredOccurrences, chunks, title, corpusGeneration, tier, truthLead }: {
  pageId: number; retiredOccurrences: readonly number[]; chunks: SegmentChunkInput[]; title: string; corpusGeneration: string | null; tier: 'title' | 'none';
  /** The truth_lead the write stores (a synopsis window opens with it); omitted when the body is unchanged (the stored one). */
  truthLead?: string }): Promise<number> {
  if (retiredOccurrences.length === 0 || chunks.length === 0) return 0;
  const target = await embeddingWriteTarget(exec);
  const provenance = embeddingInputContext(target, title, corpusGeneration, []);
  const col = quoteIdentifier(target.column.name);
  const rows = await exec.executeRaw<{ chunk_text: string; chunk_source: string; embedding: unknown; token_count: number | null; model: string | null;
    embedding_input_hash: string | null; contextual_retrieval_mode: string | null; slug: string; source_id: string; corpus_generation: string | null }>(
    `SELECT c.chunk_text, c.chunk_source, c.${col} AS embedding, c.token_count, c.model, c.embedding_input_hash, p.contextual_retrieval_mode,
            p.slug, p.source_id, p.corpus_generation
       FROM content_chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.page_id = $1 AND c.occurrence_id = ANY($2::bigint[]) AND c.${col} IS NOT NULL AND ${chunkGenerationFilter('p', 'c')}
      ORDER BY c.chunk_index`, [pageId, [...retiredOccurrences]]);
  const mode = rows[0]?.contextual_retrieval_mode ?? null;
  if (rows.length === 0) return 0;
  // Wave B spec 8.6: on a page stored under per-chunk synopsis, a vector carries over only onto a new chunk whose
  // synopsis input (its segment window over the page lead) hashes to the stored row's recorded input.
  const synopsis = mode && modeRequiresSynopsis(mode as CRMode)
    ? segmentSynopsisInputHashes(embeddingInputContext(target, title, rows[0]!.corpus_generation, []),
      await segmentSynopsisLead(exec, { id: pageId, slug: rows[0]!.slug, source_id: rows[0]!.source_id }, truthLead), chunks)
    : null;
  const stored = rows.map(row => ({ chunk_text: row.chunk_text, chunk_source: row.chunk_source, embedding: parseEmbedding(row.embedding),
    token_count: row.token_count, model: row.model, embedding_input_hash: row.embedding_input_hash }))
    .filter(chunk => synopsis ? chunk.embedding_input_hash !== null : canReuseMarkdownVector(chunk.embedding_input_hash, mode, tier, provenance, chunk));
  const { reuse } = planEmbeddingReuse(stored, chunks, synopsis
    ? c => synopsis.get(c as SegmentChunkInput) ?? (c as { embedding_input_hash?: string | null }).embedding_input_hash ?? ''
    : c => `${c.chunk_source}\0${c.chunk_text}`);
  for (const [i, matched] of reuse) {
    const row = matched as typeof stored[number];
    chunks[i]!.embedding = row.embedding as Float32Array;
    chunks[i]!.token_count = row.token_count ?? undefined;
    if (row.model) chunks[i]!.model = row.model;
    if (row.embedding_input_hash) chunks[i]!.embedding_input_hash = row.embedding_input_hash;
  }
  return reuse.size;
}
