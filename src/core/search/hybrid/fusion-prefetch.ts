/**
 * hybridSearch pipeline stage (#6721): the three reads fusion makes about its
 * candidate rows, issued together.
 *
 * `fuseArms` used to await, one after another: the unverified-extraction marks
 * (before RRF, `stampUnverifiedExtractions`), the chunk embeddings for the
 * cosine re-score (after RRF, `cosineReScore`) and the generated-page rows for
 * provenance demotion (in the identity boosts, `applyGeneratedDemotion`). Each
 * reads by ids that are known as soon as the arms return: RRF keeps one row per
 * candidate chunk (rrf-page-fusion.ts `accumulateRrf`) and the re-score and the
 * post-fusion stages neither add nor drop rows, so the page ids and chunk ids
 * the three reads need are the candidates'. On a pooled Postgres that is two
 * round trips fewer in series on every hybrid search.
 *
 * Each read is started here and consumed at the same step as before, so the
 * marks still land before RRF and every boost runs in its old order. A read
 * keeps its rejection for its consumer, whose own catch decides what a failure
 * means (as before); the no-op handler attached here only keeps a rejection
 * that no consumer awaits from being reported as unhandled.
 */
import type { BrainEngine } from '../../engine.ts';
import type { PageReadPolicy, SearchResult } from '../../types.ts';
import { type GeneratedPageRow, readGeneratedPages } from '../provenance-demotion.ts';

export interface FusionPrefetch {
  marks?: Promise<Map<number, { unverified: boolean; status: string }>>;
  embeddings?: Promise<Map<number, Float32Array>>;
  generated?: Promise<GeneratedPageRow[]>;
}

function started<T>(read: () => Promise<T>): Promise<T> {
  const promise = (async () => read())();
  promise.catch(() => {});
  return promise;
}

/**
 * Starts the three reads for `candidates` (every arm's rows). `embeddingColumn`
 * is the column the cosine re-score hydrates, or null when it will not run or
 * splits rows across two spaces (cross-modal `both`); it then reads on its own.
 */
export function prefetchFusionReads(engine: BrainEngine, candidates: SearchResult[], policy: PageReadPolicy | undefined,
  embeddingColumn: string | null): FusionPrefetch {
  const pageIds = [...new Set(candidates.map((r) => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))];
  const chunkIds = [...new Set(candidates.map((r) => r.chunk_id).filter((id): id is number => id != null))];
  return {
    ...(pageIds.length > 0 ? {
      marks: started(() => engine.getUnverifiedExtractionPageIds(pageIds, policy)),
      generated: started(() => readGeneratedPages(engine, pageIds)),
    } : {}),
    ...(embeddingColumn && chunkIds.length > 0 ? { embeddings: started(() => engine.getEmbeddingsByChunkIds(chunkIds, embeddingColumn)) } : {}),
  };
}
