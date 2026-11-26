/**
 * The read-command, embedding-catalog, entity, takes, trust-tier and memory-mutation statements of BrainEngine.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AbandonedTakeRow, HeldFenceTakeRow, HeldFenceTakeSpec, HolderResolvedTakeRow, McpResolvedSpec, PageTierRef, PurgeTakesSpec, TakePreimage, TakePreimageRead, TakeTrustRef, TakesLeavingFence } from '../engine-sql/takes-reads.ts';
import type { AmendmentNotAppliedRow, AmendmentsNotAppliedSpec, BeliefHistoryRowQuery, CoreEditNoticeRow, CorePageRow, CorePageRowSpec, CursorEditionRow, PageIdRef, PageVersionEditionRow, TrustScanRow, TrustScanRowSpec, TrustScanTable, UnscannedTrustSpec, ValidTimeIdentityRow, ValidTimeIdentitySpec, ValidTimePickSpec } from '../engine-sql/trust-tier-reads.ts';
import type { BodyManifestMeta, BodyManifestOutline, BodyManifestRow, ExportPageKey, ExportPageKeyQuery, ExportPageRow, ExportWithdrawalRow, NormalizedFenceLines, SegmentedPageHead } from '../engine-sql/export-reads.ts';
import type { BriefEntityPageOpts, BriefEntityPageRow, ReflexPageMatch, ReflexPageRow, ReflexScope } from '../engine-sql/reflex-reads.ts';
import type * as BriefReadsSql from '../engine-sql/brief-reads.ts';
import type * as ConceptRebuildSql from '../engine-sql/concept-rebuild.ts';
import type * as EmbeddingCatalogSql from '../engine-sql/embedding-catalog.ts';
import type * as ChronicleReadsSql from '../engine-sql/chronicle-reads.ts';
import type { EntityAnchoredPages, EntityCardMatch, EntityCardRow, ExtractionLagCounts, ExtractionLagQuery, FuzzyEntityCandidateRow, IgnoredLabelPageRow, InboundLinkerCountRow, LivePageTypeRow, MentionDueQuery, MentionIndexRecount, MentionIndexStatusRow, NameVariantCandidateQuery, NameVariantCandidateRow, PrefixCandidateQuery, PrefixCandidateRow, PrefixTitleRow, ResolverPrivacy, RetirementHopRow, RetirementPrivacy, SiblingCandidateQuery, SiblingCandidateRow, SlugPatternPageRow, TextMentionPageRow, TrigramCandidateQuery, TrigramCandidateRow, VariantPageRow, NameVariantCardCandidateRow } from '../engine-sql/entity-reads.ts';
import type { ExactBatchRow, ExactScanOpts } from '../search/exact-scan.ts';
import type { ExactIdentityRow, ExactIdentityStatementOpts } from '../engine-sql/exact-identity.ts';
import type { ExactRescanChunkRow, ExactSnippetChunkRow, ExactSnippetKey, ExtractionPendingRow, FenceOverlayIncomingRow, FenceOverlayRow, FenceRowKey, FenceRowTrust, HeldFenceCellKey, HeldFenceCellRow, LongPageSizeRow, PageTypeProbe, RankCoverageRow, UnattributedFactRow, WantedPageRow } from '../engine-sql/cli-reads-ops.ts';
import type { FactReadableSpec, FactWithdrawalClaim, FactWithdrawalClaimSpec, ForgetTargetRow, ForgetTargetSpec, LinkedFactCopiesSpec, LinkedFactCopy, OwnerReachSpec, SourceWriteRow } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import type { PrivateOnlySlugScope } from '../engine-sql/page-visibility.ts';
import type { FrontmatterWhere } from '../search/frontmatter-where.ts';
import type { RankCoverageStatementOpts, RankEntitiesStatementOpts, RankEntityRow } from '../engine-sql/graph-rank.ts';
import type { WithdrawalDiscoveryKind, WithdrawalDiscoveryRead, WithdrawalDiscoveryRows } from '../engine-sql/withdrawal-discovery.ts';
import type { PageKeyRef } from '../engine-sql/trust-tier-reads.ts';
import type * as GraduationCatalogSql from '../engine-sql/graduation-catalog.ts';
import type { ExtractReceiptSlot, ExtractRollupDelta } from '../engine-sql/extract-bookkeeping.ts';
import type { HorizonBasis, HorizonScanRow, TakeGrade, TakeGradeFilter, TakeGradeKey, TakeGradeRow, TakeHorizonRow, TakeNudgeFilter, TakeNudgeInput, TakeNudgeRow } from '../engine-sql/takes-reads.ts';
import type { PageQuoteTier, PageQuoteTierSpec } from '../engine-sql/trust-tier-reads.ts';
import type { ProposeTakesCandidateScope, ProposeTakesPageRow, TakeProposalClaim, TakeProposalInsert, TakeProposalPageKey, TakeProposalRow, TakeProposalTombstone } from '../engine-sql/take-proposals.ts';
import type { PurgedSlugStoreRows } from '../engine-sql/purge-slug-stores.ts';
import type { WriteRequest } from '../persistence/model.ts';

export interface ReadStatementMembers {
  /** revert_version: the whole row of version `versionId` of page `pageId`, or null. Reads page_versions. */
  readPageVersionRow(versionId: number, pageId: number): Promise<import('../page-state/version-types.ts').PageVersion | null>;
  // Read-command statements (engine-sql/cli-reads-ops.ts). Each runs the statement its op ran through executeRaw.
  /**
   * One exact-phrase scan batch: the next `batchPages` in-scope pages after `afterPageId`, in id order, with their
   * matches or the reason their text could not be read. Null when the phrase has no searchable word. Postgres runs it
   * with JIT off under a `timeoutMs` statement deadline; a timeout throws the statement-timeout error.
   */
  scanExactBatch(opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number): Promise<ExactBatchRow[] | null>;
  /** search's type-filter probe (engine-sql/cli-reads-ops.ts probePageTypes); Postgres runs it with JIT off, unprepared. */
  probePageTypes(sets: readonly (readonly string[])[], scope: PageReadScope): Promise<PageTypeProbe>;
  /** The long-page size preflight (engine-sql/cli-reads-ops.ts): each served page's body length; `includeTimeline` counts the timeline. */
  readLongPageSizes(ids: readonly number[], scope: PageReadScope, opts: { includeTimeline: boolean }): Promise<LongPageSizeRow[]>;
  /** The first live page after `afterPageId` in id order, in any source, or null. */
  nextLivePageAfter(afterPageId: number): Promise<{ id: number; slug: string; source_id: string } | null>;
  /** gbrain export: the next 256 live page keys after page id `q.afterId`, in id order, within the filters (engine-sql/export-reads.ts). */
  listExportPageKeys(q: ExportPageKeyQuery): Promise<ExportPageKey[]>;
  /** gbrain export: the size in bytes of the source's withdrawal ledger, which the export caps (engine-sql/export-reads.ts). */
  readExportWithdrawalLedgerBytes(sourceId: string): Promise<number>;
  /** gbrain export: the source's withdrawals and purge tombstones, by visibility, fact hash and subject (engine-sql/export-reads.ts). */
  listExportWithdrawals(sourceId: string): Promise<ExportWithdrawalRow[]>;
  /** gbrain export: the live pages among `ids` with their tags in tag order, in no set order (engine-sql/export-reads.ts). */
  readExportPageRows(ids: readonly string[]): Promise<ExportPageRow[]>;
  /** gbrain export: each body and timeline lower-cased with whitespace runs made one space, line by line (engine-sql/export-reads.ts). */
  normalizeFenceLines(bodies: readonly string[], timelines: readonly string[]): Promise<NormalizedFenceLines[]>;
  /** A segmented body read: page `pageId`'s body columns and revision, deleted or not, or undefined (engine-sql/export-reads.ts). */
  readSegmentedPageHead(pageId: number): Promise<SegmentedPageHead | undefined>;
  /** A segmented body read: a generation's published manifest rows in seq order, `generation` null for the live one (engine-sql/export-reads.ts). */
  readBodyManifestRows(pageId: number, generation: number | null): Promise<BodyManifestRow[]>;
  /** A segmented body read: the entry state and protected regions of the named occurrences in one published generation (engine-sql/export-reads.ts). */
  readBodyManifestMeta(pageId: number, occurrenceIds: readonly number[], generation: number): Promise<BodyManifestMeta[]>;
  /** A segmented outline read: the facts slots and stored outline of the named occurrences in one published generation (engine-sql/export-reads.ts). */
  readBodyManifestOutline(pageId: number, occurrenceIds: readonly number[], generation: number): Promise<BodyManifestOutline[]>;
  /** A segmented body read: the seqs of one published generation's rows that end at a forced cut, in seq order (engine-sql/export-reads.ts). */
  listForcedCutSeqs(pageId: number, generation: number): Promise<number[]>;
  /** A segmented body read: the seq of one published generation's row holding stored byte `byteOffset` (the last row starting at or before it), or null (engine-sql/export-reads.ts). */
  readManifestSeqAt(pageId: number, generation: number, byteOffset: number): Promise<number | null>;
  /** A segmented body read: body_bytes of the newest segmented version that references `generation` and records a size, or null (engine-sql/export-reads.ts). */
  readSegmentedVersionBodyBytes(pageId: number, generation: number): Promise<number | null>;
  /** gbrain export: the sources with an access policy, in id order, whose folder rulebooks an export carries (engine-sql/export-reads.ts). */
  listAccessPolicySourceIds(): Promise<string[]>;
  /** whois candidates by title, slug basename, alias and email (engine-sql/exact-identity.ts), at most `opts.limit`. */
  listExactIdentityCandidates(opts: ExactIdentityStatementOpts): Promise<ExactIdentityRow[]>;
  /** rank_entities rows (engine-sql/graph-rank.ts); Postgres bounds the statement by `timeoutMs`, and a timeout throws the statement-timeout error. */
  rankEntities(opts: RankEntitiesStatementOpts, timeoutMs: number): Promise<RankEntityRow[]>;
  /**
   * rank_entities' remote coverage for one source (engine-sql/graph-rank.ts `rankCoverageStatement`): whether a page the
   * caller may read still owes link extraction, and, with `mentionTypes`, a mention pass. Postgres bounds it by `timeoutMs`.
   */
  readRankCoverage(opts: RankCoverageStatementOpts, timeoutMs: number): Promise<RankCoverageRow>;
  /** search_exact: per snippet key, its visible stored chunk when the chunk holds the snippet, by 1-based key position; `excludePrivate` drops the caller's private pages. */
  readExactSnippetChunks(keys: readonly ExactSnippetKey[], opts: { excludePrivate: boolean }): Promise<ExactSnippetChunkRow[]>;
  /** search_exact: the visible, safe-fenced chunks of `pageIds` by page id then chunk index; `excludePrivate` drops the caller's private pages. */
  listExactRescanChunks(pageIds: readonly number[], opts: { excludePrivate: boolean }): Promise<ExactRescanChunkRow[]>;
  /** GST-2891: the fence cells among `keys` held from the current world-only fact reader (eligibility/fence-overlay.ts heldRowSql), one row per distinct held cell. */
  listHeldFenceCells(keys: readonly HeldFenceCellKey[]): Promise<HeldFenceCellRow[]>;
  /** #5575 ENG-1: the fence overlay's read of one page's incoming world fence rows (eligibility/fence-overlay.ts loadFenceChunkOverlay), one row per incoming row in order; `hideHeld` adds heldRowSql for the caller in context. */
  readFenceOverlayRows(page: { sourceId: string; slug: string }, incoming: readonly FenceOverlayIncomingRow[], opts: { hideHeld: boolean }): Promise<FenceOverlayRow[]>;
  /** #5575 37-1/37-2/A5: the newest live fact at each fence row key (eligibility/stamp.ts applyFenceRowTrust): tier, activation flag, pending supersede ref. */
  listFenceRowTrust(keys: readonly FenceRowKey[]): Promise<FenceRowTrust[]>;
  /** Unverified auto-extracted pages visible in scope (`sourceIds` wins over `sourceId`), newest first. */
  listExtractionPendingPages(opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }): Promise<ExtractionPendingRow[]>;
  /** Active facts with no entity in `sourceIds`, newest id first; `worldOnly` keeps world facts, `excludePrivateProvenance` drops private-provenance facts. */
  listUnattributedFacts(opts: { sourceIds: string[]; worldOnly: boolean; excludePrivateProvenance: boolean; limit: number; offset: number }): Promise<UnattributedFactRow[]>;
  /** Missing link targets in scope, most-referenced first, with their total; `excludePrivate` drops private origins and private bare-name matches. */
  listWantedPages(opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number }): Promise<{ total: number; rows: WantedPageRow[] }>;

  // Embedding catalog (engine-sql/embedding-catalog.ts): what the embedding commands read about the vector columns. Postgres
  // and PGLite read their catalog; the Rust engine reads its per-vector records (an empty store has no column yet).
  /** A `content_chunks` vector column: whether it exists and its width (null when the type is not a vector type). */
  readChunkVectorColumn(column: string): Promise<EmbeddingCatalogSql.ChunkVectorColumn>;
  /** The stored embedding identity (model and width of `content_chunks.embedding`); null when the brain has no vector column. Postgres and PGLite throw when the width is unknown. */
  readEmbeddingIdentity(): Promise<EmbeddingCatalogSql.EmbeddingIdentity | null>;
  /** The tables that carry an `embedding` vector column, in PRIMARY_EMBEDDING_TABLES order. */
  listEmbeddingStores(): Promise<EmbeddingCatalogSql.EmbeddingStore[]>;
  /** Whether any row of `store` holds a vector. */
  hasStoredVectors(store: EmbeddingCatalogSql.EmbeddingStore): Promise<boolean>;
  /** Whether any chunk holds an image vector (`embedding_image`): search's cross-modal image arm reads only that column. */
  hasChunkImageVectors(): Promise<boolean>;
  /** Per source with chunks, the chunk count and how many hold a vector in a fixed column (`embedding_image`, `embedding_multimodal`), in source id order. */
  countChunkVectorCoverage(column: EmbeddingCatalogSql.FixedVectorColumn): Promise<EmbeddingCatalogSql.ChunkVectorCoverageRow[]>;
  /** doctor embedding_column_registry: the type of each named `content_chunks` column that exists (`vector(1024)`), in no set order. */
  readChunkColumnTypes(columns: string[]): Promise<EmbeddingCatalogSql.ChunkColumnType[]>;
  /** doctor embedding_column_registry: every `content_chunks` row and the percent holding a value in `column` (pct null with no row). Throws when the column is missing. */
  countChunkColumnCoverage(column: string): Promise<EmbeddingCatalogSql.ChunkColumnCoverage>;
  /** The ids among `ids` whose page frontmatter holds every `where` key (search's frontmatter check on finished rows), in no set order. */
  filterPageIdsByFrontmatter(ids: number[], where: FrontmatterWhere): Promise<number[]>;

  // Entity and mention reads (engine-sql/entity-reads.ts): the statements the CLI ran through executeRaw.
  /** The newest mention pass time (ISO, UTC, whole seconds) over every source or one source; null when no pass ran. */
  readMentionLastPass(sourceId?: string | null): Promise<string | null>;
  /** The mention-index status rows of `sourceIds` (mentions/coverage.ts), in no defined order; a source with no row has none. */
  readMentionIndexStatus(sourceIds: readonly string[]): Promise<MentionIndexStatusRow[]>;
  /** The live (not soft-deleted) pages of one source: mention coverage's pending count for a source with no status row. */
  countLivePagesInSource(sourceId: string): Promise<number>;
  /** Live pages of one source written at or after `since` (`-infinity` for no bound) and not scanned at their content or `mentionVersion`. */
  countMentionDueSince(sourceId: string, since: string, mentionVersion: number): Promise<number>;
  /** Writes a coverage recount on a source's status row while its fingerprint is `expectedFingerprint`; no row, no write. */
  recountMentionIndexStatus(sourceId: string, recount: MentionIndexRecount): Promise<void>;
  /**
   * Live pages due for the mention pass (no mention state, or state behind the page's content or `mentionVersion`), in
   * one source or every source; `aliases` also counts pages of those types whose derived aliases are behind.
   */
  countPagesDueForMentions(q: MentionDueQuery): Promise<number>;
  /**
   * Live pages of one source of the given types whose lowercased title is `subject` or ends with `: ` and it, by slug,
   * at most `limit`, with frontmatter `identity` as text. `excludePrivate` and `excludeQuarantined` filter candidates.
   */
  readIdentitySiblingCandidates(sourceId: string, q: SiblingCandidateQuery): Promise<SiblingCandidateRow[]>;
  /** mentions/siblings.ts siblingCanonical: the live pages of the source at `slugs`, with frontmatter identity as text. */
  readSiblingGroupRows(sourceId: string, slugs: readonly string[], opts?: { excludePrivate?: boolean }): Promise<SiblingCandidateRow[]>;
  /** The first of `slugs` holding a live page that is (`retired: true`), is not (`false`) or is either (omitted) a retired page (`retiredPageSql`). */
  findExactSlug(sourceId: string, slugs: readonly string[], opts?: { retired?: boolean }): Promise<string | null>;
  /** The slugs among `slugs` holding a live page, retired or not, each once, in no set order; `limit: 2` stops at two. */
  readLiveSlugs(sourceId: string, slugs: readonly string[], opts?: { limit?: 2 }): Promise<string[]>;
  /** The live pages among `slugs` with their types that the resolver privacy admits, each once, in no set order. */
  readLivePageTypes(sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy): Promise<LivePageTypeRow[]>;
  /** The resolver's title-similarity candidates (pg_trgm `%` on the lowered title, or the slug fragment), best first. */
  readTrigramCandidates(sourceId: string, q: TrigramCandidateQuery): Promise<TrigramCandidateRow[]>;
  /** The resolver's prefix candidates (slug LIKE a pattern, or any of the patterns), most connected first. */
  readPrefixCandidates(sourceId: string, q: PrefixCandidateQuery): Promise<PrefixCandidateRow[]>;
  /** The distinct entity directories of the resolver's live, non-retired prefix pages, at most two. */
  readPrefixDirs(sourceId: string, patterns: readonly string[]): Promise<string[]>;
  /** The resolver's live, non-retired prefix pages whose title is `title` ignoring case, at most three. */
  readPrefixTitleMatches(sourceId: string, patterns: readonly string[], title: string): Promise<PrefixTitleRow[]>;
  /** The resolver's live, non-retired pages among `slugs` that `privacy` admits, by slug, at most five. */
  readNamedEntitySlugs(sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy): Promise<string[]>;
  /**
   * Up to five live, unretired pages of one source whose lowercased title is pg_trgm-similar to `title` or whose slug
   * contains `fragment`, scored by the greater pg_trgm similarity, best first then by slug (the fuzzy entity lookup).
   */
  findFuzzyEntityCandidates(sourceId: string, title: string, fragment: string): Promise<FuzzyEntityCandidateRow[]>;
  /** At most two of `slugs` holding a live page of the source (the exact-basename step of entity resolution). */
  findExactBasenameCandidates(sourceId: string, slugs: readonly string[]): Promise<string[]>;
  /**
   * One hop of a retirement chain (entities/resolve.ts `followRetirement`): the live page at `slug`, whether it is
   * retired (`retiredPageSql`) and its trimmed `superseded_by` (else `merged_into`) target; null when no live page sits
   * there or the `privacy` page policy, rendered in the caller's access record, hides it.
   */
  readRetirementHop(sourceId: string, slug: string, privacy: RetirementPrivacy): Promise<RetirementHopRow | null>;
  /**
   * The entity card's candidate rows among the live pages of a source: the name arm (exact lower-cased title, a slug in
   * the list, or a slug matching the LIKE pattern) or the hydrate arm (a slug in the list), with the bounded body
   * prefix. `excludePrivate` applies the caller's page policy. No order.
   */
  readEntityCardRows(sourceId: string, match: EntityCardMatch, opts?: { excludePrivate?: boolean }): Promise<EntityCardRow[]>;
  /** Person-duplicate reads (engine-sql/entity-reads.ts): unretired pages by slug pattern, name-variant candidates, distinct inbound linkers (a page's retirement is readRetirementHop with 'none'). */
  listUnretiredPagesBySlugPattern(sourceId: string, patterns: readonly string[], limit: number): Promise<SlugPatternPageRow[]>;
  listNameVariantCandidates(sourceId: string, q: NameVariantCandidateQuery): Promise<NameVariantCandidateRow[]>;
  /** Name-variant reads under the caller's page policy (`excludePrivate`): the candidates, and the live pages at a slug list in list order. */
  listVisibleNameVariantCandidates(sourceId: string, q: NameVariantCandidateQuery, opts?: { excludePrivate?: boolean }): Promise<NameVariantCandidateRow[]>;
  readVisibleVariantPages(sourceId: string, slugs: readonly string[], opts?: { excludePrivate?: boolean }): Promise<VariantPageRow[]>;
  /** listVisibleNameVariantCandidates as entity-card rows with their probe hits (the entity card's name-variant arm). */
  listNameVariantCardCandidates(sourceId: string, q: NameVariantCandidateQuery, opts?: { excludePrivate?: boolean }): Promise<NameVariantCardCandidateRow[]>;
  countDistinctInboundLinkers(sourceIds: readonly string[], slugs: readonly string[]): Promise<InboundLinkerCountRow[]>;
  /** The link-extraction lag row (`extractionLagStatement`) under a `timeoutMs` bound (default 10 s; PGLite ignores it). */
  readExtractionLagCounts(q: ExtractionLagQuery): Promise<ExtractionLagCounts | undefined>;
  /**
   * Live pages of one source, by slug or updated since a database timestamp, that carry a privacy label gbrain does not
   * recognize and no visibility key (`ignoredPrivacyLabelSql`), at most `limit` (default 100,000), in no set order.
   */
  readIgnoredPrivacyLabelPages(sourceId: string, scope: { slugs: readonly string[] } | { since: string },
    opts?: { limit?: number; timeoutMs?: number }): Promise<IgnoredLabelPageRow[]>;
  /** The type and frontmatter of the live page at `slug` in the source, or null; `timeoutMs` bounds Postgres (default 1 s). */
  readLivePageFrontmatter(sourceId: string, slug: string, opts?: { timeoutMs?: number }): Promise<IgnoredLabelPageRow | null>;
  /** The live entity page, then up to 10 newest live pages that name it as a word or link to it (search/entity-anchor.ts). */
  readEntityAnchoredPages(sourceId: string, entitySlug: string): Promise<EntityAnchoredPages>;
  /** The title of each page id, deleted or not, in no set order. */
  readPageTitlesById(ids: readonly number[]): Promise<Array<{ id: number; title: string }>>;
  /** `{ has_visual }` of the image page row at `slug` when it is sealed past the safe-chunk fence, else null (importImageFile). */
  readImageSealProbe(sourceId: string, slug: string): Promise<{ has_visual: boolean } | null>;
  /** The stored chunker version of the page row with the id (live, deleted or segmented), or null when no row has it. */
  readPageChunkerVersion(pageId: number): Promise<{ chunker_version: number | null } | null>;
  /** Up to 10 newest live pages of the source under a literal slug prefix, no question, synthesis or pinned-question page. */
  readPrefixAnchoredPages(sourceId: string, prefix: string): Promise<Array<{ id: number; slug: string }>>;
  /** The slugs whose every in-scope page row (live unless `includeDeleted`) the caller's page policy hides, in no set order. */
  readPrivateOnlySlugs(slugs: readonly string[], scope?: PrivateOnlySlugScope, opts?: { includeDeleted?: boolean }): Promise<string[]>;
  /** The live pages at `slugs` in `sourceIds` with title, type, frontmatter and `COALESCE(effective_date, updated_at)` as `date` (the entity card's text mentions). */
  readTextMentionPages(sourceIds: readonly string[], slugs: readonly string[]): Promise<TextMentionPageRow[]>;
  /** The retrieval reflex's alias live recheck: the live pages in the scope at `slugs`, as (slug, source_id), in no set order. */
  readReflexLiveKeys(scope: ReflexScope, slugs: readonly string[]): Promise<Array<{ slug: string; source_id: string }>>;
  /** The retrieval reflex's candidate pages in the scope that `match` names, with the bounded body prefix (engine-sql/reflex-reads.ts). */
  readReflexPages(scope: ReflexScope, match: ReflexPageMatch): Promise<ReflexPageRow[]>;
  /** The proactive brief's live pages of the source at `slugs` that the privacy and the eligibility admit, in no set order. */
  readBriefEntityPages(sourceId: string, slugs: readonly string[], opts: BriefEntityPageOpts): Promise<BriefEntityPageRow[]>;
  /** The brief's world-visible, eligible meeting pages of `sourceIds` whose `start` text lies in [startFrom, startTo] (engine-sql/brief-reads.ts). */
  readBriefMeetingPages(sourceIds: readonly string[], startFrom: string, startTo: string, eligibility?: BriefReadsSql.BriefReadEligibility): Promise<BriefReadsSql.BriefMeetingPageRow[]>;
  /** The brief's alias rows of the source at `emails`, each with its live page that the read floor and eligibility admit. */
  readBriefEmailAliasPages(sourceId: string, emails: readonly string[], eligibility?: BriefReadsSql.BriefReadEligibility): Promise<BriefReadsSql.BriefEmailAliasPageRow[]>;
  /** The brief's active, world-visible, eligible facts among `factIds` whose provenance the caller may read. */
  readBriefWorldFacts(factIds: readonly number[], eligibility?: BriefReadsSql.BriefReadEligibility): Promise<BriefReadsSql.BriefWorldFactRow[]>;
  /** The brief's counterparty page for the edit arm, or null; its body is null past `maxBytes`. */
  readBriefEditPage(sourceId: string, slug: string, maxBytes: number, opts: BriefReadsSql.BriefEditReadOpts): Promise<BriefReadsSql.BriefEditPageRow | null>;
  /** The brief's newest timeline entry of the page recorded and dated since `since`, or null. */
  readBriefTimelineEntry(pageId: number, since: string, opts: BriefReadsSql.BriefEditReadOpts): Promise<BriefReadsSql.BriefTimelineEntryRow | null>;
  /** The brief's newest `limit` revisions of the page snapshotted since `since`, newest first; a body is null past `maxBytes`. */
  readBriefPageVersions(pageId: number, since: string, maxBytes: number, limit: number): Promise<BriefReadsSql.BriefPageVersionRow[]>;

  // Group D (takes, salience and code-edge reads): the counts and lists doctor, onboarding and repair read.
  /** Takes more than 0.001 off the 0.05 weight grid, of all takes. */
  countOffGridTakeWeights(): Promise<{ off_grid: number; total: number }>;
  /** How many takes the brain holds. */
  countTakes(): Promise<number>;
  /** The takes a fact purge removes: consolidated from a purged fact, or echoing the purged claim. */
  planFactPurgeTakes(spec: PurgeTakesSpec): Promise<Array<{ id: number; page_id: number }>>;
  /** The page's stored takes, row number to claim. */
  listTakeRowsForPage(pageId: number): Promise<Array<{ row_num: number; claim: string }>>;
  /** The stored provenance (`facts.source`) of these facts of the source. */
  listFactProvenance(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>>;
  /** The takes generation adapter's before-states: the takes a write deletes (`gone`) or replaces at their row number, by row number. */
  readTakePreimages(read: TakePreimageRead): Promise<Array<{ preimage: TakePreimage; gone: boolean }>>;
  /** `gbrain takes grades`: each live take's newest grade_takes verdict, filtered, newest first (engine-sql/takes-reads.ts). */
  listLatestTakeGrades(filter: TakeGradeFilter): Promise<TakeGradeRow[]>;
  /** grade_takes: the cached verdict at `key`, or null (engine-sql/takes-reads.ts). */
  readTakeGrade(key: TakeGradeKey): Promise<TakeGrade | null>;
  /** grade_takes: cache a verdict; a row already at its key stays (engine-sql/takes-reads.ts). */
  insertTakeGrade(row: TakeGradeKey & TakeGrade & { gradedAt?: string; waveVersion?: string }): Promise<void>;
  /** grade_takes: drop the cached verdict at `key` (engine-sql/takes-reads.ts). */
  deleteTakeGrade(key: TakeGradeKey): Promise<void>;
  /** grade_takes' managed resolve: the live page whose take at `rowNum` still holds `claim`, or null (engine-sql/takes-reads.ts). */
  readLiveTakePage(at: { pageId: number; rowNum: number; claim: string }): Promise<{ slug: string; source_id: string } | null>;
  /** `gbrain takes horizon` and the forecast journal (take_horizons; SQL in engine-sql/takes-reads.ts): a take's claim, or null. */
  readTakeClaim(takeId: number): Promise<string | null>;
  /** Set or replace a take's horizon, stamped now; a missing take refuses. */
  upsertTakeHorizon(h: { takeId: number; claimSha256: string; horizonDate: string; basis: HorizonBasis }): Promise<void>;
  /** Remove a take's horizon; true when it had one. */
  deleteTakeHorizon(takeId: number): Promise<boolean>;
  /** The horizons of the takes (null: all), by take id, with each take's claim now. */
  listTakeHorizons(takeIds: readonly number[] | null): Promise<TakeHorizonRow[]>;
  /** The takes on live pages of a source (null: all), by id, with their horizons. */
  listHorizonScanRows(sourceId: string | null): Promise<HorizonScanRow[]>;
  /** `gbrain calibration --undo-wave` (SQL in engine-sql/takes-reads.ts): the takes a wave's verdicts applied to. */
  listWaveAppliedTakeIds(waveVersion: string): Promise<number[]>;
  /** Clear the resolutions `resolvedBy` wrote on the takes; their count (a dry run counts only). */
  revertWaveTakeResolutions(spec: { takeIds: readonly number[]; resolvedBy: string; dryRun: boolean }): Promise<number>;
  /** Mark a wave's applied verdicts unapplied; their count (a dry run counts only). */
  unapplyWaveTakeGrades(spec: { waveVersion: string; dryRun: boolean }): Promise<number>;
  /** Delete a wave's take_nudge_log rows; their count (a dry run counts only). */
  purgeTakeNudgesByWave(spec: { waveVersion: string; dryRun: boolean }): Promise<number>;
  /** Log a fired nudge at a take or a take proposal; its id. */
  insertTakeNudge(n: TakeNudgeInput): Promise<number>;
  /** A source's take_nudge_log rows, oldest first, narrowed by take, proposal, pattern and wave: what insertTakeNudge's confirming read lists. */
  listTakeNudges(f: TakeNudgeFilter): Promise<TakeNudgeRow[]>;
  /** The take proposal queue (SQL in engine-sql/take-proposals.ts): pending proposals, newest first (limit clamped to 1..500). */
  listPendingTakeProposals(opts: { sourceId?: string; limit: number }): Promise<TakeProposalRow[]>;
  /** One proposal by id, whatever its status; with `sourceId`, another source's proposal reads as null. */
  readTakeProposal(id: number, sourceId?: string): Promise<TakeProposalRow | null>;
  /** Claim a pending proposal for an accept (status accepted, acted now); null when it is not pending. */
  claimTakeProposal(id: number, actedBy: string): Promise<TakeProposalClaim | null>;
  /** The claim of an accepted proposal whose take is not recorded yet, or null. */
  readStrandedTakeProposalClaim(id: number): Promise<TakeProposalClaim | null>;
  /** Put a claimed, unrecorded proposal back to pending while it is still the claim made at `claimedAt` (ISO, ms). */
  releaseTakeProposalClaim(id: number, claimedAt: string | null): Promise<void>;
  /** Record the take row an accepted proposal became. */
  setTakeProposalPromotedRow(id: number, rowNum: number): Promise<void>;
  /** Reject a pending proposal; false when it is not pending. */
  rejectTakeProposal(id: number, actedBy: string): Promise<boolean>;
  /** Whether any proposal (tombstones too) is stored under the propose_takes page key: the page is a cache hit. */
  takeProposalCached(key: TakeProposalPageKey): Promise<boolean>;
  /** The claims an operator rejected on a page, at any content. */
  listRejectedTakeProposalClaims(sourceId: string, pageSlug: string): Promise<string[]>;
  /** Store a proposal or tombstone unless that claim is stored under its page key; the new id, or null. */
  insertTakeProposal(p: TakeProposalInsert): Promise<number | null>;
  /** A source's failure tombstones (claims starting with `prefix`, never acted on), by page slug. */
  listTakeProposalTombstones(sourceId: string, prefix: string): Promise<TakeProposalTombstone[]>;
  /** Delete a source's failure tombstones, of one page or all; the pages released, sorted, each once. */
  deleteTakeProposalTombstones(sourceId: string, prefix: string, slug?: string): Promise<string[]>;
  /** The pages propose_takes reads, newest first (live, not receipts, atoms, generated or guest pages). */
  listProposeTakesCandidatePages(scope: ProposeTakesCandidateScope): Promise<ProposeTakesPageRow[]>;
  /** The one JSON document an op checkpoint row holds (`completed_keys[0]`), or null. */
  readOpCheckpointDoc(op: string, fingerprint: string): Promise<unknown>;
  /** Store one JSON document as an op checkpoint row (`completed_keys = [doc]`). */
  writeOpCheckpointDoc(op: string, fingerprint: string, doc: unknown): Promise<void>;
  /** Every write request admitted under `requestId`, whichever principal admitted it. */
  listWriteRequestsByRequestId(requestId: string): Promise<WriteRequest[]>;
  /** The page an extract receipt's slug holds, live or a tombstone (SQL in engine-sql/extract-bookkeeping.ts), or null. */
  readExtractReceiptSlot(sourceId: string, slug: string): Promise<ExtractReceiptSlot | null>;
  /** Whether the page's chunks are sealed at `safeVersion` with its current text; null for no page or a NULL answer. */
  readExtractReceiptSeal(sourceId: string, slug: string, safeVersion: number): Promise<boolean | null>;
  /** Add one extract event's deltas to its `(kind, source_id, day)` extract_rollup_7d row (the pre-v141 statement on request). */
  upsertExtractRollupDay(d: ExtractRollupDelta, opts?: { preV141?: boolean }): Promise<void>;
  /**
   * Delete the rows of purged `slugs` in `sourceId` from the stores keyed to a page by slug with no foreign key (take
   * proposals, open loops, core-edit notices, page and slug aliases, rename history; SQL in
   * engine-sql/purge-slug-stores.ts). `ifPresent` skips a store the database lacks and reports whether the secret store
   * exists. Run it on the purge transaction.
   */
  deletePurgedSlugStoreRows(sourceId: string, slugs: readonly string[], opts?: { ifPresent?: boolean }): Promise<PurgedSlugStoreRows>;
  /** The uncommitted page-level secret store occurrences of these pages (read before their rows go). */
  listPageSecretOccurrences(pageIds: readonly number[]): Promise<Array<{ id: string; page_id: number }>>;
  /** Delete the write-gate holds of purged slugs (up to each page's `deletedAt` when given) and the holds' receipts. */
  deletePurgedSlugHolds(sourceId: string, pages: ReadonlyArray<{ slug: string; id?: number | null; deletedAt?: string | null }>): Promise<{ write_gate_holds: number; write_gate_receipts: number }>;
  /**
   * The held-concept rebuild's reads and link carry (SQL in engine-sql/concept-rebuild.ts). A held concept is a
   * synthesized concept tombstone whose needs_rederive mark is open at its delete and on which no owner purge is owed.
   * readHeldConcept returns its delete instant (epoch microseconds as text); isConceptStillHeld and lockHeldConcept
   * (FOR UPDATE, on the purge transaction) check one delete instant.
   */
  readHeldConcept(pageId: number): Promise<{ deleted_us: string } | null>;
  isConceptStillHeld(pageId: number, deletedUs: string): Promise<boolean>;
  lockHeldConcept(pageId: number, sourceId: string, slug: string, deletedUs: string): Promise<boolean>;
  /** How many of `members` are live at their named revision (FOR SHARE on the publication transaction). */
  lockLiveConceptMembers(sourceId: string, members: ReadonlyArray<{ slug: string; revision: string }>): Promise<number>;
  /** The live pages among `slugs`, with their revisions. */
  listLiveConceptMemberRevisions(sourceId: string, slugs: readonly string[]): Promise<Array<{ slug: string; revision: string }>>;
  /** Links into the page from other live pages, except concept provenance, as JSON rows of the carried columns. */
  listConceptIncomingLinks(pageId: number): Promise<unknown[]>;
  /** Point `incoming` (from listConceptIncomingLinks of `oldId`) at the live page at `slug`; null when no page is live there. */
  carryConceptIncomingLinks(sourceId: string, slug: string, incoming: readonly unknown[], oldId: number): Promise<{ id: number; carried: number } | null>;
  /** When a tombstone's `hours` recovery window ends (ISO, UTC) and whether it has; null for a live or missing page. */
  readTombstoneWindow(pageId: number, hours: number): Promise<{ until: string; past: boolean } | null>;
  /** What on or about the concept row synthesis did not write (the stated kinds), with its bounded lead and segmented mark. */
  readConceptStatedKinds(pageId: number, sourceId: string, slug: string, lists: ConceptRebuildSql.StatedKindLists): Promise<ConceptRebuildSql.ConceptStatedRow>;
  /** Who may read the page row with the id, live or deleted, as the read predicate decides it; null when no row has it. */
  readRebuildAccess(pageId: number): Promise<ConceptRebuildSql.RebuildAccess | null>;
  /** Every held concept, by source then slug, with whether it is private and whether a live member page is. */
  readHeldConceptRows(): Promise<ConceptRebuildSql.HeldConceptRow[]>;
  /**
   * The engine graduation inventory's catalog reads (SQL in engine-sql/graduation-catalog.ts). listCatalogRelations
   * returns the SQL relations of the current schema, or on a store with no relations (the Rust engine) its keyspace
   * list; readCatalogSchemaVersion the schema version the brain records (null when none); listCatalogForeignKeys the
   * foreign key constraints, refused by name on a store that keeps no list of its references.
   */
  listCatalogRelations(): Promise<GraduationCatalogSql.CatalogRelations>;
  readCatalogSchemaVersion(): Promise<number | null>;
  listCatalogForeignKeys(): Promise<GraduationCatalogSql.CatalogForeignKey[]>;
  /** The page's stored takes by row number while its take_fence generation is held `fence_absent`; none otherwise. */
  listHeldFenceTakeRows(spec: HeldFenceTakeSpec): Promise<HeldFenceTakeRow[]>;
  /** The take at a page's row number with its claim and stored trust tier; null when the page has none there. */
  readTakeRowTrust(pageId: number, rowNum: number): Promise<{ id: number; claim: string; trust_tier: string } | null>;
  /** A take by id with its page's source, its trust tier and origin, whether it is active and its page quarantined. */
  readTakeTrustRef(id: number): Promise<TakeTrustRef | null>;
  // `gbrain extract takes` reads and delete (engine-sql/takes-reads.ts).
  /** The id of the live page `slug` in `sourceId`, or null. */
  readLivePageIdBySlug(slug: string, sourceId: string): Promise<number | null>;
  /** Page `pageId`'s source, slug and stored trust tier, deleted or not, or null. */
  readPageTierRef(pageId: number): Promise<PageTierRef | null>;
  /** The pages among `ids`, deleted or not, with source, slug and stored trust tier, in no set order. */
  readPageTierRows(ids: readonly number[]): Promise<Array<PageTierRef & { id: number }>>;
  /** Whether page `pageId`'s frontmatter has the top-level key `key`, deleted or not. */
  pageHasFrontmatterKey(pageId: number, key: string): Promise<boolean>;
  /** The ids of the page's takes that leave its fence (TakesLeavingFence), in no set order. */
  listTakeIdsLeavingFence(pageId: number, fence: TakesLeavingFence): Promise<number[]>;
  /** Before-states by row number of the page's takes `ids` (`gone`) and of those an incoming row would overwrite. */
  listTakePreimages(pageId: number, ids: readonly number[], incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>): Promise<Array<{ preimage: TakePreimage; gone: boolean }>>;
  /** Delete the takes `ids`, whatever their page, with their synthesis evidence; an empty list deletes nothing. */
  deleteTakesByIds(ids: readonly number[]): Promise<void>;
  /** The id of the page's take at `rowNum`, or null. */
  findTakeId(pageId: number, rowNum: number): Promise<number | null>;
  /** One page batch of `chronicle-backfill`: chronicle-shaped live pages after `q.afterId`, in id order (engine-sql/chronicle-reads.ts). */
  readChronicleBackfillBatch(q: ChronicleReadsSql.ChronicleBackfillBatchQuery): Promise<ChronicleReadsSql.ChronicleBackfillPage[]>;
  /** The distinct holders of the page's takes at `rowNums`, in no set order. */
  listTakeHoldersAtRows(pageId: number, rowNums: readonly number[]): Promise<string[]>;
  /** Resolved takes stamped `mcp:` by the MCP server, in the caller's source and holder scope. */
  countMcpResolvedTakes(spec: McpResolvedSpec): Promise<number>;
  /** A holder's 25 heaviest active resolved takes (the calibration pattern drill-down). */
  listTopResolvedTakesForHolder(holder: string): Promise<HolderResolvedTakeRow[]>;
  /** The five oldest abandoned high-conviction takes (the calibration abandoned-threads card). */
  listAbandonedTakes(): Promise<AbandonedTakeRow[]>;
  /** Live pages of the sources with an inactive or `superseded by #` take, by page id. */
  listTakeSupersessionCandidates(sourceIds: readonly string[]): Promise<Array<{ id: number; source_id: string; slug: string }>>;
  /** The row number and stored `superseded_by` of every take on a page (engine-sql/takes-reads.ts). */
  listTakePointers(pageId: number): Promise<Array<{ row_num: number; superseded_by: number | null }>>;
  /** The `old_row` / `new_row` outcome text of a page's committed `takes_supersede` requests (engine-sql/takes-reads.ts). */
  listTakeSupersedeReceipts(sourceId: string, pageId: number, slug: string): Promise<Array<{ old_row: string | null; new_row: string | null }>>;
  /** Sets one take's stored `superseded_by` (null clears it), nothing else (engine-sql/takes-reads.ts). */
  setTakeSupersededBy(pageId: number, rowNum: number, supersededBy: number | null): Promise<void>;
  /** repair accepted-takes: accepted take `forget` proposals with the `takes_remove` request that applied each, by proposal id (engine-sql/takes-reads.ts). */
  listAcceptedTakeRemovals(sourceIds: readonly string[], proposalId: number | null): Promise<import('../engine-sql/takes-reads.ts').AcceptedTakeRemoval[]>;
  /** The id and stored trust tier of the take in one row of a page, or null (engine-sql/takes-reads.ts). */
  readTakeRowTier(pageId: number, rowNum: number): Promise<{ id: number; trust_tier: string } | null>;
  /** Pages with an active take and no emotional weight yet, and pages with a weight. */
  countZeroWeightWithTakes(): Promise<{ zero_weight_with_takes: number; nonzero_weight: number }>;
  /** Whether the source owns an unresolved (symbol-target) code edge. */
  hasCodeEdgesSymbol(sourceId: string): Promise<boolean>;
  // Group D (trust tier reads): the stamped-tier reads of core memory, the trust scan, belief history, page history and valid time.
  /** The live `always_load` pages, by source then slug, with the trust columns a delivery read asks for. */
  listCorePageRows(spec: CorePageRowSpec): Promise<CorePageRow[]>;
  /** The unacknowledged remote-edit notices of core pages, the newest per page, by source then slug in byte order, at most 50; only `sourceIds` when not null. */
  listPendingCoreEditNotices(sourceIds: readonly string[] | null): Promise<CoreEditNoticeRow[]>;
  /** Rows of one scanned table above an id whose stored tier is listed, by id. */
  listTrustScanRows(spec: TrustScanRowSpec): Promise<TrustScanRow[]>;
  /** How many rows of one scanned table above an id (and at or below a ceiling) have a listed stored tier. */
  countUnscannedTrustRows(spec: UnscannedTrustSpec): Promise<number>;
  /** The trust scan's cursor (`op_checkpoints` trust_scan/v1): its `completed_keys` JSON, or null when there is none. */
  readTrustScanCursor(): Promise<unknown>;
  /** Replace the trust scan's cursor keys and stamp the row now. */
  writeTrustScanCursor(completedKeys: readonly unknown[]): Promise<void>;
  /** The claimed sources whose lift has not finished, by id. */
  listClaimPendingSourceIds(): Promise<string[]>;
  /** Each table the trust scan reads, with its max id (0 when empty). */
  readTrustScanCeilings(): Promise<Record<TrustScanTable, number>>;
  /** One page of a source's belief events, with the per-row visibility facts the remote filter reads. */
  readBeliefHistoryRows(spec: BeliefHistoryRowQuery): Promise<Array<Record<string, unknown>>>;
  /** The listed page lifetimes that are live and whose page passes the remote read floor. */
  listVisibleBeliefLifetimes(lifetimes: readonly string[]): Promise<string[]>;
  /** The stored snapshot tier of each listed page version, by id. */
  listVersionTrustTiers(ids: readonly number[]): Promise<Array<{ id: number; trust_tier: string | null }>>;
  /** The type and tier of the write that replaced each listed version (the next snapshot, or the live page), by id. */
  listVersionReasonWriters(ids: readonly number[]): Promise<Array<{ id: number; type: string | null; tier: string | null }>>;
  /** The source, slug and stored type of each listed page, deleted or not, by id (the GST-687 quoting reads); unknown ids answer nothing. */
  listPageRefsByIds(ids: readonly number[]): Promise<PageIdRef[]>;
  /** The stored type and tier of the listed pages by id (deleted or not), or of the live pages with a slug in the listed sources, by id (#8384 quoting). */
  listPageQuoteTiers(spec: PageQuoteTierSpec): Promise<PageQuoteTier[]>;
  /** The id and stored trust tier of each named page, deleted or not, in no set order (timeline projection). */
  listPageTrustTiersByKey(refs: readonly PageKeyRef[]): Promise<Array<{ id: number; source_id: string; slug: string; trust_tier: string | null }>>;
  /** The named pages that are live, each held FOR SHARE until the transaction ends, in no set order. */
  lockLivePagesByKey(refs: readonly PageKeyRef[]): Promise<PageKeyRef[]>;
  /** The live pages with a slug a valid-time read may follow, by source (at most six). */
  listValidTimeIdentities(spec: ValidTimeIdentitySpec): Promise<ValidTimeIdentityRow[]>;
  /** The valid-time pick over one page and its retained versions; null when the page is gone. */
  pickValidTimeEdition(spec: ValidTimePickSpec): Promise<Record<string, unknown> | null>;
  /** The amendment records dated after an edition took effect and on or before the date, by slug then source. */
  listAmendmentsNotApplied(spec: AmendmentsNotAppliedSpec): Promise<AmendmentNotAppliedRow[]>;
  /** A retained version of the page as an as-of read loads it; null when the page keeps no such version. */
  readPageVersionEdition(spec: { pageId: number; versionId: number }): Promise<PageVersionEditionRow | null>;
  /** Whether the page is still at the revision, and its newest version recorded at it; null when the page is gone. */
  readCursorEdition(spec: { pageId: number; revision: string }): Promise<CursorEditionRow | null>;
  /** Whether a purge hid the page until it is derived again (a `needs_rederive` row names it). */
  pageAwaitsRederive(pageId: number): Promise<boolean>;
  // Memory mutation reads (engine-sql/memory-mutation-reads.ts): the reads remember and forget make before admission.
  /** The source row a memory write admits against; null for an unknown id. */
  readSourceWriteRow(sourceId: string): Promise<SourceWriteRow | null>;
  /** A source's checkout path; null for an unknown id or a source with none. */
  readSourceLocalPath(sourceId: string): Promise<string | null>;
  /** The entity slug of one fact of a source; null when there is no such fact or it names none. */
  readFactEntitySlug(id: number, sourceId: string): Promise<string | null>;
  /** Whether a live page of the source among the slugs has a source file. */
  hasLiveFileBackedPage(sourceId: string, slugs: readonly string[]): Promise<boolean>;
  /** Whether the caller reads one fact under its visibility rule, a read eligibility and optionally the private-provenance policy. */
  factReadableUnder(spec: FactReadableSpec): Promise<boolean>;
  /** The stored tier of a world fact of the source a remote forget targets, under the remote provenance floor with `remoteFloor`; null when none. */
  readRemoteForgetTier(spec: { factId: number; sourceId: string; remoteFloor: boolean }): Promise<string | null>;
  /** The fact a forget names under the caller's visibility (ForgetTargetSpec); null when the caller does not see it. */
  readForgetTarget(spec: ForgetTargetSpec): Promise<ForgetTargetRow | null>;
  /** Whether one fact of a source names an unbacked entity (a name key with no live page). */
  isFactEntityUnbacked(id: number, sourceId: string): Promise<boolean>;
  /** The active copies of a fact's claim on other entities a forget would also withdraw, by id, at most five (LinkedFactCopiesSpec). */
  readLinkedFactCopies(spec: LinkedFactCopiesSpec): Promise<LinkedFactCopy[]>;
  /** Whether an active copy of a fact's claim the forget would reach fails the remote provenance floor. */
  hasHiddenFactCopy(spec: { id: number; sourceId: string }): Promise<boolean>;
  /** Whether the brain owner's own credential reaches a fact: no owned memory page, and its pages pass the owner's read rule. */
  ownerReachesFact(spec: OwnerReachSpec): Promise<boolean>;
  /** The claim a withdrawal of a fact changes (FactWithdrawalClaimSpec); null when the caller may not withdraw it. */
  readFactWithdrawalClaim(spec: FactWithdrawalClaimSpec): Promise<FactWithdrawalClaim | null>;
  /** One read withdrawal discovery makes (WithdrawalDiscoveryRead: claim keys, provenance pages, fence and chunk matches, targets). */
  readWithdrawalDiscovery<K extends WithdrawalDiscoveryKind>(read: Extract<WithdrawalDiscoveryRead, { kind: K }>): Promise<WithdrawalDiscoveryRows[K]>;
  /** The id and slug of the segmented pages among `slugs` in the source (engine-sql/withdrawal-pages.ts). */
  listSegmentedPages(sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string }>>;
  /** A fact withdrawal's page invalidation: a new knowledge revision, no text projection or embedding signature, for the inline pages among `slugs`. */
  invalidateWithdrawnPages(sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string; knowledge_revision: string }>>;
  /** Whether a withdrawal or purge tombstone covers a claim of a malformed fence, for `subject` or any subject when null (engine-sql/withdrawal-fence.ts). */
  hasWithdrawnFenceClaim(sourceId: string, claims: ReadonlyArray<{ claim: string; visibility: string | null }>, subject: string | null): Promise<boolean>;
}
