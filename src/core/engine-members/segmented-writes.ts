/**
 * The segmented write's statements of BrainEngine that ran through `executeRaw` and are typed members now
 * (engine-sql/segmented-rewrite.ts). `BrainEngine` extends this interface, so the member set is the union.
 */
import type * as SegmentedRewriteSql from '../engine-sql/segmented-rewrite.ts';

export interface SegmentedWriteMembers {
  /** The page a live fence rewrite of a segmented page reads, deleted or not, with its tags in byte order; null for no page. */
  readSegmentedRewritePage(pageId: number): Promise<SegmentedRewriteSql.SegmentedRewritePageRow | null>;
  /** Sets the page's deleted_at back to `deletedAt` after a rewrite of a soft-deleted page. Write. */
  restorePageDeletedAt(pageId: number, deletedAt: string): Promise<void>;
  /** The live segmented page at `sourceId`/`slug` a projection builds; null when there is none. */
  readSegmentedProjectionPage(sourceId: string, slug: string): Promise<SegmentedRewriteSql.SegmentedProjectionPageRow | null>;
  /** The members of `occurrenceIds`, in their order, that have a chunk row of the page at or below `generation`. */
  listChunkedOccurrences(pageId: number, occurrenceIds: readonly number[], generation: number): Promise<number[]>;
  /** Whether the page stores a chunk row that `generation` (live occurrences `live`) does not hold. */
  hasStaleSegmentChunks(pageId: number, generation: number, live: readonly number[]): Promise<boolean>;
  /** Deletes up to `maxRows` of those stale chunk rows; how many it deleted. Write; run it under the page lock. */
  retireStaleSegmentChunks(pageId: number, generation: number, live: readonly number[], maxRows: number): Promise<number>;
  /** Page `pageId`'s storage class, generation, title, type and body flags, deleted or not; null for no page. */
  readSegmentedLivePage(pageId: number): Promise<SegmentedRewriteSql.SegmentedLivePageRow | null>;
  /** The visible chunk rows of `occurrences` on the page that store a vector in `column`, in chunk_index order, with the page fields vector reuse checks. The Rust store keeps one column, `embedding`. */
  readRetiredChunkVectors(pageId: number, occurrences: readonly number[], column: string): Promise<SegmentedRewriteSql.RetiredChunkVectorRow[]>;
}
