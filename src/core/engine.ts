import type { RetiredChunkVectorRow, SegmentedProjectionPage } from './engine-sql/segmented-writes.ts';
import type { ReadStatementMembers } from './engine-members/read-statements.ts';
import type { FactsStatementMembers } from './engine-members/facts-statements.ts';
import type { PersistenceMembers } from './engine-members/persistence.ts';
import type { LedgerMembers } from './engine-members/ledgers.ts';
import type { GovernanceMembers } from './engine-members/governance.ts';
import type { DecideMembers } from './engine-members/decide.ts';
import type { JobsMembers } from './engine-members/jobs.ts';
import type { DoctorMembers } from './engine-members/doctor.ts';
import type { MentionPassMembers } from './engine-members/mentions.ts';
import type { CycleReadMembers } from './engine-members/cycle-reads.ts';
import type { FenceProjectionMembers } from './engine-members/fence-projection.ts';
import type { SegmentedWriteMembers } from './engine-members/segmented-writes.ts';
import type { EmbedStaleMembers } from './engine-members/embed-stale.ts';
import type { DoctorTallyMembers } from './engine-members/doctor-tallies.ts';
import type { ListReadMembers } from './engine-members/list-reads.ts';
import type { SurfacedReadMembers } from './engine-members/surfaced-reads.ts';
import type { HandoverReadMembers } from './engine-members/handover-reads.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import type * as CollateGuestSources from './engine-sql/collate-guest-sources.ts';
import type * as AccessMembersSql from './engine-sql/access-members.ts';
import type * as LinkSlugReadsSql from './engine-sql/link-slug-reads.ts';
import type * as SlugSpellingsSql from './engine-sql/slug-spellings.ts';
import type * as FederationExposureSql from './engine-sql/federation-exposure.ts';
import type * as DreamCycleSql from './engine-sql/dream-cycle.ts';
import type * as FilesOpsSql from './engine-sql/files-ops.ts';
import type { OwnerOnlyForm } from './access/owner-only.ts';
import type * as ContradictionsCycleSql from './engine-sql/contradictions-cycle.ts';
import type * as OntologyRepairSql from './engine-sql/ontology-repair.ts';
import type * as AdminReadsSql from './engine-sql/admin-reads.ts';
import type { EngineCapabilities } from './engine-capabilities.ts';
import type { SyncDispatchRow } from './engine-sql/sync-dispatch.ts';
import type { OwnerOnlyTriggerState } from './access/owner-only-marks.ts';
import type { GetVersionsOpts, PageVersionRows } from './page-state/version-types.ts';
import type { PageSnapshotBatch } from './page-snapshot-batch.ts';
import type { EntityKeyRow, EntityKeyRowsOpts } from './engine-sql/entity-keys.ts';
import type { ApplyIdentityDecisionsInput, ApplyIdentityDecisionsResult, IdentityDecisionsRead, IdentityMemberRef } from './engine-sql/identity-decisions.ts';
import type { LinkReadScope } from './link-validity.ts';
import type { ChunkWindowRequest, ChunkWindowOpts, ChunkWindowPage } from './search/chunk-windows.ts';
import type { KeywordPageWindow } from './search/keyword-statement.ts';
import type { EmbeddingState, EmbeddingStateCounts, EmbeddingStateRow } from './embedding-state.ts';
import type { DerivedLinkBatchItem, DerivedLinkOrigin, DerivedLinkReplacementOptions } from './derived-links.ts';
import type { FindPagesQuery, FoundPages } from './page-find.ts';
import type { PageCountQuery, PageCounts, TypeGrouper } from './page-counts.ts';
import type { GeneratedPageRow, PageCollapseFactRow } from './engine-sql/search-reads.ts';
import type { BrainMaturityRow, OnboardSignal } from './engine-sql/health.ts';
import type { EntityTypeFilter } from './schema-pack/entity-types.ts';
import type { ChunkMove } from './page-state/chunk-moves.ts';
import type { DerivedAliasRow } from './engine-sql/pages.ts';
import type { DrainLeaseHolderRecord } from './engine-sql/cycle-locks.ts';
import type { DrainHolderProgressRow } from './engine-sql/persistence-journal.ts';
import type { WriteRequest } from './persistence/model.ts';
import type { CanonicalTimelineRow, TimelineDetailRefresh, TimelineRowRemoval } from './engine-sql/timeline.ts';
import type { TakeFenceRow } from './engine-sql/takes.ts';
import type { CodeTraversalCacheClear, CodeTraversalCacheKey, CodeTraversalCacheRow } from './engine-sql/code-traversal-cache.ts';
import type { FactPreimage, FenceProjectionTarget } from './engine-sql/facts.ts';
import type { FenceFactRow, FenceRowsTarget, GuardedTakeRow, GuardedTakeRowsQuery, HeldRowsQuery, PageTrustRestore } from './engine-sql/trust-fence.ts';
import type { PageBodySizes } from './engine-sql/large-page.ts';
import type { TrustTable } from './trust/schema.ts';
import type { NewTrustProposal, PendingContradictionFilter, PendingContradictionRow, TrustProposalFilter, TrustProposalRow, TrustProposalStatus, TrustProposalTransition } from './engine-sql/trust-proposals.ts';
import type { PageExtractionCommit, PageExtractionPipeline, PageExtractionWatermarkRow } from './engine-sql/page-extraction-state.ts';
import type { ImportedPageSeal, InlinePageRegionsRow, LivePageBodyRow, OriginClaimRow, PageIndexingState, PageIngestStamp, PageOriginRow, PageOriginTarget, RevivalPageRow } from './engine-sql/write-guards.ts';
import type { PageEmbeddingBudgetRow, PageEmbeddingReservation, PageEmbeddingReserveInput } from './engine-sql/page-embedding-budget.ts';
import type { EmbeddingCompletionOpts, EmbeddingCompletionRow } from './engine-sql/embedding-install.ts';
import type { CallerPageAccessRow, PagePolicyPart, WriteVisibilityProbe } from './engine-sql/page-visibility.ts';
import type { PageDateFieldsByIdRow, PageDateFieldsRow, PageRefRow, RelationalPageRow } from './engine-sql/relational-reads.ts';
import type { DefaultSourceSplit, LiveIdentityHolderRow, LocalPathSourceRow, PlainSyncSourceRow, RenameIdentityRow, SourceCheckRow, SourceInsert, SourcesNotReadableOpts, SourceUpstreamObservation, PageIdentityRow, PageSizeRow, ReasonPurgeTombstone, SourcePathPageRow, SourceRoutingRow, SourcePathRow } from './engine-sql/sources.ts';
import type {
  Coverage as NotifierCoverage, MarkerIntent, NotifierHostSourceRow, NotifierLeaseClaim, NotifierLeaseClaimInput, NotifierLeaseHolder,
  NotifierSourceRow, NotifierStatusRow, PendingWantedMarker, StatePatch as NotifierStatePatch, WantedMarker, WantedMarkerInput, FirstDueRow,
  NotifierFirstDueRow, SourceSyncShapeRow,
} from './engine-sql/notifier.ts';
import type {
  AdmissionSourceRow, AttachSourcePathOptions, OpCheckpointRecord, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions,
  SourceStateRow, WorktreeBinding, HostTopologyRow,
} from './engine-sql/write-misc.ts';
import type { ChronicleJudgeKey, ChronicleRowKey, ChronicleRowUpsert } from './engine-sql/chronicle-ledger.ts';
import type { StoredPageHead } from './engine-sql/page-mutation-reads.ts';
import type { PageChunkCounts, WindowChunkRow } from './engine-sql/page-window-chunks.ts';
import type { ChronicleLedgerRow } from './chronicle/contract.ts';
import type { WorktreeClaimStore } from './engine-sql/worktree-claim.ts';
import type { WriterAdminStateOptions, WriterAdminStore } from './engine-sql/writer-admin.ts';
import type { CheckoutFileRow, OriginDependentRow, OriginRefInput, PageLabelRow, PrivacyOriginRow } from './engine-sql/label-door.ts';
import type * as PagePurgeSql from './engine-sql/page-purge.ts';
import type * as PagePurgeSweepSql from './engine-sql/page-purge-sweep.ts';
import type * as PagePurgeJournalSql from './engine-sql/page-purge-journal.ts';
import type * as PurgeStoresSql from './engine-sql/purge-stores.ts';
import type * as PurgeReceiptSql from './engine-sql/purge-receipt.ts';
import type * as OriginHoldsSql from './engine-sql/origin-holds.ts';
import type { DerivedOriginPark } from './persistence/derived-origin-hold.ts';
import type { HeadBlockerReadOpts, HeadBlockerRow, RecoveringHeadRow } from './engine-sql/head-blocker.ts';
import type { IncompleteSyncReceiptRow, IncompleteSyncReceiptSpec, OpenPassWorkSpec } from './engine-sql/checkpoint-validation.ts';
import type { ChronicleStore } from './engine-sql/chronicle-executor.ts';
import type {
  ActorAttributionRow, PageRevisionAttributionRow, RowAttributionRow, RowAttributionTarget, VersionAttributionRow, VersionRef,
  WriteAttributionNameIds, WriteAttributionNames,
} from './engine-sql/write-attribution.ts';
import type { EntityInboundEdgeRow, JunkEntityHubRow, LinkContextAsk, LinkContextMatch, LinkContextOriginPage, LinkEndpointPage, LivePageSummary, TitledPage } from './engine-sql/link-reads.ts';
import type { CodeChunkScope, CodeDefinitionRow, CodeRefChunkRow, CodeSymbolQuery, ContextualModeCandidate, FrozenHitKey, FrozenHitRow, UnsealedPageScope, WithdrawalChunkKey, WithdrawalChunkRow } from './engine-sql/chunk-reads.ts';
import type { EffectiveDateFallbackRow, EffectiveDateSampleCounts, OwnTimelineRow, PageTimelineRow, SegmentedTimelinePages, TimelineOrphanPage, TimelineRowDeletion } from './engine-sql/timeline-reads.ts';
import type {
  ConnectorFencePage, TimelineHistoryQuery, TimelineMarkupQuery, TimelineMarkupRow, TimelineRepairPage, TimelineRowRewrite, TimelineVersionBody,
  TimelineVersionWitness,
} from './engine-sql/timeline-repair-reads.ts';
import type { CaseSensitiveAliasRow, EntityAliasRow, PageAliasRow, SlugAliasRow, TitleHitRow } from './engine-sql/alias-fanout-reads.ts';
import type {
  McpLifetimeUsageRow, McpLogPruneBatch, McpLogPruneCutoff, McpOpUsageRow, McpRequestLogRow, McpRollupPrunedBefore, SearchTelemetryBucket,
  SearchTelemetryRow, McpRequestCountKind, McpRequestLogPage, McpRequestLogPageSpec, PendingWriteHealth, McpTokenRequestCount,
} from './engine-sql/telemetry.ts';
import type { ChatUsageLogRow, ChatUsageWindow } from './engine-sql/chat-usage.ts';
import type { FieldUsageQuery, FieldUsageTypeSample } from './engine-sql/field-usage.ts';
import type * as LinkTemporalSql from './engine-sql/link-temporal.ts';
import type { RelationshipEvidence, RelationshipKey, RelationshipStateWrite } from './link-relationships.ts';
import type { CoverageRelevance, ProjectionRebuildProgress, ScopedCount } from './search/retrieval-coverage.ts';
import type { ProjectionReadinessRow, ProjectionReadinessScope } from './search/projection-readiness.ts';
import type { VectorBackfillOpts } from './search-vector-backfill.ts';
import type {
  Page, PageInput, PageFilters, GetPageOpts, PageReadScope, PageReadPolicy, Chunk, ChunkInput, ChunkReuseRow, StaleChunkRow, StalePageRow,
  ChunklessPageRow, SearchResult, SearchOpts, ResolvedColumn, Link, GraphNode, GraphPath, RelationalFanoutRow, RelationalFanoutOpts, ChainHopOpts,
  ChainHopEdge, TimelineEntry, TimelineInput, TimelineOpts, ChronicleTimelineRow, ChronicleTimelineOpts, LastSeenResult, OntologyObservationInput,
  OntologyMergeResult, OntologyValue, OntologyDimensionStat, OntologyConflict, OntologyReadOpts, RawData, PageVersion, BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput, EngineConfig, CodeEdgeInput, CodeEdgeResult, EvalCandidate, EvalCandidateInput, EvalCaptureFailure,
  EvalCaptureFailureReason, SalienceOpts, SalienceResult, AnomaliesOpts, AnomalyResult, EmotionalWeightInputRow, EmotionalWeightWriteRow,
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow, AdjacencyRow, EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';
import type { BatchAuditSite } from './retry.ts';
import type { StaleTakeOpts, StaleTakeRow, TakeEmbeddingInput } from './takes-row-types.ts';
import type {
  BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState, ManifestRow, ManifestRowInput, SegmentChunkInput,
  SegmentedEmbedPage, SegmentedEmbedRef, SegmentedPageMeta, SegmentSweepOptions, SegmentSweepResult, SegmentTextInput,
} from './page-body/types.ts';
import type { SegmentDerivationInput, SegmentDerivationKind, SegmentDerivationRow } from './page-body/derivations.ts';
import type * as AccessGrantsSql from './engine-sql/access-grants.ts';
import type * as SharedSkillMembersSql from './engine-sql/shared-skill-members.ts';
import type { StoredSkillRevision } from './shared-skills/model.ts';
import type { OauthClientGrantPersist, OauthGrantAuditRow } from './engine-sql/client-grants.ts';
import type { OauthGrantAuditInsert } from './engine-sql/oauth-revocation.ts';
import type {
  AccessTokenGrantWrite, AccessTokenListRow, AccessTokenPrivateAxis, ActiveTokenGrantField, ActiveTokenTarget, DeletedOAuthClient,
  LegacyTokenGrantColumns, OauthClientGrantInsert, OauthClientProbe, OauthTokenInsert, OauthTokenRung, ScopeSourceLock, TokenByHashCaller,
  OauthCodeInsert, OauthCodeRow, OauthTokenRow,
} from './engine-sql/access-credentials.ts';
import type { FactsFencePagesQuery, SweepPageRefRow, SweepDeferredPageRow, SweepDeferredPagesQuery, SweepStalePageRow, SweepStalePagesQuery } from './engine-sql/sweep-reads.ts';
import type { DeltaSessionRow, SessionCursorRow, SessionStateWrite } from './engine-sql/session-state.ts';
import type * as DoctorReadsSql from './engine-sql/doctor-reads.ts';
import type * as DoctorDerivedSql from './engine-sql/doctor-derived.ts';
import type * as DoctorPersistenceSql from './engine-sql/doctor-persistence.ts';
import type * as DoctorPagesSql from './engine-sql/doctor-pages.ts';
import type * as DoctorSearchSql from './engine-sql/doctor-search.ts';
import type * as AtomBacklogSql from './engine-sql/atom-backlog.ts';
import type * as ProjectionBacklogSql from './engine-sql/projection-backlog.ts';
import type * as DoctorAccSql from './engine-sql/doctor-acc.ts';
import type * as DoctorCheckpointsSql from './engine-sql/doctor-checkpoints.ts';
import type * as DoctorSourcesSql from './engine-sql/doctor-sources.ts';
import type * as DoctorTerminalSql from './engine-sql/doctor-terminal.ts';
import type * as DoctorBrainSql from './engine-sql/doctor-brain.ts';
import type * as DoctorSyncSql from './engine-sql/doctor-sync.ts';
import type * as DoctorFactsTrustSql from './engine-sql/doctor-facts-trust.ts';
import type * as FenceCensusSql from './engine-sql/fence-census.ts';
import type { FileFinding, PageFinding, ScanRecord } from './fence-repair/census-store.ts';
import type { BriefEntityPageOpts, BriefEntityPageRow, ReflexPageMatch, ReflexPageRow, ReflexScope } from './engine-sql/reflex-reads.ts';
import type * as BriefReadsSql from './engine-sql/brief-reads.ts';
import type { CounterColumn, WriterReleaseStore } from './engine-sql/writer-release.ts';
import type { PublicationJournalStore } from './engine-sql/publication-journal.ts';
import type { StoredWorktreeManifest } from './persistence/worktree-manifest.ts';
import type { ActiveWorktreeRefreshRow, BlockingEffectRow, OnboardingSourceRow, WriterDiagnosticRows, WriterStatusRows } from './engine-sql/writer-status.ts';
import type * as DoctorJoinSql from './engine-sql/doctor-join.ts';
import type * as OverwriteSql from './engine-sql/overwrite-reads.ts';
import type * as SegmentedPurgeWritesSql from './engine-sql/segmented-purge-writes.ts';
import type * as PageViewDigestsSql from './engine-sql/page-view-digests.ts';
import type * as SynopsisTierSql from './engine-sql/synopsis-tier.ts';
import type { AliasTarget } from './engine-sql/alias-orphans.ts';
import type { AtomFenceCandidate, AtomFenceQuery, ContactRowQuery, RepairPageRef, SplitFactsPages } from './engine-sql/repair-fence-scans.ts';
import type { AttributionTable, DriftConflictBounds, DriftConflictDetails, DriftConflictGroups, DriftConflictQuery, FailedWriteQuery, FailedWriteRow, OriginPathPageRow, SourceHoldQuery, SourceHoldRecordRow, UntiledPage, UntiledPageQuery } from './engine-sql/repair-plan-scans.ts';
import type { ConnectorSourceRow, LoopFactState, OrphanBinding, OrphanCheckpointBounds, OrphanCheckpointRow } from './engine-sql/repair-bookkeeping.ts';
import type { ContentReceiptBinding, OwnedContentRow } from './engine-sql/owned-content.ts';
import type { FileTombstone, FileTombstoneQuery, LegacyOriginPair, LiveOriginPage, OriginClaimantRow, OriginTwinGroupRow, RepairScanPage, RepairScanQuery, SafeChunksPendingRow, TwinMergeLosers, UnreviewedSyncTombstone } from './engine-sql/repair-page-scans.ts';
import type { LinkTargetPage, LinksRearm, OwnedLink, WriterReadPolicy } from './engine-sql/remote-links.ts';
import type { ManagedSyncOrphanRows, ManagedSyncRetireMode, ManagedSyncRetireTarget, SourceManagedSyncFailure } from './engine-sql/managed-sync-orphans.ts';
import type { OriginIndexState, OriginTwinCount, PageRef, TornPages } from './engine-sql/repair-page-reads.ts';
import type { PageRevisionWriter, RevisionWriterRequest } from './engine-sql/sync-run-reads.ts';
import type { RepairBusyRows } from './engine-sql/repair-busy.ts';
import type { SourceDeleteImpact, SourceDeleteResult, SourceSyncStampOptions, SourceIncarnationListRow as SourcesIncarnationRow, SyncCheckpointAdvance } from './engine-sql/sources.ts';
import type { SyncAdmissionEffectsInput } from './engine-sql/sync-admission.ts';
import type { SyncImportPageQuery, SyncImportPageRow, SyncImportPageWindow } from './engine-sql/sync-pass-pages.ts';

export type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions, PageMutationPrecondition, PageWithdrawal } from './page-state/types.ts';

/**
 * v0.27.1: file row for binary-asset metadata. Mirrors the `files` table
 * shape on both engines (Postgres has had it since v0.18; PGLite gets it
 * via migration v36).
 */
/**
 * Options for `traverseGraph`.
 *
 * `frontierCap`: when set, each breadth-first layer adds at most N new
 * pages, chosen after deduplication in (slug, id) order. Default: unset = no
 * per-layer cap (the walk is still bounded by TRAVERSE_WALK_ROW_CAP).
 *
 * NOTE: no truncation signal is exposed yet. The per-layer cap now dedupes
 * before it limits, which was the precondition in TODOS.md → "T8 truncation
 * signal"; restoring the callback is still open there.
 */
/**
 * v0.38: bare row shape returned by `BrainEngine.listAllSources()`.
 * Kept lean (no per-source page_count) so the autopilot tick stays O(1)
 * SQL queries regardless of source count. `sources-ops.SourceListEntry`
 * is the enriched application-layer shape.
 */
export interface SourceRow {
  id: string;
  name: string | null;
  local_path: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown>;
}

/** One `sources` row with the columns import and contextual retrieval read (`BrainEngine.getSource`); values as the driver returns them. */
export interface SourceDetailRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown>;
  created_at: Date;
  /** Per-source contextual-retrieval mode override; null falls through to the global mode. */
  contextual_retrieval_mode?: string | null;
  /** Per-source mount-frontmatter trust gate. */
  trust_frontmatter_overrides?: boolean;
}

/** One `sources` row as `listSourceRecords` returns it; `archived` and `newest_content_at` are absent on a schema that lacks them. */
export interface SourceRecordRow {
  id: string; name: string; local_path: string | null; last_commit: string | null; last_sync_at: Date | null;
  /** Postgres returns an object; PGLite may return JSON text. */
  config: Record<string, unknown> | string;
  created_at: Date; archived?: boolean; newest_content_at?: Date | null;
}
/** A source's config and incarnation (`readSourceIncarnation`). */
export interface SourceIncarnationRow { config: unknown; incarnation: string }
/** The source row a memory write admits against (`readSourceWriteRow`): `kind` and `role` are `config->>'kind'` and `config->>'role'`. */
export interface SourceWriteRow { incarnation: string; archived: boolean; local_path: string | null; kind: string | null; role: string | null }
/** `factReadableUnder`: one fact, read with any visibility (the owner) or the caller's world rule, under a read eligibility. */
export interface FactReadableSpec {
  id: number; sourceId: string; anyVisibility: boolean;
  eligibility: import('./eligibility/policy.ts').ReadEligibility | undefined; excludePrivate: boolean;
}
/**
 * `readForgetTarget`: the fact a forget names. `ownPage` (a member's own member page) reads only a private fact on that
 * page while the live page names the member; otherwise `worldOnly` keeps world facts and `remoteFloor` adds the remote
 * provenance floor. `lock` takes the row FOR UPDATE.
 */
export interface ForgetTargetSpec { id: number; sourceId: string; worldOnly: boolean; remoteFloor: boolean; lock: boolean; ownPage: string | null }
/** The fact row `readForgetTarget` answers. */
export interface ForgetTargetRow { id: number; entity_slug: string | null; source_markdown_slug: string | null; row_num: number | null; expired_at: Date | null; trust_tier: string | null }
/** `readLinkedFactCopies`: the copies of fact `id`'s claim on other entities; `worldOnly` keeps world ones, `remoteFloor` adds the remote provenance floor. */
export interface LinkedFactCopiesSpec { id: number; sourceId: string; worldOnly: boolean; remoteFloor: boolean }
/** One copy `readLinkedFactCopies` answers. */
export interface LinkedFactCopy { id: number; entity_slug: string }
/**
 * `readFactWithdrawalClaim`: the fact a withdrawal admits, never an extraction outcome marker. `worldOnly` keeps world
 * facts and a private fact on `memberPage` (a member's own page, checked by the caller); `remoteFloor` adds the remote
 * provenance floor. `lock` reads the row FOR UPDATE inside the caller's transaction (the withdrawal itself); the Rust
 * store serializes its writes, so it takes no row lock there.
 */
export interface FactWithdrawalClaimSpec { id: number; sourceId: string; worldOnly: boolean; memberPage: string | null; remoteFloor: boolean; lock?: boolean }
/** The claim `readFactWithdrawalClaim` answers: its visibility, text, fingerprint, withdrawal subject and whether it expired. */
export interface FactWithdrawalClaim { visibility: 'private' | 'world'; fact: string; fact_hash: string; subject: string; expired: boolean }
/** `ownerReachesFact`: the owner's member identity and the folder rules it satisfies. */
export interface OwnerReachSpec { id: number; sourceId: string; identity: readonly string[]; satisfied: readonly string[] }
/** `readGuestSourceRow`: the source's guest_sources row (null fields without one) and whether row-level security hides guest_sources. */
export interface GuestSourceLookupRow { hidden: boolean; source_id: string | null; writers: string[] | null; trust_ceiling: string | null }
/** `readPageTrustRows` input: page ids, and (source_id, slug) keys read live unless `includeDeleted`. */
export interface PageTrustLookup { ids?: readonly number[]; keys?: ReadonlyArray<{ source_id: string; slug: string }>; includeDeleted?: boolean }
/** One page's trust fields; `byId` marks a row found by id, `flagged` an activation-suppressed page, `guest` a page in a guest source, `precedence` the class of source it came from (eligibility/precedence.ts, C3). */
export interface PageTrustRow { id: number; source_id: string; slug: string; trust_tier: string; write_origin: unknown; flagged: boolean; guest: boolean; precedence: string; byId: boolean }
/** `readRowTrustRows` input: a row table and the row ids to read. */
export interface RowTrustLookup { table: 'facts' | 'takes' | 'timeline_entries'; ids: readonly number[] }
/** One fact, take or timeline row's trust fields; `flagged` marks an activation-suppressed row, `contested` its first pending supersede proposal (`tp<id>:challenger|challenged`, never set on a timeline row), `precedence` a fact's source class, or `approved` when it came from an allowed-claims page (eligibility/precedence.ts, C3; null on a take or timeline row). */
export interface RowTrustRow { id: number; trust_tier: string; write_origin: unknown; flagged: boolean; contested: string | null; precedence: string | null }
/** A live page with its frontmatter aliases and knowledge revision (`listLinkPageMetadata`). */
export interface LinkPageMetadataRow { slug: string; source_id: string; type: string; title: string; aliases?: unknown; knowledge_revision: string }
/** One stored non-event timeline row (`listStoredTimelineRows`); `date` is `YYYY-MM-DD`. */
export interface StoredTimelineRow { id: number; date: string; source: string; summary: string; detail: string | null }
/** A page and the knowledge revision `filterPagesAtRevision` checks it is still at. */
export interface PageAtRevisionRef { source_id: string; slug: string; revision: string }

/**
 * One `gbrain_cycle_locks` row as `readCycleLocks` returns it: the lease the lock id names. Timestamps are the
 * database's (`db_now` is its clock at the read, so ages compare database stamps with the database clock, #7614);
 * the driver may hand them back as `Date` or ISO text, and the caller coerces.
 */
export interface CycleLockRow {
  id: string;
  holder_pid: number;
  holder_host: string;
  acquisition_token: string;
  acquired_at: Date | string;
  ttl_expires_at: Date | string;
  last_refreshed_at: Date | string | null;
  db_now: Date | string;
}

/** Which lease rows `readCycleLocks` returns: one lock id, several, every expired row, or every row (oldest first for the last two). */
export type CycleLockFilter =
  | { by: 'id'; lockId: string }
  | { by: 'ids'; lockIds: readonly string[] }
  | { by: 'stale' }
  | { by: 'all' };

export interface TraverseGraphOpts extends LinkReadScope {
  sourceId?: string;
  sourceIds?: string[];
  frontierCap?: number;
}

export interface FileRow {
  id: number;
  source_id: string;
  page_slug: string | null;
  page_id: number | null;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** `listFiles` options: the files of one page slug (in any source) when `pageSlug` is given, else every file; at most `limit`. */
export interface ListFilesOptions { pageSlug?: string | null; limit: number }

/**
 * v0.27.1: spec for upsertFile. Identity is (source_id, storage_path).
 * Re-upserting the same identity with a different content_hash updates the
 * row in place (image was replaced); same content_hash is a no-op.
 */
export interface FileSpec {
  source_id?: string;
  page_slug?: string | null;
  page_id?: number | null;
  filename: string;
  storage_path: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  content_hash: string;
  metadata?: Record<string, unknown>;
}

/**
 * v0.41.18.0 — shared opts for engine batch primitives that self-retry on
 * transient connection errors. Threaded through addLinksBatch /
 * addTimelineEntriesBatch / addTakesBatch / upsertChunks.
 *
 * Retry semantics: each batch primitive wraps its internal SQL in
 * `withRetry(BULK_RETRY_OPTS)` (default `{maxRetries:3, delayMs:1000,
 * delayMaxMs:10000, jitter:'decorrelated'}`). Callers MUST NOT add their own
 * `withRetry` wrapper around these methods — that produces 3×3=9 retry
 * attempts under failure, amplifying load on a recovering circuit breaker.
 * CI lint guard `scripts/check-no-double-retry.sh` enforces the rule.
 *
 * - `auditSite`: typed label for the JSONL audit emission (`~/.gbrain/audit/
 *   batch-retry-YYYY-Www.jsonl`). Must be a member of `BATCH_AUDIT_SITES`
 *   in `src/core/retry.ts`. The CI lint guard `scripts/check-batch-audit-
 *   site.sh` validates every string-literal value at build time.
 * - `signal`: AbortSignal that aborts mid-retry-sleep on SIGTERM/SIGINT.
 *   `MinionWorker.shutdownAbort.signal` is the canonical source.
 */
export interface BatchOpts {
  auditSite?: BatchAuditSite;
  signal?: AbortSignal;
}

/**
 * Options for `transaction` / `transactionDirect`.
 *
 * `signal`: aborting it cancels the transaction. An already-aborted signal
 * rejects before `BEGIN` is sent. On Postgres an abort while the transaction
 * runs discards its connection (the socket closes, so the server rolls the
 * transaction back whether or not a statement is in flight, directly or
 * through a transaction-mode pooler) and the transaction rejects with an
 * `AbortError` whose `cause` is the driver's `CONNECTION_CLOSED` error; the
 * pool reconnects on its next checkout. Every `finally` on the way out runs.
 * A nested transaction (savepoint) shares its parent's connection, so
 * aborting it aborts the parent too. PGLite's single in-process connection
 * cannot interrupt a statement: only the pre-`BEGIN` check applies there.
 */
export interface TransactionOptions {
  signal?: AbortSignal;
  /**
   * GBRA-156: Postgres behind a transaction-mode pooler (transaction pipelining on) sends the transaction's first
   * statement with BEGIN instead of a round trip later, when this accepts its text. If BEGIN fails that statement runs
   * in autocommit, so pass only a test that accepts a read or a transaction-local set_config, never a write
   * (`isPersistenceDeclaration`). Ignored by PGLite and inside a transaction.
   */
  pipelineFirst?: (statement: string) => boolean;
  /**
   * GBRA-156: Postgres on a pool that pipelines inside a transaction sends every statement this accepts, in order,
   * behind BEGIN before BEGIN's answer; the first it refuses, and every later one, waits for the answer. If BEGIN fails
   * the accepted statements run in autocommit, so pass only a test that accepts reads and transaction-local
   * set_config (`isPipelinableSearchRead`). Ignored by PGLite and inside a transaction.
   */
  pipelineEarly?: (statement: string) => boolean;
  /** GBRA-156: Postgres opens `BEGIN READ ONLY` (a write inside fails with 25006); search's reads pass it. Ignored by PGLite and when nested. */
  readOnly?: boolean;
}

/** Input row for addLinksBatch. Optional fields default to '' (matches NOT NULL DDL). */
/** One wanted row as replaceWantedLinkRows writes it (wanted-links-store.ts `WantedLinkInput`). */
export interface WantedLinkRowInput {
  producer: 'body' | 'frontmatter';
  ref_kind: 'slug' | 'name';
  target_source_id: string;
  target_ref: string;
  link_type: string;
  context: string;
}

/** What replaceWantedLinkRows replaces: the rows of `producers`, with `readAt` stamped on every bare-name row. */
export interface WantedLinkRowsReplacement {
  rows: readonly WantedLinkRowInput[];
  producers: readonly ('body' | 'frontmatter')[];
  readAt?: string;
}

export interface LinkBatchInput {
  from_slug: string;
  to_slug: string;
  link_type?: string;
  context?: string;
  /**
   * Provenance (v0.13+; opened to kebab tags in v114 / #1941). Any lowercase
   * kebab-case value <=64 chars is DB-valid (CHECK `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`),
   * so external derivers stamp their own tag (e.g. 'citation-graph'). The
   * reconciliation-managed built-ins are 'markdown' ([Name](path) refs),
   * 'frontmatter' (YAML-derived, see origin_*), 'mentions', 'wikilink-resolved';
   * 'manual' is for user/tool-created edges. NULL = legacy/unknown (pre-v0.13).
   * Missing on this batch input defaults to 'markdown'. NOTE: the add_link OP
   * (not this engine method) forbids callers from passing the four managed
   * built-ins and defaults omitted to 'manual' — internal callers use the
   * engine directly and keep writing the managed values.
   */
  link_source?: string;
  /** For link_source='frontmatter': slug of the page whose frontmatter created this edge. */
  origin_slug?: string;
  /** Frontmatter field name (e.g. 'key_people', 'investors'). */
  origin_field?: string;
  /**
   * v0.18.0: source id for each endpoint. When omitted, the engine JOINs
   * against `source_id='default'`. Pass explicit values when the edge
   * lives in a non-default source OR crosses sources.
   *
   * Without these fields, the batch JOIN `pages.slug = v.from_slug` fans
   * out across every source containing that slug, silently creating wrong
   * edges in a multi-source brain. The source_id filter eliminates the
   * fan-out. Origin pages (frontmatter provenance) get their own
   * source_id so reconciliation can't delete edges from another source's
   * frontmatter.
   */
  from_source_id?: string;
  to_source_id?: string;
  origin_source_id?: string;
  /**
   * v0.41.18.0 (A10, codex finding #12): distinguishes "plain body mention"
   * (NULL or 'plain') from "verb-pattern-derived typed NER" ('typed_ner')
   * within link_source='mentions'. Backed by v98 schema column. NOT in
   * the links UNIQUE constraint — same (from, to, type, source, origin)
   * tuple with different link_kind collides DO NOTHING. Default NULL =
   * legacy / unknown / pre-v98 semantics.
   */
  link_kind?: string;
  /** #4381: how the authored reference named its target: `qualified` (`[[source:slug]]`) or `unqualified`. NULL for edges no reference derived. */
  resolution_type?: 'qualified' | 'unqualified';
}

/** Input row for addTimelineEntriesBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface TimelineBatchInput {
  slug: string;
  date: string;
  source?: string;
  summary: string;
  detail?: string;
  /**
   * v0.18.0: source id for the owning page. When omitted, the engine JOINs
   * against `source_id='default'`. Without this, two pages sharing the
   * same slug across sources would fan out timeline rows to both.
   */
  source_id?: string;
}

/**
 * A single dedicated database connection, isolated from the engine's pool.
 *
 * Used by migration paths that need session-level GUCs (e.g.
 * `SET statement_timeout = '600000'` before a `CREATE INDEX CONCURRENTLY`)
 * without leaking into the shared pool, and by write-quiesce designs
 * that need a session-lifetime Postgres advisory lock that survives
 * across transaction boundaries.
 *
 * On Postgres: backed by postgres-js `sql.reserve()`; the same backend
 * process serves every `executeRaw` call within the callback. Released
 * automatically when the callback returns or throws.
 *
 * On PGLite: a thin pass-through. PGLite has no pool, so every call is
 * already on the single backing connection. The interface is still
 * exposed so cross-engine callers don't need to branch.
 *
 * Not safe to call from inside `transaction()`. The transaction holds a
 * different backend; reserving a second one can deadlock on a row the
 * transaction itself is waiting to write.
 */
export interface ReservedConnection {
  /**
   * v0.41.18.0 (A20, codex #7): optional 3rd-arg `opts.signal` lets callers
   * actually cancel a running query. Init nudge (3s wallclock cap) wires an
   * AbortController whose timer fires at 3s; queries that haven't returned
   * by then get cancelled (Postgres: query.cancel(); PGLite: in-process,
   * Promise.race against signal-rejection — documented gap because PGLite
   * has no kernel-level cancellation).
   */
  executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal; prepare?: boolean },
  ): Promise<T[]>;
}

/**
 * v0.28: Takes — typed/weighted/attributed claims, indexed in Postgres.
 * Markdown is source of truth (fenced table on the page); this row is the
 * derived index. Page-scoped via page_id (NOT slug — slug is unique only
 * within a source). `(page_id, row_num)` is the natural unique key.
 */
// v0.38: TakeKind opens from closed 4-element union to string (T3/T10).
// Pre-v0.38, kinds {fact|take|bet|hunch} were enforced by DB CHECK
// (migrations v41/v48) AND by this TS closed union. Codex outside-voice
// review caught that dropping the CHECK without also widening the TS
// type "moves inconsistency around" — raw SQL and old clients could
// poison rows that runtime-validate cleanly. v0.38 migration v76 drops
// the CHECK; this widens the type. Runtime validation moves to the
// active schema pack's `takes_kinds:` declaration. The annotation
// primitive's seed list in gbrain-base reproduces {fact|take|bet|hunch}
// so existing behavior is unchanged; packs can extend to {finding|
// hypothesis|observation|...} per domain.
export interface TakeKindLiteral { kind: string }
export type TakeKind = string;

