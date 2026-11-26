import postgres from '#postgres'
import { tryAcquirePoolLongHold, PoolCapacityError } from './pool-budget.ts';
import { capabilitiesForEngineKind, type EngineCapabilities } from './engine-capabilities.ts';
import { noteRequestConfigWrite, requestConfigRows, requestConfigValue } from './config-snapshot.ts';
import { replaceDerivedLinks, replaceDerivedLinksBatch, type DerivedLinkBatchItem, type DerivedLinkOrigin, type DerivedLinkReplacementOptions } from './derived-links.ts';
import { mutatePageTag } from './page-state/tags.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import type { GetVersionsOpts, PageVersionRows } from './page-state/version-types.ts';
import { assertPageRevision } from './page-state/types.ts';
import { assertOriginUnclaimed, assertRevivalUnclaimed, classifyOriginUniqueViolation } from './persistence/origin-guard.ts';
import { lockUnheldPageKeys, withHeldPageKeys, type HeldPageKeys } from './page-state/guards.ts';
import { readPageSnapshot as readCanonicalPageSnapshot } from './page-state/snapshot.ts';
import { ReadDeadlineError, readDeadline, readDeadlineSignal } from './read-deadline.ts';
import { readPageSnapshotsBatch } from './page-snapshot-batch.ts';
import { createPageVersion, type VersionHistory } from './page-state/versions.ts';
import { moveSlugBindings, recordRenameAlias } from './page-state/rename-alias.ts';
import { dropPhantomMigrationDuplicates } from './facts/ontology-rekey.ts';
import { composablePostgresTransaction, transactionMemo, withCommitChecks } from './page-state/transactions.ts';
import type {
  PageReadScope, PageReadPolicy, DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow, Page, PageInput, PageFilters, PageType, Chunk, ChunkInput,
  ChunkReuseRow, StaleChunkRow, StalePageRow, ChunklessPageRow, SearchResult, SearchOpts, ResolvedColumn, Link, GraphNode, GraphPath, TimelineEntry,
  TimelineInput, TimelineOpts, ChronicleTimelineRow, ChronicleTimelineOpts, LastSeenResult, OntologyObservationInput, OntologyMergeResult,
  OntologyValue, OntologyDimensionStat, OntologyConflict, OntologyReadOpts, RawData, PageVersion, BrainStats, BrainHealth, IngestLogEntry,
  IngestLogInput, EngineConfig, EvalCandidate, EvalCandidateInput, EvalCaptureFailure, EvalCaptureFailureReason, SalienceOpts, SalienceResult,
  AnomaliesOpts, AnomalyResult, EmotionalWeightInputRow, EmotionalWeightWriteRow, EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';
import type { TrustTier, TaintTable, WriteOrigin } from './trust/tier.ts';
import {
  readRelationalFanout, readChainHop, readAliases, readBacklinkCounts, readAdjacencyBoosts, readContentFlags, readExtractionStates,
  readEffectiveDates, readSalienceScores,
} from './search/read-enrichment.ts';
import { reservedTransactions, type ReservedTransactions } from './postgres-engine/reserved-transactions.ts';
import { holdSearchConnection } from './search/connection-budget.ts';
import { traceSqlOptions } from './sql-trace.ts';
import { tlsRequiredDefaultError, withPgTls } from './pg-tls.ts';
import { hasPostgresCancellationCapability, postgresCancellationUnavailable, reserveWithCancellation } from './postgres-engine/cancellation.ts';
import { runBoundedStatement, runDeadlineRead } from './postgres-engine/bounded-statement.ts';
import { needsJitOff, runJitOffStatement } from './postgres-engine/jit-off-statement.ts';
import { retrySchemaReplayOnDeadlock, schemaDiagnosticConnection, withSchemaLockTimeout } from './postgres-engine/schema-lock-timeout.ts';
import type {
  BrainEngine, BatchOpts, LinkBatchInput, TimelineBatchInput, ReservedConnection, DreamVerdict, DreamVerdictInput, FileSpec, FileRow,
  ListFilesOptions, TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow, StaleTakeOpts, TakeEmbeddingInput, TakeResolution,
  SynthesisEvidenceInput, TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts, FactRow, FactInsertStatus, NewFact,
  FactListOpts, RecallFactReadOpts, FactsHealth, SourceRow, PageTrustLookup, RowTrustLookup, PageAtRevisionRef, WantedLinkRowsReplacement,
} from './engine.ts';
import { withRetry, BULK_RETRY_OPTS, resolveBulkRetryOpts, computeNextDelay, isRetryableConnError, type BatchAuditSite } from './retry.ts';
import { isConnectionEndedError } from './retry-matcher.ts';
import { CheckoutGauge, PoisonedDiscardCounter, PoolIncidentCounter, type PoolGaugeSnapshot } from './pool-gauge.ts';
import { driverPoolStats, enginePoolStats, type DriverPoolStats } from './postgres-engine/pool-stats.ts';
import { valueHash, normalizeDimension, isNovelDimension, isBackdatedObservation, ONTOLOGY_SUPERSEDE_GUARD, NOT_CONVERSATION_SLOT_SQL, CONVERSATION_SLOT_SQL } from './chronicle/ontology.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import { DREAM_VERDICT_TTL_SECONDS, clampSearchLimit, type CycleLockFilter, type TransactionOptions } from './engine.ts';
import { transactionAborted, withTransactionAbort, type Discardable } from './postgres-engine/transaction-abort.ts';
import { readWriteTransactions, retryReadOnlyAutocommit } from './postgres-engine/read-write-transactions.ts';
import { searchLimitCap } from './search/eval-pool-depth.ts';
import { executeRawJsonb, type SqlValue } from './sql-query.ts';
import { sanitizeForJsonb, sanitizeText, buildLinkRows, buildTimelineRows } from './batch-rows.ts';
import { SCHEMA_SQL } from './schema-embedded.generated.ts';
import { verifySchema } from './schema-verify.ts';
import { applyChunkEmbeddingIndexPolicy, dropZombieIndexes, supportsHnswIterativeScan } from './vector-index.ts';
import { searchIndexWalk, searchVectorPool, readVectorPool, remainingVectorBudget, type VectorPoolAttempt, POOL_MAX_SCAN_TUPLES } from './search/vector-pool.ts';
import {
  buildVectorSearchStatement, PAGE_SOURCE_STATS_SQL, SCOPE_CHUNKS_SQL, VECTOR_EXTENSION_VERSION_SQL, vectorScopeLoader, vectorStatementForms,
  type PageSourceStats, type ScopeChunkCount, type VectorSearchStatement,
} from './search/vector-statement.ts';
import { VECTOR_SETTING_DEFAULTS, vectorScanSettings } from './search/vector-settings.ts';
import { guardSearchStatistics } from './search/projection-statistics.ts';
import {
  vectorCastSuffix, resolveActiveEmbeddingColumnFromEngine, resolveWriteColumnFromConfigRows, quoteIdentifier, COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from './search/embedding-column.ts';
import { getFtsLanguage, applyFtsLanguagePolicy } from './fts-language.ts';
import { splitEmbeddingSignature, currentSpaceChunkPredicate, lockEmbeddingSources } from './embedding-invalidation.ts';
import { SAFE_FENCE_CHUNKER_VERSION, bodyWriteChunkVersion, chunkManifestReads, currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from './search/safe-chunks.ts';
import { GBrainError, PAGE_SORT_SQL } from './types.ts';
import { finalizeLastSeen } from './chronicle/last-seen.ts';
import * as db from './db.ts';
import { ConnectionManager, DEFAULT_DIRECT_POOL_SIZE } from './connection-manager.ts';
import { logConnectionEvent } from './connection-audit.ts';
import { drainBackgroundWorkBeforeDisconnect } from './background-work.ts';
import { abortGuarded, requestSignal, throwIfRequestAborted } from './request-signal.ts';
import { refuseAborted } from './engine-sql/abort-aware.ts';
import {
  validateSlug, contentHash, isBlankBody, rowToPage, rowToStalePage, rowToChunk, rowToSearchResult, parseEmbedding, tryParseEmbedding,
  isUndefinedTableError, warnOncePerProcess,
} from './utils.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import {
  buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildBestPerPagePoolCte, buildOrFallbackWebsearchQuery, boundWebsearchQuery,
  collapseWebsearchDashRuns, keywordPhraseFactorSql,
} from './search/sql-ranking.ts';
import { commonOrTokens, narrowedOrFallbackText, readOrTokenShares } from './search/keyword-or-narrow.ts';
import { keywordArmRows } from './search/keyword-identifier-probe.ts';
import { RARE_TERM_CHUNK_CAP, rankOrFallbackByRarity, rareTermPagesSql, type RareTermPages } from './search/keyword-or-rarity.ts';
import { buildKeywordChunkMatch, keywordCandidatesSql, KEYWORD_RANK_CANDIDATES, KEYWORD_RANKED_ROWS_CTE, KEYWORD_STATEMENT_SETTINGS } from './search/keyword-chunk-match.ts';
import {
  privatePagesFilterFragment, privateSnapshotFilterFragment, privateLinkOriginFilterFragment, privateTimelineEventFilterFragment,
  privateFactFilterForReader, privatePagesFilterForCaller,
} from './search/private-visibility.ts';
import { deletedPageProjectionHiddenSql } from './eligibility/sql.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { readStoredEmbeddingIdentity } from './stored-embedding-identity.ts';
import { assertEmbeddedEmbedding, embeddedSchemaEmbedding, embeddedSettingsRecord, isEmbeddedEngine, settingsConnectionOptions } from './embedded-engine.ts';
import { DELETE_BATCH_SIZE, TRAVERSE_PATH_ROW_CAP, TRAVERSE_WALK_ROW_CAP } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from './embed-skip.ts';
import { holdSchemaMigrationSessionLock, holdSchemaMigrationTransactionLock } from './postgres-engine/init-schema-lock.ts';
import { assertSchemaNotAhead } from './schema-client-behind.ts';
import { deadlineReadSettings, isPipelinableSearchRead, SEARCH_JIT_OFF, withSearchJitOff, withSearchSettings, type SearchSettings } from './postgres-engine/search-settings.ts';
import { loadKeywordStatementTimeout } from './postgres-engine/keyword-statement-timeout.ts';
import { applyPostgresForwardReferenceBootstrap } from './engine-sql/bootstrap.ts';
import * as factsImpl from './engine-sql/facts.ts';
import * as embedStaleWorkImpl from './engine-sql/embed-stale-work.ts';
import * as embeddingProvenanceImpl from './engine-sql/embedding-provenance.ts';
import * as synopsisTierImpl from './engine-sql/synopsis-tier.ts';
import * as sourceCrModeImpl from './engine-sql/source-cr-mode.ts';
import * as syncReasonReadsImpl from './engine-sql/sync-reason-reads.ts';
import * as trustWithdrawalsImpl from './engine-sql/trust-withdrawals.ts';
import * as beliefLedgerImpl from './engine-sql/belief-ledger.ts';
import * as beliefStateImpl from './engine-sql/belief-state.ts';
import * as beliefPurgeImpl from './engine-sql/belief-purge.ts';
import * as openLoopsImpl from './engine-sql/open-loops.ts';
import * as loopMutesImpl from './engine-sql/loop-mutes.ts';
import * as sourceArchiveImpl from './engine-sql/source-archive.ts';
import * as entityIdentitiesImpl from './engine-sql/entity-identities.ts';
import type { EntityIdentityFilter, EntityIdentityLinkInput, EntityIdentityUnlinkInput } from './engine-sql/entity-identities.ts';
import type { ListLoopsOpts as OpenLoopListOpts, LoopStatus as OpenLoopStatus, OpenLoopUpsert as OpenLoopUpsertInput } from './loops/loops-store.ts';
import * as trustWriteGateImpl from './engine-sql/trust-write-gate.ts';
import * as takesImpl from './engine-sql/takes.ts';
import * as codeEdgesImpl from './engine-sql/code-edges.ts';
import * as pageSpendImpl from './engine-sql/page-spend.ts';
import * as codeTraversalCache from './engine-sql/code-traversal-cache.ts';
import * as salienceImpl from './engine-sql/salience.ts';
import * as pageLookupImpl from './engine-sql/page-lookup.ts';
import type { FindPagesQuery, FoundPages } from './page-find.ts';
import type { PageCountQuery, PageCounts, TypeGrouper } from './page-counts.ts';
import * as healthImpl from './engine-sql/health.ts';
import { resolveEntityTypes } from './schema-pack/entity-types.ts';
import * as pagesImpl from './engine-sql/pages.ts';
import * as entityKeysImpl from './engine-sql/entity-keys.ts';
import type { EntityKeyRow, EntityKeyRowsOpts } from './engine-sql/entity-keys.ts';
import * as identityDecisionsImpl from './engine-sql/identity-decisions.ts';
import * as tagsImpl from './engine-sql/tags.ts';
import * as linksImpl from './engine-sql/links.ts';
import * as wantedLinksImpl from './engine-sql/wanted-links.ts';
import * as timelineImpl from './engine-sql/timeline.ts';
import * as sourcesImpl from './engine-sql/sources.ts';
import * as linkSlugReadsImpl from './engine-sql/link-slug-reads.ts';
import * as slugSpellingsImpl from './engine-sql/slug-spellings.ts';
import * as federationExposureImpl from './engine-sql/federation-exposure.ts';
import * as notifierImpl from './engine-sql/notifier.ts';
import * as cliReadsImpl from './engine-sql/cli-reads-import.ts';
import * as listReadsImpl from './engine-sql/list-reads.ts';
import * as writeMiscImpl from './engine-sql/write-misc.ts';
import * as chronicleLedger from './engine-sql/chronicle-ledger.ts';
import * as pageMutationReads from './engine-sql/page-mutation-reads.ts';
import * as repairBookkeepingImpl from './engine-sql/repair-bookkeeping.ts';
import * as managedSyncOrphansImpl from './engine-sql/managed-sync-orphans.ts';
import * as ownedContentImpl from './engine-sql/owned-content.ts';
import * as repairPageReadsImpl from './engine-sql/repair-page-reads.ts';
import * as aliasOrphansImpl from './engine-sql/alias-orphans.ts';
import * as repairPageScansImpl from './engine-sql/repair-page-scans.ts';
import * as repairFenceScansImpl from './engine-sql/repair-fence-scans.ts';
import * as repairPlanScansImpl from './engine-sql/repair-plan-scans.ts';
import type { AttributionTable } from './engine-sql/repair-plan-scans.ts';
import * as gitHoldsImpl from './engine-sql/git-holds.ts';
import * as repairBusyImpl from './engine-sql/repair-busy.ts';
import * as worktreeClaimImpl from './engine-sql/worktree-claim.ts';
import type { WorktreeClaimStore } from './engine-sql/worktree-claim.ts';
import * as writerAdminImpl from './engine-sql/writer-admin.ts';
import type { WriterAdminStateOptions, WriterAdminStore } from './engine-sql/writer-admin.ts';
import * as writerReleaseImpl from './engine-sql/writer-release.ts';
import type { CounterColumn, WriterReleaseStore } from './engine-sql/writer-release.ts';
import * as publicationJournalImpl from './engine-sql/publication-journal.ts';
import * as gitDurabilityImpl from './engine-sql/git-durability.ts';
import * as gitEffectsImpl from './engine-sql/git-effects.ts';
import * as topologyStoreImpl from './engine-sql/topology-store.ts';
import * as refreshStoreImpl from './engine-sql/refresh-store.ts';
import * as groupPublishStoreImpl from './engine-sql/group-publish-store.ts';
import * as manualLinksImpl from './engine-sql/manual-links.ts';
import * as managedSyncStoreImpl from './engine-sql/managed-sync-store.ts';
import * as writerStatusImpl from './engine-sql/writer-status.ts';
import * as labelDoorImpl from './engine-sql/label-door.ts';
import * as pagePurgeImpl from './engine-sql/page-purge.ts';
import * as pagePurgeSweepImpl from './engine-sql/page-purge-sweep.ts';
import * as pagePurgeJournalImpl from './engine-sql/page-purge-journal.ts';
import * as purgeStoresImpl from './engine-sql/purge-stores.ts';
import * as purgeReceiptImpl from './engine-sql/purge-receipt.ts';
import * as originHoldsImpl from './engine-sql/origin-holds.ts';
import type { DerivedOriginPark } from './persistence/derived-origin-hold.ts';
import * as headBlockerImpl from './engine-sql/head-blocker.ts';
import * as checkpointValidationImpl from './engine-sql/checkpoint-validation.ts';
import * as chronicleExecutorImpl from './engine-sql/chronicle-executor.ts';
import type { StoredWorktreeManifest } from './persistence/worktree-manifest.ts';
import * as writeAttributionImpl from './engine-sql/write-attribution.ts';
import * as opCheckpointImpl from './engine-sql/op-checkpoint.ts';
import * as atomGenerationImpl from './engine-sql/atom-generation.ts';
import * as syncPassPagesImpl from './engine-sql/sync-pass-pages.ts';
import type { SyncImportPageQuery, SyncImportPageWindow } from './engine-sql/sync-pass-pages.ts';
import * as syncRunReadsImpl from './engine-sql/sync-run-reads.ts';
import * as syncAdmissionImpl from './engine-sql/sync-admission.ts';
import type { SyncAdmissionEffectsInput } from './engine-sql/sync-admission.ts';
import type { RowAttributionTarget, VersionRef, WriteAttributionNameIds } from './engine-sql/write-attribution.ts';
import * as persistenceStateImpl from './engine-sql/persistence-state.ts';
import * as persistenceDeclarationImpl from './engine-sql/persistence-declaration.ts';
import type { DurablePersistenceSettings } from './engine-sql/persistence-declaration.ts';
import * as persistenceJournalImpl from './engine-sql/persistence-journal.ts';
import * as persistenceAdmissionImpl from './engine-sql/persistence-admission.ts';
import * as syncHoldReadsImpl from './engine-sql/sync-hold-reads.ts';
import * as syncHoldStoreImpl from './engine-sql/sync-hold-store.ts';
import * as syncStatusReadsImpl from './engine-sql/sync-status-reads.ts';
import type { SyncStatusProbeOptions } from './engine-sql/sync-status-reads.ts';
import type { GitHoldSummaryWeights, SyncPassRowWrite } from './engine-sql/sync-hold-store.ts';
import * as appliedWatermarkReadsImpl from './engine-sql/applied-watermark-reads.ts';
import * as syncDispatchImpl from './engine-sql/sync-dispatch.ts';
import type { GitHoldRecordsQuery } from './engine-sql/sync-hold-reads.ts';
import * as writeGuardsImpl from './engine-sql/write-guards.ts';
import * as pageVisibilityImpl from './engine-sql/page-visibility.ts';
import * as remoteLinksImpl from './engine-sql/remote-links.ts';
import * as factsBackstopImpl from './engine-sql/facts-backstop.ts';
import * as largePageImpl from './engine-sql/large-page.ts';
import * as relationalReadsImpl from './engine-sql/relational-reads.ts';
import * as trustFenceImpl from './engine-sql/trust-fence.ts';
import * as fenceProjectionImpl from './engine-sql/fence-projection.ts';
import * as rowTierImpl from './engine-sql/row-tier.ts';
import * as unwithdrawnRestoreImpl from './engine-sql/unwithdrawn-restore.ts';
import * as fenceHoldsImpl from './engine-sql/fence-holds.ts';
import * as generationsImpl from './engine-sql/derived-generations.ts';
import * as generationLedgerImpl from './engine-sql/generation-ledger.ts';
import * as generationActivationsImpl from './engine-sql/generation-activations.ts';
import * as generationRepairImpl from './engine-sql/generation-repair.ts';
import * as generationFenceEvidenceImpl from './engine-sql/generation-fence-evidence.ts';
import * as chronicleEventsImpl from './engine-sql/chronicle-events.ts';
import * as generationPageRowsImpl from './engine-sql/generation-page-rows.ts';
import * as generationAtomReadsImpl from './engine-sql/generation-atom-reads.ts';
import * as generationFenceRestoreImpl from './engine-sql/generation-fence-restore.ts';
import * as persistenceClaimsImpl from './engine-sql/persistence-claims.ts';
import * as housekeepingImpl from './engine-sql/persistence-housekeeping.ts';
import * as effectScansImpl from './engine-sql/persistence-effect-scans.ts';
import * as ownerScansImpl from './engine-sql/persistence-owner-scans.ts';
import * as effectWorkerImpl from './engine-sql/persistence-effect-worker.ts';
import * as idleProbeImpl from './engine-sql/persistence-idle-probe.ts';
import * as noopSettleImpl from './engine-sql/persistence-embedding-noop-settle.ts';
import type { ProjectionScanCursor } from './page-state/projection-window.ts';
import type { TrustTable } from './trust/schema.ts';
import * as trustProposalsImpl from './engine-sql/trust-proposals.ts';
import * as cliReadsOpsImpl from './engine-sql/cli-reads-ops.ts';
import * as exportReadsImpl from './engine-sql/export-reads.ts';
import * as segmentedWritesImpl from './engine-sql/segmented-writes.ts';
import * as factsDoctorImpl from './engine-sql/facts-doctor.ts';
import * as embeddingCatalogImpl from './engine-sql/embedding-catalog.ts';
import * as frontmatterIdsImpl from './engine-sql/frontmatter-ids.ts';
import * as chronicleReadsImpl from './engine-sql/chronicle-reads.ts';
import * as factRelinkImpl from './engine-sql/fact-relink-attempts.ts';
import * as factRelinkWritesImpl from './engine-sql/fact-relink-writes.ts';
import * as factsCycleImpl from './engine-sql/facts-cycle.ts';
import * as factsPurgeImpl from './engine-sql/facts-purge.ts';
import * as factsPurgePlanImpl from './engine-sql/facts-purge-plan.ts';
import * as projectionRebuildImpl from './engine-sql/projection-rebuild.ts';
import * as dreamCycleImpl from './engine-sql/dream-cycle.ts';
import * as factsRepairImpl from './engine-sql/facts-repair.ts';
import * as repairAppliesImpl from './engine-sql/repair-applies.ts';
import * as visibilityScansImpl from './engine-sql/visibility-scans.ts';
import * as openTwinsImpl from './engine-sql/open-twins.ts';
import * as openFactsScansImpl from './engine-sql/open-facts-scans.ts';
import * as privateLabelScansImpl from './engine-sql/private-label-scans.ts';
import type * as PrivateLabelScansSql from './engine-sql/private-label-scans.ts';
import type * as OpenFactsScansSql from './engine-sql/open-facts-scans.ts';
import type * as OpenTwinsSql from './engine-sql/open-twins.ts';
import type * as RepairAppliesSql from './engine-sql/repair-applies.ts';
import * as labelRepairImpl from './engine-sql/label-repair-reads.ts';
import * as factTextRepair from './engine-sql/fact-text-repair.ts';
import * as overwriteReads from './engine-sql/overwrite-reads.ts';
import * as atomRestoreReads from './engine-sql/atom-restore-reads.ts';
import * as movedPageReads from './engine-sql/moved-page-reads.ts';
import * as meetingPages from './engine-sql/meeting-pages.ts';
import * as attendancePages from './engine-sql/attendance-pages.ts';
import * as connectorAttempts from './engine-sql/connector-attempts.ts';
import * as connectorDbCursor from './engine-sql/connector-db-cursor.ts';
import * as lostFenceReads from './engine-sql/lost-fence-reads.ts';
import * as staleAtomReads from './engine-sql/stale-atom-reads.ts';
import * as remirrorEffects from './engine-sql/segmented-mirror-effects.ts';
import * as fenceRepairRecords from './engine-sql/fence-repair-records.ts';
import * as budgetLedgerWrites from './engine-sql/budget-ledger-writes.ts';
import * as secretStoreRows from './engine-sql/secret-store.ts';
import * as secretSpansRows from './engine-sql/secret-spans-rows.ts';
import * as twinMergeMoves from './engine-sql/twin-merge-moves.ts';
import * as renameAliasRows from './engine-sql/rename-alias-rows.ts';
import * as filesOpsImpl from './engine-sql/files-ops.ts';
import * as contradictionsCycleImpl from './engine-sql/contradictions-cycle.ts';
import * as ontologyRepairImpl from './engine-sql/ontology-repair.ts';
import * as adminReadsImpl from './engine-sql/admin-reads.ts';
import * as factsRecallImpl from './engine-sql/facts-recall.ts';
import * as factsTrustImpl from './engine-sql/facts-trust.ts';
import * as derivationTrustImpl from './engine-sql/derivation-trust.ts';
import * as factsConversationImpl from './engine-sql/facts-conversation.ts';
import type * as FactsConversationSql from './engine-sql/facts-conversation.ts';
import type { ExactScanOpts } from './search/exact-scan.ts';
import type { ExactIdentityStatementOpts } from './engine-sql/exact-identity.ts';
import type { RankCoverageStatementOpts, RankEntitiesStatementOpts } from './engine-sql/graph-rank.ts';
import * as transactionSettingsImpl from './engine-sql/transaction-settings.ts';
import * as writerVersionsImpl from './engine-sql/writer-versions.ts';
import * as connectGateImpl from './engine-sql/connect-gate.ts';
import * as beliefImpl from './engine-sql/belief.ts';
import * as searchVectorImpl from './engine-sql/search-vector.ts';
import * as configImpl from './engine-sql/config.ts';
import * as accessControlImpl from './engine-sql/access-control.ts';
import * as pinnedQuestionsImpl from './engine-sql/pinned-questions.ts';
import * as volunteerEventsImpl from './engine-sql/volunteer-events.ts';
import * as retrievalFeedbackImpl from './engine-sql/retrieval-feedback.ts';
import * as gitGapCensusImpl from './engine-sql/git-gap-census.ts';
import type { GitGapBatch } from './engine-sql/git-gap-census.ts';
import type { OwnerOnlyForm } from './access/owner-only.ts';
import type { RetrievalEventInsert, RetrievalRatingBatch } from './engine-sql/retrieval-feedback.ts';
import type { VolunteerEventInsert } from './engine-sql/volunteer-events.ts';
import type { PinnedQuestionFilter, PinnedQuestionInsert } from './engine-sql/pinned-questions.ts';
import * as accessPolicyImpl from './engine-sql/access-policy.ts';
import * as accessSetupImpl from './engine-sql/access-setup.ts';
import type {
  AccessCredentialLookup, AccessCredentialRow, AccessMemberLookup, AccessMemberRow, LiveMemberRow, LiveMemberVia, AudiencePrincipalRows,
  MayActForVia, FolderAccessRows, JobPrincipalKind, AccessGroupRow, PageNamingReaderRow, MemberBindingVia,
} from './engine-sql/access-control.ts';
import * as extractBookkeepingImpl from './engine-sql/extract-bookkeeping.ts';
import * as cycleLocksImpl from './engine-sql/cycle-locks.ts';
import * as jobsImpl from './engine-sql/jobs.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, ListJobsFilter } from './engine-sql/jobs.ts';
import * as jobsQueue from './engine-sql/jobs-queue.ts';
import * as jobsHealth from './engine-sql/jobs-health.ts';
import * as engineMigration from './engine-sql/engine-migration.ts';
import type { QueueDivergenceSpec, QueueHealthSpec } from './engine-sql/jobs-health.ts';
import * as jobsStatus from './engine-sql/jobs-status.ts';
import type { JobStatusFilter } from './engine-sql/jobs-status.ts';
import * as jobsChecks from './engine-sql/jobs-checks.ts';
import * as calibrationProfiles from './engine-sql/calibration-profiles.ts';
import type * as CalibrationProfilesSql from './engine-sql/calibration-profiles.ts';
import * as decideProposals from './engine-sql/decide-proposals.ts';
import * as jobsWake from './engine-sql/jobs-wake.ts';
import type { DeadDreamSubmissionSpec } from './engine-sql/jobs-checks.ts';
import * as jobsInsight from './engine-sql/jobs-insight.ts';
import * as jobsSpend from './engine-sql/jobs-spend.ts';
import * as spendLog from './engine-sql/spend-log.ts';
import * as oauthClients from './engine-sql/oauth-clients.ts';
import * as accessTokens from './engine-sql/access-tokens.ts';
import * as jobsSubagent from './engine-sql/jobs-subagent.ts';
import * as takesReads from './engine-sql/takes-reads.ts';
import * as takeProposals from './engine-sql/take-proposals.ts';
import * as extractBookkeeping from './engine-sql/extract-bookkeeping.ts';
import * as purgeSlugStores from './engine-sql/purge-slug-stores.ts';
import * as conceptRebuildSql from './engine-sql/concept-rebuild.ts';
import * as graduationCatalog from './engine-sql/graduation-catalog.ts';
import * as trustTierReads from './engine-sql/trust-tier-reads.ts';
import * as versionReasons from './engine-sql/version-reasons.ts';
import * as versionPrune from './engine-sql/version-prune.ts';
import * as segmentedPurgeWrites from './engine-sql/segmented-purge-writes.ts';
import * as pageViewDigests from './engine-sql/page-view-digests.ts';
import * as memoryMutationReads from './engine-sql/memory-mutation-reads.ts';
import * as withdrawalDiscoveryReads from './engine-sql/withdrawal-discovery.ts';
import * as withdrawalPages from './engine-sql/withdrawal-pages.ts';
import * as withdrawalFence from './engine-sql/withdrawal-fence.ts';
import type { CancelJobsSpec, DelayActiveJobSpec, JobAttachmentInsert, JobPageSpec, JobTokenCounts, PruneJobsSpec, RetryJobPolicy, SynthesisCompletionPrefix } from './engine-sql/jobs-queue.ts';
import { noteDirectPoolLease } from './direct-pool-profile.ts';
import * as filesImpl from './engine-sql/files.ts';
import type { ChunkWindowRequest, ChunkWindowOpts, ChunkWindowPage } from './search/chunk-windows.ts';
import type { KeywordPageWindow } from './search/keyword-statement.ts';
import { frontmatterWhereSql } from './search/frontmatter-where.ts';
import type { EmbeddingState, EmbeddingStateCounts, EmbeddingStateRow } from './embedding-state.ts';
import * as chunksImpl from './engine-sql/chunks.ts';
import * as searchReadsImpl from './engine-sql/search-reads.ts';
import * as linkReadsImpl from './engine-sql/link-reads.ts';
import * as linkTemporalImpl from './engine-sql/link-temporal.ts';
import * as retrievalCoverageImpl from './engine-sql/retrieval-coverage.ts';
import { backfillChunkVectors, backfillPageVectors, type VectorBackfillOpts } from './search-vector-backfill.ts';
import { ensureFactsFtsIndex } from './facts/fts-index.ts';
import type { RelationshipKey, RelationshipStateWrite } from './link-relationships.ts';
import type { CoverageRelevance } from './search/retrieval-coverage.ts';
import type { ProjectionReadinessScope } from './search/projection-readiness.ts';
import * as chunkReadsImpl from './engine-sql/chunk-reads.ts';
import * as timelineReadsImpl from './engine-sql/timeline-reads.ts';
import * as timelineRepairImpl from './engine-sql/timeline-repair-reads.ts';
import type { TimelineRowDeletion } from './engine-sql/timeline-reads.ts';
import * as telemetryImpl from './engine-sql/telemetry.ts';
import * as chatUsageImpl from './engine-sql/chat-usage.ts';
import * as fieldUsageImpl from './engine-sql/field-usage.ts';
import * as decideStoreImpl from './engine-sql/decide-store.ts';
import * as aliasFanoutReadsImpl from './engine-sql/alias-fanout-reads.ts';
import type { McpRequestLogRow, SearchTelemetryBucket, McpRequestCountKind } from './engine-sql/telemetry.ts';
import type { CodeChunkScope, CodeSymbolQuery, FrozenHitKey, UnsealedPageScope, WithdrawalChunkKey } from './engine-sql/chunk-reads.ts';
import type { ChunkMove } from './page-state/chunk-moves.ts';
import type { DerivedAliasRow } from './engine-sql/pages.ts';
import * as ownerOnlyMarksImpl from './engine-sql/owner-only-marks.ts';
import type { OwnerOnlyTriggerState } from './access/owner-only-marks.ts';
import { ownerOnlyLineageReadable } from './access/owner-only.ts';
import * as pageBodyImpl from './engine-sql/page-body.ts';
import { runDerivationSweep } from './page-body/segment-derive.ts';
import type {
  BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState, ManifestRow, ManifestRowInput, SegmentChunkInput, SegmentedEmbedRef,
  SegmentedPageMeta, SegmentSweepOptions, SegmentSweepResult, SegmentTextInput,
} from './page-body/types.ts';
import type { SegmentDerivationInput, SegmentDerivationKind, SegmentDerivationRow } from './page-body/derivations.ts';
import { hasCJK } from './cjk.ts';
import { searchKeywordCJK as searchKeywordCJKImpl } from './engine-sql/cjk-search.ts';
import { KeywordTimeoutNegativeCache, keywordRerunPoolIdle } from './postgres-engine/keyword-timeout-cache.ts';
import * as titlesImpl from './engine-sql/titles.ts';
import * as keywordPagesImpl from './engine-sql/keyword-pages.ts';
import * as entityReadsImpl from './engine-sql/entity-reads.ts';
import * as mentionPassImpl from './engine-sql/mention-pass.ts';
import * as mentionReadsImpl from './engine-sql/mention-reads.ts';
import * as segmentDeriveStoreImpl from './engine-sql/segment-derive-store.ts';
import * as pageEmbeddingBudgetImpl from './engine-sql/page-embedding-budget.ts';
import * as embeddingInstallImpl from './engine-sql/embedding-install.ts';
import type { CjkKeywordCtx } from './search/cjk-keyword-sql.ts';
import { postgresExecutor, type RunUnsafeOpts } from './engine-sql/dialect-postgres.ts';
import type { SqlExecutor } from './engine-sql/executor.ts';
import { scopedRead, unscopedExecutor } from './engine-sql/brands.ts';
import { writerStamp } from './persistence/writer-versions.ts';
import { wellFormedJson } from './text-safe.ts';
import { ENGINE_ROOT } from './engine-root.ts';
import { insertEvalCandidate } from './feedback/store.ts';
import * as accessGrantsImpl from './engine-sql/access-grants.ts';
import * as accessMembersImpl from './engine-sql/access-members.ts';
import type * as AccessMembersSql from './engine-sql/access-members.ts';
import * as sharedSkillMembersImpl from './engine-sql/shared-skill-members.ts';
import type * as SharedSkillMembersSql from './engine-sql/shared-skill-members.ts';
import * as reflexReadsImpl from './engine-sql/reflex-reads.ts';
import * as briefReadsImpl from './engine-sql/brief-reads.ts';
import * as doctorReadsImpl from './engine-sql/doctor-reads.ts';
import * as doctorDerivedImpl from './engine-sql/doctor-derived.ts';
import * as doctorPersistenceImpl from './engine-sql/doctor-persistence.ts';
import * as doctorPagesImpl from './engine-sql/doctor-pages.ts';
import * as doctorTalliesImpl from './engine-sql/doctor-tallies.ts';
import * as doctorSearchImpl from './engine-sql/doctor-search.ts';
import * as atomBacklogImpl from './engine-sql/atom-backlog.ts';
import type { AtomBacklogQuery } from './engine-sql/atom-backlog.ts';
import * as projectionBacklogImpl from './engine-sql/projection-backlog.ts';
import * as doctorAccImpl from './engine-sql/doctor-acc.ts';
import * as doctorCheckpointsImpl from './engine-sql/doctor-checkpoints.ts';
import * as doctorTerminalImpl from './engine-sql/doctor-terminal.ts';
import * as doctorBrainImpl from './engine-sql/doctor-brain.ts';
import * as doctorSyncImpl from './engine-sql/doctor-sync.ts';
import * as doctorFactsTrustImpl from './engine-sql/doctor-facts-trust.ts';
import * as fenceCensusImpl from './engine-sql/fence-census.ts';
import * as doctorSourcesImpl from './engine-sql/doctor-sources.ts';
import * as schemaDetectImpl from './engine-sql/schema-detect.ts';
import * as queryCacheInvalidateImpl from './engine-sql/query-cache-invalidate.ts';
import * as accessReadLogImpl from './engine-sql/access-read-log.ts';
import * as handoverReadsImpl from './engine-sql/handover-reads.ts';
import * as sweepReadsImpl from './engine-sql/sweep-reads.ts';
import * as sessionStateImpl from './engine-sql/session-state.ts';
import type { DrainLeaseHolderRecord } from './engine-sql/cycle-locks.ts';
import * as accessCredentials from './engine-sql/access-credentials.ts';
import * as clientGrants from './engine-sql/client-grants.ts';
import * as oauthRevocation from './engine-sql/oauth-revocation.ts';
import type { OauthGrantAuditInsert } from './engine-sql/oauth-revocation.ts';
import type { OauthClientGrantPersist } from './engine-sql/client-grants.ts';
import type {
  AccessTokenGrantWrite, AccessTokenPrivateAxis, ActiveTokenGrantField, ActiveTokenTarget, LegacyTokenGrantColumns, OauthClientGrantInsert,
  OauthClientProbe, OauthTokenInsert, OauthTokenRung, ScopeSourceLock, TokenByHashCaller, OauthCodeInsert,
} from './engine-sql/access-credentials.ts';
import * as trustScan from './engine-sql/trust-scan.ts';
import * as doctorJoinImpl from './engine-sql/doctor-join.ts';
import * as readSharedSources from './engine-sql/read-shared-sources.ts';

export { hasPostgresCancellationCapability } from './postgres-engine/cancellation.ts';
// Engine-path imports stay static unless a call site carries an explicit
// engine-dynamic-import-ok justification. The gateway is the only current
// exception because its local try/catch preserves a soft fallback.

/**
 * #6278: how long a cancelled statement may stay unsettled after its cancel request before the reserved
 * connection is discarded to settle it client-side. A transaction-mode pooler (Supavisor :6543) may not
 * forward the cancel, leaving the backend in ClientRead where no server timeout applies.
 */
export const DEFAULT_CANCEL_SETTLE_MS = 2_000;
export function cancelSettleMs(): number {
  const raw = Number(process.env.GBRAIN_CANCEL_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : DEFAULT_CANCEL_SETTLE_MS;
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function getPostgresSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
  const sanitizedModel = escapeSqlStringLiteral(String(model));
  return applyFtsLanguagePolicy(applyChunkEmbeddingIndexPolicy(SCHEMA_SQL, parsedDims))
    .replace(/vector\(1536\)/g, `vector(${parsedDims})`)
    .replace(/'text-embedding-3-large'/g, `'${sanitizedModel}'`)
    .replace(/\('embedding_dimensions', '1536'\)/g, `('embedding_dimensions', '${parsedDims}')`);
}

// CONNECTION_ERROR_PATTERNS / isConnectionError were used by the per-call
// executeRaw retry that #406 originally shipped. Eng-review D3 dropped that
// retry as unsound (regex idempotence-boundary doesn't hold for writable
// CTEs or side-effecting SELECTs). Recovery now happens at the supervisor
// level (3-strikes-then-reconnect). The unit tests in
// test/connection-resilience.test.ts retain a self-contained copy of the
// helper so the regression-against-future-reintroduction guard still works.
// See TODOS.md item: "err.code-based connection-error matching" for the
// follow-up that will reintroduce a typed retry mechanism.

/** Runs `fn` unless the request's signal already fired, as `executeRaw` and `decideRead` do (GBRA-156): an aborted request sends no statement. */
async function whenNotAborted<T>(fn: () => Promise<T>): Promise<T> { throwIfRequestAborted(); return fn(); }

export class PostgresEngine implements BrainEngine {
  readonly [ENGINE_ROOT]: object = this;
  private vectorIterativeScan?: Promise<boolean>;
  private keywordStatementTimeout?: Promise<string>;
  private keywordTimeouts = new KeywordTimeoutNegativeCache(Date.now, undefined, () => keywordRerunPoolIdle(enginePoolStats(this), this._disconnectPromise)); // #7082
  private readonly vectorScope = vectorScopeLoader(() => this.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL), ids => this.executeRaw<ScopeChunkCount>(SCOPE_CHUNKS_SQL, [ids]));
  /** Transaction clones keep chunk invalidation and replacement atomic. */
  private _chunkWritesInTransaction = false;
  readonly kind = 'postgres' as const;
  readonly capabilities: EngineCapabilities = capabilitiesForEngineKind('postgres');
  private readonly _beforeDisconnect = new Set<() => Promise<void>>();
  private _disconnectPromise: Promise<void> | null = null;

  registerBeforeDisconnect(stop: () => Promise<void>): () => void {
    this._beforeDisconnect.add(stop);
    return () => { this._beforeDisconnect.delete(stop); };
  }

  private _sql: ReturnType<typeof postgres> | null = null;
  /** Saved config for reconnection. */
  private _savedConfig: (EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }) | null = null;
  /** Whether a reconnect is in progress (prevents concurrent reconnects). */
  private _reconnecting = false;
  /**
   * Approximate in-flight counters for the health probe's diagnostics
   * (issue #6). Tracks the raw/direct/reserved/tx seams ONLY — see the
   * honesty contract in pool-gauge.ts. Shared by tx-scoped engine clones
   * via the prototype chain (same process, same pools). Fail-open.
   */
  private checkoutGauge = new CheckoutGauge();
  private poisonedDiscards = new PoisonedDiscardCounter();
  private readonly onPoisoned = (pool: 'read' | 'direct', status: string) => this.poisonedDiscards.record(pool, status);
  /** #6383: stuck-connection retirements and build failures, per engine, with their warn lines. */
  private poolIncidents = new PoolIncidentCounter();
  private readonly poolHealth = (pool: 'read' | 'direct') => this.poolIncidents.hooks(pool);
  /**
   * #1471: module-singleton OWNERSHIP token. `true` only for the engine whose
   * connect() actually created the shared db.ts `sql` singleton (returned
   * atomically by db.connect()). Borrowers — probe engines constructed while the
   * singleton already exists (resolveLintContentSanity config-lift, doctor,
   * integrity) — get `false` and must NOT db.disconnect() it, or they null the
   * `sql` the long-lived owner (the cycle engine) still uses and every later
   * phase throws "connect() has not been called". `_connectionStyle` alone can't
   * separate owner from borrower: both are 'module'. Correct because the
   * creator's lifetime dominates all borrowers — the CLI engine is created first
   * and disconnected last (cli.ts), and borrowers are strictly nested.
   */
  private _ownsModuleSingleton = false;
  /**
   * Tracks which connection path this engine is using so disconnect() is
   * idempotent. 'instance' = own _sql pool (poolSize was set);
   * 'module' = the module-level db singleton (backward compat path).
   * null = never connected, or already disconnected. Without this, a second
   * disconnect() on an instance-pool engine would fall through to
   * db.disconnect() and clobber the unrelated module-level connection.
   */
  private _connectionStyle: 'instance' | 'module' | null = null;

  /**
   * v0.30.1 (Fix 1 + X1 + T5): instance-owned ConnectionManager.
   * - INSTANCE-owned: each PostgresEngine constructs its own.
   * - Worker engines (cycle, sync) inherit via opts.parentConnectionManager.
   * - transaction() clones share the parent's via copy.
   * - Module-singleton path (when poolSize unset) wraps the db.ts singleton.
   *
   * Public so callers can access read()/ddl()/bulk()/healthCheck() without
   * threading the manager through every API. doctor's connection_routing
   * check uses it; runMigrations() uses ddl().
   */
  connectionManager: ConnectionManager | null = null;

  // Instance connection (for workers) or fall back to module global (backward compat)
  /** The database URL this engine connected with; the warm CLI socket binds its identity to it (src/core/cli-socket/server.ts). */
  get connectedDatabaseUrl(): string | undefined { return this._savedConfig?.database_url; }
  get sql(): ReturnType<typeof postgres> {
    if (this._sql) return this._sql;
    // issue #1678: an instance-pool engine whose _sql went null (a mid-process
    // disconnect/reconnect, or a reaped socket) must NOT fall through to the
    // module singleton — that singleton was never connected on a worker, so
    // db.getConnection() throws the misleading "connect() has not been called".
    // Throw a tailored RETRYABLE error instead (isRetryableConnError matches
    // problem === 'No database connection'), so a caller wrapped in
    // withRetry+reconnect rebuilds this instance's pool and recovers. The
    // module / never-connected path (style 'module' or null) keeps the legacy
    // getConnection() behavior.
    if (this._connectionStyle === 'instance') {
      throw new GBrainError(
        'No database connection',
        'instance connection pool was torn down (socket reaped or mid-process disconnect)',
        'Transient — the operation reconnects and retries. If it persists, check pooler/Supavisor health.',
      );
    }
    return db.getConnection();
  }

  /**
   * Engine-sql executor over the CURRENT connection (EO1): a fresh adapter on
   * every access, never stored, so a transaction clone (whose `sql` getter
   * returns the tx handle) runs migrated domain SQL inside its transaction.
   */
  private get engineSql(): SqlExecutor {
    return refuseAborted(this.engineSqlOn(this.sql));
  }

  /** engineSql whose statements a read-only session default refused (25006) run once more in BEGIN READ WRITE, as executeRaw's do (#7183). */
  private get autocommitSql(): SqlExecutor {
    return refuseAborted(postgresExecutor(this.sql, {
      runUnsafe: (c, sql, params, opts) => retryReadOnlyAutocommit(c, cc => this.runUnsafe(cc, sql, params, opts)),
      gauge: this.checkoutGauge,
    }));
  }

  /** Executor over a handle the engine yielded (e.g. `withScopedReadTransaction`'s `tx`). */
  private engineSqlOn(conn: ReturnType<typeof postgres>): SqlExecutor {
    return postgresExecutor(conn, {
      runUnsafe: (c, sql, params, opts) => this.runUnsafe(c, sql, params, opts),
      gauge: this.checkoutGauge,
    });
  }

  // Source-scope binding for Postgres RLS — opt-in via env var.
  //
  // When `GBRAIN_RLS_SCOPE_BINDING` is set to `1` / `true`, source-scoped
  // query methods (listPages, search*, getChunks, etc.) wrap their queries
  // in a transaction that begins with
  //   SELECT set_config('app.scopes', '<csv-of-allowed-source-ids>', true)
  // (equivalent to `SET LOCAL app.scopes = '<value>'`, but works through
  //  parameterised SQL — `SET LOCAL` itself doesn't accept parameters)
  // so Postgres RLS policies on source-scoped tables can filter rows by
  // `current_setting('app.scopes', true)`. The expected policy shape:
  //
  //   USING (current_setting('app.scopes', true) = '*'
  //          OR source_id = ANY(string_to_array(
  //             current_setting('app.scopes', true), ',')))
  //
  // Recommended runtime-role default:
  //   ALTER ROLE <runtime-role> SET app.scopes = '*';
  // so admin / autopilot / cycle queries that don't pass scope info still
  // see all rows. OAuth-scoped requests override the default per
  // transaction with their allowed-source CSV.
  //
  // Default behavior (env var unset): the helper is a TRUE pass-through —
  // it calls `callback(this.sql)` with no transaction wrap and no
  // set_config, byte-identical to not having this helper at all. The only
  // exception is callers that pass `alwaysTransaction: true` (the search
  // methods, whose `SET LOCAL statement_timeout` already required a
  // transaction on master) — they keep exactly the `sql.begin()` wrap
  // they had before this helper existed, and pass `jitOff` (#6039,
  // postgres-engine/search-settings.ts). No read gains a new per-read
  // pool-hold when the flag is off (the #1794 PgBouncer-exhaustion class).
  //
  // Honest caveat: only the read paths that route through this helper are
  // backstopped by RLS. This is defense-in-depth layer 2; the app-layer
  // source filters (sourceScopeOpts) remain layer 1 and stay mandatory.
  private get rlsScopeBindingEnabled(): boolean {
    const v = process.env.GBRAIN_RLS_SCOPE_BINDING;
    return v === '1' || v === 'true';
  }

  private async withScopedReadTransaction<T>(
    sourceIds: string[] | undefined,
    sourceId: string | undefined,
    callback: (tx: ReturnType<typeof postgres>) => Promise<T>,
    opts?: { alwaysTransaction?: boolean; jitOff?: boolean; settings?: SearchSettings | (() => SearchSettings) },
  ): Promise<T> {
    const deadlineAt = this._pageTransaction ? undefined : readDeadline();
    // Flag off + no pre-existing transaction need: call through on the
    // shared pool exactly as master does. No tx round-trip, no pool slot
    // held for the duration of the read.
    // Under a read deadline a read wanting its own transaction takes the deadline's, its settings inside (search-settings.ts).
    if (deadlineAt !== undefined && !this.rlsScopeBindingEnabled) return await runDeadlineRead(this.sql, deadlineAt, tx => withSearchSettings(tx, false, deadlineReadSettings(opts, deadlineAt), () => callback(tx)), this.checkoutGauge, cancelSettleMs(), readDeadlineSignal());
    if (!this.rlsScopeBindingEnabled && !opts?.alwaysTransaction) {
      return await callback(this.sql);
    }
    // Precedence matches sourceScopeOpts: federated array > scalar > '*'
    // (unscoped — relies on the recommended `ALTER ROLE ... SET
    // app.scopes = '*'` default, or on no policy being installed).
    let scopesValue = '*';
    if (sourceIds && sourceIds.length > 0) {
      scopesValue = sourceIds.join(',');
    } else if (sourceId) {
      scopesValue = sourceId;
    }
    return this.readTransaction(tx => {
      // One settings statement for the scope binding, JIT off and the
      // caller's settings (a thunk is read here, after BEGIN, so a deadline
      // budget is measured one round trip before the query). A savepoint in
      // a caller's transaction restores the caller's values afterwards; a
      // failed callback rolls them back with the savepoint and keeps its
      // original error (postgres-engine/search-settings.ts).
      const settings = {
        ...(this.rlsScopeBindingEnabled ? { 'app.scopes': scopesValue } : {}),
        ...(opts?.jitOff ? SEARCH_JIT_OFF : {}),
        ...(deadlineAt === undefined ? {} : { statement_timeout: String(Math.max(1, Math.ceil(deadlineAt - Date.now()))) }),
        ...(typeof opts?.settings === 'function' ? opts.settings() : opts?.settings),
      };
      return withSearchSettings(tx, this._pageTransaction, settings, () => callback(tx), VECTOR_SETTING_DEFAULTS);
    });
  }

  /**
   * A typed read that master issued through `executeRaw`, which a preparer's bounded view (persistence/bounded-reads.ts)
   * ended on the server at the claim's deadline. Under `withReadDeadline` it runs as `withScopedReadTransaction`'s
   * deadline path does (a reserved read-only transaction whose `statement_timeout` is the time left); otherwise, inside
   * a transaction or a locking read (`unbounded`) uses the current connection. A clock abort discards it at once (#8155).
   */
  private preparationRead<T>(fn: (exec: SqlExecutor) => Promise<T>, unbounded?: boolean): Promise<T> {
    try { throwIfRequestAborted(); } catch (error) { return Promise.reject(error); } // a cancelled request reserves no connection and sends no BEGIN, as executeRaw refused it (R2)
    const deadlineAt = this._pageTransaction || unbounded ? undefined : readDeadline();
    if (deadlineAt === undefined) return fn(this.autocommitSql);
    return runDeadlineRead(this.sql, deadlineAt, tx => fn(refuseAborted(this.engineSqlOn(tx))), this.checkoutGauge, cancelSettleMs(), readDeadlineSignal());
  }

  /** A typed read master ran on `engineSql`: still so, or `preparationRead` under a read deadline. */
  private engineSqlRead<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
    return this._pageTransaction || readDeadline() === undefined ? fn(this.engineSql) : this.preparationRead(fn);
  }

  /** A typed read master ran through this engine's executeRaw (a statement fault a test injects reaches it): still so, or `preparationRead` under a read deadline. */
  private ownRawRead<T>(fn: (exec: Pick<BrainEngine, 'executeRaw'>) => Promise<T>): Promise<T> {
    return this._pageTransaction || readDeadline() === undefined ? fn(this) : this.preparationRead(fn);
  }

  /**
   * A locking typed read (`FOR SHARE`) master issued through `executeRaw`. A read-only deadline transaction refuses a
   * row lock, so under a read deadline it is master's bounded statement: a read-write `statement_timeout` of the time
   * left, the deadline's signal, and a refusal before it is sent once the deadline has passed.
   */
  private lockingPreparationRead<T>(fn: (exec: Pick<SqlExecutor, 'executeRaw'>) => Promise<T>): Promise<T> {
    const deadlineAt = this._pageTransaction ? undefined : readDeadline();
    if (deadlineAt === undefined) return fn(this.autocommitSql);
    const signal = readDeadlineSignal();
    return fn({ executeRaw: <R>(sql: string, params?: unknown[]) => Date.now() >= deadlineAt ? Promise.reject(new ReadDeadlineError())
      : this.executeRaw<R>(sql, params, { timeoutMs: Math.max(1, deadlineAt - Date.now()), ...(signal ? { signal } : {}) }) });
  }

  /** An unscoped read in its own transaction with JIT off (search-settings.ts); a savepoint inside a caller's transaction. */
  private jitOffRead<T>(callback: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    return this.readTransaction(tx => withSearchJitOff(tx, this._pageTransaction, () => callback(tx)));
  }

  /**
   * GBRA-156: a top-level read transaction opens `BEGIN READ ONLY` (a write inside it fails, never commits) and answers when its read returns, without waiting for COMMIT's round trip.
   * The driver keeps the connection reserved, and the gauge counts it, until COMMIT settles; a failed COMMIT cannot
   * change rows already read, so it is not the caller's error. `run` lets its statement errors propagate (every read here does).
   */
  private readTransaction<T>(run: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    if (this._pageTransaction) return this.transaction(engine => run((engine as PostgresEngine).sql));
    return new Promise<T>((resolve, reject) => {
      let answered = false;
      this.transaction(async engine => {
        const tx = (engine as PostgresEngine).sql;
        const result = await run(tx);
        answered = true;
        resolve(result);
        return result;
      }, { pipelineEarly: isPipelinableSearchRead, readOnly: true }).catch(error => { if (!answered) reject(error); });
    });
  }

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<void> {
    this.vectorIterativeScan = undefined;
    this.keywordStatementTimeout = undefined;
    this._savedConfig = config;
    const url = config.database_url;
    if (config.poolSize) {
      // Instance-level connection for worker isolation. resolvePoolSize lets
      // GBRAIN_POOL_SIZE cap below the caller's requested size when set — the
      // env var is a user escape hatch, so it wins.
      const url = config.database_url;
      if (!url) throw new GBrainError('No database URL', 'database_url is missing', 'Provide --url');
      const size = Math.min(config.poolSize, db.resolvePoolSize(config.poolSize));
      const embedded = isEmbeddedEngine(this);
      // Honor PgBouncer transaction-mode detection on worker-instance pools too.
      // Without this, `gbrain jobs work` against a Supabase pooler URL hits
      // "prepared statement does not exist" under load just like the module
      // singleton did before v0.15.4.
      const prepare = db.resolvePrepare(url);
      // Session timeouts (statement_timeout + idle_in_transaction_session_timeout)
      // keep orphan pgbouncer backends from holding locks for hours when the
      // postgres.js client disconnects mid-transaction. See resolveSessionTimeouts
      // in db.ts for context + env var overrides.
      const timeouts = db.resolveSessionTimeouts();
      const opts: Record<string, unknown> = {
        max: size,
        idle_timeout: 20,
        connect_timeout: db.resolveUrlConnectTimeout(url),
        // Explicit (matches the postgres.js implicit default; GBRAIN_POOL_MAX_LIFETIME_S overrides).
        max_lifetime: db.resolveMaxLifetimeSeconds(),
        types: { bigint: postgres.BigInt },
        // Silence postgres NOTICE-level messages by default. See db.ts for
        // rationale (stdout-parsing callers like jobs-submit --json break when
        // idempotent CREATE migrations flood stdout). Opt back in with
        // GBRAIN_PG_NOTICES=1.
        onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
        ...db.poolHealthOptions({ ...this.poolHealth('read'), onpoisoned: (status: string) => this.onPoisoned('read', status) }, timeouts.statement_timeout),
        shared_types: db.resolveSharedTypes(url), array_types: db.resolveArrayTypes(url), ...db.readPoolPipelineOptions(url), ...db.transactionPipelineOptions(url),
      };
      opts.connection = { ...timeouts, application_name: db.gbrainApplicationName() };
      if (typeof prepare === 'boolean') {
        opts.prepare = prepare;
      }
      const instanceOpts = embedded ? { ...opts, ...settingsConnectionOptions(url) } : opts;
      this._sql = postgres(url, traceSqlOptions(withPgTls(url, instanceOpts), 'instance'));
      await db.checkPoolAndLoadSharedTypes(this._sql, url, { persisted: !embedded }).catch(async (e: unknown) => { throw (await tlsRequiredDefaultError(url, e, instanceOpts)) ?? e; });
      await db.setSessionDefaults(this._sql);
      this._connectionStyle = 'instance';

      // v0.30.1: instance-owned ConnectionManager wraps the read pool we just
      // built. Parent inheritance (T5/X1): worker engines pass their parent's
      // manager so kill-switch state and direct pool are shared.
      this.connectionManager = new ConnectionManager({
        url,
        parent: config.parentConnectionManager,
        readPoolOwnedExternally: true, // we own _sql; manager just routes
        onpoisoned: this.onPoisoned,
        health: this.poolHealth,
        ...(embedded ? { directUrl: embeddedSettingsRecord(this)?.database.directUrl ?? null, directUrlFromEnv: false, settingsConnection: true } : {}),
      });
      this.connectionManager.setReadPool(this._sql);
    } else {
      // Module-level singleton (backward compat for CLI main engine).
      // #1471: db.connect() returns whether THIS call created the singleton —
      // decided atomically inside connect() (no await between its null-check and
      // pool assignment), so two concurrent module connects can't both claim
      // ownership. Store the token; only the owner tears the singleton down.
      this._ownsModuleSingleton = await db.connect(config, { ...this.poolHealth('read'), onpoisoned: status => this.onPoisoned('read', status) });
      this._connectionStyle = 'module';

      // v0.30.1: connection-manager wraps the module singleton.
      if (url) {
        this.connectionManager = new ConnectionManager({
          url,
          parent: config.parentConnectionManager,
          readPoolOwnedExternally: true, // db.ts owns the pool
          onpoisoned: this.onPoisoned,
          health: this.poolHealth,
        });
        this.connectionManager.setReadPool(db.getConnection());
      }
    }
  }

  async disconnect(): Promise<void> {
    this.vectorIterativeScan = undefined;
    this.keywordStatementTimeout = undefined;
    if (this._disconnectPromise) return this._disconnectPromise;
    const work = this.disconnectInternal();
    this._disconnectPromise = work;
    try { await work; }
    finally { if (this._disconnectPromise === work) this._disconnectPromise = null; }
  }

  private async disconnectInternal(): Promise<void> {
    const open = !!this.connectionManager || !!this._sql || this._connectionStyle === 'module';
    if (open) for (const stop of this._beforeDisconnect) await stop(); // hooks run once, as PGLite's early return does
    // v0.41.25.0 (#1570) — instrument disconnect calls to identify the
    // mid-process caller behind the singleton-null bug. The audit log
    // captures connection_style so we can tell instance-pool teardowns
    // (correct, end-of-worker-life) apart from module-singleton teardowns
    // (the load-bearing class). Best-effort: audit failure never blocks
    // the actual disconnect. Logged BEFORE the early-return branches so
    // even a no-op disconnect (engine that was never connected) is
    // recorded — that case may itself be a caller-side bug worth seeing.
    try {
      logDbDisconnect('postgres', this._connectionStyle ?? 'unknown');
    } catch { /* best-effort; never block disconnect on audit failure */ }
    // #4143 engine parity with PGLiteEngine.disconnect(): settle in-flight
    // background-work statements before pool teardown. Mode 'disconnect' —
    // residual telemetry buffers are dropped on BOTH engines (symmetric lossy
    // semantics; the CLI-exit drain is where residuals flush). Guarded so a
    // no-op disconnect (never connected / already torn down) skips the drain.
    if (open) await drainBackgroundWorkBeforeDisconnect();
    // v0.30.1: tear down the direct pool first if the manager owns one.
    if (this.connectionManager) {
      await this.connectionManager.disconnect();
      this.connectionManager = null;
    }
    if (this._sql) {
      // #1972: gbrain-owned hard bound so a PgBouncer drain that never settles
      // can't block teardown until the CLI's 10s force-exit truncates stdout.
      await db.endPoolBounded(this._sql);
      this._sql = null;
      // After this point, _connectionStyle stays 'instance' so a second
      // disconnect() is a no-op rather than falling through and clearing
      // the unrelated module-level db singleton.
      return;
    }
    if (this._connectionStyle === 'module') {
      // #1471: only the engine that created the shared singleton may tear it
      // down. A borrower clears its own markers WITHOUT calling db.disconnect(),
      // so a probe engine's teardown can't clobber the owner's live connection.
      if (this._ownsModuleSingleton) {
        await db.disconnect();
        this._ownsModuleSingleton = false;
      }
      this._connectionStyle = null;
    }
    // else: nothing to disconnect (already done or never connected)
  }

  /** `embedding` sizes a fresh schema (engine graduation passes the source's layout); a stored identity still wins. */
  async initSchema(opts: { embedding?: { dimensions: number; model: string } } = {}): Promise<void> {
    // v0.30.1 (X1): route DDL through the direct pool when ConnectionManager
    // is in dual-pool mode. The pooler's 2-min statement_timeout truncates
    // SCHEMA_SQL replays + migrations on Supabase; the direct pool gets
    // 30min. Lane B replaces the lock primitive with a TTL+heartbeat table
    // lock; Lane A does the routing.
    const pool = this.connectionManager
      ? await this.connectionManager.ddl()
      : this.sql;

    let dims: number = DEFAULT_EMBEDDING_DIMENSIONS;
    let model: string = DEFAULT_EMBEDDING_MODEL;
    const embedded = embeddedSchemaEmbedding(this); // settings.embedding, never the process gateway
    if (embedded) ({ dimensions: dims, model } = embedded);
    else try {
      // Keep the gateway lazy: its static closure is large, and evaluation inside
      // this try/catch preserves the unconfigured-gateway default fallback.
      const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
      // Both accessors THROW when the gateway is unconfigured (they never
      // return falsy), so the catch below is the only fallback path (#3461).
      dims = gw.getEmbeddingDimensions();
      model = gw.getEmbeddingModel();
    } catch { /* gateway not yet configured — use defaults */ }
    if (opts.embedding) ({ dimensions: dims, model } = opts.embedding);

    const storedIdentity = await readStoredEmbeddingIdentity(this);
    if (storedIdentity) {
      if (!storedIdentity.model) throw new Error('Stored embedding model is unknown. Run gbrain migrate embeddings --status and explicitly migrate before schema initialization.');
      if (embedded) assertEmbeddedEmbedding(embedded, storedIdentity);
      dims = storedIdentity.dimensions;
      model = storedIdentity.model;
    }
    let sqlText = getPostgresSchema(dims, model);

    // GBRA-467: the schema migration lock covers the bootstrap, the replay and the migrations (holdSchemaMigrationLock).
    const { runMigrations, withSchemaMigrationLock, registeredLatestVersion } = await import('./migrate.ts'); // engine-dynamic-import-ok: initSchema only, keeps the ~220 migration modules off every connect
    const t0 = Date.now();
    logConnectionEvent({
      pool: this.connectionManager?.isDualPoolActive() ? 'ddl' : 'read',
      op: 'acquire',
      caller: 'PostgresEngine.initSchema',
    });
    try {
      await withSchemaMigrationLock(this, async () => {
        await assertSchemaNotAhead((q) => pool.unsafe(q), registeredLatestVersion()); // #7776: an older binary never replays its schema over a newer one
        // Another initSchema may have recorded an identity between the read above and this lock: check it again here.
        const lockedIdentity = storedIdentity ? null : await readStoredEmbeddingIdentity(this);
        if (lockedIdentity?.model) {
          if (embedded) assertEmbeddedEmbedding(embedded, lockedIdentity);
          if (lockedIdentity.dimensions !== dims || lockedIdentity.model !== model) sqlText = getPostgresSchema(lockedIdentity.dimensions, lockedIdentity.model);
        }
        // The bootstrap and the replay share one backend: withSchemaLockTimeout sets a session lock_timeout on it.
        // On a pool of more than one it is a reserved backend (checkout gauge only, no long-hold permit: migrations
        // reserve their own); a pool of one is already a single backend.
        const pinned = pool.options.max > 1;
        if (pinned) this.checkoutGauge.acquire('reserved');
        const conn: postgres.Sql = pinned ? await pool.reserve().catch((e) => { this.checkoutGauge.release('reserved'); throw e; }) : pool;
        if (pinned) this.checkoutGauge.checkedOut();
        try {
          // Pre-schema bootstrap: add forward-referenced state the embedded schema
          // blob requires but that older brains don't have yet (issues #366/#375/
          // #378/#396 + #266/#357). Idempotent on fresh installs and modern brains.
          // Threads the DDL connection so the bootstrap probes run inside the schema
          // lock, not on the pooler outside it (Codex P1 finding, v0.36 dreamy-thompson wave).
          await this.applyForwardReferenceBootstrap(conn);

          await retrySchemaReplayOnDeadlock(() => withSchemaLockTimeout(conn, () => conn.unsafe(sqlText), { step: 'replay', diagnostic: schemaDiagnosticConnection(this._savedConfig?.database_url) })); // #5227: bounded wait, typed schema_lock_blocked; #6143: a deadlock victim runs again
        } finally {
          if (pinned) { (conn as postgres.ReservedSql).release(); this.checkoutGauge.release('reserved'); }
        }

        // Run any pending migrations automatically
        const { applied } = await runMigrations(this);
        if (applied > 0) {
          process.stderr.write(`  ${applied} migration(s) applied\n`);
        }

        // Post-migration schema verification: catches columns that migrations
        // defined but PgBouncer transaction-mode silently failed to create.
        // Self-heals missing columns via ALTER TABLE ADD COLUMN IF NOT EXISTS.
        const verify = await verifySchema(this);
        if (verify.healed.length > 0) {
          process.stderr.write(`  Schema verify: self-healed ${verify.healed.length} missing column(s)\n`);
        }
        if (applied > 0 || verify.healed.length > 0) db.clearSharedTypes(this.sql, pool);

        // v0.30.1 (Fix 5): sweep zombie HNSW indexes (indisvalid=false) from
        // crashed CREATE INDEX CONCURRENTLY calls. Best-effort; errors logged
        // to stderr but never block engine.connect.
        try {
          const result = await dropZombieIndexes(this);
          if (result.dropped.length > 0) {
            process.stderr.write(`  HNSW sweep: dropped ${result.dropped.length} zombie index(es)\n`);
          }
        } catch { /* best-effort */ }
      });
    } finally {
      logConnectionEvent({
        pool: this.connectionManager?.isDualPoolActive() ? 'ddl' : 'read',
        op: 'release',
        caller: 'PostgresEngine.initSchema',
        duration_ms: Date.now() - t0,
      });
    }
  }

  /**
   * GBRA-467: the schema migration lock (key 42, brain-global), transaction-scoped on a backend reserved from the
   * DDL pool, or from the statement pool when the DDL pool has one connection (a short-lived command's direct pool,
   * left idle by the migrations until its idle timeout drops it). Session lock only when every pool has one.
   */
  async holdSchemaMigrationLock<T>(fn: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
    const ddl = this.connectionManager ? await this.connectionManager.ddl() : this.sql;
    const pool = ddl.options.max > 1 ? ddl : this.sql.options.max > 1 ? this.sql : null;
    if (!pool) return holdSchemaMigrationSessionLock(ddl, fn);
    this.checkoutGauge.acquire('reserved');
    const conn = await pool.reserve().catch((e) => { this.checkoutGauge.release('reserved'); throw e; });
    this.checkoutGauge.checkedOut();
    try {
      return await holdSchemaMigrationTransactionLock(conn, fn);
    } finally {
      conn.release();
      this.checkoutGauge.release('reserved');
    }
  }

  /**
   * Forward-reference bootstrap before SCHEMA_SQL replay; the single
   * implementation (shared with PGLite and `db.initSchema()`) lives in
   * `engine-sql/bootstrap.ts` (E1).
   */
  private async applyForwardReferenceBootstrap(injectedConn?: postgres.Sql): Promise<void> {
    // Use the caller-provided connection (DDL pool, holding the advisory lock
    // from initSchema) when available — falls back to this.sql for backward
    // compatibility with any unit-test path that still calls bootstrap directly.
    // Production path always passes the DDL conn so bootstrap probes run inside
    // the same lock scope as SCHEMA_SQL replay.
    await applyPostgresForwardReferenceBootstrap(injectedConn ?? this.sql);
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.transactionOn(this.sql, fn, opts);
  }

  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    const conn = !this._pageTransaction && this.connectionManager?.isDualPoolActive()
      ? await this.connectionManager.ddl() : this.sql;
    return this.transactionOn(conn, fn, opts);
  }

  private async transactionOn<T>(conn: ReturnType<typeof postgres>, fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    // GBRA-156: a top-level read transaction inherits its request's signal (request-signal.ts), so a request nobody waits for gives its connection back.
    const inherited = !opts?.signal && opts?.readOnly && !this._pageTransaction ? requestSignal() : undefined;
    if (inherited) opts = { ...opts, signal: inherited };
    if (opts?.signal?.aborted) throw transactionAborted(opts.signal);
    if (!opts?.readOnly) conn = readWriteTransactions(conn);
    // try/finally, not .finally on the chained promise: begin() can throw
    // SYNCHRONOUSLY (e.g. nested transaction on a tx clone whose conn has no
    // .begin), which would skip a chained .finally and leak the counter.
    if (!this._pageTransaction) this.checkoutGauge.acquire('tx');
    try {
      // GBRA-156: the pool's begin takes `first`; a nested transaction's begin (a savepoint) takes only the callback.
      const mode = opts?.readOnly ? { mode: 'read only' } : {};
      const begin = (run: (handle: unknown) => Promise<unknown>) => this._pageTransaction ? conn.begin(run)
        : opts?.pipelineEarly ? conn.begin({ ...mode, early: opts.pipelineEarly }, run)
        : opts?.pipelineFirst ? conn.begin({ ...mode, first: opts.pipelineFirst }, run)
        : opts?.readOnly ? conn.begin('read only', run) : conn.begin(run);
      return await holdSearchConnection(() => withCommitChecks(checks => withTransactionAbort(opts?.signal, attach => withHeldPageKeys(this._pageTransaction ? this._heldPageKeys : null, held => begin(async (handle) => {
        attach(handle as Discardable);
        if (!this._pageTransaction) this.checkoutGauge.checkedOut();
        const tx = composablePostgresTransaction(handle);
        // Create a scoped engine with tx as its connection, no shared state mutation
        const txEngine = Object.create(this) as PostgresEngine;
        Object.defineProperty(txEngine, '_chunkWritesInTransaction', { value: true });
        Object.defineProperty(txEngine, '_pageTransaction', { value: true });
        Object.defineProperty(txEngine, '_heldPageKeys', { value: held });
        if (!this._pageTransaction) Object.defineProperty(txEngine, '_commitChecks', { value: checks });
        Object.defineProperty(txEngine, 'sql', { get: () => tx });
        Object.defineProperty(txEngine, '_sql', { value: tx as unknown as ReturnType<typeof postgres>, writable: false });
        return fn(txEngine);
      }) as Promise<T>), { cancelSettleMs: cancelSettleMs() })));
    } finally {
      if (!this._pageTransaction) this.checkoutGauge.release('tx');
    }
  }

  /** Long holds share a budget across every engine that uses the same physical pool. */
  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>, opts?: { route?: 'ordinary'; selfContained?: boolean }): Promise<T> {
    let pool = this.sql;
    let releasePermit: (() => void) | null = null;
    if (!this._pageTransaction && opts?.route !== 'ordinary' && this.connectionManager?.isDualPoolActive()) {
      try {
        const direct = await this.connectionManager.ddl();
        releasePermit = tryAcquirePoolLongHold(direct, this.connectionManager.describeMode().direct_pool_size ?? DEFAULT_DIRECT_POOL_SIZE);
        if (releasePermit) pool = direct;
      } catch {
        // A disabled direct route falls back to the same bounded ordinary pool.
      }
    }
    releasePermit ??= tryAcquirePoolLongHold(pool, undefined, { selfContained: opts?.selfContained });
    if (!releasePermit) throw new PoolCapacityError();
    // Gauge BEFORE reserve(): a reserve() stuck waiting for a free slot is
    // exactly the in-flight pressure the probe diagnostics should surface.
    this.checkoutGauge.acquire('reserved');
    let reserved: Awaited<ReturnType<typeof pool.reserve>>;
    try {
      reserved = await pool.reserve();
    } catch (e) {
      this.checkoutGauge.release('reserved');
      releasePermit();
      throw e;
    }
    this.checkoutGauge.checkedOut();
    try {
      const conn: ReservedConnection = {
        async executeRaw<R = Record<string, unknown>>(
          query: string,
          params?: unknown[],
          opts?: { signal?: AbortSignal; prepare?: boolean },
        ): Promise<R[]> {
          // ReservedConnection.executeRaw doesn't wire AbortSignal today (migrations and cycle-lock writes
          // don't want cancellation); opts.signal is ignored. GBRA-75 w9: `prepare` names a parameterized
          // statement (bounded read sessions); postgres.js ANDs it with the connection option, as runUnsafe does.
          // Without it the statement stays unnamed, as before.
          void opts;
          const rows = params === undefined
            ? await reserved.unsafe(query)
            : await reserved.unsafe(query, params as Parameters<typeof reserved.unsafe>[1], { prepare: opts?.prepare === true });
          return rows as unknown as R[];
        },
      };
      return await fn(Object.assign(conn, { transaction: <R>(run: (engine: BrainEngine) => Promise<R>, opts?: TransactionOptions) => this.transactionOn(reservedTransactions(reserved), run, opts) } satisfies ReservedTransactions));
    } finally {
      // Counter/gauge decrements run regardless of release() throwing
      // (double-release or socket error must not permanently leak a permit
      // of the small direct-reserve budget — data-migration review).
      try {
        reserved.release();
      } catch {
        // best-effort; the pool's own lifecycle handles a broken reservation
      }
      this.checkoutGauge.release('reserved');
      releasePermit();
    }
  }

  /**
   * Health-probe diagnostics (issue #6). Duck-typed — deliberately NOT on the
   * BrainEngine interface (PGLite has no pool to diagnose; the worker reads
   * it optionally, same pattern as `engine.reconnect`). Fail-open: returns
   * null instead of throwing.
   */
  /** #5801: observe connection acquisition (see CheckoutGauge.onCheckout). Duck-typed like getPoolDiagnostics. */
  onCheckout(listener: () => void): () => void { return this.checkoutGauge.onCheckout(listener); }

  getPoolDiagnostics(): { tracked: PoolGaugeSnapshot; poolMax: number | null; poisonedDiscards: number; stuckDiscards: number; buildFailures: number; desyncDiscards: number; recovered: number; recoveryFailed: number; pool: DriverPoolStats | null; prepare: boolean | null } | null {
    try {
      const max = (this.sql as unknown as { options?: { max?: number } }).options?.max;
      return {
        tracked: this.checkoutGauge.snapshot(),
        poolMax: typeof max === 'number' ? max : null,
        poisonedDiscards: this.poisonedDiscards?.count ?? 0,
        stuckDiscards: this.poolIncidents?.stuckCount ?? 0,
        buildFailures: this.poolIncidents?.buildFailureCount ?? 0,
        desyncDiscards: this.poolIncidents?.desyncCount ?? 0, recovered: this.poolIncidents?.recoveredCount ?? 0, recoveryFailed: this.poolIncidents?.recoveryFailedCount ?? 0,
        pool: driverPoolStats(this.sql),
        prepare: (this.sql as unknown as { options?: { prepare?: boolean } }).options?.prepare ?? null,
      };
    } catch {
      return null;
    }
  }

  // Pages CRUD
  async getPage(slug: string, opts?: PageSnapshotOptions): Promise<Page | null> {
    return (await this.readPageSnapshot(slug, opts))?.page ?? null;
  }

  async readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
    // #6276: the remote alias-resolving read's visibility subplans cross the JIT thresholds on larger brains; run it with JIT off.
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx =>
      readCanonicalPageSnapshot(async (query, params) => Array.from(await tx.unsafe(query, params as never, { prepare: true })) as never, slug, opts),
    opts?.resolveAlias && opts.excludePrivate ? { alwaysTransaction: true, jitOff: true } : undefined);
  }

  async readPageSnapshotsBatch(refs: ReadonlyArray<{ slug: string; sourceId: string }>, opts?: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean }) {
    const sourceIds = [...new Set(refs.map(ref => ref.sourceId))];
    return this.withScopedReadTransaction(sourceIds.length ? sourceIds : undefined, undefined, tx =>
      readPageSnapshotsBatch(async (query, params) => Array.from(await tx.unsafe(query, params as never, { prepare: true })) as never, refs, opts));
  }

  async lockPageKeys(keys: readonly PageKey[]): Promise<void> {
    if (!this._pageTransaction) throw new Error('lockPageKeys requires engine.transaction()');
    await lockUnheldPageKeys(this, this._heldPageKeys!, keys);
  }
  private _heldPageKeys: HeldPageKeys | null = null;

  /**
   * v0.41.13 (#1309) — identity-based dedup pre-check.
   * See `BrainEngine.findDuplicatePage` for the contract.
   */
  async findDuplicatePage(
    sourceId: string,
    opts: { hash: string; frontmatterId?: string | null; excludeSlug?: string },
  ): Promise<{ slug: string; id: number } | null> {
    return this.withScopedReadTransaction(undefined, sourceId, tx => pagesImpl.findDuplicatePage(scopedRead(this.engineSqlOn(tx)), sourceId, opts));
  }
  async findDuplicatePages(sourceId: string, inputs: Parameters<typeof pagesImpl.findDuplicatePages>[2]) { return this.withScopedReadTransaction(undefined, sourceId, tx => pagesImpl.findDuplicatePages(scopedRead(this.engineSqlOn(tx)), sourceId, inputs)); }

  private _pageTransaction = false;

  async putPage(slug: string, page: PageInput, opts?: PageWriteOptions): Promise<Page> {
    slug = validateSlug(slug);
    const write = async (tx: BrainEngine) => {
      const sourceId = opts?.sourceId ?? 'default';
      await tx.lockPageKeys([{ sourceId, slug }]);
      if (opts?.expectedRevision !== undefined || opts?.force !== undefined) {
        assertPageRevision(await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true }), opts);
      }
      await assertOriginUnclaimed(tx, { sourceId, slug, sourcePath: page.source_path ?? null, revive: true });
      return pagesImpl.putPage((tx as PostgresEngine).engineSql, slug, page, opts).catch(error => { throw classifyOriginUniqueViolation(error) ?? error; });
    };
    return opts?.inline && this._pageTransaction ? write(this) : this.transaction(write);
  }

  async deletePage(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return pagesImpl.deletePage(this.engineSql, slug, opts);
  }

  /**
   * v0.41.19.0 — batch delete primitive. See BrainEngine.deletePages JSDoc.
   * Single SQL round-trip per call; caller is responsible for chunking input
   * to <= DELETE_BATCH_SIZE. RETURNING slug projects the actually-deleted set
   * so the caller can filter pagesAffected.
   */
  async deletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    return pagesImpl.deletePages(this.engineSql, slugs, opts);
  }

  /**
   * v0.41.19.0 — batch path → slug resolution. See BrainEngine.resolveSlugsByPaths
   * JSDoc. Single SQL round-trip; folds rows into a Map.
   */
  async resolveSlugsByPaths(
    paths: string[],
    opts: { sourceId: string },
  ): Promise<Map<string, string>> {
    return pagesImpl.resolveSlugsByPaths(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), paths, opts);
  }

  async softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null> {
    return pagesImpl.softDeletePage(this.engineSql, slug, opts);
  }

  /**
   * #4587 — batch soft-delete primitive. See BrainEngine.softDeletePages
   * JSDoc. Mirrors deletePages' shape (empty-array early-return, batch-size
   * throw, RETURNING slug) with softDeletePage's `deleted_at IS NULL`
   * idempotency predicate. Nothing cascades — the 72h purge phase owns the
   * eventual hard delete.
   */
  async softDeletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    return pagesImpl.softDeletePages(this.engineSql, slugs, opts);
  }

  async restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    return this.transaction(async tx => { await assertRevivalUnclaimed(tx, slug, opts?.sourceId); return pagesImpl.restorePage((tx as PostgresEngine).engineSql, slug, opts); });
  }

  async purgeDeletedPages(
    olderThanHours: number,
    opts?: { dryRun?: boolean; excludeIds?: number[]; onlyIds?: number[] },
  ): Promise<{ slugs: string[]; count: number; pages?: { slug: string; source_id: string; deleted_at: Date }[] }> {
    return pagesImpl.purgeDeletedPages(this.engineSql, olderThanHours, opts);
  }

  async refreshPageBody(
    slug: string,
    sourceId: string,
    compiledTruth: string,
    timeline: string,
    contentHash: string,
  ): Promise<void> {
    return pagesImpl.refreshPageBody(this.engineSql, slug, sourceId, compiledTruth, timeline, contentHash);
  }

  async updatePageContextualRetrievalState(
    slug: string,
    sourceId: string,
    mode: string,
    corpusGeneration: string | null,
  ): Promise<void> {
    return pagesImpl.updatePageContextualRetrievalState(this.engineSql, slug, sourceId, mode, corpusGeneration, (key, read) => transactionMemo(this, key, read));
  }

  async migrateFactsToCanonical(
    phantomSlug: string,
    canonicalSlug: string,
    sourceId: string,
  ): Promise<{ migrated: number }> {
    const sql = this.sql;
    // UPDATE preserves every other column (embedding, valid_*, kind,
    // status, notability, confidence, source_session, ...) except
    // row_num, which is offset past canonical's current MAX(row_num)
    // (#4558): canonical already owns fence rows 1..N, so carrying the
    // phantom's row_num across collides on the partial UNIQUE
    // idx_facts_fence_key. Same seed rule fence-write.ts uses for that
    // index. MAX counts expired rows too (the index only excludes NULL);
    // NULL + M stays NULL (legacy-guard semantics intact). extract_facts
    // hasRowNumDrift re-harmonises the numbering against the disk fence.
    // Idempotent by virtue of the WHERE clause matching nothing on re-run. We scope to `expired_at IS NULL` so the migration touches only
    // active facts. Forgotten / superseded rows that already carry an
    // expiry stay where they are — soft-deleting the phantom page is
    // sufficient to make them invisible without rewriting their slug
    // (and rewriting would break the audit trail in listSupersessions). B-10: an observation the canonical page already holds would collide on idx_facts_ontology_stint_dedup; drop it first.
    await dropPhantomMigrationDuplicates(this, sourceId, canonicalSlug, phantomSlug);
    const result = await sql`
      UPDATE facts
      SET entity_slug = ${canonicalSlug},
          source_markdown_slug = ${canonicalSlug},
          row_num = facts.row_num + COALESCE((
            SELECT MAX(f2.row_num) FROM facts f2
            WHERE f2.source_id = ${sourceId}
              AND f2.source_markdown_slug = ${canonicalSlug}
              AND f2.row_num IS NOT NULL
          ), 0)
      WHERE source_id = ${sourceId}
        AND source_markdown_slug = ${phantomSlug}
        AND expired_at IS NULL
    `;
    return { migrated: result.count ?? 0 };
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    return this.withScopedReadTransaction(filters?.sourceIds, filters?.sourceId, tx => pagesImpl.listPages(scopedRead(this.engineSqlOn(tx)), filters));
  }
  async findPages(query: FindPagesQuery): Promise<FoundPages> {
    return this.withScopedReadTransaction(query.sourceIds, query.sourceId, tx => pageLookupImpl.findPages(scopedRead(this.engineSqlOn(tx)), query));
  }
  async countPagesBy(query: PageCountQuery, groupTypes?: TypeGrouper): Promise<PageCounts> {
    return this.withScopedReadTransaction(query.sourceIds, query.sourceId, tx => pageLookupImpl.countPagesBy(scopedRead(this.engineSqlOn(tx)), query, groupTypes));
  }

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => pagesImpl.getAllSlugs(scopedRead(this.engineSqlOn(tx)), opts));
  }

  listMarkdownPageSlugs(sourceId: string) { return pagesImpl.listMarkdownPageSlugs(this, sourceId); }
  async listAllPageRefs(): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>> {
    return pagesImpl.listAllPageRefs(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'));
  }

  async listEntityKeyRows(opts: EntityKeyRowsOpts): Promise<EntityKeyRow[]> {
    return entityKeysImpl.listEntityKeyRows(unscopedExecutor(this.engineSql, 'duplicate finder: brain-wide entity keys, trusted local only'), opts);
  }

  async listIdentityDecisions(): Promise<identityDecisionsImpl.IdentityDecisionsRead> {
    return identityDecisionsImpl.listIdentityDecisions(unscopedExecutor(this.engineSql, 'identity decisions: brain-wide, trusted local only'));
  }

  async listRestrictedIdentityMembers(members: ReadonlyArray<identityDecisionsImpl.IdentityMemberRef>): Promise<identityDecisionsImpl.IdentityMemberRef[]> {
    return identityDecisionsImpl.listRestrictedIdentityMembers(unscopedExecutor(this.engineSql, 'identity decisions: brain-wide, trusted local only'), members);
  }

  async applyIdentityDecisions(input: identityDecisionsImpl.ApplyIdentityDecisionsInput): Promise<identityDecisionsImpl.ApplyIdentityDecisionsResult> {
    return this.transaction(tx => identityDecisionsImpl.applyIdentityDecisions((tx as PostgresEngine).engineSql, input));
  }

  // Sources SQL lives once in ./engine-sql/sources.ts (refactor wave 1, W1-extended).
  async listAllSources(opts?: { includeArchived?: boolean; localPathOnly?: boolean }): Promise<SourceRow[]> {
    return sourcesImpl.listAllSources(unscopedExecutor(this.engineSql, 'sources: unscoped on master (EO4 inventory)'), opts);
  }

  async updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    return sourcesImpl.updateSourceConfig(this.engineSql, sourceId, patch);
  }

  // Import-path guard, attribution and config reads: SQL in engine-sql (persistence-state, transaction-settings, belief, config, access-control, sources).
  getSource(sourceId: string) { return this.preparationRead(exec => sourcesImpl.getSource(unscopedExecutor(exec, 'sources: single-row read ran unscoped through executeRaw'), sourceId)); }
  getConfigValues(keys: readonly string[]) { return this.preparationRead(exec => configImpl.getConfigValues(unscopedExecutor(exec, 'config: keyed read ran unscoped through executeRaw'), keys)); }
  readStoredConfigValue(key: string) { return this.ownRawRead(exec => configImpl.readStoredConfigValue(exec, key)); }
  readManagedModeRows() { return this.preparationRead(exec => persistenceStateImpl.readManagedModeRows(unscopedExecutor(exec, 'persistence: managed-mode read ran unscoped through executeRaw'))); }

  // Read-command statements (engine-sql/cli-reads-ops.ts), through this engine's executeRaw so each keeps its deadline and JIT handling.
  scanExactBatch(opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number) { return cliReadsOpsImpl.scanExactBatch(this.executeRaw.bind(this), opts, afterPageId, batchPages, timeoutMs); }
  nextLivePageAfter(afterPageId: number) { return cliReadsOpsImpl.nextLivePageAfter(this.executeRaw.bind(this), afterPageId); }
  listExportPageKeys(q: exportReadsImpl.ExportPageKeyQuery) { return exportReadsImpl.listExportPageKeys(this, q); }
  readExportWithdrawalLedgerBytes(sourceId: string) { return this.engineRead(exec => exportReadsImpl.readExportWithdrawalLedgerBytes(exec, sourceId)); }
  listExportWithdrawals(sourceId: string) { return this.engineRead(exec => exportReadsImpl.listExportWithdrawals(exec, sourceId)); }
  readExportPageRows(ids: readonly string[]) { return exportReadsImpl.readExportPageRows(this, ids); }
  normalizeFenceLines(bodies: readonly string[], timelines: readonly string[]) { return this.ownRawRead(exec => exportReadsImpl.normalizeFenceLines(exec, bodies, timelines)); }
  readSegmentedPageHead(pageId: number) { return this.ownRawRead(exec => exportReadsImpl.readSegmentedPageHead(exec, pageId)); }
  readSegmentedLivePage(pageId: number) { return this.ownRawRead(exec => segmentedWritesImpl.readSegmentedLivePage(exec, pageId)); }
  listChunkedOccurrences(pageId: number, occurrenceIds: readonly number[], generation: number) { return this.ownRawRead(exec => segmentedWritesImpl.listChunkedOccurrences(exec, pageId, occurrenceIds, generation)); }
  readRetiredChunkVectors(pageId: number, occurrences: readonly number[], column: string) { return this.ownRawRead(exec => segmentedWritesImpl.readRetiredChunkVectors(exec, pageId, occurrences, column)); }
  hasStaleSegmentChunks(pageId: number, generation: number, live: readonly number[]) { return this.ownRawRead(exec => segmentedWritesImpl.hasStaleSegmentChunks(exec, pageId, generation, live)); }
  retireStaleSegmentChunks(pageId: number, generation: number, live: readonly number[], maxRows: number) { return segmentedWritesImpl.retireStaleSegmentChunks(this, pageId, generation, live, maxRows); }
  readSegmentedProjectionPage(sourceId: string, slug: string) { return segmentedWritesImpl.readSegmentedProjectionPage(this, sourceId, slug); }
  listSegmentedRechunkCandidates(chunkerVersion: number, scope?: segmentedWritesImpl.RechunkCandidateScope) { return segmentedWritesImpl.listSegmentedRechunkCandidates(this, chunkerVersion, scope); }
  readSegmentedRechunkPage(pageId: number) { return segmentedWritesImpl.readSegmentedRechunkPage(this, pageId); }
  listOccurrenceChunks(pageId: number, occurrences: readonly number[]) { return segmentedWritesImpl.listOccurrenceChunks(this, pageId, occurrences); }
  readMaterializingRevision() { return segmentedWritesImpl.readMaterializingRevision(this); }
  setMaterializingRevision(revision: string) { return segmentedWritesImpl.setMaterializingRevision(this, revision); }
  restorePageUpdatedAt(pageId: number, updatedUs: string) { return segmentedWritesImpl.restorePageUpdatedAt(this, pageId, updatedUs); }
  readSegmentedRewritePage(pageId: number) { return segmentedWritesImpl.readSegmentedRewritePage(this, pageId); }
  restorePageDeletedAt(pageId: number, deletedAt: string) { return segmentedWritesImpl.restorePageDeletedAt(this, pageId, deletedAt); }
  lockSegmentedGenerationPage(pageId: number) { return segmentedWritesImpl.lockSegmentedGenerationPage(this, pageId); }
  splitManifestGeneration(pageId: number, generation: number, stagingId: string) { return segmentedWritesImpl.splitManifestGeneration(this, pageId, generation, stagingId); }
  publishRebuiltGeneration(pageId: number, generation: number, stagingId: string) { return segmentedWritesImpl.publishRebuiltGeneration(this, pageId, generation, stagingId); }
  setSegmentedVersionHash(pageId: number, generation: number, contentHash: string, bodyBytes: number) { return segmentedWritesImpl.setSegmentedVersionHash(this, pageId, generation, contentHash, bodyBytes); }
  hasLiveSegmentedPage(sourceId: string, slug: string) { return segmentedWritesImpl.hasLiveSegmentedPage(this, sourceId, slug); }
  countSegmentedEmbedRows(pageId: number, column: string) { return segmentedWritesImpl.countSegmentedEmbedRows(this, pageId, column); }
  listSegmentedStaleRows(pageId: number, column: string, opts: segmentedWritesImpl.SegmentedStaleRowsOpts) { return segmentedWritesImpl.listSegmentedStaleRows(this, pageId, column, opts); }
  readSegmentChunkInputHashes(pageId: number, chunkIndexes: readonly number[]) { return segmentedWritesImpl.readSegmentChunkInputHashes(this, pageId, chunkIndexes); }
  installSegmentedVectors(pageId: number, column: ResolvedColumn, model: string | null, vectors: readonly segmentedWritesImpl.SegmentedVectorInstall[]) { return segmentedWritesImpl.installSegmentedVectors(this, pageId, column, model, vectors); }
  listLiveEmbedSegments(pageId: number) { return segmentedWritesImpl.listLiveEmbedSegments(this, pageId); }
  listSegmentChunkRows(pageId: number, occurrenceId: number) { return segmentedWritesImpl.listSegmentChunkRows(this, pageId, occurrenceId); }
  readBodyManifestRows(pageId: number, generation: number | null) { return exportReadsImpl.readBodyManifestRows(this, pageId, generation); }
  readBodyManifestMeta(pageId: number, occurrenceIds: readonly number[], generation: number) { return exportReadsImpl.readBodyManifestMeta(this, pageId, occurrenceIds, generation); }
  readBodyManifestOutline(pageId: number, occurrenceIds: readonly number[], generation: number) { return exportReadsImpl.readBodyManifestOutline(this, pageId, occurrenceIds, generation); }
  listForcedCutSeqs(pageId: number, generation: number) { return this.engineRead(exec => exportReadsImpl.listForcedCutSeqs(exec, pageId, generation)); }
  readManifestSeqAt(pageId: number, generation: number, byteOffset: number) { return exportReadsImpl.readManifestSeqAt(this, pageId, generation, byteOffset); }
  readSegmentedVersionBodyBytes(pageId: number, generation: number) { return this.engineRead(exec => exportReadsImpl.readSegmentedVersionBodyBytes(exec, pageId, generation)); }
  listAccessPolicySourceIds() { return exportReadsImpl.listAccessPolicySourceIds(this); }
  probePageTypes(sets: readonly (readonly string[])[], scope: PageReadScope) { return cliReadsOpsImpl.probePageTypes(this.executeRaw.bind(this), sets, scope); }
  readLongPageSizes(ids: readonly number[], scope: PageReadScope, opts: { includeTimeline: boolean }) { return cliReadsOpsImpl.readLongPageSizes(this.executeRaw.bind(this), ids, scope, opts); }
  readReflexLiveKeys(scope: reflexReadsImpl.ReflexScope, slugs: readonly string[]) { return reflexReadsImpl.readReflexLiveKeys(this.executeRaw.bind(this), scope, slugs); }
  readReflexPages(scope: reflexReadsImpl.ReflexScope, match: reflexReadsImpl.ReflexPageMatch) { return reflexReadsImpl.readReflexPages(this.executeRaw.bind(this), scope, match); }
  readBriefEntityPages(sourceId: string, slugs: readonly string[], opts: reflexReadsImpl.BriefEntityPageOpts) { return reflexReadsImpl.readBriefEntityPages(this.executeRaw.bind(this), sourceId, slugs, opts); }
  readBriefMeetingPages(sourceIds: readonly string[], startFrom: string, startTo: string, eligibility?: briefReadsImpl.BriefReadEligibility) { return briefReadsImpl.readBriefMeetingPages(this.executeRaw.bind(this), sourceIds, startFrom, startTo, eligibility); }
  readBriefEmailAliasPages(sourceId: string, emails: readonly string[], eligibility?: briefReadsImpl.BriefReadEligibility) { return briefReadsImpl.readBriefEmailAliasPages(this.executeRaw.bind(this), sourceId, emails, eligibility); }
  readBriefWorldFacts(factIds: readonly number[], eligibility?: briefReadsImpl.BriefReadEligibility) { return briefReadsImpl.readBriefWorldFacts(this.executeRaw.bind(this), factIds, eligibility); }
  readBriefEditPage(sourceId: string, slug: string, maxBytes: number, opts: briefReadsImpl.BriefEditReadOpts) { return briefReadsImpl.readBriefEditPage(this.executeRaw.bind(this), sourceId, slug, maxBytes, opts); }
  readBriefTimelineEntry(pageId: number, since: string, opts: briefReadsImpl.BriefEditReadOpts) { return briefReadsImpl.readBriefTimelineEntry(this.executeRaw.bind(this), pageId, since, opts); }
  readBriefPageVersions(pageId: number, since: string, maxBytes: number, limit: number) { return briefReadsImpl.readBriefPageVersions(this.executeRaw.bind(this), pageId, since, maxBytes, limit); }
  listExactIdentityCandidates(opts: ExactIdentityStatementOpts) { return cliReadsOpsImpl.listExactIdentityCandidates(this.executeRaw.bind(this), opts); }
  rankEntities(opts: RankEntitiesStatementOpts, timeoutMs: number) { return cliReadsOpsImpl.rankEntities(this.executeRaw.bind(this), opts, timeoutMs); }
  readRankCoverage(opts: RankCoverageStatementOpts, timeoutMs: number) { return cliReadsOpsImpl.readRankCoverage(this.executeRaw.bind(this), opts, timeoutMs); }
  readExactSnippetChunks(keys: readonly cliReadsOpsImpl.ExactSnippetKey[], opts: { excludePrivate: boolean }) { return cliReadsOpsImpl.readExactSnippetChunks(this.executeRaw.bind(this), keys, opts); }
  listExactRescanChunks(pageIds: readonly number[], opts: { excludePrivate: boolean }) { return cliReadsOpsImpl.listExactRescanChunks(this.executeRaw.bind(this), pageIds, opts); }
  listHeldFenceCells(keys: readonly cliReadsOpsImpl.HeldFenceCellKey[]) { return cliReadsOpsImpl.listHeldFenceCells(this.executeRaw.bind(this), keys); }
  readFenceOverlayRows(page: { sourceId: string; slug: string }, incoming: readonly cliReadsOpsImpl.FenceOverlayIncomingRow[], opts: { hideHeld: boolean }) { return cliReadsOpsImpl.readFenceOverlayRows(this.executeRaw.bind(this), page, incoming, opts); }
  listFenceRowTrust(keys: readonly cliReadsOpsImpl.FenceRowKey[]) { return cliReadsOpsImpl.listFenceRowTrust(this.executeRaw.bind(this), keys); }
  listExtractionPendingPages(opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }) { return cliReadsOpsImpl.listExtractionPendingPages(this.executeRaw.bind(this), opts); }
  listUnattributedFacts(opts: { sourceIds: string[]; worldOnly: boolean; excludePrivateProvenance: boolean; limit: number; offset: number }) { return cliReadsOpsImpl.listUnattributedFacts(this.executeRaw.bind(this), opts); }
  listWantedPages(opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number }) { return cliReadsOpsImpl.listWantedPages(this.executeRaw.bind(this), opts); }

  // Facts statements, doctor checks (engine-sql/facts-doctor.ts), through executeRaw as before.
  listConversationFactRows(sourceIds: string[], limit: number) { return factsDoctorImpl.listConversationFactRows(this.executeRaw.bind(this), sourceIds, limit); }
  countRedactedFacts(sourceIds?: string[]) { return factsDoctorImpl.countRedactedFacts(this.executeRaw.bind(this), sourceIds); }
  listOutsideContentFenceCounts() { return factsDoctorImpl.listOutsideContentFenceCounts(this.executeRaw.bind(this)); }
  countAtomFacts() { return factsDoctorImpl.countAtomFacts(this.executeRaw.bind(this)); }
  listUnpreviewedTrustFacts(limit: number) { return factsDoctorImpl.listUnpreviewedTrustFacts(this.executeRaw.bind(this), limit); }
  countUnlinkedFactsByOrigin(opts: { sourceIds: string[]; auditSources: string[]; windowPerSource: number; hasAttempts: boolean }) { return factsDoctorImpl.countUnlinkedFactsByOrigin(this.executeRaw.bind(this), opts); }
  countUnlinkedFactStats(opts: { sourceIds: string[]; auditSources: string[]; hasAttempts: boolean }) { return factsDoctorImpl.countUnlinkedFactStats(this.executeRaw.bind(this), opts); }
  countFactRelinkOutcomes(sourceIds: string[]) { return factsDoctorImpl.countFactRelinkOutcomes(this.executeRaw.bind(this), sourceIds); }
  listUnlinkedConversationSlugs(opts: { sourceId: string; auditSources: string[]; windowPerSource: number; fix: factsDoctorImpl.ConversationFixKind; hasAttempts: boolean }) { return factsDoctorImpl.listUnlinkedConversationSlugs(this.executeRaw.bind(this), opts); }
  countFactEmbeddingCoverage(opts: { sourceId?: string | null; model: string; dims: number }) { return factsDoctorImpl.countFactEmbeddingCoverage(this.executeRaw.bind(this), opts); }
  countStaleFactEmbeddings(opts: { model: string; dims: number; sourceId?: string | null }) { return factsDoctorImpl.countStaleFactEmbeddings(this.executeRaw.bind(this), opts); }
  countSegmentedCensusPages(sourceIds: string[], checkedOutSourceIds: string[]) { return factsDoctorImpl.countSegmentedCensusPages(this.executeRaw.bind(this), sourceIds, checkedOutSourceIds); }
  readFactTableCatalog() { return factsDoctorImpl.readFactTableCatalog(this.executeRaw.bind(this)); }
  readChunkVectorColumn(column: string) { return embeddingCatalogImpl.readChunkVectorColumn(this.executeRaw.bind(this), column); }
  readEmbeddingIdentity() { return embeddingCatalogImpl.readEmbeddingIdentity(this.executeRaw.bind(this), () => this.getConfig('embedding_model')); }
  listEmbeddingStores() { return embeddingCatalogImpl.listEmbeddingStores(this.executeRaw.bind(this)); }
  hasStoredVectors(store: embeddingCatalogImpl.EmbeddingStore) { return embeddingCatalogImpl.hasStoredVectors(this.executeRaw.bind(this), store); }
  hasChunkImageVectors() { return embeddingCatalogImpl.hasChunkImageVectors(this.executeRaw.bind(this)); }
  countChunkVectorCoverage(column: embeddingCatalogImpl.FixedVectorColumn) { return embeddingCatalogImpl.countChunkVectorCoverage(this.executeRaw.bind(this), column); }
  readChunkColumnTypes(columns: string[]) { return embeddingCatalogImpl.readChunkColumnTypes(this.executeRaw.bind(this), columns); }
  countChunkColumnCoverage(column: string) { return embeddingCatalogImpl.countChunkColumnCoverage(this.executeRaw.bind(this), column); }
  filterPageIdsByFrontmatter(ids: number[], where: frontmatterIdsImpl.FrontmatterWhere) { return frontmatterIdsImpl.filterPageIdsByFrontmatter(this.executeRaw.bind(this), ids, where); }

  // Doctor reads, second set (engine-sql/doctor-derived.ts).
  readIgnoredPrivacyLabelCounts(opts: { sourceIds?: string[]; timeoutMs: number }) { return doctorDerivedImpl.readIgnoredPrivacyLabelCounts(this.executeRaw.bind(this), opts); }
  countSafeIndexPending(sourceIds?: string[]) { return doctorDerivedImpl.countSafeIndexPending(this.executeRaw.bind(this), sourceIds); }
  countCredentialProjectionPending(sourceIds?: string[]) { return doctorDerivedImpl.countCredentialProjectionPending(this.executeRaw.bind(this), sourceIds); }
  countPagesByTypeAndOwner(sourceIds?: string[]) { return doctorDerivedImpl.countPagesByTypeAndOwner(this.executeRaw.bind(this), sourceIds); }
  listRecordedTombstones(hours: string, released: readonly number[]) { return doctorDerivedImpl.listRecordedTombstones(this.executeRaw.bind(this), hours, released); }
  countDerivedVisibility(sourceIds: string[], timeoutMs: number) { return doctorDerivedImpl.countDerivedVisibility(this.executeRaw.bind(this), sourceIds, timeoutMs); }
  listUntiledSegmentedPageRows(sourceIds: readonly string[] | null, slugs: readonly string[] | null, limit: number) { return doctorDerivedImpl.listUntiledSegmentedPageRows(this.executeRaw.bind(this), sourceIds, slugs, limit); }
  listTimelineHistoryBatch(sourceIds: string[], afterId: number) { return doctorDerivedImpl.listTimelineHistoryBatch(this.executeRaw.bind(this), sourceIds, afterId); }
  readPageCompiledTruths(ids: number[], timeoutMs?: number) { return doctorDerivedImpl.readPageCompiledTruths(this.executeRaw.bind(this), ids, timeoutMs); }
  readEmbeddingBacklogAge(column: string) { return doctorDerivedImpl.readEmbeddingBacklogAge(this.executeRaw.bind(this), column); }
  listBudgetLimitedRows(opts: { column: string; sourceId?: string; signature: string | null }) { return doctorDerivedImpl.listBudgetLimitedRows(this.executeRaw.bind(this), opts); }
  readBudgetHoldAge() { return doctorDerivedImpl.readBudgetHoldAge(this.executeRaw.bind(this)); }
  listImageAssetFiles() { return doctorDerivedImpl.listImageAssetFiles(this.executeRaw.bind(this)); }
  listAmbiguousExtractionInputs() { return doctorDerivedImpl.listAmbiguousExtractionInputs(this.executeRaw.bind(this)); }
  listExtractionInputReceipts() { return doctorDerivedImpl.listExtractionInputReceipts(this.executeRaw.bind(this)); }
  listUnpricedDerivationModels() { return doctorDerivedImpl.listUnpricedDerivationModels(this.executeRaw.bind(this)); }
  listRestorableAtomRetirements(sourceIds: string[]) { return doctorDerivedImpl.listRestorableAtomRetirements(this.executeRaw.bind(this), sourceIds); }
  countLedgerCoveredAtomRetirements(sourceIds: string[]) { return doctorDerivedImpl.countLedgerCoveredAtomRetirements(this.executeRaw.bind(this), sourceIds); }
  listLiveGenerationRetirements(sourceIds: string[], restoreDays: number) { return doctorDerivedImpl.listLiveGenerationRetirements(this.executeRaw.bind(this), sourceIds, restoreDays); }
  listHeldGenerations(sourceIds: string[]) { return doctorDerivedImpl.listHeldGenerations(this.executeRaw.bind(this), sourceIds); }
  listOrphanGenerationCandidates(sourceIds: readonly string[], kind: string | null) { return doctorDerivedImpl.listOrphanGenerationCandidates(this.executeRaw.bind(this), sourceIds, kind); }
  readAtomProvenanceCounts() { return doctorDerivedImpl.readAtomProvenanceCounts(this.executeRaw.bind(this)); }
  readExtractRollup7d(withExpected: boolean) { return doctorDerivedImpl.readExtractRollup7d(this.executeRaw.bind(this), withExpected); }
  readExtractKindRollup7d(kind: string) { return doctorDerivedImpl.readExtractKindRollup7d(this.executeRaw.bind(this), kind); }
  listRecordedHaltReasons7d() { return doctorDerivedImpl.listRecordedHaltReasons7d(this.executeRaw.bind(this)); }
  listCapacityCounters() { return doctorPersistenceImpl.listCapacityCounters(this.executeRaw.bind(this)); }
  listOutstandingHolders(principal: doctorPersistenceImpl.RequestPrincipal | null) { return doctorPersistenceImpl.listOutstandingHolders(this.executeRaw.bind(this), principal); }
  countPersistenceRequestRows(estimate: boolean) { return doctorPersistenceImpl.countPersistenceRequestRows(this.executeRaw.bind(this), estimate); }
  listLifetimeCounters() { return doctorPersistenceImpl.listLifetimeCounters(this.executeRaw.bind(this)); }
  readAdmissionSample(principal: doctorPersistenceImpl.RequestPrincipal | null) { return doctorPersistenceImpl.readAdmissionSample(this.executeRaw.bind(this), principal); }
  listRunningRequestStalls(maxClaimMs: number) { return doctorPersistenceImpl.listRunningRequestStalls(this.executeRaw.bind(this), maxClaimMs); }
  readLiveConsumerSummary() { return doctorPersistenceImpl.readLiveConsumerSummary(this.executeRaw.bind(this)); }
  readCounterDrift(clampedKey: string) { return doctorPersistenceImpl.readCounterDrift(this.executeRaw.bind(this), clampedKey); }
  readMaxRequestSequence() { return doctorPersistenceImpl.readMaxRequestSequence(this.executeRaw.bind(this)); }
  listRefusalBreakerRows(sourceId: string, windowHours: number, threshold: number, limit: number) { return doctorPersistenceImpl.listRefusalBreakerRows(this.executeRaw.bind(this), sourceId, windowHours, threshold, limit); }
  listRecentDriftReceiptSlugs(sourceId: string, floor: string, message: string) { return doctorPersistenceImpl.listRecentDriftReceiptSlugs(this.executeRaw.bind(this), sourceId, floor, message); }
  listOlderDriftReceiptSlugs(sourceId: string, floor: string, message: string, timeoutMs: number) { return doctorPersistenceImpl.listOlderDriftReceiptSlugs(this.executeRaw.bind(this), sourceId, floor, message, timeoutMs); }
  readPublicationRefusals() { return doctorPersistenceImpl.readPublicationRefusals(this.executeRaw.bind(this)); }
  countParkedEffects(sourceIds: string[] | null) { return doctorPersistenceImpl.countParkedEffects(this.executeRaw.bind(this), sourceIds); }
  listParkedEffects(sourceIds: string[] | null) { return doctorPersistenceImpl.listParkedEffects(this.executeRaw.bind(this), sourceIds); }
  listGitPushHoldRows(codes: string[], sourceIds: string[] | null) { return doctorPersistenceImpl.listGitPushHoldRows(this.executeRaw.bind(this), codes, sourceIds); }
  listStalledCatchupRows(sourceIds: string[] | null, stallMs: number) { return doctorPersistenceImpl.listStalledCatchupRows(this.executeRaw.bind(this), sourceIds, stallMs); }
  listParkedGroupRows(sourceIds: string[] | null) { return doctorPersistenceImpl.listParkedGroupRows(this.executeRaw.bind(this), sourceIds); }
  readStaleEmbeddingCounts(sourceIds: string[] | null) { return doctorPersistenceImpl.readStaleEmbeddingCounts(this.executeRaw.bind(this), sourceIds); }
  listStaleEmbeddingEffects(sourceIds: string[] | null) { return doctorPersistenceImpl.listStaleEmbeddingEffects(this.executeRaw.bind(this), sourceIds); }
  listOrphanBindingRows(limit: number | null) { return doctorPersistenceImpl.listOrphanBindingRows(this.executeRaw.bind(this), limit); }
  readPersistenceBrainIdText() { return doctorPersistenceImpl.readPersistenceBrainIdText(this.executeRaw.bind(this)); }
  listWorktreeIds() { return doctorPersistenceImpl.listWorktreeIds(this.executeRaw.bind(this)); }
  listManagedRoots(hostId: string | null) { return doctorPersistenceImpl.listManagedRoots(this.executeRaw.bind(this), hostId); }
  listUnboundSourcePages() { return doctorPersistenceImpl.listUnboundSourcePages(this.executeRaw.bind(this)); }
  listRecentWriterVersions(days: number) { return doctorPersistenceImpl.listRecentWriterVersions(this.executeRaw.bind(this), days); }
  listRecentPurgeRequests(days: number, cap: number) { return doctorPersistenceImpl.listRecentPurgeRequests(this.executeRaw.bind(this), days, cap); }
  listStuckWorktreeRefreshes(minutes: number) { return doctorPersistenceImpl.listStuckWorktreeRefreshes(this.executeRaw.bind(this), minutes); }
  listSourceBindingsForMovement(sourceIds: string[] | null) { return doctorPersistenceImpl.listSourceBindingsForMovement(this.executeRaw.bind(this), sourceIds); }
  listRunningClaimOwners(hostId: string) { return doctorPersistenceImpl.listRunningClaimOwners(this.executeRaw.bind(this), hostId); }
  listOwnerBindings(hostId: string) { return doctorPersistenceImpl.listOwnerBindings(this.executeRaw.bind(this), hostId); }
  listConsumerOwners(hostIds: string[]) { return doctorPersistenceImpl.listConsumerOwners(this.executeRaw.bind(this), hostIds); }
  listCallerRefusalRows(sourceIds: string[], operations: string[]) { return doctorPersistenceImpl.listCallerRefusalRows(this.executeRaw.bind(this), sourceIds, operations); }
  countCompactedCallerRefusals(sourceIds: string[], operations: string[]) { return doctorPersistenceImpl.countCompactedCallerRefusals(this.executeRaw.bind(this), sourceIds, operations); }
  listLocalEditAdoptions() { return doctorPersistenceImpl.listLocalEditAdoptions(this.executeRaw.bind(this)); }
  listDerivationPurgeSweeps() { return doctorPersistenceImpl.listDerivationPurgeSweeps(this.executeRaw.bind(this)); }
  listOversizedPages(minBytes: number) { return doctorPagesImpl.listOversizedPages(this.executeRaw.bind(this), minBytes); }
  listScraperJunkCandidates(limit: number | null) { return doctorPagesImpl.listScraperJunkCandidates(this.executeRaw.bind(this), limit); }
  countLiveSegmentedPages(opts?: { projectionPending?: boolean }) { return doctorTalliesImpl.countLiveSegmentedPages(this.executeRaw.bind(this), opts); }
  countValidityLapsedFacts() { return doctorTalliesImpl.countValidityLapsedFacts(this.executeRaw.bind(this)); }
  countOrphanEventProjections(sourceIds: readonly string[] | null) { return doctorTalliesImpl.countOrphanEventProjections(this.executeRaw.bind(this), sourceIds); }
  countMarkedPages(marker: doctorPagesImpl.PageMarker) { return doctorPagesImpl.countMarkedPages(this.executeRaw.bind(this), marker); }
  countOversizedCorePages(maxBytes: number) { return doctorPagesImpl.countOversizedCorePages(this.executeRaw.bind(this), maxBytes); }
  readRawProvenanceGaps() { return doctorPagesImpl.readRawProvenanceGaps(this.executeRaw.bind(this)); }
  countUnverifiedExtractions(days: number, sourceId: string | null) { return doctorPagesImpl.countUnverifiedExtractions(this.executeRaw.bind(this), days, sourceId); }
  listContentHashDuplicates() { return doctorPagesImpl.listContentHashDuplicates(this.executeRaw.bind(this)); }
  countTranscriptImportPages() { return doctorPagesImpl.countTranscriptImportPages(this.executeRaw.bind(this)); }
  countPageRows() { return doctorPagesImpl.countPageRows(this.executeRaw.bind(this)); }
  countPagesBySlugPrefix(prefix: string) { return doctorPagesImpl.countPagesBySlugPrefix(this.executeRaw.bind(this), prefix); }
  countLivePages() { return doctorPagesImpl.countLivePages(this.executeRaw.bind(this)); }
  readOldestPageCreatedAt() { return doctorPagesImpl.readOldestPageCreatedAt(this.executeRaw.bind(this)); }
  countPageTrustTiers() { return doctorPagesImpl.countPageTrustTiers(this.executeRaw.bind(this)); }
  countPagesWithMentionLinks() { return doctorPagesImpl.countPagesWithMentionLinks(this.executeRaw.bind(this)); }
  countImageModalityMismatches() { return doctorPagesImpl.countImageModalityMismatches(this.executeRaw.bind(this)); }
  readImagePageCoverage() { return doctorPagesImpl.readImagePageCoverage(this.executeRaw.bind(this)); }
  listFactsPageBodies() { return doctorPagesImpl.listFactsPageBodies(this.executeRaw.bind(this)); }
  listBracketPathPages() { return doctorPagesImpl.listBracketPathPages(this.executeRaw.bind(this)); }
  listSlugPathCandidates(sourceIds: string[] | null) { return doctorPagesImpl.listSlugPathCandidates(this.executeRaw.bind(this), sourceIds); }
  countAtomExtractionBacklog(query: AtomBacklogQuery, opts?: { signal?: AbortSignal }) {
    return atomBacklogImpl.countAtomExtractionBacklog((sql, params) => this.executeRaw(sql, params, opts?.signal ? { signal: opts.signal } : undefined), query);
  }
  listAtomBacklogSourceIds() { return doctorSearchImpl.listAtomBacklogSourceIds(this.executeRaw.bind(this)); }
  readProjectionBacklog(scope: PageReadScope) { return projectionBacklogImpl.readProjectionBacklog(this.executeRaw.bind(this), scope); }
  listGitImageHoldCounts(sourceIds: string[]) { return doctorSearchImpl.listGitImageHoldCounts(this.executeRaw.bind(this), sourceIds); }
  listTruncatedMarkdownBodies() { return doctorSearchImpl.listTruncatedMarkdownBodies(this.executeRaw.bind(this)); }
  countSegmentedMarkdownBodies() { return doctorSearchImpl.countSegmentedMarkdownBodies(this.executeRaw.bind(this)); }
  listRecentPageBodies(sourceIds: string[] | null) { return doctorSearchImpl.listRecentPageBodies(this.executeRaw.bind(this), sourceIds); }
  countSegmentedRecentPages(sourceIds: string[] | null) { return doctorSearchImpl.countSegmentedRecentPages(this.executeRaw.bind(this), sourceIds); }
  countPagesHiddenByPrefix(pattern: string, sourceIds: string[] | null) { return doctorSearchImpl.countPagesHiddenByPrefix(this.executeRaw.bind(this), pattern, sourceIds); }
  listOrphanedAliasCounts() { return doctorSearchImpl.listOrphanedAliasCounts(this.executeRaw.bind(this)); }
  readSoftDeletedAliasCounts() { return doctorSearchImpl.readSoftDeletedAliasCounts(this.executeRaw.bind(this)); }
  listPageTypePairs() { return doctorSearchImpl.listPageTypePairs(this.executeRaw.bind(this)); }
  listAccessMemberStatuses() { return doctorJoinImpl.listAccessMemberStatuses(this.executeRaw.bind(this)); }
  listAccessGroupMemberships() { return doctorJoinImpl.listAccessGroupMemberships(this.executeRaw.bind(this)); }
  listPagesReadByNobody(live: readonly string[], opts: { timeoutMs: number }) { return doctorJoinImpl.listPagesReadByNobody(this.executeRaw.bind(this), live, opts); }
  listRulePagesReadByNobody(sourceId: string, prefix: string, admittedCount: number, admitted: readonly string[], opts: { timeoutMs: number }) {
    return doctorJoinImpl.listRulePagesReadByNobody(this.executeRaw.bind(this), sourceId, prefix, admittedCount, admitted, opts);
  }
  listGoogleSourceMembers() { return doctorJoinImpl.listGoogleSourceMembers(this.executeRaw.bind(this)); }
  listOwnerMemberLinks(memberId: string) { return doctorJoinImpl.listOwnerMemberLinks(this.executeRaw.bind(this), memberId); }
  isAccessStateUnreadable() { return doctorAccImpl.isAccessStateUnreadable(this.executeRaw.bind(this)); }
  listRawOnlyRules() { return doctorAccImpl.listRawOnlyRules(this.executeRaw.bind(this)); }
  listAudienceMemberIds() { return doctorAccImpl.listAudienceMemberIds(this.executeRaw.bind(this)); }
  listLabelledOnlyMemberIds() { return doctorAccImpl.listLabelledOnlyMemberIds(this.executeRaw.bind(this)); }
  listAccessMemberRows(includeRemoved: boolean) { return doctorAccImpl.listAccessMemberRows(this.executeRaw.bind(this), includeRemoved); }
  listAttestCredentialRows() { return doctorAccImpl.listAttestCredentialRows(this.executeRaw.bind(this)); }
  listActiveAccessTokenRows() { return doctorAccImpl.listActiveAccessTokenRows(this.executeRaw.bind(this)); }
  listActiveOauthClientRows() { return doctorAccImpl.listActiveOauthClientRows(this.executeRaw.bind(this)); }
  listOauthClientAuthShapes() { return doctorAccImpl.listOauthClientAuthShapes(this.executeRaw.bind(this)); }
  listDanglingFederatedReads() { return doctorAccImpl.listDanglingFederatedReads(this.executeRaw.bind(this)); }
  listOrphanWorkspaceSources(suffix: string) { return doctorAccImpl.listOrphanWorkspaceSources(this.executeRaw.bind(this), suffix); }
  listPrivilegedDcrClients(scopeRegex: string) { return doctorAccImpl.listPrivilegedDcrClients(this.executeRaw.bind(this), scopeRegex); }
  readMcpRequestLogBytes() { return doctorAccImpl.readMcpRequestLogBytes(this.executeRaw.bind(this)); }
  countMcpRequestLogRows(limit: number) { return doctorAccImpl.countMcpRequestLogRows(this.executeRaw.bind(this), 'postgres', limit); }
  hasMcpLogRowsPastWindow(days: number, keepOperations: readonly string[]) { return doctorAccImpl.hasMcpLogRowsPastWindow(this.executeRaw.bind(this), days, keepOperations); }
  readKnowledgeRevisionNotNull() { return doctorAccImpl.readKnowledgeRevisionNotNull(this.executeRaw.bind(this)); }
  readDriftSchema() { return doctorAccImpl.readDriftSchema(this.executeRaw.bind(this)); }
  listDriftLiveRows(schema: doctorAccImpl.DriftSchema, sourceId: string, at: { after?: number; slug?: string }) { return doctorAccImpl.listDriftLiveRows(this.executeRaw.bind(this), schema, sourceId, at); }
  listDriftVersionRows(schema: doctorAccImpl.DriftSchema, pageIds: number[]) { return doctorAccImpl.listDriftVersionRows(this.executeRaw.bind(this), schema, pageIds); }
  originIndexPresent(name: string) { return doctorAccImpl.originIndexPresent(this.executeRaw.bind(this), name); }
  readChronicleLedgerStats() { return doctorAccImpl.readChronicleLedgerStats(this.executeRaw.bind(this)); }
  readChronicleDuplicateEvents() { return doctorAccImpl.readChronicleDuplicateEvents(this.executeRaw.bind(this)); }
  readFeedbackStatus() { return doctorAccImpl.readFeedbackStatus(this.executeRaw.bind(this)); }
  listVolunteerChannels(sourceIds: readonly string[] | null) { return doctorAccImpl.listVolunteerChannels(this.executeRaw.bind(this), sourceIds); }
  listFenceCandidateRecords(op: string, sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listFenceCandidateRecords(this.executeRaw.bind(this), op, sourceIds); }
  listDerivedOriginParks(op: string) { return doctorCheckpointsImpl.listDerivedOriginParks(this.executeRaw.bind(this), op); }
  listPurgeParks(op: string) { return doctorCheckpointsImpl.listPurgeParks(this.executeRaw.bind(this), op); }
  readSoakCounterRows(op: string, days: readonly string[]) { return doctorCheckpointsImpl.readSoakCounterRows(this.executeRaw.bind(this), op, days); }
  listUnfinishedManagedSyncCursors() { return doctorCheckpointsImpl.listUnfinishedManagedSyncCursors(this.executeRaw.bind(this)); }
  listManagedSyncPassStops(sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listManagedSyncPassStops(this.executeRaw.bind(this), sourceIds); }
  listManagedSyncBacklogHeaders() { return doctorCheckpointsImpl.listManagedSyncBacklogHeaders(this.executeRaw.bind(this)); }
  readManagedSyncPassRow(op: string, fingerprint: string) { return doctorCheckpointsImpl.readManagedSyncPassRow(this.executeRaw.bind(this), op, fingerprint); }
  listLiveManagedSyncPassRows(op: string, sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listLiveManagedSyncPassRows(this.executeRaw.bind(this), op, sourceIds); }
  listCheckpointBlockedSources(sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listCheckpointBlockedSources(this.executeRaw.bind(this), sourceIds); }
  listOpenIdentityDowngrades(op: string, sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listOpenIdentityDowngrades(this.executeRaw.bind(this), op, sourceIds); }
  listHeldManagedAtomRows(sourceIds: readonly string[] | undefined, excludedRole: string) { return doctorCheckpointsImpl.listHeldManagedAtomRows(this.executeRaw.bind(this), sourceIds, excludedRole); }
  readDoctorLastKnown(op: string) { return doctorCheckpointsImpl.readDoctorLastKnown(this.executeRaw.bind(this), op); }
  writeDoctorLastKnown(op: string, rows: readonly doctorCheckpointsImpl.DoctorLastKnownRow[]) { return doctorCheckpointsImpl.writeDoctorLastKnown(this.executeRaw.bind(this), op, rows); }
  readSyncAdmissionSettingRow(key: string, op: string, fingerprint: string) { return doctorCheckpointsImpl.readSyncAdmissionSettingRow(this.executeRaw.bind(this), key, op, fingerprint); }
  readLatestConnectorReceipt() { return doctorCheckpointsImpl.readLatestConnectorReceipt(this.executeRaw.bind(this)); }
  listFactsAbsorbFailureGroups() { return doctorCheckpointsImpl.listFactsAbsorbFailureGroups(this.executeRaw.bind(this)); }
  listCredentialResealHoldRows(producer: string, sourceIds?: readonly string[]) { return doctorCheckpointsImpl.listCredentialResealHoldRows(this.executeRaw.bind(this), producer, sourceIds); }
  readTerminalFailureGroups(query: doctorTerminalImpl.TerminalGroupsQuery, opts?: doctorTerminalImpl.TerminalReadOpts) { return doctorTerminalImpl.readTerminalFailureGroups(this.executeRaw.bind(this), query, opts); }
  listTerminalFailureBatch(query: doctorTerminalImpl.TerminalBatchQuery, opts?: doctorTerminalImpl.TerminalReadOpts) { return doctorTerminalImpl.listTerminalFailureBatch(this.executeRaw.bind(this), query, opts); }
  listOpenPassCheckpointBlockers(passOp: string, sourceIds: readonly string[] | null) { return doctorTerminalImpl.listOpenPassCheckpointBlockers(this.executeRaw.bind(this), passOp, sourceIds); }
  listWorktreeBlockerRequests(worktreeId: string, checkpoint: string) { return doctorTerminalImpl.listWorktreeBlockerRequests(this.executeRaw.bind(this), worktreeId, checkpoint); }
  listInterimStoredObjectCounts(type: string, shelfSourceId: string, prefix: string, adoptedTag: string) { return doctorBrainImpl.listInterimStoredObjectCounts(this.executeRaw.bind(this), type, shelfSourceId, prefix, adoptedTag); }
  readOldestSourceCreatedAt() { return doctorBrainImpl.readOldestSourceCreatedAt(this.executeRaw.bind(this)); }
  listVisibilityCandidatePages(sourceIds: readonly string[] | null) { return doctorBrainImpl.listVisibilityCandidatePages(this.executeRaw.bind(this), sourceIds); }
  countVisibilityNoncanonicalHolds(holdOp: string, sourceIds: readonly string[] | null) { return doctorBrainImpl.countVisibilityNoncanonicalHolds(this.executeRaw.bind(this), holdOp, sourceIds); }
  countReadersNoncanonicalHolds(holdOp: string, sourceIds: readonly string[] | null) { return doctorBrainImpl.countReadersNoncanonicalHolds(this.executeRaw.bind(this), holdOp, sourceIds); }
  listReaderCandidatePages(sourceIds: readonly string[] | null) { return doctorBrainImpl.listReaderCandidatePages(this.executeRaw.bind(this), sourceIds); }
  listContentBlockedReceipts() { return doctorBrainImpl.listContentBlockedReceipts(this.executeRaw.bind(this)); }
  listPassAdmittedReceipts(sourceId: string, passId: string) { return doctorBrainImpl.listPassAdmittedReceipts(this.executeRaw.bind(this), sourceId, passId); }
  listManagedSyncCursorFailureRows(sourceIds: readonly string[] | null) { return doctorSyncImpl.listManagedSyncCursorFailureRows(this.executeRaw.bind(this), sourceIds); }
  listManagedSyncOrphanRowsets(sourceIds: readonly string[] | null, movedMessage: string) { return doctorSyncImpl.listManagedSyncOrphanRowsets(this.executeRaw.bind(this), sourceIds, movedMessage); }
  listDurableManagedSyncFailureKeys(keys: readonly string[]) { return doctorSyncImpl.listDurableManagedSyncFailureKeys(this.executeRaw.bind(this), keys); }
  readDoctorSources<V extends doctorSourcesImpl.DoctorSourceVariant>(variant: V, scope?: doctorSourcesImpl.DoctorSourceScope) { return doctorSourcesImpl.readDoctorSources(this.executeRaw.bind(this), variant, scope); }
  listGuestSourceRows() { return doctorSourcesImpl.listGuestSourceRows(this.executeRaw.bind(this)); }
  listCheckoutRoots(hostId: string | null) { return doctorSourcesImpl.listCheckoutRoots(this.executeRaw.bind(this), hostId); }
  listPendingRoster(sourceIds: readonly string[] | null, hostId: string | null) { return doctorSourcesImpl.listPendingRoster(this.executeRaw.bind(this), sourceIds, hostId); }
  countDefaultSourceFiles() { return doctorSourcesImpl.countDefaultSourceFiles(this.executeRaw.bind(this)); }
  countConversationPipelinePages(types: readonly string[], slugPatterns: readonly string[]) { return doctorFactsTrustImpl.countConversationPipelinePages(this.executeRaw.bind(this), types, slugPatterns); }
  listPersistentWriterContention(reason: string) { return doctorFactsTrustImpl.listPersistentWriterContention(this.executeRaw.bind(this), reason); }
  countRowTrustTiers(table: doctorFactsTrustImpl.TrustTierTable) { return doctorFactsTrustImpl.countRowTrustTiers(this.executeRaw.bind(this), table); }
  countLegacyUnknownBySource(ceilings: doctorFactsTrustImpl.LegacyIdCeilings, sourceIds?: readonly string[]) { return doctorFactsTrustImpl.countLegacyUnknownBySource(this.executeRaw.bind(this), ceilings, sourceIds); }
  listTrustColumns() { return doctorFactsTrustImpl.listTrustColumns(this.executeRaw.bind(this)); }
  listTrustClaimTargets(mode: doctorFactsTrustImpl.TrustClaimTargetMode, sourceIds?: readonly string[]) { return doctorFactsTrustImpl.listTrustClaimTargets(this.executeRaw.bind(this), mode, sourceIds); }
  countClaimLiftedRows(table: doctorFactsTrustImpl.ClaimLiftTable) { return doctorFactsTrustImpl.countClaimLiftedRows(this.executeRaw.bind(this), table); }
  listFenceCensusSources(sourceIds: readonly string[] | null) { return fenceCensusImpl.listFenceCensusSources(this.executeRaw.bind(this), sourceIds); }
  readFencePassHorizon(graceMs: number) { return fenceCensusImpl.readFencePassHorizon(this.executeRaw.bind(this), graceMs); }
  listFenceCensusPagesById(sourceId: string, afterId: number, limit: number) { return fenceCensusImpl.listFenceCensusPagesById(this.executeRaw.bind(this), sourceId, afterId, limit); }
  listFenceCensusPagesUpdated(sourceId: string, lower: string, after: { at: string; id: number } | null, limit: number) { return fenceCensusImpl.listFenceCensusPagesUpdated(this.executeRaw.bind(this), sourceId, lower, after, limit); }
  listLiveFencePageIds(pageIds: readonly number[]) { return fenceCensusImpl.listLiveFencePageIds(this.executeRaw.bind(this), pageIds); }
  readFenceScanRecord(op: string, fingerprint: string) { return fenceCensusImpl.readFenceScanRecord(this.executeRaw.bind(this), op, fingerprint); }
  writeFenceScanRecord(op: string, fingerprint: string, record: Parameters<typeof fenceCensusImpl.writeFenceScanRecord>[3]) { return fenceCensusImpl.writeFenceScanRecord(this.executeRaw.bind(this), op, fingerprint, record); }
  upsertFenceCandidatePart(op: string, fingerprint: string, ids: { sourceId: string; incarnation: string; key: string }, part: 'page' | 'file', finding: Parameters<typeof fenceCensusImpl.upsertFenceCandidatePart>[5]) { return fenceCensusImpl.upsertFenceCandidatePart(this.executeRaw.bind(this), op, fingerprint, ids, part, finding); }
  clearFenceCandidateParts(op: string, fingerprints: readonly string[], part: 'page' | 'file') { return fenceCensusImpl.clearFenceCandidateParts(this.executeRaw.bind(this), op, fingerprints, part); }
  readFenceTrendRecords(op: string, sourceIds: readonly string[], fromDay: string) { return fenceCensusImpl.readFenceTrendRecords(this.executeRaw.bind(this), op, sourceIds, fromDay); }
  countSegmentedFencePages(sourceIds: readonly string[], walkedSourceIds: readonly string[]) { return fenceCensusImpl.countSegmentedFencePages(this.executeRaw.bind(this), sourceIds, walkedSourceIds); }
  readBudgetLedgerDay(scope: string, resolver: string, day: string) { return fenceCensusImpl.readBudgetLedgerDay(this.executeRaw.bind(this), scope, resolver, day); }
  upsertFactRelinkAttempt(sourceId: string, attempt: factRelinkImpl.FactRelinkAttempt, opts: factRelinkImpl.FactRelinkUpsertOpts = {}) { return factRelinkImpl.upsertFactRelinkAttempt(this.autocommitSql, sourceId, attempt, opts); }
  listFactRelinkOutcomes(sourceId: string, factIds: number[], outcomes: string[]) { return factRelinkImpl.listFactRelinkOutcomes(this.executeRaw.bind(this), sourceId, factIds, outcomes); }
  deleteFactRelinkMemos(sourceId: string, tier: string, targetSlug: string) { return factRelinkImpl.deleteFactRelinkMemos(this.autocommitSql, sourceId, tier, targetSlug); }
  placeRelinkedFact(sourceId: string, placement: factRelinkWritesImpl.RelinkPlacement) { return factRelinkWritesImpl.placeRelinkedFact(this.autocommitSql, sourceId, placement); }
  linkConversationFact(sourceId: string, link: factRelinkWritesImpl.ConversationFactLink) { return factRelinkWritesImpl.linkConversationFact(this.autocommitSql, sourceId, link); }
  listConversationRelinkPages(sourceId: string, q: factRelinkWritesImpl.ConversationRelinkPagesQuery) { return factRelinkWritesImpl.listConversationRelinkPages(this.executeRaw.bind(this), sourceId, q); }

  // Facts statements, command, cycle and fence reads (engine-sql/facts-cycle.ts), through executeRaw as before.
  listActiveFactsForEntity(sourceId: string, entitySlug: string, limit: number) { return factsCycleImpl.listActiveFactsForEntity(this.executeRaw.bind(this), sourceId, entitySlug, limit); }
  listFreshExtractionOutcomes(sourceId: string, slugs: string[], sources: string[], preferredSource: string) { return factsCycleImpl.listFreshExtractionOutcomes(this.executeRaw.bind(this), sourceId, slugs, sources, preferredSource); }
  listFenceRowGroups() { return factsCycleImpl.listFenceRowGroups(this.executeRaw.bind(this)); }
  readFactSubject(id: number) { return factsCycleImpl.readFactSubject(this.executeRaw.bind(this), id); }
  listFactProvenance(sourceId: string, ids: number[]) { return factsTrustImpl.listFactProvenance(this.executeRaw.bind(this), sourceId, ids); }
  factsOrAliasesMayMatch(sourceId: string, slugTokens: readonly string[], aliasNorms: readonly string[]) { return factsCycleImpl.factsOrAliasesMayMatch(this.executeRaw.bind(this), sourceId, slugTokens, aliasNorms); }
  listFactsForPage(sourceId: string, slug: string) { return factsCycleImpl.listFactsForPage(this.executeRaw.bind(this), sourceId, slug); }
  countLegacyFactsPending(sourceId: string) { return factsCycleImpl.countLegacyFactsPending(this.executeRaw.bind(this), sourceId); }
  countUnconsolidatedFactsBySource(opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }) { return factsCycleImpl.countUnconsolidatedFactsBySource(this.executeRaw.bind(this), opts); }
  findBulkFactDays(sourceIds: string[] | undefined, rule: factsCycleImpl.BulkDayRule) { return factsCycleImpl.findBulkFactDays(this.executeRaw.bind(this), sourceIds, rule); }
  maxFenceRowNum(sourceId: string, slug: string) { return factsCycleImpl.maxFenceRowNum(this.executeRaw.bind(this), sourceId, slug); }
  readFenceRowOccupant(sourceId: string, slug: string, rowNum: number) { return factsCycleImpl.readFenceRowOccupant(this.executeRaw.bind(this), sourceId, slug, rowNum); }
  listStoredFenceFactRows(sourceId: string, slug: string) { return factsCycleImpl.listStoredFenceFactRows(this.executeRaw.bind(this), sourceId, slug); }
  countWorldFacts(opts: factsCycleImpl.EntityFactCountOpts) { return factsCycleImpl.countWorldFacts(this.executeRaw.bind(this), opts); }
  listPhantomFactRows(sourceId: string, slug: string) { return factsCycleImpl.listPhantomFactRows(this.executeRaw.bind(this), sourceId, slug); }
  listCanonicalFenceRowNums(sourceId: string, slug: string) { return factsCycleImpl.listCanonicalFenceRowNums(this.executeRaw.bind(this), sourceId, slug); }
  moveFactToPage(sourceId: string, id: number, slug: string, rowNum: number | null) { return factsCycleImpl.moveFactToPage(this.executeRaw.bind(this), sourceId, id, slug, rowNum); }
  repointInboundLinks(phantomId: number, canonicalId: number) { return factsCycleImpl.repointInboundLinks(this.executeRaw.bind(this), phantomId, canonicalId); }
  repointOutboundLinks(phantomId: number, canonicalId: number) { return factsCycleImpl.repointOutboundLinks(this.executeRaw.bind(this), phantomId, canonicalId); }
  pageHasTimelineEntries(pageId: number | string | null) { return factsCycleImpl.pageHasTimelineEntries(this.executeRaw.bind(this), pageId); }
  maxFenceRowNumOfPage(sourceId: string, slug: string) { return factsCycleImpl.maxFenceRowNumOfPage(this.executeRaw.bind(this), sourceId, slug); }
  listRootPageSlugsAfter(sourceId: string, take: number, held: string[], after: string) { return factsCycleImpl.listRootPageSlugsAfter(this.executeRaw.bind(this), sourceId, take, held, after); }
  listOwnLinkIds(pageId: number | string) { return factsCycleImpl.listOwnLinkIds(this.executeRaw.bind(this), pageId); }
  listActiveFactIdsOfPage(sourceId: string, slug: string) { return factsCycleImpl.listActiveFactIdsOfPage(this.executeRaw.bind(this), sourceId, slug); }
  listFactIdsStillOnPage(ids: number[], slug: string) { return factsCycleImpl.listFactIdsStillOnPage(this.executeRaw.bind(this), ids, slug); }
  listLinkIdsOnPage(ids: number[], pageId: number | string) { return factsCycleImpl.listLinkIdsOnPage(this.executeRaw.bind(this), ids, pageId); }
  readPageFileOrigin(sourceId: string, slug: string, opts?: { includeDeleted?: boolean }) { return factsCycleImpl.readPageFileOrigin(this.executeRaw.bind(this), sourceId, slug, opts); }
  listFenceRowClaims(sourceId: string, slug: string) { return factsCycleImpl.listFenceRowClaims(this.executeRaw.bind(this), sourceId, slug); }
  adoptFactIntoFence(sourceId: string, id: string, rowNum: number, slug: string, fact: string) { return factsCycleImpl.adoptFactIntoFence(this.executeRaw.bind(this), sourceId, id, rowNum, slug, fact); }
  listFenceRowSupersession(sourceId: string, slug: string) { return factsCycleImpl.listFenceRowSupersession(this.executeRaw.bind(this), sourceId, slug); }
  setFactSupersededBy(sourceId: string, id: number | string, supersededBy: number | null) { return factsCycleImpl.setFactSupersededBy(this.executeRaw.bind(this), sourceId, id, supersededBy); }
  listHeldWideningFactIds(sourceId: string, ids: number[]) { return factsCycleImpl.listHeldWideningFactIds(this.executeRaw.bind(this), sourceId, ids); }
  expireFactInPlace(sourceId: string, id: number | string) { return factsCycleImpl.expireFactInPlace(this.executeRaw.bind(this), sourceId, id); }
  expireAndDetachFact(sourceId: string, id: number | string) { return factsCycleImpl.expireAndDetachFact(this.executeRaw.bind(this), sourceId, id); }
  updateFenceFactCells(sourceId: string, id: number | string, cells: factsCycleImpl.FenceFactCells) { return factsCycleImpl.updateFenceFactCells(this.executeRaw.bind(this), sourceId, id, cells); }
  listExpirableFactIdsOfDeletedPage(sourceId: string, slug: string, pageId: number | null) { return factsCycleImpl.listExpirableFactIdsOfDeletedPage(this.executeRaw.bind(this), sourceId, slug, pageId); }
  readDeletedPageBody(sourceId: string, slug: string) { return factsCycleImpl.readDeletedPageBody(this.executeRaw.bind(this), sourceId, slug); }
  expireFactsByIds(sourceId: string, ids: number[]) { return factsCycleImpl.expireFactsByIds(this.executeRaw.bind(this), sourceId, ids); }
  listOntologyObservationSlugs(sourceId: string) { return factsCycleImpl.listOntologyObservationSlugs(this.executeRaw.bind(this), sourceId); }
  listDeletedPageSlugsWithActiveFacts(sourceId: string) { return factsCycleImpl.listDeletedPageSlugsWithActiveFacts(this.executeRaw.bind(this), sourceId); }
  scanUnfencedFactRows(sourceId: string) { return factsCycleImpl.scanUnfencedFactRows(this.executeRaw.bind(this), sourceId); }
  listHeldFactRows(sourceId: string, days: string) { return factsCycleImpl.listHeldFactRows(this.executeRaw.bind(this), sourceId, days); }
  listFencedFactsOfMissingPages(sourceId: string) { return factsCycleImpl.listFencedFactsOfMissingPages(this.executeRaw.bind(this), sourceId); }
  readFenceRowNumHint(sourceId: string, slug: string) { return factsCycleImpl.readFenceRowNumHint(this.executeRaw.bind(this), sourceId, slug); }
  readSourceCheckoutPath(sourceId: string) { return factsCycleImpl.readSourceCheckoutPath(this.executeRaw.bind(this), sourceId); }
  readLiveStoredBody(sourceId: string, slug: string, lock = false) { return factsCycleImpl.readLiveStoredBody(this.executeRaw.bind(this), sourceId, slug, lock); }
  listPageStates(sourceId: string, slug: string) { return factsCycleImpl.listPageStates(this.executeRaw.bind(this), sourceId, slug); }
  countSegmentedVersionsOfPage(sourceId: string, slug: string) { return factsCycleImpl.countSegmentedVersionsOfPage(this.executeRaw.bind(this), sourceId, slug); }

  // Facts statements, purge, withdrawal, relink and fence repair (engine-sql/facts-purge.ts), through executeRaw as before.

  countFactFingerprintLeftovers(sourceId: string, factHash: string, visibility: string, subject: string) { return factsPurgeImpl.countFactFingerprintLeftovers(this.executeRaw.bind(this), sourceId, factHash, visibility, subject); }
  loadPurgeTarget(id: number, sourceId: string) { return factsPurgeImpl.loadPurgeTarget(this.executeRaw.bind(this), id, sourceId); }
  planFactPurgeIds(sourceId: string, visibility: string, factHash: string, subject: string) { return factsPurgeImpl.planFactPurgeIds(this.executeRaw.bind(this), sourceId, visibility, factHash, subject); }
  listFactsReconcileBacklog() { return factsPurgeImpl.listFactsReconcileBacklog(this.executeRaw.bind(this)); }
  settleFactsReconcile(sourceId: string, slug: string, outcome: factsPurgeImpl.FactsReconcileOutcome, revision?: string | null) { return factsPurgeImpl.settleFactsReconcile(this.executeRaw.bind(this), sourceId, slug, outcome, revision); }
  lockReconcileRevision(sourceId: string, slug: string, revision: string | null) { return factsPurgeImpl.lockReconcileRevision(this.executeRaw.bind(this), sourceId, slug, revision); }
  selectFactsReconcileDrain(sourceId: string, pageLimit: number) { return factsPurgeImpl.selectFactsReconcileDrain(this.executeRaw.bind(this), sourceId, pageLimit); }
  listRelinkCandidateRows(opts: { sourceId: string; afterId: number; since: Date | null; limit: number }) { return factsPurgeImpl.listRelinkCandidateRows(this.executeRaw.bind(this), opts); }
  countRelinkCandidates(sourceId: string) { return factsPurgeImpl.countRelinkCandidates(this.executeRaw.bind(this), sourceId); }
  listSimilarActiveFacts(opts: { sourceId: string; factId: number; remote: boolean; excludePrivate: boolean; minCosine: number; limit: number }) { return factsPurgeImpl.listSimilarActiveFacts(this.executeRaw.bind(this), opts); }
  findActiveSingleFact(opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean; newest?: boolean }) { return factsPurgeImpl.findActiveSingleFact(this.executeRaw.bind(this), opts); }
  listSingleFactMetadata(opts: { sourceId: string; ids: number[]; remoteFloor: boolean }) { return factsPurgeImpl.listSingleFactMetadata(this.executeRaw.bind(this), opts); }
  countUnfencedFactGroups(opts: { sourceId?: string }) { return factsPurgeImpl.countUnfencedFactGroups(this.executeRaw.bind(this), opts); }
  listUnfencedFactRows(opts: { sourceId?: string; fenceableSourceIds?: string[] }) { return factsPurgeImpl.listUnfencedFactRows(this.executeRaw.bind(this), opts); }
  listHeldFenceFactRows(sourceId: string, slug: string) { return factsPurgeImpl.listHeldFenceFactRows(this.executeRaw.bind(this), sourceId, slug); }
  listWithdrawalSlugs(sourceId: string, visibility: string, factHash: string, subject: string) { return factsPurgeImpl.listWithdrawalSlugs(this.executeRaw.bind(this), sourceId, visibility, factHash, subject); }
  expireFactsByWithdrawal(sourceId: string, visibility: string, fact: string, subject: string) { return factsPurgeImpl.expireFactsByWithdrawal(this.executeRaw.bind(this), sourceId, visibility, fact, subject); }
  insertFactPurge(row: factsPurgeImpl.FactPurgeInsert) { return factsPurgeImpl.insertFactPurge(this.executeRaw.bind(this), row); }
  insertTakePurge(row: factsPurgeImpl.TakePurgeInsert) { return factsPurgeImpl.insertTakePurge(this.executeRaw.bind(this), row); }
  listDerivedRows(frontier: ReadonlyArray<{ table: string; id: string }>, limit: number) { return factsPurgeImpl.listDerivedRows(this.executeRaw.bind(this), frontier, limit); }
  upsertPagePurges(row: factsPurgeImpl.PagePurgeUpsert) { return factsPurgeImpl.upsertPagePurges(this.executeRaw.bind(this), row); }
  // A fact purge's plan, dry run and --match (engine-sql/facts-purge-plan.ts), through executeRaw as before.
  listRequestsCarryingClaim(q: factsPurgePlanImpl.PurgeClaimNeedles & { limit: number }) { return factsPurgePlanImpl.listRequestsCarryingClaim(this.executeRaw.bind(this), q); }
  listRequestsHoldingStagings(sourceId: string, stagingIds: readonly string[]) { return factsPurgePlanImpl.listRequestsHoldingStagings(this.executeRaw.bind(this), sourceId, stagingIds); }
  countPurgeProbe(probe: factsPurgePlanImpl.PurgeProbe, rows: number) { return factsPurgePlanImpl.countPurgeProbe(this.executeRaw.bind(this), probe, rows); }
  listPurgeProbeItems(probe: factsPurgePlanImpl.PurgeItemsProbe) { return factsPurgePlanImpl.listPurgeProbeItems(this.executeRaw.bind(this), probe); }
  // A projection rebuild's queue, keep-plan and seal statements (engine-sql/projection-rebuild.ts), through executeRaw as before.
  listQueuedPageProjections(filter: projectionRebuildImpl.QueuedProjectionFilter) { return projectionRebuildImpl.listQueuedPageProjections(this.executeRaw.bind(this), filter); }
  readProjectionJobReason(key: projectionRebuildImpl.ProjectionJobKey) { return projectionRebuildImpl.readProjectionJobReason(this.executeRaw.bind(this), key); }
  readChunkKeepState(pageId: number, provenanceModel: string | null, column: projectionRebuildImpl.KeepColumn) { return projectionRebuildImpl.readChunkKeepState(this.executeRaw.bind(this), pageId, provenanceModel, column); }
  clearUnkeptChunkVectors(pageId: number, provenanceModel: string | null, column: projectionRebuildImpl.KeepColumn, currentIds: readonly number[]) { return projectionRebuildImpl.clearUnkeptChunkVectors(this.executeRaw.bind(this), pageId, provenanceModel, column, currentIds); }
  setProjectionChunkerVersion(sourceId: string, slug: string, version: number) { return projectionRebuildImpl.setProjectionChunkerVersion(this.executeRaw.bind(this), sourceId, slug, version); }
  hasDrainableProjectionJob(opts: { media?: boolean } = {}) { return projectionRebuildImpl.hasDrainableProjectionJob(this.executeRaw.bind(this), opts); }
  readChunkRowsFingerprint(pageId: number) { return projectionRebuildImpl.readChunkRowsFingerprint(this.executeRaw.bind(this), pageId); }
  deleteUnkeptChunks(pageId: number, keptIds: readonly number[]) { return projectionRebuildImpl.deleteUnkeptChunks(this.executeRaw.bind(this), pageId, keptIds); }
  listStaleChunkVectors(pageId: number, provenanceModel: string | null, column: projectionRebuildImpl.KeepColumn, currentIds: readonly number[]) { return projectionRebuildImpl.listStaleChunkVectors(this.executeRaw.bind(this), pageId, provenanceModel, column, currentIds); }
  clearChunkVectors(pageId: number, column: projectionRebuildImpl.KeepColumn, ids: readonly number[]) { return projectionRebuildImpl.clearChunkVectors(this.executeRaw.bind(this), pageId, column, ids); }
  countPendingTextChunks(pageId: number, column: projectionRebuildImpl.KeepColumn) { return projectionRebuildImpl.countPendingTextChunks(this.executeRaw.bind(this), pageId, column); }
  probeProjectionWindowCandidates(candidates: readonly projectionRebuildImpl.ProjectionWindowCandidate[]) { return projectionRebuildImpl.probeProjectionWindowCandidates(this.executeRaw.bind(this), candidates); }
  readProjectionHead(sourceId: string, slug: string) { return projectionRebuildImpl.readProjectionHead(this.executeRaw.bind(this), sourceId, slug); }
  isDeferredReplacementHeld(sourceId: string, slug: string, revision: string, claim: string) { return projectionRebuildImpl.isDeferredReplacementHeld(this.executeRaw.bind(this), sourceId, slug, revision, claim); }
  renewDeferredReplacementClaim(job: projectionRebuildImpl.ProjectionJobKey, claim: string) { return projectionRebuildImpl.renewDeferredReplacementClaim(this.executeRaw.bind(this), job, claim); }
  releaseDeferredReplacementClaim(slug: string, claim: string) { return projectionRebuildImpl.releaseDeferredReplacementClaim(this.executeRaw.bind(this), slug, claim); }
  listProjectionDrainPreview(limit: number) { return projectionRebuildImpl.listProjectionDrainPreview(this.executeRaw.bind(this), limit); }
  listImageSealWindow(after: { sourceIncarnation: string; slug: string }, limit: number, notAfter?: string) { return projectionRebuildImpl.listImageSealWindow(this.executeRaw.bind(this), after, limit, notAfter); }
  readImageSealPages(rows: ReadonlyArray<{ source_id: string; slug: string; revision: string }>) { return projectionRebuildImpl.readImageSealPages(this.executeRaw.bind(this), rows); }
  listImageSealChunks(pageIds: readonly number[], column: projectionRebuildImpl.KeepColumn, provenanceModel: string | null) { return projectionRebuildImpl.listImageSealChunks(this.executeRaw.bind(this), pageIds, column, provenanceModel); }
  clearImageSealVectors(column: projectionRebuildImpl.KeepColumn, chunks: ReadonlyArray<{ id: number; page_id: number }>) { return projectionRebuildImpl.clearImageSealVectors(this.executeRaw.bind(this), column, chunks); }
  sealImagePages(pages: ReadonlyArray<{ id: number; revision: string }>) { return projectionRebuildImpl.sealImagePages(this.executeRaw.bind(this), pages); }
  hasQueuedProjectionWork(opts: { media?: boolean } = {}) { return projectionRebuildImpl.hasQueuedProjectionWork(this.executeRaw.bind(this), opts); }
  readPagesRowEstimate() { return projectionRebuildImpl.readPagesRowEstimate(this.executeRaw.bind(this)); }
  readDrainRunStart() { return projectionRebuildImpl.readDrainRunStart(this.executeRaw.bind(this)); }
  isDrainClockPast(runStart: string) { return projectionRebuildImpl.isDrainClockPast(this.executeRaw.bind(this), runStart); }
  queuePageProjectionJob(sourceId: string, slug: string, reason: string) { return projectionRebuildImpl.queuePageProjectionJob(this.executeRaw.bind(this), sourceId, slug, reason); }
  hasSegmentedPage(sourceId: string, slug: string) { return projectionRebuildImpl.hasSegmentedPage(this.executeRaw.bind(this), sourceId, slug); }
  rekeyProjectionJob(job: projectionRebuildImpl.ProjectionJobKey, revision: string) { return projectionRebuildImpl.rekeyProjectionJob(this.executeRaw.bind(this), job, revision); }
  stampDeferredProjectionJob(job: projectionRebuildImpl.ProjectionJobKey, requeue: boolean) { return projectionRebuildImpl.stampDeferredProjectionJob(this.executeRaw.bind(this), job, requeue); }
  touchUnclaimedProjectionJob(job: projectionRebuildImpl.ProjectionJobKey) { return projectionRebuildImpl.touchUnclaimedProjectionJob(this.executeRaw.bind(this), job); }
  deferProjectionJob(job: projectionRebuildImpl.ProjectionJobKey) { return projectionRebuildImpl.deferProjectionJob(this.executeRaw.bind(this), job); }
  expireFactsOfGonePages(sourceIds: string[], slugs: string[]) { return factsPurgeImpl.expireFactsOfGonePages(this.executeRaw.bind(this), sourceIds, slugs); }
  readPurgeSourceLocalPath(sourceId: string) { return factsPurgeImpl.readPurgeSourceLocalPath(this.executeRaw.bind(this), sourceId); }
  listGitEffectsCarryingReason(sourceId: string, needle: string, escaped: string, foldedJson: string) { return factsPurgeImpl.listGitEffectsCarryingReason(this.executeRaw.bind(this), sourceId, needle, escaped, foldedJson); }
  listPageGitEffectsForStrip(sourceId: string, slug: string) { return factsPurgeImpl.listPageGitEffectsForStrip(this.executeRaw.bind(this), sourceId, slug); }
  setPurgeEffectData(effectId: string, data: Record<string, unknown>) { return factsPurgeImpl.setPurgeEffectData(this.executeRaw.bind(this), effectId, data); }
  listPageChangeReasons(sourceId: string, slug: string, pageId: number) { return factsPurgeImpl.listPageChangeReasons(this.executeRaw.bind(this), sourceId, slug, pageId); }
  listRequestsRecordingReasons(sourceId: string, slug: string) { return factsPurgeImpl.listRequestsRecordingReasons(this.executeRaw.bind(this), sourceId, slug); }
  heldEntityPageDeleted(sourceId: string, slug: string) { return factsPurgeImpl.heldEntityPageDeleted(this.executeRaw.bind(this), sourceId, slug); }
  readHeldAccessState(sourceId: string, entity: string) { return factsPurgeImpl.readHeldAccessState(this.executeRaw.bind(this), sourceId, entity); }
  heldTargetPageLive(sourceId: string, slug: string) { return factsPurgeImpl.heldTargetPageLive(this.executeRaw.bind(this), sourceId, slug); }
  listHeldMoveRows(sourceId: string) { return factsPurgeImpl.listHeldMoveRows(this.executeRaw.bind(this), sourceId); }
  listStruckHeldRows(sourceId: string) { return factsPurgeImpl.listStruckHeldRows(this.executeRaw.bind(this), sourceId); }
  readHeldRowVisibility(sourceId: string, slug: string) { return factsPurgeImpl.readHeldRowVisibility(this.executeRaw.bind(this), sourceId, slug); }
  heldMoveDue(sourceId: string) { return factsPurgeImpl.heldMoveDue(this.executeRaw.bind(this), sourceId); }
  readHeldConfigValue(name: string) { return factsPurgeImpl.readHeldConfigValue(this.executeRaw.bind(this), name); }
  readHeldPageLocation(sourceId: string, slug: string, opts?: { timeoutMs?: number }) { return factsPurgeImpl.readHeldPageLocation(this.executeRaw.bind(this), sourceId, slug, opts); }
  readHeldVersionsEdited(requestId: string) { return factsPurgeImpl.readHeldVersionsEdited(this.executeRaw.bind(this), requestId); }
  listSegmentedPageBodies(sourceId: string, limit: number) { return factsPurgeImpl.listSegmentedPageBodies(this.executeRaw.bind(this), sourceId, limit); }
  listSegmentedVersionBodies(sourceId: string, limit: number) { return factsPurgeImpl.listSegmentedVersionBodies(this.executeRaw.bind(this), sourceId, limit); }
  setPurgeProbeTimeout(ms: number) { return factsPurgeImpl.setPurgeProbeTimeout(this.executeRaw.bind(this), ms); }
  probePurgeDerivations(sourceId: string, needles: string[], pageIds: number[], patterns: string[], cursor: factsPurgeImpl.DerivationKey | null, rows: number) { return factsPurgeImpl.probePurgeDerivations(this.executeRaw.bind(this), sourceId, needles, pageIds, patterns, cursor, rows); }
  listBeliefEventsForPurgeProbe(sourceId: string, after: number) { return factsPurgeImpl.listBeliefEventsForPurgeProbe(this.executeRaw.bind(this), sourceId, after); }
  listFactContextsForPurgeProbe(sourceId: string, after: number) { return factsPurgeImpl.listFactContextsForPurgeProbe(this.executeRaw.bind(this), sourceId, after); }
  listPageSourcePathsForPurge(pageIds: number[]) { return factsPurgeImpl.listPageSourcePathsForPurge(this.executeRaw.bind(this), pageIds); }
  listNearestFactsForPurge(embedding: string, sourceId: string, model: string, fact: string) { return factsPurgeImpl.listNearestFactsForPurge(this.executeRaw.bind(this), embedding, sourceId, model, fact); }
  countLegacyDerivedPages(sourceId: string) { return factsPurgeImpl.countLegacyDerivedPages(this.executeRaw.bind(this), sourceId); }
  vacuumPurgedTables(withQueryCache: boolean) { return factsPurgeImpl.vacuumPurgedTables(this.executeRaw.bind(this), withQueryCache); }
  listPageProseHits(store: factsPurgeImpl.PageProseStore, sourceId: string, loweredNeedles: string[]) { return factsPurgeImpl.listPageProseHits(this.executeRaw.bind(this), store, sourceId, loweredNeedles); }
  readPurgeReceiptSourcePath(sourceId: string) { return factsPurgeImpl.readPurgeReceiptSourcePath(this.executeRaw.bind(this), sourceId); }
  countPagePurgeTombstones(sourceId: string, slug: string) { return factsPurgeImpl.countPagePurgeTombstones(this.executeRaw.bind(this), sourceId, slug); }
  listPurgeClaimFacts(sourceId: string, slug: string) { return this.ownRawRead(exec => pagePurgeImpl.listPurgeClaimFacts(exec, sourceId, slug)); }
  listPurgeClaimTakes(pageId: number) { return this.ownRawRead(exec => pagePurgeImpl.listPurgeClaimTakes(exec, pageId)); }
  listPurgeSegmentClaims(sourceId: string, slug: string, pageId: number) { return pagePurgeImpl.listPurgeSegmentClaims(this, sourceId, slug, pageId); }
  listQueuedPagePurges(sourceId: string, afterSequence: string, limit: number) { return this.ownRawRead(exec => pagePurgeImpl.listQueuedPagePurges(exec, sourceId, afterSequence, limit)); }
  listPageLinkStreams(sourceId: string, pageId: number) { return this.ownRawRead(exec => pagePurgeImpl.listPageLinkStreams(exec, sourceId, pageId)); }
  insertPageFactPurges(sourceId: string, slug: string, requestId: string, actor: string) { return pagePurgeImpl.insertPageFactPurges(this, sourceId, slug, requestId, actor); }
  listPageVersionBodiesForPurge(pageId: number) { return pagePurgeImpl.listPageVersionBodiesForPurge(this, pageId); }
  readPurgePageBody(pageId: number) { return pagePurgeImpl.readPurgePageBody(this, pageId); }
  listPageMirrorFacts(sourceId: string, slug: string) { return pagePurgeImpl.listPageMirrorFacts(this, sourceId, slug); }
  listPageMirrorTakeHashes(pageId: number) { return pagePurgeImpl.listPageMirrorTakeHashes(this, pageId); }
  countPageCascadeRows(pageId: number) { return pagePurgeImpl.countPageCascadeRows(this, pageId); }
  listPageVersionSourcePaths(pageId: number) { return pagePurgeImpl.listPageVersionSourcePaths(this, pageId); }
  listPagePurgeTombstones(sourceId: string, limit: number) { return this.ownRawRead(exec => pagePurgeImpl.listPagePurgeTombstones(exec, sourceId, limit)); }
  listPagePurgeRows(sourceId: string | null, limit: number) { return pagePurgeImpl.listPagePurgeRows(this, sourceId, limit); }
  deletePagePurgeTombstones(sourceId: string, slug: string) { return pagePurgeImpl.deletePagePurgeTombstones(this, sourceId, slug); }
  deleteFactPurgesByRequests(sourceId: string, requestIds: readonly string[]) { return pagePurgeImpl.deleteFactPurgesByRequests(this, sourceId, requestIds); }
  deleteTakePurgesByRequests(sourceId: string, requestIds: readonly string[]) { return pagePurgeImpl.deleteTakePurgesByRequests(this, sourceId, requestIds); }
  deletePurgedPageTrustProposals(sourceId: string, pageId: number, factIds: number[], takeIds: number[]) { return pagePurgeSweepImpl.deletePurgedPageTrustProposals(this, sourceId, pageId, factIds, takeIds); }
  deletePurgedPageHolds(sourceId: string, slug: string, pageId?: number | null) { return pagePurgeSweepImpl.deletePurgedPageHolds(this, sourceId, slug, pageId ?? null); }
  deletePurgedPageGateReceipts(pageId: number, factIds: number[], takeIds: number[], holdIds: string[]) { return pagePurgeSweepImpl.deletePurgedPageGateReceipts(this, pageId, factIds, takeIds, holdIds); }
  deletePurgedPageFacts(sourceId: string, slug: string) { return pagePurgeSweepImpl.deletePurgedPageFacts(this, sourceId, slug); }
  deletePurgedPageFiles(sourceId: string, slug: string, pageId: number) { return pagePurgeSweepImpl.deletePurgedPageFiles(this, sourceId, slug, pageId); }
  listPageTimelineReceipts(sourceId: string, slugs: readonly string[], limit: number, after: string, withDiffs: boolean) { return pagePurgeSweepImpl.listPageTimelineReceipts(this, sourceId, slugs, limit, after, withDiffs); }
  listPageSegmentShas(sourceId: string, slug: string, pageId: number) { return pagePurgeSweepImpl.listPageSegmentShas(this, sourceId, slug, pageId); }
  countPageManifestRows(pageId: number) { return pagePurgeSweepImpl.countPageManifestRows(this, pageId); }
  deletePageStagings(sourceId: string, slug: string, pageId: number) { return pagePurgeSweepImpl.deletePageStagings(this, sourceId, slug, pageId); }
  deletePageSegmentTexts(sourceId: string, shas: readonly string[]) { return pagePurgeSweepImpl.deletePageSegmentTexts(this, sourceId, shas); }
  sweepPageTextsForClaims(sourceId: string, cursor: string, forms: readonly string[], chunkBytes: number) { return pagePurgeSweepImpl.sweepPageTextsForClaims(this, sourceId, cursor, forms, chunkBytes); }
  listRequestsForSlugs(sourceId: string, slugs: readonly string[], limit: number, after: string) { return pagePurgeJournalImpl.listRequestsForSlugs(this, sourceId, slugs, limit, after); }
  /** The journal sweep's two reads run in write preparation under the claim's deadline (TYPED_PREPARATION_READS): `ownRawRead` ends them on the server at the bound, as the bounded view ended their raw statements. */
  readJournalCeiling(sourceId: string) { return this.ownRawRead(exec => pagePurgeJournalImpl.readJournalCeiling(exec, sourceId)); }
  sweepJournalChunk(q: pagePurgeJournalImpl.JournalChunkQuery) { return this.ownRawRead(exec => pagePurgeJournalImpl.sweepJournalChunk(exec, q)); }
  readEffectBytes(requestId: string) { return pagePurgeJournalImpl.readEffectBytes(this, requestId); }
  redactWriteRequestRow(redaction: pagePurgeJournalImpl.RequestRedaction) { return pagePurgeJournalImpl.redactWriteRequestRow(this, redaction); }
  releaseTerminalBytes(key: string, bytes: number) { return pagePurgeJournalImpl.releaseTerminalBytes(this, key, bytes); }
  deletePurgedFeedbackRows(sourceId: string, slugs: readonly string[]) { return purgeStoresImpl.deletePurgedFeedbackRows(this, sourceId, slugs); }
  deletePurgedNameStoreRows(sourceId: string, slugs: readonly string[]) { return purgeStoresImpl.deletePurgedNameStoreRows(this, sourceId, slugs); }
  clearQueryCache(sourceId?: string) { return purgeStoresImpl.clearQueryCache(this, sourceId); }
  relationExists(table: string) { return purgeReceiptImpl.relationExists(this, table); }
  readDerivationPurgeState(requestId: string) { return purgeReceiptImpl.readDerivationPurgeState(this, requestId); }
  recordDerivationPurgeRow(row: purgeReceiptImpl.DerivationPurgeRecord) { return purgeReceiptImpl.recordDerivationPurgeRow(this, row); }
  continueDerivationSweep(sourceId: string, opts: purgeReceiptImpl.DerivationSweepOptions, limits: purgeReceiptImpl.DerivationSweepLimits, hooks?: purgeReceiptImpl.DerivationSweepHooks) { return runDerivationSweep(this, sourceId, opts, limits, hooks); }
  listDerivationClaimForms(claims: readonly string[]) { return purgeReceiptImpl.listDerivationClaimForms(this, claims); }
  listPurgeOrigins(ids: readonly number[], recheckParked: boolean) { return originHoldsImpl.listPurgeOrigins(this, ids, recheckParked); }
  upsertDerivedOriginPark(pageId: number, park: DerivedOriginPark) { return originHoldsImpl.upsertDerivedOriginPark(this, pageId, park); }
  recordOwedPurgeRows(pageId: number, requestId: string) { return originHoldsImpl.recordOwedPurgeRows(this, pageId, requestId); }
  deleteOriginHoldRows(op: 'derived-origin-park' | 'owed-page-purge', pageIds: readonly number[]) { return originHoldsImpl.deleteOriginHoldRows(this, op, pageIds); }
  readDeletePageRequest(sourceId: string, requestId: string) { return factsPurgeImpl.readDeletePageRequest(this.executeRaw.bind(this), sourceId, requestId); }
  listPurgeEffects(requestId: string) { return factsPurgeImpl.listPurgeEffects(this.executeRaw.bind(this), requestId); }
  countPurgeFingerprintResidue(sourceId: string, factHash: string, subject: string) { return factsPurgeImpl.countPurgeFingerprintResidue(this.executeRaw.bind(this), sourceId, factHash, subject); }
  listStagingPartEdges(sourceId: string, keep: number, after: { id: string; part: number }) { return factsPurgeImpl.listStagingPartEdges(this.executeRaw.bind(this), sourceId, keep, after); }
  listStagingsHoldingClaim(sourceId: string, claim: string) { return factsPurgeImpl.listStagingsHoldingClaim(this.executeRaw.bind(this), sourceId, claim); }
  purgeSubjectPageLive(sourceId: string, slug: string) { return factsPurgeImpl.purgeSubjectPageLive(this.executeRaw.bind(this), sourceId, slug); }
  listPurgePagesById(sourceId: string, pageIds: number[]) { return factsPurgeImpl.listPurgePagesById(this.executeRaw.bind(this), sourceId, pageIds); }
  countPurgeVersionsCarryingClaim(sourceId: string, needle: string, escaped: string, reason: string) { return factsPurgeImpl.countPurgeVersionsCarryingClaim(this.executeRaw.bind(this), sourceId, needle, escaped, reason); }
  countPurgeReviewRows(sourceId: string, refs: string[], factIds: number[]) { return factsPurgeImpl.countPurgeReviewRows(this.executeRaw.bind(this), sourceId, refs, factIds); }
  listPurgeStreamSlugs(factIds: number[]) { return factsPurgeImpl.listPurgeStreamSlugs(this.executeRaw.bind(this), factIds); }
  findPurgeBlockedPublication(sourceId: string, slugs: string[], ownRequest: string) { return factsPurgeImpl.findPurgeBlockedPublication(this.executeRaw.bind(this), sourceId, slugs, ownRequest); }
  listPagesForPurgeRewrite(sourceId: string, pageIds: number[]) { return factsPurgeImpl.listPagesForPurgeRewrite(this.executeRaw.bind(this), sourceId, pageIds); }
  updatePageBodyForPurge(sourceId: string, pageId: number, compiled: string, timeline: string, hash: string) { return factsPurgeImpl.updatePageBodyForPurge(this.executeRaw.bind(this), sourceId, pageId, compiled, timeline, hash); }
  setPurgeVersionBody(versionId: number, compiled: string, timeline: string | null) { return factsPurgeImpl.setPurgeVersionBody(this.executeRaw.bind(this), versionId, compiled, timeline); }
  async listPurgeVersionBodies(query: segmentedPurgeWrites.PurgeVersionBodyQuery) { return segmentedPurgeWrites.listPurgeVersionBodies(this, query); }
  redactVersionChangeReasons(sourceId: string, needle: string, reasonNeedle: string) { return factsPurgeImpl.redactVersionChangeReasons(this.executeRaw.bind(this), sourceId, needle, reasonNeedle); }
  listSegmentedVersionsForPurge(sourceId: string, needle: string, pageIds: number[], after: number) { return factsPurgeImpl.listSegmentedVersionsForPurge(this.executeRaw.bind(this), sourceId, needle, pageIds, after); }
  abortPurgedStagings(stagingIds: string[]) { return factsPurgeImpl.abortPurgedStagings(this.executeRaw.bind(this), stagingIds); }
  deletePurgedStagingParts(stagingIds: string[]) { return factsPurgeImpl.deletePurgedStagingParts(this.executeRaw.bind(this), stagingIds); }
  deletePageViewDigests(pageIds: number[]) { return factsPurgeImpl.deletePageViewDigests(this.executeRaw.bind(this), pageIds); }
  deleteUnreferencedPurgedTexts(sourceId: string, replaced: Uint8Array[], claim: string) { return factsPurgeImpl.deleteUnreferencedPurgedTexts(this.executeRaw.bind(this), sourceId, replaced, claim); }
  listPurgeMatchCandidates(sourceId: string, text: string) { return factsPurgeImpl.listPurgeMatchCandidates(this.executeRaw.bind(this), sourceId, text); }
  lockPurgeSource(sourceId: string) { return factsPurgeImpl.lockPurgeSource(this.executeRaw.bind(this), sourceId); }
  insertHoldingPagePurges(sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]) { return factsPurgeImpl.insertHoldingPagePurges(this.executeRaw.bind(this), sourceId, visibility, factHash, requestId, actor, reason, factIds); }
  deletePurgedTakes(takeIds: number[]) { return factsPurgeImpl.deletePurgedTakes(this.executeRaw.bind(this), takeIds); }
  deletePurgeReviewQueue(sourceId: string, refs: string[]) { return factsPurgeImpl.deletePurgeReviewQueue(this.executeRaw.bind(this), sourceId, refs); }
  deletePurgeReviewProposals(sourceId: string, refs: string[]) { return factsPurgeImpl.deletePurgeReviewProposals(this.executeRaw.bind(this), sourceId, refs); }
  deletePurgeDecideProposals(sourceId: string, factIds: number[]) { return factsPurgeImpl.deletePurgeDecideProposals(this.executeRaw.bind(this), sourceId, factIds); }
  deletePurgeTrustProposals(sourceId: string, factIds: number[], takeIds: number[]) { return factsPurgeImpl.deletePurgeTrustProposals(this.executeRaw.bind(this), sourceId, factIds, takeIds); }
  deletePurgeOpenLoops(sourceId: string, factIds: number[]) { return factsPurgeImpl.deletePurgeOpenLoops(this.executeRaw.bind(this), sourceId, factIds); }
  deletePurgeWriteGateHolds(sourceId: string, factHash: string) { return factsPurgeImpl.deletePurgeWriteGateHolds(this.executeRaw.bind(this), sourceId, factHash); }
  deletePurgeWriteGateReceipts(factIds: string[], takeIds: string[], holdIds: string[]) { return factsPurgeImpl.deletePurgeWriteGateReceipts(this.executeRaw.bind(this), factIds, takeIds, holdIds); }
  deletePurgeTakeProposals(sourceId: string, factHash: string) { return factsPurgeImpl.deletePurgeTakeProposals(this.executeRaw.bind(this), sourceId, factHash); }
  blankPurgeCoreEditNotices(sourceId: string, loweredFact: string) { return factsPurgeImpl.blankPurgeCoreEditNotices(this.executeRaw.bind(this), sourceId, loweredFact); }
  deletePurgedFacts(factIds: number[], sourceId: string) { return factsPurgeImpl.deletePurgedFacts(this.executeRaw.bind(this), factIds, sourceId); }
  deletePurgedChunks(pageIds: number[]) { return factsPurgeImpl.deletePurgedChunks(this.executeRaw.bind(this), pageIds); }
  listPurgedPageRevisions(sourceId: string, pageIds: number[]) { return factsPurgeImpl.listPurgedPageRevisions(this.executeRaw.bind(this), sourceId, pageIds); }
  insertPurgeEffects(requestId: string, sourceId: string, data: unknown) { return factsPurgeImpl.insertPurgeEffects(this.executeRaw.bind(this), requestId, sourceId, data); }

  // Facts statements, repair classifiers and loop retirement (engine-sql/facts-repair.ts), through executeRaw as before.
  loopFactDrift(sourceIds: string[], loopId: number | null) { return factsRepairImpl.loopFactDrift(this.executeRaw.bind(this), sourceIds, loopId); }
  closedLoopWithActiveFact(sourceId: string | null, loopId: number) { return factsRepairImpl.closedLoopWithActiveFact(this.executeRaw.bind(this), sourceId, loopId); }
  listSessionFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null) { return factsRepairImpl.listSessionFactsForClassification(this.executeRaw.bind(this), sourceIds, lanes, ids); }
  listSessionFactTwins(ids: number[], lanes: string[]) { return factsRepairImpl.listSessionFactTwins(this.executeRaw.bind(this), ids, lanes); }
  listCapturedFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null) { return factsRepairImpl.listCapturedFactsForClassification(this.executeRaw.bind(this), sourceIds, lanes, ids); }
  countLabelFacts(sourceIds: string[], cap: number, args: factsRepairImpl.LabelFactCountArgs) { return factsRepairImpl.countLabelFacts(this.executeRaw.bind(this), sourceIds, cap, args); }
  listLabelFactCandidates(sourceIds: string[], slug: string | null, args: labelRepairImpl.LabelFactArgs) { return labelRepairImpl.listLabelFactCandidates(this.executeRaw.bind(this), sourceIds, slug, args); }
  listSegmentedLabelPages(sourceIds: string[], args: Omit<labelRepairImpl.LabelFactArgs, 'labelLine'>) { return labelRepairImpl.listSegmentedLabelPages(this.executeRaw.bind(this), sourceIds, args); }
  hasActiveAuditMarker(sourceId: string, slug: string, sources: readonly string[]) { return labelRepairImpl.hasActiveAuditMarker(this.executeRaw.bind(this), sourceId, slug, sources); }
  listRedactedFactCandidates(sourceIds: readonly string[], ids: readonly number[] | null) { return factTextRepair.listRedactedFactCandidates(this, sourceIds, ids); }
  restoreRedactedFactTexts(sourceId: string, restores: readonly factTextRepair.FactTextRestore[], marker: string) { return factTextRepair.restoreRedactedFactTexts(this, sourceId, restores, marker); }
  listProjectedFenceRows(sourceId: string, slug: string, rowNums: readonly number[], texts: readonly string[]) { return factTextRepair.listProjectedFenceRows(this, sourceId, slug, rowNums, texts); }
  listUnexpiredFactIds(ids: readonly number[]) { return factTextRepair.listUnexpiredFactIds(this, ids); }
  lockFactRows(sourceId: string, ids: readonly number[]) { return factTextRepair.lockFactRows(this, sourceId, ids); }
  expireFactWithNote(sourceId: string, id: number, note: string) { return factTextRepair.expireFactWithNote(this, sourceId, id, note); }
  expirePageFactsBySource(sourceId: string, slug: string, sources: readonly string[]) { return factTextRepair.expirePageFactsBySource(this, sourceId, slug, sources); }
  readMaxFactRowNum(sourceId: string, slug: string) { return factTextRepair.readMaxFactRowNum(this, sourceId, slug); }
  listExtractorFactsForClassification(sourceIds: string[], slug: string | null) { return factsRepairImpl.listExtractorFactsForClassification(this.executeRaw.bind(this), sourceIds, slug); }
  listClosedConsolidationTies(sourceIds: string[]) { return factsRepairImpl.listClosedConsolidationTies(this.executeRaw.bind(this), sourceIds); }
  listPagelessEntityFacts(sourceIds: string[]) { return factsRepairImpl.listPagelessEntityFacts(this.executeRaw.bind(this), sourceIds); }
  listOntologyFactCandidates(sourceIds: string[]) { return factsRepairImpl.listOntologyFactCandidates(this.executeRaw.bind(this), sourceIds); }
  listDuplicateFactRows(sourceIds: string[], excludedSources: string[]) { return factsRepairImpl.listDuplicateFactRows(this.executeRaw.bind(this), sourceIds, excludedSources); }
  listFactsOnValidDay(sourceId: string, day: string) { return factsRepairImpl.listFactsOnValidDay(this.executeRaw.bind(this), sourceId, day); }
  readLivePageByPath(sourceId: string, path: string) { return factsRepairImpl.readLivePageByPath(this.executeRaw.bind(this), sourceId, path); }
  listPurgedPageFactCandidates(sourceIds: string[], ids: number[] | null) { return factsRepairImpl.listPurgedPageFactCandidates(this.executeRaw.bind(this), sourceIds, ids); }
  listFactsHomeCandidates(sourceId: string) { return factsRepairImpl.listFactsHomeCandidates(this.executeRaw.bind(this), sourceId); }
  listHeldHomeRows(sourceId: string, days: number) { return factsRepairImpl.listHeldHomeRows(this.executeRaw.bind(this), sourceId, days); }
  listOrphanedFenceRows(sourceId: string) { return factsRepairImpl.listOrphanedFenceRows(this.executeRaw.bind(this), sourceId); }
  readFactSnapshots(sourceId: string, ids: number[], lock: boolean) { return lock ? factsRepairImpl.readFactSnapshots(this.executeRaw.bind(this), sourceId, ids, true) : this.ownRawRead(exec => factsRepairImpl.readFactSnapshots(exec.executeRaw.bind(exec), sourceId, ids, false)); }
  listConceptLineageRows(sourceIds: string[], conceptIds: number[] | null, timeoutMs: number) { return factsRepairImpl.listConceptLineageRows(this.executeRaw.bind(this), sourceIds, conceptIds, timeoutMs); }
  listConceptInputRows(conceptIds: number[], timeoutMs: number) { return factsRepairImpl.listConceptInputRows(this.executeRaw.bind(this), conceptIds, timeoutMs); }
  listNamedVisibilityRows(sourceIds: string[], slugs: string[], timeoutMs: number) { return factsRepairImpl.listNamedVisibilityRows(this.executeRaw.bind(this), sourceIds, slugs, timeoutMs); }
  listAtomLineageRows(sourceIds: string[], ids: number[] | null, timeoutMs: number) { return visibilityScansImpl.listAtomLineageRows(this.executeRaw.bind(this), sourceIds, ids, timeoutMs); }
  listChronicleEventVisibilityRows(sourceIds: string[], ids: number[] | null, timeoutMs: number) { return visibilityScansImpl.listChronicleEventVisibilityRows(this.executeRaw.bind(this), sourceIds, ids, timeoutMs); }
  listAliasOnlyPrivatePages(sourceIds: string[], ids: number[] | null, timeoutMs: number) { return visibilityScansImpl.listAliasOnlyPrivatePages(this.executeRaw.bind(this), sourceIds, ids, timeoutMs); }
  countPurgedPageFacts(sourceIds: string[], cap: number) { return factsRepairImpl.countPurgedPageFacts(this.executeRaw.bind(this), sourceIds, cap); }
  listUnwithdrawnFacts(sourceIds: string[], slug: string | null, fenceKind: string) { return factsRepairImpl.listUnwithdrawnFacts(this.executeRaw.bind(this), sourceIds, slug, fenceKind); }
  listWorldFactsFromPrivateSources(sourceIds: string[], ids: number[] | null) { return factsRepairImpl.listWorldFactsFromPrivateSources(this.executeRaw.bind(this), sourceIds, ids); }
  listActiveSourceIds() { return factsRepairImpl.listActiveSourceIds(this.executeRaw.bind(this)); }
  readRepairBrainId() { return factsRepairImpl.readRepairBrainId(this.executeRaw.bind(this)); }
  listAgentSessionTakeCandidates(sourceIds: string[], ids: number[] | null, noteMark: string) { return factsRepairImpl.listAgentSessionTakeCandidates(this.executeRaw.bind(this), sourceIds, ids, noteMark); }
  listSettledSessionFacts(sourceId: string, ids: number[]) { return factsRepairImpl.listSettledSessionFacts(this.executeRaw.bind(this), sourceId, ids); }
  reattributeSessionFacts(sourceId: string, facts: Array<{ id: number; note: string }>, separator: string) { return factsRepairImpl.reattributeSessionFacts(this.executeRaw.bind(this), sourceId, facts, separator); }
  retireSessionTakes(sourceId: string, takeIds: number[]) { return factsRepairImpl.retireSessionTakes(this.executeRaw.bind(this), sourceId, takeIds); }
  listFenceRewriteRows(sourceId: string, ids: number[]) { return factsRepairImpl.listFenceRewriteRows(this.executeRaw.bind(this), sourceId, ids); }
  listOtherAttributedFactIds(sourceId: string, ids: number[]) { return factsRepairImpl.listOtherAttributedFactIds(this.executeRaw.bind(this), sourceId, ids); }
  listInactiveTakeIds(ids: number[]) { return factsRepairImpl.listInactiveTakeIds(this.executeRaw.bind(this), ids); }
  expireCapturedFacts(sourceId: string, ids: number[], context: string) { return factsRepairImpl.expireCapturedFacts(this.executeRaw.bind(this), sourceId, ids, context); }
  listExpiredFactIds(sourceId: string, ids: number[]) { return factsRepairImpl.listExpiredFactIds(this.executeRaw.bind(this), sourceId, ids); }
  readEntityRehomeState(sourceId: string, fromSlug: string, toSlug: string) { return factsRepairImpl.readEntityRehomeState(this.executeRaw.bind(this), sourceId, fromSlug, toSlug); }
  rehomeEntityFacts(sourceId: string, fromSlug: string, toSlug: string) { return factsRepairImpl.rehomeEntityFacts(this.executeRaw.bind(this), sourceId, fromSlug, toSlug); }
  restoreConsolidationTie(tie: RepairAppliesSql.ConsolidationTieRestore) { return repairAppliesImpl.restoreConsolidationTie(this.executeRaw.bind(this), tie); }
  listLiveDuplicateRows(sourceId: string, factIds: readonly number[], visibility: string, fingerprint: string) { return repairAppliesImpl.listLiveDuplicateRows(this.executeRaw.bind(this), sourceId, factIds, visibility, fingerprint); }
  supersedeDuplicateFacts(sourceId: string, factIds: readonly number[], keptId: number, visibility: string, fingerprint: string) { return repairAppliesImpl.supersedeDuplicateFacts(this.executeRaw.bind(this), sourceId, factIds, keptId, visibility, fingerprint); }
  linkStruckDuplicateFacts(sourceId: string, factIds: readonly number[], keptId: number) { return repairAppliesImpl.linkStruckDuplicateFacts(this.executeRaw.bind(this), sourceId, factIds, keptId); }
  listCommittedRestorePages(sourceIds: readonly string[], slugs: readonly string[], hash: string, requestIds: readonly string[]) { return repairAppliesImpl.listCommittedRestorePages(this.executeRaw.bind(this), sourceIds, slugs, hash, requestIds); }
  listActivePositionedFactIds(factIds: readonly number[]) { return repairAppliesImpl.listActivePositionedFactIds(this.executeRaw.bind(this), factIds); }
  readFactRestorePage(sourceId: string, slug: string) { return repairAppliesImpl.readFactRestorePage(this.executeRaw.bind(this), sourceId, slug); }
  restoreExtractorFact(sourceId: string, id: number, rowNum: number, expiredAt: string) { return repairAppliesImpl.restoreExtractorFact(this.executeRaw.bind(this), sourceId, id, rowNum, expiredAt); }
  moveFactClaimDates(sourceId: string, rows: readonly RepairAppliesSql.ClaimDateMove[]) { return repairAppliesImpl.moveFactClaimDates(this.executeRaw.bind(this), sourceId, rows); }
  lockApprovedFacts(sourceId: string, factIds: readonly number[]) { return repairAppliesImpl.lockApprovedFacts(this.executeRaw.bind(this), sourceId, factIds); }
  expireApprovedFacts(sourceId: string, factIds: readonly number[]) { return repairAppliesImpl.expireApprovedFacts(this.executeRaw.bind(this), sourceId, factIds); }
  tightenDatabaseFactVisibility(sourceId: string, factIds: readonly number[]) { return repairAppliesImpl.tightenDatabaseFactVisibility(this.executeRaw.bind(this), sourceId, factIds); }
  listPageAccessKeys(pageIds: readonly number[]) { return repairAppliesImpl.listPageAccessKeys(this.executeRaw.bind(this), pageIds); }
  listOpenTwinRows(pages: ReadonlyArray<{ source_id: string; slug: string }>, outside: readonly OpenTwinsSql.OpenTwinReader[]) { return openTwinsImpl.listOpenTwinRows(this.executeRaw.bind(this), pages, outside); }
  listOpenFactsWindow(sel: OpenFactsScansSql.OpenFactsSelection, after: number, upper: number | null, classes: readonly string[], limit: number, timeoutMs: number) { return openFactsScansImpl.listOpenFactsWindow(this.executeRaw.bind(this), sel, after, upper, classes, limit, timeoutMs); }
  countOpenFactReasons(sel: OpenFactsScansSql.OpenFactsSelection, timeoutMs: number) { return openFactsScansImpl.countOpenFactReasons(this.executeRaw.bind(this), sel, timeoutMs); }
  listLabelledPages(sourceIds: string[], after: number, ids: number[] | null, timeoutMs: number) { return privateLabelScansImpl.listLabelledPages(this.executeRaw.bind(this), sourceIds, after, ids, timeoutMs); }
  listLiveLabelRows(ids: number[], timeoutMs: number) { return privateLabelScansImpl.listLiveLabelRows(this.executeRaw.bind(this), ids, timeoutMs); }
  listClearDependents(cleared: PrivateLabelScansSql.ClearedLabels, timeoutMs: number) { return privateLabelScansImpl.listClearDependents(this.executeRaw.bind(this), cleared, timeoutMs); }
  listContextualRetrievalModes(ids: number[], timeoutMs: number) { return privateLabelScansImpl.listContextualRetrievalModes(this.executeRaw.bind(this), ids, timeoutMs); }
  listUnembeddedChunkPages(ids: number[], timeoutMs: number) { return privateLabelScansImpl.listUnembeddedChunkPages(this.executeRaw.bind(this), ids, timeoutMs); }
  detachFenceRowFacts(sourceId: string, slug: string, rowNum: number) { return repairAppliesImpl.detachFenceRowFacts(this.executeRaw.bind(this), sourceId, slug, rowNum); }
  hasDatabaseOnlyClaim(sourceId: string, entitySlug: string, fact: string) { return repairAppliesImpl.hasDatabaseOnlyClaim(this.executeRaw.bind(this), sourceId, entitySlug, fact); }
  readSourceCloneRow(sourceId: string) { return repairAppliesImpl.readSourceCloneRow(this.executeRaw.bind(this), sourceId); }

  // Facts statements, search relevance and trust reads (engine-sql/facts-trust.ts), through executeRaw as before.
  private get rawTransaction(): factsTrustImpl.EngineRawTransaction { return fn => this.transaction(tx => fn(tx.executeRaw.bind(tx))); }
  listFactsForRelevance(q: factsTrustImpl.FactRelevanceQuery) { return factsTrustImpl.listFactsForRelevance(this.executeRaw.bind(this), this.rawTransaction, q); }
  countUncomparableFacts(q: factsTrustImpl.UncomparableFactsQuery) { return factsTrustImpl.countUncomparableFacts(this.executeRaw.bind(this), this.rawTransaction, q); }
  matchSavedFacts(q: factsTrustImpl.SavedFactsMatchQuery) { return factsTrustImpl.matchSavedFacts(this.executeRaw.bind(this), q); }
  readEntityNewestFacts(q: factsTrustImpl.EntityNewestFactsQuery) { return factsTrustImpl.readEntityNewestFacts(this.executeRaw.bind(this), q); }
  matchHeadStems(heads: readonly string[], terms: readonly string[]) { return factsTrustImpl.matchHeadStems(this.executeRaw.bind(this), heads, terms); }
  readFactForOwnerAction(id: number) { return factsTrustImpl.readFactForOwnerAction(this.executeRaw.bind(this), id); }
  listStandingPreferences(opts: { sourceId?: string; since?: Date }) { return factsTrustImpl.listStandingPreferences(this.executeRaw.bind(this), opts); }
  listLexicalContestCandidates(opts: Parameters<typeof factsTrustImpl.listLexicalContestCandidates>[1]) { return factsTrustImpl.listLexicalContestCandidates(this.executeRaw.bind(this), opts); }
  listFactsFromQuotedPages(opts: Parameters<typeof factsTrustImpl.listFactsFromQuotedPages>[1]) { return factsTrustImpl.listFactsFromQuotedPages(this.executeRaw.bind(this), opts); }
  listOwnerTierFacts(opts: Parameters<typeof factsTrustImpl.listOwnerTierFacts>[1]) { return factsTrustImpl.listOwnerTierFacts(this.executeRaw.bind(this), opts); }
  listRestatedPrivateCopies(opts: Parameters<typeof factsTrustImpl.listRestatedPrivateCopies>[1]) { return factsTrustImpl.listRestatedPrivateCopies(this.executeRaw.bind(this), opts); }
  countDerivedFactTaint() { return factsTrustImpl.countDerivedFactTaint(this.executeRaw.bind(this)); }
  lowerTrustTier(table: TaintTable, ids: readonly number[], tier: TrustTier, origin: WriteOrigin | null) { return derivationTrustImpl.lowerTrustTier(this.executeRaw.bind(this), table, ids, tier, origin); }
  countDerivedRowTaint(table: derivationTrustImpl.DerivedTaintTable) { return derivationTrustImpl.countDerivedRowTaint(this.executeRaw.bind(this), table); }
  stampPageFrontmatter(stamp: derivationTrustImpl.PageFrontmatterStamp) { return derivationTrustImpl.stampPageFrontmatter(this.executeRaw.bind(this), stamp); }
  readFactEntitySlugById(id: number) { return factsTrustImpl.readFactEntitySlugById(this.executeRaw.bind(this), id); }
  readSupersessionReplacement(newId: number, oldId: number) { return factsTrustImpl.readSupersessionReplacement(this.executeRaw.bind(this), newId, oldId); }
  linkSupersededFact(oldId: number, newId: number) { return factsTrustImpl.linkSupersededFact(this.executeRaw.bind(this), oldId, newId); }
  listLivePageTitles(sourceId: string, slugs: string[]) { return factsTrustImpl.listLivePageTitles(this.executeRaw.bind(this), sourceId, slugs); }
  listPageAliasNames(sourceId: string, slugs: string[]) { return factsTrustImpl.listPageAliasNames(this.executeRaw.bind(this), sourceId, slugs); }
  listCaptureDuplicateCandidates(opts: { sourceId: string; visibilities: string[]; fact: string; attributedTo: string | null; replacingPage: string | null; scanLimit: number }) { return factsTrustImpl.listCaptureDuplicateCandidates(this.executeRaw.bind(this), opts); }
  computeFactFingerprints(texts: string[]) { return factsTrustImpl.computeFactFingerprints(this.executeRaw.bind(this), texts); }
  listClaimConflictPairs(sourceId: string, auditSources: string[], cap: number) { return factsTrustImpl.listClaimConflictPairs(this.executeRaw.bind(this), sourceId, auditSources, cap); }
  countClaimConflictPairs(sourceId: string, auditSources: string[]) { return factsTrustImpl.countClaimConflictPairs(this.executeRaw.bind(this), sourceId, auditSources); }
  listUnarchivedSourceRows() { return factsTrustImpl.listUnarchivedSourceRows(this.executeRaw.bind(this)); }
  listAllUnarchivedSourceIds() { return factsTrustImpl.listAllUnarchivedSourceIds(this.executeRaw.bind(this)); }

  // Facts statements, conversation fact publication and relink (engine-sql/facts-conversation.ts).
  readNewestConversationFactId(sourceId: string, slug: string) { return factsConversationImpl.readNewestConversationFactId(this.executeRaw.bind(this), sourceId, slug); }
  findSpentConversationRequest(principalKind: string, principalId: string, requestId: string, digest: string) { return factsConversationImpl.findSpentConversationRequest(this.executeRaw.bind(this), principalKind, principalId, requestId, digest); }
  listConversationBatchRequests(principalKind: string, principalId: string, sourceId: string, anchorSlug: string) { return factsConversationImpl.listConversationBatchRequests(this.executeRaw.bind(this), principalKind, principalId, sourceId, anchorSlug); }
  readStoredConversationEntry(id: string, generation: string) { return factsConversationImpl.readStoredConversationEntry(this.executeRaw.bind(this), id, generation); }
  readPrincipalCounters(key: string) { return factsConversationImpl.readPrincipalCounters(this.executeRaw.bind(this), key); }
  countConversationPagesToExtract(sourceId: string, pageTypes: string[], force: boolean) { return factsConversationImpl.countConversationPagesToExtract(this.executeRaw.bind(this), sourceId, pageTypes, force); }
  listMergedEntityAliases(sourceId: string, slugs: string[]) { return factsConversationImpl.listMergedEntityAliases(this.executeRaw.bind(this), sourceId, slugs); }
  moveConversationSourceWindows(sourceId: string, slug: string, moves: ReadonlyArray<{ from: string; to: FactsConversationSql.SourceWindow }>) { return factsConversationImpl.moveConversationSourceWindows(this.executeRaw.bind(this), sourceId, slug, moves); }
  stampConversationSourceWindows(pairs: ReadonlyArray<{ id: number; w: FactsConversationSql.SourceWindow | null }>) { return factsConversationImpl.stampConversationSourceWindows(this.executeRaw.bind(this), pairs); }
  countActiveConversationFacts(sourceId: string, slug: string) { return factsConversationImpl.countActiveConversationFacts(this.executeRaw.bind(this), sourceId, slug); }
  readConversationSlotValueHash(sourceId: string, entitySlug: string, dimension: string, validFrom: Date | string) { return factsConversationImpl.readConversationSlotValueHash(this.executeRaw.bind(this), sourceId, entitySlug, dimension, validFrom); }
  deleteConversationOutcomeRows(sourceId: string, slug: string) { return factsConversationImpl.deleteConversationOutcomeRows(this.executeRaw.bind(this), sourceId, slug); }
  listPurgeTombstoneMatches(sourceId: string, claims: { facts: string[]; visibilities: string[]; entitySlugs: Array<string | null>; sources: Array<string | null> }) { return factsConversationImpl.listPurgeTombstoneMatches(this.executeRaw.bind(this), sourceId, claims); }
  maxConversationRowNum(sourceId: string, slug: string) { return factsConversationImpl.maxConversationRowNum(this.executeRaw.bind(this), sourceId, slug); }
  listHeldFactSlots(sourceId: string, slug: string) { return factsConversationImpl.listHeldFactSlots(this.executeRaw.bind(this), sourceId, slug); }
  countPageConversationFacts(sourceId: string, slug: string) { return factsConversationImpl.countPageConversationFacts(this.executeRaw.bind(this), sourceId, slug); }
  countConversationWindowFacts(sourceId: string, slug: string, key: string) { return factsConversationImpl.countConversationWindowFacts(this.executeRaw.bind(this), sourceId, slug, key); }
  countConversationFactsOutsideWindows(sourceId: string, slug: string, keys: readonly string[]) { return factsConversationImpl.countConversationFactsOutsideWindows(this.executeRaw.bind(this), sourceId, slug, keys); }
  clearConversationPageFacts(sourceId: string, slug: string, windows?: { keys: readonly string[]; keep: boolean; unanchored: boolean }) { return factsConversationImpl.clearConversationPageFacts(this.executeRaw.bind(this), sourceId, slug, windows); }
  findSameClaimFenceRow(sourceId: string, slug: string, fact: string, source: string | null) { return factsConversationImpl.findSameClaimFenceRow(this.executeRaw.bind(this), sourceId, slug, fact, source); }
  findOntologyTwin(sourceId: string, slug: string, factId: number) { return factsConversationImpl.findOntologyTwin(this.executeRaw.bind(this), sourceId, slug, factId); }
  readRelinkSource(sourceId: string) { return factsConversationImpl.readRelinkSource(this.executeRaw.bind(this), sourceId); }
  factRelinkAttemptsTableExists() { return factsConversationImpl.factRelinkAttemptsTableExists(this.executeRaw.bind(this)); }
  readReextractOutcomeRow(sourceId: string, slug: string) { return factsConversationImpl.readReextractOutcomeRow(this.executeRaw.bind(this), sourceId, slug); }
  listUnbackedConversationRows(sourceId: string, slugs: string[]) { return factsConversationImpl.listUnbackedConversationRows(this.executeRaw.bind(this), sourceId, slugs); }
  listUnlinkedConversationRows(sourceId: string, slugs: string[]) { return factsConversationImpl.listUnlinkedConversationRows(this.executeRaw.bind(this), sourceId, slugs); }
  listEntityHintPages(sourceId: string, slugs: string[]) { return factsConversationImpl.listEntityHintPages(this.executeRaw.bind(this), sourceId, slugs); }
  lockPageById(pageId: number) { return factsConversationImpl.lockPageById(this.executeRaw.bind(this), pageId); }
  listClearedRelinkedFacts(sourceId: string, slug: string) { return factsConversationImpl.listClearedRelinkedFacts(this.executeRaw.bind(this), sourceId, slug); }
  countEmbeddedFactsAmong(sourceId: string, ids: number[]) { return factsConversationImpl.countEmbeddedFactsAmong(this.executeRaw.bind(this), sourceId, ids); }
  // Facts statements, write path and recall pool reads (engine-sql/facts-trust.ts, facts-recall.ts)
  readPendingWriteReceipt(principalKind: string, principalId: string, requestId: string) { return factsTrustImpl.readPendingWriteReceipt(this.executeRaw.bind(this), principalKind, principalId, requestId); }
  lockSourceShared(sourceId: string) { return factsTrustImpl.lockSourceShared(this.executeRaw.bind(this), sourceId); }
  listOversizedStaleFacts(opts: { sourceId?: string; model: string; dims: number; maxTokens: number }) { return factsTrustImpl.listOversizedStaleFacts(this.executeRaw.bind(this), opts); }
  listLivePersonTitles(sourceId: string, slugs: string[]) { return factsTrustImpl.listLivePersonTitles(this.executeRaw.bind(this), sourceId, slugs); }
  readLiveFactEntityPage(sourceId: string, slug: string, excludePrivate?: boolean) { return factsTrustImpl.readLiveFactEntityPage(this.executeRaw.bind(this), sourceId, slug, excludePrivate); }
  lockAgentWritebackSetting(key: string) { return factsTrustImpl.lockAgentWritebackSetting(this.executeRaw.bind(this), key); }
  listFactsToRetireFromPage(sourceId: string, session: string, slug: string, pattern: string) { return factsTrustImpl.listFactsToRetireFromPage(this.executeRaw.bind(this), sourceId, session, slug, pattern); }
  listContestedProposalPairs(ids: number[], policy: factsTrustImpl.ContestedReadPolicy) { return factsTrustImpl.listContestedProposalPairs(this.executeRaw.bind(this), ids, policy); }
  recordDerivationEdges(derived: factsTrustImpl.DerivationEdgeRef, sourceId: string | null, edges: readonly factsTrustImpl.DerivationEdgeRef[]) { return factsTrustImpl.recordDerivationEdges(this.executeRaw.bind(this), derived, sourceId, edges); }
  expireDerivedFacts(ids: number[], sourceId: string) { return factsTrustImpl.expireDerivedFacts(this.executeRaw.bind(this), ids, sourceId); }
  deactivateDerivedTakes(ids: number[], sourceId: string) { return factsTrustImpl.deactivateDerivedTakes(this.executeRaw.bind(this), ids, sourceId); }
  softDeleteDerivedPages(ids: number[], sourceId: string) { return factsTrustImpl.softDeleteDerivedPages(this.executeRaw.bind(this), ids, sourceId); }
  markNeedsRederive(table: string, ids: string[], sourceId: string, requestId: string | null, reason: string, hiddenNow: string[]) { return factsTrustImpl.markNeedsRederive(this.executeRaw.bind(this), table, ids, sourceId, requestId, reason, hiddenNow); }
  readMemberPageWithdrawal(q: factsTrustImpl.MemberPageWithdrawalQuery) { return factsTrustImpl.readMemberPageWithdrawal(this.executeRaw.bind(this), q); }
  readClaimWithdrawal(q: factsTrustImpl.ClaimWithdrawalQuery) { return factsTrustImpl.readClaimWithdrawal(this.executeRaw.bind(this), q); }
  readFactVisibility(id: number, sourceId: string) { return factsTrustImpl.readFactVisibility(this.executeRaw.bind(this), id, sourceId); }
  readReplacementTarget(q: factsTrustImpl.ReplacementTargetQuery) { return factsTrustImpl.readReplacementTarget(this.executeRaw.bind(this), q); }
  readPairFactRow(id: number, lock?: boolean) { return factsTrustImpl.readPairFactRow(this.executeRaw.bind(this), id, lock); }
  expireSupersededFact(q: { oldId: number; sourceId: string; newId: number; until: string | null }) { return factsTrustImpl.expireSupersededFact(this.executeRaw.bind(this), q); }
  retireSupersededFact(q: { oldId: number | string; sourceId: string; newId: number; until: Date | null }) { return factsTrustImpl.retireSupersededFact(this.executeRaw.bind(this), q); }
  restoreSupersededFact(q: { oldId: number; sourceId: string; expiredAt: string | null; validUntil: string | null; supersededBy: number | null; expectedSupersededBy: number | null }) { return factsTrustImpl.restoreSupersededFact(this.executeRaw.bind(this), q); }
  readFactForForget(id: number) { return factsTrustImpl.readFactForForget(this.executeRaw.bind(this), id); }
  expireFactSuperseded(factId: number, validUntil: string | null) { return factsTrustImpl.expireFactSuperseded(this.executeRaw.bind(this), factId, validUntil); }
  expireFactAtDate(factId: number, today: string) { return factsTrustImpl.expireFactAtDate(this.executeRaw.bind(this), factId, today); }
  readWithdrawalAnchor(factId: number, sourceId: string) { return factsTrustImpl.readWithdrawalAnchor(this.executeRaw.bind(this), factId, sourceId); }
  readFactActivity(id: number, sourceId: string) { return factsTrustImpl.readFactActivity(this.executeRaw.bind(this), id, sourceId); }
  readReviewAcceptedMark(id: number, sourceId: string, mark: string) { return factsTrustImpl.readReviewAcceptedMark(this.executeRaw.bind(this), id, sourceId, mark); }
  readFactsFtsIndexState(name: string) { return factsTrustImpl.readFactsFtsIndexState(this.executeRaw.bind(this), name); }
  swapFactsFtsIndex() { return factsTrustImpl.swapFactsFtsIndex(this.executeRaw.bind(this)); }
  readFactsEmbeddingColumn() { return factsRecallImpl.readFactsEmbeddingColumn(this.executeRaw.bind(this)); }
  listNearestFacts(q: factsRecallImpl.NearestFactsQuery) { return factsRecallImpl.listNearestFacts(this.executeRaw.bind(this), this.rawTransaction, q); }
  listFactSourcePages(ids: readonly number[]) { return factsRecallImpl.listFactSourcePages(this.executeRaw.bind(this), ids); }
  listSlotRows(scope: factsTrustImpl.FactPoolScope, slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>) { return factsRecallImpl.listSlotRows(this.executeRaw.bind(this), scope, slots); }
  listPoolUnbackedKeys(scope: factsTrustImpl.FactPoolScope, keys: readonly string[], limit: number) { return factsRecallImpl.listPoolUnbackedKeys(this.executeRaw.bind(this), scope, keys, limit); }
  listCallOffCueFacts(scope: factsTrustImpl.FactPoolScope, pairs: ReadonlyArray<{ source_id: string; entity_slug: string }>) { return factsRecallImpl.listCallOffCueFacts(this.executeRaw.bind(this), scope, pairs); }
  listPoolEntityPairs(scope: factsTrustImpl.FactPoolScope, filters: factsTrustImpl.FactPoolFilters) { return factsRecallImpl.listPoolEntityPairs(this.executeRaw.bind(this), scope, filters); }
  listFactRowsByIds(sourceIds: readonly string[], ids: readonly number[]) { return factsRecallImpl.listFactRowsByIds(this.executeRaw.bind(this), sourceIds, ids); }
  listOntologyStreamSlugs(sourceId: string, entitySlug: string, dimension: string) { return factsTrustImpl.listOntologyStreamSlugs(this.executeRaw.bind(this), sourceId, entitySlug, dimension); }
  readOntologyRival(sourceId: string, entitySlug: string, dimension: string, excludeId: number) { return factsTrustImpl.readOntologyRival(this.executeRaw.bind(this), sourceId, entitySlug, dimension, excludeId); }
  listBeliefStreamSlugs(table: 'facts' | 'takes' | 'pages', ids: readonly number[]) { return factsTrustImpl.listBeliefStreamSlugs(this.executeRaw.bind(this), table, ids); }
  listReadablePageSlugs(sourceId: string, slugs: readonly string[], scope: PageReadScope, limit: number) { return factsRecallImpl.listReadablePageSlugs(this.executeRaw.bind(this), sourceId, slugs, scope, limit); }


  getSourceStrictness(sourceId: string) { return this.preparationRead(exec => persistenceStateImpl.getSourceStrictness(unscopedExecutor(exec, 'persistence: strict-source read ran unscoped through executeRaw'), sourceId)); }
  readPersistenceBrainId() { return this.preparationRead(exec => persistenceStateImpl.readPersistenceBrainId(unscopedExecutor(exec, 'persistence: brain identity read ran unscoped through executeRaw'))); }
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }) { return persistenceDeclarationImpl.declarePersistence(this, opts?.durable); }
  requireSynchronousCommit() { return persistenceDeclarationImpl.requireSynchronousCommit(this); }
  readLocalWriterRow(id: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => persistenceStateImpl.readLocalWriterRow(unscopedExecutor(exec, 'persistence: local writer read ran unscoped through executeRaw'), id, opts), opts?.lock); }
  readOAuthClientReceiptGrant(clientId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => accessGrantsImpl.readOAuthClientReceiptGrant(unscopedExecutor(exec, 'access grants: a receipt client grant read ran unscoped through executeRaw'), clientId, opts), opts?.lock); }
  readAccessTokenReceiptGrant(tokenId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => accessGrantsImpl.readAccessTokenReceiptGrant(unscopedExecutor(exec, 'access grants: a receipt token grant read ran unscoped through executeRaw'), tokenId, opts), opts?.lock); }
  readOAuthClientMemberGrant(clientId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => accessGrantsImpl.readOAuthClientMemberGrant(unscopedExecutor(exec, 'access grants: a member client grant read ran unscoped through executeRaw'), clientId, opts), true); }
  readAccessTokenMemberGrant(tokenId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => accessGrantsImpl.readAccessTokenMemberGrant(unscopedExecutor(exec, 'access grants: a member token grant read ran unscoped through executeRaw'), tokenId, opts), true); }
  readLocalWriterMemberGrant(id: string) { return this.preparationRead(exec => accessGrantsImpl.readLocalWriterMemberGrant(unscopedExecutor(exec, 'access grants: a member local writer grant read ran unscoped through executeRaw'), id), true); }
  readSharedSkillServingEpoch() { return this.preparationRead(exec => accessGrantsImpl.readSharedSkillServingEpoch(unscopedExecutor(exec, 'access grants: the serving epoch read ran unscoped through executeRaw'))); }
  // Shared-skill membership (engine-sql/shared-skill-members.ts)
  readSharedSkillCatalogIdentity() { return sharedSkillMembersImpl.readSharedSkillCatalogIdentity(this.autocommitSql); }
  listSharedSkillCatalogHeads(q: SharedSkillMembersSql.SharedSkillHeadQuery) { return sharedSkillMembersImpl.listSharedSkillCatalogHeads(this.engineSql, q); }
  readSharedSkillPolicyRow(sourceId: string, incarnation: string, lock: boolean) { return sharedSkillMembersImpl.readSharedSkillPolicyRow(this.engineSql, sourceId, incarnation, lock); }
  writeSharedSkillPolicy(w: SharedSkillMembersSql.SharedSkillPolicyWrite) { return sharedSkillMembersImpl.writeSharedSkillPolicy(this.autocommitSql, w); }
  writeSharedSkillRevision(w: SharedSkillMembersSql.SharedSkillRevisionWrite) { return sharedSkillMembersImpl.writeSharedSkillRevision(this.autocommitSql, w); }
  readSharedSkillRevision(k: SharedSkillMembersSql.SharedSkillRevisionKey) { return sharedSkillMembersImpl.readSharedSkillRevision(this.engineSql, k); }
  listSharedSkillFollowSources(allowed: string[] | null, sourceIds: string[] | null) { return sharedSkillMembersImpl.listSharedSkillFollowSources(this.engineSql, allowed, sourceIds); }
  lockSharedSkillBrainId() { return sharedSkillMembersImpl.lockSharedSkillBrainId(this.engineSql); }
  readSharedSkillMember(by: SharedSkillMembersSql.SharedSkillMemberLookup) { return sharedSkillMembersImpl.readSharedSkillMember(this.engineSql, by); }
  countSharedSkillMembers() { return sharedSkillMembersImpl.countSharedSkillMembers(this.engineSql); }
  listSharedMemberMigrationRows(sourceId: string) { return sharedSkillMembersImpl.listSharedMemberMigrationRows(this, sourceId); }
  enrollSharedSkillMember(spec: SharedSkillMembersSql.SharedSkillMemberEnroll) { return sharedSkillMembersImpl.enrollSharedSkillMember(this.autocommitSql, spec); }
  rebindSharedSkillMember(installationId: string, followPolicy: unknown, epoch: number) { return sharedSkillMembersImpl.rebindSharedSkillMember(this.autocommitSql, installationId, followPolicy, epoch); }
  leaveSharedSkillMember(installationId: string) { return sharedSkillMembersImpl.leaveSharedSkillMember(this.autocommitSql, installationId); }
  issueSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchIssue) { return sharedSkillMembersImpl.issueSharedSkillDeliveryBatch(this.autocommitSql, spec); }
  readSharedSkillDeliveryBatch(token: string, installationId: string, epoch: number) { return sharedSkillMembersImpl.readSharedSkillDeliveryBatch(this.engineSql, token, installationId, epoch); }
  acknowledgeSharedSkillDeliveryBatch(spec: SharedSkillMembersSql.SharedSkillBatchAcknowledge) { return sharedSkillMembersImpl.acknowledgeSharedSkillDeliveryBatch(this.autocommitSql, spec); }
  insertLocalWriterRow(row: persistenceStateImpl.LocalWriterInsert) { return persistenceStateImpl.insertLocalWriterRow(this.autocommitSql, row); }
  revokeLocalWriterRow(id: string) { return persistenceStateImpl.revokeLocalWriterRow(this.autocommitSql, id); }
  readJournalLimitRows() { return this.preparationRead(exec => persistenceJournalImpl.readJournalLimitRows(unscopedExecutor(exec, 'persistence: journal limit read ran unscoped through executeRaw'))); }
  readHeldPageRows<R = Record<string, unknown>>(pageIds: string[]) { return this.preparationRead(exec => persistenceJournalImpl.readHeldPageRows<R>(unscopedExecutor(exec, 'persistence: hold read ran unscoped through executeRaw'), pageIds)); }
  readHeldHitRows<R = Record<string, unknown>>(query: persistenceJournalImpl.HeldHitQuery) { return this.preparationRead(exec => persistenceJournalImpl.readHeldHitRows<R>(unscopedExecutor(exec, 'persistence: held hit read ran unscoped through executeRaw'), query)); }
  readHeldCoverageRows(sourceIds: string[] | null) { return this.preparationRead(exec => persistenceJournalImpl.readHeldCoverageRows(unscopedExecutor(exec, 'persistence: hold summary read ran unscoped through executeRaw'), sourceIds)); }
  listFenceHoldRows(sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string) { return fenceHoldsImpl.listFenceHoldRows(this.executeRaw.bind(this), sourceIds, kinds, ownerKey); }
  readFenceOriginGone(sourceId: string, slug: string) { return fenceHoldsImpl.readFenceOriginGone(this.executeRaw.bind(this), sourceId, slug); }
  lockGenerationKey(lockKey: string) { return fenceHoldsImpl.lockGenerationKey(this.executeRaw.bind(this), lockKey); }
  clearFenceHoldRows(key: fenceHoldsImpl.FenceHoldKey) { return fenceHoldsImpl.clearFenceHoldRows(this.executeRaw.bind(this), key); }
  readFenceHoldFiles(sourceIds: readonly string[], slugs: readonly string[]) { return fenceHoldsImpl.readFenceHoldFiles(this.executeRaw.bind(this), sourceIds, slugs); }
  readLiveGenerationRow(key: generationsImpl.GenerationRowKey) { return generationsImpl.readLiveGenerationRow(this.executeRaw.bind(this), key); }
  activateGenerationRows(key: generationsImpl.GenerationRowKey, liveId: number | null, row: generationsImpl.GenerationActivationRow, items: readonly generationsImpl.GenerationLedgerRow[]) { return generationsImpl.activateGenerationRows(this.executeRaw.bind(this), key, liveId, row, items); }
  recordHeldGenerationRow(key: generationsImpl.GenerationRowKey, row: generationsImpl.HeldGenerationRow) { return generationsImpl.recordHeldGenerationRow(this.executeRaw.bind(this), key, row); }
  readGitHoldRecords<R = Record<string, unknown>>(opts?: GitHoldRecordsQuery) { return syncHoldReadsImpl.readGitHoldRecords<R>(this, opts); }
  readGitHoldRetryRequest(fingerprint: string) { return syncHoldReadsImpl.readGitHoldRetryRequest(this, fingerprint); }
  readGitHoldReportInputs(sourceId: string, fingerprint: string) { return syncHoldReadsImpl.readGitHoldReportInputs(this, sourceId, fingerprint); }
  readSourcePurgeEpoch(sourceId: string) { return syncReasonReadsImpl.readSourcePurgeEpoch(this, sourceId); }
  lockGitHoldSummary(sourceId: string, incarnation: string) { return syncHoldStoreImpl.lockGitHoldSummary(this, sourceId, incarnation); }
  adjustGitHoldSummary(sourceId: string, incarnation: string, delta: number, weights: GitHoldSummaryWeights) { return syncHoldStoreImpl.adjustGitHoldSummary(this, sourceId, incarnation, delta, weights); }
  readGitHoldRow<R = Record<string, unknown>>(sourceId: string, incarnation: string, path: string) { return syncHoldStoreImpl.readGitHoldRow<R>(this, sourceId, incarnation, path); }
  writeGitHoldRow(sourceId: string, incarnation: string, path: string, record: object) { return syncHoldStoreImpl.writeGitHoldRow(this, sourceId, incarnation, path, record); }
  replaceGitHoldRow(sourceId: string, incarnation: string, path: string, expected: object, next: object) { return syncHoldStoreImpl.replaceGitHoldRow(this, sourceId, incarnation, path, expected, next); }
  deleteGitHoldRow(sourceId: string, incarnation: string, path: string) { return syncHoldStoreImpl.deleteGitHoldRow(this, sourceId, incarnation, path); }
  countGitHolds(sourceId: string, incarnation: string) { return syncHoldStoreImpl.countGitHolds(this, sourceId, incarnation); }
  readGitHoldListingRows<R = Record<string, unknown>>(sourceIds: readonly string[], limit: number) { return syncHoldStoreImpl.readGitHoldListingRows<R>(this, sourceIds, limit); }
  readGitHoldCodeCountRows(sourceIds: readonly string[]) { return syncHoldStoreImpl.readGitHoldCodeCountRows(this, sourceIds); }
  readGitImageHoldCountRows(sourceIds: readonly string[]) { return syncHoldStoreImpl.readGitImageHoldCountRows(this, sourceIds); }
  readSyncConversionRows<C = Record<string, unknown>>(sourceIds: readonly string[]) { return syncHoldStoreImpl.readSyncConversionRows<C>(this, sourceIds); }
  recordSyncConversion(sourceId: string, incarnation: string, conversion: syncHoldStoreImpl.SyncConversion) { return syncHoldStoreImpl.recordSyncConversion(this, sourceId, incarnation, conversion); }
  readSyncPassRow<V = Record<string, unknown>>(sourceId: string, incarnation: string) { return syncHoldStoreImpl.readSyncPassRow<V>(this, sourceId, incarnation); }
  readLiveSyncPassRows<V = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncHoldStoreImpl.readLiveSyncPassRows<V>(this, sourceIds); }
  writeSyncPassRow(sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts?: SyncPassRowWrite) { return syncHoldStoreImpl.writeSyncPassRow(this, sourceId, incarnation, value, opts); }
  readSyncStatusSourceRow<P = Record<string, unknown>, W = Record<string, unknown>, F = Record<string, unknown>>(sourceId: string) { return syncStatusReadsImpl.readSyncStatusSourceRow<P, W, F>(this, sourceId); }
  readSyncStatusCommittedRow(sourceId: string) { return syncStatusReadsImpl.readSyncStatusCommittedRow(this, sourceId); }
  readManagedSyncCursorHeader<H = Record<string, unknown>>(sourceId: string, incarnation: string, failedKey: string) { return syncStatusReadsImpl.readManagedSyncCursorHeader<H>(this, sourceId, incarnation, failedKey); }
  readRetiredManagedSyncCursor(sourceId: string, incarnation: string) { return syncStatusReadsImpl.readRetiredManagedSyncCursor(this, sourceId, incarnation); }
  readManagedSyncFailureRows<V = Record<string, unknown>, R = Record<string, unknown>, F = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readManagedSyncFailureRows<V, R, F>(this, sourceIds); }
  readOrphanedManagedSyncFailureRows<F = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readOrphanedManagedSyncFailureRows<F>(this, sourceIds); }
  listFreshnessTargets(worktreeId: string, incarnation: string, windowHours: number, limit: number) { return syncStatusReadsImpl.listFreshnessTargets(this, worktreeId, incarnation, windowHours, limit); }
  readSyncHeadRequestRow(sourceId: string, opts?: SyncStatusProbeOptions) { return syncStatusReadsImpl.readSyncHeadRequestRow(this, sourceId, opts); }
  readSyncRecoveryProbeRow(sourceId: string, opts?: SyncStatusProbeOptions) { return syncStatusReadsImpl.readSyncRecoveryProbeRow(this, sourceId, opts); }
  readIdentityDowngradeRows<D = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readIdentityDowngradeRows<D>(this, sourceIds); }
  readIdentityDowngradeOldPage(sourceId: string, path: string, slug: string) { return syncStatusReadsImpl.readIdentityDowngradeOldPage(this, sourceId, path, slug); }
  countIdentityDowngradeCarry(sourceId: string, slug: string, pageId: number) { return syncStatusReadsImpl.countIdentityDowngradeCarry(this, sourceId, slug, pageId); }
  readIdentityRemedySide(sourceId: string, by: { pageId: number } | { slug: string }) { return syncStatusReadsImpl.readIdentityRemedySide(this, sourceId, by); }
  readWriteWatermarkRow(sourceId: string) { return appliedWatermarkReadsImpl.readWriteWatermarkRow(this, sourceId); }
  readSourceMovementRows(binding: { source_id: string; worktree_id: string; source_incarnation: string }) { return appliedWatermarkReadsImpl.readSourceMovementRows(this, binding); }
  readLiveSyncJobId(sourceId: string) { return appliedWatermarkReadsImpl.readLiveSyncJobId(this, sourceId); }
  readSourceCheckoutRoot(sourceId: string, hostId: string | null) { return appliedWatermarkReadsImpl.readSourceCheckoutRoot(this, sourceId, hostId); }
  readUnembeddedPageSummary(sourceId: string, column: string) { return appliedWatermarkReadsImpl.readUnembeddedPageSummary(this, sourceId, column); }
  heldGenerationRowsForInput(key: generationsImpl.GenerationRowKey, pin: string) { return generationsImpl.heldGenerationRowsForInput(this.executeRaw.bind(this), key, pin); }
  readHeldGenerationContext(key: generationsImpl.GenerationRowKey, holdId: string) { return generationsImpl.readHeldGenerationContext(this.executeRaw.bind(this), key, holdId); }
  liveGenerationForOperation(operationId: string) { return generationsImpl.liveGenerationForOperation(this.executeRaw.bind(this), operationId); }
  countGenerationAttempt(key: generationsImpl.GenerationRowKey, holdId: string, code: string) { return generationsImpl.countGenerationAttempt(this.executeRaw.bind(this), key, holdId, code); }
  clearGenerationAttempts(holdId: string) { return generationsImpl.clearGenerationAttempts(this.executeRaw.bind(this), holdId); }
  readGenerationRestored(key: generationsImpl.GenerationRowKey) { return generationsImpl.readGenerationRestored(this.executeRaw.bind(this), key); }
  clearTieHeldGenerationRows(sourceId: string, kind: string, ownerPrefix: string) { return generationsImpl.clearTieHeldGenerationRows(this.executeRaw.bind(this), sourceId, kind, ownerPrefix); }
  readGenerationValve(key: generationsImpl.GenerationRowKey, windowKey: string) { return generationsImpl.readGenerationValve(this.executeRaw.bind(this), key, windowKey); }
  bumpGenerationValve(key: generationsImpl.GenerationRowKey, windowKey: string, retired: number) { return generationsImpl.bumpGenerationValve(this.executeRaw.bind(this), key, windowKey, retired); }
  scrubGenerationPageRows(sourceId: string, fenceKinds: readonly string[], slug: string) { return generationLedgerImpl.scrubGenerationPageRows(this.executeRaw.bind(this), sourceId, fenceKinds, slug); }
  scrubGenerationTextRows(sourceId: string, needles: readonly string[]) { return generationLedgerImpl.scrubGenerationTextRows(this.executeRaw.bind(this), sourceId, needles); }
  recordGenerationActivation(key: generationsImpl.GenerationRowKey, row: generationActivationsImpl.GenerationActivationRecord) { return generationActivationsImpl.recordGenerationActivation(this.executeRaw.bind(this), key, row); }
  markGenerationActivated(activationId: string, generationId: number) { return generationActivationsImpl.markGenerationActivated(this.executeRaw.bind(this), activationId, generationId); }
  readGenerationActivationState(activationId: string, slug: string, sourceId: string) { return generationActivationsImpl.readGenerationActivationState(this.executeRaw.bind(this), activationId, slug, sourceId); }
  settleGenerationMember(activationId: string, slug: string) { return generationActivationsImpl.settleGenerationMember(this.executeRaw.bind(this), activationId, slug); }
  listPendingGenerationMembers(sourceIds: readonly string[], kind: string | null) { return generationActivationsImpl.listPendingGenerationMembers(this.executeRaw.bind(this), sourceIds, kind); }
  listGenerationOrphanCandidates(sourceIds: readonly string[], kind: string | null) { return generationActivationsImpl.listGenerationOrphanCandidates(this.executeRaw.bind(this), sourceIds, kind); }
  readGenerationItemsByIds(generationIds: readonly number[]) { return generationRepairImpl.readGenerationItemsByIds(this.executeRaw.bind(this), generationIds); }
  listUnmatchedGenerationRows(sourceIds: readonly string[], kind: string, filter: generationRepairImpl.GenerationRepairFilter) { return generationRepairImpl.listUnmatchedGenerationRows(this.executeRaw.bind(this), sourceIds, kind, filter); }
  listRestorableGenerationRows(sourceIds: readonly string[], kind: string, filter: generationRepairImpl.GenerationRepairFilter) { return generationRepairImpl.listRestorableGenerationRows(this.executeRaw.bind(this), sourceIds, kind, filter); }
  listHeldGenerationRows(sourceIds: readonly string[], kind: string, filter: generationRepairImpl.GenerationRepairFilter) { return generationRepairImpl.listHeldGenerationRows(this.executeRaw.bind(this), sourceIds, kind, filter); }
  readHeldGenerationProposal(id: number) { return generationRepairImpl.readHeldGenerationProposal(this.executeRaw.bind(this), id); }
  listGenerationSourceIncarnations(sourceIds: readonly string[]) { return generationRepairImpl.listGenerationSourceIncarnations(this.executeRaw.bind(this), sourceIds); }
  listRecordedFenceItemKeys(key: generationsImpl.GenerationRowKey, itemKeys: readonly string[]) { return generationFenceEvidenceImpl.listRecordedFenceItemKeys(this.executeRaw.bind(this), key, itemKeys); }
  hasBodylessPageVersion(sourceId: string, slug: string) { return generationFenceEvidenceImpl.hasBodylessPageVersion(this.executeRaw.bind(this), sourceId, slug); }
  listFenceVersionBodies(sourceId: string, slug: string, before: number | null, limit: number) { return generationFenceEvidenceImpl.listFenceVersionBodies(this.executeRaw.bind(this), sourceId, slug, before, limit); }
  moveKeptFactRows(sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]) { return generationFenceEvidenceImpl.moveKeptFactRows(this.executeRaw.bind(this), sourceId, slug, ids, claimed); }
  readChronicleDepthRow(sourceId: string, slug: string) { return chronicleEventsImpl.readChronicleDepthRow(this.executeRaw.bind(this), sourceId, slug); }
  listChronicleOwnedHashes(sourceId: string, pageId: number) { return chronicleEventsImpl.listChronicleOwnedHashes(this.executeRaw.bind(this), sourceId, pageId); }
  listRetiredGenerationItemKeys(sourceId: string, kind: string, itemKeys: readonly string[]) { return chronicleEventsImpl.listRetiredGenerationItemKeys(this.executeRaw.bind(this), sourceId, kind, itemKeys); }
  listEventProjectionRows(eventPageIds: readonly number[]) { return chronicleEventsImpl.listEventProjectionRows(this.executeRaw.bind(this), eventPageIds); }
  listPageContentHashes(query: chronicleEventsImpl.PageContentHashQuery) { return chronicleEventsImpl.listPageContentHashes(this.executeRaw.bind(this), query); }
  listLiveGenerationItems(key: generationsImpl.GenerationRowKey) { return chronicleEventsImpl.listLiveGenerationItems(this.executeRaw.bind(this), key); }
  readEventProjectionId(eventPageId: number, date: string) { return chronicleEventsImpl.readEventProjectionId(this.executeRaw.bind(this), eventPageId, date); }
  pageSlugExists(sourceId: string, slug: string) { return chronicleEventsImpl.pageSlugExists(this.executeRaw.bind(this), sourceId, slug); }
  deleteEventProjections(sourceId: string, slugs: readonly string[]) { return chronicleEventsImpl.deleteEventProjections(this.executeRaw.bind(this), sourceId, slugs); }
  restoreEventProjection(row: chronicleEventsImpl.EventProjectionRestore) { return chronicleEventsImpl.restoreEventProjection(this.executeRaw.bind(this), row); }
  hasChronicleSkipDecision(decision: chronicleEventsImpl.ChronicleSkipDecision) { return chronicleEventsImpl.hasChronicleSkipDecision(this.executeRaw.bind(this), decision); }
  listOrphanedChronicleOwners(sourceId: string, kind: string, limit: number) { return chronicleEventsImpl.listOrphanedChronicleOwners(this.executeRaw.bind(this), sourceId, kind, limit); }
  listChronicleEventSlotRows(sourceId: string, slugs: readonly string[]) { return chronicleEventsImpl.listChronicleEventSlotRows(this.executeRaw.bind(this), sourceId, slugs); }
  listChronicleCoverageGapRows() { return chronicleEventsImpl.listChronicleCoverageGapRows(this.executeRaw.bind(this)); }
  readGenerationFenceBlocks(generationIds: readonly number[]) { return generationFenceRestoreImpl.readGenerationFenceBlocks(this.executeRaw.bind(this), generationIds); }
  listOwnedGenerationItems(generationIds: readonly number[]) { return generationFenceRestoreImpl.listOwnedGenerationItems(this.executeRaw.bind(this), generationIds); }
  readLiveGenerationId(key: generationsImpl.GenerationRowKey) { return generationFenceRestoreImpl.readLiveGenerationId(this.executeRaw.bind(this), key); }
  readGenerationPageRows(query: generationPageRowsImpl.GenerationPageRowsQuery) { return generationPageRowsImpl.readGenerationPageRows(this.executeRaw.bind(this), query); }
  readAtomOriginInput(sourceId: string, slug: string) { return generationAtomReadsImpl.readAtomOriginInput(this.executeRaw.bind(this), sourceId, slug); }
  listProducerVersionRows(sourceId: string, slugs: readonly string[], producer: generationAtomReadsImpl.GenerationVersionProducer) { return generationAtomReadsImpl.listProducerVersionRows(this.executeRaw.bind(this), sourceId, slugs, producer); }
  listAtomWriteReceipts(sourceId: string, slugs: readonly string[]) { return generationAtomReadsImpl.listAtomWriteReceipts(this.executeRaw.bind(this), sourceId, slugs); }
  readWriteRequest(principalKind: string, principalId: string, requestId: string) { return this.preparationRead(exec => persistenceJournalImpl.readWriteRequest(unscopedExecutor(exec, 'persistence: request read ran unscoped through executeRaw'), principalKind, principalId, requestId)); }
  readWriteRequestsByRequestIds(principalKind: string, principalId: string, requestIds: readonly string[]) { return persistenceJournalImpl.readWriteRequestsByRequestIds(unscopedExecutor(this.engineSql, 'persistence: grouped request read ran unscoped through the transaction executeRaw'), principalKind, principalId, requestIds); }
  readWriteRequestsByRequestId(requestId: string) { return this.preparationRead(exec => persistenceJournalImpl.readWriteRequestsByRequestId(unscopedExecutor(exec, 'persistence: request read ran unscoped through executeRaw'), requestId)); }
  readWriteRequestById(id: string, opts?: { signal?: AbortSignal }) { return this.preparationRead(exec => persistenceJournalImpl.readWriteRequestById(unscopedExecutor(exec, 'persistence: request read ran unscoped through executeRaw'), id, opts)); }
  listWriteRequestsByRequestIds(requestIds: readonly string[]) { return this.preparationRead(exec => persistenceJournalImpl.listWriteRequestsByRequestIds(unscopedExecutor(exec, 'persistence: request read ran unscoped through executeRaw'), requestIds)); }
  listWriteRequestRows(principalKind: string, principalId: string, sourceId: string, filter: persistenceJournalImpl.WriteRequestListFilter) { return persistenceJournalImpl.listWriteRequestRows(unscopedExecutor(this.engineSql, 'persistence: receipt list ran unscoped through executeRaw'), principalKind, principalId, sourceId, filter); }
  readWriteRequestProgress(id: string, opts?: { signal?: AbortSignal }) { return this.preparationRead(exec => persistenceJournalImpl.readWriteRequestProgress(unscopedExecutor(exec, 'persistence: request progress read ran unscoped through executeRaw'), id, opts)); }
  readCounterRows(keys: readonly string[]) { return this.preparationRead(exec => persistenceJournalImpl.readCounterRows(unscopedExecutor(exec, 'persistence: counter rows read ran unscoped through executeRaw'), keys)); }
  ownsSchemaTables() { return this.preparationRead(exec => persistenceJournalImpl.ownsSchemaTables(unscopedExecutor(exec, 'persistence: schema owner read ran unscoped through executeRaw'))); }
  readOAuthClientWriteGrant(clientId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => persistenceJournalImpl.readOAuthClientWriteGrant(unscopedExecutor(exec, 'persistence: OAuth client grant read ran unscoped through executeRaw'), clientId, opts), opts?.lock); }
  readAccessTokenWriteGrant(tokenId: string, opts?: { lock?: boolean }) { return this.preparationRead(exec => persistenceJournalImpl.readAccessTokenWriteGrant(unscopedExecutor(exec, 'persistence: legacy token grant read ran unscoped through executeRaw'), tokenId, opts), opts?.lock); }
  shareLockWriteCredential(kind: 'oauth_client' | 'legacy_token', id: string) { return this.preparationRead(exec => persistenceJournalImpl.shareLockWriteCredential(unscopedExecutor(exec, 'persistence: credential lock ran unscoped through executeRaw'), kind, id), true); }
  readAdmissionRate(principal: { kind: string; id: string } | null, opts?: { sample?: boolean }) { return this.preparationRead(exec => persistenceJournalImpl.readAdmissionRate(unscopedExecutor(exec, 'persistence: admission rate read ran unscoped through executeRaw'), principal, opts)); }
  countOutstandingBySource(principalKind: string, principalId: string) { return this.preparationRead(exec => persistenceJournalImpl.countOutstandingBySource(unscopedExecutor(exec, 'persistence: outstanding-by-source read ran unscoped through executeRaw'), principalKind, principalId)); }
  // The admission statements run on this engine's executeRaw, as journal.ts sent them (a fault a test injects still reaches them).
  readWorktreeAdmission(key: persistenceAdmissionImpl.WorktreeAdmissionKey, opts?: { lockRefresh?: boolean }) { return persistenceAdmissionImpl.readWorktreeAdmission(this, key, opts); }
  completeSyncedRefresh(refreshId: string) { return persistenceAdmissionImpl.completeSyncedRefresh(this, refreshId); }
  hasDeferralRoom(worktreeId: string, capability: string, liveMs: number) { return this.ownRawRead(exec => persistenceAdmissionImpl.hasDeferralRoom(exec, worktreeId, capability, liveMs)); }
  readRefreshTiming(refreshId: string) { return this.ownRawRead(exec => persistenceAdmissionImpl.readRefreshTiming(exec, refreshId)); }
  countHeldBehindImport(sourceId: string, principal: { kind: string; id: string } | null) { return this.ownRawRead(exec => persistenceAdmissionImpl.countHeldBehindImport(exec, sourceId, principal)); }
  lockPersistenceCounters(keys: readonly string[]): Promise<persistenceJournalImpl.CounterRow[]> { return this._pageTransaction ? persistenceJournalImpl.lockPersistenceCounters(this.autocommitSql, keys) : this.transaction(tx => tx.lockPersistenceCounters(keys)); } // pipelined: one connection only, so open a transaction
  insertWriteRequest(row: persistenceJournalImpl.WriteRequestInsert) { return persistenceJournalImpl.insertWriteRequest(this.autocommitSql, row); }
  insertWriteRequestGroup(group: persistenceJournalImpl.WriteRequestGroupInsert) { return persistenceJournalImpl.insertWriteRequestGroup(this.autocommitSql, group); }
  readOwnerHostBinding(worktreeId: string) { return persistenceJournalImpl.readOwnerHostBinding(unscopedExecutor(this.engineSql, 'persistence: owner binding read ran unscoped through the transaction executeRaw'), worktreeId); }
  stampWriteClaim(id: string, token: string, leaseMs: number, phaseJson: string) { return persistenceJournalImpl.stampWriteClaim(this.autocommitSql, id, token, leaseMs, phaseJson); }
  lockWriteRequest(id: string) { return persistenceJournalImpl.lockWriteRequest(this.autocommitSql, id); }
  lockWriteRequestsById(ids: readonly string[]) { return persistenceJournalImpl.lockWriteRequestsById(this.autocommitSql, ids); }
  compactTerminalIntent(compaction: persistenceJournalImpl.TerminalIntentCompaction) { return persistenceJournalImpl.compactTerminalIntent(this.autocommitSql, compaction); }
  completeWriteRow(completion: persistenceJournalImpl.WriteCompletion) { return persistenceJournalImpl.completeWriteRow(this.autocommitSql, completion); }
  cancelWriteRow(cancel: persistenceJournalImpl.WriteCancellation) { return persistenceJournalImpl.cancelWriteRow(this.autocommitSql, cancel); }
  insertPublicationEffects(spec: persistenceJournalImpl.PublicationEffectsSpec) { return persistenceJournalImpl.insertPublicationEffects(this.autocommitSql, spec); }
  insertWithdrawalEffects(spec: persistenceJournalImpl.WithdrawalEffectsSpec) { return persistenceJournalImpl.insertWithdrawalEffects(this.autocommitSql, spec); }
  insertRemirrorEffects(requestId: string, sourceId: string, data: Record<string, unknown>) { return remirrorEffects.insertRemirrorEffects(this, requestId, sourceId, data); }
  readRemirrorEffects(requestId: string) { return remirrorEffects.readRemirrorEffects(this, requestId); }
  listSourceCheckpointRecords<R>(op: string, sourceIds: readonly string[] | null) { return fenceRepairRecords.listSourceCheckpointRecords<R>(this, op, sourceIds); }
  insertOpCheckpointIfAbsent(op: string, fingerprint: string, completedKeys: readonly unknown[]) { return fenceRepairRecords.insertOpCheckpointIfAbsent(this, op, fingerprint, completedKeys); }
  replaceOpCheckpointAtVersion(op: string, fingerprint: string, completedKeys: readonly unknown[], expected: number) { return fenceRepairRecords.replaceOpCheckpointAtVersion(this, op, fingerprint, completedKeys, expected); }
  upsertFenceTrendRunRecord(op: string, fingerprint: string, record: unknown) { return fenceRepairRecords.upsertFenceTrendRunRecord(this, op, fingerprint, record); }
  readOldestSyncHoldAt(code: string, sourceIds: readonly string[]) { return fenceRepairRecords.readOldestSyncHoldAt(this, code, sourceIds); }
  readLastFinishedJobAt(name: string) { return fenceRepairRecords.readLastFinishedJobAt(this, name); }
  reclaimBudgetReservations(key: budgetLedgerWrites.BudgetLedgerKey, nowIso: string) { return budgetLedgerWrites.reclaimBudgetReservations(this, key, nowIso); }
  reserveBudgetReservation(key: budgetLedgerWrites.BudgetLedgerKey, spec: budgetLedgerWrites.BudgetReservationSpec) { return budgetLedgerWrites.reserveBudgetReservation(this, key, spec); }
  dispatchBudgetReservation(key: budgetLedgerWrites.BudgetLedgerKey, id: string, nowIso: string) { return budgetLedgerWrites.dispatchBudgetReservation(this, key, id, nowIso); }
  settleBudgetReservation(key: budgetLedgerWrites.BudgetLedgerKey, id: string, actual: string) { return budgetLedgerWrites.settleBudgetReservation(this, key, id, actual); }
  releaseBudgetReservation(key: budgetLedgerWrites.BudgetLedgerKey, id: string) { return budgetLedgerWrites.releaseBudgetReservation(this, key, id); }
  findSecretEntryByMac(sourceId: string, mac: string) { return secretStoreRows.findSecretEntryByMac(this, sourceId, mac); }
  secretEntryExists(id: string) { return secretStoreRows.secretEntryExists(this, id); }
  insertSecretEntry(row: secretStoreRows.SecretEntryInsert, conflict: secretStoreRows.SecretEntryConflict) { return secretStoreRows.insertSecretEntry(this, row, conflict); }
  insertSecretOccurrence(o: secretStoreRows.SecretOccurrenceInsert) { return secretStoreRows.insertSecretOccurrence(this, o); }
  readSecretEntry(id: string) { return secretStoreRows.readSecretEntry(this, id); }
  listSecretOccurrences(entryId: string) { return secretStoreRows.listSecretOccurrences(this, entryId); }
  listSecretEntrySummaries(filter: { sourceId: string | null; slug: string | null; limit: number }) { return secretStoreRows.listSecretEntrySummaries(this, filter); }
  countSecretsByRule(sourceId: string | null) { return secretStoreRows.countSecretsByRule(this, sourceId); }
  listAllowedSecretMacs(sourceId: string | null) { return secretStoreRows.listAllowedSecretMacs(this, sourceId); }
  listSecretKeysInUse() { return secretStoreRows.listSecretKeysInUse(this); }
  readSecretStoreSnapshot() { return secretStoreRows.readSecretStoreSnapshot(this); }
  insertBackupSecretEntry(row: secretStoreRows.SecretBackupEntryRow) { return secretStoreRows.insertBackupSecretEntry(this, row); }
  readBackupEntryHold(id: string, sourceId: string, mac: string) { return secretStoreRows.readBackupEntryHold(this, id, sourceId, mac); }
  insertBackupSecretOccurrence(o: secretStoreRows.SecretBackupOccurrenceRow, pageId: number | null) { return secretStoreRows.insertBackupSecretOccurrence(this, o, pageId); }
  deleteUnreferencedSecretEntry(id: string) { return secretStoreRows.deleteUnreferencedSecretEntry(this, id); }
  listSecretHoldingPages(sourceId: string, slugs: readonly string[], id: string) { return secretStoreRows.listSecretHoldingPages(this, sourceId, slugs, id); }
  countUnreferencedSecretEntries() { return secretStoreRows.countUnreferencedSecretEntries(this); }
  readRestorePageHit(sourceId: string, slug: string, marker: string) { return secretStoreRows.readRestorePageHit(this, sourceId, slug, marker); }
  markSecretEntryAllowed(id: string) { return secretStoreRows.markSecretEntryAllowed(this, id); }
  readPageRedactionRow(sourceId: string, slug: string) { return secretSpansRows.readPageRedactionRow(this, sourceId, slug); }
  readPageRedactionRows(pageId: number, sourceId: string, slug: string) { return secretSpansRows.readPageRedactionRows(this, pageId, sourceId, slug); }
  listTimelineDedupRows(pageId: number) { return secretSpansRows.listTimelineDedupRows(this, pageId); }
  listVersionBodiesForRedaction(pageId: number) { return secretSpansRows.listVersionBodiesForRedaction(this, pageId); }
  countPageVersionRows(pageId: number) { return secretSpansRows.countPageVersionRows(this, pageId); }
  setRetainedVersionBody(pageId: number, id: number, compiledTruth: string | null, frontmatter: unknown) { return secretSpansRows.setRetainedVersionBody(this, pageId, id, compiledTruth, frontmatter); }
  listChunkTextsForRedaction(pageId: number, purpose: 'rewrite' | 'scan') { return secretSpansRows.listChunkTextsForRedaction(this, pageId, purpose); }
  deleteChunksByIds(pageId: number, ids: readonly number[]) { return secretSpansRows.deleteChunksByIds(this, pageId, ids); }
  setRedactedPageFields(pageId: number, fields: secretSpansRows.RedactedPageFields) { return secretSpansRows.setRedactedPageFields(this, pageId, fields); }
  readRawDataValue(pageId: number, id: number) { return secretSpansRows.readRawDataValue(this, pageId, id); }
  setRawDataValue(pageId: number, id: number, data: unknown) { return secretSpansRows.setRawDataValue(this, pageId, id, data); }
  setRedactedRowText(pageId: number, store: secretSpansRows.RedactedRowStore, id: number, column: string, text: string) { return secretSpansRows.setRedactedRowText(this, pageId, store, id, column, text); }
  moveTwinRelationships(ids: twinMergeMoves.TwinMergeIds) { return twinMergeMoves.moveTwinRelationships(this, ids); }
  moveTwinPageChildren(move: twinMergeMoves.TwinPageChildrenMove) { return twinMergeMoves.moveTwinPageChildren(this, move); }
  moveTwinFacts(sourceId: string, twinSlug: string, survivorSlug: string) { return twinMergeMoves.moveTwinFacts(this, sourceId, twinSlug, survivorSlug); }
  movePageVersions(fromPageId: number, toPageId: number) { return twinMergeMoves.movePageVersions(this, fromPageId, toPageId); }
  recordRenameAlias(sourceId: string, oldSlug: string, newSlug: string) { return renameAliasRows.recordRenameAliasRows(this, sourceId, oldSlug, newSlug); }
  listGlobalPurgeWithdrawals(sourceId: string, hashes: readonly string[], worldOnly: boolean) { return this.ownRawRead(exec => remirrorEffects.listGlobalPurgeWithdrawals(exec, sourceId, hashes, worldOnly)); }
  readSourceMembership(sourceId: string, opts?: { lock?: boolean | 'update' }) { return this.preparationRead(exec => persistenceClaimsImpl.readSourceMembership(exec, sourceId, opts), !!opts?.lock); }
  findTopologyChanges(principalId: string, requestIds: string[]) { return persistenceClaimsImpl.findTopologyChanges(unscopedExecutor(this.engineSql, 'persistence: topology probe ran unscoped through the transaction executeRaw'), principalId, requestIds); }
  readTopologyChangeDigest(requestId: string, sourceId: string) { return persistenceClaimsImpl.readTopologyChangeDigest(unscopedExecutor(this.engineSql, 'persistence: sources add replay read ran unscoped through executeRaw'), requestId, sourceId); }
  listTopologyRecoveries(hostId: string, after: string | null, limit: number) { return this.preparationRead(exec => persistenceClaimsImpl.listTopologyRecoveries(unscopedExecutor(exec, 'persistence: topology recovery scan ran unscoped through executeRaw'), hostId, after, limit)); }
  readTopologyChange(principalId: string, requestId: string) { return persistenceClaimsImpl.readTopologyChange(unscopedExecutor(this.engineSql, 'persistence: topology receipt read ran unscoped through the transaction executeRaw'), principalId, requestId); }
  insertTopologyChange(row: persistenceClaimsImpl.TopologyChangeInsert) { return persistenceClaimsImpl.insertTopologyChange(this.autocommitSql, row); }
  // The renewal ran on executeRawDirect (consumer.ts); the expiry on the consumer's statement engine, direct while its route is.
  renewWriteClaim(renewal: persistenceClaimsImpl.ClaimRenewal, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.renewWriteClaim(this.directRawSql, renewal, opts); }
  releaseUnpublishedClaim(release: persistenceClaimsImpl.ClaimRelease, opts?: { direct?: boolean }) {
    return persistenceClaimsImpl.releaseUnpublishedClaim(opts?.direct ? { executeRaw: (sql, params) => this.executeRawDirect(sql, params) } : this, release);
  }
  expireStaleWriteClaims(expiry: persistenceClaimsImpl.ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.expireStaleWriteClaims(opts?.direct ? this.directRawSql : this.autocommitSql, expiry, { signal: opts?.signal }); }
  hasClaimableWrite(hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }) { return persistenceClaimsImpl.hasClaimableWrite(unscopedExecutor(this.autocommitSql, 'persistence: claim check ran unscoped through executeRaw'), hostId, excludeRoots, opts); }
  selectClaimableWrite<R = Record<string, unknown>>(spec: persistenceClaimsImpl.ClaimHeadSpec) { return persistenceClaimsImpl.selectClaimableWrite<R>(unscopedExecutor(this.engineSql, 'persistence: FIFO head read ran unscoped through the transaction executeRaw'), spec); }
  selectClaimableLaneHead<R = Record<string, unknown>>(spec: persistenceClaimsImpl.LaneHeadSpec) { return persistenceClaimsImpl.selectClaimableLaneHead<R>(unscopedExecutor(this.engineSql, 'persistence: lane head read ran unscoped through the transaction executeRaw'), spec); }
  chargeTransientInterruption(charge: persistenceClaimsImpl.TransientCharge) { return persistenceClaimsImpl.chargeTransientInterruption(this.autocommitSql, charge); }
  stampLaneHeadClaim<R = Record<string, unknown>>(stamp: persistenceClaimsImpl.LaneHeadStamp) { return persistenceClaimsImpl.stampLaneHeadClaim<R>(this.autocommitSql, stamp); }
  // The reclaim ran on executeRawDirect (journal.ts reclaimReleasedWrite).
  reclaimReleasedWrite<R = Record<string, unknown>>(stamp: persistenceClaimsImpl.LaneHeadStamp) { return persistenceClaimsImpl.reclaimReleasedWrite<R>(this.directRawSql, stamp); }
  // The consumer row reads ran on executeRaw (direct while the consumer's route is); the heartbeat's writes on executeRawDirect.
  listHostConsumerRows(hostId: string, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.listHostConsumerRows(unscopedExecutor(opts?.direct ? this.directRawSql : this.engineSql, 'persistence: consumer rows read ran unscoped through executeRaw'), hostId, { signal: opts?.signal }); }
  probeLiveConsumerRows(probe: persistenceClaimsImpl.ConsumerProbe, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.probeLiveConsumerRows(unscopedExecutor(opts?.direct ? this.directRawSql : this.engineSql, 'persistence: live consumer probe ran unscoped through executeRaw'), probe, { signal: opts?.signal }); }
  renewConsumerRow(renewal: persistenceClaimsImpl.ConsumerRenewal, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.renewConsumerRow(this.directRawSql, renewal, opts); }
  deleteConsumerRow(key: persistenceClaimsImpl.ConsumerRowKey, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.deleteConsumerRow(this.directRawSql, key, opts); }
  stampWorktreeHeartbeats(hostId: string, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.stampWorktreeHeartbeats(this.directRawSql, hostId, opts); }
  // The turn ran on the consumer's statement engine: direct while its route is (consumer-lane.ts).
  claimHousekeepingTurn(claim: housekeepingImpl.HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }) { return housekeepingImpl.claimHousekeepingTurn(opts?.direct ? this.directRawSql : this.autocommitSql, claim, { signal: opts?.signal }); }
  completeHousekeepingTurn(turn: { op: string; hostId: string }, opts?: { direct?: boolean }) { return housekeepingImpl.completeHousekeepingTurn(opts?.direct ? this.directRawSql : this.autocommitSql, turn); }
  readReceiptBudget(retentionKey: string, floorDays: number) { return this.preparationRead(exec => housekeepingImpl.readReceiptBudget(unscopedExecutor(exec, 'persistence: receipt budget read ran unscoped through executeRaw'), retentionKey, floorDays)); }
  listCompactableReceipts<R = Record<string, unknown>>(retentionDays: number) { return this.preparationRead(exec => housekeepingImpl.listCompactableReceipts<R>(unscopedExecutor(exec, 'persistence: compaction listing ran unscoped through executeRaw'), retentionDays)); }
  readReceiptCompactionWindow(hours: number) { return this.preparationRead(exec => housekeepingImpl.readReceiptCompactionWindow(unscopedExecutor(exec, 'persistence: receipt compaction window read ran unscoped through executeRaw'), hours)); }
  listReceiptCompactionCandidates(states: readonly string[], cutoff: string, maxSequence: string) { return this.preparationRead(exec => housekeepingImpl.listReceiptCompactionCandidates(unscopedExecutor(exec, 'persistence: receipt compaction candidate scan ran unscoped through executeRaw'), states, cutoff, maxSequence)); }
  countKeptFailedReceipts(cutoff: string) { return this.preparationRead(exec => housekeepingImpl.countKeptFailedReceipts(unscopedExecutor(exec, 'persistence: kept failed receipt count ran unscoped through executeRaw'), cutoff)); }
  listReservationsAfter(after: string, limit: number) { return this.preparationRead(exec => housekeepingImpl.listReservationsAfter(unscopedExecutor(exec, 'persistence: reservation sweep read ran unscoped through executeRaw'), after, limit)); }
  trueUpReservations(rows: readonly housekeepingImpl.TrueUpReservation[]) { return housekeepingImpl.trueUpReservations(this.autocommitSql, rows); }
  listTrueUpRequests<R = Record<string, unknown>>(ids: readonly string[]) { return this.preparationRead(exec => housekeepingImpl.listTrueUpRequests<R>(unscopedExecutor(exec, 'persistence: true-up read ran unscoped through executeRaw'), ids)); }
  readCapacityForecastInputs(opts?: { light?: boolean }) { return this.preparationRead(exec => housekeepingImpl.readCapacityForecastInputs(unscopedExecutor(exec, 'persistence: capacity forecast read ran unscoped through executeRaw'), opts)); }
  listPendingSegmentedProjections(filter: housekeepingImpl.SegmentedProjectionFilter) { return this.preparationRead(exec => housekeepingImpl.listPendingSegmentedProjections(unscopedExecutor(exec, 'projections: segmented queue read ran unscoped through executeRaw'), filter)); }
  selectProjectionWindowJobs(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean) { return this.preparationRead(exec => housekeepingImpl.selectProjectionWindowJobs(unscopedExecutor(exec, 'projections: resident window read ran unscoped through executeRaw'), cursor, retryCooldown)); }
  claimSegmentedProjection(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.claimSegmentedProjection(this.autocommitSql, ref, claim); }
  renewSegmentedProjectionClaim(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.renewSegmentedProjectionClaim(this.autocommitSql, ref, claim); }
  releaseSegmentedProjectionClaim(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.releaseSegmentedProjectionClaim(this.autocommitSql, ref, claim); }
  deleteProjectionJob(job: housekeepingImpl.ProjectionJobRef) { return housekeepingImpl.deleteProjectionJob(this.autocommitSql, job); }
  markProjectionRebuildFailed(job: housekeepingImpl.ProjectionJobRef) { return housekeepingImpl.markProjectionRebuildFailed(this.autocommitSql, job); }
  listGatedMirrorRequests(hostId: string, gateCode: string, allowedCodes: readonly string[]) { return this.preparationRead(exec => effectScansImpl.listGatedMirrorRequests(unscopedExecutor(exec, 'persistence: gated mirror scan ran unscoped through executeRaw'), hostId, gateCode, allowedCodes)); }
  listEffectRecoveries<R = Record<string, unknown>>(hostId: string, after: string | null, limit: number) { return this.preparationRead(exec => effectScansImpl.listEffectRecoveries<R>(unscopedExecutor(exec, 'persistence: effect recovery scan ran unscoped through executeRaw'), hostId, after, limit)); }
  selectClaimableEffect<R = Record<string, unknown>>(hostId: string, deadOwners: readonly string[]) { return effectScansImpl.selectClaimableEffect<R>(unscopedExecutor(this.engineSql, 'persistence: effect claim read ran unscoped through the transaction executeRaw'), hostId, deadOwners); }
  listEmbeddingCandidates(sourceIds: readonly string[], neverRetried: readonly string[]) { return effectScansImpl.listEmbeddingCandidates(unscopedExecutor(this.engineSql, 'persistence: embedding candidate scan ran unscoped through executeRaw'), sourceIds, neverRetried); }
  listOverdueHeldWrites<R = Record<string, unknown>>(hostId: string, maxWaitMs: number, hold: ownerScansImpl.OverdueHoldKind, opts?: { signal?: AbortSignal }) { return ownerScansImpl.listOverdueHeldWrites<R>(unscopedExecutor(this.autocommitSql, 'persistence: overdue hold scan ran unscoped through executeRaw'), hostId, maxWaitMs, hold, opts); }
  lockOverdueHold(hold: ownerScansImpl.OverdueHold) { return ownerScansImpl.lockOverdueHold(unscopedExecutor(this.autocommitSql, 'persistence: overdue hold check ran unscoped through the transaction executeRaw'), hold); }
  listOwnerRecoveryHeads<R = Record<string, unknown>>(hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }) { return ownerScansImpl.listOwnerRecoveryHeads<R>(unscopedExecutor(opts?.direct ? this.directRawSql : this.engineSql, 'persistence: owner recovery scan ran unscoped through executeRaw'), hostId, excluded, { signal: opts?.signal }); }
  // The refresh resume's reads ran on executeRaw (worktree-refresh.ts resumeWorktreeRefreshes).
  listResumableRefreshes<R = Record<string, unknown>>(hostId: string, budgetMs: number) { return ownerScansImpl.listResumableRefreshes<R>(unscopedExecutor(this.engineSql, 'persistence: refresh resume scan ran unscoped through executeRaw'), hostId, budgetMs); }
  listSourceLastCommits(sourceIds: readonly string[]) { return ownerScansImpl.listSourceLastCommits(unscopedExecutor(this.engineSql, 'persistence: refresh resume source read ran unscoped through executeRaw'), sourceIds); }
  readRequestEffects(requestId: string, kind?: 'git') { return this.preparationRead(exec => effectScansImpl.readRequestEffects(unscopedExecutor(exec, 'persistence: receipt effect read ran unscoped through executeRaw'), requestId, kind)); }
  readSourceRequestById<R = Record<string, unknown>>(sourceId: string, id: string) { return this.preparationRead(exec => effectScansImpl.readSourceRequestById<R>(unscopedExecutor(exec, 'persistence: retry request read ran unscoped through executeRaw'), sourceId, id)); }
  listSourceRequestsByRequestId<R = Record<string, unknown>>(sourceId: string, requestId: string) { return this.preparationRead(exec => effectScansImpl.listSourceRequestsByRequestId<R>(unscopedExecutor(exec, 'persistence: retry request read ran unscoped through executeRaw'), sourceId, requestId)); }
  listRetryTrackedEffects<R = Record<string, unknown>>(requestRowId: string, parkedOnly: boolean, failedCodes: readonly string[]) { return this.preparationRead(exec => effectScansImpl.listRetryTrackedEffects<R>(unscopedExecutor(exec, 'persistence: retry effect read ran unscoped through executeRaw'), requestRowId, parkedOnly, failedCodes)); }
  lockEffectRow<R = Record<string, unknown>>(id: string | number) { return effectScansImpl.lockEffectRow<R>(unscopedExecutor(this.autocommitSql, 'persistence: effect lock ran unscoped through executeRaw'), id); }
  stampEffectClaim<R = Record<string, unknown>>(claim: effectWorkerImpl.EffectClaim) { return effectWorkerImpl.stampEffectClaim<R>(this, claim); }
  claimEffectRecovery<R = Record<string, unknown>>(claim: effectWorkerImpl.EffectClaim) { return effectWorkerImpl.claimEffectRecovery<R>(this, claim); }
  claimCoalescedGitEffects<R = Record<string, unknown>>(input: effectWorkerImpl.CoalescedGitClaim) { return effectWorkerImpl.claimCoalescedGitEffects<R>(this, input); }
  renewEffectClaim(claim: effectWorkerImpl.EffectClaimRef, opts?: { direct?: boolean }) { return effectWorkerImpl.renewEffectClaim((opts?.direct ? { executeRaw: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => this.executeRawDirect<T>(sql, params) } : this), claim); }
  advanceEffectRow(claim: effectWorkerImpl.EffectClaimRef & { slug: string }) { return effectWorkerImpl.advanceEffectRow(this, claim); }
  completeEffectRow(claim: effectWorkerImpl.EffectClaimRef & { outcomeJson: string }) { return effectWorkerImpl.completeEffectRow(this, claim); }
  retryEffectRow(claim: effectWorkerImpl.EffectClaimRef & { reason: string; delayMs: number }) { return effectWorkerImpl.retryEffectRow(this, claim); }
  retryBusyEffectRow(claim: effectWorkerImpl.EffectClaimRef & { dataJson: string; delayMs: number }) { return effectWorkerImpl.retryBusyEffectRow(this, claim); }
  requeueEffectRow(claim: effectWorkerImpl.EffectClaimRef & { dataJson: string; reason: string | null; delayMs: number }) { return effectWorkerImpl.requeueEffectRow(this, claim); }
  parkEffectRow(claim: effectWorkerImpl.EffectClaimRef & { dataJson: string }) { return effectWorkerImpl.parkEffectRow(this, claim); }
  failEffectRow(claim: effectWorkerImpl.EffectClaimRef & { reason: string }) { return effectWorkerImpl.failEffectRow(this, claim); }
  readMirrorGateRows(requestIds: readonly string[]) { return effectWorkerImpl.readMirrorGateRows(unscopedExecutor(this.engineSql, 'persistence: mirror gate read ran unscoped through executeRaw'), requestIds); }
  lockEffectGuard(worktreeId: string | null) { return effectWorkerImpl.lockEffectGuard(this, worktreeId); }
  hasRearmableTargets(requestIds: readonly string[], code: string) { return effectWorkerImpl.hasRearmableTargets(unscopedExecutor(this.engineSql, 'persistence: rearmable target probe ran unscoped through executeRaw'), requestIds, code); }
  probeIdleWork(spec: idleProbeImpl.IdleProbeSpec, opts?: { signal?: AbortSignal; lane?: ReservedConnection; direct?: boolean }) {
    const exec: idleProbeImpl.IdleProbeExec = opts?.lane ?? (opts?.direct ? { executeRaw: (sql, params, o) => this.executeRawDirect(sql, params, o) } : this);
    return idleProbeImpl.probeIdleWork(exec, spec, { signal: opts?.signal });
  }
  probeNoopEmbeddingSettle(from: string) { return noopSettleImpl.probeNoopEmbeddingSettle(this, from); }
  lockNoopEmbeddingWindow(spec: { from: string; limit: number }) { return noopSettleImpl.lockNoopEmbeddingWindow(this, spec); }
  readNoopEmbeddingCandidates(spec: noopSettleImpl.NoopSettleCandidateSpec) { return noopSettleImpl.readNoopEmbeddingCandidates(this, spec); }
  settleNoopEmbeddingRows(ids: readonly string[]) { return noopSettleImpl.settleNoopEmbeddingRows(this, ids); }
  readTransactionSettings(names: readonly string[]) { return transactionSettingsImpl.readTransactionSettings(unscopedExecutor(this.engineSql, 'transaction settings: read ran through the transaction executeRaw'), names); }
  readCurrentWriteTrust() { return transactionSettingsImpl.readCurrentWriteTrust(unscopedExecutor(this.engineSql, 'transaction settings: write trust read ran through the transaction executeRaw')); }
  setWriteContext(input: transactionSettingsImpl.WriteContextInput) { return transactionSettingsImpl.setWriteContext(this.autocommitSql, input); }
  readWriterVersionCutoff() { return writerVersionsImpl.readWriterVersionCutoff(unscopedExecutor(this.autocommitSql, 'writer versions: cutoff read ran unscoped through executeRaw')); }
  listWriterVersions(limit: number) { return writerVersionsImpl.listWriterVersions(unscopedExecutor(this.autocommitSql, 'writer versions: list ran unscoped through executeRaw'), limit); }
  recentWriterVersions(days: number) { return writerVersionsImpl.recentWriterVersions(unscopedExecutor(this.autocommitSql, 'writer versions: window read ran unscoped through executeRaw'), days); }
  readSegmentedGateEvidence(days: number) { return this.preparationRead(exec => writerVersionsImpl.readSegmentedGateEvidence(unscopedExecutor(exec, 'writer versions: segmented gate read ran unscoped through executeRaw'), days)); }
  applyTransactionSettings(names: readonly string[], values: readonly string[]) { return transactionSettingsImpl.applyTransactionSettings(this.autocommitSql, names, values); }
  beginSnapshotRead(opts?: { readOnly?: boolean }) { return transactionSettingsImpl.beginSnapshotRead(this, opts); }
  setLocalStatementTimeout(ms: number) { return transactionSettingsImpl.setLocalStatementTimeout(this, ms); }
  hasPersistenceTable(table: connectGateImpl.PersistenceTable) { return connectGateImpl.hasPersistenceTable(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), table); }
  listManagedRootBindings(hostId: string, opts?: { signal?: AbortSignal }) { return connectGateImpl.listManagedRootBindings(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), hostId, opts); }
  readGraduationGateRow(opts?: { withRunSetting?: boolean }) { return connectGateImpl.readGraduationGateRow(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), opts); }
  listRetiredDeactivations() { return connectGateImpl.listRetiredDeactivations(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw')); }
  // Group A (decide store). The reads a doctor check reaches run bounded: they honour a read deadline as the typed preparation reads do (statement-deadline.ts BOUNDED_TYPED_READS).
  private async decideRead<T>(fn: (exec: ReturnType<typeof unscopedExecutor>) => Promise<T>): Promise<T> { throwIfRequestAborted(); return this.preparationRead(exec => fn(unscopedExecutor(exec, 'decide store: master engine.executeRaw, unscoped (it refused an aborted request, GBRA-156)'))); }
  private async engineRead<T>(fn: (exec: ReturnType<typeof unscopedExecutor>) => Promise<T>): Promise<T> { throwIfRequestAborted(); return this.preparationRead(exec => fn(unscopedExecutor(abortGuarded(exec), 'N3 typed read: master engine.executeRaw, unscoped (it refused an aborted request and kept its deadline)'))); } // master's executeRaw reads: refuse an aborted request (GBRA-156); end at a doctor deadline or preparation clock (BOUNDED_TYPED_READS, TYPED_PREPARATION_READS)
  readDecideState(key: string) { return this.decideRead(exec => decideStoreImpl.readDecideState(exec, key)); }
  upsertDecideState(key: string, value: string) { return decideStoreImpl.upsertDecideState(this, key, value); }
  deleteDecideState(key: string) { return decideStoreImpl.deleteDecideState(this, key); }
  ensureDecideState(key: string, value: string) { return decideStoreImpl.ensureDecideState(this, key, value); }
  insertDecideSpend(rows: readonly decideStoreImpl.DecideSpendInsert[]) { return decideStoreImpl.insertDecideSpend(this, rows); }
  dailyDecideSpend(since: Date) { return this.decideRead(exec => decideStoreImpl.dailyDecideSpend(exec, since)); }
  listDecideSpendBySlot() { return decideStoreImpl.listDecideSpendBySlot(this); }
  insertDecideReceipts(rows: readonly decideStoreImpl.DecideReceiptInsert[]) { return decideStoreImpl.insertDecideReceipts(this, rows); }
  pruneDecideReceipts(retentionDays: number) { return decideStoreImpl.pruneDecideReceipts(this, retentionDays); }
  listDecideReceiptStats(opts: { slot?: string; sinceHours: number }) { return this.decideRead(exec => decideStoreImpl.listDecideReceiptStats(exec, opts)); }
  decideSlotUsage(sinceHours: number) { return this.decideRead(exec => decideStoreImpl.decideSlotUsage(exec, sinceHours)); }
  decideConflictNoEntityCounts(sinceHours: number) { return decideStoreImpl.decideConflictNoEntityCounts(this, sinceHours); }
  listDecideReplayReceipts(slot: string, sinceHours: number) { return decideStoreImpl.listDecideReplayReceipts(this, slot, sinceHours); }
  listDecideResolvedModels(sinceHours: number) { return this.decideRead(exec => decideStoreImpl.listDecideResolvedModels(exec, sinceHours)); }
  listDecideMixedModelDecisions(sinceHours: number) { return this.decideRead(exec => decideStoreImpl.listDecideMixedModelDecisions(exec, sinceHours)); }
  insertDecideCalibration(row: decideStoreImpl.DecideCalibrationInsert) { return decideStoreImpl.insertDecideCalibration(this, row); }
  storeDecideQualification(id: number, q: decideStoreImpl.DecideQualification) { return decideStoreImpl.storeDecideQualification(this, id, q); }
  listDecideCalibrations(opts?: { slot?: string; includeRetired?: boolean }) { return this.decideRead(exec => decideStoreImpl.listDecideCalibrations(exec, opts)); }
  getDecideCalibration(id: number) { return decideStoreImpl.getDecideCalibration(this, id); }
  setDecideCalibrationRetired(id: number, retired: boolean) { return decideStoreImpl.setDecideCalibrationRetired(this, id, retired); }
  readLedgerSource(sourceId: string, opts?: { batch?: boolean }) { return this.preparationRead(exec => beliefImpl.readLedgerSource(unscopedExecutor(exec, 'belief: ledger source probe ran unscoped through executeRaw'), sourceId, opts), opts?.batch); }
  readBeliefTombstones(sourceId: string, factFps: readonly string[], takeFps: readonly string[]) { return beliefLedgerImpl.readBeliefTombstones(unscopedExecutor(this.engineSql, 'belief: the ledger write path ran this read through executeRaw unscoped'), sourceId, factFps, takeFps); }
  readLegacyClaimFingerprints(sourceId: string, claims: readonly string[]) { return beliefLedgerImpl.readLegacyClaimFingerprints(unscopedExecutor(this.engineSql, 'belief: the pre-v341 fingerprint probe ran this read through executeRaw unscoped'), sourceId, claims); }
  readLegacyBeliefTombstones(sourceId: string, probes: Parameters<typeof beliefLedgerImpl.readLegacyBeliefTombstones>[2]) { return beliefLedgerImpl.readLegacyBeliefTombstones(unscopedExecutor(this.engineSql, 'belief: the ledger write path ran this read through executeRaw unscoped'), sourceId, probes); }
  readLatestBeliefCoverage(sourceId: string) { return beliefLedgerImpl.readLatestBeliefCoverage(unscopedExecutor(this.engineSql, 'belief: the ledger activation ran this read through executeRaw unscoped'), sourceId); }
  hasBeliefBaseline(sourceId: string, slug: string, runId: string) { return beliefLedgerImpl.hasBeliefBaseline(unscopedExecutor(this.engineSql, 'belief: the ledger activation ran this read through executeRaw unscoped'), sourceId, slug, runId); }
  listBeliefBaselinePending(sourceId: string, runId: string, after: string, skip: readonly string[], limit: number) { return beliefLedgerImpl.listBeliefBaselinePending(unscopedExecutor(this.engineSql, 'belief: the ledger activation ran this read through executeRaw unscoped'), sourceId, runId, after, skip, limit); }
  countBeliefBaselineSlugs(sourceId: string, runId: string) { return beliefLedgerImpl.countBeliefBaselineSlugs(unscopedExecutor(this.engineSql, 'belief: the ledger activation ran this read through executeRaw unscoped'), sourceId, runId); }
  readBeliefRedactions(sourceId: string, subjectKeys: readonly string[], fieldHashes: readonly string[]) { return beliefLedgerImpl.readBeliefRedactions(unscopedExecutor(this.engineSql, 'belief: the ledger write path ran this read through executeRaw unscoped'), sourceId, subjectKeys, fieldHashes); }
  insertBeliefRedaction(row: beliefLedgerImpl.BeliefRedactionInsert) { return beliefLedgerImpl.insertBeliefRedaction(this.autocommitSql, row); }
  releaseBeliefRedactions(ids: readonly number[], publicationId: string, releasedHash: string) { return beliefLedgerImpl.releaseBeliefRedactions(this.autocommitSql, ids, publicationId, releasedHash); }
  insertBeliefEvents(rows: readonly beliefLedgerImpl.BeliefEventInsertRow[]) { return beliefLedgerImpl.insertBeliefEvents(this.autocommitSql, rows); }
  markBeliefCommits(publicationIds: readonly string[]) { return beliefLedgerImpl.markBeliefCommits(this.autocommitSql, publicationIds); }
  readOpenBeliefLifetimes(pairs: readonly { incarnation: string; slug: string }[]) { return beliefLedgerImpl.readOpenBeliefLifetimes(unscopedExecutor(this.engineSql, 'belief: the ledger write path ran this read through executeRaw unscoped'), pairs); }
  endBeliefLifetime(lifetime: string) { return beliefLedgerImpl.endBeliefLifetime(this.autocommitSql, lifetime); }
  mintBeliefLifetime(mint: beliefLedgerImpl.BeliefLifetimeMint) { return beliefLedgerImpl.mintBeliefLifetime(this.autocommitSql, mint); }
  renameBeliefLifetime(lifetime: string, slug: string, pageId: number) { return beliefLedgerImpl.renameBeliefLifetime(this.autocommitSql, lifetime, slug, pageId); }
  readMovedBeliefLifetimes(pageIds: readonly number[]) { return beliefLedgerImpl.readMovedBeliefLifetimes(unscopedExecutor(this.engineSql, 'belief: the ledger write path ran this read through executeRaw unscoped'), pageIds); }
  readBeliefStateRows(input: beliefStateImpl.BeliefStateRowsInput) { return beliefStateImpl.readBeliefStateRows(unscopedExecutor(this.engineSql, 'belief: the ledger state read ran this read through executeRaw unscoped'), input); }
  readBeliefFactsById(ids: readonly number[]) { return beliefStateImpl.readBeliefFactsById(unscopedExecutor(this.engineSql, 'belief: the ledger state read ran this read through executeRaw unscoped'), ids); }
  bumpSourcePurgeEpoch(sourceId: string) { return beliefPurgeImpl.bumpSourcePurgeEpoch(this.autocommitSql, sourceId); }
  hasBeliefEvents(sourceId: string) { return beliefPurgeImpl.hasBeliefEvents(unscopedExecutor(this.engineSql, 'belief: the purge ran this read through executeRaw unscoped'), sourceId); }
  registerPurgeRedaction(row: beliefPurgeImpl.PurgeRedactionInsert) { return beliefPurgeImpl.registerPurgeRedaction(this.autocommitSql, row); }
  releasePurgeRedactionsForField(row: beliefPurgeImpl.PurgeRedactionRelease) { return beliefPurgeImpl.releasePurgeRedactionsForField(this.autocommitSql, row); }
  replayPagePurges(row: beliefPurgeImpl.ReplayPagePurges) { return beliefPurgeImpl.replayPagePurges(this.autocommitSql, row); }
  readPurgeReplaySchema(stores: readonly string[]) { return beliefPurgeImpl.readPurgeReplaySchema(unscopedExecutor(this.engineSql, 'belief: the purge replay ran these probes through executeRaw unscoped'), stores); }
  async listCoveredSources(subjectKey: string) { return this.engineRead(exec => beliefImpl.listCoveredSources(exec, subjectKey)); }
  isFolderRestricted(sourceId: string, slug: string) { return this.preparationRead(exec => accessControlImpl.isFolderRestricted(unscopedExecutor(exec, 'access: folder rule read ran unscoped through executeRaw'), sourceId, slug)); }
  // The member lookup and the folder access read run through this engine's executeRaw, as access/caller.ts did; under a
  // preparer's read deadline they run as the other typed preparation reads do (preparationRead), ending at the deadline.
  readLiveMember(via: MemberBindingVia, key: string) { return this.ownRawRead(exec => accessControlImpl.readLiveMember(exec, via, key)); }
  readFolderAccess(readers: readonly string[]) { return this.ownRawRead(exec => accessControlImpl.readFolderAccess(exec, readers)); }
  // Session state runs through this engine's executeRaw, as context/session-state.ts did (engine-sql/session-state.ts).
  upsertSessionState(sourceId: string, clientId: string, sessionId: string, write: sessionStateImpl.SessionStateWrite) { return sessionStateImpl.upsertSessionState(this, sourceId, clientId, sessionId, write); }
  readSessionCursor(sourceId: string, clientId: string, sessionId: string) { return this.ownRawRead(exec => sessionStateImpl.readSessionCursor(exec, sourceId, clientId, sessionId)); }
  readDeltaSessionRow(sourceId: string, clientId: string, sessionId: string) { return this.ownRawRead(exec => sessionStateImpl.readDeltaSessionRow(exec, sourceId, clientId, sessionId)); }
  readCheckpointManifestRow(sourceId: string, clientId: string, sessionId: string) { return this.ownRawRead(exec => sessionStateImpl.readCheckpointManifestRow(exec, sourceId, clientId, sessionId)); }
  writeCheckpointManifest(sourceId: string, clientId: string, sessionId: string, manifest: readonly unknown[]) { return sessionStateImpl.writeCheckpointManifest(this, sourceId, clientId, sessionId, manifest); }
  ageOutSessionState(olderThanDays: number) { return sessionStateImpl.ageOutSessionState(this, olderThanDays); }
  capSessionStatePerClient(maxRowsPerClient: number) { return sessionStateImpl.capSessionStatePerClient(this, maxRowsPerClient); }
  listAppliedPolicyRevisions() { return this.preparationRead(exec => accessControlImpl.listAppliedPolicyRevisions(unscopedExecutor(exec, 'access: applied revision read ran unscoped through executeRaw'))); }
  listFactsFencePages(q: sweepReadsImpl.FactsFencePagesQuery) { return sweepReadsImpl.listFactsFencePages(this, q); }
  listSweepStalePages(q: sweepReadsImpl.SweepStalePagesQuery) { return sweepReadsImpl.listSweepStalePages(this, q); }
  listSweepDeferredPages(q: sweepReadsImpl.SweepDeferredPagesQuery) { return sweepReadsImpl.listSweepDeferredPages(this, q); }
  listPageRefsForSlugs(slugs: readonly string[]) { return sweepReadsImpl.listPageRefsForSlugs(this, slugs); }
  readMayActFor(via: MayActForVia, key: string): Promise<string[] | string | null> { return accessControlImpl.readMayActFor(this, via, key); }
  readJobPrincipal(principal: { kind: JobPrincipalKind; id: string }) { return this.ownRawRead(exec => accessControlImpl.readJobPrincipal(exec, principal)); }
  readAudiencePrincipals(memberIds: readonly string[], groupIds: readonly string[]): Promise<AudiencePrincipalRows> { return accessControlImpl.readAudiencePrincipals(this, memberIds, groupIds); }
  // The folder-rule policy members (engine-sql/access-policy.ts), on this handle: a transaction's own clone inside one.
  readAccessStoreConfig(sourceId: string) { return accessPolicyImpl.readAccessStoreConfig(this, sourceId); }
  writeAccessStoreConfig(sourceId: string, store: string) { return accessPolicyImpl.writeAccessStoreConfig(this, sourceId, store); }
  ensureAccessPolicyState(sourceId: string) { return accessPolicyImpl.ensureAccessPolicyState(this, sourceId); }
  lockAccessPolicy(sourceId: string) { return accessPolicyImpl.lockAccessPolicy(this, sourceId); }
  listAccessRules(sourceId: string) { return accessPolicyImpl.listAccessRules(this, sourceId); }
  readAccessPolicyRevisions(query: accessPolicyImpl.AccessRevisionQuery) { return accessPolicyImpl.readAccessPolicyRevisions(this, query); }
  listAccessCoverage(sourceId: string) { return accessPolicyImpl.listAccessCoverage(this, sourceId); }
  readAccessStateUnreadable() { return accessPolicyImpl.readAccessStateUnreadable(this); }
  applyAccessRuleChanges(sourceId: string, changes: accessPolicyImpl.AccessRuleChanges) { return accessPolicyImpl.applyAccessRuleChanges(this, sourceId, changes); }
  restampAccessWindow(sourceId: string, after: number, batch: number) { return accessPolicyImpl.restampAccessWindow(this, sourceId, after, batch); }
  finishAccessRestamp(sourceId: string) { return accessPolicyImpl.finishAccessRestamp(this, sourceId); }
  insertAccessPolicyRevision(row: accessPolicyImpl.AccessRevisionInsert) { return accessPolicyImpl.insertAccessPolicyRevision(this, row); }
  markAccessRevisionsApplied(sourceId: string, upTo?: number) { return accessPolicyImpl.markAccessRevisionsApplied(this, sourceId, upTo); }
  approveAccessPolicyRevision(sourceId: string, revision: number, actor: string) { return accessPolicyImpl.approveAccessPolicyRevision(this, sourceId, revision, actor); }
  hasAccessPolicyState(sourceId: string) { return accessPolicyImpl.hasAccessPolicyState(this, sourceId); }
  listAccessPrefixSlugs(sourceId: string, prefixes: string | readonly string[]) { return accessPolicyImpl.listAccessPrefixSlugs(this, sourceId, prefixes); }
  readAccessPolicyMarks(sourceId: string, operationId?: string) { return accessPolicyImpl.readAccessPolicyMarks(this, sourceId, operationId); }
  replaceAccessInvalidCoverage(sourceId: string, prefixes: readonly string[], detail: unknown) { return accessPolicyImpl.replaceAccessInvalidCoverage(this, sourceId, prefixes, detail); }
  // The access setup and policy-store members (engine-sql/access-setup.ts), on this handle: a transaction's own clone inside one.
  listUnboundTokenNames() { return accessSetupImpl.listUnboundTokenNames(this); }
  listUnboundClientIds() { return accessSetupImpl.listUnboundClientIds(this); }
  readLiveAccessToken(name: string) { return accessSetupImpl.readLiveAccessToken(this, name); }
  filterUnarchivedSourceIds(ids: readonly string[]) { return accessSetupImpl.filterUnarchivedSourceIds(this, ids); }
  recordTokenSetupReads(name: string, reads: readonly string[]) { return accessSetupImpl.recordTokenSetupReads(this, name, reads); }
  listKeysReadingSource(sourceId: string) { return accessSetupImpl.listKeysReadingSource(this, sourceId); }
  countCompanyPages(sourceId: string) { return accessSetupImpl.countCompanyPages(this, sourceId); }
  revokeAccessTokenById(id: string) { return accessSetupImpl.revokeAccessTokenById(this, id); }
  readUnfinishedAccessMigration(sourceId: string) { return accessSetupImpl.readUnfinishedAccessMigration(this, sourceId); }
  insertAccessMigration(id: string, sourceId: string, direction: string) { return accessSetupImpl.insertAccessMigration(this, id, sourceId, direction); }
  recordAccessMigrationPhase(id: string, phase: string, receipts: Record<string, unknown>) { return accessSetupImpl.recordAccessMigrationPhase(this, id, phase, receipts); }
  switchAccessMigration(id: string, receipts: Record<string, unknown>) { return accessSetupImpl.switchAccessMigration(this, id, receipts); }
  listAccessPolicySources() { return accessSetupImpl.listAccessPolicySources(this); }
  countPeopleFolderPages() { return accessSetupImpl.countPeopleFolderPages(this); }
  countOpenPages(sources: readonly string[], exclude: readonly accessSetupImpl.OpenPageExclusion[]) { return accessSetupImpl.countOpenPages(this, sources, exclude); }
  readAccessMembers(by: AccessMemberLookup): Promise<AccessMemberRow[]> { return accessControlImpl.readAccessMembers(this, by); }
  readAccessCredentials(by: AccessCredentialLookup): Promise<AccessCredentialRow[]> { return accessControlImpl.readAccessCredentials(this, by); }
  listOwnerCredentialRows(memberId: string) { return accessControlImpl.listOwnerCredentialRows(this, memberId); }
  insertPinnedQuestion(row: PinnedQuestionInsert) { return pinnedQuestionsImpl.insertPinnedQuestion(this, row); }
  readPinnedQuestion(sourceId: string, slug: string) { return pinnedQuestionsImpl.readPinnedQuestion(this, sourceId, slug); }
  listPinnedQuestions(filter: PinnedQuestionFilter) { return pinnedQuestionsImpl.listPinnedQuestions(this, filter); }
  insertVolunteerEvents(rows: readonly VolunteerEventInsert[]) { return volunteerEventsImpl.insertVolunteerEvents(this, rows); }
  readVolunteerUsage(sourceIds: readonly string[], days: number) { return volunteerEventsImpl.readVolunteerUsage(this, sourceIds, days); }
  insertRetrievalEvents(events: RetrievalEventInsert[]) { return retrievalFeedbackImpl.insertRetrievalEvents(this, events); }
  readRetrievalEvent(id: string) { return retrievalFeedbackImpl.readRetrievalEvent(this, id); }
  applyRetrievalRatings(args: RetrievalRatingBatch) { return retrievalFeedbackImpl.applyRetrievalRatings(this, args); }
  readGitGapSourceRow(sourceId: string) { return gitGapCensusImpl.readGitGapSourceRow(this, sourceId); }
  countGitGapLivePages(sourceId: string) { return gitGapCensusImpl.countGitGapLivePages(this, sourceId); }
  markTransactionReadOnly() { return gitGapCensusImpl.markTransactionReadOnly(this); }
  listGitGapNewestPages(sourceId: string, limit: number) { return gitGapCensusImpl.listGitGapNewestPages(this, sourceId, limit); }
  countGitGapUnreadFacts(sourceId: string, pageIds: readonly string[]) { return gitGapCensusImpl.countGitGapUnreadFacts(this, sourceId, pageIds); }
  readGitGapPageBatch(sourceId: string, batch: GitGapBatch) { return gitGapCensusImpl.readGitGapPageBatch(this, sourceId, batch); }
  countGitGapFactsOnPages(sourceId: string, slugs: readonly string[]) { return gitGapCensusImpl.countGitGapFactsOnPages(this, sourceId, slugs); }
  countGitGapTimelineOnPages(pageIds: readonly number[]) { return gitGapCensusImpl.countGitGapTimelineOnPages(this, pageIds); }
  readGitGapSourceRows(sourceId: string, derivedLinkSources: readonly string[], holdOp: string) { return gitGapCensusImpl.readGitGapSourceRows(this, sourceId, derivedLinkSources, holdOp); }
  revokeAccessTokensNamed(name: string) { return accessCredentials.revokeAccessTokensNamed(this, name); }
  revokeAccessToken(id: string) { return accessCredentials.revokeAccessToken(this, id); }
  deleteOAuthClient(clientId: string) { return accessCredentials.deleteOAuthClient(this, clientId); }
  readActiveAccessTokenGrant(id: string, field: ActiveTokenGrantField) { return accessCredentials.readActiveAccessTokenGrant(this, id, field); }
  accessTokenLive(id: string) { return accessCredentials.accessTokenLive(this, id); }
  oauthClientLive(clientId: string) { return accessCredentials.oauthClientLive(this, clientId); }
  readOauthClientColumns(probe: OauthClientProbe) { return accessCredentials.readOauthClientColumns(this, probe); }
  setOauthClientTokenTtl(clientId: string, ttlSeconds: number) { return accessCredentials.setOauthClientTokenTtl(this, clientId, ttlSeconds); }
  insertOauthClientGrant(row: OauthClientGrantInsert) { return accessCredentials.insertOauthClientGrant(this, row); }
  readTokenLifetimeClampedClients() { return accessCredentials.readTokenLifetimeClampedClients(this); }
  readScopeSourceConfigs(ids: readonly string[], lock?: ScopeSourceLock) { return accessCredentials.readScopeSourceConfigs(this, ids, lock); }
  readOauthClientForUpdate(clientId: string) { return clientGrants.readOauthClientForUpdate(this, clientId); }
  readLiveOauthClients() { return clientGrants.readLiveOauthClients(this); }
  listAccessTokenRows() { return clientGrants.listAccessTokenRows(this); }
  lockOauthClientName(lockKey: string) { return clientGrants.lockOauthClientName(this, lockKey); }
  readLiveAccessTokenRows() { return clientGrants.readLiveAccessTokenRows(this); }
  oauthClientHoldsAuthorization(clientId: string) { return clientGrants.oauthClientHoldsAuthorization(this, clientId); }
  readSourceArchivedForShare(id: string) { return clientGrants.readSourceArchivedForShare(this, id); }
  readSourceAttestState(id: string) { return clientGrants.readSourceAttestState(this, id); }
  replaceSourceConfig(id: string, config: Record<string, unknown>) { return clientGrants.replaceSourceConfig(this, id, config); }
  persistOauthClientGrant(grant: OauthClientGrantPersist) { return clientGrants.persistOauthClientGrant(this, grant); }
  readLatestCatalogProvenanceAudit(clientId: string) { return clientGrants.readLatestCatalogProvenanceAudit(this, clientId); }
  listOauthGrantAudit(clientId: string) { return clientGrants.listOauthGrantAudit(this, clientId); }
  deleteOauthTokenByHash(hash: string, clientId: string) { return oauthRevocation.deleteOauthTokenByHash(this, hash, clientId); }
  softDeleteOauthClient(clientId: string) { return oauthRevocation.softDeleteOauthClient(this, clientId); }
  deleteOauthClientTokens(clientId: string) { return oauthRevocation.deleteOauthClientTokens(this, clientId); }
  deleteOauthClientCodes(clientId: string) { return oauthRevocation.deleteOauthClientCodes(this, clientId); }
  deleteOauthClientRow(clientId: string) { return oauthRevocation.deleteOauthClientRow(this, clientId); }
  setOauthClientRevision(clientId: string, revision: number, revoke: boolean) { return oauthRevocation.setOauthClientRevision(this, clientId, revision, revoke); }
  setOauthClientReadSharedRevision(clientId: string, revision: number | null) { return oauthRevocation.setOauthClientReadSharedRevision(this, clientId, revision); }
  readSharedSourceRows() { return readSharedSources.readSharedSourceRows(this); }
  insertOauthGrantAudit(row: OauthGrantAuditInsert) { return oauthRevocation.insertOauthGrantAudit(this, row); }
  readOauthAccessTokenRows(hash: string, rung: OauthTokenRung) { return accessCredentials.readOauthAccessTokenRows(this, hash, rung); }
  lockActiveAccessTokens(target: ActiveTokenTarget) { return accessCredentials.lockActiveAccessTokens(this, target); }
  writeAccessTokenGrant(id: string, write: AccessTokenGrantWrite) { return accessCredentials.writeAccessTokenGrant(this, id, write); }
  setAccessTokenReadSharedRevision(id: string, revision: number | null) { return accessCredentials.setAccessTokenReadSharedRevision(this, id, revision); }
  writeAccessTokenPrivateGrant(id: string, axis: AccessTokenPrivateAxis, value: string) { return accessCredentials.writeAccessTokenPrivateGrant(this, id, axis, value); }
  lockLegacyAccessTokens() { return accessCredentials.lockLegacyAccessTokens(this); }
  readActiveAccessTokenByHash(hash: string, caller: TokenByHashCaller) { return accessCredentials.readActiveAccessTokenByHash(this, hash, caller); }
  touchAccessTokenLastUsed(id: string, unified: boolean) { return accessCredentials.touchAccessTokenLastUsed(this, id, unified); }
  deleteExpiredOauthCredentials(nowEpochSeconds: number) { return accessCredentials.deleteExpiredOauthCredentials(this, nowEpochSeconds); }
  expireAllOauthCredentials() { return accessCredentials.expireAllOauthCredentials(this); }
  countOauthAccessTokens(from: number, to: number | null) { return accessCredentials.countOauthAccessTokens(this, from, to); }
  convertLegacyAccessTokenGrant(id: string, columns: LegacyTokenGrantColumns) { return accessCredentials.convertLegacyAccessTokenGrant(this, id, columns); }
  insertOauthToken(row: OauthTokenInsert) { return accessCredentials.insertOauthToken(this, row); }
  insertOauthCode(row: OauthCodeInsert) { return accessCredentials.insertOauthCode(this, row); }
  readOauthCodeForUpdate(codeHash: string, clientId: string) { return accessCredentials.readOauthCodeForUpdate(this, codeHash, clientId); }
  deleteOauthCode(codeHash: string, clientId: string) { return accessCredentials.deleteOauthCode(this, codeHash, clientId); }
  readOauthRefreshTokenForUpdate(tokenHash: string, clientId: string) { return accessCredentials.readOauthRefreshTokenForUpdate(this, tokenHash, clientId); }
  deleteOauthRefreshToken(tokenHash: string, clientId: string) { return accessCredentials.deleteOauthRefreshToken(this, tokenHash, clientId); }
  readOauthCodeChallenge(codeHash: string, clientId: string, nowEpochSeconds: number) { return accessCredentials.readOauthCodeChallenge(this, codeHash, clientId, nowEpochSeconds); }
  issueOauthTokens(rows: readonly OauthTokenInsert[]) { return accessCredentials.issueOauthTokens(this, rows); }
  listAudienceAccessMembers(): Promise<string[]> { return accessControlImpl.listAudienceAccessMembers(this); }
  readAccessGroups(id: string | null): Promise<AccessGroupRow[]> { return accessControlImpl.readAccessGroups(this, id); }
  listPagesNamingReader(principal: string, opts?: { live?: boolean }): Promise<PageNamingReaderRow[]> { return accessControlImpl.listPagesNamingReader(this, principal, opts); }
  // Entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts).
  readMentionLastPass(sourceId?: string | null) { return this.preparationRead(exec => entityReadsImpl.readMentionLastPass(unscopedExecutor(exec, 'entities: mention pass time ran unscoped through executeRaw'), sourceId)); }
  readMentionIndexStatus(sourceIds: readonly string[]) { return this.preparationRead(exec => entityReadsImpl.readMentionIndexStatus(unscopedExecutor(exec, 'entities: mention-index status ran unscoped through executeRaw'), sourceIds)); }
  countLivePagesInSource(sourceId: string) { return this.preparationRead(exec => entityReadsImpl.countLivePagesInSource(unscopedExecutor(exec, 'entities: live-page count ran unscoped through executeRaw'), sourceId)); }
  countMentionDueSince(sourceId: string, since: string, mentionVersion: number) { return this.preparationRead(exec => entityReadsImpl.countMentionDueSince(unscopedExecutor(exec, 'entities: mention due-since count ran unscoped through executeRaw'), sourceId, since, mentionVersion)); }
  recountMentionIndexStatus(sourceId: string, recount: entityReadsImpl.MentionIndexRecount) { return entityReadsImpl.recountMentionIndexStatus(this.autocommitSql, sourceId, recount); }
  readSegmentedPageSealed(sourceId: string, slug: string) { return segmentDeriveStoreImpl.readSegmentedPageSealed(this, sourceId, slug); }
  storeSegmentDerivationsIfLive(pageId: number, generation: number, rows: readonly segmentDeriveStoreImpl.SegmentDerivationStoreRow[]) { return segmentDeriveStoreImpl.storeSegmentDerivationsIfLive(this, pageId, generation, rows); }
  listMentionSourceIds() { return mentionPassImpl.listMentionSourceIds(this); }
  writeMentionIndexStatus(sourceId: string, patch: mentionPassImpl.MentionStatusPatch) { return mentionPassImpl.writeMentionIndexStatus(this, sourceId, patch); }
  lockMentionSources(sourceIds: readonly string[], shared: boolean) { return mentionPassImpl.lockMentionSources(this, sourceIds, shared); }
  listMentionLinkOrigins(sourceId: string) { return mentionPassImpl.listMentionLinkOrigins(this, sourceId); }
  deleteSourceMentionLinks(sourceId: string, origins: readonly string[] | null) { return mentionPassImpl.deleteSourceMentionLinks(this, sourceId, origins); }
  clearMentionSourceIndex(sourceId: string) { return mentionPassImpl.clearMentionSourceIndex(this, sourceId); }
  listStaleDerivedAliasSlugs(sourceId: string, types: readonly string[]) { return mentionPassImpl.listStaleDerivedAliasSlugs(this, sourceId, types); }
  deleteDerivedAliasesForSlugs(sourceId: string, slugs: readonly string[]) { return mentionPassImpl.deleteDerivedAliasesForSlugs(this, sourceId, slugs); }
  listAliasDuePages(sourceId: string, types: readonly string[], after: number, version: number, limit: number) { return mentionPassImpl.listAliasDuePages(this, sourceId, types, after, version, limit); }
  listDerivedAliasRows(sourceId: string, slugs: readonly string[]) { return mentionPassImpl.listDerivedAliasRows(this, sourceId, slugs); }
  readMentionPageRevisions(ids: readonly number[], opts: { forShare: boolean }) { return mentionPassImpl.readMentionPageRevisions(this, ids, opts); }
  insertDerivedAliasRows(sourceId: string, rows: readonly mentionPassImpl.DerivedAliasInsertRow[]) { return mentionPassImpl.insertDerivedAliasRows(this, sourceId, rows); }
  upsertPageAliasState(sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number) { return mentionPassImpl.upsertPageAliasState(this, sourceId, pages, version); }
  listMentionCandidatePages(sourceIds: readonly string[], after: number, limit: number, patterns: readonly string[] | null) { return mentionPassImpl.listMentionCandidatePages(this, sourceIds, after, limit, patterns); }
  listGazetteerEntryKeys(sourceId: string) { return mentionPassImpl.listGazetteerEntryKeys(this, sourceId); }
  listMentionLinkersOfTargets(sourceId: string, slugs: readonly string[]) { return mentionPassImpl.listMentionLinkersOfTargets(this, sourceId, slugs); }
  lockMentionEntries(sourceId: string) { return mentionPassImpl.lockMentionEntries(this, sourceId); }
  applyGazetteerEntryChanges(sourceId: string, removed: readonly mentionPassImpl.GazetteerEntryKeyRow[], added: readonly mentionPassImpl.GazetteerEntryKeyRow[]) { return mentionPassImpl.applyGazetteerEntryChanges(this, sourceId, removed, added); }
  resetMentionRevisions(by: mentionPassImpl.MentionResetBy) { return mentionPassImpl.resetMentionRevisions(this, by); }
  readMentionGenerations(sourceIds: readonly string[], lock: boolean) { return mentionPassImpl.readMentionGenerations(this, sourceIds, lock); }
  listMentionDuePages(sourceId: string, version: number, after: number, limit: number) { return mentionPassImpl.listMentionDuePages(this, sourceId, version, after, limit); }
  listPageOutLinks(ids: readonly number[]) { return mentionPassImpl.listPageOutLinks(this, ids); }
  deleteLinksById(ids: readonly number[]) { return mentionPassImpl.deleteLinksById(this, ids); }
  upsertPageMentionState(sourceId: string, pages: ReadonlyArray<{ id: number; revision: string }>, version: number, generation: string) { return mentionPassImpl.upsertPageMentionState(this, sourceId, pages, version, generation); }
  readMentionStatusStates(sourceIds: readonly string[]) { return mentionPassImpl.readMentionStatusStates(this, sourceIds); }
  readMentionPolicyFingerprints(sourceIds: readonly string[]) { return mentionPassImpl.readMentionPolicyFingerprints(this, sourceIds); }
  resetSourceMentionIndexRevisions(sourceId: string) { return mentionPassImpl.resetSourceMentionIndexRevisions(this, sourceId); }
  listLivePageSourceIds() { return mentionReadsImpl.listLivePageSourceIds(this); }
  listGazetteerPages(types: readonly string[], handleKeys: readonly [string, string, string, string]) { return mentionReadsImpl.listGazetteerPages(this, types, handleKeys); }
  listGazetteerAliases(types: readonly string[]) { return mentionReadsImpl.listGazetteerAliases(this, types); }
  readPageStampTimes(slugs: readonly string[], sourceIds: readonly string[]) { return mentionReadsImpl.readPageStampTimes(this, slugs, sourceIds); }
  readPageRevisionForShare(sourceId: string, slug: string) { return mentionReadsImpl.readPageRevisionForShare(this, sourceId, slug); }
  readExplainPage(sourceId: string, slug: string) { return mentionReadsImpl.readExplainPage(this, sourceId, slug); }
  readExplainScanPage(sourceId: string, slug: string, version: number) { return mentionReadsImpl.readExplainScanPage(this, sourceId, slug, version); }
  countMentionLinksTo(pageId: number, sourceId: string, targets: readonly string[]) { return mentionReadsImpl.countMentionLinksTo(this, pageId, sourceId, targets); }
  readPageNameText(sourceId: string, slug: string) { return mentionReadsImpl.readPageNameText(this, sourceId, slug); }
  listFrontmatterAliasNorms(sourceId: string, slug: string) { return mentionReadsImpl.listFrontmatterAliasNorms(this, sourceId, slug); }
  listRejectedDeclarationPages(sourceId: string, types: readonly string[], pattern: string) { return mentionReadsImpl.listRejectedDeclarationPages(this, sourceId, types, pattern); }
  countPagesDueForMentions(q: entityReadsImpl.MentionDueQuery) { return this.preparationRead(exec => entityReadsImpl.countPagesDueForMentions(unscopedExecutor(exec, 'entities: mention-due count ran unscoped through executeRaw'), q)); }
  readIdentitySiblingCandidates(sourceId: string, q: entityReadsImpl.SiblingCandidateQuery) { return this.preparationRead(exec => entityReadsImpl.readIdentitySiblingCandidates(unscopedExecutor(exec, 'entities: sibling candidates ran unscoped through executeRaw'), sourceId, q)); }
  readSiblingGroupRows(sourceId: string, slugs: readonly string[], opts?: { excludePrivate?: boolean }) { return this.preparationRead(exec => entityReadsImpl.readSiblingGroupRows(unscopedExecutor(exec, 'entities: sibling group rows ran unscoped through executeRaw'), sourceId, slugs, opts)); }
  findExactSlug(sourceId: string, slugs: readonly string[], opts?: { retired?: boolean }) { return this.preparationRead(exec => entityReadsImpl.findExactSlug(unscopedExecutor(exec, 'entities: exact slug ran unscoped through executeRaw'), sourceId, slugs, opts)); }
  readLiveSlugs(sourceId: string, slugs: readonly string[], opts?: { limit?: 2 }) { return this.preparationRead(exec => entityReadsImpl.readLiveSlugs(unscopedExecutor(exec, 'entities: live slug read ran unscoped through executeRaw'), sourceId, slugs, opts)); }
  readLivePageTypes(sourceId: string, slugs: readonly string[], privacy: entityReadsImpl.ResolverPrivacy) { return this.preparationRead(exec => entityReadsImpl.readLivePageTypes(unscopedExecutor(exec, 'entities: live page type read ran unscoped through executeRaw'), sourceId, slugs, privacy)); }
  readTrigramCandidates(sourceId: string, q: entityReadsImpl.TrigramCandidateQuery) { return this.preparationRead(exec => entityReadsImpl.readTrigramCandidates(unscopedExecutor(exec, 'entities: trigram candidate read ran unscoped through executeRaw'), sourceId, q)); }
  readPrefixCandidates(sourceId: string, q: entityReadsImpl.PrefixCandidateQuery) { return this.preparationRead(exec => entityReadsImpl.readPrefixCandidates(unscopedExecutor(exec, 'entities: prefix candidate read ran unscoped through executeRaw'), sourceId, q)); }
  readPrefixDirs(sourceId: string, patterns: readonly string[]) { return this.preparationRead(exec => entityReadsImpl.readPrefixDirs(unscopedExecutor(exec, 'entities: prefix directory read ran unscoped through executeRaw'), sourceId, patterns)); }
  readPrefixTitleMatches(sourceId: string, patterns: readonly string[], title: string) { return this.preparationRead(exec => entityReadsImpl.readPrefixTitleMatches(unscopedExecutor(exec, 'entities: prefix title read ran unscoped through executeRaw'), sourceId, patterns, title)); }
  readNamedEntitySlugs(sourceId: string, slugs: readonly string[], privacy: entityReadsImpl.ResolverPrivacy) { return this.preparationRead(exec => entityReadsImpl.readNamedEntitySlugs(unscopedExecutor(exec, 'entities: named entity read ran unscoped through executeRaw'), sourceId, slugs, privacy)); }
  findFuzzyEntityCandidates(sourceId: string, title: string, fragment: string) { return this.preparationRead(exec => entityReadsImpl.findFuzzyEntityCandidates(unscopedExecutor(exec, 'entities: fuzzy lookup ran unscoped through executeRaw'), sourceId, title, fragment)); }
  findExactBasenameCandidates(sourceId: string, slugs: readonly string[]) { return this.preparationRead(exec => entityReadsImpl.findExactBasenameCandidates(unscopedExecutor(exec, 'entities: exact basename ran unscoped through executeRaw'), sourceId, slugs)); }
  readRetirementHop(sourceId: string, slug: string, privacy: entityReadsImpl.RetirementPrivacy) { return this.preparationRead(exec => entityReadsImpl.readRetirementHop(unscopedExecutor(exec, 'entities: retirement hop ran unscoped through executeRaw'), sourceId, slug, privacy)); }
  readEntityCardRows(sourceId: string, match: entityReadsImpl.EntityCardMatch, opts?: { excludePrivate?: boolean }) { return this.preparationRead(exec => entityReadsImpl.readEntityCardRows(unscopedExecutor(exec, 'entities: entity card candidates ran unscoped through executeRaw'), sourceId, match, opts)); }
  listUnretiredPagesBySlugPattern(sourceId: string, patterns: readonly string[], limit: number) { return this.preparationRead(exec => entityReadsImpl.listUnretiredPagesBySlugPattern(unscopedExecutor(exec, 'entities: slug pattern pages ran unscoped through executeRaw'), sourceId, patterns, limit)); }
  listNameVariantCandidates(sourceId: string, q: entityReadsImpl.NameVariantCandidateQuery) { return this.preparationRead(exec => entityReadsImpl.listNameVariantCandidates(unscopedExecutor(exec, 'entities: name variant candidates ran unscoped through executeRaw'), sourceId, q)); }
  countDistinctInboundLinkers(sourceIds: readonly string[], slugs: readonly string[]) { return this.preparationRead(exec => entityReadsImpl.countDistinctInboundLinkers(unscopedExecutor(exec, 'entities: inbound linkers ran unscoped through executeRaw'), sourceIds, slugs)); }
  readExtractionLagCounts(q: entityReadsImpl.ExtractionLagQuery) { return entityReadsImpl.readExtractionLagCounts(this, q); }
  readIgnoredPrivacyLabelPages(sourceId: string, scope: { slugs: readonly string[] } | { since: string }, opts?: { limit?: number; timeoutMs?: number }) { return entityReadsImpl.readIgnoredPrivacyLabelPages(this, sourceId, scope, opts); }
  readLivePageFrontmatter(sourceId: string, slug: string, opts?: { timeoutMs?: number }) { return entityReadsImpl.readLivePageFrontmatter(this, sourceId, slug, opts); }
  readEntityAnchoredPages(sourceId: string, entitySlug: string) { return entityReadsImpl.readEntityAnchoredPages(this, sourceId, entitySlug); }
  readPageTitlesById(ids: readonly number[]) { return entityReadsImpl.readPageTitlesById(this, ids); }
  readTextMentionPages(sourceIds: readonly string[], slugs: readonly string[]) { return entityReadsImpl.readTextMentionPages(this, sourceIds, slugs); }
  listLocalPathSources() { return sourcesImpl.listLocalPathSources(unscopedExecutor(this.engineSql, 'sources: source resolution read it unscoped through executeRaw')); }
  listSourcePathRows() { return sourcesImpl.listSourcePathRows(unscopedExecutor(this.engineSql, 'sources: sources add read it unscoped through executeRaw')); }
  readPlainSyncSource(sourceId: string) { return sourcesImpl.readPlainSyncSource(unscopedExecutor(this.engineSql, 'sources: plain-directory sync read it unscoped through executeRaw'), sourceId); }
  readOwnerOnlySourcesPresent() { return sourcesImpl.readOwnerOnlySourcesPresent(unscopedExecutor(this.engineSql, 'sources: the owner-only check read it unscoped through executeRaw'), ownerOnlyLineageReadable(this)); }
  readOwnerOnlySourceConfig(sourceId: string) { return sourcesImpl.readOwnerOnlySourceConfig(unscopedExecutor(this.engineSql, 'sources: the owner-only check read it unscoped through executeRaw'), sourceId); }
  listSourceRoutingRows() { return sourcesImpl.listSourceRoutingRows(unscopedExecutor(this.engineSql, 'sources: source resolution read it unscoped through executeRaw')); }
  countDefaultSourceSplit() { return sourcesImpl.countDefaultSourceSplit(unscopedExecutor(this.engineSql, 'sources: the default-write guard read it unscoped through executeRaw')); }
  listStaleSyncSourceIds() { return sourcesImpl.listStaleSyncSourceIds(unscopedExecutor(this.engineSql, 'sources: the advisor read it unscoped through executeRaw')); }
  listSourceIds() { return this.engineSqlRead(exec => sourcesImpl.listSourceIds(unscopedExecutor(exec, 'sources: get_backlinks read it unscoped through executeRaw'))); }
  readSoleSourceId() { return this.engineSqlRead(exec => sourcesImpl.readSoleSourceId(unscopedExecutor(exec, 'sources: the corpus source check read it unscoped through executeRaw'))); }
  readFirstSourceId() { return this.engineSqlRead(exec => sourcesImpl.readFirstSourceId(unscopedExecutor(exec, 'sources: doctor origin_twins read it unscoped through executeRaw'))); }
  lockAllSourceRows(mode: 'update' | 'share') { return sourcesImpl.lockAllSourceRows(this.autocommitSql, mode); }
  readSourceRow(sourceId: string) { return sourcesImpl.readSourceRow(unscopedExecutor(this.engineSql, 'sources: source checks read it unscoped through executeRaw'), sourceId); }
  readLiveSlugAliases(sourceId: string, targets: readonly string[]) { return this.engineSqlRead(exec => linkSlugReadsImpl.readLiveSlugAliases(unscopedExecutor(exec, 'link preparation: the live alias targets read unscoped through executeRaw'), sourceId, targets)); }
  readSourceSlugProbe(sourceId: string, afterId: number) { return this.engineSqlRead(exec => linkSlugReadsImpl.readSourceSlugProbe(unscopedExecutor(exec, 'link preparation: the source slug fingerprint read unscoped through executeRaw'), sourceId, afterId)); }
  readStoredSlugSpellings(key: string, scope: slugSpellingsImpl.StoredSpellingScope, after: string, keys?: readonly string[] | null) { return this.engineSqlRead(exec => slugSpellingsImpl.readStoredSlugSpellings(unscopedExecutor(exec, 'slug params: the stored-spelling scan read unscoped through executeRaw'), key, scope, after, keys)); }
  lockSourceRow(sourceId: string) { return sourcesImpl.lockSourceRow(this.autocommitSql, sourceId); }
  lockSourceForUpdate(sourceId: string) { return sourcesImpl.lockSourceForUpdate(this.autocommitSql, sourceId); }
  isSourceClaimed(sourceId: string) { return sourcesImpl.isSourceClaimed(unscopedExecutor(this.engineSql, 'sources: sync-authority read the claim unscoped through executeRaw'), sourceId); }
  readSourceChunkerVersion(sourceId: string) { return sourcesImpl.readSourceChunkerVersion(unscopedExecutor(this.engineSql, 'sources: sync preflight read it unscoped through executeRaw'), sourceId); }
  setSourceChunkerVersion(sourceId: string, version: string) { return sourcesImpl.setSourceChunkerVersion(this.autocommitSql, sourceId, version); }
  markSourceSynced(sourceId: string, opts?: sourcesImpl.SourceSyncStampOptions) { return sourcesImpl.markSourceSynced(this.autocommitSql, sourceId, opts); } // autocommitSql: keeps executeRaw's read-only-default retry (#7183)
  advanceSyncCheckpoint(input: sourcesImpl.SyncCheckpointAdvance) { return sourcesImpl.advanceSyncCheckpoint(this.autocommitSql, input); }
  renameSource(sourceId: string, name: string) { return sourcesImpl.renameSource(this.autocommitSql, sourceId, name); }
  readFederationExposedPages(sourceId: string, hidePrivate: boolean) { return federationExposureImpl.readFederationExposedPages(unscopedExecutor(this.engineSql, 'federation warning: the exposed pages read unscoped through executeRaw'), sourceId, hidePrivate); }
  countSourcePages(sourceId: string, opts?: { includeDeleted?: boolean }) { return sourcesImpl.countSourcePages(unscopedExecutor(this.engineSql, 'sources: source commands counted pages unscoped through executeRaw'), sourceId, opts); }
  readSourcesNotReadable(readable: readonly string[], opts: sourcesImpl.SourcesNotReadableOpts) { return sourcesImpl.readSourcesNotReadable(unscopedExecutor(this.engineSql, 'sources: unscoped remote reads checked other sources through executeRaw'), readable, opts); }
  insertSource(row: sourcesImpl.SourceInsert) { return sourcesImpl.insertSource(this.autocommitSql, row); }
  deleteSourceRecord(sourceId: string, opts?: { expiredArchiveOnly?: boolean }) { return sourcesImpl.deleteSourceRecord(this.autocommitSql, sourceId, opts); }
  readSourceDeleteImpact(sourceId: string) { return sourcesImpl.readSourceDeleteImpact(unscopedExecutor(this.engineSql, 'sources: the source delete preview counted rows unscoped through executeRaw'), sourceId); }
  readPageSizeRows(sourceId: string, maxBytes: number, slugs: readonly string[] | null) { return sourcesImpl.readPageSizeRows(unscopedExecutor(this.engineSql, 'sources: the sync size-state read ran it unscoped through executeRaw'), sourceId, maxBytes, slugs); }
  holdPageEmbedding(pageId: number, reason: string) { return sourcesImpl.holdPageEmbedding(this.autocommitSql, pageId, reason); }
  readReasonPurgeTombstones(sourceId: string, pair?: sourcesImpl.ReasonPurgeTombstone) { return sourcesImpl.readReasonPurgeTombstones(unscopedExecutor(this.engineSql, 'sources: the purged change-reason reads ran it unscoped through executeRaw'), sourceId, pair); }
  writeReasonPurgeTombstones(sourceId: string, pairs: readonly sourcesImpl.ReasonPurgeTombstone[]) { return sourcesImpl.writeReasonPurgeTombstones(this.autocommitSql, sourceId, pairs); }
  insertReasonPurgeTombstones(sourceId: string, commits: string[], paths: string[]) { return this.writeReasonPurgeTombstones(sourceId, commits.map((commit_sha, i) => ({ commit_sha, path: paths[i]! }))); }
  listSourcePathPages(sourceId: string) { return sourcesImpl.listSourcePathPages(unscopedExecutor(this.engineSql, 'sources: full sync read it unscoped through executeRaw'), sourceId); }
  listQuarantinedSlugs(sourceId: string) { return sourcesImpl.listQuarantinedSlugs(unscopedExecutor(this.engineSql, 'sources: extraction read it unscoped through executeRaw'), sourceId); }
  readRenameIdentityRows(sourceId: string, paths: readonly string[], slugs: readonly string[]) { return sourcesImpl.readRenameIdentityRows(unscopedExecutor(this.engineSql, 'sources: the rename identity check read it unscoped through executeRaw'), sourceId, paths, slugs); }
  readLiveIdentityHolders(sourceId: string, ids: readonly string[], titles: readonly string[]) { return sourcesImpl.readLiveIdentityHolders(unscopedExecutor(this.engineSql, 'sources: the rename identity check read it unscoped through executeRaw'), sourceId, ids, titles); }
  writeSourceSyncHeartbeat(sourceId: string) { return sourcesImpl.writeSourceSyncHeartbeat(this.autocommitSql, sourceId); }
  writeSourceUpstreamObservation(sourceId: string, observed: sourcesImpl.SourceUpstreamObservation) { return sourcesImpl.writeSourceUpstreamObservation(this.autocommitSql, sourceId, observed); }
  readPageIdentity(pageId: number) { return sourcesImpl.readPageIdentity(unscopedExecutor(this.engineSql, 'sources: the held-rename redecision read a page identity unscoped through executeRaw'), pageId); }
  readSourceLastCommit(sourceId: string) { return sourcesImpl.readSourceLastCommit(unscopedExecutor(this.engineSql, 'sources: the resident notifier read the last commit unscoped through executeRaw'), sourceId); }
  advanceSourcePurgeEpoch(sourceId: string) { return sourcesImpl.advanceSourcePurgeEpoch(this.autocommitSql, sourceId); }
  advanceSourceCommit(sourceId: string, commit: string, newestContentAt?: string | null) { return sourcesImpl.advanceSourceCommit(this.autocommitSql, sourceId, commit, newestContentAt); }
  async countRepoBoundSources(): Promise<number> {
    return this.preparationRead(exec => sourcesImpl.countRepoBoundSources(unscopedExecutor(exec, 'sources: unscoped on master (the readiness sync probe read it through executeRaw)')));
  }

  async claimNotifierLease(l: notifierImpl.NotifierLeaseClaimInput): Promise<notifierImpl.NotifierLeaseClaim> {
    return notifierImpl.claimNotifierLease(this.autocommitSql, l);
  }

  async readNotifierLease(hostId: string): Promise<notifierImpl.NotifierLeaseHolder | null> {
    return notifierImpl.readNotifierLease(this.autocommitSql, hostId);
  }

  async holdsNotifierLease(hostId: string, ownerId: string, fence: number): Promise<boolean> {
    return notifierImpl.holdsNotifierLease(this.autocommitSql, hostId, ownerId, fence);
  }

  async releaseNotifierLease(hostId: string, ownerId: string): Promise<void> {
    return notifierImpl.releaseNotifierLease(this.autocommitSql, hostId, ownerId);
  }

  async listNotifierHostSourceRows(): Promise<notifierImpl.NotifierHostSourceRow[]> {
    return this.preparationRead(exec => notifierImpl.listNotifierHostSourceRows(unscopedExecutor(exec, 'notifier: unscoped on master (the resident read its host sources through executeRaw)')));
  }

  async readNotifierSources(sourceIds: string[] | null): Promise<notifierImpl.NotifierSourceRow[]> {
    return notifierImpl.readNotifierSources(this.autocommitSql, sourceIds);
  }

  async writeNotifierState(sourceId: string, patch: notifierImpl.StatePatch): Promise<void> {
    return notifierImpl.writeNotifierState(this.autocommitSql, sourceId, patch);
  }

  async writeNotifierCoverage(sourceId: string, coverage: notifierImpl.Coverage): Promise<void> {
    return notifierImpl.writeNotifierCoverage(this.autocommitSql, sourceId, coverage);
  }

  async recordNotifierSyncerHost(sourceId: string, hostId: string): Promise<void> {
    return notifierImpl.recordNotifierSyncerHost(this.autocommitSql, sourceId, hostId);
  }

  async readNotifierStatusRows(sourceIds: string[] | null): Promise<notifierImpl.NotifierStatusRow[]> {
    return this.preparationRead(exec => notifierImpl.readNotifierStatusRows(unscopedExecutor(exec, 'notifier: unscoped on master (the freshness notice read its status rows through executeRaw)'), sourceIds));
  }

  async hasNotifierCoverage(): Promise<boolean> {
    return whenNotAborted(() => this.preparationRead(exec => notifierImpl.hasNotifierCoverage(exec)));
  }

  async upsertWantedMarker(marker: notifierImpl.WantedMarkerInput): Promise<notifierImpl.WantedMarker | null> {
    return notifierImpl.upsertWantedMarker(this.autocommitSql, marker);
  }

  async attachWantedMarkerJob(sourceId: string, intent: notifierImpl.MarkerIntent, generation: number, jobId: number): Promise<void> {
    return notifierImpl.attachWantedMarkerJob(this.autocommitSql, sourceId, intent, generation, jobId);
  }

  async readWantedMarkers(sourceIds: string[] | null): Promise<notifierImpl.WantedMarker[]> {
    return notifierImpl.readWantedMarkers(this.autocommitSql, sourceIds);
  }

  async readDueWantedMarkers(sourceIds: string[] | null): Promise<notifierImpl.WantedMarker[]> {
    return notifierImpl.readDueWantedMarkers(this.autocommitSql, sourceIds);
  }

  async pruneSatisfiedWantedMarkers(sourceIds: string[]): Promise<void> {
    return notifierImpl.pruneSatisfiedWantedMarkers(this.autocommitSql, sourceIds);
  }

  async clearWantedMarker(sourceId: string, intent: notifierImpl.MarkerIntent, generation: number): Promise<boolean> {
    return notifierImpl.clearWantedMarker(this.autocommitSql, sourceId, intent, generation);
  }

  async settleFreshnessMarker(sourceId: string, generation: number, checkoutHead: string | null): Promise<void> {
    return notifierImpl.settleFreshnessMarker(this.autocommitSql, sourceId, generation, checkoutHead);
  }

  async listSourceWantedMarkers(sourceId: string): Promise<notifierImpl.PendingWantedMarker[]> {
    return notifierImpl.listSourceWantedMarkers(this.autocommitSql, sourceId);
  }
  async readFirstDue(sourceIds: string[]): Promise<notifierImpl.FirstDueRow[]> { return notifierImpl.readFirstDue(this.autocommitSql, sourceIds); }

  async readSourceSyncShape(sourceId: string): Promise<notifierImpl.SourceSyncShapeRow | null> {
    return notifierImpl.readSourceSyncShape(this.autocommitSql, sourceId);
  }

  readDrainHolderProgress(sourceId: string, since: string) { return persistenceJournalImpl.readDrainHolderProgress(unscopedExecutor(this.engineSql, 'drain lease: the lease reading read the holder progress unscoped through executeRaw'), sourceId, since); }
  async readNotifierFirstDue(sourceIds: string[]): Promise<notifierImpl.NotifierFirstDueRow[]> {
    return notifierImpl.readNotifierFirstDue(this.autocommitSql, sourceIds);
  }

  async listSourceLocalPaths(): Promise<string[]> {
    return this.preparationRead(exec => sourcesImpl.listSourceLocalPaths(unscopedExecutor(exec, 'sources: unscoped on master (the filesystem lock read it through executeRaw)')));
  }

  // The CLI import and extract reads that ran unscoped through executeRaw (engine-sql/cli-reads-import.ts), on the current connection.
  private get cliReads() { return unscopedExecutor(this.engineSql, 'cli reads: the import and extract paths ran these unscoped through executeRaw'); }
  listSourceRecords() { return cliReadsImpl.listSourceRecords(this.cliReads); }
  readSourceIncarnation(sourceId: string) { return this.engineSqlRead(exec => cliReadsImpl.readSourceIncarnation(unscopedExecutor(exec, 'cli reads: the import and extract paths ran these unscoped through executeRaw'), sourceId)); }
  readSyncDispatchRow(sourceId: string) { return syncDispatchImpl.readSyncDispatchRow(this, sourceId); }
  readRetainedSources(sourceIds: readonly string[]) { return this.engineSqlRead(exec => cliReadsImpl.readRetainedSources(unscopedExecutor(exec, 'cli reads: the import and extract paths ran these unscoped through executeRaw'), sourceIds)); }
  listLiveSlugSourceIds(slug: string) { return listReadsImpl.listLiveSlugSourceIds(this.executeRaw.bind(this), slug); }
  resolveChainAnchorRows(slug: string, policy: PageReadPolicy) { return listReadsImpl.resolveChainAnchorRows(this.executeRaw.bind(this), slug, policy); }
  probeTargetRows(slug: string, policy: PageReadPolicy, chunkManifest?: boolean) { return listReadsImpl.probeTargetRows(this.executeRaw.bind(this), slug, policy, chunkManifest); }
  readCompanyBrainEvidenceRows(sourceId: string) { return listReadsImpl.readCompanyBrainEvidenceRows(this.executeRaw.bind(this), sourceId); }
  listCardRows(query: listReadsImpl.CardListQuery) { return listReadsImpl.listCardRows(this.executeRaw.bind(this), query); }
  readShelfPageRows(sourceId: string) { return listReadsImpl.readShelfPageRows(this.executeRaw.bind(this), sourceId); }
  findCardRows(q: listReadsImpl.CardFindQuery) { return listReadsImpl.findCardRows(this.executeRaw.bind(this), q); }
  readFirstLiveSlugAtPath(path: string) { return listReadsImpl.readFirstLiveSlugAtPath(this.executeRaw.bind(this), path); }
  listPathTwinSlugs(sourceId: string, paths: readonly string[]) { return listReadsImpl.listPathTwinSlugs(this.executeRaw.bind(this), sourceId, paths); }
  listLiveSlugOrigins(slugs: readonly string[], sourceId?: string) { return listReadsImpl.listLiveSlugOrigins(this.executeRaw.bind(this), slugs, sourceId); }
  probeRetypeRows(query: listReadsImpl.RetypeProbeQuery) { return listReadsImpl.probeRetypeRows(this.executeRaw.bind(this), query); }
  listAliasCandidatePages(type: string, sourceId: string, limit: number) { return listReadsImpl.listAliasCandidatePages(this.executeRaw.bind(this), type, sourceId, limit); }
  listLinkCandidatePages(type: string, sourceId: string | undefined, limit: number) { return listReadsImpl.listLinkCandidatePages(this.executeRaw.bind(this), type, sourceId, limit); }
  countLivePagesByType(scope: listReadsImpl.SourceIdScope) { return listReadsImpl.countLivePagesByType(this.executeRaw.bind(this), scope); }
  listTypeOrphanRows(scope: listReadsImpl.SourceIdScope, undeclared: readonly string[], limit: number) { return listReadsImpl.listTypeOrphanRows(this.executeRaw.bind(this), scope, undeclared, limit); }
  readStaleMentionScan(limit: number) { return listReadsImpl.readStaleMentionScan(this.executeRaw.bind(this), limit); }
  readClockMillisText() { return listReadsImpl.readClockMillisText(this.executeRaw.bind(this)); }
  listLiveSourceIncarnations(ids: readonly string[]) { return listReadsImpl.listLiveSourceIncarnations(this.executeRaw.bind(this), ids); }
  readAttendanceWindow(sourceId: string, afterSlug: string, limit: number) { return listReadsImpl.readAttendanceWindow(this.executeRaw.bind(this), sourceId, afterSlug, limit); }
  listEmailAliasPages(aliasNorm: string, sourceId: string) { return listReadsImpl.listEmailAliasPages(this.executeRaw.bind(this), aliasNorm, sourceId); }
  readUploadSessionByRequest(principalKind: string, principalId: string, clientRequestId: string) { return listReadsImpl.readUploadSessionByRequest(this.executeRaw.bind(this), principalKind, principalId, clientRequestId); }
  readSourceIncarnationArchived(sourceId: string) { return listReadsImpl.readSourceIncarnationArchived(this.executeRaw.bind(this), sourceId); }
  listEnabledLabelledOnlyMemberIds() { return listReadsImpl.listEnabledLabelledOnlyMemberIds(this.executeRaw.bind(this)); }
  readChatCensusRows(sourceIds: readonly string[], chatTypes: readonly string[], dmTypes: readonly string[], hidePrivate: boolean) { return listReadsImpl.readChatCensusRows(this.executeRaw.bind(this), sourceIds, chatTypes, dmTypes, hidePrivate); }
  readWhoCanReadRows(slug: string, sourceId: string | undefined, form: 'closed' | 'fn' | 'mode') { return listReadsImpl.readWhoCanReadRows(this.executeRaw.bind(this), slug, sourceId, form); }
  readPageAccessAllowed(sourceId: string, slug: string, identity: readonly string[]) { return listReadsImpl.readPageAccessAllowed(this.executeRaw.bind(this), sourceId, slug, identity); }
  readPageFolderRulesAllowed(sourceId: string, slug: string, satisfied: readonly string[]) { return listReadsImpl.readPageFolderRulesAllowed(this.executeRaw.bind(this), sourceId, slug, satisfied); }
  countLineageClosingRules(ruleIds: readonly string[], sourceId: string) { return listReadsImpl.countLineageClosingRules(this.executeRaw.bind(this), ruleIds, sourceId); }
  readOpCheckpointCompletedKeys(op: string, fingerprint: string) { return listReadsImpl.readOpCheckpointCompletedKeys(this.executeRaw.bind(this), op, fingerprint); }
  readForecastPredictions(q: listReadsImpl.PredictionQuery) { return listReadsImpl.readForecastPredictions(this.executeRaw.bind(this), q); }
  readPredictionLedgerEvents(sourceIds: readonly string[], slugs: readonly string[]) { return listReadsImpl.readPredictionLedgerEvents(this.executeRaw.bind(this), sourceIds, slugs); }
  readTakeHorizonRows(takeIds: readonly number[] | null) { return listReadsImpl.readTakeHorizonRows(this.executeRaw.bind(this), takeIds); }
  readLatestTakeGrades(takeIds: readonly number[]) { return listReadsImpl.readLatestTakeGrades(this.executeRaw.bind(this), takeIds); }
  readBeliefCoverageEvents(sourceId: string) { return beliefLedgerImpl.readBeliefCoverageEvents(this, sourceId); }
  hasCompanyBrainReceipt(sourceId: string) { return cliReadsImpl.hasCompanyBrainReceipt(this.cliReads, sourceId); }
  readGuestSourceRow(sourceId: string) { return cliReadsImpl.readGuestSourceRow(this.cliReads, sourceId); }
  listGuestSourceIds(sourceIds: readonly string[]) { return this.preparationRead(exec => cliReadsImpl.listGuestSourceIds(unscopedExecutor(exec, 'cli reads: the import and extract paths ran these unscoped through executeRaw'), sourceIds)); }
  hasGuestSource() { return cliReadsImpl.hasGuestSource(this.cliReads); }
  readPageTrustRows(lookup: PageTrustLookup) { return cliReadsImpl.readPageTrustRows(this.cliReads, lookup); }
  readRowTrustRows(lookup: RowTrustLookup) { return cliReadsImpl.readRowTrustRows(this.cliReads, lookup); }
  readDatabaseClock() { return this.preparationRead(exec => cliReadsImpl.readDatabaseClock(unscopedExecutor(exec, 'cli reads: the import and extract paths ran these unscoped through executeRaw'))); }
  /** Page-write reads (engine-sql/write-misc.ts); a preparation read ends at its deadline, a locked read runs in the caller's transaction. */
  private get writeMiscReads() { return unscopedExecutor(this.engineSql, 'write misc: page writes ran these unscoped through executeRaw'); }
  private writeMiscRead<T>(fn: (exec: ReturnType<typeof unscopedExecutor>) => Promise<T>) {
    return this.preparationRead(exec => fn(unscopedExecutor(exec, 'write misc: page writes ran these unscoped through executeRaw')));
  }
  readSourceState(sourceId: string, opts?: writeMiscImpl.SourceStateOptions) {
    return opts?.lock === 'share' ? writeMiscImpl.readSourceState(this.writeMiscReads, sourceId, opts) : this.writeMiscRead(exec => writeMiscImpl.readSourceState(exec, sourceId, opts));
  }
  readAdmissionSource(sourceId: string) { return this.writeMiscRead(exec => writeMiscImpl.readAdmissionSource(exec, sourceId)); }
  sharedSkillPackTablePresent() { return this.writeMiscRead(exec => writeMiscImpl.sharedSkillPackTablePresent(exec)); }
  listSharedSkillPackRoots(hostId: string) { return this.writeMiscRead(exec => writeMiscImpl.listSharedSkillPackRoots(exec, hostId)); }
  getWorktreeBinding(sourceId: string, hostId: string | null) { return this.writeMiscRead(exec => writeMiscImpl.getWorktreeBinding(exec, sourceId, hostId)); }
  listHostTopologyRows(hostId: string) { return this.writeMiscRead(exec => writeMiscImpl.listHostTopologyRows(exec, hostId)); }
  listWorktreeMembers(worktreeId: string) { return this.writeMiscRead(exec => writeMiscImpl.listWorktreeMembers(exec, worktreeId)); }
  worktreeClaimStore(): Promise<WorktreeClaimStore> { return worktreeClaimImpl.worktreeClaimStore(this); }
  readWriterAdminState(opts?: WriterAdminStateOptions): Promise<string> { return writerAdminImpl.readWriterAdminState(this, opts); }
  readWorktreeManifest(worktreeId: string): Promise<StoredWorktreeManifest | null> { return writerAdminImpl.readWorktreeManifest(this, worktreeId); }
  readWriterDiagnosticRows(abandonedCutoff: string | null, excludedOrigins: readonly string[]) { return writerStatusImpl.readWriterDiagnosticRows(this, abandonedCutoff, excludedOrigins); }
  readWriterStatusRows(hostId: string | null, sourceId: string | null) { return writerStatusImpl.readWriterStatusRows(this, hostId, sourceId); }
  listOnboardingSources(sourceId: string | null) { return writerStatusImpl.listOnboardingSources(this, sourceId); }
  listBlockingEffectRows(sourceId: string | null, limit: number, recoveringOnly: boolean) { return writerStatusImpl.listBlockingEffectRows(this, sourceId, limit, recoveringOnly); }
  listActiveWorktreeRefreshRows(sourceId: string | null) { return writerStatusImpl.listActiveWorktreeRefreshRows(this, sourceId); }
  readHeadBlockerRows(ids: readonly string[], hostId: string | null, opts?: headBlockerImpl.HeadBlockerReadOpts) { return headBlockerImpl.readHeadBlockerRows(this, ids, hostId, opts); }
  readRecoveringHeadRow(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) { return headBlockerImpl.readRecoveringHeadRow(this, id, opts); }
  readIncompleteSyncReceipt(spec: checkpointValidationImpl.IncompleteSyncReceiptSpec) { return checkpointValidationImpl.readIncompleteSyncReceipt(this, spec); }
  readOpenPassWork(spec: checkpointValidationImpl.OpenPassWorkSpec) { return checkpointValidationImpl.readOpenPassWork(this, spec); }
  readIncompleteSyncReceiptRows(spec: checkpointValidationImpl.IncompleteSyncReceiptSpec) { return checkpointValidationImpl.readIncompleteSyncReceiptRows(this, spec); }
  readPrivacyOrigin(sourceId: string, slug: string) { return labelDoorImpl.readPrivacyOrigin(this, sourceId, slug); }
  listOriginDependents(origins: readonly labelDoorImpl.OriginRefInput[]) { return labelDoorImpl.listOriginDependents(this, origins); }
  listCheckoutFiles(pageIds: readonly number[]) { return labelDoorImpl.listCheckoutFiles(this, pageIds); }
  readPageLabelRow(sourceId: string, slug: string) { return labelDoorImpl.readPageLabelRow(this, sourceId, slug); }
  readLabelGuardTiers(pageId: number) { return labelDoorImpl.readLabelGuardTiers(this, pageId); }
  writePageLabelGuard(pageId: number, tier: import('./trust/tier.ts').TrustTier | null) { return labelDoorImpl.writePageLabelGuard(this, pageId, tier); }
  writerAdminStore(): Promise<WriterAdminStore> { return writerAdminImpl.writerAdminStore(this); }
  writerReleaseStore(): Promise<WriterReleaseStore> { return writerReleaseImpl.writerReleaseStore(this); }
  publicationJournalStore() { return publicationJournalImpl.publicationJournalStore(this); }
  gitDurabilityStore() { return gitDurabilityImpl.gitDurabilityStore(this); }
  gitEffectStore() { return gitEffectsImpl.gitEffectStore(this); }
  topologyStore() { return topologyStoreImpl.topologyStore(this); }
  refreshStore() { return refreshStoreImpl.refreshStore(this); }
  groupPublishStore() { return groupPublishStoreImpl.groupPublishStore(this); }
  manualLinkStore() { return manualLinksImpl.manualLinkStore(this); }
  runSyncStatement<R = Record<string, unknown>>(name: managedSyncStoreImpl.SyncStatementName, params?: readonly unknown[], opts?: managedSyncStoreImpl.SyncStatementOptions) { return managedSyncStoreImpl.runSyncStatement<R>(this, name, params, opts); }
  chronicleStore() { return chronicleExecutorImpl.chronicleStore(this); }
  addPersistenceCounters(key: string, delta: Partial<Record<CounterColumn, number>>): Promise<void> { return writerReleaseImpl.addPersistenceCounters(this, key, delta); }
  hasExtractedEvents(sourceId: string, pageId: number) { return whenNotAborted(() => writeMiscImpl.hasExtractedEvents(this.writeMiscReads, sourceId, pageId)); }
  async upsertChronicleRow(w: chronicleLedger.ChronicleRowUpsert) { return chronicleLedger.upsertChronicleRow(this, w); }
  async readChronicleRow(key: chronicleLedger.ChronicleRowKey) { return chronicleLedger.readChronicleRow(this, key); }
  async hasPendingAutoChronicleRow(sourceId: string, pageId: number, extractorVersion: number) { return chronicleLedger.hasPendingAutoChronicleRow(this, sourceId, pageId, extractorVersion); }
  async countRecentChronicleReservations() { return chronicleLedger.countRecentChronicleReservations(this); }
  async reserveChronicleJudgeSlot(limit: number, key: chronicleLedger.ChronicleJudgeKey) { return chronicleLedger.reserveChronicleJudgeSlot(this, limit, key); }
  async pruneChronicleReservations() { return chronicleLedger.pruneChronicleReservations(this); }
  async insertConfigIfAbsent(key: string, value: string) { return chronicleLedger.insertConfigIfAbsent(this, key, value); }
  async readPageTruthLead(pageId: number) { return chronicleLedger.readPageTruthLead(this, pageId); }
  listActiveAccessMembers() { return whenNotAborted(() => writeMiscImpl.listActiveAccessMembers(this.writeMiscReads)); }
  hasLabelledOnlyMember() { return whenNotAborted(() => this.engineSqlRead(exec => writeMiscImpl.hasLabelledOnlyMember(unscopedExecutor(exec, 'write misc: page writes ran these unscoped through executeRaw')))); }
  hasLabelledOnlyMemberAmong(memberIds: readonly string[]) { return whenNotAborted(() => this.engineSqlRead(exec => writeMiscImpl.hasLabelledOnlyMemberAmong(unscopedExecutor(exec, 'write misc: page writes ran these unscoped through executeRaw'), memberIds))); }
  listAccessTokens() { return whenNotAborted(() => accessCredentials.listAccessTokens(this)); }
  readOpCheckpointKeys(op: string, fingerprint: string) { return whenNotAborted(() => this.engineSqlRead(exec => writeMiscImpl.readOpCheckpointKeys(unscopedExecutor(exec, 'write misc: page writes ran these unscoped through executeRaw'), op, fingerprint))); }
  async readStoredPageHead(sourceId: string, slug: string) { return pageMutationReads.readStoredPageHead(this, sourceId, slug); }
  async readVersionSourcePath(versionId: number, pageId: number) { return pageMutationReads.readVersionSourcePath(this, versionId, pageId); }
  // Resumable-op checkpoint writes (engine-sql/op-checkpoint.ts) run on executeRawDirect and the purge on executeRaw, as op-checkpoint.ts ran them.
  writeOpCheckpointKeys(op: string, fingerprint: string, keys: string[]) { return opCheckpointImpl.writeOpCheckpointKeys(this, op, fingerprint, keys); }
  appendOpCheckpointPaths(op: string, fingerprint: string, paths: string[]) { return opCheckpointImpl.appendOpCheckpointPaths(this, op, fingerprint, paths); }
  deleteOpCheckpoint(op: string, fingerprint: string) { return opCheckpointImpl.deleteOpCheckpoint(this, op, fingerprint); }
  deleteOpCheckpointPaths(op: string, fingerprint: string) { return opCheckpointImpl.deleteOpCheckpointPaths(this, op, fingerprint); }
  readOpCheckpointRecords(op: string, fingerprints: readonly string[]) { return opCheckpointImpl.readOpCheckpointRecords(this, op, fingerprints); }
  writeOpCheckpointRecords(op: string, rows: ReadonlyArray<{ fingerprint: string; record: unknown }>) { return opCheckpointImpl.writeOpCheckpointRecords(this, op, rows); }
  readAtomGeneration(pageId: number, contentHash: string) { return atomGenerationImpl.readAtomGeneration(this, pageId, contentHash); }
  recordAtomGenerationBump(sourceId: string, incarnation: string, pageId: number, keepContentHash: string | null, keepGeneration: number | null) { return atomGenerationImpl.recordAtomGenerationBump(this, sourceId, incarnation, pageId, keepContentHash, keepGeneration); }
  readSyncImportPageRows(q: SyncImportPageQuery, window: SyncImportPageWindow) { return syncPassPagesImpl.readSyncImportPageRows(this, q, window); }
  declareSyncImportPageCursor(q: SyncImportPageQuery) { return syncPassPagesImpl.declareSyncImportPageCursor(this, q); }
  fetchSyncImportPageCursor(rows: number) { return syncPassPagesImpl.fetchSyncImportPageCursor(this, rows); }
  readAdmittedWriteRequests(principalKind: string, principalId: string, requestIds: readonly string[], committedOnly: boolean) { return syncRunReadsImpl.readAdmittedWriteRequests(this, principalKind, principalId, requestIds, committedOnly); }
  readPageRevisionWriter(pageId: number, sourceId: string) { return syncRunReadsImpl.readPageRevisionWriter(this, pageId, sourceId); }
  readRevisionWriterRequest(id: string) { return syncRunReadsImpl.readRevisionWriterRequest(this, id); }
  writeSyncAdmissionStamp(op: string, fingerprint: string, value: string) { return syncAdmissionImpl.writeSyncAdmissionStamp(this, op, fingerprint, value); }
  readSyncAdmissionEffects(input: SyncAdmissionEffectsInput) { return syncAdmissionImpl.readSyncAdmissionEffects(this, input); }
  readOpCheckpointRecord(op: string, fingerprint: string, opts?: { freshWithinDays?: number }) { return writeMiscImpl.readOpCheckpointRecord(this.writeMiscReads, op, fingerprint, opts); }
  writeOpCheckpointRecord(op: string, fingerprint: string, completedKeys: readonly unknown[] | null) { return opCheckpointImpl.writeOpCheckpointRecord(this, op, fingerprint, completedKeys); }
  listSourceIncarnations(sourceIds: readonly string[]) { return sourcesImpl.listSourceIncarnations(unscopedExecutor(this.engineSql, 'sources: repair preview hashes read it unscoped through executeRaw'), sourceIds); }
  /** Repair bookkeeping (engine-sql/repair-bookkeeping.ts): reads unscoped as before; writes and locked reads keep executeRaw's read-only retry (#7183). */
  private get repairBookkeepingReads() { return unscopedExecutor(this.engineSql, 'repair bookkeeping: the repair kinds and doctor checks ran these unscoped through executeRaw'); }
  listOrphanBindings(opts?: { limit?: number }) { return repairBookkeepingImpl.listOrphanBindings(this.repairBookkeepingReads, opts); }
  deleteOrphanBinding(binding: Pick<repairBookkeepingImpl.OrphanBinding, 'source_id' | 'source_incarnation'>) { return repairBookkeepingImpl.deleteOrphanBinding(this.autocommitSql, binding); }
  readLoopFactState(loopId: number, opts?: { lock?: boolean }) { return repairBookkeepingImpl.readLoopFactState(this.autocommitSql, loopId, opts); }
  expireSourceFactNow(factId: number, sourceId: string) { return repairBookkeepingImpl.expireSourceFactNow(this.autocommitSql, factId, sourceId); }
  listConnectorSources(opts?: { lock?: boolean }) { return repairBookkeepingImpl.listConnectorSources(this.autocommitSql, opts); }
  listOrphanConnectorCheckpoints(loadable: readonly string[], bounds: repairBookkeepingImpl.OrphanCheckpointBounds, limit: number) { return repairBookkeepingImpl.listOrphanConnectorCheckpoints(this.repairBookkeepingReads, loadable, bounds, limit); }
  countConnectorCheckpointsKeyed(keys: readonly string[]) { return repairBookkeepingImpl.countConnectorCheckpointsKeyed(this.repairBookkeepingReads, keys); }
  deleteOrphanConnectorCheckpoint(row: repairBookkeepingImpl.OrphanCheckpointRow, loadable: readonly string[], bounds: repairBookkeepingImpl.OrphanCheckpointBounds) {
    return repairBookkeepingImpl.deleteOrphanConnectorCheckpoint(this.autocommitSql, row, loadable, bounds);
  }
  listManagedSyncOrphanRows(sourceIds: readonly string[] | null) { return managedSyncOrphansImpl.listManagedSyncOrphanRows(this.repairBookkeepingReads, sourceIds); }
  listArchivedSourceIds() { return managedSyncOrphansImpl.listArchivedSourceIds(this.repairBookkeepingReads); }
  listManagedSyncFailureKeys(keys: readonly string[]) { return managedSyncOrphansImpl.listManagedSyncFailureKeys(this.repairBookkeepingReads, keys); }
  applyManagedSyncRetireLimits() { return managedSyncOrphansImpl.applyManagedSyncRetireLimits(this.autocommitSql); }
  retireManagedSyncPassSlugMode(target: managedSyncOrphansImpl.ManagedSyncRetireTarget, lockId: string) { return managedSyncOrphansImpl.retireManagedSyncPassSlugMode(this.autocommitSql, target, lockId); }
  retireManagedSyncCursor(target: managedSyncOrphansImpl.ManagedSyncRetireTarget, mode: managedSyncOrphansImpl.ManagedSyncRetireMode) { return managedSyncOrphansImpl.retireManagedSyncCursor(this.autocommitSql, target, mode); }
  deleteManagedSyncFailureRow(key: string, retired: boolean) { return managedSyncOrphansImpl.deleteManagedSyncFailureRow(this.autocommitSql, key, retired); }
  deleteManagedSyncManifest(runId: string) { return managedSyncOrphansImpl.deleteManagedSyncManifest(this.autocommitSql, runId); }
  listSourceManagedSyncFailures<F = Record<string, unknown>>(sourceId: string) { return managedSyncOrphansImpl.listSourceManagedSyncFailures<F>(this.repairBookkeepingReads, sourceId); }
  deleteManagedSyncFailureObservation(key: string, observationId: string) { return managedSyncOrphansImpl.deleteManagedSyncFailureObservation(this.autocommitSql, key, observationId); }
  listOwnedContentRows(sourceIds: readonly string[] | null, inheritsPersistence: boolean) { return ownedContentImpl.listOwnedContentRows(this.repairBookkeepingReads, sourceIds, inheritsPersistence); }
  readContentReceiptBinding(sourceId: string) { return ownedContentImpl.readContentReceiptBinding(this.repairBookkeepingReads, sourceId); }
  readConfigForUpdate(key: string) { return ownedContentImpl.readConfigForUpdate(this.autocommitSql, key); }
  /** Page repair reads (engine-sql/repair-page-reads.ts): reads unscoped as before; writes on the engine's own executor. */
  countPageChildOrphans(target: { table: string; col: string }) { return this.engineSqlRead(exec => repairPageReadsImpl.countPageChildOrphans(unscopedExecutor(exec, 'repair bookkeeping: the repair kinds and doctor checks ran these unscoped through executeRaw'), target)); }
  clearPageChildOrphans(target: { table: string; col: string }) { return repairPageReadsImpl.clearPageChildOrphans(this.autocommitSql, target); }
  probeTornPages() { return repairPageReadsImpl.probeTornPages(this.repairBookkeepingReads); }
  listAccessReaderDrift(sourceIds: readonly string[], afterId: number) { return repairPageReadsImpl.listAccessReaderDrift(this.repairBookkeepingReads, sourceIds, afterId); }
  countAccessReaderDrift() { return repairPageReadsImpl.countAccessReaderDrift(this.repairBookkeepingReads); }
  deriveAccessReaders(pageId: number) { return repairPageReadsImpl.deriveAccessReaders(this.autocommitSql, pageId); }
  readOriginIndexState() { return repairPageReadsImpl.readOriginIndexState(this.repairBookkeepingReads); }
  listOriginTwinCounts(limit: number) { return repairPageReadsImpl.listOriginTwinCounts(this.repairBookkeepingReads, limit); }
  /** Alias targets (engine-sql/alias-orphans.ts): read unscoped as before; the delete on the engine's own executor. */
  listAliasTargets(sourceIds: readonly string[] | null) { return aliasOrphansImpl.listAliasTargets(this.repairBookkeepingReads, sourceIds); }
  deleteOrphanedAliases(sourceId: string, slug: string) { return aliasOrphansImpl.deleteOrphanedAliases(this.autocommitSql, sourceId, slug); }
  listSafeChunksPending(sourceIds: readonly string[]) { return repairPageScansImpl.listSafeChunksPending(this.repairBookkeepingReads, sourceIds); }
  listOriginTwinGroups(sourceId: string, limit: number) { return repairPageScansImpl.listOriginTwinGroups(this.repairBookkeepingReads, sourceId, limit); }
  listLegacyOriginPairs(sourceId: string, prefix: string, limit: number) { return repairPageScansImpl.listLegacyOriginPairs(this.repairBookkeepingReads, sourceId, prefix, limit); }
  listLiveOriginPages(sourceId: string, paths: readonly string[]) { return repairPageScansImpl.listLiveOriginPages(this.repairBookkeepingReads, sourceId, paths); }
  listOriginClaimants(sourceId: string, ids: readonly number[]) { return repairPageScansImpl.listOriginClaimants(this.repairBookkeepingReads, sourceId, ids); }
  countLiveFileBackedPages(sourceId: string, opts?: { nonBlank?: boolean }) { return repairPageScansImpl.countLiveFileBackedPages(this.repairBookkeepingReads, sourceId, opts); }
  listRepairScanPages(sourceId: string, q: repairPageScansImpl.RepairScanQuery) { return repairPageScansImpl.listRepairScanPages(this.repairBookkeepingReads, sourceId, q); }
  listFileTombstones(sourceId: string, q: repairPageScansImpl.FileTombstoneQuery) { return repairPageScansImpl.listFileTombstones(this.repairBookkeepingReads, sourceId, q); }
  listUnreviewedSyncTombstones(olderThanHours: number) { return repairPageScansImpl.listUnreviewedSyncTombstones(this.repairBookkeepingReads, olderThanHours); }
  listTwinMergeLosers(survivorId: number, twinId: number) { return repairPageScansImpl.listTwinMergeLosers(this.repairBookkeepingReads, survivorId, twinId); }
  listContactRowPages(sourceIds: readonly string[], q: repairFenceScansImpl.ContactRowQuery) { return repairFenceScansImpl.listContactRowPages(this.repairBookkeepingReads, sourceIds, q); }
  listSplitFactsPages(sourceIds: readonly string[]) { return repairFenceScansImpl.listSplitFactsPages(this.repairBookkeepingReads, sourceIds); }
  listAtomFenceCandidates(sourceIds: readonly string[], q: repairFenceScansImpl.AtomFenceQuery) { return repairFenceScansImpl.listAtomFenceCandidates(this.executeRaw.bind(this), sourceIds, q); }
  listPageTruths(ids: readonly number[], opts?: { timeoutMs?: number }) { return repairFenceScansImpl.listPageTruths(this.executeRaw.bind(this), ids, opts?.timeoutMs); }
  listPagesByOriginPath(sourceId: string) { return repairPlanScansImpl.listPagesByOriginPath(this.repairBookkeepingReads, sourceId); }
  countSegmentedOriginPages(sourceIds: readonly string[]) { return repairPlanScansImpl.countSegmentedOriginPages(this.repairBookkeepingReads, sourceIds); }
  listSegmentedPageSlugs(sourceId: string) { return repairPlanScansImpl.listSegmentedPageSlugs(this.repairBookkeepingReads, sourceId); }
  listProvenAttributionTargets(table: AttributionTable, sourceIds: readonly string[]) { return repairPlanScansImpl.listProvenAttributionTargets(this.repairBookkeepingReads, table, sourceIds); }
  countUnfilledAttribution(table: AttributionTable, sourceIds: readonly string[]) { return repairPlanScansImpl.countUnfilledAttribution(this.repairBookkeepingReads, table, sourceIds); }
  listFailedWriteRequests(sourceIds: readonly string[], query: repairPlanScansImpl.FailedWriteQuery) { return repairPlanScansImpl.listFailedWriteRequests(this.repairBookkeepingReads, sourceIds, query); }
  readDriftConflictBounds(sourceId: string) { return repairPlanScansImpl.readDriftConflictBounds(this.repairBookkeepingReads, sourceId); }
  listDriftConflictGroups(sourceId: string, query: repairPlanScansImpl.DriftConflictQuery) { return repairPlanScansImpl.listDriftConflictGroups(this.repairBookkeepingReads, sourceId, query); }
  readDriftConflictDetails(sourceId: string, slugs: readonly string[], opts: { paths: boolean }) { return repairPlanScansImpl.readDriftConflictDetails(this.repairBookkeepingReads, sourceId, slugs, opts); }
  listUntiledSegmentedPages(opts?: repairPlanScansImpl.UntiledPageQuery) { return repairPlanScansImpl.listUntiledSegmentedPages(this.repairBookkeepingReads, opts); }
  listSourceHoldRecords(op: string, opts?: repairPlanScansImpl.SourceHoldQuery) { return repairPlanScansImpl.listSourceHoldRecords(this.repairBookkeepingReads, op, opts); }
  requestGitHoldRetry(sourceId: string, incarnation: string, paths: readonly string[], requestedAt: string) { return gitHoldsImpl.requestGitHoldRetry(this, sourceId, incarnation, paths, requestedAt); }
  readRepairBusyRows(sourceId: string, incarnation: string) { return repairBusyImpl.readRepairBusyRows(this.repairBookkeepingReads, sourceId, incarnation); }
  purgeStaleCheckpoints(ttlDays: number) { return opCheckpointImpl.purgeStaleCheckpoints(this, ttlDays); }
  purgeStaleAppliedCaptures(ttlDays: number) { return opCheckpointImpl.purgeStaleAppliedCaptures(this, ttlDays); }
  /** Write attribution reads (engine-sql/write-attribution.ts). */
  private get attributionReads() { return unscopedExecutor(this.engineSql, 'write attribution: get_write_attribution ran these unscoped through executeRaw'); }
  readWriteAttributionNames(ids: WriteAttributionNameIds) { return writeAttributionImpl.readWriteAttributionNames(this.attributionReads, ids); }
  readPageRevisionAttribution(pageId: number) { return writeAttributionImpl.readPageRevisionAttribution(this.attributionReads, pageId); }
  readVersionAttributions(versions: VersionRef[]) { return writeAttributionImpl.readVersionAttributions(this.attributionReads, versions); }
  readOldestVersionAttribution(pageId: number) { return writeAttributionImpl.readOldestVersionAttribution(this.attributionReads, pageId); }
  readRowAttribution(target: RowAttributionTarget) { return writeAttributionImpl.readRowAttribution(this.attributionReads, target); }
  readHealthMemoClock() { return whenNotAborted(() => writeMiscImpl.readHealthMemoClock(this.writeMiscReads)); }
  listSynopsisSourceIds() { return whenNotAborted(() => writeMiscImpl.listSynopsisSourceIds(this.writeMiscReads)); }
  readSynopsisTierSources(skipFrontmatter: boolean) { return synopsisTierImpl.readSynopsisTierSources(this, skipFrontmatter); }
  setSourceContextualMode(sourceId: string, mode: string | null) { return sourceCrModeImpl.setSourceContextualMode(this, sourceId, mode); }
  hasSynopsisFrontmatterOverride() { return writeMiscImpl.hasSynopsisFrontmatterOverride(this.writeMiscReads); }
  insertAccessMember(spec: AccessMembersSql.AccessMemberInsert) { return accessMembersImpl.insertAccessMember(this.autocommitSql, spec); }
  setAccessMemberDisabled(id: string, disabled: boolean) { return accessMembersImpl.setAccessMemberDisabled(this.autocommitSql, id, disabled); }
  setAccessMemberEmail(id: string, email: string | null) { return accessMembersImpl.setAccessMemberEmail(this.autocommitSql, id, email); }
  setAccessMemberKind(id: string, kind: AccessMembersSql.AccessMemberKind) { return accessMembersImpl.setAccessMemberKind(this.autocommitSql, id, kind); }
  setAccessMemberLabelledOnly(id: string, labelledOnly: boolean) { return accessMembersImpl.setAccessMemberLabelledOnly(this.autocommitSql, id, labelledOnly); }
  tombstoneAccessMember(id: string) { return accessMembersImpl.tombstoneAccessMember(this.autocommitSql, id); }
  addAccessGroupMembers(groupId: string, memberIds: readonly string[]) { return accessMembersImpl.addAccessGroupMembers(this.autocommitSql, groupId, memberIds); }
  removeAccessGroupMembers(groupId: string, memberIds: readonly string[]) { return accessMembersImpl.removeAccessGroupMembers(this.autocommitSql, groupId, memberIds); }
  deleteAccessGroup(id: string) { return accessMembersImpl.deleteAccessGroup(this.autocommitSql, id); }
  readAccessMemberLink(system: string, externalId: string) { return accessMembersImpl.readAccessMemberLink(this.engineSql, system, externalId); }
  insertAccessMemberLink(system: string, externalId: string, memberId: string) { return accessMembersImpl.insertAccessMemberLink(this.autocommitSql, system, externalId, memberId); }
  deleteAccessMemberLink(system: string, externalId: string) { return accessMembersImpl.deleteAccessMemberLink(this.autocommitSql, system, externalId); }
  listAccessMemberLinks(memberId: string | null) { return accessMembersImpl.listAccessMemberLinks(this.engineSql, memberId); }
  readCredentialBindingForUpdate(target: AccessMembersSql.CredentialTarget, opts: { readsUnscoped: boolean }) { return accessMembersImpl.readCredentialBindingForUpdate(this.engineSql, target, opts); }
  /** A preparation read (page-visibility.ts defaultSourceMemberWriter): master sent it through executeRaw, so it ends at a read deadline. */
  readCredentialMemberId(target: AccessMembersSql.CredentialTarget) { return this.ownRawRead(exec => accessMembersImpl.readCredentialMemberId(exec, target)); }
  listCredentialMemberBindings(names: readonly string[]) { return this.ownRawRead(exec => accessMembersImpl.listCredentialMemberBindings(exec, names)); }
  readAccessTokenAttest(id: string) { return this.ownRawRead(exec => accessMembersImpl.readAccessTokenAttest(exec, id)); }
  readOauthClientAttest(clientId: string, opts?: { lock?: boolean }) {
    return opts?.lock ? accessMembersImpl.readOauthClientAttest(this.engineSql, clientId, opts) : this.ownRawRead(exec => accessMembersImpl.readOauthClientAttest(exec, clientId));
  }
  /** The attested-actor link read (access/actor.ts linkedMember): master sent it through executeRaw, so it ends at a read deadline. */
  readLinkedMember(system: string, externalId: string) { return this.ownRawRead(exec => accessMembersImpl.readLinkedMember(exec, system, externalId)); }
  writeCredentialBinding(target: AccessMembersSql.CredentialTarget, binding: AccessMembersSql.CredentialBinding) { return accessMembersImpl.writeCredentialBinding(this.autocommitSql, target, binding); }
  writeCredentialReadsUnscoped(target: AccessMembersSql.CredentialTarget, readsUnscoped: boolean) { return accessMembersImpl.writeCredentialReadsUnscoped(this.autocommitSql, target, readsUnscoped); }
  expireMemoryProposals(reason: string) { return whenNotAborted(() => writeMiscImpl.expireMemoryProposals(this.autocommitSql, reason)); }
  listAwaitingMemoryProposals(limit: number) { return whenNotAborted(() => writeMiscImpl.listAwaitingMemoryProposals(this.writeMiscReads, limit)); }
  readMemoryProposal(principalKind: string, principalId: string, requestId: string) { return whenNotAborted(() => writeMiscImpl.readMemoryProposal(this.writeMiscReads, principalKind, principalId, requestId)); }
  purgeMemoryProposals(retentionDays: number) { return whenNotAborted(() => writeMiscImpl.purgeMemoryProposals(this.autocommitSql, retentionDays)); }
  readPendingProposalSummary() { return whenNotAborted(() => writeMiscImpl.readPendingProposalSummary(this.writeMiscReads)); }
  listMemoryProposalRows(query: writeMiscImpl.ProposalListQuery) { return whenNotAborted(() => writeMiscImpl.listMemoryProposalRows(this.writeMiscReads, query)); }
  listOwnerProposalRows(requestId: string) { return whenNotAborted(() => writeMiscImpl.listOwnerProposalRows(this.writeMiscReads, requestId)); }
  attachSourcePath(sourceId: string, localPath: string, opts?: writeMiscImpl.AttachSourcePathOptions) { return whenNotAborted(() => writeMiscImpl.attachSourcePath(this.autocommitSql, sourceId, localPath, opts)); }
  listLinkPageMetadata(sourceId?: string) { return cliReadsImpl.listLinkPageMetadata(this.cliReads, sourceId); }
  listLinkPageMetadataForSlugs(sourceId: string, slugs: readonly string[]) { return cliReadsImpl.listLinkPageMetadataForSlugs(this.cliReads, sourceId, slugs); }
  listAttendedOriginSlugs(sourceId: string, slugs?: readonly string[]) { return cliReadsImpl.listAttendedOriginSlugs(this.cliReads, sourceId, slugs); }
  listStoredTimelineRows(sourceId: string, slug: string) { return cliReadsImpl.listStoredTimelineRows(this.cliReads, sourceId, slug); }
  filterPagesAtRevision(refs: readonly PageAtRevisionRef[]) { return cliReadsImpl.filterPagesAtRevision(this.cliReads, refs); }

  // v0.37.0 — domain-bank engine methods (D14 + D5 + D10).
  //
  // `listPrefixSampledPages`: one page per prefix, tiebroken by inbound-link
  // count (connection_count via LEFT JOIN to page_links). Stale-bias optional
  // for LSD mode (D5). Source-scoped (D5). Excludes close-set slugs.
  //
  // Ranking inside each prefix partition:
  //   1. stale_score DESC (when staleBias) — never-retrieved beats >90d-stale beats fresh
  //   2. connection_count DESC — structural-centrality tiebreaker (D10)
  //   3. slug ASC — deterministic for tests
  async listPrefixSampledPages(opts: DomainBankSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listPrefixSampledPages(read => this.withScopedReadTransaction(opts.sourceIds, opts.sourceId, tx => read(scopedRead(this.engineSqlOn(tx)))), opts);
  }

  // v0.37.0 — corpus-sampling fallback when prefix-stratified can't fill M.
  // Deterministic with opts.seed (setseed before SELECT); random otherwise.
  async listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listCorpusSample(read => this.withScopedReadTransaction(opts.sourceIds, opts.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: typeof opts.seed === 'number' }), opts);
  }

  bumpPageRetrievals(pageIds: number[]) { return pagesImpl.bumpPageRetrievals(this.autocommitSql, pageIds); }
  listRestorableAtoms(sourceIds: readonly string[], atomId: number | null) { return atomRestoreReads.listRestorableAtoms(this, sourceIds, atomId); }
  countKeptAtomRetirements(sourceIds: readonly string[]) { return atomRestoreReads.countKeptAtomRetirements(this, sourceIds); }
  listLivePagesBySourcePaths(sourceId: string, excludeId: number, paths: readonly string[]) { return movedPageReads.listLivePagesBySourcePaths(this, sourceId, excludeId, paths); }
  listLivePagesByFileName(sourceId: string, excludeId: number, name: string) { return movedPageReads.listLivePagesByFileName(this, sourceId, excludeId, name); }
  listLivePagesSharingFrontmatterId(sourceId: string, pageId: number) { return movedPageReads.listLivePagesSharingFrontmatterId(this, sourceId, pageId); }
  readMeetingPage(sourceId: string, meetingId: string) { return meetingPages.readMeetingPage(this, sourceId, meetingId); }
  listAttendanceMatches(sourceId: string, slugs: readonly string[], name: string) { return attendancePages.listAttendanceMatches(this, sourceId, slugs, name); }
  recordConnectorSyncAttempt(sourceId: string, at: string, seed: readonly unknown[]) { return connectorAttempts.recordConnectorSyncAttempt(this, sourceId, at, seed); }
  writeConnectorDbCursor(key: string, record: readonly unknown[]) { return connectorDbCursor.writeConnectorDbCursor(this, key, record); }
  hasSegmentedHistory(pageId: number) { return movedPageReads.hasSegmentedHistory(this, pageId); }
  readLivePagesByIds(sourceId: string, ids: readonly number[]) { return movedPageReads.readLivePagesByIds(this, sourceId, ids); }
  listRetiredFenceItems(sourceIds: readonly string[], only: { source_id: string; slug: string } | null) { return lostFenceReads.listRetiredFenceItems(this, sourceIds, only); }
  listInlineVersionTexts(pageId: number) { return lostFenceReads.listInlineVersionTexts(this, pageId); }
  hasActiveFactText(sourceId: string, slug: string, fact: string, visibility: string) { return lostFenceReads.hasActiveFactText(this, sourceId, slug, fact, visibility); }
  hasTakeClaim(pageId: number, claim: string) { return lostFenceReads.hasTakeClaim(this, pageId, claim); }
  readFactTrustTier(id: number) { return lostFenceReads.readFactTrustTier(this, id); }
  listFenceFactRowNums(sourceId: string, slug: string) { return lostFenceReads.listFenceFactRowNums(this, sourceId, slug); }
  listTakeRowNums(pageId: number) { return lostFenceReads.listTakeRowNums(this, pageId); }
  readLiveFactRowTier(sourceId: string, slug: string, rowNum: number, fact: string) { return lostFenceReads.readLiveFactRowTier(this, sourceId, slug, rowNum, fact); }
  readTakeRowTierByClaim(pageId: number, rowNum: number, claim: string) { return lostFenceReads.readTakeRowTierByClaim(this, pageId, rowNum, claim); }
  listStaleAtoms(sourceIds: readonly string[], atomId: number | null) { return staleAtomReads.listStaleAtoms(this, sourceIds, atomId); }

  async resolveSlugs(partial: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<string[]> {
    return pagesImpl.resolveSlugs(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), partial, opts);
  }

  // Search
  // v0.20.0 Cathedral II Layer 3 (1b): chunk-grain FTS internally,
  // dedup-to-best-chunk-per-page on the way out. External shape
  // preserves the v0.19.0 contract so backlinks / enrichment-service /
  // list_pages etc. see zero breaking changes. A2 two-pass (Layer 7)
  // consumes searchKeywordChunks for the raw chunk-grain primitive.
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    guardSearchStatistics(this, this._pageTransaction);
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }

    const detailLow = opts?.detail === 'low';
    // Fetch headroom for dedup: if we only fetch `limit` chunks, a cluster of
    // co-occurring terms in one page can eat the entire result set and we'd
    // ship < limit pages. 3x gives dedup enough to pick top N distinct pages.
    const innerLimit = Math.min(limit * 3, searchLimitCap() * 3);

    // Source-aware ranking (v0.22): boost curated content (originals/,
    // concepts/, writing/) and dampen bulk content (chat/, daily/, media/x/)
    // by multiplying the chunk-grain ts_rank with a source-factor CASE.
    // Detail-gated — disabled for `detail='high'` (temporal queries) so
    // chat surfaces normally for date-framed lookups. Hard-exclude prefixes
    // (test/, attachments/, .raw/ by default) filter at the chunk-rank stage
    // so they never enter the candidate set. (archive/ is demoted, not
    // excluded — issue #1777.)
    const boostMap = opts?.source_boosts ?? resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    // #3986: CJK query branch — engine parity with PGLite's v0.32.7
    // fallback. websearch_to_tsquery with an ASCII-stemming config can't
    // tokenize CJK, so the FTS path below returns empty; route to the
    // shared term-by-term ILIKE fallback instead. ASCII path unchanged.
    if (hasCJK(query)) {
      return this._searchKeywordCJK(query, {
        limit, offset, innerLimit, sourceFactorCase, hardExcludeClause,
        visibilityClause: buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' }),
        detailFilter: detailLow ? `AND cc.chunk_source = 'compiled_truth'` : '',
        opts, dedup: true,
      });
    }

    const params: unknown[] = [collapseWebsearchDashRuns(query)];
    let typeClause = '';
    if (type) {
      params.push(type);
      typeClause = `AND p.type = $${params.length}`;
    }
    // v0.33: multi-type filter for whoknows. AND-applied alongside the
    // single-value `type` filter (callers can use either or both).
    let typesClause = '';
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      typesClause = `AND p.type = ANY($${params.length}::text[])`;
    }
    typesClause += frontmatterWhereSql('p', opts?.where, json => `$${params.push(json)}`);
    let excludeSlugsClause = '';
    if (excludeSlugs?.length) {
      params.push(excludeSlugs);
      excludeSlugsClause = `AND p.slug != ALL($${params.length}::text[])`;
    }
    let languageClause = '';
    if (language) {
      params.push(language);
      languageClause = `AND cc.language = $${params.length}`;
    }
    let symbolKindClause = '';
    if (symbolKind) {
      params.push(symbolKind);
      symbolKindClause = `AND cc.symbol_type = $${params.length}`;
    }
    // v0.29.1: since/until filter by effective date, with import-time fallback.
    let afterDateClause = '';
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation filter. When the
    // caller's auth scope is set, narrow the inner CTE candidate set so
    // an authenticated MCP client cannot see foreign-source pages via
    // keyword search. Array form wins over scalar (federated subsumes
    // single-source). Index-backed by idx_pages_source_id; the filter is
    // pushed to the INNER CTE specifically so HNSW-style downstream
    // ranking sees a narrowed candidate set rather than re-ranking a
    // cross-source pool.
    let sourceClause = '';
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      sourceClause = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      sourceClause = `AND p.source_id = $${params.length}`;
    }
    const scope = sourceClause ? { idx: params.length, many: !!opts?.sourceIds?.length } : null;
    params.push(innerLimit);
    const innerLimitParam = `$${params.length}`;
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    // v0.26.5: visibility filter hides soft-deleted pages and pages from
    // archived sources. Joined `sources s` lets the predicate compile to a
    // column lookup. NOT bypassed by detail=high — soft-delete is a contract,
    // not a temporal preference.
    const visibilityClause = buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' });
    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();
    const rankIdx = opts?.rankQuery ? params.push(opts.rankQuery) - 1 : opts?.orFallback ? params.push(params[0]) - 1 : 0;

    const chunk = buildKeywordChunkMatch(ftsLang, opts?.excludePrivate);
    const chunkFilters = `${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''} ${languageClause} ${symbolKindClause}`;
    const score = `ts_rank(cc.search_vector, websearch_to_tsquery('${ftsLang}', $${rankIdx + 1})) * ${keywordPhraseFactorSql(ftsLang, `$${rankIdx + 1}`, opts?.keywordPhrase === true)} * ${sourceFactorCase}`;
    const pageJoin = `SELECT p.id as page_id, cc.id as chunk_id, ${score} AS score
        FROM ${chunk.from}
        JOIN pages p ON p.id = cc.page_id
        JOIN sources s ON s.id = p.source_id
        WHERE ${chunk.match}
          ${typeClause}
          ${typesClause}
          ${excludeSlugsClause}
          ${chunkFilters}
          ${afterDateClause}
          ${beforeDateClause}
          ${sourceClause}
          ${hardExcludeClause}
          ${visibilityClause}
          ${chunk.modality}`;
    const candidates = keywordCandidatesSql(ftsLang, { excludePrivate: opts?.excludePrivate, pageFiltered: !!(typeClause || typesClause || afterDateClause || beforeDateClause), score, pageJoin, chunkFilters, pageFilters: `${excludeSlugsClause} ${sourceClause} ${hardExcludeClause} ${visibilityClause}`, scope });
    const rawQuery = `
      WITH ranked_chunks AS (
        SELECT page_id, chunk_id, score, bounded_rows FROM (SELECT *, count(*) OVER () AS bounded_rows, row_number() OVER (PARTITION BY page_id ORDER BY score DESC, chunk_id ASC) AS page_rank FROM (${candidates}
        LIMIT ${KEYWORD_RANK_CANDIDATES}) bounded) per_page WHERE page_rank = 1
        ORDER BY score DESC, page_id ASC, chunk_id ASC
        LIMIT ${innerLimitParam}
      ),
      ${KEYWORD_RANKED_ROWS_CTE},
      ${buildBestPerPagePoolCte('ranked_rows')}
      SELECT slug, page_id, title, type, source_id,
        effective_date, effective_date_source,
        message_id, thread_id, source_subject,
        chunk_id, chunk_index, chunk_text, chunk_source, score, bounded_rows,
        false AS stale
      FROM best_per_page
      ORDER BY score DESC, page_id ASC, chunk_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING) + search-only
    // timeout. alwaysTransaction: this method needed sql.begin() on master
    // already (a transaction-local statement_timeout can never leak onto a
    // pooled connection). The scope, JIT off, the timeout and the
    // enable_seqscan of a relaxed or chunk-driven attempt are one settings statement
    // (postgres-engine/search-settings.ts).
    const statementTimeout = await this.keywordStatementTimeoutSetting();
    const runKeyword = (queryText: string, relaxed = false, rankText = queryText) => this.keywordTimeouts.run(opts?.keywordTimeoutCache === true, this,
      [statementTimeout, relaxed, rawQuery, collapseWebsearchDashRuns(queryText), collapseWebsearchDashRuns(rankText), params.slice(1), opts?.sourceIds ?? null, opts?.sourceId ?? null, ...(opts?.orFill ? ['any-word fill'] : [])], () =>
      this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, (tx) => {
        const boundParams = params.map((v, i) => i === 0 ? collapseWebsearchDashRuns(queryText) : i === rankIdx && !opts?.rankQuery ? collapseWebsearchDashRuns(rankText) : v);
        return tx.unsafe(rawQuery, boundParams as Parameters<typeof tx.unsafe>[1]);
      }, { alwaysTransaction: true, jitOff: true, settings: relaxed || candidates !== pageJoin ? { statement_timeout: statementTimeout, enable_seqscan: 'off', ...KEYWORD_STATEMENT_SETTINGS } : { statement_timeout: statementTimeout, ...KEYWORD_STATEMENT_SETTINGS } }));
    const strict = opts?.orFill ? [] : await runKeyword(query);
    if (Number(strict[0]?.bounded_rows) >= KEYWORD_RANK_CANDIDATES) opts?.onKeywordIncomplete?.('candidate_budget');
    // D2 fix (fix/title-retrieval-arm): when the strict AND finds nothing,
    // retry ONCE with OR-of-terms through the SAME scoped wrapper (a fresh
    // scoped transaction, so RLS scope binding applies identically). Opt-in
    // via SearchOpts.orFallback (Reviewer F1): only hybridSearch's recall arm
    // relaxes; precision consumers keep the strict-AND contract. #7491: the
    // identifier probe and the relaxed-row tag (#3617 follow-up) live in
    // search/keyword-identifier-probe.ts.
    return keywordArmRows<Record<string, unknown>>({ query, strict, orFallback: opts?.orFallback, orFill: opts?.orFill, limit, offset, toResult: rowToSearchResult, onIncomplete: opts?.onKeywordIncomplete,
      runProbe: (match, rank) => runKeyword(match, true, rank),
      runHandles: handles => keywordPagesImpl.searchHandlePages((read, settings) => this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: true, jitOff: true, settings }), query, handles, opts, limit, { statementTimeout, statementSettings: KEYWORD_STATEMENT_SETTINGS }),
      runRelaxed: async (orQuery) => {
        const shares = await readOrTokenShares((sql, p) => this.executeRaw(sql, p), query, ftsLang);
        const narrowed = narrowedOrFallbackText(shares), common = commonOrTokens(shares, RARE_TERM_CHUNK_CAP);
        const rows = await runKeyword(narrowed ?? orQuery, true, orQuery);
        if (narrowed || Number(rows[0]?.bounded_rows) >= KEYWORD_RANK_CANDIDATES) opts?.onKeywordIncomplete?.('candidate_budget');
        return rankOrFallbackByRarity<Record<string, unknown>>({ query, rows, limit, offset, runRare: q => runKeyword(q, true, orQuery),
          readTermPages: terms => this.executeRaw<RareTermPages>(rareTermPagesSql(ftsLang), [terms.filter(t => !common.has(t)), RARE_TERM_CHUNK_CAP]) });
      } });
  }

  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm. SQL lives
   * once in engine-sql/titles.ts (exact-title key #5889, index-backed remote
   * predicate). Each attempt (strict, then OR fallback) runs in its own
   * scoped read transaction under the keyword statement timeout (#6495 knob).
   */
  /** Cat 40 Hard F2 strict keyword count and keyword-mode pages; SQL in engine-sql/keyword-pages.ts. */
  async countKeywordPages(query: string, opts?: SearchOpts & { timeoutMs?: number }): Promise<number> {
    return keywordPagesImpl.countKeywordPages((read, settings) => this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: true, jitOff: true, settings }), query, opts, { statementTimeout: await this.keywordStatementTimeoutSetting(), statementSettings: KEYWORD_STATEMENT_SETTINGS, timeoutMs: opts?.timeoutMs });
  }
  async searchKeywordPages(query: string, opts: SearchOpts | undefined, page: KeywordPageWindow): Promise<SearchResult[]> {
    return keywordPagesImpl.searchKeywordPages((read, settings) => this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: true, jitOff: true, settings }), query, opts, page, { statementTimeout: await this.keywordStatementTimeoutSetting(), statementSettings: KEYWORD_STATEMENT_SETTINGS });
  }

  async searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    return titlesImpl.searchTitles(
      (read, settings) => this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: true, jitOff: true, settings }),
      query,
      opts,
      { statementTimeout: await this.keywordStatementTimeoutSetting(), statementSettings: KEYWORD_STATEMENT_SETTINGS, relaxedPrefersIndex: true, staleProbe: false, chunkManifest: exec => chunkManifestReads(this, exec) },
    );
  }

  /**
   * v0.20.0 Cathedral II Layer 3 (1b) chunk-grain keyword search.
   * Ranks chunks via content_chunks.search_vector WITHOUT the
   * dedup-to-page pass searchKeyword applies. Used by A2 two-pass
   * retrieval (Layer 7) as the anchor-discovery primitive.
   *
   * Most callers should prefer searchKeyword (external page-grain
   * contract). This is intentionally a narrow internal knob.
   */
  async searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }

    // Source-aware ranking applies here too — searchKeywordChunks is the
    // chunk-grain anchor primitive that two-pass retrieval (Layer 7) uses,
    // so curated-vs-bulk dampening should affect the anchor pool. Same
    // detail-gate, same hard-exclude behavior as searchKeyword.
    const boostMap = opts?.source_boosts ?? resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    // #3986: CJK branch — same fallback as searchKeyword but chunk-grain
    // (no page-dedup). Parity with PGLite searchKeywordChunks.
    if (hasCJK(query)) {
      return this._searchKeywordCJK(query, {
        limit, offset,
        innerLimit: 0,             // unused on chunk-grain (no inner CTE)
        sourceFactorCase, hardExcludeClause,
        visibilityClause: buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' }),
        detailFilter: detailLow ? `AND cc.chunk_source = 'compiled_truth'` : '',
        opts, dedup: false,
      });
    }

    const params: unknown[] = [collapseWebsearchDashRuns(query)];
    let typeClause = '';
    if (type) {
      params.push(type);
      typeClause = `AND p.type = $${params.length}`;
    }
    // v0.33: multi-type filter for whoknows. AND-applied alongside the
    // single-value `type` filter (callers can use either or both).
    let typesClause = '';
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      typesClause = `AND p.type = ANY($${params.length}::text[])`;
    }
    typesClause += frontmatterWhereSql('p', opts?.where, json => `$${params.push(json)}`);
    let excludeSlugsClause = '';
    if (excludeSlugs?.length) {
      params.push(excludeSlugs);
      excludeSlugsClause = `AND p.slug != ALL($${params.length}::text[])`;
    }
    let languageClause = '';
    if (language) {
      params.push(language);
      languageClause = `AND cc.language = $${params.length}`;
    }
    let symbolKindClause = '';
    if (symbolKind) {
      params.push(symbolKind);
      symbolKindClause = `AND cc.symbol_type = $${params.length}`;
    }
    // v0.29.1: since/until filter by effective date, with import-time fallback.
    let afterDateClause = '';
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation. Anchor primitive
    // for two-pass retrieval, so cross-source anchors would let the walk
    // discover foreign-source neighbors. Filter at chunk-rank time.
    let sourceClause = '';
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      sourceClause = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      sourceClause = `AND p.source_id = $${params.length}`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    // v0.26.5: visibility filter for searchKeywordChunks (anchor primitive).
    const visibilityClause = buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' });
    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();

    const rawQuery = `
      SELECT
        p.slug, p.id as page_id, p.title, p.type, p.source_id,
        p.effective_date, p.effective_date_source,
        CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
          THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
        CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
          THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
        cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
        ts_rank(cc.search_vector, websearch_to_tsquery('${ftsLang}', $1)) * ${sourceFactorCase} AS score,
        false AS stale
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      JOIN sources s ON s.id = p.source_id
      WHERE cc.search_vector @@ websearch_to_tsquery('${ftsLang}', $1)
        ${typeClause}
        ${typesClause}
        ${excludeSlugsClause}
        ${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''}
        ${languageClause}
        ${symbolKindClause}
        ${afterDateClause}
        ${beforeDateClause}
        ${sourceClause}
        ${hardExcludeClause}
        ${visibilityClause}
      ORDER BY score DESC, page_id ASC, chunk_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // RLS scope binding + search-only timeout. alwaysTransaction: master
    // already wrapped this in sql.begin() for the transaction-local timeout;
    // scope, JIT off and the timeout are one settings statement.
    const statementTimeout = await this.keywordStatementTimeoutSetting();
    const rows = await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId,
      tx => tx.unsafe(rawQuery, params as Parameters<typeof tx.unsafe>[1]),
      { alwaysTransaction: true, jitOff: true, settings: { statement_timeout: statementTimeout } });
    return rows.map(rowToSearchResult);
  }

  /**
   * #3986: CJK keyword fallback (parity port of PGLite's v0.32.7 branch).
   * SQL builds in the shared cjk-keyword-sql.ts; execution goes through the
   * same scoped read transaction (RLS scope binding + the keyword statement
   * timeout) as the FTS keyword paths. See src/core/engine-sql/cjk-search.ts.
   */
  private async _searchKeywordCJK(query: string, ctx: CjkKeywordCtx): Promise<SearchResult[]> {
    const statementTimeout = await this.keywordStatementTimeoutSetting();
    return searchKeywordCJKImpl(
      async (read) =>
        await this.withScopedReadTransaction(ctx.opts?.sourceIds, ctx.opts?.sourceId, async (tx) => {
          return await read(scopedRead(postgresExecutor(tx, {
            runUnsafe: (conn, sql, params, opts) => this.runUnsafe(conn, sql, params, opts),
            gauge: this.checkoutGauge,
          })));
        }, { alwaysTransaction: true, jitOff: true, settings: { statement_timeout: statementTimeout } }),
      query,
      ctx,
    );
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    guardSearchStatistics(this, this._pageTransaction);
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }
    // Two-stage CTE (v0.22): the candidate CTE keeps a pure-distance ORDER BY
    // so the HNSW index stays usable; the outer stages re-rank by source
    // factor. Statement shape, freshness placement (#5824) and pool counts
    // live in search/vector-statement.ts, shared with PGLite and doctor.
    const scope = await this.vectorScope(opts);
    const statementFor = vectorStatementForms(chunkManifest => buildVectorSearchStatement({ dialect: 'postgres', embedding, limit, offset: opts?.offset || 0, opts, scope, chunkManifest }));
    const stmt = statementFor(true);
    const iterative = await this.vectorIterativeScanSupported();
    const walked = await searchIndexWalk(stmt, limit, async walk => readVectorPool(await this.runVectorAttempt(statementFor, walk, iterative, opts, (tx, sql, bound) => tx.unsafe(sql, bound))));
    if (walked) return walked.map(rowToSearchResult);
    const rows = await searchVectorPool(limit, stmt.innerLimit, iterative, stmt.indexed, 'postgres',
      async attempt => {
        const batch = await this.runVectorAttempt(statementFor, attempt, iterative, opts, (tx, sql, bound) => tx.unsafe(sql, bound));
        return { ...readVectorPool(batch), exhausted: attempt.exact };
      },
      async (pool, remainingMs) => {
        const deadline = performance.now() + remainingMs;
        return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async tx => {
          const { hasMoreSql } = statementFor(await chunkManifestReads(this, this.engineSqlOn(tx)));
          const rows = await tx.unsafe(hasMoreSql, [...stmt.params.slice(0, stmt.innerLimitIdx), pool + 1] as Parameters<typeof tx.unsafe>[1]);
          return Number(rows[0].eligible) > pool;
        }, { alwaysTransaction: true, jitOff: true, settings: () => ({ statement_timeout: String(remainingVectorBudget(deadline)) }) });
      },
      opts?.onVectorPoolMeta,
    );
    return rows.map(rowToSearchResult);
  }

  /**
   * EXPLAIN (no ANALYZE) of the first ANN attempt `searchVector` runs (the index
   * walk when there is one): the same statement, bound parameters, scoped read
   * transaction and scan settings, through `tx.unsafe` (the vendored driver
   * never prepares it). Used by doctor `vector_plan` and the plan-proof E2E.
   */
  async explainVectorSearch(embedding: Float32Array, opts?: SearchOpts): Promise<Record<string, unknown>> {
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const scope = await this.vectorScope(opts);
    const statementFor = vectorStatementForms(chunkManifest => buildVectorSearchStatement({ dialect: 'postgres', embedding, limit, offset: opts?.offset || 0, opts, scope, chunkManifest }));
    const stmt = statementFor(true);
    const iterative = await this.vectorIterativeScanSupported();
    const attempt = { innerLimit: stmt.innerLimit, maxScanTuples: stmt.indexWalkSql || stmt.scopeScanSql ? Math.max(2_000, stmt.innerLimit * stmt.indexWalkOverfetch) : POOL_MAX_SCAN_TUPLES, remainingMs: 8_000, exact: false, indexWalk: !!stmt.indexWalkSql, scopeScan: !stmt.indexWalkSql && !!stmt.scopeScanSql };
    const [row] = await this.runVectorAttempt(statementFor, attempt, iterative, opts, (tx, sql, bound) => tx.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`, bound));
    const plan = row?.['QUERY PLAN'];
    return (Array.isArray(plan) ? plan[0] : plan) as Record<string, unknown>;
  }

  /** #6495: resolve the keyword/title statement bound for this connection at connect (file plane, else the DB plane, else 8000 ms; postgres-engine/keyword-statement-timeout.ts), never from a request or inside a search's transaction. */
  private keywordStatementTimeoutSetting(): Promise<string> {
    // Under a preparation deadline the config read takes the deadline, and a load it fails is not kept.
    if (this.keywordStatementTimeout || this._pageTransaction || readDeadline() === undefined) return this.keywordStatementTimeout ??= loadKeywordStatementTimeout(this, this._savedConfig?.keyword_statement_timeout_ms);
    return loadKeywordStatementTimeout(this, this._savedConfig?.keyword_statement_timeout_ms, text => this.configRead(sql => sql.unsafe(text))).then(value => this.keywordStatementTimeout ??= Promise.resolve(value));
  }

  async keywordBoundedRead<T>(read: (db: Pick<BrainEngine, 'executeRaw'>) => Promise<T>): Promise<T> {
    const statementTimeout = await this.keywordStatementTimeoutSetting();
    return this.withScopedReadTransaction(undefined, undefined, tx => read(this.engineSqlOn(tx)), { alwaysTransaction: true, settings: { statement_timeout: statementTimeout } });
  }

  private async vectorIterativeScanSupported(): Promise<boolean> {
    this.vectorIterativeScan ??= this.executeRaw<{ extversion: string }>(VECTOR_EXTENSION_VERSION_SQL)
      .then(rows => supportsHnswIterativeScan(rows[0]?.extversion));
    const probe = this.vectorIterativeScan;
    try { return await probe; }
    catch (error) {
      if (this.vectorIterativeScan === probe) this.vectorIterativeScan = undefined;
      throw error;
    }
  }

  private runVectorAttempt(
    statementFor: (chunkManifest: boolean) => VectorSearchStatement,
    { innerLimit, maxScanTuples, remainingMs, exact, indexWalk, scopeScan }: VectorPoolAttempt,
    iterative: boolean,
    opts: SearchOpts | undefined,
    run: (tx: ReturnType<typeof postgres>, sql: string, bound: Parameters<ReturnType<typeof postgres>['unsafe']>[1]) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    const deadline = performance.now() + remainingMs;
    const shape = statementFor(true);
    const walk = indexWalk && !!shape.indexWalkSql;
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async tx => {
      const stmt = statementFor(await chunkManifestReads(this, this.engineSqlOn(tx)));
      const bound = [...stmt.params];
      bound[stmt.innerLimitIdx] = exact ? null : innerLimit;
      return run(tx, (scopeScan && stmt.scopeScanSql) || (walk && stmt.indexWalkSql) || (exact ? stmt.exactSql : stmt.sql), bound as Parameters<typeof tx.unsafe>[1]);
    }, { alwaysTransaction: true, jitOff: true, settings: () => vectorScanSettings(iterative, innerLimit, maxScanTuples, deadline, opts?.hnswIterativeScan, walk ? shape.indexWalkOverfetch : undefined, !!shape.indexWalkSql && !walk && !(scopeScan && shape.scopeScanSql) && !exact) });
  }

  async getEmbeddingsByChunkIds(ids: number[], column: string = 'embedding'): Promise<Map<number, Float32Array>> {
    return chunksImpl.getEmbeddingsByChunkIds(unscopedExecutor(this.engineSql, 'chunks: unscoped on master (EO4 inventory)'), ids, column);
  }
  // Search ranking-stage reads and onboarding counts: master's engine.executeRaw statements, unscoped as on master.
  private get searchRead() { return unscopedExecutor(this.engineSql, 'search reads: master engine.executeRaw, unscoped'); }
  async cosinesByChunkIds(ids: number[], column: string, query: Float32Array) { return searchReadsImpl.cosinesByChunkIds(this.searchRead, ids, column, query); }
  async hasSupersedeEdges() { return searchReadsImpl.hasSupersedeEdges(this.searchRead); }
  async supersedingPageSlugs(pageIds: number[], policy?: PageReadPolicy) { return searchReadsImpl.supersedingPageSlugs(this.searchRead, pageIds, policy); }
  async aliasCanonicalRefs(refs: Array<{ slug: string; source_id: string }>, policy?: PageReadPolicy) { return searchReadsImpl.aliasCanonicalRefs(this.searchRead, refs, policy); }
  async pageCollapseFacts(ids: number[], bodyIds: number[]) { return searchReadsImpl.pageCollapseFacts(this.searchRead, ids, bodyIds); }
  async slugsEndingIn(sourceId: string, word: string) { return searchReadsImpl.slugsEndingIn(this.searchRead, sourceId, word); }
  async generatedPagesIn(ids: number[]) { return searchReadsImpl.generatedPagesIn(this.searchRead, ids); }
  async livePageIdsAt(refs: Array<{ slug: string; source_id: string }>) { return searchReadsImpl.livePageIdsAt(this.searchRead, refs); }
  async pagesLinkingTo(fromIds: number[], toIds: number[]) { return searchReadsImpl.pagesLinkingTo(this.searchRead, fromIds, toIds); }
  async countOnboardSignal(signal: healthImpl.OnboardSignal, entityTypes: import('./schema-pack/entity-types.ts').EntityTypeFilter, opts?: { signal?: AbortSignal }) {
    return healthImpl.countOnboardSignal(this.searchRead, signal, entityTypes, opts);
  }
  async countBrainLivePages() { return healthImpl.countBrainLivePages(this.searchRead); }
  async countLivePagesBySource() { return healthImpl.countLivePagesBySource(this.searchRead); }
  async countChunksBySource(column: string) { return healthImpl.countChunksBySource(this.searchRead, column); }
  async readBrainMaturity() { return this.engineSqlRead(exec => healthImpl.readBrainMaturity(unscopedExecutor(exec, 'search reads: master engine.executeRaw, unscoped'))); }
  private get linkRead() { return unscopedExecutor(this.engineSql, 'link reads: master engine.executeRaw, unscoped'); }
  inboundLinkCoverage(opts?: { sourceIds?: string[] }) { return linkReadsImpl.inboundLinkCoverage(this.linkRead, opts); }
  listJunkEntityHubs(opts: { edgeThreshold: number; maxChunks: number; limit: number }) { return linkReadsImpl.listJunkEntityHubs(this.linkRead, opts); }
  countEntityPages(filter: import('./schema-pack/entity-types.ts').EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }) { return linkReadsImpl.countEntityPages(this.linkRead, filter, opts); }
  entityGraphCoverage(filter: import('./schema-pack/entity-types.ts').EntityTypeFilter) { return linkReadsImpl.entityGraphCoverage(this.linkRead, filter); }
  entityFeatureCoverage(filter: import('./schema-pack/entity-types.ts').EntityTypeFilter, feature: 'links' | 'timeline', opts?: { samplePercent?: number }) { return this.engineSqlRead(exec => linkReadsImpl.entityFeatureCoverage(unscopedExecutor(exec, 'link reads: master engine.executeRaw, unscoped'), filter, feature, opts)); }
  countDatedMeetingPages() { return this.engineSqlRead(exec => linkReadsImpl.countDatedMeetingPages(unscopedExecutor(exec, 'link reads: master engine.executeRaw, unscoped'))); }
  countForeignEdges(slug: string, sourceId: string, direction: 'in' | 'out' | 'both') { return linkReadsImpl.countForeignEdges(this.linkRead, slug, sourceId, direction); }
  listLivePageSummaries(scope?: PageReadScope) { return linkReadsImpl.listLivePageSummaries(this.linkRead, scope); }
  countInboundLinks(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }) { return linkReadsImpl.countInboundLinks(this.linkRead, slug, sourceId, opts); }
  readEntityInboundEdges(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }) { return linkReadsImpl.readEntityInboundEdges(this.linkRead, slug, sourceId, opts); }
  /** Link preparation's endpoint read: master bounded it through executeRaw, so a preparation read ends at its deadline. */
  listLinkEndpointPages(sourceId: string, slugs: string[], crossSourceSlugs: string[]) {
    return this.preparationRead(exec => linkReadsImpl.listLinkEndpointPages(unscopedExecutor(exec, 'link reads: master engine.executeRaw, unscoped'), sourceId, slugs, crossSourceSlugs));
  }
  listPagesTitledIn(queryLower: string, scope: PageReadScope) { return linkReadsImpl.listPagesTitledIn(this.linkRead, queryLower, scope); }
  wordLexemes(words: string[]) { return linkReadsImpl.wordLexemes(this.linkRead, words); }
  readLinkContextMatches(asks: readonly linkReadsImpl.LinkContextAsk[]) { return linkReadsImpl.readLinkContextMatches(this.linkRead, asks); }
  readLinkContextOriginPages(ids: readonly number[]) { return linkReadsImpl.readLinkContextOriginPages(this.linkRead, ids); }
  private get linkTemporal() { return unscopedExecutor(this.autocommitSql, 'link temporal: master engine.executeRaw, unscoped'); }
  readLinkRelationshipEvidence(keys: readonly RelationshipKey[]) { return linkTemporalImpl.readLinkRelationshipEvidence(this.linkTemporal, keys); }
  writeLinkRelationshipState(write: RelationshipStateWrite) { return linkTemporalImpl.writeLinkRelationshipState(this.linkTemporal, write); }
  linkRelationshipKeysForPages(pageIds: readonly number[]) { return linkTemporalImpl.linkRelationshipKeysForPages(this.linkTemporal, pageIds); }
  staleLinkRelationshipKeys(limit: number) { return linkTemporalImpl.staleLinkRelationshipKeys(this.linkTemporal, limit); }
  linkRelationshipKeysForOrigin(pageId: number) { return linkTemporalImpl.linkRelationshipKeysForOrigin(this.linkTemporal, pageId); }
  // The rows are pipelined, which keeps their order only on one connection: a call outside a transaction opens one.
  applyLinkTemporalRows(input: linkTemporalImpl.LinkTemporalRows): Promise<linkTemporalImpl.LinkTemporalApplied> {
    return this._pageTransaction ? linkTemporalImpl.applyLinkTemporalRows(this.linkTemporal, input) : this.transaction(tx => tx.applyLinkTemporalRows(input));
  }
  writeManualLinkTransitions(rel: linkTemporalImpl.ManualLinkRelationship, rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>) { return linkTemporalImpl.writeManualLinkTransitions(this.linkTemporal, rel, rows); }
  removeManualLinkTransitions(rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }) { return linkTemporalImpl.removeManualLinkTransitions(this.linkTemporal, rel); }
  listRelationshipNoteRows(subjects: ReadonlyArray<{ slug: string; source_id: string }>, opts: { excludePrivate: boolean }) { return linkTemporalImpl.listRelationshipNoteRows(this.linkTemporal, subjects, opts); }
  edgeValidityCounts(opts: { sourceIds?: readonly string[]; staleLimit: number }) { return linkTemporalImpl.edgeValidityCounts(this.linkTemporal, opts); }
  listPageStatusByRef(refs: ReadonlyArray<{ source_id: string; slug: string }>, scope: { excludePrivate: boolean; includeQuarantined?: boolean }) { return linkTemporalImpl.listPageStatusByRef(this.linkTemporal, refs, scope); }
  listRecordMetadataRows(pageIds: readonly number[], scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }) { return linkTemporalImpl.listRecordMetadataRows(this.linkTemporal, pageIds, scope); }
  readReferrerGroupRows(target: { sources: readonly string[]; slugs: readonly string[] }, scope: linkTemporalImpl.ReferrerGroupScope) { return linkTemporalImpl.readReferrerGroupRows(this.linkTemporal, target, scope); }
  readReferrerPageDetails(ids: readonly number[]) { return linkTemporalImpl.readReferrerPageDetails(this.linkTemporal, ids); }
  readPageReferenceDate(sourceId: string, slug: string) { return linkTemporalImpl.readPageReferenceDate(this.linkTemporal, sourceId, slug); }
  readReferrerTargetCounts(target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] }, scope: linkTemporalImpl.ReferrerTargetCountScope) { return linkTemporalImpl.readReferrerTargetCounts(this.linkTemporal, target, scope); }
  listReferrerTargetSources(slug: string, sources: readonly string[]) { return linkTemporalImpl.listReferrerTargetSources(this.linkTemporal, slug, sources); }
  countReferrerRows(target: { sources: readonly string[]; slugs: readonly string[] }, scope: linkTemporalImpl.ReferrerRowScope) { return linkTemporalImpl.countReferrerRows(this.linkTemporal, target, scope); }
  readReferrerRows(target: { sources: readonly string[]; slugs: readonly string[] }, scope: Parameters<typeof linkTemporalImpl.readReferrerRows>[2]) { return linkTemporalImpl.readReferrerRows(this.linkTemporal, target, scope); }
  readReferrerRecordCandidates(target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] }, scope: linkTemporalImpl.ReferrerRecordCandidateScope) { return linkTemporalImpl.readReferrerRecordCandidates(this.linkTemporal, target, scope); }
  readReferrerRecordPages(ids: readonly number[]) { return linkTemporalImpl.readReferrerRecordPages(this.linkTemporal, ids); }
  readReferrerTypes(target: { sources: readonly string[]; slugs: readonly string[] }, scope: linkTemporalImpl.ReferrerTypeScope) { return linkTemporalImpl.readReferrerTypes(this.linkTemporal, target, scope); }
  countSearchVectorRows() { return searchVectorImpl.countSearchVectorRows(this.linkTemporal); }
  replaceSearchVectorTriggerFunction(target: 'pages' | 'chunks', lang: string) { return searchVectorImpl.replaceSearchVectorTriggerFunction(this.linkTemporal, target, lang); }
  backfillSearchVectors(target: 'pages' | 'chunks', opts: Pick<VectorBackfillOpts, 'lang' | 'checkpoint' | 'tick'>) { return target === 'pages' ? backfillPageVectors(this, opts) : backfillChunkVectors(this, opts); }
  ensureFactsKeywordIndex(lang: string, notice?: (line: string) => void) { return ensureFactsFtsIndex(this, { lang, version: 0, notice }); }
  countPendingProjectionPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance) { return retrievalCoverageImpl.countPendingProjectionPages(this.executeRaw.bind(this), scope, relevance); }
  countEmbeddingHeldPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance) { return retrievalCoverageImpl.countEmbeddingHeldPages(this.executeRaw.bind(this), scope, relevance); }
  projectionRebuildProgress(scope: ProjectionReadinessScope) { return retrievalCoverageImpl.projectionRebuildProgress({ executeRaw: this.executeRaw.bind(this) }, scope); }
  // The readiness probe's statements, through this engine's executeRaw so the probe keeps its JIT-off option.
  readProjectionReadinessGeneration() { return retrievalCoverageImpl.readProjectionReadinessGeneration(this.executeRaw.bind(this)); }
  readProjectionReadiness(scope: ProjectionReadinessScope) { return retrievalCoverageImpl.readProjectionReadiness(this.executeRaw.bind(this), scope); }
  private get chunkRead() { return unscopedExecutor(this.engineSql, 'chunk reads: master engine.executeRaw, unscoped'); }
  findCodeDefinitions(symbol: string, opts?: CodeSymbolQuery) { return chunkReadsImpl.findCodeDefinitions(this.chunkRead, symbol, opts); }
  listSymbolTypesForName(symbol: string, opts?: Omit<CodeSymbolQuery, 'limit'>) { return chunkReadsImpl.listSymbolTypesForName(this.chunkRead, symbol, opts); }
  findCodeRefChunks(symbol: string, opts?: CodeSymbolQuery) { return chunkReadsImpl.findCodeRefChunks(this.chunkRead, symbol, opts); }
  countOversizedEmbedSkips(maxBytes: number) { return chunkReadsImpl.countOversizedEmbedSkips(this.chunkRead, maxBytes); }
  countOrphanChunks() { return chunkReadsImpl.countOrphanChunks(this.chunkRead); }
  countCodeChunkPages() { return chunkReadsImpl.countCodeChunkPages(this.chunkRead); }
  codeChunksExist(sourceId: string | undefined, policy?: PageReadScope) { return chunkReadsImpl.codeChunksExist(this.chunkRead, sourceId, policy); }
  hasUnsealedPages(scope: UnsealedPageScope) { return chunkReadsImpl.hasUnsealedPages(this.chunkRead, scope); }
  currentCodeChunksExist(scope: CodeChunkScope, predicate: 'any' | 'with_symbol') { return chunkReadsImpl.currentCodeChunksExist(this.chunkRead, scope, predicate); }
  listQualifiedSymbolNames(sourceId: string, symbol: string, opts: { match: 'exact' | 'contains'; limit: number }) { return chunkReadsImpl.listQualifiedSymbolNames(this.chunkRead, sourceId, symbol, opts); }
  listWithdrawalChunks(sourceId: string, keys: WithdrawalChunkKey[], opts: { after: number; limit: number; subjects: string[] | null }) { return chunkReadsImpl.listWithdrawalChunks(this.chunkRead, sourceId, keys, opts); }
  deleteChunksForPages(pageIds: readonly number[]) { return chunkReadsImpl.deleteChunksForPages(this.autocommitSql, pageIds); }
  listContextualModeCandidates(sourceIds: string[]) { return chunkReadsImpl.listContextualModeCandidates(this.chunkRead, sourceIds); }
  async resolveFrozenHits(hits: FrozenHitKey[], scope: PageReadScope) { return chunkReadsImpl.resolveFrozenHits(this.chunkRead, hits, scope, await chunkManifestReads(this)); }
  private get timelineRead() { return unscopedExecutor(this.engineSql, 'timeline reads: master engine.executeRaw, unscoped'); }
  private timelineBoundedRead<T>(fn: (exec: ReturnType<typeof unscopedExecutor>) => Promise<T>) { return whenNotAborted(() => this.preparationRead(exec => fn(unscopedExecutor(exec, 'timeline reads: master engine.executeRaw, unscoped')))); }
  sampleEffectiveDates() { return whenNotAborted(() => timelineReadsImpl.sampleEffectiveDates(this.timelineRead)); }
  sampleEffectiveDateSources() { return whenNotAborted(() => timelineReadsImpl.sampleEffectiveDateSources(this.timelineRead)); }
  readMaxTimelineEntryId() { return this.timelineBoundedRead(exec => timelineReadsImpl.readMaxTimelineEntryId(exec)); }
  listStoredTimelineRowsOrdered(pageId: number) { return whenNotAborted(() => this.preparationRead(exec => timelineReadsImpl.listStoredTimelineRowsOrdered(unscopedExecutor(exec, 'timeline reads: master engine.executeRaw, unscoped'), pageId))); }
  deleteTimelineRows(pageId: number, deletions: readonly TimelineRowDeletion[]) { return whenNotAborted(() => timelineReadsImpl.deleteTimelineRows(this.autocommitSql, pageId, deletions)); }
  storedTimelineRowsByPageIds(pageIds: readonly number[]) { return this.timelineBoundedRead(exec => timelineReadsImpl.storedTimelineRowsByPageIds(exec, pageIds)); }
  countSegmentedTimelinePages(sourceIds: readonly string[], limit: number) { return this.timelineBoundedRead(exec => timelineReadsImpl.countSegmentedTimelinePages(exec, sourceIds, limit)); }
  countTimelineCommentMarkupRows(sourceIds: readonly string[]) { return whenNotAborted(() => timelineReadsImpl.countTimelineCommentMarkupRows(this.timelineRead, sourceIds)); }
  listTimelineOrphanPages(opts: { afterId: number; limit: number; sourceId?: string }) { return whenNotAborted(() => timelineReadsImpl.listTimelineOrphanPages(this.timelineRead, opts)); }
  listTimelineHistoryPages(sourceIds: readonly string[], q: timelineRepairImpl.TimelineHistoryQuery) { return timelineRepairImpl.listTimelineHistoryPages(this.timelineRead, sourceIds, q); }
  listTimelineVersionWitnesses(sourceId: string, slug: string) { return timelineRepairImpl.listTimelineVersionWitnesses(this.timelineRead, sourceId, slug); }
  readTimelineVersionBody(pageId: number, versionId: number) { return timelineRepairImpl.readTimelineVersionBody(this.timelineRead, pageId, versionId); }
  listTimelineMarkupRows(q: timelineRepairImpl.TimelineMarkupQuery) { return timelineRepairImpl.listTimelineMarkupRows(this.timelineRead, q); }
  listMaterializedMarkerPages(sourceIds: readonly string[], afterId: number) { return timelineRepairImpl.listMaterializedMarkerPages(this.timelineRead, sourceIds, afterId); }
  rewriteTimelineRow(pageId: number, row: timelineRepairImpl.TimelineRowRewrite) { return timelineRepairImpl.rewriteTimelineRow(this.autocommitSql, pageId, row); }
  listDateBulletPages(sourceIds: readonly string[], afterId: number, slugs: readonly string[], limit: number) { return timelineRepairImpl.listDateBulletPages(this.timelineRead, sourceIds, afterId, slugs, limit); }
  listConnectorFencePages(sourceIds: readonly string[], kinds: readonly string[], segmented: boolean) { return timelineRepairImpl.listConnectorFencePages(this.timelineRead, sourceIds, kinds, segmented); }
  private get telemetryRead() { return unscopedExecutor(this.engineSql, 'telemetry reads: master engine.executeRaw, unscoped'); }
  recordSearchTelemetry(bucket: SearchTelemetryBucket) { return telemetryImpl.recordSearchTelemetry(this.autocommitSql, bucket); }
  readSearchStats(cutoffDate: string) { return telemetryImpl.readSearchStats(this.telemetryRead, cutoffDate); }
  readClientOpUsage(days: number) { return telemetryImpl.readClientOpUsage(this.telemetryRead, days); }
  readMcpRollupPrunedBefore() { return telemetryImpl.readMcpRollupPrunedBefore(this.telemetryRead); }
  logMcpRequest(row: McpRequestLogRow) { return telemetryImpl.logMcpRequest(this.autocommitSql, row); }
  readMcpLogPruneCutoff(days: number) { return telemetryImpl.readMcpLogPruneCutoff(this.autocommitSql, days); }
  pruneMcpRequestLogBatch(cutoff: string, keepOperations: readonly string[], limit: number) { return telemetryImpl.pruneMcpRequestLogBatch(this.autocommitSql, cutoff, keepOperations, limit); }
  readMcpLifetimeUsage(tokenNames: readonly string[]) { return telemetryImpl.readMcpLifetimeUsage(this.telemetryRead, tokenNames); }
  countMcpRequestsLastDay(kind: McpRequestCountKind) { return telemetryImpl.countMcpRequestsLastDay(this.telemetryRead, kind); }
  readMcpRequestLogPage(spec: telemetryImpl.McpRequestLogPageSpec) { return telemetryImpl.readMcpRequestLogPage(this.telemetryRead, spec); }
  readPendingWriteHealth() { return telemetryImpl.readPendingWriteHealth(this.telemetryRead); }
  countMcpRequestsLastDayByToken(tokenNames: readonly string[]) { return telemetryImpl.countMcpRequestsLastDayByToken(this.telemetryRead, tokenNames); }
  logChatUsage(row: chatUsageImpl.ChatUsageLogRow) { return chatUsageImpl.logChatUsage(this.autocommitSql, row); }
  readChatUsage(days: number) { return chatUsageImpl.readChatUsage(this.telemetryRead, days); }
  readFieldUsageSamples(query: fieldUsageImpl.FieldUsageQuery) { return fieldUsageImpl.readFieldUsageSamples(unscopedExecutor(this.engineSql, 'field usage samples: master engine.executeRaw, unscoped'), query); }
  private get aliasFanoutRead() { return unscopedExecutor(this.engineSql, 'alias fan-out reads: master engine.executeRaw, unscoped'); }
  findPagesByTitles(titleNorms: readonly string[], sourceIds: readonly string[], types: readonly string[], opts?: { excludePrivate?: boolean }) { return aliasFanoutReadsImpl.findPagesByTitles(this.aliasFanoutRead, titleNorms, sourceIds, types, opts); }
  resolveCaseSensitiveAliases(aliasNorms: readonly string[], sourceIds: readonly string[]) { return this.engineRead(exec => aliasFanoutReadsImpl.resolveCaseSensitiveAliases(exec, aliasNorms, sourceIds)); }
  readPageTitle(sourceId: string, slug: string) { return this.engineRead(exec => aliasFanoutReadsImpl.readPageTitle(exec, sourceId, slug)); }
  readPageAliasRows(sourceIds: readonly string[], slugs: readonly string[]) { return this.engineRead(exec => aliasFanoutReadsImpl.readPageAliasRows(exec, sourceIds, slugs)); }
  readEntityAliasRows(sourceId: string, slugs: readonly string[]) { return this.engineRead(exec => aliasFanoutReadsImpl.readEntityAliasRows(exec, sourceId, slugs)); }
  listSlugAliases(sourceId: string) { return aliasFanoutReadsImpl.listSlugAliases(this.aliasFanoutRead, sourceId); }

  // v0.41.18.0: lazy-cached resolveBulkRetryOpts result. Constructor-time
  // resolution would force env validation at module-load, which breaks tests
  // that withEnv-mutate after engine construction. Lazy + cache-once preserves
  // doctor's "bad env surfaces at startup" UX (codex M-10) for the production
  // path where doctor runs first.
  private _bulkRetryOptsCache?: ReturnType<typeof resolveBulkRetryOpts>;
  private getBulkRetryOpts(): ReturnType<typeof resolveBulkRetryOpts> {
    if (!this._bulkRetryOptsCache) this._bulkRetryOptsCache = resolveBulkRetryOpts();
    return this._bulkRetryOptsCache;
  }

  /**
   * v0.41.18.0 — internal retry helper for the 3 batch primitives. Wraps fn
   * in withRetry with BULK_RETRY_OPTS defaults + env overrides + audit-site
   * label + AbortSignal. Audit JSONL emission on every retry attempt
   * (success path) and on exhausted retries (lost rows).
   *
   * The auditSite kwarg is type-guarded via BatchAuditSite enum; CI lint
   * `scripts/check-batch-audit-site.sh` enforces enum membership at build.
   */
  private async batchRetry<T>(
    auditSite: BatchAuditSite,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    batchSize: number,
  ): Promise<T> {
    const opts = this.getBulkRetryOpts();
    let prevDelay = 0;
    try {
      return await withRetry(fn, {
        maxRetries: opts.maxRetries,
        delayMs: opts.delayMs,
        delayMaxMs: opts.delayMaxMs,
        jitter: BULK_RETRY_OPTS.jitter,
        auditSite,
        signal,
        onRetry: (attempt, err) => {
          // Compute delay for this attempt for the audit record. withRetry
          // re-computes internally; this mirrors the math so the audit value
          // matches what actually sleeps.
          const delay = computeNextDelay(attempt - 1, prevDelay, opts.delayMs, opts.delayMaxMs, BULK_RETRY_OPTS.jitter);
          prevDelay = delay;
          auditLogBatchRetry(auditSite, batchSize, attempt, delay, err);
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[${auditSite}] connection blip, retrying (attempt ${attempt}/${opts.maxRetries}): ${msg}\n`);
        },
        // v0.41.25.0 (#1570): on null-singleton retryable errors, rebuild
        // the connection BEFORE the inter-attempt sleep so the next attempt
        // sees a live pool. `this.reconnect()` is race-safe via the
        // `_reconnecting` guard, handles both module and instance pools,
        // and is a fast no-op when the underlying client is still healthy
        // (postgres.js's own connection-replacement covers that case).
        // Fail-loud per retry.ts contract: a reconnect throw propagates
        // as the real cause, replacing the symptomatic
        // "No database connection" error. ctx carries the triggering error so
        // reconnect() can classify reap-vs-other for the pool-recovery audit.
        reconnect: (ctx) => this.reconnect(ctx),
      });
    } catch (err) {
      // Distinguish "retries exhausted" (a retryable error that ran out of
      // attempts) from "non-retryable" (caller bug, constraint violation,
      // etc.). Only the former counts as an exhausted-retry audit event.
      // withRetry propagates the last retryable error after exhausting
      // attempts — we re-classify via isRetryableConnError indirectly: if
      // the error reached us AND opts.maxRetries was hit, the audit row
      // matters. RetryAbortError (clean shutdown) skips audit.
      if (err instanceof Error && err.name === 'RetryAbortError') throw err;
      // Best-effort exhausted-retry log. If the error wasn't retryable in
      // the first place, isRetryableConnError(err) is false and we skip.
      // retry.ts is already in this module's static graph through withRetry, so
      // classifying the exhausted error does not need a second runtime import.
      if (isRetryableConnError(err)) {
        auditLogBatchExhausted(auditSite, batchSize, opts.maxRetries + 1, err);
      }
      throw err;
    }
  }

  // Chunks SQL lives once in ./engine-sql/chunks.ts (refactor wave 1, W1-extended).
  // The engine keeps the retry + transaction wrapper, the RLS scope
  // transaction and the source-scope / active-column resolution.
  async upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true } & BatchOpts): Promise<void> {
    if (this._chunkWritesInTransaction) return this._upsertChunksOnce(slug, chunks, opts);
    return this.batchRetry(opts?.auditSite ?? 'upsertChunks', opts?.signal,
      () => this.transaction(tx => (tx as PostgresEngine)._upsertChunksOnce(slug, chunks, opts)), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true }): Promise<void> {
    return chunksImpl.upsertChunksOnce(this.engineSql, {
      lockPageKeys: (keys) => this.lockPageKeys(keys),
      readPageSnapshot: (pageSlug, snapshotOpts) => this.readPageSnapshot(pageSlug, snapshotOpts),
      memo: (key, read) => transactionMemo(this, key, read),
    }, slug, chunks, opts);
  }

  getChunkWindows(requests: ChunkWindowRequest[], opts: ChunkWindowOpts): Promise<ChunkWindowPage[]> {
    return this.withScopedReadTransaction(opts.sourceIds?.length ? opts.sourceIds : undefined, opts.sourceIds?.length ? undefined : opts.sourceId,
      async tx => chunksImpl.getChunkWindows(scopedRead(this.engineSqlOn(tx)), requests, opts, requests.length > 0 && await chunkManifestReads(this, this.engineSqlOn(tx))));
  }

  async getChunks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean }): Promise<Chunk[]> {
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = opts?.sourceId ?? 'default';
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(sourceIds, sourceIds ? undefined : sourceId,
      async tx => chunksImpl.getChunks(scopedRead(this.engineSqlOn(tx)), column, slug, { sourceIds, sourceId }, { ...opts, chunkManifest: await chunkManifestReads(this, this.engineSqlOn(tx)) }));
  }

  async getChunkPage(slug: string, opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; requireSafeChunks?: boolean; fromIndex: number; limit: number }) {
    const sourceIds = opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = opts.sourceId ?? 'default';
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(sourceIds, sourceIds ? undefined : sourceId,
      async tx => chunksImpl.getChunkPage(scopedRead(this.engineSqlOn(tx)), column, slug, { sourceIds, sourceId }, { ...opts, chunkManifest: await chunkManifestReads(this, this.engineSqlOn(tx)) }));
  }

  /** S2: quoted identifier of the registry-ACTIVE embedding column for the
   *  health plane (getStats / getHealth) — read-only sites pass fallbackToLegacy
   *  so a broken registry row can't crash diagnostics. Callers prefix the
   *  table alias themselves (`cc.${colId}`). */
  private async activeEmbeddingColId(opts?: { fallbackToLegacy?: boolean }): Promise<string> {
    const col = await resolveActiveEmbeddingColumnFromEngine(this, opts);
    return quoteIdentifier(col.name);
  }

  countArchivedEmbeddingWork(opts: embedStaleWorkImpl.ArchivedEmbeddingWorkOpts) { return embedStaleWorkImpl.countArchivedEmbeddingWork(this.executeRaw.bind(this), opts); }
  countEmbedPendingProjections(scope: embedStaleWorkImpl.PendingProjectionScope) { return embedStaleWorkImpl.countEmbedPendingProjections(this.executeRaw.bind(this), scope); }
  listEmbedPendingProjections(scope: embedStaleWorkImpl.PendingProjectionScope, limit: number) { return embedStaleWorkImpl.listEmbedPendingProjections(this.executeRaw.bind(this), scope, limit); }
  listEmbedProjectionRepairPages(scope: embedStaleWorkImpl.PendingProjectionScope, afterPageId: number, limit: number) { return embedStaleWorkImpl.listEmbedProjectionRepairPages(this.executeRaw.bind(this), scope, afterPageId, limit); }
  readPageIsSegmented(pageId: number) { return embedStaleWorkImpl.readPageIsSegmented(this.executeRaw.bind(this), pageId); }
  hasEmbeddingSignatureDrift(opts: embedStaleWorkImpl.SignatureDriftOpts) { return embedStaleWorkImpl.hasEmbeddingSignatureDrift(this.executeRaw.bind(this), opts); }
  readPageProvenanceComplete(slug: string, sourceId: string, model: string, dims: number | null, column: string) { return embeddingProvenanceImpl.readPageProvenanceComplete(this, slug, sourceId, model, dims, column); }
  listUnembeddedChunkIndexes(slug: string, sourceId: string, column: string) { return embedStaleWorkImpl.listUnembeddedChunkIndexes(this.executeRaw.bind(this), slug, sourceId, column); }
  sumEmbedBackfillChars(sourceId: string | null, all: boolean) { return embedStaleWorkImpl.sumEmbedBackfillChars(this.executeRaw.bind(this), sourceId, all); }
  lockContentDriftState(key: string, initial: string) { return embedStaleWorkImpl.lockContentDriftState(this.executeRaw.bind(this), key, initial); }
  invalidateContentDriftChunks(window: embedStaleWorkImpl.ContentDriftChunkWindow) { return embedStaleWorkImpl.invalidateContentDriftChunks(this.executeRaw.bind(this), window); }
  async countStaleChunks(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => chunksImpl.countStaleChunks(scopedRead(this.engineSqlOn(tx)), column, opts));
  }

  async sumStaleChunkChars(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.sumStaleChunkChars(unscopedExecutor(this.engineSql, 'chunks: unscoped on master (EO4 inventory)'), column, opts);
  }

  async setPageEmbeddingSignature(slug: string, opts: { sourceId?: string; signature: string }): Promise<void> {
    return chunksImpl.setPageEmbeddingSignature(this.engineSql, slug, opts);
  }

  async invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string; includeNullSignature?: boolean }): Promise<number> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this)).name;
    return chunksImpl.invalidateStaleSignatureEmbeddings(fn => this.transaction(fn), column, opts);
  }

  async invalidateContentDriftEmbeddings(opts?: { sourceId?: string }): Promise<number> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this)).name;
    return chunksImpl.invalidateContentDriftEmbeddings(fn => this.transaction(fn), column, opts);
  }

  async listStaleChunks(opts?: {
    batchSize?: number;
    afterPageId?: number;
    afterChunkIndex?: number;
    sourceId?: string;
    orderBy?: 'page_id' | 'updated_desc';
    afterUpdatedAt?: string | null;
  }): Promise<StaleChunkRow[]> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => chunksImpl.listStaleChunks(scopedRead(this.engineSqlOn(tx)), column, opts));
  }

  async countChunklessPagesWithContent(opts?: { sourceId?: string }): Promise<number> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => chunksImpl.countChunklessPagesWithContent(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async listChunklessPagesWithContent(opts?: { batchSize?: number; afterPageId?: number; sourceId?: string }): Promise<ChunklessPageRow[]> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => chunksImpl.listChunklessPagesWithContent(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async readEmbeddingStateCounts(opts: { mode: 'ops' | 'full'; sourceIds?: string[]; purgeWindowHours: number }): Promise<EmbeddingStateCounts> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(opts.sourceIds, undefined, tx => chunksImpl.readEmbeddingStateCounts(scopedRead(this.engineSqlOn(tx)), column, opts));
  }

  async listEmbeddingStateRows(opts: { sourceIds?: string[]; slugs?: string[]; states: readonly EmbeddingState[]; limit: number; purgeWindowHours: number }): Promise<EmbeddingStateRow[]> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(opts.sourceIds, undefined, tx => chunksImpl.listEmbeddingStateRows(scopedRead(this.engineSqlOn(tx)), column, opts));
  }

  async sealChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; expectedRevision?: string }): Promise<void> {
    await this.transaction(tx => { const e = tx as PostgresEngine; return chunksImpl.sealChunks(e.engineSql, e, slug, chunks, opts); });
  }

  async ownerOnlyMarkTriggers(opts?: { ensure?: boolean; installing?: boolean }): Promise<OwnerOnlyTriggerState> {
    return ownerOnlyMarksImpl.ownerOnlyMarkTriggers(this.engineSql, opts);
  }

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunks(this.engineSql, slug, opts);
  }

  async deleteChunksExcept(slug: string, keepIds: readonly number[], opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunksExcept(this.autocommitSql, slug, keepIds, opts);
  }

  async setChunkerVersion(slug: string, version: number, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.setChunkerVersion(this.autocommitSql, slug, version, opts);
  }

  async writeTextProjectionSeal(slug: string, opts: { sourceId: string; revision: string; timelineText: string }): Promise<void> {
    return chunksImpl.writeTextProjectionSeal(this.autocommitSql, slug, opts);
  }

  async moveChunkIndexes(pageId: number, waves: readonly (readonly ChunkMove[])[]): Promise<void> {
    return chunksImpl.moveChunkIndexes(this.autocommitSql, pageId, waves);
  }

  async getChunkReuseRows(slug: string, opts?: { sourceId?: string }): Promise<ChunkReuseRow[]> {
    return this.preparationRead(exec => chunksImpl.getChunkReuseRows(unscopedExecutor(exec, 'chunks: import reuse read ran unscoped on the pool on master (executeRaw)'), slug, opts));
  }

  async countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked'; held?: 'exclude' | 'only'; wantedProducers?: readonly string[] }): Promise<number> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => pagesImpl.countStalePagesForExtraction(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
    held?: 'exclude';
    wantedProducers?: readonly string[];
  }): Promise<StalePageRow[]> {
    return this.withScopedReadTransaction(undefined, opts.sourceId, tx => pagesImpl.listStalePagesForExtraction(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number> {
    return pagesImpl.markPagesExtractedBatch(this.engineSql, refs, defaultExtractedAt);
  }

  async markPagesAttendanceBlocked(refs: Array<{ slug: string; source_id: string; revision: string }>): Promise<number> {
    return pagesImpl.markPagesAttendanceBlocked(this.engineSql, refs);
  }
  async countStaleFrontmatterKeyPages(opts: { sourceIds: string[] }) { return this.withScopedReadTransaction(opts.sourceIds, undefined, tx => pagesImpl.countStaleFrontmatterKeyPages(scopedRead(this.engineSqlOn(tx)), opts)); }
  async listStaleFrontmatterKeyPages(opts: { sourceId: string; afterId: number; limit: number }) { return this.withScopedReadTransaction(undefined, opts.sourceId, tx => pagesImpl.listStaleFrontmatterKeyPages(scopedRead(this.engineSqlOn(tx)), opts)); }
  async stripStaleFrontmatterKeys(opts: { sourceId: string; ids: number[] }) { return pagesImpl.stripStaleFrontmatterKeys(this.engineSql, opts); }

  // Links
  async addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
    opts?: { fromSourceId?: string; toSourceId?: string; originSourceId?: string },
  ): Promise<void> {
    return linksImpl.addLink(this.engineSql, from, to, context, linkType, linkSource, originSlug, originField, opts);
  }

  async addLinksBatch(links: LinkBatchInput[], opts?: BatchOpts): Promise<number> {
    if (links.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addLinksBatch', opts?.signal, () => linksImpl.addLinksBatch(this.engineSql, links), links.length);
  }

  async replaceDerivedLinks(origin: DerivedLinkOrigin, links: LinkBatchInput[], opts?: DerivedLinkReplacementOptions) {
    return replaceDerivedLinks(this, origin, links, opts);
  }

  async replaceDerivedLinksBatch(items: readonly DerivedLinkBatchItem[]) {
    return replaceDerivedLinksBatch(this, items);
  }

  // Wanted-link writes (engine-sql/wanted-links.ts), on the current connection: the caller's transaction when there is
  // one. autocommitSql retries a statement a read-only session default refused, as the executeRaw calls they replace did.
  lockRegisteredSourceIds(sourceIds: readonly string[]) { return this.lockingPreparationRead(exec => wantedLinksImpl.lockRegisteredSourceIds(exec, sourceIds)); }
  replaceWantedLinkRows(origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement) {
    return wantedLinksImpl.replaceWantedLinkRows(this.autocommitSql, origin, replacement);
  }

  // #3674 — see BrainEngine.removeLinksByPagesAndSource JSDoc. Identical SQL
  // shape in PGLiteEngine (parity). JSONB recordset binding (never
  // JSON.stringify into ::jsonb — executeRawJsonb passes raw objects).
  async removeLinksByPagesAndSource(
    pages: Array<{ slug: string; source_id: string }>,
    opts: {
      linkSource: string;
      keepTypedNerPairs?: Array<{
        from_slug: string; from_source_id: string;
        to_slug: string; to_source_id: string;
      }>;
    },
  ): Promise<number> {
    return linksImpl.removeLinksByPagesAndSource(this.engineSql, pages, opts);
  }

  async removeLink(
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<number> {
    return linksImpl.removeLink(this.engineSql, from, to, linkType, linkSource, opts);
  }

  async getLinks(slug: string, opts?: import("./link-validity.ts").LinkReadScope): Promise<Link[]> {
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => linksImpl.getLinks(scopedRead(this.engineSqlOn(tx)), slug, opts));
  }

  async getBacklinks(slug: string, opts?: import("./link-validity.ts").LinkReadScope): Promise<Link[]> {
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => linksImpl.getBacklinks(scopedRead(this.engineSqlOn(tx)), slug, opts));
  }

  async listLinkSources(
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]> {
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => linksImpl.listLinkSources(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
    sourceId?: string,
  ): Promise<{ slug: string; similarity: number } | null> {
    return this.engineSqlRead(exec => pagesImpl.findByTitleFuzzy(unscopedExecutor(exec, 'pages: unscoped on master (EO4 inventory)'), name, dirPrefix, minSimilarity, sourceId));
  }

  async traverseGraph(
    slug: string,
    depth: number = 5,
    opts?: import('./engine.ts').TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    return linksImpl.traverseGraph(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), slug, depth, opts);
  }

  async traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
  ): Promise<GraphPath[]> {
    return (await this.traversePathsDetailed(slug, opts)).paths;
  }

  async traversePathsDetailed(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
  ): Promise<{ paths: GraphPath[]; truncated: boolean }> {
    return linksImpl.traversePathsDetailed(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), slug, opts);
  }

  async relationalFanout(
    seeds: string[],
    opts?: import('./types.ts').RelationalFanoutOpts,
  ): Promise<import('./types.ts').RelationalFanoutRow[]> {
    return readRelationalFanout(this.executeRaw.bind(this), seeds, opts, await chunkManifestReads(this));
  }

  async relationalChainHop(frontierPageIds: number[], opts: import('./types.ts').ChainHopOpts): Promise<import('./types.ts').ChainHopEdge[]> {
    return readChainHop(this.executeRaw.bind(this), frontierPageIds, opts, await chunkManifestReads(this));
  }

  async getBacklinkCounts(pageIds: number[], opts?: PageReadScope): Promise<Map<number, number>> {
    // JIT off (search-settings.ts): ~370 expanded-query ids cross jit_above_cost; at 50k compiling was ~140 of ~170 ms.
    return !pageIds.length ? new Map() : this.jitOffRead(tx => readBacklinkCounts(async (query, params) =>
      Array.from(await tx.unsafe(query, params as never, { prepare: true })) as never, pageIds, opts));
  }

  async getAdjacencyBoosts(pageIds: number[], opts?: PageReadScope): Promise<Map<number, import('./types.ts').AdjacencyRow>> {
    return readAdjacencyBoosts(this.executeRaw.bind(this), pageIds, opts);
  }

  async getContentFlagsByPageIds(pageIds: number[], opts?: PageReadScope): Promise<Map<number, { reason: string; detail: string }>> {
    return readContentFlags(this.executeRaw.bind(this), pageIds, opts);
  }

  async getUnverifiedExtractionPageIds(pageIds: number[], opts?: PageReadScope): Promise<Map<number, { unverified: boolean; status: string }>> {
    return readExtractionStates(this.executeRaw.bind(this), pageIds, opts);
  }

  async getPageTimestamps(slugs: string[]): Promise<Map<string, Date>> {
    return pagesImpl.getPageTimestamps(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), slugs);
  }

  async getEffectiveDates(refs: Array<{slug: string; source_id: string}>, opts?: PageReadScope): Promise<Map<string, Date>> {
    return readEffectiveDates(this.executeRaw.bind(this), refs, opts);
  }

  async getSalienceScores(refs: Array<{slug: string; source_id: string}>, opts?: PageReadPolicy): Promise<Map<string, number>> {
    return readSalienceScores(this.executeRaw.bind(this), refs, opts);
  }

  async findOrphanPages(opts?: {
    sourceId?: string;
    sourceIds?: string[];
    excludePrivate?: boolean;
    mode?: 'inbound' | 'islanded'; scopeInbound?: boolean;
  }): Promise<Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean; source_id?: string }>> {
    return linksImpl.findOrphanPages(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), opts);
  }

  // Tags
  async addTag(slug: string, tag: string, opts?: { sourceId?: string; tagSource?: 'frontmatter' }): Promise<void> {
    return mutatePageTag(this, { sourceId: opts?.sourceId ?? 'default', slug }, tag, true, opts?.tagSource);
  }

  async removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    return mutatePageTag(this, { sourceId: opts?.sourceId ?? 'default', slug }, tag, false);
  }

  async pruneFrontmatterTags(slug: string, keep: readonly string[], opts?: { sourceId?: string }): Promise<void> {
    return tagsImpl.pruneFrontmatterTags(refuseAborted(this.autocommitSql), slug, keep, opts);
  }

  async addPageTagsById(pageId: number, tags: readonly string[], opts?: { tagSource?: 'frontmatter' }): Promise<void> {
    return tagsImpl.addPageTagsById(this.autocommitSql, pageId, tags, opts);
  }

  async getTags(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; liveOnly?: boolean }): Promise<string[]> {
    return tagsImpl.getTags(unscopedExecutor(this.engineSql, 'tags: unscoped on master (EO4 inventory)'), slug, opts);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<boolean> {
    return timelineImpl.addTimelineEntry(this.engineSql, slug, entry, opts);
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[], opts?: BatchOpts): Promise<number> {
    if (entries.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addTimelineEntriesBatch', opts?.signal, () => timelineImpl.addTimelineEntriesBatch(this.engineSql, entries), entries.length);
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    return timelineImpl.getTimeline(unscopedExecutor(this.engineSql, 'timeline: unscoped on master (EO4 inventory)'), slug, opts);
  }

  async getTimelineForDate(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    return timelineImpl.getTimelineForDate(unscopedExecutor(this.engineSql, 'timeline: unscoped on master (EO4 inventory)'), date, opts);
  }

  async getSince(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    return timelineImpl.getSince(unscopedExecutor(this.engineSql, 'timeline: unscoped on master (EO4 inventory)'), date, opts);
  }

  async getOnThisDay(opts?: PageReadScope & { date?: string; limit?: number }): Promise<ChronicleTimelineRow[]> {
    return timelineImpl.getOnThisDay(unscopedExecutor(this.engineSql, 'timeline: unscoped on master (EO4 inventory)'), opts);
  }

  async getLastSeen(entitySlug: string, opts?: PageReadScope & { asof?: string }): Promise<LastSeenResult> {
    return timelineImpl.getLastSeen(unscopedExecutor(this.engineSql, 'timeline: unscoped on master (EO4 inventory)'), entitySlug, opts);
  }

  async upsertEventProjection(opts: { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string }): Promise<{ projected: boolean }> {
    return timelineImpl.upsertEventProjection(this.engineSql, opts);
  }

  removeTimelineRows(pageId: number, rows: readonly timelineImpl.TimelineRowRemoval[]) { return timelineImpl.removeTimelineRows(this.autocommitSql, pageId, rows); }
  updateTimelineDetails(pageId: number, rows: readonly timelineImpl.TimelineDetailRefresh[]) { return timelineImpl.updateTimelineDetails(this.autocommitSql, pageId, rows); }
  insertCanonicalTimelineRows(pageId: number, rows: readonly timelineImpl.CanonicalTimelineRow[]) { return timelineImpl.insertCanonicalTimelineRows(this.autocommitSql, pageId, rows); }
  readNewestTimelineEntryId(sourceId: string, slug: string, date: string, summary: string) { return timelineImpl.readNewestTimelineEntryId(this.autocommitSql, sourceId, slug, date, summary); }

  async mergeOntologyFact(obs: OntologyObservationInput): Promise<OntologyMergeResult> {
    const sql = this.sql;
    const sourceId = obs.sourceId ?? 'default';
    const dimension = normalizeDimension(obs.dimension);
    const vh = valueHash(obs.value);
    const conf = obs.confidence ?? 0.7;
    const status = obs.status ?? (isNovelDimension(dimension) ? 'quarantined' : 'active');
    const visibility = obs.visibility ?? 'private';
    const validFrom = obs.validFrom ?? null;
    const validUntil = obs.validTo ?? null;
    const factText = `${dimension}: ${obs.value}`;

    // The "current open" row is the open-ended one (valid_until IS NULL) that
    // hasn't been retracted (expired_at IS NULL). Supersession closes its
    // valid_until rather than expiring it, so --asof time-travel still sees it.
    const cur = await sql<{ id: number; value_hash: string; valid_from: string | null }[]>`
      SELECT id, value_hash, valid_from FROM facts
       WHERE source_id = ${sourceId} AND entity_slug = ${obs.entitySlug}
         AND dimension = ${dimension} AND expired_at IS NULL AND valid_until IS NULL
         AND (dim_status IS NULL OR dim_status = 'active') AND ${sql.unsafe(NOT_CONVERSATION_SLOT_SQL)}
       ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC
       LIMIT 1`;
    const current = cur[0];
    // GBRA-574 B2: a conversation fact holding this exact stint key gives up its slot, so the observation is stored.
    const freeKey = () => validFrom == null ? null : sql`UPDATE facts SET dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
      WHERE source_id = ${sourceId} AND entity_slug = ${obs.entitySlug} AND dimension = ${dimension} AND value_hash = ${vh}
        AND source_markdown_slug = ${obs.source} AND valid_from = ${validFrom}::timestamptz AND ${sql.unsafe(CONVERSATION_SLOT_SQL)}`;

    if (current && current.value_hash === vh && !isBackdatedObservation(validFrom, current.valid_from)) {
      // Same value → corroboration, or noop when this provenance already
      // observed the value during the current stint.
      const seen = await sql`
        SELECT 1 FROM facts
         WHERE source_id = ${sourceId} AND entity_slug = ${obs.entitySlug} AND dimension = ${dimension}
           AND value_hash = ${vh} AND source_markdown_slug = ${obs.source} AND ${sql.unsafe(NOT_CONVERSATION_SLOT_SQL)}
           AND COALESCE(valid_from, '-infinity'::timestamptz) >= COALESCE(${current.valid_from}::timestamptz, '-infinity'::timestamptz)
         LIMIT 1`;
      if (seen.length) return { action: 'noop', factId: null, supersededId: null };
      await freeKey();
      const ins = await sql<{ id: number }[]>`
        INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                           confidence, source, source_markdown_slug, valid_from, valid_until, expired_at, consolidated_into)
        VALUES (${sourceId}, ${obs.entitySlug}, ${factText}, 'fact', ${visibility}, ${dimension}, ${obs.value}, ${vh}, ${status},
                ${conf}, ${obs.source}, ${obs.source}, COALESCE(${validFrom}::timestamptz, now()), ${validUntil}, now(), ${current.id})
        ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from) WHERE dimension IS NOT NULL
        DO NOTHING
        RETURNING id`;
      return ins.length
        ? { action: 'corroborated', factId: Number(ins[0].id), supersededId: null }
        : { action: 'noop', factId: null, supersededId: null };
    }

    await freeKey();
    const ins = await sql<{ id: number }[]>`
      INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                         confidence, source, source_markdown_slug, valid_from, valid_until)
      VALUES (${sourceId}, ${obs.entitySlug}, ${factText}, 'fact', ${visibility}, ${dimension}, ${obs.value}, ${vh}, ${status},
              ${conf}, ${obs.source}, ${obs.source}, COALESCE(${validFrom}::timestamptz, now()), ${validUntil})
      ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from) WHERE dimension IS NOT NULL
      DO NOTHING
      RETURNING id`;
    if (!ins.length) return { action: 'noop', factId: null, supersededId: null };
    const newId = Number(ins[0].id);

    let supersededId: number | null = null;
    if (current && status === 'active') {
      const forward = validFrom == null || current.valid_from == null
        || new Date(validFrom).getTime() >= new Date(current.valid_from).getTime();
      if (forward) {
        // Close the prior row's valid window at the new fact's valid_from (or now()).
        const closed = await sql`UPDATE facts SET valid_until = COALESCE(${validFrom}::timestamptz, now()), superseded_by = ${newId}
                   WHERE id = ${current.id} AND valid_until IS NULL${sql.unsafe(ONTOLOGY_SUPERSEDE_GUARD)} RETURNING id`;
        supersededId = closed.length ? Number(current.id) : null;
      }
    }
    return { action: supersededId ? 'superseded_prior' : 'inserted', factId: newId, supersededId };
  }

  async getOntology(entitySlug: string, opts?: OntologyReadOpts): Promise<OntologyValue[]> {
    const sql = this.sql;
    const minConf = opts?.minConfidence ?? 0;
    const includeQ = opts?.includeQuarantined ?? false;
    const asof = opts?.asof ?? null;
    const scope = opts?.sourceIds && opts.sourceIds.length
      ? sql`AND source_id = ANY(${opts.sourceIds})`
      : sql`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
    // Provenance/entity page gates and the deleted-page hide, BEFORE DISTINCT ON: the caller gets the newest value they may see.
    const privacy = sql.unsafe(`AND ${deletedPageProjectionHiddenSql('facts', 'facts')}${opts?.excludePrivate ? ` AND ${privateFactFilterForReader('facts')}` : ''}${opts?.excludeDiary ? ` AND NOT starts_with(COALESCE(source_markdown_slug, ''), 'life/diary/')` : ''}`);
    const visibility = opts?.visibility ? sql`AND visibility = ANY(${opts.visibility})` : sql``;
    const rows = await sql<OntologyValue[]>`
      SELECT DISTINCT ON (dimension COLLATE "C")
        dimension, value, confidence,
        source_markdown_slug AS source, valid_from, valid_until AS valid_to,
        COALESCE(dim_status, 'active') AS status, id AS fact_id
      FROM facts
      WHERE entity_slug = ${entitySlug} AND dimension IS NOT NULL AND expired_at IS NULL AND ${sql.unsafe(NOT_CONVERSATION_SLOT_SQL)}
        ${scope} ${privacy} ${visibility}
        AND COALESCE(valid_from, '-infinity'::timestamptz) <= COALESCE(${asof}::timestamptz, now())
        AND COALESCE(valid_until, 'infinity'::timestamptz) > COALESCE(${asof}::timestamptz, now())
        AND confidence >= ${minConf}
        AND (${includeQ}::boolean OR dim_status IS NULL OR dim_status = 'active')
      ORDER BY dimension COLLATE "C", valid_from DESC NULLS LAST, confidence DESC, id DESC`;
    return rows.map((r) => ({ ...r, confidence: Number(r.confidence), fact_id: Number(r.fact_id) }));
  }

  async discoverOntologyDimensions(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<OntologyDimensionStat[]> {
    const sql = this.sql;
    const scope = opts?.sourceIds && opts.sourceIds.length
      ? sql`AND source_id = ANY(${opts.sourceIds})`
      : sql`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
    const rows = await sql<{ dimension: string; entities: number; observations: number }[]>`
      SELECT dimension, count(DISTINCT entity_slug)::int AS entities, count(*)::int AS observations
      FROM facts
      WHERE dimension IS NOT NULL AND expired_at IS NULL AND ${sql.unsafe(NOT_CONVERSATION_SLOT_SQL)} ${scope}
      GROUP BY dimension ORDER BY entities DESC, dimension COLLATE "C"`;
    return rows.map((r) => ({ dimension: r.dimension, entities: Number(r.entities), observations: Number(r.observations) }));
  }

  // The ontology re-key and repair statements (engine-sql/ontology-repair.ts).
  listRekeyLosers(sourceId: string, move: ontologyRepairImpl.RekeyMove) { return ontologyRepairImpl.listRekeyLosers(this.executeRaw.bind(this), sourceId, move); }
  repointSupersededToKept(ids: number[], keeps: number[]) { return ontologyRepairImpl.repointSupersededToKept(this.executeRaw.bind(this), ids, keeps); }
  clearOntologySlots(ids: number[]) { return ontologyRepairImpl.clearOntologySlots(this.executeRaw.bind(this), ids); }
  deleteRekeyLosers(ids: number[]) { return ontologyRepairImpl.deleteRekeyLosers(this.executeRaw.bind(this), ids); }
  restoreOntologyFact(row: ontologyRepairImpl.OntologyFactRestore) { return ontologyRepairImpl.restoreOntologyFact(this.executeRaw.bind(this), row); }

  async findOntologyConflicts(opts?: PageReadScope & Pick<OntologyReadOpts, 'minConfidence' | 'visibility' | 'excludeDiary'>): Promise<OntologyConflict[]> {
    const sql = this.sql;
    const minConf = opts?.minConfidence ?? 0;
    const scope = opts?.sourceIds && opts.sourceIds.length
      ? sql`AND source_id = ANY(${opts.sourceIds})`
      : sql`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
    // Same page gates as getOntology, inside the CTE so a conflict
    // that only exists because of a hidden provenance is never reported.
    const privacy = sql.unsafe(`AND ${deletedPageProjectionHiddenSql('facts', 'facts')}${opts?.excludePrivate ? ` AND ${privateFactFilterForReader('facts')}` : ''}${opts?.excludeDiary ? ` AND NOT starts_with(COALESCE(source_markdown_slug, ''), 'life/diary/')` : ''}`);
    const visibility = opts?.visibility ? sql`AND visibility = ANY(${opts.visibility})` : sql``;
    const rows = await sql<{ entity_slug: string; dimension: string; values: OntologyConflict['values'] }[]>`
      WITH cur AS (
        SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
        FROM facts
        WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL AND ${sql.unsafe(NOT_CONVERSATION_SLOT_SQL)}
          AND (dim_status IS NULL OR dim_status = 'active')
          AND confidence >= ${minConf} ${scope} ${privacy} ${visibility}
      )
      SELECT entity_slug, dimension,
             json_agg(json_build_object('value', value, 'source', source, 'confidence', confidence, 'fact_id', fact_id) ORDER BY fact_id) AS values
      FROM cur
      GROUP BY entity_slug, dimension
      HAVING count(DISTINCT value) >= 2 AND count(DISTINCT source) >= 2
      ORDER BY entity_slug COLLATE "C", dimension COLLATE "C"`;
    return rows.map((r) => ({ entity_slug: r.entity_slug, dimension: r.dimension, values: r.values }));
  }

  // Raw data
  async putRawData(
    slug: string,
    source: string,
    data: object,
    opts?: { sourceId?: string },
  ): Promise<void> {
    const sql = this.sql;
    // v0.31.8 (D21): two-branch INSERT-SELECT. Without opts.sourceId, the
    // page-id lookup matches every same-slug page (pre-v0.31.8 behavior).
    // With opts.sourceId, the lookup is source-scoped.
    if (opts?.sourceId) {
      const result = await sql`
        INSERT INTO raw_data (page_id, source, data)
        SELECT id, ${source}, ${sql.json(data as Parameters<typeof sql.json>[0])}
        FROM pages WHERE slug = ${slug} AND source_id = ${opts.sourceId}
        ON CONFLICT (page_id, source) DO UPDATE SET
          data = EXCLUDED.data,
          fetched_at = now()
        RETURNING id
      `;
      if (result.length === 0) {
        throw new Error(`putRawData failed: page "${slug}" (source=${opts.sourceId}) not found`);
      }
      return;
    }
    const result = await sql`
      INSERT INTO raw_data (page_id, source, data)
      SELECT id, ${source}, ${sql.json(data as Parameters<typeof sql.json>[0])}
      FROM pages WHERE slug = ${slug}
      ON CONFLICT (page_id, source) DO UPDATE SET
        data = EXCLUDED.data,
        fetched_at = now()
      RETURNING id
    `;
    if (result.length === 0) throw new Error(`putRawData failed: page "${slug}" not found`);
  }

  async getRawData(
    slug: string,
    source?: string,
    opts?: PageReadScope & { includeDeleted?: boolean },
  ): Promise<RawData[]> {
    const sql = this.sql;
    const privacy = opts?.excludePrivate ? sql.unsafe(`AND ${privatePagesFilterForCaller('p')}`) : sql``;
    const alive = opts?.includeDeleted ? sql`` : sql`AND p.deleted_at IS NULL`; // raw_data follows the page soft-delete
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = sourceIds ? undefined : opts?.sourceId;
    let rows;
    if (source && sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ANY(${sourceIds}::text[]) ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    } else if (sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND p.source_id = ANY(${sourceIds}::text[]) ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    } else if (source && sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ${sourceId} ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    } else if (source) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source} ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    } else if (sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND p.source_id = ${sourceId} ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    } else {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`;
    }
    return rows as unknown as RawData[];
  }

  // Files SQL lives once in ./engine-sql/files.ts (refactor wave 1, W1-extended).
  async upsertFile(spec: FileSpec): Promise<{ id: number; created: boolean }> {
    return filesImpl.upsertFile(this.engineSql, spec);
  }

  async getFile(sourceId: string, storagePath: string): Promise<FileRow | null> {
    return filesImpl.getFile(unscopedExecutor(this.engineSql, 'files: unscoped on master (EO4 inventory)'), sourceId, storagePath);
  }

  async listFilesForPage(pageId: number): Promise<FileRow[]> {
    return filesImpl.listFilesForPage(unscopedExecutor(this.engineSql, 'files: unscoped on master (EO4 inventory)'), pageId);
  }

  listFiles(opts: ListFilesOptions) { return filesImpl.listFiles(unscopedExecutor(this.engineSql, 'files: unscoped on master (EO4 inventory)'), opts); }
  // The files commands' and file operations' statements (engine-sql/files-ops.ts).
  hasFileWithHash(contentHash: string, storagePath: string) { return filesOpsImpl.hasFileWithHash(this.executeRaw.bind(this), contentHash, storagePath); }
  listFileRowsForVerify() { return filesOpsImpl.listFileRowsForVerify(this.executeRaw.bind(this)); }
  readSourceLocalPathForVerify(sourceId: string) { return filesOpsImpl.readSourceLocalPathForVerify(this.executeRaw.bind(this), sourceId); }
  upsertCliFileRow(row: filesOpsImpl.FileRowScalars, metadata: filesOpsImpl.FileMetadata) { return filesOpsImpl.upsertCliFileRow(this.executeRaw.bind(this), row, metadata); }
  upsertRawFileRow(row: filesOpsImpl.FileRowScalars & { source_id: string }, metadata: filesOpsImpl.FileMetadata) { return filesOpsImpl.upsertRawFileRow(this.executeRaw.bind(this), row, metadata); }
  upsertSyncFileRow(row: filesOpsImpl.FileRowScalars, metadata: filesOpsImpl.FileMetadata) { return filesOpsImpl.upsertSyncFileRow(this.executeRaw.bind(this), row, metadata); }
  sourceIdExists(sourceId: string) { return filesOpsImpl.sourceIdExists(this.executeRaw.bind(this), sourceId); }
  readPageIdInSource(slug: string, sourceId: string) { return filesOpsImpl.readPageIdInSource(this.executeRaw.bind(this), slug, sourceId); }
  readFileOwner(storagePath: string) { return filesOpsImpl.readFileOwner(this.executeRaw.bind(this), storagePath); }
  claimFilePage(storagePath: string, sourceId: string, pageId: number) { return filesOpsImpl.claimFilePage(this.executeRaw.bind(this), storagePath, sourceId, pageId); }
  upsertOpFileRow(row: filesOpsImpl.FileRowScalars & { source_id: string; page_id: number | null }, metadata: filesOpsImpl.FileMetadata) { return filesOpsImpl.upsertOpFileRow(this.executeRaw.bind(this), row, metadata); }
  listReadableFileRows(slug: string | undefined, excludePrivate: boolean) { return filesOpsImpl.listReadableFileRows(this.executeRaw.bind(this), slug, excludePrivate); }
  readReadableFileForUrl(storagePath: string, excludePrivate: boolean) { return filesOpsImpl.readReadableFileForUrl(this.executeRaw.bind(this), storagePath, excludePrivate); }
  readReadablePageId(slug: string, sourceId: string, excludePrivate: boolean) { return filesOpsImpl.readReadablePageId(this.executeRaw.bind(this), slug, sourceId, excludePrivate); }
  countUnreadableFilesAt(storagePath: string, excludePrivate: boolean) { return filesOpsImpl.countUnreadableFilesAt(this.executeRaw.bind(this), storagePath, excludePrivate); }
  countFilesRegisteredElsewhere(identity: filesOpsImpl.RegisteredFileIdentity) { return filesOpsImpl.countFilesRegisteredElsewhere(this.executeRaw.bind(this), identity); }
  registerFileRow(row: filesOpsImpl.FileRowScalars & { source_id: string; page_id: number | null }, metadata: filesOpsImpl.FileMetadata) { return filesOpsImpl.registerFileRow(this.executeRaw.bind(this), row, metadata); }
  readReadableFileForVerify(storagePath: string, excludePrivate: boolean) { return filesOpsImpl.readReadableFileForVerify(this.executeRaw.bind(this), storagePath, excludePrivate); }
  listReadableFilePaths(slug: string | undefined, excludePrivate: boolean) { return filesOpsImpl.listReadableFilePaths(this.executeRaw.bind(this), slug, excludePrivate); }

  // Dream-cycle triage verdict cache (v0.23 boolean era; widened by #4152 triage-v1).
  async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
    const sql = this.sql;
    const rows = await sql<Array<{
      worth_processing: boolean;
      reasons: string[] | null;
      judged_at: Date;
      score: number | null;
      content_type: string | null;
      segments: Array<{ quote: string; note?: string }> | null;
      entities: string[] | null;
      model: string | null;
      triage_version: number | null;
    }>>`
      SELECT worth_processing, reasons, judged_at,
             score, content_type, segments, entities, model, triage_version
      FROM dream_verdicts
      WHERE file_path = ${filePath} AND content_hash = ${contentHash}
        -- NULL = pre-TTL row in the #4657 bootstrap window; a miss here re-judges the corpus
        AND (expires_at IS NULL OR expires_at > now())
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      worth_processing: r.worth_processing,
      reasons: r.reasons ?? [],
      judged_at: r.judged_at instanceof Date ? r.judged_at.toISOString() : String(r.judged_at),
      score: r.score ?? null,
      content_type: r.content_type ?? null,
      segments: r.segments ?? [],
      entities: r.entities ?? [],
      model: r.model ?? null,
      triage_version: r.triage_version ?? null,
    };
  }

  async putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void> {
    const sql = this.sql;
    verdict = wellFormedJson(verdict);
    // Expiry is computed server-side (now() + TTL) so it lives on the same
    // clock as the `expires_at > now()` read predicate and judged_at.
    await sql`
      INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons,
                                  score, content_type, segments, entities, model, triage_version,
                                  expires_at)
      VALUES (${filePath}, ${contentHash}, ${verdict.worth_processing}, ${sql.json(verdict.reasons as Parameters<typeof sql.json>[0])},
              ${verdict.score}, ${verdict.content_type}, ${sql.json(verdict.segments as unknown as Parameters<typeof sql.json>[0])},
              ${sql.json(verdict.entities as Parameters<typeof sql.json>[0])}, ${verdict.model}, ${verdict.triage_version},
              now() + make_interval(secs => ${DREAM_VERDICT_TTL_SECONDS}))
      ON CONFLICT (file_path, content_hash) DO UPDATE SET
        worth_processing = EXCLUDED.worth_processing,
        reasons = EXCLUDED.reasons,
        score = EXCLUDED.score,
        content_type = EXCLUDED.content_type,
        segments = EXCLUDED.segments,
        entities = EXCLUDED.entities,
        model = EXCLUDED.model,
        triage_version = EXCLUDED.triage_version,
        judged_at = now(),
        expires_at = EXCLUDED.expires_at
    `;
  }

  async sweepDreamVerdicts(): Promise<number> {
    const sql = this.sql;
    const result = await sql`DELETE FROM dream_verdicts WHERE expires_at <= now()`;
    return result.count ?? 0;
  }

  // Dream-cycle statements (engine-sql/dream-cycle.ts).
  listDreamQueueCandidates() { return dreamCycleImpl.listDreamQueueCandidates(this.executeRaw.bind(this)); }
  listLiveDreamCycleLocks(graceSecs: number) { return dreamCycleImpl.listLiveDreamCycleLocks(this.executeRaw.bind(this), graceSecs); }
  readDreamJobStatus(id: number) { return dreamCycleImpl.readDreamJobStatus(this.executeRaw.bind(this), id); }
  ensureDreamMapConfigRow(key: string) { return dreamCycleImpl.ensureDreamMapConfigRow(this.executeRaw.bind(this), key); }
  lockDreamMapConfigRow(key: string) { return dreamCycleImpl.lockDreamMapConfigRow(this.executeRaw.bind(this), key); }
  writeDreamMapConfigRow(key: string, value: string) { return dreamCycleImpl.writeDreamMapConfigRow(this.executeRaw.bind(this), key, value); }
  recordDreamBreakerReset(resetsKey: string, baseKey: string) { return dreamCycleImpl.recordDreamBreakerReset(this.executeRaw.bind(this), resetsKey, baseKey); }
  stampDreamPageProvenance(stamp: dreamCycleImpl.DreamPageProvenanceStamp) { return dreamCycleImpl.stampDreamPageProvenance(this.executeRaw.bind(this), stamp); }
  listDreamPageIds(slug: string, sourceId: string) { return dreamCycleImpl.listDreamPageIds(this.executeRaw.bind(this), slug, sourceId); }
  countDreamProvenancePages(sourceId: string, cycleDate: string, summarySlug: string, writtenSlugs: string[]) { return dreamCycleImpl.countDreamProvenancePages(this.executeRaw.bind(this), sourceId, cycleDate, summarySlug, writtenSlugs); }
  readDreamDeferralReceipt(receiptId: string) { return dreamCycleImpl.readDreamDeferralReceipt(this.executeRaw.bind(this), receiptId); }
  listConsolidationClaimValues(ids: number[]) { return dreamCycleImpl.listConsolidationClaimValues(this.executeRaw.bind(this), ids); }
  setConsolidatedFactValidUntil(validUntil: Date, id: number) { return dreamCycleImpl.setConsolidatedFactValidUntil(this.executeRaw.bind(this), validUntil, id); }
  listReadersSourcedFactIds(ids: number[]) { return dreamCycleImpl.listReadersSourcedFactIds(this.executeRaw.bind(this), ids); }
  findConsolidationPageIds(sourceId: string, slug: string) { return dreamCycleImpl.findConsolidationPageIds(this.executeRaw.bind(this), sourceId, slug); }
  readConsolidationTakesMaxRowNum(pageId: number) { return dreamCycleImpl.readConsolidationTakesMaxRowNum(this.executeRaw.bind(this), pageId); }
  findConsolidatedTakes(pageId: number, claim: string) { return dreamCycleImpl.findConsolidatedTakes(this.executeRaw.bind(this), pageId, claim); }
  refreshConsolidatedTakeSource(source: string, id: number) { return dreamCycleImpl.refreshConsolidatedTakeSource(this.executeRaw.bind(this), source, id); }
  findConsolidatedTakeIds(pageId: number, rowNum: number) { return dreamCycleImpl.findConsolidatedTakeIds(this.executeRaw.bind(this), pageId, rowNum); }
  listConsolidationClaimShapes(ids: number[]) { return dreamCycleImpl.listConsolidationClaimShapes(this.executeRaw.bind(this), ids); }
  listRetainedDreamOutputSources(sourceId: string) { return dreamCycleImpl.listRetainedDreamOutputSources(this.executeRaw.bind(this), sourceId); }
  readDreamSourceIncarnation(sourceId: string) { return dreamCycleImpl.readDreamSourceIncarnation(this.executeRaw.bind(this), sourceId); }
  listDreamAtomPages(sourceId: string) { return dreamCycleImpl.listDreamAtomPages(this.executeRaw.bind(this), sourceId); }
  listSynthesisPageBodies(sourceId: string, slugs: string[]) { return dreamCycleImpl.listSynthesisPageBodies(this.executeRaw.bind(this), sourceId, slugs); }
  listLaterPersistenceRequests(sourceId: string, incarnation: string, slug: string, sequence: number | string) { return dreamCycleImpl.listLaterPersistenceRequests(this.executeRaw.bind(this), sourceId, incarnation, slug, sequence); }
  listCommittedOutputRequests(requestIds: string[], sourceId: string, incarnation: string) { return dreamCycleImpl.listCommittedOutputRequests(this.executeRaw.bind(this), requestIds, sourceId, incarnation); }
  readDreamVerifyEpoch() { return dreamCycleImpl.readDreamVerifyEpoch(this.executeRaw.bind(this)); }
  listDreamJobCreatedAt(ids: number[]) { return dreamCycleImpl.listDreamJobCreatedAt(this.executeRaw.bind(this), ids); }
  readDreamPreRunRevision(slug: string, sourceId: string, sinceIso: string) { return dreamCycleImpl.readDreamPreRunRevision(this.executeRaw.bind(this), slug, sourceId, sinceIso); }
  listCompletedSynthJobs(key: string) { return dreamCycleImpl.listCompletedSynthJobs(this.executeRaw.bind(this), key); }
  countCoalescibleSynthJobs(keys: string[]) { return dreamCycleImpl.countCoalescibleSynthJobs(this.executeRaw.bind(this), keys); }
  listWaitingChildJobIds(queue: string) { return dreamCycleImpl.listWaitingChildJobIds(this.executeRaw.bind(this), queue); }
  listDreamChildJobTimings(ids: number[]) { return dreamCycleImpl.listDreamChildJobTimings(this.executeRaw.bind(this), ids); }
  countRecentDreamSynthSubmissions(sourceId: string) { return dreamCycleImpl.countRecentDreamSynthSubmissions(this.executeRaw.bind(this), sourceId); }

  // ============================================================
  // v0.31: Hot memory — facts table operations
  // ============================================================

  // Facts SQL lives once in ./engine-sql/facts.ts (refactor wave 1 C11): the
  // methods below are one-line delegations over the engine-sql executor.

  /** Narrow deps for the peeled facts module. */
  /**
   * v0.41.15.0 (T6, codex #20): per-process cache for the
   * `facts.embedding` cast suffix. Migration v40 creates the column as
   * `halfvec(N)` on pgvector >= 0.7 but falls back to `vector(N)` on
   * older. The pre-v0.41.15 insert path always cast embeddings as
   * `::vector`, which works via implicit cast on pgvector >= 0.7 but
   * is honest-only when the column actually IS vector. Probing once
   * per process + caching the suffix lets the insert match the column
   * type exactly. Initialized lazily in `insertFacts`.
   */
  private _factsEmbeddingCastSuffix: '::vector' | '::halfvec' | null = null;

  private async resolveFactsEmbeddingCast(): Promise<'::vector' | '::halfvec'> {
    if (this._factsEmbeddingCastSuffix !== null) return this._factsEmbeddingCastSuffix;
    const sql = this.sql;
    try {
      const rows = await sql<Array<{ formatted: string | null }>>`
        SELECT format_type(a.atttypid, a.atttypmod) AS formatted
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'facts'
           AND a.attname = 'embedding'
           AND NOT a.attisdropped
      `;
      const formatted = rows?.[0]?.formatted ?? null;
      // halfvec match first — halfvec contains "vec" so a /vector/i
      // regex would shadow it. See readFactsEmbeddingDim's identical
      // ordering note. Otherwise '::vector' (the pre-v0.41.15 behavior);
      // on a brain without the facts.embedding column yet (pre-v40) the
      // INSERT would fail elsewhere anyway.
      const suffix = formatted && /halfvec\(\d+\)/i.test(formatted) ? '::halfvec' : '::vector';
      // #6712 L6: a transaction engine is an Object.create clone of the engine it runs on, so a probe answered
      // inside a transaction is cached on that root engine: one probe per process, not one per publication.
      let root: PostgresEngine = this;
      while (Object.getPrototypeOf(root) instanceof PostgresEngine) root = Object.getPrototypeOf(root) as PostgresEngine;
      root._factsEmbeddingCastSuffix = suffix;
      return suffix;
    } catch {
      // Probe failed — fall back to '::vector' default. Cache so we
      // don't re-probe on every insert.
      this._factsEmbeddingCastSuffix = '::vector';
      return '::vector';
    }
  }

  async insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
    return factsImpl.insertFact(this.engineSql, () => this.resolveFactsEmbeddingCast(), input, ctx);
  }

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date; successorFrom?: Date }): Promise<boolean> {
    return factsImpl.expireFact(this.engineSql, id, opts);
  }

  async insertFacts(
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }> {
    return factsImpl.insertFacts(this.engineSql, () => this.resolveFactsEmbeddingCast(), rows, ctx, opts);
  }

  async deleteFactsForPage(
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }> {
    return factsImpl.deleteFactsForPage(this.engineSql, slug, source_id, opts);
  }

  async listFactsByEntity(
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsByEntity(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, entitySlug, opts);
  }

  async listFactsSince(
    source_id: string,
    since: Date,
    opts?: RecallFactReadOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsSince(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, since, opts);
  }

  async listFactsKeyset(
    source_id: string,
    after: { createdAt: string; id: number | null } | null,
    opts?: RecallFactReadOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsKeyset(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, after, opts);
  }

  async listFactsBySession(
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsBySession(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, sessionId, opts);
  }

  async listSupersessions(
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[]; eligibility?: import('./engine.ts').FactListOpts['eligibility']; excludePrivate?: boolean },
  ): Promise<FactRow[]> {
    return factsImpl.listSupersessions(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, opts);
  }

  async countUnconsolidatedFacts(source_id: string): Promise<number> {
    return factsImpl.countUnconsolidatedFacts(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id);
  }

  listFenceRetireCandidates(target: factsImpl.FenceProjectionTarget) {
    return factsImpl.listFenceRetireCandidates(unscopedExecutor(this.engineSql, 'fence projection: fact read ran unscoped through executeRaw'), target);
  }

  readFactPreimages(sourceId: string, ids: readonly number[]) {
    return factsImpl.readFactPreimages(unscopedExecutor(this.engineSql, 'generation adapters: fact before-state read ran unscoped through executeRaw'), sourceId, ids);
  }

  restoreFactPreimage(sourceId: string, preimage: Record<string, unknown>) {
    return factsImpl.restoreFactPreimage(this.executeRaw.bind(this), sourceId, preimage);
  }
  listFactIdsBySourcePrefix(sourceId: string, slug: string, sourcePrefix: string) { return factsImpl.listFactIdsBySourcePrefix(this.executeRaw.bind(this), sourceId, slug, sourcePrefix); }
  expireFactRows(sourceId: string, ids: readonly number[]) { return factsImpl.expireFactRows(this.executeRaw.bind(this), sourceId, ids); }

  async findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array; embeddingModel?: string | null; arm?: 'keyword'; attributedTo?: import('./engine.ts').FactAttribution | null; excludeMemberPages?: boolean; onlyPage?: string },
  ): Promise<FactRow[]> {
    return factsImpl.findCandidateDuplicates(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, entitySlug, factText, opts);
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    return factsImpl.consolidateFact(this.engineSql, id, takeId);
  }

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    return factsImpl.findTrajectory(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), opts);
  }

  async getFactsHealth(source_id: string): Promise<FactsHealth> {
    return factsImpl.getFactsHealth(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id);
  }

  // Segmented page storage (Wave B): SQL in ./engine-sql/page-body.ts.
  async allocateBodyOccurrenceIds(count: number): Promise<number[]> { return pageBodyImpl.allocateBodyOccurrenceIds(this.engineSql, count); }
  async stageSegmentTexts(sourceId: string, texts: readonly SegmentTextInput[], opts?: { stagingId?: string }): Promise<{ inserted: number }> { return pageBodyImpl.stageSegmentTexts(this.engineSql, sourceId, texts, opts); }
  async readSegmentTexts(sourceId: string, sha256s: readonly Uint8Array[]): Promise<Map<string, Uint8Array>> {
    return this.engineSqlRead(exec => pageBodyImpl.readSegmentTexts(unscopedExecutor(exec, 'page-body: page-id keyed internal read'), sourceId, sha256s));
  }
  async stageManifestRows(rows: readonly ManifestRowInput[]): Promise<void> { return pageBodyImpl.stageManifestRows(this.engineSql, rows); }
  async readManifest(pageId: number, opts?: { generation?: number; stagingId?: string; region?: BodyRegion; lastN?: number }): Promise<ManifestRow[]> {
    return this.engineSqlRead(exec => pageBodyImpl.readManifest(unscopedExecutor(exec, 'page-body: page-id keyed internal read'), pageId, opts));
  }
  readSegmentedEmbedPage(ref: SegmentedEmbedRef) { return pageBodyImpl.readSegmentedEmbedPage(unscopedExecutor(this.engineSql, 'page-body: segmented embed page read'), ref); }
  async stageSegmentChunks(pageId: number, generation: number, chunks: readonly SegmentChunkInput[], opts?: { embeddingColumn?: ResolvedColumn }): Promise<number[]> {
    return pageBodyImpl.stageSegmentChunks(this.engineSql, pageId, generation, chunks, opts);
  }
  async createSegmentedPageShell(slug: string, meta: SegmentedPageMeta, opts: { sourceId: string }): Promise<{ id: number }> { return pageBodyImpl.createSegmentedPageShell(this.engineSql, slug, meta, opts); }
  async flipBodyGeneration(input: BodyFlipInput): Promise<BodyFlipResult> { return pageBodyImpl.flipBodyGeneration(this.engineSql, input); }
  async sealSegmentedPage(pageId: number, opts?: { timelineLead?: string }): Promise<void> { return pageBodyImpl.sealSegmentedPage(this.engineSql, pageId, opts?.timelineLead); }
  async openBodyStaging(input: BodyStagingInput): Promise<void> { return pageBodyImpl.openBodyStaging(this.engineSql, input); }
  async setBodyStagingState(id: string, state: BodyStagingState, opts?: { commitRequestId?: string | null }): Promise<void> { return pageBodyImpl.setBodyStagingState(this.engineSql, id, state, opts); }
  async sweepSegments(opts?: SegmentSweepOptions): Promise<SegmentSweepResult> { return pageBodyImpl.sweepSegments(this.engineSql, opts); }
  hasSegmentStorage() { return this.preparationRead(exec => writeGuardsImpl.hasSegmentStorage(unscopedExecutor(exec, 'page body: segment storage probe ran unscoped through executeRaw'))); }
  async readSegmentDerivations(pageId: number, opts?: { kind?: SegmentDerivationKind; occurrenceIds?: readonly number[] }): Promise<SegmentDerivationRow[]> {
    return pageBodyImpl.readSegmentDerivations(unscopedExecutor(this.engineSql, 'page-body: page-id keyed internal read'), pageId, opts);
  }
  async upsertSegmentDerivations(rows: readonly SegmentDerivationInput[]): Promise<void> { return pageBodyImpl.upsertSegmentDerivations(this.engineSql, rows); }
  async retireSegmentDerivations(pageId: number, liveOccurrenceIds: readonly number[], opts?: { kind?: SegmentDerivationKind }): Promise<number> {
    return pageBodyImpl.retireSegmentDerivations(this.engineSql, pageId, liveOccurrenceIds, opts);
  }
  async lockBodyStagingState(stagingId: string) { return segmentedPurgeWrites.lockBodyStagingState(this, stagingId); }
  async deleteUnstagedSegmentChunks(pageId: number, generation: number, keep: readonly number[]) { return segmentedPurgeWrites.deleteUnstagedSegmentChunks(this, pageId, generation, keep); }
  async deleteRewrittenSegmentDerivations(spec: segmentedPurgeWrites.RewrittenDerivationsDelete) { return segmentedPurgeWrites.deleteRewrittenSegmentDerivations(this, spec); }
  async readPageViewDigest(key: pageViewDigests.PageViewDigestKey) { return pageViewDigests.readPageViewDigest(this, key); }
  async writePageViewDigest(key: pageViewDigests.PageViewDigestKey, digest: pageViewDigests.PageViewDigest) { return pageViewDigests.writePageViewDigest(this, key, digest); }

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence
  // ============================================================

  // Takes SQL lives once in ./engine-sql/takes.ts (refactor wave 1 C12).

  /** Narrow deps for the peeled takes module. */
  async addTakesBatch(rowsIn: TakeBatchInput[], opts?: BatchOpts): Promise<number> {
    return takesImpl.addTakesBatch(() => this.engineSql, (site, signal, fn, size) => this.batchRetry(site, signal, fn, size), rowsIn, opts);
  }

  async listActiveTakesForPages(
    pageIds: number[],
    opts: { takesHoldersAllowList?: string[] } = {},
  ): Promise<Map<number, Take[]>> {
    return takesImpl.listActiveTakesForPages(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), pageIds, opts);
  }

  matchTakeRows(pageId: number, rows: readonly takesImpl.TakeFenceRow[], limit: number) { return this.preparationRead(exec => takesImpl.matchTakeRows(unscopedExecutor(exec, 'page write: fence take collision read ran unscoped through executeRaw'), pageId, rows, limit)); }
  deleteTakeRows(pageId: number, rowNums: readonly number[]) { return takesImpl.deleteTakeRows(this.autocommitSql, pageId, rowNums); }

  async writeContradictionsRun(row: {
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
  }): Promise<boolean> {
    return takesImpl.writeContradictionsRun(this.engineSql, row);
  }

  async loadContradictionsTrend(days: number): Promise<Array<{
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
  }>> {
    return takesImpl.loadContradictionsTrend(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), days);
  }

  async getContradictionCacheEntry(key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null> {
    return takesImpl.getContradictionCacheEntry(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), key);
  }

  async putContradictionCacheEntry(opts: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
    verdict: Record<string, unknown>;
    ttl_seconds?: number;
  }): Promise<void> {
    return takesImpl.putContradictionCacheEntry(this.engineSql, opts);
  }

  async sweepContradictionCache(): Promise<number> {
    return takesImpl.sweepContradictionCache(this.engineSql);
  }

  // The edge-contradictions phase, the scoped contradiction reader and the eval reads (engine-sql/contradictions-cycle.ts).
  listEdgeContradictionCandidates(query: contradictionsCycleImpl.EdgeCandidateQuery) { return contradictionsCycleImpl.listEdgeContradictionCandidates(this.executeRaw.bind(this), query); }
  listKnownEdgeProposals(fromPageId: number, linkType: string, evidenceHashes: string[]) { return contradictionsCycleImpl.listKnownEdgeProposals(this.executeRaw.bind(this), fromPageId, linkType, evidenceHashes); }
  listLinkContexts(fromPageId: number, toPageId: number, linkType: string) { return contradictionsCycleImpl.listLinkContexts(this.executeRaw.bind(this), fromPageId, toPageId, linkType); }
  recordEdgeProposal(proposal: contradictionsCycleImpl.EdgeProposalInput) { return contradictionsCycleImpl.recordEdgeProposal(this.executeRaw.bind(this), proposal); }
  readEdgeProposal(id: number) { return contradictionsCycleImpl.readEdgeProposal(this.executeRaw.bind(this), id); }
  edgeClosureLanded(fromPageId: number, endingToPageId: number | null, linkType: string, closeDate: string | null) { return contradictionsCycleImpl.edgeClosureLanded(this.executeRaw.bind(this), fromPageId, endingToPageId, linkType, closeDate); }
  readEdgeProposalEvidence(id: number) { return contradictionsCycleImpl.readEdgeProposalEvidence(this.executeRaw.bind(this), id); }
  readEdgeProposalHash(id: number) { return contradictionsCycleImpl.readEdgeProposalHash(this.executeRaw.bind(this), id); }
  markEdgeProposalStale(id: number) { return contradictionsCycleImpl.markEdgeProposalStale(this.executeRaw.bind(this), id); }
  setEdgeProposalStatus(id: number, status: string) { return contradictionsCycleImpl.setEdgeProposalStatus(this.executeRaw.bind(this), id, status); }
  rejectOpenEdgeProposal(id: number) { return contradictionsCycleImpl.rejectOpenEdgeProposal(this.executeRaw.bind(this), id); }
  markEdgeProposalUndone(id: number) { return contradictionsCycleImpl.markEdgeProposalUndone(this.executeRaw.bind(this), id); }
  markRevertedEdgeProposals() { return contradictionsCycleImpl.markRevertedEdgeProposals(this.executeRaw.bind(this)); }
  listEdgeProposalCliRows(filter: contradictionsCycleImpl.EdgeProposalCliFilter, limit: number) { return contradictionsCycleImpl.listEdgeProposalCliRows(this.executeRaw.bind(this), filter, limit); }
  deleteHeldEdgeProposalErrors() { return contradictionsCycleImpl.deleteHeldEdgeProposalErrors(this.executeRaw.bind(this)); }
  listAppliedEdgeProposalIds() { return contradictionsCycleImpl.listAppliedEdgeProposalIds(this.executeRaw.bind(this)); }
  deleteEdgeProposalError(id: number) { return contradictionsCycleImpl.deleteEdgeProposalError(this.executeRaw.bind(this), id); }
  readEdgeProposalSourceId(id: number) { return contradictionsCycleImpl.readEdgeProposalSourceId(this.executeRaw.bind(this), id); }
  markEdgeProposalDated(id: number) { return contradictionsCycleImpl.markEdgeProposalDated(this.executeRaw.bind(this), id); }
  listLiveChunksByIds(ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined) { return contradictionsCycleImpl.listLiveChunksByIds(this.executeRaw.bind(this), ids, policy, floor); }
  listLiveTakesByIds(ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined) { return contradictionsCycleImpl.listLiveTakesByIds(this.executeRaw.bind(this), ids, policy, floor); }
  readLastContradictionsPromptVersion() { return contradictionsCycleImpl.readLastContradictionsPromptVersion(this.executeRaw.bind(this)); }
  listEvalCandidateQueries(limit: number) { return contradictionsCycleImpl.listEvalCandidateQueries(this.executeRaw.bind(this), limit); }

  async listTakes(opts: TakesListOpts = {}): Promise<Take[]> {
    return takesImpl.listTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts);
  }

  async searchTakes(query: string, opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility } = {}): Promise<TakeHit[]> {
    return takesImpl.searchTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakesVector(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), embedding, opts);
  }

  async getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>> {
    return takesImpl.getTakeEmbeddings(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), ids);
  }

  async countStaleTakes(opts?: StaleTakeOpts): Promise<number> {
    return takesImpl.countStaleTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts);
  }

  async listStaleTakes(opts?: StaleTakeOpts): Promise<StaleTakeRow[]> {
    return takesImpl.listStaleTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts);
  }

  async updateTakeEmbeddings(rowsIn: TakeEmbeddingInput[], opts?: BatchOpts): Promise<number> { return takesImpl.updateTakeEmbeddings(() => this.engineSql, (site, signal, fn, size) => this.batchRetry(site, signal, fn, size), rowsIn, opts); }

  async updateTake(
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void> {
    return takesImpl.updateTake(this.engineSql, pageId, rowNum, fields);
  }

  async supersedeTake(
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }> {
    return takesImpl.supersedeTake(this.engineSql, pageId, oldRow, newRow);
  }

  async resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
    return takesImpl.resolveTake(this.engineSql, pageId, rowNum, resolution);
  }

  async getScorecard(opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard> {
    return takesImpl.getScorecard(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts, allowList);
  }

  async getCalibrationCurve(opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]> {
    return takesImpl.getCalibrationCurve(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts, allowList);
  }

  async addSynthesisEvidence(rowsIn: SynthesisEvidenceInput[]): Promise<number> {
    return takesImpl.addSynthesisEvidence(this.engineSql, rowsIn);
  }

  // Versions
  async createVersion(slug: string, opts?: { sourceId?: string; preimage?: PageSnapshot } & VersionHistory): Promise<PageVersion> {
    return createPageVersion(this, slug, opts?.sourceId ?? 'default', opts?.preimage, opts);
  }

  async getVersions<B extends boolean = true>(slug: string, opts?: GetVersionsOpts<B>): Promise<PageVersionRows<B>> {
    return pagesImpl.getVersions(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), slug, opts);
  }
  async readLatestVersionId(pageId: number) { return versionReasons.readLatestVersionId(this, pageId); }
  async readLatestVersionIdAtTier(pageId: number, tier: string) { return versionReasons.readLatestVersionIdAtTier(this, pageId, tier); }
  async stampVersionChangeReason(spec: { pageId: number; afterVersionId: number; reason: string }) { return versionReasons.stampVersionChangeReason(this, spec); }
  async listVersionsByChangeReason(sourceId: string, reasons: readonly string[]) { return versionReasons.listVersionsByChangeReason(this, sourceId, reasons); }
  async listRetainedVersionBodies(pageId: number, limit: number) { return versionReasons.listRetainedVersionBodies(this, pageId, limit); }
  async readArchivedVersionBody(pageId: number, receiptId: string) { return versionReasons.readArchivedVersionBody(this, pageId, receiptId); }
  listOverwriteCandidates(sourceId: string, slugs: readonly string[] | null, limit: number) { return overwriteReads.listOverwriteCandidates(this, sourceId, slugs, limit); }
  listVersionsAfter(pageIds: readonly number[], afterId: number) { return overwriteReads.listVersionsAfter(this, pageIds, afterId); }
  listOverwriteLivePages(pageIds: readonly number[]) { return overwriteReads.listOverwriteLivePages(this, pageIds); }
  readVersionContent(versionId: number, pageId: number) { return overwriteReads.readVersionContent(this, versionId, pageId); }
  readPageVersionRow(versionId: number, pageId: number) { return overwriteReads.readPageVersionRow(this, versionId, pageId); }
  async replaceVersionChangeReasons(sourceId: string, rows: ReadonlyArray<{ id: number; reason: string }>, replacement: string) { return versionReasons.replaceVersionChangeReasons(this, sourceId, rows, replacement); }
  async pruneHoldingPageVersions(pageId: number) { return versionPrune.pruneHoldingPageVersions(this, pageId); }

  async revertToVersion(
    slug: string,
    versionId: number,
    opts?: { sourceId?: string },
  ): Promise<void> {
    return pagesImpl.revertToVersion(this.engineSql, slug, versionId, opts);
  }

  // Stats + health
  /** The liveness round trip through this engine's executeRaw, as master ran it; under a read deadline it ends at the deadline (statement-deadline.ts bounds it). */
  pingStore(opts?: { signal?: AbortSignal; direct?: boolean }) { return opts?.direct ? healthImpl.pingStore({ executeRaw: (sql, params, o) => this.executeRawDirect(sql, params, o) }, opts) : this.ownRawRead(exec => healthImpl.pingStore(exec, opts)); }
  async getStats(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainStats> {
    const sql = this.sql;
    // #4592: optional source scope. NULL = brain-wide (trusted local); a
    // scope array confines EVERY counter — including chunk/link/tag/timeline
    // counts and pages_by_type — so a scoped remote grant can't recover an
    // excluded source's numbers by subtraction. Derived tables scope through
    // their page joins; links count only when BOTH endpoints are in scope.
    // The joins are FK-total, so the NULL-scope numbers are unchanged.
    const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
    // S2: embedded_count keys on the registry-ACTIVE column (fallback to
    // legacy on a broken registry — diagnostics never crash).
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const [stats] = await sql`
      SELECT
        -- v0.26.5: exclude soft-deleted from page_count. Same posture as the
        -- search filter and getPage default — soft-deleted is hidden everywhere
        -- the user looks. Chunks/links stay raw because they still occupy
        -- storage until the autopilot purge phase runs.
        (SELECT count(*) FROM pages p WHERE p.deleted_at IS NULL
           AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))) as page_count,
        (SELECT count(*) FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))) as chunk_count,
        -- Keyed on the stored VECTOR, not embedded_at: a schema rebuild NULLs
        -- every vector without touching embedded_at, and this count must not
        -- report a dark column as embedded.
        (SELECT count(*) FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE cc.${sql.unsafe(colId)} IS NOT NULL
            AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))) as embedded_count,
        -- EXISTS (not JOIN) so a legacy dead link (missing endpoint row)
        -- still counts in the unscoped view exactly as before.
        (SELECT count(*) FROM links l
          WHERE (${scope}::text[] IS NULL
             OR (EXISTS (SELECT 1 FROM pages pf WHERE pf.id = l.from_page_id AND pf.source_id = ANY(${scope}))
                 AND EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND pt.source_id = ANY(${scope}))))) as link_count,
        (SELECT count(DISTINCT t.tag) FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))) as tag_count,
        (SELECT count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id
          WHERE (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))) as timeline_entry_count
    `;

    const types = await sql`
      SELECT type, count(*)::int as count FROM pages p WHERE p.deleted_at IS NULL
        AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
      GROUP BY type ORDER BY count DESC, type COLLATE "C"
    `;
    const pages_by_type: Record<string, number> = {};
    for (const t of types) {
      pages_by_type[t.type as string] = t.count as number;
    }

    return {
      page_count: Number(stats.page_count),
      chunk_count: Number(stats.chunk_count),
      embedded_count: Number(stats.embedded_count),
      link_count: Number(stats.link_count),
      tag_count: Number(stats.tag_count),
      timeline_entry_count: Number(stats.timeline_entry_count),
      pages_by_type,
    };
  }

  async getHealth(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainHealth> {
    // Each statement in its own JIT-off transaction (at 50k two spent ~0.5 of ~0.56 s compiling); the deps stay on the pool.
    const exec: SqlExecutor = { ...this.engineSql, run: (fragment, runOpts) => this.jitOffRead(tx => this.engineSqlOn(tx).run(fragment, runOpts)) };
    return healthImpl.getHealth(unscopedExecutor(exec, 'health: unscoped on master (EO4 inventory)'), opts, {
      embeddingColumn: async () => (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name,
      countStalePagesForExtraction: (o) => this.countStalePagesForExtraction(o),
      getConfig: (key) => this.getConfig(key),
      entityTypes: (scope) => resolveEntityTypes(this, scope),
    });
  }

  // The admin operations' statements (engine-sql/admin-reads.ts).
  listVisiblePageSlugs(slugs: string[], sourceIds: string[] | null, policy: adminReadsImpl.PagePolicyPart) { return adminReadsImpl.listVisiblePageSlugs(this.executeRaw.bind(this), slugs, sourceIds, policy); }
  readPagesForVersionHistory(pageIds: number[]) { return adminReadsImpl.readPagesForVersionHistory(this.executeRaw.bind(this), pageIds); }
  // The `gbrain schema detect` page-shape reads (engine-sql/schema-detect.ts).
  listHandoverReaderPages(principals: readonly string[], limit: number) { return handoverReadsImpl.listHandoverReaderPages(this.executeRaw.bind(this), principals, limit); }
  listHandoverPrefixPages(sourceId: string, prefix: string) { return handoverReadsImpl.listHandoverPrefixPages(this.executeRaw.bind(this), sourceId, prefix); }
  countMemberPage(slug: string) { return handoverReadsImpl.countMemberPage(this.executeRaw.bind(this), slug); }
  countMemberPageFacts(slug: string) { return handoverReadsImpl.countMemberPageFacts(this.executeRaw.bind(this), slug); }
  countMemberBoundCredentials(memberId: string) { return handoverReadsImpl.countMemberBoundCredentials(this.executeRaw.bind(this), memberId); }
  readLastUndoneHandoverId(memberId: string) { return handoverReadsImpl.readLastUndoneHandoverId(this.executeRaw.bind(this), memberId); }
  readHandoverRow(by: 'id' | 'plan_hash', value: string) { return handoverReadsImpl.readHandoverRow(this.executeRaw.bind(this), by, value); }
  listMemberSourceRows(memberId: string | null) { return handoverReadsImpl.listMemberSourceRows(this.executeRaw.bind(this), memberId); }
  pageTypeTotals(sourceId: string) { return schemaDetectImpl.pageTypeTotals(this.executeRaw.bind(this), sourceId); }
  countLivePagesAtPathPrefix(prefix: string) { return schemaDetectImpl.countLivePagesAtPathPrefix(this.executeRaw.bind(this), prefix); }
  probeUntypedPathPrefix(prefix: string, sourceId?: string) { return schemaDetectImpl.probeUntypedPathPrefix(this.executeRaw.bind(this), prefix, sourceId); }
  insertAccessReadLogRows(rows: readonly accessReadLogImpl.ReadLogRow[]) { return accessReadLogImpl.insertAccessReadLogRows(this.executeRaw.bind(this), rows); }
  pruneAccessReadLog(days: number, maxRows: number) { return accessReadLogImpl.pruneAccessReadLog(this.executeRaw.bind(this), days, maxRows); }
  readAccessReadLog(query: { since: string; member: string | null; limit: number }) { return accessReadLogImpl.readAccessReadLog(this.executeRaw.bind(this), query); }
  listAccessReadPageRefs(slug: string, sourceId: string | null) { return accessReadLogImpl.listAccessReadPageRefs(this.executeRaw.bind(this), slug, sourceId); }
  readAccessReadsOfPages(query: { pageIds: readonly number[]; since: string; limit: number }) { return accessReadLogImpl.readAccessReadsOfPages(this.executeRaw.bind(this), query); }
  tallyAccessReadsOfPages(query: { pageIds: readonly number[]; since: string }) { return accessReadLogImpl.tallyAccessReadsOfPages(this.executeRaw.bind(this), query); }
  invalidateQueryCacheRows(sourceId?: string) { return queryCacheInvalidateImpl.invalidateQueryCacheRows(this.executeRaw.bind(this), sourceId); }
  pagePrefixSamples(sourceId: string, minPages: number, limit: number) { return schemaDetectImpl.pagePrefixSamples(this.executeRaw.bind(this), sourceId, minPages, limit); }
  countPagesByTypeForSource(sourceId: string, limit: number) { return schemaDetectImpl.countPagesByTypeForSource(this.executeRaw.bind(this), sourceId, limit); }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    const sql = this.sql;
    // v0.31.2 (codex P1 #3): source_id threaded so multi-source brains can
    // scope ingest_log queries. Default 'default' matches the column DEFAULT.
    const sourceId = entry.source_id ?? 'default';
    // v254: the writer's version, host and segment-reader mark (writer-versions.ts writerStamp).
    const stamp = writerStamp({ mint: false, engine: this });
    await sql`
      INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader)
      VALUES (${sourceId}, ${entry.source_type}, ${entry.source_ref}, ${sql.json(entry.pages_updated)}, ${entry.summary}, ${stamp.version}, ${stamp.hostId}::uuid, true)
    `;
  }

  async getIngestLog(opts?: { limit?: number; sourceIds?: string[] }): Promise<IngestLogEntry[]> {
    const sql = this.sql;
    const limit = opts?.limit || 50;
    // Source-scope for remote / federated callers; unscoped only for trusted
    // local callers (same posture as searchKeyword's sourceIds filter).
    const scope = opts?.sourceIds && opts.sourceIds.length > 0
      ? sql`WHERE source_id = ANY(${opts.sourceIds}::text[])`
      : sql``;
    // id DESC breaks ties: PGLite's clock ticks in milliseconds, so rows written in one millisecond share created_at.
    const rows = await sql`
      SELECT id, source_id, source_type, source_ref, pages_updated, summary, created_at FROM ingest_log ${scope} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    // Belt-and-suspenders source_id fallback for any pre-v50 row.
    return (rows as unknown as IngestLogEntry[]).map(r => ({
      ...r,
      source_id: r.source_id ?? 'default',
    }));
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string, opts?: { sourceId?: string }): Promise<number> {
    newSlug = validateSlug(newSlug);
    const sourceId = opts?.sourceId ?? 'default';
    // The rename and its slug alias commit together.
    return this.transaction(tx => pagesImpl.updateSlug((tx as PostgresEngine).engineSql, tx, oldSlug, newSlug, sourceId));
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub in v0.2. Links table uses integer page_id FKs, which are already
    // correct after updateSlug (page_id doesn't change, only slug does).
    // Textual [[wiki-links]] in compiled_truth are NOT rewritten here.
    // The maintain skill's dead link detector surfaces stale references.
  }

  async resolveSlugWithAlias(
    slug: string,
    sourceOrSources: string | readonly string[],
    opts?: { excludePrivate?: boolean },
  ): Promise<string> {
    return (await this.resolveSlugWithAliasDetailed(slug, sourceOrSources, opts))?.canonical_slug ?? slug;
  }

  async resolveSlugWithAliasDetailed(
    slug: string,
    sourceOrSources: string | readonly string[],
    opts?: { excludePrivate?: boolean },
  ): Promise<{ canonical_slug: string; source_id: string } | null> {
    return pagesImpl.resolveSlugWithAliasDetailed(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), slug, sourceOrSources, opts);
  }

  async resolveAliases(
    aliasNorms: string[],
    opts?: PageReadScope,
  ): Promise<Map<string, Array<{ slug: string; source_id: string }>>> {
    return readAliases(this.executeRaw.bind(this), aliasNorms, opts);
  }

  async setPageAliases(slug: string, sourceId: string, aliasNorms: string[], opts?: { inline?: boolean }): Promise<void> {
    if (opts?.inline && this._pageTransaction) return pagesImpl.setPageAliases(this.engineSql, this, slug, sourceId, aliasNorms);
    return this.transaction(tx => pagesImpl.setPageAliases((tx as PostgresEngine).engineSql, tx, slug, sourceId, aliasNorms));
  }

  async replaceDerivedAliases(slug: string, sourceId: string, aliases: readonly DerivedAliasRow[]): Promise<void> { // DELETE + INSERT commit together: outside a transaction it opens one, so a refused INSERT keeps the old rows
    return this._pageTransaction ? pagesImpl.replaceDerivedAliases(this.autocommitSql, slug, sourceId, aliases) : this.transaction(tx => pagesImpl.replaceDerivedAliases((tx as PostgresEngine).engineSql, slug, sourceId, aliases));
  }

  async getPageSealState(pageId: number): Promise<{ chunker_version: number | null } | null> {
    return this.preparationRead(exec => pagesImpl.getPageSealState(unscopedExecutor(exec, 'pages: seal-state read ran unscoped on the pool on master (executeRaw)'), pageId));
  }

  async refreshPageOrigin(slug: string, opts: { sourceId: string; sourcePath: string; sourceUri?: string | null }): Promise<void> {
    return pagesImpl.refreshPageOrigin(this.autocommitSql, slug, opts);
  }
  readPageOrigin(target: writeGuardsImpl.PageOriginTarget) { return this.preparationRead(exec => writeGuardsImpl.readPageOrigin(unscopedExecutor(exec, 'origin guard: page read ran unscoped through executeRaw'), target)); }
  listRevivalPages(slug: string, sourceId: string | null) { return this.preparationRead(exec => writeGuardsImpl.listRevivalPages(unscopedExecutor(exec, 'origin guard: revival read ran unscoped through executeRaw'), slug, sourceId)); }
  listOriginClaims(sourceId: string, spellings: readonly string[], opts: { lockKeys: readonly string[]; excludePageId?: number | null }) { return writeGuardsImpl.listOriginClaims(this.autocommitSql, sourceId, spellings, opts); }
  bindPageOrigin(target: writeGuardsImpl.PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }) { return writeGuardsImpl.bindPageOrigin(this.autocommitSql, target); }
  detachPageOrigin(pageId: number, reason: string) { return writeGuardsImpl.detachPageOrigin(this.autocommitSql, pageId, reason); }
  readPageDatabaseOnlyReason(sourceId: string, slug: string) { return this.preparationRead(exec => writeGuardsImpl.readPageDatabaseOnlyReason(unscopedExecutor(exec, 'repair: database-only marker read ran unscoped through executeRaw'), sourceId, slug)); }
  bumpPageKnowledgeRevision(pageId: number) { return writeGuardsImpl.bumpPageKnowledgeRevision(this.autocommitSql, pageId); }
  removePageFrontmatterKeys(sourceId: string, pageId: number, keys: readonly string[]) { return writeGuardsImpl.removePageFrontmatterKeys(this.autocommitSql, sourceId, pageId, keys); }
  setPageType(sourceId: string, slug: string, type: string) { return writeGuardsImpl.setPageType(this.autocommitSql, sourceId, slug, type); }
  stampPageIngest(slug: string, stamp: writeGuardsImpl.PageIngestStamp) { return writeGuardsImpl.stampPageIngest(this.autocommitSql, slug, stamp); }
  sealImportedPage(slug: string, seal: writeGuardsImpl.ImportedPageSeal) { return writeGuardsImpl.sealImportedPage(this.autocommitSql, slug, seal); }
  readLivePageBody(slug: string, opts: { sourceId: string }) { return this.preparationRead(exec => writeGuardsImpl.readLivePageBody(unscopedExecutor(exec, 'valid-time advisory: page body read ran unscoped through executeRaw'), slug, opts)); }
  readStoredPageTier(sourceId: string, slug: string) { return this.preparationRead(exec => writeGuardsImpl.readStoredPageTier(unscopedExecutor(exec, 'page write gate: stored tier read ran unscoped through executeRaw'), sourceId, slug)); }
  readInlinePageRegions(pageId: number) { return this.preparationRead(exec => writeGuardsImpl.readInlinePageRegions(unscopedExecutor(exec, 'append tail digest: page body read ran unscoped through executeRaw'), pageId)); }
  readPageIndexingState(pageId: number) { return writeGuardsImpl.readPageIndexingState(unscopedExecutor(this.engineSql, 'page projection: indexing state read ran unscoped through executeRaw'), pageId); }
  /** The page embedding ledger on the paid path, on the engine's own executor, as planPageEmbedding's `executeRaw` ran (page-embedding-budget.ts). */
  readPageEmbeddingBudget(pageId: number) { return pageEmbeddingBudgetImpl.readPageEmbeddingBudget(unscopedExecutor(this.engineSql, 'page embedding budget: hold read ran unscoped through executeRaw'), pageId); }
  recordPageEmbeddingHold(pageId: number, reason: string) { return pageEmbeddingBudgetImpl.recordPageEmbeddingHold(this.autocommitSql, pageId, reason); }
  openPageEmbeddingHold(pageId: number) { return pageEmbeddingBudgetImpl.openPageEmbeddingHold(this.autocommitSql, pageId); }
  reservePageEmbedding(pageId: number, input: Parameters<BrainEngine['reservePageEmbedding']>[1]) { return pageEmbeddingBudgetImpl.reservePageEmbedding(this.autocommitSql, pageId, input); }
  settlePageEmbeddingReservation(pageId: number, settle: Parameters<BrainEngine['settlePageEmbeddingReservation']>[1]) { return pageEmbeddingBudgetImpl.settlePageEmbeddingReservation(this.autocommitSql, pageId, settle); }
  /** The embedding effect's install path, on the engine's own executor, as embedPage's and installPageEmbeddings' `executeRaw` ran. */
  readEmbeddingCompletion(pageId: number, opts: embeddingInstallImpl.EmbeddingCompletionOpts) { return embeddingInstallImpl.readEmbeddingCompletion(unscopedExecutor(this.engineSql, 'embedding effect: completion read ran unscoped through executeRaw'), pageId, opts); }
  lockEffectClaimRow(effectId: number | string) { return embeddingInstallImpl.lockEffectClaimRow(this.autocommitSql, effectId); }
  lockEmbeddingSwitch() { return embeddingInstallImpl.lockEmbeddingSwitch(this.autocommitSql); }
  installChunkEmbeddings(pageId: number, column: ResolvedColumn, batch: string) { return embeddingInstallImpl.installChunkEmbeddings(this.autocommitSql, pageId, column, batch); }
  readPageHiddenFromCaller(sourceId: string, slug: string, opts: { policy: pageVisibilityImpl.PagePolicyPart }) { return this.preparationRead(exec => pageVisibilityImpl.readPageHiddenFromCaller(unscopedExecutor(exec, 'page visibility: caller policy read ran unscoped through executeRaw'), sourceId, slug, opts)); }
  readCallerPageAccess(pages: readonly { source_id: string; slug: string }[], opts: { policy: pageVisibilityImpl.PagePolicyPart }) { return this.preparationRead(exec => pageVisibilityImpl.readCallerPageAccess(unscopedExecutor(exec, 'page visibility: caller policy read ran unscoped through executeRaw'), pages, opts)); }
  readWriteVisibilityProbe(sourceId: string, slug: string) { return this.preparationRead(exec => pageVisibilityImpl.readWriteVisibilityProbe(unscopedExecutor(exec, 'page visibility: write probe ran unscoped through executeRaw'), sourceId, slug, ownerOnlyLineageReadable(this))); }
  readPagePrivacyHidden(sourceId: string, slug: string) { return this.preparationRead(exec => pageVisibilityImpl.readPagePrivacyHidden(unscopedExecutor(exec, 'page visibility: privacy read ran unscoped through executeRaw'), sourceId, slug)); }
  readWriterSlugFence(principal: { kind: string; id: string }, opts?: { delegated?: boolean }) { return this.preparationRead(exec => pageVisibilityImpl.readWriterSlugFence(unscopedExecutor(exec, 'page visibility: writer fence read ran unscoped through executeRaw'), principal, opts)); }
  setEffectTransactionLimits() { return remoteLinksImpl.setEffectTransactionLimits(this); }
  readOwnedLinks(linkSource: string, originPageId: number | string) { return remoteLinksImpl.readOwnedLinks(unscopedExecutor(this.engineSql, 'links effect: owned edge read ran unscoped through executeRaw'), linkSource, originPageId); }
  deleteOwnedLinks(originPageId: number | string, linkSource: string, ids: readonly (number | string)[]) { return remoteLinksImpl.deleteOwnedLinks(this, originPageId, linkSource, ids); }
  readLinkTargetPages(sourceId: string, slugs: readonly string[], policy: remoteLinksImpl.WriterReadPolicy | null) { return this.engineSqlRead(exec => remoteLinksImpl.readLinkTargetPages(unscopedExecutor(exec, 'links effect: target read ran unscoped through executeRaw'), sourceId, slugs, policy)); }
  rearmLinksEffects(opts: remoteLinksImpl.LinksRearm) { return remoteLinksImpl.rearmLinksEffects(this, opts); }
  hasPendingFactsExtraction(pageId: number | string, jobStates: readonly string[]) { return factsBackstopImpl.hasPendingFactsExtraction(unscopedExecutor(this.engineSql, 'facts backstop: pending extraction read ran unscoped through executeRaw'), pageId, jobStates); }
  hasCompletedFactsExtraction(pageId: number | string) { return factsBackstopImpl.hasCompletedFactsExtraction(unscopedExecutor(this.engineSql, 'facts backstop: completed extraction read ran unscoped through executeRaw'), pageId); }
  readStoredBodyBytes(slug: string, sourceId: string) { return this.preparationRead(exec => largePageImpl.readStoredBodyBytes(unscopedExecutor(exec, 'large page: stored body size read ran unscoped through executeRaw'), slug, sourceId)); }
  readAdmittedPageRefs(refs: readonly relationalReadsImpl.PageRefRow[], policy: PageReadPolicy) { return this.preparationRead(exec => relationalReadsImpl.readAdmittedPageRefs(unscopedExecutor(exec, 'relational recall: seed admit read ran unscoped through executeRaw'), refs, policy)); }
  readPageSynopses(refs: readonly relationalReadsImpl.PageRefRow[], policy?: PageReadPolicy) { return this.preparationRead(exec => relationalReadsImpl.readPageSynopses(unscopedExecutor(exec, 'relational recall: hydrate read ran unscoped through executeRaw'), refs, policy)); }
  readSeedTitleSlugs(sourceId: string, types: readonly string[], title: string) { return this.preparationRead(exec => relationalReadsImpl.readSeedTitleSlugs(unscopedExecutor(exec, 'relational recall: title seed read ran unscoped through executeRaw'), sourceId, types, title)); }
  async readPageBodySizes(pageId: number) { return largePageImpl.readPageBodySizes(this, pageId); }
  listFenceFactRows(target: trustFenceImpl.FenceRowsTarget) { return trustFenceImpl.listFenceFactRows(unscopedExecutor(this.engineSql, 'fence guard: locking fact read ran unscoped through executeRaw'), target); }
  async restorePageTrust(spec: trustFenceImpl.PageTrustRestore) { return trustFenceImpl.restorePageTrust(this, spec); }
  listHeldRows(q: trustFenceImpl.HeldRowsQuery) { return trustFenceImpl.listHeldRows(unscopedExecutor(this.engineSql, 'fence guard: held-row read ran unscoped through executeRaw'), q); }
  listGuardedTakeRows(q: trustFenceImpl.GuardedTakeRowsQuery) { return trustFenceImpl.listGuardedTakeRows(unscopedExecutor(this.engineSql, 'fence guard: batch take guard ran unscoped through executeRaw'), q); }
  listQuotedTakeRows(pageId: number, rowNums: readonly number[]) { return fenceProjectionImpl.listQuotedTakeRows(this, pageId, rowNums); }
  listPageFenceFactCells(sourceId: string, slug: string) { return fenceProjectionImpl.listPageFenceFactCells(this, sourceId, slug); }
  hasPositionedPageFacts(sourceId: string, slug: string) { return fenceProjectionImpl.hasPositionedPageFacts(this, sourceId, slug); }
  hasFenceAbsentHold(sourceId: string, kind: string, ownerKey: string) { return fenceProjectionImpl.hasFenceAbsentHold(this, sourceId, kind, ownerKey); }
  listPageTakeRowNums(pageId: number) { return fenceProjectionImpl.listPageTakeRowNums(this, pageId); }
  expireFenceFacts(sourceId: string, slug: string, incoming: string, ids: readonly number[]) { return fenceProjectionImpl.expireFenceFacts(this, sourceId, slug, incoming, ids); }
  refreshFenceFactFields(sourceId: string, slug: string, fieldRows: string) { return fenceProjectionImpl.refreshFenceFactFields(this, sourceId, slug, fieldRows); }
  clearChangedTakeResolutions(pageId: number, claims: string) { return fenceProjectionImpl.clearChangedTakeResolutions(this, pageId, claims); }
  writeFenceTakeResolutions(pageId: number, resolutions: string) { return fenceProjectionImpl.writeFenceTakeResolutions(this, pageId, resolutions); }
  detachFenceFactRows(ids: readonly number[]) { return trustFenceImpl.detachFenceFactRows(this, ids); }
  listOccupiedFenceRowNums(sourceId: string, slug: string) { return trustFenceImpl.listOccupiedFenceRowNums(this, sourceId, slug); }
  moveGuardedFenceRows(moves: readonly trustFenceImpl.FenceRowMove[]) { return trustFenceImpl.moveGuardedFenceRows(this, moves); }
  listTrustedPrivateCopies(sourceId: string, slug: string, restated: readonly trustFenceImpl.FenceRestatement[]) { return trustFenceImpl.listTrustedPrivateCopies(this, sourceId, slug, restated); }
  readLiveFenceFactAt(sourceId: string, slug: string, rowNum: number) { return trustFenceImpl.readLiveFenceFactAt(this, sourceId, slug, rowNum); }
  listFactsAboveWriter(sourceId: string, slug: string) { return trustFenceImpl.listFactsAboveWriter(this, sourceId, slug); }
  readRowTrustTier(table: rowTierImpl.RowTierTable, id: number) { return rowTierImpl.readRowTrustTier(this, table, id); }
  setRowTrustTier(table: rowTierImpl.RowTierTable, id: number, tier: string, decision: string) { return rowTierImpl.setRowTrustTier(this, table, id, tier, decision); }
  readTierProjectionPage(table: rowTierImpl.RowTierTable, id: number) { return rowTierImpl.readTierProjectionPage(this, table, id); }
  readPageInlineBody(pageId: number | string) { return unwithdrawnRestoreImpl.readPageInlineBody(this, pageId); }
  insertTrustProposal(input: trustProposalsImpl.NewTrustProposal) { return trustProposalsImpl.insertTrustProposal(this.autocommitSql, input); }
  getTrustProposal(id: number, lock = false) { return trustProposalsImpl.getTrustProposal(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), id, lock); }
  listUnreadablePrivacyHoldIds(ids: number[]) { return trustProposalsImpl.listUnreadablePrivacyHoldIds(unscopedExecutor(this.engineSql, 'trust: the privacy-hold readability join ran through executeRaw unscoped'), ids); }
  listTrustProposals(filter: trustProposalsImpl.TrustProposalFilter = {}) { return trustProposalsImpl.listTrustProposals(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), filter); }
  pendingTrustProposalsFor(table: TrustTable, id: number) { return trustProposalsImpl.pendingTrustProposalsFor(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), table, id); }
  updatePendingTrustProposalAfter(id: number, after: Record<string, unknown>) { return trustProposalsImpl.updatePendingTrustProposalAfter(this.autocommitSql, id, after); }
  transitionTrustProposal(id: number, from: trustProposalsImpl.TrustProposalStatus, to: trustProposalsImpl.TrustProposalStatus, opts: trustProposalsImpl.TrustProposalTransition = {}) { return trustProposalsImpl.transitionTrustProposal(this.autocommitSql, id, from, to, opts); }
  listPendingContradictions(filter: trustProposalsImpl.PendingContradictionFilter = {}) { return trustProposalsImpl.listPendingContradictions(unscopedExecutor(this.engineSql, 'trust: the trust review contradiction read ran through executeRaw unscoped'), filter); }

  // Config

  /**
   * Single-statement sibling of {@link batchRetry} for the NON-batch config
   * accessors that touch `this.sql` directly (#1603 / PR #1593 follow-up,
   * PR #1891 by @jalagrange).
   *
   * Why not `batchRetry`: a config accessor is not a sized batch — routing it
   * through `batchRetry` would emit bogus batch-retry audit JSONL (inflating
   * the `batch_retry_health` doctor metric) and demand a fake `BatchAuditSite`
   * enum member. This keeps the SAME retry + reconnect posture with no audit.
   *
   * Why it exists: the `sql` getter throws a RETRYABLE "No database
   * connection" by design when an instance pool was torn down mid-cycle
   * (#1678), precisely so a withRetry+reconnect caller rebuilds the pool and
   * self-heals. `getConfig` got that wrapper in #1603; the sibling accessors
   * did not — so the first config write/list after a mid-cycle disconnect
   * threw unhandled (e.g. crashing the worker into a respawn loop).
   *
   * `fn` MUST re-read `this.sql` per invocation — `reconnect()` rebuilds the
   * pool between attempts. Safe for the writes too: `withRetry` only retries
   * connection-class failures (statement never committed), and both writes
   * are idempotent (upsert / delete), so even a lost-ack replay converges.
   */
  private async connRetry<T>(fn: () => Promise<T>): Promise<T> {
    const opts = this.getBulkRetryOpts();
    return withRetry(fn, {
      maxRetries: opts.maxRetries,
      delayMs: opts.delayMs,
      delayMaxMs: opts.delayMaxMs,
      jitter: BULK_RETRY_OPTS.jitter,
      // Same reconnect posture as batchRetry: rebuild a dead instance pool
      // before the next attempt. Race-safe via the engine's `_reconnecting`
      // guard; fail-loud — a reconnect throw propagates as the real cause.
      reconnect: (ctx) => this.reconnect(ctx),
    });
  }

  async getConfig(key: string): Promise<string | null> {
    const held = await requestConfigValue(this, key);
    if (held !== undefined) return held;
    // #1603: a transient pooler drop on this read used to throw / fall through
    // to defaults silently — which on remote Postgres surfaces as the wrong
    // search mode/knobs and empty-stdout queries.
    return this.configRead(async sql => {
      const rows = await sql`SELECT value FROM config WHERE key = ${key}`;
      return rows.length > 0 ? (rows[0].value as string) : null;
    });
  }

  /** A config read: retried on a pooler drop (#1603), or under a preparer's read deadline its bounded read-only transaction (`preparationRead`). */
  private configRead<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    throwIfRequestAborted(); // a cancelled request starts no config read, as executeRaw refused it (R2)
    const deadlineAt = this._pageTransaction ? undefined : readDeadline();
    if (deadlineAt === undefined) return this.connRetry(() => run(this.sql));
    return runDeadlineRead(this.sql, deadlineAt, run, this.checkoutGauge, cancelSettleMs(), readDeadlineSignal());
  }

  async setConfig(key: string, value: string): Promise<void> {
    return this.connRetry(async () => {
      await this.sql`
        INSERT INTO config (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
      noteRequestConfigWrite(this, key, value);
    });
  }

  async unsetConfig(key: string): Promise<number> {
    return this.connRetry(async () => {
      const result = await this.sql`DELETE FROM config WHERE key = ${key}` as unknown as { count: number };
      noteRequestConfigWrite(this, key, null);
      return result.count ?? 0;
    });
  }

  async listConfigKeys(prefix: string): Promise<string[]> {
    // LIKE-escape literal % and _ so a config key with those chars resolves
    // correctly. Pure string work — stays outside the retried thunk.
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `${escaped}%`;
    return this.configRead(async sql => {
      const rows = await sql<{ key: string }[]>`
        SELECT key FROM config WHERE key LIKE ${pattern} ESCAPE '\\' ORDER BY key COLLATE "C"
      `;
      return rows.map(r => r.key);
    });
  }

  async getAllConfig(): Promise<Record<string, string>> {
    const held = await requestConfigRows(this);
    if (held) return held;
    return this.configRead(async sql => {
      const rows = await sql<{ key: string; value: string }[]>`
        SELECT key, value FROM config
      `;
      const out: Record<string, string> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    });
  }

  // Migration support
  async runMigration(_version: number, sqlStr: string): Promise<void> {
    const conn = this.sql;
    await conn.unsafe(sqlStr);
  }

  async getChunksWithEmbeddings(slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }): Promise<Chunk[]> {
    return chunksImpl.getChunksWithEmbeddings(unscopedExecutor(this.engineSql, 'chunks: unscoped on master (EO4 inventory)'), slug, opts);
  }

  /**
   * Reconnect the engine after a transient connection blip. Branches on
   * connection style; no-ops if no saved config or if already reconnecting.
   *
   * - MODULE-singleton engines SHARE `db.ts`'s `sql` (#1745). Calling
   *   `db.disconnect()` here (via `this.disconnect()`) would null it out from
   *   under EVERY concurrent op (other dream-cycle phases, minion-queue
   *   `promoteDelayed`), which then throw "connect() has not been called" in the
   *   disconnect→connect window. postgres.js already auto-replaces dead sockets
   *   inside its pool, so a transient blip recovers WITHOUT a teardown. Recover
   *   idempotently instead: `db.connect()` is a no-op when the singleton is alive
   *   (the common case) and re-establishes it only if some other path nulled it —
   *   never introducing a null window — then refreshes the ConnectionManager read
   *   pool. Scope: fixes the singleton-NULL-window bug specifically; it does NOT
   *   rebuild a genuinely WEDGED-but-live pool (db.connect() no-ops there) — a
   *   different failure mode postgres.js owns.
   *
   * - INSTANCE pools (worker engines, `poolSize` set) own their `_sql` — tearing
   *   it down and rebuilding is correct and isolated; nobody else shares it. This
   *   path also records a pool-recovery audit event (#1685 GAP B) so the
   *   `pool_reap_health` doctor check can answer "reaped N times AND not
   *   auto-recovering." `ctx.error` (threaded by retry.ts) is classified: a
   *   CONNECTION_ENDED match is a true pooler reap; anything else (or no error,
   *   e.g. the supervisor's health-check reconnect) is `reconnect_other`. All
   *   audit calls are best-effort and never block the reconnect (CODEX #8).
   */
  async reconnect(ctx?: { error?: unknown }): Promise<void> {
    if (!this._savedConfig || this._reconnecting) return;
    if (this._connectionStyle !== 'instance') {
      // Module-singleton: never tear down the shared pool. db.connect() is
      // idempotent (no-op when the singleton is alive — the common #1745 path).
      // FAIL-LOUD (codex): do NOT swallow a real connect failure — a swallowed
      // error would make reconnect() resolve "successfully" and let the
      // supervisor reset its health-failure counter / emit db_reconnected when
      // the DB is actually down. A throw propagates as the real cause (matches
      // the withRetry+reconnect contract and the instance path's posture).
      await db.connect(this._savedConfig);
      // If db.connect() RE-CREATED the singleton (another path nulled it), the
      // ConnectionManager set at connect-time still points at the ended old
      // pool. Refresh it. Idempotent no-op when the singleton was already alive.
      this.connectionManager?.setReadPool(db.getConnection());
      return;
    }
    this._reconnecting = true;

    let isReap = false;
    if (ctx?.error !== undefined) {
      try {
        isReap = isConnectionEndedError(ctx.error);
      } catch { /* classification is best-effort */ }
    }
    try {
      logPoolRecovery(isReap ? 'reap_detected' : 'reconnect_other', ctx?.error);
    } catch { /* audit is best-effort */ }

    // Instance pool: BUILD-THEN-SWAP. Snapshot the live pool, build a fresh one,
    // and only tear the old one down once the new one is proven live. The naive
    // disconnect()-then-connect() ordering nulls `_sql` BEFORE the rebuild, so a
    // connect() failure during a transient blip leaves `_sql === null` for the
    // rest of the process. A dead `_sql` falls through to the module-singleton
    // accessor — which the autopilot process never connected — so every
    // subsequent non-retry-wrapped call (getConfig, per-phase reads) throws
    // "No database connection: connect() has not been called" and crashes the
    // worker into a respawn loop (#1593 root-cause). Holding the old pool until
    // the new one validates keeps the engine usable; postgres.js pools self-heal
    // on the next query once Postgres is back, and batchRetry's backoff retries.
    const oldSql = this._sql;
    const oldManager = this.connectionManager;
    try {
      this._sql = null; // force connect() to build a fresh pool, not reuse
      // connect() validates the new pool via `SELECT 1` before returning.
      await this.connect(this._savedConfig);
      // New pool is live — discard the old one best-effort, and the superseded manager's direct pool with it.
      if (oldSql) { try { await oldSql.end({ timeout: 5 }); } catch { /* swallow */ } }
      if (oldManager && oldManager !== this.connectionManager) oldManager.retire();
      try {
        logPoolRecovery('reconnect_succeeded');
      } catch { /* best-effort */ }
    } catch (err) {
      // Rebuild failed: tear down the half-built pool (if any) and restore the
      // prior live pool + manager so the engine stays usable.
      if (this._sql && this._sql !== oldSql) {
        try { await this._sql.end({ timeout: 5 }); } catch { /* swallow */ }
      }
      this._sql = oldSql;
      this.connectionManager = oldManager;
      try {
        logPoolRecovery('reconnect_failed', err);
      } catch { /* best-effort */ }
      throw err; // let batchRetry's backoff handle the retry
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * Shared body for executeRaw / executeRawDirect: run a raw statement on the
   * given connection and wire AbortSignal cancellation onto the pending query.
   * Cancellable statements retain an exclusive connection through query and
   * cancellation settlement so a late CancelRequest cannot hit its successor.
   */
  private runUnsafe<T>(
    conn: ReturnType<typeof postgres>,
    sql: string,
    params?: unknown[],
    opts?: RunUnsafeOpts,
  ): Promise<T[]> {
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    return holdSearchConnection(async () => {
      const signal = opts?.signal;
      let reserved: postgres.ReservedSql | undefined;
      let pending: ReturnType<typeof conn.unsafe> | undefined;
      let cancellation: Promise<void> | undefined;
      let retired = false, settled = false, discarded = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let owner: postgres.TransactionSql | postgres.ReservedSql = conn as unknown as postgres.TransactionSql;
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        reserved = signal && typeof conn.reserve === 'function' ? await reserveWithCancellation(opts => conn.reserve(opts), signal) : undefined;
        if (reserved) { conn = reserved; this.checkoutGauge.checkedOut(); }
        owner = reserved ?? conn as unknown as postgres.TransactionSql;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (signal && !hasPostgresCancellationCapability(owner)) throw postgresCancellationUnavailable();
        // #5984: parameterized statements default to named prepared statements, as tagged templates do.
        // postgres.js ANDs this with the connection option, so a PgBouncer transaction pooler
        // (`prepare: false`) stays unprepared; elsewhere a repeat costs one round trip instead of a
        // describe round trip plus an execute round trip.
        const driverOpts = { cancelFence: !!signal, prepare: opts?.prepare ?? true, ...(opts?.simple === undefined ? {} : { simple: opts.simple }) };
        pending = conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1], driverOpts);
        try { return await pending as unknown as T[]; } finally { settled = true; }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(settleTimer);
        try {
          if (cancellation) await cancellation;
          if (retired && !discarded) owner.discard();
        } finally { reserved?.release(); }
      }
      function onAbort() {
        if (!pending || cancellation) return;
        // #6278: a transaction-mode pooler may swallow the cancel request and leave the backend in ClientRead,
        // so the statement never settles on its own. Past the settle window the reserved connection is
        // discarded, which rejects the statement client-side (CONNECTION_DESTROYED) and frees the awaiting caller.
        pending.then(() => { settled = true; }, () => { settled = true; });
        settleTimer = setTimeout(() => {
          if (settled) return;
          retired = true; discarded = true;
          owner.discard();
        }, cancelSettleMs());
        try { cancellation = pending.cancel().catch(() => { retired = true; }); }
        catch { retired = true; }
      }
    });
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number; jitOff?: boolean; prepare?: boolean },
  ): Promise<T[]> {
    // try/finally (not .finally on the promise): runUnsafe throws
    // SYNCHRONOUSLY on a pre-aborted signal, which would skip a chained
    // .finally and leak the counter.
    throwIfRequestAborted();
    this.checkoutGauge.acquire('raw');
    try {
      if (opts?.jitOff || (opts?.timeoutMs !== undefined && !this._pageTransaction)) return await holdSearchConnection(async () => {
        if (opts.jitOff && await needsJitOff(this.sql, this._pageTransaction)) return await runJitOffStatement<T>(this.sql, this._pageTransaction, sql, params, opts, (c, s, p, o) => this.runUnsafe(c, s, p, o), () => this.checkoutGauge.checkedOut());
        // #6278: a transaction-local statement_timeout, which holds through a transaction-mode pooler (postgres-engine/bounded-statement.ts).
        return opts.timeoutMs !== undefined && !this._pageTransaction ? await runBoundedStatement<T>(this.sql, sql, params, { ...opts, timeoutMs: opts.timeoutMs }, () => this.checkoutGauge.checkedOut()) : await retryReadOnlyAutocommit(this.sql, c => this.runUnsafe<T>(c, sql, params, opts));
      }, opts.signal);
      return await retryReadOnlyAutocommit(this.sql, c => this.runUnsafe<T>(c, sql, params, opts));
    } finally {
      this.checkoutGauge.release('raw');
    }
    // Pre-#406 behavior: throw on any error including connection death.
    // Per-call auto-retry is not safe here because executeRaw is also used
    // for non-transactional mutations (DELETE/UPDATE/INSERT in sources.ts,
    // ALTER TABLE in migrations) where retrying after a connection-mid-statement
    // death can phantom-write a row that already committed on the server.
    // Recovery instead happens at the supervisor level: the watchdog detects
    // 3 consecutive health-check failures and calls engine.reconnect() to
    // swap in a fresh pool. See db.ts setSessionDefaults / supervisor.ts.
  }

  /**
   * Minion lock hot-path variant of executeRaw. Routes to the DIRECT
   * session-mode pool (port 5432) when dual-pool is active so lock
   * heartbeats survive the transaction-pooler's per-transaction connection
   * recycling. See BrainEngine.executeRawDirect for the full rationale.
   *
   * When this engine is a transaction-scoped clone (txEngine from
   * transaction()), `connectionManager` is inherited but `this.sql` is the tx
   * connection; we intentionally honor the tx connection in that case by
   * falling through to this.sql, because routing a statement inside an open
   * transaction onto a different pool would break atomicity. The lock
   * hot-path (claim/renewLock) does NOT run inside transaction(), so in
   * practice this always reaches the direct pool there.
   */
  async executeRawDirect<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    // #4145 R2-2: observe the signal BEFORE (potentially slow) direct-pool
    // acquisition — a caller whose timeout already fired must not queue for
    // a pool slot just to be cancelled afterwards. runUnsafe re-checks after
    // acquisition.
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    // Inside an open transaction, _sql is the reserved tx connection (set via
    // defineProperty in transaction()); never reroute off it.
    const inTransaction = this._sql !== null && this.connectionManager?.peekReadPool() !== this._sql;
    const conn = (!inTransaction && this.connectionManager?.isDualPoolActive())
      ? await this.connectionManager.ddl()
      : this.sql;
    // try/finally, not .finally — see executeRaw (sync throw on pre-aborted signal).
    this.checkoutGauge.acquire('direct');
    try {
      return await retryReadOnlyAutocommit(conn, c => this.runUnsafe<T>(c, sql, params, opts));
    } finally {
      this.checkoutGauge.release('direct');
    }
  }

  // Cycle-lock SQL lives once in ./engine-sql/cycle-locks.ts. Acquire / release / delete ran as autocommit tagged
  // templates under retryReadOnlyAutocommit on the pool; the renewal runs on the direct session pool (#1794).
  /** Executor whose `query` is `executeRawDirect`: the lease renewal's transport (direct pool, signal-cancellable). */
  private get directEngineSql(): SqlExecutor {
    return { ...this.engineSql, query: async (sql, params, opts) => ({ rows: await this.executeRawDirect(sql, params as unknown[] | undefined, opts), affectedRows: 0 }) };
  }
  /** Executor whose `executeRaw` is `executeRawDirect`: the write-claim renewal's and expiry's transport (engine-sql/persistence-claims.ts). */
  private get directRawSql(): SqlExecutor {
    return { ...this.engineSql, executeRaw: (sql, params, opts) => this.executeRawDirect(sql, params, opts) };
  }
  async acquireCycleLock(lockId: string, opts: Parameters<BrainEngine['acquireCycleLock']>[1]) {
    const held = await retryReadOnlyAutocommit(this.sql, c => cycleLocksImpl.acquireCycleLock(this.engineSqlOn(c), lockId, opts));
    if (held) noteDirectPoolLease();
    return held;
  }
  async refreshCycleLock(lockId: string, opts: Parameters<BrainEngine['refreshCycleLock']>[1], queryOpts?: { signal?: AbortSignal }) { return cycleLocksImpl.refreshCycleLock(this.directEngineSql, lockId, opts, queryOpts); }
  async releaseCycleLock(lockId: string, opts: Parameters<BrainEngine['releaseCycleLock']>[1]) { return retryReadOnlyAutocommit(this.sql, c => cycleLocksImpl.releaseCycleLock(this.engineSqlOn(c), lockId, opts)); }
  async readCycleLocks(filter: CycleLockFilter) { return cycleLocksImpl.readCycleLocks(unscopedExecutor(this.engineSql, 'cycle locks: unscoped on master (db-lock selectLockRows)'), filter); }
  async readDrainLeaseBeacon(lockToken: string) { return cycleLocksImpl.readDrainLeaseBeacon(unscopedExecutor(this.engineSql, 'drain lease: the lease reading read the holder beacon unscoped through executeRaw'), lockToken); }
  async writeDrainLeaseHolder(record: DrainLeaseHolderRecord) { return cycleLocksImpl.writeDrainLeaseHolder(this.autocommitSql, record); }
  async refreshDrainLeaseHolder(lockToken: string, ttlMinutes: number) { return cycleLocksImpl.refreshDrainLeaseHolder(this.autocommitSql, lockToken, ttlMinutes); }
  async releaseDrainLeaseHolder(lockToken: string) { return cycleLocksImpl.releaseDrainLeaseHolder(this.autocommitSql, lockToken); }
  async deleteCycleLock(lockId: string, opts: Parameters<BrainEngine['deleteCycleLock']>[1]) { return retryReadOnlyAutocommit(this.sql, c => cycleLocksImpl.deleteCycleLock(this.engineSqlOn(c), lockId, opts)); }
  async deleteCycleLockIfStale(lockId: string, opts: Parameters<BrainEngine['deleteCycleLockIfStale']>[1]) { return retryReadOnlyAutocommit(this.sql, c => cycleLocksImpl.deleteCycleLockIfStale(this.engineSqlOn(c), lockId, opts)); }
  /** The page embedding lease: on the engine's own executor, as its `executeRaw` statements ran (page-embedding-lease.ts). */
  takePageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['takePageEmbeddingLease']>[1]) { return cycleLocksImpl.takePageEmbeddingLease(this.autocommitSql, leaseId, opts); }
  renewPageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['renewPageEmbeddingLease']>[1]) { return cycleLocksImpl.renewPageEmbeddingLease(this.autocommitSql, leaseId, opts); }
  releasePageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['releasePageEmbeddingLease']>[1]) { return cycleLocksImpl.releasePageEmbeddingLease(this.autocommitSql, leaseId, opts); }
  listVectorlessChunkIndexes(pageId: number, column: string) { return pageSpendImpl.listVectorlessChunkIndexes(this, pageId, column); }
  async assertCycleLease(lockId: string, acquisitionToken: string) { return cycleLocksImpl.assertCycleLease(this, lockId, acquisitionToken); }

  // Minion jobs (engine-sql/jobs.ts): the submission and lifecycle writes run in one transaction each; claim and
  // renewal run on executeRawDirect; reads run where they are called (a transaction engine reads inside it).
  async admitJob(spec: AdmitJobSpec, policy: AdmitJobPolicy) { return this.transaction(tx => jobsImpl.admitJob(tx, spec, policy)); }
  async getJob(id: number) { return jobsImpl.getJob(this, id); }
  async readLiveJobIds(ids: number[]) { return jobsImpl.readLiveJobIds(this, ids); }
  async readJobDataByIdempotencyKey(key: string) { return jobsImpl.readJobDataByIdempotencyKey(this, key); }
  async coalesceOnIdempotencyKey(key: string, policy: { authority: unknown; decide: AdmitJobPolicy['decide'] }) { return jobsImpl.coalesceOnIdempotencyKey(this, key, policy.decide); }
  async listJobs(filter?: ListJobsFilter) { return jobsImpl.listJobs(this, filter); }
  async claimNextJob(spec: ClaimJobSpec) { return jobsImpl.claimNextJob(this, spec); }
  async renewJobLease(id: number, lockToken: string, lockDurationMs: number, opts?: { signal?: AbortSignal }) { return jobsImpl.renewJobLease(this, id, lockToken, lockDurationMs, opts); }
  async completeJob(id: number, lockToken: string, result?: Record<string, unknown>) { return this.transaction(tx => jobsImpl.completeJob(tx, id, lockToken, result)); }
  async failJob(id: number, lockToken: string, errorText: string, newStatus: 'delayed' | 'failed' | 'dead', backoffMs?: number, result?: Record<string, unknown>) {
    return this.transaction(tx => jobsImpl.failJob(tx, id, lockToken, errorText, newStatus, backoffMs, result));
  }
  async reclaimStalledJobs(graceMs: number) { return this.transaction(tx => jobsImpl.reclaimStalledJobs(tx, graceMs)); }
  // The queue's other statements (engine-sql/jobs-queue.ts); multi-statement writes run in one transaction.
  async deleteTerminalJob(id: number) { return jobsQueue.deleteTerminalJob(this, id); }
  async pauseJob(id: number) { return jobsQueue.pauseJob(this, id); }
  async resumeJob(id: number) { return jobsQueue.resumeJob(this, id); }
  async failParentJob(parentId: number, errorText: string) { return jobsQueue.failParentJob(this, parentId, errorText); }
  async resolveParentJob(parentId: number) { return jobsQueue.resolveParentJob(this, parentId); }
  async resolveStrandedParents() { return jobsQueue.resolveStrandedParents(this); }
  async detachChildJob(childId: number) { return jobsQueue.detachChildJob(this, childId); }
  async updateJobProgress(id: number, lockToken: string, progress: unknown) { return jobsQueue.updateJobProgress(this, id, lockToken, progress); }
  async addJobTokens(id: number, lockToken: string, tokens: JobTokenCounts) { return jobsQueue.addJobTokens(this, id, lockToken, tokens); }
  async delayActiveJob(id: number, lockToken: string, spec: DelayActiveJobSpec, opts?: { signal?: AbortSignal }) { return jobsQueue.delayActiveJob(this, id, lockToken, spec, opts); }
  async releaseWatchdogClaim(id: number, lockToken: string, errorText: string) { return jobsQueue.releaseWatchdogClaim(this, id, lockToken, errorText); }
  async releaseClaimForPause(id: number, lockToken: string) { return jobsQueue.releaseClaimForPause(this, id, lockToken); }
  async deferClaimForQuietHours(id: number, lockToken: string) { return jobsQueue.deferClaimForQuietHours(this, id, lockToken); }
  async markJobWatchdogSuspect(id: number) { return jobsQueue.markJobWatchdogSuspect(this, id); }
  async promoteDelayedJobs() { return jobsQueue.promoteDelayedJobs(this); }
  async cancelJobs(ids: readonly number[], spec?: CancelJobsSpec) { return this.transaction(tx => jobsQueue.cancelJobs(tx, ids, spec)); }
  async killTimedOutJobs() { return this.transaction(tx => jobsQueue.killTimedOutJobs(tx)); }
  async killWallClockJobs(lockDurationMs: number) { return this.transaction(tx => jobsQueue.killWallClockJobs(tx, lockDurationMs)); }
  async pruneJobs(spec: PruneJobsSpec) { return jobsQueue.pruneJobs(this, spec); }
  async listSynthesisCompletionKeys(sourceId: string, keyPrefix: SynthesisCompletionPrefix) { return jobsQueue.listSynthesisCompletionKeys(this, sourceId, keyPrefix); }
  async listRecentSynthesisCompletions(sourceId: string, hours: number) { return jobsQueue.listRecentSynthesisCompletions(this, sourceId, hours); }
  async retryJob(id: number, policy: RetryJobPolicy) { return this.transaction(tx => jobsQueue.retryJob(tx, id, policy)); }
  async postInboxMessage(jobId: number, sender: string, payload: unknown) { return jobsQueue.postInboxMessage(this, jobId, sender, payload); }
  async readJobInbox(jobId: number, lockToken: string) { return jobsQueue.readJobInbox(this, jobId, lockToken); }
  async readChildCompletions(parentId: number, lockToken: string, since?: Date | null) { return jobsQueue.readChildCompletions(this, parentId, lockToken, since); }
  async listOpenJobIdsInQueue(queue: string) { return jobsQueue.listOpenJobIdsInQueue(this, queue); }
  async renewPrivateQueueLease(queue: string, ownerToken: string, leaseMs: number) { return jobsQueue.renewPrivateQueueLease(this, queue, ownerToken, leaseMs); }
  async listOwnedPrivateQueues(maxQueues: number) { return jobsQueue.listOwnedPrivateQueues(this, maxQueues); }
  async readPrivateQueueState(queue: string) { return jobsQueue.readPrivateQueueState(this, queue); }
  async listStaleWaitingJobIds(name: string, hours: number, limit: number) { return jobsQueue.listStaleWaitingJobIds(this, name, hours, limit); }
  async listUnfinishedJobsByName(names: readonly string[]) { return jobsQueue.listUnfinishedJobsByName(this, names); }
  async countTtlExpiredWaiting(name: string, hours: number) { return jobsQueue.countTtlExpiredWaiting(this, name, hours); }
  async readJobStats(since: Date, queue: string) { return jobsQueue.readJobStats(this, since, queue); }
  async readQueueFamilyStats(since: Date) { return jobsQueue.readQueueFamilyStats(this, since); }
  async hasOverdueWatchdogSuspect(queue: string, names: readonly string[], waitMs: number) { return jobsQueue.hasOverdueWatchdogSuspect(this, queue, names, waitMs); }
  async listUnreviewedJobs() { return jobsQueue.listUnreviewedJobs(this); }
  async getFailedJobForRetry(id: number) { return jobsQueue.getFailedJobForRetry(this, id); }
  async countOpenJobsByOwner(clientId: string) { return jobsQueue.countOpenJobsByOwner(this, clientId); }
  async readJobSourceState(sourceId: string) { return this.ownRawRead(exec => jobsQueue.readJobSourceState(exec, sourceId)); }
  async lockOAuthClient(clientId: string) { return jobsQueue.lockOAuthClient(this, clientId); }
  async listJobPage(spec: JobPageSpec) { return jobsQueue.listJobPage(this, spec); }
  async listJobAttachmentNames(jobId: number) { return jobsQueue.listJobAttachmentNames(this, jobId); }
  async insertJobAttachment(jobId: number, attachment: JobAttachmentInsert) { return jobsQueue.insertJobAttachment(this, jobId, attachment); }
  async listJobAttachments(jobId: number) { return jobsQueue.listJobAttachments(this, jobId); }
  async getJobAttachment(jobId: number, filename: string) { return jobsQueue.getJobAttachment(this, jobId, filename); }
  async deleteJobAttachment(jobId: number, filename: string) { return jobsQueue.deleteJobAttachment(this, jobId, filename); }
  // Queue health reads (lane 5 group A; engine-sql/jobs-health.ts).
  async readQueueHealthSignals(spec: QueueHealthSpec) { return this.engineRead(exec => jobsHealth.readQueueHealthSignals(exec, spec)); }
  async listWaitingByQueue() { return this.engineRead(exec => jobsHealth.listWaitingByQueue(exec)); }
  async readQueueDivergence(spec: QueueDivergenceSpec) { return this.engineRead(exec => jobsHealth.readQueueDivergence(exec, spec)); }
  async listQueueWedgeCounts() { return this.engineRead(exec => jobsHealth.listQueueWedgeCounts(exec)); }
  async listPrivateQueueHealth() { return this.engineRead(exec => jobsHealth.listPrivateQueueHealth(exec)); }
  async readWedgeSignals(queue: string, handlerNames: readonly string[], opts?: { signal?: AbortSignal }) { return this.engineRead(exec => jobsHealth.readWedgeSignals(exec, queue, handlerNames, opts)); }
  async readOldestWaitingAge(queue: string, opts?: { signal?: AbortSignal }) { return this.engineRead(exec => jobsHealth.readOldestWaitingAge(exec, queue, opts)); }
  async readUntakenWaitingJobs(name: string, thresholdHours: number) { return this.engineRead(exec => jobsHealth.readUntakenWaitingJobs(exec, name, thresholdHours)); }
  async countWaitingJobs(excludeFactsAbsorb: boolean) { return jobsHealth.countWaitingJobs(this, excludeFactsAbsorb); }
  async countWaitingJobsForNames(queue: string, names: readonly string[]) { return jobsHealth.countWaitingJobsForNames(this, queue, names); }
  async listStuckActiveJobsByName() { return this.engineRead(exec => jobsHealth.listStuckActiveJobsByName(exec)); }
  // Engine migration source reads (engine-sql/engine-migration.ts).
  async readEngineMigrationHistory() { return engineMigration.readEngineMigrationHistory(this); }
  async readMigrationRows(table: engineMigration.MigrationTable) { return engineMigration.readMigrationRows(this, table); }
  async readMigrationPageColumns(slug: string, sourceId: string) { return engineMigration.readMigrationPageColumns(this, slug, sourceId); }
  async listManualLinkTransitions(slug: string, sourceId: string) { return engineMigration.listManualLinkTransitions(this, slug, sourceId); }
  async countLiveTimelineEntries() { return engineMigration.countLiveTimelineEntries(this); }

  // Job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts).
  async readLastAutopilotCycles() { return jobsStatus.readLastAutopilotCycles(this); }
  async countJobsByStatus(filter?: JobStatusFilter) { return jobsStatus.countJobsByStatus(this, filter); }
  async readWaitingQueueDepths() { return jobsStatus.readWaitingQueueDepths(this); }
  async readLastCompletedJobAt() { return jobsStatus.readLastCompletedJobAt(this); }
  async listRecentSourceCycleFailures(spec: { cutoff: string; sourceId?: string | null }) { return jobsStatus.listRecentSourceCycleFailures(this, spec); }
  async countTtlCancelledByName(reasonLike: string, withinSeconds: number) { return jobsStatus.countTtlCancelledByName(this, reasonLike, withinSeconds); }
  async readWaitingScopeState(spec: { name: string; queue: string; jobId: number }) { return jobsStatus.readWaitingScopeState(this, spec); }
  async countRecentCompletedJobs(name: string, withinSeconds: number) { return jobsStatus.countRecentCompletedJobs(this, name, withinSeconds); }
  async listRecentFailedJobErrors(withinSeconds: number) { return jobsStatus.listRecentFailedJobErrors(this, withinSeconds); }
  async listBudgetOwners() { return jobsStatus.listBudgetOwners(this); }
  async readQueuedPageChars(spec: { name: string; queue: string; maxChars: number }) { return jobsStatus.readQueuedPageChars(this, spec); }
  async readSourceJobCounts(failedWithinSeconds: number) { return jobsStatus.readSourceJobCounts(this, failedWithinSeconds); }
  async readEmbedBackfillBySource(sourceIds: readonly string[]) { return jobsStatus.readEmbedBackfillBySource(this, sourceIds); }

  // Group C: the queue reads the doctor checks and the dream breaker make (engine-sql/jobs-checks.ts).
  async listStalledEmbedBackfillSources() { return jobsChecks.listStalledEmbedBackfillSources(this); }
  async readGlobalMaintenanceDeaths(spec: { deaths: number }) { return jobsChecks.readGlobalMaintenanceDeaths(this, spec); }
  async readLastFailedGlobalMaintenanceJob(since: string | null) { return jobsChecks.readLastFailedGlobalMaintenanceJob(this, since); }
  async listFactsAbsorbJobsStillDead(spec: { hours: number; limit: number }) { return jobsChecks.listFactsAbsorbJobsStillDead(this, spec); }
  async readLegacyJobAuthority() { return jobsChecks.readLegacyJobAuthority(this); }
  async readQueuedSpendRows(spec: { legacyPrefixes: Readonly<Record<string, readonly string[]>>; waitMs: number }) { return jobsChecks.readQueuedSpendRows(this, spec); }
  async listBuildSkewStacktraceLines(spec: { prefix: string; windowHours: number; scanJobs: number }) { return jobsChecks.listBuildSkewStacktraceLines(this, spec); }
  async countDeadDreamSubmissionRows(spec: DeadDreamSubmissionSpec) { return jobsChecks.countDeadDreamSubmissionRows(this, spec); }
  async listFactsAbsorbJobsByKeyPrefix(spec: { prefix: string; keys: readonly string[] }) { return jobsChecks.listFactsAbsorbJobsByKeyPrefix(this, spec); }
  async listDeadFactsAbsorbJobsByKeys(keys: readonly string[]) { return jobsChecks.listDeadFactsAbsorbJobsByKeys(this, keys); }
  async readJobInsight(spec: jobsInsight.JobInsightSpec) { return jobsInsight.readJobInsight(this, spec); }
  // Group C (spend reservations and lease pressure).
  async readJobSpendTree(spec: jobsSpend.JobSpendTreeSpec) { return jobsSpend.readJobSpendTree(this, spec); }
  async insertSpendReservation(row: jobsSpend.SpendReservationInsert) { return jobsSpend.insertSpendReservation(this, row); }
  async expireSpendReservations(scope?: jobsSpend.ExpireSpendScope) { return jobsSpend.expireSpendReservations(this, scope); }
  async settleSpendReservation(reservationId: string, actualCents: number) { return jobsSpend.settleSpendReservation(this, reservationId, actualCents); }
  async markSpendUsageUnknown(reservationId: string, reason: string) { return jobsSpend.markSpendUsageUnknown(this, reservationId, reason); }
  async reserveClientSpend(spec: spendLog.ClientReserveSpec) { return this.transaction(tx => spendLog.reserveClientSpend(tx, spec)); }
  async reserveGroupSpend(spec: spendLog.GroupReserveSpec) { return this.transaction(tx => spendLog.reserveGroupSpend(tx, spec)); }
  async readGroupSpendTotals(budgetKey: string) { return spendLog.readGroupSpendTotals(this, budgetKey); }
  async settleSpendWithLog(reservationId: string, actualCents: number, operation: string, tokenName: string | null) { return this.transaction(tx => spendLog.settleSpendWithLog(tx, reservationId, actualCents, operation, tokenName)); }
  async insertSpendLog(row: spendLog.SpendLogInsert) { return spendLog.insertSpendLog(this, row); }
  async sumClientSpendSince(clientId: string, since: Date) { return spendLog.sumClientSpendSince(this, clientId, since); }
  async readClientBudgetUsd(clientId: string) { return spendLog.readClientBudgetUsd(this, clientId); }
  async insertOauthClient(row: spendLog.OauthClientInsert) { return spendLog.insertOauthClient(this, row); }
  async updateOauthClientBudget(clientId: string, usd: number | null) { return spendLog.updateOauthClientBudget(this, clientId, usd); }
  async readAgentClientSpend() { return spendLog.readAgentClientSpend(this); }
  readOauthClient(clientId: string) { return this.ownRawRead(exec => oauthClients.readOauthClient(exec, clientId)); }
  async listOauthClients() { return oauthClients.listOauthClients(this); }
  async listAdminClientRows() { return oauthClients.listAdminClientRows(this); }
  async patchOauthClient(clientId: string, patch: oauthClients.OauthClientPatch, guard?: oauthClients.OauthClientPatchGuard) { return oauthClients.patchOauthClient(this, clientId, patch, guard); }
  async insertAccessToken(row: accessTokens.AccessTokenInsert) { return accessTokens.insertAccessToken(this, row); }
  async findActiveAccessTokens(target: string) { return accessTokens.findActiveAccessTokens(this, target); }
  async setAccessTokenMinTrust(id: string, tier: string | null) { return accessTokens.setAccessTokenMinTrust(this, id, tier); }
  async readLiveAccessTokenScope(id: string) { return accessTokens.readLiveAccessTokenScope(this, id); }
  async insertLeasePressure(row: jobsSpend.LeasePressureInsert) { return jobsSpend.insertLeasePressure(this, row); }
  async countLeasePressure(filter?: jobsSpend.LeasePressureFilter) { return jobsSpend.countLeasePressure(this, filter); }
  async listRecentLeasePressure(windowMs: number, limit: number) { return jobsSpend.listRecentLeasePressure(this, windowMs, limit); }
  // Group B (subagent transcript and tool ledger; engine-sql/jobs-subagent.ts).
  async listSubagentMessages(jobId: number, opts?: { last?: boolean }) { return jobsSubagent.listSubagentMessages(this, jobId, opts); }
  async countSubagentMessages(jobId: number) { return jobsSubagent.countSubagentMessages(this, jobId); }
  async insertSubagentMessage(jobId: number, message: jobsSubagent.SubagentMessageInsert) { return jobsSubagent.insertSubagentMessage(this, jobId, message); }
  async listSubagentToolExecutions(jobId: number, order: jobsSubagent.SubagentToolOrder) { return jobsSubagent.listSubagentToolExecutions(this, jobId, order); }
  async hasSubagentToolExecution(jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }) { return jobsSubagent.hasSubagentToolExecution(this, jobId, opts); }
  async listSubagentWriteOutcomes(jobId: number, toolUseIdPrefix?: string) { return jobsSubagent.listSubagentWriteOutcomes(this, jobId, toolUseIdPrefix); }
  async listSubagentOneshotLedger(jobId: number, toolUseIdPrefix: string) { return jobsSubagent.listSubagentOneshotLedger(this, jobId, toolUseIdPrefix); }
  async summarizeSubagentToolExecutions(jobIds: readonly number[], spec: { toolName: string; status: string }) { return jobsSubagent.summarizeSubagentToolExecutions(this, jobIds, spec); }
  async listSubagentPutPageSlugs(jobIds: readonly number[]) { return jobsSubagent.listSubagentPutPageSlugs(this, jobIds); }
  async listSubagentPutPageWrites(jobIds: readonly number[]) { return jobsSubagent.listSubagentPutPageWrites(this, jobIds); }
  async listSubagentRetainedPutPages(jobIds: readonly number[]) { return jobsSubagent.listSubagentRetainedPutPages(this, jobIds); }
  async listSubagentStagedPages(jobId: number) { return jobsSubagent.listSubagentStagedPages(this, jobId); }
  async listSubagentTimelineAppendCalls(jobIds: readonly number[], sourceId: string) { return jobsSubagent.listSubagentTimelineAppendCalls(this, jobIds, sourceId); }
  async recordSubagentToolExecutions(jobId: number, rows: readonly jobsSubagent.SubagentToolInsert[], opts?: { legacyGuard?: boolean }) { return this.transaction(tx => jobsSubagent.recordSubagentToolExecutions(tx, jobId, rows, opts)); }
  async startSubagentToolExecution(jobId: number, row: jobsSubagent.SubagentToolStart) { return jobsSubagent.startSubagentToolExecution(this, jobId, row); }
  async completeSubagentToolExecution(target: jobsSubagent.SubagentToolTarget, output: string) { return jobsSubagent.completeSubagentToolExecution(this, target, output); }
  async failSubagentToolExecution(target: jobsSubagent.SubagentToolTarget, error: string, fallback?: jobsSubagent.SubagentFailureFallback) { return this.transaction(tx => jobsSubagent.failSubagentToolExecution(tx, target, error, fallback)); }
  async countOffGridTakeWeights() { return takesReads.countOffGridTakeWeights(this); }
  async countTakes() { return takesReads.countTakes(this); }
  async planFactPurgeTakes(spec: takesReads.PurgeTakesSpec) { return takesReads.planFactPurgeTakes(this, spec); }
  async listTakeRowsForPage(pageId: number) { return takesReads.listTakeRowsForPage(this, pageId); }
  async readTakePreimages(read: takesReads.TakePreimageRead) { return takesReads.readTakePreimages(this, read); }
  async listHeldFenceTakeRows(spec: takesReads.HeldFenceTakeSpec) { return takesReads.listHeldFenceTakeRows(this, spec); }
  async readTakeRowTrust(pageId: number, rowNum: number) { return takesReads.readTakeRowTrust(this, pageId, rowNum); }
  async readTakeTrustRef(id: number) { return takesReads.readTakeTrustRef(this, id); }
  async readLivePageIdBySlug(slug: string, sourceId: string) { return takesReads.readLivePageIdBySlug(this, slug, sourceId); }
  async readPageTierRef(pageId: number) { return takesReads.readPageTierRef(this, pageId); }
  async readPageTierRows(ids: readonly number[]) { return takesReads.readPageTierRows(this, ids); }
  async pageHasFrontmatterKey(pageId: number, key: string) { return takesReads.pageHasFrontmatterKey(this, pageId, key); }
  async listTakeIdsLeavingFence(pageId: number, fence: takesReads.TakesLeavingFence) { return takesReads.listTakeIdsLeavingFence(this, pageId, fence); }
  async listTakePreimages(pageId: number, ids: readonly number[], incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>) { return takesReads.listTakePreimages(this, pageId, ids, incoming); }
  async deleteTakesByIds(ids: readonly number[]) { return takesReads.deleteTakesByIds(this, ids); }
  async findTakeId(pageId: number, rowNum: number) { return takesReads.findTakeId(this, pageId, rowNum); }
  readChronicleBackfillBatch(q: chronicleReadsImpl.ChronicleBackfillBatchQuery) { return chronicleReadsImpl.readChronicleBackfillBatch(this, q); }
  async listTakeHoldersAtRows(pageId: number, rowNums: readonly number[]) { return takesReads.listTakeHoldersAtRows(this, pageId, rowNums); }
  async stampTakeResolvedAt(pageId: number, rowNum: number, resolvedAt: string) { return takesReads.stampTakeResolvedAt(this, pageId, rowNum, resolvedAt); }
  async recordTakeHoldersUsed(requestId: string, holders: readonly string[]) { return takesReads.recordTakeHoldersUsed(this, requestId, holders); }
  async listLatestTakeGrades(filter: takesReads.TakeGradeFilter) { return takesReads.listLatestTakeGrades(this, filter); }
  async readTakeGrade(key: takesReads.TakeGradeKey) { return takesReads.readTakeGrade(this, key); }
  async insertTakeGrade(row: Parameters<typeof takesReads.insertTakeGrade>[1]) { return takesReads.insertTakeGrade(this, row); }
  async deleteTakeGrade(key: takesReads.TakeGradeKey) { return takesReads.deleteTakeGrade(this, key); }
  async readLiveTakePage(at: Parameters<typeof takesReads.readLiveTakePage>[1]) { return takesReads.readLiveTakePage(this, at); }
  async readTakeClaim(takeId: number) { return takesReads.readTakeClaim(this, takeId); }
  async upsertTakeHorizon(h: Parameters<typeof takesReads.upsertTakeHorizon>[1]) { return takesReads.upsertTakeHorizon(this, h); }
  async deleteTakeHorizon(takeId: number) { return takesReads.deleteTakeHorizon(this, takeId); }
  async listTakeHorizons(takeIds: readonly number[] | null) { return takesReads.listTakeHorizons(this, takeIds); }
  async listHorizonScanRows(sourceId: string | null) { return takesReads.listHorizonScanRows(this, sourceId); }
  async listWaveAppliedTakeIds(waveVersion: string) { return takesReads.listWaveAppliedTakeIds(this, waveVersion); }
  async revertWaveTakeResolutions(spec: Parameters<typeof takesReads.revertWaveTakeResolutions>[1]) { return takesReads.revertWaveTakeResolutions(this, spec); }
  async unapplyWaveTakeGrades(spec: Parameters<typeof takesReads.unapplyWaveTakeGrades>[1]) { return takesReads.unapplyWaveTakeGrades(this, spec); }
  async purgeTakeNudgesByWave(spec: Parameters<typeof takesReads.purgeTakeNudgesByWave>[1]) { return takesReads.purgeTakeNudgesByWave(this, spec); }
  async insertTakeNudge(n: takesReads.TakeNudgeInput) { return takesReads.insertTakeNudge(this, n); }
  async listTakeNudges(f: takesReads.TakeNudgeFilter) { return takesReads.listTakeNudges(this, f); }
  async listPendingTakeProposals(opts: { sourceId?: string; limit: number }) { return takeProposals.listPendingTakeProposals(this, opts); }
  async readTakeProposal(id: number, sourceId?: string) { return takeProposals.readTakeProposal(this, id, sourceId); }
  async claimTakeProposal(id: number, actedBy: string) { return takeProposals.claimTakeProposal(this, id, actedBy); }
  async readStrandedTakeProposalClaim(id: number) { return takeProposals.readStrandedTakeProposalClaim(this, id); }
  async releaseTakeProposalClaim(id: number, claimedAt: string | null) { return takeProposals.releaseTakeProposalClaim(this, id, claimedAt); }
  async setTakeProposalPromotedRow(id: number, rowNum: number) { return takeProposals.setTakeProposalPromotedRow(this, id, rowNum); }
  async rejectTakeProposal(id: number, actedBy: string) { return takeProposals.rejectTakeProposal(this, id, actedBy); }
  async takeProposalCached(key: takeProposals.TakeProposalPageKey) { return takeProposals.takeProposalCached(this, key); }
  async listRejectedTakeProposalClaims(sourceId: string, pageSlug: string) { return takeProposals.listRejectedTakeProposalClaims(this, sourceId, pageSlug); }
  async insertTakeProposal(p: takeProposals.TakeProposalInsert) { return takeProposals.insertTakeProposal(this, p); }
  async listTakeProposalTombstones(sourceId: string, prefix: string) { return takeProposals.listTakeProposalTombstones(this, sourceId, prefix); }
  async deleteTakeProposalTombstones(sourceId: string, prefix: string, slug?: string) { return takeProposals.deleteTakeProposalTombstones(this, sourceId, prefix, slug); }
  async listProposeTakesCandidatePages(scope: takeProposals.ProposeTakesCandidateScope) { return takeProposals.listProposeTakesCandidatePages(this, scope); }
  async readOpCheckpointDoc(op: string, fingerprint: string) { return takeProposals.readOpCheckpointDoc(this, op, fingerprint); }
  async writeOpCheckpointDoc(op: string, fingerprint: string, doc: unknown) { return takeProposals.writeOpCheckpointDoc(this, op, fingerprint, doc); }
  async listWriteRequestsByRequestId(requestId: string) { return takeProposals.listWriteRequestsByRequestId(this, requestId); }
  async readExtractReceiptSlot(sourceId: string, slug: string) { return extractBookkeeping.readExtractReceiptSlot(this, sourceId, slug); }
  async readExtractReceiptSeal(sourceId: string, slug: string, safeVersion: number) { return extractBookkeeping.readExtractReceiptSeal(this, sourceId, slug, safeVersion); }
  async upsertExtractRollupDay(d: extractBookkeeping.ExtractRollupDelta, opts?: { preV141?: boolean }) { return extractBookkeeping.upsertExtractRollupDay(this, d, opts); }
  async deletePurgedSlugStoreRows(sourceId: string, slugs: readonly string[], opts?: { ifPresent?: boolean }) { return purgeSlugStores.deletePurgedSlugStoreRows(this, sourceId, slugs, opts); }
  async listPageSecretOccurrences(pageIds: readonly number[]) { return purgeSlugStores.listPageSecretOccurrences(this, pageIds); }
  async deletePurgedSlugHolds(sourceId: string, pages: ReadonlyArray<{ slug: string; deletedAt?: string | null }>) { return purgeSlugStores.deletePurgedSlugHolds(this, sourceId, pages); }
  readHeldConcept(pageId: number) { return conceptRebuildSql.readHeldConcept(this, pageId); }
  isConceptStillHeld(pageId: number, deletedUs: string) { return conceptRebuildSql.isConceptStillHeld(this, pageId, deletedUs); }
  lockHeldConcept(pageId: number, sourceId: string, slug: string, deletedUs: string) { return conceptRebuildSql.lockHeldConcept(this, pageId, sourceId, slug, deletedUs); }
  lockLiveConceptMembers(sourceId: string, members: ReadonlyArray<{ slug: string; revision: string }>) { return conceptRebuildSql.lockLiveConceptMembers(this, sourceId, members); }
  listLiveConceptMemberRevisions(sourceId: string, slugs: readonly string[]) { return conceptRebuildSql.listLiveConceptMemberRevisions(this, sourceId, slugs); }
  listConceptIncomingLinks(pageId: number) { return conceptRebuildSql.listConceptIncomingLinks(this, pageId); }
  carryConceptIncomingLinks(sourceId: string, slug: string, incoming: readonly unknown[], oldId: number) { return conceptRebuildSql.carryConceptIncomingLinks(this, sourceId, slug, incoming, oldId); }
  readTombstoneWindow(pageId: number, hours: number) { return conceptRebuildSql.readTombstoneWindow(this, pageId, hours); }
  listCatalogRelations() { return graduationCatalog.listCatalogRelations(this); }
  readCatalogSchemaVersion() { return graduationCatalog.readCatalogSchemaVersion(this); }
  listCatalogForeignKeys() { return graduationCatalog.listCatalogForeignKeys(this); }
  async countMcpResolvedTakes(spec: takesReads.McpResolvedSpec) { return takesReads.countMcpResolvedTakes(this, spec); }
  async listTopResolvedTakesForHolder(holder: string) { return takesReads.listTopResolvedTakesForHolder(this, holder); }
  async listAbandonedTakes() { return takesReads.listAbandonedTakes(this); }
  async listTakeSupersessionCandidates(sourceIds: readonly string[]) { return takesReads.listTakeSupersessionCandidates(this, sourceIds); }
  async listTakePointers(pageId: number) { return takesReads.listTakePointers(this, pageId); }
  async listTakeSupersedeReceipts(sourceId: string, pageId: number, slug: string) { return takesReads.listTakeSupersedeReceipts(this, sourceId, pageId, slug); }
  async setTakeSupersededBy(pageId: number, rowNum: number, supersededBy: number | null) { return takesReads.setTakeSupersededBy(this, pageId, rowNum, supersededBy); }
  async listAcceptedTakeRemovals(sourceIds: readonly string[], proposalId: number | null) { return takesReads.listAcceptedTakeRemovals(this, sourceIds, proposalId); }
  async readTakeRowTier(pageId: number, rowNum: number) { return takesReads.readTakeRowTier(this, pageId, rowNum); }
  async countZeroWeightWithTakes() { return takesReads.countZeroWeightWithTakes(this); }
  async hasCodeEdgesSymbol(sourceId: string) { return takesReads.hasCodeEdgesSymbol(this, sourceId); }
  async listCorePageRows(spec: trustTierReads.CorePageRowSpec) { return this.ownRawRead(exec => trustTierReads.listCorePageRows(exec, spec)); }
  async listPendingCoreEditNotices(sourceIds: readonly string[] | null) { return this.ownRawRead(exec => trustTierReads.listPendingCoreEditNotices(exec, sourceIds)); }
  async listTrustScanRows(spec: trustTierReads.TrustScanRowSpec) { return trustTierReads.listTrustScanRows(this, spec); }
  async countUnscannedTrustRows(spec: trustTierReads.UnscannedTrustSpec) { return trustTierReads.countUnscannedTrustRows(this, spec); }
  async readTrustScanCursor() { return trustScan.readTrustScanCursor(this); }
  async writeTrustScanCursor(completedKeys: readonly unknown[]) { return trustScan.writeTrustScanCursor(this, completedKeys); }
  async listClaimPendingSourceIds() { return trustScan.listClaimPendingSourceIds(this); }
  async readTrustScanCeilings() { return trustScan.readTrustScanCeilings(this); }
  async readBeliefHistoryRows(spec: trustTierReads.BeliefHistoryRowQuery) { return trustTierReads.readBeliefHistoryRows(this, spec); }
  async listVisibleBeliefLifetimes(lifetimes: readonly string[]) { return trustTierReads.listVisibleBeliefLifetimes(this, lifetimes); }
  async listVersionTrustTiers(ids: readonly number[]) { return trustTierReads.listVersionTrustTiers(this, ids); }
  async listVersionReasonWriters(ids: readonly number[]) { return trustTierReads.listVersionReasonWriters(this, ids); }
  async listPageRefsByIds(ids: readonly number[]) { return trustTierReads.listPageRefsByIds(this, ids); }
  async listPageQuoteTiers(spec: trustTierReads.PageQuoteTierSpec) { return trustTierReads.listPageQuoteTiers(this, spec); }
  async listPageTrustTiersByKey(refs: readonly trustTierReads.PageKeyRef[]) { return trustTierReads.listPageTrustTiersByKey(this, refs); }
  async lockLivePagesByKey(refs: readonly trustTierReads.PageKeyRef[]) { return trustTierReads.lockLivePagesByKey(this, refs); }
  async listValidTimeIdentities(spec: trustTierReads.ValidTimeIdentitySpec) { return trustTierReads.listValidTimeIdentities(this, spec); }
  async pickValidTimeEdition(spec: trustTierReads.ValidTimePickSpec) { return trustTierReads.pickValidTimeEdition(this, spec); }
  async listAmendmentsNotApplied(spec: trustTierReads.AmendmentsNotAppliedSpec) { return trustTierReads.listAmendmentsNotApplied(this, spec); }
  async readPageVersionEdition(spec: { pageId: number; versionId: number }) { return trustTierReads.readPageVersionEdition(this, spec); }
  async readCursorEdition(spec: { pageId: number; revision: string }) { return trustTierReads.readCursorEdition(this, spec); }
  async pageAwaitsRederive(pageId: number) { return trustTierReads.pageAwaitsRederive(this, pageId); }
  async readSourceWriteRow(sourceId: string) { return memoryMutationReads.readSourceWriteRow(this, sourceId); }
  async readSourceLocalPath(sourceId: string) { return memoryMutationReads.readSourceLocalPath(this, sourceId); }
  async readFactEntitySlug(id: number, sourceId: string) { return memoryMutationReads.readFactEntitySlug(this, id, sourceId); }
  async hasLiveFileBackedPage(sourceId: string, slugs: readonly string[]) { return memoryMutationReads.hasLiveFileBackedPage(this, sourceId, slugs); }
  async factReadableUnder(spec: import('./engine.ts').FactReadableSpec) { return memoryMutationReads.factReadableUnder(this, spec); }
  async readRemoteForgetTier(spec: { factId: number; sourceId: string; remoteFloor: boolean }) { return memoryMutationReads.readRemoteForgetTier(this, spec); }
  async readForgetTarget(spec: import('./engine.ts').ForgetTargetSpec) { return memoryMutationReads.readForgetTarget(this, spec); }
  async isFactEntityUnbacked(id: number, sourceId: string) { return memoryMutationReads.isFactEntityUnbacked(this, id, sourceId); }
  async readLinkedFactCopies(spec: import('./engine.ts').LinkedFactCopiesSpec) { return memoryMutationReads.readLinkedFactCopies(this, spec); }
  async hasHiddenFactCopy(spec: { id: number; sourceId: string }) { return memoryMutationReads.hasHiddenFactCopy(this, spec); }
  async ownerReachesFact(spec: import('./engine.ts').OwnerReachSpec) { return memoryMutationReads.ownerReachesFact(this, spec); }
  async readFactWithdrawalClaim(spec: import('./engine.ts').FactWithdrawalClaimSpec) { return memoryMutationReads.readFactWithdrawalClaim(this, spec); }
  async readWithdrawalDiscovery<K extends withdrawalDiscoveryReads.WithdrawalDiscoveryKind>(read: Extract<withdrawalDiscoveryReads.WithdrawalDiscoveryRead, { kind: K }>) { return withdrawalDiscoveryReads.readWithdrawalDiscovery<K>(this, read); }
  async listSegmentedPages(sourceId: string, slugs: readonly string[]) { return withdrawalPages.listSegmentedPages(this, sourceId, slugs); }
  async invalidateWithdrawnPages(sourceId: string, slugs: readonly string[]) { return withdrawalPages.invalidateWithdrawnPages(this, sourceId, slugs); }
  async hasWithdrawnFenceClaim(sourceId: string, claims: readonly withdrawalFence.FenceClaimRow[], subject: string | null) { return withdrawalFence.hasWithdrawnFenceClaim(this, sourceId, claims, subject); }

  // Decide family, group B: calibration profiles (engine-sql/calibration-profiles.ts).
  async getLatestCalibrationProfile(spec: CalibrationProfilesSql.LatestCalibrationProfileSpec) { return calibrationProfiles.getLatestCalibrationProfile(this, spec); }
  async isCalibrationProfileUnchanged(spec: CalibrationProfilesSql.CalibrationProfileUnchangedSpec) { return calibrationProfiles.isCalibrationProfileUnchanged(this, spec); }
  async insertCalibrationProfile(row: CalibrationProfilesSql.CalibrationProfileInsert) { return calibrationProfiles.insertCalibrationProfile(this, row); }
  async readVoiceGateHealth(spec: { sourceIds?: readonly string[] }) { return calibrationProfiles.readVoiceGateHealth(this, spec); }
  async purgeCalibrationProfilesByWave(spec: { waveVersion: string; dryRun: boolean }) { return calibrationProfiles.purgeCalibrationProfilesByWave(this, spec); }

  // ============================================================
  // v0.20.0 Cathedral II: code edges (Layer 1 stubs — filled by Layer 5)
  // ============================================================
  // Declared here so the interface contract is satisfied and consumers can
  // import against them. Implementations throw until the edge extractor +
  // per-lang tree-sitter queries land in Layer 5/6.
  // ============================================================

  // Code-edge SQL lives once in ./engine-sql/code-edges.ts (refactor wave 1 C13).

  async addCodeEdges(edges: import('./types.ts').CodeEdgeInput[]): Promise<number> {
    return codeEdgesImpl.addCodeEdges(this.engineSql, edges);
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    return codeEdgesImpl.deleteCodeEdgesForChunks(this.engineSql, chunkIds);
  }

  async clearCodeEdgesLeavingChunks(chunkIds: number[]): Promise<void> {
    return codeEdgesImpl.clearCodeEdgesLeavingChunks(this.autocommitSql, chunkIds);
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; chunkId?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCallersOf(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), qualifiedName, opts);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; bareFallback?: boolean; chunkId?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCalleesOf(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), qualifiedName, opts);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getEdgesByChunk(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), chunkId, opts);
  }

  // jobs-tables group D: the code_traversal_cache table (./engine-sql/code-traversal-cache.ts).
  async getCodeTraversalCache(key: codeTraversalCache.CodeTraversalCacheKey) { return codeTraversalCache.getCodeTraversalCache(this, key); }
  async putCodeTraversalCache(key: codeTraversalCache.CodeTraversalCacheKey, response: unknown, maxChunkUpdatedAt: string, xminMax: number) { return codeTraversalCache.putCodeTraversalCache(this, key, response, maxChunkUpdatedAt, xminMax); }
  async clearCodeTraversalCache(opts: codeTraversalCache.CodeTraversalCacheClear) { return codeTraversalCache.clearCodeTraversalCache(this, opts); }

  // Eval capture (v0.25.0). See BrainEngine interface docs.
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    return insertEvalCandidate(this, input);
  }

  async listEvalCandidates(filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]> {
    const sql = this.sql;
    const raw = filter?.limit;
    const limit = (raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0)
      ? 1000
      : Math.min(Math.floor(raw), 100000);
    const since = filter?.since ?? new Date(0);
    const tool = filter?.tool ?? null;
    // id DESC tiebreaker so same-millisecond inserts return deterministically
    // — without this, `gbrain eval export --since` could dupe or miss rows
    // across non-overlapping windows.
    const rows = tool
      ? await sql`
          SELECT * FROM eval_candidates
          WHERE created_at >= ${since} AND tool_name = ${tool}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT * FROM eval_candidates
          WHERE created_at >= ${since}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `;
    return rows as unknown as EvalCandidate[];
  }

  async deleteEvalCandidatesBefore(date: Date): Promise<number> {
    const sql = this.sql;
    const rows = await sql`
      DELETE FROM eval_candidates WHERE created_at < ${date} RETURNING id
    `;
    return rows.length;
  }

  async logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void> {
    const sql = this.sql;
    await sql`INSERT INTO eval_capture_failures (reason) VALUES (${reason})`;
  }

  async listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]> {
    const sql = this.sql;
    const since = filter?.since ?? new Date(0);
    const rows = await sql`
      SELECT * FROM eval_capture_failures
      WHERE ts >= ${since}
      ORDER BY ts DESC, id DESC
    `;
    return rows as unknown as EvalCaptureFailure[];
  }

  // ============================================================
  // v0.29 — Salience + Anomaly Detection
  // ============================================================

  // Salience SQL lives once in ./engine-sql/salience.ts (refactor wave 1 C10).

  /** Narrow deps for the peeled salience module. */
  async batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]> {
    return salienceImpl.batchLoadEmotionalInputs(unscopedExecutor(this.engineSql, 'salience: unscoped on master (EO4 inventory)'), slugs);
  }

  async setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number> {
    return salienceImpl.setEmotionalWeightBatch(this.engineSql, rows);
  }

  async getRecentSalience(opts: SalienceOpts): Promise<SalienceResult[]> {
    return salienceImpl.getRecentSalience(unscopedExecutor(this.engineSql, 'salience: unscoped on master (EO4 inventory)'), opts);
  }

  async listEnrichCandidates(opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]> {
    return salienceImpl.listEnrichCandidates(unscopedExecutor(this.engineSql, 'salience: unscoped on master (EO4 inventory)'), opts);
  }

  async findAnomalies(opts: AnomaliesOpts): Promise<AnomalyResult[]> {
    return salienceImpl.findAnomalies(unscopedExecutor(this.engineSql, 'salience: unscoped on master (EO4 inventory)'), opts);
  }

  // Trust: the fact withdrawal ledger (engine-sql/trust-withdrawals.ts), through the raw path as before.
  hasCoveringFactWithdrawal(sourceId: string, visibility: string, factHash: string, claim: string, subject: string) { return trustWithdrawalsImpl.hasCoveringFactWithdrawal(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, visibility, factHash, claim, subject); }
  isFactWithdrawn(sourceId: string, visibility: string | null, claim: string, entitySlug: string | null, memberPage: string | null) { return trustWithdrawalsImpl.isFactWithdrawn(unscopedExecutor(this.engineSql, 'trust: the withdrawn-claim check ran through executeRaw unscoped'), sourceId, visibility, claim, entitySlug, memberPage); }
  isFactPurged(sourceId: string, visibility: string, claim: string, entitySlug: string | null) { return trustWithdrawalsImpl.isFactPurged(unscopedExecutor(this.engineSql, 'trust: the purged-claim check ran through executeRaw unscoped'), sourceId, visibility, claim, entitySlug); }
  insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null) { return trustWithdrawalsImpl.insertFactWithdrawal(this.autocommitSql, sourceId, visibility, claim, subject, withdrawnAt); }
  listFactWithdrawalDates(sourceId: string, claims: readonly trustWithdrawalsImpl.WithdrawalClaimRow[], subject: string | null) { return this.preparationRead(exec => trustWithdrawalsImpl.listFactWithdrawalDates(unscopedExecutor(exec, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, claims, subject)); }
  moveFactWithdrawalSubject(sourceId: string, oldSlug: string, newSlug: string) { return trustWithdrawalsImpl.moveFactWithdrawalSubject(this.autocommitSql, sourceId, oldSlug, newSlug); }
  hasFactWithdrawalForSubject(sourceId: string, subject: string) { return trustWithdrawalsImpl.hasFactWithdrawalForSubject(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, subject); }
  listFactWithdrawalKeys(sourceId: string, limit: number) { return trustWithdrawalsImpl.listFactWithdrawalKeys(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, limit); }
  readFactCacheWatermark(sourceId: string) { return trustWithdrawalsImpl.readFactCacheWatermark(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId); }
  readTrustGeneration() { return trustWithdrawalsImpl.readTrustGeneration(unscopedExecutor(this.engineSql, 'trust: the policy generation read ran through executeRaw unscoped')); }
  readSourcePurgeFlags(sourceId: string) { return trustWithdrawalsImpl.readSourcePurgeFlags(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), sourceId); }
  listPurgedTakeRows(sourceId: string, takes: readonly trustWithdrawalsImpl.TakeClaimRow[], subject: string | null) { return trustWithdrawalsImpl.listPurgedTakeRows(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), sourceId, takes, subject); }
  lockFactForWithdrawal(spec: trustWithdrawalsImpl.WithdrawalLockSpec) { return trustWithdrawalsImpl.lockFactForWithdrawal(this.autocommitSql, spec); }
  queueWithdrawalReview(sourceId: string, factRef: string) { return trustWithdrawalsImpl.queueWithdrawalReview(this.autocommitSql, sourceId, factRef); }
  listSegmentedPagesBySlug(sourceId: string, slugs: readonly string[]) { return trustWithdrawalsImpl.listSegmentedPagesBySlug(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), sourceId, slugs); }
  bumpWithdrawnPageRevisions(sourceId: string, slugs: readonly string[]) { return trustWithdrawalsImpl.bumpWithdrawnPageRevisions(this.autocommitSql, sourceId, slugs); }
  readPageRevisions(ids: readonly number[]) { return trustWithdrawalsImpl.readPageRevisions(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), ids); }
  appendFactForgetReason(id: number, sourceId: string, note: string) { return trustWithdrawalsImpl.appendFactForgetReason(this.autocommitSql, id, sourceId, note); }
  readFactWithdrawnRow(spec: trustWithdrawalsImpl.FactWithdrawnSpec) { return trustWithdrawalsImpl.readFactWithdrawnRow(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), spec); }
  readFactWithdrawnBacking(spec: trustWithdrawalsImpl.FactWithdrawnSpec) { return trustWithdrawalsImpl.readFactWithdrawnBacking(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), spec); }
  // Open loops (engine-sql/open-loops.ts), through the raw path as before.
  upsertOpenLoop(loop: OpenLoopUpsertInput) { return whenNotAborted(() => openLoopsImpl.upsertOpenLoop(this.autocommitSql, loop)); }
  closeOpenLoop(sourceId: string | null, id: number, status: Exclude<OpenLoopStatus, 'open'>, closedBy: string) { return whenNotAborted(() => openLoopsImpl.closeOpenLoop(this.autocommitSql, sourceId, id, status, closedBy)); }
  listOpenLoops(opts?: OpenLoopListOpts) { return whenNotAborted(() => openLoopsImpl.listOpenLoops(unscopedExecutor(this.engineSql, 'open loops: the list read ran through executeRaw unscoped'), opts)); }
  readEntityOpenLoops(slug: string, sourceId: string, limit: number) { return whenNotAborted(() => openLoopsImpl.readEntityOpenLoops(unscopedExecutor(this.engineSql, 'open loops: the entity card read ran through executeRaw unscoped'), slug, sourceId, limit)); }
  countOpenLoopsByCounterpartyEmail(sourceId: string, emails: readonly string[], loopType: string) { return whenNotAborted(() => openLoopsImpl.countOpenLoopsByCounterpartyEmail(unscopedExecutor(this.engineSql, 'open loops: the withheld-noise count ran through executeRaw unscoped'), sourceId, emails, loopType)); }
  // Loop mutes (engine-sql/loop-mutes.ts), through the raw path as before.
  addLoopSuppression(sourceId: string, kind: loopMutesImpl.SuppressionKind, value: string) { return loopMutesImpl.addLoopSuppression(this.autocommitSql, sourceId, kind, value); }
  removeLoopSuppression(sourceId: string, kind: loopMutesImpl.SuppressionKind, value: string) { return loopMutesImpl.removeLoopSuppression(this.autocommitSql, sourceId, kind, value); }
  listLoopSuppressions(sourceId: string) { return loopMutesImpl.listLoopSuppressions(unscopedExecutor(this.engineSql, 'loop mutes: the mute list read ran through executeRaw unscoped'), sourceId); }
  listMuteRecheckThreads(sourceId: string) { return loopMutesImpl.listMuteRecheckThreads(unscopedExecutor(this.engineSql, 'loop mutes: the re-check thread read ran through executeRaw unscoped'), sourceId); }
  closeMutedLoops(sourceId: string, kind: loopMutesImpl.SuppressionKind, value: string, apply: boolean) { return loopMutesImpl.closeMutedLoops(this.autocommitSql, sourceId, kind, value, apply); }
  requeueMutedLoops(sourceId: string, kind: loopMutesImpl.SuppressionKind, value: string, apply: boolean) { return loopMutesImpl.requeueMutedLoops(this.autocommitSql, sourceId, kind, value, apply); }
  closeThreadLoops(sourceId: string, threadId: string, closedBy: string, only: readonly string[] | null) { return loopMutesImpl.closeThreadLoops(this.autocommitSql, sourceId, threadId, closedBy, only); }
  settleMuteRecheck(sourceId: string, threadId: string) { return loopMutesImpl.settleMuteRecheck(this.autocommitSql, sourceId, threadId); }
  // Source archive (engine-sql/source-archive.ts), through the raw path as before.
  archiveSource(sourceId: string, ttlHours: number) { return sourceArchiveImpl.archiveSource(this.autocommitSql, sourceId, ttlHours); }
  restoreArchivedSource(sourceId: string, federated: boolean) { return sourceArchiveImpl.restoreArchivedSource(this.autocommitSql, sourceId, federated); }
  listArchivedSourceRows() { return sourceArchiveImpl.listArchivedSourceRows(unscopedExecutor(this.engineSql, 'source archive: the archive list read ran through executeRaw unscoped')); }
  listExpiredArchivedSources() { return sourceArchiveImpl.listExpiredArchivedSources(unscopedExecutor(this.engineSql, 'source archive: the expired archive read ran through executeRaw unscoped')); }
  listUnverifiedArchivedSourceIds() { return sourceArchiveImpl.listUnverifiedArchivedSourceIds(unscopedExecutor(this.engineSql, 'source archive: the unverified archive read ran through executeRaw unscoped')); }
  listSourceOAuthClients(sourceId: string) { return sourceArchiveImpl.listSourceOAuthClients(unscopedExecutor(this.engineSql, 'source archive: the source client read ran through executeRaw unscoped'), sourceId); }
  private get entityIdentityRead() { return unscopedExecutor(this.engineSql, 'entity identities: master engine.executeRaw, unscoped'); }
  linkEntityIdentityRow(input: EntityIdentityLinkInput) { return entityIdentitiesImpl.linkEntityIdentityRow(this.autocommitSql, input); }
  unlinkEntityIdentityRow(input: EntityIdentityUnlinkInput) { return entityIdentitiesImpl.unlinkEntityIdentityRow(this.autocommitSql, input); }
  listEntityIdentityRows(filter: EntityIdentityFilter) { return entityIdentitiesImpl.listEntityIdentityRows(this.entityIdentityRead, filter); }
  readEntityIdentityIdsForPages(pages: ReadonlyArray<{ sourceId: string; slug: string }>) { return entityIdentitiesImpl.readEntityIdentityIdsForPages(this.entityIdentityRead, pages); }
  readCanonicalTwin(sourceId: string, slug: string) { return entityIdentitiesImpl.readCanonicalTwin(this.entityIdentityRead, sourceId, slug); }
  upsertWriteGateReceipt(input: trustWriteGateImpl.WriteGateReceiptInput) { return trustWriteGateImpl.upsertWriteGateReceipt(this.autocommitSql, input); }
  upsertPageWriteGateReceipt(sourceId: string, slug: string, receipt: trustWriteGateImpl.WriteGateReceiptFields) { return trustWriteGateImpl.upsertPageWriteGateReceipt(this.autocommitSql, sourceId, slug, receipt); }
  deleteStalePageWriteGateReceipts(sourceId: string, slug: string, contentHash: string | null) { return trustWriteGateImpl.deleteStalePageWriteGateReceipts(this.autocommitSql, sourceId, slug, contentHash); }
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number) { return trustWriteGateImpl.listWriteGateReceiptsFor(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), targetTable, targetId, limit); }
  deleteStaleWriteGateReceipts(olderThanDays: number) { return trustWriteGateImpl.deleteStaleWriteGateReceipts(this.autocommitSql, olderThanDays); }
  upsertWriteGateHold(input: trustWriteGateImpl.WriteGateHoldRowInput) { return trustWriteGateImpl.upsertWriteGateHold(this.autocommitSql, input); }
  listWriteGateHoldRows(opts: trustWriteGateImpl.WriteGateHoldListOpts) { return trustWriteGateImpl.listWriteGateHoldRows(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), opts); }
  listTrustAllowRuleRows(opts: trustWriteGateImpl.TrustAllowRuleListOpts = {}) { return trustWriteGateImpl.listTrustAllowRuleRows(unscopedExecutor(this.engineSql, 'trust: the allow rule read ran through executeRaw unscoped'), opts); }
  getWriteGateHoldRow(id: number) { return trustWriteGateImpl.getWriteGateHoldRow(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), id); }
  decideWriteGateHold(id: number, status: 'released' | 'dropped', decidedBy: string) { return trustWriteGateImpl.decideWriteGateHold(this.autocommitSql, id, status, decidedBy); }
  // Decide proposals (group C; engine-sql/decide-proposals.ts).
  async insertDecideProposal(p: decideProposals.NewProposal) { return decideProposals.insertDecideProposal(this, p); }
  async getDecideProposal(id: number, lock?: boolean) { return decideProposals.getDecideProposal(this, id, lock); }
  async listDecideProposalIds(sweepId: string, status: decideProposals.ProposalStatus) { return decideProposals.listDecideProposalIds(this, sweepId, status); }
  async listDecideProposals(opts?: { status?: decideProposals.ProposalStatus | 'all'; limit?: number }) { return decideProposals.listDecideProposals(this, opts); }
  async transitionDecideProposal(id: number, from: decideProposals.ProposalStatus, to: decideProposals.ProposalStatus, state?: { before?: string | null; after?: string | null }) { return decideProposals.transitionDecideProposal(this, id, from, to, state); }
  async listDecideProposedPairs(sourceId: string, factId: number) { return decideProposals.listDecideProposedPairs(this, sourceId, factId); }
  async insertDecideReviewProposal(p: decideProposals.NewReviewProposal) { return decideProposals.insertDecideReviewProposal(this, p); }
  async listDecideReviewProposals(status: string) { return decideProposals.listDecideReviewProposals(this, status); }
  async getDecideReviewProposal(id: number, lock?: boolean) { return decideProposals.getDecideReviewProposal(this, id, lock); }
  async transitionDecideReviewProposal(id: number, from: string, to: string) { return decideProposals.transitionDecideReviewProposal(this, id, from, to); }
  async listDecideReviewProposalIds(sweepId: string, includeWithdrawals: boolean) { return decideProposals.listDecideReviewProposalIds(this, sweepId, includeWithdrawals); }
  async readProposalReviewRates() { return decideProposals.readProposalReviewRates(this); }
  async listDueDecideReviewQueue(kind: string, sourceId: string, limit: number) { return decideProposals.listDueDecideReviewQueue(this, kind, sourceId, limit); }
  async applyDecideReviewQueue(op: decideProposals.ReviewQueueOp) { return decideProposals.applyDecideReviewQueue(this, op); }
  async listDueDecideSweepDeferred(sourceId: string, limit: number) { return decideProposals.listDueDecideSweepDeferred(this, sourceId, limit); }
  async applyDecideSweepDeferred(sourceId: string, op: decideProposals.SweepDeferredOp) { return decideProposals.applyDecideSweepDeferred(this, sourceId, op); }

  // Group A (jobs-tables): the Wakeshift report-back tables (engine-sql/jobs-wake.ts).
  openWakeWatch(watch: jobsWake.WakeWatchInsert) { return jobsWake.openWakeWatch(this, watch); }
  listWakeWatches(filter: jobsWake.WakeWatchFilter) { return jobsWake.listWakeWatches(this, filter); }
  endWakeWatches(spec: jobsWake.EndWakeWatches) { return jobsWake.endWakeWatches(this, spec); }
  countWakeWatches() { return jobsWake.countWakeWatches(this); }
  readWakeDoctor() { return jobsWake.readWakeDoctor(this); }
  countPendingWakeForgets() { return jobsWake.countPendingWakeForgets(this); }
  listWakeCrons() { return jobsWake.listWakeCrons(this); }
  addWakeCron(name: string) { return jobsWake.addWakeCron(this, name); }
  removeWakeCron(name: string) { return jobsWake.removeWakeCron(this, name); }
  hasWakeCron(name: string) { return jobsWake.hasWakeCron(this, name); }
  recordWakeCronRun(run: { name: string; status: string; finishedAt: string | null }) { return jobsWake.recordWakeCronRun(this, run); }
  hasWakeTermsAcceptance(principalKey: string, termsVersion: string) { return jobsWake.hasWakeTermsAcceptance(this, principalKey, termsVersion); }
  recordWakeTermsAcceptance(principalKey: string, termsVersion: string) { return jobsWake.recordWakeTermsAcceptance(this, principalKey, termsVersion); }
  listDueWakeWatches(spec: { ids?: readonly number[] } = {}) { return jobsWake.listDueWakeWatches(this, spec); }
  claimWakeWatch(id: number, leaseSeconds: number) { return jobsWake.claimWakeWatch(this, id, leaseSeconds); }
  settleWakeWatch(settle: jobsWake.WakeWatchSettle) { return jobsWake.settleWakeWatch(this, settle); }
  queueWakeForget(wakeUser: string, memberId: string | null) { return jobsWake.queueWakeForget(this, wakeUser, memberId); }
  forgetWakeMember(memberId: string) { return jobsWake.forgetWakeMember(this, memberId); }
  forgetWakeCredential(kind: jobsWake.WakeCredentialKind, id: string) { return jobsWake.forgetWakeCredential(this, kind, id); }
  claimWakeForgets(spec: { leaseSeconds: number; limit: number }) { return jobsWake.claimWakeForgets(this, spec); }
  settleWakeForget(settle: jobsWake.WakeForgetSettle) { return jobsWake.settleWakeForget(this, settle); }
}
