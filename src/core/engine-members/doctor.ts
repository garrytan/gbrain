/**
 * The doctor and fence census read statements of BrainEngine.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type * as AtomBacklogSql from '../engine-sql/atom-backlog.ts';
import type * as RemediationRecordsSql from '../engine-sql/remediation-records.ts';
import type * as DoctorAccSql from '../engine-sql/doctor-acc.ts';
import type * as DoctorBrainSql from '../engine-sql/doctor-brain.ts';
import type * as DoctorCheckpointsSql from '../engine-sql/doctor-checkpoints.ts';
import type * as DoctorDerivedSql from '../engine-sql/doctor-derived.ts';
import type * as DoctorFactsTrustSql from '../engine-sql/doctor-facts-trust.ts';
import type * as DoctorPagesSql from '../engine-sql/doctor-pages.ts';
import type * as DoctorPersistenceSql from '../engine-sql/doctor-persistence.ts';
import type * as DoctorReadsSql from '../engine-sql/doctor-reads.ts';
import type * as DoctorSearchSql from '../engine-sql/doctor-search.ts';
import type * as DoctorSourcesSql from '../engine-sql/doctor-sources.ts';
import type * as DoctorSyncSql from '../engine-sql/doctor-sync.ts';
import type * as DoctorTerminalSql from '../engine-sql/doctor-terminal.ts';
import type * as FenceCensusSql from '../engine-sql/fence-census.ts';
import type { FileFinding, PageFinding, ScanRecord } from '../fence-repair/census-store.ts';
import type { PageReadScope } from '../types.ts';
import type * as ProjectionBacklogSql from '../engine-sql/projection-backlog.ts';
import type * as DoctorJoinSql from '../engine-sql/doctor-join.ts';
import type * as SlugSpellingRepairSql from '../engine-sql/slug-spelling-repair.ts';

export interface DoctorMembers {
  // The legacy_slug_spellings check and gbrain repair slug-spelling (engine-sql/slug-spelling-repair.ts).
  /** The tables of `tables` that row-level security applies to for the running role, in name order. */
  readRowSecurityTables(tables: readonly string[]): Promise<string[]>;
  /** Pages of every source (deleted included) whose slug has a capital or a non-printable-ASCII character, id above `afterId`, id order, 5000 a call. */
  listSlugSpellingCandidates(afterId: number): Promise<SlugSpellingRepairSql.SlugSpellingCandidateRow[]>;
  /** The database's server encoding (`SHOW server_encoding`; the spelling key needs UTF8). */
  readServerEncoding(): Promise<string>;
  /** The tables on the search path that row-level security applies to for the running role, in name order. */
  readRowSecurityBrainTables(): Promise<string[]>;
  /** The source row the slug-spelling preview reads (checkout, incarnation, slug-root mode), or null. */
  readSlugRepairSource(sourceId: string): Promise<SlugSpellingRepairSql.SlugRepairSourceRow | null>;
  /** One source's pages (deleted included) that may not be normal, id above `afterId`, id order, 5000 a call. */
  listSourceSlugSpellingCandidates(sourceId: string, afterId: number): Promise<SlugSpellingRepairSql.SourceSlugSpellingCandidateRow[]>;
  /** The source's pages other than `excludeId` whose spelling index key is one of `keys` (or, keys null, whose scan key is `scanKey`), id order. */
  readSpellingKeyPages(sourceId: string, keys: readonly string[] | null, scanKey: string, excludeId: number): Promise<SlugSpellingRepairSql.SpellingKeyPageRow[]>;
  /** The page row the slug-spelling move re-reads under its locks, or null. */
  readSlugRepairPage(pageId: number, sourceId: string): Promise<SlugSpellingRepairSql.SourceSlugSpellingCandidateRow | null>;
  /** The slug of page `pageId` when it belongs to `sourceId`, or null. */
  readPageSlugInSource(pageId: number, sourceId: string): Promise<string | null>;
  /** The live markdown pages a reindex would re-chunk (chunker below `chunkerVersion` or no contextual mode), of `type` when named, and their body characters. */
  readReindexSpendInputs(chunkerVersion: number, type: string | null): Promise<RemediationRecordsSql.ReindexSpendInputs>;
  /** Writes one remediation step's `migration_impact_log` row. */
  insertImpactLogRow(row: RemediationRecordsSql.ImpactLogRow): Promise<void>;
  // Doctor reads (engine-sql/doctor-reads.ts): the statements doctor checks ran through executeRaw.

  // Doctor reads, second set (engine-sql/doctor-derived.ts): the statements more doctor checks and their repairs ran through executeRaw.
  /** The ignored-privacy-label values of live pages by key (at most 50 keys, 100001 pages scanned); `sourceIds` narrows it. */
  readIgnoredPrivacyLabelCounts(opts: { sourceIds?: string[]; timeoutMs: number }): Promise<DoctorDerivedSql.IgnoredPrivacyLabelRow[]>;
  /** Live pages of unarchived sources chunked below the safe-chunk fence: the ones a repair rebuilds and the ones it keeps. */
  countSafeIndexPending(sourceIds?: string[]): Promise<DoctorDerivedSql.RebuildableCounts>;
  /** Live pages whose text projection is behind and whose body holds a private key block: rebuildable and kept. */
  countCredentialProjectionPending(sourceIds?: string[]): Promise<DoctorDerivedSql.RebuildableCounts>;
  /** Live pages per source and stored type, split by whether gbrain writers wrote them. */
  countPagesByTypeAndOwner(sourceIds?: string[]): Promise<DoctorDerivedSql.PageTypeOwnerRow[]>;
  /** Expired tombstones of a source the belief ledger records, in scan order. */
  listRecordedTombstones(hours: string, released: readonly number[]): Promise<DoctorDerivedSql.RecordedTombstoneRow[]>;
  /** The derived-page visibility counts of `sourceIds` under a statement deadline. */
  countDerivedVisibility(sourceIds: string[], timeoutMs: number): Promise<DoctorDerivedSql.DerivedVisibilityCounts>;
  /** Live segmented pages of unarchived sources whose live generation rows do not tile the body. */
  listUntiledSegmentedPageRows(sourceIds: readonly string[] | null, slugs: readonly string[] | null, limit: number): Promise<DoctorDerivedSql.UntiledPageRow[]>;
  /** The next 200 inline pages after `afterId` carrying a timeline row no event page owns. */
  listTimelineHistoryBatch(sourceIds: string[], afterId: number): Promise<DoctorDerivedSql.TimelineHistoryPageRow[]>;
  /** The compiled text of pages by id. */
  readPageCompiledTruths(ids: number[], timeoutMs?: number): Promise<Array<{ id: number; body: string | null }>>;
  /** Age of the oldest live chunk with no vector in `column`, the chunks with no pending-since stamp, and whether the oldest predates the backfill. */
  readEmbeddingBacklogAge(column: string): Promise<DoctorDerivedSql.EmbeddingBacklogAgeRow | undefined>;
  /** Per source among `sourceIds`: the live-body chunks with no vector in `column`, the unstamped ones and the oldest pending-since stamp. */
  readEmbedBacklogRows(column: string, sourceIds: string[]): Promise<DoctorDerivedSql.EmbedBacklogRow[]>;
  /** Held and capped large pages with chunks still waiting for `column`, by source, state and reason. */
  listBudgetLimitedRows(opts: { column: string; sourceId?: string; signature: string | null }): Promise<DoctorDerivedSql.BudgetLimitedRow[]>;
  /** How many applying budget holds are older than a day, and the oldest update time. */
  readBudgetHoldAge(): Promise<DoctorDerivedSql.BudgetHoldAge | undefined>;
  /** The first 1000 image file rows with their source root and page source path. */
  listImageAssetFiles(): Promise<DoctorDerivedSql.ImageAssetFileRow[]>;
  /** Conversation pages held for an undetected format (at most 20, newest first) with the total. */
  listAmbiguousExtractionInputs(): Promise<DoctorDerivedSql.AmbiguousExtractionRow[]>;
  /** Page extraction receipts that read only part of their input, by pipeline and kind. */
  listExtractionInputReceipts(): Promise<DoctorDerivedSql.ExtractionReceiptRow[]>;
  /** Models whose derivation receipts say they had no price, with pipelines and pages. */
  listUnpricedDerivationModels(): Promise<DoctorDerivedSql.UnpricedModelRow[]>;
  /** Restorable re-extraction retirements no live generation ledger records, per source. */
  listRestorableAtomRetirements(sourceIds: string[]): Promise<DoctorDerivedSql.RestorableAtomRetirementRow[]>;
  /** Restorable re-extraction retirements a live generation ledger records. */
  countLedgerCoveredAtomRetirements(sourceIds: string[]): Promise<number>;
  /** Live generations that retired items within the last `restoreDays` days, by source and kind. */
  listLiveGenerationRetirements(sourceIds: string[], restoreDays: number): Promise<DoctorDerivedSql.GenerationRetirementRow[]>;
  /** Held derived generations by source, kind and reason. */
  listHeldGenerations(sourceIds: string[]): Promise<DoctorDerivedSql.HeldGenerationRow[]>;
  /** Pages a create member wrote for an activation that never happened and no live generation owns. */
  listOrphanGenerationCandidates(sourceIds: readonly string[], kind: string | null): Promise<DoctorDerivedSql.OrphanGenerationCandidateRow[]>;
  /** The atom provenance drift counts (none when the aggregate returned no row). */
  readAtomProvenanceCounts(): Promise<DoctorDerivedSql.AtomProvenanceCounts | undefined>;
  /** The unchanged-body recheck's drifted atom groups of live inline pages, by page id then source hash (at most 200). */
  listBodyRecheckGroups(): Promise<DoctorDerivedSql.BodyRecheckGroup[]>;
  /** The body storage and body columns of the page with this id, or null. */
  readBodyRecheckPage(pageId: number): Promise<DoctorDerivedSql.BodyRecheckPage | null>;
  /** The newest 20 inline versions of the page that hold a body, newest first. */
  listBodyRecheckVersions(pageId: number): Promise<DoctorDerivedSql.BodyRecheckVersion[]>;
  /** The 7-day extract rollup per kind; `withExpected: false` is the pre-v141 text. */
  readExtractRollup7d(withExpected: boolean): Promise<DoctorDerivedSql.ExtractRollupRow[]>;
  /** `extract --explain <kind>`: that kind's 7-day extract rollup aggregate (null columns when it has none). */
  readExtractKindRollup7d(kind: string): Promise<DoctorDerivedSql.ExtractKindRollupRow | null>;
  /** The recorded halt reasons of the 7-day extract rollup, per kind and reason. */
  listRecordedHaltReasons7d(): Promise<DoctorDerivedSql.RecordedHaltReasonRow[]>;
  // Doctor persistence reads (engine-sql/doctor-persistence.ts): the statements the persistence checks ran through executeRaw.
  /** Every counter row of the brain and of each principal, in key order. */
  listCapacityCounters(): Promise<DoctorPersistenceSql.CapacityCounterRow[]>;
  /** The three sources holding the most outstanding slots (of one principal when given), most stalled (ten minutes or older) first. */
  listOutstandingHolders(principal: DoctorPersistenceSql.RequestPrincipal | null): Promise<DoctorPersistenceSql.OutstandingHolderRow[]>;
  /** Rows in `persistence_requests`: the planner's estimate (Postgres, `estimate`) or the exact count. */
  countPersistenceRequestRows(estimate: boolean): Promise<{ rows: string } | undefined>;
  /** The lifetime request ids of the brain and of each principal, in key order. */
  listLifetimeCounters(): Promise<DoctorPersistenceSql.LifetimeCounterRow[]>;
  /** Admissions inside the last 7 days among the newest 10,000 (of one principal when given), and the oldest of those. */
  readAdmissionSample(principal: DoctorPersistenceSql.RequestPrincipal | null): Promise<DoctorPersistenceSql.AdmissionSample | undefined>;
  /** The oldest 100 running requests with their claim state, age, root progress inside `maxClaimMs` and the queue behind them. */
  listRunningRequestStalls(maxClaimMs: number): Promise<DoctorPersistenceSql.RunningRequestStallRow[]>;
  /** Hosts with a live full or promoted consumer heartbeat (renewed in the last 5 minutes) and the age of the oldest. */
  readLiveConsumerSummary(): Promise<DoctorPersistenceSql.LiveConsumerSummary | undefined>;
  /** Each terminal-bytes counter beside the receipts and topology changes it should equal, and the true-up clamp setting. */
  readCounterDrift(clampedKey: string): Promise<DoctorPersistenceSql.CounterDriftRow[]>;
  /** The newest request sequence, or null on an empty journal. */
  readMaxRequestSequence(): Promise<string | null>;
  /** Maintenance submit_job slugs refused `threshold` times or more with the same write and code inside `windowHours`. */
  listRefusalBreakerRows(sourceId: string, windowHours: number, threshold: number, limit: number): Promise<DoctorPersistenceSql.RefusalBreakerRow[]>;
  /** Slugs with a source_changed receipt after sequence `floor` (up to 100), with the total of them. */
  listRecentDriftReceiptSlugs(sourceId: string, floor: string, message: string): Promise<Array<{ slug: string; total: number }>>;
  /** Slugs with a source_changed receipt at or below sequence `floor` (up to 101), under a `timeoutMs` bound. */
  listOlderDriftReceiptSlugs(sourceId: string, floor: string, message: string, timeoutMs: number): Promise<Array<{ slug: string }>>;
  /** Writes in the last 7 days the database refused: by the managed-writer guard, by another trigger, and unclassified P0001. */
  readPublicationRefusals(): Promise<DoctorPersistenceSql.PublicationRefusalRow | undefined>;
  /** Effects that recorded a parked target and are not settled (of `sourceIds` when given). */
  countParkedEffects(sourceIds: string[] | null): Promise<number>;
  /** The first 20 parked effects with their request, and whether the binding they were parked under is gone. */
  listParkedEffects(sourceIds: string[] | null): Promise<DoctorPersistenceSql.ParkedEffectRow[]>;
  /** Held Git effects per source and worktree: retrying and parked counts, the codes of `codes` that hold them and the oldest request. */
  listGitPushHoldRows(codes: string[], sourceIds: string[] | null): Promise<DoctorPersistenceSql.GitPushHoldRow[]>;
  /** Queued writer_busy effects per source: how many waited longer than `stallMs`, how many are busy, since when, and the most retries. */
  listStalledCatchupRows(sourceIds: string[] | null, stallMs: number): Promise<DoctorPersistenceSql.StalledCatchupRow[]>;
  /** Parked Git targets per source, error code and former binding. */
  listParkedGroupRows(sourceIds: string[] | null): Promise<DoctorPersistenceSql.ParkedGroupRow[]>;
  /** Committed writes' stale queued or failed embedding effects: all, the failed, and the retry-queued. */
  readStaleEmbeddingCounts(sourceIds: string[] | null): Promise<DoctorPersistenceSql.StaleEmbeddingCounts>;
  /** The first 10 stale embedding effects. */
  listStaleEmbeddingEffects(sourceIds: string[] | null): Promise<DoctorPersistenceSql.StaleEmbeddingEffectRow[]>;
  /** Source bindings whose source is gone or was re-created, by source id, up to `limit` when given. */
  listOrphanBindingRows(limit: number | null): Promise<DoctorPersistenceSql.OrphanBindingRow[]>;
  /** The online-built request indexes by name, in order: valid, missing (valid null) or building (phase set); a purge's preparation read too. */
  readRequestIndexStates(names: readonly string[]): Promise<DoctorPersistenceSql.RequestIndexRow[]>;
  /** The persistence identity as text, or null when the schema has no `persistence_brain` row. */
  readPersistenceBrainIdText(): Promise<string | null>;
  /** Every managed worktree id. */
  listWorktreeIds(): Promise<string[]>;
  /** The local paths of the active sources and of the worktrees `hostId` binds. */
  listManagedRoots(hostId: string | null): Promise<DoctorPersistenceSql.ManagedRootRow[]>;
  /** Sources with live database-only pages: the page count, whether the source has a binding, and its local path. */
  listUnboundSourcePages(): Promise<DoctorPersistenceSql.UnboundSourcePageRow[]>;
  /** Committed requests of the last `days`, grouped per role, host, principal and version. */
  listRecentWriterVersions(days: number): Promise<DoctorPersistenceSql.RecentWriterVersionRow[]>;
  /** Request ids of the page, fact and take purges of the last `days` (up to `cap`). */
  listRecentPurgeRequests(days: number, cap: number): Promise<string[]>;
  /** Active worktree refreshes older than `minutes`. */
  listStuckWorktreeRefreshes(minutes: number): Promise<DoctorPersistenceSql.StuckWorktreeRefreshRow[]>;
  /** Every active source's binding with its worktree owner (of `sourceIds` when given). */
  listSourceBindingsForMovement(sourceIds: string[] | null): Promise<DoctorPersistenceSql.MovementBindingRow[]>;
  /** The first 500 running claims that carry an owner, on worktrees `hostId` owns or on no worktree. */
  listRunningClaimOwners(hostId: string): Promise<DoctorPersistenceSql.RunningClaimOwnerRow[]>;
  /** Worktree bindings owned by a host other than `hostId`. */
  listOwnerBindings(hostId: string): Promise<DoctorPersistenceSql.OwnerBindingRow[]>;
  /** The newest consumer heartbeat of each of `hostIds`. */
  listConsumerOwners(hostIds: string[]): Promise<DoctorPersistenceSql.ConsumerOwnerRow[]>;
  /** The caller writes of `sourceIds` a managed-writer guard or a file drift refused, with the intent's pin and revision state, by sequence. */
  listCallerRefusalRows(sourceIds: string[], operations: string[]): Promise<DoctorPersistenceSql.CallerRefusalRow[]>;
  /** The refused receipts of `sourceIds` that compaction already emptied. */
  countCompactedCallerRefusals(sourceIds: string[], operations: string[]): Promise<number>;
  /** Per source, the put_page writes committed in the last 24 hours that adopted a local edit, and the paths. */
  listLocalEditAdoptions(): Promise<DoctorPersistenceSql.LocalEditAdoptionRow[]>;
  /** The recorded derivation-result sweeps of fact purges, oldest first. */
  listDerivationPurgeSweeps(): Promise<DoctorPersistenceSql.DerivationPurgeSweepRow[]>;
  // Doctor page reads (engine-sql/doctor-pages.ts): the page-table statements doctor checks ran through executeRaw.
  /** Live pages without an `embed_skip` marker whose body and timeline are over `minBytes` bytes, largest first (at most 101). */
  listOversizedPages(minBytes: number): Promise<DoctorPagesSql.OversizedPageRow[]>;
  /** Live pages with title, body and timeline heads and frontmatter, newest update first (`limit` of them), or all of them (`null`). */
  listScraperJunkCandidates(limit: number | null): Promise<DoctorPagesSql.ScraperJunkRow[]>;
  /** Live pages whose frontmatter holds the key `marker` (`quarantine` or `content_flag`). */
  countMarkedPages(marker: DoctorPagesSql.PageMarker): Promise<number>;
  /** Live `always_load` pages stored in segments with more than `maxBytes` body bytes. */
  countOversizedCorePages(maxBytes: number): Promise<number>;
  /** Synthesized pages with no raw trace, raw data, evidence or exemption: their count and five slugs. */
  readRawProvenanceGaps(): Promise<DoctorPagesSql.RawProvenanceGaps>;
  /** Live unverified auto-extracted pages created more than `days` days ago (in `sourceId` when given). */
  countUnverifiedExtractions(days: number, sourceId: string | null): Promise<number>;
  /** Groups of live pages sharing a content hash within a source (at most 51). */
  listContentHashDuplicates(): Promise<DoctorPagesSql.ContentHashDuplicateRow[]>;
  /** Live conversation pages imported from a transcript. */
  countTranscriptImportPages(): Promise<number>;
  /** Every page row, soft-deleted pages included. */
  countPageRows(): Promise<number>;
  /** Page rows (soft-deleted included) whose slug starts with `prefix`, taken literally. */
  countPagesBySlugPrefix(prefix: string): Promise<number>;
  /** Live page rows. */
  countLivePages(): Promise<number>;
  /** The earliest `created_at` of any page row (soft-deleted included), or null. */
  readOldestPageCreatedAt(): Promise<string | Date | null>;
  /** Page rows per stored `trust_tier`. */
  countPageTrustTiers(): Promise<DoctorPagesSql.TrustTierCount[]>;
  /** Live pages with at least one outgoing `mentions` link. */
  countPagesWithMentionLinks(): Promise<number>;
  /** Image-asset chunks with an image vector whose modality is not `image`. */
  countImageModalityMismatches(): Promise<number>;
  /** Live image pages, those with no image vector and those with no recorded `source_path`. */
  readImagePageCoverage(): Promise<DoctorPagesSql.ImagePageCoverage>;
  /** Live `facts` pages in (source, slug) order with the bounded body prefix. */
  listFactsPageBodies(): Promise<DoctorPagesSql.FactsPageBody[]>;
  /** Live pages whose `source_path` has a bracket or a control character. */
  listBracketPathPages(): Promise<DoctorPagesSql.BracketPathPage[]>;
  /** Live pages of an unarchived source whose slug matches the slug-change pattern (in `sourceIds` when given), in id order. */
  listSlugPathCandidates(sourceIds: string[] | null): Promise<DoctorPagesSql.SlugPathCandidate[]>;
  /** Per candidate slug, each of `default` and `sourceId` with a live page at it (a null `source_id` row: neither), by slug then source (the multi_source_drift probe). */
  probeSlugSources(slugs: readonly string[], sourceId: string): Promise<DoctorPagesSql.SlugSourceRow[]>;
  /** Pages awaiting atom extraction (no atom of their current content yet, no held or tombstoned disposition) in the query's source scope; `opts.signal` cancels the count on the SQL engines. */
  countAtomExtractionBacklog(query: AtomBacklogSql.AtomBacklogQuery, opts?: { signal?: AbortSignal }): Promise<number>;
  /** The sources with a live page, by id in byte order (the extract_atoms_backlog roster). */
  listAtomBacklogSourceIds(): Promise<Array<{ source_id: string }>>;
  /** The projection queue by class (pending text, failed, sealable and reimport images, protected, archived) in a read scope, the age of the oldest job that needs work, and the database time of the count. */
  readProjectionBacklog(scope: PageReadScope): Promise<ProjectionBacklogSql.ProjectionBacklogCounts>;
  /** Unsupported-image holds (managed_image_sync_unsupported) per source's current incarnation among sourceIds; sources with none are not listed. */
  listGitImageHoldCounts(sourceIds: string[]): Promise<DoctorSearchSql.GitImageHoldCount[]>;
  /** Pages whose body is under 30% of their raw content (over 1000 characters, with H2/H3 headings), at most 101. */
  listTruncatedMarkdownBodies(): Promise<DoctorSearchSql.TruncatedMarkdownBody[]>;
  /** Segmented pages whose raw content is over 1000 characters with H2/H3 headings (the length comparison skips them). */
  countSegmentedMarkdownBodies(): Promise<number>;
  /** Bodies of the 1000 newest live pages (NULL for a segmented page), within sourceIds when given. */
  listRecentPageBodies(sourceIds: string[] | null): Promise<DoctorSearchSql.RecentPageBody[]>;
  /** How many of the 1000 newest live pages are stored in segments, within sourceIds when given. */
  countSegmentedRecentPages(sourceIds: string[] | null): Promise<number>;
  /** Chunked pages search serves whose slug matches the LIKE pattern (backslash escapes), within sourceIds when given. */
  countPagesHiddenByPrefix(pattern: string, sourceIds: string[] | null): Promise<number>;
  // Doctor search and knowledge reads (engine-sql/doctor-search.ts): the statements the alias, type, entity, body, link, search-policy, hold, projection and atom doctor checks ran through executeRaw.
  /** Alias rows (both tables) whose target page row is absent, per source, in source order. */
  listOrphanedAliasCounts(): Promise<DoctorSearchSql.OrphanedAliasCount[]>;
  /** Alias rows (both tables) whose target page is soft-deleted. */
  readSoftDeletedAliasCounts(): Promise<DoctorSearchSql.SoftDeletedAliasCounts>;
  /** Every distinct (source, type) among live typed pages, in source then type order. */
  listPageTypePairs(): Promise<DoctorSearchSql.PageTypePair[]>;
  // Doctor reads of the checks from the rust-engine/main join (engine-sql/doctor-join.ts): access_pages_read_by_nobody and owner_identity.
  /** Every access member by id, with its status: removed (tombstoned), disabled, or enabled. */
  listAccessMemberStatuses(): Promise<DoctorJoinSql.AccessMemberStatusRow[]>;
  /** Every group membership, in no defined order. */
  listAccessGroupMemberships(): Promise<DoctorJoinSql.AccessGroupMembershipRow[]>;
  /** The live pages whose readers name none of `live` and not the nobody marker, member pages left out; no defined order. */
  listPagesReadByNobody(live: readonly string[], opts: { timeoutMs: number }): Promise<DoctorJoinSql.PageReadersRow[]>;
  /** The live pages a folder rule at `prefix` of `sourceId` covers that none of the `admitted` principals reads; no defined order. */
  listRulePagesReadByNobody(sourceId: string, prefix: string, admittedCount: number, admitted: readonly string[], opts: { timeoutMs: number }): Promise<DoctorJoinSql.PageReadersRow[]>;
  /** The Google sources that are not archived, by id in byte order, with their account and bound members. */
  listGoogleSourceMembers(): Promise<DoctorJoinSql.GoogleSourceMembersRow[]>;
  /** One member's external ids (access_member_links), by system and external id. */
  listOwnerMemberLinks(memberId: string): Promise<DoctorJoinSql.OwnerMemberLinkRow[]>;
  // Doctor reads, second set (engine-sql/doctor-acc.ts): the access, token, OAuth, request-log, decide, chronicle, feedback, belief and volunteer statements doctor checks ran through executeRaw.
  /** Whether the database role cannot read the folder access tables (row-level security hides them). */
  isAccessStateUnreadable(): Promise<boolean>;
  /** Folder and page rules that do not cover the pages derived from their pages, by source and rule id. */
  listRawOnlyRules(): Promise<DoctorAccSql.RawOnlyRuleRow[]>;
  /** Enabled members marked as an audience, by id. */
  listAudienceMemberIds(): Promise<string[]>;
  /** Enabled members that carry the labelled-only grant, by id. */
  listLabelledOnlyMemberIds(): Promise<string[]>;
  /** Every access member row with its groups, removed members only with `includeRemoved`. */
  listAccessMemberRows(includeRemoved: boolean): Promise<DoctorAccSql.Row[]>;
  /** Active tokens and live OAuth clients that carry an attest actor, as JSON rows. */
  listAttestCredentialRows(): Promise<DoctorAccSql.AttestCredentialRow[]>;
  /** Active (not revoked) API token rows, oldest first. */
  listActiveAccessTokenRows(): Promise<DoctorAccSql.Row[]>;
  /** OAuth client rows not deleted, by id. */
  listActiveOauthClientRows(): Promise<DoctorAccSql.Row[]>;
  /** Every OAuth client's id, auth method and secret hash. */
  listOauthClientAuthShapes(): Promise<DoctorAccSql.OauthClientAuthShape[]>;
  /** Federated read grants of live OAuth clients that name no source. */
  listDanglingFederatedReads(): Promise<DoctorAccSql.DanglingFederatedRead[]>;
  /** Derived-workspace sources (id ending in `suffix`) with no path, pages, facts or live client naming them. */
  listOrphanWorkspaceSources(suffix: string): Promise<Array<{ id: string }>>;
  /** Live clients that look self-registered with a scope matching `scopeRegex`; null when the grant audit schema is absent. */
  listPrivilegedDcrClients(scopeRegex: string): Promise<DoctorAccSql.PrivilegedDcrClient[] | null>;
  /** Live pages whose `readable_by` names no valid reader, by source then slug (the first `limit`), each with the total. */
  listMalformedReaderPages(limit: number): Promise<DoctorAccSql.MalformedReaderPageRow[]>;
  /** Readers pages name that match no live member or group (or a group with no member), each with its page count and first page. */
  listUnknownReaders(limit: number): Promise<DoctorAccSql.UnknownReaderRow[]>;
  /** Live pages written in the last `days` days that gained `readable_by` since their newest earlier version, newest first. */
  listRecentReaderNarrowings(days: number, limit: number): Promise<DoctorAccSql.ReaderNarrowingRow[]>;
  /** What the MCP request log occupies, in bytes (the engine's own measure). */
  readMcpRequestLogBytes(): Promise<number>;
  /** The MCP request log's row count: an estimate on Postgres, a count bounded to `limit` rows elsewhere. */
  countMcpRequestLogRows(limit: number): Promise<number>;
  /** Whether a request older than `days` days that retention would delete (operation not in `keepOperations`) is waiting. */
  hasMcpLogRowsPastWindow(days: number, keepOperations: readonly string[]): Promise<boolean>;
  /** `pages.knowledge_revision`: null when absent, else whether the column is NOT NULL (the revision backfill finished). */
  readKnowledgeRevisionNotNull(): Promise<boolean | null>;
  /** Which columns the provenance drift scan can read: trust tiers, then write attribution. */
  readDriftSchema(): Promise<DoctorAccSql.DriftSchema>;
  /** One batch of a source's live pages after page id `at.after`, or the page at `at.slug`, with the writer of its revision. */
  listDriftLiveRows(schema: DoctorAccSql.DriftSchema, sourceId: string, at: { after?: number; slug?: string }): Promise<DoctorAccSql.DriftLiveRow[]>;
  /** The versions of the given pages, oldest first, with the writer of each. */
  listDriftVersionRows(schema: DoctorAccSql.DriftSchema, pageIds: number[]): Promise<DoctorAccSql.DriftVersionRow[]>;
  /** Whether the index `name` exists (the origin index read on a non-Postgres engine). */
  originIndexPresent(name: string): Promise<boolean>;
  /** Life Chronicle ledger rollups of the automatic rows. */
  readChronicleLedgerStats(): Promise<DoctorAccSql.ChronicleLedgerStats>;
  /** Pages holding live events a newer chronicle extraction did not produce, and how many such events. */
  readChronicleDuplicateEvents(): Promise<DoctorAccSql.ChronicleDuplicateEvents>;
  /** Retrieval feedback counts, last rating time, the busiest client's share and the lowest and highest page weights. */
  readFeedbackStatus(): Promise<DoctorAccSql.FeedbackStatusRow>;
  /** Context-volunteer events of the last 7 days per channel; null `sourceIds` reads the whole brain. */
  listVolunteerChannels(sourceIds: readonly string[] | null): Promise<DoctorAccSql.VolunteerChannelRow[]>;
  // Doctor checkpoint reads (engine-sql/doctor-checkpoints.ts): the op_checkpoints and ingest_log statements doctor ran through executeRaw.
  /** The fence candidate records of live source incarnations (one source's when `sourceIds` is given), by fingerprint. */
  listFenceCandidateRecords(op: string, sourceIds?: readonly string[]): Promise<DoctorCheckpointsSql.CandidateRecord[]>;
  /** Every derived-origin park whose page is still a tombstone, oldest first. */
  listDerivedOriginParks(op: string): Promise<DoctorCheckpointsSql.DerivedOriginPark[]>;
  /** Every purge-failure record whose tombstone still exists as recorded, by fingerprint. */
  listPurgeParks(op: string): Promise<DoctorCheckpointsSql.PurgeParkRow[]>;
  /** The sync soak counter record of each of the given UTC days (a day with none is absent). */
  readSoakCounterRows(op: string, days: readonly string[]): Promise<Array<Record<string, unknown>>>;
  /** The fingerprints of unfinished managed-sync cursors that no newer failure row explains. */
  listUnfinishedManagedSyncCursors(): Promise<string[]>;
  /** The managed-sync failure rows of live source incarnations that have no cursor row (the stops a pass left). */
  listManagedSyncPassStops(sourceIds?: readonly string[]): Promise<DoctorCheckpointsSql.ManagedSyncPassStopRow[]>;
  /** The headers of unfinished managed-sync cursors of registered sources. */
  listManagedSyncBacklogHeaders(): Promise<DoctorCheckpointsSql.ManagedSyncBacklogHeader[]>;
  /** One managed-sync pass row (record, write time and the engine clock at the read), or null when there is none. */
  readManagedSyncPassRow(op: string, fingerprint: string): Promise<DoctorCheckpointsSql.ManagedSyncPassRowRecord | null>;
  /** The pass rows of the sources' live incarnations (every source when `sourceIds` is omitted). */
  listLiveManagedSyncPassRows(op: string, sourceIds?: readonly string[]): Promise<DoctorCheckpointsSql.LiveManagedSyncPassRowRecord[]>;
  /** The non-archived sources whose unfinished managed-sync cursor waits at its checkpoint step. */
  listCheckpointBlockedSources(sourceIds?: readonly string[]): Promise<string[]>;
  /** The open identity-downgrade records (no disposition, old page still soft-deleted by that sync), oldest first, with the live slugs at the new path. */
  listOpenIdentityDowngrades(op: string, sourceIds?: readonly string[]): Promise<DoctorCheckpointsSql.OpenIdentityDowngradeRow[]>;
  /** The held managed-atom rows of the sources' current incarnations that no later run completed, excluding sources of role `excludedRole`. */
  listHeldManagedAtomRows(sourceIds: readonly string[] | undefined, excludedRole: string): Promise<DoctorCheckpointsSql.HeldManagedAtomRow[]>;
  /** The stored doctor last-known entries of one op: the entry name and its value. */
  readDoctorLastKnown(op: string): Promise<Array<{ fingerprint: string; entry: unknown }>>;
  /** Upserts one doctor last-known row per entry (the fingerprint is the entry name). */
  writeDoctorLastKnown(op: string, rows: readonly DoctorCheckpointsSql.DoctorLastKnownRow[]): Promise<void>;
  /** The sync-admission setting: the config value at `key` and the dating row's value and `set_at` (null when none). */
  readSyncAdmissionSettingRow(key: string, op: string, fingerprint: string): Promise<DoctorCheckpointsSql.SyncAdmissionSettingRecord>;
  /** The summary of the newest connector receipt in the ingest log, or null when there is none. */
  readLatestConnectorReceipt(): Promise<string | null>;
  /** The `facts:absorb` ingest rows of the last 24 hours grouped by source and reason, by source then count. */
  listFactsAbsorbFailureGroups(): Promise<DoctorCheckpointsSql.FactsAbsorbFailureGroup[]>;
  /** The credential re-chunk holds that still apply at chunker generation `producer`, oldest page first (doctor credential_projection_pending, text_projection_readiness). */
  listCredentialResealHoldRows(producer: string, sourceIds?: readonly string[]): Promise<DoctorCheckpointsSql.CredentialResealHoldRow[]>;
  // Doctor terminal reads: the grouped terminal write failure aggregate, its drill-down batch and the open-pass blocker statements doctor ran through executeRaw
  /** The terminal receipts of the window and every receipt holding a recovery record, grouped on the columns the classifier reads, with the per-source totals row (`opts` bounds the statement on Postgres). */
  readTerminalFailureGroups(query: DoctorTerminalSql.TerminalGroupsQuery, opts?: DoctorTerminalSql.TerminalReadOpts): Promise<DoctorTerminalSql.TerminalGroupRow[]>;
  /** One source's terminal receipts and recovery holders, newest first by sequence, each with the later request that made it moot. */
  listTerminalFailureBatch(query: DoctorTerminalSql.TerminalBatchQuery, opts?: DoctorTerminalSql.TerminalReadOpts): Promise<DoctorTerminalSql.TerminalBatchRow[]>;
  /** Non-archived sources whose open pass has its managed-sync checkpoint request pending, with the worktree and checkpoint request. */
  listOpenPassCheckpointBlockers(passOp: string, sourceIds: readonly string[] | null): Promise<DoctorTerminalSql.OpenPassCheckpoint[]>;
  /** The recovery rows and pending sync page or checkpoint requests of a worktree that block its pass checkpoint, other than the checkpoint itself. */
  listWorktreeBlockerRequests(worktreeId: string, checkpoint: string): Promise<DoctorTerminalSql.WorktreeBlockerRequest[]>;
  // Doctor brain reads: the page, tag, fact, source and checkpoint statements the storage, archive, backup, git-hold and connector checks ran through executeRaw
  /** Live stored-object pages outside the shelf that no adoption tag marks, per source (the storage_manifest check's interim count). */
  listInterimStoredObjectCounts(type: string, shelfSourceId: string, prefix: string, adoptedTag: string): Promise<DoctorBrainSql.InterimStoredObjectCount[]>;
  /** The earliest `created_at` of any source row, or null for a brain with no source. */
  readOldestSourceCreatedAt(): Promise<string | Date | null>;
  /** Live pages of non-archived sources whose frontmatter has a `visibility` key (any letter case) that is not the text `private`. */
  listVisibilityCandidatePages(sourceIds: readonly string[] | null): Promise<DoctorBrainSql.VisibilityCandidatePage[]>;
  /** Held files of non-archived sources that a git hold of `holdOp` records as `visibility_noncanonical`. */
  countVisibilityNoncanonicalHolds(holdOp: string, sourceIds: readonly string[] | null): Promise<number>;
  /** Held files of non-archived sources that a git hold of `holdOp` records as `readers_noncanonical`. */
  countReadersNoncanonicalHolds(holdOp: string, sourceIds: readonly string[] | null): Promise<number>;
  /** Live pages of non-archived sources whose frontmatter names readers with a misspelled `readable_by` key. */
  listReaderCandidatePages(sourceIds: readonly string[] | null): Promise<DoctorBrainSql.VisibilityCandidatePage[]>;
  /** The failed, conflicted or cancelled receipts that unfinished managed-sync cursors wait on. */
  listContentBlockedReceipts(): Promise<DoctorBrainSql.ContentBlockedReceipt[]>;
  /** The failed, conflicted or cancelled receipts a source's sync pass admitted (the receipt intent carries the pass id). */
  listPassAdmittedReceipts(sourceId: string, passId: string): Promise<DoctorBrainSql.ContentBlockedReceipt[]>;
  // Doctor sync reads: the managed-sync cursor, failure and orphan statements doctor ran through executeRaw
  /** The unfinished managed-sync cursors of live source incarnations with their pending receipt, failure row and manifest path (`sourceIds` null reads every source). */
  listManagedSyncCursorFailureRows(sourceIds: readonly string[] | null): Promise<DoctorSyncSql.ManagedSyncCursorFailureRow[]>;
  /** The five rowsets the managed-sync orphan classification reads; `movedMessage` is the refusal message of a checkpoint that lost the last_commit race. */
  listManagedSyncOrphanRowsets(sourceIds: readonly string[] | null, movedMessage: string): Promise<DoctorSyncSql.ManagedSyncOrphanRowsets>;
  /** The cursor keys among `keys` that still have a durable managed-sync failure row, under any incarnation. */
  listDurableManagedSyncFailureKeys(keys: readonly string[]): Promise<string[]>;
  // Doctor reads over `sources` (engine-sql/doctor-sources.ts).
  /** The rows of one doctor `sources` read (`variant` names the statement; `scope` confines it to some ids or one source). */
  readDoctorSources<V extends DoctorSourcesSql.DoctorSourceVariant>(variant: V, scope?: DoctorSourcesSql.DoctorSourceScope): Promise<DoctorSourcesSql.DoctorSourceRows[V][]>;
  /** Sources whose config says guest or that have a guest_sources row, with writers and ceiling; throws the missing-table error behind the guest-notes migration. */
  listGuestSourceRows(): Promise<DoctorSourcesSql.GuestSourceRow[]>;
  /** Live sources' checkout roots, and the roots the host's worktree bindings hold (none on an engine without managed persistence). */
  listCheckoutRoots(hostId: string | null): Promise<DoctorSourcesSql.CheckoutRootRow[]>;
  /** The sources whose commits sync, with their last commit, managed flag and this host's root; `sourceIds` null reads every source. */
  listPendingRoster(sourceIds: readonly string[] | null, hostId: string | null): Promise<DoctorSourcesSql.PendingRosterRow[]>;
  /** Live pages of the `default` source and how many of them record a source path. */
  countDefaultSourceFiles(): Promise<DoctorSourcesSql.DefaultSourceFiles>;
  /** Non-default sources whose current incarnation holds a skill pack with a live head; throws the missing-schema error without the shared-skills tables. */
  listAdoptedSkillPackSourceIds(): Promise<string[]>;
  // Doctor facts, fence and trust reads (engine-sql/doctor-facts-trust.ts).
  /** Live pages of the conversation-pipeline `types` whose slug matches none of the LIKE `slugPatterns`. */
  countConversationPipelinePages(types: readonly string[], slugPatterns: readonly string[]): Promise<number>;
  /** Per source, the facts writes deferred for `reason` in the last 24 hours that no later completed facts-absorb job covers, when they persist (more than 10, or the oldest over an hour old). */
  listPersistentWriterContention(reason: string): Promise<DoctorFactsTrustSql.WriterContentionRow[]>;
  countRowTrustTiers(table: DoctorFactsTrustSql.TrustTierTable): Promise<DoctorFactsTrustSql.RowTrustTierCount[]>;
  countLegacyUnknownBySource(ceilings: DoctorFactsTrustSql.LegacyIdCeilings, sourceIds?: readonly string[]): Promise<DoctorFactsTrustSql.LegacyUnknownRow[]>;
  listTrustColumns(): Promise<DoctorFactsTrustSql.TrustColumnRow[]>;
  listTrustClaimTargets(mode: DoctorFactsTrustSql.TrustClaimTargetMode, sourceIds?: readonly string[]): Promise<DoctorFactsTrustSql.TrustClaimTargetRow[]>;
  countClaimLiftedRows(table: DoctorFactsTrustSql.ClaimLiftTable): Promise<number>;
  // Fence census reads and writes (engine-sql/fence-census.ts).
  listFenceCensusSources(sourceIds: readonly string[] | null): Promise<FenceCensusSql.FenceCensusSource[]>;
  readFencePassHorizon(graceMs: number): Promise<string>;
  listFenceCensusPagesById(sourceId: string, afterId: number, limit: number): Promise<FenceCensusSql.FenceCensusPage[]>;
  listFenceCensusPagesUpdated(sourceId: string, lower: string, after: { at: string; id: number } | null, limit: number): Promise<FenceCensusSql.FenceCensusPage[]>;
  listLiveFencePageIds(pageIds: readonly number[]): Promise<number[]>;
  readFenceScanRecord(op: string, fingerprint: string): Promise<ScanRecord | null>;
  writeFenceScanRecord(op: string, fingerprint: string, record: ScanRecord): Promise<void>;
  upsertFenceCandidatePart(op: string, fingerprint: string, ids: { sourceId: string; incarnation: string; key: string }, part: 'page' | 'file', finding: PageFinding | FileFinding): Promise<void>;
  clearFenceCandidateParts(op: string, fingerprints: readonly string[], part: 'page' | 'file'): Promise<void>;
  readFenceTrendRecords(op: string, sourceIds: readonly string[], fromDay: string): Promise<FenceCensusSql.FenceTrendRecord[]>;
  countSegmentedFencePages(sourceIds: readonly string[], walkedSourceIds: readonly string[]): Promise<number>;
  readBudgetLedgerDay(scope: string, resolver: string, day: string): Promise<FenceCensusSql.BudgetLedgerDayRow | null>;
}
