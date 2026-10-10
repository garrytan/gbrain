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

/**
 * A13 reuse for one page import: copies each stored vector the reuse gate
 * admits onto its matching new chunk in `into`, and maps the chunk's index to
 * the stored row id when that row already holds exactly what the chunk would
 * insert (so an import can keep it in place), else to null. With
 * `keepUnembedded` (the in-transaction pass), an identical stored row with no
 * vector also maps to its id when the new chunk carries no vector. A
 * prepared import reuses nothing from a page stored under per-chunk synopsis.
 */
export async function reuseStoredChunkVectors(
  exec: BrainEngine,
  into: ChunkInput[],
  { slug, sourceId, title, corpusGeneration, tier, prepared, keepUnembedded = false }: { slug: string; sourceId: string; title: string; corpusGeneration: string | null; tier: 'title' | 'none'; prepared: boolean; keepUnembedded?: boolean },
): Promise<Map<number, number | null>> {
  const reused = new Map<number, number | null>();
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
  const stored = all.filter(chunk => canReuseMarkdownVector(recorded.get(chunk.chunk_index), rows[0]!.contextual_retrieval_mode, tier, provenance, chunk));
  const identity = (chunk: ChunkInput | Chunk) => JSON.stringify([chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
    chunk.language ?? null, chunk.symbol_name ?? null, chunk.symbol_type ?? null, chunk.start_line ?? null, chunk.end_line ?? null,
    chunk.parent_symbol_path ?? null, chunk.doc_comment ?? null, chunk.symbol_name_qualified ?? null, chunk.modality ?? 'text']);
  for (const [i, matched] of planEmbeddingReuse(stored, into, c => `${c.chunk_source}\0${c.chunk_text}`).reuse) {
    into[i].embedding = matched.embedding as Float32Array;
    into[i].token_count = matched.token_count ?? undefined;
    if (matched.model) into[i].model = matched.model;
    // The stored row already holds exactly what this chunk would insert (same
    // index, identity, vector, recorded input and text hash, no image or
    // multimodal vector the insert would drop), so it can stay in place.
    const row = matched as Chunk;
    reused.set(i, recorded.get(row.chunk_index) != null && textOnly.has(row.chunk_index) && identity(row) === identity(into[i]) ? row.id : null);
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
      if (identity(row) === identity(into[i]!)) reused.set(i, row.id);
    }
  }
  return reused;
}
