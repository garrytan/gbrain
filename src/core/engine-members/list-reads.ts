/**
 * The page-list, slug-source, access and storage-shelf reads of BrainEngine (SQL and contracts in engine-sql/list-reads.ts).
 * `BrainEngine` extends this interface.
 */
import type { PageReadPolicy } from '../types.ts';
import type { CardListQuery, CardRow, CompanyBrainEvidenceRows, PageSourceIdRow, ShelfPageRow, TargetProbeSqlRow } from '../engine-sql/list-reads.ts';

export interface ListReadMembers {
  /** The sources holding a live page at `slug`, by id in byte order (page-ref ambiguity, quarantine clear, --grammar). */
  listLiveSlugSourceIds(slug: string): Promise<string[]>;
  /** Every live copy of `slug` the read policy admits, as `{ id, source_id }`, by source id (relational chain anchors). */
  resolveChainAnchorRows(slug: string, policy: PageReadPolicy): Promise<PageSourceIdRow[]>;
  /** Every readable live copy of `slug` with its chunk, vector, projection and chunker facts, by source id (`explain_target`). */
  probeTargetRows(slug: string, policy: PageReadPolicy, chunkManifest?: boolean): Promise<TargetProbeSqlRow[]>;
  /** The company-brain evidence picks of a source: first ownership link, first decision supersession, first live page. */
  readCompanyBrainEvidenceRows(sourceId: string): Promise<CompanyBrainEvidenceRows>;
  /** The storage shelf's card count and one page of its cards, by slug in byte order (`gbrain storage list`). */
  listCardRows(query: CardListQuery): Promise<{ total: number; cards: CardRow[] }>;
  /** Every live page of a source as `{ slug, title, type, frontmatter }`, by slug in byte order (the shelf read). */
  readShelfPageRows(sourceId: string): Promise<ShelfPageRow[]>;
}
