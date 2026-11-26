
import type { ReflexPageMatch, ReflexPageRow, ReflexScope } from '../engine-sql/reflex-reads.ts';

export interface ReadStatementMembers {
  /** The retrieval reflex's alias live recheck: the live pages in the scope at `slugs`, as (slug, source_id), in no set order. */
  readReflexLiveKeys(scope: ReflexScope, slugs: readonly string[]): Promise<Array<{ slug: string; source_id: string }>>;
  /** The retrieval reflex's candidate pages in the scope that `match` names, with the bounded body prefix (engine-sql/reflex-reads.ts). */
  readReflexPages(scope: ReflexScope, match: ReflexPageMatch): Promise<ReflexPageRow[]>;
  // `gbrain extract takes` reads and delete (engine-sql/takes-reads.ts).
  /** The id of the live page `slug` in `sourceId`, or null. */
  readLivePageIdBySlug(slug: string, sourceId: string): Promise<number | null>;
  /** The id of the page's take at `rowNum`, or null. */
  findTakeId(pageId: number, rowNum: number): Promise<number | null>;
}
