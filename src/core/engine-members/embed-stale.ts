/**
 * The `gbrain embed --stale` statements of BrainEngine (SQL in engine-sql/embed-stale-work.ts and
 * engine-sql/embedding-provenance.ts): the reads and writes embedding-readiness.ts, embedding-invalidation.ts,
 * embed-stale.ts and content-drift-sweep.ts ran through executeRaw. `BrainEngine` extends this interface.
 */
import type * as EmbedStaleWork from '../engine-sql/embed-stale-work.ts';

export interface EmbedStaleMembers {
  /** Live, non-embed_skip pages of archived sources with embedding work (embedding-readiness.ts countArchivedEmbeddingWork). */
  countArchivedEmbeddingWork(opts: EmbedStaleWork.ArchivedEmbeddingWorkOpts): Promise<number>;
  /** How many pages still wait for a text projection under `scope`. */
  countEmbedPendingProjections(scope: EmbedStaleWork.PendingProjectionScope): Promise<number>;
  /** The first `limit` pages of `scope` in active sources still waiting for a text projection, by page id. */
  listEmbedPendingProjections(scope: EmbedStaleWork.PendingProjectionScope, limit: number): Promise<EmbedStaleWork.PendingProjectionPage[]>;
  /** The next `limit` pages of `scope` in active sources after `afterPageId` that a projection rebuild can build, by page id. */
  listEmbedProjectionRepairPages(scope: EmbedStaleWork.PendingProjectionScope, afterPageId: number, limit: number): Promise<EmbedStaleWork.ProjectionRepairPage[]>;
  /** Whether the page with this id keeps its body in segments. */
  readPageIsSegmented(pageId: number): Promise<boolean>;
  /** Whether an embedded chunk sits on a page whose signature drifted (embedding-invalidation.ts hasSignatureDrift). */
  hasEmbeddingSignatureDrift(opts: EmbedStaleWork.SignatureDriftOpts): Promise<boolean>;
  /** Whether every visible chunk of the page holds a vector in `column` that is current for `model` at `dims` wide (engine-sql/embedding-provenance.ts; the embedding signature stamp). */
  readPageProvenanceComplete(slug: string, sourceId: string, model: string, dims: number | null, column: string): Promise<boolean>;
  /** The chunk indexes of the page's live body with no vector in `column`, ascending (embed-stale.ts embedStaleForSource). */
  listUnembeddedChunkIndexes(slug: string, sourceId: string, column: string): Promise<number[]>;
  /** The characters a backfill would embed: live pages' chunks without a vector (every chunk with `all`) and, unless `all`, live chunkless pages' bodies (embed-consent.ts). */
  sumEmbedBackfillChars(sourceId: string | null, all: boolean): Promise<EmbedStaleWork.EmbedBackfillChars>;
  /** The content-drift sweep's cursor row, created with `initial` when absent and locked for the transaction; run it on the transaction handle. */
  lockContentDriftState(key: string, initial: string): Promise<string | null>;
  /** One content-drift batch: drop the vectors of the next chunk rows whose text changed since they were embedded; run it on the transaction handle. */
  invalidateContentDriftChunks(window: EmbedStaleWork.ContentDriftChunkWindow): Promise<EmbedStaleWork.ContentDriftChunkResult>;
}
