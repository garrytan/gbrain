import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from './types.ts';
import { acceptedEmbeddingInputHashes, embeddingInputHash, isContextualMode } from '../embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from './projections.ts';

export async function reconcileContextualEmbeddingInputs(tx: BrainEngine, snapshot: PageSnapshot,
  mode: string, corpusGeneration: string | null): Promise<number> {
  const target = await embeddingWriteTarget(tx);
  const chunks = await tx.getChunks(snapshot.page.slug, { sourceId: snapshot.page.source_id, includeUnsealed: true });
  const provenance = embeddingInputContext(target, snapshot.page.title, corpusGeneration, chunks);
  const recorded = new Map((await tx.readChunkInputHashes(Number(snapshot.page.id))).map(r => [Number(r.id), r.embedding_input_hash]));
  const stale = chunks.filter(chunk => !chunk.embedding_is_null).filter(chunk => {
    const hash = recorded.get(Number(chunk.id)) ?? null;
    return hash === null ? isContextualMode(mode) || chunk.model !== target.provenanceModel
      : !acceptedEmbeddingInputHashes(provenance, mode, chunk).includes(hash);
  }).map(chunk => Number(chunk.id));
  if (stale.length) await tx.clearChunkEmbeddingsByIds(Number(snapshot.page.id), target.column, stale);
  const staleIds = new Set(stale);
  const raw = chunks.filter(chunk => !chunk.embedding_is_null && !staleIds.has(Number(chunk.id))
    && recorded.get(Number(chunk.id)) == null);
  if (raw.length) await tx.writeChunkInputHashes(Number(snapshot.page.id), raw.map(chunk => Number(chunk.id)),
    raw.map(chunk => embeddingInputHash(provenance, 'none', chunk)));
  return stale.length;
}