/** Input row for addTakesBatch. */
export interface TakeBatchInput {
  page_id: number;
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight?: number;          // 0..1, default 0.5; clamped server-side
  since_date?: string;      // ISO date 'YYYY-MM-DD'
  until_date?: string;
  source?: string;
  superseded_by?: number | null;
  active?: boolean;         // default true
}

/** Take row as returned by listTakes / searchTakes. */
export interface Take {
  id: number;
  page_id: number;
  page_slug: string;        // joined from pages
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  since_date: string | null;
  until_date: string | null;
  source: string | null;
  superseded_by: number | null;
  active: boolean;
  resolved_at: string | null;
  resolved_outcome: boolean | null;
  /**
   * v0.30.0: 3-state outcome label. v0.36.1.1 added 'unresolvable' as a 4th
   * state for verdicts where evidence was insufficient to grade. Sits
   * alongside `resolved_outcome` for back-compat. New writes populate both;
   * legacy v0.28-resolved rows have `resolved_quality` backfilled by
   * migration v40 from the boolean. Null on unresolved rows. Schema CHECK
   * (widened in v74) enforces (quality, outcome) consistency:
   * `correct` ↔ `outcome=true`, `incorrect` ↔ `outcome=false`,
   * `partial` ↔ `outcome=NULL`, `unresolvable` ↔ `outcome=NULL`.
   */
  resolved_quality: 'correct' | 'incorrect' | 'partial' | 'unresolvable' | null;
  resolved_value: number | null;
  resolved_unit: string | null;
  resolved_source: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TakesListOpts extends PageReadPolicy {
  page_id?: number;
  page_slug?: string;       // resolved via JOIN
  holder?: string;
  kind?: TakeKind;
  active?: boolean;         // default true (only active rows)
  resolved?: boolean;       // true = only resolved; false = only unresolved; undefined = both
  /** Per-token MCP allow-list. Server applies AND holder = ANY($takesHoldersAllowList) when set. */
  takesHoldersAllowList?: string[];
  sortBy?: 'weight' | 'since_date' | 'created_at';
  /** With `sortBy: 'since_date'`, oldest first (default newest first). */
  oldestFirst?: boolean;
  /**
   * Only takes made on or before this ISO date (YYYY-MM-DD): a take with no
   * since_date is left out, and one in ISO form (YYYY-MM-DD, or YYYY-MM read as
   * the 15th) after the date is left out; any other form is kept for the caller.
   */
  sinceOnOrBefore?: string;
  /** Takes with no take_grade_cache row for this prompt version and judge come first. */
  ungradedFirst?: { promptVersion: string; judgeModelId: string };
  limit?: number;
  offset?: number;
  /** Federated/source scope via the take's page.source_id. Array wins over
   *  scalar, matching sourceScopeOpts. Omitted (local CLI) = no source filter. */
  sourceId?: string;
  sourceIds?: string[];
  /** #5575 read eligibility (eligibility/sql.ts) for read ops; unset for internal writers and fence re-renders. */
  eligibility?: import('./eligibility/policy.ts').ReadEligibility;
}

/** Search result row from searchTakes / searchTakesVector. */
export interface TakeHit {
  take_id: number;
  page_id: number;
  page_slug: string;
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  since_date: string | null;
  until_date: string | null;
  source: string | null;
  score: number;            // search rank score (ts_rank for keyword, 1-cos_dist for vector)
}

export type { StaleTakeOpts, StaleTakeRow, TakeEmbeddingInput } from './takes-row-types.ts';

/** Resolution metadata for resolveTake. */
export interface TakeResolution {
  /**
   * v0.30.0: primary 3-state input; v0.36.1.1 widened to 4-state with
   * 'unresolvable'. When set, takes precedence over `outcome` and the engine
   * writes both columns (quality directly; outcome derived:
   * `correct→true`, `incorrect→false`, `partial→null`, `unresolvable→null`).
   * `unresolvable` marks rows where the judge ran but evidence was
   * insufficient to grade; surfaces in `TakesScorecard.unresolvable_count`.
   */
  quality?: 'correct' | 'incorrect' | 'partial' | 'unresolvable';
  /**
   * v0.28 back-compat input. Keep submitting for v0.28 callers; the engine
   * derives quality (`true→correct`, `false→incorrect`). When `quality` is
   * also set, `quality` wins. When neither is set, the engine throws.
   * Mutually-exclusive with `quality === 'partial'` because partial isn't
   * binary.
   */
  outcome?: boolean;
  value?: number;
  unit?: string;       // 'usd' | 'pct' | 'count' | other
  source?: string;
  resolvedBy: string;  // slug or 'garry'
}

/** v0.30.0: scorecard aggregate. */
export interface TakesScorecard {
  total_bets: number;
  /**
   * Count of resolved rows where `resolved_quality IN
   * ('correct','incorrect','partial')`. v0.36.1.1 deliberately keeps this
   * 3-state semantic to preserve historical comparisons. Unresolvable rows
   * land in the sibling `unresolvable_count` field instead.
   */
  resolved: number;
  correct: number;
  incorrect: number;
  partial: number;
  /** Accuracy = correct / (correct + incorrect). NULL when n=0. */
  accuracy: number | null;
  /**
   * Brier score over rows where `resolved_quality IN ('correct','incorrect')`.
   * Maps `correct→1`, `incorrect→0`, computes `mean((weight − outcome)²)`.
   * Lower is better; 0 = perfect; 0.25 = always-50% baseline.
   * Excludes partial AND unresolvable — both hide signal; the dedicated
   * `partial_rate` and `unresolvable_rate` fields surface them separately.
   * NULL when no correct+incorrect rows.
   */
  brier: number | null;
  /** partial / resolved. NULL when n=0. */
  partial_rate: number | null;
  /**
   * v0.36.1.1: count of rows where `resolved_quality = 'unresolvable'`.
   * Sibling field to `resolved` so historical comparisons against pre-v80
   * scorecards stay valid; `resolved` retains its 3-state meaning, and
   * unresolvable rows count here separately. Optional for SDK back-compat —
   * downstream consumers constructing TakesScorecard fixtures shouldn't have
   * to update on a hotfix. `finalizeScorecard` always populates it.
   */
  unresolvable_count?: number;
  /**
   * v0.37.2.0: `unresolvable_count / (resolved + unresolvable_count)`. NULL
   * when both are 0. Surfaces the spec's headline calibration signal:
   * "what fraction of grade-attempted takes couldn't be graded?" — high
   * values signal weak evidence retrieval rather than wrong predictions.
   * Optional for SDK back-compat; see `unresolvable_count` note above.
   */
  unresolvable_rate?: number | null;
}

export interface TakesScorecardOpts extends PageReadScope {
  holder?: string;
  domainPrefix?: string; // e.g. 'companies/' to scope the scorecard
  domainPrefixAlso?: string[]; // more prefixes read with `domainPrefix` (one name stored under another spelling)
  since?: string;        // ISO date 'YYYY-MM-DD'
  until?: string;        // ISO date 'YYYY-MM-DD'
  /** Federated/source scope via the take's page.source_id (array wins over scalar). */
  sourceId?: string;
  sourceIds?: string[];
}

/** v0.30.0: calibration curve bucket. */
export interface CalibrationBucket {
  /** Lower bound of the weight bucket, inclusive. */
  bucket_lo: number;
  /** Upper bound, exclusive (except for the final bucket which is inclusive of 1.0). */
  bucket_hi: number;
  /** Count of resolved correct+incorrect bets falling in this weight range. */
  n: number;
  /** correct / n. NULL when n=0. */
  observed: number | null;
  /** mean(weight) within the bucket — what was predicted on average. NULL when n=0. */
  predicted: number | null;
}

export interface CalibrationCurveOpts extends PageReadScope {
  holder?: string;
  bucketSize?: number; // default 0.1
  /** Federated/source scope via the take's page.source_id (array wins over scalar). */
  sourceId?: string;
  sourceIds?: string[];
}

/** Synthesis evidence row input (provenance from think synthesis pages). */
export interface SynthesisEvidenceInput {
  synthesis_page_id: number;
  take_page_id: number;
  take_row_num: number;
  citation_index: number;
}

/** One candidate segment extracted by triage: a verbatim quote plus why it matters. */
export interface TriageSegment {
  quote: string;
  note?: string;
}

/**
 * Dream-cycle triage verdict on a transcript (#4152 two-stage cascade).
 * Triage-v1 fields (`score` .. `triage_version`) are null/[] on legacy rows
 * written by the boolean-era judge — callers treat those rows as cache misses.
 */
export interface DreamVerdict {
  worth_processing: boolean;
  reasons: string[];
  judged_at: string;
  /** Ordinal salience score in [0,1]; comparable only within (model, triage_version). */
  score: number | null;
  content_type: string | null;
  segments: TriageSegment[];
  entities: string[];
  model: string | null;
  triage_version: number | null;
}

/**
 * Lifetime of a cached dream verdict (#4069). `triage_version`/`model` already
 * invalidate rows semantically; this is the TEMPORAL bound — rows for deleted
 * or re-hashed transcripts age out, long-lived transcripts re-judge at this
 * cadence. Mirrored by the '30 days' defaults in migration v138 + schema.sql.
 */
export const DREAM_VERDICT_TTL_SECONDS = 30 * 86400;

/** Input shape for putDreamVerdict — judged_at defaults to now() server-side. */
export interface DreamVerdictInput {
  worth_processing: boolean;
  reasons: string[];
  score: number | null; // NULL only on a triage backoff marker (cycle/triage-backoff.ts): a miss to every reader
  content_type: string | null;
  segments: TriageSegment[];
  entities: string[];
  model: string;
  triage_version: number;
}

// ============================================================
// v0.31 Hot Memory: facts table + recall surface
// ============================================================

/** Allowed `facts.kind` values (per-kind decay halflives). 'idea' is extractor/DB-only — absent from the frozen MEMORY_VERBS enum in verbs.ts. */
export type FactKind = 'event' | 'preference' | 'commitment' | 'belief' | 'fact' | 'idea';

export const ALL_FACT_KINDS: readonly FactKind[] = [
  'event', 'preference', 'commitment', 'belief', 'fact', 'idea',
] as const;

/** Visibility tier on a fact row. Mirrors takes' world-default ACL contract (D21). */
export type FactVisibility = 'private' | 'world';

/** Status returned by insertFact. */
export type FactInsertStatus = 'inserted' | 'duplicate' | 'superseded';

/** A fact row read from the facts table. */
export interface FactRow {
  embedding_model?: string | null;
  embedded_text_hash?: string | null;
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  /**
   * v0.31.2: salience tier the LLM assigned at extraction time. Surfaces
   * to consumers (recall response, daily-page writer, admin dashboard,
   * agents reading via MCP `_meta.brain_hot_memory`). Pre-v45 brains had
   * no notability column; migration v46 backfills with default 'medium'.
   */
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  expired_at: Date | null;
  superseded_by: number | null;
  consolidated_at: Date | null;
  consolidated_into: number | null;
  source: string;
  source_session: string | null;
  confidence: number;
  embedding: Float32Array | null;
  embedded_at: Date | null;
  created_at: Date;
  /** Set only when the list call asked for `fingerprint` (#5888 hot-memory collapse). */
  fact_fingerprint?: string;
  /** Set by `listFactsKeyset`: created_at at the column's microsecond precision (ISO UTC). */
  created_at_iso?: string;
  /** Who asserted the claim (migration v215); null when attribution is unavailable. */
  attributed_to?: FactAttribution | null;
  /** #5575: the stored trust tier and write origin (absent on brains before the trust migration). */
  trust_tier?: import('./trust/tier.ts').TrustTier;
  write_origin?: Record<string, unknown> | null;
  /** The typed claim columns (NewFact.claim_*), each set only when the row stores it. */
  claim_metric?: string | null; claim_value?: number | null; claim_unit?: string | null; claim_period?: string | null;
}

/**
 * Who asserted a saved fact: the user, the assistant (a recommendation, answer
 * or plan it gave), or a named third party. Never whether the claim is true or
 * was accepted. NULL means attribution is unavailable.
 */
export type FactAttribution = 'user' | 'assistant' | 'other';

/** Input for insertFact. source_id supplied via the ctx arg. */
export interface NewFact {
  embedding_model?: string | null;
  fact: string;
  kind?: FactKind;                     // default 'fact'
  entity_slug?: string | null;
  visibility?: FactVisibility;          // default 'private'
  context?: string | null;
  valid_from?: Date;                   // default now()
  valid_until?: Date | null;
  /**
   * v0.46 (#3014) — explicit expiry timestamp. When set, the row is
   * inactive: excluded from active views (recall, listFactsByEntity's
   * activeOnly default) and eligible for listSupersessions. The fence
   * mapper stamps this for struck rows (superseded / forgotten /
   * inactive-unrecognized) because no DB derivation from `valid_until`
   * exists — no trigger, sweep, or read-time coalesce populates it.
   * Active-row callers leave it undefined; insertFacts defaults it to NULL.
   */
  expired_at?: Date | null;
  source: string;                       // 'mcp:put_page' | 'mcp:extract_facts' | 'cli:think' | etc
  source_session?: string | null;
  confidence?: number;                  // [0,1], default 1.0
  notability?: 'high' | 'medium' | 'low'; // salience filter for extraction gate
  embedding?: Float32Array | null;     // pre-computed; if null, insertFact computes via gateway
  /**
   * v0.35.4 (D-CDX-5) — typed-claim fields. Optional. When populated,
   * `gbrain eval trajectory` + `find_trajectory` MCP op consume them for
   * chronological regression detection and drift_score. `claim_metric` is
   * normalized to lowercase snake_case by the extraction layer before
   * this method sees it; the engine stores verbatim.
   */
  claim_metric?: string | null;
  claim_value?: number | null;
  claim_unit?: string | null;
  claim_period?: string | null;
  /**
   * v0.40.2.0 — event-shaped row marker ('meeting', 'job_change',
   * 'location_change', etc). Mutually informational with `claim_metric`:
   * a row can have either, both, or neither. Persisted into
   * `facts.event_type` (migration v89). Existing callers don't need to
   * set this — leaving it undefined preserves pre-v0.40 behavior.
   */
  event_type?: string | null;
  /** Speaker attribution (migration v215). Undefined/null → NULL (unavailable). */
  attributed_to?: FactAttribution | null;
  /** GBRA-574 B2: the slot (facts/slots.ts), conversation extractor only; insertFacts adds value_hash and dim_status 'active'. */
  dimension?: string | null; value?: string | null;
}

/** Options shared by list-facts methods. */
export interface FactListOpts {
  /** Hide expired_at IS NOT NULL rows. Default true. */
  activeOnly?: boolean;
  /** Return only facts where consolidated_at IS NULL. Default false. */
  unconsolidatedOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Restrict to specific kinds. Default: all kinds. */
  kinds?: FactKind[];
  /**
   * Visibility filter. When undefined, returns all. When set, only matches
   * are returned. Remote (untrusted) callers must supply ['world'].
   */
  visibility?: FactVisibility[];
  /**
   * Case-insensitive substring filter on fact text, applied IN SQL (before
   * limit). A client-side post-limit grep silently returns nothing for
   * high-cardinality entities — the match may sit outside the newest-N
   * window (found by the 2026-08-06 memory eval on an entity with hundreds
   * of facts). LIKE wildcards in the needle are escaped; plain substring
   * semantics only.
   */
  grep?: string;
  /** Intersect entity reads with this exact source_session before LIMIT/OFFSET. Also honored by listFactsSince. */
  sessionId?: string;
  /**
   * When true, `listFactsSince`'s `since` comparison and ORDER BY use
   * COALESCE(valid_from, created_at) — event time — instead of creation
   * time. Batch backfill (e.g. `extract-conversation-facts` run over many
   * pages at once) inserts many facts with the same `created_at` (the
   * batch's run time), which makes creation-time ordering useless for
   * "what happened yesterday" recall — results sort by extraction order,
   * not by when the underlying event occurred. Off by default, so the
   * facts meta-hook's hot-memory injection cache (`facts/meta-hook.ts`,
   * a 24h recency window re-ranked by decayed confidence) keeps its
   * creation-time semantics unchanged.
   */
  eventTime?: boolean;
  /**
   * When true, exclude the durable audit checkpoint rows that
   * extract-conversation-facts writes into the facts table
   * (`EXTRACTION_COMPLETE` / `EXTRACTION_NOT_APPLICABLE`). These are
   * batch-run checkpoints, not user facts; their `created_at` is always
   * the most recent write, so for trusted callers (no visibility filter)
   * they dominate the newest-N fetch window right after a batch run and
   * starve `recall` of real facts. Honored consistently by
   * `listFactsByEntity` / `listFactsBySession` / `listFactsSince` on both
   * engines. Off by default so existing callers that intentionally want
   * the full row set (e.g. `gbrain doctor` checkpoint audits) are
   * unaffected.
   */
  excludeAuditRows?: boolean;
  /** #5888: listFactsSince/listFactsBySession also select `gbrain_fact_fingerprint(fact)` as `fact_fingerprint`. */
  fingerprint?: boolean;
  /** #5575 read eligibility (eligibility/sql.ts): read floor, quarantined-page and needs_rederive hiding, proactive suppression. Unset for internal writers. */
  eligibility?: import('./eligibility/policy.ts').ReadEligibility;
  /** Hide facts whose provenance page (`source_markdown_slug`) is private. Resolved by the trusted operation layer (resolveExcludePrivatePages), never from MCP parameters. */
  excludePrivate?: boolean;
}

/** FactListOpts plus the entity (and the page the fact sits on) listFactsSince and listFactsKeyset narrow to before LIMIT. */
export type RecallFactReadOpts = FactListOpts & { entitySlug?: string; sourceMarkdownSlug?: string };

/** Per-source operational health snapshot consumed by `gbrain doctor`. */
export interface FactsHealth {
  source_id: string;
  total_active: number;          // expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
  total_today: number;           // created in last 24h
  total_week: number;            // created in last 7d
  total_expired: number;         // expired_at IS NOT NULL OR valid_until <= now() (the complement of active)
  total_consolidated: number;    // consolidated_at IS NOT NULL
  top_entities: Array<{ entity_slug: string; count: number }>;
  /** Optional counters fed by the queue / classifier — populated when those modules report. */
  drop_counter?: number;
  classifier_fail_counter?: number;
  p50_latency_ms?: number;
  p99_latency_ms?: number;
}

/**
 * v0.35.4 (D-CDX-6) — Options for `BrainEngine.findTrajectory`.
 *
 * `sourceId` (scalar fast path) and `sourceIds` (federated array) follow
 * the v0.34.1.0 search* pattern: when `sourceIds` is set the engine
 * applies `WHERE source_id = ANY($N::text[])`; otherwise scalar predicate
 * with `sourceId ?? 'default'`.
 *
 * `remote` (D-CDX-1) gates the visibility filter: when true the engine
 * adds `AND visibility = 'world'`, mirroring `recall`'s posture for
 * untrusted callers. Callers pass worldOnlyFacts(ctx.remote), so the local
 * CLI and the brain owner see both private + world facts.
 */
export interface TrajectoryOpts {
  entitySlug: string;
  /** Single-source scope; default 'default' when both this and sourceIds are unset. */
  sourceId?: string;
  /** Federated array scope (mutually exclusive with sourceId; the array wins when set). */
  sourceIds?: string[];
  /**
   * Filters to visibility='world' unless strictly `false`. FAIL-CLOSED: an
   * omitted flag means world-only, so trusted local callers must pass
   * `remote: false` explicitly.
   */
  remote?: boolean;
  /** Same as FactListOpts.excludePrivate: hide points whose provenance page is private. */
  excludePrivate?: boolean;
  /** Metric filter. When set, only facts with this canonical metric label participate. */
  metric?: string;
  /**
   * v0.40.2.0 — kind filter. Default 'all'. Defensive opt that future-proofs
   * the API now that event_type rows live alongside metric rows in the same
   * table. Existing callers (founder-scorecard, eval-trajectory) pass
   * 'metric' explicitly for clarity (no behavior change since their
   * downstream math already skips NULL-metric rows). Richer event-shape
   * filtering (job_change vs meeting vs location) is a v0.40.3+ TODO once
   * the event schema gets structured fields.
   *   - 'metric': only rows with claim_metric IS NOT NULL
   *   - 'event':  only rows with event_type IS NOT NULL
   *   - 'all':    both (default)
   */
  kind?: 'metric' | 'event' | 'all';
  /** Lower bound on valid_from (inclusive). YYYY-MM-DD or full ISO. */
  since?: string | Date;
  /** Upper bound on valid_from (inclusive). YYYY-MM-DD or full ISO. */
  until?: string | Date;
  /** Cap on points returned (the newest N, in chronological order). Default 100, max 500. */
  limit?: number;
}

/**
 * A single point in an entity's claim trajectory. Carries the typed-claim
 * fields when populated (drives regression detection), the underlying
 * fact text (for display), provenance (source_session, source_markdown_slug),
 * and the raw embedding so the caller can compute drift_score without a
 * second SQL round-trip.
 */
export interface TrajectoryPoint {
  fact_id: number;
  valid_from: Date;
  valid_until: Date | null;
  metric: string | null;
  value: number | null;
  unit: string | null;
  period: string | null;
  /**
   * v0.40.2.0 — event-shaped row marker (e.g. 'meeting', 'job_change',
   * 'location_change'). Mutually informational with metric: a row can have
   * (a) metric set + event_type null (typed claim like MRR=$50K),
   * (b) metric null + event_type set (event like "last met Marco"), or
   * (c) both null (legacy free-text fact row from pre-v0.35.4 brains).
   * Both founder-scorecard's per-metric math and eval-trajectory's
   * regression analysis already skip null-metric rows, so event-only
   * rows ride through invisibly to those callers.
   */
  event_type: string | null;
  text: string;
  source_session: string | null;
  source_markdown_slug: string | null;
  /** Raw embedding for drift computation; null when the fact was inserted without one. */
  embedding: Float32Array | null;
}

/** Maximum results returned by search operations. Internal bulk operations (listPages) are not clamped. */
export const MAX_SEARCH_LIMIT = 100;

/** Clamp a user-provided search limit to a safe range. */
export function clampSearchLimit(limit: number | undefined, defaultLimit = 20, cap = MAX_SEARCH_LIMIT): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) return defaultLimit;
  if (limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), cap);
}

export interface BrainEngine extends ReadStatementMembers, FactsStatementMembers, PersistenceMembers, LedgerMembers, GovernanceMembers, DecideMembers, JobsMembers, DoctorMembers, MentionPassMembers, CycleReadMembers, EmbedStaleMembers, DoctorTallyMembers, ListReadMembers, FenceProjectionMembers, SurfacedReadMembers, SegmentedWriteMembers, HandoverReadMembers {
  /** Discriminator: lets migrations and other consumers branch on engine kind without instanceof + dynamic imports. */
  readonly kind: 'postgres' | 'pglite' | 'rust';
  readonly capabilities: EngineCapabilities; // what this engine can do, by name (engine-capabilities.ts); ask it instead of branching on kind

  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Recover a dropped connection using the config captured at the last
   * `connect()`. Callers (autopilot health probe, batchRetry) MUST use this
   * instead of `disconnect()` + bare `connect()`: the latter loses the config
   * (#2034 — a bare `connect()` with no args throws `database_url undefined`
   * forever) AND opens a null-connection window. Implemented on BOTH engines
   * for parity so the call is never a silent no-op.
   */
  reconnect(ctx?: { error?: unknown }): Promise<void>;
  initSchema(): Promise<void>;
  /** GBRA-467: run `fn` under the cross-process schema migration lock; callers use schema-migration-lock.ts. */
  holdSchemaMigrationLock?<T>(fn: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** Short control transaction on the existing direct route; honors nested transaction scope. */
  transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** Mandatory resident-consumer stop barrier before datastore/pool shutdown. */
  registerBeforeDisconnect(stop: () => Promise<void>): () => void;
  /**
   * Run `fn` with a dedicated connection (Postgres: reserved backend; PGLite: pass-through). See `ReservedConnection`
   * for semantics and usage constraints. Release is automatic. `route: 'ordinary'` skips the direct route. `selfContained`:
   * `fn` uses only `conn` and never waits on the pool (like a transaction), so a one-connection ordinary pool may lend it.
   */
  withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>, opts?: { route?: 'ordinary'; selfContained?: boolean }): Promise<T>;

