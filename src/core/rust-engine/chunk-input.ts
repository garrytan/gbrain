/**
 * What a chunk write sends to the store. PGLite's `upsertChunks` normalises each chunk before it writes it (an empty
 * string or zero becomes null, the model defaults to the embedding model the brain is configured for, the text is
 * scrubbed for JSON); the store keeps what it is given, so the same normalisation happens here, once, and a chunk
 * reads back with the same fields. This is a helper, not a member: `store-members/` modules export only members.
 */
import { sanitizeText } from '../batch-rows.ts';
import { normalizeEngineColumn } from '../search/embedding-column.ts';
import type { ChunkInput, ResolvedColumn } from '../types.ts';
import { capabilityMissing } from './errors.ts';
import { refuseMember } from './store-members/common.ts';
import type { StoreBrain } from './store.ts';

/** The model PGLite stamps on a chunk that names none: the gateway's, else the brain's `embedding_model` config, else `unconfigured`. */
async function defaultModel(brain: StoreBrain): Promise<string> {
  try {
    const gateway = await import('../ai/gateway.ts'); // engine-dynamic-import-ok
    const model = gateway.getEmbeddingModelProvenance();
    if (model) return model;
  } catch { /* the config row decides */ }
  return (await brain.getConfig('embedding_model')) || 'unconfigured';
}

/**
 * The model label a chunk write under the caller's `embeddingColumn` stamps on a chunk that names none, or `undefined`
 * for the brain's default (PGLite's upsertChunks: `writeCol.embeddingModel || ...`). The store keeps one vector column,
 * `embedding`, of the configured width (`embedding_dimensions`, 1536 when unset), so only a descriptor of that column is
 * served: any other name, a `halfvec`, or another width refuses `engine_capability_missing`.
 */
export async function textColumnModel(brain: StoreBrain, member: string, embeddingColumn: unknown): Promise<string | undefined> {
  if (embeddingColumn === undefined) return undefined;
  const column = normalizeEngineColumn(embeddingColumn as ResolvedColumn);
  // The store's own reading of the width (chunks.rs embedding_dimensions): a positive integer, else 1536.
  const configured = (await brain.getConfig('embedding_dimensions'))?.trim() ?? '';
  const width = /^\d+$/.test(configured) && Number(configured) > 0 ? Number(configured) : 1536;
  if (column.name !== 'embedding' || column.type !== 'vector' || column.dimensions !== width) {
    refuseMember(member, `option embeddingColumn ${column.name} ${column.type}(${column.dimensions}); the store keeps embedding vector(${width}) only`);
  }
  return column.embeddingModel || undefined;
}

/**
 * The chunks as PGLite would store them, ready for the store. A text vector travels as a number array with the hash
 * of the input it was computed from; an image vector never gets here (the member refuses it first). A vector needs a
 * model label: with no chunk model and no configured one, the write throws, as PGLite's does.
 */
export async function prepareChunks(brain: StoreBrain, chunks: ChunkInput[], columnModel?: string): Promise<Record<string, unknown>[]> {
  if (chunks.length === 0) return [];
  // A registered embedding column changes which column and model PGLite writes; the store has neither.
  for (const key of ['search_embedding_column', 'embedding_columns']) {
    if (await brain.getConfig(key)) throw capabilityMissing('chunks', `upsertChunks (config ${key} routes chunk writes to another embedding column)`);
  }
  const fallback = columnModel || await defaultModel(brain);
  if (fallback === 'unconfigured' && chunks.some((chunk) => chunk.embedding && !chunk.model)) {
    throw new Error('Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.');
  }
  return chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    chunk_text: sanitizeText(chunk.chunk_text),
    chunk_source: chunk.chunk_source ?? null,
    model: chunk.model || fallback,
    token_count: chunk.token_count || null,
    language: chunk.language || null,
    symbol_name: chunk.symbol_name || null,
    symbol_type: chunk.symbol_type || null,
    start_line: chunk.start_line ?? null,
    end_line: chunk.end_line ?? null,
    parent_symbol_path: chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0 ? chunk.parent_symbol_path : null,
    doc_comment: chunk.doc_comment || null,
    symbol_name_qualified: chunk.symbol_name_qualified || null,
    modality: chunk.modality ?? 'text',
    projected_byte_start: chunk.projected_byte_start ?? null,
    projected_byte_end: chunk.projected_byte_end ?? null,
    embedding: chunk.embedding ? Array.from(chunk.embedding) : null,
    embedding_input_hash: chunk.embedding ? chunk.embedding_input_hash ?? null : null,
  }));
}
