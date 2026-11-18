/**
 * What a chunk write sends to the store. PGLite's `upsertChunks` normalises each chunk before it writes it (an empty
 * string or zero becomes null, the model defaults to the embedding model the brain is configured for, the text is
 * scrubbed for JSON); the store keeps what it is given, so the same normalisation happens here, once, and a chunk
 * reads back with the same fields. This is a helper, not a member: `store-members/` modules export only members.
 */
import { sanitizeText } from '../batch-rows.ts';
import type { ChunkInput } from '../types.ts';
import { capabilityMissing } from './errors.ts';
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

/** The chunks as PGLite would store them, ready for the store. Vectors never get here (the member refuses them first). */
export async function prepareChunks(brain: StoreBrain, chunks: ChunkInput[]): Promise<Record<string, unknown>[]> {
  if (chunks.length === 0) return [];
  // A registered embedding column changes which column and model PGLite writes; the store has neither.
  for (const key of ['search_embedding_column', 'embedding_columns']) {
    if (await brain.getConfig(key)) throw capabilityMissing('chunks', `upsertChunks (config ${key} routes chunk writes to another embedding column)`);
  }
  const fallback = await defaultModel(brain);
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
  }));
}
