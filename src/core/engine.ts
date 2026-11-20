import type { ExportPageKey, ExportPageKeyQuery, ExportPageRow, ExportWithdrawalRow, NormalizedFenceLines, SegmentedPageHead, BodyManifestRow, BodyManifestMeta, BodyManifestOutline } from './engine-sql/export-reads.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import type * as DecideStoreSql from './engine-sql/decide-store.ts';
import type * as TrustWithdrawalsSql from './engine-sql/trust-withdrawals.ts';
import type * as OpenLoopsSql from './engine-sql/open-loops.ts';
import type * as DerivationTrustSql from './engine-sql/derivation-trust.ts';
import type * as ChronicleEventsSql from './engine-sql/chronicle-events.ts';
import type * as CalibrationProfilesSql from './engine-sql/calibration-profiles.ts';
import type { WriteContextInput, WriteContextResult } from './engine-sql/transaction-settings.ts';
import type { RecentWriterVersionRow, WriterVersionRow } from './engine-sql/writer-versions.ts';
import type * as EntityIdentitiesSql from './engine-sql/entity-identities.ts';
import type * as AccessGrantsSql from './engine-sql/access-grants.ts';
import type * as AccessMembersSql from './engine-sql/access-members.ts';
import type * as SharedSkillMembersSql from './engine-sql/shared-skill-members.ts';
import type { StoredSkillRevision } from './shared-skills/model.ts';
import type { ListLoopsOpts as OpenLoopListOpts, LoopStatus as OpenLoopStatus, OpenLoopUpsert as OpenLoopUpsertInput } from './loops/loops-store.ts';
import type * as TrustWriteGateSql from './engine-sql/trust-write-gate.ts';
import type * as JobsWake from './engine-sql/jobs-wake.ts';
import type { OauthClientGrantPersist, OauthGrantAuditRow } from './engine-sql/client-grants.ts';
import type { OauthGrantAuditInsert } from './engine-sql/oauth-revocation.ts';
import type { AccessTokenGrantWrite, AccessTokenListRow, AccessTokenPrivateAxis, ActiveTokenGrantField, ActiveTokenTarget, DeletedOAuthClient, LegacyTokenGrantColumns, OauthClientGrantInsert, OauthClientProbe, OauthTokenInsert, OauthTokenRung, ScopeSourceLock, TokenByHashCaller, OauthCodeInsert, OauthCodeRow, OauthTokenRow } from './engine-sql/access-credentials.ts';
import type { ExactScanOpts, ExactBatchRow } from './search/exact-scan.ts';
import type { ExactIdentityStatementOpts, ExactIdentityRow } from './engine-sql/exact-identity.ts';
import type { RankCoverageStatementOpts, RankEntitiesStatementOpts, RankEntityRow } from './engine-sql/graph-rank.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessGroupRow, AccessMemberLookup, PageNamingReaderRow, AccessMemberRow, LiveMemberRow, MemberBindingVia, AppliedPolicyRevision, AudiencePrincipalRows, FolderAccessRows, MayActForVia, JobPrincipalKind, LiveMemberVia } from './engine-sql/access-control.ts';
import type { AccessCoverageRow, AccessPolicyMarks, AccessRestampWindow, AccessRevisionInsert, AccessRevisionQuery, AccessRevisionRow, AccessRuleChanges, AccessRuleRow } from './engine-sql/access-policy.ts';
import type { AccessMigrationRow, LiveAccessTokenRow, MemberKeyReadingRow, OpenPageCount, OpenPageExclusion, PeopleFolderCount } from './engine-sql/access-setup.ts';
import type { FactsFencePagesQuery, SweepPageRefRow, SweepDeferredPageRow, SweepDeferredPagesQuery, SweepStalePageRow, SweepStalePagesQuery } from './engine-sql/sweep-reads.ts';
import type { DeltaSessionRow, SessionCursorRow, SessionStateWrite } from './engine-sql/session-state.ts';
import type { ExactRescanChunkRow, ExactSnippetChunkRow, ExactSnippetKey, ExtractionPendingRow, FenceOverlayIncomingRow, FenceOverlayRow, HeldFenceCellKey, HeldFenceCellRow, RankCoverageRow, UnattributedFactRow, WantedPageRow } from './engine-sql/cli-reads-ops.ts';
import type * as FactsDoctorSql from './engine-sql/facts-doctor.ts';
import type * as EmbeddingCatalogSql from './engine-sql/embedding-catalog.ts';
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
import type { FactRelinkAttempt, FactRelinkOutcome, FactRelinkUpsertOpts } from './engine-sql/fact-relink-attempts.ts';
import type { ConversationFactLink, ConversationRelinkPagesQuery, RelinkPlacement } from './engine-sql/fact-relink-writes.ts';
import type * as DreamCycleSql from './engine-sql/dream-cycle.ts';
import type * as FactsCycleSql from './engine-sql/facts-cycle.ts';
import type * as FactsPurgeSql from './engine-sql/facts-purge.ts';
import type * as FactsRepairSql from './engine-sql/facts-repair.ts';
import type * as FilesOpsSql from './engine-sql/files-ops.ts';
import type * as ContradictionsCycleSql from './engine-sql/contradictions-cycle.ts';
import type * as OntologyRepairSql from './engine-sql/ontology-repair.ts';
import type * as AdminReadsSql from './engine-sql/admin-reads.ts';
import type * as FactsRecallSql from './engine-sql/facts-recall.ts';
import type * as FactsTrustSql from './engine-sql/facts-trust.ts';
import type * as FactsConversationSql from './engine-sql/facts-conversation.ts';
import type { EngineCapabilities } from './engine-capabilities.ts';
import type { GitHoldRecordsQuery, GitHoldReportInputs } from './engine-sql/sync-hold-reads.ts';
import type { GitHoldSummaryWeights, SyncPassRowRead, SyncPassRowWrite } from './engine-sql/sync-hold-store.ts';
import type { SourceCheckoutRoot, UnembeddedPageSummary, WriteWatermarkRow } from './engine-sql/applied-watermark-reads.ts';
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
import type { LocalWriterInsert, LocalWriterRow } from './engine-sql/persistence-state.ts';
import type { DurablePersistenceSettings } from './engine-sql/persistence-declaration.ts';
import type { DrainLeaseHolderRecord } from './engine-sql/cycle-locks.ts';
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, DrainHolderProgressRow, HeldCoverageRow, OAuthClientWriteGrant, OutstandingBySource, PublicationEffectsSpec, WithdrawalEffectsSpec, WriteCancellation, WriteCancelResult, WriteCompletion, WriteRequestInsert, WriteRequestListFilter, WriteRequestProgress } from './engine-sql/persistence-journal.ts';
import type { ClaimExpiry, ClaimHeadSpec, ClaimRelease, ClaimRenewal, ConsumerProbe, ConsumerRenewal, ConsumerRowKey, ConsumerRowRead, SourceMembership, TopologyChange, TopologyChangeInsert } from './engine-sql/persistence-claims.ts';
import type { GatedMirrorRequest, RequestEffectState } from './engine-sql/persistence-effect-scans.ts';
import type { EffectClaim, EffectClaimRef, EffectWorktreeOwner, MirrorGateRow } from './engine-sql/persistence-effect-worker.ts';
import type { IdleProbeRow, IdleProbeSpec } from './engine-sql/persistence-idle-probe.ts';
import type { OverdueHold, OverdueHoldKind } from './engine-sql/persistence-owner-scans.ts';
import type { CapacityForecastInputs, HousekeepingTurnClaim, PendingSegmentedProjection, ProjectionWindowRow, ReceiptBudget, SegmentedProjectionFilter, TrueUpReservation, ProjectionJobRef, ProjectionPageRef, SegmentedProjectionClaimOutcome } from './engine-sql/persistence-housekeeping.ts';
import type { NoopSettleCandidate, NoopSettleCandidateSpec, NoopSettledRow, NoopSettleWindow } from './engine-sql/persistence-embedding-noop-settle.ts';
import type { ProjectionScanCursor } from './page-state/projection-window.ts';
import type { WriteRequest } from './persistence/model.ts';
import type { CanonicalTimelineRow, TimelineDetailRefresh, TimelineRowRemoval } from './engine-sql/timeline.ts';
import type { TakeFenceRow } from './engine-sql/takes.ts';
import type { CodeTraversalCacheClear, CodeTraversalCacheKey, CodeTraversalCacheRow } from './engine-sql/code-traversal-cache.ts';
import type { FactPreimage, FenceProjectionTarget } from './engine-sql/facts.ts';
import type { FenceFactRow, FenceRowsTarget, GuardedTakeRow, GuardedTakeRowsQuery, HeldRowsQuery, PageTrustRestore } from './engine-sql/trust-fence.ts';
import type { FenceHoldFileRow, FenceHoldKey, FenceHoldRow } from './engine-sql/fence-holds.ts';
import type { GenerationActivationRow, GenerationAttemptCount, GenerationLedgerRow, GenerationRowKey, GenerationValveRow, HeldGenerationRow, HeldInputRow, LiveGenerationRow } from './engine-sql/derived-generations.ts';
import type { LedgerScrubCounts } from './engine-sql/generation-ledger.ts';
import type { GenerationActivationRecord, GenerationActivationState, GenerationOrphanRow, PendingGenerationMemberRow } from './engine-sql/generation-activations.ts';
import type { GenerationRepairFilter, GenerationRepairItemRow, HeldGenerationListRow, HeldGenerationProposalRow, RestorableGenerationRow, SourceIncarnationListRow,
  UnmatchedGenerationRow } from './engine-sql/generation-repair.ts';
