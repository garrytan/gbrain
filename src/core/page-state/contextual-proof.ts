import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from './types.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { acceptedEmbeddingInputHashes, embeddingInputHash, isContextualMode } from '../embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from './projections.ts';

export async function reconcileContextualEmbeddingInputs(tx: BrainEngine, snapshot: PageSnapshot,
  mode: string, corpusGeneration: string | null): Promise<number> {
  const target = await embeddingWriteTarget(tx);
  const chunks = await tx.getChunks(snapshot.page.slug, { sourceId: snapshot.page.source_id, includeUnsealed: true });
  const provenance = embeddingInputContext(target, snapshot.page.title, corpusGeneration, chunks);
  const recorded = new Map((await tx.executeRaw<{ id: number; embedding_input_hash: string | null }>(
    'SELECT id,embedding_input_hash FROM content_chunks WHERE page_id=$1', [snapshot.page.id])).map(r => [Number(r.id), r.embedding_input_hash]));
  const stale = chunks.filter(chunk => !chunk.embedding_is_null).filter(chunk => {
    const hash = recorded.get(Number(chunk.id)) ?? null;
    return hash === null ? isContextualMode(mode) || chunk.model !== target.provenanceModel
      : !acceptedEmbeddingInputHashes(provenance, mode, chunk).includes(hash);
  }).map(chunk => Number(chunk.id));
  if (stale.length) await tx.executeRaw(`UPDATE content_chunks SET ${quoteIdentifier(target.column.name)}=NULL,
    embedded_at=NULL,embedded_text_hash=NULL,embedding_input_hash=NULL WHERE page_id=$1 AND id=ANY($2::int[])`, [snapshot.page.id, stale]);
  const staleIds = new Set(stale);
  const raw = chunks.filter(chunk => !chunk.embedding_is_null && !staleIds.has(Number(chunk.id))
    && recorded.get(Number(chunk.id)) == null);
  if (raw.length) await tx.executeRaw(`UPDATE content_chunks c SET embedding_input_hash=proof.hash
    FROM unnest($2::int[],$3::text[]) AS proof(id,hash) WHERE c.page_id=$1 AND c.id=proof.id`,
  [snapshot.page.id, raw.map(chunk => Number(chunk.id)), raw.map(chunk => embeddingInputHash(provenance, 'none', chunk))]);
  return stale.length;
}
