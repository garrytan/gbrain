/**
 * The page-list, slug-source, access and storage-shelf reads of BrainEngine (SQL and contracts in engine-sql/list-reads.ts).
 * `BrainEngine` extends this interface.
 */
import type { PageReadPolicy } from '../types.ts';
import type { OwnerOnlyForm } from '../access/owner-only.ts';
import type { BeliefCoverageEventRow } from '../engine-sql/belief-ledger.ts';
import type { AttendanceWindowRow, CardFindQuery, CardHitRow, CardListQuery, ChatCensusRow, PredictionLedgerEvent, PredictionQuery, PredictionRow, TakeGradeRow, TakeHorizonRow, WhoCanReadRow, CardRow, CompanyBrainEvidenceRows, MentionScanLinkRow, MentionScanPageRow, PageBodyRow, PageSourceIdRow, RetypeProbeQuery, ShelfPageRow, SourceIdScope, TargetProbeSqlRow } from '../engine-sql/list-reads.ts';

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
  /** The shelf cards ranked for a phrase, best first, at most 500 (`gbrain storage find`). */
  findCardRows(q: CardFindQuery): Promise<CardHitRow[]>;
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
  /** The attendance-repair preview reads: the database clock in whole milliseconds as text; */
  readClockMillisText(): Promise<string>;
  /** the listed live, never-archived sources with their incarnations; */
  listLiveSourceIncarnations(ids: readonly string[]): Promise<Array<{ id: string; incarnation: string }>>;
  /** and the scan window: the source's pages after a slug in byte order, soft-deleted ones marked, at most `limit`. */
  readAttendanceWindow(sourceId: string, afterSlug: string, limit: number): Promise<AttendanceWindowRow[]>;
  /** Up to two distinct live pages in another source that carry an exact email as a page alias (open-loop counterparty). */
  listEmailAliasPages(aliasNorm: string, sourceId: string): Promise<Array<{ slug: string; source_id: string }>>;
  /** The page-upload reads: the upload session a principal began under a client request id (raw columns), or null; */
  readUploadSessionByRequest(principalKind: string, principalId: string, clientRequestId: string): Promise<Record<string, unknown> | null>;
  /** and a source's incarnation as text with its archive flag, or null. */
  readSourceIncarnationArchived(sourceId: string): Promise<{ incarnation: string; archived: boolean } | null>;
  /** The enabled labelled-only members, by id in byte order. */
  listEnabledLabelledOnlyMemberIds(): Promise<string[]>;
  /** Per source, its live chat pages the private-page rule admits (when asked) and their distinct channels, by source id in byte order. */
  readChatCensusRows(sourceIds: readonly string[], chatTypes: readonly string[], dmTypes: readonly string[], hidePrivate: boolean): Promise<ChatCensusRow[]>;
  /** The who-can-read report (commands/access.ts whoCanRead): the pages at a slug with their owner-only flag in the given form; */
  readWhoCanReadRows(slug: string, sourceId: string | undefined, form: OwnerOnlyForm): Promise<WhoCanReadRow[]>;
  /** whether the member-access rule for an identity, and the folder rules for a satisfied set, admit a page under the current caller record; */
  readPageAccessAllowed(sourceId: string, slug: string, identity: readonly string[]): Promise<boolean>;
  readPageFolderRulesAllowed(sourceId: string, slug: string, satisfied: readonly string[]): Promise<boolean>;
  /** and how many of a page's folder rule ids are not raw-only rules of the source. */
  countLineageClosingRules(ruleIds: readonly string[], sourceId: string): Promise<number>;
  /** The completed keys of one op checkpoint row, or null (the connector DB cursor read). */
  readOpCheckpointCompletedKeys(op: string, fingerprint: string): Promise<unknown[] | null>;
  /** The forecast journal (forecast-journal.ts): the predictions the filters admit, by (source, slug, row); */
  readForecastPredictions(q: PredictionQuery): Promise<PredictionRow[]>;
  /** the ledger events that date them; */
  readPredictionLedgerEvents(sourceIds: readonly string[], slugs: readonly string[]): Promise<PredictionLedgerEvent[]>;
  /** the takes' horizons (all when null) and their newest grades; */
  readTakeHorizonRows(takeIds: readonly number[] | null): Promise<TakeHorizonRow[]>;
  readLatestTakeGrades(takeIds: readonly number[]): Promise<TakeGradeRow[]>;
  /** and a source's belief-ledger coverage events of its current incarnation, by id (belief/coverage-report.ts). */
  readBeliefCoverageEvents(sourceId: string): Promise<BeliefCoverageEventRow[]>;
}
