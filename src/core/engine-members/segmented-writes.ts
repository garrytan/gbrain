/**
 * The segmented write path's page, chunk and setting statements: a streamed segmented import, a re-chunk
 * (`gbrain reindex --segmented`), a segmented fence rewrite and a segmented embed (SQL in engine-sql/segmented-writes.ts;
 * the Rust store serves them through store-members/page-body.ts). `BrainEngine` extends this interface.
 */
import type { ResolvedColumn } from '../types.ts';
import type {
  LiveEmbedSegmentRow, OccurrenceChunkRow, RechunkCandidateScope, SegmentChunkRowRow, SegmentedGenerationLock,
  SegmentedLivePageRow, SegmentedRechunkPageRow, SegmentedRewritePageRow, SegmentedStaleRowRow, SegmentedStaleRowsOpts,
  SegmentedVectorInstall,
} from '../engine-sql/segmented-writes.ts';

export interface SegmentedWriteMembers {
  /** A segmented write: page `pageId`'s storage class, generation, title, type and body flags, deleted or not, or null (engine-sql/segmented-writes.ts). */
  readSegmentedLivePage(pageId: number): Promise<SegmentedLivePageRow | null>;
  /** gbrain reindex --segmented: ids of sealed, live segmented pages below `chunkerVersion` in the scope, in (source_id, slug) order (engine-sql/segmented-writes.ts). */
  listSegmentedRechunkCandidates(chunkerVersion: number, scope?: RechunkCandidateScope): Promise<number[]>;
  /** gbrain reindex --segmented: segmented page `pageId` with its revision, seal and updated_at in microseconds, deleted or not, or null (engine-sql/segmented-writes.ts). */
  readSegmentedRechunkPage(pageId: number): Promise<SegmentedRechunkPageRow | null>;
  /** gbrain reindex --segmented: the visible chunk rows of `occurrences`, by occurrence then local ordinal (engine-sql/segmented-writes.ts). */
  listOccurrenceChunks(pageId: number, occurrences: readonly number[]): Promise<OccurrenceChunkRow[]>;
  /** gbrain reindex --segmented: the transaction's gbrain.materializing_revision setting (null never set, '' cleared) (engine-sql/segmented-writes.ts). */
  readMaterializingRevision(): Promise<string | null>;
  /** gbrain reindex --segmented: set gbrain.materializing_revision for the transaction; a flip of the page at that revision keeps it and its seal (engine-sql/segmented-writes.ts). */
  setMaterializingRevision(revision: string): Promise<void>;
  /** gbrain reindex --segmented: set page `pageId`'s updated_at to `updatedUs` microseconds after the epoch, exactly (engine-sql/segmented-writes.ts). */
  restorePageUpdatedAt(pageId: number, updatedUs: string): Promise<void>;
  /** A fence rewrite: page `pageId` with its body columns, contextual stamp and tags, deleted or not, or null (engine-sql/segmented-writes.ts). */
  readSegmentedRewritePage(pageId: number): Promise<SegmentedRewritePageRow | null>;
  /** A fence rewrite: set page `pageId`'s deleted_at back to `deletedAt` (engine-sql/segmented-writes.ts). */
  restorePageDeletedAt(pageId: number, deletedAt: string): Promise<void>;
  /** A retained-generation rewrite: page `pageId`'s body columns, row-locked for the rest of the transaction, or null (engine-sql/segmented-writes.ts). */
  lockSegmentedGenerationPage(pageId: number): Promise<SegmentedGenerationLock | null>;
  /** A retained-generation rewrite: give generation `generation` manifest rows of its own, the later part of shared rows staged under `stagingId` (engine-sql/segmented-writes.ts). */
  splitManifestGeneration(pageId: number, generation: number, stagingId: string): Promise<void>;
  /** A retained-generation rewrite: publish the rows staged under `stagingId`, the rebuilt ones covering exactly `generation` (engine-sql/segmented-writes.ts). */
  publishRebuiltGeneration(pageId: number, generation: number, stagingId: string): Promise<void>;
  /** A retained-generation rewrite: set content_hash and body_bytes of the segmented version rows at `generation` (engine-sql/segmented-writes.ts). */
  setSegmentedVersionHash(pageId: number, generation: number, contentHash: string, bodyBytes: number): Promise<void>;
  /** A segmented embed: whether the page at `sourceId`/`slug` is segmented, live and in a live source, sealed or not (engine-sql/segmented-writes.ts). */
  hasLiveSegmentedPage(sourceId: string, slug: string): Promise<boolean>;
  /** A segmented embed: a sealed page's live rows and those without a vector in `column` (engine-sql/segmented-writes.ts). */
  countSegmentedEmbedRows(pageId: number, column: string): Promise<{ total: number; stale: number }>;
  /** A segmented embed: a sealed page's live rows without a vector in `column`, newest first, keyset by chunk_index (engine-sql/segmented-writes.ts). */
  listSegmentedStaleRows(pageId: number, column: string, opts: SegmentedStaleRowsOpts): Promise<SegmentedStaleRowRow[]>;
  /** A segmented embed: the recorded embedding input of the page's live rows at `chunkIndexes` (engine-sql/segmented-writes.ts). */
  readSegmentChunkInputHashes(pageId: number, chunkIndexes: readonly number[]): Promise<Array<{ chunk_index: number; embedding_input_hash: string | null }>>;
  /** A segmented embed: install vectors on the live rows whose text and recorded input still match; returns how many took one (engine-sql/segmented-writes.ts). */
  installSegmentedVectors(pageId: number, column: ResolvedColumn, model: string | null, vectors: readonly SegmentedVectorInstall[]): Promise<number>;
  /** A segmented embed: the page's live manifest rows, newest first (engine-sql/segmented-writes.ts). */
  listLiveEmbedSegments(pageId: number): Promise<LiveEmbedSegmentRow[]>;
  /** A segmented embed: a sealed page's live rows of one occurrence with their recorded inputs, in chunk_index order (engine-sql/segmented-writes.ts). */
  listSegmentChunkRows(pageId: number, occurrenceId: number): Promise<SegmentChunkRowRow[]>;
}
