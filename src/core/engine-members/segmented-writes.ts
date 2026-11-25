/**
 * The segmented write's statements of BrainEngine that ran through `executeRaw` and are typed members now
 * (engine-sql/segmented-rewrite.ts). `BrainEngine` extends this interface, so the member set is the union. The chunk probes,
 * the stale-chunk retirement and the retired-vector read are the members of engine-sql/segmented-writes.ts.
 */
import type * as SegmentedRewriteSql from '../engine-sql/segmented-rewrite.ts';

export interface SegmentedWriteMembers {
  /** The page a live fence rewrite of a segmented page reads, deleted or not, with its tags in byte order; null for no page. */
  readSegmentedRewritePage(pageId: number): Promise<SegmentedRewriteSql.SegmentedRewritePageRow | null>;
  /** Sets the page's deleted_at back to `deletedAt` after a rewrite of a soft-deleted page. Write. */
  restorePageDeletedAt(pageId: number, deletedAt: string): Promise<void>;
  /** Page `pageId`'s storage class, generation, title, type and body flags, deleted or not; null for no page. */
  readSegmentedLivePage(pageId: number): Promise<SegmentedRewriteSql.SegmentedLivePageRow | null>;
}
