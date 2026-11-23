/**
 * The page-list, slug-source, access and storage-shelf reads of BrainEngine (SQL and contracts in engine-sql/list-reads.ts).
 * `BrainEngine` extends this interface.
 */
import type { PageReadPolicy } from '../types.ts';
import type { CardListQuery, CardRow, CompanyBrainEvidenceRows, MentionScanLinkRow, MentionScanPageRow, PageBodyRow, PageSourceIdRow, RetypeProbeQuery, ShelfPageRow, SourceIdScope, TargetProbeSqlRow } from '../engine-sql/list-reads.ts';

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
  /** The removed-path lookups of a git sync (sync-git.ts resolveSlugsForRemovedPaths): the first live page recording a path, by (source, slug); */
  readFirstLiveSlugAtPath(path: string): Promise<string | null>;
  /** the paths several live pages of a source record, with their slugs by byte; */
  listPathTwinSlugs(sourceId: string, paths: readonly string[]): Promise<Array<{ source_path: string; slugs: string[] }>>;
  /** and the live pages at these slugs with their recorded file, by (source, slug). */
  listLiveSlugOrigins(slugs: readonly string[], sourceId?: string): Promise<Array<{ slug: string; source_path: string | null }>>;
  /** The schema-pack previews: how many live pages a retype rule matches and its first ten slugs by byte; */
  probeRetypeRows(query: RetypeProbeQuery): Promise<{ count: number; sample: string[] }>;
  /** the page-to-alias and page-to-link candidates of a type, by slug in byte order, at most `limit`; */
  listAliasCandidatePages(type: string, sourceId: string, limit: number): Promise<PageBodyRow[]>;
  listLinkCandidatePages(type: string, sourceId: string | undefined, limit: number): Promise<PageBodyRow[]>;
  /** and the type-orphan review: the live page count per stored type in scope, and the untyped or undeclared pages by (source, slug). */
  countLivePagesByType(scope: SourceIdScope): Promise<Array<{ type: string | null; n: string }>>;
  listTypeOrphanRows(scope: SourceIdScope, undeclared: readonly string[], limit: number): Promise<Array<{ slug: string; source_id: string; type: string | null }>>;
  /** The stale-mention scan: the first `limit` live pages holding a mention link (by slug, id) with their text, and their mention links. */
  readStaleMentionScan(limit: number): Promise<{ pages: MentionScanPageRow[]; links: MentionScanLinkRow[] }>;
}