  // Pages CRUD
  /**
   * Fetch a page by slug.
   * v0.26.5: by default soft-deleted rows return null (matches the search
   * filter contract). Pass `opts.includeDeleted: true` to surface them with
   * `deleted_at` populated — used by `gbrain pages purge-deleted` listing,
   * by `restore_page` flow, and by operator diagnostics.
   */
  getPage(slug: string, opts?: GetPageOpts): Promise<Page | null>;
  readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null>;
  /**
   * `readPageSnapshot(slug, { sourceId })` for a run of exact refs in one statement (page-snapshot-batch.ts):
   * the longest prefix whose bodies fit `maxBytes`. Postgres binds the refs' sources for RLS.
   */
  readPageSnapshotsBatch(refs: ReadonlyArray<{ slug: string; sourceId: string }>, opts?: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean }): Promise<PageSnapshotBatch>;
  /** Hold exact page identities through commit, including absent rows. Requires a transaction. */
  lockPageKeys(keys: readonly PageKey[]): Promise<void>;
  /**
   * Insert or update a page. When `opts.sourceId` is omitted, the row is
   * written under the schema DEFAULT ('default'). When provided, `source_id`
   * is included in the INSERT column list so ON CONFLICT (source_id, slug)
   * DO UPDATE actually targets the intended row instead of fabricating a
   * duplicate at (default, slug). Multi-source brains MUST pass sourceId.
   */
  /**
   * `allowEmptyOverwrite` (default false) opts out of the data-loss guard that
   * refuses to overwrite an existing non-empty page body with a blank one (see
   * `isBlankBody`). Pass it only when clearing a body is the deliberate intent;
   * deleting a page goes through `deletePage`/`softDeletePage`, not this path.
   */
  putPage(slug: string, page: PageInput, opts?: PageWriteOptions): Promise<Page>;
  /**
   * v0.41.13 (#1309) — identity-based dedup pre-check for the import pipeline.
   *
   * Returns the first matching `{slug, id}` whose `(source_id, …)` matches
   * the supplied identity signal, OR null when nothing matches.
   *
   * Identity precedence (a row matches if EITHER fires):
   *   - `content_hash = $hash` AND `deleted_at IS NULL`
   *   - `frontmatter->>'id' = $frontmatterId` AND `$frontmatterId IS NOT NULL`
   *     AND `deleted_at IS NULL`
   *
   * Background: the overlapping-ingest-roots bug class (infiniteGameExp,
   * issue #1309) created two pages per file when a user ran `gbrain import
   * /vault/Subdir/` then `gbrain import /vault/` — the slug-shape changed
   * but the content + external ID were identical. Pre-fix, the import
   * pipeline dedup-checked by `getPage(slug)` alone and missed the
   * cross-slug duplicate. This method gives the importer a deterministic
   * way to identify true duplicates BEFORE insert.
   *
   * Per codex review: the optional `?` shape lets existing test doubles
   * compile without changes. Callers must defensively check
   * `engine.findDuplicatePage?.(...)` and fall through on undefined.
   * `deleted_at IS NULL` is deliberate — a soft-deleted page should NOT
   * block a legitimate re-import under a new slug.
   *
   * `excludeSlug` removes the caller's own row, so a page never matches
   * itself. A `frontmatter.id` match ranks ahead of a bare `content_hash`
   * match, so a page that shares the external id is never hidden behind an
   * unrelated page that happens to share text.
   */
  findDuplicatePage?(
    sourceId: string,
    opts: { hash: string; frontmatterId?: string | null; excludeSlug?: string },
  ): Promise<{ slug: string; id: number } | null>;
  findDuplicatePages?(sourceId: string, inputs: ReadonlyArray<{ hash: string; frontmatterId?: string | null; excludeSlug?: string }>): Promise<Array<{ slug: string; id: number } | null>>;
  /**
   * Hard-delete a page row. Cascades to content_chunks, page_links,
   * chunk_relations via existing FK ON DELETE CASCADE.
   *
   * v0.26.5: this is no longer the public-facing `delete_page` op handler —
   * the op now soft-deletes via `softDeletePage` instead. `deletePage` stays
   * as the underlying primitive used by `purgeDeletedPages` and by callers
   * that explicitly want hard-delete semantics (e.g. test setup teardown).
   */
  /**
   * v0.18.0+ multi-source: `opts.sourceId` scopes the DELETE so a source-A
   * delete doesn't hard-delete the same-slug pages in sources B/C/D. Without
   * it, the bare DELETE matches every row with that slug across all sources.
   * Cascades through content_chunks / page_links / chunk_relations via FKs.
   *
   * v0.41.19.0 (CDX-11): single-row primitive used by `purgeDeletedPages`,
   * `gbrain sync` (one path per call), test setup teardown, and the v0.41.19.0
   * sync-delete decompose path (when `deletePages` throws on a 500-row batch,
   * the sync loop falls back to per-slug `deletePage` to log unrecoverable
   * failures to `failedFiles`). `gbrain sync` calls this on EVERY run that
   * sees a deleted file — it is NOT admin-only.
   *
   * Unlike `deletePages` it scrubs nothing else: the page purge, its main
   * caller, scrubs those stores itself and records them in its receipt.
   */
  deletePage(slug: string, opts?: { sourceId?: string }): Promise<void>;
  /**
   * v0.41.19.0 — batch delete: single SQL round-trip via
   * `DELETE FROM pages WHERE slug = ANY($1::text[]) AND source_id = $2
   *  RETURNING slug`. Cascades through content_chunks / page_links (×3) /
   * tags / raw_data / timeline_entries / page_versions via FKs declared in
   * `src/schema.sql`. `files.page_id` and `links.origin_page_id` go SET
   * NULL per their FK definitions.
   *
   * SINGLE-BATCH PRIMITIVE: caller is responsible for chunking the input to
   * `<= DELETE_BATCH_SIZE` entries per call (see
   * `src/core/engine-constants.ts`). Matches the `addLinksBatch` convention
   * — engine assumes well-behaved input, caller owns the slicing.
   *
   * Returns the slugs of rows ACTUALLY DELETED (order undefined). Callers
   * use this to filter their own `pagesAffected` tracking so downstream
   * phases don't waste lookups on phantom slugs (paths that were in the
   * deletion list but had no DB row).
   *
   * #9068: in the same transaction, after the delete, it scrubs the rows
   * that name a deleted page outside any foreign key: retrieval_event_pages,
   * retrieval_event_links, retrieval_feedback, retrieval_weights,
   * context_volunteer_events, mention_gazetteer_entries and the slug in
   * eval_candidates.retrieved_slugs (scrubPurgedSlugs, scrubPurgedNameStores).
   *
   * ATOMICITY: one transaction. The whole batch commits or
   * the whole batch rolls back. Coarser than the per-row `deletePage`
   * cadence — a mid-loop abort or transient connection failure can roll
   * back up to `DELETE_BATCH_SIZE - 1` successful deletes from the
   * in-flight batch. `gbrain sync` is idempotent (next run picks them up
   * via git diff); other callers should account for the contract.
   *
   * sourceId is REQUIRED (no `'default'` fallback). This is asymmetric with
   * `deletePage` (which keeps the optional/'default' fallback for back-
   * compat). Filed as v0.42+ TODO to tighten `deletePage` to match once a
   * full caller audit confirms every site threads `sourceId`.
   */
  deletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]>;
  /**
   * v0.41.19.0 — batch path → slug resolution. Single SQL round-trip via
   * `SELECT slug, source_path FROM pages WHERE source_path = ANY($1::text[])
   *  AND source_id = $2`. Returns `Map<path, slug>`; paths NOT in the map
   * have no `source_path` row in the DB and the caller is expected to fall
   * back to `resolveSlugForPath(path)` for the path-derived slug.
   *
   * Mirrors the contract of the single-call `resolveSlugByPathOrSourcePath`
   * helper in `src/commands/sync.ts`, batched. As of v0.41.19.0, that
   * single-call helper is implemented on top of this method (one Map
   * allocation per single-path call; negligible cost; one owner of the SQL
   * + fallback semantics).
   *
   * SINGLE-BATCH PRIMITIVE: caller chunks to `<= DELETE_BATCH_SIZE`.
   *
   * Empty `paths` short-circuits to an empty Map without touching the DB.
   */
  resolveSlugsByPaths(
    paths: string[],
    opts: { sourceId: string },
  ): Promise<Map<string, string>>;
  /**
   * v0.26.5 — set `deleted_at = now()` on a page. Returns the slug if a row
   * was soft-deleted, null if no row matched (already soft-deleted OR not found).
   * Idempotent-as-null. The page stays in the DB and cascade rows (chunks,
   * links) stay intact; the autopilot purge phase hard-deletes after 72h.
   */
  softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null>;
  /**
   * #4587 — batch soft-delete: single SQL round-trip via
   * `UPDATE pages SET deleted_at = now() WHERE slug = ANY($1::text[])
   *  AND source_id = $2 AND deleted_at IS NULL RETURNING slug`.
   *
   * The batch twin of `softDeletePage`, mirroring the `deletePages` contract
   * exactly so `gbrain sync`'s delete lanes (which previously hard-deleted
   * through `deletePages`/`deletePage`, bypassing the 72h recovery window)
   * can swap in place:
   *
   * - SINGLE-BATCH PRIMITIVE: caller chunks input to `<= DELETE_BATCH_SIZE`
   *   entries per call (see `src/core/engine-constants.ts`); larger input
   *   THROWS. Empty input short-circuits to `[]` without touching the DB.
   * - Returns the slugs ACTUALLY FLIPPED active→soft-deleted (order
   *   undefined). Rows already soft-deleted — or absent — are silently
   *   excluded (idempotent, matching `softDeletePage`'s idempotent-as-null),
   *   so callers' `pagesAffected` tracking only sees real transitions.
   * - `deleted_at IS NULL` predicate is load-bearing: a re-run must never
   *   refresh `deleted_at` on an already-soft-deleted row, which would
   *   silently extend (or restart) its 72h purge clock.
   * - sourceId is REQUIRED (no `'default'` fallback), same as `deletePages`.
   * - ATOMICITY: one statement, one transaction — same coarseness note as
   *   `deletePages`; sync's decompose-on-batch-failure falls back to
   *   one-element batches per slug.
   *
   * Unlike `deletePages`, NOTHING cascades: chunks/links/timeline rows stay
   * intact behind the `deleted_at` filters (68 read-side filters, #1702
   * class), the autopilot purge phase hard-deletes after 72h via
   * `purgeDeletedPages`, and a re-import within the window revives the page
   * through `putPage`'s ON CONFLICT `deleted_at = NULL`.
   * `deletePage`/`deletePages` remain the purge/teardown primitives.
   */
  softDeletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]>;
  /**
   * v0.26.5 — clear `deleted_at` on a soft-deleted page. Returns true iff a
   * row was restored. False if the slug is unknown OR the page is not
   * currently soft-deleted (idempotent-as-false).
   */
  restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean>;
  /**
   * v0.26.5 — hard-delete pages whose `deleted_at` is older than the cutoff.
   * Called by the autopilot purge phase and by the `gbrain pages purge-deleted`
   * CLI escape hatch. Cascades through existing FKs.
   *
   * `opts.dryRun: true` runs a SELECT with the SAME WHERE predicate (same
   * cutoff arithmetic, same DB `now()` clock source) instead of the DELETE,
   * so the preview and a subsequent real run agree up to whatever crosses
   * the cutoff (or is soft-deleted/restored) between the two statements.
   * Dry-run responses additionally carry `pages` (slug, source_id, deleted_at) for
   * display; the destructive path returns the deleted pages in `pages` too.
   * `opts.excludeIds` keeps those page ids out of both (GBRA-130 A-49: tombstones the unmanaged belief-ledger
   * expiry failed or parked); `opts.onlyIds` limits both to those ids under the same holds (#9653 concept rebuild).
   */
  purgeDeletedPages(
    olderThanHours: number,
    opts?: { dryRun?: boolean; excludeIds?: number[]; onlyIds?: number[] },
  ): Promise<{ slugs: string[]; count: number; pages?: { slug: string; source_id: string; deleted_at: Date }[] }>;
  /**
   * v0.26.5: by default `listPages` excludes soft-deleted rows. Set
   * `filters.includeDeleted: true` to surface them.
   */
  listPages(filters?: PageFilters): Promise<Page[]>;
  /** #7191: live pages whose slug, source path or title matches a find pattern (SQL in engine-sql/page-lookup.ts). */
  findPages(query: FindPagesQuery): Promise<FoundPages>;
  /** #7191: live page counts per (source, type), with distinct-slug totals per type group when `groupTypes` is set. */
  countPagesBy(query: PageCountQuery, groupTypes?: TypeGrouper): Promise<PageCounts>;
  /** `gbrain schema detect`: live page totals of one source, typed and untyped (SQL in engine-sql/schema-detect.ts). */
  pageTypeTotals(sourceId: string): Promise<import('./engine-sql/schema-detect.ts').PageTypeTotals>;
  /** `gbrain schema detect`: the slug prefixes with at least `minPages` live pages, largest first, with their page types in byte order. */
  pagePrefixSamples(sourceId: string, minPages: number, limit: number): Promise<import('./engine-sql/schema-detect.ts').PagePrefixSample[]>;
  /** `gbrain schema detect`: live typed page counts per type, largest first (a tie in byte order), at most `limit`. */
  countPagesByTypeForSource(sourceId: string, limit: number): Promise<import('./engine-sql/schema-detect.ts').PageTypeCount[]>;
  /**
   * Fuzzy slug resolver.
   *
   * v0.41.13 (#1436): `opts.sourceId` scopes the search to a single source;
   * `opts.sourceIds` to an array (federated_read OAuth tier). Pre-fix the
   * resolver was unscoped, so MCP `get_page` with `fuzzy: true` would
   * return candidates from sources the caller couldn't actually access.
   * Source-bleed via fuzzy resolution was the bug class infiniteGameExp
   * reported as #1436. When neither opt is set, the original unscoped
   * behavior is preserved for back-compat with internal callers (the
   * `gbrain query --resolve` CLI path, etc.). Field names match the
   * `sourceScopeOpts(ctx)` helper output so callers can spread directly.
   */
  resolveSlugs(partial: string, opts?: PageReadScope): Promise<string[]>;
  /**
   * Returns the slug of every page in the brain. Used by batch commands as a
   * mutation-immune iteration source (alternative to listPages OFFSET pagination,
   * which is unstable when ordering by updated_at and writes are happening).
   *
   * v0.31.8 (D12): `opts.sourceId` scopes the result to a single source
   * (used by the source-aware reconcileLinks path so wikilink resolution
   * doesn't span unrelated sources). When omitted, returns the union of
   * slugs across every source (pre-v0.31.8 behavior).
   */
  getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>>;

  /** Duplicate finder: live, unretired pages of these types in unarchived sources with only the named frontmatter keys, keyset-paged by (source_id, slug) (SQL in engine-sql/entity-keys.ts). */
  listEntityKeyRows(opts: EntityKeyRowsOpts): Promise<EntityKeyRow[]>;
  /** The owner's identity decisions (migration v325) and the members a "same" decision could not link yet (SQL in engine-sql/identity-decisions.ts). */
  listIdentityDecisions(): Promise<IdentityDecisionsRead>;
  /** The given pages that not every reader may read: readers named, a folder rule or a private label (SQL in engine-sql/identity-decisions.ts). */
  listRestrictedIdentityMembers(members: ReadonlyArray<IdentityMemberRef>): Promise<IdentityMemberRef[]>;
  /** Writes and removes identity decisions and reconciles their 'dedupe:confirm' identity rows, in one transaction. */
  applyIdentityDecisions(input: ApplyIdentityDecisionsInput): Promise<ApplyIdentityDecisionsResult>;

  /**
   * v0.32.8: cross-source page enumeration. Returns one row per (slug,
   * source_id) pair across the brain, ordered by (source_id, slug) for
   * deterministic iteration on large brains. Used by extract-takes,
   * extract, and integrity to replace the `getAllSlugs() → getPage(slug)`
   * N+1 pattern, which silently defaulted to source_id='default' and
   * skipped non-default-source pages.
   *
   * Cheap by design: only slug + source_id + updated_at, not the full Page
   * row. For loops that need page.compiled_truth / timeline / frontmatter,
   * use `forEachPage` from src/core/engine-iter.ts instead.
   *
   * #4304: `updated_at` (the row's last DB-write time — "touched since",
   * NOT the content's authored date) is included so time-window walks like
   * `gbrain extract --since` can filter refs BEFORE fetching full pages,
   * instead of a getPage round-trip per page across the whole corpus.
   */
  listAllPageRefs(): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>>;
  /** The slugs of the source's markdown pages, soft-deleted pages included, by byte order (commands/reconcile-links.ts). */
  listMarkdownPageSlugs(sourceId: string): Promise<string[]>;
  /** who-can-read's page rows for `slug` (in `sourceId` when given), with the owner-only test of `form` (commands/access.ts). */

  /**
   * v0.38 — lean per-source enumeration for hot-loop callers (autopilot
   * dispatch, doctor freshness check). Returns the bare row shape sources-ops
   * needs without the N+1 per-source page_count enrichment in
   * `sources-ops.listSources`.
   *
   * Defaults filter out archived sources. When `localPathOnly` is true,
   * also filters `local_path IS NOT NULL` so the autopilot fan-out doesn't
   * dispatch jobs for pure-DB sources whose handler would fall back to
   * the global sync.repo_path (codex r1 P1-4).
   *
   * `config` is returned as `Record<string, unknown>` — both engines
   * already parse the JSONB at the boundary (Postgres-js returns
   * parsed objects; PGLite returns objects via its built-in JSONB
   * codec). Callers reading `config['last_full_cycle_at']` get a string.
   */
  listAllSources(opts?: {
    includeArchived?: boolean;
    localPathOnly?: boolean;
  }): Promise<SourceRow[]>;

  /**
   * v0.38 — atomic JSONB merge into sources.config. Uses Postgres's
   * `config || $patch::jsonb` operator so concurrent writers don't
   * stomp each other (last write wins, but no read-modify-write race).
   *
   * Primary caller: runCycle's exit hook writes
   *   { last_full_cycle_at: '<ISO>' }
   * after a successful per-source cycle so autopilot's freshness gate
   * can read it next tick. Resolves codex round-1 P0-5 (write site for
   * last_full_cycle_at was unspecified pre-PR).
   *
   * Returns true if a row was updated (source exists), false otherwise
   * (silently no-ops on unknown sourceId — caller decides whether that's
   * a problem).
   */
  updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean>;
  /** Sets the source's display name; false for an unknown source, which changes nothing (engine-sql/sources.ts). */
  renameSource(sourceId: string, name: string): Promise<boolean>;
  /** The remote-written pages of a source that name no readers, first five by slug, for the federation warning (engine-sql/federation-exposure.ts). */
  readFederationExposedPages(sourceId: string, hidePrivate: boolean): Promise<FederationExposureSql.FederationExposedRow[]>;

  /** One source row (id, name, local_path, last_commit, last_sync_at, config, created_at, contextual_retrieval_mode, trust_frontmatter_overrides), or null when no source has that id. */
  getSource(sourceId: string): Promise<SourceDetailRow | null>;

  /**
   * Local paths of every source that has one (non-null, non-empty), in no particular order. The filesystem lock
   * (`withSourceFilesystemLock`) canonicalizes each to pick the outermost worktree root an import locks.
   */
  listSourceLocalPaths(): Promise<string[]>;

  /** How many sources that are not archived have a non-empty local path (the readiness sync probe). */
  countRepoBoundSources(): Promise<number>;

  /**
   * Claims or renews this host's commit notifier lease (SQL and contract in engine-sql/notifier.ts): the fencing token
   * when the caller owns it (a takeover bumps it), else the current holder. notifier/store.ts claimLease.
   */
  claimNotifierLease(l: NotifierLeaseClaimInput): Promise<NotifierLeaseClaim>;

  /** This host's commit notifier lease row (owner, fence, kind, pid, expiry, live), or null when it has none. notifier/store.ts readLease. */
  readNotifierLease(hostId: string): Promise<NotifierLeaseHolder | null>;

  /** The commit notifier's fencing check: the host's lease is still `ownerId`'s, with `fence`, and unexpired. notifier/store.ts holdsLease. */
  holdsNotifierLease(hostId: string, ownerId: string, fence: number): Promise<boolean>;

  /** Expires the host's commit notifier lease now, only while `ownerId` holds it (a clean stop). notifier/store.ts releaseLease. */
  releaseNotifierLease(hostId: string, ownerId: string): Promise<void>;

  /** Every source that is not archived, in id order, as the commit notifier's host source list reads it (notifier/resident.ts). */
  listNotifierHostSourceRows(): Promise<NotifierHostSourceRow[]>;

  /** The commit notifier's per-source rows of `sourceIds` (every row when null), in source id order. notifier/store.ts readNotifierSources. */
  readNotifierSources(sourceIds: string[] | null): Promise<NotifierSourceRow[]>;

  /** One commit notifier state transition of a source; nothing when the source does not exist. notifier/store.ts writeState. */
  writeNotifierState(sourceId: string, patch: NotifierStatePatch): Promise<void>;

  /** A source's commit notifier coverage record (observed HEAD, detection mode, owner). notifier/store.ts writeCoverage. */
  writeNotifierCoverage(sourceId: string, coverage: NotifierCoverage): Promise<void>;

  /** Records the host that advanced a classic source; writes nothing when it did not change. notifier/store.ts recordSyncerHost. */
  recordNotifierSyncerHost(sourceId: string, hostId: string): Promise<void>;

  /**
   * Each source of `sourceIds` (every source when null) that is not archived, in id order, at most 200, with its notifier
   * row, whether the owner host's lease is live and how many wanted markers are still due (notifier/status.ts).
   */
  readNotifierStatusRows(sourceIds: string[] | null): Promise<NotifierStatusRow[]>;

  /** Whether a resident has recorded commit notifier coverage for any source (notifier/status.ts, the freshness notice). */
  hasNotifierCoverage(): Promise<boolean>;

  /**
   * Records (or re-records) a wanted marker: what a source should reach, for one intent class. A re-record bumps
   * generation and keeps first_due_at unless the source was re-created. Null when the source does not exist.
   * notifier/store.ts upsertMarker.
   */
  upsertWantedMarker(marker: WantedMarkerInput): Promise<WantedMarker | null>;

  /** Names the queued job that drains a wanted marker, only while the marker is still at `generation`. notifier/store.ts attachMarkerJob. */
  attachWantedMarkerJob(sourceId: string, intent: MarkerIntent, generation: number, jobId: number): Promise<void>;

  /** The wanted markers of `sourceIds` (every marker when null), oldest first_due_at first, at most 1000. notifier/store.ts readMarkers. */
  readWantedMarkers(sourceIds: string[] | null): Promise<WantedMarker[]>;

  /**
   * The wanted markers that still ask for work: pull and full markers, and freshness markers whose wanted_head is null or
   * differs from the source's last_commit. Oldest first_due_at first, at most 1000. notifier/store.ts readDueMarkers.
   */
  readDueWantedMarkers(sourceIds: string[] | null): Promise<WantedMarker[]>;

  /** Deletes the freshness and pull markers of `sourceIds` that name the head the source already reached. notifier/store.ts pruneSatisfiedMarkers. */
  pruneSatisfiedWantedMarkers(sourceIds: string[]): Promise<void>;

  /** Deletes a wanted marker only at `generation`; true when a row went. notifier/store.ts clearMarker. */
  clearWantedMarker(sourceId: string, intent: MarkerIntent, generation: number): Promise<boolean>;

  /**
   * Deletes the source's freshness marker at `generation` when a run satisfied it (no head named, the head last_commit
   * holds, or `checkoutHead` equal to last_commit). notifier/store.ts settleMarkers.
   */
  settleFreshnessMarker(sourceId: string, generation: number, checkoutHead: string | null): Promise<void>;

  /** The source's wanted markers as the sync status notifier block lists them, oldest first. notifier/status.ts readNotifierBlock. */
  listSourceWantedMarkers(sourceId: string): Promise<PendingWantedMarker[]>;

  /** Per existing source of `sourceIds`: the notifier's observed head and first due time, current incarnation only (sync-pending.ts readFirstDue). */
  readFirstDue(sourceIds: string[]): Promise<FirstDueRow[]>;
  /** A live source as a sync request sees it (local path, managed checkout root, bound to a worktree), or null when it is missing or archived. notifier/nudge.ts sourceSyncShape. */
  readSourceSyncShape(sourceId: string): Promise<SourceSyncShapeRow | null>;

  /** Each existing source's persisted first-due clock: the earlier of its notifier row's first_due_at (not idle) and its oldest due freshness marker, with the observed head. sync-pending.ts readFirstDue. */
  readNotifierFirstDue(sourceIds: string[]): Promise<NotifierFirstDueRow[]>;
  /** The raw progress row of a drain lease's holder: managed commits since `since` (ISO), the last commit and save, through the source's writer binding; null when unbound (engine-sql/persistence-journal.ts). */
  readDrainHolderProgress(sourceId: string, since: string): Promise<DrainHolderProgressRow | null>;

  /** Source resolution reads (SQL and contracts in engine-sql/sources.ts): sources with a local path and `archived`; every source row with `default`'s emptiness flag; the default-write guard's page split. */
  listLocalPathSources(): Promise<LocalPathSourceRow[]>;
  /** Every source with a local path as `{ id, local_path }` (the API-backed `sources add` overlap check). */
  listSourcePathRows(): Promise<SourcePathRow[]>;
  /** The registered path, last commit and config of a source that is not archived, or null (plain-directory sync). */
  readPlainSyncSource(sourceId: string): Promise<PlainSyncSourceRow | null>;
  /** Owner-only reads (access/owner-only.ts): does any source carry the owner-only rule; one source's raw config, or null. */
  readOwnerOnlySourcesPresent(): Promise<boolean>;
  readOwnerOnlySourceConfig(sourceId: string): Promise<{ config: unknown } | null>;
  listSourceRoutingRows(): Promise<SourceRoutingRow[]>;
  countDefaultSourceSplit(): Promise<DefaultSourceSplit>;
  /** Live sources last synced more than seven days ago by the database clock, by id (engine-sql/sources.ts). */
  listStaleSyncSourceIds(): Promise<string[]>;
  /** Every source id, archived sources included, by id (engine-sql/sources.ts). */
  listSourceIds(): Promise<string[]>;
  /** The only source's id, or null when there are none or several (engine-sql/sources.ts). */
  readSoleSourceId(): Promise<string | null>;
  /** `default` when it exists, else the lowest source id in byte order, else null (engine-sql/sources.ts). */
  readFirstSourceId(): Promise<string | null>;
  /** Locks every source row FOR UPDATE or FOR SHARE until the transaction ends (engine-sql/sources.ts). */
  lockAllSourceRows(mode: 'update' | 'share'): Promise<void>;
  /** One source's id, local_path, raw config and archived flag, or null; `lockSourceRow` reads it FOR UPDATE (engine-sql/sources.ts). */
  readSourceRow(sourceId: string): Promise<SourceCheckRow | null>;
  lockSourceRow(sourceId: string): Promise<SourceCheckRow | null>;
  /** Takes the source row's lock for the rest of the transaction and reads nothing; an unknown source is a no-op (`lockSourceForUpdate`, engine-sql/sources.ts). */
  lockSourceForUpdate(sourceId: string): Promise<void>;
  /** Whether a writer binding claims the source's current incarnation; false for an unknown source (engine-sql/sources.ts). */
  isSourceClaimed(sourceId: string): Promise<boolean>;
  /** The source's stamped chunker version, or null (engine-sql/sources.ts). */
  readSourceChunkerVersion(sourceId: string): Promise<string | null>;
  /** Stamps the source's chunker version; an unknown source changes nothing (engine-sql/sources.ts). */
  setSourceChunkerVersion(sourceId: string, version: string): Promise<void>;
  /** Advances the sync anchor: last_commit, last_sync_at and, when given, newest_content_at (null clears it); an unknown source changes nothing (engine-sql/sources.ts). */
  advanceSourceCommit(sourceId: string, commit: string, newestContentAt?: string | null): Promise<void>;
  /** The 0-change sync heartbeat: `last_sync_at` = now, the commit anchor untouched. An unknown source changes nothing. */
  writeSourceSyncHeartbeat(sourceId: string): Promise<void>;
  /** The sync's upstream observation of the source's checkout (engine-sql/sources.ts); an unknown source changes nothing. */
  writeSourceUpstreamObservation(sourceId: string, observed: SourceUpstreamObservation): Promise<void>;
  /** The frontmatter `id` and title of live page `pageId`; null for a missing or soft-deleted page. */
  readPageIdentity(pageId: number): Promise<PageIdentityRow | null>;
  /** The commit the source's last sync advanced to, or null before the first sync and for an unknown source (engine-sql/sources.ts). */
  readSourceLastCommit(sourceId: string): Promise<string | null>;
  /** Sets the source's last sync time to now; false for an unknown source, which changes nothing (engine-sql/sources.ts). */
  markSourceSynced(sourceId: string, opts?: SourceSyncStampOptions): Promise<boolean>;
  /** The managed sync checkpoint (persistence/sync-prepare.ts): an incarnation- and from-guarded anchor advance (engine-sql/sources.ts). */
  advanceSyncCheckpoint(input: SyncCheckpointAdvance): Promise<{ advanced: boolean; pinnedSlugMode: string | null }>;
  /** Pages of one source, soft-deleted pages only with `includeDeleted`; an unknown source has none (engine-sql/sources.ts). */
  countSourcePages(sourceId: string, opts?: { includeDeleted?: boolean }): Promise<number>;
  /** An unscoped remote read's `sources_not_readable` test: nothing visible in `readable`, pages elsewhere (engine-sql/sources.ts). */
  readSourcesNotReadable(readable: readonly string[], opts: SourcesNotReadableOpts): Promise<boolean>;
  /** Inserts one source row (id, name, local_path, config); a taken id or name throws and writes nothing. */
  insertSource(row: SourceInsert): Promise<void>;
  /**
   * Deletes the source (only an expired archive when `expiredArchiveOnly`) with its pages and every row that names it
   * outside a foreign key (binding, managed-sync cursors, write gate holds with their receipts, eval candidate slugs);
   * `stranded` counts the pages when the pages would not cascade, and then nothing is deleted. A RESTRICT foreign key
   * (an OAuth client of the source, revoked or not) fails it with 23503. Wrapped by `deleteSourceRow` (engine-sql/sources.ts).
   */
  deleteSourceRecord(sourceId: string, opts?: { expiredArchiveOnly?: boolean }): Promise<SourceDeleteResult>;
  /** The id, name and page/chunk/embedding/file/fact counts a source delete would remove, or null (engine-sql/sources.ts). */
  readSourceDeleteImpact(sourceId: string): Promise<SourceDeleteImpact | null>;
  /** The live pages of one source (only `slugs` when given) a sync size-state read reports, by slug (engine-sql/sources.ts). */
  readPageSizeRows(sourceId: string, maxBytes: number, slugs: readonly string[] | null): Promise<PageSizeRow[]>;
  /** Sets the page's embedding hold to `held` with `reason` (engine-sql/sources.ts). */
  holdPageEmbedding(pageId: number, reason: string): Promise<void>;
  /** The source's purged change-reason pairs by commit then path, or only `pair` when stored (engine-sql/sources.ts). */
  readReasonPurgeTombstones(sourceId: string, pair?: ReasonPurgeTombstone): Promise<ReasonPurgeTombstone[]>;
  /** Stores the purged (commit, path) change-reason pairs of a source; returns how many were new. */
  writeReasonPurgeTombstones(sourceId: string, pairs: readonly ReasonPurgeTombstone[]): Promise<number>;
  /** The same store with the pairs spread into two lists (a fact purge's receipt hits). */
  insertReasonPurgeTombstones(sourceId: string, commits: string[], paths: string[]): Promise<number>;
  /** Adds one to the source's purge epoch and returns the new value as stored, or null for an unknown source (engine-sql/sources.ts). */
  advanceSourcePurgeEpoch(sourceId: string): Promise<string | number | null>;
  /** The live pages of one source that have a source_path, in no set order (engine-sql/sources.ts). */
  listSourcePathPages(sourceId: string): Promise<SourcePathPageRow[]>;
  /** The slugs of one source's live quarantined pages, in no set order (engine-sql/sources.ts). */
  listQuarantinedSlugs(sourceId: string): Promise<string[]>;
  /** The live pages of one source whose source_path is in `paths` or whose slug is in `slugs`, in no set order (engine-sql/sources.ts). */
  readRenameIdentityRows(sourceId: string, paths: readonly string[], slugs: readonly string[]): Promise<RenameIdentityRow[]>;
  /** The live pages of one source whose frontmatter id is in `ids` or whose title is in `titles`, in no set order (engine-sql/sources.ts). */
  readLiveIdentityHolders(sourceId: string, ids: readonly string[], titles: readonly string[]): Promise<LiveIdentityHolderRow[]>;
  /** Every source with the columns `loadAllSources` reads, `default` first then by id; a schema without `archived`/`newest_content_at` omits them. */
  listSourceRecords(): Promise<SourceRecordRow[]>;
  /** A source's config and incarnation, or null for an unknown id. */
  readSourceIncarnation(sourceId: string): Promise<SourceIncarnationRow | null>;
  /** A single-source sync's routing row: the source's columns (null when unknown), its claim and company-brain receipt, and the persistence mode rows (engine-sql/sync-dispatch.ts). */
  readSyncDispatchRow(sourceId: string): Promise<SyncDispatchRow | undefined>;
  /** #9968: the ids among `sourceIds` whose bound worktree still holds a recovery record, in byte order. */
  readRetainedSources(sourceIds: readonly string[]): Promise<string[]>;
  /** Whether the source's current incarnation has a company-brain ingestion receipt. */
  hasCompanyBrainReceipt(sourceId: string): Promise<boolean>;
  /** The source's guest_sources row and whether row-level security hides guest_sources; throws the missing-table error on an old schema. */
  readGuestSourceRow(sourceId: string): Promise<GuestSourceLookupRow>;
  /** Whether guest_sources holds a row for the source (the record `guests init` writes). A Rust brain keeps none and refuses (capability guest_sources). */
  hasGuestSourceRow(sourceId: string): Promise<boolean>;
  /** Writes the source's guest_sources row, or merges `writers` into it (distinct, in byte order; the row keeps its ceiling), and answers the row (guests/sources.ts initGuestSource). */
  upsertGuestSource(sourceId: string, writers: readonly string[], trustCeiling: string): Promise<CollateGuestSources.GuestSourceRow>;
  /** The live page at `slug` in each guest source (only `guestSource` when given), by source id in byte order (guests/promote.ts). */
  listGuestNotes(slug: string, guestSource?: string): Promise<Array<{ id: number; source_id: string }>>;
  /** The guest sources (config `guest: true` or a guest_sources row) among `sourceIds`, in no particular order. */
  listGuestSourceIds(sourceIds: readonly string[]): Promise<string[]>;
  /** Whether any source is a guest source. */
  hasGuestSource(): Promise<boolean>;
  /** Trust tier, write origin, activation flag and guest flag of pages by id and by (source_id, slug). */
  readPageTrustRows(lookup: PageTrustLookup): Promise<PageTrustRow[]>;
  /** Trust tier, write origin, activation flag and pending-supersede ref of fact, take or timeline rows by id; an id with no row reads none. */
  readRowTrustRows(lookup: RowTrustLookup): Promise<RowTrustRow[]>;
  /** The database clock as a UTC ISO string with microseconds (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). */
  readDatabaseClock(): Promise<string>;
  /**
   * Page-write reads and upkeep that belong to no other domain (SQL and contracts in engine-sql/write-misc.ts). A Rust
   * brain keeps no shared skillpacks, chronicle state, access members or memory proposals, so it answers those empty.
   */
  readSourceState(sourceId: string, opts?: SourceStateOptions): Promise<SourceStateRow | null>;
  readAdmissionSource(sourceId: string): Promise<AdmissionSourceRow | null>;
  sharedSkillPackTablePresent(): Promise<boolean>;
  listSharedSkillPackRoots(hostId: string): Promise<SharedSkillPackRoot[]>;
  /** The source's writer binding with host `hostId`'s paths (null host columns for a null or unbound host); null when unbound. */
  getWorktreeBinding(sourceId: string, hostId: string | null): Promise<WorktreeBinding | null>;
  /** Every worktree host `hostId` binds, with its owner, epoch, state and topology generation, in no set order (the topology lock's local read). */
  listHostTopologyRows(hostId: string): Promise<HostTopologyRow[]>;
  /** The source bindings of one worktree, by byte source id. */
  listWorktreeMembers(worktreeId: string): Promise<Array<{ source_id: string; relative_path: string }>>;
  /**
   * The unmanaged writer claim's store (engine-sql/worktree-claim.ts). Call it on a transaction engine: it turns on
   * durable commit, locks the brain row, and every store call runs in that transaction. `claimWorktreeBinding(engine,
   * body)` opens the transaction and the store.
   */
  worktreeClaimStore(): Promise<WorktreeClaimStore>;
  /**
   * The writer topology a reviewed `--expected-state` binds to, as jsonb text (engine-sql/writer-admin.ts); the digest
   * is its SHA-256 (persistence/admin-intent.ts). `lock` holds the topology until the transaction commits.
   */
  readWriterAdminState(opts?: WriterAdminStateOptions): Promise<string>;
  /** A worktree's recorded manifest, read before a transfer accept's transaction; null when it has none or is missing. */
  readWorktreeManifest(worktreeId: string): Promise<StoredWorktreeManifest | null>;
  /** Writer status's diagnostics rows (engine-sql/writer-status.ts): a running claim untouched since `abandonedCutoff` (ISO) is abandoned. */
  readWriterDiagnosticRows(abandonedCutoff: string | null, excludedOrigins: readonly string[]): Promise<WriterDiagnosticRows>;
  /** Writer status's source bindings with `hostId`'s root, and its stopped retire requests (one source, or all). */
  readWriterStatusRows(hostId: string | null, sourceId: string | null): Promise<WriterStatusRows>;
  /** The active sources (one, or all) the writer onboarding preflight reads, by id in byte order. */
  listOnboardingSources(sourceId: string | null): Promise<OnboardingSourceRow[]>;
  /** The effects that keep the brain from quiescing, by id, at most `limit` (persistence/blocking-effects.ts). */
  listBlockingEffectRows(sourceId: string | null, limit: number, recoveringOnly: boolean): Promise<BlockingEffectRow[]>;
  /** The active worktree refreshes (of one source's worktree, or all), oldest first. */
  listActiveWorktreeRefreshRows(sourceId: string | null): Promise<ActiveWorktreeRefreshRow[]>;
  /**
   * delete_page's derived-origin carry and the label door (engine-sql/label-door.ts). The page at (sourceId, slug),
   * soft-deleted or not, when it is a privacy origin (an atom, or hidden by privacyPartSql); else null. The caller reads
   * the alias setting first (readHonorAliases).
   */
  readPrivacyOrigin(sourceId: string, slug: string): Promise<PrivacyOriginRow | null>;
  /** The pages the removal of `origins` would open (private-labels.ts dependentsSql('remove')), by (id, cleared_id). */
  listOriginDependents(origins: readonly OriginRefInput[]): Promise<OriginDependentRow[]>;
  /** Each page among `pageIds` with a recorded file, with its source's checkout path, by id. */
  listCheckoutFiles(pageIds: readonly number[]): Promise<CheckoutFileRow[]>;
  /** The page at (sourceId, slug), soft-deleted or not: its id and stored frontmatter. */
  readPageLabelRow(sourceId: string, slug: string): Promise<PageLabelRow | null>;
  /** The tiers a label guard over the page raises to: its owner-set guard tier and its open `lower_page` prior tiers. */
  readLabelGuardTiers(pageId: number): Promise<import('./engine-sql/label-door.ts').LabelGuardTiers>;
  /** Sets the page's label guard (GST-2521) to `tier`, stamped now; null removes it. */
  writePageLabelGuard(pageId: number, tier: import('./trust/tier.ts').TrustTier | null): Promise<void>;
  /**
   * The writer-admin store for writer lock and unlock and transfer prepare, accept and cancel (engine-sql/writer-admin.ts).
   * Call it on a transaction engine: it turns on durable commit, and every store call runs in that transaction.
   * `writerAdminTransaction(engine, body)` opens the transaction and the store.
   */
  writerAdminStore(): Promise<WriterAdminStore>;
  /**
   * The store of writer activation, deactivation and the pre-activation claim release (engine-sql/writer-release.ts).
   * Called on a transaction engine, every store call runs in that transaction.
   */
  writerReleaseStore(): Promise<WriterReleaseStore>;
  /**
   * The request-row reads and writes of a bound (worktree) publication around its files (engine-sql/publication-journal.ts).
   * Called on a transaction engine, every store call runs in that transaction.
   */
  publicationJournalStore(): Promise<PublicationJournalStore>;
  /** The chronicle executor's ledger, campaign and event reads and writes (engine-sql/chronicle-executor.ts); on a transaction engine, in that transaction. */
  chronicleStore(): Promise<ChronicleStore>;
  hasExtractedEvents(sourceId: string, pageId: number): Promise<boolean>;
  /** Records one chronicle ledger decision; false when its guards leave the existing row as it was. */
  upsertChronicleRow(w: ChronicleRowUpsert): Promise<boolean>;
  /** The chronicle ledger row at its primary key, every column, or null. */
  readChronicleRow(key: ChronicleRowKey): Promise<ChronicleLedgerRow | null>;
  /** Whether an automatic, extractable decision of the page at the extractor version is still pending. */
  hasPendingAutoChronicleRow(sourceId: string, pageId: number, extractorVersion: number): Promise<boolean>;
  /** The automatic chronicle judge reservations taken in the last 24 hours. */
  countRecentChronicleReservations(): Promise<number>;
  /** Takes one automatic chronicle judge slot when fewer than `limit` were taken in the last 24 hours; false at the limit. Serialized across hosts. */
  reserveChronicleJudgeSlot(limit: number, key: ChronicleJudgeKey): Promise<boolean>;
  /** Deletes the chronicle judge reservations older than 48 hours. */
  pruneChronicleReservations(): Promise<void>;
  /** Sets a config key only when it has none (`ON CONFLICT (key) DO NOTHING`). */
  insertConfigIfAbsent(key: string, value: string): Promise<void>;
  /** The stored `truth_lead` of a page by id (a segmented page's body prefix), or null. */
  readPageTruthLead(pageId: number): Promise<string | null>;
  /** The stored type, tier, title and frontmatter of a page by source and slug, soft-deleted too, or null. */
  readStoredPageHead(sourceId: string, slug: string): Promise<StoredPageHead | null>;
  /** A version's `source_path` when the version belongs to `pageId`, or null. */
  readVersionSourcePath(versionId: number, pageId: number): Promise<string | null>;
  /** The text chunk a get_page window around `chunkId` centers on, when it is a chunk of `pageId` at its live generation, or null. */
  readWindowChunk(chunkId: number, pageId: number): Promise<WindowChunkRow | null>;
  /** The chunk count of `pageId` at its live generation and how many of those chunks have a vector (get_page body none). */
  countPageChunks(pageId: number): Promise<PageChunkCounts>;
  listActiveAccessMembers(): Promise<string[]>;
  /** Whether any access member, live or not, carries the labelled-only grant; a failed read throws (engine-sql/write-misc.ts). */
  hasLabelledOnlyMember(): Promise<boolean>;
  /** Every legacy access token (`auth list`), revoked ones too, newest first. */
  listAccessTokens(): Promise<AccessTokenListRow[]>;
  /** One resumable op's completed checkpoint keys, deduplicated; `corruptParent` when a legacy array was not an array (op-checkpoint.ts). */
  readOpCheckpointKeys(op: string, fingerprint: string): Promise<{ keys: string[]; corruptParent: boolean }>;
  /** A resumable op's checkpoint parent with `keys` (sorted by the caller) as its completed keys, stamped now (op-checkpoint.ts recordCompleted). */
  writeOpCheckpointKeys(op: string, fingerprint: string, keys: string[]): Promise<void>;
  /** The checkpoint parent created or stamped now, then each path not yet banked added (op-checkpoint.ts appendCompleted). */
  appendOpCheckpointPaths(op: string, fingerprint: string, paths: string[]): Promise<void>;
  /** The checkpoint parent deleted, its paths with it; a missing row is a no-op (op-checkpoint.ts clearOpCheckpoint). */
  deleteOpCheckpoint(op: string, fingerprint: string): Promise<void>;
  /** The checkpoint's paths deleted, its parent kept (op-checkpoint.ts clearOpCheckpoint's second sweep). */
  deleteOpCheckpointPaths(op: string, fingerprint: string): Promise<void>;
  /**
   * The first completed key of each named checkpoint parent (`completed_keys->0`; null for an empty array), one entry
   * per parent found, in no stated order (engine-sql/op-checkpoint.ts). The sync import provenance records
   * (persistence/sync-holds.ts) are read this way; inside `transaction()` the read sees the transaction's writes.
   */
  readOpCheckpointRecords(op: string, fingerprints: readonly string[]): Promise<unknown[]>;
  /** Each row's checkpoint parent set to the one-element array `[record]`, stamped now; each fingerprint at most once (sync-holds.ts recordSyncImportProvenances). */
  writeOpCheckpointRecords(op: string, rows: ReadonlyArray<{ fingerprint: string; record: unknown }>): Promise<void>;
  /** The uncommitted fence-repair notices of `sourceIds` (all when null), by byte order of fingerprint (fence-repair/uncommitted.ts). */
  /**
   * A sync pass's `I⋈P` (engine-sql/sync-pass-pages.ts): the source's pages with a recorded origin and the fields of their
   * import records, for the named page ids or the keyset page after `after`, in page id order.
   */
  readSyncImportPageRows(q: SyncImportPageQuery, window: SyncImportPageWindow): Promise<SyncImportPageRow[]>;
  /** Opens the transaction's whole-source `I⋈P` cursor (Postgres's full read); read it with `fetchSyncImportPageCursor`. */
  declareSyncImportPageCursor(q: SyncImportPageQuery): Promise<void>;
  /** The open `I⋈P` cursor's next `rows` rows; fewer means it is done. */
  fetchSyncImportPageCursor(rows: number): Promise<SyncImportPageRow[]>;
  /** The principal's request rows under `requestIds`, only committed ones when `committedOnly` (engine-sql/sync-run-reads.ts; sync-admitted.ts readAdmitted). */
  readAdmittedWriteRequests(principalKind: string, principalId: string, requestIds: readonly string[], committedOnly: boolean): Promise<WriteRequest[]>;
  /** Page `pageId` of `sourceId`: its live revision and the request row id that wrote it; null for no page (sync-concurrent-write.ts). */
  readPageRevisionWriter(pageId: number, sourceId: string): Promise<PageRevisionWriter | null>;
  /** The journal request with row id `id`, projected to the `concurrent_write` proof's columns; null when absent. */
  readRevisionWriterRequest(id: string): Promise<RevisionWriterRequest | null>;
  /** The `sync.admission` dating row `[{value, set_at}]` written with the database clock; returns `set_at` as stored (sync-admission.ts writeSyncAdmission). */
  writeSyncAdmissionStamp(op: string, fingerprint: string, value: string): Promise<string>;
  /** `sync status`'s two `effective` probes of a restricted `sync.admission` (engine-sql/sync-admission.ts; sync-admission.ts syncAdmissionStatus). */
  readSyncAdmissionEffects(input: SyncAdmissionEffectsInput): Promise<{ pinned: boolean; destructive: boolean }>;
  /**
   * A checkpoint parent whose keys are JSON records (the repair runner's cursor, the preview-approval sets), or null.
   * `fresh` answers whether its stamp is within `freshWithinDays` of the database clock (null when not asked).
   */
  readOpCheckpointRecord(op: string, fingerprint: string, opts?: { freshWithinDays?: number }): Promise<OpCheckpointRecord | null>;
  /** The parent's records replaced and stamped now, in the caller's transaction; `null` deletes it with its paths. */
  writeOpCheckpointRecord(op: string, fingerprint: string, completedKeys: readonly unknown[] | null): Promise<void>;
  /** The incarnation of each known source of `sourceIds` as text, in id order (the preview hash of a repair binds it). */
  listSourceIncarnations(sourceIds: readonly string[]): Promise<SourcesIncarnationRow[]>;
  /** Writer bindings whose source or incarnation is gone, by source id (repair orphan-bindings, engine-sql/repair-bookkeeping.ts). */
  listOrphanBindings(opts?: { limit?: number }): Promise<OrphanBinding[]>;
  /** Deletes one orphan binding when it is still orphaned with no pending request; false when it was kept. */
  deleteOrphanBinding(binding: Pick<OrphanBinding, 'source_id' | 'source_incarnation'>): Promise<boolean>;
  /** A loop, its commitment fact and whether another open loop references it; `lock` locks both rows in the caller's transaction. */
  readLoopFactState(loopId: number, opts?: { lock?: boolean }): Promise<LoopFactState>;
  /** Expires an active fact of `sourceId` now, `valid_until` clipped to now; false when no active fact matched. */
  expireSourceFactNow(factId: number, sourceId: string): Promise<boolean>;
  /** Every connector-kind source, archived ones included; `lock` share-locks them in id order in the caller's transaction. */
  listConnectorSources(opts?: { lock?: boolean }): Promise<ConnectorSourceRow[]>;
  /** Connector checkpoint and retry rows whose key is not in `loadable` and that nothing pending references. */
  listOrphanConnectorCheckpoints(loadable: readonly string[], bounds: OrphanCheckpointBounds, limit: number): Promise<OrphanCheckpointRow[]>;
  /** How many connector checkpoint and retry rows carry one of `keys` as their key. */
  countConnectorCheckpointsKeyed(keys: readonly string[]): Promise<number>;
  /** Deletes one planned orphan checkpoint when the whole orphan test still holds for its stamp; false when it was kept. */
  deleteOrphanConnectorCheckpoint(row: OrphanCheckpointRow, loadable: readonly string[], bounds: OrphanCheckpointBounds): Promise<boolean>;
  /** The five reads of the managed-sync orphan classification for `sourceIds` (null: every active source; engine-sql/managed-sync-orphans.ts). */
  listManagedSyncOrphanRows(sourceIds: readonly string[] | null): Promise<ManagedSyncOrphanRows>;
  /** The ids of the archived sources. */
  listArchivedSourceIds(): Promise<string[]>;
  /** Which of `keys` have a durable `managed-sync-failure` row. */
  listManagedSyncFailureKeys(keys: readonly string[]): Promise<string[]>;
  /** The orphan retirement transaction's settings: a synchronous commit and a two-second lock wait. */
  applyManagedSyncRetireLimits(): Promise<void>;
  /** Removes a refused pass row's `slug_mode` obligation while no pass holds the lease `lockId`; false when nothing changed. */
  retireManagedSyncPassSlugMode(target: ManagedSyncRetireTarget, lockId: string): Promise<boolean>;
  /** Deletes an orphaned unfinished cursor when `mode`'s re-check still holds; its pending intent, or null when kept. */
  retireManagedSyncCursor(target: ManagedSyncRetireTarget, mode: ManagedSyncRetireMode): Promise<{ intent: unknown } | null>;
  /** Deletes the `managed-sync-failure` row under `key` when no cursor still needs it; false when kept. */
  deleteManagedSyncFailureRow(key: string, retired: boolean): Promise<boolean>;
  /** Deletes the run's `managed-sync-manifest` row when no cursor names the run; false when kept. */
  deleteManagedSyncManifest(runId: string): Promise<boolean>;
  /** The source's recorded managed-sync failures (any incarnation) by byte key, each with whether an unfinished cursor shares its key. */
  listSourceManagedSyncFailures<F = Record<string, unknown>>(sourceId: string): Promise<Array<SourceManagedSyncFailure<F>>>;
  /** Deletes the `managed-sync-failure` row under `key` while it still records `observationId`; false when it is gone or records another. */
  deleteManagedSyncFailureObservation(key: string, observationId: string): Promise<boolean>;
  /** Active owned content sources with their receipt and owner binding (engine-sql/owned-content.ts). */
  listOwnedContentRows(sourceIds: readonly string[] | null, inheritsPersistence: boolean): Promise<OwnedContentRow[]>;
  /** The source's content receipt and owner binding, or null. */
  readContentReceiptBinding(sourceId: string): Promise<ContentReceiptBinding | null>;
  /** The config value under `key`, its row locked in the caller's transaction; null when no row. */
  readConfigForUpdate(key: string): Promise<string | null>;
  /** Rows of a listed page child column whose page no longer exists (engine-sql/repair-page-reads.ts); an unlisted column throws. */
  countPageChildOrphans(target: { table: string; col: string }): Promise<number>;
  /** Deletes those orphans, or clears the reference of an ON DELETE SET NULL column; how many rows changed. */
  clearPageChildOrphans(target: { table: string; col: string }): Promise<number>;
  /** Pages whose stored body, timeline or frontmatter cannot be read back (torn TOAST): the count and the first 20 by id. */
  probeTornPages(): Promise<TornPages>;
  /** Pages of `sourceIds` after `afterId` whose stored readers differ from the readers their frontmatter names, by id. */
  listAccessReaderDrift(sourceIds: readonly string[], afterId: number): Promise<PageRef[]>;
  /** How many pages brain-wide name readers whose stored readers differ from them. */
  countAccessReaderDrift(): Promise<number>;
  /** Stores the readers the page's frontmatter names when they differ; false when nothing changed. */
  deriveAccessReaders(pageId: number): Promise<boolean>;
  /** The state of `pages_live_origin_key`, the one-live-page-per-origin invariant (#6948). */
  readOriginIndexState(): Promise<OriginIndexState>;
  /** Live duplicate-origin groups per source, by source id, at most `limit` sources. */
  listOriginTwinCounts(limit: number): Promise<OriginTwinCount[]>;
  /** Alias targets of `sourceIds` (every source when null) whose page is missing or soft-deleted, by source then slug in byte order (engine-sql/alias-orphans.ts). */
  listAliasTargets(sourceIds: readonly string[] | null): Promise<AliasTarget[]>;
  /** Deletes both alias tables' rows that resolve to `(sourceId, slug)` when it has no page row; how many rows went. */
  deleteOrphanedAliases(sourceId: string, slug: string): Promise<number>;
  /** Live pages of `sourceIds` `gbrain repair safe-chunks` re-seals or reports, by id (engine-sql/repair-page-scans.ts). */
  listSafeChunksPending(sourceIds: readonly string[]): Promise<SafeChunksPendingRow[]>;
  /** Origins two or more live pages of the source record, at most `limit`, in byte order. */
  listOriginTwinGroups(sourceId: string, limit: number): Promise<OriginTwinGroupRow[]>;
  /** Live pages recording `prefix` plus another live page's origin, by legacy id then the other's, at most `limit`. */
  listLegacyOriginPairs(sourceId: string, prefix: string, limit: number): Promise<LegacyOriginPair[]>;
  /** Live pages of the source recording any of `paths`, by id. */
  listLiveOriginPages(sourceId: string, paths: readonly string[]): Promise<LiveOriginPage[]>;
  /** The verdict inputs of the live pages of the source with these ids, by id: body digest, frontmatter id, trust tier, the no-caller page policy and slug-keyed withdrawals (the origin-twins verdict). */
  listOriginClaimants(sourceId: string, ids: readonly number[]): Promise<OriginClaimantRow[]>;
  /** How many live pages of the source record an origin (`nonBlank`: a non-blank one). */
  countLiveFileBackedPages(sourceId: string, opts?: { nonBlank?: boolean }): Promise<number>;
  /** The ghost-pages and legacy-twins page reads of one source, by id (engine-sql/repair-page-scans.ts `RepairScanQuery`). */
  listRepairScanPages(sourceId: string, q: RepairScanQuery): Promise<RepairScanPage[]>;
  /** Soft-deleted pages of the source recording a non-blank file, below `q.before`, by id descending (uncommitted-deletions). */
  listFileTombstones(sourceId: string, q: FileTombstoneQuery): Promise<FileTombstone[]>;
  /** Every tombstone a managed sync made that no live page of its source backs by content, oldest first (`expired`: older than the cutoff). */
  listUnreviewedSyncTombstones(olderThanHours: number): Promise<UnreviewedSyncTombstone[]>;
  /** What moving twin `twinId` into `survivorId` would land on (engine-sql/repair-page-scans.ts `TwinMergeLosers`). Read-only. */
  listTwinMergeLosers(survivorId: number, twinId: number): Promise<TwinMergeLosers>;
  /** Live inline pages of `sourceIds` with two or more contact rows, by id (contact-rows; engine-sql/repair-fence-scans.ts). */
  listContactRowPages(sourceIds: readonly string[], q: ContactRowQuery): Promise<RepairPageRef[]>;
  /** Live pages of `sourceIds` whose two sections each hold a facts fence, inline and segmented, by id (split-facts). */
  listSplitFactsPages(sourceIds: readonly string[]): Promise<SplitFactsPages>;
  /** World atoms of `sourceIds` whose live source page names a facts or takes fence or is segmented, by id (atom-fence-rows). */
  listAtomFenceCandidates(sourceIds: readonly string[], q: AtomFenceQuery): Promise<AtomFenceCandidate[]>;
  /** The compiled truth of the pages `ids` (null for a segmented page), any state (engine-sql/repair-fence-scans.ts). */
  listPageTruths(ids: readonly number[], opts?: { timeoutMs?: number }): Promise<Array<{ id: number; body: string | null }>>;
  /** Live pages of the source that record an origin, by slug in byte order (engine-sql/repair-plan-scans.ts). */
  listPagesByOriginPath(sourceId: string): Promise<OriginPathPageRow[]>;
  /** How many live file-backed pages of `sourceIds` store their body in segments. */
  countSegmentedOriginPages(sourceIds: readonly string[]): Promise<number>;
  /** The live segmented pages of `sourceId`, by slug in byte order (engine-sql/repair-plan-scans.ts; repair segmented-mirror). */
  listSegmentedPageSlugs(sourceId: string): Promise<string[]>;
  /** attribution-backfill: ids of the `table` rows of `sourceIds` with no attribution that exactly one committed request proves, ascending. */
  listProvenAttributionTargets(table: AttributionTable, sourceIds: readonly string[]): Promise<number[]>;
  /** attribution-backfill: how many `table` rows of `sourceIds` have no attribution. */
  countUnfilledAttribution(table: AttributionTable, sourceIds: readonly string[]): Promise<number>;
  /** failed-writes: the refused requests of `sourceIds` the preview lists, by sequence, less the fact requests a later one recovered. */
  listFailedWriteRequests(sourceIds: readonly string[], query: FailedWriteQuery): Promise<FailedWriteRow[]>;
  /** Drift audit: the source's incarnation and its newest and oldest request sequence; null for an unknown source. */
  readDriftConflictBounds(sourceId: string): Promise<DriftConflictBounds | null>;
  /** Drift audit: the window's `source_changed` conflict totals and one page of per-slug groups, by slug (engine-sql/repair-plan-scans.ts). */
  listDriftConflictGroups(sourceId: string, query: DriftConflictQuery): Promise<DriftConflictGroups>;
  /** Drift audit: the newest committed receipt of each slug and, with `paths`, each live page's recorded file. */
  readDriftConflictDetails(sourceId: string, slugs: readonly string[], opts: { paths: boolean }): Promise<DriftConflictDetails>;
  /** GST-1209: live segmented pages of unarchived sources whose live rows do not tile the body, by source and slug. */
  listUntiledSegmentedPages(opts?: UntiledPageQuery): Promise<UntiledPage[]>;
  /** The first record of each `op` checkpoint naming a source and its current incarnation, by source then fingerprint. */
  listSourceHoldRecords(op: string, opts?: SourceHoldQuery): Promise<SourceHoldRecordRow[]>;
  /** Adds paths to a Git source's retry request, once each in byte order, stamped `requestedAt` (engine-sql/git-holds.ts). */
  requestGitHoldRetry(sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string): Promise<void>;
  /** A repair's busy-set rows: the source's open requests, its unfinished sync cursors and held paths (engine-sql/repair-busy.ts). */
  readRepairBusyRows(sourceId: string, incarnation: string): Promise<RepairBusyRows>;
  /** The checkpoints stamped more than `ttlDays` days ago and not exempt deleted with their paths; how many (op-checkpoint.ts purgeStaleCheckpoints). */
  purgeStaleCheckpoints(ttlDays: number): Promise<number>;
  /** The request, OAuth client, legacy token and local writer rows that name write attributions (ops/attribution.ts). */
  readWriteAttributionNames(ids: WriteAttributionNameIds): Promise<WriteAttributionNames>;
  /** A page's live revision with the actor that wrote it, its trust tier and write origin; null for no page. */
  readPageRevisionAttribution(pageId: number): Promise<PageRevisionAttributionRow | null>;
  /** Each listed version's writer, archiving writer and trust tier. */
  readVersionAttributions(versions: VersionRef[]): Promise<VersionAttributionRow[]>;
  /** The writer of a page's oldest version snapshot; null when it has none. */
  readOldestVersionAttribution(pageId: number): Promise<ActorAttributionRow | null>;
  /** The fact, take or timeline entry `target` names with its write receipts, filtered before the pick; null when none is visible. */
  readRowAttribution(target: RowAttributionTarget): Promise<RowAttributionRow | null>;
  /** The get_health memo's page clock: a string that changes whenever a page is written (health-memo.ts). */
  readHealthMemoClock(): Promise<string>;
  /** The live sources whose own contextual-retrieval mode is per_chunk_synopsis, by id (synopsis-sweep.ts). */
  listSynopsisSourceIds(): Promise<string[]>;
  /** The synopsis tier's sources and whether trusted page frontmatter picks the tier (synopsis-sweep.ts); skips the page check when asked. */
  readSynopsisTierSources(skipFrontmatter: boolean): Promise<SynopsisTierSql.SynopsisTierSources>;
  /** Sets a source's own contextual-retrieval mode, or clears it (null); false when the source does not exist (sources set-cr-mode). */
  setSourceContextualMode(sourceId: string, mode: string | null): Promise<boolean>;
  /** Whether a live markdown page of a source that trusts its frontmatter names the synopsis tier there (synopsis-sweep.ts; engine-sql/write-misc.ts). */
  hasSynopsisFrontmatterOverride(): Promise<boolean>;
  /** Inserts an access member, creates its missing groups, adds it to each and binds the token, in one transaction (engine-sql/access-members.ts). */
  insertAccessMember(spec: AccessMembersSql.AccessMemberInsert): Promise<{ groupsCreated: string[] }>;
  /** Disables an access member (an earlier disable time is kept) or enables it. */
  setAccessMemberDisabled(id: string, disabled: boolean): Promise<void>;
  /** Sets (or, with null, clears) the email of a member that is not removed; true when a row changed. */
  setAccessMemberEmail(id: string, email: string | null): Promise<boolean>;
  /** Sets the kind of a member that is not removed. */
  setAccessMemberKind(id: string, kind: AccessMembersSql.AccessMemberKind): Promise<void>;
  /** Sets or clears the labelled-only grant of a member that is not removed. */
  setAccessMemberLabelledOnly(id: string, labelledOnly: boolean): Promise<void>;
  /** Marks a member removed (and disabled), clears its email and drops its group memberships, in one transaction. */
  tombstoneAccessMember(id: string): Promise<void>;
  /** Creates the group when missing and adds each member, in one transaction; true when the group was created. */
  addAccessGroupMembers(groupId: string, memberIds: readonly string[]): Promise<boolean>;
  /** Drops each named member from the group. */
  removeAccessGroupMembers(groupId: string, memberIds: readonly string[]): Promise<void>;
  /** Deletes the group and its memberships. */
  deleteAccessGroup(id: string): Promise<void>;
  /** Member links (v286, engine-sql/access-members.ts): read one exactly, add one, remove one, list all or one member's. */
  readAccessMemberLink(system: string, externalId: string): Promise<AccessMembersSql.AccessMemberLinkRow | null>;
  insertAccessMemberLink(system: string, externalId: string, memberId: string): Promise<void>;
  deleteAccessMemberLink(system: string, externalId: string): Promise<void>;
  listAccessMemberLinks(memberId: string | null): Promise<AccessMembersSql.AccessMemberLinkRow[]>;
  /** A credential's binding columns locked FOR UPDATE (inside the binding's transaction), or undefined. */
  readCredentialBindingForUpdate(target: AccessMembersSql.CredentialTarget, opts: { readsUnscoped: boolean }): Promise<AccessMembersSql.CredentialBindingRow | undefined>;
  /** The member a credential is bound to (a revoked or deleted one too, nothing locked), or null. */
  readCredentialMemberId(target: AccessMembersSql.CredentialTarget): Promise<string | null>;
  /** The brain-audience heuristic's binding read: each live token (by name) and live OAuth client (by client id) among `names`, with its member. */
  listCredentialMemberBindings(names: readonly string[]): Promise<AccessMembersSql.CredentialMemberBinding[]>;
  /** A legacy token's attest columns and revoked_at by id text, revoked or not, or null (access/actor.ts attestRightOf). */
  readAccessTokenAttest(id: string): Promise<AccessMembersSql.AccessTokenAttestRow | null>;
  /** An OAuth client's attest columns, deleted_at, grant types and confidential flag by client_id, or null; `lock` is FOR UPDATE. */
  readOauthClientAttest(clientId: string, opts?: { lock?: boolean }): Promise<AccessMembersSql.OauthClientAttestRow | null>;
  /** The enabled member linked to (system, externalId), with its groups, or null (access/actor.ts linkedMember). */
  readLinkedMember(system: string, externalId: string): Promise<AccessMembersSql.LinkedMemberRow | null>;
  /** Writes a credential's member, may_act_for and attest columns. */
  writeCredentialBinding(target: AccessMembersSql.CredentialTarget, binding: AccessMembersSql.CredentialBinding): Promise<void>;
  /** Sets a credential's reads_unscoped to now() (true) or clears it (false). */
  writeCredentialReadsUnscoped(target: AccessMembersSql.CredentialTarget, readsUnscoped: boolean): Promise<void>;
  expireMemoryProposals(reason: string): Promise<number>;
  listAwaitingMemoryProposals(limit: number): Promise<Array<Record<string, unknown>>>;
  /** The memory proposal a principal holds under `requestId` (a uuid), as its stored row, or null. */
  readMemoryProposal(principalKind: string, principalId: string, requestId: string): Promise<Record<string, unknown> | null>;
  purgeMemoryProposals(retentionDays: number): Promise<number>;
  /** How many memory proposals await their owner unexpired, and the oldest one's age in hours; null for no row. */
  readPendingProposalSummary(): Promise<PendingProposalRow | null>;
  /** One page of the owner's memory-proposal list, oldest first, as stored rows. */
  listMemoryProposalRows(query: ProposalListQuery): Promise<Array<Record<string, unknown>>>;
  /** The stored proposals of any credential with this request id, at most two. */
  listOwnerProposalRows(requestId: string): Promise<Array<Record<string, unknown>>>;
  /** Attach a working tree to an existing path-less source (`sources add --path`); an unknown id changes nothing. */
  attachSourcePath(sourceId: string, localPath: string, opts?: AttachSourcePathOptions): Promise<void>;
  /** Every live page (of one source when given) with aliases and knowledge revision, by source then slug. */
  listLinkPageMetadata(sourceId?: string): Promise<LinkPageMetadataRow[]>;
  /** The live pages of one source whose slug is in `slugs`, by slug. */
  listLinkPageMetadataForSlugs(sourceId: string, slugs: readonly string[]): Promise<LinkPageMetadataRow[]>;
  /** One source's pages (of `slugs` when given) with a body or frontmatter self `attended` link, in no set order. */
  listAttendedOriginSlugs(sourceId: string, slugs?: readonly string[]): Promise<string[]>;
  /** A page's stored non-event timeline rows, in no particular order. */
  listStoredTimelineRows(sourceId: string, slug: string): Promise<StoredTimelineRow[]>;
  /** The live pages among `refs` still at the knowledge revision each names, in no particular order. */
  filterPagesAtRevision(refs: readonly PageAtRevisionRef[]): Promise<Array<{ slug: string; source_id: string }>>;

  /**
   * v0.37.0 — prefix-stratified page sampling for `gbrain brainstorm` / `gbrain lsd`
   * domain-bank module. Takes a caller-supplied prefix list (cached at the domain-bank
   * layer per D3), returns one page per prefix tiebroken by `connection_count`
   * (LEFT JOIN to page_links, count of inbound links).
   *
   * Stale-bias (D5 / LSD): when `opts.staleBias === true`, ROW_NUMBER() ORDER BY
   * prefers pages with `last_retrieved_at IS NULL` (never retrieved) > pages older
   * than `staleThresholdDays` (default 90) > recently-retrieved.
   *
   * Source scoping (D5, codex r2 #2 fix): `sourceId` (scalar) and `sourceIds`
   * (array, wins over scalar) per the [source-id-canonical-thread] pattern.
   * Both threaded from day 1 even though v0.37.0 callers are CLI-local — D7
   * MCP exposure ships zero-refactor.
   *
   * Soft-deleted pages (deleted_at IS NOT NULL) excluded automatically.
   */
  listPrefixSampledPages(opts: DomainBankSampleOpts): Promise<DomainBankRow[]>;

  /**
   * v0.37.0 — corpus-sampling fallback for `gbrain brainstorm` when prefix-stratified
   * can't fill M (small brain, single-prefix corpus). Random sample of N pages with
   * the same exclusion + source-scope semantics as `listPrefixSampledPages`.
   * Deterministic with `opts.seed` set; falls back to RANDOM() otherwise.
   *
   * Returns the same `DomainBankRow` shape so the orchestrator can union both
   * sources of pages and dedup by slug+source_id.
   */
  listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]>;

  /**
   * Records now as the retrieval time of each page id that names a page (last-retrieved.ts bumpLastRetrievedAt),
   * unless its record is under 5 minutes old. The samplers above read it as `last_retrieved_at`. An empty list
   * writes nothing.
   */
  bumpPageRetrievals(pageIds: number[]): Promise<void>;
  /** repair atoms-restore: the restorable re-extraction retirements of the sources (or atom `atomId`), by id (engine-sql/atom-restore-reads.ts). */
  listRestorableAtoms(sourceIds: readonly string[], atomId: number | null): Promise<import('./engine-sql/atom-restore-reads.ts').RestorableAtomRow[]>;
  /** The re-extraction retirements of the sources the restore rule keeps, by reason. */
  countKeptAtomRetirements(sourceIds: readonly string[]): Promise<{ origin_gone: number; replaced: number; older_generation: number }>;
  /** moved-pages: the live pages of a source (but one) whose recorded path is one of `paths`, by id (engine-sql/moved-page-reads.ts). */
  listLivePagesBySourcePaths(sourceId: string, excludeId: number, paths: readonly string[]): Promise<import('./engine-sql/moved-page-reads.ts').MovedPageRow[]>;
  /** At most five live pages of a source (but one) whose recorded path is `name` or ends in `/name`, by slug. */
  listLivePagesByFileName(sourceId: string, excludeId: number, name: string): Promise<Array<{ slug: string; source_path: string }>>;
  /** At most five other live pages of a source sharing page `pageId`'s frontmatter `id`, by slug. */
  listLivePagesSharingFrontmatterId(sourceId: string, pageId: number): Promise<string[]>;
  /** Whether the page or one of its versions is stored in segments. */
  hasSegmentedHistory(pageId: number): Promise<boolean>;
  /** The live page of a source holding the meeting (frontmatter `meeting_id`), lowest id first; null when none (SQL in engine-sql/meeting-pages.ts). */
  readMeetingPage(sourceId: string, meetingId: string): Promise<import('./engine-sql/meeting-pages.ts').MeetingPageRow | null>;
  /** At most two live person pages of a source an attendee name can mean: by slug, lower(title) or a lower(alias) (SQL in engine-sql/attendance-pages.ts). */
  listAttendanceMatches(sourceId: string, slugs: readonly string[], name: string): Promise<string[]>;
  /** Stamps a source's first connector sync attempt once (`seed` for a new state row); false for an unknown source (SQL in engine-sql/connector-attempts.ts). */
  recordConnectorSyncAttempt(sourceId: string, at: string, seed: readonly unknown[]): Promise<boolean>;
  /** Writes an unmanaged connector's cursor row, keeping its last run when `record` has no `last_run` key (SQL in engine-sql/connector-db-cursor.ts). */
  writeConnectorDbCursor(key: string, record: readonly unknown[]): Promise<void>;
  /** The named live pages of a source with their revision and recorded path. */
  readLivePagesByIds(sourceId: string, ids: readonly number[]): Promise<import('./engine-sql/moved-page-reads.ts').MovedPageRow[]>;
  /** repair lost-fence-rows: the retired fence items of unproven, unheld page fence generations (engine-sql/lost-fence-reads.ts). */
  listRetiredFenceItems(sourceIds: readonly string[], only: { source_id: string; slug: string } | null): Promise<import('./engine-sql/lost-fence-reads.ts').RetiredFenceItem[]>;
  /** The page's inline version bodies and timelines, by id. */
  listInlineVersionTexts(pageId: number): Promise<Array<{ id: number; compiled_truth: string; timeline: string | null }>>;
  /** Whether the page holds an unexpired fact with this text and visibility. */
  hasActiveFactText(sourceId: string, slug: string, fact: string, visibility: string): Promise<boolean>;
  /** Whether the page holds a take with this claim. */
  hasTakeClaim(pageId: number, claim: string): Promise<boolean>;
  /** The stored trust tier of a fact, or null. */
  readFactTrustTier(id: number): Promise<string | null>;
  /** The row numbers of every fact the page holds, ascending. */
  listFenceFactRowNums(sourceId: string, slug: string): Promise<number[]>;
  /** The row numbers of every take of the page, ascending. */
  listTakeRowNums(pageId: number): Promise<number[]>;
  /** The id and tier of the page's unexpired fact at a row number with this text, or null. */
  readLiveFactRowTier(sourceId: string, slug: string, rowNum: number, fact: string): Promise<{ id: number; trust_tier: string | null } | null>;
  /** The id and tier of the take at a row number of the page with this claim, or null. */
  readTakeRowTierByClaim(pageId: number, rowNum: number, claim: string): Promise<{ id: number; trust_tier: string | null } | null>;
  /** repair stale-atoms: the live atoms whose origin is gone or moved past them with a completed extraction, by (class, id) (engine-sql/stale-atom-reads.ts). */
  listStaleAtoms(sourceIds: readonly string[], atomId: number | null): Promise<import('./engine-sql/stale-atom-reads.ts').StaleAtomRow[]>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  /** Cat 40 Hard F2: pages matching searchKeyword's strict query (never the OR retry), capped at KEYWORD_COUNT_CAP + 1; `timeoutMs` bounds the Postgres statement. */
  countKeywordPages(query: string, opts?: SearchOpts & { timeoutMs?: number }): Promise<number>;
  /** Cat 40 Hard F2: `match: "keyword"` pages, best chunk each, ordered (score DESC, page_id ASC) with no global chunk cap. */
  searchKeywordPages(query: string, opts: SearchOpts | undefined, page: KeywordPageWindow): Promise<SearchResult[]>;
  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm.
   *
   * content_chunks.search_vector never includes the page TITLE (it is
   * doc_comment + symbol_name_qualified + chunk_text), so a page whose
   * title tokens are absent from its body is unreachable by searchKeyword.
   * This arm queries the PAGE-GRAIN DOCUMENT vector pages.search_vector —
   * NOT titles alone: per pageSearchVectorSql it is title ('A') + the
   * first 65,536 chars of the sanitized timeline ('C'); no compiled_truth
   * since v124. Ranked by ts_rank_cd, the 'A' title dominates, but
   * timeline matches also produce (lower-ranked) candidates. Returns page-grain hits joined to
   * ONE representative chunk per page (compiled_truth preferred, else
   * lowest chunk_index) so rows are shaped like searchKeyword's output and
   * can enter RRF fusion in hybridSearch.
   *
   * Deliberately NO query-length gating — unlike the alias hop (≤6-token
   * guard) and the title-phrase re-rank boost, this arm must GENERATE
   * candidates for long exact-title queries, which is exactly where
   * chunk-grain AND FTS is weakest.
   */
  searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  /**
   * Hydrate embeddings for chunks already known by id. v0.36 (D9):
   * optional `column` parameter selects which content_chunks column to
   * fetch from (default 'embedding'). The dynamic-embedding-column
   * search path hands its resolved column name here so cosineReScore
   * rehydrates in the right embedding space — otherwise vector search
   * against `embedding_voyage` would HNSW-rank against Voyage but
   * rescore against OpenAI vectors (NaN / wrong rankings).
   *
   * The column name MUST be regex-validated by the caller (resolveEmbed-
   * dingColumn rejects bad names). Engines identifier-quote on
   * interpolation as defense in depth (D12).
   */
  getEmbeddingsByChunkIds(ids: number[], column?: string): Promise<Map<number, Float32Array>>;
  /** Text-space cosine per visible chunk id with an embedding in `column`, computed in the database; absent ids did not hydrate (SQL in engine-sql/search-reads.ts). */
  cosinesByChunkIds(ids: number[], column: string, query: Float32Array): Promise<Map<number, number>>;
  // Search ranking-stage reads (hybrid search after fusion; SQL in engine-sql/search-reads.ts).
  /** Whether any `supersedes` link exists (one index probe). */
  hasSupersedeEdges(): Promise<boolean>;
  /** Superseded page id -> slug of a live same-source page that supersedes it; under a policy all three pages must be readable. */
  supersedingPageSlugs(pageIds: number[], policy?: PageReadPolicy): Promise<Map<number, string>>;
  /** The refs that are the canonical slug of a `slug_aliases` row, on a page the policy may read. */
  aliasCanonicalRefs(refs: Array<{ slug: string; source_id: string }>, policy?: PageReadPolicy): Promise<Array<{ source_id: string; canonical_slug: string }>>;
  /** Collapse facts per existing page id: redirect target, bounded body length and, for `bodyIds`, body md5 and lead. */
  pageCollapseFacts(ids: number[], bodyIds: number[]): Promise<PageCollapseFactRow[]>;
  /** Up to two live slugs in a source that are `word` or end in `/word`. */
  slugsEndingIn(sourceId: string, word: string): Promise<string[]>;
  /** The pages among `ids` gbrain generated (`dream_generated: true` or type `extract_receipt`). */
  generatedPagesIn(ids: number[]): Promise<GeneratedPageRow[]>;
  /** Ids of the live pages at the given (source id, slug) refs. */
  livePageIdsAt(refs: Array<{ slug: string; source_id: string }>): Promise<number[]>;
  /** The pages among `fromIds` with a ranking link to a page in `toIds`. */
  pagesLinkingTo(fromIds: number[], toIds: number[]): Promise<number[]>;
  /** One brain-wide MCP onboarding count (SQL in engine-sql/health.ts). */
  countOnboardSignal(signal: OnboardSignal, entityTypes: EntityTypeFilter, opts?: { signal?: AbortSignal }): Promise<number>;
  /** Live pages brain-wide, or null when unreadable (backup coverage; SQL in engine-sql/health.ts). */
  countBrainLivePages(): Promise<number | null>;
  /** Live pages per source, one row per source that has any (`gbrain sources status`; SQL in engine-sql/health.ts). */
  countLivePagesBySource(): Promise<import('./engine-sql/health.ts').LivePagesBySourceRow[]>;
  /** Chunks of live pages per source and those embedded in `column`, the active embedding column (`gbrain sources status`; SQL in engine-sql/health.ts). */
  countChunksBySource(column: string): Promise<import('./engine-sql/health.ts').ChunksBySourceRow[]>;
  /** Live pages, active facts and the earliest source or page timestamp, brain-wide (backup coverage; engine-sql/health.ts). */
  readBrainMaturity(): Promise<BrainMaturityRow | null>;
  /** Graph counts and endpoint reads of doctor, orphans, graph-query, the entity card, link preparation and search (SQL and contracts in engine-sql/link-reads.ts). */
  inboundLinkCoverage(opts?: { sourceIds?: string[] }): Promise<{ livePages: number; linkedPages: number }>;
  listJunkEntityHubs(opts: { edgeThreshold: number; maxChunks: number; limit: number }): Promise<JunkEntityHubRow[]>;
  countEntityPages(filter: EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }): Promise<number>;
  entityGraphCoverage(filter: EntityTypeFilter): Promise<{ entities: number; connected: number; withTimeline: number } | null>;
  entityFeatureCoverage(filter: EntityTypeFilter, feature: 'links' | 'timeline', opts?: { samplePercent?: number }): Promise<{ sampleSize: number; matched: number }>;
  countDatedMeetingPages(): Promise<number>;
  countForeignEdges(slug: string, sourceId: string, direction: 'in' | 'out' | 'both'): Promise<number>;
  listLivePageSummaries(scope?: PageReadScope): Promise<LivePageSummary[]>;
  countInboundLinks(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }): Promise<number>;
  readEntityInboundEdges(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }): Promise<EntityInboundEdgeRow[]>;
  listLinkEndpointPages(sourceId: string, slugs: string[], crossSourceSlugs: string[]): Promise<LinkEndpointPage[]>;
  listPagesTitledIn(queryLower: string, scope: PageReadScope): Promise<TitledPage[]>;
  wordLexemes(words: string[]): Promise<Map<string, string[]>>;
  /** The stored link rows and origin page bodies behind returned link contexts, for a world-only caller (eligibility/fence-overlay.ts worldLinkContexts). */
  readLinkContextMatches(asks: readonly LinkContextAsk[]): Promise<LinkContextMatch[]>;
  readLinkContextOriginPages(ids: readonly number[]): Promise<LinkContextOriginPage[]>;
  /** Link temporal state: relationship evidence and state rows, temporal link rows, manual transitions and their reads (SQL and contracts in engine-sql/link-temporal.ts). */
  readLinkRelationshipEvidence(keys: readonly RelationshipKey[]): Promise<RelationshipEvidence>;
  /** Upsert and remove relationship state rows; returns how many rows changed. */
  writeLinkRelationshipState(write: RelationshipStateWrite): Promise<number>;
  linkRelationshipKeysForPages(pageIds: readonly number[]): Promise<RelationshipKey[]>;
  staleLinkRelationshipKeys(limit: number): Promise<RelationshipKey[]>;
  linkRelationshipKeysForOrigin(pageId: number): Promise<RelationshipKey[]>;
  applyLinkTemporalRows(input: LinkTemporalSql.LinkTemporalRows): Promise<LinkTemporalSql.LinkTemporalApplied>;
  writeManualLinkTransitions(rel: LinkTemporalSql.ManualLinkRelationship, rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>): Promise<{ inserted: number; key: RelationshipKey | null }>;
  removeManualLinkTransitions(rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }): Promise<RelationshipKey[]>;
  listRelationshipNoteRows(subjects: ReadonlyArray<{ slug: string; source_id: string }>, opts: { excludePrivate: boolean }): Promise<LinkTemporalSql.RelationshipNoteRow[]>;
  edgeValidityCounts(opts: { sourceIds?: readonly string[]; staleLimit: number }): Promise<LinkTemporalSql.EdgeValidityCounts | null>;
  listPageStatusByRef(refs: ReadonlyArray<{ source_id: string; slug: string }>, scope: { excludePrivate: boolean; includeQuarantined?: boolean }): Promise<Array<{ source_id: string; slug: string; status: unknown }>>;
  listRecordMetadataRows(pageIds: readonly number[], scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }): Promise<LinkTemporalSql.RecordMetadataRows>;
  readReferrerGroupRows(target: { sources: readonly string[]; slugs: readonly string[] }, scope: LinkTemporalSql.ReferrerGroupScope): Promise<LinkTemporalSql.ReferrerGroupRow[]>;
  readReferrerPageDetails(ids: readonly number[]): Promise<LinkTemporalSql.ReferrerPageDetailRow[]>;
  /** A live page's `COALESCE(effective_date, updated_at)` as UTC microsecond text, or null (the newer-mentions cutoff). */
  readPageReferenceDate(sourceId: string, slug: string): Promise<string | null>;
  readReferrerTargetCounts(target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
    scope: LinkTemporalSql.ReferrerTargetCountScope): Promise<LinkTemporalSql.ReferrerTargetCountRow[]>;
  /** The referrer page (get_backlinks group "page") and the card's record rows (mentions/referrers.ts). */
  listReferrerTargetSources(slug: string, sources: readonly string[]): Promise<string[]>;
  countReferrerRows(target: { sources: readonly string[]; slugs: readonly string[] }, scope: LinkTemporalSql.ReferrerRowScope): Promise<number>;
  readReferrerRows(target: { sources: readonly string[]; slugs: readonly string[] },
    scope: LinkTemporalSql.ReferrerRowScope & { cursor: readonly [string | null, string, string] | null; limit: number }): Promise<LinkTemporalSql.ReferrerRow[]>;
  readReferrerRecordCandidates(target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
    scope: LinkTemporalSql.ReferrerRecordCandidateScope): Promise<LinkTemporalSql.ReferrerRecordCandidateRow[]>;
  readReferrerRecordPages(ids: readonly number[]): Promise<LinkTemporalSql.ReferrerRecordPageRow[]>;
  /** The canonical and stored types among an entity's referrers (the unknown-type error of get_backlinks). */
  readReferrerTypes(target: { sources: readonly string[]; slugs: readonly string[] }, scope: LinkTemporalSql.ReferrerTypeScope): Promise<LinkTemporalSql.ReferrerTypeRow[]>;
  /** reindex-search-vector's steps (SQL in engine-sql/search-vector.ts and search-vector-backfill.ts). */
  countSearchVectorRows(): Promise<{ pages: number; chunks: number }>;
  replaceSearchVectorTriggerFunction(target: 'pages' | 'chunks', lang: string): Promise<void>;
  backfillSearchVectors(target: 'pages' | 'chunks', opts: Pick<VectorBackfillOpts, 'lang' | 'checkpoint' | 'tick'>): Promise<number>;
  ensureFactsKeywordIndex(lang: string, notice?: (line: string) => void): Promise<'present' | 'swapped'>;
  /** Retrieval coverage counts in a read scope; null when a count fails (SQL in engine-sql/retrieval-coverage.ts). */
  countPendingProjectionPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null>;
  countEmbeddingHeldPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null>;
  projectionRebuildProgress(scope: ProjectionReadinessScope): Promise<ProjectionRebuildProgress | null>;
  /**
   * The readiness probe (search/projection-readiness.ts): the generation its cached answer depends on (null when no
   * stable generation can be read, so the probe does not cache), and whether the scope has unsealed pages that need
   * work (`pending`) or only protected pages no repair seals (`by_design`). The second throws when the read fails.
   */
  readProjectionReadinessGeneration(): Promise<string | null>;
  readProjectionReadiness(scope: ProjectionReadinessScope): Promise<ProjectionReadinessRow>;
  /** Code-symbol lookups, code readiness probes, doctor chunk counts, withdrawal's chunk scan, contextual-mode and frozen hits (SQL and contracts in engine-sql/chunk-reads.ts). */
  findCodeDefinitions(symbol: string, opts?: CodeSymbolQuery): Promise<CodeDefinitionRow[]>;
  listSymbolTypesForName(symbol: string, opts?: Omit<CodeSymbolQuery, 'limit'>): Promise<Array<string | null>>;
  findCodeRefChunks(symbol: string, opts?: CodeSymbolQuery): Promise<CodeRefChunkRow[]>;
  countOversizedEmbedSkips(maxBytes: number): Promise<{ marked: number; chunkless: number }>;
  countOrphanChunks(): Promise<number>;
  countCodeChunkPages(): Promise<{ chunks: number; pages: number }>;
  codeChunksExist(sourceId: string | undefined, policy?: PageReadScope): Promise<boolean>;
  /** Whether a live page in scope is below the safe-chunk fence, under search's type and slug-prefix filters. */
  hasUnsealedPages(scope: UnsealedPageScope): Promise<boolean>;
  currentCodeChunksExist(scope: CodeChunkScope, predicate: 'any' | 'with_symbol'): Promise<boolean>;
  listQualifiedSymbolNames(sourceId: string, symbol: string, opts: { match: 'exact' | 'contains'; limit: number }): Promise<string[]>;
  listWithdrawalChunks(sourceId: string, keys: WithdrawalChunkKey[], opts: { after: number; limit: number; subjects: string[] | null }): Promise<WithdrawalChunkRow[]>;
  deleteChunksForPages(pageIds: readonly number[]): Promise<void>;
  listContextualModeCandidates(sourceIds: string[]): Promise<ContextualModeCandidate[]>;
  resolveFrozenHits(hits: FrozenHitKey[], scope: PageReadScope): Promise<FrozenHitRow[]>;
  /** Doctor's effective-date sample and timeline clock, the projection's stored-timeline read and delete, repair timeline's reads, the orphan prune's walk (SQL and contracts in engine-sql/timeline-reads.ts). */
  sampleEffectiveDates(): Promise<EffectiveDateSampleCounts>;
  sampleEffectiveDateSources(): Promise<EffectiveDateFallbackRow[]>;
  readMaxTimelineEntryId(): Promise<number>;
  listStoredTimelineRowsOrdered(pageId: number): Promise<OwnTimelineRow[]>;
  deleteTimelineRows(pageId: number, deletions: readonly TimelineRowDeletion[]): Promise<Array<{ date: string; removed: boolean }>>;
  storedTimelineRowsByPageIds(pageIds: readonly number[]): Promise<PageTimelineRow[]>;
  countSegmentedTimelinePages(sourceIds: readonly string[], limit: number): Promise<SegmentedTimelinePages>;
  countTimelineCommentMarkupRows(sourceIds: readonly string[]): Promise<number>;
  listTimelineOrphanPages(opts: { afterId: number; limit: number; sourceId?: string }): Promise<TimelineOrphanPage[]>;
  /** The page and row scans of repair timeline, timeline-comments, timeline-order and connector-fences, the retraction check's version reads and the comment-row rewrite (SQL and contracts in engine-sql/timeline-repair-reads.ts). */
  listTimelineHistoryPages(sourceIds: readonly string[], q: TimelineHistoryQuery): Promise<TimelineRepairPage[]>;
  listTimelineVersionWitnesses(sourceId: string, slug: string): Promise<TimelineVersionWitness[]>;
  readTimelineVersionBody(pageId: number, versionId: number): Promise<TimelineVersionBody | null>;
  listTimelineMarkupRows(q: TimelineMarkupQuery): Promise<TimelineMarkupRow[]>;
  listMaterializedMarkerPages(sourceIds: readonly string[], afterId: number): Promise<TimelineRepairPage[]>;
  rewriteTimelineRow(pageId: number, row: TimelineRowRewrite): Promise<void>;
  listDateBulletPages(sourceIds: readonly string[], afterId: number, slugs: readonly string[], limit: number): Promise<TimelineRepairPage[]>;
  listConnectorFencePages(sourceIds: readonly string[], kinds: readonly string[], segmented: boolean): Promise<ConnectorFencePage[]>;
  /** The search telemetry flush and window read, the MCP usage read and its pruned-window probe (SQL and contracts in engine-sql/telemetry.ts). */
  recordSearchTelemetry(bucket: SearchTelemetryBucket): Promise<void>;
  readSearchStats(cutoffDate: string): Promise<SearchTelemetryRow[]>;
  readClientOpUsage(days: number): Promise<McpOpUsageRow[]>;
  readMcpRollupPrunedBefore(): Promise<McpRollupPrunedBefore>;
  /** The MCP request log insert, its retention prune and the lifetime usage read (SQL and contracts in engine-sql/telemetry.ts). */
  logMcpRequest(row: McpRequestLogRow): Promise<void>;
  readMcpLogPruneCutoff(days: number): Promise<McpLogPruneCutoff>;
  pruneMcpRequestLogBatch(cutoff: string, keepOperations: readonly string[], limit: number): Promise<McpLogPruneBatch>;
  readMcpLifetimeUsage(tokenNames: readonly string[]): Promise<McpLifetimeUsageRow[]>;
  /** The request log rows of the last 24 hours: all of them, the traffic, or the failed traffic (the admin dashboard counts). */
  countMcpRequestsLastDay(kind: McpRequestCountKind): Promise<number>;
  /** One page of the request log, newest first, with the filtered total (`/admin/api/requests`). */
  readMcpRequestLogPage(spec: McpRequestLogPageSpec): Promise<McpRequestLogPage>;
  /** In-flight writes, the oldest one's age in seconds, and the pending writes of the last day that later failed (`/admin/api/health-indicators`). */
  readPendingWriteHealth(): Promise<PendingWriteHealth>;
  /** Requests of the last 24 hours per asked token; a token with none has no row. */
  countMcpRequestsLastDayByToken(tokenNames: readonly string[]): Promise<McpTokenRequestCount[]>;
  /** The chat usage ledger insert and the get_usage window read (SQL and contracts in engine-sql/chat-usage.ts). */
  logChatUsage(row: ChatUsageLogRow): Promise<void>;
  readChatUsage(days: number): Promise<ChatUsageWindow>;
  /** `schema detect --fields`: live page type counts and per-type page samples (SQL and contract in engine-sql/field-usage.ts). */
  readFieldUsageSamples(query: FieldUsageQuery): Promise<FieldUsageTypeSample[]>;
  /** Alias fan-out's exact-title lookup, case-sensitive alias read, page title and alias rows (SQL and contracts in engine-sql/alias-fanout-reads.ts). */
  findPagesByTitles(titleNorms: readonly string[], sourceIds: readonly string[], types: readonly string[], opts?: { excludePrivate?: boolean }): Promise<TitleHitRow[]>;
  resolveCaseSensitiveAliases(aliasNorms: readonly string[], sourceIds: readonly string[]): Promise<CaseSensitiveAliasRow[]>;
  readPageTitle(sourceId: string, slug: string): Promise<string | null>;
  readPageAliasRows(sourceIds: readonly string[], slugs: readonly string[]): Promise<PageAliasRow[]>;
  /** The entity card's alias rows: every alias row of a listed slug in the source, by alias (no tie order). */
  readEntityAliasRows(sourceId: string, slugs: readonly string[]): Promise<EntityAliasRow[]>;
  /** Every `slug_aliases` row of the source, for link extraction's renamed-slug map (no order). */
  listSlugAliases(sourceId: string): Promise<SlugAliasRow[]>;
  /** Link preparation's live alias targets among `targets`: alias with no live page, live canonical page (engine-sql/link-slug-reads.ts). */
  readLiveSlugAliases(sourceId: string, targets: readonly string[]): Promise<LinkSlugReadsSql.LiveSlugAliasRow[]>;
  /** Link preparation's slug fingerprint of a source and the slugs above `afterId` (engine-sql/link-slug-reads.ts). */
  readSourceSlugProbe(sourceId: string, afterId: number): Promise<LinkSlugReadsSql.SourceSlugProbe>;
  /** A scalar slug read's stored-spelling scan: up to 200 stored slugs with spelling key `key`, after `after` by bytes (engine-sql/slug-spellings.ts). */
  readStoredSlugSpellings(key: string, scope: SlugSpellingsSql.StoredSpellingScope, after: string, keys?: readonly string[] | null): Promise<string[]>;

  // Chunks
  /**
   * Replace the chunk set for a page. Internal page-id lookup is sourceId-
   * scoped when `opts.sourceId` is given; without it, the schema DEFAULT
   * matches and bare-slug lookup blows up if the same slug exists in
   * multiple sources (Postgres 21000).
   */
  /**
   * v0.41.18.0: internal SQL wrapped in `withRetry(BULK_RETRY_OPTS)` against
   * transient connection errors (Supavisor circuit-breaker recovery).
   * Idempotent under replay via single-statement DELETE+INSERT in implicit tx
   * — Postgres rolls back automatically on conn drop, so commit-ambiguous
   * failure replays to the same end state. Callers MUST NOT wrap externally;
   * see {@link BatchOpts} retry-contract block.
   *
   * #1262 registry-aware text-embedding writes: `opts.embeddingColumn`
   * (a caller-resolved descriptor, mirror of SearchOpts) routes
   * `chunk.embedding` into that column with its declared cast. When
   * omitted, engines resolve the active column from the DB-plane
   * registry rows (`search_embedding_column` + `embedding_columns`) via
   * resolveWriteColumnFromConfigRows — the same registry the read side
   * searches — falling back to the legacy `embedding`::vector column on
   * pre-registry brains. `embedding_image` routing is unaffected.
   * `sealChunkerVersion` (#5984): the caller deleted every chunk of the page
   * earlier in this transaction; the stale-row work is skipped and the page is
   * sealed at that chunker version after the insert. With `pageId` (the
   * caller's own write of that page in this transaction) the seal and the
   * insert are sent together and the seal's page is checked against it (`deferSeal`: by the caller, sealImportedPage).
   */
  upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true } & BatchOpts): Promise<void>;
  /**
   * Replace a page's chunks and seal its text projection at its current revision in one transaction, so search and
   * `getChunks` serve them (upsertChunks alone leaves the projection unsealed). Refuses a missing, deleted or
   * segmented page, an archived source and a stale `expectedRevision` (SQL in engine-sql/chunks.ts).
   */
  sealChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; expectedRevision?: string }): Promise<void>;
  /**
   * GST-3032: the owner-only delete triggers (migration v322) that are missing or disabled, with each table's owner. With
   * `ensure`, on a brain holding an owner-only source or a mark, sets the unguarded mark that reads owner-only lineage
   * closed (a gap; not while `installing`), then re-creates each one on a table the current role owns (SQL in engine-sql/owner-only-marks.ts).
   */
  ownerOnlyMarkTriggers(opts?: { ensure?: boolean; installing?: boolean }): Promise<OwnerOnlyTriggerState>;
  /**
   * Read every chunk for a page. Scope precedence mirrors getPage (#2555):
   * a federated grant (`sourceIds[]`) wins over scalar `sourceId`; with
   * neither set, the lookup falls back to the `'default'` source (the
   * local-untyped-call default that importCodeFile's incremental embedding
   * reuse relies on). Vectors are omitted by default (#2544 — most callers throw
   * them away). `includeEmbedding` opts back in, and beats
   * `getChunksWithEmbeddings`, which honors neither scope precedence nor RLS.
   */
  getChunks(slug: string, opts?: PageReadScope & { includeEmbedding?: boolean; includeUnsealed?: boolean }): Promise<Chunk[]>;
  /** get_chunks paging: the chunks with chunk_index in [fromIndex, fromIndex + limit) under getChunks' predicate, the count it admits and the highest chunk_index (engine-sql/chunks.ts). */
  getChunkPage(slug: string, opts: PageReadScope & { fromIndex: number; limit: number }): Promise<{ chunks: Chunk[]; total_chunks: number; max_chunk_index: number | null }>;
  /** Evidence delivery: one batched, re-authorized chunk-window read keyed by page_id (engine-sql/chunks.ts). */
  getChunkWindows(requests: ChunkWindowRequest[], opts: ChunkWindowOpts): Promise<ChunkWindowPage[]>;
  /**
   * Count chunks whose registry-ACTIVE embedding column IS NULL (S2).
   * Pre-flight short-circuit for `embed --stale` so a 100%-embedded brain
   * does no further work after a single SELECT count(*) (~50 bytes wire).
   *
   * `opts.sourceId` scopes the count to a single source. When omitted,
   * counts across every source in the brain. Operators running
   * `gbrain embed --stale --source media-corpus` expect only that
   * source's NULLs touched; the caller threads `sourceId` here.
   *
   * `includeNullSignature` (only meaningful with `signature`, #3391): also
   * count embedded chunks whose page has NO recorded signature (v108
   * grandfathered). Provider-migration paths set this so pre-stamp pages
   * aren't silently left in the old embedding space.
   */
  countStaleChunks(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number>;
  /**
   * Sum of LENGTH(chunk_text) over stale chunks — the character-count
   * backlog the embed phase / embed-backfill will process. Sibling of
   * countStaleChunks (same stale predicate + embed_skip filter + optional
   * sourceId scope); used by the `gbrain sync --all` cost preview to price
   * the embedding backlog via estimateCostFromChars. Returns 0 on an
   * empty/fully-embedded brain.
   *
   * v0.41.31: `signature` (optional) widens "stale" to ALSO include chunks
   * whose page `embedding_signature` is set AND differs from the current
   * model signature (a model/dims swap). NULL signature is GRANDFATHERED
   * (never counted) so the post-migration corpus isn't flagged en masse.
   * Omit `signature` for the active-column-IS-NULL-only count.
   * `includeNullSignature` lifts the grandfather clause (#3391) — see
   * countStaleChunks.
   */
  sumStaleChunkChars(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number>;
  /**
   * Stamp `pages.embedding_signature = signature` for one page. Called after
   * a page's chunks are (re)embedded so a later model swap can detect it as
   * stale. Idempotent. No-op if the page doesn't exist.
   */
  setPageEmbeddingSignature(slug: string, opts: { sourceId?: string; signature: string }): Promise<void>;
  /**
   * NULL out the embeddings (and embedded_at) of every chunk whose page
   * `embedding_signature` is set AND differs from `signature` — i.e. pages
   * embedded under a now-stale model. Returns the chunk count invalidated.
   * The embed-stale loop calls this BEFORE listStaleChunks so signature-
   * drift pages flow through the existing NULL-embedding cursor (keeps
   * listStaleChunks's keyset pagination untouched). GRANDFATHER: NULL
   * signature is never invalidated. `sourceId` scopes the sweep.
   *
   * `includeNullSignature` (#3391): ALSO invalidate embedded chunks whose
   * page signature is NULL (pre-v108 pages that predate the stamp). After a
   * provider/model swap those vectors are in the old embedding space; the
   * default grandfather clause would silently keep them mixed into the new
   * index. `gbrain migrate embeddings` and `embed --stale
   * --include-null-signature` set this.
   */
  invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string; includeNullSignature?: boolean }): Promise<number>;
  /**
   * #4246: NULL out the embeddings (embedding + embedded_at +
   * embedded_text_hash) of every chunk whose stored `embedded_text_hash` no
   * longer matches `md5(chunk_text)` (text rewritten after its vector was
   * computed). Feeds the NULL-embedding cursor like
   * invalidateStaleSignatureEmbeddings. GRANDFATHER: NULL hash (pre-v133
   * rows) is never invalidated — no upgrade re-embed spike. embed_skip pages
   * are excluded (listStaleChunks can't re-embed them). #7117: bounded
   * batches in id order, one transaction each, no saved cursor (the embed
   * paths run content-drift-sweep.ts). Returns the chunk count invalidated.
   */
  invalidateContentDriftEmbeddings(opts?: { sourceId?: string }): Promise<number>;
  /**
   * Return every chunk whose registry-ACTIVE embedding column IS NULL (S2),
   * with the metadata needed for embedBatch + upsertChunks. Vector columns
   * are omitted by design — stale rows have NULL embeddings, so shipping
   * them wastes wire bytes. Caller groups by slug, embeds, and re-upserts.
   *
   * v0.33.3: cursor-paginated — yields up to `batchSize` rows per call
   * (default 2000) to stay within Supabase's statement_timeout. Pass the
   * last row's `(page_id, chunk_index)` as `afterPageId`/`afterChunkIndex`
   * to fetch the next page.  When fewer than `batchSize` rows come back,
   * the caller has reached the end.
   *
   * `opts.sourceId` scopes the scan to a single source (matches the
   * countStaleChunks contract). Paired with embedAllStale's --source
   * support.
   */
  listStaleChunks(opts?: {
    batchSize?: number;
    afterPageId?: number;
    afterChunkIndex?: number;
    sourceId?: string;
    // v0.41.18.0 (A13, codex #9): pagination order. Default 'page_id'
    // (legacy stable cursor). 'updated_desc' joins pages and orders by
    // p.updated_at DESC NULLS LAST, p.id, cc.chunk_index — backed by
    // idx_pages_updated_at_desc + content_chunks_stale_idx partial.
    orderBy?: 'page_id' | 'updated_desc';
    // For 'updated_desc' cursor: previous row's updated_at, page_id, chunk_index.
    // ISO-8601 string for cross-engine compatibility (postgres.js + PGLite
    // both round-trip TIMESTAMPTZ as Date | string; ISO string is the
    // common denominator on the wire).
    afterUpdatedAt?: string | null;
  }): Promise<StaleChunkRow[]>;
  /**
   * Pre-flight count for the chunkless-page safety net: pages with
   * non-empty `compiled_truth` AND/OR non-empty `timeline` — both are
   * chunked independently by the healer — and ZERO `content_chunks` rows.
   * `embed --stale` only scans `content_chunks` (embedding IS NULL) — a
   * page written directly via `putPage` that never got chunked has no
   * chunk row to find, so it stays invisible to that scan forever.
   * `opts.sourceId` scopes the count to a single source, matching
   * `countStaleChunks`. Quarantined and `embed_skip` pages are excluded —
   * both are intentionally chunkless by design, not drift needing repair.
   * See `ChunklessPageRow` for the full rationale.
   */
  countChunklessPagesWithContent(opts?: { sourceId?: string }): Promise<number>;
  /**
   * List pages with non-empty `compiled_truth` and/or `timeline` and zero
   * `content_chunks` rows (sibling of `countChunklessPagesWithContent`;
   * same predicate). Keyset-paginated on `id` (mirrors
   * `listStalePagesForExtraction`) — pass the last row's `id` as
   * `afterPageId` for the next page. Default `batchSize` 50 — deliberately
   * small (unlike the 2000-row default on chunk-metadata-only cursors
   * elsewhere): each row here carries a FULL page body, so a large batch
   * of large pages is a real memory concern this is a safety-net sweep for
   * a rare drift case, not the primary bulk-import chunking path.
   */
  listChunklessPagesWithContent(opts?: {
    batchSize?: number;
    afterPageId?: number;
    sourceId?: string;
  }): Promise<ChunklessPageRow[]>;
  /** #6696 B3: counts per embedding state over the ACTIVE column (contract and ops/full semantics: src/core/embedding-state.ts). */
  readEmbeddingStateCounts(opts: { mode: 'ops' | 'full'; sourceIds?: string[]; purgeWindowHours: number }): Promise<EmbeddingStateCounts>;
  /** #6696 B3: one row per (page, state) in `states`, ordered (state, source_id, slug), at most `limit` rows. */
  listEmbeddingStateRows(opts: { sourceIds?: string[]; slugs?: string[]; states: readonly EmbeddingState[]; limit: number; purgeWindowHours: number }): Promise<EmbeddingStateRow[]>;
  /**
   * Delete every chunk for a page. Internal page-id lookup is sourceId-scoped
   * when `opts.sourceId` is given; otherwise the bare-slug subquery returns
   * the wrong row count in multi-source brains.
   */
  deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void>;
  /**
   * Delete a page's chunks except the rows in `keepIds` (the import's reused vectors). Unlike `deleteChunks` it does
   * not clear the page's text seal; the caller reseals. An empty `keepIds` deletes them all.
   */
  deleteChunksExcept(slug: string, keepIds: readonly number[], opts?: { sourceId?: string }): Promise<void>;
  /** Stamp `pages.chunker_version` on one page (a page with no chunks counts as sealed once stamped). */
  setChunkerVersion(slug: string, version: number, opts?: { sourceId?: string }): Promise<void>;
  /**
   * Seal a page's text projection at `revision` and rebuild its `search_vector` from its title and `timeline` (the
   * sanitized timeline the caller indexes). Writes nothing once the page's revision has moved on. Callers use the
   * `sealPageTextProjection` helper, which reads the page's snapshot first.
   */
  writeTextProjectionSeal(slug: string, opts: { sourceId: string; revision: string; timelineText: string }): Promise<void>;
  /** Move kept chunk rows to new `chunk_index` values in place, one UPDATE per wave (keeps their vectors). */
  moveChunkIndexes(pageId: number, waves: readonly (readonly ChunkMove[])[]): Promise<void>;
  /** A page's stored chunks with the flags the import's vector-reuse gate reads (recorded input hash, text-only, unembedded). */
  getChunkReuseRows(slug: string, opts?: { sourceId?: string }): Promise<ChunkReuseRow[]>;

  // ============================================================
  // v0.42.7 (#1696): link/timeline extraction freshness watermark.
  // A page is stale for extraction when its links_extracted_at is NULL,
  // older than the extractor version stamp, or older than its updated_at
  // (edited-since-extract — the MCP put_page / sync --no-extract path).
  // Powers `gbrain extract --stale` + the `links_extraction_lag` doctor check.
  // ============================================================
  /**
   * Count pages needing (re)extraction. `versionTs` is the ISO-8601
   * `LINK_EXTRACTOR_VERSION_TS` string (bound `::timestamptz`); when omitted,
   * only the NULL + edited-since arms apply. Soft-deleted pages excluded.
   * `attendance` (#5761) excludes or selects pages whose attendance marker
   * equals their current knowledge revision.
   */
  countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked'; held?: 'exclude' | 'only'; wantedProducers?: readonly string[] }): Promise<number>;
  /**
   * List a keyset page (ordered by `id`, `id > afterPageId`) of stale pages
   * WITH their content so the caller extracts without an N+1 `getPage`. Same
   * stale predicate as countStalePagesForExtraction (segmented rows carry no body:
   * read it block by block). The caller passes a SMALL batchSize (25MB transcript
   * pages exist) and applies its own per-batch byte budget.
   */
  listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
    held?: 'exclude';
    wantedProducers?: readonly string[];
  }): Promise<StalePageRow[]>;
  /**
   * Stamp `links_extracted_at` for a batch of pages keyed on the unique
   * `(slug, source_id)` pair (3-array `unnest` idiom; slugs/ids/timestamps only,
   * so unlike the free-text batch inserts it never needed the #1861 jsonb migration).
   * Short-circuits on empty input. Called AFTER the link/timeline flush so a
   * crash mid-batch leaves pages unstamped and they re-extract next run.
   *
   * Each ref may carry its own `extractedAt`; refs that omit it use the
   * `defaultExtractedAt` arg. `gbrain extract --stale` passes the row's READ
   * `updated_at` per ref (v0.42.7 D4 race fix) so a concurrent edit landing
   * between the SELECT and this stamp advances `updated_at` past the stamped
   * value → the page stays stale → re-extracted next run, never marked
   * fresh-with-the-old-content. Sync / DB-extract sites omit per-ref values and
   * pass `now()` (the page was just imported, so `now() >= updated_at`).
   *
   * #3957: returns the number of pages rows actually stamped. A shortfall vs
   * `refs.length` means some refs matched no `(slug, source_id)` pair — the
   * classic wrong-source stamp that used to fail silently while the stale
   * backlog grew. stampExtracted (extract.ts) logs the shortfall.
   */
  markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number>;
  /** #5761: mark pages attendance-blocked at `revision`; skips refs whose page moved past it. Returns rows marked. */
  markPagesAttendanceBlocked(refs: Array<{ slug: string; source_id: string; revision: string }>): Promise<number>;
  /** #6454: live pages per source whose stored frontmatter still carries a parser-reserved key (type/title/tags/slug). */
  countStaleFrontmatterKeyPages(opts: { sourceIds: string[] }): Promise<Array<{ source_id: string; n: number }>>;
  /** #6454: those pages of one source in id order after `afterId`, with the stale keys each carries. */
  listStaleFrontmatterKeyPages(opts: { sourceId: string; afterId: number; limit: number }): Promise<Array<{ id: number; slug: string; keys: string[] }>>;
  /** #6454: strips the reserved keys from the named live pages of one source (coordinated maintenance write); rows changed. */
  stripStaleFrontmatterKeys(opts: { sourceId: string; ids: number[] }): Promise<number>;

  // Links
  /**
   * Single-row link insert. linkSource defaults to 'markdown' for back-compat
   * with pre-v0.13 callers. Pass 'frontmatter' + originSlug + originField for
   * frontmatter-derived edges; 'manual' for user-initiated edges.
   */
  /**
   * v0.18.0+ multi-source: each endpoint can live in a different source.
   * `opts.fromSourceId` / `opts.toSourceId` / `opts.originSourceId` default to
   * 'default'. Without these, the original cross-product `FROM pages f, pages t`
   * fanned out across every source containing the slug.
   */
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
    opts?: { fromSourceId?: string; toSourceId?: string; originSourceId?: string },
  ): Promise<void>;
  /**
   * Bulk insert links via a single multi-row INSERT...SELECT FROM (VALUES) JOIN pages
   * statement with ON CONFLICT DO NOTHING. Returns the count of rows actually inserted
   * (RETURNING clause excludes conflicts and JOIN-dropped rows whose slugs don't exist).
   * Used by extract.ts to avoid 47K sequential round-trips on large brains.
   */
  /**
   * v0.41.18.0: internal SQL wrapped in `withRetry(BULK_RETRY_OPTS)`.
   * Idempotent via `ON CONFLICT (from_page_id, to_page_id, link_type,
   * link_source, origin_page_id) DO NOTHING` — composite key is the semantic
   * uniqueness. Replay-after-partial-success: 2nd attempt finds conflicts,
   * returns 0 from RETURNING. Caller-visible edge: linksCreated undercounts
   * on commit-ambiguous replay. Cosmetic (audit JSONL captures the truth).
   * Callers MUST NOT wrap externally; see {@link BatchOpts} retry contract.
   */
  addLinksBatch(links: LinkBatchInput[], opts?: BatchOpts): Promise<number>;
  replaceDerivedLinks(origin: DerivedLinkOrigin, links: LinkBatchInput[], opts?: DerivedLinkReplacementOptions): Promise<{ created: number; removed: number }>;
  /** replaceDerivedLinks for many origins in one transaction; any failure rolls back every origin (derived-links.ts). */
  replaceDerivedLinksBatch(items: readonly DerivedLinkBatchItem[]): Promise<Array<{ created: number; removed: number }>>;
  /**
   * The registered ids among `sourceIds`, by id, read `FOR SHARE` so none disappears before the caller's page-guard
   * lock (wanted-links-store.ts possibleWantedRows).
   */
  lockRegisteredSourceIds(sourceIds: readonly string[]): Promise<string[]>;
  /**
   * Replace one origin page's wanted rows (wanted-links.ts) for `replacement.producers`: rows of those producers that
   * `replacement.rows` does not name are deleted, then each row is written. Returns the rows written. The caller
   * filters and locks the rows first (wanted-links-store.ts replaceWantedLinks).
   */
  replaceWantedLinkRows(origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement): Promise<number>;
  /**
   * Remove links from `from` to `to`. If linkType is provided, only that specific
   * (from, to, type) row is removed. If omitted, ALL link types between the pair
   * are removed (matches pre-multi-type-link behavior). linkSource additionally
   * constrains the delete to a specific provenance ('frontmatter', 'markdown',
   * 'manual') — used by runAutoLink reconciliation to avoid deleting edges from
   * other provenances when pruning frontmatter-derived edges.
   *
   * #4527: returns the number of rows actually deleted (via RETURNING) so
   * callers can distinguish a real removal from a no-op (typo'd slug, wrong
   * type/provenance, already-removed edge) instead of both looking like
   * success.
   */
  removeLink(
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<number>;
  /**
   * #3674 — bulk removal of derived links for a set of FROM pages, scoped to
   * one link_source. The substrate for `extract links --by-mention --rebuild`:
   * a per-page delete-then-insert (inside `transaction()`) replaces the
   * additive-only write path so stale mentions rows finally die.
   *
   * Semantics:
   *   - Deletes rows whose from_page is one of `pages` (composite
   *     (slug, source_id) match — source isolation) AND
   *     link_source = `opts.linkSource`.
   *   - `opts.keepTypedNerPairs` protects extract-ner's verb-typed rows the
   *     mention scan cannot regenerate: a row with link_kind = 'typed_ner'
   *     whose (from, to) pair appears in the keep list SURVIVES. typed_ner
   *     rows NOT in the list (target no longer derivable) are deleted with
   *     everything else.
   *
   * Returns the number of rows deleted. Atomic per call (one statement).
   * Both engines implement the identical SQL shape (parity-pinned).
   */
  removeLinksByPagesAndSource(
    pages: Array<{ slug: string; source_id: string }>,
    opts: {
      linkSource: string;
      keepTypedNerPairs?: Array<{
        from_slug: string; from_source_id: string;
        to_slug: string; to_source_id: string;
      }>;
    },
  ): Promise<number>;
  /**
   * v0.31.8 (D12 + D16): `opts.sourceId` source-scopes the from-page lookup.
   * When omitted, the read returns links from every same-slug page across
   * sources (pre-v0.31.8 behavior; preserved via two-branch query in both
   * engines). When set, the from-page filter becomes
   * `WHERE f.slug = $1 AND f.source_id = $X`.
   *
   * #2200: `opts.sourceIds` is a federated read grant (caller's allowedSources).
   * It takes precedence over scalar `sourceId` and constrains BOTH endpoints
   * (from AND to) to the grant via `source_id = ANY($::text[])` — so an in-grant
   * page linking to an out-of-grant page does NOT leak the foreign slug/context
   * (carries the `traversePaths` both-endpoint invariant). Remote MCP clients
   * always route here (sourceScopeOpts emits an array for any allowedSources
   * grant); the scalar branch is internal/CLI and keeps cross-source visibility
   * (reconcileLinks + back-link validators depend on it).
   */
  getLinks(slug: string, opts?: LinkReadScope): Promise<Link[]>;
  /**
   * v0.31.8 (D12 + D16): same `opts.sourceId` semantics as `getLinks`,
   * applied to the to-page side of the join. #2200: `opts.sourceIds` federated
   * grant constrains both endpoints (see `getLinks`).
   */
  getBacklinks(slug: string, opts?: LinkReadScope): Promise<Link[]>;
  /**
   * v114 (#1941): distinct link_source provenances with edge counts, for
   * `gbrain link-sources`. Source-scoped via `{sourceId?, sourceIds?}` (both
   * forms, so federated `allowedSources` reads don't leak cross-source counts).
   * Deterministic order `count DESC, link_source ASC NULLS LAST` for PG/PGLite
   * parity. `link_source` may be NULL (legacy/unknown rows).
   */
  listLinkSources(
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]>;
  /**
   * Fuzzy-match a display name to a page slug using pg_trgm similarity.
   * Zero embedding cost, zero LLM cost — designed for the v0.13 resolver used
   * during migration/batch backfill where 5K+ lookups must stay sub-second.
   *
   * Returns the best match whose title similarity is at or above `minSimilarity`
   * (default 0.55). If `dirPrefix` is given (e.g. 'people' or 'companies'),
   * only slugs starting with that prefix are considered. Returns null when no
   * page meets the threshold.
   *
   * Uses the `%` trigram operator (GIN-indexed) + the standard `similarity()`
   * function. Both engines support pg_trgm (PGLite 0.3+, Postgres always).
   *
   * `sourceId` constrains the search to a single source and filters out
   * soft-deleted pages. Mirrors the same filters `tryFuzzyMatch` in
   * `src/core/entities/resolve.ts` got via #1436 (v0.41.13.0). Omit for the
   * historical unscoped behavior — live-mode callers that already know
   * the source should pass it to avoid cross-source slug suggestions that
   * get silently dropped at the FK filter downstream. Batch-mode callers
   * (e.g. `gbrain extract`) intentionally omit it to build a cross-source
   * resolution map.
   */
  findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity?: number,
    sourceId?: string,
  ): Promise<{ slug: string; similarity: number } | null>;
  /**
   * v0.34.1 (#861 — P0 leak seal): `opts.sourceId` / `opts.sourceIds`
   * constrain visited nodes to a single source or array of sources.
   * Pre-fix, the walk ignored source scope and an authenticated MCP
   * client could enumerate cross-source topology + page metadata via
   * the graph op. MCP-bound callers MUST pass the auth'd scope; local
   * CLI callers omit it for the historical unscoped behavior.
   */
  traverseGraph(
    slug: string,
    depth?: number,
    opts?: TraverseGraphOpts,
  ): Promise<GraphNode[]>;
  /**
   * Edge-based graph traversal with optional type and direction filters.
   * Returns a list of edges (GraphPath[]) instead of nodes. Supports:
   * - linkType: per-edge filter, only follows matching edges (per-edge semantics)
   * - direction: 'in' (follow to->from), 'out' (follow from->to), 'both'
   * - depth: max depth from root (default 5)
   * - sourceId/sourceIds: v0.34.1 source-isolation filter, see traverseGraph
   * Breadth-first: each page is visited once, at its shortest depth, and each
   * qualifying edge leaving a visited page is returned once.
   */
  traversePaths(
    slug: string,
    opts?: PageReadScope & { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<GraphPath[]>;
  /**
   * `traversePaths` plus its truncation signal. The final SELECT is bounded
   * by `TRAVERSE_PATH_ROW_CAP` (engine-constants.ts) on both engines, and
   * `truncated` is true when the walk hit it — rows past the cap (the
   * DEEPEST edges under the ORDER BY depth contract) were dropped. The cap
   * counts raw rows before the in-memory edge dedup, so `paths.length`
   * alone cannot reveal truncation. `traversePaths` is the `.paths`
   * projection; the op layer surfaces `truncated` as a stderr note so the
   * GraphPath[] wire shape stays unchanged.
   */
  traversePathsDetailed(
    slug: string,
    opts?: LinkReadScope & { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<{ paths: GraphPath[]; truncated: boolean }>;
  /**
   * Typed-edge relational fan-out for the relational recall arm (v0.43).
   *
   * Generalizes traversePaths to a SEED ARRAY and aggregates to ranked NODES
   * (not edges): for each reached page, the shortest hop from any seed, a
   * connection-richness count, the edge types it was reached by, the shortest
   * connecting slug path, and the page's canonical (lowest-ordinal) chunk id.
   *
   * Invariants:
   * - WITHIN-SOURCE: a walk never crosses a source boundary (each branch
   *   stays in its seed's own source), even when multiple sources are in
   *   scope. Cross-source edge traversal is a separate, security-reviewed
   *   feature.
   * - `link_source='mentions'` edges are EXCLUDED by default (noisy + the
   *   densest fan-out source); opt in via `includeMentions`.
   * - Non-ranking link types (src/core/link-ranking-policy.ts) are never walked.
   * - `deleted_at IS NULL` at seed, every neighbor, and every returned node.
   * - Deterministic ordering: hop ASC, edge_count DESC, source_id, slug.
   * Must move in lockstep with the PGLite implementation
   * (test/e2e/engine-parity.test.ts).
   */
  relationalFanout(
    seeds: string[],
    opts?: RelationalFanoutOpts,
  ): Promise<RelationalFanoutRow[]>;
  /**
   * One oriented expansion step of a multi-hop relational chain from up to a
   * few dozen frontier page ids. Returns logical edges whose frontier side is
   * the relation's subject (`toward: 'object'`) or object (`toward:
   * 'subject'`), with every endpoint and origin authorized by the read policy
   * BEFORE the caller scores anything, at most `neighborCap` edges per frontier
   * node, same-source edges only, mentions and non-ranking link types
   * excluded (hops and degree). Deterministic order: frontier id, lowest link id. Pinned by test/e2e/engine-parity.test.ts.
   */
  relationalChainHop(frontierPageIds: number[], opts: ChainHopOpts): Promise<ChainHopEdge[]>;
  /**
   * For a list of page ids, return how many pages link to each (mentions
   * and non-ranking link types excluded). Used by hybrid search backlink boost. Single SQL query, not N+1.
   * Keyed by page id — NOT slug — so namesake slugs across sources never
   * share or sum counts (#4380). Ids with zero links map to 0.
   */
  getBacklinkCounts(pageIds: number[], opts?: PageReadScope): Promise<Map<number, number>>;
  /**
   * v0.40.4 — for a list of page_ids, return adjacency aggregates
   * restricted to the subgraph induced by them. Returns ALL pages with
   * `hits >= 1` (callers apply their own threshold). Empty input → empty
   * Map, no SQL.
   *
   * Returned shape per page (AdjacencyRow):
   *   - `hits`: distinct from_page_id count, in-set (non-ranking link
   *     types excluded, src/core/link-ranking-policy.ts)
   *   - `cross_source_hits`: distinct OTHER source_ids count (excluding
   *     target's own source), in-set
   *
   * SOURCE-SCOPE CONTRACT: pageIds MUST already be source-scoped by the
   * caller. An optional read scope authorizes endpoints and origins. Adjacency is
   * page-id keyed and the in-set restriction makes cross-source leakage
   * impossible BY CONSTRUCTION (a leaked-in page_id from another source
   * would have to also appear in the caller's input set, which the
   * caller is responsible for preventing). The only consumer in v0.40.4
   * is hybridSearch via runPostFusionStages, which is source-scoped
   * upstream. Same trust posture as `cosineReScore`'s chunk_id handling.
   *
   * Known limitation: cross_source_hits doesn't distinguish "genuinely
   * linked from another team" from "mirrored imports from another
   * source" (codex outside-voice #15). T-todo-4 captures the v0.41+
   * sync-topology-aware refinement.
   */
  getAdjacencyBoosts(pageIds: number[], opts?: PageReadScope): Promise<Map<number, AdjacencyRow>>;
  /**
   * v0.42 (issue #1699): for a list of page_ids, return their
   * `frontmatter.content_flag` markers (reason + detail). Used by hybrid
   * search to stamp `SearchResult.content_flag` post-fusion — the
   * agent-warning channel for fuzzy markup-heavy / oversize pages that
   * stay searchable. Single SQL query, not N+1. Pages without the marker
   * get no entry in the map. Empty input → empty map (no query).
   */
  getContentFlagsByPageIds(
    pageIds: number[],
    opts?: PageReadScope,
  ): Promise<Map<number, { reason: string; detail: string }>>;
  /**
   * Extraction quarantine lane (issue #160), widened for #4220: for a list
   * of page_ids, return a map for every page that carries a
   * `frontmatter.status` value. Each entry reports the raw status string plus
   * whether the page is an unverified auto-extracted entity stub (frontmatter
   * `provenance: 'auto-extracted'` + `status: 'unverified'`). Used by hybrid
   * search to stamp `SearchResult.status` (always) and
   * `SearchResult.unverified` (quarantine special case) pre-fusion so the
   * fusion-level compiled-truth boost skips stubs. Single SQL query, not
   * N+1. Empty input → empty map (no query). The quarantine predicate is the
   * shared `unverifiedExtractionFragment` (src/core/extraction-review.ts).
   */
  getUnverifiedExtractionPageIds(
    pageIds: number[],
    opts?: PageReadScope,
  ): Promise<Map<number, { unverified: boolean; status: string }>>;
  /**
   * v0.27.0: for a list of slugs, return their updated_at timestamps (or created_at fallback).
   * Used by hybrid search recency boost. Single SQL query, not N+1.
   * Slugs with no timestamp get no entry in the map.
   *
   * @deprecated v0.29.1: prefer getEffectiveDates (composite-keyed, multi-source-safe).
   * Kept for back-compat with PR #618 callers.
   */
  getPageTimestamps(slugs: string[]): Promise<Map<string, Date>>;
  /**
   * v0.29.1: for a list of (slug, source_id) refs, return COALESCE(effective_date,
   * updated_at) per ref. Single SQL query. Composite-keyed map (key format:
   * `${source_id}::${slug}`) so multi-source brains don't conflate pages with
   * the same slug across sources (codex pass-1 finding #3).
   *
   * Drives the new applyRecencyBoost post-fusion stage. Returns NULL for refs
   * with no row; map omits them.
   */
  getEffectiveDates(refs: Array<{slug: string; source_id: string}>, opts?: PageReadScope): Promise<Map<string, Date>>;
  /**
   * v0.29.1: for a list of (slug, source_id) refs, return the salience score
   * (emotional_weight × 5 + ln(1 + take_count)) per ref. Single SQL query.
   * Composite-keyed (`${source_id}::${slug}`) like getEffectiveDates.
   *
   * Drives the new applySalienceBoost post-fusion stage. Pages with no row
   * (or zero emotional_weight + zero takes) get score = 0; the boost stage
   * skips them.
   */
  getSalienceScores(refs: Array<{slug: string; source_id: string}>, opts?: PageReadPolicy): Promise<Map<string, number>>;
  /**
   * Return every page with no inbound links.
   * Domain comes from the frontmatter `domain` field (null if unset).
   * The caller filters pseudo-pages + derives display domain.
   * Used by `gbrain orphans` and `runCycle`'s orphan sweep phase.
   *
   * v0.41.29.0: scopes the CANDIDATE set to one source (`sourceId`, from
   * `gbrain doctor/orphans --source` + single-source MCP clients) or a
   * federated set (`sourceIds`, from `allowedSources` MCP clients). The
   * inbound-link side is NOT scoped — a page in source X linked FROM
   * source Y is genuinely reachable, so it is not an orphan of X. Omit
   * `opts` for the brain-wide behavior (unchanged). When both are set,
   * `sourceIds` wins (mirrors `sourceScopeOpts` precedence).
   */
  /**
   * #4524: `mode` selects the orphan definition. 'islanded' (the DEFAULT)
   * matches get_health.orphan_pages — no live inbound AND no live outbound
   * link — so every consumer (orphans CLI, find_orphans op, doctor
   * orphan_ratio, health) agrees by construction. 'inbound' is the legacy
   * no-inbound-only view (a page that links out but is never linked TO still
   * counts as an orphan there).
   */
  /**
   * #4280: rows carry `type` + `quarantined` so the shared orphan-reporting
   * policy can exclude machine leaf types and quarantined shells that slug
   * conventions cannot infer. SQL applies read authorization; reporting exclusions remain in
   * ONE place (`shouldExcludeFromOrphanReporting`).
   */
  findOrphanPages(opts?: PageReadScope & {
    sourceId?: string;
    sourceIds?: string[];
    mode?: 'inbound' | 'islanded'; scopeInbound?: boolean;
  }): Promise<Array<{
    slug: string;
    title: string;
    domain: string | null;
    type?: string | null;
    quarantined?: boolean; source_id?: string;
  }>>;

  // Tags
  /**
   * v0.18.0+ multi-source: `opts.sourceId` scopes the page-id lookup. When
   * omitted, the schema DEFAULT 'default' applies; in multi-source brains
   * with the same slug across sources the bare-slug lookup returns >1 row
   * and the INSERT/DELETE fails with Postgres 21000.
   * `tagSource: 'frontmatter'` marks an import-owned row a later import may
   * delete (A14); every other add stamps 'added', which no import deletes.
   */
  addTag(slug: string, tag: string, opts?: { sourceId?: string; tagSource?: 'frontmatter' }): Promise<void>;
  removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void>;
  /** Delete a page's frontmatter-owned tags that are not in `keep`; explicitly added and legacy NULL-source tags stay. */
  pruneFrontmatterTags(slug: string, keep: readonly string[], opts?: { sourceId?: string }): Promise<void>;
  /** Add many tags to one page by its id in one statement (same claim rules as `addTag`); the caller holds the page guard. */
  addPageTagsById(pageId: number, tags: readonly string[], opts?: { tagSource?: 'frontmatter' }): Promise<void>;
  /**
   * #2200: getTags ALSO accepts a federated `sourceIds[]` read grant (precedence
   * over scalar `sourceId`); it unions tags across the matched same-slug pages
   * via `page_id IN (…) … DISTINCT`. The write-side addTag/removeTag deliberately
   * stay scalar-only — `allowedSources` is a read grant; writes route to one source.
   */
  getTags(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; liveOnly?: boolean }): Promise<string[]>;

  // Timeline
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * Pass opts.skipExistenceCheck=true for batch operations where the slug is already
   * known to exist (e.g., from a getAllSlugs() snapshot). Duplicates are silently
   * deduplicated by the (page_id, date, summary) UNIQUE index (ON CONFLICT DO NOTHING).
   */
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * `opts.skipExistenceCheck` skips the pre-check for batch loops where the slug
   * is already known to exist. `opts.sourceId` source-scopes both the existence
   * check AND the page-id lookup inside the INSERT — required for multi-source
   * brains where the slug exists in 2+ sources.
   *
   * #3827: returns true when a row was actually inserted, false when the
   * (page_id, date, summary, source) unique index deduplicated it (ON CONFLICT
   * DO NOTHING) or the page-id subquery matched nothing under
   * skipExistenceCheck — so callers can surface "skipped" instead of lying "ok".
   */
  addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<boolean>;
  /**
   * Bulk insert timeline entries via a single multi-row INSERT...SELECT FROM (VALUES)
   * JOIN pages statement with ON CONFLICT DO NOTHING. Returns the count of rows
   * actually inserted (RETURNING excludes conflicts and JOIN-dropped rows whose
   * slugs don't exist). Used by extract.ts to avoid sequential round-trips.
   */
  /**
   * v0.41.18.0: internal SQL wrapped in `withRetry(BULK_RETRY_OPTS)`.
   * Idempotent via composite-key conflict (page_id, kind, when_text, body).
   * Same caller-visible undercount caveat as {@link addLinksBatch}.
   * Callers MUST NOT wrap externally; see {@link BatchOpts} retry contract.
   */
  addTimelineEntriesBatch(entries: TimelineBatchInput[], opts?: BatchOpts): Promise<number>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // v0.42.x — Life Chronicle (#2390) timeline reads. All filter the depth page
  // (and any event page) on deleted_at IS NULL, order by COALESCE(event
  // effective_date, date), and honor source scope (sourceIds[] > sourceId).
  /** Events/timeline rows on a given day (or its ISO week when opts.week). */
  getTimelineForDate(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]>;
  /** Events/timeline rows on or after `date`, optionally filtered by event.kind. */
  getSince(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]>;
  /** "On this day" — events from the same month-day in PRIOR years (default: today). */
  getOnThisDay(opts?: PageReadScope & { date?: string; limit?: number }): Promise<ChronicleTimelineRow[]>;
  /** Most recent date an entity appears (its own page or an event's `who`). */
  getLastSeen(entitySlug: string, opts?: PageReadScope & { asof?: string }): Promise<LastSeenResult>;
  /**
   * Upsert the date-index projection row for an event page: page_id = depth
   * page, event_page_id = event page, keyed (event_page_id, date). Re-extraction
   * with a changed summary UPDATEs (no duplicate). Returns projected=false when
   * either slug is missing in the source. Idempotent.
   */
  upsertEventProjection(opts: { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string }): Promise<{ projected: boolean }>;

  /**
   * Delete the page's own (non-event) timeline rows that `rows` name and that still match them on every field (id,
   * date, source, summary, detail): a row changed since it was read stays, and an event projection (a row with an
   * event page) is never touched. Returns each deleted row's date (`YYYY-MM-DD`) and its `removed` mark. A page write
   * calls it inside its own transaction (engine-sql/timeline.ts).
   */
  removeTimelineRows(pageId: number, rows: readonly TimelineRowRemoval[]): Promise<Array<{ date: string; removed: boolean }>>;
  /**
   * Replace the detail of the page's own (non-event) timeline rows named in `rows` with `next` when the stored detail
   * still equals the preimage `detail`; any other row stays. Event projections are never touched.
   */
  updateTimelineDetails(pageId: number, rows: readonly TimelineDetailRefresh[]): Promise<void>;
  /**
   * Insert the page's own timeline rows (the fence projection's bullets) in order; a row equal on (date, summary,
   * source) to a stored row of the page is skipped. A missing page is a foreign key refusal.
   */
  insertCanonicalTimelineRows(pageId: number, rows: readonly CanonicalTimelineRow[]): Promise<void>;
  /** The id of the newest timeline row of the page (deleted or not) on `date` whose summary is `summary`, event rows included, or null. */
  readNewestTimelineEntryId(sourceId: string, slug: string, date: string, summary: string): Promise<number | null>;

  // v0.42.x — Life Chronicle (#2390) per-entity ontology (rides `facts`).
  /**
   * Record one ontology observation (entity has dimension=value). Idempotent on
   * the deterministic dedup key (source_id, entity_slug, dimension, value_hash,
   * source_markdown_slug). A new value forward-supersedes the prior open row
   * (expired_at + superseded_by); the same value corroborates; a backdated
   * conflicting value is inserted WITHOUT rewriting the prior (surfaced by
   * findOntologyConflicts). Never throws on dup — returns action 'noop'.
   */
  mergeOntologyFact(obs: OntologyObservationInput): Promise<OntologyMergeResult>;
  /** Current resolved ontology for an entity at `asof` (default now). */
  getOntology(entitySlug: string, opts?: OntologyReadOpts): Promise<OntologyValue[]>;
  /** Meta-ontology: which dimensions exist across the brain, and how widely. */
  discoverOntologyDimensions(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<OntologyDimensionStat[]>;
  /** Dimensions with ≥2 distinct current-open values from ≥2 provenances. */
  findOntologyConflicts(opts?: PageReadScope & Pick<OntologyReadOpts, 'minConfidence' | 'visibility' | 'excludeDiary'>): Promise<OntologyConflict[]>;

  // The ontology re-key and repair statements (engine-sql/ontology-repair.ts).
  /** A re-key's losers: of each set of facts that would share an ontology key once `move` applies, every row but the survivor (`keep`). Reads facts. */
  listRekeyLosers(sourceId: string, move: OntologyRepairSql.RekeyMove): Promise<Array<{ id: number | string; keep: number | string }>>;
  /** Repoints supersession links at the dropped rows to their survivors. Writes facts. */
  repointSupersededToKept(ids: number[], keeps: number[]): Promise<void>;
  /** A losing conversation fact keeps its row and gives up its ontology slot. Writes facts. */
  clearOntologySlots(ids: number[]): Promise<void>;
  /** Deletes the dropped ontology rows. Writes facts. */
  deleteRekeyLosers(ids: number[]): Promise<void>;
  /** `repair ontology-facts`: the ontology rows of these sources that carry the fence step's signature, with their class flags. Reads facts. */
  /** `repair ontology-facts --apply`: restores one observation only while its row number, page and expiry are as previewed; returns the restored row, none when it changed. Writes facts. */
  restoreOntologyFact(row: OntologyRepairSql.OntologyFactRestore): Promise<Array<{ id: number | string; expired: boolean }>>;

  // Raw data
  /**
   * v0.31.8 (D21): `opts.sourceId` source-scopes the page-id lookup. When
   * omitted, the write targets the bare slug (pre-v0.31.8 behavior); the
   * Postgres 21000 hazard for multi-source brains exists on this path.
   * Multi-source callers MUST pass sourceId to land on the intended row.
   */
  putRawData(slug: string, source: string, data: object, opts?: { sourceId?: string }): Promise<void>;
  /**
   * v0.31.8 (D21): `opts.sourceId` source-scopes the page-id lookup (without
   * it, multi-source brains return rows from every same-slug page). Rows
   * follow the page's soft-delete; `includeDeleted` (export/migration) opts in.
   */
  getRawData(slug: string, source?: string, opts?: PageReadScope & { includeDeleted?: boolean }): Promise<RawData[]>;

  // Files (v0.27.1: binary asset metadata + storage_path. Image bytes never
  // enter the DB; storage_path references a path inside the brain repo or an
  // external store).
  upsertFile(spec: FileSpec): Promise<{ id: number; created: boolean }>;
  getFile(sourceId: string, storagePath: string): Promise<FileRow | null>;
  listFilesForPage(pageId: number): Promise<FileRow[]>;
  /** One page slug's files (any source) by filename, or every file by page slug then filename; at most `limit` (`files list`). */
  listFiles(opts: ListFilesOptions): Promise<FileRow[]>;

  // The files commands' and file operations' statements (engine-sql/files-ops.ts).
  /** Whether a files row already holds this hash at this storage path (`gbrain files upload` and `sync` skip it). Reads files. */
  hasFileWithHash(contentHash: string, storagePath: string): Promise<boolean>;
  /** `gbrain files verify`: every file by storage path, at most 1000. Reads files. */
  listFileRowsForVerify(): Promise<FilesOpsSql.FileRecord[]>;
  /** A source's checkout path for `gbrain files verify`, null when it has none or the source is unknown. Reads sources. */
  readSourceLocalPathForVerify(sourceId: string): Promise<string | null>;
  /** The files write of `gbrain files upload` (standard and smart): inserts the row, or on the same storage path takes the new hash, size and type and merges the metadata. Writes files. */
  upsertCliFileRow(row: FilesOpsSql.FileRowScalars, metadata: FilesOpsSql.FileMetadata): Promise<void>;
  /** The files write of the git lane of `gbrain files upload`: the same upsert naming the source. Writes files. */
  upsertRawFileRow(row: FilesOpsSql.FileRowScalars & { source_id: string }, metadata: FilesOpsSql.FileMetadata): Promise<void>;
  /** The files write of `gbrain files sync`: the same upsert as `upsertCliFileRow`. Writes files. */
  upsertSyncFileRow(row: FilesOpsSql.FileRowScalars, metadata: FilesOpsSql.FileMetadata): Promise<void>;
  /** Whether a source with this id exists. Reads sources. */
  sourceIdExists(sourceId: string): Promise<boolean>;
  /** The id of the page at this slug in this source, null when it has none. Reads pages. */
  readPageIdInSource(slug: string, sourceId: string): Promise<number | null>;
  /** The source, page id and hash of the files row at this storage path, null when none is stored. Reads files. */
  readFileOwner(storagePath: string): Promise<FilesOpsSql.FileOwnerRow | null>;
  /** Gives the files row at this storage path to a source and page. Writes files. */
  claimFilePage(storagePath: string, sourceId: string, pageId: number): Promise<void>;
  /** The files write of the file_upload operation: a conflict keeps the row's source and page when the new row names no page. Writes files. */
  upsertOpFileRow(row: FilesOpsSql.FileRowScalars & { source_id: string; page_id: number | null }, metadata: FilesOpsSql.FileMetadata): Promise<void>;
  /** file_list: the files of one page (or every page) the caller can read, at most 100; `excludePrivate` hides files attached to a private page. Reads files and pages. */
  listReadableFileRows(slug: string | undefined, excludePrivate: boolean): Promise<FilesOpsSql.FileRecord[]>;
  /** file_url: the stored path, type and size of the file at this path when the caller can read it, else null. Reads files and pages. */
  readReadableFileForUrl(storagePath: string, excludePrivate: boolean): Promise<FilesOpsSql.FileRecord | null>;
  /** file_register: the id of the page at this slug in this source when the caller can read it, undefined when it cannot or none exists. Reads pages. */
  readReadablePageId(slug: string, sourceId: string, excludePrivate: boolean): Promise<number | undefined>;
  /** file_register: how many files rows at this storage path the caller cannot read. Reads files and pages. */
  countUnreadableFilesAt(storagePath: string, excludePrivate: boolean): Promise<number>;
  /** file_register: how many rows at this storage path differ from the page, filename, source or page id. Reads files. */
  countFilesRegisteredElsewhere(identity: FilesOpsSql.RegisteredFileIdentity): Promise<number>;
  /** file_register: records the row, or refreshes it when the same identity holds the path; false when another holds it (nothing written). Writes files. */
  registerFileRow(row: FilesOpsSql.FileRowScalars & { source_id: string; page_id: number | null }, metadata: FilesOpsSql.FileMetadata): Promise<boolean>;
  /** file_verify: the size and hash of the file at this path when the caller can read it, else null. Reads files and pages. */
  readReadableFileForVerify(storagePath: string, excludePrivate: boolean): Promise<{ size_bytes: unknown; content_hash: string } | null>;
  /** file_verify: the storage paths and pages the caller can read, for one page or every page, at most 100. Reads files and pages. */
  listReadableFilePaths(slug: string | undefined, excludePrivate: boolean): Promise<Array<{ storage_path: string; page_slug: string | null }>>;

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis evidence
  // ============================================================
  /**
   * Bulk insert/upsert takes. Binds the whole batch as one JSONB document via
   * `jsonb_to_recordset(($1::jsonb)->'rows')` through `executeRawJsonb` (#1861;
   * free-text-safe, replaced the prior `unnest(::text[])` path). Idempotency:
   * ON CONFLICT (page_id, row_num) DO UPDATE — re-extract on a changed
   * claim/weight updates the row in place; an identical row stays unwritten. Returns
   * the rows inserted, updated or already current. Row construction + weight clamp/round + NUL-strip live in
   * `src/core/batch-rows.ts:buildTakeRows` (shared across both engines).
   *
   * Wrapped in `batchRetry` like the other batch primitives, so `opts` (auditSite,
   * AbortSignal) is honored; same no-double-wrap contract as `BatchOpts`.
   *
   * Weight outside [0, 1] is clamped server-side and surfaces a stderr
   * warning per call (`TAKES_WEIGHT_CLAMPED`). Invalid `kind` values
   * fail the whole batch via the CHECK constraint — caller is responsible
   * for parser validation upstream.
   */
  addTakesBatch(rows: TakeBatchInput[], opts?: BatchOpts): Promise<number>;

  /** Persist embeddings for active take rows; inactive rows are ignored. */
  updateTakeEmbeddings(rows: TakeEmbeddingInput[], opts?: BatchOpts): Promise<number>;

  /** List takes filtered by holder/kind/active/etc. Resolves page_slug via JOIN. */
  listTakes(opts?: TakesListOpts): Promise<Take[]>;

  /**
   * Keyword search across active takes. Uses pg_trgm similarity over claim text.
   * Honors `takesHoldersAllowList` via WHERE filter so MCP-bound calls cannot
   * retrieve holders outside the token's allow-list.
   */
  searchTakes(query: string, opts?: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility }): Promise<TakeHit[]>;

  /**
   * Vector search across active takes. Cosine distance against `embedding`.
   * Skipped (returns []) when no embedding column has been populated yet.
   */
  searchTakesVector(
    embedding: Float32Array,
    opts?: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility },
  ): Promise<TakeHit[]>;

  /** Look up embeddings by take id (mirrors getEmbeddingsByChunkIds). */
  getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>>;

  /** Stale-take count (#5885 lifecycle: missing, claim-drifted, or, with a target, other-model/width vectors). */
  countStaleTakes(opts?: StaleTakeOpts): Promise<number>;

  /** List stale takes (no embedding column in payload — same pattern as listStaleChunks). */
  listStaleTakes(opts?: StaleTakeOpts): Promise<StaleTakeRow[]>;

  /**
   * Update a take's mutable fields. May NOT change claim/kind/holder per the
   * supersession invariants — those route through supersedeTake. Throws
   * `TAKE_ROW_NOT_FOUND` when (page_id, row_num) doesn't exist.
   */
  updateTake(
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void>;

  /**
   * Supersede the take at (page_id, oldRow). Marks old row active=false +
   * sets superseded_by; appends new row at the next row_num for the page;
   * returns both row_nums. Atomic (transactional). Cycle prevention: if newRow
   * sets superseded_by pointing to a chain that comes back to oldRow, throws
   * `TAKES_SUPERSEDE_CYCLE`. Resolved bets (`resolved_at IS NOT NULL`) cannot
   * be superseded — throws `TAKE_RESOLVED_IMMUTABLE`.
   */
  supersedeTake(
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }>;

  /**
   * Resolve a bet (or take). Sets resolved_* columns. Immutable: re-resolve
   * attempts throw `TAKE_ALREADY_RESOLVED`. Use supersede to express a new bet.
   *
   * v0.30.0: accepts either `quality` (3-state, primary) or `outcome` (boolean,
   * back-compat). When both set, `quality` wins. The engine writes BOTH columns
   * derived from whichever input was given: `quality='correct'/'incorrect'` →
   * `outcome=true/false`; `quality='partial'` → `outcome=NULL`. The schema
   * `takes_resolution_consistency` CHECK constraint catches contradictory
   * states at the DB layer as a defense-in-depth backstop.
   */
  resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void>;

  /**
   * v0.30.0: aggregate calibration scorecard. Pure SQL aggregation; no LLM.
   * Counts resolved bets, computes accuracy, Brier score (correct+incorrect
   * only), and `partial_rate`. Filtering: `holder` scopes to one identity;
   * `domainPrefix` scopes to a slug-prefix (e.g. `companies/`); `since`/`until`
   * scope to a `since_date` window.
   *
   * Privacy (D4 from plan): `allowList` is REQUIRED in the TS signature.
   * The engine applies `WHERE holder = ANY($allowList)` INSIDE the GROUP BY
   * so hidden-holder rows contribute zero to aggregates. Pass an empty array
   * to enforce zero-results; pass `undefined` only from server-side trusted
   * callers that have already verified the request is unrestricted.
   */
  getScorecard(opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard>;

  /**
   * v0.30.0: calibration curve. Bins resolved correct+incorrect bets by stated
   * weight (default bucket size 0.1) and reports observed vs predicted frequency
   * per bucket. Same allow-list contract as `getScorecard`. Excludes partial
   * (consistent with Brier — partial has no binary outcome to compare against).
   */
  getCalibrationCurve(opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]>;

  /** Persist think provenance. ON CONFLICT DO NOTHING; returns rows inserted. */
  addSynthesisEvidence(rows: SynthesisEvidenceInput[]): Promise<number>;

  // Dream-cycle significance verdict cache (v0.23).
  // Keyed by (file_path, content_hash). Distinct from raw_data, which is
  // page-scoped — transcripts being judged aren't pages yet.
  getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null>;
  putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void>;
  /**
   * Delete expired dream verdicts; returns rows removed. Best-effort
   * housekeeping — reads already treat expired rows as misses (#4069).
   */
  sweepDreamVerdicts(): Promise<number>;

  // Dream-cycle statements (engine-sql/dream-cycle.ts): the retriage queue reads, the dream breaker and write-deferral config map, the provenance stamp, the consolidate phase and the synthesize family. Each runs the statement its caller ran through executeRaw.
  /** Waiting, delayed and paused subagent jobs of a dream synthesis key or a private dream-inline queue (dream retriage). Reads minion_jobs. */
  listDreamQueueCandidates(): Promise<DreamCycleSql.DreamQueueCandidate[]>;
  /** Cycle locks that are unexpired or refreshed within `graceSecs`, with their acquisition time in epoch milliseconds (dream retriage). Reads gbrain_cycle_locks. */
  listLiveDreamCycleLocks(graceSecs: number): Promise<DreamCycleSql.LiveDreamCycleLock[]>;
  /** The status of one job, or null when it is gone (the retriage pre-cancel re-check). Reads minion_jobs. */
  readDreamJobStatus(id: number): Promise<{ status: string } | null>;
  /** Creates the config row `key` holding an empty map when it is missing (dream breaker and write deferrals; run in a transaction). */
  ensureDreamMapConfigRow(key: string): Promise<void>;
  /** Locks the config row `key` until the transaction ends; returns its value and the database clock, or null when it is missing. */
  lockDreamMapConfigRow(key: string): Promise<DreamCycleSql.DreamMapConfigRow | null>;
  /** Writes the config row `key` (dream breaker and write deferrals). */
  writeDreamMapConfigRow(key: string, value: string): Promise<void>;
  /** Upserts a dream breaker reset of `baseKey` into the map at `resetsKey` in one statement, dropping entries older than 24 hours. */
  recordDreamBreakerReset(resetsKey: string, baseKey: string): Promise<void>;
  /** Stamps a dream-written page: merges the frontmatter and keeps the first cycle date; a page older than `firstWriteAt` is left alone. Writes pages. */
  stampDreamPageProvenance(stamp: DreamCycleSql.DreamPageProvenanceStamp): Promise<void>;
  /** The id of the live page `slug` in `sourceId` (zero or one row). */
  listDreamPageIds(slug: string, sourceId: string): Promise<Array<{ id: number }>>;
  /** How many dream pages carry `cycleDate` (not the summary) and how many of `writtenSlugs` keep an earlier cycle date. */
  countDreamProvenancePages(sourceId: string, cycleDate: string, summarySlug: string, writtenSlugs: string[]): Promise<DreamCycleSql.DreamProvenanceCounts | null>;
  /** The durable receipt of a deferred dream write by request row id, or null. Reads persistence_requests. */
  readDreamDeferralReceipt(receiptId: string): Promise<DreamCycleSql.DreamDeferralReceipt | null>;
  /** The typed claim value of each fact in `ids` (consolidate). Reads facts. */
  listConsolidationClaimValues(ids: number[]): Promise<DreamCycleSql.ConsolidationClaimValue[]>;
  /** Sets a consolidated fact's valid_until; a no-op when it already holds `validUntil`. Writes facts. */
  setConsolidatedFactValidUntil(validUntil: Date, id: number): Promise<void>;
  /** The ids among `ids` of facts on a page that names readers or sits under a folder rule (consolidate). Reads facts and pages. */
  listReadersSourcedFactIds(ids: number[]): Promise<Array<{ id: number }>>;
  /** The id of the live page `slug` in `sourceId` (zero or one row; consolidate). */
  findConsolidationPageIds(sourceId: string, slug: string): Promise<Array<{ id: number }>>;
  /** The highest take row number on a page, 0 when it has none. Reads takes. */
  readConsolidationTakesMaxRowNum(pageId: number): Promise<number>;
  /** The earliest self-held fact take of `claim` on a page, active or not (zero or one row). Reads takes. */
  findConsolidatedTakes(pageId: number, claim: string): Promise<DreamCycleSql.ConsolidatedTake[]>;
  /** Refreshes a consolidated take's source-aggregation string. Writes takes. */
  refreshConsolidatedTakeSource(source: string, id: number): Promise<void>;
  /** The id of the take at `rowNum` on a page. Reads takes. */
  findConsolidatedTakeIds(pageId: number, rowNum: number): Promise<Array<{ id: number }>>;
  /** The typed claim columns of each fact in `ids` (consolidate). Reads facts. */
  listConsolidationClaimShapes(ids: number[]): Promise<DreamCycleSql.ConsolidationClaimShapeRow[]>;
  /** The distinct `raw_source` of the live dream-generated pages of `sourceId` that name one. Reads pages. */
  listRetainedDreamOutputSources(sourceId: string): Promise<Array<{ raw_source: string }>>;
  /** The incarnation of `sourceId`, or null when it is missing. Reads sources. */
  readDreamSourceIncarnation(sourceId: string): Promise<{ incarnation: string | null } | null>;
  /** The live atom pages of `sourceId` that were not imported, each with whether it is private (synthesize concepts). Reads pages. */
  listDreamAtomPages(sourceId: string): Promise<DreamCycleSql.DreamAtomPage[]>;
  /** The slug, title and body of each live non-segmented page of `slugs` in `sourceId`, by slug. Reads pages. */
  listSynthesisPageBodies(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null; body: string | null }>>;
  /** Queued, running, recovering and committed requests on a page after `sequence`, oldest first (synthesize postprocess). Reads persistence_requests. */
  listLaterPersistenceRequests(sourceId: string, incarnation: string, slug: string, sequence: number | string): Promise<import('./persistence/model.ts').WriteRequest[]>;
  /** The committed put_page journal rows of `requestIds` in a source and incarnation, newest first. Reads persistence_requests. */
  listCommittedOutputRequests(requestIds: string[], sourceId: string, incarnation: string): Promise<Array<{ request: import('./persistence/model.ts').WriteRequest }>>;
  /** The database clock now, as the driver returns it (the dream verification epoch). */
  readDreamVerifyEpoch(): Promise<unknown>;
  /** The creation time of each job in `ids`. Reads minion_jobs. */
  listDreamJobCreatedAt(ids: number[]): Promise<Array<{ id: number | string; created_at: unknown }>>;
  /** The first version snapshot of a page taken at or after `sinceIso`, or null when none exists. Reads page_versions. */
  readDreamPreRunRevision(slug: string, sourceId: string, sinceIso: string): Promise<DreamCycleSql.DreamPreRunRevision | null>;
  /** The id and idempotency key of each completed job under the synthesis key `key` or one of its chunks, by id. Reads minion_jobs. */
  listCompletedSynthJobs(key: string): Promise<Array<{ id: number; idempotency_key: string }>>;
  /** How many jobs under `keys` still count as existing (not cancelled or dead). Reads minion_jobs. */
  countCoalescibleSynthJobs(keys: string[]): Promise<number>;
  /** The ids of the jobs waiting or delayed in `queue`. Reads minion_jobs. */
  listWaitingChildJobIds(queue: string): Promise<Array<{ id: number }>>;
  /** The timestamps and token counts of each job in `ids`. Reads minion_jobs. */
  listDreamChildJobTimings(ids: number[]): Promise<DreamCycleSql.DreamChildJobTiming[]>;
  /** The dream synthesis subagent jobs submitted for `sourceId` in the last 24 hours, not counting cancelled ones (the daily cap). Reads minion_jobs. */
  countRecentDreamSynthSubmissions(sourceId: string): Promise<number>;

  // ============================================================
  // v0.32.6 Contradiction probe — batched takes fetch + cache + trends
  // ============================================================

  /**
   * Batch fetch: for each page_id in the input array, return the page's
   * currently-active takes. Single query under the hood (`WHERE page_id =
   * ANY($1) AND active = true`); replaces the O(K) loop of listTakes calls
   * the contradiction probe would otherwise pay per probe-query.
   *
   * Returns a Map keyed on page_id; pages with no active takes get an empty
   * array (NOT undefined) so callers can avoid existence checks.
   *
   * Honors `takesHoldersAllowList` for MCP scope enforcement (mirrors
   * listTakes contract). Pass undefined from trusted local callers.
   */
  listActiveTakesForPages(
    pageIds: number[],
    opts?: { takesHoldersAllowList?: string[] },
  ): Promise<Map<number, Take[]>>;

  /**
   * The row numbers of the page's stored takes whose claim, kind or holder differs (null-safe) from the fence row of
   * the same number in `rows`, ascending, at most `limit`. A page write refuses a fence that would take them over.
   */
  matchTakeRows(pageId: number, rows: readonly TakeFenceRow[], limit: number): Promise<number[]>;
  /** Delete the page's takes at `rowNums`, with their synthesis evidence; an empty list deletes nothing. */
  deleteTakeRows(pageId: number, rowNums: readonly number[]): Promise<void>;
  /** Set the `resolved_at` of the page's take at `rowNum` (a date or an ISO time); no take there writes nothing. */
  stampTakeResolvedAt(pageId: number, rowNum: number, resolvedAt: string): Promise<void>;
  /** Store `holders` as persistence request `requestId`'s `authority.takeHoldersUsed`, in the order given. */
  recordTakeHoldersUsed(requestId: string, holders: readonly string[]): Promise<void>;

  /**
   * Persist a single contradiction-probe run row. Caller supplies a full
   * `ContradictionsRunRow`-shaped object; the engine inserts as-is.
   *
   * Idempotent on `run_id`: re-inserting an existing run_id is a no-op
   * (caller passes ISO-timestamp-shaped run_ids that won't collide
   * unintentionally). Returns true iff a row was inserted.
   */
  writeContradictionsRun(row: {
    run_id: string;
    judge_model: string;
    prompt_version: string;
    queries_evaluated: number;
    queries_with_contradiction: number;
    total_contradictions_flagged: number;
    wilson_ci_lower: number;
    wilson_ci_upper: number;
    judge_errors_total: number;
    cost_usd_total: number;
    duration_ms: number;
    source_tier_breakdown: Record<string, unknown>;
    report_json: Record<string, unknown>;
  }): Promise<boolean>;

  /**
   * Load contradiction-probe run history within the last N days, ordered
   * newest first. Used by `gbrain eval suspected-contradictions trend` and
   * by the doctor `contradictions` check. `report_json` and
   * `source_tier_breakdown` are parsed JSONB columns.
   */
  loadContradictionsTrend(days: number): Promise<Array<{
    run_id: string;
    ran_at: string;
    judge_model: string;
    queries_evaluated: number;
    queries_with_contradiction: number;
    total_contradictions_flagged: number;
    wilson_ci_lower: number;
    wilson_ci_upper: number;
    judge_errors_total: number;
    cost_usd_total: number;
    duration_ms: number;
    source_tier_breakdown: Record<string, unknown>;
    report_json: Record<string, unknown>;
  }>>;

  /**
   * Cache lookup for the contradiction probe's persistent judge cache (P2).
   * Returns the verdict JSON if a row exists with matching key AND non-expired
   * `expires_at`. NULL means cache miss (judge call needed).
   *
   * Key shape mirrors the table primary key: (chunk_a_hash, chunk_b_hash,
   * model_id, prompt_version, truncation_policy). Codex's outside-voice
   * critique fixed the key to include prompt_version + truncation_policy so
   * prompt edits cleanly invalidate prior verdicts.
   */
  getContradictionCacheEntry(key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null>;

  /**
   * Upsert a contradiction-probe judge verdict into the persistent cache.
   * `ttl_seconds` controls expires_at (default 30 days from now). Caller
   * supplies pre-hashed chunk text + the verdict to cache.
   *
   * ON CONFLICT DO UPDATE so re-runs refresh expires_at; this is the simplest
   * shape for "I judged the same pair again with the same config, slide the
   * TTL forward."
   */
  putContradictionCacheEntry(opts: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
    verdict: Record<string, unknown>;
    ttl_seconds?: number;
  }): Promise<void>;

  /**
   * Sweep expired cache entries. Returns count deleted. Periodic call from
   * cache.ts — keeps the table bounded without requiring a cron.
   */
  sweepContradictionCache(): Promise<number>;

  // The edge-contradictions phase, the scoped contradiction reader and the eval reads (engine-sql/contradictions-cycle.ts).
  /** The live state relationships of subjects with two or more targets of one type, newest groups first. Reads link_relationships, pages. */
  listEdgeContradictionCandidates(query: ContradictionsCycleSql.EdgeCandidateQuery): Promise<ContradictionsCycleSql.EdgeCandidateRow[]>;
  /** The proposals of one subject and link type whose evidence hash is among these, with whether each was touched in the last 24 hours. Reads link_edge_proposals. */
  listKnownEdgeProposals(fromPageId: number, linkType: string, evidenceHashes: string[]): Promise<ContradictionsCycleSql.KnownEdgeProposalRow[]>;
  /** Up to three distinct non-empty contexts of one link. Reads links. */
  listLinkContexts(fromPageId: number, toPageId: number, linkType: string): Promise<string[]>;
  /** Records an edge proposal; an existing row of the same evidence is replaced only while it is an error row. Returns the row id, null when the existing row stood. Writes link_edge_proposals. */
  recordEdgeProposal(proposal: ContradictionsCycleSql.EdgeProposalInput): Promise<number | null>;
  /** One edge proposal with its subject and ending slugs, null when none. Reads link_edge_proposals, pages. */
  readEdgeProposal(id: number): Promise<ContradictionsCycleSql.EdgeProposalRow | null>;
  /** Whether a dream transition ends this relationship on `closeDate`. Reads link_transitions. */
  edgeClosureLanded(fromPageId: number, endingToPageId: number | null, linkType: string, closeDate: string | null): Promise<boolean>;
  /** The evidence hashes the two relationships of a proposal carry now, null when either is gone. Reads link_edge_proposals, link_relationships. */
  readEdgeProposalEvidence(id: number): Promise<{ a: string; b: string } | null>;
  /** The evidence hash a proposal was judged on, null when none. Reads link_edge_proposals. */
  readEdgeProposalHash(id: number): Promise<{ evidence_hash: string } | null>;
  /** Marks a proposal stale. Writes link_edge_proposals. */
  markEdgeProposalStale(id: number): Promise<void>;
  /** Sets a proposal's status. Writes link_edge_proposals. */
  setEdgeProposalStatus(id: number, status: string): Promise<void>;
  /** Rejects a proposal that is still open; true when it was. Writes link_edge_proposals. */
  rejectOpenEdgeProposal(id: number): Promise<boolean>;
  /** Marks an applied proposal undone. Writes link_edge_proposals. */
  markEdgeProposalUndone(id: number): Promise<void>;
  /** Applied proposals whose closure transition is gone become reverted_by_user; returns how many. Writes link_edge_proposals. */
  markRevertedEdgeProposals(): Promise<number>;
  /** `gbrain edge-proposals`: the proposals of `filter` with their slugs, newest first, at most `limit` (1 to 1000). Reads link_edge_proposals, pages. */
  listEdgeProposalCliRows(filter: ContradictionsCycleSql.EdgeProposalCliFilter, limit: number): Promise<ContradictionsCycleSql.EdgeProposalCliRow[]>;
  /** `gbrain edge-proposals retry --all-held`: deletes the judge errors held after their attempts; the deleted ids. Writes link_edge_proposals. */
  deleteHeldEdgeProposalErrors(): Promise<Array<{ id: number }>>;
  /** `gbrain edge-proposals undo --all-applied`: the applied proposals in id order. Reads link_edge_proposals. */
  listAppliedEdgeProposalIds(): Promise<Array<{ id: number }>>;
  /** `gbrain edge-proposals retry <id>`: deletes the proposal while it is a judge error; the deleted id. Writes link_edge_proposals. */
  deleteEdgeProposalError(id: number): Promise<Array<{ id: number }>>;
  /** `gbrain edge-proposals date`: the proposal's source, null when none. Reads link_edge_proposals. */
  readEdgeProposalSourceId(id: number): Promise<string | null>;
  /** `gbrain edge-proposals date`: rejects the proposal the user dated. Writes link_edge_proposals. */
  markEdgeProposalDated(id: number): Promise<void>;
  /** The live chunks with these ids that the caller's read policy (and trust floor) admits, for the scoped contradiction reader. Reads content_chunks, pages. */
  listLiveChunksByIds(ids: number[], policy: PageReadPolicy, floor: import('./trust/tier.ts').TrustTier | undefined): Promise<ContradictionsCycleSql.LiveChunkRow[]>;
  /** The active takes with these ids that the caller's read policy (holder allow-list, trust floor) admits. Reads takes, pages. */
  listLiveTakesByIds(ids: number[], policy: PageReadPolicy, floor: import('./trust/tier.ts').TrustTier | undefined): Promise<ContradictionsCycleSql.LiveTakeRow[]>;
  /** The prompt version of the most recent persisted contradiction run, null when none ran. Reads eval_contradictions_runs. */
  readLastContradictionsPromptVersion(): Promise<string | null>;
  /** The newest captured queries, at most `limit`. Reads eval_candidates. */
  listEvalCandidateQueries(limit: number): Promise<string[]>;

  // ============================================================
  // v0.31 Hot memory — facts table operations
  // ============================================================
  /**
   * Insert a fact into the per-source hot memory. The handler:
   *   1. canonicalizes entity_slug against pages (caller may pre-canonicalize)
   *   2. queries findCandidateDuplicates (entity-prefiltered, k=5 cap)
   *   3. cosine ≥0.95 fast-path → mark duplicate, skip classifier
   *   4. else classifier (caller's job; this engine method handles the
   *      DB-side INSERT/UPDATE only). On insert.status === 'duplicate' or
   *      'superseded' the engine returns the existing/superseding row id.
   * Per-entity advisory lock on Postgres serializes the dedup window.
   * PGLite no-op for the lock (single-process).
   *
   * `status` reflects what the engine wrote:
   *   'inserted'   → row inserted
   *   'duplicate'  → no new row (returns the matching candidate id)
   *   'superseded' → new row inserted; old row got expired_at + superseded_by
   */
  insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }>;

  /**
   * v0.32.2: batch insert for fence-extracted fact rows. Persists the
   * v51 fence columns (`row_num`, `source_markdown_slug`) alongside the
   * standard NewFact fields.
   *
   * Designed for the `extract_facts` cycle phase: wipe-then-batch-insert
   * per page. No dedup is performed here — callers (the cycle phase via
   * `deleteFactsForPage` + this) own that contract. Bypasses the
   * single-row supersede flow because fence reconciliation is the canonical
   * source-of-truth direction, not the consolidator path.
   *
   * Insertion is atomic per call: all rows commit in a single transaction
   * or none commit (the transaction rolls back on any constraint
   * violation, e.g. the v51 partial UNIQUE index on
   * `(source_id, source_markdown_slug, row_num)`).
   *
   * Returns the inserted ids in input-order so callers can correlate
   * fence-row → DB-id without a separate lookup.
   *
   * v0.46 (#3014): `superseded_by_row` carries a struck row's page-local
   * `superseded by #N` reference. A second pass in the same transaction
   * resolves it to `facts.superseded_by` (a FK to facts.id), keyed on
   * (source_id, source_markdown_slug, row_num). Unresolvable references
   * (self / dangling / chained) leave `superseded_by` NULL and surface a
   * `warnings` entry — never an FK to a guessed id (resolver:
   * `src/core/facts/supersede-resolve.ts`).
   *
   * v0.46 (#3014): `opts.deleteForPageFirst` makes the wipe-then-reinsert
   * reconcile atomic. When set, the page's fence-owned rows are DELETEd as
   * the first statement of the SAME transaction that inserts `rows`, so a
   * failing insert rolls the delete back and the page is never left
   * emptied. (A standalone `deleteFactsForPage` call before `insertFacts`
   * self-commits, so an insert throw would permanently lose the page's
   * facts.) `slug` / `excludeSourcePrefixes` / `preserveExpiredLegacy`
   * mirror `deleteFactsForPage`; the deleted count is returned as
   * `deleted`. Callers that omit it get the standalone insert (deleted: 0), unchanged.
   * `opts.deleteForPageFirst` is deprecated (GBRA-161 PR 2, test/generations-deprecated-fact-writers.test.ts).
   */
  insertFacts(
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }>;

  /**
   * v0.32.2: hard-delete every fact row scoped to a single fence page.
   *
   * Keyed on `(source_id, source_markdown_slug)`. Used by the
   * `extract_facts` cycle phase before re-inserting from the fence — the
   * fence is canonical, the DB is the derived index, so each phase run
   * wipes the page-scoped index and rebuilds it from the markdown.
   *
   * Hard DELETE (not soft-delete via `expired_at`). A fence row that
   * disappears from markdown corresponds to a fact the user removed
   * entirely from history; the DB mirrors that. Forgotten facts that
   * stay in the fence as strikethrough rows survive the wipe because
   * the re-insert puts them back with `valid_until = today` per the
   * `extract-from-fence` derivation contract.
   *
   * Pre-v51 rows (NULL `source_markdown_slug`) are NEVER deleted by this
   * call — the partial UNIQUE index on `row_num IS NOT NULL` is the
   * structural guarantee that legacy rows live in a different keyspace
   * until the v0_32_2 migration backfills them. Cycle-phase callers in
   * commit 7 add the empty-fence-guard as a belt-and-suspenders check.
   */
  /**
   * #1928: `excludeSourcePrefixes` protects facts whose `source` matches any
   * given prefix (e.g. `['cli:']` for conversation facts written by
   * `extract-conversation-facts`) from a fence reconcile. Those rows are NOT
   * fence-owned — a destructive wipe-and-reinsert pass would delete them and
   * never recreate them (the page has no `## Facts` fence). Omitted ⇒ legacy
   * behavior (delete every fact on the page coordinate). NULL/empty `source`
   * rows are always deletable (fence default).
   *
   * #2646: `preserveExpiredLegacy` protects soft-expired legacy rows
   * (`row_num IS NULL AND expired_at IS NOT NULL`) — the record left by
   * `forget_fact`'s legacy DB-only path. Fence rows always carry a
   * `row_num`, so these rows are never fence-owned and a wipe would
   * destroy the forget record (the audit trail of the forget). Note what
   * this does NOT promise: it protects the record, not the forget itself —
   * if the fence still carries the same claim, fence canonicality
   * independently reinserts it as a fresh active row (legacy DB-only
   * forgets are documented as non-durable; see extract-facts.ts). Omitted ⇒ legacy behavior.
   * @deprecated GBRA-161 PR 2: retire through publishFenceGeneration / publishExtractedFacts (docs/architecture/generations.md).
   */
  deleteFactsForPage(
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }>;

  /**
   * Mark a fact expired. Never DELETE. Returns true iff a row was updated.
   * Idempotent-as-false (already expired returns false without changing state). `successorFrom`: end by facts/supersede-interval.ts's rule.
   * @deprecated GBRA-161 PR 2: retire through publishFenceGeneration / publishExtractedFacts (docs/architecture/generations.md).
   */
  expireFact(id: number, opts?: { supersededBy?: number; at?: Date; successorFrom?: Date }): Promise<boolean>;

  /** List active facts about an entity within a source, newest first. */
  listFactsByEntity(
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]>;

  /**
   * List facts since a given timestamp within a source (creation time by
   * default; event time with `eventTime: true`, see FactListOpts). The
   * optional `entitySlug` / `sessionId` filters AND onto the time window in
   * the same SQL query, before LIMIT, so a caller composing "this entity (or
   * session) since T" gets the newest matching rows rather than a
   * post-filtered slice of the newest-N.
   */
  listFactsSince(
    source_id: string,
    since: Date,
    opts?: RecallFactReadOpts,
  ): Promise<FactRow[]>;

  /**
   * delta's facts arm: facts strictly after a `(created_at, id)` keyset
   * (`id: null` = strictly after the timestamp), OLDEST first, each row with
   * `created_at_iso` at column precision. Honors activeOnly, visibility,
   * fingerprint, limit, and the opt-in recall narrowing (entitySlug, sessionId, grep, excludeAuditRows) that --since-last-run paging uses.
   */
  listFactsKeyset(
    source_id: string,
    after: { createdAt: string; id: number | null } | null,
    opts?: RecallFactReadOpts,
  ): Promise<FactRow[]>;

  /** List facts captured under a session id within a source. */
  listFactsBySession(
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]>;

  /**
   * Audit log: facts that were superseded (superseded_by set), newest
   * first. Drives `gbrain recall --supersessions`. v0.46 (#3014): the
   * filter requires only `superseded_by IS NOT NULL`, not `expired_at`
   * too — the ontology-dimension writer closes a superseded row via
   * `valid_until` (not `expired_at`) so `--asof` time-travel still sees
   * it, so requiring `expired_at` here would drop every ontology
   * supersession. Ordering / `since` use COALESCE(expired_at, valid_until).
   * `visibility` filters BEFORE the LIMIT (same contract as
   * FactListOpts.visibility) so a remote world-only caller can't have a
   * private row consume a limit slot.
   */
  listSupersessions(
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: FactVisibility[]; eligibility?: FactListOpts['eligibility']; excludePrivate?: boolean },
  ): Promise<FactRow[]>;

  /**
   * v0.32: count facts that haven't been promoted to takes by the consolidate
   * phase yet (active + unconsolidated). Drives `gbrain recall --pending`.
   * Single SQL: COUNT(*) WHERE consolidated_at IS NULL AND expired_at IS NULL
   * AND (valid_until IS NULL OR valid_until > now()) — read-time TTL validity
   * keeps this backlog in lockstep with what the consolidator can read.
   */
  countUnconsolidatedFacts(source_id: string): Promise<number>;

  /**
   * The facts a page publication's fence projection would retire (engine-sql/facts.ts `listFenceRetireCandidates`): the
   * before-state of each fact attached to the page at a fence position that the incoming fence (`target.incoming`, the
   * JSON text of its row_num, fact and visibility) does not hold as it is, by row number then id. A conversation-extractor
   * row counts only when a fence row claims its number; a private row `gbrain repair open-facts` opens never does.
   */
  listFenceRetireCandidates(target: FenceProjectionTarget): Promise<FactPreimage[]>;

  /**
   * The before-state of the facts `ids` of `sourceId` (engine-sql/facts.ts `readFactPreimages`, `FACT_PREIMAGE_SQL`),
   * in id order; an id that is no fact of the source is left out, and an id that is not a whole number is refused. The
   * generation adapters (generations/adapters/fact-rows.ts `factPreimages`) record it before rows change.
   */
  readFactPreimages(sourceId: string, ids: readonly number[]): Promise<FactPreimage[]>;

  /**
   * Puts the recorded before-state `preimage` (`FACT_PREIMAGE_SQL`) back onto its fact of `sourceId` in the caller's
   * transaction (engine-sql/facts.ts `restoreFactPreimage`): lifecycle, consolidation marks, and the fence position
   * when no other row of the page holds it. Only a row whose claim and visibility still match changes; resolves whether it did.
   */
  restoreFactPreimage(sourceId: string, preimage: Record<string, unknown>): Promise<boolean>;

  /**
   * The extracted facts generation's rows and retire (engine-sql/facts.ts): the ids of a page coordinate's facts whose
   * `source` starts with `sourcePrefix` (matched literally; `%`, `_` and `\` refuse), by id; and the expiry, now, of the live facts of `ids`.
   */
  listFactIdsBySourcePrefix(sourceId: string, slug: string, sourcePrefix: string): Promise<number[]>;
  expireFactRows(sourceId: string, ids: readonly number[]): Promise<void>;

  /**
   * Find candidate duplicates for a new fact within a source+entity bucket.
   * Entity-prefilter is mandatory (bounds the contradiction-classifier blast
   * radius). Hard cap k=5 by default. Embedding-cosine when both sides have
   * embeddings; recency fallback otherwise. `arm: 'keyword'` ranks the same
   * bucket by full-text rank instead (C2 `facts.candidate_fusion`).
   * `attributedTo` (the new fact's speaker) drops rows a different known
   * speaker asserted before the k cap, in every arm; NULL rows stay candidates; `excludeMemberPages` drops member pages.
   */
  findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array; embeddingModel?: string | null; arm?: 'keyword'; attributedTo?: FactAttribution | null; excludeMemberPages?: boolean; onlyPage?: string },
  ): Promise<FactRow[]>;

  /**
   * Mark a fact as consolidated into a take. Sets consolidated_at + consolidated_into.
   * Never DELETE — facts stay as audit trail.
   */
  consolidateFact(id: number, takeId: number): Promise<void>;

  /**
   * v0.35.4 (D-CDX-1 + D-CDX-6) — chronological fact trajectory for an
   * entity. Returns points ordered by (valid_from ASC, id ASC) so the
   * caller can compute regressions and drift_score deterministically.
   *
   * - Source-scoped via `sourceId` (scalar) OR `sourceIds` (federated array).
   * - Visibility-filtered: when `opts.remote=true`, only `visibility='world'`
   *   facts are returned. Trusted local callers see both private + world.
   * - Optional metric filter restricts to a single normalized metric label.
   * - Active-only by default (expired_at IS NULL). DELIBERATELY no
   *   valid_until clause: trajectory is a HISTORY view, and the consolidator
   *   stamps valid_until on every non-newest point in a cluster — filtering
   *   would collapse each trajectory to its final point. Soft-deleted
   *   entities on the pages side are NOT filtered here — trajectory is a
   *   facts-table query and doesn't JOIN pages.
   */
  findTrajectory(opts: TrajectoryOpts): Promise<TrajectoryPoint[]>;

  /** Per-source operational metrics for `gbrain doctor` facts_health check. */
  getFactsHealth(source_id: string): Promise<FactsHealth>;

  // Segmented page storage (Wave B; SQL in engine-sql/page-body.ts). Called only when pages.segmented_storage is on.
  /** `count` fresh manifest occurrence ids from one sequence; never reused. */
  allocateBodyOccurrenceIds(count: number): Promise<number[]>;
  /** Insert segment texts for one source, `ON CONFLICT DO NOTHING`, in statements bounded by STAGE_BATCH_BYTES; with `stagingId`, record them as that staging's (a page purge keeps them while it is live). */
  stageSegmentTexts(sourceId: string, texts: readonly SegmentTextInput[], opts?: { stagingId?: string }): Promise<{ inserted: number }>;
  /** Segment texts by sha256 for one source, keyed by lowercase hex; missing shas are absent. */
  readSegmentTexts(sourceId: string, sha256s: readonly Uint8Array[]): Promise<Map<string, Uint8Array>>;
  /** Insert manifest rows (staged rows carry `stagingId`), in bounded statements. */
  stageManifestRows(rows: readonly ManifestRowInput[]): Promise<void>;
  /** Manifest metadata (never text) of generation `generation` (default: the page's live body_generation), or of a staging, in seq order; `lastN` returns the tail rows of `region` (or the page). */
  readManifest(pageId: number, opts?: { generation?: number; stagingId?: string; region?: BodyRegion; lastN?: number }): Promise<ManifestRow[]>;
  /** A segmented page that is live, sealed and in a live source, by id or by source and slug; null otherwise, an inline page included (`readSegmentedEmbedPage`). */
  readSegmentedEmbedPage(ref: SegmentedEmbedRef): Promise<SegmentedEmbedPage | null>;
  /** Insert chunk rows of new occurrences under `generation` (invisible until the flip); chunk_index continues past the page's maximum under a per-page transaction advisory lock. Returns the assigned chunk indexes in input order. */
  stageSegmentChunks(pageId: number, generation: number, chunks: readonly SegmentChunkInput[], opts?: { embeddingColumn?: ResolvedColumn }): Promise<number[]>;
  /** Insert the row of a new segmented page at body_generation 0 (never visible outside the transaction that flips it to 1). */
  createSegmentedPageShell(slug: string, meta: SegmentedPageMeta, opts: { sourceId: string }): Promise<{ id: number }>;
  /** The generation flip, inside the publication transaction: closes and publishes manifest rows, retires chunk rows (bounded), updates the page row. Refuses `revision_changed` when the page's body_generation is not `expectedGeneration`. */
  flipBodyGeneration(input: BodyFlipInput): Promise<BodyFlipResult>;
  /**
   * Seal a segmented page's text projection at its current revision: its chunks become visible, and its title and
   * sanitized timeline lead (`timelineLead`, else the stored lead, after the page's withdrawal overlay) become its keyword
   * vector. The chunker stamp keeps an older segmented chunker while any chunk row from before this generation remains.
   * A missing page is a no-op. Runs inside the caller's publication transaction as its last step.
   */
  sealSegmentedPage(pageId: number, opts?: { timelineLead?: string }): Promise<void>;
  /** Record a body staging (GC root while open/sealed/prepared). */
  openBodyStaging(input: BodyStagingInput): Promise<void>;
  /** Move a staging to a new state; `commitRequestId` with `committed`. */
  setBodyStagingState(id: string, state: BodyStagingState, opts?: { commitRequestId?: string | null }): Promise<void>;
  /** Garbage collection: retired chunks and dead manifest rows (versions are roots), unreferenced texts past the grace window, expired stagings. */
  sweepSegments(opts?: SegmentSweepOptions): Promise<SegmentSweepResult>;
  /** Whether any body staging or segment text exists: the vacuum's one probe before it sweeps (engine-sql/write-guards.ts). */
  hasSegmentStorage(): Promise<boolean>;
  // Per-segment derivation watermarks (Wave B PR 4; types in page-body/derivations.ts, SQL in engine-sql/page-body.ts).
  /** A page's rows (every kind, or `kind`; optionally only `occurrenceIds`), by kind then occurrence. */
  readSegmentDerivations(pageId: number, opts?: { kind?: SegmentDerivationKind; occurrenceIds?: readonly number[] }): Promise<SegmentDerivationRow[]>;
  /** Claims normalized and folded as derivation needles (gbrain_fact_normalize, then the fold), non-empty, distinct, by byte order. */
  /** Insert or replace rows keyed (page, kind, occurrence) in bounded statements; a replaced row keeps created_at. */
  upsertSegmentDerivations(rows: readonly SegmentDerivationInput[]): Promise<void>;
  /** Delete a page's rows (every kind, or `kind`) whose occurrence is not in `liveOccurrenceIds`; returns the count. */
  retireSegmentDerivations(pageId: number, liveOccurrenceIds: readonly number[], opts?: { kind?: SegmentDerivationKind }): Promise<number>;
  // The fact purge's segmented writes (engine-sql/segmented-purge-writes.ts).
  /** The state of a body staging, read under its row lock, or null when no staging has that id (the flip of a create checks it). */
  lockBodyStagingState(stagingId: string): Promise<string | null>;
  /** A segmented write: the members of `occurrenceIds`, in order, with a chunk row at or below `generation` (engine-sql/segmented-writes.ts). */
  listChunkedOccurrences(pageId: number, occurrenceIds: readonly number[], generation: number): Promise<number[]>;
  /** A segmented write: the stored vectors in `column` of the visible chunks of `occurrences`, in chunk_index order, for reuse (engine-sql/segmented-writes.ts). */
  readRetiredChunkVectors(pageId: number, occurrences: readonly number[], column: string): Promise<RetiredChunkVectorRow[]>;
  /** A segmented projection: whether the page stores a chunk row generation `generation` (live occurrences `live`) does not hold (engine-sql/segmented-writes.ts). */
  hasStaleSegmentChunks(pageId: number, generation: number, live: readonly number[]): Promise<boolean>;
  /** A segmented projection: delete up to `maxRows` of those stale chunk rows; returns how many it deleted (engine-sql/segmented-writes.ts). */
  retireStaleSegmentChunks(pageId: number, generation: number, live: readonly number[], maxRows: number): Promise<number>;
  /** A segmented projection: the live segmented page at `sourceId`/`slug` it builds, or null (engine-sql/segmented-writes.ts). */
  readSegmentedProjectionPage(sourceId: string, slug: string): Promise<SegmentedProjectionPage | null>;
  /** Deletes the page's chunk rows at `generation` whose chunk_index is not in `keepChunkIndexes` (rows a dead preparation staged). */
  deleteUnstagedSegmentChunks(pageId: number, generation: number, keepChunkIndexes: readonly number[]): Promise<void>;
  /** Deletes the derivation rows a rewritten segment may hold (segment-derive.ts deleteRewrittenDerivations); answers how many. */
  deleteRewrittenSegmentDerivations(spec: SegmentedPurgeWritesSql.RewrittenDerivationsDelete): Promise<number>;
  // The read-view digest cache of a segmented page (engine-sql/page-view-digests.ts). A miss recomputes; a store with no cache serves a permanent miss.
  /** The cached digest of one read view of a page, or null when none is stored. */
  readPageViewDigest(key: PageViewDigestsSql.PageViewDigestKey): Promise<PageViewDigestsSql.PageViewDigest | null>;
  /** Caches the digest of one read view and drops the page's cached views of other revisions. */
  writePageViewDigest(key: PageViewDigestsSql.PageViewDigestKey, digest: PageViewDigestsSql.PageViewDigest): Promise<void>;

  // Versions
  /**
   * Snapshot a page row into page_versions. Source-scoped via `opts.sourceId`;
   * without it the bare-slug lookup snapshots whichever row Postgres returns
   * first when the slug exists across multiple sources.
   */
  /** `preimage` (#5984): the caller's own read of the page under its page guard in this transaction; versioned without a re-read. `reason`/`historyGap` (GBRA-217, sync imports): the snapshot's change reason and the page's history-gap marker. */
  createVersion(slug: string, opts?: { sourceId?: string; preimage?: PageSnapshot } & import('./page-state/versions.ts').VersionHistory): Promise<PageVersion>;
  /**
   * v0.31.8 (D12 + D16): `opts.sourceId` source-scopes the page-id lookup.
   * When omitted, returns versions for every same-slug page across sources
   * (pre-v0.31.8 behavior; preserved via two-branch query).
   */
  getVersions<B extends boolean = true>(slug: string, opts?: GetVersionsOpts<B>): Promise<PageVersionRows<B>>;
  /** The page's newest version id (`max(page_versions.id)`), or null when it keeps none (engine-sql/version-reasons.ts). */
  readLatestVersionId(pageId: number): Promise<number | null>;
  /** The page's newest version whose snapshot `trust_tier` is `tier`, or null when none is (engine-sql/version-reasons.ts). */
  readLatestVersionIdAtTier(pageId: number, tier: string): Promise<number | null>;
  /** Sets `change_reason` on the page's versions with an id over `afterVersionId`; answers how many took it. */
  stampVersionChangeReason(spec: { pageId: number; afterVersionId: number; reason: string }): Promise<number>;
  /** The versions of the source's pages whose change reason is one of `reasons`, by id (repair purged-change-reasons). */
  listVersionsByChangeReason(sourceId: string, reasons: readonly string[]): Promise<import('./engine-sql/version-reasons.ts').VersionReasonRow[]>;
  /** The page's retained inline version bodies, newest first, at most `limit` (repair redacted-facts). */
  listRetainedVersionBodies(pageId: number, limit: number): Promise<Array<{ id: number; compiled_truth: string }>>;
  /** The newest version of a page that a request archived, or null (repair accepted-takes). */
  readArchivedVersionBody(pageId: number, receiptId: string): Promise<{ id: number; body_storage: string | null; compiled_truth: string | null; timeline: string | null } | null>;
  /** overwritten-edits: versions a managed sync import archived over a database edit, newest first (engine-sql/overwrite-reads.ts). */
  listOverwriteCandidates(sourceId: string, slugs: readonly string[] | null, limit: number): Promise<OverwriteSql.OverwriteCandidateRow[]>;
  /** The later versions of the pages, by id, with their writing request and content. */
  listVersionsAfter(pageIds: readonly number[], afterId: number): Promise<OverwriteSql.OverwriteVersionRow[]>;
  /** Each named page's revision, its writing request, content and tags. */
  listOverwriteLivePages(pageIds: readonly number[]): Promise<OverwriteSql.OverwriteLiveRow[]>;
  /** One version's content columns, or null. */
  readVersionContent(versionId: number, pageId: number): Promise<OverwriteSql.OverwriteContentRow | null>;
  /** Sets `replacement` on each named version still holding its named reason; answers the ids set, by id. */
  replaceVersionChangeReasons(sourceId: string, rows: ReadonlyArray<{ id: number; reason: string }>, replacement: string): Promise<number[]>;
  /**
   * GST-2497 (engine-sql/version-prune.ts): keeps a holding page's newest LARGE_PAGE_VERSIONS_KEPT inline versions, deletes
   * at most HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE older ones, marks the history it cut; answers how many it deleted.
   */
  pruneHoldingPageVersions(pageId: number): Promise<number>;
  /**
   * v0.31.8 (D12): `opts.sourceId` source-scopes both the version lookup
   * and the page revert. Without it, multi-source brains can revert the
   * wrong row when the slug exists in 2+ sources.
   */
  revertToVersion(slug: string, versionId: number, opts?: { sourceId?: string }): Promise<void>;

  // Stats + health
  /**
   * #4592: both diagnostics take an optional source scope (same shape as
   * sourceScopeOpts). Omitted = brain-wide (trusted local). Scoped = EVERY
   * counter/coverage/degree confines to the grant — including derived-table
   * counts via their page joins, and link-derived numbers only when BOTH
   * endpoints are in scope — so an excluded source's numbers can't be
   * recovered by subtraction.
   */
  getStats(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainStats>;
  getHealth(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainHealth>;
  /** The liveness round trip (`/health`, doctor's connection check, the minion worker's probe): resolves when the store answers. `direct`: a SQL engine's direct lane (Rust has one lane). */
  pingStore(opts?: { signal?: AbortSignal; direct?: boolean }): Promise<void>;

  // The admin operations' statements (engine-sql/admin-reads.ts).
  /** The slugs among `slugs` that name a live page the policy part admits, within the source scope (`null` admits every source). Reads pages. */
  listVisiblePageSlugs(slugs: string[], sourceIds: string[] | null, policy: AdminReadsSql.PagePolicyPart): Promise<string[]>;
  /** The live pages with these ids: slug, source and frontmatter, for the version history. Reads pages. */
  readPagesForVersionHistory(pageIds: number[]): Promise<AdminReadsSql.VersionPageRow[]>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  /**
   * `opts.sourceIds` scopes the log to those sources (federated read grant /
   * remote caller scope). Omitted → whole brain (trusted local callers).
   */
  getIngestLog(opts?: { limit?: number; sourceIds?: string[] }): Promise<IngestLogEntry[]>;

  // Sync
  /**
   * Rename a page's slug (chunks + links + tags + timeline + versions all
   * preserved via stable page_id). `opts.sourceId` scopes the UPDATE — without
   * it, the bare `WHERE slug = old` matches every row across every source and
   * would either rename them all OR violate the (source_id, slug) UNIQUE.
   *
   * Returns the number of rows moved. 0 means the old slug had no row in the
   * scoped source — an UPDATE that matches nothing does NOT throw, so callers
   * that need to know whether the rename actually happened (the sync rename
   * path, #3056) must check the return value rather than rely on the catch.
   */
  updateSlug(oldSlug: string, newSlug: string, opts?: { sourceId?: string }): Promise<number>;
  rewriteLinks(oldSlug: string, newSlug: string): Promise<void>;

  /**
   * v0.42 type-unification (T2, plan D1+F10). Returns the canonical slug if
   * `slug` is registered in `slug_aliases` for any of the provided source(s);
   * otherwise returns `slug` unchanged. Defense-in-depth: also returns the
   * input when the table doesn't exist yet (pre-v104 brains).
   *
   * Accepts either a single sourceId (scalar) OR a sourceIds array
   * (federated reads). Multi-source ambiguity: when the same alias_slug
   * exists in two registered sources, returns the first match in array
   * order and emits a once-per-process stderr `multi_match` warning.
   *
   * Callers (the cluster the alias-table primitive is meant for):
   *   - src/core/entities/resolve.ts: wikilink resolver short-circuit
   *     (alias-table is authoritative; runs BEFORE fuzzy/prefix cascade)
   *   - MCP `read_page` op (canonical lookup)
   *   - Search rank stage `applyAliasResolvedBoost` (knows whether a
   *     top-K result was reached via an alias)
   *
   * Source-scoped throughout per F12 (codex outside voice) — no cross-source
   * false-positive resolution. v0.42 ships this method on both engines.
   */
  resolveSlugWithAlias(
    slug: string,
    sourceOrSources: string | readonly string[],
    opts?: Pick<PageReadScope, 'excludePrivate'>,
  ): Promise<string>;
  /**
   * `resolveSlugWithAlias` plus the OWNING source of the winning alias row
   * (same scope + precedence rules), or null when no alias matches (or the
   * table predates v104). A consumer that goes on to READ the canonical page
   * must scope that read to `source_id`: a federated getPage prefers the
   * anchor source, so an unrelated live page at the canonical slug in another
   * granted source would otherwise shadow the alias owner's page.
   */
  resolveSlugWithAliasDetailed(
    slug: string,
    sourceOrSources: string | readonly string[],
    opts?: Pick<PageReadScope, 'excludePrivate'>,
  ): Promise<{ canonical_slug: string; source_id: string } | null>;

  /**
   * T3 retrieval-cathedral — free-text alias resolution for SEARCH.
   * Given a set of NORMALIZED alias strings (normalizeAlias() output),
   * return a map alias_norm -> canonical slugs from page_aliases. An alias
   * may resolve to MORE THAN ONE slug (two pages claimed the same name) —
   * the caller reports the collision and resolves deterministically.
   *
   * Source-scoped: pass scalar `sourceId` (single-source) OR `sourceIds`
   * (federated read) — array wins when both set, matching sourceScopeOpts.
   * Empty input → empty map (no query). Throws "relation page_aliases does
   * not exist" on pre-v110 brains; the alias-hop caller wraps in try/catch
   * (isUndefinedColumnError) and degrades to no-injection (D9 fail-open).
   */
  resolveAliases(
    aliasNorms: string[],
    opts?: PageReadScope,
  ): Promise<Map<string, Array<{ slug: string; source_id: string }>>>;

  /**
   * T3 retrieval-cathedral — WRITE side of the alias layer. Replace the full
   * alias set for one (slug, source) with `aliasNorms` (already normalized):
   * delete the page's existing page_aliases rows, insert the new set. Empty
   * `aliasNorms` just clears them. Idempotent (the unique triple). Called by
   * the ingest projection in importFromContent and the `reindex --aliases`
   * backfill so a page's declared aliases stay in lockstep with its frontmatter.
   */
  setPageAliases(
    slug: string,
    sourceId: string,
    aliasNorms: string[],
    /** #5984: `inline` writes in the caller's page transaction, without a savepoint. */
    opts?: { inline?: boolean },
  ): Promise<void>;
  /**
   * Replace a page's derived alias rows (origin declared/subject, written by the mention pass) with `aliases`; an
   * empty list only deletes. Frontmatter rows are untouched. Runs on the transaction engine it is called on.
   */
  replaceDerivedAliases(slug: string, sourceId: string, aliases: readonly DerivedAliasRow[]): Promise<void>;
  /**
   * A live, unsegmented page's stored `chunker_version` by page id, or null when the page is gone, deleted or
   * segmented. The import reads it to see whether the stored chunks predate the safe-chunk fence.
   */
  getPageSealState(pageId: number): Promise<{ chunker_version: number | null } | null>;
  /** Record where a live page's file lives (`source_path`, and `source_uri` when given); a page already holding both writes nothing. */
  refreshPageOrigin(slug: string, opts: { sourceId: string; sourcePath: string; sourceUri?: string | null }): Promise<void>;
  // Page write guards (engine-sql/write-guards.ts): the origin check and bind, the ingest stamp and the import seal.
  /** The page `target` names, live or a tombstone (by `pageId` within the source, else by `slug`), or null. */
  readPageOrigin(target: PageOriginTarget): Promise<PageOriginRow | null>;
  /** The soft-deleted pages with `slug` (of `sourceId` only, when given) a restore revives, by source id in byte order. */
  listRevivalPages(slug: string, sourceId: string | null): Promise<RevivalPageRow[]>;
  /** Locks each origin key (`opts.lockKeys`) until the transaction ends, then the live pages other than `excludePageId` recording one of `spellings`, by slug. */
  listOriginClaims(sourceId: string, spellings: readonly string[], opts: { lockKeys: readonly string[]; excludePageId?: number | null }): Promise<OriginClaimRow[]>;
  /** Records `sourcePath` as a page's origin (persistence/origin-guard.ts `bindOrigin` only); the number of pages whose origin changed. */
  bindPageOrigin(target: PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }): Promise<number>;
  /** Forgets a page's recorded file (`source_path`, `source_uri`) and marks it database-only with `reason`; the knowledge revision stays. */
  detachPageOrigin(pageId: number, reason: string): Promise<void>;
  /** The page's `database_only_reason`, live or a tombstone, or null (also for no such page). */
  readPageDatabaseOnlyReason(sourceId: string, slug: string): Promise<string | null>;
  /** Gives a page a new knowledge revision, live or a tombstone (its text projection seal is cleared). */
  bumpPageKnowledgeRevision(pageId: number): Promise<void>;
  /** Removes frontmatter keys from a live page of the source; a page that held one takes a new knowledge revision. */
  removePageFrontmatterKeys(sourceId: string, pageId: number, keys: readonly string[]): Promise<void>;
  /** Sets a page's `type`, live or a tombstone; a changed type takes a new knowledge revision. */
  setPageType(sourceId: string, slug: string, type: string): Promise<void>;
  /** Records a page's ingest provenance (`source_kind`, `ingested_via`, `ingested_at`); a missing page writes nothing. */
  stampPageIngest(slug: string, stamp: PageIngestStamp): Promise<void>;
  /** An import's closing seal: the chunker version always, the text seal when the page is at `seal.revision`; the page id, or null. */
  sealImportedPage(slug: string, seal: ImportedPageSeal): Promise<{ id: number } | null>;
  /** A live page's frontmatter, body columns, body storage and content hash (the valid-time advisory's after image), or null. */
  readLivePageBody(slug: string, opts: { sourceId: string }): Promise<LivePageBodyRow | null>;
  /** A page's stored body columns by id, live or a tombstone, read raw (the append tail digest), or null (engine-sql/write-guards.ts). */
  readInlinePageRegions(pageId: number): Promise<InlinePageRegionsRow | null>;
  /** The raw stored `trust_tier` of a page by (source, slug), live or a tombstone (the page write gate), or null (engine-sql/write-guards.ts). */
  readStoredPageTier(sourceId: string, slug: string): Promise<string | null>;
  /** Page `pageId`'s chunker version, corpus generation and page kind (a text projection's indexing context), live or a tombstone; null for no such page. */
  readPageIndexingState(pageId: number): Promise<PageIndexingState | null>;
  /**
   * The page embedding ledger on the paid path (engine-sql/page-embedding-budget.ts; page-embedding-budget.ts owns the
   * policy): the page's hold marker and ledger row, the hold record, the approval that opens a hold, the grant under the
   * row lock and the settle inside the grant's reservation window.
   */
  readPageEmbeddingBudget(pageId: number): Promise<PageEmbeddingBudgetRow>;
  recordPageEmbeddingHold(pageId: number, reason: string): Promise<void>;
  openPageEmbeddingHold(pageId: number): Promise<void>;
  reservePageEmbedding(pageId: number, input: PageEmbeddingReserveInput): Promise<PageEmbeddingReservation>;
  settlePageEmbeddingReservation(pageId: number, settle: { window: string | null; reservedUsd: number; bookedUsd: number; unpricedCalls: number }): Promise<void>;
  /**
   * The extraction watermark and partial-input receipt (engine-sql/page-extraction-state.ts; extraction-watermark.ts owns
   * the policy), one row per page and pipeline: the live page's id with its stored watermark, the commit of a successful
   * extraction, the receipt read, the row delete and the receipt upsert. A hard page delete and a source delete remove the rows.
   */
  readPageExtractionWatermark(sourceId: string, slug: string, pipeline: PageExtractionPipeline): Promise<PageExtractionWatermarkRow | null>;
  commitPageExtraction(commit: PageExtractionCommit): Promise<void>;
  readPageExtractionReceipt(pageId: number, pipeline: PageExtractionPipeline): Promise<Record<string, unknown> | null>;
  clearPageExtractionState(pageId: number, pipeline: PageExtractionPipeline): Promise<void>;
  writePageExtractionReceipt(pageId: number, pipeline: PageExtractionPipeline, pipelineVersion: number, receipt: Record<string, unknown>): Promise<void>;
  /**
   * The embedding effect's install path (engine-sql/embedding-install.ts): the page's visible chunks and which carry a
   * current vector, the effect claim under its row lock, the embedding switch's share lock and one batch of the install.
   */
  readEmbeddingCompletion(pageId: number, opts: EmbeddingCompletionOpts): Promise<EmbeddingCompletionRow[]>;
  lockEffectClaimRow(effectId: number | string): Promise<{ state: string; execution_token: string | null } | null>;
  lockEmbeddingSwitch(): Promise<void>;
  installChunkEmbeddings(pageId: number, column: ResolvedColumn, batch: string): Promise<void>;
  // Page visibility guards (engine-sql/page-visibility.ts): the current caller's page policy, rendered in its access record.
  /** Whether a row of the page (live or soft-deleted) fails the current caller's policy: `read` (access, then privacy) or `access` alone. */
  readPageHiddenFromCaller(sourceId: string, slug: string, opts: { policy: PagePolicyPart }): Promise<boolean>;
  /** Whether the live page passes the empty-identity page policy with privacy (no reader identity, grant or satisfied rule counts; the caller's folder coverage and owner flag do); false for a missing or soft-deleted page. */
  readPageWorldVisible(sourceId: string, slug: string): Promise<boolean>;
  /** For each (source_id, slug) that names a page row, whether a live row of it passes the current caller's policy; in no set order. */
  readCallerPageAccess(pages: readonly { source_id: string; slug: string }[], opts: { policy: PagePolicyPart }): Promise<CallerPageAccessRow[]>;
  /** The opening read of a remote page write's visibility check: labelled-only members, what a reader identity could open on the page the empty-identity policy hides, owner-only sources. */
  readWriteVisibilityProbe(sourceId: string, slug: string): Promise<WriteVisibilityProbe | undefined>;
  /** Whether the live page fails the privacy part of the remote read policy (honor_aliases read first); null when it has no live page. */
  readPagePrivacyHidden(sourceId: string, slug: string): Promise<boolean | null>;
  /** A stored writer's slug fence now (an OAuth client's bound prefixes, or its delegated ones for a delegated write; a local writer's grant ceiling), or null. */
  readWriterSlugFence(principal: { kind: string; id: string }, opts?: { delegated?: boolean }): Promise<unknown>;
  // The remote links effect and its batch re-arm (engine-sql/remote-links.ts).
  /** The links effect transaction's settings: synchronous commit, a 1s lock wait and a 5s statement limit. */
  setEffectTransactionLimits(): Promise<void>;
  /** The edges `linkSource` owns from page `originPageId`, with each target's slug. */
  readOwnedLinks(linkSource: string, originPageId: number | string): Promise<OwnedLink[]>;
  /** Removes the edges among `ids` that `linkSource` owns from page `originPageId`; returns how many. */
  deleteOwnedLinks(originPageId: number | string, linkSource: string, ids: readonly (number | string)[]): Promise<number>;
  /** The live pages of the source among `slugs`: readable under the writer's policy (null: every page) and shown by the privacy part. */
  readLinkTargetPages(sourceId: string, slugs: readonly string[], policy: WriterReadPolicy | null): Promise<LinkTargetPage[]>;
  /** Re-arms, once each, the `links` effects of requests published together; returns how many. */
  rearmLinksEffects(opts: LinksRearm): Promise<number>;
  /** Whether page `pageId` has a queued or running facts backstop effect, or a facts-absorb job in `jobStates` (engine-sql/facts-backstop.ts). */
  hasPendingFactsExtraction(pageId: number | string, jobStates: readonly string[]): Promise<boolean>;
  /** Whether a facts-absorb job for page `pageId` completed without being skipped (engine-sql/facts-backstop.ts). */
  hasCompletedFactsExtraction(pageId: number | string): Promise<boolean>;
  /** A live page's stored body size (segmented `body_bytes`, else the UTF-8 bytes of its body columns), or null (engine-sql/large-page.ts). */
  readStoredBodyBytes(slug: string, sourceId: string): Promise<number | null>;
  // Relational recall arm page reads (engine-sql/relational-reads.ts).
  /** The refs naming a live, unquarantined page of an unarchived source that `policy` admits (`pageReadFilter` live); in no set order. */
  readAdmittedPageRefs(refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageRefRow[]>;
  /** The observation-date inputs (frontmatter, import filename) of the refs' live pages that `policy` admits (search/evidence-date.ts); in no set order. */
  readAdmittedPageDateFields(refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageDateFieldsRow[]>;
  /** The observation-date inputs of the page rows `ids` name, soft-deleted included (search/evidence-date.ts); in no set order. */
  readPageDateFieldsByIds(ids: readonly number[]): Promise<PageDateFieldsByIdRow[]>;
  /** The refs' pages that `policy` admits and the search visibility clause shows, with the bounded body prefix as `synopsis`; in no set order. */
  readPageSynopses(refs: readonly PageRefRow[], policy?: PageReadPolicy): Promise<RelationalPageRow[]>;
  /** At most two slugs of live, unretired pages of `sourceId` whose type is in `types` and whose title matches `title` case-insensitively; in no set order. */
  readSeedTitleSlugs(sourceId: string, types: readonly string[], title: string): Promise<string[]>;
  /** Page `pageId`'s body and truth sizes (deleted or not), append_page's read after its write, or null (engine-sql/large-page.ts). */
  readPageBodySizes(pageId: number): Promise<PageBodySizes | null>;
  /**
   * The page's live fence facts the writer may not simply expire (engine-sql/trust-fence.ts), by row number and locked until
   * the transaction ends: more trusted than the writer's declared tier, held narrower by a widening proposal the incoming
   * fence still asks to widen, or opened by `gbrain repair open-facts`. Each row carries its stored `trust_tier`.
   */
  listFenceFactRows(target: FenceRowsTarget): Promise<FenceFactRow[]>;
  /**
   * A fence append's restore (trust/fence-append.ts withPageTierKept, engine-sql/trust-fence.ts): sets the page's
   * trust_tier and write_origin back. The tier trigger still applies, so a raise needs the caller's promotion.
   */
  restorePageTrust(spec: PageTrustRestore): Promise<void>;
  /**
   * Of the page's take or timeline rows `ids`, the rows a write may not delete or overwrite (engine-sql/trust-fence.ts), by
   * id and locked until the transaction ends: more trusted than `writer` (the declared tier when omitted) and, with
   * `pending`, held by an open `forget` contest. Each row carries its stored `trust_tier`.
   */
  listHeldRows(q: HeldRowsQuery): Promise<Array<{ id: number; trust_tier: string }>>;
  /** The stored takes of a reconcile batch's pages that a lower-tier write may not change, by page and row, locked (engine-sql/trust-fence.ts). */
  listGuardedTakeRows(q: GuardedTakeRowsQuery): Promise<GuardedTakeRow[]>;
  /**
   * Trust decisions (engine-sql/trust-proposals.ts): inserts a pending proposal, or returns the pending one already recorded
   * for the same (action, target, related) with `created: false`. The proposer principal and request come from the
   * transaction's attribution settings.
   */
  insertTrustProposal(input: NewTrustProposal): Promise<{ id: number; created: boolean }>;
  /** One trust proposal by id, or null; `lock` takes it `FOR UPDATE` for the decision that follows. */
  getTrustProposal(id: number, lock?: boolean): Promise<TrustProposalRow | null>;
  /** The privacy holds among `ids` whose target fact the current caller's widened world-only fact reads do not admit, ascending (trust/privacy-hold-reply.ts). */
  listUnreadablePrivacyHoldIds(ids: number[]): Promise<number[]>;
  /** Trust proposals by status (`pending` by default; `all`), source, action and creation time, oldest first (500 by default, at most 5000). */
  listTrustProposals(filter?: TrustProposalFilter): Promise<TrustProposalRow[]>;
  /** The pending trust proposals naming a row as target or related, by id. */
  pendingTrustProposalsFor(table: TrustTable, id: number): Promise<TrustProposalRow[]>;
  /** Replaces a pending trust proposal's after state; a decided one is left alone. */
  updatePendingTrustProposalAfter(id: number, after: Record<string, unknown>): Promise<void>;
  /** Compare-and-set on a trust proposal's status, recording an after state and the decider; false when it was not in `from`. */
  transitionTrustProposal(id: number, from: TrustProposalStatus, to: TrustProposalStatus, opts?: TrustProposalTransition): Promise<boolean>;
  /** The contradictions `trust review` lists: pending decide proposals whose two facts are both active, by source and creation time, oldest first (at most 1000). */
  listPendingContradictions(filter?: PendingContradictionFilter): Promise<PendingContradictionRow[]>;

  /**
   * v0.35.5 — narrow UPDATE of `pages.compiled_truth`, `pages.timeline`, and
   * `pages.content_hash` for a single slug+source. NO chunking, NO embedding,
   * NO link reconcile, NO `updated_at` advance beyond the trivial bump.
   *
   * Used by the phantom-redirect pass in `extract_facts` after appending
   * migrated fact rows to a canonical page's disk fence: we just rewrote the
   * `.md` on disk, so the DB body must match before the next reconcile reads
   * stale state. content_hash is included so the next `gbrain sync` sees the
   * canonical as unchanged and skips re-import (round-14 + codex #7 — the
   * "second cycle is a no-op" premise depends on all three columns moving
   * together).
   *
   * Skips soft-deleted rows (deleted_at filter). Idempotent — second call
   * with the same args produces the same row state.
   */
  refreshPageBody(
    slug: string,
    sourceId: string,
    compiledTruth: string,
    timeline: string,
    contentHash: string,
  ): Promise<void>;

  /**
   * v0.40.3.0 — narrow UPDATE that stamps the two CR-state columns
   * (`contextual_retrieval_mode`, `corpus_generation`) plus
   * `updated_at = now()` and nothing else.
   *
   * Used by `src/core/contextual-retrieval-service.ts:reembedPageWithContextualRetrieval`
   * at the end of its PHASE 2 transaction. Why narrow instead of routing
   * through `putPage`: stamping the CR state alone shouldn't trigger the
   * full page-version snapshot machinery (createVersion fires on every
   * putPage with an existing row, which would bloat page_versions on every
   * tier upgrade).
   *
   * Skips soft-deleted rows (deleted_at filter). Idempotent — same args
   * twice produces the same row state. Both columns are NULL-tolerant
   * (callers pass NULL for `corpusGeneration` only on the 'none' tier
   * path; 'title' and 'per_chunk_synopsis' always supply a hash).
   */
  updatePageContextualRetrievalState(
    slug: string,
    sourceId: string,
    mode: string,
    corpusGeneration: string | null,
  ): Promise<void>;

  /**
   * v0.35.5 — lossless DB-side migration of fact rows from one slug to
   * another within a single source. UPDATEs `entity_slug` and
   * `source_markdown_slug` on every active fact row keyed on the phantom
   * slug, and offsets `row_num` past the canonical page's current
   * MAX(row_num) — all rows incl. expired, since partial idx_facts_fence_key
   * only excludes NULL — so overlapping fence rows never collide (#4558);
   * NULL row_num stays NULL. Every other column is preserved verbatim.
   *
   * Idempotent: re-run after success finds no rows to update and returns
   * `{migrated: 0}`. Hard-deletes are out of scope; the caller wipes the
   * phantom's `.md` file separately. Scoped to one source by design —
   * cross-source migration is a separate concern.
   */
  migrateFactsToCanonical(
    phantomSlug: string,
    canonicalSlug: string,
    sourceId: string,
  ): Promise<{ migrated: number }>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
  /**
   * v0.32.3 — delete a config row. Returns the number of rows deleted (0 or 1).
   * No-op when the key doesn't exist. Used by `gbrain config unset` and by
   * `gbrain search modes --reset`. Engine-agnostic.
   */
  unsetConfig(key: string): Promise<number>;
  /**
   * v0.32.3 — list config keys matching a literal prefix (e.g. "search.").
   * Used by `gbrain config unset --pattern` and the search-modes --reset path.
   * Does NOT support glob/regex on purpose — the caller knows the prefix.
   */
  listConfigKeys(prefix: string): Promise<string[]>;
  /**
   * Read the whole config table in one round trip, as a key -> value map.
   *
   * `loadConfigWithEngine()` needs ~44 config keys on every connect. Read one
   * key at a time that is 44 round trips, which costs nothing on PGLite and
   * dominates the wall clock on a hosted Postgres: `gbrain stats` against a
   * Supabase brain spent seconds on reads the server answered in under 3ms
   * total. The config table is a handful of rows, so fetching all of it is
   * cheaper than fetching any meaningful subset of it.
   *
   * Callers that need a single key still use getConfig(). This is for the
   * bulk-read path only.
   */
  getAllConfig(): Promise<Record<string, string>>;

  /**
   * The stored `{ key, value }` rows for the named config keys in one read, ordered by key; a key with no row is
   * absent. Reads the table itself, not the request config snapshot (`getConfig` / `getAllConfig` honor that).
   */
  getConfigValues(keys: readonly string[]): Promise<Array<{ key: string; value: string }>>;
  /**
   * One config key's stored value (null without a row), never from the request snapshot: inside `transaction()` on its
   * connection, so a value read twice in one transaction is the same (persistence/sync-admission.ts readSyncAdmission);
   * outside one, under a preparer's read deadline, it ends there as the raw statement did (bounded-reads.ts).
   */
  readStoredConfigValue(key: string): Promise<string | null>;

  /**
   * The `enabled` value of every `persistence_brain` singleton row, as stored (a healthy brain has exactly one boolean).
   * Callers decide what a malformed answer means; the direct-write guard refuses it (persistence/managed-mode.ts).
   */
  readManagedModeRows(): Promise<Array<{ enabled: unknown }>>;
















































  // Migration support
  runMigration(version: number, sql: string): Promise<void>;
  // Deliberately scalar-only (no sourceIds[] widening): engine-internal with
  // zero remote-reachable callers (verified #2555 review), so the federated
  // read-scope contract doesn't apply. Widen only if an op ever exposes it.
  /** Raw preservation tools may include unverified chunks; retrieval leaves this false. */
  getChunksWithEmbeddings(slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }): Promise<Chunk[]>;

  // Raw SQL (for Minions job queue and other internal modules)
  /**
   * v0.41.18.0 (A20, codex #7): optional 3rd-arg `opts.signal` lets callers
   * actually cancel a running query. Init nudge (3s wallclock cap) wires an
   * AbortController whose timer fires at 3s; queries that haven't returned
   * by then get cancelled (Postgres: query.cancel(); PGLite: in-process,
   * Promise.race against signal-rejection — documented gap because PGLite
   * has no kernel-level cancellation).
   *
   * #6278: `opts.timeoutMs` runs an autocommit statement under a
   * transaction-local `statement_timeout` of that many milliseconds (Postgres:
   * a reserved connection runs `BEGIN; SET LOCAL statement_timeout`, the
   * statement and `COMMIT` as one pipelined round trip, so the bound holds
   * through a transaction-mode pooler that drops the session's startup
   * parameters; a statement past it fails with SQLSTATE 57014). Inside a
   * transaction the option is ignored (a `SET LOCAL` there would change the
   * enclosing transaction). PGLite ignores it: one in-process connection has
   * no other session to wait on. `deadlineAt` (#6696, epoch ms) recomputes the bound after the pool wait.
   * `jitOff` runs it with `jit = off` when the server has JIT on (postgres-engine/jit-off-statement.ts; PGLite ignores it); `prepare: false` plans it for its actual parameters on every call.
   */
  executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number; jitOff?: boolean; prepare?: boolean },
  ): Promise<T[]>;

  /**
   * Like `executeRaw`, but routes through the DIRECT (session-mode) pool when
   * dual-pool is active (Supabase: port 5432), falling back to the read pool
   * otherwise. Use this for the Minion lock hot-path (`claim`/`renewLock`):
   * those statements heartbeat a lock over many seconds, and the
   * transaction-mode pooler (port 6543) recycles connections per-transaction,
   * which surfaces as `CONNECTION_ENDED` mid-heartbeat → orphaned locks →
   * silent worker wedge. The direct session pool holds the connection open for
   * the life of the worker, so heartbeats survive. Single-statement UPDATEs
   * only — same idempotency contract as `executeRaw`. On PGLite (no pooler)
   * this is identical to `executeRaw`.
   */
  executeRawDirect<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]>;

  /**
   * Runs `read` in one unscoped read transaction under the keyword statement bound
   * (`search.keyword_statement_timeout_ms`, transaction-local): a search-time read outside the engine's own keyword
   * statements that must not wait on a lock without a bound (the segmented-region read with its chunk-manifest probe
   * through `db`). A statement past the bound fails with 57014. PGLite runs `read` on the engine itself and sets
   * no statement timeout, as for its keyword statements.
   */
  keywordBoundedRead<T>(read: (db: Pick<BrainEngine, 'executeRaw'>) => Promise<T>): Promise<T>;

  /**
   * The segmented-region read of search dedup (`segmentRegions`, search/dedup.ts) for an engine with no SQL dialect:
   * `[{ chunk_id, byte_start }]`, one row per hit chunk of a served segmented page whose occurrence has a live
   * manifest offset (the rows the SQL engines' statement under keywordBoundedRead returns). Each hit names the page
   * the search returned it on. Only the Rust engine defines it; the SQL engines run the statement through
   * keywordBoundedRead.
   */
  readSegmentRegions?(hits: ReadonlyArray<{ pageId: number; chunkId: number }>): Promise<Array<{ chunk_id: number; byte_start: number }>>;

  // ============================================================
  // Cycle locks: TTL lease rows in `gbrain_cycle_locks` (db-lock.ts owns the policy)
  // ============================================================
  /**
   * Take the lease `lockId`: insert a free row, or steal an expired one whose holder has not refreshed it within
   * `stealGraceSeconds` (a starved-but-alive holder keeps it, #1794). The caller supplies the holder identity and the
   * `acquisitionToken` UUID that fences every later call. Returns the row's id and an epoch-text `fence` for
   * diagnostics (never compared), or null when the lease is held and unexpired. Timestamps are the database's `NOW()`.
   * On Postgres a successful acquire also notes a direct-pool lease (direct-pool-profile.ts).
   */
  acquireCycleLock(lockId: string, opts: {
    holderPid: number;
    holderHost: string;
    acquisitionToken: string;
    ttlMinutes: number;
    stealGraceSeconds: number;
  }): Promise<{ id: string; fence: string } | null>;

  /**
   * Renew the lease: push `ttl_expires_at` out by `ttlMinutes` and stamp `last_refreshed_at`, only when the row still
   * carries this holder pid and token. Returns false when the lease is gone or was taken over (the holder lost it).
   * Postgres routes it to the direct session pool and cancels the statement when `signal` aborts; PGLite runs it on
   * its database and never forwarded the signal.
   */
  refreshCycleLock(lockId: string, opts: {
    holderPid: number;
    acquisitionToken: string;
    ttlMinutes: number;
  }, queryOpts?: { signal?: AbortSignal }): Promise<boolean>;

  /** Release the lease: delete the row only when pid and token still match. Returns whether a row was deleted (false: already released or taken over). */
  releaseCycleLock(lockId: string, opts: { holderPid: number; acquisitionToken: string }): Promise<boolean>;

  /** Read lease rows (see `CycleLockFilter`). A read: no side effects, no acquire. */
  readCycleLocks(filter: CycleLockFilter): Promise<CycleLockRow[]>;
  /** The beacon of the drain-lease holder record carrying `lockToken`, or null (engine-sql/cycle-locks.ts). */
  readDrainLeaseBeacon(lockToken: string): Promise<Record<string, unknown> | null>;
  /** Writes a drain lease's holder record, replacing the source's former one, in one statement (engine-sql/cycle-locks.ts). */
  writeDrainLeaseHolder(record: DrainLeaseHolderRecord): Promise<void>;
  /** Renews the drain-lease holder record carrying `lockToken` by `ttlMinutes` (engine-sql/cycle-locks.ts). */
  refreshDrainLeaseHolder(lockToken: string, ttlMinutes: number): Promise<void>;
  /** Deletes the drain-lease holder record carrying `lockToken` (engine-sql/cycle-locks.ts). */
  releaseDrainLeaseHolder(lockToken: string): Promise<void>;

  /**
   * Snapshot-matched delete (`gbrain sync --break-lock`, the dead-holder reaper, takeover): one DELETE matching the
   * observed id, pid and token, so a reused pid or a fresh holder is never removed. True when it deleted the row.
   */
  deleteCycleLock(lockId: string, opts: { holderPid: number; acquisitionToken: string }): Promise<boolean>;

  /**
   * Age-gated delete (`gbrain sync --break-lock --max-age`): as `deleteCycleLock`, but only when the row's
   * `last_refreshed_at` is older than `maxAgeSeconds` (a wedged-but-alive holder). Returns the deleted row's
   * `last_refreshed_at` so the caller can report the stale age.
   */
  deleteCycleLockIfStale(lockId: string, opts: {
    holderPid: number;
    acquisitionToken: string;
    maxAgeSeconds: number;
  }): Promise<{ deleted: boolean; lastRefreshedAt: Date | null }>;

  /**
   * Page embedding leases (`embed-page:<page id>`, page-embedding-lease.ts owns the policy). Take: insert the row, or
   * take over an expired one (no steal grace); false while another holder's unexpired row stands. Renew: push the
   * expiry out when the row still carries `acquisitionToken`, false when the lease was lost; a holder renews inside its
   * install transaction. Release: delete this holder's row and every expired `embed-page:` row. Database clock.
   */
  takePageEmbeddingLease(leaseId: string, opts: { holderPid: number; holderHost: string; acquisitionToken: string; ttlMinutes: number }): Promise<boolean>;
  renewPageEmbeddingLease(leaseId: string, opts: { acquisitionToken: string; ttlMinutes: number }): Promise<boolean>;
  releasePageEmbeddingLease(leaseId: string, opts: { acquisitionToken: string }): Promise<void>;
  /** The chunk indexes of a page's live rows with no vector in `column` (engine-sql/page-spend.ts; `embedStalePages`). */
  listVectorlessChunkIndexes(pageId: number, column: string): Promise<number[]>;

  /**
   * The lease fence: true when `lockId` is still held under `acquisitionToken` and unexpired. Inside a transaction it
   * holds the row `FOR KEY SHARE` until commit, so the holder's renewal passes and a takeover or delete waits.
   */
  assertCycleLease(lockId: string, acquisitionToken: string): Promise<boolean>;













  // ============================================================
  // v0.20.0 Cathedral II: code edges (Layer 5 populates, Layer 7 consumes)
  // ============================================================
  /**
   * Bulk-insert code edges. Resolved edges (to_chunk_id set) land in
   * code_edges_chunk; unresolved refs (to_chunk_id null, to_symbol_qualified
   * set) land in code_edges_symbol. ON CONFLICT DO NOTHING handles idempotency.
   * Returns count of rows actually inserted.
   */
  addCodeEdges(edges: CodeEdgeInput[]): Promise<number>;

  /**
   * Delete all code edges involving these chunk IDs, in BOTH directions, across
   * both code_edges_chunk and code_edges_symbol. Called by importCodeFile on
   * per-chunk invalidation (codex SP-2): when a chunk's text changed, stale
   * inbound edges from other pages pointing at the old symbol must wipe before
   * new edges write.
   */
  deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void>;

  /**
   * Delete the edges that LEAVE these chunks from both tables and clear their `edges_backfilled_at`, keeping the edges
   * other chunks hold that point AT them (`installCodeChunkEdges`; engine-sql/code-edges.ts).
   */
  clearCodeEdgesLeavingChunks(chunkIds: number[]): Promise<void>;

  /**
   * "Who calls this symbol?" Returns UNION of code_edges_chunk +
   * code_edges_symbol matching `to_symbol_qualified = qualifiedName`.
   * Source scoping (codex SP-3): if opts.sourceId is set, filter by the
   * anchor chunk's source; if opts.allSources, ignore scoping.
   */
  getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; chunkId?: number },
  ): Promise<CodeEdgeResult[]>;

  /**
   * "What does this symbol call?" Edges from chunks whose from_symbol_qualified
   * = qualifiedName; same source scoping as getCallersOf. opts.bareFallback (#4670):
   * zero-row miss + delimiter-free input re-keys on content_chunks.symbol_name.
   */
  getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; bareFallback?: boolean; chunkId?: number },
  ): Promise<CodeEdgeResult[]>;

  /**
   * All edges touching a chunk in the given direction. Used by A2 two-pass
   * retrieval to expand from anchor chunks. direction='in' returns edges
   * pointing AT the chunk; 'out' returns edges FROM it; 'both' unions.
   */
  getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<CodeEdgeResult[]>;
  // jobs-tables group D: the code_traversal_cache table.
  /** The memoised traversal at the key and generation, or null (code_blast and code_flow). */
  getCodeTraversalCache(key: CodeTraversalCacheKey): Promise<CodeTraversalCacheRow | null>;
  /** Upsert a memoised traversal on (symbol, depth, source); the response is stored as JSON. */
  putCodeTraversalCache(key: CodeTraversalCacheKey, response: unknown, maxChunkUpdatedAt: string, xminMax: number): Promise<void>;
  /** Delete one source's cached traversals, or all of them; returns the number deleted. */
  clearCodeTraversalCache(opts: CodeTraversalCacheClear): Promise<number>;

  /**
   * Chunk-grain keyword search. Ranks by content_chunks.search_vector
   * without the dedup-to-page pass that searchKeyword applies. Consumed
   * by A2 two-pass retrieval as its anchor source. Most callers should
   * prefer searchKeyword (external contract: page-grain best-chunk-per-page).
   */
  searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]>;

  // Eval capture (v0.25.0 — BrainBench-Real substrate).
  // Captured at the op-layer wrapper in src/core/operations.ts; reads via
  // `gbrain eval export` (NDJSON) for sibling gbrain-evals consumption.
  // Adding these to BrainEngine is a breaking-interface change for third-
  // party engine implementers — this is why v0.25.0 is a minor bump.
  /** Insert a captured candidate. Returns the new row id. Best-effort: callers swallow failures and route them through `logEvalCaptureFailure`. */
  logEvalCandidate(input: EvalCandidateInput): Promise<number>;
  /** Read candidates by time window / limit / tool filter. Used by `gbrain eval export`. */
  listEvalCandidates(filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]>;
  /** Delete candidates created before `date`. Returns rows deleted. Used by `gbrain eval prune`. */
  deleteEvalCandidatesBefore(date: Date): Promise<number>;
  /** Log a capture failure so `gbrain doctor` can surface drops cross-process. Best-effort; symmetric with logEvalCandidate (failure-of-failure is lost). */
  logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void>;
  /** Read capture failures within an optional time window. Used by `gbrain doctor`. */
  listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]>;

  // ============================================================
  // v0.29 — Salience + Anomaly Detection
  // ============================================================
  // The brain surfaces what's unusual and emotionally charged without being
  // asked. Cost: ~zero at query time (deterministic SQL), with backfill done
  // during the new `recompute_emotional_weight` cycle phase.

  /**
   * Batch-load tag + take inputs for the emotional-weight formula. One CTE-shaped
   * query: `pages` LEFT JOIN aggregated `tags` and aggregated `takes` (each
   * pre-aggregated in its own CTE so the page × N tags × M takes cartesian
   * product is avoided).
   *
   * If `slugs` is undefined, returns inputs for every page in the brain
   * (full-mode backfill). If provided, returns only matching slugs (incremental
   * recompute after sync / synthesize touched specific pages).
   *
   * Multi-source-aware: each row carries its `source_id` so the matching
   * `setEmotionalWeightBatch` UPDATE can composite-key correctly.
   */
  batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]>;

  /**
   * Apply pre-computed emotional weights in a single UPDATE. Composite-keyed
   * on `(slug, source_id)` because `pages.slug` is only unique within a
   * source — a slug-only UPDATE would fan out across sources, the same bug
   * that the v0.18.0 link batches fixed for cross-source edges.
   *
   * Rewrites ONLY rows whose stored weight differs (`IS DISTINCT FROM`, #4797) —
   * returns rows CHANGED; missing `(slug, source_id)` tuples are skipped.
   */
  setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number>;

  /**
   * Salience query: pages recently touched, ranked by a deterministic
   * `(emotional_weight * 5) + ln(1 + take_count) + recency_decay` score.
   *
   * The handler computes the time boundary in JS (`now - days * 86400000`)
   * and binds it as TIMESTAMPTZ so the SQL is identical across PGLite +
   * Postgres (eng review D5 — avoids dialect drift on `interval` binding).
   */
  getRecentSalience(opts: SalienceOpts): Promise<SalienceResult[]>;

  /**
   * v0.41.39 (issue #1700) — enrich candidate selection for
   * `gbrain enrich --thin`. ONE source-aware SQL query: thin-filter +
   * per-page inbound-link count (source-correct via `to_page_id = p.id`,
   * `link_source='mentions'` excluded) + optional `enriched_at` recency
   * guard + whitelisted ORDER BY (ENRICH_ORDER_SQL) + LIMIT. Returns a
   * lightweight projection (NO page bodies) so ranking 100K stubs doesn't
   * pull every body into memory.
   *
   * Empty `opts.types` → empty result, no SQL. Source scope follows the
   * canonical scalar/array precedence (sourceIds wins over sourceId).
   */
  listEnrichCandidates(opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]>;

  /**
   * Anomaly detection: cohorts (tag, type) with unusually-high page activity
   * on a target day vs baseline mean+stddev over the previous N days. Year
   * cohort is deferred to v0.30 (slug-regex year extraction is fragile).
   *
   * Baseline densifies the day series via `generate_series` zero-fill so
   * sparse-day rare cohorts don't look "normally active" — a sparse-day cohort
   * with one touch in 30 days has a low baseline mean and high sigma at 7 touches,
   * not a misleading mean of 1.
   */
  findAnomalies(opts: AnomaliesOpts): Promise<AnomalyResult[]>;








}
