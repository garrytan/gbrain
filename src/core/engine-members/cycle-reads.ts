/**
 * The cycle, belief and sync reads of BrainEngine that ran through `executeRaw` and are typed members now
 * (engine-sql/cycle-reads.ts). `BrainEngine` extends this interface, so the member set is the union.
 */
import type * as CycleReadsSql from '../engine-sql/cycle-reads.ts';

export interface CycleReadMembers {
  /** The per-source cycle's listing instant (UTC ISO with microseconds, held back for a transaction still open on another connection), or null. */
  readCycleListingInstant(): Promise<string | null>;
  /** Up to `limit` live pages of the source after the cursor `(since, slug)` by `(updated_at, slug bytes)`; every page when `since` is null. */
  listSourceChangedPagesAfter(sourceId: string, since: string | null, slug: string, limit: number): Promise<CycleReadsSql.SourceChangedPageRow[]>;
  /** The soft-deleted page of the source whose origin is `path` (or whose slug is `slug` when it has none): the latest deletion first, the lowest id among equals. */
  readSoftDeletedPageAtOrigin(sourceId: string, path: string, slug: string): Promise<CycleReadsSql.SoftDeletedPageRow | null>;
  /** The live pages of the source whose origin is `sourcePath`, by slug bytes. */
  listLivePagesAtOrigin(sourceId: string, sourcePath: string): Promise<CycleReadsSql.LivePageAtOriginRow[]>;
  /** The facts about `slug`, the links of page `pageId` and the aliases of `slug`: what a carry would move. */
  countPageCarryRows(sourceId: string, slug: string, pageId: number): Promise<CycleReadsSql.PageCarryCounts>;
  /** The source's open lifetimes with no page at their slug and, when `deep`, events naming a lifetime that does not exist: the count and the first `limit` by slug then lifetime bytes. */
  listOrphanLifetimes(sourceId: string, limit: number, deep: boolean): Promise<CycleReadsSql.OrphanLifetimeSamples>;
}