import type { FenceVersionBodyRow } from './engine-sql/generation-fence-evidence.ts';
import type { GenerationPageRow, GenerationPageRowsQuery } from './engine-sql/generation-page-rows.ts';
import type { AtomOriginInputRow, AtomWriteReceiptRow, GenerationVersionProducer, ProducerVersionRow } from './engine-sql/generation-atom-reads.ts';
import type { GenerationFenceBlockRow, GenerationOwnedItemRow } from './engine-sql/generation-fence-restore.ts';
import type { PageBodySizes } from './engine-sql/large-page.ts';
import type { TrustTable } from './trust/schema.ts';
import type { NewTrustProposal, PendingContradictionFilter, PendingContradictionRow, TrustProposalFilter, TrustProposalRow, TrustProposalStatus, TrustProposalTransition } from './engine-sql/trust-proposals.ts';
import type { GraduationGateRow, ManagedRootBindingRow, PersistenceTable, RetiredDeactivationRow } from './engine-sql/connect-gate.ts';
import type { ImportedPageSeal, InlinePageRegionsRow, LivePageBodyRow, OriginClaimRow, PageIndexingState, PageIngestStamp, PageOriginRow, PageOriginTarget } from './engine-sql/write-guards.ts';
import type { PageEmbeddingBudgetRow, PageEmbeddingReservation, PageEmbeddingReserveInput } from './engine-sql/page-embedding-budget.ts';
import type { EmbeddingCompletionOpts, EmbeddingCompletionRow } from './engine-sql/embedding-install.ts';
import type { CallerPageAccessRow, PagePolicyPart, WriteVisibilityProbe } from './engine-sql/page-visibility.ts';
import type { LedgerSource } from './engine-sql/belief.ts';
import type { EntityCardMatch, EntityCardRow, ExtractionLagCounts, ExtractionLagQuery, IgnoredLabelPageRow, InboundLinkerCountRow, LivePageTypeRow, MentionDueQuery, MentionIndexRecount, MentionIndexStatusRow, NameVariantCandidateQuery, NameVariantCandidateRow, PrefixCandidateQuery, PrefixCandidateRow, PrefixTitleRow, ResolverPrivacy, RetirementHopRow, RetirementPrivacy, SiblingCandidateQuery, SiblingCandidateRow, SlugPatternPageRow, TrigramCandidateQuery, TrigramCandidateRow, FuzzyEntityCandidateRow } from './engine-sql/entity-reads.ts';
import type { PageRefRow, RelationalPageRow } from './engine-sql/relational-reads.ts';
import type { DefaultSourceSplit, LiveIdentityHolderRow, LocalPathSourceRow, PlainSyncSourceRow, RenameIdentityRow, SourceCheckRow, SourceInsert, SourceUpstreamObservation, PageIdentityRow, PageSizeRow, ReasonPurgeTombstone, SourcePathPageRow, SourceRoutingRow } from './engine-sql/sources.ts';
import type {
  Coverage as NotifierCoverage, MarkerIntent, NotifierHostSourceRow, NotifierLeaseClaim, NotifierLeaseClaimInput, NotifierLeaseHolder, NotifierSourceRow, NotifierStatusRow,
  NotifierFirstDueRow, PendingWantedMarker, SourceSyncShapeRow, StatePatch as NotifierStatePatch, WantedMarker, WantedMarkerInput,
} from './engine-sql/notifier.ts';
import type {
  AdmissionSourceRow, AttachSourcePathOptions, PendingProposalRow, ProposalListQuery, SharedSkillPackRoot, SourceStateOptions, SourceStateRow, WorktreeBinding,
} from './engine-sql/write-misc.ts';
import type {
  ActorAttributionRow, PageRevisionAttributionRow, RowAttributionRow, RowAttributionTarget, VersionAttributionRow, VersionRef,
  WriteAttributionNameIds, WriteAttributionNames,
} from './engine-sql/write-attribution.ts';
import type { AdmitJobPolicy, AdmitJobResult, AdmitJobSpec, ClaimJobSpec, JobRow, ListJobsFilter } from './engine-sql/jobs.ts';
import type { JobInsightRows, JobInsightSpec } from './engine-sql/jobs-insight.ts';
import type {
  ExpireSpendScope, JobSpendTreeSpec, LeasePressureFilter, LeasePressureInsert, LeasePressureRow, SettleSpendOutcome, SpendReservationInsert, SpendTreeRow,
} from './engine-sql/jobs-spend.ts';
import type {
  AgentClientSpendRow, ClientReserveOutcome, ClientReserveSpec, GroupReserveOutcome, GroupReserveSpec, GroupSpendRow, OauthClientInsert,
  SettleLogOutcome, SpendLogInsert,
} from './engine-sql/spend-log.ts';
import type { OauthClientPatch, OauthClientPatchGuard, OauthClientPatched, OauthClientRow } from './engine-sql/oauth-clients.ts';
import type { AccessTokenInsert, ActiveAccessTokenRow } from './engine-sql/access-tokens.ts';
import type { HeldFenceTakeRow, HeldFenceTakeSpec, McpResolvedSpec, PurgeTakesSpec, TakePreimage, TakePreimageRead, TakeTrustRef, AbandonedTakeRow, HolderResolvedTakeRow, PageTierRef, TakesLeavingFence } from './engine-sql/takes-reads.ts';
import type {
  BeliefHistoryRowQuery, CorePageRow, CorePageRowSpec, TrustScanRow, TrustScanRowSpec, UnscannedTrustSpec, ValidTimeIdentityRow,
  ValidTimeIdentitySpec, ValidTimePickSpec, AmendmentsNotAppliedSpec, AmendmentNotAppliedRow, PageVersionEditionRow, CursorEditionRow, PageIdRef,
  TrustScanTable,
} from './engine-sql/trust-tier-reads.ts';
import type {
  CancelJobsSpec, DelayActiveJobSpec, JobAttachmentInsert, JobPageSpec, JobStatsRead, JobTokenCounts, PrivateQueueState, PruneJobsSpec,
  SynthesisCompletion, SynthesisCompletionPrefix, JobSourceState,
  QueueFamilyRow, RetryJobPolicy,
} from './engine-sql/jobs-queue.ts';
import type {
  PrivateQueueHealthRow, QueueDivergence, QueueDivergenceSpec, QueueHealthSignals, QueueHealthSpec, QueueWedgeRow, QueueWedgeSignals, WaitingByQueueRow,
} from './engine-sql/jobs-health.ts';
import type {
  BudgetOwnerRow, EmbedBackfillState, FailedJobError, JobStatusCount, JobStatusFilter, LastAutopilotCycles, QueueDepth, SourceJobCounts, TtlCancelledCount,
  WaitingScopeState,
} from './engine-sql/jobs-status.ts';
import type {
  DeadDreamSubmissionSpec, FactsAbsorbJobRow, FactsAbsorbStillDead, GlobalMaintenanceDeaths, LastFailedGlobalMaintenanceJob,
  LegacyJobAuthorityRead, QueuedSpendRows,
} from './engine-sql/jobs-checks.ts';
import type {
  SubagentFailureFallback, SubagentMessageInsert, SubagentMessageRow, SubagentOneshotLedgerRow, SubagentRetainedPutPage, SubagentToolInsert,
  SubagentToolOrder, SubagentToolRow, SubagentToolStart, SubagentToolTarget, SubagentWriteOutcome,
} from './engine-sql/jobs-subagent.ts';
import type { EntityInboundEdgeRow, JunkEntityHubRow, LinkContextAsk, LinkContextMatch, LinkContextOriginPage, LinkEndpointPage, LivePageSummary, TitledPage } from './engine-sql/link-reads.ts';
import type { CodeChunkScope, CodeDefinitionRow, CodeRefChunkRow, CodeSymbolQuery, ContextualModeCandidate, FrozenHitKey, FrozenHitRow, UnsealedPageScope, WithdrawalChunkKey, WithdrawalChunkRow } from './engine-sql/chunk-reads.ts';
import type { WithdrawalDiscoveryKind, WithdrawalDiscoveryRead, WithdrawalDiscoveryRows } from './engine-sql/withdrawal-discovery.ts';
import type { EffectiveDateFallbackRow, EffectiveDateSampleCounts, OwnTimelineRow, PageTimelineRow, SegmentedTimelinePages, TimelineOrphanPage, TimelineRowDeletion } from './engine-sql/timeline-reads.ts';
import type { CaseSensitiveAliasRow, EntityAliasRow, PageAliasRow, SlugAliasRow, TitleHitRow } from './engine-sql/alias-fanout-reads.ts';
import type { McpLifetimeUsageRow, McpRequestCountKind, McpRequestLogPage, McpRequestLogPageSpec, PendingWriteHealth, McpTokenRequestCount, McpLogPruneBatch, McpLogPruneCutoff, McpOpUsageRow, McpRequestLogRow, McpRollupPrunedBefore, SearchTelemetryBucket, SearchTelemetryRow } from './engine-sql/telemetry.ts';
import type { ChatUsageLogRow, ChatUsageWindow } from './engine-sql/chat-usage.ts';
import type { FieldUsageQuery, FieldUsageTypeSample } from './engine-sql/field-usage.ts';
import type * as LinkTemporalSql from './engine-sql/link-temporal.ts';
import type * as DecideProposalsSql from './engine-sql/decide-proposals.ts';
import type { RelationshipEvidence, RelationshipKey, RelationshipStateWrite } from './link-relationships.ts';
import type { CoverageRelevance, ProjectionRebuildProgress, ScopedCount } from './search/retrieval-coverage.ts';
import type { ProjectionReadinessRow, ProjectionReadinessScope } from './search/projection-readiness.ts';
import type { VectorBackfillOpts } from './search-vector-backfill.ts';
export type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions, PageMutationPrecondition, PageWithdrawal } from './page-state/types.ts';
import type {
  Page, PageInput, PageFilters, GetPageOpts, PageReadScope, PageReadPolicy,
  Chunk, ChunkInput, ChunkReuseRow, StaleChunkRow, StalePageRow, ChunklessPageRow,
  SearchResult, SearchOpts, ResolvedColumn,
  Link, GraphNode, GraphPath, RelationalFanoutRow, RelationalFanoutOpts, ChainHopOpts, ChainHopEdge,
  TimelineEntry, TimelineInput, TimelineOpts,
  ChronicleTimelineRow, ChronicleTimelineOpts, LastSeenResult,
  OntologyObservationInput, OntologyMergeResult, OntologyValue, OntologyDimensionStat,
  OntologyConflict, OntologyReadOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  CodeEdgeInput, CodeEdgeResult,
  EvalCandidate, EvalCandidateInput,
  EvalCaptureFailure, EvalCaptureFailureReason,
  SalienceOpts, SalienceResult, AnomaliesOpts, AnomalyResult,
  EmotionalWeightInputRow, EmotionalWeightWriteRow,
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow,
  AdjacencyRow,
  EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';

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
/** One page's trust fields; `byId` marks a row found by id, `flagged` an activation-suppressed page, `guest` a page in a guest source. */
export interface PageTrustRow { id: number; source_id: string; slug: string; trust_tier: string; write_origin: unknown; flagged: boolean; guest: boolean; byId: boolean }
/** `readRowTrustRows` input: a row table and the row ids to read. */
export interface RowTrustLookup { table: 'facts' | 'takes' | 'timeline_entries'; ids: readonly number[] }
/** One fact, take or timeline row's trust fields; `flagged` marks an activation-suppressed row, `contested` its first pending supersede proposal (`tp<id>:challenger|challenged`, never set on a timeline row). */
export interface RowTrustRow { id: number; trust_tier: string; write_origin: unknown; flagged: boolean; contested: string | null }
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
import type { BatchAuditSite } from './retry.ts';
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

import type { StaleTakeOpts, StaleTakeRow, TakeEmbeddingInput } from './takes-row-types.ts';
import type { BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState, ManifestRow, ManifestRowInput, SegmentChunkInput,
  SegmentedEmbedPage, SegmentedEmbedRef, SegmentedPageMeta, SegmentSweepOptions, SegmentSweepResult, SegmentTextInput } from './page-body/types.ts';
import type { SegmentDerivationInput, SegmentDerivationKind, SegmentDerivationRow } from './page-body/derivations.ts';
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

export interface BrainEngine {
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

  /** A live source as a sync request sees it (local path, managed checkout root, bound to a worktree), or null when it is missing or archived. notifier/nudge.ts sourceSyncShape. */
  readSourceSyncShape(sourceId: string): Promise<SourceSyncShapeRow | null>;

  /** Each existing source's persisted first-due clock: the earlier of its notifier row's first_due_at (not idle) and its oldest due freshness marker, with the observed head. sync-pending.ts readFirstDue. */
  readNotifierFirstDue(sourceIds: string[]): Promise<NotifierFirstDueRow[]>;
  /** The raw progress row of a drain lease's holder: managed commits since `since` (ISO), the last commit and save, through the source's writer binding; null when unbound (engine-sql/persistence-journal.ts). */
  readDrainHolderProgress(sourceId: string, since: string): Promise<DrainHolderProgressRow | null>;

  /** Source resolution reads (SQL and contracts in engine-sql/sources.ts): sources with a local path and `archived`; every source row with `default`'s emptiness flag; the default-write guard's page split. */
  listLocalPathSources(): Promise<LocalPathSourceRow[]>;
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
  /** Pages of one source, soft-deleted pages only with `includeDeleted`; an unknown source has none (engine-sql/sources.ts). */
  countSourcePages(sourceId: string, opts?: { includeDeleted?: boolean }): Promise<number>;
  /** Inserts one source row (id, name, local_path, config); a taken id or name throws and writes nothing. */
  insertSource(row: SourceInsert): Promise<void>;
  /** The live pages of one source (only `slugs` when given) a sync size-state read reports, by slug (engine-sql/sources.ts). */
  readPageSizeRows(sourceId: string, maxBytes: number, slugs: readonly string[] | null): Promise<PageSizeRow[]>;
  /** Sets the page's embedding hold to `held` with `reason` (engine-sql/sources.ts). */
  holdPageEmbedding(pageId: number, reason: string): Promise<void>;
  /** The source's purged change-reason pairs by commit then path, or only `pair` when stored (engine-sql/sources.ts). */
  readReasonPurgeTombstones(sourceId: string, pair?: ReasonPurgeTombstone): Promise<ReasonPurgeTombstone[]>;
  /** Adds one to the source's purge epoch and returns the new value as stored, or null for an unknown source (engine-sql/sources.ts). */
  advanceSourcePurgeEpoch(sourceId: string): Promise<string | number | null>;
  /** The live pages of one source that have a source_path, in no set order (engine-sql/sources.ts). */
  listSourcePathPages(sourceId: string): Promise<SourcePathPageRow[]>;
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
  /** Whether the source's current incarnation has a company-brain ingestion receipt. */
  hasCompanyBrainReceipt(sourceId: string): Promise<boolean>;
  /** The source's guest_sources row and whether row-level security hides guest_sources; throws the missing-table error on an old schema. */
  readGuestSourceRow(sourceId: string): Promise<GuestSourceLookupRow>;
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
  hasExtractedEvents(sourceId: string, pageId: number): Promise<boolean>;
  listActiveAccessMembers(): Promise<string[]>;
  /** Whether any access member, live or not, carries the labelled-only grant; a failed read throws (engine-sql/write-misc.ts). */
  hasLabelledOnlyMember(): Promise<boolean>;
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
  listOntologyFactCandidates(sourceIds: string[]): Promise<OntologyRepairSql.OntologyFactCandidateRow[]>;
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
  /** Insert or replace rows keyed (page, kind, occurrence) in bounded statements; a replaced row keeps created_at. */
  upsertSegmentDerivations(rows: readonly SegmentDerivationInput[]): Promise<void>;
  /** Delete a page's rows (every kind, or `kind`) whose occurrence is not in `liveOccurrenceIds`; returns the count. */
  retireSegmentDerivations(pageId: number, liveOccurrenceIds: readonly number[], opts?: { kind?: SegmentDerivationKind }): Promise<number>;

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
  /** The liveness round trip (`/health`, doctor's ops-tier connection check): resolves when the store answers. */
  pingStore(opts?: { signal?: AbortSignal }): Promise<void>;

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
  /** Locks each origin key (`opts.lockKeys`) until the transaction ends, then the live pages other than `excludePageId` recording one of `spellings`, by slug. */
  listOriginClaims(sourceId: string, spellings: readonly string[], opts: { lockKeys: readonly string[]; excludePageId?: number | null }): Promise<OriginClaimRow[]>;
  /** Records `sourcePath` as a page's origin (persistence/origin-guard.ts `bindOrigin` only); the number of pages whose origin changed. */
  bindPageOrigin(target: PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }): Promise<number>;
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
  /** For each (source_id, slug) that names a page row, whether a live row of it passes the current caller's policy; in no set order. */
  readCallerPageAccess(pages: readonly { source_id: string; slug: string }[], opts: { policy: PagePolicyPart }): Promise<CallerPageAccessRow[]>;
  /** The opening read of a remote page write's visibility check: labelled-only members, what a reader identity could open on the page the empty-identity policy hides, owner-only sources. */
  readWriteVisibilityProbe(sourceId: string, slug: string): Promise<WriteVisibilityProbe | undefined>;
  /** A stored writer's slug fence now (an OAuth client's bound prefixes, a local writer's grant ceiling), or null. */
  readWriterSlugFence(principal: { kind: string; id: string }): Promise<unknown>;
  /** A live page's stored body size (segmented `body_bytes`, else the UTF-8 bytes of its body columns), or null (engine-sql/large-page.ts). */
  readStoredBodyBytes(slug: string, sourceId: string): Promise<number | null>;
  // Relational recall arm page reads (engine-sql/relational-reads.ts).
  /** The refs naming a live, unquarantined page of an unarchived source that `policy` admits (`pageReadFilter` live); in no set order. */
  readAdmittedPageRefs(refs: readonly PageRefRow[], policy: PageReadPolicy): Promise<PageRefRow[]>;
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
   * The `enabled` value of every `persistence_brain` singleton row, as stored (a healthy brain has exactly one boolean).
   * Callers decide what a malformed answer means; the direct-write guard refuses it (persistence/managed-mode.ts).
   */
  readManagedModeRows(): Promise<Array<{ enabled: unknown }>>;

  // Read-command statements (engine-sql/cli-reads-ops.ts). Each runs the statement its op ran through executeRaw.
  /**
   * One exact-phrase scan batch: the next `batchPages` in-scope pages after `afterPageId`, in id order, with their
   * matches or the reason their text could not be read. Null when the phrase has no searchable word. Postgres runs it
   * with JIT off under a `timeoutMs` statement deadline; a timeout throws the statement-timeout error.
   */
  scanExactBatch(opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number): Promise<ExactBatchRow[] | null>;
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
  /** Unverified auto-extracted pages visible in scope (`sourceIds` wins over `sourceId`), newest first. */
  listExtractionPendingPages(opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }): Promise<ExtractionPendingRow[]>;
  /** Active facts with no entity in `sourceIds`, newest id first; `worldOnly` keeps world facts, `excludePrivateProvenance` drops private-provenance facts. */
  listUnattributedFacts(opts: { sourceIds: string[]; worldOnly: boolean; excludePrivateProvenance: boolean; limit: number; offset: number }): Promise<UnattributedFactRow[]>;
  /** Missing link targets in scope, most-referenced first, with their total; `excludePrivate` drops private origins and private bare-name matches. */
  listWantedPages(opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number }): Promise<{ total: number; rows: WantedPageRow[] }>;

  // Facts statements, doctor checks (engine-sql/facts-doctor.ts). Each runs the statement its caller ran through executeRaw.
  /** conversation_outcomes_stale: the newest unexpired extraction-outcome rows of `sourceIds`, newest id first, at most `limit`. */
  listConversationFactRows(sourceIds: string[], limit: number): Promise<FactsDoctorSql.ConversationFactRow[]>;
  /** facts_redaction_marker: active facts holding a redaction marker in live sources (only `sourceIds` when given). */
  countRedactedFacts(sourceIds?: string[]): Promise<number>;
  /** outside_content_fences: per imported page a third party wrote, its fence-indexed fact, take and link counts, by source id and slug. */
  listOutsideContentFenceCounts(): Promise<FactsDoctorSql.OutsideContentFenceRow[]>;
  /** facts_health: unexpired facts naming an `atoms/` page, in every source. */
  countAtomFacts(): Promise<number>;
  /** trust_release_unpreviewed_fields: current user_confirmed facts a trust release raised without previewing their fence fields, by id, at most `limit`, each with the total. */
  listUnpreviewedTrustFacts(limit: number): Promise<FactsDoctorSql.UnpreviewedTrustFactRow[]>;
  /** unlinked_facts: per source and origin, counts over each source's newest `windowPerSource` active facts; `hasAttempts` says the brain has `fact_relink_attempts`. */
  countUnlinkedFactsByOrigin(opts: { sourceIds: string[]; auditSources: string[]; windowPerSource: number; hasAttempts: boolean }): Promise<FactsDoctorSql.UnlinkedOriginRow[]>;
  /** unlinked_facts: the 7-day counts of active facts (unlinked share, relink judgments, inference tiers); null when no row comes back. */
  countUnlinkedFactStats(opts: { sourceIds: string[]; auditSources: string[]; hasAttempts: boolean }): Promise<FactsDoctorSql.UnlinkedFactStatsRow | null>;
  /** unlinked_facts: relink attempt outcomes (every no_subject, the linked ones of the last 7 days) by outcome and tier. */
  countFactRelinkOutcomes(sourceIds: string[]): Promise<FactsDoctorSql.FactRelinkOutcomeRow[]>;
  /** unlinked_facts: the pages holding the targeted unlinked conversation rows of one source, most rows first. */
  listUnlinkedConversationSlugs(opts: { sourceId: string; auditSources: string[]; windowPerSource: number; fix: FactsDoctorSql.ConversationFixKind; hasAttempts: boolean }): Promise<Array<{ slug: string }>>;
  /** fact_take_vectors: per source, the embeddable facts with no vector, with a vector not current for `model` and `dims` or the text, and the partially embedded ones. */
  countFactEmbeddingCoverage(opts: { sourceId?: string | null; model: string; dims: number }): Promise<FactsDoctorSql.FactEmbeddingCoverageRow[]>;
  /** The embeddable facts whose vector is not current for `model` and `dims` or the text, over every source or `sourceId`, with the sum of their lengths in characters. */
  countStaleFactEmbeddings(opts: { model: string; dims: number; sourceId?: string | null }): Promise<{ count: number; chars: number }>;
  /** fence_integrity: live markdown pages of these sources stored in segments with no checkout file walked; null when no row answers. */
  countSegmentedCensusPages(sourceIds: string[], checkedOutSourceIds: string[]): Promise<{ n: number } | null>;
  /** unlinked_facts: the `facts` and `fact_relink_attempts` table names the brain has (null for one it lacks). */
  readFactTableCatalog(): Promise<{ facts: string | null; attempts: string | null } | null>;

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
  /** Per source with chunks, the chunk count and how many hold a vector in a fixed column (`embedding_image`, `embedding_multimodal`), in source id order. */
  countChunkVectorCoverage(column: EmbeddingCatalogSql.FixedVectorColumn): Promise<EmbeddingCatalogSql.ChunkVectorCoverageRow[]>;
  /** doctor embedding_column_registry: the type of each named `content_chunks` column that exists (`vector(1024)`), in no set order. */
  readChunkColumnTypes(columns: string[]): Promise<EmbeddingCatalogSql.ChunkColumnType[]>;
  /** doctor embedding_column_registry: every `content_chunks` row and the percent holding a value in `column` (pct null with no row). Throws when the column is missing. */
  countChunkColumnCoverage(column: string): Promise<EmbeddingCatalogSql.ChunkColumnCoverage>;

  // Facts relink attempts (engine-sql/fact-relink-attempts.ts): the `fact_relink_attempts` writes and reads relink ran through executeRaw.
  /** Records a fact's latest relink attempt (`attempted_at` now), replacing its stored one; `keepModelAndRun` keeps the stored `model` and `run_id` on a conflict. */
  upsertFactRelinkAttempt(sourceId: string, attempt: FactRelinkAttempt, opts?: FactRelinkUpsertOpts): Promise<void>;
  /** The stored relink outcome of each of `factIds` in the source whose outcome is one of `outcomes`, by fact id. */
  listFactRelinkOutcomes(sourceId: string, factIds: number[], outcomes: string[]): Promise<FactRelinkOutcome[]>;
  /** Deletes the source's relink attempts of `tier` that name `targetSlug`. */
  deleteFactRelinkMemos(sourceId: string, tier: string, targetSlug: string): Promise<void>;

  // Facts relink writes (engine-sql/fact-relink-writes.ts): the guarded facts update statements relink ran through executeRaw.
  /** Places a pinned fact that still has no entity, page, row number or expiry (link onto `slug`'s fence, or retire as a duplicate); true when it moved. */
  placeRelinkedFact(sourceId: string, placement: RelinkPlacement): Promise<boolean>;
  /** Links a conversation page's derived row still exactly as planned onto a live page; true when it was linked. */
  linkConversationFact(sourceId: string, link: ConversationFactLink): Promise<boolean>;
  /** The conversation relink's page pick: the pages with the most derived rows it would link, most rows first, then by slug in byte order. */
  listConversationRelinkPages(sourceId: string, q: ConversationRelinkPagesQuery): Promise<string[]>;

  // Facts statements, command, cycle and fence reads (engine-sql/facts-cycle.ts). Each runs the statement its caller ran through executeRaw.
  /** enrich's grounding read: an entity's unexpired, unlapsed facts, highest confidence first (newest id breaks a tie), at most `limit`. */
  listActiveFactsForEntity(sourceId: string, entitySlug: string, limit: number): Promise<FactsCycleSql.EvidenceFactRow[]>;
  /** The unexpired audit rows of `slugs` written by one of `sources`, by slug, the rows of `preferredSource` first within a page. */
  listFreshExtractionOutcomes(sourceId: string, slugs: string[], sources: string[], preferredSource: string): Promise<FactsCycleSql.ExtractionOutcomeRow[]>;
  /** Every page coordinate with fenced rows (no `cli:` rows): its row numbers in order and whether every row is expired. No set order. */
  listFenceRowGroups(): Promise<FactsCycleSql.FenceRowGroupRow[]>;
  /** The source and page slug (the row's page, else its entity) of fact `id`, or null for no such row. */
  readFactSubject(id: number): Promise<FactsCycleSql.FactSubjectRow | null>;
  /** The fence-owned rows of a page coordinate, by row number then id; `valid_from`, `valid_until` and `expired_at` are dates. */
  listFactsForPage(sourceId: string, slug: string): Promise<FactsCycleSql.PageFactRow[]>;
  /** Per entity page of the source, its unexpired unfenced rows (a live page in a source with a checkout). No set order. */
  countLegacyFactsPending(sourceId: string): Promise<FactsCycleSql.LegacyPendingRow[]>;
  /** The consolidate phase's (source, entity) buckets of at least `minPerBucket` active unconsolidated facts. No set order. */
  countUnconsolidatedFactsBySource(opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }): Promise<FactsCycleSql.UnconsolidatedBucketRow[]>;
  /** Every bulk day of the unarchived sources (`sourceIds` narrows them) under `rule`, as the statement returns them. */
  findBulkFactDays(sourceIds: string[] | undefined, rule: FactsCycleSql.BulkDayRule): Promise<FactsCycleSql.BulkDayRow[]>;
  /** The largest `row_num` of a page coordinate's facts, 0 for none. */
  maxFenceRowNum(sourceId: string, slug: string): Promise<number>;
  /** The id of the facts row that holds `rowNum` at a page coordinate (the oldest when several do), or null. */
  readFenceRowOccupant(sourceId: string, slug: string, rowNum: number): Promise<number | null>;
  /** The page coordinate's facts that hold a row number, oldest id first. */
  listStoredFenceFactRows(sourceId: string, slug: string): Promise<FactsCycleSql.StoredFenceFactRow[]>;
  /** The entity card's exact active-fact count under its visibility, privacy and read eligibility. */
  countWorldFacts(opts: FactsCycleSql.EntityFactCountOpts): Promise<number>;
  // Facts cycle, phantom redirect, fence and file-guard statements (engine-sql/facts-cycle.ts). Each runs the statement its caller ran through executeRaw.
  /** Every facts row of a page coordinate (the phantom's rows to move), with its row number, no set order. */
  listPhantomFactRows(sourceId: string, slug: string): Promise<FactsCycleSql.PhantomFactRow[]>;
  /** The fence row numbers a page coordinate's facts already hold (no set order). */
  listCanonicalFenceRowNums(sourceId: string, slug: string): Promise<Array<{ row_num: number }>>;
  /** Points fact `id` at page `slug` under `rowNum`; a null `rowNum` leaves no fence row and expires the fact if it was not already expired. */
  moveFactToPage(sourceId: string, id: number, slug: string, rowNum: number | null): Promise<void>;
  /** Moves the links that point at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
  repointInboundLinks(phantomId: number, canonicalId: number): Promise<void>;
  /** Moves the links that start at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
  repointOutboundLinks(phantomId: number, canonicalId: number): Promise<void>;
  /** Whether page `pageId` (null: no page) has at least one timeline entry. */
  pageHasTimelineEntries(pageId: number | string | null): Promise<boolean>;
  /** The largest fence `row_num` of a page coordinate's facts, 0 for none (the phantom redirect's canonical-page read). */
  maxFenceRowNumOfPage(sourceId: string, slug: string): Promise<number>;
  /** The source's live root-level slugs past `after`, in slug order, leaving out `held`: at most `take` rows (page size plus one). */
  listRootPageSlugsAfter(sourceId: string, take: number, held: string[], after: string): Promise<Array<{ slug: string }>>;
  /** The ids of the links `pageId` itself owns (not derived from another page). */
  listOwnLinkIds(pageId: number | string): Promise<Array<{ id: number }>>;
  /** The ids of a page coordinate's unexpired facts. */
  listActiveFactIdsOfPage(sourceId: string, slug: string): Promise<Array<{ id: number }>>;
  /** Which of facts `ids` are unexpired and now sit on page `slug`. */
  listFactIdsStillOnPage(ids: number[], slug: string): Promise<Array<{ id: number }>>;
  /** Which of links `ids` now start at page `pageId`. */
  listLinkIdsOnPage(ids: number[], pageId: number | string): Promise<Array<{ id: number }>>;
  /** The recorded file origin (`source_path`, `source_uri`) of a live page, or null for no live page. */
  readPageFileOrigin(sourceId: string, slug: string): Promise<FactsCycleSql.PageFileOrigin | null>;
  /** The facts of a page coordinate that hold a fence row number, with their claim text and source (no set order). */
  listFenceRowClaims(sourceId: string, slug: string): Promise<FactsCycleSql.FenceRowClaim[]>;
  /** Gives unfenced fact `id` fence row `rowNum` on page `slug` with claim text `fact`; only a row that still has no fence row changes. */
  adoptFactIntoFence(sourceId: string, id: string, rowNum: number, slug: string, fact: string): Promise<void>;
  /** The facts of a page coordinate that hold a fence row number, with their expiry and supersession (no set order). */
  listFenceRowSupersession(sourceId: string, slug: string): Promise<FactsCycleSql.FenceRowSupersession[]>;
  /** Sets (or, with null, clears) fact `id`'s `superseded_by`. */
  setFactSupersededBy(sourceId: string, id: number | string, supersededBy: number | null): Promise<void>;
  /** Which of facts `ids` have a pending, rejected or undone trust proposal that holds back a visibility change. */
  listHeldWideningFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number }>>;
  /** Expires fact `id` where it stands (the fence row keeps its number). An already expired fact keeps its expiry time. */
  expireFactInPlace(sourceId: string, id: number | string): Promise<void>;
  /** Expires fact `id` and drops its fence row number. An already expired fact keeps its expiry time. */
  expireAndDetachFact(sourceId: string, id: number | string): Promise<void>;
  /** Writes a fence row's cells onto fact `id`. */
  updateFenceFactCells(sourceId: string, id: number | string, cells: FactsCycleSql.FenceFactCells): Promise<void>;
  /** The unexpired fence rows of a page coordinate whose page is soft-deleted (and, when `pageId` is given, is that page id). */
  listExpirableFactIdsOfDeletedPage(sourceId: string, slug: string, pageId: number | null): Promise<Array<{ id: number }>>;
  /** The newest soft-deleted page of a coordinate's stored body, or null for none. */
  readDeletedPageBody(sourceId: string, slug: string): Promise<FactsCycleSql.DeletedPageBodyRow | null>;
  /** Expires the still-unexpired facts among `ids`; the ids it expired. */
  expireFactsByIds(sourceId: string, ids: number[]): Promise<Array<{ id: number }>>;
  /** The page slugs (no `/`) that still hold an unexpired ontology observation. */
  listOntologyObservationSlugs(sourceId: string): Promise<Array<{ slug: string }>>;
  /** The soft-deleted pages of the source that still have unexpired fence rows, in slug order. */
  listDeletedPageSlugsWithActiveFacts(sourceId: string): Promise<Array<{ slug: string }>>;
  /** The source's unexpired facts with no fence row, by entity slug (null first) then id, with page-existence flags. */
  scanUnfencedFactRows(sourceId: string): Promise<FactsCycleSql.UnfencedScanRow[]>;
  /** The source's unexpired fence rows on a holding page (any folder depth) that name another entity, by entity slug then id; `days` is the age cutoff as text. */
  listHeldFactRows(sourceId: string, days: string): Promise<FactsCycleSql.HeldFactRow[]>;
  /** The source's fenced, unexpired facts whose page is missing or soft-deleted, by id, with the page slug they sit on. */
  listFencedFactsOfMissingPages(sourceId: string): Promise<Array<{ id: number; slug: string }>>;
  /** The largest fence `row_num` of a page coordinate's facts, 0 for none (the fence writer's numbering hint; the caller handles a failed read). */
  readFenceRowNumHint(sourceId: string, slug: string): Promise<number>;
  /** The source's checkout path, or null when the source is unknown or has none. */
  readSourceCheckoutPath(sourceId: string): Promise<string | null>;
  /** The live page's stored body, or null for no live page. `lock` takes the row lock (inside a transaction). */
  readLiveStoredBody(sourceId: string, slug: string, lock?: boolean): Promise<FactsCycleSql.StoredBodyRow | null>;
  /** The live page's state, then its 20 newest page_versions rows that hold a body, newest first. */
  listPageStates(sourceId: string, slug: string): Promise<FactsCycleSql.PageStateRow[]>;
  /** How many of a page's versions keep their body in segments. */
  countSegmentedVersionsOfPage(sourceId: string, slug: string): Promise<number>;

  // Facts statements, purge, withdrawal, relink and fence repair (engine-sql/facts-purge.ts). Each runs the statement its caller ran through executeRaw.

  countFactFingerprintLeftovers(sourceId: string, factHash: string, visibility: string, subject: string): Promise<number>;
  loadPurgeTarget(id: number, sourceId: string): Promise<FactsPurgeSql.PurgeTargetRow | null>;
  planFactPurgeIds(sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ id: number }>>;
  listFactsReconcileBacklog(): Promise<FactsPurgeSql.FactsReconcileBacklogRows>;
  /** extract_facts: record one live page's reconcile outcome at `revision` (`undefined`: the current revision); a page that moved on records nothing. */
  settleFactsReconcile(sourceId: string, slug: string, outcome: FactsPurgeSql.FactsReconcileOutcome, revision?: string | null): Promise<void>;
  /** extract_facts' commit step: lock the live page for the rest of the transaction and report whether it is still at `revision`. */
  lockReconcileRevision(sourceId: string, slug: string, revision: string | null): Promise<boolean>;
  /** extract_facts: settle the source's due fenceless pages as complete, then return up to `pageLimit` due retryable slugs, never-attempted first. */
  selectFactsReconcileDrain(sourceId: string, pageLimit: number): Promise<string[]>;
  listRelinkCandidateRows(opts: { sourceId: string; afterId: number; since: Date | null; limit: number }): Promise<FactsPurgeSql.RelinkCandidateRow[]>;
  countRelinkCandidates(sourceId: string): Promise<number>;
  listSimilarActiveFacts(opts: { sourceId: string; factId: number; remote: boolean; excludePrivate: boolean; minCosine: number; limit: number }): Promise<FactsPurgeSql.SimilarActiveFacts>;
  findActiveSingleFact(opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean; newest?: boolean }): Promise<FactsPurgeSql.ExactFactRow | null>;
  listSingleFactMetadata(opts: { sourceId: string; ids: number[]; remoteFloor: boolean }): Promise<FactsPurgeSql.SingleFactMetadataRow[]>;
  listUnfencedFactRows(opts: { sourceId?: string }): Promise<FactsPurgeSql.UnfencedFactRow[]>;
  listHeldFenceFactRows(sourceId: string, slug: string): Promise<FactsPurgeSql.HeldFenceFactRow[]>;
  listWithdrawalSlugs(sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ slug: string }>>;
  expireFactsByWithdrawal(sourceId: string, visibility: string, fact: string, subject: string): Promise<Array<{ id: number }>>;
  /** Stores a fact purge tombstone; false when the same (source, visibility, subject, fingerprint) one exists. */
  insertFactPurge(row: FactsPurgeSql.FactPurgeInsert): Promise<boolean>;
  /** One hop of the derivation walk: the rows a `derivation_inputs` edge derives from a frontier row, distinct, by (table, id), at most `limit`. */
  listDerivedRows(frontier: ReadonlyArray<{ table: string; id: string }>, limit: number): Promise<Array<{ derived_table: string; derived_id: string }>>;
  // The facts purge statements of gone-page-facts.ts, purge-reasons.ts, held-fact-move.ts and purge-verify.ts (engine-sql/facts-purge.ts). Each runs the statement its caller ran through executeRaw.
  /** Expires the facts a retention purge takes with its deleted pages (filed on them, their conversation slots, extracted from them, about them and held by no page): four updates in order over the paired source ids and slugs. Writes facts; run it in the purge transaction. */
  expireFactsOfGonePages(sourceIds: string[], slugs: string[]): Promise<void>;
  /** The source's checkout path, null for none or no such source. Reads sources. */
  readPurgeSourceLocalPath(sourceId: string): Promise<string | null>;
  /** Tombstones each (commit, path) pair, none twice; the number added. Writes reason_purge_tombstones. */
  insertReasonPurgeTombstones(sourceId: string, commits: string[], paths: string[]): Promise<number>;
  /** The source's Git effects whose data carries the claim in one of its three forms, in id order, locked for the redaction. Reads persistence_effects. */
  listGitEffectsCarryingReason(sourceId: string, needle: string, escaped: string, foldedJson: string): Promise<FactsPurgeSql.PurgeGitEffectRow[]>;
  /** The slug's Git effects that carry a commit line or trailers, in id order, locked for the strip. Reads persistence_effects. */
  listPageGitEffectsForStrip(sourceId: string, slug: string): Promise<FactsPurgeSql.PurgeGitEffectRow[]>;
  /** Replaces one effect's data (`effectId` is the bigint id as text). Writes persistence_effects. */
  setPurgeEffectData(effectId: string, data: Record<string, unknown>): Promise<void>;
  /** The change reasons the page's versions and its requests (intent and outcome) recorded, each once, null included. Reads page_versions and persistence_requests. */
  listPageChangeReasons(sourceId: string, slug: string, pageId: number): Promise<Array<{ reason: string | null }>>;
  /** The slug's requests whose intent or outcome records a reason, oldest first (10000 at most). Reads persistence_requests. */
  listRequestsRecordingReasons(sourceId: string, slug: string): Promise<FactsPurgeSql.IntentRedactionTarget[]>;
  /** Whether a soft-deleted page holds the slug. Reads pages. */
  heldEntityPageDeleted(sourceId: string, slug: string): Promise<boolean>;
  /** Whether the access state is readable, an exact page rule covers the entity and a folder rule restricts it. Reads access_rules, access_pending_coverage and the access functions; the caller decides what a failed read means. */
  readHeldAccessState(sourceId: string, entity: string): Promise<FactsPurgeSql.HeldAccessState[]>;
  /** Whether a live page holds the slug. Reads pages. */
  heldTargetPageLive(sourceId: string, slug: string): Promise<boolean>;
  /** Every live held row on every holding page of the source, by holding page, entity and id. Reads facts and pages. */
  listHeldMoveRows(sourceId: string): Promise<FactsPurgeSql.HeldFactRow[]>;
  /** The struck held rows, one per holding page and row number, none an active fact reuses. Reads facts and pages. */
  listStruckHeldRows(sourceId: string): Promise<FactsPurgeSql.StruckHeldRow[]>;
  /** Whether every reader of the source can read the live page; null for no live page. Reads pages and the access rules. */
  readHeldRowVisibility(sourceId: string, slug: string): Promise<{ visible: boolean } | null>;
  /** Whether a rule now narrows a held row's entity below its holding page's readers. Reads facts, pages and the access functions. */
  heldMoveDue(sourceId: string): Promise<boolean>;
  /** One config row's value, null when unset. Reads config. */
  readHeldConfigValue(name: string): Promise<string | null>;
  /** A live page's file path and URI, null for none; `timeoutMs` ends the read on the server. Reads pages. */
  readHeldPageLocation(sourceId: string, slug: string, opts?: { timeoutMs?: number }): Promise<{ source_path: string | null; source_uri: string | null } | null>;
  /** The segmented saved versions a held-fact request recorded as not edited; 0 for none. Reads persistence_requests. */
  readHeldVersionsEdited(requestId: string): Promise<number>;
  /** The source's live pages stored in segments, in id order, `limit` of them. Reads pages. */
  listSegmentedPageBodies(sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: null; version_id: null }>>;
  /** The source's retained versions stored in segments, in id order, `limit` of them. Reads page_versions and pages. */
  listSegmentedVersionBodies(sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: number; version_id: number }>>;
  /** Bounds the statements of the transaction it runs in to `ms` milliseconds (set_config, local). */
  setPurgeProbeTimeout(ms: number): Promise<void>;
  /** One batch of stored derivation results after the cursor (page, pipeline, occurrence): the rows scanned, the claim candidates, those a sweep covers and holds the claim, and those it does not, and the last key. Reads page_segment_derivations and pages. */
  probePurgeDerivations(sourceId: string, needles: string[], pageIds: number[], patterns: string[], cursor: FactsPurgeSql.DerivationKey | null, rows: number): Promise<FactsPurgeSql.PurgeDerivationProbeRow>;
  /** The next 1000 belief events of the source after id `after` with a recorded value, in id order. Reads belief_events. */
  listBeliefEventsForPurgeProbe(sourceId: string, after: number): Promise<Array<{ id: number; subject_kind: string; subject_key: string; value: unknown }>>;
  /** The next 1000 live facts of the source after id `after` that have a context, in id order. Reads facts. */
  listFactContextsForPurgeProbe(sourceId: string, after: number): Promise<Array<{ id: number; context: string }>>;
  /** The distinct relative file paths (64 at most) of the pages and their versions, none absolute or climbing out. Reads pages and page_versions. */
  listPageSourcePathsForPurge(pageIds: number[]): Promise<Array<{ source_path: string }>>;
  /** The five same-model facts of the source nearest to the embedding, each with whether it contains the claim. Reads facts. */
  listNearestFactsForPurge(embedding: string, sourceId: string, model: string, fact: string): Promise<Array<{ id: number; similarity: number; contains_claim: boolean }>>;
  /** The source's live atom and dream pages that no derivation edge explains. Reads pages and derivation_inputs. */
  countLegacyDerivedPages(sourceId: string): Promise<number>;
  /** Compacts the tables a purge touches (query_cache too when asked); rejects when the VACUUM fails. PGLite only: Postgres leaves it to the operator. */
  vacuumPurgedTables(withQueryCache: boolean): Promise<void>;
  /** The first 20 slugs, in order, of the source's live pages whose text in the store states one of the lowered needles. Reads the store and pages. */
  listPageProseHits(store: FactsPurgeSql.PageProseStore, sourceId: string, loweredNeedles: string[]): Promise<Array<{ slug: string }>>;
  /** The source's checkout path as the page purge receipt reads it, null for none. Reads sources. */
  readPurgeReceiptSourcePath(sourceId: string): Promise<string | null>;
  /** How many tombstones the page purge left for the slug. Reads page_purges. */
  countPagePurgeTombstones(sourceId: string, slug: string): Promise<number>;
  /** The newest delete_page request of the source with this request id, null for none. Reads persistence_requests. */
  readDeletePageRequest(sourceId: string, requestId: string): Promise<FactsPurgeSql.DeletePageRequestRow | null>;
  /** The request's effects in kind order, each with whether any target is parked. Reads persistence_effects. */
  listPurgeEffects(requestId: string): Promise<Array<{ kind: string; state: string; error_code: string | null; parked: boolean }>>;
  /** The facts and takes that still carry the purged claim's fingerprint under the subject (`*` for any), outcome markers apart. Reads facts and takes. */
  countPurgeFingerprintResidue(sourceId: string, factHash: string, subject: string): Promise<{ facts: number; takes: number }>;
  /** The next 1000 upload parts of the source's live stagings after the (staging, part) cursor, in order, each with its first and last `keep` bytes. Reads page_body_staging_parts and page_body_stagings. */
  listStagingPartEdges(sourceId: string, keep: number, after: { id: string; part: number }): Promise<FactsPurgeSql.StagingPartEdge[]>;
  /** The ids of the source's live stagings whose staged segment texts or upload parts hold the claim, plain or as a fence cell stores it, in id order. Reads page_body_stagings, page_body_manifest, page_segment_texts, page_body_staging_parts, page_body_staging_texts and persistence_requests. */
  listStagingsHoldingClaim(sourceId: string, claim: string): Promise<string[]>;
  /** Whether a live page of the source holds the slug (the one-row read that tells a purge the subject is an unbacked name key). Reads pages. */
  purgeSubjectPageLive(sourceId: string, slug: string): Promise<boolean>;
  /** The slug, id and knowledge revision of the source's pages with these ids. Reads pages. */
  listPurgePagesById(sourceId: string, pageIds: number[]): Promise<FactsPurgeSql.PurgePageRef[]>;
  /** How many saved versions of the source's pages carry the claim in their text, title, metadata or segments, or quote it in their change reason (`needle` lowered, `escaped` its JSON form, `reason` the folded reason form). Reads page_versions, pages, page_body_manifest and page_segment_texts. */
  countPurgeVersionsCarryingClaim(sourceId: string, needle: string, escaped: string, reason: string): Promise<number>;
  /** How many review queue, review proposal and decide proposal rows of the source name the facts (`refs` are the ids as text). Reads decide_review_queue, decide_review_proposals and decide_proposals. */
  countPurgeReviewRows(sourceId: string, refs: string[], factIds: number[]): Promise<FactsPurgeSql.PurgeReviewCounts>;
  /** The distinct belief stream slugs (holding page, else entity) of the facts. Reads facts; run it in the purge transaction. */
  listPurgeStreamSlugs(factIds: number[]): Promise<string[]>;
  /** One unfinished write or withdrawal mirror (not the request `ownRequest`) on one of the pages, null for none. Reads persistence_requests and persistence_effects. */
  findPurgeBlockedPublication(sourceId: string, slugs: string[], ownRequest: string): Promise<FactsPurgeSql.PurgeBlockedPublication | null>;
  /** The source's pages with these ids, whole rows, each with its tags as `purge_tags`, in slug order. Reads pages and tags. */
  listPagesForPurgeRewrite(sourceId: string, pageIds: number[]): Promise<Array<Record<string, unknown>>>;
  /** Stores a page's body with the purged fence rows dropped, its content hash, and voids its text projection and embedding signature. Writes pages; run it in the purge transaction. */
  updatePageBodyForPurge(sourceId: string, pageId: number, compiled: string, timeline: string, hash: string): Promise<void>;
  /** Stores a saved version's two body parts after the purge edit (a null timeline stays null). Writes page_versions; run it in the purge transaction. */
  setPurgeVersionBody(versionId: number, compiled: string, timeline: string | null): Promise<void>;
  /** Overwrites the change reason of every saved version of the source's pages that quotes the claim (lowered plain form or folded reason form) with `[purged]`; the ids redacted. Writes page_versions. */
  redactVersionChangeReasons(sourceId: string, needle: string, reasonNeedle: string): Promise<number[]>;
  /** The next 5000 segmented saved versions of the source after id `after` that belong to one of the pages or whose generation holds the lowered claim, in id order. Reads page_versions, pages, page_body_manifest and page_segment_texts. */
  listSegmentedVersionsForPurge(sourceId: string, needle: string, pageIds: number[], after: number): Promise<FactsPurgeSql.SegmentedVersionRow[]>;
  /** Aborts the uncommitted stagings with these ids; the page ids they belonged to (none for a staging with no page). Writes page_body_stagings; run it in the purge transaction. */
  abortPurgedStagings(stagingIds: string[]): Promise<number[]>;
  /** Deletes the upload parts of these stagings; how many. Writes page_body_staging_parts; run it in the purge transaction. */
  deletePurgedStagingParts(stagingIds: string[]): Promise<number>;
  /** Deletes the cached read-view digests of these pages. Writes page_view_digests; run it in the purge transaction. */
  deletePageViewDigests(pageIds: number[]): Promise<void>;
  /** Deletes the source's segment texts that no manifest row references and that were replaced by the purge (`replaced` are their sha256 digests) or hold the claim, plain or as a fence cell stores it; how many. Writes page_segment_texts; run it in the purge transaction. */
  deleteUnreferencedPurgedTexts(sourceId: string, replaced: Uint8Array[], claim: string): Promise<number>;
  /** The first 25 facts of the source whose text contains `text` (case folded), in id order, each cut to 160 characters. Reads facts. */
  listPurgeMatchCandidates(sourceId: string, text: string): Promise<FactsPurgeSql.PurgeMatchRow[]>;
  /** Locks the source row for the purge transaction and returns its incarnation and archived flag, null for no such source. Reads sources; run it in the purge transaction. */
  lockPurgeSource(sourceId: string): Promise<FactsPurgeSql.PurgeSourceLock | null>;
  /** Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. */
  insertHoldingPagePurges(sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]): Promise<void>;
  /** Stores the text-free take purge tombstone for the claim fingerprint under the subject, none twice. Writes take_purges; run it in the purge transaction. */
  insertTakePurge(sourceId: string, subject: string, claimHash: string, requestId: string): Promise<void>;
  /** Deletes the takes with these ids; how many. Writes takes; run it in the purge transaction. */
  deletePurgedTakes(takeIds: number[]): Promise<number>;
  /** Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. */
  deletePurgeReviewQueue(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. */
  deletePurgeReviewProposals(sourceId: string, refs: string[]): Promise<number>;
  /** Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. */
  deletePurgeDecideProposals(sourceId: string, factIds: number[]): Promise<number>;
  /** Deletes the source's trust proposals whose target or related row is one of the facts or takes; how many. Writes trust_proposals; run it in the purge transaction. */
  deletePurgeTrustProposals(sourceId: string, factIds: number[], takeIds: number[]): Promise<number>;
  /** Deletes the source's open loops on one of the facts; how many. Writes open_loops; run it in the purge transaction. */
  deletePurgeOpenLoops(sourceId: string, factIds: number[]): Promise<number>;
  /** Deletes the source's held writes whose fact or claim text has the fingerprint; the ids deleted. Writes write_gate_holds; run it in the purge transaction. */
  deletePurgeWriteGateHolds(sourceId: string, factHash: string): Promise<string[]>;
  /** Deletes the gate receipts that name one of the facts, takes or held writes (ids as text); how many. Writes write_gate_receipts; run it in the purge transaction. */
  deletePurgeWriteGateReceipts(factIds: string[], takeIds: string[], holdIds: string[]): Promise<number>;
  /** Deletes the source's take proposals whose claim text has the fingerprint; how many. Writes take_proposals; run it in the purge transaction. */
  deletePurgeTakeProposals(sourceId: string, factHash: string): Promise<number>;
  /** Blanks the base text of the source's core edit notices that quote the lowered fact; how many. Writes core_edit_notices; run it in the purge transaction. */
  blankPurgeCoreEditNotices(sourceId: string, loweredFact: string): Promise<number>;
  /** Deletes the facts with these ids from the source; how many. Writes facts; run it in the purge transaction. */
  deletePurgedFacts(factIds: number[], sourceId: string): Promise<number>;
  /** Deletes the chunks of these pages and voids the text projection that certified them; how many pages had chunks deleted. Writes content_chunks and pages; run it in the purge transaction. */
  deletePurgedChunks(pageIds: number[]): Promise<number>;
  /** The id, slug and knowledge revision of the source's pages with these ids, in slug order. Reads pages. */
  listPurgedPageRevisions(sourceId: string, pageIds: number[]): Promise<FactsPurgeSql.PurgedPageRevision[]>;
  /** Queues the withdrawal-mirror, git and embedding effects of the purge request under the source's current incarnation and worktree binding, none twice; `data` is the effect payload. Writes persistence_effects; run it in the purge transaction. */
  insertPurgeEffects(requestId: string, sourceId: string, data: unknown): Promise<void>;

  // Facts statements, repair classifiers and loop retirement (engine-sql/facts-repair.ts). Each runs the statement its caller ran through executeRaw.
  /** Closed loops whose commitment fact is still active and retirable (same source, no other open loop references it), in id order; `loopId` null is every loop. Reads open_loops. */
  loopFactDrift(sourceIds: string[], loopId: number | null): Promise<FactsRepairSql.LoopFactDriftRow[]>;
  /** A loop already closed whose commitment fact is still active (the retry path of `loops_close`); `sourceId` null is unscoped. Reads open_loops. */
  closedLoopWithActiveFact(sourceId: string | null, loopId: number): Promise<FactsRepairSql.ClosedLoopRow | null>;
  /** Active, unsuperseded facts of the capture `lanes` in these sources whose attribution is the user or unset, optionally only `ids`, in (source, id) order. */
  listSessionFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null): Promise<FactsRepairSql.SessionFactRow[]>;
  /** For each fact in `ids`: whether an owner twin exists outside the capture `lanes`, and the sessions of its capture-lane twins. */
  listSessionFactTwins(ids: number[], lanes: string[]): Promise<FactsRepairSql.SessionFactTwinRow[]>;
  /** Active, unsuperseded capture-lane facts of these sources with their fingerprint and whether a legitimate (other-lane) twin exists, in (source, id) order. */
  listCapturedFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null): Promise<FactsRepairSql.CapturedFactRow[]>;
  /** The bounded count of the default (evidenced) set of label facts, capped at `cap`. Reads open_loops and fact_withdrawals. */
  countLabelFacts(sourceIds: string[], cap: number, args: FactsRepairSql.LabelFactCountArgs): Promise<{ count: number; capped: boolean }>;
  /** Expired fenceless extractor facts of these sources (or of one page `slug`) with the page, withdrawal, duplicate, fence and receipt evidence, in (source, page, id) order. Reads persistence_requests and fact_withdrawals. */
  listExtractorFactsForClassification(sourceIds: string[], slug: string | null): Promise<FactsRepairSql.ExtractorFactRow[]>;
  /** The bounded count of facts of a purged page, by class, capped at `cap`. Reads page_purges, fact_withdrawals and open_loops. */
  countPurgedPageFacts(sourceIds: string[], cap: number): Promise<{ evidenced: number; ambiguous: number; capped: boolean }>;
  /** Facts a facts-fence generation (`fenceKind`) retired that no withdrawal covers, in (source, page, id) order; `slug` null is every page. Reads derived_generations, derived_generation_items and fact_withdrawals. */
  listUnwithdrawnFacts(sourceIds: string[], slug: string | null, fenceKind: string): Promise<FactsRepairSql.UnwithdrawnFactRow[]>;
  /** Active `world` facts held in, or extracted from, a page that is private by its visibility, declared lineage or a privacy alias, optionally only `ids`, in id order; `readable` is whether the holding page hides the row from a remote caller. */
  listWorldFactsFromPrivateSources(sourceIds: string[], ids: number[] | null): Promise<FactsRepairSql.WorldFactFromPrivateSourceRow[]>;
  /** The ids of the sources that are not archived, in id order (the repair previews that name `--source` when more than one). */
  listActiveSourceIds(): Promise<Array<{ id: string }>>;
  /** The brain id a repair preview hashes (`persistence_brain.brain_id`), or null when the brain has no such row. */
  readRepairBrainId(): Promise<string | null>;
  /** Active, unresolved `fact`/`self` takes of these sources with the facts consolidated into each, one grouped pass, in (source, slug, id) order; `ids` null is every take. */
  listAgentSessionTakeCandidates(sourceIds: string[], ids: number[] | null, noteMark: string): Promise<FactsRepairSql.AgentSessionTakeCandidateRow[]>;
  /** The named facts of the source already attributed to `other` and neither expired nor superseded, with their context. */
  listSettledSessionFacts(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; context: string | null }>>;
  /** Re-attributes the named database-only user facts of the source to `other`, appending each note once after `separator`; returns the changed ids. Run it on the transaction. */
  reattributeSessionFacts(sourceId: string, facts: Array<{ id: number; note: string }>, separator: string): Promise<Array<{ id: number | string }>>;
  /** Retires the named active `fact`/`self` takes of the source whose contributing facts are all non-user; returns the retired ids. Run it on the transaction. */
  retireSessionTakes(sourceId: string, takeIds: number[]): Promise<Array<{ id: number | string }>>;
  /** The named unexpired facts of the source with their claim and fence row number. */
  listFenceRewriteRows(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; fact: string; row_num: number }>>;
  /** The named facts of the source attributed to `other`. */
  listOtherAttributedFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>>;
  /** The named takes that are inactive. */
  listInactiveTakeIds(ids: number[]): Promise<Array<{ id: number | string }>>;
  /** Expires the named active database-only facts of the source, putting `context` before their own; returns the expired ids. Run it on the transaction. */
  expireCapturedFacts(sourceId: string, ids: number[], context: string): Promise<Array<{ id: number | string }>>;
  /** The named facts of the source that are expired. */
  listExpiredFactIds(sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>>;
  /** Per page-less `entity_slug` of these sources: the database-only fact ids and the count of fence-held facts, in (source, slug) order. */
  listPagelessEntityFacts(sourceIds: string[]): Promise<FactsRepairSql.PagelessEntityFactRow[]>;
  /** Whether the `from` and `to` pages are live in the source and the database-only fact ids keyed under `from`. Run it on the transaction. */
  readEntityRehomeState(sourceId: string, fromSlug: string, toSlug: string): Promise<FactsRepairSql.EntityRehomeState | null>;
  /** Re-keys the database-only facts of the source from `fromSlug` to `toSlug`. Run it on the transaction. */
  rehomeEntityFacts(sourceId: string, fromSlug: string, toSlug: string): Promise<void>;

  // Facts statements, search relevance and trust reads (engine-sql/facts-trust.ts). Each runs the statement its caller ran through executeRaw.
  /** One arm of the search fact pool: the keyword arm, or a named entity's active (`entity`) or ended (`entity_ended`) facts, under the caller's read policy; `similarity` is the cosine to `vector` where comparable. */
  listFactsForRelevance(q: FactsTrustSql.FactRelevanceQuery): Promise<FactsTrustSql.FactRelevanceRow[]>;
  /** Facts in the pool the cosine arm cannot compare (no vector, another model, stale text hash or other dimensions), per source, the most first. */
  countUncomparableFacts(q: FactsTrustSql.UncomparableFactsQuery): Promise<Array<{ source_id: string; n: number }>>;
  /** The keyword scan behind a search's saved-facts block: active facts sharing the query's words, with match counts and trust ranks. */
  matchSavedFacts(q: FactsTrustSql.SavedFactsMatchQuery): Promise<FactsTrustSql.SavedFactMatchRow[]>;
  /** The fact an owner action targets, with its stored trust tier, or null when no fact has the id. */
  readFactForOwnerAction(id: number): Promise<FactsTrustSql.OwnerActionFactRow | null>;
  /** Unconfirmed standing preferences and commitments the write gate flagged (needs write_gate_receipts; the caller probes it). */
  listStandingPreferences(opts: { sourceId?: string; since?: Date }): Promise<FactsTrustSql.StandingPreferenceRow[]>;
  /** Active facts about the entity, kind and visibility that are more trusted than the writer: the keyless conflict slot's candidates. */
  listLexicalContestCandidates(opts: { sourceId: string; entitySlug: string; kind: string; visibility: string; pageSlug?: string; writer: import('./trust/tier.ts').TrustTier }): Promise<Array<{ id: number; fact: string; trust_tier: string }>>;
  /** Of `ids`, the facts held on, derived from, or saved by a backstop naming a page of one of `pageTypes` (search/transcript-quote.ts). */
  listFactsFromQuotedPages(opts: Parameters<typeof FactsTrustSql.listFactsFromQuotedPages>[1]): Promise<number[]>;
  /** Of `ids`, the facts whose stored tier ranks at or above `floor`. */
  listOwnerTierFacts(opts: { ids: readonly number[]; floor: import('./trust/tier.ts').TrustTier }): Promise<number[]>;
  /** The active non-world copy of a claim that a world write would restate, more trusted than the writer, when no active world copy exists. */
  listRestatedPrivateCopies(opts: { sourceId: string; claim: string; entity: string | null; writer: import('./trust/tier.ts').TrustTier }): Promise<Array<{ id: number; visibility: string; trust_tier: string }>>;
  /** How many facts carry taint inputs in their write origin, and how many of those are external_untrusted. */
  countDerivedFactTaint(): Promise<{ derived: number; external: number }>;
  /** Lowers the rows of `ids` whose stored tier ranks above `tier` to `tier` and `origin`, never raising; resolves the ids lowered (trust/taint.ts). */
  lowerTrustTier(table: import('./trust/tier.ts').TaintTable, ids: readonly number[], tier: import('./trust/tier.ts').TrustTier,
    origin: import('./trust/tier.ts').WriteOrigin | null): Promise<number[]>;
  /** How many take, timeline or page rows carry taint inputs in their write origin, and how many of those are external_untrusted. */
  countDerivedRowTaint(table: DerivationTrustSql.DerivedTaintTable): Promise<{ derived: number; external: number }>;
  /** One fixed frontmatter stamp: the retirement stamp on soft-deleted pages, or an atom generation's `source_hash` on its live atoms. */
  stampPageFrontmatter(stamp: DerivationTrustSql.PageFrontmatterStamp): Promise<void>;
  /** The `entity_slug` a stored fact has; null when it has none or no fact has the id. */
  readFactEntitySlugById(id: number): Promise<string | null>;
  /** The replacement fact's fence row, whether both facts sit on one page, both validity starts and the old end; null when either id is gone. */
  readSupersessionReplacement(newId: number, oldId: number): Promise<FactsTrustSql.SupersessionReplacementRow | null>;
  /** Links the old fact to the one that replaced it (`superseded_by`). Run it on the maintenance transaction. */
  linkSupersededFact(oldId: number, newId: number): Promise<void>;
  /** The slug and title of each named live page of the source. */
  listLivePageTitles(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>>;
  /** The normalized aliases of the named pages; throws on a brain older than v110 (no `page_aliases`). */
  listPageAliasNames(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; alias_norm: string }>>;
  /** The newest `scanLimit` live facts of the source whose fingerprint equals the candidate's, in these visibilities, spoken by nobody else, leaving out member-owned pages. */
  listCaptureDuplicateCandidates(opts: { sourceId: string; visibilities: string[]; fact: string; attributedTo: string | null; replacingPage: string | null; scanLimit: number }): Promise<FactsTrustSql.CaptureDuplicateCandidateRow[]>;
  /** The fingerprint of each text, in order (`gbrain_fact_fingerprint`). */
  computeFactFingerprints(texts: string[]): Promise<string[]>;
  /** Unproposed same-bucket claim conflicts in the source, by (new id, old id), at most `cap` rows. */
  listClaimConflictPairs(sourceId: string, auditSources: string[], cap: number): Promise<Array<Record<string, unknown>>>;
  /** How many unproposed claim conflicts the source holds, or null when no row answers. */
  countClaimConflictPairs(sourceId: string, auditSources: string[]): Promise<{ n: number | string } | null>;
  /** The ids of every source that is not archived, in id order (the claim-conflict sweep's default scope). */
  listAllUnarchivedSourceIds(): Promise<Array<{ id: string }>>;

  // Facts statements, conversation fact publication and relink (engine-sql/facts-conversation.ts). Each runs the statement its caller ran through executeRaw.
  /** The newest extractor fact id of a page (null when it has none): the next generation's seed. */
  readNewestConversationFactId(sourceId: string, slug: string): Promise<number | string | null>;
  /** The writer's request `requestId` when its digest is not `digest`, or it was compacted without committing: a spent id. */
  findSpentConversationRequest(principalKind: string, principalId: string, requestId: string, digest: string): Promise<{ request_id: string } | null>;
  /** The writer's unsettled and failed (not yet compacted) conversation-facts batch requests of a source, in journal order. */
  listConversationBatchRequests(principalKind: string, principalId: string, sourceId: string, anchorSlug: string): Promise<FactsConversationSql.ConversationBatchRequestRow[]>;
  /** The stored entry of `generation` in the batch request row `id` (null when the row or the entry is gone). */
  readStoredConversationEntry(id: string, generation: string): Promise<FactsConversationSql.ConversationPageEntry | null>;
  /** A principal's journal counters (outstanding requests, reserved receipt bytes, lifetime ids), null when it has no row. */
  readPrincipalCounters(key: string): Promise<FactsConversationSql.PersistenceCounterRow | null>;
  /** Live pages of the given types in a source that a run would extract: all of them with `force`, else those with no active outcome row. */
  countConversationPagesToExtract(sourceId: string, pageTypes: string[], force: boolean): Promise<number>;
  /** Entity slugs that became aliases of a live page (and no longer name a live page of their own): alias to canonical. */
  listMergedEntityAliases(sourceId: string, slugs: string[]): Promise<FactsConversationSql.MergedAliasRow[]>;
  /** Re-anchors a page's extractor facts from each `from` window key to its `to` window (ids unchanged) in one statement, so a chain of moves among windows of the same text applies at once. */
  moveConversationSourceWindows(sourceId: string, slug: string, moves: ReadonlyArray<{ from: string; to: FactsConversationSql.SourceWindow }>): Promise<void>;
  /** Anchors one batch of freshly inserted facts to their windows; one JSON bind, so JSONB stays an object. */
  stampConversationSourceWindows(pairs: ReadonlyArray<{ id: number; w: FactsConversationSql.SourceWindow | null }>): Promise<void>;
  /** A page's active conversation facts, audit rows aside. */
  countActiveConversationFacts(sourceId: string, slug: string): Promise<number>;
  /** The value hash of the slot's latest conversation-source value at or before `validFrom`, null when there is none. */
  readConversationSlotValueHash(sourceId: string, entitySlug: string, dimension: string, validFrom: Date | string): Promise<{ value_hash: string } | null>;
  /** Deletes a page's audit (outcome) rows; returns the ids removed. */
  deleteConversationOutcomeRows(sourceId: string, slug: string): Promise<Array<{ id: number }>>;
  /** The positions (1-based) of the claims that match a purge tombstone (under their own entity, or any subject for an unbacked name key). */
  listPurgeTombstoneMatches(sourceId: string, claims: { facts: string[]; visibilities: string[]; entitySlugs: Array<string | null>; sources: Array<string | null> }): Promise<Array<{ ord: number | string }>>;
  /** The largest row number any fact of the page holds (null for none). */
  maxConversationRowNum(sourceId: string, slug: string): Promise<number | string | null>;
  /** The slot keys the page's facts already hold. */
  listHeldFactSlots(sourceId: string, slug: string): Promise<FactsConversationSql.HeldFactSlotRow[]>;
  /** The page's conversation facts, audit rows aside: what a clear would lose that a window extraction may not see again. */
  countPageConversationFacts(sourceId: string, slug: string): Promise<number>;
  /** The page's active conversation facts anchored to window `key`. */
  countConversationWindowFacts(sourceId: string, slug: string, key: string): Promise<number>;
  /** The page's active conversation facts a settled collection keeping window `keys` removes: anchored to another window, or unanchored. */
  countConversationFactsOutsideWindows(sourceId: string, slug: string, keys: readonly string[]): Promise<number>;
  /** Clears a page's prior extractor batch before a replacement, keeping the history other records depend on: a row an open loop or another fact's `superseded_by` references is expired, never deleted, and rows `gbrain repair conversation-labels` retired stay expired. */
  clearConversationPageFacts(sourceId: string, slug: string, windows?: { keys: readonly string[]; keep: boolean; unanchored: boolean }): Promise<number>;
  /** The oldest active fence row of the page holding the same claim and source, whatever its visibility. */
  findSameClaimFenceRow(sourceId: string, slug: string, fact: string, source: string | null): Promise<{ id: number | string; visibility: string } | null>;
  /** An ontology observation the page already holds at the same key as fact `factId` (preferring an active one). */
  findOntologyTwin(sourceId: string, slug: string, factId: number): Promise<{ id: number | string } | null>;
  /** The source row a relink publication checks before it writes (null when the source is not registered). */
  readRelinkSource(sourceId: string): Promise<FactsConversationSql.RelinkSourceRow | null>;
  /** Whether the brain has the `fact_relink_attempts` table. */
  factRelinkAttemptsTableExists(): Promise<boolean>;
  /** The page's newest active terminal outcome row and the content hash of its live page (null when it has none). */
  readReextractOutcomeRow(sourceId: string, slug: string): Promise<{ id: number | string; hash: string } | null>;
  /** Derived rows of these pages that sit on an unbacked name key, in (page, id) order. */
  listUnbackedConversationRows(sourceId: string, slugs: string[]): Promise<FactsConversationSql.UnbackedConversationRow[]>;
  /** Derived rows of these pages that are live and have no entity, in (page, id) order. */
  listUnlinkedConversationRows(sourceId: string, slugs: string[]): Promise<FactsConversationSql.UnlinkedConversationRow[]>;
  /** The live pages among `slugs` with their retirement and folder-restriction flags. */
  listEntityHintPages(sourceId: string, slugs: string[]): Promise<FactsConversationSql.EntityHintPageRow[]>;
  /** Locks one page row until the transaction ends. */
  lockPageById(pageId: number): Promise<void>;
  /** The page's expired conversation facts that a relink had linked to a still-live entity page, newest first. */
  listClearedRelinkedFacts(sourceId: string, slug: string): Promise<FactsConversationSql.ClearedRelinkedFactRow[]>;
  /** How many of the facts `ids` carry an embedding. */
  countEmbeddedFactsAmong(sourceId: string, ids: number[]): Promise<number>;
  // Facts statements, write path and recall pool reads (engine-sql/facts-trust.ts, facts-recall.ts)
  /** The durable receipt of a write still queued, running or recovering, or null. */
  readPendingWriteReceipt(principalKind: string, principalId: string, requestId: string): Promise<{ request_id: string; state: string } | null>;
  /** Takes a shared row lock on the source for the rest of the transaction. */
  lockSourceShared(sourceId: string): Promise<void>;
  /** The stale, embeddable facts for `model` and `dims` longer than `maxTokens` bytes, in id order. */
  listOversizedStaleFacts(opts: { sourceId?: string; model: string; dims: number; maxTokens: number }): Promise<FactsTrustSql.OversizedStaleFactRow[]>;
  /** The slug and title of each named live, non-retired person page of the source. */
  listLivePersonTitles(sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>>;
  /** The live page `slug` of the source, with the remote read floor when `excludePrivate`, or null. */
  readLiveFactEntityPage(sourceId: string, slug: string, excludePrivate?: boolean): Promise<{ slug: string; type: string | null } | null>;
  /** Takes the advisory lock that serializes changes to one memory setting for the rest of the transaction. */
  lockAgentWritebackSetting(key: string): Promise<void>;
  /** The active facts of the source extracted under `session` or whose context names the page, in id order. */
  listFactsToRetireFromPage(sourceId: string, session: string, slug: string, pattern: string): Promise<FactsTrustSql.RetireFactRow[]>;
  /** The pending decide proposals naming any of `ids`, both facts readable under `policy`, in proposal order. */
  listContestedProposalPairs(ids: number[], policy: FactsTrustSql.ContestedReadPolicy): Promise<FactsTrustSql.ContestedProposalPairRow[]>;
  /** The stored provenance (`facts.source`) of these facts of the source. */
  listFactProvenance(sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>>;
  /** Records every input of one derived row (idempotent), in the transaction that writes the row. */
  recordDerivationEdges(derived: FactsTrustSql.DerivationEdgeRef, sourceId: string | null, edges: readonly FactsTrustSql.DerivationEdgeRef[]): Promise<void>;
  /** Expires these facts of the source; returns how many rows it touched. */
  expireDerivedFacts(ids: number[], sourceId: string): Promise<number>;
  /** Deactivates these takes on pages of the source; returns how many rows it touched. */
  deactivateDerivedTakes(ids: number[], sourceId: string): Promise<number>;
  /** Soft-deletes these pages of the source; returns one row per page now hidden, `now` true when this call hid it (#9653). */
  softDeleteDerivedPages(ids: number[], sourceId: string): Promise<Array<{ id: number; now: boolean }>>;
  /** Marks each derived row of `table` as needing re-derivation; `hiddenNow` names the pages this call just hid (#9653). */
  markNeedsRederive(table: string, ids: string[], sourceId: string, requestId: string | null, reason: string, hiddenNow: string[]): Promise<void>;
  /** The withdrawal a remote save onto a member page meets, or null (GST-2346). */
  readMemberPageWithdrawal(q: FactsTrustSql.MemberPageWithdrawalQuery): Promise<FactsTrustSql.WithdrawalRow | null>;
  /** The visibility of one fact of the source, or null. */
  readFactVisibility(id: number, sourceId: string): Promise<{ visibility: string } | null>;
  /** The fact a `remember.replaces` names, with whether the withdrawal ledger covers it, or null. */
  readReplacementTarget(q: FactsTrustSql.ReplacementTargetQuery): Promise<FactsTrustSql.ReplacementTargetRow | null>;
  /** One fact of a supersede pair by id, `lock` taking the row lock; the raw row, or null. */
  readPairFactRow(id: number, lock?: boolean): Promise<Record<string, unknown> | null>;
  /** Expires the old fact of an accepted supersede pair and links it to the new one; returns how many rows it touched. */
  expireSupersededFact(q: { oldId: number; sourceId: string; newId: number; until: string | null }): Promise<number>;
  /** Puts the old fact of an undone supersede pair back as it was; returns how many rows it touched. */
  restoreSupersededFact(q: { oldId: number; sourceId: string; expiredAt: string | null; validUntil: string | null; supersededBy: number | null; expectedSupersededBy: number | null }): Promise<number>;
  /** The columns a forget decides on, for one fact by id, or null. */
  readFactForForget(id: number): Promise<FactsTrustSql.ForgetFactRow | null>;
  /** Expires an active fact for a supersession or retirement (`validUntil` or now ends it). */
  expireFactSuperseded(factId: number, validUntil: string | null): Promise<void>;
  /** Ends an active fact on `today` and expires it. */
  expireFactAtDate(factId: number, today: string): Promise<void>;
  /** Whether the withdrawal ledger covers this fact of the source, or null when the fact is not there. */
  readWithdrawalAnchor(factId: number, sourceId: string): Promise<{ withdrawn: boolean } | null>;
  /** Whether this fact of the source is active, and the md5 of its text, or null. */
  readFactActivity(id: number, sourceId: string): Promise<{ active: boolean; text_hash: string } | null>;
  /** The fact, when it is expired and its context carries `mark`, or null. */
  readReviewAcceptedMark(id: number, sourceId: string, mark: string): Promise<{ id: number } | null>;
  /** Whether index `name` is valid, and its definition; null when there is no such index. */
  readFactsFtsIndexState(name: string): Promise<{ valid: boolean; def: string } | null>;
  /** Swaps the built `idx_facts_fts_next` into place (two renames), in the caller's transaction. */
  swapFactsFtsIndex(): Promise<void>;
  /** The type and declared dimensions of the facts embedding column, or null. */
  readFactsEmbeddingColumn(): Promise<{ type: string; dims: number } | null>;
  /** The pool facts nearest a query embedding by cosine distance under the pool read policy. */
  listNearestFacts(q: FactsRecallSql.NearestFactsQuery): Promise<FactsRecallSql.PoolFactRow[]>;
  /** Every active conversation slot row of the given slots under the pool read policy, by valid_from, id. */
  listSlotRows(scope: FactsTrustSql.FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<FactsRecallSql.SlotFactRow[]>;
  /** The (source, entity) pairs among `keys` that hold an active pool fact and have no live page. */
  listPoolUnbackedKeys(scope: FactsTrustSql.FactPoolScope, keys: readonly string[], limit: number): Promise<Array<{ source_id: string; entity_slug: string }>>;
  /** The newest cue facts that retract or call off a fact, per (source, entity) pair, under the pool read policy. */
  listCallOffCueFacts(scope: FactsTrustSql.FactPoolScope, pairs: ReadonlyArray<{ source_id: string; entity_slug: string }>): Promise<FactsRecallSql.CueFactRow[]>;
  /** The distinct (source, entity) pairs with a fact in the authorized, filtered pool. */
  listPoolEntityPairs(scope: FactsTrustSql.FactPoolScope, filters: FactsTrustSql.FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>>;
  /** The whole fact rows of these ids within these sources. */
  listFactRowsByIds(sourceIds: readonly string[], ids: readonly number[]): Promise<FactsRecallSql.FactRowSqlShape[]>;


  /** True when the source's `config.canonical` is `git` (a git-canonical source); false for anything else, including an unknown id. */
  getSourceStrictness(sourceId: string): Promise<boolean>;

  /** The brain's persistence identity (`persistence_brain.brain_id`), or null when the schema holds no such row. */
  readPersistenceBrainId(): Promise<string | null>;

  /**
   * Declares persistence protocol 2 for the current transaction (`gbrain.persistence_protocol`), with the durable-write
   * settings when given, and returns the brain's persistence id read under the brain row's share lock (null when the
   * row is missing). Outside a transaction the declaration ends with its statement. engine-sql/persistence-declaration.ts.
   */
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }): Promise<string | null>;
  /** Synchronous commit for the rest of the current transaction (engine-sql/persistence-declaration.ts); nothing outside one. */
  requireSynchronousCommit(): Promise<void>;

  /** One local writer registration row (lane, credential hash, grant ceiling, revoked_at), or undefined; `lock` reads it `FOR SHARE`. */
  readLocalWriterRow(id: string, opts?: { lock?: boolean }): Promise<LocalWriterRow | undefined>;

  /** Registers a local writer unless its id or credential hash is already registered; true when this call inserted the row. */
  insertLocalWriterRow(row: LocalWriterInsert): Promise<boolean>;
  /** Revokes a local writer registration, keeping an earlier revocation time; true when the registration exists. */
  revokeLocalWriterRow(id: string): Promise<boolean>;
  /** An OAuth client's receipt grant row, deleted or not, or undefined; `lock` reads it `FOR SHARE` (engine-sql/access-grants.ts). */
  readOAuthClientReceiptGrant(clientId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.ReceiptClientGrant | undefined>;
  /** An access token's receipt grant row, revoked or not, or undefined; `lock` reads it `FOR SHARE`. */
  readAccessTokenReceiptGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.ReceiptTokenGrant | undefined>;
  /** A live (not deleted) OAuth client's membership grant row read `FOR SHARE` (unless `lock` is false), or undefined. */
  readOAuthClientMemberGrant(clientId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.MemberClientGrant | undefined>;
  /** A live (not revoked) access token's grant columns read `FOR SHARE` (unless `lock` is false), or undefined. */
  readAccessTokenMemberGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessGrantsSql.MemberTokenGrant | undefined>;
  /** A local writer's grant ceiling and revoked_at read `FOR SHARE`, revoked or not, or undefined. */
  readLocalWriterMemberGrant(id: string): Promise<AccessGrantsSql.MemberLocalWriterGrant | undefined>;
  /** The shared-skill serving epoch, or null when the brain has no shared-skill state row. */
  readSharedSkillServingEpoch(): Promise<string | null>;

  // Shared-skill membership (engine-sql/shared-skill-members.ts): the rows join_brain, sync_brain_skills, leave_brain and the catalog read.
  /** The brain id, the catalog token secret and the serving epoch, or undefined without the brain or shared-skill state row. */
  readSharedSkillCatalogIdentity(): Promise<SharedSkillMembersSql.SharedSkillCatalogIdentity | undefined>;
  /** The live shared-skill heads of live sources that match the query, in key order, at most `limit` rows. */
  listSharedSkillCatalogHeads(query: SharedSkillMembersSql.SharedSkillHeadQuery): Promise<SharedSkillMembersSql.SharedSkillHeadRow[]>;
  /** A source incarnation's stored publication policy and epoch, or undefined; `lock` reads it `FOR SHARE`. */
  readSharedSkillPolicyRow(sourceId: string, incarnation: string, lock: boolean): Promise<{ epoch: string; policy: unknown } | undefined>;
  /** Upserts a source incarnation's publication policy under a new epoch and appends its audit row. */
  writeSharedSkillPolicy(write: SharedSkillMembersSql.SharedSkillPolicyWrite): Promise<void>;
  /** Inserts a published revision and moves its head; the SQL engines' publication guard refuses it outside a coordinated write. */
  writeSharedSkillRevision(write: SharedSkillMembersSql.SharedSkillRevisionWrite): Promise<void>;
  /** One stored shared-skill revision that is not deleted, or undefined. */
  readSharedSkillRevision(key: SharedSkillMembersSql.SharedSkillRevisionKey): Promise<StoredSkillRevision | undefined>;
  /** The live sources in both id lists (null matches all), by id, at most 65 rows. */
  listSharedSkillFollowSources(allowed: string[] | null, sourceIds: string[] | null): Promise<Array<{ id: string; incarnation: string }>>;
  /** The persistent brain id locked `FOR UPDATE`, or undefined without the row. */
  lockSharedSkillBrainId(): Promise<string | undefined>;
  /** One shared-skill member locked `FOR UPDATE`, or undefined; by installation id it matches only under its own principal. */
  readSharedSkillMember(by: SharedSkillMembersSql.SharedSkillMemberLookup): Promise<SharedSkillMembersSql.SharedSkillMemberRow | undefined>;
  /** The number of shared-skill members, active or not. */
  countSharedSkillMembers(): Promise<number>;
  /** Inserts a shared-skill member or re-activates the one with its installation id at the next epoch. */
  enrollSharedSkillMember(spec: SharedSkillMembersSql.SharedSkillMemberEnroll): Promise<void>;
  /** Sets an active member's narrowed follow policy and epoch, and resets its sequences and views. */
  rebindSharedSkillMember(installationId: string, followPolicy: unknown, epoch: number): Promise<void>;
  /** Marks a shared-skill member inactive. */
  leaveSharedSkillMember(installationId: string): Promise<void>;
  /** Issues a delivery batch for a member: prune, reuse or insert, retention trim and the seen mark, in order. */
  issueSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchIssue): Promise<SharedSkillMembersSql.SharedSkillBatchIssued>;
  /** A member's batch under this epoch issued within 24 hours, locked `FOR UPDATE`, or undefined. */
  readSharedSkillDeliveryBatch(token: string, installationId: string, epoch: number): Promise<SharedSkillMembersSql.SharedSkillBatchRow | undefined>;
  /** Records a batch's acknowledgment evidence and, with `advance`, the member's acknowledged sequence and view. */
  acknowledgeSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchAcknowledge): Promise<void>;

  // Write-journal statements (engine-sql/persistence-journal.ts): the text journal.ts, limits.ts and held-reads.ts sent through executeRaw.
  /** The journal limit config rows, then one row with a null key: the largest page stored in segments, or 'unindexed'. */
  readJournalLimitRows(): Promise<Array<{ key: string | null; value: string | null }>>;
  /** The current-incarnation hold rows (`record`, page `revision`) naming these page ids, in fingerprint order. */
  readHeldPageRows<R = Record<string, unknown>>(pageIds: string[]): Promise<Array<{ record: R; revision: string | null }>>;
  /** The held-file summary rows of live sources with at least one held file, in source order; null reads every source. */
  readHeldCoverageRows(sourceIds: string[] | null): Promise<HeldCoverageRow[]>;
  /** The held fence results of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first (`listFenceHolds`, engine-sql/fence-holds.ts). */
  listFenceHoldRows(sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string): Promise<FenceHoldRow[]>;
  /** A fence publish's statements (generations/fence.ts, engine-sql/fence-holds.ts): whether the page is deleted or gone, the generation key lock, the held rows a readable fence clears, and the held pages' file state. */
  readFenceOriginGone(sourceId: string, slug: string): Promise<boolean>;
  lockGenerationKey(lockKey: string): Promise<void>;
  clearFenceHoldRows(key: FenceHoldKey): Promise<void>;
  readFenceHoldFiles(sourceIds: readonly string[], slugs: readonly string[]): Promise<FenceHoldFileRow[]>;
  /** The generation ledger statements of generations/publish.ts (engine-sql/derived-generations.ts): the live generation with its items, a new generation's activation, and a held result. */
  readLiveGenerationRow(key: GenerationRowKey): Promise<LiveGenerationRow | null>;
  activateGenerationRows(key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow, items: readonly GenerationLedgerRow[]): Promise<number>;
  recordHeldGenerationRow(key: GenerationRowKey, row: HeldGenerationRow): Promise<void>;
  /** The git sync hold records of each source's current incarnation, by source then fingerprint (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldRecords<R = Record<string, unknown>>(opts?: GitHoldRecordsQuery): Promise<Array<{ record: R }>>;
  /** The pending `sources retry-held` request's keys for one source incarnation's fingerprint, or null (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldRetryRequest(fingerprint: string): Promise<Array<{ paths?: unknown }> | null>;
  /** A sync hold report's summary counters (null when none) and the source's `mirror_read_only` text (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldReportInputs(sourceId: string, fingerprint: string): Promise<GitHoldReportInputs>;
  /** The source's purge epoch as stored, which every fact purge bumps, or null for an unknown source (SQL in engine-sql/sync-reason-reads.ts). */
  readSourcePurgeEpoch(sourceId: string): Promise<string | number | null>;
  // The git sync hold store (SQL in engine-sql/sync-hold-store.ts); sync-holds.ts keeps the hold semantics.
  /** Creates the source incarnation's hold summary row when missing, else touches it (Postgres: locks it); returns its count. */
  lockGitHoldSummary(sourceId: string, incarnation: string): Promise<number>;
  /** Adds `delta` to the hold summary's count and each weight to its counter, none below zero; no summary row, no write. */
  adjustGitHoldSummary(sourceId: string, incarnation: string, delta: number, weights: GitHoldSummaryWeights): Promise<void>;
  /** The hold record at `path` of the source incarnation as stored, or null. */
  readGitHoldRow<R = Record<string, unknown>>(sourceId: string, incarnation: string, path: string): Promise<R | null>;
  /** Stores `record` as the hold at `path`, replacing any. */
  writeGitHoldRow(sourceId: string, incarnation: string, path: string, record: object): Promise<void>;
  /** Replaces the hold at `path` with `next` only while it is still `expected` (JSON equality); true when it landed. */
  replaceGitHoldRow(sourceId: string, incarnation: string, path: string, expected: object, next: object): Promise<boolean>;
  /** Deletes the hold at `path`; no hold, no change. */
  deleteGitHoldRow(sourceId: string, incarnation: string, path: string): Promise<void>;
  /** The source incarnation's outstanding holds (its summary's count), 0 without a summary. */
  countGitHolds(sourceId: string, incarnation: string): Promise<number>;
  /** The managed sync pass row of one source incarnation, or null (SQL in engine-sql/sync-hold-store.ts). */
  readSyncPassRow<V = Record<string, unknown>>(sourceId: string, incarnation: string): Promise<SyncPassRowRead<V> | null>;
  /** The managed sync pass rows of the sources' live incarnations (null: every source), in no set order. */
  readLiveSyncPassRows<V = Record<string, unknown>>(sourceIds: readonly string[] | null): Promise<Array<SyncPassRowRead<V> & { source_id: string }>>;
  /** Writes the managed sync pass row under its lease fence; false when it did not land (persistence/sync-pass-row.ts writePassRow). */
  writeSyncPassRow(sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts?: SyncPassRowWrite): Promise<boolean>;
  /** A source's sync point and pending write requests, for the applied watermark (SQL in engine-sql/applied-watermark-reads.ts). */
  readWriteWatermarkRow(sourceId: string): Promise<WriteWatermarkRow>;
  /** A source's incarnation and its checkout on host `hostId` (else the source's path); null when absent. */
  readSourceCheckoutRoot(sourceId: string, hostId: string | null): Promise<SourceCheckoutRoot | null>;
  /** The source's pages still waiting for an embedding in `column`: count, oldest edit, budget-held count. */
  readUnembeddedPageSummary(sourceId: string, column: string): Promise<UnembeddedPageSummary>;
  /** publishGeneration's producer-path statements: held rows of one input, a held row's context, the identical replay, the attempt counter and the valve. */
  heldGenerationRowsForInput(key: GenerationRowKey, pin: string): Promise<HeldInputRow[]>;
  readHeldGenerationContext(key: GenerationRowKey, holdId: string): Promise<{ held_context: Record<string, unknown> | null } | null>;
  liveGenerationForOperation(operationId: string): Promise<number | null>;
  countGenerationAttempt(key: GenerationRowKey, holdId: string, code: string): Promise<GenerationAttemptCount>;
  clearGenerationAttempts(holdId: string): Promise<void>;
  /** The consolidation ledger statements of generations/adapters/fact-rows.ts: whether a key's live row is a restore, and the clear of one entity's `tie` holds (`ownerPrefix` is compared over its JavaScript length). */
  readGenerationRestored(key: GenerationRowKey): Promise<boolean>;
  clearTieHeldGenerationRows(sourceId: string, kind: string, ownerPrefix: string): Promise<void>;
  readGenerationValve(key: GenerationRowKey, windowKey: string): Promise<GenerationValveRow>;
  bumpGenerationValve(key: GenerationRowKey, windowKey: string, retired: number): Promise<void>;
  /** The purge scrub of the generation ledger (generations/ledger-scrub.ts, engine-sql/generation-ledger.ts): one page's rows, or every row whose text carries a needle. */
  scrubGenerationPageRows(sourceId: string, fenceKinds: readonly string[], slug: string): Promise<LedgerScrubCounts>;
  scrubGenerationTextRows(sourceId: string, needles: readonly string[]): Promise<LedgerScrubCounts>;
  /** The managed activation rows of generations/managed.ts (engine-sql/generation-activations.ts): record, flip, member gate, settle and the two operator lists. */
  recordGenerationActivation(key: GenerationRowKey, row: GenerationActivationRecord): Promise<void>;
  markGenerationActivated(activationId: string, generationId: number): Promise<void>;
  readGenerationActivationState(activationId: string, slug: string, sourceId: string): Promise<GenerationActivationState | null>;
  settleGenerationMember(activationId: string, slug: string): Promise<void>;
  listPendingGenerationMembers(sourceIds: readonly string[], kind: string | null): Promise<PendingGenerationMemberRow[]>;
  listGenerationOrphanCandidates(sourceIds: readonly string[], kind: string | null): Promise<GenerationOrphanRow[]>;
  /** The reads of gbrain repair generations (engine-sql/generation-repair.ts); the three lists take the typed selector filter. */
  readGenerationItemsByIds(generationIds: readonly number[]): Promise<GenerationRepairItemRow[]>;
  listUnmatchedGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<UnmatchedGenerationRow[]>;
  listRestorableGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<RestorableGenerationRow[]>;
  listHeldGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<HeldGenerationListRow[]>;
  readHeldGenerationProposal(id: number): Promise<HeldGenerationProposalRow | null>;
  /** The incarnation of each known source of `sourceIds` as text, in id order (the preview hash of a repair binds it). */
  listSourceIncarnations(sourceIds: readonly string[]): Promise<SourceIncarnationListRow[]>;
  /** The fence evidence statements of generations/fence-evidence.ts (engine-sql/generation-fence-evidence.ts, #8819). */
  listRecordedFenceItemKeys(key: GenerationRowKey, itemKeys: readonly string[]): Promise<Array<{ item_key: string }>>;
  hasBodylessPageVersion(sourceId: string, slug: string): Promise<boolean>;
  listFenceVersionBodies(sourceId: string, slug: string, before: number | null, limit: number): Promise<FenceVersionBodyRow[]>;
  moveKeptFactRows(sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]): Promise<void>;
  /** The fence restore reads of generations/fence-restore.ts (engine-sql/generation-fence-restore.ts). */
  readGenerationFenceBlocks(generationIds: readonly number[]): Promise<GenerationFenceBlockRow[]>;
  listOwnedGenerationItems(generationIds: readonly number[]): Promise<GenerationOwnedItemRow[]>;
  readLiveGenerationId(key: GenerationRowKey): Promise<{ id: number | string } | null>;
  /** The page rows a page generation adapter reads, deleted rows included, by slug (engine-sql/generation-page-rows.ts). */
  readGenerationPageRows(query: GenerationPageRowsQuery): Promise<GenerationPageRow[]>;
  /**
   * The Life Chronicle event statements (engine-sql/chronicle-events.ts): the depth page row, the ledger's owned event
   * hashes and skip decisions, the chronicle items a generation retired or holds live, the event projection rows (read,
   * deleted, restored), page content hashes and event slot fields, and the live generations whose depth page is gone.
   */
  readChronicleDepthRow(sourceId: string, slug: string): Promise<ChronicleEventsSql.ChronicleDepthRow | null>;
  listChronicleOwnedHashes(sourceId: string, pageId: number): Promise<string[]>;
  listRetiredGenerationItemKeys(sourceId: string, kind: string, itemKeys: readonly string[]): Promise<string[]>;
  listEventProjectionRows(eventPageIds: readonly number[]): Promise<ChronicleEventsSql.EventProjectionRow[]>;
  listPageContentHashes(query: ChronicleEventsSql.PageContentHashQuery): Promise<ChronicleEventsSql.PageContentHashRow[]>;
  listLiveGenerationItems(key: GenerationRowKey): Promise<Array<{ item_key: string; identity_hash: string }>>;
  readEventProjectionId(eventPageId: number, date: string): Promise<number | null>;
  pageSlugExists(sourceId: string, slug: string): Promise<boolean>;
  deleteEventProjections(sourceId: string, slugs: readonly string[]): Promise<void>;
  restoreEventProjection(row: ChronicleEventsSql.EventProjectionRestore): Promise<void>;
  hasChronicleSkipDecision(decision: ChronicleEventsSql.ChronicleSkipDecision): Promise<boolean>;
  listOrphanedChronicleOwners(sourceId: string, kind: string, limit: number): Promise<string[]>;
  listChronicleEventSlotRows(sourceId: string, slugs: readonly string[]): Promise<ChronicleEventsSql.ChronicleEventSlotRow[]>;
  /** The atom adapter's reads (engine-sql/generation-atom-reads.ts): a live page origin's input pin, the stored versions a producer wrote, committed managed atom receipts. */
  readAtomOriginInput(sourceId: string, slug: string): Promise<AtomOriginInputRow | null>;
  listProducerVersionRows(sourceId: string, slugs: readonly string[], producer: GenerationVersionProducer): Promise<ProducerVersionRow[]>;
  listAtomWriteReceipts(sourceId: string, slugs: readonly string[]): Promise<AtomWriteReceiptRow[]>;
  /** The request a principal admitted under `requestId` (a uuid), or null. */
  readWriteRequest(principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null>;
  /** At most two requests with this request_id (a uuid), from any principal, in no set order. */
  readWriteRequestsByRequestId(requestId: string): Promise<WriteRequest[]>;
  /** The request with journal id `id`, or null; `signal` cancels the read. */
  readWriteRequestById(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequest | null>;
  /** A principal's requests in one live source, newest sequence first, through the cursor and fences (list_write_requests). */
  listWriteRequestRows(principalKind: string, principalId: string, sourceId: string, filter: WriteRequestListFilter): Promise<WriteRequest[]>;
  /** The progress columns of request `id` (state, error, outcome, deferral), or null; `signal` cancels the read. */
  readWriteRequestProgress(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequestProgress | null>;
  /** The sources holding outstanding (queued, deferred, running, recovering) requests of one principal, as `{ source_id, n }`: the most first, a tie in byte order of the source id. */
  countOutstandingBySource(principalKind: string, principalId: string): Promise<OutstandingBySource[]>;
  /** Whether this connection's role owns the gbrain tables (so it can apply migrations); false only when it provably does not. */
  ownsSchemaTables(): Promise<boolean>;
  /** The live grant row of the OAuth client that owns a write, or null; `lock` holds it FOR SHARE so a revocation waits. */
  readOAuthClientWriteGrant(clientId: string, opts?: { lock?: boolean }): Promise<OAuthClientWriteGrant | null>;
  /** The live grant row of the legacy token that owns a write (the token grant columns this brain has, and revoked_at), or null; `lock` as above. */
  readAccessTokenWriteGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessTokenWriteGrant | null>;
  /** Holds the OAuth client or legacy token row FOR SHARE for the caller's transaction (a missing row locks nothing). */
  shareLockWriteCredential(kind: 'oauth_client' | 'legacy_token', id: string): Promise<void>;
  /** The existing counter rows of `keys` in key byte order, without a lock (a missing key has no row). */
  readCounterRows(keys: readonly string[]): Promise<CounterRow[]>;
  /** The brain's first request id and a sample of the latest 1,000 admissions (one principal's, or the brain's): count, age of the oldest, mean reservation, mean compacted size. `{ sample: false }` reads only the first request id. */
  readAdmissionRate(principal: { kind: string; id: string } | null, opts?: { sample?: boolean }): Promise<AdmissionRate>;
  /** Creates the missing counter rows and locks them all FOR UPDATE in key order; returns the locked rows. */
  lockPersistenceCounters(keys: readonly string[]): Promise<CounterRow[]>;
  /** Inserts an admitted request and charges its (already locked) counters; returns the stored row. */
  insertWriteRequest(row: WriteRequestInsert): Promise<WriteRequest>;
  /** Stamps a claim (running, token, lease, first phase) on request `id`; null when the refresh barrier refused it. */
  stampWriteClaim(id: string, token: string, leaseMs: number, phaseJson: string): Promise<ClaimedWriteRow | null>;
  /** Request `id` locked FOR UPDATE until the transaction ends, or null. */
  lockWriteRequest(id: string): Promise<WriteRequest | null>;
  /** Records a request's terminal state and releases its counters; null when the result exceeds its reservation. */
  completeWriteRow(completion: WriteCompletion): Promise<CompletedWriteRow | null>;
  /** Cancels a request still queued as the caller read it, in one step: lock, check, complete, release its counters; null when it does not exist. */
  cancelWriteRow(cancel: WriteCancellation): Promise<WriteCancelResult | null>;
  /** Inserts a publication's effects in queue order (a gated one only while auto-linking is on); returns the kinds inserted. */
  insertPublicationEffects(spec: PublicationEffectsSpec): Promise<string[]>;
  /** Queues a managed-request withdrawal's three effects for its source; an unknown source queues none, a kind already queued is kept. */
  insertWithdrawalEffects(spec: WithdrawalEffectsSpec): Promise<void>;
  // Write-claim statements (engine-sql/persistence-claims.ts): the text journal.ts, authority.ts and consumer.ts sent through executeRaw.
  /** A source's incarnation and archive flag, or null; `lock` reads it FOR SHARE (`'update'`: FOR UPDATE) until the transaction ends. */
  readSourceMembership(sourceId: string, opts?: { lock?: boolean | 'update' }): Promise<SourceMembership | null>;
  /** `[{ request_id }]` for the first of `requestIds` a topology change of local writer `principalId` used, or []. */
  findTopologyChanges(principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>>;
  readTopologyChange(principalId: string, requestId: string): Promise<TopologyChange | null>;
  insertTopologyChange(row: TopologyChangeInsert): Promise<TopologyChange>;
  /** Extends a claim's lease (and records its phase); true while the request is running under the token. Postgres sends it on the direct pool. */
  renewWriteClaim(renewal: ClaimRenewal, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Returns a claim that never began to publish to queued under its token; `direct` sends it on the Postgres direct pool. */
  releaseUnpublishedClaim(release: ClaimRelease, opts?: { direct?: boolean }): Promise<void>;
  /** Returns expired claims and claims of dead owners to queued, at most 100; `direct` sends it on the Postgres direct pool. */
  expireStaleWriteClaims(expiry: ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<void>;
  /** Whether a claim would find a row now; `priority` overrides the foreground-priority config row when set. */
  hasClaimableWrite(hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }): Promise<boolean>;
  /** The request a FIFO claim takes next, locked FOR UPDATE SKIP LOCKED until the transaction ends, or null (journal.ts `claimNextWrite`). */
  selectClaimableWrite<R = Record<string, unknown>>(spec: ClaimHeadSpec): Promise<R | null>;
  /** Consumer rows (persistence/consumer-heartbeat.ts): the host's rows oldest first, and its live full rows other than the caller's. `direct`: the Postgres direct pool. */
  listHostConsumerRows(hostId: string, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<ConsumerRowRead[]>;
  probeLiveConsumerRows(probe: ConsumerProbe, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<ConsumerRowRead[]>;
  /** The heartbeat's renewal (purges the host's lapsed rows), its row delete and its worktree stamp; Postgres sends each on the direct pool. */
  renewConsumerRow(renewal: ConsumerRenewal, opts?: { signal?: AbortSignal }): Promise<void>;
  deleteConsumerRow(key: ConsumerRowKey, opts?: { signal?: AbortSignal }): Promise<void>;
  stampWorktreeHeartbeats(hostId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  // Housekeeping statements (engine-sql/persistence-housekeeping.ts): the text housekeeping-turn.ts, compaction-pass.ts, journal.ts,
  // receipt-true-up.ts, capacity-forecast.ts and the projection queue readers sent through executeRaw after a write.
  /** Leases this host's housekeeping turn; true when it was free. `direct` sends it on the Postgres direct pool. */
  claimHousekeepingTurn(claim: HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<boolean>;
  /** Marks this host's leased housekeeping turn finished. `direct` sends it on the Postgres direct pool. */
  completeHousekeepingTurn(turn: { op: string; hostId: string }, opts?: { direct?: boolean }): Promise<void>;
  /** The explicit receipt retention (null when unset), the brain's reserved terminal bytes and now minus `floorDays`, as text. */
  readReceiptBudget(retentionKey: string, floorDays: number): Promise<ReceiptBudget>;
  /** Up to 100 compactable receipts completed over `retentionDays` ago, oldest first, without unresolved caller refusals or open-sync rows. */
  listCompactableReceipts<R = Record<string, unknown>>(retentionDays: number): Promise<R[]>;
  /** `{ id, sequence, compacted }` of up to `limit` requests after sequence `after`, in sequence order. */
  listReservationsAfter(after: string, limit: number): Promise<Array<{ id: string; sequence: string; compacted: boolean }>>;
  /** The terminal requests among `ids` with their effect bytes and whether an effect is unfinished, in sequence order. */
  listTrueUpRequests<R = Record<string, unknown>>(ids: readonly string[]): Promise<R[]>;
  /** Inside the true-up's transaction, after its counter locks: shrinks each unchanged settled request to what its receipt keeps and releases the freed bytes from the counters; returns the bytes given back. */
  trueUpReservations(rows: readonly TrueUpReservation[]): Promise<number>;
  /** The capacity forecast's reads: counters, per-day principal and topology rows, history, reclaimable bytes and the table size. */
  readCapacityForecastInputs(opts?: { light?: boolean }): Promise<CapacityForecastInputs>;
  /** Pending segmented-page projection jobs ready to rebuild, oldest first. */
  listPendingSegmentedProjections(filter: SegmentedProjectionFilter): Promise<PendingSegmentedProjection[]>;
  /** The resident projection pass's window of pending jobs after `cursor`, with the high-water row last. */
  selectProjectionWindowJobs(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): Promise<ProjectionWindowRow[]>;
  // The segmented projector's queue writes (page-body/projection.ts). `claim` is `segmented_projecting:<uuid>`, unique to one build.
  /** Claims the page's queued job unless another live claim holds it: `claimed`, `held`, or `absent` when the page has no job. */
  claimSegmentedProjection(ref: ProjectionPageRef, claim: string): Promise<SegmentedProjectionClaimOutcome>;
  /** Moves this build's claim to now, in the caller's transaction when it has one; false when the job no longer carries `claim`. */
  renewSegmentedProjectionClaim(ref: ProjectionPageRef, claim: string): Promise<boolean>;
  /** Puts a job that still carries `claim` back to `canonical_change`, so another build can take it. */
  releaseSegmentedProjectionClaim(ref: ProjectionPageRef, claim: string): Promise<void>;
  /** Deletes the job when it is still queued at `job.revision` (the page sealed at that revision). */
  deleteProjectionJob(job: ProjectionJobRef): Promise<void>;
  /** Marks a job still queued at `job.revision` and not under a live claim `rebuild_failed`, starting its retry window. */
  markProjectionRebuildFailed(job: ProjectionJobRef): Promise<void>;
  // Effect scans (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass sent through executeRaw.
  /**
   * Up to 100 requests on worktrees `hostId` owns whose failed withdrawal mirror is parked by `gateCode` and whose other
   * unsettled effects are parked only with a code in `allowedCodes` (`resumeGatedMirrors`). A non-uuid host id refuses.
   */
  listGatedMirrorRequests(hostId: string, gateCode: string, allowedCodes: readonly string[]): Promise<GatedMirrorRequest[]>;
  /**
   * Up to `limit` effects on worktrees `hostId` owns with a recovery due now, in id order after effect id `after` (from
   * the start when null) (`selectEffectRecoveries`). A non-uuid host, a non-bigint `after` or a negative limit refuses.
   */
  listEffectRecoveries<R = Record<string, unknown>>(hostId: string, after: string | null, limit: number): Promise<R[]>;
  /**
   * The next effect host `hostId` may claim, row-locked for the current transaction (rows another transaction holds are
   * skipped), or null; `deadOwners` are owner keys whose running effects are claimable now (`claimPersistenceEffect`).
   * A non-uuid host id refuses.
   */
  selectClaimableEffect<R = Record<string, unknown>>(hostId: string, deadOwners: readonly string[]): Promise<R | null>;
  /**
   * The effects of journal request `requestId` as its receipt reads them (state, error code, outcome, whether a recovery
   * is open), in kind order, or only its Git effect when `kind` is `'git'`. A non-uuid request id refuses.
   */
  readRequestEffects(requestId: string, kind?: 'git'): Promise<RequestEffectState[]>;

  // Owner scans (engine-sql/persistence-owner-scans.ts): the reads the write owner's housekeeping sent through executeRaw.
  /**
   * Up to 100 deferred writes on worktrees `hostId` owns whose `hold` (a refresh barrier, or an import that has not
   * landed) is past the wait limit `maxWaitMs`, in sequence order (`expireDeferredWrites`). A non-uuid host id refuses.
   */
  listOverdueHeldWrites<R = Record<string, unknown>>(hostId: string, maxWaitMs: number, hold: OverdueHoldKind, opts?: { signal?: AbortSignal }): Promise<R[]>;
  /**
   * Whether the hold an expiry scanned still stands, its row locked for the current transaction: the refresh still
   * unreleased, or the write still deferred on the same pending import and past its limit (`expireDeferredWrites`).
   */
  lockOverdueHold(hold: OverdueHold): Promise<boolean>;
  /**
   * The oldest recovering write of each worktree `hostId` owns that is not in `excluded`, at most 16 (the consumer's
   * recovery scan). `direct` takes the Postgres direct lane (the consumer passes `consumerOnDirectLane`). A non-uuid
   * host id refuses.
   */
  listOwnerRecoveryHeads<R = Record<string, unknown>>(hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }): Promise<R[]>;
  /**
   * The interrupted refreshes of worktrees `hostId` owns that the owner's topology scan converges, at most 16, a
   * syncing row last; each carries `stale` (no move for `budgetMs`). A non-uuid host id refuses.
   */
  listResumableRefreshes<R = Record<string, unknown>>(hostId: string, budgetMs: number): Promise<(R & { stale: boolean })[]>;
  /** The last commit of each named source that exists (null before its first sync), in source id order (the refresh resume's lag check). */
  listSourceLastCommits(sourceIds: readonly string[]): Promise<{ last_commit: string | null }[]>;

  // Effect worker (engine-sql/persistence-effect-worker.ts): the claim stamp and the statements that settle a claim,
  // which effect-journal.ts sent through executeRaw. Each settle statement matches only effect `id` still claimed under
  // `token` (a null token matches none), so a claim that moved changes nothing.
  /** Claims effect `id` under `token` (running, a 2-minute lease, one more attempt): the claimed row, or null when no effect has the id. */
  stampEffectClaim<R = Record<string, unknown>>(claim: EffectClaim): Promise<R | null>;
  /**
   * Extends an effect claim's lease by 2 minutes; true while it is running under the token with no recovery. `direct`
   * runs it on the Postgres direct lane (`executeRawDirect`), outside any pooled transaction.
   */
  renewEffectClaim(claim: EffectClaimRef, opts?: { direct?: boolean }): Promise<boolean>;
  /** Requeues a claimed effect (no recovery) due now with its scan cursor at `slug` (`advanceEffectCursor`). */
  advanceEffectRow(claim: EffectClaimRef & { slug: string }): Promise<void>;
  /** Finishes a claimed effect (no recovery) with `outcomeJson`: committed, or failed `targets_parked` when it parked targets. */
  completeEffectRow(claim: EffectClaimRef & { outcomeJson: string }): Promise<void>;
  /** Requeues a claimed effect after `delayMs` with error code `reason`, a claim under recovery included. */
  retryEffectRow(claim: EffectClaimRef & { reason: string; delayMs: number }): Promise<void>;
  /** Requeues a claimed effect as `writer_busy` after `delayMs`, merging `dataJson` (the busy streak) into its data. */
  retryBusyEffectRow(claim: EffectClaimRef & { dataJson: string; delayMs: number }): Promise<void>;
  /** Requeues a claimed effect (no recovery) with data `dataJson`, error code `reason`, after `delayMs`. */
  requeueEffectRow(claim: EffectClaimRef & { dataJson: string; reason: string | null; delayMs: number }): Promise<void>;
  /** Fails a claimed effect (no recovery) as `targets_parked` with data `dataJson`. */
  parkEffectRow(claim: EffectClaimRef & { dataJson: string }): Promise<void>;
  /** Fails a claimed effect (no recovery) with error code `reason`. */
  failEffectRow(claim: EffectClaimRef & { reason: string }): Promise<void>;
  /** The withdrawal mirrors that gate these requests (`mirrorGates`): each not committed, or committed with its publications. */
  readMirrorGateRows(requestIds: readonly string[]): Promise<MirrorGateRow[]>;
  /**
   * The effect guard's locks (`guardEffectSource`): share-locks the brain row, then the effect's worktree row, and
   * returns that worktree's owner and state; null without a worktree id or when the worktree row is gone.
   */
  lockEffectGuard(worktreeId: string | null): Promise<EffectWorktreeOwner | null>;
  /** Whether one of these requests has a target parked under `code` that its committed withdrawal mirror re-arms (`hasRearmableTargets`). */
  hasRearmableTargets(requestIds: readonly string[], code: string): Promise<boolean>;
  /**
   * The persistence consumer's idle probe (`persistence-idle-probe.ts`): whether any worker a full tick fans out to has
   * work now, and where the resident projection window stands. Runs on `opts.lane` (the consumer's reserved idle lane)
   * when given, else on the Postgres direct lane when `opts.direct`, else on the engine; `opts.signal` cancels it.
   */
  probeIdleWork(spec: IdleProbeSpec, opts?: { signal?: AbortSignal; lane?: ReservedConnection; direct?: boolean }): Promise<IdleProbeRow | null>;

  // No-op embedding settle (engine-sql/persistence-embedding-noop-settle.ts): the statements embedding-noop-settle.ts
  // sends to settle, in bulk, queued page embedding effects whose chunks already carry current vectors. The caller
  // runs the last three in one transaction and keeps the source guard, the cursor and the true-up.
  /** Whether an unattempted queued embedding effect lies past effect id `from` (`probeNoopEmbeddingSettle`). */
  probeNoopEmbeddingSettle(from: string): Promise<boolean>;
  /** The newest effect id, then the next `limit` unattempted embedding effects past `from`, locked skip-locked (`lockNoopEmbeddingWindow`). */
  lockNoopEmbeddingWindow(spec: { from: string; limit: number }): Promise<NoopSettleWindow>;
  /** The window effects the runner would find nothing to embed for, before their source guard; share-locks their pages (`readNoopEmbeddingCandidates`). */
  readNoopEmbeddingCandidates(spec: NoopSettleCandidateSpec): Promise<NoopSettleCandidate[]>;
  /** Settles these queued effects as the runner's claim and completion of a no-op leave them (`settleNoopEmbeddingRows`). */
  settleNoopEmbeddingRows(ids: readonly string[]): Promise<NoopSettledRow[]>;

  /**
   * The current value of each named transaction-local setting (`current_setting(name, true)`), in `names` order, null
   * where unset. On a transaction engine it reads inside that transaction. Names are code constants (dotted lowercase).
   */
  readTransactionSettings(names: readonly string[]): Promise<Array<string | null>>;

  /** Sets each named setting to the value at its index for the rest of the current transaction (`set_config(name, value, true)`), in one statement. */
  applyTransactionSettings(names: readonly string[], values: readonly string[]): Promise<void>;
  /** Starts the current transaction as one snapshot (`REPEATABLE READ`, and `READ ONLY` with `readOnly`); call it first. */
  beginSnapshotRead(opts?: { readOnly?: boolean }): Promise<void>;
  /**
   * Bounds every later statement of the current transaction to `ms` milliseconds (`SET LOCAL statement_timeout`).
   * `ms` is a non-negative integer. On the Rust engine it does nothing: the store has no statement timeout.
   */
  setLocalStatementTimeout(ms: number): Promise<void>;

  /**
   * The writer's trust declaration in force on this transaction: the raw `gbrain.write_trust_tier` and
   * `gbrain.write_origin` settings, each null (or '') where unset (persistence/context.ts `currentWriteTrust` parses them).
   */
  readCurrentWriteTrust(): Promise<{ tier: string | null; origin: string | null }>;

  /**
   * Establishes a coordinated write's context on the current transaction in one statement (persistence/context.ts
   * `withCoordinatedWrite`): source scope, actor (an enclosing actor is kept), trust (nests as min(outer, inner)) and the
   * git protocol. Sets nothing when the persistence identity row is missing (`brainId` null). `previous` holds the values
   * it replaced, '' where unset, in engine-sql/transaction-settings.ts WRITE_CONTEXT_SETTINGS order.
   */
  setWriteContext(input: WriteContextInput): Promise<WriteContextResult>;

  // The writer-version reads (engine-sql/writer-versions.ts): which binaries admitted and published the retained requests.
  /** When the brain started stamping writer versions (migration 178), as ISO text; null when not recorded. */
  readWriterVersionCutoff(): Promise<string | null>;
  /** The latest admitter and consumer version per host and principal across all retained requests, newest first, at most `limit`. */
  listWriterVersions(limit: number): Promise<WriterVersionRow[]>;
  /** Committed requests published in the last `days`, grouped per role, host, principal and version, stamped after the cutoff. */
  recentWriterVersions(days: number): Promise<RecentWriterVersionRow[]>;

  // The connect gate's persistence reads (engine-sql/connect-gate.ts): table probes, managed roots, graduation, retired epochs.
  /** Whether persistence table `table` exists (a brain before the persistence migrations has none). */
  hasPersistenceTable(table: PersistenceTable): Promise<boolean>;
  /** The managed roots host `hostId` binds, plus every source with a local path, in one snapshot. */
  listManagedRootBindings(hostId: string, opts?: { signal?: AbortSignal }): Promise<ManagedRootBindingRow[]>;
  /** The graduation custody row, or null; `withRunSetting` adds the run the current transaction declares. */
  readGraduationGateRow(opts?: { withRunSetting?: boolean }): Promise<GraduationGateRow | null>;
  /** The outcome of every committed writer deactivation. */
  listRetiredDeactivations(): Promise<RetiredDeactivationRow[]>;

  /**
   * What the belief ledger knows about one source (incarnation, purge epoch, newest coverage event, whether any purge
   * exists), or null for an unknown source. `batch` also returns the managed-mode rows and the plan-cache mode it
   * replaced, and switches the transaction to generic plans when coverage is active.
   */
  readLedgerSource(sourceId: string, opts?: { batch?: boolean }): Promise<LedgerSource | null>;
  /** The sources with a belief event about `subjectKey` in their current incarnation, by id (engine-sql/belief.ts). */
  listCoveredSources(subjectKey: string): Promise<string[]>;

  /**
   * Whether a page known by its slug sits under an applied folder rule, a pending or invalid folder prefix, or the
   * database role cannot read the folder access tables. A failed read throws; callers that count it as restricted catch.
   */
  isFolderRestricted(sourceId: string, slug: string): Promise<boolean>;

  /** Each source with folder access state and its newest applied folder-rule revision (null when none is applied), by source id. */
  listAppliedPolicyRevisions(): Promise<AppliedPolicyRevision[]>;

  /**
   * The live (enabled, not tombstoned) access member `key` names through `via` (the member id, the config key's value,
   * a live legacy token or a live OAuth client), with its groups; null when there is none. A failed read throws
   * unchanged (access/caller.ts tells a schema older than the member tables from a transient failure).
   */
  readLiveMember(via: MemberBindingVia, key: string): Promise<LiveMemberRow | null>;

  /**
   * The applied folder rules any of `readers` meets (none read when `readers` is empty) and every folder prefix that
   * reads as nobody, `!unreadable` included when this database role cannot read the folder access tables. Runs through
   * this engine's executeRaw; a failure throws (access/caller.ts folderAccessForAll counts it as fail closed).
   */
  readFolderAccess(readers: readonly string[]): Promise<FolderAccessRows>;

  // Session state (engine-sql/session-state.ts): the session_context_state statements context/session-state.ts ran
  // through executeRaw. Keys arrive resolved (client id and session id capped); a failure throws unchanged.
  /** Inserts or updates one session cursor row in one statement; resolves the row's incomplete-wake counter. */
  upsertSessionState(sourceId: string, clientId: string, sessionId: string, write: SessionStateWrite): Promise<number>;
  /** The session cursor row context_pack reads (wake time as microsecond ISO UTC text), or null when there is none. */
  readSessionCursor(sourceId: string, clientId: string, sessionId: string): Promise<SessionCursorRow | null>;
  /** delta's session row (both cursors as microsecond ISO UTC text, the counter as a number), or null when there is none. */
  readDeltaSessionRow(sourceId: string, clientId: string, sessionId: string): Promise<DeltaSessionRow | null>;
  /** The session's stored checkpoint manifest, or null when the session has no row. */
  readCheckpointManifestRow(sourceId: string, clientId: string, sessionId: string): Promise<{ checkpoint_manifest: unknown } | null>;
  /** Replaces the session's checkpoint manifest, creating the row when there is none. */
  writeCheckpointManifest(sourceId: string, clientId: string, sessionId: string, manifest: readonly unknown[]): Promise<void>;
  /** Deletes every session row last written more than `olderThanDays` (a whole number >= 1) days ago. */
  ageOutSessionState(olderThanDays: number): Promise<void>;
  /** Keeps the newest `maxRowsPerClient` (a whole number >= 1) session rows of each (source_id, client_id). */
  capSessionStatePerClient(maxRowsPerClient: number): Promise<void>;

  /**
   * The stored may_act_for of one caller (`via` names where it is stored; `key` is the token id, the client id or the
   * config key): a live token's or client's list, null when the row is revoked, deleted or absent; the stdio config text as stored.
   */
  readMayActFor(via: MayActForVia, key: string): Promise<string[] | string | null>;

  /**
   * The stored row of a queued remote job's principal (an OAuth client's grant columns, or the whole legacy token row),
   * revoked and deleted rows included; null when there is none. minions/submission-authority.ts decides what it permits.
   */
  readJobPrincipal(principal: { kind: JobPrincipalKind; id: string }): Promise<Record<string, unknown> | null>;

  /** Which of `memberIds` are enabled members (with their groups) and which of `groupIds` exist; an empty list reads nothing. */
  readAudiencePrincipals(memberIds: readonly string[], groupIds: readonly string[]): Promise<AudiencePrincipalRows>;

  /**
   * The folder-rule policy members access/policy.ts runs (engine-sql/access-policy.ts says what each reads or writes).
   * lockAccessPolicy, applyAccessRuleChanges, finishAccessRestamp and the revision writes belong inside one transaction.
   */
  readAccessStoreConfig(sourceId: string): Promise<{ store: string | null } | null>;
  writeAccessStoreConfig(sourceId: string, store: string): Promise<void>;
  ensureAccessPolicyState(sourceId: string): Promise<void>;
  lockAccessPolicy(sourceId: string): Promise<void>;
  listAccessRules(sourceId: string): Promise<AccessRuleRow[]>;
  readAccessPolicyRevisions(query: AccessRevisionQuery): Promise<AccessRevisionRow[]>;
  listAccessCoverage(sourceId: string): Promise<AccessCoverageRow[]>;
  readAccessStateUnreadable(): Promise<boolean>;
  applyAccessRuleChanges(sourceId: string, changes: AccessRuleChanges): Promise<void>;
  restampAccessWindow(sourceId: string, after: number, batch: number): Promise<AccessRestampWindow>;
  finishAccessRestamp(sourceId: string): Promise<number>;
  insertAccessPolicyRevision(row: AccessRevisionInsert): Promise<void>;
  markAccessRevisionsApplied(sourceId: string, upTo?: number): Promise<void>;
  approveAccessPolicyRevision(sourceId: string, revision: number, actor: string): Promise<void>;
  hasAccessPolicyState(sourceId: string): Promise<boolean>;
  listAccessPrefixSlugs(sourceId: string, prefixes: string | readonly string[]): Promise<string[]>;
  readAccessPolicyMarks(sourceId: string, operationId?: string): Promise<AccessPolicyMarks>;
  replaceAccessInvalidCoverage(sourceId: string, prefixes: readonly string[], detail: unknown): Promise<void>;
  /**
   * The access setup and policy-store members outside access/policy.ts (engine-sql/access-setup.ts says what each reads
   * or writes): the member-key setup of commands/access-serves.ts, the policy-store migration journal of
   * access/policy-migrate.ts, the policy sources of access/policy-transfer.ts and the people folders of access/serves.ts.
   */
  listUnboundTokenNames(): Promise<string[]>;
  listUnboundClientIds(): Promise<string[]>;
  readLiveAccessToken(name: string): Promise<LiveAccessTokenRow | null>;
  listUnarchivedSourceIds(ids: readonly string[]): Promise<string[]>;
  recordTokenSetupReads(name: string, reads: readonly string[]): Promise<void>;
  listKeysReadingSource(sourceId: string): Promise<MemberKeyReadingRow[]>;
  countCompanyPages(sourceId: string): Promise<{ pages: number; calls: number }>;
  revokeAccessTokenById(id: string): Promise<void>;
  readUnfinishedAccessMigration(sourceId: string): Promise<AccessMigrationRow | null>;
  insertAccessMigration(id: string, sourceId: string, direction: string): Promise<void>;
  recordAccessMigrationPhase(id: string, phase: string, receipts: Record<string, unknown>): Promise<void>;
  switchAccessMigration(id: string, receipts: Record<string, unknown>): Promise<void>;
  listAccessPolicySources(): Promise<string[]>;
  countPeopleFolderPages(): Promise<PeopleFolderCount[]>;
  /** The maintenance sweep's facts-fence pages (engine-sql/sweep-reads.ts): newest `scanCap` recent pages, those holding a fence. */
  listFactsFencePages(q: FactsFencePagesQuery): Promise<string[]>;
  /** The sweep's links and timeline pages: recent pages whose links watermark is stale, less `exclude`, newest first. */
  listSweepStalePages(q: SweepStalePagesQuery): Promise<SweepStalePageRow[]>;
  /** Of the sweep's deferred segmented `slugs`, those still recent and stale. */
  listSweepDeferredPages(q: SweepDeferredPagesQuery): Promise<SweepDeferredPageRow[]>;
  /** The live pages of any source whose slug is in `slugs` (the links pass's refs), in no set order. */
  listPageRefsForSlugs(slugs: readonly string[]): Promise<SweepPageRefRow[]>;
  /**
   * The open pages of `sources` less each excluded prefix (access/open-pages.ts): live pages the empty-identity
   * member-access floor admits, grouped by source, top-level folder, type and whether the privacy part admits them.
   * The policy is rendered in the current access context; the caller reads it outside any caller record.
   */
  countOpenPages(sources: readonly string[], exclude: readonly OpenPageExclusion[]): Promise<OpenPageCount[]>;

  /** Access member rows with their groups: one by exact id or by declared email (any status), or all by id, removed ones only when asked. */
  readAccessMembers(by: AccessMemberLookup): Promise<AccessMemberRow[]>;

  /** Live credentials (active legacy tokens, clients not deleted): the tokens with one exact name, or those bound to one member. */
  readAccessCredentials(by: AccessCredentialLookup): Promise<AccessCredentialRow[]>;

  /** Revoke every active access token with this exact name; the revoked ids (none on a store that keeps no credentials). */
  revokeAccessTokensNamed(name: string): Promise<string[]>;
  /** Revoke the active access token with this id (a UUID); its name, or null when no active token has it. */
  revokeAccessToken(id: string): Promise<string | null>;
  /** Delete an OAuth client, its tokens and codes cascading; the deleted client, or null when none has this id. */
  deleteOAuthClient(clientId: string): Promise<DeletedOAuthClient | null>;
  /** Every access token, newest first, without its hash. */
  listAccessTokens(): Promise<AccessTokenListRow[]>;
  /** One grant column (`private_pages` or `permissions`) of the active token with this id (a UUID): `{ value }`, or null. */
  readActiveAccessTokenGrant(id: string, field: ActiveTokenGrantField): Promise<{ value: unknown } | null>;
  /** Whether an active access token has this id (compared as text). */
  accessTokenLive(id: string): Promise<boolean>;
  /** Whether an OAuth client not deleted has this id. */
  oauthClientLive(clientId: string): Promise<boolean>;
  /** Which of the probe's optional `oauth_clients` columns this brain has (a store that keeps them all names them all). */
  readOauthClientColumns(probe: OauthClientProbe): Promise<string[]>;
  /** Set one OAuth client's access-token lifetime in seconds; false when no client has this id. */
  setOauthClientTokenTtl(clientId: string, ttlSeconds: number): Promise<boolean>;
  /** Insert a scoped OAuth client with its register audit row (a store that keeps no grant audit writes the client only). */
  insertOauthClientGrant(row: OauthClientGrantInsert): Promise<void>;
  /** The clients an upgrade migration clamped the token lifetime of; a brain with no grant audit table raises its error. */
  readTokenLifetimeClampedClients(): Promise<string[]>;
  /** The id and config of each source among `ids`; `lock` takes the rows in id order FOR SHARE or FOR UPDATE (a single-writer store takes none). */
  readScopeSourceConfigs(ids: readonly string[], lock?: ScopeSourceLock): Promise<{ id: string; config: unknown }[]>;
  /** The client's whole row read FOR UPDATE inside the caller's transaction (a single-writer store takes no lock), or null. */
  readOauthClientForUpdate(clientId: string): Promise<OauthClientRow | null>;
  /** Every OAuth client not deleted, whole rows (the grant checks read every credential's grant). */
  readLiveOauthClients(): Promise<OauthClientRow[]>;
  /** Every access token not revoked, whole rows (a store that keeps no attest or private columns reads their defaults). */
  readLiveAccessTokenRows(): Promise<Record<string, unknown>[]>;
  /** Every access token, revoked ones too, whole rows newest first, a tie by id (the admin key list). */
  listAccessTokenRows(): Promise<Record<string, unknown>[]>;
  /** The transaction-scoped lock on a client name key, so same-name registrations serialize (a single-writer store takes none). */
  lockOauthClientName(lockKey: string): Promise<void>;
  /** Whether the client holds an OAuth token or an authorization code (a store that keeps neither answers false). */
  oauthClientHoldsAuthorization(clientId: string): Promise<boolean>;
  /** Whether the source is archived, read FOR SHARE inside the caller's transaction; null for no such source. */
  readSourceArchivedForShare(id: string): Promise<boolean | null>;
  /** The source's archived flag and config, or null for no such source (the `--attest-sources` check). */
  readSourceAttestState(id: string): Promise<{ archived: boolean; config: unknown } | null>;
  /** Set the source's whole config (the `--attest-sources` mark). */
  replaceSourceConfig(id: string, config: Record<string, unknown>): Promise<void>;
  /** Write a client's grant while it still holds the expected revision, rewrite its legacy open jobs and append the audit row; false (nothing written) when the revision moved. */
  persistOauthClientGrant(grant: OauthClientGrantPersist): Promise<boolean>;
  /** The `after_grant` document of the client's newest audit row that records a catalog provenance, or null; a brain with no audit table raises its error. */
  readLatestCatalogProvenanceAudit(clientId: string): Promise<unknown | null>;
  /** The client's grant audit rows, oldest first. */
  listOauthGrantAudit(clientId: string): Promise<OauthGrantAuditRow[]>;
  /** Delete the OAuth token with this hash when this client owns it (a revoke naming another client deletes nothing). */
  deleteOauthTokenByHash(hash: string, clientId: string): Promise<void>;
  /** Stamp an OAuth client `deleted_at` now (a revoke); its tokens and codes are separate deletes. */
  softDeleteOauthClient(clientId: string): Promise<void>;
  /** Delete every OAuth token, access and refresh, of the client. */
  deleteOauthClientTokens(clientId: string): Promise<void>;
  /** Delete every authorization code of the client (a store that keeps none deletes none). */
  deleteOauthClientCodes(clientId: string): Promise<void>;
  /** Delete the OAuth client row (the lifecycle `delete`); its tokens and codes are separate deletes. */
  deleteOauthClientRow(clientId: string): Promise<void>;
  /** Set the client's grant revision; `revoke` also stamps `deleted_at` when the client is not already revoked. */
  setOauthClientRevision(clientId: string, revision: number, revoke: boolean): Promise<void>;
  /** Append one row to the OAuth grant audit (the grant documents are JSON text). */
  insertOauthGrantAudit(row: OauthGrantAuditInsert): Promise<void>;
  /** The bearer check's OAuth token read at one rung of its degrade ladder. */
  readOauthAccessTokenRows(hash: string, rung: OauthTokenRung): Promise<Record<string, unknown>[]>;
  /** `auth rescope`'s whole rows (`SELECT *`) of the active tokens one id or an exact name names, locked FOR UPDATE. */
  lockActiveAccessTokens(target: ActiveTokenTarget): Promise<Record<string, unknown>[]>;
  /** `auth rescope`'s grant writes: the grant columns and mirror (one more revision; null for no token), a private grant column, and the legacy-shape tokens locked FOR UPDATE, oldest first. */
  writeAccessTokenGrant(id: string, write: AccessTokenGrantWrite): Promise<number | null>;
  writeAccessTokenPrivateGrant(id: string, axis: AccessTokenPrivateAxis, value: string): Promise<void>;
  lockLegacyAccessTokens(): Promise<Record<string, unknown>[]>;
  /** The bearer check's whole row (`SELECT *`) of the token not revoked with this hash, or null. */
  readActiveAccessTokenByHash(hash: string, caller: TokenByHashCaller): Promise<Record<string, unknown> | null>;
  /** Stamp a token's `last_used_at`, debounced to once a minute. */
  touchAccessTokenLastUsed(id: string, unified: boolean): Promise<void>;
  /** Delete the OAuth tokens and codes that expired before `nowEpochSeconds`; the count of both (a store that keeps none deletes none). */
  deleteExpiredOauthCredentials(nowEpochSeconds: number): Promise<number>;
  /** Set `expires_at = 0` on every OAuth token and code (the shared-skill restore quarantine): no archived grant is honored. */
  expireAllOauthCredentials(): Promise<void>;
  /** OAuth access tokens expiring from `from` to `to` (epoch seconds, inclusive), or after `from` when `to` is null. */
  countOauthAccessTokens(from: number, to: number | null): Promise<number>;
  /** Convert an access token still on the legacy shape to its grant columns on first read; the converted row, or null when none converted. */
  convertLegacyAccessTokenGrant(id: string, columns: LegacyTokenGrantColumns): Promise<Record<string, unknown> | null>;
  /** Insert one OAuth token (the INSERTs of `OAuthGrants.issue`); a repeated hash is 23505, a client with no row 23503. */
  insertOauthToken(row: OauthTokenInsert): Promise<void>;
  /** Insert one authorization code (OAuthGrants.decide); a repeated hash is 23505, a client with no row 23503. */
  insertOauthCode(row: OauthCodeInsert): Promise<void>;
  /** The code of this hash and client taken FOR UPDATE, or null (the caller checks expiry). */
  readOauthCodeForUpdate(codeHash: string, clientId: string): Promise<OauthCodeRow | null>;
  /** Delete the code of this hash and client. */
  deleteOauthCode(codeHash: string, clientId: string): Promise<void>;
  /** The refresh token of this hash and client taken FOR UPDATE, or null (the caller checks expiry). */
  readOauthRefreshTokenForUpdate(tokenHash: string, clientId: string): Promise<OauthTokenRow | null>;
  /** Delete the refresh token of this hash and client. */
  deleteOauthRefreshToken(tokenHash: string, clientId: string): Promise<void>;
  /** The PKCE challenge of an unexpired code of this client (its client not soft-deleted), or null. */
  readOauthCodeChallenge(codeHash: string, clientId: string, nowEpochSeconds: number): Promise<string | null>;
  /** Insert the tokens of one grant on the grant transaction, all or none, after the client lock (OAuthGrants.issue); run it on the transaction handle, never the pool. */
  issueOauthTokens(rows: readonly OauthTokenInsert[]): Promise<void>;

  /** The ids of the enabled, untombstoned audience-kind members, by id. */
  listAudienceAccessMembers(): Promise<string[]>;

  /** Every access group with its member ids, by id; or the one group with exactly that id (null lists every group). */
  readAccessGroups(id: string | null): Promise<AccessGroupRow[]>;

  /** The pages, in every source and by (source, slug), whose readers name exactly `principal`; at most 51 of them. */
  listPagesNamingReader(principal: string, opts?: { live?: boolean }): Promise<PageNamingReaderRow[]>;

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
  countDistinctInboundLinkers(sourceIds: readonly string[], slugs: readonly string[]): Promise<InboundLinkerCountRow[]>;
  /** The link-extraction lag row (`extractionLagStatement`) under a `timeoutMs` bound (default 10 s; PGLite ignores it). */
  readExtractionLagCounts(q: ExtractionLagQuery): Promise<ExtractionLagCounts | undefined>;
  /**
   * Live pages of one source, by slug or updated since a database timestamp, that carry a privacy label gbrain does not
   * recognize and no visibility key (`ignoredPrivacyLabelSql`), at most `limit` (default 100,000), in no set order.
   */
  readIgnoredPrivacyLabelPages(sourceId: string, scope: { slugs: readonly string[] } | { since: string },
    opts?: { limit?: number; timeoutMs?: number }): Promise<IgnoredLabelPageRow[]>;

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

  /**
   * The lease fence: true when `lockId` is still held under `acquisitionToken` and unexpired. Inside a transaction it
   * holds the row `FOR KEY SHARE` until commit, so the holder's renewal passes and a takeover or delete waits.
   */
  assertCycleLease(lockId: string, acquisitionToken: string): Promise<boolean>;

  // ============================================================
  // Minion jobs (engine-sql/jobs.ts). Rows are raw `minion_jobs` rows; the queue maps them with `rowToMinionJob`.
  // ============================================================
  /**
   * Submit one job in one transaction: idempotency key, parameter coalesce, delegated capacity, name quota,
   * backpressure caps and parent checks, then the insert and the parent flip to `waiting-children`. Returns the new
   * row, or an existing one with `coalesced` (and the audit of a cap or parameter coalesce).
   */
  admitJob(spec: AdmitJobSpec, policy: AdmitJobPolicy): Promise<AdmitJobResult>;

  /** One job row by id, or null. */
  getJob(id: number): Promise<JobRow | null>;
  /** The given ids whose job is waiting, active, delayed, waiting-children or paused (engine-sql/jobs.ts). */
  readLiveJobIds(ids: number[]): Promise<number[]>;
  /** `{ data }` of the job holding an idempotency key, whatever its status, or null. */
  readJobDataByIdempotencyKey(key: string): Promise<{ data: unknown } | null>;
  /**
   * The idempotency-key step of admitJob on its own: the row holding `key` when `policy.decide` returns it, or null
   * when no row holds the key or a dead or cancelled row's key was freed. `policy.authority` is the caller's
   * submission authority, which the Rust store decides with; the SQL engines ask `decide`.
   */
  coalesceOnIdempotencyKey(key: string, policy: { authority: unknown; decide: AdmitJobPolicy['decide'] }): Promise<JobRow | null>;

  /** Job rows matching every given filter, newest first (default 50 from offset 0). */
  listJobs(filter?: ListJobsFilter): Promise<JobRow[]>;

  /**
   * Claim the next waiting job of `names` in `queue` by priority then age (two workers never get one row), stamping
   * the lease, resolved timeout and lease, the attempt and the spend fence. On Postgres it runs on the direct pool.
   */
  claimNextJob(spec: ClaimJobSpec): Promise<JobRow | null>;

  /** Extend the lease of an active job this token still holds; false when the claim moved on. Direct pool on Postgres. */
  renewJobLease(id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal }): Promise<boolean>;

  /**
   * Complete an active job this token holds, rolling its tokens and `child_done` up to its parent and waking a parent
   * whose children are all finished. Returns the completed row (before a `remove_on_complete` delete), or null.
   */
  completeJob(id: number, lockToken: string, result?: Record<string, unknown>): Promise<JobRow | null>;

  /**
   * Fail an active job this token holds (`delayed` retry, `failed` or `dead`), applying `on_child_fail` to its parent
   * on a terminal failure. Returns the row (before a `remove_on_fail` delete), or null when the token is stale.
   */
  failJob(id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>): Promise<JobRow | null>;

  /**
   * The stall sweep: active jobs whose lease expired more than `graceMs` ago requeue (a dead multi-claim worker's
   * co-runners marked, no stall counted) or go `dead` at `max_stalled`, notifying and waking their parents.
   */
  reclaimStalledJobs(graceMs: number): Promise<{ requeued: JobRow[]; dead: JobRow[] }>;

  // Minion queue statements beyond the lifecycle (engine-sql/jobs-queue.ts): operator writes, sweeps, inbox, private
  // queues, stats and attachments. The queue keeps the policy (validation, the unreviewed-job gate, authorization).
  /** Delete a terminal job (its inbox and attachments go with it); false when it is missing or still live. */
  deleteTerminalJob(id: number): Promise<boolean>;
  /** Pause a waiting, active or delayed job, clearing its lock. Null when the job is in no such status. */
  pauseJob(id: number): Promise<JobRow | null>;
  /** Return a paused job to waiting. Null when it is not paused. */
  resumeJob(id: number): Promise<JobRow | null>;
  /** Fail a parent waiting on its children with `errorText`. Null when it is not waiting on children. */
  failParentJob(parentId: number, errorText: string): Promise<JobRow | null>;
  /** Return a parent waiting on its children to waiting when none of them is live. */
  resolveParentJob(parentId: number): Promise<JobRow | null>;
  /** Wake every parent waiting on children with no live child; the count woken. */
  resolveStrandedParents(): Promise<number>;
  /** Remove a child's dependency on its parent. */
  detachChildJob(childId: number): Promise<void>;
  /** Replace the progress of an active job this token holds; false when the claim moved on. */
  updateJobProgress(id: number, lockToken: string, progress: unknown): Promise<boolean>;
  /** Add to the token counts of an active job this token holds; false when the claim moved on. */
  addJobTokens(id: number, lockToken: string, tokens: JobTokenCounts): Promise<boolean>;
  /**
   * Return an active job this token holds to `delayed` without counting an attempt (a lease-full bounce, a deferral,
   * a configuration release). Null when the claim moved on. Postgres cancels the statement when `signal` aborts.
   */
  delayActiveJob(id: number, lockToken: string, spec: DelayActiveJobSpec, opts?: { signal?: AbortSignal }): Promise<JobRow | null>;
  /** Requeue a co-runner of a watchdog drain with the suspect mark, no attempt counted; false when the claim moved on. */
  releaseWatchdogClaim(id: number, lockToken: string, errorText: string): Promise<boolean>;
  /** Append the watchdog suspect mark once to a job's stacktrace (any status, `updated_at` untouched). */
  markJobWatchdogSuspect(id: number): Promise<void>;
  /** Move delayed jobs whose delay passed back to waiting. */
  promoteDelayedJobs(): Promise<JobRow[]>;
  /** Cancel the live roots in `ids` and their descendants in one transaction, notifying and waking their parents. */
  cancelJobs(ids: readonly number[], spec?: CancelJobsSpec): Promise<JobRow[]>;
  /** Dead-letter active jobs past `timeout_at` that still hold a lease, notifying and waking their parents. */
  killTimedOutJobs(): Promise<JobRow[]>;
  /** Dead-letter active jobs past their wall-clock threshold, notifying and waking their parents. */
  killWallClockJobs(lockDurationMs: number): Promise<JobRow[]>;
  /** Delete (or count, on `dryRun`) jobs in `statuses` last updated before `olderThan`; the count. */
  pruneJobs(spec: PruneJobsSpec): Promise<number>;
  /** Completed dream synthesis keys of a source starting with `keyPrefix`, live jobs and the prune archive, each once. */
  listSynthesisCompletionKeys(sourceId: string, keyPrefix: SynthesisCompletionPrefix): Promise<string[]>;
  /** The source's synth-v2 completions (live jobs, then archive rows) that finished within the last `hours`. */
  listRecentSynthesisCompletions(sourceId: string, hours: number): Promise<SynthesisCompletion[]>;
  /** Re-queue a failed or dead job fresh after `policy.admit` passes, in one transaction. Null when not retried. */
  retryJob(id: number, policy: RetryJobPolicy): Promise<JobRow | null>;
  /** Insert one inbox message for a job. */
  postInboxMessage(jobId: number, sender: string, payload: unknown): Promise<JobRow>;
  /** Mark and return the unread messages of an active job this token holds; [] when the claim moved on. */
  readJobInbox(jobId: number, lockToken: string): Promise<JobRow[]>;
  /** The `child_done` payloads in an active parent's inbox (after `since`), oldest first; [] unless this token holds it. */
  readChildCompletions(parentId: number, lockToken: string, since?: Date | null): Promise<unknown[]>;
  /** Ids of the live jobs in one queue, ascending. */
  listOpenJobIdsInQueue(queue: string): Promise<number[]>;
  /** Extend the owner lease of a private queue's live jobs this owner token holds; the count renewed. */
  renewPrivateQueueLease(queue: string, ownerToken: string, leaseMs: number): Promise<number>;
  /** Private queues with live jobs and owner metadata, oldest first, at most `maxQueues`. */
  listOwnedPrivateQueues(maxQueues: number): Promise<string[]>;
  /** The recovery verdict's inputs for one private queue. */
  readPrivateQueueState(queue: string): Promise<PrivateQueueState>;
  /** Ids of jobs of `name` waiting since before `hours` ago, oldest first, at most `limit`. */
  listStaleWaitingJobIds(name: string, hours: number, limit: number): Promise<number[]>;
  /** How many jobs of `name` have waited since before `hours` ago. */
  countTtlExpiredWaiting(name: string, hours: number): Promise<number>;
  /** The raw counts behind the queue statistics, with the wedge signature of `queue`. */
  readJobStats(since: Date, queue: string): Promise<JobStatsRead>;
  /** Per queue family: live counts now and intake since `since`, families in byte order. */
  readQueueFamilyStats(since: Date): Promise<QueueFamilyRow[]>;
  /** Whether a waiting, authorized, marked job of `names` in `queue` has waited `waitMs` since its requeue. */
  hasOverdueWatchdogSuspect(queue: string, names: readonly string[], waitMs: number): Promise<boolean>;
  /** Live jobs whose authority is not exactly the application authority, by id. */
  listUnreviewedJobs(): Promise<Array<{ id: number; submission_authority: unknown }>>;
  /** The name and data of a failed or dead job, or null. */
  getFailedJobForRetry(id: number): Promise<{ name: string; data: Record<string, unknown> } | null>;
  /** A delegated client's open `subagent` jobs, across queues and non-terminal statuses (its used slots). */
  countOpenJobsByOwner(clientId: string): Promise<number>;
  /** Lock a delegated client's OAuth row for the rest of the transaction (delegated job admission). */
  lockOAuthClient(clientId: string): Promise<void>;
  /** An agent job's source: archived and created_at, or null (the job authority check). */
  readJobSourceState(sourceId: string): Promise<JobSourceState | null>;
  /** One `list_jobs` page, newest first on `(created_at, id)`, each row with `created_us` for the next cursor. */
  listJobPage(spec: JobPageSpec): Promise<JobRow[]>;
  /** The attachment filenames of a job, or null when the job does not exist. */
  listJobAttachmentNames(jobId: number): Promise<string[] | null>;
  /** Store one attachment; its metadata. A duplicate filename violates `uniq_minion_attachments_job_filename`. */
  insertJobAttachment(jobId: number, attachment: JobAttachmentInsert): Promise<JobRow>;
  /** The attachment metadata of a job, oldest first. */
  listJobAttachments(jobId: number): Promise<JobRow[]>;
  /** One attachment with its `content` bytes, or null. */
  getJobAttachment(jobId: number, filename: string): Promise<JobRow | null>;
  /** Delete one attachment; false when there was none. */
  deleteJobAttachment(jobId: number, filename: string): Promise<boolean>;
  // Queue health reads (lane 5 group A; engine-sql/jobs-health.ts): what doctor's queue checks, the advisor and the submit probe ask.
  /** The `queue_health` check's counts: stalled-forever, deep, watchdog-killed, prompt_too_long and old embed-backfill jobs. */
  readQueueHealthSignals(spec: QueueHealthSpec): Promise<QueueHealthSignals>;
  /** Waiting jobs per queue (depth, oldest age in seconds), deepest first. */
  listWaitingByQueue(): Promise<WaitingByQueueRow[]>;
  /** Intake, completions and waiting per job name, and the waiting-TTL cancellations, over a window. */
  readQueueDivergence(spec: QueueDivergenceSpec): Promise<QueueDivergence>;
  /** Per queue (private dream queues excluded): live active rows, waiting rows and minutes since the last completion. */
  listQueueWedgeCounts(): Promise<QueueWedgeRow[]>;
  /** Per dream-inline private queue: live active, waiting-class and paused rows, oldest wait and birth, source id. */
  listPrivateQueueHealth(): Promise<PrivateQueueHealthRow[]>;
  /** One queue's wedge signals (stalled, live active, waiting, claimable, last completions). `opts.signal` cancels a SQL statement. */
  readWedgeSignals(queue: string, handlerNames: readonly string[], opts?: { signal?: AbortSignal }): Promise<QueueWedgeSignals>;
  /** The age in whole seconds of the oldest waiting job in a queue, or null with none. */
  readOldestWaitingAge(queue: string, opts?: { signal?: AbortSignal }): Promise<number | null>;
  /** How many jobs wait; `excludeFactsAbsorb` leaves out the `facts-absorb` jobs PGLite's facts drain owns. */
  countWaitingJobs(excludeFactsAbsorb: boolean): Promise<number>;
  /** Active jobs whose lock lapsed or whose stalled counter reached two, per name. */
  listStuckActiveJobsByName(): Promise<Array<{ name: string; n: number }>>;

  // Minion job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts): `gbrain status`, `jobs stats`,
  // the facts drain backlog, source health and the sync status report. Windows are seconds.
  /** The newest completed `autopilot-cycle` job and the newest completed `autopilot-*` job (finished-at order), or null each. */
  readLastAutopilotCycles(): Promise<LastAutopilotCycles>;
  /** Job counts by status, in status order, over the jobs a filter (name, queue, statuses) matches; no filter counts all. */
  countJobsByStatus(filter?: JobStatusFilter): Promise<JobStatusCount[]>;
  /** Waiting depth and oldest-waiting age in seconds per queue with waiting work, deepest first. */
  readWaitingQueueDepths(): Promise<QueueDepth[]>;
  /** The freshest `updated_at` among completed jobs, or null. */
  readLastCompletedJobAt(): Promise<Date | null>;
  /** Cancelled jobs whose `error_text` matches the LIKE pattern and that finished in the last `withinSeconds`, counted by name. */
  countTtlCancelledByName(reasonLike: string, withinSeconds: number): Promise<TtlCancelledCount[]>;
  /** The waiting jobs sharing a returned job's source scope, plus its id and age in minutes while it is active with a live lease. */
  readWaitingScopeState(spec: { name: string; queue: string; jobId: number }): Promise<WaitingScopeState>;
  /** Jobs of a name that completed within the last `withinSeconds`. */
  countRecentCompletedJobs(name: string, withinSeconds: number): Promise<number>;
  /** The id and failure text of dead or failed jobs updated within the last `withinSeconds`, by id. */
  listRecentFailedJobErrors(withinSeconds: number): Promise<FailedJobError[]>;
  /** The newest five unfinished jobs that own a budget, with remaining and reserved cents, newest id first. */
  listBudgetOwners(): Promise<BudgetOwnerRow[]>;
  /** The average page text length (capped at `maxChars`) of the pages queued jobs of a name and queue point at, or null. */
  readQueuedPageChars(spec: { name: string; queue: string; maxChars: number }): Promise<number | null>;
  /** Per-source failure, queue and embed-backfill counts over the `sync` and `embed-backfill` jobs. */
  readSourceJobCounts(failedWithinSeconds: number): Promise<SourceJobCounts[]>;
  /** The embed-backfill jobs of each named source: queued, active and last completion. */
  readEmbedBackfillBySource(sourceIds: readonly string[]): Promise<EmbedBackfillState[]>;

  // Group C: the queue reads the doctor checks and the dream breaker make (engine-sql/jobs-checks.ts).
  /** The distinct `sourceId` of embed-backfill jobs that ended failed or dead with a stall record in their progress (null: a job without a source). */
  listStalledEmbedBackfillSources(): Promise<Array<string | null>>;
  /** How the last `deaths` brain-wide maintenance jobs and each dream phase's last `deaths` children died (the `global_maintenance_timeouts` check). */
  readGlobalMaintenanceDeaths(spec: { deaths: number }): Promise<GlobalMaintenanceDeaths>;
  /** The newest brain-wide maintenance job that ended without completing after `since` (a timestamp text, or null for all), with the count and earliest finish of them all. */
  readLastFailedGlobalMaintenanceJob(since: string | null): Promise<LastFailedGlobalMaintenanceJob | null>;
  /** Facts-absorb jobs dead or failed inside `hours` that no later job for the same page completed: the total and the newest `limit` (the `facts_extraction_health` check). */
  listFactsAbsorbJobsStillDead(spec: { hours: number; limit: number }): Promise<FactsAbsorbStillDead>;
  /** The claim gate's population and the terminal keyed rows with SQL NULL authority (the `legacy_job_authority` check). */
  readLegacyJobAuthority(): Promise<LegacyJobAuthorityRead>;
  /** Queued jobs by name and spend basis, and the spend-authorized rows waiting longer than `waitMs` (the `legacy_job_authority` spend census). */
  readQueuedSpendRows(spec: { legacyPrefixes: Readonly<Record<string, readonly string[]>>; waitMs: number }): Promise<QueuedSpendRows>;
  /** The stacktrace lines `LIKE prefix || '%'` (a LIKE pattern: `_` is a wildcard) of the newest `scanJobs` recently updated jobs (the `runtime_build_skew` check). */
  listBuildSkewStacktraceLines(spec: { prefix: string; windowHours: number; scanJobs: number }): Promise<Array<{ id: number; line: string }>>;
  /** Dead dream submissions per base key inside the window, resets applied (the dream breaker's counting rule). */
  countDeadDreamSubmissionRows(spec: DeadDreamSubmissionSpec): Promise<Array<{ base_key: string; dead_submissions: number; last_dead_at: string }>>;
  /** Facts-absorb jobs whose key is `LIKE prefix || '%'` (a LIKE pattern) that are dead or whose key is in `keys` (the dead-write retry's reconcile). */
  listFactsAbsorbJobsByKeyPrefix(spec: { prefix: string; keys: readonly string[] }): Promise<FactsAbsorbJobRow[]>;
  /** The dead facts-absorb jobs with a key in `keys` (the dead-write retry's operator controls). */
  listDeadFactsAbsorbJobsByKeys(keys: readonly string[]): Promise<FactsAbsorbJobRow[]>;
  // Group D (jobs insight): the reads behind `describeJobs`.
  /** Submitter, queue position, slot holders, live children, blocking locks and foreign-owner tokens of a batch of jobs. */
  readJobInsight(spec: JobInsightSpec): Promise<JobInsightRows>;
  // Group C (spend reservations and lease pressure): `mcp_spend_reservations` and `minion_lease_pressure_log`.
  /** Per described job: the settled cents, priced count and unsettled count of the reservations of itself and its descendants. */
  readJobSpendTree(spec: JobSpendTreeSpec): Promise<SpendTreeRow[]>;
  /** One new `pending` spend reservation, for a client or a budget group, optionally tied to a job. */
  insertSpendReservation(row: SpendReservationInsert): Promise<void>;
  /** Mark every overdue `pending` reservation `expired` (all, one client's or one group's); how many. */
  expireSpendReservations(scope?: ExpireSpendScope): Promise<number>;
  /** Settle a pending or expired hold at its actual cents (idempotent: a settled one reports `already_settled`). */
  settleSpendReservation(reservationId: string, actualCents: number): Promise<SettleSpendOutcome>;
  /** Record why a pending or expired hold's usage is unknown; whether a row changed. */
  markSpendUsageUnknown(reservationId: string, reason: string): Promise<boolean>;
  // Spend ledger and client budgets (engine-sql/spend-log.ts): `mcp_spend_log` and the spend columns of `oauth_clients`.
  /** Atomic client admission: the client's cap, the sweep, the day's ledger sum and open holds, then a refusal or the new hold. */
  reserveClientSpend(spec: ClientReserveSpec): Promise<ClientReserveOutcome>;
  /** Atomic group admission against a lifetime total: the sweep, the totals, then a refusal or the (bounded) new hold. */
  reserveGroupSpend(spec: GroupReserveSpec): Promise<GroupReserveOutcome>;
  /** A budget key's ledger sum, overdue holds and live holds, in cents. */
  readGroupSpendTotals(budgetKey: string): Promise<GroupSpendRow>;
  /** Settle a hold and write its ledger row as one unit (a settled hold is left alone; a missing one is reported). */
  settleSpendWithLog(reservationId: string, actualCents: number, operation: string, tokenName: string | null): Promise<SettleLogOutcome>;
  /** One ledger row of an unreserved paid call. */
  insertSpendLog(row: SpendLogInsert): Promise<void>;
  /** A client's ledger sum from an instant on, in cents. */
  sumClientSpendSince(clientId: string, since: Date): Promise<number>;
  /** A client's `budget_usd_per_day` as text (dollars to two decimals); null for no cap or no such client. */
  readClientBudgetUsd(clientId: string): Promise<string | null>;
  /** One `oauth_clients` row with the spend columns (a repeated client id is a constraint error). */
  insertOauthClient(row: OauthClientInsert): Promise<void>;
  /** Set or clear a client's daily cap in dollars; whether the client exists. */
  updateOauthClientBudget(clientId: string, usd: number | null): Promise<boolean>;
  /** The admin page's spend per live agent client: cap, today's ledger sum, open holds, unknown holds and open subagent jobs. */
  readAgentClientSpend(): Promise<AgentClientSpendRow[]>;
  readOauthClient(clientId: string): Promise<OauthClientRow | null>;
  /** Every client's whole row, by name then id in byte order (`gbrain auth clients`). */
  listOauthClients(): Promise<OauthClientRow[]>;
  patchOauthClient(clientId: string, patch: OauthClientPatch, guard?: OauthClientPatchGuard): Promise<OauthClientPatched | null>;
  /** One `access_tokens` row at grant revision 1; its generated id. A repeated token hash is a constraint error (23505). */
  insertAccessToken(row: AccessTokenInsert): Promise<{ id: string }>;
  /** The tokens not yet revoked whose id or name is `target`, by id (names are not unique, so there may be several). */
  findActiveAccessTokens(target: string): Promise<ActiveAccessTokenRow[]>;
  /** Set or clear one token's read floor by row id. A tier outside the six is a constraint error (23514). */
  setAccessTokenMinTrust(id: string, tier: string | null): Promise<void>;
  /** One rate-lease bounce appended to the lease-pressure log. */
  insertLeasePressure(row: LeasePressureInsert): Promise<void>;
  /** How many lease bounces match every given field (window in ms, job id, lease key). */
  countLeasePressure(filter?: LeasePressureFilter): Promise<number>;
  /** The bounces of the last `windowMs` ms, newest first, at most `limit`. */
  listRecentLeasePressure(windowMs: number, limit: number): Promise<LeasePressureRow[]>;
  // Group B (subagent transcript and tool ledger; engine-sql/jobs-subagent.ts): the rows the subagent handler, replay, the transcript views and the dream provenance reads use.
  /** The job's subagent messages by `message_idx`; with `last`, only the newest. */
  listSubagentMessages(jobId: number, opts?: { last?: boolean }): Promise<SubagentMessageRow[]>;
  /** How many messages the job has persisted. */
  countSubagentMessages(jobId: number): Promise<number>;
  /** Persist one message (`content_blocks` is JSON text); a message already at the same `message_idx` stays. */
  insertSubagentMessage(jobId: number, message: SubagentMessageInsert): Promise<void>;
  /** The job's tool rows, in replay order (`message_idx`, ordinal with legacy NULL as 0, `id`) or `id` order. */
  listSubagentToolExecutions(jobId: number, order: SubagentToolOrder): Promise<SubagentToolRow[]>;
  /** Whether the job has a tool row of `status` whose `tool_use_id` is `LIKE toolUseIdPrefix || '%'` (a LIKE pattern). */
  hasSubagentToolExecution(jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }): Promise<boolean>;
  /** The job's `brain_put_page` rows' status, error and output by `id`, scoped to a `tool_use_id` LIKE prefix when given. */
  listSubagentWriteOutcomes(jobId: number, toolUseIdPrefix?: string): Promise<SubagentWriteOutcome[]>;
  /** The oneshot ledger: rows whose `tool_use_id` is `LIKE toolUseIdPrefix || '%'`, by `id`, with their input fields as text. */
  listSubagentOneshotLedger(jobId: number, toolUseIdPrefix: string): Promise<SubagentOneshotLedgerRow[]>;
  /** How many rows of `toolName` in `status` the jobs hold and the bytes of their output as jsonb text. */
  summarizeSubagentToolExecutions(jobIds: readonly number[], spec: { toolName: string; status: string }): Promise<{ count: number; output_bytes: number }>;
  /** The distinct slugs the jobs' completed `brain_put_page` calls named, bytewise ascending, null last. */
  listSubagentPutPageSlugs(jobIds: readonly number[]): Promise<Array<string | null>>;
  /** Each completed `brain_put_page` call of the jobs: job, slug and start time, by `id`. */
  listSubagentPutPageWrites(jobIds: readonly number[]): Promise<Array<{ job_id: number; slug: string | null; started_at: Date }>>;
  /** The jobs' completed `brain_put_page` calls whose output state is `committed`, with their job's idempotency key, by `id`. */
  listSubagentRetainedPutPages(jobIds: readonly number[]): Promise<SubagentRetainedPutPage[]>;
  /** A staging child's pages: per slug the last staged `brain_put_page` and its markdown, slugs bytewise ascending. */
  listSubagentStagedPages(jobId: number): Promise<Array<{ slug: string | null; content: string | null }>>;
  /** The jobs' `brain_add_timeline_entry` calls whose request id names a committed, `ok` timeline request of `sourceId`, by `id`. */
  listSubagentTimelineAppendCalls(jobIds: readonly number[], sourceId: string): Promise<Array<{ request_id: string; slug: string; input: unknown }>>;
  /** Bank tool rows at stable ordinals atomically; an occupied position stays. `legacyGuard` also skips a turn's legacy NULL-ordinal row of the same id. */
  recordSubagentToolExecutions(jobId: number, rows: readonly SubagentToolInsert[], opts?: { legacyGuard?: boolean }): Promise<void>;
  /** Record a gateway tool call's first observation (a pending v2 row); the stable id of the row at that position (null for a legacy row). */
  startSubagentToolExecution(jobId: number, row: SubagentToolStart): Promise<string | null>;
  /** Settle a tool row complete (`output` is JSON text); how many rows it settled. */
  completeSubagentToolExecution(target: SubagentToolTarget, output: string): Promise<number>;
  /** Settle a tool row failed, inserting one from `fallback` when the position has none; how many rows it changed. */
  failSubagentToolExecution(target: SubagentToolTarget, error: string, fallback?: SubagentFailureFallback): Promise<number>;
  // Group D (takes, salience and code-edge reads): the counts and lists doctor, onboarding and repair read.
  /** Takes more than 0.001 off the 0.05 weight grid, of all takes. */
  countOffGridTakeWeights(): Promise<{ off_grid: number; total: number }>;
  /** How many takes the brain holds. */
  countTakes(): Promise<number>;
  /** The takes a fact purge removes: consolidated from a purged fact, or echoing the purged claim. */
  planFactPurgeTakes(spec: PurgeTakesSpec): Promise<Array<{ id: number; page_id: number }>>;
  /** The page's stored takes, row number to claim. */
  listTakeRowsForPage(pageId: number): Promise<Array<{ row_num: number; claim: string }>>;
  /** The page's stored takes by row number while its take_fence generation is held `fence_absent`; none otherwise. */
  listHeldFenceTakeRows(spec: HeldFenceTakeSpec): Promise<HeldFenceTakeRow[]>;
  /** The takes generation adapter's before-states: the takes a write deletes (`gone`) or replaces at their row number, by row number. */
  readTakePreimages(read: TakePreimageRead): Promise<Array<{ preimage: TakePreimage; gone: boolean }>>;
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
  /** Resolved takes stamped `mcp:` by the MCP server, in the caller's source and holder scope. */
  countMcpResolvedTakes(spec: McpResolvedSpec): Promise<number>;
  /** A holder's 25 heaviest active resolved takes (the calibration pattern drill-down). */
  listTopResolvedTakesForHolder(holder: string): Promise<HolderResolvedTakeRow[]>;
  /** The five oldest abandoned high-conviction takes (the calibration abandoned-threads card). */
  listAbandonedTakes(): Promise<AbandonedTakeRow[]>;
  /** Live pages of the sources with an inactive or `superseded by #` take, by page id. */
  listTakeSupersessionCandidates(sourceIds: readonly string[]): Promise<Array<{ id: number; source_id: string; slug: string }>>;
  /** Pages with an active take and no emotional weight yet, and pages with a weight. */
  countZeroWeightWithTakes(): Promise<{ zero_weight_with_takes: number; nonzero_weight: number }>;
  /** Whether the source owns an unresolved (symbol-target) code edge. */
  hasCodeEdgesSymbol(sourceId: string): Promise<boolean>;
  // Group D (trust tier reads): the stamped-tier reads of core memory, the trust scan, belief history, page history and valid time.
  /** The live `always_load` pages, by source then slug, with the trust columns a delivery read asks for. */
  listCorePageRows(spec: CorePageRowSpec): Promise<CorePageRow[]>;
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

  // Decide family, group B: calibration profiles (engine-sql/calibration-profiles.ts).
  /** The newest calibration profile (`generated_at DESC`, then `id DESC`) of `holder` (any holder when unset) in `sourceIds` (an empty list matches nothing) or else `sourceId`; null when none. `id` is the BIGSERIAL as text. */
  getLatestCalibrationProfile(spec: CalibrationProfilesSql.LatestCalibrationProfileSpec): Promise<CalibrationProfilesSql.CalibrationProfileRow | null>;
  /** Whether the latest profile of the source and holder already holds this total, brier, accuracy, partial rate (REAL-rounded) and model; false when there is none. */
  isCalibrationProfileUnchanged(spec: CalibrationProfilesSql.CalibrationProfileUnchangedSpec): Promise<boolean>;
  /** Insert one calibration profile (the `calibration_profile` cycle phase's write). The source must exist; `generatedAt`, `waveVersion` and `published` default to now, `v0.36.1.0` and false. */
  insertCalibrationProfile(row: CalibrationProfilesSql.CalibrationProfileInsert): Promise<void>;
  /** The profiles generated in the last 7 days (of `sourceIds` when set) and how many of them failed the voice gate. */
  readVoiceGateHealth(spec: { sourceIds?: readonly string[] }): Promise<CalibrationProfilesSql.VoiceGateHealth>;
  /** `undo-wave`: how many profiles `waveVersion` wrote (`dryRun`), or delete them and return how many went. */
  purgeCalibrationProfilesByWave(spec: { waveVersion: string; dryRun: boolean }): Promise<number>;

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

  // Trust: the fact withdrawal ledger (engine-sql/trust-withdrawals.ts). Each runs the statement its caller ran through executeRaw.
  /** Whether a withdrawal in the source at `visibility` covers a claim for `subject`: its fingerprint is `factHash` or the v1 fingerprint of `claim`, and its subject is '*' or `subject`. */
  hasCoveringFactWithdrawal(sourceId: string, visibility: string, factHash: string, claim: string, subject: string): Promise<boolean>;
  /** Records a withdrawal of `claim` (by its fingerprint) for `subject`, at `withdrawnAt` (an ISO time) or now; false when that withdrawal was already recorded. */
  insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null): Promise<boolean>;
  /** Whether a withdrawal (subject '*', `entitySlug` or `memberPage`) or a purge tombstone (subject '*' or `entitySlug`) of the source covers `claim`; a null `visibility` matches any. */
  isFactWithdrawn(sourceId: string, visibility: string | null, claim: string, entitySlug: string | null, memberPage: string | null): Promise<boolean>;
  /** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
  isFactPurged(sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean>;
  /** Per claim row with a matching withdrawal (same visibility, its fingerprint or v1 fingerprint, subject '*' or `subject`; any subject when null): the earliest withdrawal time. No set order. */
  listFactWithdrawalDates(sourceId: string, claims: readonly TrustWithdrawalsSql.WithdrawalClaimRow[], subject: string | null): Promise<TrustWithdrawalsSql.WithdrawalDateRow[]>;
  /** Rename or merge: moves the source's withdrawals of subject `oldSlug` to `newSlug`, keeping a withdrawal `newSlug` already has. */
  moveFactWithdrawalSubject(sourceId: string, oldSlug: string, newSlug: string): Promise<void>;
  /** Whether any withdrawal of the source has subject `subject`. */
  hasFactWithdrawalForSubject(sourceId: string, subject: string): Promise<boolean>;
  /** The source's withdrawal keys by visibility, fingerprint and subject, at most `limit`. */
  listFactWithdrawalKeys(sourceId: string, limit: number): Promise<TrustWithdrawalsSql.WithdrawalKeyRow[]>;
  /** The hot-memory cache watermark of the source: withdrawal count, newest withdrawal (UTC ISO) and the folder access rules digest. It changes on any forget or rulebook install. */
  readFactCacheWatermark(sourceId: string): Promise<TrustWithdrawalsSql.FactCacheWatermarkRow>;
  /** The trust policy generation as decimal text; it moves whenever cached proactive content could turn wrong. Throws when it cannot be read. */
  readTrustGeneration(): Promise<string>;
  /** Whether the source has any fact purge tombstone (`facts`) and any take purge tombstone (`takes`). */
  readSourcePurgeFlags(sourceId: string): Promise<{ facts: boolean; takes: boolean }>;
  /** The fact a withdrawal admits (id and source; world facts only when worldOnly unless it is on memberPage; the remote provenance floor when remoteFloor), locked for the withdrawal; null when none. */
  lockFactForWithdrawal(spec: TrustWithdrawalsSql.WithdrawalLockSpec): Promise<TrustWithdrawalsSql.WithdrawalLockRow | null>;
  /** Queues the overnight review of withdrawn fact `factRef`; a queued review stays. */
  queueWithdrawalReview(sourceId: string, factRef: string): Promise<void>;
  /** The segmented pages among `slugs` in the source (id, slug). */
  listSegmentedPagesBySlug(sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string }>>;
  /** Gives the inline pages among `slugs` a new knowledge revision and clears their text projection revision and embedding signature. Returns them with the new revision. */
  bumpWithdrawnPageRevisions(sourceId: string, slugs: readonly string[]): Promise<TrustWithdrawalsSql.WithdrawnPageRevision[]>;
  /** The pages with these ids and their knowledge revisions. */
  readPageRevisions(ids: readonly number[]): Promise<TrustWithdrawalsSql.WithdrawnPageRevision[]>;
  /** Appends `note` to fact `id`'s context, after ' | ' when the context has text. */
  appendFactForgetReason(id: number, sourceId: string, note: string): Promise<void>;
  /** The withdrawal a save of this claim meets (the refusal's `fact_withdrawn`); entity, owned-page and source-wide withdrawals, the entity's first; null when none. Remote callers see only withdrawals they can see a backing row of, or that none backs. */
  readFactWithdrawnRow(spec: TrustWithdrawalsSql.FactWithdrawnSpec): Promise<TrustWithdrawalsSql.FactWithdrawnRow | null>;
  /** For a remote caller: whether the withdrawn rows backing this claim include one it can see (`visible`) and one it cannot (`hidden`). */
  readFactWithdrawnBacking(spec: TrustWithdrawalsSql.FactWithdrawnSpec): Promise<{ visible: boolean; hidden: boolean }>;

  // Open loops (engine-sql/open-loops.ts). Each runs the statement loops-store.ts ran through executeRaw and returns
  // the raw rows; loops-store.ts normalizes them.
  /** Inserts a loop, or updates the row with its source and dedup key when that row is open, the new activity is newer, or an unmute queued it, and a mute does not hold it for the same counterparty email. `applied` is false when the guard kept the existing row. */
  upsertOpenLoop(loop: OpenLoopUpsertInput): Promise<OpenLoopsSql.OpenLoopUpsertResult>;
  /** Closes the open loop `id` (in `sourceId` when not null) as `status`, by `closedBy`, now; the closed row, or null when no open loop matches. */
  closeOpenLoop(sourceId: string | null, id: number, status: Exclude<OpenLoopStatus, 'open'>, closedBy: string): Promise<OpenLoopsSql.OpenLoopDbRow | null>;
  /** The loops that pass every filter, newest activity first, then id descending, at most `limit` (1 to 1000, 200 by default). */
  listOpenLoops(opts?: OpenLoopListOpts): Promise<OpenLoopsSql.OpenLoopDbRow[]>;
  /** The open loops whose counterparty page is (sourceId, slug), newest activity first, at most `limit` (entity-card.ts). */
  readEntityOpenLoops(slug: string, sourceId: string, limit: number): Promise<OpenLoopsSql.EntityOpenLoopRow[]>;

  // Entity identities: cross-source identity groups (engine-sql/entity-identities.ts; entity-identity.ts validates first).
  /** Links the live page (sourceId, slug) into the group: re-linking moves it; canonical true demotes the old canonical in the same write. Throws the identity page-not-found error with no live page. */
  linkEntityIdentityRow(input: EntityIdentitiesSql.EntityIdentityLinkInput): Promise<void>;
  /** Removes the page (sourceId, slug), live or soft-deleted, from the group entityId; true when a row was removed. */
  unlinkEntityIdentityRow(input: EntityIdentitiesSql.EntityIdentityUnlinkInput): Promise<boolean>;
  /** The members (live pages) the filter keeps, by entity id, canonical first, source, then slug. */
  listEntityIdentityRows(filter: EntityIdentitiesSql.EntityIdentityFilter): Promise<EntityIdentitiesSql.EntityIdentityRow[]>;
  /** The group of each live member page in the cross product of the pages' sources and slugs. */
  readEntityIdentityIdsForPages(pages: ReadonlyArray<{ sourceId: string; slug: string }>): Promise<EntityIdentitiesSql.EntityIdentityPageRow[]>;
  /** At most two canonical members in another source of the live page's group (Gmail counterparty resolution). */
  readCanonicalTwin(sourceId: string, slug: string): Promise<EntityIdentitiesSql.CanonicalTwinRow[]>;

  // Trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts). Writers call these inside their
  // publication transaction, so a rolled-back write leaves no receipt or hold.
  /** Record a flag or quarantine receipt; the same target, content hash and detector version refreshes it. Returns its id. */
  upsertWriteGateReceipt(input: TrustWriteGateSql.WriteGateReceiptInput): Promise<number>;
  /** Record a receipt on the live page (sourceId, slug); null when no live page has that slug. */
  upsertPageWriteGateReceipt(sourceId: string, slug: string, receipt: TrustWriteGateSql.WriteGateReceiptFields): Promise<number | null>;
  /** Remove the live or deleted page's receipts whose content hash is not `contentHash` (null keeps none). */
  deleteStalePageWriteGateReceipts(sourceId: string, slug: string, contentHash: string | null): Promise<void>;
  /** One row's receipts, newest `last_seen_at` first (ties: higher id first), at most `limit`. */
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number): Promise<TrustWriteGateSql.WriteGateReceiptRow[]>;
  /** Delete receipts not seen for `olderThanDays` days, except those of a hold still held. Returns how many. */
  deleteStaleWriteGateReceipts(olderThanDays: number): Promise<number>;
  /** Hold a quarantined fact or take; the same source, slug, fingerprint and detector version re-opens the hold. Returns its id. */
  upsertWriteGateHold(input: TrustWriteGateSql.WriteGateHoldRowInput): Promise<number>;
  /** Holds, highest id first. */
  listWriteGateHoldRows(opts: TrustWriteGateSql.WriteGateHoldListOpts): Promise<TrustWriteGateSql.WriteGateHoldRow[]>;
  /** The owner's write-gate allow rules as stored, by id: active ones only unless `includeRemoved`, in the given sources (all when none). */
  listTrustAllowRuleRows(opts?: TrustWriteGateSql.TrustAllowRuleListOpts): Promise<Array<Record<string, unknown>>>;
  /** One hold by id, any status. */
  getWriteGateHoldRow(id: number): Promise<TrustWriteGateSql.WriteGateHoldRow | null>;
  /** Mark a held row released or dropped; false when it does not exist or was already decided. */
  decideWriteGateHold(id: number, status: 'released' | 'dropped', decidedBy: string): Promise<boolean>;

  // ============================================================
  // Decide proposals (group C; engine-sql/decide-proposals.ts, rust/docs/store/decide-proposals.md)
  // ============================================================
  /** Insert a supersede proposal. Returns its id, or null when its sweep slot or claim-sweep fact pair already carries one. */
  insertDecideProposal(p: DecideProposalsSql.NewProposal): Promise<number | null>;
  /** One supersede proposal; `lock` takes the row lock inside a transaction (a store with no row locks reads it plain). */
  getDecideProposal(id: number, lock?: boolean): Promise<DecideProposalsSql.ProposalRow | null>;
  /** The ids of one sweep's proposals in a status, by pair index. */
  listDecideProposalIds(sweepId: string, status: DecideProposalsSql.ProposalStatus): Promise<number[]>;
  /** Supersede proposals with both facts' text, oldest first; default status `pending`, default limit 200. */
  listDecideProposals(opts?: { status?: DecideProposalsSql.ProposalStatus | 'all'; limit?: number }): Promise<DecideProposalsSql.ProposalListing[]>;
  /** Compare-and-set a supersede proposal's status; false when it is no longer `from`. */
  transitionDecideProposal(id: number, from: DecideProposalsSql.ProposalStatus, to: DecideProposalsSql.ProposalStatus, state?: { before?: string | null; after?: string | null }): Promise<boolean>;
  /** The ordered fact pairs that already carry a proposal, in any status, and name `factId`. */
  listDecideProposedPairs(sourceId: string, factId: number): Promise<Array<{ a: number; b: number }>>;
  /** Insert a review proposal. Returns its id, or null when the (kind, source, a, b, subject) proposal exists. */
  insertDecideReviewProposal(p: DecideProposalsSql.NewReviewProposal): Promise<number | null>;
  /** Review proposals in a status (`all` for every one), by id. */
  listDecideReviewProposals(status: string): Promise<DecideProposalsSql.ReviewProposalRecord[]>;
  /** One review proposal; `lock` takes the row lock inside a transaction (a store with no row locks reads it plain). */
  getDecideReviewProposal(id: number, lock?: boolean): Promise<DecideProposalsSql.ReviewProposalRecord | null>;
  /** Compare-and-set a review proposal's status; false when it is no longer `from`. */
  transitionDecideReviewProposal(id: number, from: string, to: string): Promise<boolean>;
  /** The pending review proposals of one sweep, by id; withdrawals only when asked. */
  listDecideReviewProposalIds(sweepId: string, includeWithdrawals: boolean): Promise<number[]>;
  /** The doctor's review rates: per kind the pending count, oldest pending age in days and 30-day decisions, over both proposal tables. */
  readProposalReviewRates(): Promise<DecideProposalsSql.ProposalReviewCounts[]>;
  /** Review-queue rows of one kind and source that are due and not exhausted, oldest due first. */
  listDueDecideReviewQueue(kind: string, sourceId: string, limit: number): Promise<DecideProposalsSql.ReviewQueueRow[]>;
  /** Queue a review pair (idempotent), drop a queue row or defer it with a reason; the number of rows it touched. */
  applyDecideReviewQueue(op: DecideProposalsSql.ReviewQueueOp): Promise<number>;
  /** Due conflict-sweep retries of a source, oldest due first. */
  listDueDecideSweepDeferred(sourceId: string, limit: number): Promise<Array<{ fact_id: number; attempts: number }>>;
  /** Defer a swept fact, hand over relinked facts or clear a fact's retry row; the number of rows it touched. */
  applyDecideSweepDeferred(sourceId: string, op: DecideProposalsSql.SweepDeferredOp): Promise<number>;

  // Group A (decide store): `decide_state`, `decide_spend`, `decision_receipts`, `decide_calibrations` (engine-sql/decide-store.ts).
  /** The value kept under a decide state key, or null. */
  readDecideState(key: string): Promise<string | null>;
  /** Keep a value under a decide state key, replacing an earlier one. */
  upsertDecideState(key: string, value: string): Promise<void>;
  /** Forget a decide state key (absent is fine). */
  deleteDecideState(key: string): Promise<void>;
  /** Keep the value only when the key is empty, then answer the stored value (null if it cannot be read back). */
  ensureDecideState(key: string, value: string): Promise<string | null>;
  /** Record spend rows; a request id already recorded keeps its first row, and a refused row records none. */
  insertDecideSpend(rows: readonly DecideStoreSql.DecideSpendInsert[]): Promise<void>;
  /** Third-party spend recorded at or after `since`: the total and the remote part. */
  dailyDecideSpend(since: Date): Promise<{ total: number; remote: number }>;
  /** Spend totals per slot over the whole ledger, in slot order. */
  listDecideSpendBySlot(): Promise<DecideStoreSql.DecideSpendSlotTotals[]>;
  /** Record receipt rows in order; a refused row records none. */
  insertDecideReceipts(rows: readonly DecideStoreSql.DecideReceiptInsert[]): Promise<void>;
  /** Delete receipts older than `retentionDays` (and spend older than `max(retentionDays, 31)` days); answers how many receipts went. */
  pruneDecideReceipts(retentionDays: number): Promise<number>;
  /** Receipt counts, mean answer value, latency percentiles and tokens per (slot, mode, outcome, error reason) over the window. */
  listDecideReceiptStats(opts: { slot?: string; sinceHours: number }): Promise<DecideStoreSql.DecideReceiptStat[]>;
  /** Per-slot decisions, rows, tokens, errors, skips and egress refusals over the window. */
  decideSlotUsage(sinceHours: number): Promise<DecideStoreSql.DecideSlotUsageRow[]>;
  /** Conflict receipts in the window and how many were `no_entity` skips. */
  decideConflictNoEntityCounts(sinceHours: number): Promise<{ receipts: number; skipped: number }>;
  /** The receipts of `slot` in the window that a replay reads, by decision id, rank, insertion order. */
  listDecideReplayReceipts(slot: string, sinceHours: number): Promise<DecideStoreSql.DecideReplayReceipt[]>;
  /** Each (slot, provider, resolved model) in the window with its count and latest time, latest first. */
  listDecideResolvedModels(sinceHours: number): Promise<DecideStoreSql.DecideResolvedModel[]>;
  /** Per slot, the receipts in the window marked `mixed_model`. */
  listDecideMixedModelDecisions(sinceHours: number): Promise<Array<{ slot: string; n: number }>>;
  /** Record one calibration, stamped now, and answer its id. */
  insertDecideCalibration(row: DecideStoreSql.DecideCalibrationInsert): Promise<number>;
  /** Replace the qualification columns of calibration `id` and stamp `qualified_at`; an unknown id changes nothing. */
  storeDecideQualification(id: number, q: DecideStoreSql.DecideQualification): Promise<void>;
  /** The calibrations by slot (byte order), newest first; retired ones only with `includeRetired`. */
  listDecideCalibrations(opts?: { slot?: string; includeRetired?: boolean }): Promise<DecideStoreSql.DecideCalibration[]>;
  /** Calibration `id`, or null. */
  getDecideCalibration(id: number): Promise<DecideStoreSql.DecideCalibration | null>;
  /** Retire calibration `id` or bring it back; answers whether the row exists. */
  setDecideCalibrationRetired(id: number, retired: boolean): Promise<boolean>;
  // Group A (jobs-tables): the Wakeshift report-back tables (engine-sql/jobs-wake.ts).
  /** Record a watch and return its id; a second open watch of the same Wakeshift subscription keeps its row and takes the new expiry. */
  openWakeWatch(watch: JobsWake.WakeWatchInsert): Promise<number>;
  /** One principal's watches, newest first, at most 50: the open ones (and ones updated in the last day), or one target's. */
  listWakeWatches(filter: JobsWake.WakeWatchFilter): Promise<JobsWake.WakeWatchRow[]>;
  /** End open watches for a reason (disabled, expired, or one unwatched id); the rows that ended. */
  endWakeWatches(spec: JobsWake.EndWakeWatches): Promise<JobsWake.EndedWakeWatch[]>;
  /** Every watch counted by state and last error. */
  countWakeWatches(): Promise<Array<{ state: string; last_error: string | null; n: number }>>;
  /** The doctor's wakeshift reads: 7-day watch counts, unregistered cron runs, stale and dead forgets. */
  readWakeDoctor(): Promise<JobsWake.WakeDoctorRead>;
  /** Wakeshift forgets still waiting to be sent. */
  countPendingWakeForgets(): Promise<number>;
  /** The registered crons by name with each one's last reported run. */
  listWakeCrons(): Promise<JobsWake.WakeCronRow[]>;
  /** Register a cron name. */
  addWakeCron(name: string): Promise<void>;
  /** Unregister a cron name and end the open watches on it; the watches that ended. */
  removeWakeCron(name: string): Promise<JobsWake.EndedWakeWatch[]>;
  /** Whether a cron name is registered. */
  hasWakeCron(name: string): Promise<boolean>;
  /** Record one cron run, drop that cron's runs older than 30 days, and say whether the name is registered. */
  recordWakeCronRun(run: { name: string; status: string; finishedAt: string | null }): Promise<{ registered: boolean }>;
  /** Whether a principal key accepted a terms version. */
  hasWakeTermsAcceptance(principalKey: string, termsVersion: string): Promise<boolean>;
  /** Record a terms acceptance (one already recorded stays). */
  recordWakeTermsAcceptance(principalKey: string, termsVersion: string): Promise<void>;
  /** The open, due, unleased watches whose target settled (at most 20), each with the job, write request or cron run it watches. */
  listDueWakeWatches(spec?: { ids?: readonly number[] }): Promise<JobsWake.WakeRow[]>;
  /** Lease one due watch; its lease token and attempts, or null when it is not due or leased. */
  claimWakeWatch(id: number, leaseSeconds: number): Promise<{ lease: string; attempts: number } | null>;
  /** Settle a leased watch; false when it was ended or re-leased meanwhile. */
  settleWakeWatch(settle: JobsWake.WakeWatchSettle): Promise<boolean>;
  /** Queue a Wakeshift forget of a user (once while one is pending); with a member id, only when that member is not removed. */
  queueWakeForget(wakeUser: string, memberId: string | null): Promise<void>;
  /** A removed member's Wakeshift state: queue a forget of each user it watched under, end its open watches, drop its terms acceptances. */
  forgetWakeMember(memberId: string): Promise<{ ended: number; queued: number }>;
  /** A revoked token's or deleted OAuth client's Wakeshift state: queue a forget of each user its member-less watches ran under, end its open watches, drop its terms acceptances. */
  forgetWakeCredential(kind: JobsWake.WakeCredentialKind, id: string): Promise<{ ended: number; queued: number }>;
  /** Lease up to `limit` due pending forgets. */
  claimWakeForgets(spec: { leaseSeconds: number; limit: number }): Promise<JobsWake.WakeForgetClaim[]>;
  /** Settle a leased forget; false when its lease no longer matches. */
  settleWakeForget(settle: JobsWake.WakeForgetSettle): Promise<boolean>;

  // Doctor reads (engine-sql/doctor-reads.ts): the statements doctor checks ran through executeRaw.
  /** Rows of a page-child relation (`<table>.<column>`) whose page row is gone; a NULL reference of a SET NULL column is not one. */
  countPageChildOrphans(target: DoctorReadsSql.PageChildTarget): Promise<number>;

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
  /** One keyset batch of world atoms whose source page names a facts or takes fence. */
  listAtomFenceCandidates(opts: { sourceIds: string[]; atomId: number | null; after: number; limit: number; timeoutMs?: number }): Promise<DoctorDerivedSql.AtomFenceCandidateRow[]>;
  /** The compiled text of pages by id. */
  readPageCompiledTruths(ids: number[], timeoutMs?: number): Promise<Array<{ id: number; body: string | null }>>;
  /** Age of the oldest live chunk with no vector in `column`, the chunks with no pending-since stamp, and whether the oldest predates the backfill. */
  readEmbeddingBacklogAge(column: string): Promise<DoctorDerivedSql.EmbeddingBacklogAgeRow | undefined>;
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
  /** The 7-day extract rollup per kind; `withExpected: false` is the pre-v141 text. */
  readExtractRollup7d(withExpected: boolean): Promise<DoctorDerivedSql.ExtractRollupRow[]>;
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
  /** Page versions a managed import archived under a database write, newest first (up to `limit`), narrowed to `slugs` when given. */
  listOverwriteCandidates(sourceId: string, limit: number, slugs: string[] | null): Promise<Array<Record<string, unknown>>>;
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
  /** Pages awaiting atom extraction (no atom of their current content yet, no held or tombstoned disposition) in the query's source scope; `opts.signal` cancels the count on the SQL engines. */
  countAtomExtractionBacklog(query: AtomBacklogSql.AtomBacklogQuery, opts?: { signal?: AbortSignal }): Promise<number>;
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
  /** The failed, conflicted or cancelled receipts that unfinished managed-sync cursors wait on. */
  listContentBlockedReceipts(): Promise<DoctorBrainSql.ContentBlockedReceipt[]>;
  /** The failed, conflicted or cancelled receipts a source's sync pass admitted (the receipt intent carries the pass id). */
  listPassAdmittedReceipts(sourceId: string, passId: string): Promise<DoctorBrainSql.ContentBlockedReceipt[]>;
  /** Connector checkpoint and retry rows no source can load (`before` bounds `updated_at`; `minAgeDays` adds the age floor). */
  listOrphanConnectorCheckpoints(query: DoctorBrainSql.OrphanConnectorCheckpointQuery): Promise<DoctorBrainSql.OrphanCheckpointRow[]>;
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
  /** gbrain-owned content sources with their shared-skills receipt, owner binding and queued work (none on an engine without managed persistence). */
  listOwnedContentRows(sourceIds: readonly string[] | null, inheritsPersistence: boolean): Promise<DoctorSourcesSql.OwnedContentRow[]>;
  /** Live pages of the `default` source and how many of them record a source path. */
  countDefaultSourceFiles(): Promise<DoctorSourcesSql.DefaultSourceFiles>;
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
