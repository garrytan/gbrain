import { registerManagedFilesystemEngine } from './persistence/filesystem-guard.ts';
import { capabilitiesForEngineKind, type EngineCapabilities } from './engine-capabilities.ts';
import { writerStamp } from './persistence/writer-versions.ts';
import { noteRequestConfigWrite, requestConfigRows, requestConfigValue } from './config-snapshot.ts';
import { replaceDerivedLinks, replaceDerivedLinksBatch, type DerivedLinkBatchItem, type DerivedLinkOrigin, type DerivedLinkReplacementOptions } from './derived-links.ts';
import { trackPgliteDatabase, PgliteClosingError, notifyPgliteOpened } from './pglite-lifecycle.ts';
import { mutatePageTag } from './page-state/tags.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import type { GetVersionsOpts, PageVersionRows } from './page-state/version-types.ts';
import { assertPageRevision } from './page-state/types.ts';
import { assertOriginUnclaimed, assertRevivalUnclaimed, classifyOriginUniqueViolation } from './persistence/origin-guard.ts';
import { lockUnheldPageKeys, withHeldPageKeys, type HeldPageKeys } from './page-state/guards.ts';
import { readPageSnapshot as readCanonicalPageSnapshot } from './page-state/snapshot.ts';
import { readPageSnapshotsBatch } from './page-snapshot-batch.ts';
import { createPageVersion, type VersionHistory } from './page-state/versions.ts';
import { moveSlugBindings, recordRenameAlias } from './page-state/rename-alias.ts';
import { dropPhantomMigrationDuplicates } from './facts/ontology-rekey.ts';
import { composablePgliteTransaction, transactionMemo } from './page-state/transactions.ts';
import { configurePgliteCodecs, PgliteStatementCache } from './pglite-statements.ts';
import { snapshotSchemaInputs } from './snapshot-schema-inputs.ts';
import type { PageReadScope } from './types.ts';
import type { PageReadPolicy } from './types.ts';
import { readRelationalFanout, readChainHop, readAliases, readBacklinkCounts, readAdjacencyBoosts, readContentFlags, readExtractionStates, readEffectiveDates, readSalienceScores } from './search/read-enrichment.ts';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
// Engine-live path: static top-level imports (scratch probe, #2674) — the
// engine-dynamic-import guard forbids lazy `import()` here.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve as resolvePath, sep as pathSep } from 'node:path';
// Engine-live path: static top-level import (no lazy `import()`). Supplies
// PGLite's WASM/fsBundle/extension assets embedded via `with { type: 'file' }`
// so a `bun build --compile` binary can serve a PGLite brain (Bun vfs #1340).
// The embedded `extensions` REPLACE the stock `{ vector, pg_trgm }` imports.
import { getEmbeddedPgliteOptions, withSharedBuffers } from './pglite-embedded-assets.ts';
import {
  drainBackgroundWorkBeforeDisconnect,
  backgroundWorkSinkCount,
  pgliteCloseTimeoutMs,
  SINK_DRAIN_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
} from './background-work.ts';
// Engine-live path: static top-level import (no lazy `import()`). The opt-in
// out-of-band disconnect watchdog (#4284) reuses the worker_threads watchdog
// `gbrain sync` already validated against starved event loops (#1633).
import { installProcessWatchdog } from './process-watchdog.ts';
import type {
  BrainEngine,
  BatchOpts,
  LinkBatchInput, TimelineBatchInput,
  ReservedConnection,
  DreamVerdict, DreamVerdictInput,
  FileSpec, FileRow, ListFilesOptions,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow, StaleTakeOpts, TakeEmbeddingInput,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
  FactRow, FactInsertStatus,
  NewFact, FactListOpts, RecallFactReadOpts, FactsHealth,
  SourceRow, PageTrustLookup, RowTrustLookup, PageAtRevisionRef,
  WantedLinkRowsReplacement,
} from './engine.ts';
import { DREAM_VERDICT_TTL_SECONDS, clampSearchLimit, type CycleLockFilter, type TransactionOptions } from './engine.ts';
import { transactionAborted } from './postgres-engine/transaction-abort.ts';
import { searchLimitCap } from './search/eval-pool-depth.ts';
// Engine-path imports stay static unless a call site carries an explicit
// engine-dynamic-import-ok justification. The gateway is the only current
// exception because its local try/catch preserves a soft fallback.
import {
  withRetry,
  BULK_RETRY_OPTS,
  resolveBulkRetryOpts,
  computeNextDelay,
  isRetryableConnError,
  type BatchAuditSite,
} from './retry.ts';
import {
  valueHash,
  normalizeDimension,
  isNovelDimension, isBackdatedObservation, ONTOLOGY_SUPERSEDE_GUARD, NOT_CONVERSATION_SLOT_SQL, CONVERSATION_SLOT_SQL,
} from './chronicle/ontology.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import { supportsHnswIterativeScan } from './vector-index.ts';
import { searchIndexWalk, searchVectorPool, readVectorPool, type VectorPoolAttempt } from './search/vector-pool.ts';
import { beforePlannerRead, plannerRead } from './planner-stats.ts';
import { buildVectorSearchStatement, PAGE_SOURCE_STATS_SQL, SCOPE_CHUNKS_SQL, VECTOR_EXTENSION_VERSION_SQL, vectorScopeLoader, type PageSourceStats, type ScopeChunkCount } from './search/vector-statement.ts';
import { withVectorSettings } from './search/vector-settings.ts';
import { PGLITE_SCHEMA_SQL, getPGLiteSchema } from './pglite-schema.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { readStoredEmbeddingIdentity } from './stored-embedding-identity.ts';
import { assertEmbeddedEmbedding, embeddedSchemaEmbedding, isEmbeddedEngine } from './embedded-engine.ts';
import { DELETE_BATCH_SIZE, TRAVERSE_PATH_ROW_CAP, TRAVERSE_WALK_ROW_CAP } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { SAFE_FENCE_CHUNKER_VERSION, bodyWriteChunkVersion, currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from './search/safe-chunks.ts';
import { acquireLock, pgliteLockDirFor, releaseLock, type LockHandle } from './pglite-lock.ts';
import { assertPgliteGraduationOpenable } from './persistence/graduation-custody.ts';
// Engine-live path (#3596): static import, never a lazy `import()` in the
// connect() catch. No cycle: pglite-repair.ts imports nothing from this file.
import { attemptWalRepairAndRetry, closeRepairEpisodeIfOpen, readRepairFailedMarker, recordFailedAutoRepair, type WalRepairReceipt } from './pglite-repair.ts';
import { getFtsLanguage } from './fts-language.ts';
import { splitEmbeddingSignature, currentSpaceChunkPredicate, lockEmbeddingSources } from './embedding-invalidation.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput, ChunkReuseRow, StaleChunkRow, StalePageRow, ChunklessPageRow,
  SearchResult, SearchOpts, ResolvedColumn,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  ChronicleTimelineRow, ChronicleTimelineOpts, LastSeenResult,
  OntologyObservationInput, OntologyMergeResult, OntologyValue, OntologyDimensionStat,
  OntologyConflict, OntologyReadOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  EvalCandidate, EvalCandidateInput,
  EvalCaptureFailure, EvalCaptureFailureReason,
  SalienceOpts, SalienceResult, AnomaliesOpts, AnomalyResult,
  EmotionalWeightInputRow, EmotionalWeightWriteRow,
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow,
  EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';
import { validateSlug, contentHash, isBlankBody, rowToPage, rowToStalePage, rowToChunk, rowToSearchResult, isUndefinedTableError, warnOncePerProcess } from './utils.ts';
import { executeRawJsonb, type SqlValue } from './sql-query.ts';
import { sanitizeForJsonb, sanitizeText, buildLinkRows, buildTimelineRows } from './batch-rows.ts';
import { PAGE_SORT_SQL } from './types.ts';
import { finalizeLastSeen } from './chronicle/last-seen.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildBestPerPagePoolCte, buildOrFallbackWebsearchQuery, boundWebsearchQuery, collapseWebsearchDashRuns, keywordPhraseFactorSql } from './search/sql-ranking.ts';
import { RARE_TERM_CHUNK_CAP, rankOrFallbackByRarity, rareTermPagesSql, type RareTermPages } from './search/keyword-or-rarity.ts';
import { keywordArmRows } from './search/keyword-identifier-probe.ts';
import { privatePagesFilterFragment, privateSnapshotFilterFragment, privateLinkOriginFilterFragment, privateTimelineEventFilterFragment, privateFactFilterForReader, privatePagesFilterForCaller } from './search/private-visibility.ts';
import { deletedPageProjectionHiddenSql } from './eligibility/sql.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from './embed-skip.ts';
import {
  vectorCastSuffix,
  resolveActiveEmbeddingColumnFromEngine,
  resolveWriteColumnFromConfigRows,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from './search/embedding-column.ts';
import { hasCJK } from './cjk.ts';
import * as factsImpl from './engine-sql/facts.ts';
import * as synopsisTierImpl from './engine-sql/synopsis-tier.ts';
import * as sourceCrModeImpl from './engine-sql/source-cr-mode.ts';
import * as trustWithdrawalsImpl from './engine-sql/trust-withdrawals.ts';
import * as openLoopsImpl from './engine-sql/open-loops.ts';
import * as entityIdentitiesImpl from './engine-sql/entity-identities.ts';
import type { EntityIdentityFilter, EntityIdentityLinkInput, EntityIdentityUnlinkInput } from './engine-sql/entity-identities.ts';
import type { ListLoopsOpts as OpenLoopListOpts, LoopStatus as OpenLoopStatus, OpenLoopUpsert as OpenLoopUpsertInput } from './loops/loops-store.ts';
import * as trustWriteGateImpl from './engine-sql/trust-write-gate.ts';
import * as takesImpl from './engine-sql/takes.ts';
import { PgliteCheckpointGuard, guardedHandle, writesWal } from './pglite-engine/checkpoint-guard.ts';
import { pgliteExecutor } from './engine-sql/dialect-pglite.ts';
import type { SqlExecutor } from './engine-sql/executor.ts';
import { scopedRead, unscopedExecutor } from './engine-sql/brands.ts';
import * as codeEdgesImpl from './engine-sql/code-edges.ts';
import * as codeTraversalCache from './engine-sql/code-traversal-cache.ts';
import { getEdgesByChunk as getEdgesByChunkPglite, type PgliteCodeEdgesDeps } from './pglite-engine/code-edges.ts';
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
import * as notifierImpl from './engine-sql/notifier.ts';
import * as cliReadsImpl from './engine-sql/cli-reads-import.ts';
import * as writeMiscImpl from './engine-sql/write-misc.ts';
import * as worktreeClaimImpl from './engine-sql/worktree-claim.ts';
import type { WorktreeClaimStore } from './engine-sql/worktree-claim.ts';
import * as writerAdminImpl from './engine-sql/writer-admin.ts';
import type { WriterAdminStateOptions, WriterAdminStore } from './engine-sql/writer-admin.ts';
import * as writeAttributionImpl from './engine-sql/write-attribution.ts';
import * as opCheckpointImpl from './engine-sql/op-checkpoint.ts';
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
import * as fenceHoldsImpl from './engine-sql/fence-holds.ts';
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
import * as factsDoctorImpl from './engine-sql/facts-doctor.ts';
import * as embeddingCatalogImpl from './engine-sql/embedding-catalog.ts';
import * as factRelinkImpl from './engine-sql/fact-relink-attempts.ts';
import * as factRelinkWritesImpl from './engine-sql/fact-relink-writes.ts';
import * as factsCycleImpl from './engine-sql/facts-cycle.ts';
import * as factsPurgeImpl from './engine-sql/facts-purge.ts';
import * as factsRepairImpl from './engine-sql/facts-repair.ts';
import * as factsTrustImpl from './engine-sql/facts-trust.ts';
import type { ExactScanOpts } from './search/exact-scan.ts';
import type { ExactIdentityStatementOpts } from './engine-sql/exact-identity.ts';
import type { RankCoverageStatementOpts, RankEntitiesStatementOpts } from './engine-sql/graph-rank.ts';
import * as transactionSettingsImpl from './engine-sql/transaction-settings.ts';
import * as writerVersionsImpl from './engine-sql/writer-versions.ts';
import * as connectGateImpl from './engine-sql/connect-gate.ts';
import * as beliefImpl from './engine-sql/belief.ts';
import * as configImpl from './engine-sql/config.ts';
import * as accessControlImpl from './engine-sql/access-control.ts';
import * as accessPolicyImpl from './engine-sql/access-policy.ts';
import * as accessSetupImpl from './engine-sql/access-setup.ts';
import type { AccessCredentialLookup, AccessCredentialRow, AccessMemberLookup, AccessMemberRow, LiveMemberRow, LiveMemberVia, AudiencePrincipalRows, MayActForVia, FolderAccessRows } from './engine-sql/access-control.ts';
import * as cycleLocksImpl from './engine-sql/cycle-locks.ts';
import * as jobsImpl from './engine-sql/jobs.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, ListJobsFilter } from './engine-sql/jobs.ts';
import * as jobsQueue from './engine-sql/jobs-queue.ts';
import * as jobsHealth from './engine-sql/jobs-health.ts';
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
import * as trustTierReads from './engine-sql/trust-tier-reads.ts';
import * as versionReasons from './engine-sql/version-reasons.ts';
import * as versionPrune from './engine-sql/version-prune.ts';
import * as memoryMutationReads from './engine-sql/memory-mutation-reads.ts';
import * as withdrawalDiscoveryReads from './engine-sql/withdrawal-discovery.ts';
import * as withdrawalPages from './engine-sql/withdrawal-pages.ts';
import * as withdrawalFence from './engine-sql/withdrawal-fence.ts';
import type {
  CancelJobsSpec, DelayActiveJobSpec, JobAttachmentInsert, JobPageSpec, JobTokenCounts, PruneJobsSpec, RetryJobPolicy,
  SynthesisCompletionPrefix,
} from './engine-sql/jobs-queue.ts';
import * as filesImpl from './engine-sql/files.ts';
import type { ChunkWindowRequest, ChunkWindowOpts, ChunkWindowPage } from './search/chunk-windows.ts';
import type { KeywordPageWindow } from './search/keyword-statement.ts';
import { frontmatterWhereSql } from './search/frontmatter-where.ts';
import type { EmbeddingState, EmbeddingStateCounts, EmbeddingStateRow } from './embedding-state.ts';
import * as chunksImpl from './engine-sql/chunks.ts';
import * as searchReadsImpl from './engine-sql/search-reads.ts';
import * as linkReadsImpl from './engine-sql/link-reads.ts';
import * as linkTemporalImpl from './engine-sql/link-temporal.ts';
import * as searchVectorImpl from './engine-sql/search-vector.ts';
import * as retrievalCoverageImpl from './engine-sql/retrieval-coverage.ts';
import { backfillChunkVectors, backfillPageVectors, type VectorBackfillOpts } from './search-vector-backfill.ts';
import { ensureFactsFtsIndex } from './facts/fts-index.ts';
import type { RelationshipKey, RelationshipStateWrite } from './link-relationships.ts';
import type { CoverageRelevance } from './search/retrieval-coverage.ts';
import type { ProjectionReadinessScope } from './search/projection-readiness.ts';
import * as chunkReadsImpl from './engine-sql/chunk-reads.ts';
import * as timelineReadsImpl from './engine-sql/timeline-reads.ts';
import type { TimelineRowDeletion } from './engine-sql/timeline-reads.ts';
import * as telemetryImpl from './engine-sql/telemetry.ts';
import * as chatUsageImpl from './engine-sql/chat-usage.ts';
import * as fieldUsageImpl from './engine-sql/field-usage.ts';
import * as decideStoreImpl from './engine-sql/decide-store.ts';
import * as aliasFanoutReadsImpl from './engine-sql/alias-fanout-reads.ts';
import type { McpRequestLogRow, SearchTelemetryBucket } from './engine-sql/telemetry.ts';
import type { CodeChunkScope, CodeSymbolQuery, FrozenHitKey, UnsealedPageScope, WithdrawalChunkKey } from './engine-sql/chunk-reads.ts';
import type { ChunkMove } from './page-state/chunk-moves.ts';
import type { DerivedAliasRow } from './engine-sql/pages.ts';
import * as ownerOnlyMarksImpl from './engine-sql/owner-only-marks.ts';
import type { OwnerOnlyTriggerState } from './access/owner-only-marks.ts';
import { ownerOnlyLineageReadable } from './access/owner-only.ts';
import * as pageBodyImpl from './engine-sql/page-body.ts';
import type { BodyFlipInput, BodyFlipResult, BodyRegion, BodyStagingInput, BodyStagingState, ManifestRow, ManifestRowInput, SegmentChunkInput,
  SegmentedEmbedRef, SegmentedPageMeta, SegmentSweepOptions, SegmentSweepResult, SegmentTextInput } from './page-body/types.ts';
import type { SegmentDerivationInput, SegmentDerivationKind, SegmentDerivationRow } from './page-body/derivations.ts';
import { searchKeywordCJK } from './engine-sql/cjk-search.ts';
import * as titlesImpl from './engine-sql/titles.ts';
import * as keywordPagesImpl from './engine-sql/keyword-pages.ts';
import * as entityReadsImpl from './engine-sql/entity-reads.ts';
import * as pageEmbeddingBudgetImpl from './engine-sql/page-embedding-budget.ts';
import * as embeddingInstallImpl from './engine-sql/embedding-install.ts';
import { applyForwardReferenceBootstrap, pgliteBootstrapTarget } from './engine-sql/bootstrap.ts';
import { assertSchemaNotAhead } from './schema-client-behind.ts';
import { wellFormedJson } from './text-safe.ts';
import { ENGINE_ROOT } from './engine-root.ts';
import { insertEvalCandidate } from './feedback/store.ts';
import { noteSchemaVersion } from './migrate-pending.ts';

/**
 * #4284 — opt-in out-of-band watchdog for a PGLite disconnect with a live
 * handle. OFF by default: a DIAGNOSTIC/INCIDENT instrument (CI lanes, heavy
 * tests, wedge hunts), not ambient production protection. When armed it is
 * the ONLY layer that can fire while the event loop is wedged (worker_threads
 * — its timers live on a separate OS thread): stderr line + SIGTERM at the
 * deadline, SIGKILL at deadline+grace, converting a silent 600s CI kill into
 * a fast, loud, attributed death.
 *
 * (The in-loop close bound this backs up — `pgliteCloseTimeoutMs` — lives in
 * background-work.ts so cli-force-exit's computed teardown deadline budgets
 * the SAME bound the engine honors; its HONEST SCOPE is documented at the
 * close site below.)
 *
 * Resolve ordering is OFF-check FIRST: unset/''/0/negative → inert (deadline
 * 0) — but a SET-and-unparseable value ("30s", "5m") warns once before going
 * inert, because a garbage value must not silently disarm the instrument an
 * incident responder deliberately armed. Only a positive value proceeds to
 * the lethal-knob floor
 *   max(5000, backgroundWorkSinkCount()*SINK_DRAIN_TIMEOUT_MS + closeTimeout + 2000)
 * which budgets the serial pre-close drain plus the in-loop close bound, so a
 * numeric units typo (`=30`, thinking seconds) clamps UP with a warn instead
 * of SIGKILLing a HEALTHY slow teardown — `jobs work` daemons reconnect()
 * through disconnect(). Mirrors the computed-deadline pattern in
 * cli-force-exit.ts. Grace: explicit `0` is honored (SIGKILL at the
 * deadline); unset → default 30000; garbage warns once and uses the default.
 */
function pgliteCloseWatchdogMs(): { deadlineMs: number; graceMs: number } {
  const rawStr = process.env.GBRAIN_PGLITE_CLOSE_WATCHDOG_MS;
  if (rawStr === undefined || rawStr === '') return { deadlineMs: 0, graceMs: 0 }; // OFF (default)
  const raw = Number(rawStr);
  if (!Number.isFinite(raw)) {
    warnOncePerProcess(
      'pglite-close-watchdog-env-invalid',
      `[pglite] GBRAIN_PGLITE_CLOSE_WATCHDOG_MS=${rawStr} is not a number — the disconnect watchdog is OFF, not armed. Use milliseconds (e.g. 30000).`,
    );
    return { deadlineMs: 0, graceMs: 0 };
  }
  if (raw <= 0) return { deadlineMs: 0, graceMs: 0 }; // deliberate off
  const floor = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(5000, backgroundWorkSinkCount() * SINK_DRAIN_TIMEOUT_MS + pgliteCloseTimeoutMs() + 2000),
  );
  const deadlineMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(floor, Math.floor(raw)));
  if (deadlineMs > raw) {
    // Keyed by the computed deadline: in a long-lived daemon the floor GROWS
    // as sinks register lazily, and the warn must re-fire when the effective
    // deadline changes — otherwise the attribution surface lies about when
    // the kill will land (#4284 red-team).
    warnOncePerProcess(
      `pglite-close-watchdog-floor:${deadlineMs}`,
      `[pglite] GBRAIN_PGLITE_CLOSE_WATCHDOG_MS=${raw} is below this process's safe floor (drain budget + close timeout) — clamped up to ${deadlineMs}ms so a healthy slow teardown is never killed.`,
    );
  }
  let graceMs = 30_000;
  const rawGraceStr = process.env.GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS;
  if (rawGraceStr !== undefined && rawGraceStr !== '') {
    const g = Number(rawGraceStr);
    if (Number.isFinite(g) && g >= 0) {
      graceMs = Math.min(MAX_TIMER_DELAY_MS, Math.floor(g)); // explicit 0 = SIGKILL at deadline
    } else {
      warnOncePerProcess(
        'pglite-close-watchdog-grace-env-invalid',
        `[pglite] Ignoring invalid GBRAIN_PGLITE_CLOSE_WATCHDOG_GRACE_MS=${rawGraceStr}; using default 30000ms.`,
      );
    }
  }
  return { deadlineMs, graceMs };
}

type PGLiteDB = PGlite;

// Tier 3 snapshot fast-restore. Reads a tar dump produced by
// `bun run scripts/build-pglite-snapshot.ts`. Snapshot is matched against
// the current MIGRATIONS hash via a sidecar `.version` file; on mismatch we
// silently fall through to a normal initSchema (snapshot is just an
// optimization, never authoritative).
let _snapshotWarnLogged = false;

let _snapshotSchemaHashMemo: string | null = null;
const _snapshotFileMemo = new Map<string, { versionLines: string[]; blob: Blob | null } | null>();
let _snapshotTarReads = 0;

export function __snapshotMemoStatsForTests(): { tarReads: number; memoEntries: number } {
  return { tarReads: _snapshotTarReads, memoEntries: _snapshotFileMemo.size };
}

export function __resetSnapshotMemoForTests(): void {
  _snapshotSchemaHashMemo = null;
  _snapshotFileMemo.clear();
  _snapshotTarReads = 0;
  _snapshotWarnLogged = false;
}

export function tryLoadSnapshot(snapshotPath: string): Blob | null {
  try {
    let entry = _snapshotFileMemo.get(snapshotPath);
    if (entry === null) return null; // terminally unusable this process
    if (entry === undefined) {
      // First touch of this path in this process — do the file work once.
      // Lazy require so production builds without these imports don't crash.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs'); // engine-dynamic-import-ok
      const crypto = require('node:crypto') as typeof import('node:crypto'); // engine-dynamic-import-ok

      if (!fs.existsSync(snapshotPath)) {
        if (!_snapshotWarnLogged) {
          // eslint-disable-next-line no-console
          console.warn(`[pglite] GBRAIN_PGLITE_SNAPSHOT set but file missing: ${snapshotPath} — using normal init.`);
          _snapshotWarnLogged = true;
        }
        _snapshotFileMemo.set(snapshotPath, null);
        return null;
      }
      const versionPath = snapshotPath.replace(/\.tar(?:\.gz)?$/, '.version');
      if (!fs.existsSync(versionPath)) {
        if (!_snapshotWarnLogged) {
          // eslint-disable-next-line no-console
          console.warn(`[pglite] snapshot version file missing: ${versionPath} — using normal init.`);
          _snapshotWarnLogged = true;
        }
        _snapshotFileMemo.set(snapshotPath, null);
        return null;
      }
      if (_snapshotSchemaHashMemo === null) {
        // 'unavailable' (source files unreadable — compiled binary) never
        // matches a hex hash below, so the snapshot is refused via the same
        // stale path. Memoized either way: one file read per process.
        _snapshotSchemaHashMemo = computeSnapshotSchemaHash(crypto, fs) ?? 'unavailable';
      }
      const versionLines = fs.readFileSync(versionPath, 'utf8').trim().split('\n');
      if (_snapshotSchemaHashMemo !== (versionLines[0] ?? '')) {
        if (!_snapshotWarnLogged) {
          // eslint-disable-next-line no-console
          console.warn(`[pglite] snapshot stale (schema hash mismatch) — using normal init. Rebuild with: bun run build:pglite-snapshot`);
          _snapshotWarnLogged = true;
        }
        _snapshotFileMemo.set(snapshotPath, null);
        return null;
      }
      entry = { versionLines, blob: null };
      _snapshotFileMemo.set(snapshotPath, entry);
    }

    // W0 fix-wave: the version file's dims=/model= lines record the embedding
    // shape the snapshot was BAKED with. A snapshot whose vector(dims) columns
    // differ from what THIS process would create poisons every embedding
    // write ("expected 1280 dimensions, not 1536" — the W0 incident when the
    // fixture went default-on). Resolve our would-be shape through the same
    // gateway-with-default fallback initSchema uses and refuse a mismatch.
    // Version files without the shape lines (pre-W0) are treated as stale.
    // Re-evaluated on EVERY call against the CURRENT gateway config — never
    // memoized (see memo comment above).
    let wantDims: number | string = DEFAULT_EMBEDDING_DIMENSIONS;
    let wantModel: string = DEFAULT_EMBEDDING_MODEL;
    try {
      const gw = require('./ai/gateway.ts') as typeof import('./ai/gateway.ts'); // engine-dynamic-import-ok
      wantDims = gw.getEmbeddingDimensions();
      wantModel = gw.getEmbeddingModel();
    } catch { /* gateway not configured — defaults, same as initSchema */ }
    const shapeOk = entry.versionLines[1] === `dims=${wantDims}` && entry.versionLines[2] === `model=${wantModel}`;
    if (!shapeOk) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] snapshot embedding shape mismatch (want dims=${wantDims} model=${wantModel}, have ${entry.versionLines[1] ?? 'none'} ${entry.versionLines[2] ?? ''}) — using normal init. Rebuild with: bun run build:pglite-snapshot`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    if (entry.blob === null) {
      // Tar read deferred until the first shape-matching caller (see memo
      // comment above). A torn/unreadable tar is terminal for the process.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs'); // engine-dynamic-import-ok
        const buf = fs.readFileSync(snapshotPath);
        _snapshotTarReads += 1;
        entry.blob = new Blob([new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength)]);
      } catch {
        _snapshotFileMemo.set(snapshotPath, null);
        return null;
      }
    }
    return entry.blob;
  } catch {
    // Any failure -> fall through to normal init. Never block tests.
    return null;
  }
}

export function computeSnapshotSchemaHash(
  crypto: typeof import('node:crypto'),
  fs: typeof import('node:fs'),
): string | null {
  // Raw file bytes remain identical under coverage instrumentation, unlike
  // Function.toString(). The inputs are the static import closure of the
  // schema roots plus the bootstrap (src/core/snapshot-schema-inputs.ts), so a
  // new schema helper is hashed without editing a list; CI's pglite-snapshot
  // cache keys must cover the same files (test/snapshot-inputs-closure.test.ts).
  // Unreadable sources (compiled binary) safely disable this test optimization.
  try {
    const at = (file: string) => new URL(`./${file}`, import.meta.url);
    const files = snapshotSchemaInputs(
      (file) => fs.existsSync(at(file)),
      (file) => fs.readFileSync(at(file), 'utf8'),
    );
    const hash = crypto.createHash('sha256');
    hash.update('files:v4\n');
    for (const file of files) {
      hash.update(`${file}\n`);
      hash.update(fs.readFileSync(at(file)));
      hash.update('\n--\n');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * v0.41.8.0 (#1340) — classify PGLite.create() init failures so
 * the user-visible hint points at the right next step.
 *
 * `bunfs` — Bun's vfs ENOENT on older macOS where `/$$bunfs/root`
 *   is read-only, so PGLite can't extract its `pglite.data` WASM
 *   payload. Fix: `bun upgrade` (newer Bun versions mount the vfs
 *   writable) or run via Node.
 *
 * `corrupt` — catalog/pgvector corruption (#2348): 58P01 /
 *   internal_load_library / missing vector type or core relation.
 *   WAL reset cannot fix this class; routes to `gbrain reinit-pglite`.
 *   MUST stay matched BEFORE the wasm arm — a `58P01 … Aborted()`
 *   message is catalog corruption, not a WAL tear.
 *
 * `wasm-abort` — the Emscripten runtime abort (`Aborted(). Build with
 *   -sASSERTIONS…`, `RuntimeError: unreachable`, and the legacy #223
 *   signatures). Root cause is almost always corrupt WAL/checkpoint
 *   state after an unclean shutdown (historically misdiagnosed as a
 *   "macOS 26.3 WASM bug" — see #223); this verdict is the trigger
 *   for the in-place WAL auto-repair (`pglite-repair.ts`).
 *
 * `unknown` — falls through to a generic hint that names the doctor
 *   command; the #223 pointer is offered only on darwin (#2674).
 *
 * Regex tightened per Codex eng-review finding #9: don't match
 * generic `pglite.data` substring (could fire on unrelated PGLite
 * errors). Match the literal `$$bunfs` marker OR ENOENT+pglite.data
 * co-occurrence.
 */
export type PgliteInitFailure = 'bunfs' | 'wasm-abort' | 'corrupt' | 'unknown';

// #2674: non-Error rejections (Emscripten aborts can throw plain objects)
// used to stringify as "[object Object]" — prefer .message when present.
// WAL-repair wave: Emscripten's FS layer also throws message-LESS objects
// (e.g. `ErrnoError { name: 'ErrnoError', errno: 20 }` when the data dir is a
// symlink NODEFS refuses to mount) — surface name+errno / JSON instead of the
// useless "[object Object]".
export function stringifyPgliteInitError(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  if (message != null) return String(message);
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    const errno = (err as { errno?: unknown }).errno;
    if (typeof name === 'string' && errno != null) return `${name} (errno ${errno})`;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return typeof name === 'string' ? `${name}: ${json}` : json;
    } catch { /* circular — fall through */ }
    if (typeof name === 'string') return name;
  }
  return String(err);
}

export function classifyPgliteInitError(message: string): PgliteInitFailure {
  if (/\$\$bunfs|ENOENT[\s\S]*pglite\.data/i.test(message)) return 'bunfs';
  // #2348: a corrupted PGLite data dir (two OS processes opened it concurrently
  // and trashed the catalog/extension state) surfaces as a 58P01 internal error
  // loading the pgvector library, or the vector type / a core relation gone
  // missing. Distinct, actionable cause — must beat the generic wasm-runtime
  // match below so the user is pointed at recovery, not the macOS WASM bug.
  if (/58P01|internal_load_library|type "?vector"? does not exist|relation "?content_chunks"? does not exist/i.test(message)) {
    return 'corrupt';
  }
  // Broadened (v0.42.x WAL-repair wave): the REAL production message is
  // `Aborted(). Build with -sASSERTIONS for more info.` — no "runtime" in it,
  // so the legacy arms alone let the primary crash fall through to 'unknown'.
  // Deliberately over-matches (RuntimeError/unreachable are generic WASM
  // traps); the repair path downstream is bounded by layout validation, the
  // reaped-lock gate, and restore-on-failure.
  if (/aborted\s*\(\)|RuntimeError|unreachable|abort.*runtime|macos.*26\.3|wasm.*runtime/i.test(message)) {
    return 'wasm-abort';
  }
  return 'unknown';
}

/**
 * What the auto-repair path did (or why it didn't run) for a `wasm-abort`
 * failure — folded into the user-facing error so the message never lies about
 * the state of the data dir. `'failed-not-restored'` is the arm that matters
 * most: repair ran, PGLite still failed, AND the automatic restore failed —
 * the dir is in a reset state and the user must restore from the backup.
 */
export interface PgliteInitRepairContext {
  repair:
    | 'not-attempted'
    | 'in-memory'
    | 'disabled'
    | 'skipped-validation'
    | 'skipped-live-writer'
    | 'skipped-cooldown'
    | 'failed-restored'
    | 'failed-not-restored';
  backupPath?: string;
  detail?: string;
}

function repairContextLine(ctx: PgliteInitRepairContext): string {
  switch (ctx.repair) {
    case 'in-memory':
      return '  This engine is in-memory (no data dir), so there is no stored state to\n' +
        '  repair — this is an environment/runtime failure, not data corruption.';
    case 'disabled':
      return '  Auto-repair is disabled (GBRAIN_PGLITE_WAL_REPAIR=off). Run\n' +
        '  `gbrain pglite-repair` to repair manually.';
    case 'skipped-validation':
      return `  Auto-repair skipped: ${ctx.detail ?? 'the data dir did not validate as a PG17 pglite layout'}.`;
    case 'skipped-live-writer':
      return `  Auto-repair skipped: ${ctx.detail ?? 'the data-dir lock was acquired by reaping a prior holder'}`;
    case 'skipped-cooldown':
      return `  Auto-repair skipped: ${ctx.detail ?? 'a recent attempt failed (cooldown active)'}`;
    case 'failed-restored':
      return '  Auto-repair ran but PGLite still failed to start. The data dir was\n' +
        `  RESTORED to its pre-repair state (backup kept at ${ctx.backupPath ?? '<dataDir>.wal-repair-backup-*'}).` +
        (ctx.detail ? `\n  Detail: ${ctx.detail}` : '');
    case 'failed-not-restored':
      return '  Auto-repair ran, PGLite still failed to start, AND the automatic restore\n' +
        '  itself failed — the data dir is currently in a RESET state. Your\n' +
        `  pre-repair files are intact in the backup at ${ctx.backupPath ?? '<dataDir>.wal-repair-backup-*'};\n` +
        '  restore manually: move the backup\'s `pg_wal` dir back to `<dataDir>/pg_wal`\n' +
        '  and its `pg_control` file back to `<dataDir>/global/pg_control`.' +
        (ctx.detail ? `\n  Detail: ${ctx.detail}` : '');
    case 'not-attempted':
    default:
      return '  Auto-repair was not attempted.';
  }
}

export function buildPgliteInitErrorMessage(
  verdict: PgliteInitFailure,
  original: string,
  // #2674: threaded (defaulted) so tests can exercise both branches without
  // monkey-patching process.platform.
  platform: NodeJS.Platform = process.platform,
  // WAL-repair wave: what auto-repair did for a wasm-abort, so the hint tells
  // the truth about the current state of the data dir.
  ctx?: PgliteInitRepairContext,
): string {
  const header = 'PGLite failed to initialize its WASM runtime.';
  let hint: string;
  switch (verdict) {
    case 'bunfs':
      hint =
        '  This looks like a Bun vfs issue: `/$$bunfs/root` is read-only on\n' +
        '  your system, so PGLite cannot extract its pglite.data WASM payload.\n' +
        '  Fix: `bun upgrade` (newer Bun mounts the vfs writable). If that\n' +
        '  does not help, run via Node: `node src/cli.ts` or install gbrain\n' +
        '  using the Node-based path. See #1340 for details.';
      break;
    case 'wasm-abort':
      hint =
        '  Most common cause: corrupt WAL/checkpoint state after an unclean\n' +
        '  shutdown (often a macOS-upgrade reboot killing gbrain mid-write) —\n' +
        '  NOT a macOS WASM bug, despite the historical diagnosis in\n' +
        '  https://github.com/garrytan/gbrain/issues/223.\n' +
        repairContextLine(ctx ?? { repair: 'not-attempted' }) + '\n' +
        '  Recovery ladder:\n' +
        '    1. gbrain pglite-repair --dry-run   (diagnose, mutates nothing; prints the\n' +
        '       in-place WAL repair command to run once the user agrees, data preserved)\n' +
        '    2. Last resort, only with the user\'s agreement: `gbrain reinit-pglite`\n' +
        '       (rebuilds from the brain repo; DB-only pages and facts are not carried over).\n' +
        '    3. Switch engines (docs/ENGINES.md): `gbrain init --supabase` or\n' +
        '       native Postgres.\n' +
        '  Run `gbrain doctor` for a full diagnosis.';
      break;
    case 'corrupt':
      hint =
        '  Your PGLite store looks corrupted (the catalog or the pgvector\n' +
        '  extension cannot load). This happens when two processes opened the\n' +
        '  same brain at once — now prevented (#2348), but an already-damaged\n' +
        '  store cannot be repaired in place (WAL repair does not fix catalog\n' +
        '  corruption; `gbrain pglite-repair --dry-run` can still report the\n' +
        '  state of the data dir). Recover:\n' +
        '    1. Restore a backup of the brain.pglite directory if you have one, OR\n' +
        '    2. Rebuild from your brain repo:\n' +
        '       gbrain reinit-pglite --embedding-model <id> --embedding-dimensions <N>\n' +
        '       (wipes + re-inits + re-syncs; DB-only state is re-derived).\n' +
        '  Deleting .gbrain-lock/ or postmaster.pid does NOT fix this.';
      break;
    case 'unknown':
    default:
      // #2674: name the plausible causes per platform. The darwin branch keeps
      // the #223 pointer (readers arrive from that issue), reframed to the
      // real root cause behind those reports: torn WAL from unclean shutdown.
      hint = platform === 'darwin'
        ? '  Possible cause: corrupt WAL/checkpoint state after an unclean\n' +
          '  shutdown — the failure class behind\n' +
          '  https://github.com/garrytan/gbrain/issues/223.\n' +
          '  Try `gbrain pglite-repair --dry-run` to diagnose the data dir, and\n' +
          '  run `gbrain doctor` for a full diagnosis.'
        : '  Possible causes: another gbrain process holding the database\n' +
          '  (lock contention), or a damaged PGLite data directory.\n' +
          '  Try `gbrain pglite-repair --dry-run` to diagnose the data dir, and\n' +
          '  run `gbrain doctor` for a full diagnosis; if the data dir is\n' +
          '  damaged, `gbrain reinit-pglite` rebuilds it from your brain repo.';
      break;
  }
  return `${header}\n${hint}\n  Original error: ${original}`;
}

/**
 * The loud stderr notice printed when connect() auto-repaired the data dir in
 * place. Exported for the serial regression test.
 */
export function buildWalRepairNotice(receipt: WalRepairReceipt): string {
  return [
    '⚠️  gbrain repaired this brain\'s PGLite WAL in place.',
    `    Data dir: ${receipt.dataDir}`,
    `    Cause: torn WAL/checkpoint state from an unclean shutdown (issue #223 class).`,
    `    Transactions not checkpointed before the corruption may be lost, and`,
    `    indexes are not rebuilt: pages written just before the crash can be`,
    `    missing from vector search while keyword search still finds them.`,
    `    Pre-repair backup: ${receipt.backupPath}`,
    `    Next: rebuild the vector indexes with \`gbrain reindex --vectors\`,`,
    `    then run \`gbrain doctor\` to verify brain integrity.`,
    `    Disable auto-repair with GBRAIN_PGLITE_WAL_REPAIR=off.`,
  ].join('\n');
}

/**
 * #2084 — PGLite's Emscripten runtime hijacks `process.exitCode` as ITS status
 * channel: instantiation REPLACES the property with an accessor whose getter
 * falls back to the WASM runtime status (99 while alive, the exit status after
 * close) whenever no explicit value was assigned — and assigning `undefined`
 * resets to that fallback, so "unset" cannot be restored. Pre-fix, every clean
 * PGLite run carried a bogus 99 until close zeroed it, and an errored op's
 * exit 1 survived only by accident of write ordering.
 *
 * Containment: around PGlite.create(), snapshot the pre-call value and restore
 * it — pinning an explicit 0 when nothing was set, because restoring
 * `undefined` would surface the WASM fallback instead. This keeps the GLOBAL
 * tidy for external readers; the CLI's own verdict never reads it (it lives in
 * the owned channel: setCliExitVerdict/currentExitCode, cli-force-exit.ts —
 * in-memory brains run initdb whose status lands on a later tick, past any
 * snapshot). db.close() stays unwrapped (see the comment at the close site).
 */
async function preservingProcessExitCode<T>(fn: () => Promise<T>): Promise<T> {
  const pre = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = typeof pre === 'number' || typeof pre === 'string' ? pre : 0;
  }
}

/**
 * #2674 — the scratch-store probe, the diagnostic half of the issue.
 *
 * PGLite reports only `Aborted()` to JS and prints the real PANIC (e.g.
 * `could not locate a valid checkpoint record`) to its own stderr, so from
 * the JS-visible error alone a damaged store is indistinguishable from a
 * broken WASM runtime. The one thing that CAN tell them apart is opening a
 * throwaway store on the same machine:
 *
 *   - scratch store works → the runtime is healthy; the REAL store is damaged.
 *   - scratch store fails too → the runtime cannot start here at all.
 *
 * Stderr capture: PGLite 0.4.3 exposes no print/printErr hook on
 * `PGliteOptions` (checked: only `debug`, which still writes to the
 * process's own stderr), so we deliberately do NOT try to intercept the
 * PANIC text — monkey-patching process.stderr.write around an async WASM
 * init is exactly the hack the classifier comments warn against. The
 * probe's ok/fail outcome carries the diagnosis instead; `verdict` is
 * populated from the JS-visible error for callers that want it.
 *
 * Runs the SAME code path as the real engine (PGlite.create with the
 * embedded WASM/extension assets) but deliberately NOT PGLiteEngine.connect():
 * connect wraps failures in buildPgliteInitErrorMessage, whose hint text
 * would then pollute re-classification of the probe error.
 *
 * Safety: the scratch dir comes from mkdtemp under os.tmpdir() and is
 * additionally checked against `realStorePath` (refuses any overlap in
 * either direction) — a bug here must never touch the brain being
 * diagnosed. The dir is removed in a finally, success or failure.
 */
export interface PgliteScratchProbeResult {
  ok: boolean;
  duration_ms: number;
  /** JS-visible error when ok=false (the PANIC itself lands on stderr, not here). */
  error?: string;
  verdict?: PgliteInitFailure;
}

export async function probePgliteScratchStore(
  realStorePath?: string,
): Promise<PgliteScratchProbeResult> {
  const scratchDir = await mkdtemp(joinPath(tmpdir(), 'gbrain-pglite-probe-'));
  if (realStorePath) {
    const real = resolvePath(realStorePath);
    const scratch = resolvePath(scratchDir);
    if (scratch === real || scratch.startsWith(real + pathSep) || real.startsWith(scratch + pathSep)) {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `refusing to probe: scratch dir ${scratch} overlaps the real store ${real}`,
      );
    }
  }

  const started = Date.now();
  let db: PGlite | null = null;
  try {
    // Same assets as the real engine's connect(): the embedded WASM/fsBundle/
    // extension options (Bun vfs #1340) — a compiled binary's probe must
    // exercise the same runtime path the real store open uses.
    const embedded = await getEmbeddedPgliteOptions();
    db = await preservingProcessExitCode(() =>
      PGlite.create({
        dataDir: joinPath(scratchDir, 'store'),
        ...embedded,
      }),
    );
    await db.query(`CREATE TABLE scratch_probe (id int PRIMARY KEY, note text)`);
    await db.query(`INSERT INTO scratch_probe VALUES (1, 'ok')`);
    const res = await db.query<{ note: string }>(`SELECT note FROM scratch_probe WHERE id = 1`);
    if (res.rows[0]?.note !== 'ok') {
      throw new Error(`scratch store read-back mismatch: ${JSON.stringify(res.rows)}`);
    }
    return { ok: true, duration_ms: Date.now() - started };
  } catch (err) {
    const message = stringifyPgliteInitError(err);
    return {
      ok: false,
      duration_ms: Date.now() - started,
      error: message,
      verdict: classifyPgliteInitError(message),
    };
  } finally {
    if (db) {
      try { await db.close(); } catch { /* probe store — nothing to save */ }
    }
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class PGLiteEngine implements BrainEngine {
  readonly [ENGINE_ROOT]: object = this;
  private vectorIterativeScan?: Promise<boolean>;
  private readonly vectorScope = vectorScopeLoader(() => this.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL), ids => this.executeRaw<ScopeChunkCount>(SCOPE_CHUNKS_SQL, [ids]));
  /** Transaction clones keep chunk invalidation and replacement atomic. */
  private _chunkWritesInTransaction = false;
  private _checkpointGuard: PgliteCheckpointGuard | undefined;
  readonly kind = 'pglite' as const;
  readonly capabilities: EngineCapabilities = capabilitiesForEngineKind('pglite');
  private _db: PGLiteDB | null = null;
  private _lock: LockHandle | null = null;
  /** Graduation custody: a kernel lock this process already holds, adopted by the next open instead of acquired. */
  private _adoptedLock: LockHandle | null = null;
  private _dbWork: ReturnType<typeof trackPgliteDatabase<PGLiteDB>> | null = null;
  private _connectPromise: Promise<void> | null = null;
  private _closingWork: Promise<void> | null = null;
  private _disconnectCall: Promise<void> | null = null;
  private _disconnectRequested = false;
  private _closePoison: Error | null = null;
  private readonly _beforeDisconnect = new Set<() => Promise<void>>();

  /** Mandatory resident-consumer stop barrier; runs while the datastore is usable. */
  registerBeforeDisconnect(stop: () => Promise<void>): () => void {
    this._beforeDisconnect.add(stop);
    return () => { this._beforeDisconnect.delete(stop); };
  }

  private _attachDatabase(database: PGLiteDB): PGLiteDB {
    this._statements = new PgliteStatementCache(database);
    this._dbWork = trackPgliteDatabase(this._statements.attach(database, false));
    this._checkpointGuard = undefined;
    return this._dbWork.database;
  }
  private _statements: PgliteStatementCache | null = null;
  // #2034: captured at connect() so reconnect() can restore the same data dir
  // after a drop, matching PostgresEngine's _savedConfig contract.
  private _savedConfig: EngineConfig | null = null;
  // Tier 3: when GBRAIN_PGLITE_SNAPSHOT loaded a post-initSchema state into
  // PGlite.create(loadDataDir), initSchema is a no-op (schema is already
  // present + migrations already applied). Saves ~1-3s per fresh test PGLite.
  private _snapshotLoaded = false;
  /**
   * Set when connect() auto-repaired the data dir's WAL in place (mirrors
   * upstream PR #994's `repairedDataDir`). Null on every non-repaired connect.
   * Test seam + programmatic callers can surface the receipt.
   */
  walRepairReceipt: WalRepairReceipt | null = null;

  /** #9227: whether this engine has its datastore open under the lock that admits one process (always true for an open in-memory store). */
  holdsDatastoreLock(): boolean {
    return this._db !== null && this._lock?.acquired === true;
  }

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
  }

  /**
   * Engine-sql executor over the CURRENT handle (EO1): a fresh adapter on
   * every access, never stored, so a transaction clone (whose `db` getter
   * returns the tx handle) runs migrated domain SQL inside its transaction.
   */
  private get engineSql(): SqlExecutor {
    return pgliteExecutor(this._pageTransaction || this._dbWork === null ? this.db : guardedHandle(this.db, this._checkpointGuard ??= new PgliteCheckpointGuard()));
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    return this._connectWithRootRegistration(config, true);
  }

  async connectForRestore(config: EngineConfig): Promise<void> {
    if (!config.database_path || this._db || this._connectPromise) throw new Error('Restore staging requires a fresh engine and an explicit datastore path');
    return this._connectWithRootRegistration(config, false);
  }

  private async _connectWithRootRegistration(config: EngineConfig, registerRoots: boolean): Promise<void> {
    if (this._disconnectRequested || this._closingWork || this._closePoison) throw this._closePoison ?? new PgliteClosingError();
    if (this._db || this._connectPromise) {
      if ((this._savedConfig?.database_path || undefined) !== (config.database_path || undefined)) {
        throw new Error('PGLite engine is already connected or connecting to another datastore');
      }
      return this._connectPromise ?? undefined;
    }
    this.vectorIterativeScan = undefined;
    const opening = this._connectInternal(config).then(async () => {
      try {
        await configurePgliteCodecs(this.db);
        if (registerRoots) await registerManagedFilesystemEngine(this, config.database_path);
      }
      catch (error) {
        try { await this._closeInternal({ retainLock: this._lock !== null && this._lock === this._adoptedLock }); }
        catch (closeError) {
          this._closePoison = new PgliteClosingError(`PGLite registry failure cleanup did not close; lock retained: ${String(closeError)}`);
          throw this._closePoison;
        }
        throw error;
      }
      notifyPgliteOpened(this, config.database_path);
    });
    this._connectPromise = opening;
    try { await opening; }
    catch (error) {
      if (!this._db && !this._closePoison && this._lock?.acquired) {
        if (this._lock !== this._adoptedLock) await releaseLock(this._lock);
        this._lock = null;
      }
      throw error;
    }
    finally {
      if (this._connectPromise === opening) this._connectPromise = null;
      this._adoptedLock = null;
    }
  }

  /**
   * Engine graduation: open a persistent datastore under a kernel lock this
   * process already holds (the rollback move-back), so ownership never gaps.
   * A failed open hands the lock back to the caller unreleased.
   */
  async connectWithHeldLock(config: EngineConfig, lock: LockHandle): Promise<void> {
    if (!config.database_path || !lock.acquired) throw new Error('A held-lock open needs a persistent datastore and its held kernel lock');
    if (lock.lockDir !== pgliteLockDirFor(config.database_path)) throw new Error('The held kernel lock does not belong to this datastore');
    if (this._db || this._connectPromise) throw new Error('PGLite engine is already connected or connecting');
    this._adoptedLock = lock;
    return this._connectWithRootRegistration(config, true);
  }

  /**
   * Engine graduation: drain admitted statements, checkpoint and close the
   * database, then hand the kernel lock back to the caller instead of
   * releasing it. The caller owns the handle (move-aside, then releaseLock).
   * Call the engine's ordinary disconnect afterwards to drop its wrappers.
   */
  async closeRetainingLock(): Promise<LockHandle> {
    if (this._closePoison) throw this._closePoison;
    if (this._disconnectCall || this._closingWork || this._connectPromise) throw new PgliteClosingError();
    const lock = this._lock;
    if (!this._db || !lock?.acquired || !this._savedConfig?.database_path) {
      throw new Error('closeRetainingLock needs an open persistent datastore that holds its kernel lock');
    }
    this.vectorIterativeScan = undefined;
    this._disconnectRequested = true;
    const work = this._closeInternal({ retainLock: true });
    this._closingWork = work;
    try { await work; }
    catch (error) {
      this._closePoison = new PgliteClosingError(`PGLite shutdown failed; datastore ownership is retained until process exit: ${String(error)}`);
      this._db = null;
      throw this._closePoison;
    }
    finally { this._closingWork = null; this._disconnectRequested = false; }
    return lock;
  }

  private async _connectInternal(config: EngineConfig): Promise<void> {
    this._snapshotLoaded = false;
    this._savedConfig = config; // #2034: remember for reconnect()
    this.walRepairReceipt = null; // per-connect: stale receipts must not survive reconnect()
    const dataDir = config.database_path || undefined; // undefined = in-memory

    // Automatic repair failed earlier: never open (lock + create write the data dir); refuse with the consented repair.
    const failedRepair = dataDir ? readRepairFailedMarker(dataDir) : null;
    if (dataDir && failedRepair) throw (await import('./pglite-repair-consent.ts')).repairFailedRefusal(dataDir, failedRepair); // engine-dynamic-import-ok: refusal path only, keeps the consent graph off every open

    // Engine graduation: a tombstone, a stray datastore or a live run stops the open before the lock.
    if (dataDir) assertPgliteGraduationOpenable(dataDir, 'pre_lock');
    // Acquire file lock to prevent concurrent PGLite access (crashes with Aborted())
    this._lock = this._adoptedLock ?? await acquireLock(dataDir);

    if (!this._lock.acquired) {
      throw new Error('Could not acquire PGLite lock. Another gbrain process is using the database.');
    }
    if (dataDir && this._lock !== this._adoptedLock) {
      try { assertPgliteGraduationOpenable(dataDir, 'locked'); }
      catch (error) { await releaseLock(this._lock); this._lock = null; throw error; }
    }

    // Tier 3: optional snapshot fast-restore. Only applies to in-memory
    // engines (no persistent dataDir). The snapshot was built from a fresh
    // `initSchema()` run; if the version file matches the current MIGRATIONS
    // hash, load the dump and skip the schema replay. Mismatch or missing
    // file silently falls back to normal init.
    let loadDataDir: Blob | undefined;
    if (!dataDir && process.env.GBRAIN_PGLITE_SNAPSHOT && !isEmbeddedEngine(this)) {
      const snapshotResult = tryLoadSnapshot(process.env.GBRAIN_PGLITE_SNAPSHOT);
      if (snapshotResult) {
        loadDataDir = snapshotResult;
        this._snapshotLoaded = true;
      }
    }

    // NOTE (#2084): PGLite's Emscripten runtime writes the WASM backend's
    // proc_exit status into `process.exitCode` (initdb here at create-time,
    // the postmaster at close-time), and the writes land asynchronously —
    // a snapshot/restore around these awaits does NOT contain them. That is
    // why the CLI's exit paths read gbrain's own verdict
    // (cli-force-exit.ts currentExitCode), never ambient process.exitCode.
    // Embedded WASM/fsBundle/extension assets (Bun vfs #1340). Resolved once
    // here so both the initial create and the WAL-repair retry below share the
    // same compiled modules. Its `extensions` replaces the stock vector/pg_trgm.
    const embedded = withSharedBuffers(await getEmbeddedPgliteOptions(), config.pglite_shared_buffers);
    try {
      this._db = this._attachDatabase(await preservingProcessExitCode(() =>
        PGlite.create({
          dataDir,
          loadDataDir,
          ...embedded,
        }),
      ));
      // Snapshot parity: dumpDataDir bakes the BUILD process's TimeZone into
      // the cluster defaults (date-dependent tests failed only in the evening,
      // only under the snapshot) and the BUILD time into the seeded sources'
      // created_at (a CI-cached snapshot over an hour old made every fresh
      // test brain fail the behavior_changes fresh-install grace, which reads
      // MIN(sources.created_at)). Pin the RUNTIME zone and stamp now(), so
      // restored engines behave like cold ones (bun test pins TZ=UTC).
      if (this._snapshotLoaded && this._db) {
        const runtimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        await this._db.query(`SELECT set_config('TimeZone', $1, false)`, [runtimeZone]);
        await this._db.query(`UPDATE sources SET created_at = now()`);
      }
      // Healthy open: close any repair episode left open by a prior failed
      // attempt (red-team: episodes otherwise stayed open forever — doctor
      // kept reporting corruption-likely and a weeks-stale episode backup
      // could be reused over much newer data). Cheap no-op without a sidecar.
      if (dataDir) closeRepairEpisodeIfOpen(dataDir);
    } catch (err) {
      // v0.13.1: any PGLite.create() failure becomes actionable. v0.41.8.0
      // (#1340): the previous error hint hardcoded the macOS 26.3 link, but
      // the same crash shape can come from Bun's vfs (`/$$bunfs/root` is
      // read-only on older macOS + Bun 1.3.x, so PGLite can't extract its
      // pglite.data WASM payload). Route the hint by failure shape so
      // users get the right next step.
      const original = stringifyPgliteInitError(err); // #2674
      const verdict = classifyPgliteInitError(original);
      let ctx: PgliteInitRepairContext = { repair: 'not-attempted' };
      let retryError: string | undefined;

      if (!dataDir && !this._db) {
        let retried: PGLiteDB | null = null;
        try {
          retried = await preservingProcessExitCode(() => PGlite.create({ ...embedded }));
        } catch (error) {
          retryError = stringifyPgliteInitError(error);
        }
        if (retried) {
          this._db = this._attachDatabase(retried);
          this._snapshotLoaded = false;
          console.warn(`[pglite] in-memory init failed and was retried cold — recovered. First error: ${original}`);
          return;
        }
      }

      // WAL-repair wave (#223/#1670/#2575): a wasm-abort on a PERSISTENT data
      // dir is almost always torn WAL/checkpoint state from an unclean
      // shutdown — repairable in place. The seam NEVER throws (its failure
      // modes fold into `ctx`), so every non-repaired path still funnels
      // through the single lock-release-then-throw site below.
      if (verdict === 'wasm-abort') {
        if (!dataDir) {
          ctx = { repair: 'in-memory' };
        } else {
          const attempt = await attemptWalRepairAndRetry(
            dataDir,
            () => preservingProcessExitCode(() =>
              // No loadDataDir on the retry: the snapshot path is
              // in-memory-only (see above), and dataDir is persistent here.
              PGlite.create({
                dataDir,
                ...embedded,
              }),
            ),
            { reaped: this._lock?.reaped },
          );
          if (attempt.status === 'repaired') {
            this._db = this._attachDatabase(attempt.db);
            this.walRepairReceipt = attempt.receipt;
            console.warn(buildWalRepairNotice(attempt.receipt));
            return; // success: lock stays held, normal connect contract
          }
          if (attempt.status === 'skipped') {
            const reasonToCtx = {
              'disabled': 'disabled',
              'validation-failed': 'skipped-validation',
              'possibly-live-writer': 'skipped-live-writer',
              'recently-failed': 'skipped-cooldown',
            } as const;
            ctx = { repair: reasonToCtx[attempt.reason], detail: attempt.detail };
          } else {
            ctx = {
              repair: attempt.restored ? 'failed-restored' : 'failed-not-restored',
              backupPath: attempt.receipt?.backupPath,
              detail: attempt.repairError,
            };
          }
        }
      }

      const wrapped = new Error(buildPgliteInitErrorMessage(verdict, original, process.platform, ctx) +
        (retryError === undefined ? '' : `\n  Cold retry error: ${retryError}`));
      const repairFailed = dataDir ? recordFailedAutoRepair(dataDir, ctx.repair, ctx.backupPath, original) : null;
      if (this._db) {
        try { await this._closeInternal({ retainLock: this._lock !== null && this._lock === this._adoptedLock }); }
        catch (closeError) {
          this._db = null;
          this._closePoison = new PgliteClosingError(`PGLite initialization cleanup failed; lock retained: ${String(closeError)}`);
          throw this._closePoison;
        }
      } else if (this._lock?.acquired) {
        if (this._lock !== this._adoptedLock) await releaseLock(this._lock);
        this._lock = null;
      }
      if (dataDir && repairFailed) throw (await import('./pglite-repair-consent.ts')).repairFailedRefusal(dataDir, repairFailed, original, wrapped.message); // engine-dynamic-import-ok: refusal path only
      throw wrapped;
    }
  }

  async disconnect(): Promise<void> {
    this.vectorIterativeScan = undefined;
    if (this._disconnectCall) return this._disconnectCall;
    if (this._closePoison) throw this._closePoison;
    this._disconnectRequested = true;
    if (this._connectPromise) {
      try { await this._connectPromise; } catch { /* failed open already cleans its lock */ }
      if (this._disconnectCall) return this._disconnectCall;
    }
    if (!this._db && !this._lock) { this._disconnectRequested = false; return; }
    const work = this._closeInternal();
    this._closingWork = work;
    // Keep the actual close alive after a caller's deadline. The engine and
    // opaque native handle remain strongly retained until it succeeds.
    void work.then(() => {
      this._closingWork = null;
      this._disconnectCall = null;
      this._disconnectRequested = false;
    }, error => {
      this._closePoison = new PgliteClosingError(`PGLite shutdown failed; datastore ownership is retained until process exit: ${String(error)}`);
      this._db = null;
    });
    const call = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new PgliteClosingError();
            warnOncePerProcess('pglite-close-timeout', `[pglite] close exceeded ${pgliteCloseTimeoutMs()}ms; the kernel lock remains held. Await shutdown or terminate this process before reopening the datastore.`);
            reject(error);
          }, pgliteCloseTimeoutMs());
        })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    this._disconnectCall = call;
    return call;
  }

  private async _closeInternal(opts: { retainLock?: boolean } = {}): Promise<void> {
    const db = this._db;
    const lock = this._lock;
    const work = this._dbWork;
    let watchdog: { dispose(): void } | null = null;
    if (db) {
      const { deadlineMs, graceMs } = pgliteCloseWatchdogMs();
      if (deadlineMs > 0) {
        watchdog = installProcessWatchdog({ deadlineMs, graceMs, label: 'pglite-disconnect-watchdog' });
        warnOncePerProcess(`pglite-close-watchdog-armed:${deadlineMs}:${graceMs}`,
          `[pglite] disconnect watchdog armed: SIGTERM at ${deadlineMs}ms, SIGKILL at ${deadlineMs + graceMs}ms (out-of-band worker thread).`);
      }
    }
    try {
      // Persistence consumers are a mandatory barrier. Best-effort telemetry
      // deadlines never authorize releasing datastore ownership.
      for (const stop of this._beforeDisconnect) await stop();
      this._db = null;
      await work?.stopAndDrain();
      await drainBackgroundWorkBeforeDisconnect();
      if (db) {
        // Do not abandon a CHECKPOINT and start close concurrently. A failed
        // settled checkpoint can still be recovered by a successful close.
        try { await work?.checkpoint(); }
        catch (error) { warnOncePerProcess('pglite-checkpoint-failed', `[pglite] checkpoint failed; retaining ownership through close: ${String(error)}`); }
        await db.close();
      }
      if (lock?.acquired && !opts.retainLock) await releaseLock(lock);
      this._lock = null;
      this._dbWork = null;
      this._statements = null;
    } finally {
      // A slow close keeps the watchdog armed until it actually settles. On a
      // failed close the lock is retained; callers must terminate the process.
      watchdog?.dispose();
    }
  }

  /**
   * #2034: engine-parity reconnect. PGLite is single-writer in-process so it
   * doesn't suffer the pool-drop class PostgresEngine.reconnect() handles, but
   * the method MUST exist so callers (autopilot health probe, worker/queue
   * claim-error recovery) can call `engine.reconnect()` uniformly.
   *
   * IN-MEMORY (no `database_path`) is a NO-OP: there is no persistent backing,
   * the connection can't recoverably "drop" in-process, and a disconnect+reopen
   * would DISCARD all state. This matches the long-standing assumption the
   * worker/queue recovery paths are written against ("PGLite has no pooler
   * reaping so reconnect is absent" — src/core/minions/queue.ts). A FILE-backed
   * engine genuinely re-opens the same data dir (state persists on disk).
   */
  async reconnect(_ctx?: { error?: unknown }): Promise<void> {
    if (!this._savedConfig) return; // never connected — nothing to restore
    if (!this._savedConfig.database_path) return; // in-memory — no-op, preserve state
    const config = this._savedConfig;
    await this.disconnect();
    await this.connect(config);
  }

  async initSchema(): Promise<void> {
    // Tier 3: snapshot was loaded into PGlite — schema + migrations already
    // applied. Only record the schema version, as a cold init does.
    if (this._snapshotLoaded) return noteSchemaVersion(this, parseInt(await this.getConfig('version') ?? '', 10));
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
    } catch { /* gateway not configured — use defaults */ }

    const storedIdentity = await readStoredEmbeddingIdentity(this);
    if (storedIdentity) {
      if (!storedIdentity.model) throw new Error('Stored embedding model is unknown. Run gbrain migrate embeddings --status and explicitly migrate before schema initialization.');
      if (embedded) assertEmbeddedEmbedding(embedded, storedIdentity);
      dims = storedIdentity.dimensions;
      model = storedIdentity.model;
    }
    const { runMigrations, withSchemaMigrationLock, registeredLatestVersion } = await import('./migrate.ts'); // engine-dynamic-import-ok: initSchema only, keeps the ~220 migration modules off every connect
    await withSchemaMigrationLock(this, async () => {
      await assertSchemaNotAhead(async (q) => (await this.db.query<Record<string, unknown>>(q)).rows, registeredLatestVersion()); // #7776
      await this.applyForwardReferenceBootstrap();
      await this.db.exec(getPGLiteSchema(dims, model));

      const { applied } = await runMigrations(this);
      if (applied > 0) {
        process.stderr.write(`  ${applied} migration(s) applied\n`);
      }
    });
    await registerManagedFilesystemEngine(this, this._savedConfig?.database_path);
  }

  /**
   * Forward-reference bootstrap before PGLITE_SCHEMA_SQL replay; the single
   * implementation lives in `engine-sql/bootstrap.ts` (E1).
   */
  private async applyForwardReferenceBootstrap(): Promise<void> {
    await applyForwardReferenceBootstrap(pgliteBootstrapTarget(this.db));
  }

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    // PGLite has no connection pool. The single backing connection is
    // always effectively reserved — pass it through.
    const db = this.db;
    const conn: ReservedConnection = {
      async executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> {
        const { rows } = await db.query(sql, params);
        return rows as R[];
      },
    };
    return fn(conn);
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (opts?.signal?.aborted) throw transactionAborted(opts.signal);
    const run = (db = this.db) => withHeldPageKeys(this._pageTransaction ? this._heldPageKeys : null, held => db.transaction(async handle => {
      const tx = composablePgliteTransaction(this._statements?.attach(handle, true) ?? handle);
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, '_chunkWritesInTransaction', { value: true });
      Object.defineProperty(txEngine, '_pageTransaction', { value: true });
      Object.defineProperty(txEngine, '_heldPageKeys', { value: held });
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    }));
    if (this._pageTransaction || !this._dbWork) return run();
    const guard = this._checkpointGuard ??= new PgliteCheckpointGuard();
    return this._dbWork.admit(db => guard.runOutermost(sql => db.query(sql), () => run(db)));
  }

  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.transaction(fn, opts);
  }

  // Pages CRUD
  async getPage(slug: string, opts?: PageSnapshotOptions): Promise<Page | null> {
    return (await this.readPageSnapshot(slug, opts))?.page ?? null;
  }

  async readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
    return readCanonicalPageSnapshot(this.executeRaw.bind(this), slug, opts);
  }

  async readPageSnapshotsBatch(refs: ReadonlyArray<{ slug: string; sourceId: string }>, opts?: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean }) {
    return readPageSnapshotsBatch(this.executeRaw.bind(this), refs, opts);
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
    return pagesImpl.findDuplicatePage(scopedRead(this.engineSql), sourceId, opts);
  }
  async findDuplicatePages(sourceId: string, inputs: Parameters<typeof pagesImpl.findDuplicatePages>[2]) { return pagesImpl.findDuplicatePages(scopedRead(this.engineSql), sourceId, inputs); }

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
      return pagesImpl.putPage((tx as PGLiteEngine).engineSql, slug, page, opts, (s, src) => tx.getPage(s, { sourceId: src })).catch(error => { throw classifyOriginUniqueViolation(error) ?? error; });
    };
    return opts?.inline && this._pageTransaction ? write(this) : this.transaction(write);
  }

  async deletePage(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return pagesImpl.deletePage(this.engineSql, slug, opts);
  }

  /**
   * v0.41.19.0 — batch delete primitive. See BrainEngine.deletePages JSDoc.
   * Parity implementation with PostgresEngine.deletePages. PGLite supports
   * `slug = ANY($1)` array-param binding natively (addLinksBatch already
   * proves this).
   */
  async deletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    return pagesImpl.deletePages(this.engineSql, slugs, opts);
  }

  /**
   * v0.41.19.0 — batch path → slug resolution. See BrainEngine.resolveSlugsByPaths
   * JSDoc.
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
   * JSDoc. Parity implementation with PostgresEngine.softDeletePages:
   * deletePages' shape (empty-array early-return, batch-size throw,
   * RETURNING slug) with softDeletePage's `deleted_at IS NULL` idempotency
   * predicate. Nothing cascades — the 72h purge phase owns the eventual
   * hard delete. PGLite binds `slug = ANY($1)` array params natively
   * (deletePages already proves this).
   */
  async softDeletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    return pagesImpl.softDeletePages(this.engineSql, slugs, opts);
  }

  async restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    return this.transaction(async tx => { await assertRevivalUnclaimed(tx, slug, opts?.sourceId); return pagesImpl.restorePage((tx as PGLiteEngine).engineSql, slug, opts); });
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
    // Parity with PostgresEngine.migrateFactsToCanonical: only entity_slug, source_markdown_slug and row_num change
    // (row_num offset past canonical's MAX(row_num), #4558; NULL stays NULL, expired rows count — see the Postgres twin),
    // on active rows only (expired_at IS NULL) so the supersession audit trail stays. B-10: first drop an observation
    // the canonical page already holds, which would collide on idx_facts_ontology_stint_dedup.
    await dropPhantomMigrationDuplicates(this, sourceId, canonicalSlug, phantomSlug);
    const { rows } = await this.db.query(
      `UPDATE facts
         SET entity_slug = $1,
             source_markdown_slug = $1,
             row_num = facts.row_num + COALESCE((
               SELECT MAX(f2.row_num) FROM facts f2
               WHERE f2.source_id = $2
                 AND f2.source_markdown_slug = $1
                 AND f2.row_num IS NOT NULL
             ), 0)
       WHERE source_id = $2
         AND source_markdown_slug = $3
         AND expired_at IS NULL
       RETURNING id`,
      [canonicalSlug, sourceId, phantomSlug],
    );
    return { migrated: rows.length };
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    return plannerRead(this, this._pageTransaction, () => pagesImpl.listPages(scopedRead(this.engineSql), filters));
  }
  async findPages(query: FindPagesQuery): Promise<FoundPages> {
    return plannerRead(this, this._pageTransaction, () => pageLookupImpl.findPages(scopedRead(this.engineSql), query));
  }
  async countPagesBy(query: PageCountQuery, groupTypes?: TypeGrouper): Promise<PageCounts> {
    return plannerRead(this, this._pageTransaction, () => pageLookupImpl.countPagesBy(scopedRead(this.engineSql), query, groupTypes));
  }

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    return pagesImpl.getAllSlugs(scopedRead(this.engineSql), opts);
  }

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
    return this.transaction(tx => identityDecisionsImpl.applyIdentityDecisions((tx as PGLiteEngine).engineSql, input));
  }

  // Sources SQL lives once in ./engine-sql/sources.ts (refactor wave 1, W1-extended).
  async listAllSources(opts?: { includeArchived?: boolean; localPathOnly?: boolean }): Promise<SourceRow[]> {
    return sourcesImpl.listAllSources(unscopedExecutor(this.engineSql, 'sources: unscoped on master (EO4 inventory)'), opts);
  }

  async updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    return sourcesImpl.updateSourceConfig(this.engineSql, sourceId, patch);
  }

  // Import-path guard, attribution and config reads: SQL in engine-sql (persistence-state, transaction-settings, belief, config, access-control, sources).
  getSource(sourceId: string) { return sourcesImpl.getSource(unscopedExecutor(this.engineSql, 'sources: single-row read ran unscoped through executeRaw'), sourceId); }
  getConfigValues(keys: readonly string[]) { return configImpl.getConfigValues(unscopedExecutor(this.engineSql, 'config: keyed read ran unscoped through executeRaw'), keys); }
  readManagedModeRows() { return persistenceStateImpl.readManagedModeRows(unscopedExecutor(this.engineSql, 'persistence: managed-mode read ran unscoped through executeRaw')); }

  // Read-command statements (engine-sql/cli-reads-ops.ts), through executeRaw as before; PGLite has no statement deadline or JIT, so it ignores those bounds as it did.
  private get rawRead(): cliReadsOpsImpl.EngineRawRead { return (sql, params) => this.executeRaw(sql, params); }
  scanExactBatch(opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number) { return cliReadsOpsImpl.scanExactBatch(this.rawRead, opts, afterPageId, batchPages, timeoutMs); }
  nextLivePageAfter(afterPageId: number) { return cliReadsOpsImpl.nextLivePageAfter(this.rawRead, afterPageId); }
  listExportPageKeys(q: exportReadsImpl.ExportPageKeyQuery) { return exportReadsImpl.listExportPageKeys(this, q); }
  readExportWithdrawalLedgerBytes(sourceId: string) { return exportReadsImpl.readExportWithdrawalLedgerBytes(this, sourceId); }
  listExportWithdrawals(sourceId: string) { return exportReadsImpl.listExportWithdrawals(this, sourceId); }
  readExportPageRows(ids: readonly string[]) { return exportReadsImpl.readExportPageRows(this, ids); }
  normalizeFenceLines(bodies: readonly string[], timelines: readonly string[]) { return exportReadsImpl.normalizeFenceLines(this, bodies, timelines); }
  readSegmentedPageHead(pageId: number) { return exportReadsImpl.readSegmentedPageHead(this, pageId); }
  readBodyManifestRows(pageId: number, generation: number | null) { return exportReadsImpl.readBodyManifestRows(this, pageId, generation); }
  readBodyManifestMeta(pageId: number, occurrenceIds: readonly number[], generation: number) { return exportReadsImpl.readBodyManifestMeta(this, pageId, occurrenceIds, generation); }
  readBodyManifestOutline(pageId: number, occurrenceIds: readonly number[], generation: number) { return exportReadsImpl.readBodyManifestOutline(this, pageId, occurrenceIds, generation); }
  listForcedCutSeqs(pageId: number, generation: number) { return exportReadsImpl.listForcedCutSeqs(this, pageId, generation); }
  readManifestSeqAt(pageId: number, generation: number, byteOffset: number) { return exportReadsImpl.readManifestSeqAt(this, pageId, generation, byteOffset); }
  readSegmentedVersionBodyBytes(pageId: number, generation: number) { return exportReadsImpl.readSegmentedVersionBodyBytes(this, pageId, generation); }
  listAccessPolicySourceIds() { return exportReadsImpl.listAccessPolicySourceIds(this); }
  listExactIdentityCandidates(opts: ExactIdentityStatementOpts) { return cliReadsOpsImpl.listExactIdentityCandidates(this.rawRead, opts); }
  rankEntities(opts: RankEntitiesStatementOpts, timeoutMs: number) { return cliReadsOpsImpl.rankEntities(this.rawRead, opts, timeoutMs); }
  readRankCoverage(opts: RankCoverageStatementOpts, timeoutMs: number) { return cliReadsOpsImpl.readRankCoverage(this.rawRead, opts, timeoutMs); }
  readExactSnippetChunks(keys: readonly cliReadsOpsImpl.ExactSnippetKey[], opts: { excludePrivate: boolean }) { return cliReadsOpsImpl.readExactSnippetChunks(this.rawRead, keys, opts); }
  listExactRescanChunks(pageIds: readonly number[], opts: { excludePrivate: boolean }) { return cliReadsOpsImpl.listExactRescanChunks(this.rawRead, pageIds, opts); }
  listHeldFenceCells(keys: readonly cliReadsOpsImpl.HeldFenceCellKey[]) { return cliReadsOpsImpl.listHeldFenceCells(this.rawRead, keys); }
  readFenceOverlayRows(page: { sourceId: string; slug: string }, incoming: readonly cliReadsOpsImpl.FenceOverlayIncomingRow[], opts: { hideHeld: boolean }) { return cliReadsOpsImpl.readFenceOverlayRows(this.rawRead, page, incoming, opts); }
  listExtractionPendingPages(opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }) { return cliReadsOpsImpl.listExtractionPendingPages(this.rawRead, opts); }
  listUnattributedFacts(opts: { sourceIds: string[]; worldOnly: boolean; excludePrivateProvenance: boolean; limit: number; offset: number }) { return cliReadsOpsImpl.listUnattributedFacts(this.rawRead, opts); }
  listWantedPages(opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number }) { return cliReadsOpsImpl.listWantedPages(this.rawRead, opts); }

  // Facts statements, doctor checks (engine-sql/facts-doctor.ts), through executeRaw as before.
  listConversationFactRows(sourceIds: string[], limit: number) { return factsDoctorImpl.listConversationFactRows(this.rawRead, sourceIds, limit); }
  countRedactedFacts(sourceIds?: string[]) { return factsDoctorImpl.countRedactedFacts(this.rawRead, sourceIds); }
  listOutsideContentFenceCounts() { return factsDoctorImpl.listOutsideContentFenceCounts(this.rawRead); }
  countAtomFacts() { return factsDoctorImpl.countAtomFacts(this.rawRead); }
  listUnpreviewedTrustFacts(limit: number) { return factsDoctorImpl.listUnpreviewedTrustFacts(this.rawRead, limit); }
  countUnlinkedFactsByOrigin(opts: { sourceIds: string[]; auditSources: string[]; windowPerSource: number; hasAttempts: boolean }) { return factsDoctorImpl.countUnlinkedFactsByOrigin(this.rawRead, opts); }
  countUnlinkedFactStats(opts: { sourceIds: string[]; auditSources: string[]; hasAttempts: boolean }) { return factsDoctorImpl.countUnlinkedFactStats(this.rawRead, opts); }
  countFactRelinkOutcomes(sourceIds: string[]) { return factsDoctorImpl.countFactRelinkOutcomes(this.rawRead, sourceIds); }
  listUnlinkedConversationSlugs(opts: { sourceId: string; auditSources: string[]; windowPerSource: number; fix: factsDoctorImpl.ConversationFixKind; hasAttempts: boolean }) { return factsDoctorImpl.listUnlinkedConversationSlugs(this.rawRead, opts); }
  countFactEmbeddingCoverage(opts: { sourceId?: string | null; model: string; dims: number }) { return factsDoctorImpl.countFactEmbeddingCoverage(this.rawRead, opts); }
  countStaleFactEmbeddings(opts: { model: string; dims: number; sourceId?: string | null }) { return factsDoctorImpl.countStaleFactEmbeddings(this.rawRead, opts); }
  readChunkVectorColumn(column: string) { return embeddingCatalogImpl.readChunkVectorColumn(this.rawRead, column); }
  readEmbeddingIdentity() { return embeddingCatalogImpl.readEmbeddingIdentity(this.rawRead, () => this.getConfig('embedding_model')); }
  listEmbeddingStores() { return embeddingCatalogImpl.listEmbeddingStores(this.rawRead); }
  hasStoredVectors(store: embeddingCatalogImpl.EmbeddingStore) { return embeddingCatalogImpl.hasStoredVectors(this.rawRead, store); }
  countChunkVectorCoverage(column: embeddingCatalogImpl.FixedVectorColumn) { return embeddingCatalogImpl.countChunkVectorCoverage(this.rawRead, column); }
  upsertFactRelinkAttempt(sourceId: string, attempt: factRelinkImpl.FactRelinkAttempt, opts: factRelinkImpl.FactRelinkUpsertOpts = {}) { return factRelinkImpl.upsertFactRelinkAttempt(this.engineSql, sourceId, attempt, opts); }
  listFactRelinkOutcomes(sourceId: string, factIds: number[], outcomes: string[]) { return factRelinkImpl.listFactRelinkOutcomes(this.rawRead, sourceId, factIds, outcomes); }
  deleteFactRelinkMemos(sourceId: string, tier: string, targetSlug: string) { return factRelinkImpl.deleteFactRelinkMemos(this.engineSql, sourceId, tier, targetSlug); }
  placeRelinkedFact(sourceId: string, placement: factRelinkWritesImpl.RelinkPlacement) { return factRelinkWritesImpl.placeRelinkedFact(this.engineSql, sourceId, placement); }
  linkConversationFact(sourceId: string, link: factRelinkWritesImpl.ConversationFactLink) { return factRelinkWritesImpl.linkConversationFact(this.engineSql, sourceId, link); }
  listConversationRelinkPages(sourceId: string, q: factRelinkWritesImpl.ConversationRelinkPagesQuery) { return factRelinkWritesImpl.listConversationRelinkPages(this.rawRead, sourceId, q); }

  // Facts statements, command, cycle and fence reads (engine-sql/facts-cycle.ts), through executeRaw as before.
  listActiveFactsForEntity(sourceId: string, entitySlug: string, limit: number) { return factsCycleImpl.listActiveFactsForEntity(this.rawRead, sourceId, entitySlug, limit); }
  listFreshExtractionOutcomes(sourceId: string, slugs: string[], sources: string[], preferredSource: string) { return factsCycleImpl.listFreshExtractionOutcomes(this.rawRead, sourceId, slugs, sources, preferredSource); }
  listFenceRowGroups() { return factsCycleImpl.listFenceRowGroups(this.rawRead); }
  readFactSubject(id: number) { return factsCycleImpl.readFactSubject(this.rawRead, id); }
  listFactsForPage(sourceId: string, slug: string) { return factsCycleImpl.listFactsForPage(this.rawRead, sourceId, slug); }
  countLegacyFactsPending(sourceId: string) { return factsCycleImpl.countLegacyFactsPending(this.rawRead, sourceId); }
  countUnconsolidatedFactsBySource(opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }) { return factsCycleImpl.countUnconsolidatedFactsBySource(this.rawRead, opts); }
  findBulkFactDays(sourceIds: string[] | undefined, rule: factsCycleImpl.BulkDayRule) { return factsCycleImpl.findBulkFactDays(this.rawRead, sourceIds, rule); }
  maxFenceRowNum(sourceId: string, slug: string) { return factsCycleImpl.maxFenceRowNum(this.rawRead, sourceId, slug); }
  readFenceRowOccupant(sourceId: string, slug: string, rowNum: number) { return factsCycleImpl.readFenceRowOccupant(this.rawRead, sourceId, slug, rowNum); }
  listStoredFenceFactRows(sourceId: string, slug: string) { return factsCycleImpl.listStoredFenceFactRows(this.rawRead, sourceId, slug); }
  countWorldFacts(opts: factsCycleImpl.EntityFactCountOpts) { return factsCycleImpl.countWorldFacts(this.rawRead, opts); }

  // Facts statements, purge, withdrawal, relink and fence repair (engine-sql/facts-purge.ts), through executeRaw as before.

  countFactFingerprintLeftovers(sourceId: string, factHash: string, visibility: string, subject: string) { return factsPurgeImpl.countFactFingerprintLeftovers(this.rawRead, sourceId, factHash, visibility, subject); }
  loadPurgeTarget(id: number, sourceId: string) { return factsPurgeImpl.loadPurgeTarget(this.rawRead, id, sourceId); }
  planFactPurgeIds(sourceId: string, visibility: string, factHash: string, subject: string) { return factsPurgeImpl.planFactPurgeIds(this.rawRead, sourceId, visibility, factHash, subject); }
  listFactsReconcileBacklog() { return factsPurgeImpl.listFactsReconcileBacklog(this.rawRead); }
  settleFactsReconcile(sourceId: string, slug: string, outcome: factsPurgeImpl.FactsReconcileOutcome, revision?: string | null) { return factsPurgeImpl.settleFactsReconcile(this.rawRead, sourceId, slug, outcome, revision); }
  lockReconcileRevision(sourceId: string, slug: string, revision: string | null) { return factsPurgeImpl.lockReconcileRevision(this.rawRead, sourceId, slug, revision); }
  selectFactsReconcileDrain(sourceId: string, pageLimit: number) { return factsPurgeImpl.selectFactsReconcileDrain(this.rawRead, sourceId, pageLimit); }
  listRelinkCandidateRows(opts: { sourceId: string; afterId: number; since: Date | null; limit: number }) { return factsPurgeImpl.listRelinkCandidateRows(this.rawRead, opts); }
  countRelinkCandidates(sourceId: string) { return factsPurgeImpl.countRelinkCandidates(this.rawRead, sourceId); }
  listSimilarActiveFacts(opts: { sourceId: string; factId: number; remote: boolean; excludePrivate: boolean; minCosine: number; limit: number }) { return factsPurgeImpl.listSimilarActiveFacts(this.rawRead, opts); }
  findActiveSingleFact(opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean; newest?: boolean }) { return factsPurgeImpl.findActiveSingleFact(this.rawRead, opts); }
  listSingleFactMetadata(opts: { sourceId: string; ids: number[]; remoteFloor: boolean }) { return factsPurgeImpl.listSingleFactMetadata(this.rawRead, opts); }
  listUnfencedFactRows(opts: { sourceId?: string }) { return factsPurgeImpl.listUnfencedFactRows(this.rawRead, opts); }
  listHeldFenceFactRows(sourceId: string, slug: string) { return factsPurgeImpl.listHeldFenceFactRows(this.rawRead, sourceId, slug); }
  listWithdrawalSlugs(sourceId: string, visibility: string, factHash: string, subject: string) { return factsPurgeImpl.listWithdrawalSlugs(this.rawRead, sourceId, visibility, factHash, subject); }
  expireFactsByWithdrawal(sourceId: string, visibility: string, fact: string, subject: string) { return factsPurgeImpl.expireFactsByWithdrawal(this.rawRead, sourceId, visibility, fact, subject); }
  insertFactPurge(row: factsPurgeImpl.FactPurgeInsert) { return factsPurgeImpl.insertFactPurge(this.rawRead, row); }
  listDerivedRows(frontier: ReadonlyArray<{ table: string; id: string }>, limit: number) { return factsPurgeImpl.listDerivedRows(this.rawRead, frontier, limit); }

  // Facts statements, repair classifiers and loop retirement (engine-sql/facts-repair.ts), through executeRaw as before.
  loopFactDrift(sourceIds: string[], loopId: number | null) { return factsRepairImpl.loopFactDrift(this.rawRead, sourceIds, loopId); }
  closedLoopWithActiveFact(sourceId: string | null, loopId: number) { return factsRepairImpl.closedLoopWithActiveFact(this.rawRead, sourceId, loopId); }
  listSessionFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null) { return factsRepairImpl.listSessionFactsForClassification(this.rawRead, sourceIds, lanes, ids); }
  listSessionFactTwins(ids: number[], lanes: string[]) { return factsRepairImpl.listSessionFactTwins(this.rawRead, ids, lanes); }
  listCapturedFactsForClassification(sourceIds: string[], lanes: string[], ids: number[] | null) { return factsRepairImpl.listCapturedFactsForClassification(this.rawRead, sourceIds, lanes, ids); }
  countLabelFacts(sourceIds: string[], cap: number, args: factsRepairImpl.LabelFactCountArgs) { return factsRepairImpl.countLabelFacts(this.rawRead, sourceIds, cap, args); }
  listExtractorFactsForClassification(sourceIds: string[], slug: string | null) { return factsRepairImpl.listExtractorFactsForClassification(this.rawRead, sourceIds, slug); }
  countPurgedPageFacts(sourceIds: string[], cap: number) { return factsRepairImpl.countPurgedPageFacts(this.rawRead, sourceIds, cap); }
  listUnwithdrawnFacts(sourceIds: string[], slug: string | null, fenceKind: string) { return factsRepairImpl.listUnwithdrawnFacts(this.rawRead, sourceIds, slug, fenceKind); }
  listWorldFactsFromPrivateSources(sourceIds: string[], ids: number[] | null) { return factsRepairImpl.listWorldFactsFromPrivateSources(this.rawRead, sourceIds, ids); }

  // Facts statements, search relevance and trust reads (engine-sql/facts-trust.ts), through executeRaw as before.
  private get rawTransaction(): factsTrustImpl.EngineRawTransaction { return fn => this.transaction(tx => fn((sql, params) => tx.executeRaw(sql, params))); }
  listFactsForRelevance(q: factsTrustImpl.FactRelevanceQuery) { return factsTrustImpl.listFactsForRelevance(this.rawRead, this.rawTransaction, q); }
  countUncomparableFacts(q: factsTrustImpl.UncomparableFactsQuery) { return factsTrustImpl.countUncomparableFacts(this.rawRead, this.rawTransaction, q); }
  matchSavedFacts(q: factsTrustImpl.SavedFactsMatchQuery) { return factsTrustImpl.matchSavedFacts(this.rawRead, q); }
  readFactForOwnerAction(id: number) { return factsTrustImpl.readFactForOwnerAction(this.rawRead, id); }
  listStandingPreferences(opts: { sourceId?: string; since?: Date }) { return factsTrustImpl.listStandingPreferences(this.rawRead, opts); }
  listLexicalContestCandidates(opts: Parameters<typeof factsTrustImpl.listLexicalContestCandidates>[1]) { return factsTrustImpl.listLexicalContestCandidates(this.rawRead, opts); }
  listFactsFromQuotedPages(opts: Parameters<typeof factsTrustImpl.listFactsFromQuotedPages>[1]) { return factsTrustImpl.listFactsFromQuotedPages(this.rawRead, opts); }
  listOwnerTierFacts(opts: Parameters<typeof factsTrustImpl.listOwnerTierFacts>[1]) { return factsTrustImpl.listOwnerTierFacts(this.rawRead, opts); }
  listRestatedPrivateCopies(opts: Parameters<typeof factsTrustImpl.listRestatedPrivateCopies>[1]) { return factsTrustImpl.listRestatedPrivateCopies(this.rawRead, opts); }
  countDerivedFactTaint() { return factsTrustImpl.countDerivedFactTaint(this.rawRead); }


  getSourceStrictness(sourceId: string) { return persistenceStateImpl.getSourceStrictness(unscopedExecutor(this.engineSql, 'persistence: strict-source read ran unscoped through executeRaw'), sourceId); }
  readPersistenceBrainId() { return persistenceStateImpl.readPersistenceBrainId(unscopedExecutor(this.engineSql, 'persistence: brain identity read ran unscoped through executeRaw')); }
  declarePersistence(opts?: { durable?: DurablePersistenceSettings }) { return persistenceDeclarationImpl.declarePersistence(this, opts?.durable); }
  requireSynchronousCommit() { return persistenceDeclarationImpl.requireSynchronousCommit(this); }
  readLocalWriterRow(id: string, opts?: { lock?: boolean }) { return persistenceStateImpl.readLocalWriterRow(unscopedExecutor(this.engineSql, 'persistence: local writer read ran unscoped through executeRaw'), id, opts); }
  insertLocalWriterRow(row: persistenceStateImpl.LocalWriterInsert) { return persistenceStateImpl.insertLocalWriterRow(this.engineSql, row); }
  readJournalLimitRows() { return persistenceJournalImpl.readJournalLimitRows(unscopedExecutor(this.engineSql, 'persistence: journal limit read ran unscoped through executeRaw')); }
  readHeldPageRows<R = Record<string, unknown>>(pageIds: string[]) { return persistenceJournalImpl.readHeldPageRows<R>(unscopedExecutor(this.engineSql, 'persistence: hold read ran unscoped through executeRaw'), pageIds); }
  readHeldCoverageRows(sourceIds: string[] | null) { return persistenceJournalImpl.readHeldCoverageRows(unscopedExecutor(this.engineSql, 'persistence: hold summary read ran unscoped through executeRaw'), sourceIds); }
  readGitHoldRecords<R = Record<string, unknown>>(opts?: GitHoldRecordsQuery) { return syncHoldReadsImpl.readGitHoldRecords<R>(this, opts); }
  readGitHoldRetryRequest(fingerprint: string) { return syncHoldReadsImpl.readGitHoldRetryRequest(this, fingerprint); }
  readGitHoldReportInputs(sourceId: string, fingerprint: string) { return syncHoldReadsImpl.readGitHoldReportInputs(this, sourceId, fingerprint); }
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
  readSyncPassRow<V = Record<string, unknown>>(sourceId: string, incarnation: string) { return syncHoldStoreImpl.readSyncPassRow<V>(this, sourceId, incarnation); }
  readLiveSyncPassRows<V = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncHoldStoreImpl.readLiveSyncPassRows<V>(this, sourceIds); }
  writeSyncPassRow(sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts?: SyncPassRowWrite) { return syncHoldStoreImpl.writeSyncPassRow(this, sourceId, incarnation, value, opts); }
  readSyncStatusSourceRow<P = Record<string, unknown>, W = Record<string, unknown>, F = Record<string, unknown>>(sourceId: string) { return syncStatusReadsImpl.readSyncStatusSourceRow<P, W, F>(this, sourceId); }
  readSyncStatusCommittedRow(sourceId: string) { return syncStatusReadsImpl.readSyncStatusCommittedRow(this, sourceId); }
  readManagedSyncCursorHeader<H = Record<string, unknown>>(sourceId: string, incarnation: string, failedKey: string) { return syncStatusReadsImpl.readManagedSyncCursorHeader<H>(this, sourceId, incarnation, failedKey); }
  readRetiredManagedSyncCursor(sourceId: string, incarnation: string) { return syncStatusReadsImpl.readRetiredManagedSyncCursor(this, sourceId, incarnation); }
  readManagedSyncFailureRows<V = Record<string, unknown>, R = Record<string, unknown>, F = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readManagedSyncFailureRows<V, R, F>(this, sourceIds); }
  readOrphanedManagedSyncFailureRows<F = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readOrphanedManagedSyncFailureRows<F>(this, sourceIds); }
  readSyncHeadRequestRow(sourceId: string, opts?: SyncStatusProbeOptions) { return syncStatusReadsImpl.readSyncHeadRequestRow(this, sourceId, opts); }
  readSyncRecoveryProbeRow(sourceId: string, opts?: SyncStatusProbeOptions) { return syncStatusReadsImpl.readSyncRecoveryProbeRow(this, sourceId, opts); }
  readIdentityDowngradeRows<D = Record<string, unknown>>(sourceIds: readonly string[] | null) { return syncStatusReadsImpl.readIdentityDowngradeRows<D>(this, sourceIds); }
  readWriteWatermarkRow(sourceId: string) { return appliedWatermarkReadsImpl.readWriteWatermarkRow(this, sourceId); }
  readSourceCheckoutRoot(sourceId: string, hostId: string | null) { return appliedWatermarkReadsImpl.readSourceCheckoutRoot(this, sourceId, hostId); }
  readUnembeddedPageSummary(sourceId: string, column: string) { return appliedWatermarkReadsImpl.readUnembeddedPageSummary(this, sourceId, column); }
  listFenceHoldRows(sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string) { return fenceHoldsImpl.listFenceHoldRows(this.rawRead, sourceIds, kinds, ownerKey); }
  readWriteRequest(principalKind: string, principalId: string, requestId: string) { return persistenceJournalImpl.readWriteRequest(unscopedExecutor(this.engineSql, 'persistence: request read ran unscoped through executeRaw'), principalKind, principalId, requestId); }
  readWriteRequestsByRequestIds(principalKind: string, principalId: string, requestIds: readonly string[]) { return persistenceJournalImpl.readWriteRequestsByRequestIds(unscopedExecutor(this.engineSql, 'persistence: grouped request read ran unscoped through executeRaw'), principalKind, principalId, requestIds); }
  readWriteRequestById(id: string, opts?: { signal?: AbortSignal }) { return persistenceJournalImpl.readWriteRequestById(unscopedExecutor(this.engineSql, 'persistence: request read ran unscoped through executeRaw'), id, opts); }
  listWriteRequestRows(principalKind: string, principalId: string, sourceId: string, filter: persistenceJournalImpl.WriteRequestListFilter) { return persistenceJournalImpl.listWriteRequestRows(unscopedExecutor(this.engineSql, 'persistence: receipt list ran unscoped through executeRaw'), principalKind, principalId, sourceId, filter); }
  readWriteRequestProgress(id: string, opts?: { signal?: AbortSignal }) { return persistenceJournalImpl.readWriteRequestProgress(unscopedExecutor(this.engineSql, 'persistence: request progress read ran unscoped through executeRaw'), id, opts); }
  readCounterRows(keys: readonly string[]) { return persistenceJournalImpl.readCounterRows(unscopedExecutor(this.engineSql, 'persistence: counter rows read ran unscoped through executeRaw'), keys); }
  ownsSchemaTables() { return persistenceJournalImpl.ownsSchemaTables(unscopedExecutor(this.engineSql, 'persistence: schema owner read ran unscoped through executeRaw')); }
  readOAuthClientWriteGrant(clientId: string, opts?: { lock?: boolean }) { return persistenceJournalImpl.readOAuthClientWriteGrant(unscopedExecutor(this.engineSql, 'persistence: OAuth client grant read ran unscoped through executeRaw'), clientId, opts); }
  readAccessTokenWriteGrant(tokenId: string, opts?: { lock?: boolean }) { return persistenceJournalImpl.readAccessTokenWriteGrant(unscopedExecutor(this.engineSql, 'persistence: legacy token grant read ran unscoped through executeRaw'), tokenId, opts); }
  shareLockWriteCredential(kind: 'oauth_client' | 'legacy_token', id: string) { return persistenceJournalImpl.shareLockWriteCredential(unscopedExecutor(this.engineSql, 'persistence: credential lock ran unscoped through executeRaw'), kind, id); }
  readAdmissionRate(principal: { kind: string; id: string } | null, opts?: { sample?: boolean }) { return persistenceJournalImpl.readAdmissionRate(unscopedExecutor(this.engineSql, 'persistence: admission rate read ran unscoped through executeRaw'), principal, opts); }
  countOutstandingBySource(principalKind: string, principalId: string) { return persistenceJournalImpl.countOutstandingBySource(unscopedExecutor(this.engineSql, 'persistence: outstanding-by-source read ran unscoped through executeRaw'), principalKind, principalId); }
  readWorktreeAdmission(key: persistenceAdmissionImpl.WorktreeAdmissionKey, opts?: { lockRefresh?: boolean }) { return persistenceAdmissionImpl.readWorktreeAdmission(this, key, opts); }
  completeSyncedRefresh(refreshId: string) { return persistenceAdmissionImpl.completeSyncedRefresh(this, refreshId); }
  hasDeferralRoom(worktreeId: string, capability: string, liveMs: number) { return persistenceAdmissionImpl.hasDeferralRoom(this, worktreeId, capability, liveMs); }
  readRefreshTiming(refreshId: string) { return persistenceAdmissionImpl.readRefreshTiming(this, refreshId); }
  countHeldBehindImport(sourceId: string, principal: { kind: string; id: string } | null) { return persistenceAdmissionImpl.countHeldBehindImport(this, sourceId, principal); }
  lockPersistenceCounters(keys: readonly string[]) { return persistenceJournalImpl.lockPersistenceCounters(this.engineSql, keys); }
  insertWriteRequest(row: persistenceJournalImpl.WriteRequestInsert) { return persistenceJournalImpl.insertWriteRequest(this.engineSql, row); }
  insertWriteRequestGroup(group: persistenceJournalImpl.WriteRequestGroupInsert) { return persistenceJournalImpl.insertWriteRequestGroup(this.engineSql, group); }
  readOwnerHostBinding(worktreeId: string) { return persistenceJournalImpl.readOwnerHostBinding(unscopedExecutor(this.engineSql, 'persistence: owner binding read ran unscoped through executeRaw'), worktreeId); }
  stampWriteClaim(id: string, token: string, leaseMs: number, phaseJson: string) { return persistenceJournalImpl.stampWriteClaim(this.engineSql, id, token, leaseMs, phaseJson); }
  lockWriteRequest(id: string) { return persistenceJournalImpl.lockWriteRequest(this.engineSql, id); }
  completeWriteRow(completion: persistenceJournalImpl.WriteCompletion) { return persistenceJournalImpl.completeWriteRow(this.engineSql, completion); }
  insertPublicationEffects(spec: persistenceJournalImpl.PublicationEffectsSpec) { return persistenceJournalImpl.insertPublicationEffects(this.engineSql, spec); }
  insertWithdrawalEffects(spec: persistenceJournalImpl.WithdrawalEffectsSpec) { return persistenceJournalImpl.insertWithdrawalEffects(this.engineSql, spec); }
  cancelWriteRow(cancel: persistenceJournalImpl.WriteCancellation) { return persistenceJournalImpl.cancelWriteRow(this.engineSql, cancel); }
  readSourceMembership(sourceId: string, opts?: { lock?: boolean }) { return persistenceClaimsImpl.readSourceMembership(this.engineSql, sourceId, opts); }
  findTopologyChanges(principalId: string, requestIds: string[]) { return persistenceClaimsImpl.findTopologyChanges(unscopedExecutor(this.engineSql, 'persistence: topology probe ran unscoped through executeRaw'), principalId, requestIds); }
  listTopologyRecoveries(hostId: string, after: string | null, limit: number) { return persistenceClaimsImpl.listTopologyRecoveries(unscopedExecutor(this.engineSql, 'persistence: topology recovery scan ran unscoped through executeRaw'), hostId, after, limit); }
  readTopologyChange(principalId: string, requestId: string) { return persistenceClaimsImpl.readTopologyChange(unscopedExecutor(this.engineSql, 'persistence: topology receipt read ran unscoped through executeRaw'), principalId, requestId); }
  insertTopologyChange(row: persistenceClaimsImpl.TopologyChangeInsert) { return persistenceClaimsImpl.insertTopologyChange(this.engineSql, row); }
  renewWriteClaim(renewal: persistenceClaimsImpl.ClaimRenewal, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.renewWriteClaim(this.engineSql, renewal, opts); }
  releaseUnpublishedClaim(release: persistenceClaimsImpl.ClaimRelease, _opts?: { direct?: boolean }) { return persistenceClaimsImpl.releaseUnpublishedClaim(this, release); }
  expireStaleWriteClaims(expiry: persistenceClaimsImpl.ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.expireStaleWriteClaims(this.engineSql, expiry, { signal: opts?.signal }); }
  hasClaimableWrite(hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }) { return persistenceClaimsImpl.hasClaimableWrite(unscopedExecutor(this.engineSql, 'persistence: claim check ran unscoped through executeRaw'), hostId, excludeRoots, opts); }
  selectClaimableWrite<R = Record<string, unknown>>(spec: persistenceClaimsImpl.ClaimHeadSpec) { return persistenceClaimsImpl.selectClaimableWrite<R>(unscopedExecutor(this.engineSql, 'persistence: FIFO head read ran unscoped through the transaction executeRaw'), spec); }
  listHostConsumerRows(hostId: string, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.listHostConsumerRows(unscopedExecutor(this.engineSql, 'persistence: consumer rows read ran unscoped through executeRaw'), hostId, { signal: opts?.signal }); }
  probeLiveConsumerRows(probe: persistenceClaimsImpl.ConsumerProbe, opts?: { signal?: AbortSignal; direct?: boolean }) { return persistenceClaimsImpl.probeLiveConsumerRows(unscopedExecutor(this.engineSql, 'persistence: live consumer probe ran unscoped through executeRaw'), probe, { signal: opts?.signal }); }
  renewConsumerRow(renewal: persistenceClaimsImpl.ConsumerRenewal, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.renewConsumerRow(this.engineSql, renewal, opts); }
  deleteConsumerRow(key: persistenceClaimsImpl.ConsumerRowKey, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.deleteConsumerRow(this.engineSql, key, opts); }
  stampWorktreeHeartbeats(hostId: string, opts?: { signal?: AbortSignal }) { return persistenceClaimsImpl.stampWorktreeHeartbeats(this.engineSql, hostId, opts); }
  claimHousekeepingTurn(claim: housekeepingImpl.HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }) { return housekeepingImpl.claimHousekeepingTurn(this.engineSql, claim, { signal: opts?.signal }); }
  completeHousekeepingTurn(turn: { op: string; hostId: string }, _opts?: { direct?: boolean }) { return housekeepingImpl.completeHousekeepingTurn(this.engineSql, turn); }
  readReceiptBudget(retentionKey: string, floorDays: number) { return housekeepingImpl.readReceiptBudget(unscopedExecutor(this.engineSql, 'persistence: receipt budget read ran unscoped through executeRaw'), retentionKey, floorDays); }
  listCompactableReceipts<R = Record<string, unknown>>(retentionDays: number) { return housekeepingImpl.listCompactableReceipts<R>(unscopedExecutor(this.engineSql, 'persistence: compaction listing ran unscoped through executeRaw'), retentionDays); }
  listReservationsAfter(after: string, limit: number) { return housekeepingImpl.listReservationsAfter(unscopedExecutor(this.engineSql, 'persistence: reservation sweep read ran unscoped through executeRaw'), after, limit); }
  trueUpReservations(rows: readonly housekeepingImpl.TrueUpReservation[]) { return housekeepingImpl.trueUpReservations(this.engineSql, rows); }
  listTrueUpRequests<R = Record<string, unknown>>(ids: readonly string[]) { return housekeepingImpl.listTrueUpRequests<R>(unscopedExecutor(this.engineSql, 'persistence: true-up read ran unscoped through executeRaw'), ids); }
  readCapacityForecastInputs(opts?: { light?: boolean }) { return housekeepingImpl.readCapacityForecastInputs(unscopedExecutor(this.engineSql, 'persistence: capacity forecast read ran unscoped through executeRaw'), opts); }
  listPendingSegmentedProjections(filter: housekeepingImpl.SegmentedProjectionFilter) { return housekeepingImpl.listPendingSegmentedProjections(unscopedExecutor(this.engineSql, 'projections: segmented queue read ran unscoped through executeRaw'), filter); }
  selectProjectionWindowJobs(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean) { return housekeepingImpl.selectProjectionWindowJobs(unscopedExecutor(this.engineSql, 'projections: resident window read ran unscoped through executeRaw'), cursor, retryCooldown); }
  claimSegmentedProjection(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.claimSegmentedProjection(this.engineSql, ref, claim); }
  renewSegmentedProjectionClaim(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.renewSegmentedProjectionClaim(this.engineSql, ref, claim); }
  releaseSegmentedProjectionClaim(ref: housekeepingImpl.ProjectionPageRef, claim: string) { return housekeepingImpl.releaseSegmentedProjectionClaim(this.engineSql, ref, claim); }
  deleteProjectionJob(job: housekeepingImpl.ProjectionJobRef) { return housekeepingImpl.deleteProjectionJob(this.engineSql, job); }
  markProjectionRebuildFailed(job: housekeepingImpl.ProjectionJobRef) { return housekeepingImpl.markProjectionRebuildFailed(this.engineSql, job); }
  listGatedMirrorRequests(hostId: string, gateCode: string, allowedCodes: readonly string[]) { return effectScansImpl.listGatedMirrorRequests(unscopedExecutor(this.engineSql, 'persistence: gated mirror scan ran unscoped through executeRaw'), hostId, gateCode, allowedCodes); }
  listEffectRecoveries<R = Record<string, unknown>>(hostId: string, after: string | null, limit: number) { return effectScansImpl.listEffectRecoveries<R>(unscopedExecutor(this.engineSql, 'persistence: effect recovery scan ran unscoped through executeRaw'), hostId, after, limit); }
  selectClaimableEffect<R = Record<string, unknown>>(hostId: string, deadOwners: readonly string[]) { return effectScansImpl.selectClaimableEffect<R>(unscopedExecutor(this.engineSql, 'persistence: effect claim read ran unscoped through the transaction executeRaw'), hostId, deadOwners); }
  readRequestEffects(requestId: string, kind?: 'git') { return effectScansImpl.readRequestEffects(unscopedExecutor(this.engineSql, 'persistence: receipt effect read ran unscoped through executeRaw'), requestId, kind); }
  listOverdueHeldWrites<R = Record<string, unknown>>(hostId: string, maxWaitMs: number, hold: ownerScansImpl.OverdueHoldKind, opts?: { signal?: AbortSignal }) { return ownerScansImpl.listOverdueHeldWrites<R>(unscopedExecutor(this.engineSql, 'persistence: overdue hold scan ran unscoped through executeRaw'), hostId, maxWaitMs, hold, opts); }
  lockOverdueHold(hold: ownerScansImpl.OverdueHold) { return ownerScansImpl.lockOverdueHold(unscopedExecutor(this.engineSql, 'persistence: overdue hold check ran unscoped through the transaction executeRaw'), hold); }
  listOwnerRecoveryHeads<R = Record<string, unknown>>(hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }) { return ownerScansImpl.listOwnerRecoveryHeads<R>(unscopedExecutor(this.engineSql, 'persistence: owner recovery scan ran unscoped through executeRaw'), hostId, excluded, { signal: opts?.signal }); }
  // The refresh resume's reads ran on executeRaw (worktree-refresh.ts resumeWorktreeRefreshes).
  listResumableRefreshes<R = Record<string, unknown>>(hostId: string, budgetMs: number) { return ownerScansImpl.listResumableRefreshes<R>(unscopedExecutor(this.engineSql, 'persistence: refresh resume scan ran unscoped through executeRaw'), hostId, budgetMs); }
  listSourceLastCommits(sourceIds: readonly string[]) { return ownerScansImpl.listSourceLastCommits(unscopedExecutor(this.engineSql, 'persistence: refresh resume source read ran unscoped through executeRaw'), sourceIds); }
  stampEffectClaim<R = Record<string, unknown>>(claim: effectWorkerImpl.EffectClaim) { return effectWorkerImpl.stampEffectClaim<R>(this, claim); }
  renewEffectClaim(claim: effectWorkerImpl.EffectClaimRef, _opts?: { direct?: boolean }) { return effectWorkerImpl.renewEffectClaim(this, claim); }
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
    return idleProbeImpl.probeIdleWork(opts?.lane ?? this, spec, { signal: opts?.signal });
  }
  probeNoopEmbeddingSettle(from: string) { return noopSettleImpl.probeNoopEmbeddingSettle(this, from); }
  lockNoopEmbeddingWindow(spec: { from: string; limit: number }) { return noopSettleImpl.lockNoopEmbeddingWindow(this, spec); }
  readNoopEmbeddingCandidates(spec: noopSettleImpl.NoopSettleCandidateSpec) { return noopSettleImpl.readNoopEmbeddingCandidates(this, spec); }
  settleNoopEmbeddingRows(ids: readonly string[]) { return noopSettleImpl.settleNoopEmbeddingRows(this, ids); }
  readTransactionSettings(names: readonly string[]) { return transactionSettingsImpl.readTransactionSettings(unscopedExecutor(this.engineSql, 'transaction settings: read ran through the transaction executeRaw'), names); }
  readCurrentWriteTrust() { return transactionSettingsImpl.readCurrentWriteTrust(unscopedExecutor(this.engineSql, 'transaction settings: write trust read ran through the transaction executeRaw')); }
  setWriteContext(input: transactionSettingsImpl.WriteContextInput) { return transactionSettingsImpl.setWriteContext(this.engineSql, input); }
  readWriterVersionCutoff() { return writerVersionsImpl.readWriterVersionCutoff(unscopedExecutor(this.engineSql, 'writer versions: cutoff read ran unscoped through executeRaw')); }
  listWriterVersions(limit: number) { return writerVersionsImpl.listWriterVersions(unscopedExecutor(this.engineSql, 'writer versions: list ran unscoped through executeRaw'), limit); }
  recentWriterVersions(days: number) { return writerVersionsImpl.recentWriterVersions(unscopedExecutor(this.engineSql, 'writer versions: window read ran unscoped through executeRaw'), days); }
  readSegmentedGateEvidence(days: number) { return writerVersionsImpl.readSegmentedGateEvidence(unscopedExecutor(this.engineSql, 'writer versions: segmented gate read ran unscoped through executeRaw'), days); }
  applyTransactionSettings(names: readonly string[], values: readonly string[]) { return transactionSettingsImpl.applyTransactionSettings(this.engineSql, names, values); }
  beginSnapshotRead(opts?: { readOnly?: boolean }) { return transactionSettingsImpl.beginSnapshotRead(this, opts); }
  setLocalStatementTimeout(ms: number) { return transactionSettingsImpl.setLocalStatementTimeout(this, ms); }
  hasPersistenceTable(table: connectGateImpl.PersistenceTable) { return connectGateImpl.hasPersistenceTable(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), table); }
  listManagedRootBindings(hostId: string, opts?: { signal?: AbortSignal }) { return connectGateImpl.listManagedRootBindings(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), hostId, opts); }
  readGraduationGateRow(opts?: { withRunSetting?: boolean }) { return connectGateImpl.readGraduationGateRow(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw'), opts); }
  listRetiredDeactivations() { return connectGateImpl.listRetiredDeactivations(unscopedExecutor(this.engineSql, 'connect gate: persistence read ran unscoped through executeRaw')); }
  // Group A (decide store).
  readDecideState(key: string) { return decideStoreImpl.readDecideState(this, key); }
  upsertDecideState(key: string, value: string) { return decideStoreImpl.upsertDecideState(this, key, value); }
  deleteDecideState(key: string) { return decideStoreImpl.deleteDecideState(this, key); }
  ensureDecideState(key: string, value: string) { return decideStoreImpl.ensureDecideState(this, key, value); }
  insertDecideSpend(rows: readonly decideStoreImpl.DecideSpendInsert[]) { return decideStoreImpl.insertDecideSpend(this, rows); }
  dailyDecideSpend(since: Date) { return decideStoreImpl.dailyDecideSpend(this, since); }
  listDecideSpendBySlot() { return decideStoreImpl.listDecideSpendBySlot(this); }
  insertDecideReceipts(rows: readonly decideStoreImpl.DecideReceiptInsert[]) { return decideStoreImpl.insertDecideReceipts(this, rows); }
  pruneDecideReceipts(retentionDays: number) { return decideStoreImpl.pruneDecideReceipts(this, retentionDays); }
  listDecideReceiptStats(opts: { slot?: string; sinceHours: number }) { return decideStoreImpl.listDecideReceiptStats(this, opts); }
  decideSlotUsage(sinceHours: number) { return decideStoreImpl.decideSlotUsage(this, sinceHours); }
  decideConflictNoEntityCounts(sinceHours: number) { return decideStoreImpl.decideConflictNoEntityCounts(this, sinceHours); }
  listDecideReplayReceipts(slot: string, sinceHours: number) { return decideStoreImpl.listDecideReplayReceipts(this, slot, sinceHours); }
  listDecideResolvedModels(sinceHours: number) { return decideStoreImpl.listDecideResolvedModels(this, sinceHours); }
  listDecideMixedModelDecisions(sinceHours: number) { return decideStoreImpl.listDecideMixedModelDecisions(this, sinceHours); }
  insertDecideCalibration(row: decideStoreImpl.DecideCalibrationInsert) { return decideStoreImpl.insertDecideCalibration(this, row); }
  storeDecideQualification(id: number, q: decideStoreImpl.DecideQualification) { return decideStoreImpl.storeDecideQualification(this, id, q); }
  listDecideCalibrations(opts?: { slot?: string; includeRetired?: boolean }) { return decideStoreImpl.listDecideCalibrations(this, opts); }
  getDecideCalibration(id: number) { return decideStoreImpl.getDecideCalibration(this, id); }
  setDecideCalibrationRetired(id: number, retired: boolean) { return decideStoreImpl.setDecideCalibrationRetired(this, id, retired); }
  readLedgerSource(sourceId: string, opts?: { batch?: boolean }) { return beliefImpl.readLedgerSource(unscopedExecutor(this.engineSql, 'belief: ledger source probe ran unscoped through executeRaw'), sourceId, opts); }
  async listCoveredSources(subjectKey: string) { return beliefImpl.listCoveredSources(this, subjectKey); }
  isFolderRestricted(sourceId: string, slug: string) { return accessControlImpl.isFolderRestricted(unscopedExecutor(this.engineSql, 'access: folder rule read ran unscoped through executeRaw'), sourceId, slug); }
  readFolderAccess(readers: readonly string[]) { return accessControlImpl.readFolderAccess(this, readers); }
  listAppliedPolicyRevisions() { return accessControlImpl.listAppliedPolicyRevisions(unscopedExecutor(this.engineSql, 'access: applied revision read ran unscoped through executeRaw')); }
  readMayActFor(via: MayActForVia, key: string): Promise<string[] | string | null> { return accessControlImpl.readMayActFor(this, via, key); }
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
  listUnarchivedSourceIds(ids: readonly string[]) { return accessSetupImpl.listUnarchivedSourceIds(this, ids); }
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
  readAccessMembers(by: AccessMemberLookup): Promise<AccessMemberRow[]> { return accessControlImpl.readAccessMembers(this, by); }
  readAccessCredentials(by: AccessCredentialLookup): Promise<AccessCredentialRow[]> { return accessControlImpl.readAccessCredentials(this, by); }
  listAudienceAccessMembers(): Promise<string[]> { return accessControlImpl.listAudienceAccessMembers(this); }
  readLiveMember(via: LiveMemberVia, key: string): Promise<LiveMemberRow | null> { return accessControlImpl.readLiveMember(this, via, key); }
  // Entity and mention reads the CLI made through executeRaw (engine-sql/entity-reads.ts).
  readMentionLastPass(sourceId?: string | null) { return entityReadsImpl.readMentionLastPass(unscopedExecutor(this.engineSql, 'entities: mention pass time ran unscoped through executeRaw'), sourceId); }
  countPagesDueForMentions(q: entityReadsImpl.MentionDueQuery) { return entityReadsImpl.countPagesDueForMentions(unscopedExecutor(this.engineSql, 'entities: mention-due count ran unscoped through executeRaw'), q); }
  readIdentitySiblingCandidates(sourceId: string, q: entityReadsImpl.SiblingCandidateQuery) { return entityReadsImpl.readIdentitySiblingCandidates(unscopedExecutor(this.engineSql, 'entities: sibling candidates ran unscoped through executeRaw'), sourceId, q); }
  findExactSlug(sourceId: string, slugs: readonly string[], opts?: { retired?: boolean }) { return entityReadsImpl.findExactSlug(unscopedExecutor(this.engineSql, 'entities: exact slug ran unscoped through executeRaw'), sourceId, slugs, opts); }
  readLiveSlugs(sourceId: string, slugs: readonly string[], opts?: { limit?: 2 }) { return entityReadsImpl.readLiveSlugs(unscopedExecutor(this.engineSql, 'entities: live slug read ran unscoped through executeRaw'), sourceId, slugs, opts); }
  readLivePageTypes(sourceId: string, slugs: readonly string[], privacy: entityReadsImpl.ResolverPrivacy) { return entityReadsImpl.readLivePageTypes(unscopedExecutor(this.engineSql, 'entities: live page type read ran unscoped through executeRaw'), sourceId, slugs, privacy); }
  readTrigramCandidates(sourceId: string, q: entityReadsImpl.TrigramCandidateQuery) { return entityReadsImpl.readTrigramCandidates(unscopedExecutor(this.engineSql, 'entities: trigram candidate read ran unscoped through executeRaw'), sourceId, q); }
  readPrefixCandidates(sourceId: string, q: entityReadsImpl.PrefixCandidateQuery) { return entityReadsImpl.readPrefixCandidates(unscopedExecutor(this.engineSql, 'entities: prefix candidate read ran unscoped through executeRaw'), sourceId, q); }
  readPrefixDirs(sourceId: string, patterns: readonly string[]) { return entityReadsImpl.readPrefixDirs(unscopedExecutor(this.engineSql, 'entities: prefix directory read ran unscoped through executeRaw'), sourceId, patterns); }
  readPrefixTitleMatches(sourceId: string, patterns: readonly string[], title: string) { return entityReadsImpl.readPrefixTitleMatches(unscopedExecutor(this.engineSql, 'entities: prefix title read ran unscoped through executeRaw'), sourceId, patterns, title); }
  readNamedEntitySlugs(sourceId: string, slugs: readonly string[], privacy: entityReadsImpl.ResolverPrivacy) { return entityReadsImpl.readNamedEntitySlugs(unscopedExecutor(this.engineSql, 'entities: named entity read ran unscoped through executeRaw'), sourceId, slugs, privacy); }
  findFuzzyEntityCandidates(sourceId: string, title: string, fragment: string) { return entityReadsImpl.findFuzzyEntityCandidates(unscopedExecutor(this.engineSql, 'entities: fuzzy lookup ran unscoped through executeRaw'), sourceId, title, fragment); }
  findExactBasenameCandidates(sourceId: string, slugs: readonly string[]) { return entityReadsImpl.findExactBasenameCandidates(unscopedExecutor(this.engineSql, 'entities: exact basename ran unscoped through executeRaw'), sourceId, slugs); }
  readRetirementHop(sourceId: string, slug: string, privacy: entityReadsImpl.RetirementPrivacy) { return entityReadsImpl.readRetirementHop(unscopedExecutor(this.engineSql, 'entities: retirement hop ran unscoped through executeRaw'), sourceId, slug, privacy); }
  readEntityCardRows(sourceId: string, match: entityReadsImpl.EntityCardMatch, opts?: { excludePrivate?: boolean }) { return entityReadsImpl.readEntityCardRows(unscopedExecutor(this.engineSql, 'entities: entity card candidates ran unscoped through executeRaw'), sourceId, match, opts); }
  // PGLite runs in process and has no statement timeout, so the two timed reads drop `timeoutMs`. A getter, not a
  // field: a transaction engine is Object.create(this), and must run on its own executeRaw.
  private get untimedRead(): entityReadsImpl.TimedRawRead { return { executeRaw: (sql, params) => this.executeRaw(sql, params) }; }
  readExtractionLagCounts(q: entityReadsImpl.ExtractionLagQuery) { return entityReadsImpl.readExtractionLagCounts(this.untimedRead, q); }
  readIgnoredPrivacyLabelPages(sourceId: string, scope: { slugs: readonly string[] } | { since: string }, opts?: { limit?: number; timeoutMs?: number }) { return entityReadsImpl.readIgnoredPrivacyLabelPages(this.untimedRead, sourceId, scope, opts); }
  listLocalPathSources() { return sourcesImpl.listLocalPathSources(unscopedExecutor(this.engineSql, 'sources: source resolution read it unscoped through executeRaw')); }
  readPlainSyncSource(sourceId: string) { return sourcesImpl.readPlainSyncSource(unscopedExecutor(this.engineSql, 'sources: plain-directory sync read it unscoped through executeRaw'), sourceId); }
  readOwnerOnlySourcesPresent() { return sourcesImpl.readOwnerOnlySourcesPresent(unscopedExecutor(this.engineSql, 'sources: the owner-only check read it unscoped through executeRaw'), ownerOnlyLineageReadable(this)); }
  readOwnerOnlySourceConfig(sourceId: string) { return sourcesImpl.readOwnerOnlySourceConfig(unscopedExecutor(this.engineSql, 'sources: the owner-only check read it unscoped through executeRaw'), sourceId); }
  listSourceRoutingRows() { return sourcesImpl.listSourceRoutingRows(unscopedExecutor(this.engineSql, 'sources: source resolution read it unscoped through executeRaw')); }
  countDefaultSourceSplit() { return sourcesImpl.countDefaultSourceSplit(unscopedExecutor(this.engineSql, 'sources: the default-write guard read it unscoped through executeRaw')); }
  listStaleSyncSourceIds() { return sourcesImpl.listStaleSyncSourceIds(unscopedExecutor(this.engineSql, 'sources: the advisor read it unscoped through executeRaw')); }
  readSourceRow(sourceId: string) { return sourcesImpl.readSourceRow(unscopedExecutor(this.engineSql, 'sources: source checks read it unscoped through executeRaw'), sourceId); }
  lockSourceRow(sourceId: string) { return sourcesImpl.lockSourceRow(this.engineSql, sourceId); }
  isSourceClaimed(sourceId: string) { return sourcesImpl.isSourceClaimed(unscopedExecutor(this.engineSql, 'sources: sync-authority read the claim unscoped through executeRaw'), sourceId); }
  readSourceChunkerVersion(sourceId: string) { return sourcesImpl.readSourceChunkerVersion(unscopedExecutor(this.engineSql, 'sources: sync preflight read it unscoped through executeRaw'), sourceId); }
  setSourceChunkerVersion(sourceId: string, version: string) { return sourcesImpl.setSourceChunkerVersion(this.engineSql, sourceId, version); }
  countSourcePages(sourceId: string, opts?: { includeDeleted?: boolean }) { return sourcesImpl.countSourcePages(unscopedExecutor(this.engineSql, 'sources: source commands counted pages unscoped through executeRaw'), sourceId, opts); }
  insertSource(row: sourcesImpl.SourceInsert) { return sourcesImpl.insertSource(this.engineSql, row); }
  readPageSizeRows(sourceId: string, maxBytes: number, slugs: readonly string[] | null) { return sourcesImpl.readPageSizeRows(unscopedExecutor(this.engineSql, 'sources: the sync size-state read ran it unscoped through executeRaw'), sourceId, maxBytes, slugs); }
  holdPageEmbedding(pageId: number, reason: string) { return sourcesImpl.holdPageEmbedding(this.engineSql, pageId, reason); }
  readReasonPurgeTombstones(sourceId: string, pair?: sourcesImpl.ReasonPurgeTombstone) { return sourcesImpl.readReasonPurgeTombstones(unscopedExecutor(this.engineSql, 'sources: the purged change-reason reads ran it unscoped through executeRaw'), sourceId, pair); }
  writeReasonPurgeTombstones(sourceId: string, pairs: readonly sourcesImpl.ReasonPurgeTombstone[]) { return sourcesImpl.writeReasonPurgeTombstones(this.engineSql, sourceId, pairs); }
  listSourcePathPages(sourceId: string) { return sourcesImpl.listSourcePathPages(unscopedExecutor(this.engineSql, 'sources: full sync read it unscoped through executeRaw'), sourceId); }
  listQuarantinedSlugs(sourceId: string) { return sourcesImpl.listQuarantinedSlugs(unscopedExecutor(this.engineSql, 'sources: extraction read it unscoped through executeRaw'), sourceId); }
  readRenameIdentityRows(sourceId: string, paths: readonly string[], slugs: readonly string[]) { return sourcesImpl.readRenameIdentityRows(unscopedExecutor(this.engineSql, 'sources: the rename identity check read it unscoped through executeRaw'), sourceId, paths, slugs); }
  readLiveIdentityHolders(sourceId: string, ids: readonly string[], titles: readonly string[]) { return sourcesImpl.readLiveIdentityHolders(unscopedExecutor(this.engineSql, 'sources: the rename identity check read it unscoped through executeRaw'), sourceId, ids, titles); }
  advanceSourceCommit(sourceId: string, commit: string, newestContentAt?: string | null) { return sourcesImpl.advanceSourceCommit(this.engineSql, sourceId, commit, newestContentAt); }
  async countRepoBoundSources(): Promise<number> {
    return sourcesImpl.countRepoBoundSources(unscopedExecutor(this.engineSql, 'sources: unscoped on master (the readiness sync probe read it through executeRaw)'));
  }

  async claimNotifierLease(l: notifierImpl.NotifierLeaseClaimInput): Promise<notifierImpl.NotifierLeaseClaim> {
    return notifierImpl.claimNotifierLease(this.engineSql, l);
  }

  async readNotifierLease(hostId: string): Promise<notifierImpl.NotifierLeaseHolder | null> {
    return notifierImpl.readNotifierLease(this.engineSql, hostId);
  }

  async holdsNotifierLease(hostId: string, ownerId: string, fence: number): Promise<boolean> {
    return notifierImpl.holdsNotifierLease(this.engineSql, hostId, ownerId, fence);
  }

  async releaseNotifierLease(hostId: string, ownerId: string): Promise<void> {
    return notifierImpl.releaseNotifierLease(this.engineSql, hostId, ownerId);
  }

  async listNotifierHostSourceRows(): Promise<notifierImpl.NotifierHostSourceRow[]> {
    return notifierImpl.listNotifierHostSourceRows(unscopedExecutor(this.engineSql, 'notifier: unscoped on master (the resident read its host sources through executeRaw)'));
  }

  async readNotifierSources(sourceIds: string[] | null): Promise<notifierImpl.NotifierSourceRow[]> {
    return notifierImpl.readNotifierSources(this.engineSql, sourceIds);
  }

  async writeNotifierState(sourceId: string, patch: notifierImpl.StatePatch): Promise<void> {
    return notifierImpl.writeNotifierState(this.engineSql, sourceId, patch);
  }

  async writeNotifierCoverage(sourceId: string, coverage: notifierImpl.Coverage): Promise<void> {
    return notifierImpl.writeNotifierCoverage(this.engineSql, sourceId, coverage);
  }

  async recordNotifierSyncerHost(sourceId: string, hostId: string): Promise<void> {
    return notifierImpl.recordNotifierSyncerHost(this.engineSql, sourceId, hostId);
  }

  async readNotifierStatusRows(sourceIds: string[] | null): Promise<notifierImpl.NotifierStatusRow[]> {
    return notifierImpl.readNotifierStatusRows(unscopedExecutor(this.engineSql, 'notifier: unscoped on master (the freshness notice read its status rows through executeRaw)'), sourceIds);
  }

  async hasNotifierCoverage(): Promise<boolean> {
    return notifierImpl.hasNotifierCoverage(this.engineSql);
  }

  async upsertWantedMarker(marker: notifierImpl.WantedMarkerInput): Promise<notifierImpl.WantedMarker | null> {
    return notifierImpl.upsertWantedMarker(this.engineSql, marker);
  }

  async attachWantedMarkerJob(sourceId: string, intent: notifierImpl.MarkerIntent, generation: number, jobId: number): Promise<void> {
    return notifierImpl.attachWantedMarkerJob(this.engineSql, sourceId, intent, generation, jobId);
  }

  async readWantedMarkers(sourceIds: string[] | null): Promise<notifierImpl.WantedMarker[]> {
    return notifierImpl.readWantedMarkers(this.engineSql, sourceIds);
  }

  async readDueWantedMarkers(sourceIds: string[] | null): Promise<notifierImpl.WantedMarker[]> {
    return notifierImpl.readDueWantedMarkers(this.engineSql, sourceIds);
  }

  async pruneSatisfiedWantedMarkers(sourceIds: string[]): Promise<void> {
    return notifierImpl.pruneSatisfiedWantedMarkers(this.engineSql, sourceIds);
  }

  async clearWantedMarker(sourceId: string, intent: notifierImpl.MarkerIntent, generation: number): Promise<boolean> {
    return notifierImpl.clearWantedMarker(this.engineSql, sourceId, intent, generation);
  }

  async settleFreshnessMarker(sourceId: string, generation: number, checkoutHead: string | null): Promise<void> {
    return notifierImpl.settleFreshnessMarker(this.engineSql, sourceId, generation, checkoutHead);
  }

  async listSourceWantedMarkers(sourceId: string): Promise<notifierImpl.PendingWantedMarker[]> {
    return notifierImpl.listSourceWantedMarkers(this.engineSql, sourceId);
  }
  async readFirstDue(sourceIds: string[]): Promise<notifierImpl.FirstDueRow[]> { return notifierImpl.readFirstDue(this.engineSql, sourceIds); }

  async listSourceLocalPaths(): Promise<string[]> {
    return sourcesImpl.listSourceLocalPaths(unscopedExecutor(this.engineSql, 'sources: unscoped on master (the filesystem lock read it through executeRaw)'));
  }

  // The CLI import and extract reads that ran unscoped through executeRaw (engine-sql/cli-reads-import.ts), on the current connection.
  private get cliReads() { return unscopedExecutor(this.engineSql, 'cli reads: the import and extract paths ran these unscoped through executeRaw'); }
  listSourceRecords() { return cliReadsImpl.listSourceRecords(this.cliReads); }
  readSourceIncarnation(sourceId: string) { return cliReadsImpl.readSourceIncarnation(this.cliReads, sourceId); }
  readSyncDispatchRow(sourceId: string) { return syncDispatchImpl.readSyncDispatchRow(this, sourceId); }
  hasCompanyBrainReceipt(sourceId: string) { return cliReadsImpl.hasCompanyBrainReceipt(this.cliReads, sourceId); }
  readGuestSourceRow(sourceId: string) { return cliReadsImpl.readGuestSourceRow(this.cliReads, sourceId); }
  listGuestSourceIds(sourceIds: readonly string[]) { return cliReadsImpl.listGuestSourceIds(this.cliReads, sourceIds); }
  hasGuestSource() { return cliReadsImpl.hasGuestSource(this.cliReads); }
  readPageTrustRows(lookup: PageTrustLookup) { return cliReadsImpl.readPageTrustRows(this.cliReads, lookup); }
  readRowTrustRows(lookup: RowTrustLookup) { return cliReadsImpl.readRowTrustRows(this.cliReads, lookup); }
  readDatabaseClock() { return cliReadsImpl.readDatabaseClock(this.cliReads); }
  /** Page-write reads (engine-sql/write-misc.ts). */
  private get writeMiscReads() { return unscopedExecutor(this.engineSql, 'write misc: page writes ran these unscoped through executeRaw'); }
  readSourceState(sourceId: string, opts?: writeMiscImpl.SourceStateOptions) { return writeMiscImpl.readSourceState(this.writeMiscReads, sourceId, opts); }
  readAdmissionSource(sourceId: string) { return writeMiscImpl.readAdmissionSource(this.writeMiscReads, sourceId); }
  sharedSkillPackTablePresent() { return writeMiscImpl.sharedSkillPackTablePresent(this.writeMiscReads); }
  listSharedSkillPackRoots(hostId: string) { return writeMiscImpl.listSharedSkillPackRoots(this.writeMiscReads, hostId); }
  getWorktreeBinding(sourceId: string, hostId: string | null) { return writeMiscImpl.getWorktreeBinding(this.writeMiscReads, sourceId, hostId); }
  worktreeClaimStore(): Promise<WorktreeClaimStore> { return worktreeClaimImpl.worktreeClaimStore(this); }
  readWriterAdminState(opts?: WriterAdminStateOptions): Promise<string> { return writerAdminImpl.readWriterAdminState(this, opts); }
  writerAdminStore(): Promise<WriterAdminStore> { return writerAdminImpl.writerAdminStore(this); }
  hasExtractedEvents(sourceId: string, pageId: number) { return writeMiscImpl.hasExtractedEvents(this.writeMiscReads, sourceId, pageId); }
  listActiveAccessMembers() { return writeMiscImpl.listActiveAccessMembers(this.writeMiscReads); }
  hasLabelledOnlyMember() { return writeMiscImpl.hasLabelledOnlyMember(this.writeMiscReads); }
  listAccessTokens() { return writeMiscImpl.listAccessTokens(this.writeMiscReads); }
  readOpCheckpointKeys(op: string, fingerprint: string) { return writeMiscImpl.readOpCheckpointKeys(this.writeMiscReads, op, fingerprint); }
  // Resumable-op checkpoint writes (engine-sql/op-checkpoint.ts) run on executeRawDirect and the purge on executeRaw, as op-checkpoint.ts ran them.
  writeOpCheckpointKeys(op: string, fingerprint: string, keys: string[]) { return opCheckpointImpl.writeOpCheckpointKeys(this, op, fingerprint, keys); }
  appendOpCheckpointPaths(op: string, fingerprint: string, paths: string[]) { return opCheckpointImpl.appendOpCheckpointPaths(this, op, fingerprint, paths); }
  deleteOpCheckpoint(op: string, fingerprint: string) { return opCheckpointImpl.deleteOpCheckpoint(this, op, fingerprint); }
  deleteOpCheckpointPaths(op: string, fingerprint: string) { return opCheckpointImpl.deleteOpCheckpointPaths(this, op, fingerprint); }
  purgeStaleCheckpoints(ttlDays: number) { return opCheckpointImpl.purgeStaleCheckpoints(this, ttlDays); }
  /** Write attribution reads (engine-sql/write-attribution.ts). */
  private get attributionReads() { return unscopedExecutor(this.engineSql, 'write attribution: get_write_attribution ran these unscoped through executeRaw'); }
  readWriteAttributionNames(ids: WriteAttributionNameIds) { return writeAttributionImpl.readWriteAttributionNames(this.attributionReads, ids); }
  readPageRevisionAttribution(pageId: number) { return writeAttributionImpl.readPageRevisionAttribution(this.attributionReads, pageId); }
  readVersionAttributions(versions: VersionRef[]) { return writeAttributionImpl.readVersionAttributions(this.attributionReads, versions); }
  readOldestVersionAttribution(pageId: number) { return writeAttributionImpl.readOldestVersionAttribution(this.attributionReads, pageId); }
  readRowAttribution(target: RowAttributionTarget) { return writeAttributionImpl.readRowAttribution(this.attributionReads, target); }
  readHealthMemoClock() { return writeMiscImpl.readHealthMemoClock(this.writeMiscReads); }
  listSynopsisSourceIds() { return writeMiscImpl.listSynopsisSourceIds(this.writeMiscReads); }
  readSynopsisTierSources(skipFrontmatter: boolean) { return synopsisTierImpl.readSynopsisTierSources(this, skipFrontmatter); }
  setSourceContextualMode(sourceId: string, mode: string | null) { return sourceCrModeImpl.setSourceContextualMode(this, sourceId, mode); }
  expireMemoryProposals(reason: string) { return writeMiscImpl.expireMemoryProposals(this.engineSql, reason); }
  listAwaitingMemoryProposals(limit: number) { return writeMiscImpl.listAwaitingMemoryProposals(this.writeMiscReads, limit); }
  readMemoryProposal(principalKind: string, principalId: string, requestId: string) { return writeMiscImpl.readMemoryProposal(this.writeMiscReads, principalKind, principalId, requestId); }
  purgeMemoryProposals(retentionDays: number) { return writeMiscImpl.purgeMemoryProposals(this.engineSql, retentionDays); }
  readPendingProposalSummary() { return writeMiscImpl.readPendingProposalSummary(this.writeMiscReads); }
  listMemoryProposalRows(query: writeMiscImpl.ProposalListQuery) { return writeMiscImpl.listMemoryProposalRows(this.writeMiscReads, query); }
  listOwnerProposalRows(requestId: string) { return writeMiscImpl.listOwnerProposalRows(this.writeMiscReads, requestId); }
  attachSourcePath(sourceId: string, localPath: string, opts?: writeMiscImpl.AttachSourcePathOptions) { return writeMiscImpl.attachSourcePath(this.engineSql, sourceId, localPath, opts); }
  listLinkPageMetadata(sourceId?: string) { return cliReadsImpl.listLinkPageMetadata(this.cliReads, sourceId); }
  listLinkPageMetadataForSlugs(sourceId: string, slugs: readonly string[]) { return cliReadsImpl.listLinkPageMetadataForSlugs(this.cliReads, sourceId, slugs); }
  listAttendedOriginSlugs(sourceId: string, slugs?: readonly string[]) { return cliReadsImpl.listAttendedOriginSlugs(this.cliReads, sourceId, slugs); }
  listStoredTimelineRows(sourceId: string, slug: string) { return cliReadsImpl.listStoredTimelineRows(this.cliReads, sourceId, slug); }
  filterPagesAtRevision(refs: readonly PageAtRevisionRef[]) { return cliReadsImpl.filterPagesAtRevision(this.cliReads, refs); }

  // v0.37.0 — domain-bank engine methods (D14 + D5 + D10).
  // See postgres-engine.ts:listPrefixSampledPages for the ranking + source-scope rationale.
  // PGLite runs the same SQL (Postgres 17.5 under the hood) with positional `$N` binding.
  async listPrefixSampledPages(opts: DomainBankSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listPrefixSampledPages(async read => read(scopedRead(this.engineSql)), opts);
  }

  async listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listCorpusSample(async read => read(scopedRead(this.engineSql)), opts);
  }

  bumpPageRetrievals(pageIds: number[]) { return pagesImpl.bumpPageRetrievals(this.engineSql, pageIds); }

  async resolveSlugs(partial: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<string[]> {
    return pagesImpl.resolveSlugs(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), partial, opts);
  }

  // Search
  //
  // v0.20.0 Cathedral II Layer 3 (1b): keyword search now ranks at
  // chunk-grain internally using content_chunks.search_vector, then dedups
  // to best-chunk-per-page on the way out. External shape (page-grain,
  // one row per matched page, best chunk selected) is identical to
  // v0.19.0 — backlinks, enrichment-service.countMentions, list_pages,
  // etc. all see the same contract. A2 two-pass (Layer 7) consumes
  // searchKeywordChunks for raw chunk-grain results without the dedup.
  //
  // The DISTINCT ON pattern is translated into a two-stage query because
  // PGLite's query planner handles CTEs-with-DISTINCT-ON less optimally
  // than direct window function + GROUP BY. Fetch more chunks than the
  // page limit (3x) to ensure N dedup'd pages survive; bounded and fast.
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const settle = await beforePlannerRead(this, this._pageTransaction);
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }

    // Fetch 3x to give dedup headroom, then page-dedup + re-limit.
    const innerLimit = Math.min(limit * 3, searchLimitCap() * 3);

    // Source-aware ranking (v0.22): see postgres-engine.ts for rationale.
    const boostMap = opts?.source_boosts ?? resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    // v0.26.5: visibility filter (soft-deleted + archived-source).
    const visibilityClause = buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' });

    // v0.32.7: CJK query branch. PGLite uses websearch_to_tsquery('english')
    // which can't tokenize CJK; queries return empty. Switch to ILIKE on
    // chunk_text with term-frequency-count ranking when the query contains
    // CJK characters. ASCII path stays exactly the same below.
    if (hasCJK(query)) {
      return this._searchKeywordCJK(query, {
        limit, offset, innerLimit, sourceFactorCase,
        hardExcludeClause, visibilityClause, detailFilter, opts,
        dedup: true,
      }).finally(settle);
    }

    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    const params: unknown[] = [collapseWebsearchDashRuns(query), innerLimit, limit, offset];
    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }
    // v0.33: multi-type filter for whoknows.
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      extraFilter += ` AND p.type = ANY($${params.length}::text[])`;
    }
    extraFilter += frontmatterWhereSql('p', opts?.where, json => `$${params.push(json)}`);
    // Postgres parity: single-type filter and exact-slug excludes.
    if (opts?.type) {
      params.push(opts.type);
      extraFilter += ` AND p.type = $${params.length}`;
    }
    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs);
      extraFilter += ` AND p.slug != ALL($${params.length}::text[])`;
    }
    // v0.29.1 — since/until date filter (Postgres parity, codex pass-1 #10).
    // Reads against COALESCE(effective_date, updated_at) so date filtering
    // matches user intent (a meeting was on its event_date, not when it
    // got reimported). Same param shape as Postgres engine.
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation. Array wins over scalar.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();
    const rankIdx = opts?.rankQuery ? params.push(opts.rankQuery) - 1 : opts?.orFallback ? params.push(params[0]) - 1 : 0;
    const rankParam = `$${rankIdx + 1}`;

    const keywordSql =
      `WITH ranked AS (
         SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY page_id ORDER BY score DESC, chunk_id ASC) AS page_rank FROM (SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id,
           p.effective_date, p.effective_date_source,
           CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
             THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
           CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
             THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           ts_rank(cc.search_vector, websearch_to_tsquery('${ftsLang}', ${rankParam})) * ${keywordPhraseFactorSql(ftsLang, rankParam, opts?.keywordPhrase === true)} * ${sourceFactorCase} AS score,
           CASE WHEN p.updated_at < (
             SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
           ) THEN true ELSE false END AS stale
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.search_vector @@ websearch_to_tsquery('${ftsLang}', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
           -- v0.27.1: hide image rows from default text-keyword search so
           -- OCR text doesn't drown text-page hits. Image-similarity queries
           -- run a separate vector path on embedding_image.
           AND cc.modality = 'text') matched) per_page WHERE page_rank = 1
         ORDER BY score DESC, page_id ASC, chunk_id ASC
         LIMIT $2
       ),
       ${buildBestPerPagePoolCte('ranked')}
       SELECT * FROM best_per_page
       ORDER BY score DESC, page_id ASC, chunk_id ASC
       LIMIT $3 OFFSET $4`;

    const { rows: strict } = opts?.orFill ? { rows: [] } : await this.db.query(keywordSql, params);
    // D2 fix (fix/title-retrieval-arm): when the strict AND finds nothing,
    // retry ONCE with OR-of-terms. Opt-in via SearchOpts.orFallback (Reviewer
    // F1): only hybridSearch's recall arm relaxes; precision consumers keep
    // the strict-AND contract. #7491: the identifier probe and the
    // relaxed-row tag (#3617 follow-up) live in search/keyword-identifier-probe.ts.
    const run = async (matchQuery: string, rankQuery: string) => (await this.db.query(keywordSql, params.map((v, i) => i === 0 ? matchQuery : i === rankIdx && !opts?.rankQuery ? rankQuery : v))).rows as Record<string, unknown>[];
    return keywordArmRows({ query, strict: strict as Record<string, unknown>[], orFallback: opts?.orFallback, orFill: opts?.orFill, limit, offset, toResult: rowToSearchResult, runProbe: run, onIncomplete: opts?.onKeywordIncomplete,
      runHandles: handles => keywordPagesImpl.searchHandlePages(async (read) => read(scopedRead(this.engineSql)), query, handles, opts, limit, {}),
      runRelaxed: async orQuery => rankOrFallbackByRarity({ query, rows: await run(orQuery, orQuery), limit, offset, runRare: q => run(q, orQuery),
        readTermPages: async terms => (await this.db.query(rareTermPagesSql(ftsLang), [terms, RARE_TERM_CHUNK_CAP])).rows as RareTermPages[] }) }).finally(settle);
  }

  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm. SQL lives
   * once in engine-sql/titles.ts (exact-title key #5889, index-backed remote
   * predicate). CJK queries fall through to websearch FTS (a single-token CJK
   * query CAN exact-match a single-token CJK title); the richer CJK ILIKE
   * fallback stays keyword-arm-only.
   */
  /** Cat 40 Hard F2 strict keyword count and keyword-mode pages; SQL in engine-sql/keyword-pages.ts. */
  async countKeywordPages(query: string, opts?: SearchOpts & { timeoutMs?: number }): Promise<number> {
    return keywordPagesImpl.countKeywordPages(async (read) => read(scopedRead(this.engineSql)), query, opts, {});
  }
  async searchKeywordPages(query: string, opts: SearchOpts | undefined, page: KeywordPageWindow): Promise<SearchResult[]> {
    return keywordPagesImpl.searchKeywordPages(async (read) => read(scopedRead(this.engineSql)), query, opts, page, {});
  }

  async searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    return titlesImpl.searchTitles(async (read) => read(scopedRead(this.engineSql)), query, opts, { relaxedPrefersIndex: false, staleProbe: true });
  }

  /**
   * v0.32.7 CJK keyword fallback. PGLite's `websearch_to_tsquery('english')`
   * can't tokenize CJK so the FTS path returns empty for Chinese / Japanese /
   * Korean queries. This routes to an ILIKE substring scan with
   * term-frequency-count ranking as a ts_rank substitute.
   *
   * Multi-term CJK queries are split via splitCJKQueryTerms and matched
   * conjunctively (AND) so that documents containing all terms match
   * regardless of token order (e.g. Korean / Japanese free word order and particles).
   *
   * Ranking rules:
   *   - Individual term occurrences are summed via replace/length arithmetic.
   *   - Contiguous match of the full raw query receives bonus weight.
   *   - POSITION()-tiebreaker ensures earlier hits outrank later hits.
   *   - Single-term queries preserve identical ranking to the single-token path.
   *
   * Parameter bindings:
   *   - LIKE parameters are individually escaped with escapeLikePattern and wrapped with %.
   *   - Raw terms and raw query are bound unescaped for ranking arithmetic.
   *   - Explicit `ESCAPE '\'` on ILIKE clauses.
   *   - Symmetric: no asymmetric whitespace strip on chunk_text.
   *   - Empty-query guard returns no results without binding SQL.
   *
   * #3986: the Postgres engine carries the same fallback (shared SQL
   * builder in src/core/search/cjk-keyword-sql.ts), pinned by the
   * DATABASE_URL-gated engine-parity e2e.
   */
  private async _searchKeywordCJK(
    query: string,
    ctx: {
      limit: number;
      offset: number;
      innerLimit: number;
      sourceFactorCase: string;
      hardExcludeClause: string;
      visibilityClause: string;
      detailFilter: string;
      opts: SearchOpts | undefined;
      dedup: boolean;
    },
  ): Promise<SearchResult[]> {
    return searchKeywordCJK(async (read) => read(scopedRead(this.engineSql)), query, ctx, 'pglite');
  }

  /**
   * v0.20.0 Cathedral II Layer 3 (1b) chunk-grain keyword search.
   *
   * Ranks at chunk grain via content_chunks.search_vector WITHOUT the
   * dedup-to-page pass that searchKeyword applies on return. Used by
   * A2 two-pass retrieval (Layer 7) as the anchor-discovery primitive:
   * two-pass wants the top-N chunks (regardless of page), not the
   * best chunk per top-N pages.
   *
   * Most callers should prefer searchKeyword (external page-grain
   * contract). This method is intentionally a narrow internal knob.
   */
  async searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }

    // Source-aware ranking applied here too — searchKeywordChunks is the
    // chunk-grain anchor primitive that two-pass retrieval (Layer 7) uses.
    const boostMap = opts?.source_boosts ?? resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    const visibilityClause = buildVisibilityClause('p', 's', { ...opts, chunkAlias: 'cc' });

    // v0.32.7: CJK branch (same as searchKeyword but without page-dedup).
    if (hasCJK(query)) {
      return this._searchKeywordCJK(query, {
        limit, offset,
        innerLimit: 0,             // unused on chunk-grain (no inner CTE)
        sourceFactorCase,
        hardExcludeClause, visibilityClause, detailFilter, opts,
        dedup: false,
      });
    }

    const params: unknown[] = [collapseWebsearchDashRuns(query), limit, offset];
    let extraFilter = '';
    // Postgres parity: the page filters (single type, multi-type, frontmatter where, exact-slug excludes).
    if (opts?.type) {
      params.push(opts.type);
      extraFilter += ` AND p.type = $${params.length}`;
    }
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      extraFilter += ` AND p.type = ANY($${params.length}::text[])`;
    }
    extraFilter += frontmatterWhereSql('p', opts?.where, json => `$${params.push(json)}`);
    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs);
      extraFilter += ` AND p.slug != ALL($${params.length}::text[])`;
    }
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }
    // v0.29.1 since/until parity (codex pass-1 #10).
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.afterDateInclusive ? '>=' : '>'} $${params.length}::text::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) ${opts?.beforeDateInclusive ? '<=' : '<'} $${params.length}::text::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation for the chunk-grain
    // anchor primitive. Layer 7 two-pass walks from these anchors so a
    // foreign-source anchor would let the walk leak into foreign neighbors.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    // visibilityClause already declared above (v0.32.7: hoisted so CJK branch can reuse).
    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();

    const { rows } = await this.db.query(
      `SELECT
         p.slug, p.id as page_id, p.title, p.type, p.source_id,
         p.effective_date, p.effective_date_source,
         CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
           THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
         CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
           THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
         cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
         ts_rank(cc.search_vector, websearch_to_tsquery('${ftsLang}', $1)) * ${sourceFactorCase} AS score,
         CASE WHEN p.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
         ) THEN true ELSE false END AS stale
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       JOIN sources s ON s.id = p.source_id
       WHERE cc.search_vector @@ websearch_to_tsquery('${ftsLang}', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
       ORDER BY score DESC, page_id ASC, chunk_id ASC
       LIMIT $2 OFFSET $3`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const settle = await beforePlannerRead(this, this._pageTransaction);
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }
    // Same statement as postgres-engine (search/vector-statement.ts); the
    // PGLite dialect adds the timeline `stale` flag and has no exact fallback.
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding, limit, offset: opts?.offset || 0, opts, scope: await this.vectorScope(opts) });
    this.vectorIterativeScan ??= this.executeRaw<{ extversion: string }>(VECTOR_EXTENSION_VERSION_SQL)
      .then(rows => supportsHnswIterativeScan(rows[0]?.extversion));
    const probe = this.vectorIterativeScan;
    let iterative: boolean;
    try { iterative = await probe; }
    catch (error) {
      if (this.vectorIterativeScan === probe) this.vectorIterativeScan = undefined;
      throw error;
    }
    const attempt = ({ innerLimit: requested, maxScanTuples, indexWalk, scopeScan }: VectorPoolAttempt) => this.db.transaction(async tx => withVectorSettings(
      async (sql, values) => (await tx.query<Record<string, unknown>>(sql, values)).rows, iterative, requested, maxScanTuples, async () => {
        const bound = [...stmt.params];
        bound[stmt.innerLimitIdx] = requested;
        return readVectorPool((await tx.query<Record<string, unknown>>(scopeScan && stmt.scopeScanSql || indexWalk && stmt.indexWalkSql || stmt.sql, bound)).rows);
      }, undefined, opts?.hnswIterativeScan, indexWalk && stmt.indexWalkSql ? stmt.indexWalkOverfetch : undefined, !!stmt.indexWalkSql && !indexWalk && !(scopeScan && stmt.scopeScanSql)));
    const rows = await searchIndexWalk(stmt, limit, attempt) ?? await searchVectorPool(limit, stmt.innerLimit, iterative, stmt.indexed, 'pglite',
      attempt,
      async pool => {
        const { rows } = await this.db.query<{ eligible: number }>(stmt.hasMoreSql, [...stmt.params.slice(0, stmt.innerLimitIdx), pool + 1]);
        return Number(rows[0].eligible) > pool;
      },
      opts?.onVectorPoolMeta,
    );
    settle();
    return rows.map(rowToSearchResult);
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
  async readBrainMaturity() { return healthImpl.readBrainMaturity(this.searchRead); }
  private get linkRead() { return unscopedExecutor(this.engineSql, 'link reads: master engine.executeRaw, unscoped'); }
  inboundLinkCoverage(opts?: { sourceIds?: string[] }) { return linkReadsImpl.inboundLinkCoverage(this.linkRead, opts); }
  listJunkEntityHubs(opts: { edgeThreshold: number; maxChunks: number; limit: number }) { return linkReadsImpl.listJunkEntityHubs(this.linkRead, opts); }
  countEntityPages(filter: import('./schema-pack/entity-types.ts').EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }) { return linkReadsImpl.countEntityPages(this.linkRead, filter, opts); }
  entityGraphCoverage(filter: import('./schema-pack/entity-types.ts').EntityTypeFilter) { return linkReadsImpl.entityGraphCoverage(this.linkRead, filter); }
  countForeignEdges(slug: string, sourceId: string, direction: 'in' | 'out' | 'both') { return linkReadsImpl.countForeignEdges(this.linkRead, slug, sourceId, direction); }
  listLivePageSummaries(scope?: PageReadScope) { return linkReadsImpl.listLivePageSummaries(this.linkRead, scope); }
  countInboundLinks(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }) { return linkReadsImpl.countInboundLinks(this.linkRead, slug, sourceId, opts); }
  readEntityInboundEdges(slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }) { return linkReadsImpl.readEntityInboundEdges(this.linkRead, slug, sourceId, opts); }
  listLinkEndpointPages(sourceId: string, slugs: string[], crossSourceSlugs: string[]) { return linkReadsImpl.listLinkEndpointPages(this.linkRead, sourceId, slugs, crossSourceSlugs); }
  listPagesTitledIn(queryLower: string, scope: PageReadScope) { return linkReadsImpl.listPagesTitledIn(this.linkRead, queryLower, scope); }
  wordLexemes(words: string[]) { return linkReadsImpl.wordLexemes(this.linkRead, words); }
  readLinkContextMatches(asks: readonly linkReadsImpl.LinkContextAsk[]) { return linkReadsImpl.readLinkContextMatches(this.linkRead, asks); }
  readLinkContextOriginPages(ids: readonly number[]) { return linkReadsImpl.readLinkContextOriginPages(this.linkRead, ids); }
  private get linkTemporal() { return unscopedExecutor(this.engineSql, 'link temporal: master engine.executeRaw, unscoped'); }
  readLinkRelationshipEvidence(keys: readonly RelationshipKey[]) { return linkTemporalImpl.readLinkRelationshipEvidence(this.linkTemporal, keys); }
  writeLinkRelationshipState(write: RelationshipStateWrite) { return linkTemporalImpl.writeLinkRelationshipState(this.linkTemporal, write); }
  linkRelationshipKeysForPages(pageIds: readonly number[]) { return linkTemporalImpl.linkRelationshipKeysForPages(this.linkTemporal, pageIds); }
  staleLinkRelationshipKeys(limit: number) { return linkTemporalImpl.staleLinkRelationshipKeys(this.linkTemporal, limit); }
  linkRelationshipKeysForOrigin(pageId: number) { return linkTemporalImpl.linkRelationshipKeysForOrigin(this.linkTemporal, pageId); }
  applyLinkTemporalRows(input: linkTemporalImpl.LinkTemporalRows) { return linkTemporalImpl.applyLinkTemporalRows(this.linkTemporal, input); }
  writeManualLinkTransitions(rel: linkTemporalImpl.ManualLinkRelationship, rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>) { return linkTemporalImpl.writeManualLinkTransitions(this.linkTemporal, rel, rows); }
  removeManualLinkTransitions(rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }) { return linkTemporalImpl.removeManualLinkTransitions(this.linkTemporal, rel); }
  listRelationshipNoteRows(subjects: ReadonlyArray<{ slug: string; source_id: string }>, opts: { excludePrivate: boolean }) { return linkTemporalImpl.listRelationshipNoteRows(this.linkTemporal, subjects, opts); }
  edgeValidityCounts(opts: { sourceIds?: readonly string[]; staleLimit: number }) { return linkTemporalImpl.edgeValidityCounts(this.linkTemporal, opts); }
  listPageStatusByRef(refs: ReadonlyArray<{ source_id: string; slug: string }>, scope: { excludePrivate: boolean; includeQuarantined?: boolean }) { return linkTemporalImpl.listPageStatusByRef(this.linkTemporal, refs, scope); }
  listRecordMetadataRows(pageIds: readonly number[], scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }) { return linkTemporalImpl.listRecordMetadataRows(this.linkTemporal, pageIds, scope); }
  countSearchVectorRows() { return searchVectorImpl.countSearchVectorRows(this.linkTemporal); }
  replaceSearchVectorTriggerFunction(target: 'pages' | 'chunks', lang: string) { return searchVectorImpl.replaceSearchVectorTriggerFunction(this.linkTemporal, target, lang); }
  backfillSearchVectors(target: 'pages' | 'chunks', opts: Pick<VectorBackfillOpts, 'lang' | 'checkpoint' | 'tick'>) { return target === 'pages' ? backfillPageVectors(this, opts) : backfillChunkVectors(this, opts); }
  ensureFactsKeywordIndex(lang: string, notice?: (line: string) => void) { return ensureFactsFtsIndex(this, { lang, version: 0, notice }); }
  countPendingProjectionPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance) { return retrievalCoverageImpl.countPendingProjectionPages(this.linkTemporal, scope, relevance); }
  countEmbeddingHeldPages(scope: ProjectionReadinessScope, relevance: CoverageRelevance) { return retrievalCoverageImpl.countEmbeddingHeldPages(this.linkTemporal, scope, relevance); }
  projectionRebuildProgress(scope: ProjectionReadinessScope) { return retrievalCoverageImpl.projectionRebuildProgress(this.linkTemporal, scope); }
  // The readiness probe's statements, through this engine's executeRaw (PGLite has no JIT to turn off).
  readProjectionReadinessGeneration() { return retrievalCoverageImpl.readProjectionReadinessGeneration(this.rawRead); }
  readProjectionReadiness(scope: ProjectionReadinessScope) { return retrievalCoverageImpl.readProjectionReadiness(this.rawRead, scope); }
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
  deleteChunksForPages(pageIds: readonly number[]) { return chunkReadsImpl.deleteChunksForPages(this.engineSql, pageIds); }
  listContextualModeCandidates(sourceIds: string[]) { return chunkReadsImpl.listContextualModeCandidates(this.chunkRead, sourceIds); }
  async resolveFrozenHits(hits: FrozenHitKey[], scope: PageReadScope) { return chunkReadsImpl.resolveFrozenHits(this.chunkRead, hits, scope, true); }
  private get timelineRead() { return unscopedExecutor(this.engineSql, 'timeline reads: master engine.executeRaw, unscoped'); }
  sampleEffectiveDates() { return timelineReadsImpl.sampleEffectiveDates(this.timelineRead); }
  sampleEffectiveDateSources() { return timelineReadsImpl.sampleEffectiveDateSources(this.timelineRead); }
  readMaxTimelineEntryId() { return timelineReadsImpl.readMaxTimelineEntryId(this.timelineRead); }
  listStoredTimelineRowsOrdered(pageId: number) { return timelineReadsImpl.listStoredTimelineRowsOrdered(this.timelineRead, pageId); }
  deleteTimelineRows(pageId: number, deletions: readonly TimelineRowDeletion[]) { return timelineReadsImpl.deleteTimelineRows(this.engineSql, pageId, deletions); }
  storedTimelineRowsByPageIds(pageIds: readonly number[]) { return timelineReadsImpl.storedTimelineRowsByPageIds(this.timelineRead, pageIds); }
  countSegmentedTimelinePages(sourceIds: readonly string[], limit: number) { return timelineReadsImpl.countSegmentedTimelinePages(this.timelineRead, sourceIds, limit); }
  countTimelineCommentMarkupRows(sourceIds: readonly string[]) { return timelineReadsImpl.countTimelineCommentMarkupRows(this.timelineRead, sourceIds); }
  listTimelineOrphanPages(opts: { afterId: number; limit: number; sourceId?: string }) { return timelineReadsImpl.listTimelineOrphanPages(this.timelineRead, opts); }
  private get telemetryRead() { return unscopedExecutor(this.engineSql, 'telemetry reads: master engine.executeRaw, unscoped'); }
  recordSearchTelemetry(bucket: SearchTelemetryBucket) { return telemetryImpl.recordSearchTelemetry(this.engineSql, bucket); }
  readSearchStats(cutoffDate: string) { return telemetryImpl.readSearchStats(this.telemetryRead, cutoffDate); }
  readClientOpUsage(days: number) { return telemetryImpl.readClientOpUsage(this.telemetryRead, days); }
  readMcpRollupPrunedBefore() { return telemetryImpl.readMcpRollupPrunedBefore(this.telemetryRead); }
  logMcpRequest(row: McpRequestLogRow) { return telemetryImpl.logMcpRequest(this.engineSql, row); }
  readMcpLogPruneCutoff(days: number) { return telemetryImpl.readMcpLogPruneCutoff(this.engineSql, days); }
  pruneMcpRequestLogBatch(cutoff: string, keepOperations: readonly string[], limit: number) { return telemetryImpl.pruneMcpRequestLogBatch(this.engineSql, cutoff, keepOperations, limit); }
  readMcpLifetimeUsage(tokenNames: readonly string[]) { return telemetryImpl.readMcpLifetimeUsage(this.telemetryRead, tokenNames); }
  logChatUsage(row: chatUsageImpl.ChatUsageLogRow) { return chatUsageImpl.logChatUsage(this.engineSql, row); }
  readChatUsage(days: number) { return chatUsageImpl.readChatUsage(this.telemetryRead, days); }
  readFieldUsageSamples(query: fieldUsageImpl.FieldUsageQuery) { return fieldUsageImpl.readFieldUsageSamples(unscopedExecutor(this.engineSql, 'field usage samples: master engine.executeRaw, unscoped'), query); }
  private get aliasFanoutRead() { return unscopedExecutor(this.engineSql, 'alias fan-out reads: master engine.executeRaw, unscoped'); }
  findPagesByTitles(titleNorms: readonly string[], sourceIds: readonly string[], types: readonly string[], opts?: { excludePrivate?: boolean }) { return aliasFanoutReadsImpl.findPagesByTitles(this.aliasFanoutRead, titleNorms, sourceIds, types, opts); }
  resolveCaseSensitiveAliases(aliasNorms: readonly string[], sourceIds: readonly string[]) { return aliasFanoutReadsImpl.resolveCaseSensitiveAliases(this.aliasFanoutRead, aliasNorms, sourceIds); }
  readPageTitle(sourceId: string, slug: string) { return aliasFanoutReadsImpl.readPageTitle(this.aliasFanoutRead, sourceId, slug); }
  readPageAliasRows(sourceIds: readonly string[], slugs: readonly string[]) { return aliasFanoutReadsImpl.readPageAliasRows(this.aliasFanoutRead, sourceIds, slugs); }
  readEntityAliasRows(sourceId: string, slugs: readonly string[]) { return aliasFanoutReadsImpl.readEntityAliasRows(this.aliasFanoutRead, sourceId, slugs); }
  listSlugAliases(sourceId: string) { return aliasFanoutReadsImpl.listSlugAliases(this.aliasFanoutRead, sourceId); }

  // v0.41.18.0 — lazy-cached resolveBulkRetryOpts result + batch-retry helper.
  // PGLite has no Postgres pooler so retries don't fire in production; the
  // wrap is for engine-parity tests (T7) and a DI-friendly seam via the
  // existing PGlite test infrastructure. Mirrors postgres-engine.ts.
  private _bulkRetryOptsCache?: ReturnType<typeof resolveBulkRetryOpts>;
  private getBulkRetryOpts(): ReturnType<typeof resolveBulkRetryOpts> {
    if (!this._bulkRetryOptsCache) this._bulkRetryOptsCache = resolveBulkRetryOpts();
    return this._bulkRetryOptsCache;
  }

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
          const delay = computeNextDelay(attempt - 1, prevDelay, opts.delayMs, opts.delayMaxMs, BULK_RETRY_OPTS.jitter);
          prevDelay = delay;
          auditLogBatchRetry(auditSite, batchSize, attempt, delay, err);
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[${auditSite}] connection blip, retrying (attempt ${attempt}/${opts.maxRetries}): ${msg}\n`);
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'RetryAbortError') throw err;
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
      () => this.transaction(tx => (tx as PGLiteEngine)._upsertChunksOnce(slug, chunks, opts)), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true }): Promise<void> {
    return chunksImpl.upsertChunksOnce(this.engineSql, {
      lockPageKeys: (keys) => this.lockPageKeys(keys),
      readPageSnapshot: (pageSlug, snapshotOpts) => this.readPageSnapshot(pageSlug, snapshotOpts),
      memo: (key, read) => transactionMemo(this, key, read),
    }, slug, chunks, opts);
  }

  getChunkWindows(requests: ChunkWindowRequest[], opts: ChunkWindowOpts): Promise<ChunkWindowPage[]> { return chunksImpl.getChunkWindows(scopedRead(this.engineSql), requests, opts); }

  async getChunks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean }): Promise<Chunk[]> {
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = opts?.sourceId ?? 'default';
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.getChunks(scopedRead(this.engineSql), column, slug, { sourceIds, sourceId }, opts);
  }

  async getChunkPage(slug: string, opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; requireSafeChunks?: boolean; fromIndex: number; limit: number }) {
    const sourceIds = opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.getChunkPage(scopedRead(this.engineSql), column, slug, { sourceIds, sourceId: opts.sourceId ?? 'default' }, opts);
  }

  /** S2: quoted identifier of the registry-ACTIVE embedding column for the
   *  health plane (getStats / getHealth) — read-only sites pass fallbackToLegacy
   *  so a broken registry row can't crash diagnostics. Callers prefix the
   *  table alias themselves (`cc.${colId}`). */
  private async activeEmbeddingColId(opts?: { fallbackToLegacy?: boolean }): Promise<string> {
    const col = await resolveActiveEmbeddingColumnFromEngine(this, opts);
    return quoteIdentifier(col.name);
  }

  async countStaleChunks(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.countStaleChunks(scopedRead(this.engineSql), column, opts);
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
    return chunksImpl.listStaleChunks(scopedRead(this.engineSql), column, opts);
  }

  async countChunklessPagesWithContent(opts?: { sourceId?: string }): Promise<number> {
    return chunksImpl.countChunklessPagesWithContent(scopedRead(this.engineSql), opts);
  }

  async listChunklessPagesWithContent(opts?: { batchSize?: number; afterPageId?: number; sourceId?: string }): Promise<ChunklessPageRow[]> {
    return chunksImpl.listChunklessPagesWithContent(scopedRead(this.engineSql), opts);
  }

  async readEmbeddingStateCounts(opts: { mode: 'ops' | 'full'; sourceIds?: string[]; purgeWindowHours: number }): Promise<EmbeddingStateCounts> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.readEmbeddingStateCounts(scopedRead(this.engineSql), column, opts);
  }

  async listEmbeddingStateRows(opts: { sourceIds?: string[]; slugs?: string[]; states: readonly EmbeddingState[]; limit: number; purgeWindowHours: number }): Promise<EmbeddingStateRow[]> {
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return chunksImpl.listEmbeddingStateRows(scopedRead(this.engineSql), column, opts);
  }

  async sealChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; expectedRevision?: string }): Promise<void> {
    await this.transaction(tx => { const e = tx as PGLiteEngine; return chunksImpl.sealChunks(e.engineSql, e, slug, chunks, opts); });
  }

  async ownerOnlyMarkTriggers(opts?: { ensure?: boolean; installing?: boolean }): Promise<OwnerOnlyTriggerState> {
    return ownerOnlyMarksImpl.ownerOnlyMarkTriggers(this.engineSql, opts);
  }

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunks(this.engineSql, slug, opts);
  }

  async deleteChunksExcept(slug: string, keepIds: readonly number[], opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunksExcept(this.engineSql, slug, keepIds, opts);
  }

  async setChunkerVersion(slug: string, version: number, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.setChunkerVersion(this.engineSql, slug, version, opts);
  }

  async writeTextProjectionSeal(slug: string, opts: { sourceId: string; revision: string; timelineText: string }): Promise<void> {
    return chunksImpl.writeTextProjectionSeal(this.engineSql, slug, opts);
  }

  async moveChunkIndexes(pageId: number, waves: readonly (readonly ChunkMove[])[]): Promise<void> {
    return chunksImpl.moveChunkIndexes(this.engineSql, pageId, waves);
  }

  async getChunkReuseRows(slug: string, opts?: { sourceId?: string }): Promise<ChunkReuseRow[]> {
    return chunksImpl.getChunkReuseRows(unscopedExecutor(this.engineSql, 'chunks: import reuse read ran unscoped on the pool on master (executeRaw)'), slug, opts);
  }

  async countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked'; held?: 'exclude' | 'only'; wantedProducers?: readonly string[] }): Promise<number> {
    return pagesImpl.countStalePagesForExtraction(scopedRead(this.engineSql), opts);
  }

  async listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
    held?: 'exclude';
    wantedProducers?: readonly string[];
  }): Promise<StalePageRow[]> {
    return pagesImpl.listStalePagesForExtraction(scopedRead(this.engineSql), opts);
  }

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number> {
    return pagesImpl.markPagesExtractedBatch(this.engineSql, refs, defaultExtractedAt);
  }

  async markPagesAttendanceBlocked(refs: Array<{ slug: string; source_id: string; revision: string }>): Promise<number> {
    return pagesImpl.markPagesAttendanceBlocked(this.engineSql, refs);
  }
  async countStaleFrontmatterKeyPages(opts: { sourceIds: string[] }) { return pagesImpl.countStaleFrontmatterKeyPages(scopedRead(this.engineSql), opts); }
  async listStaleFrontmatterKeyPages(opts: { sourceId: string; afterId: number; limit: number }) { return pagesImpl.listStaleFrontmatterKeyPages(scopedRead(this.engineSql), opts); }
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

  // Wanted-link writes (engine-sql/wanted-links.ts), on the current connection: the caller's transaction when there is one.
  lockRegisteredSourceIds(sourceIds: readonly string[]) { return wantedLinksImpl.lockRegisteredSourceIds(this.engineSql, sourceIds); }
  replaceWantedLinkRows(origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement) {
    return wantedLinksImpl.replaceWantedLinkRows(this.engineSql, origin, replacement);
  }

  // #3674 — see BrainEngine.removeLinksByPagesAndSource JSDoc. Identical SQL
  // shape in PostgresEngine (parity). JSONB recordset binding (never
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
    return linksImpl.getLinks(scopedRead(this.engineSql), slug, opts);
  }

  async getBacklinks(slug: string, opts?: import("./link-validity.ts").LinkReadScope): Promise<Link[]> {
    return plannerRead(this, this._pageTransaction, () => linksImpl.getBacklinks(scopedRead(this.engineSql), slug, opts));
  }

  async listLinkSources(
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]> {
    return linksImpl.listLinkSources(scopedRead(this.engineSql), opts);
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
    sourceId?: string,
  ): Promise<{ slug: string; similarity: number } | null> {
    return pagesImpl.findByTitleFuzzy(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), name, dirPrefix, minSimilarity, sourceId);
  }

  async traverseGraph(
    slug: string,
    depth: number = 5,
    opts?: import('./engine.ts').TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    return plannerRead(this, this._pageTransaction, () => linksImpl.traverseGraph(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), slug, depth, opts));
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
    return plannerRead(this, this._pageTransaction, () => linksImpl.traversePathsDetailed(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), slug, opts));
  }

  async relationalFanout(
    seeds: string[],
    opts?: import('./types.ts').RelationalFanoutOpts,
  ): Promise<import('./types.ts').RelationalFanoutRow[]> {
    return readRelationalFanout(this.executeRaw.bind(this), seeds, opts);
  }

  async relationalChainHop(frontierPageIds: number[], opts: import('./types.ts').ChainHopOpts): Promise<import('./types.ts').ChainHopEdge[]> {
    return readChainHop(this.executeRaw.bind(this), frontierPageIds, opts);
  }

  async getBacklinkCounts(pageIds: number[], opts?: PageReadScope): Promise<Map<number, number>> {
    return readBacklinkCounts(this.executeRaw.bind(this), pageIds, opts);
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
    return plannerRead(this, this._pageTransaction, () => linksImpl.findOrphanPages(unscopedExecutor(this.engineSql, 'links: unscoped on master (EO4 inventory)'), opts));
  }

  // Tags
  async addTag(slug: string, tag: string, opts?: { sourceId?: string; tagSource?: 'frontmatter' }): Promise<void> {
    return mutatePageTag(this, { sourceId: opts?.sourceId ?? 'default', slug }, tag, true, opts?.tagSource);
  }

  async removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    return mutatePageTag(this, { sourceId: opts?.sourceId ?? 'default', slug }, tag, false);
  }

  async pruneFrontmatterTags(slug: string, keep: readonly string[], opts?: { sourceId?: string }): Promise<void> {
    return tagsImpl.pruneFrontmatterTags(this.engineSql, slug, keep, opts);
  }

  async addPageTagsById(pageId: number, tags: readonly string[], opts?: { tagSource?: 'frontmatter' }): Promise<void> {
    return tagsImpl.addPageTagsById(this.engineSql, pageId, tags, opts);
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

  removeTimelineRows(pageId: number, rows: readonly timelineImpl.TimelineRowRemoval[]) { return timelineImpl.removeTimelineRows(this.engineSql, pageId, rows); }
  updateTimelineDetails(pageId: number, rows: readonly timelineImpl.TimelineDetailRefresh[]) { return timelineImpl.updateTimelineDetails(this.engineSql, pageId, rows); }
  insertCanonicalTimelineRows(pageId: number, rows: readonly timelineImpl.CanonicalTimelineRow[]) { return timelineImpl.insertCanonicalTimelineRows(this.engineSql, pageId, rows); }

  async mergeOntologyFact(obs: OntologyObservationInput): Promise<OntologyMergeResult> {
    const sourceId = obs.sourceId ?? 'default';
    const dimension = normalizeDimension(obs.dimension);
    const vh = valueHash(obs.value);
    const conf = obs.confidence ?? 0.7;
    const status = obs.status ?? (isNovelDimension(dimension) ? 'quarantined' : 'active');
    const visibility = obs.visibility ?? 'private';
    const validFrom = obs.validFrom ?? null;
    const validUntil = obs.validTo ?? null;
    const factText = `${dimension}: ${obs.value}`;

    // "current open" = open-ended (valid_until IS NULL) + not retracted.
    const cur = await this.db.query(
      `SELECT id, value_hash, valid_from FROM facts
        WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND expired_at IS NULL AND valid_until IS NULL
          AND (dim_status IS NULL OR dim_status = 'active') AND ${NOT_CONVERSATION_SLOT_SQL}
        ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`,
      [sourceId, obs.entitySlug, dimension],
    );
    const current = cur.rows[0] as { id: number; value_hash: string; valid_from: string | null } | undefined;
    // GBRA-574 B2: a conversation fact holding this exact stint key gives up its slot, so the observation is stored.
    const freeKey = () => validFrom == null ? null : this.db.query(
      `UPDATE facts SET dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
        WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND value_hash = $4 AND source_markdown_slug = $5
          AND valid_from = $6::timestamptz AND ${CONVERSATION_SLOT_SQL}`,
      [sourceId, obs.entitySlug, dimension, vh, obs.source, validFrom],
    );

    if (current && current.value_hash === vh && !isBackdatedObservation(validFrom, current.valid_from)) {
      // This provenance already observed the value during the current stint.
      const seen = await this.db.query(
        `SELECT 1 FROM facts
          WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND value_hash = $4 AND source_markdown_slug = $5 AND ${NOT_CONVERSATION_SLOT_SQL}
            AND COALESCE(valid_from,'-infinity'::timestamptz) >= COALESCE($6::timestamptz,'-infinity'::timestamptz) LIMIT 1`,
        [sourceId, obs.entitySlug, dimension, vh, obs.source, current.valid_from],
      );
      if (seen.rows.length) return { action: 'noop', factId: null, supersededId: null };
      await freeKey();
      const ins = await this.db.query(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                            confidence, source, source_markdown_slug, valid_from, valid_until, expired_at, consolidated_into)
         VALUES ($1,$2,$3,'fact',$4,$5,$6,$7,$8,$9,$10,$10,COALESCE($11::timestamptz, now()),$12, now(), $13)
         ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from) WHERE dimension IS NOT NULL
         DO NOTHING RETURNING id`,
        [sourceId, obs.entitySlug, factText, visibility, dimension, obs.value, vh, status, conf, obs.source, validFrom, validUntil, current.id],
      );
      return ins.rows.length
        ? { action: 'corroborated', factId: Number((ins.rows[0] as { id: number }).id), supersededId: null }
        : { action: 'noop', factId: null, supersededId: null };
    }

    await freeKey();
    const ins = await this.db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                          confidence, source, source_markdown_slug, valid_from, valid_until)
       VALUES ($1,$2,$3,'fact',$4,$5,$6,$7,$8,$9,$10,$10,COALESCE($11::timestamptz, now()),$12)
       ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from) WHERE dimension IS NOT NULL
       DO NOTHING RETURNING id`,
      [sourceId, obs.entitySlug, factText, visibility, dimension, obs.value, vh, status, conf, obs.source, validFrom, validUntil],
    );
    if (!ins.rows.length) return { action: 'noop', factId: null, supersededId: null };
    const newId = Number((ins.rows[0] as { id: number }).id);

    let supersededId: number | null = null;
    if (current && status === 'active') {
      const forward = validFrom == null || current.valid_from == null
        || new Date(validFrom).getTime() >= new Date(current.valid_from).getTime();
      if (forward) {
        const closed = await this.db.query(
          `UPDATE facts SET valid_until = COALESCE($1::timestamptz, now()), superseded_by = $2 WHERE id = $3 AND valid_until IS NULL${ONTOLOGY_SUPERSEDE_GUARD} RETURNING id`,
          [validFrom, newId, current.id],
        );
        supersededId = closed.rows.length ? current.id : null;
      }
    }
    return { action: supersededId ? 'superseded_prior' : 'inserted', factId: newId, supersededId };
  }

  async getOntology(entitySlug: string, opts?: OntologyReadOpts): Promise<OntologyValue[]> {
    const minConf = opts?.minConfidence ?? 0;
    const includeQ = opts?.includeQuarantined ?? false;
    const asof = opts?.asof ?? null;
    const params: unknown[] = [entitySlug, asof, minConf, includeQ];
    let scope: string;
    if (opts?.sourceIds && opts.sourceIds.length) { params.push(opts.sourceIds); scope = `AND source_id = ANY($${params.length})`; }
    else { params.push(opts?.sourceId ?? null); scope = `AND ($${params.length}::text IS NULL OR source_id = $${params.length})`; }
    // Page-visibility gate on the provenance and entity pages, applied BEFORE DISTINCT ON
    // so the untrusted caller resolves the newest value they may see; a deleted page's observations are hidden for everyone.
    const privacy = `AND ${deletedPageProjectionHiddenSql('facts', 'facts')}${opts?.excludePrivate ? ` AND ${privateFactFilterForReader('facts')}` : ''}${opts?.excludeDiary ? ` AND NOT starts_with(COALESCE(source_markdown_slug, ''), 'life/diary/')` : ''}`;
    params.push(opts?.visibility ?? null);
    const visibility = `AND ($${params.length}::text[] IS NULL OR visibility = ANY($${params.length}::text[]))`;
    const r = await this.db.query(
      `SELECT DISTINCT ON (dimension) dimension, value, confidence,
         source_markdown_slug AS source, valid_from, valid_until AS valid_to,
         COALESCE(dim_status,'active') AS status, id AS fact_id
       FROM facts
       WHERE entity_slug = $1 AND dimension IS NOT NULL AND expired_at IS NULL AND ${NOT_CONVERSATION_SLOT_SQL} ${scope} ${privacy} ${visibility}
         AND COALESCE(valid_from,'-infinity'::timestamptz) <= COALESCE($2::timestamptz, now())
         AND COALESCE(valid_until,'infinity'::timestamptz) > COALESCE($2::timestamptz, now())
         AND confidence >= $3
         AND ($4::boolean OR dim_status IS NULL OR dim_status = 'active')
       ORDER BY dimension, valid_from DESC NULLS LAST, confidence DESC, id DESC`,
      params,
    );
    return r.rows.map((row) => ({ ...(row as OntologyValue), confidence: Number((row as { confidence: number }).confidence), fact_id: Number((row as { fact_id: number }).fact_id) }));
  }

  async discoverOntologyDimensions(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<OntologyDimensionStat[]> {
    const params: unknown[] = [];
    let scope: string;
    if (opts?.sourceIds && opts.sourceIds.length) { params.push(opts.sourceIds); scope = `AND source_id = ANY($${params.length})`; }
    else { params.push(opts?.sourceId ?? null); scope = `AND ($${params.length}::text IS NULL OR source_id = $${params.length})`; }
    const r = await this.db.query(
      `SELECT dimension, count(DISTINCT entity_slug)::int AS entities, count(*)::int AS observations
       FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL AND ${NOT_CONVERSATION_SLOT_SQL} ${scope}
       GROUP BY dimension ORDER BY entities DESC, dimension`,
      params,
    );
    return r.rows.map((row) => {
      const x = row as { dimension: string; entities: number; observations: number };
      return { dimension: x.dimension, entities: Number(x.entities), observations: Number(x.observations) };
    });
  }

  async findOntologyConflicts(opts?: PageReadScope & Pick<OntologyReadOpts, 'minConfidence' | 'visibility' | 'excludeDiary'>): Promise<OntologyConflict[]> {
    const minConf = opts?.minConfidence ?? 0;
    const params: unknown[] = [minConf];
    let scope: string;
    if (opts?.sourceIds && opts.sourceIds.length) { params.push(opts.sourceIds); scope = `AND source_id = ANY($${params.length})`; }
    else { params.push(opts?.sourceId ?? null); scope = `AND ($${params.length}::text IS NULL OR source_id = $${params.length})`; }
    // Same page gates as getOntology, inside the CTE so a conflict
    // that only exists because of a hidden provenance is never reported.
    const privacy = `AND ${deletedPageProjectionHiddenSql('facts', 'facts')}${opts?.excludePrivate ? ` AND ${privateFactFilterForReader('facts')}` : ''}${opts?.excludeDiary ? ` AND NOT starts_with(COALESCE(source_markdown_slug, ''), 'life/diary/')` : ''}`;
    params.push(opts?.visibility ?? null);
    const visibility = `AND ($${params.length}::text[] IS NULL OR visibility = ANY($${params.length}::text[]))`;
    const r = await this.db.query(
      `WITH cur AS (
         SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
         FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL AND ${NOT_CONVERSATION_SLOT_SQL}
           AND (dim_status IS NULL OR dim_status = 'active') AND confidence >= $1 ${scope} ${privacy} ${visibility}
       )
       SELECT entity_slug, dimension,
              json_agg(json_build_object('value', value, 'source', source, 'confidence', confidence, 'fact_id', fact_id) ORDER BY fact_id) AS values
       FROM cur GROUP BY entity_slug, dimension
       HAVING count(DISTINCT value) >= 2 AND count(DISTINCT source) >= 2
       ORDER BY entity_slug, dimension`,
      params,
    );
    return r.rows.map((row) => {
      const x = row as { entity_slug: string; dimension: string; values: OntologyConflict['values'] };
      return { entity_slug: x.entity_slug, dimension: x.dimension, values: typeof x.values === 'string' ? JSON.parse(x.values) : x.values };
    });
  }

  // Raw data
  async putRawData(
    slug: string,
    source: string,
    data: object,
    opts?: { sourceId?: string },
  ): Promise<void> {
    // v0.31.8 (D21): two-branch INSERT-SELECT. Without opts.sourceId, the
    // page-id lookup matches every same-slug page (pre-v0.31.8 behavior; can
    // still trip Postgres 21000 on multi-source brains — caller's choice).
    // With opts.sourceId, the lookup is source-scoped so the right row
    // gets the raw_data attached.
    // cathedral-4 parity: RETURNING id + zero-row check, matching the
    // Postgres engine — a missing page must THROW, never silently no-op
    // (callers treat a raw-data miss as an integrity failure).
    if (opts?.sourceId) {
      const r = await this.db.query(
        `INSERT INTO raw_data (page_id, source, data)
         SELECT id, $2, $3::jsonb
         FROM pages WHERE slug = $1 AND source_id = $4
         ON CONFLICT (page_id, source) DO UPDATE SET
           data = EXCLUDED.data,
           fetched_at = now()
         RETURNING id`,
        [slug, source, JSON.stringify(data), opts.sourceId]
      );
      if (r.rows.length === 0) {
        throw new Error(`putRawData failed: page "${slug}" (source=${opts.sourceId}) not found`);
      }
      return;
    }
    const r = await this.db.query(
      `INSERT INTO raw_data (page_id, source, data)
       SELECT id, $2, $3::jsonb
       FROM pages WHERE slug = $1
       ON CONFLICT (page_id, source) DO UPDATE SET
         data = EXCLUDED.data,
         fetched_at = now()
       RETURNING id`,
      [slug, source, JSON.stringify(data)]
    );
    if (r.rows.length === 0) {
      throw new Error(`putRawData failed: page "${slug}" not found`);
    }
  }

  async getRawData(
    slug: string,
    source?: string,
    opts?: PageReadScope & { includeDeleted?: boolean },
  ): Promise<RawData[]> {
    // v0.31.8 (D21): build WHERE clause dynamically. Without opts.sourceId,
    // no source filter (preserves pre-v0.31.8 cross-source read).
    const where: string[] = ['p.slug = $1'];
    if (opts?.excludePrivate) where.push(privatePagesFilterForCaller('p'));
    if (!opts?.includeDeleted) where.push('p.deleted_at IS NULL'); // raw_data follows the page soft-delete
    const params: unknown[] = [slug];
    if (source) {
      params.push(source);
      where.push(`rd.source = $${params.length}`);
    }
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }
    const result = await this.db.query(
      `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
       JOIN pages p ON p.id = rd.page_id
       WHERE ${where.join(' AND ')} ORDER BY p.source_id COLLATE "C", rd.source COLLATE "C"`, // page source, then raw-data source, byte-wise
      params
    );
    return result.rows as unknown as RawData[];
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

  // Dream-cycle triage verdict cache (v0.23 boolean era; widened by #4152 triage-v1).
  async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
    const result = await this.db.query<{
      worth_processing: boolean;
      reasons: string[] | null;
      judged_at: Date | string;
      score: number | null;
      content_type: string | null;
      segments: Array<{ quote: string; note?: string }> | null;
      entities: string[] | null;
      model: string | null;
      triage_version: number | null;
    }>(
      `SELECT worth_processing, reasons, judged_at,
              score, content_type, segments, entities, model, triage_version
       FROM dream_verdicts
       WHERE file_path = $1 AND content_hash = $2
         -- NULL = pre-TTL row in the #4657 bootstrap window; a miss here re-judges the corpus
         AND (expires_at IS NULL OR expires_at > now())`,
      [filePath, contentHash]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
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
    verdict = wellFormedJson(verdict);
    // $N::jsonb + JSON.stringify is legal ONLY on PGLite (its db.query parses
    // text→jsonb natively); the postgres.js twin must use sql.json().
    // Expiry is computed server-side (now() + TTL) so it lives on the same
    // clock as the `expires_at > now()` read predicate and judged_at.
    await this.db.query(
      `INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons,
                                   score, content_type, segments, entities, model, triage_version,
                                   expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
               now() + make_interval(secs => $11))
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
         expires_at = EXCLUDED.expires_at`,
      [filePath, contentHash, verdict.worth_processing, JSON.stringify(verdict.reasons),
       verdict.score, verdict.content_type, JSON.stringify(verdict.segments),
       JSON.stringify(verdict.entities), verdict.model, verdict.triage_version,
       DREAM_VERDICT_TTL_SECONDS]
    );
  }

  async sweepDreamVerdicts(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM dream_verdicts WHERE expires_at <= now()`
    );
    return result.affectedRows ?? 0;
  }

  // ============================================================
  // v0.31: Hot memory — facts table operations
  // ============================================================

  // Facts SQL lives once in ./engine-sql/facts.ts (refactor wave 1 C11): the
  // methods below are one-line delegations over the engine-sql executor.

  /** Narrow deps for the peeled facts module. */
  async insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
    return factsImpl.insertFact(this.engineSql, undefined, input, ctx);
  }

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date; successorFrom?: Date }): Promise<boolean> {
    return factsImpl.expireFact(this.engineSql, id, opts);
  }

  async insertFacts(
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }> {
    return factsImpl.insertFacts(this.engineSql, undefined, rows, ctx, opts);
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

  async findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array; embeddingModel?: string | null; arm?: 'keyword'; attributedTo?: import('./engine.ts').FactAttribution | null; excludeMemberPages?: boolean; onlyPage?: string },
  ): Promise<FactRow[]> {
    return factsImpl.findCandidateDuplicates(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, entitySlug, factText, opts);
  }

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    return factsImpl.findTrajectory(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), opts);
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    return factsImpl.consolidateFact(this.engineSql, id, takeId);
  }

  async getFactsHealth(source_id: string): Promise<FactsHealth> {
    return factsImpl.getFactsHealth(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id);
  }

  // Segmented page storage (Wave B): SQL in ./engine-sql/page-body.ts.
  async allocateBodyOccurrenceIds(count: number): Promise<number[]> { return pageBodyImpl.allocateBodyOccurrenceIds(this.engineSql, count); }
  async stageSegmentTexts(sourceId: string, texts: readonly SegmentTextInput[], opts?: { stagingId?: string }): Promise<{ inserted: number }> { return pageBodyImpl.stageSegmentTexts(this.engineSql, sourceId, texts, opts); }
  async readSegmentTexts(sourceId: string, sha256s: readonly Uint8Array[]): Promise<Map<string, Uint8Array>> {
    return pageBodyImpl.readSegmentTexts(unscopedExecutor(this.engineSql, 'page-body: page-id keyed internal read'), sourceId, sha256s);
  }
  async stageManifestRows(rows: readonly ManifestRowInput[]): Promise<void> { return pageBodyImpl.stageManifestRows(this.engineSql, rows); }
  async readManifest(pageId: number, opts?: { generation?: number; stagingId?: string; region?: BodyRegion; lastN?: number }): Promise<ManifestRow[]> {
    return pageBodyImpl.readManifest(unscopedExecutor(this.engineSql, 'page-body: page-id keyed internal read'), pageId, opts);
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
  hasSegmentStorage() { return writeGuardsImpl.hasSegmentStorage(unscopedExecutor(this.engineSql, 'page body: segment storage probe ran unscoped through executeRaw')); }
  async readSegmentDerivations(pageId: number, opts?: { kind?: SegmentDerivationKind; occurrenceIds?: readonly number[] }): Promise<SegmentDerivationRow[]> {
    return pageBodyImpl.readSegmentDerivations(unscopedExecutor(this.engineSql, 'page-body: page-id keyed internal read'), pageId, opts);
  }
  async upsertSegmentDerivations(rows: readonly SegmentDerivationInput[]): Promise<void> { return pageBodyImpl.upsertSegmentDerivations(this.engineSql, rows); }
  async retireSegmentDerivations(pageId: number, liveOccurrenceIds: readonly number[], opts?: { kind?: SegmentDerivationKind }): Promise<number> {
    return pageBodyImpl.retireSegmentDerivations(this.engineSql, pageId, liveOccurrenceIds, opts);
  }

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

  matchTakeRows(pageId: number, rows: readonly takesImpl.TakeFenceRow[], limit: number) { return takesImpl.matchTakeRows(unscopedExecutor(this.engineSql, 'page write: fence take collision read ran unscoped through executeRaw'), pageId, rows, limit); }
  deleteTakeRows(pageId: number, rowNums: readonly number[]) { return takesImpl.deleteTakeRows(this.engineSql, pageId, rowNums); }

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

  async listTakes(opts: TakesListOpts = {}): Promise<Take[]> {
    return takesImpl.listTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), opts);
  }

  async searchTakes(
    query: string,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; eligibility?: import('./eligibility/policy.ts').ReadEligibility } = {},
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
  async pruneHoldingPageVersions(pageId: number) { return versionPrune.pruneHoldingPageVersions(this, pageId); }

  async revertToVersion(
    slug: string,
    versionId: number,
    opts?: { sourceId?: string },
  ): Promise<void> {
    return pagesImpl.revertToVersion(this.engineSql, slug, versionId, opts);
  }

  // Stats + health
  async getStats(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainStats> {
    // #4592: optional source scope — parity with postgres-engine.getStats.
    // Bound as $1 (NEVER interpolated: remote callers influence the value).
    const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
    // S2: embedded_count keys on the registry-ACTIVE column (fallback to
    // legacy on a broken registry — diagnostics never crash).
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { rows: [stats] } = await this.db.query(`
      SELECT
        -- v0.26.5: exclude soft-deleted from page_count (mirrors postgres-engine).
        (SELECT count(*) FROM pages p WHERE p.deleted_at IS NULL
           AND ($1::text[] IS NULL OR p.source_id = ANY($1))) as page_count,
        (SELECT count(*) FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))) as chunk_count,
        -- Keyed on the stored VECTOR, not embedded_at (parity with
        -- postgres-engine): a schema rebuild NULLs every vector without
        -- touching embedded_at.
        (SELECT count(*) FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE cc.${colId} IS NOT NULL
            AND ($1::text[] IS NULL OR p.source_id = ANY($1))) as embedded_count,
        -- EXISTS (not JOIN) so a legacy dead link still counts unscoped.
        (SELECT count(*) FROM links l
          WHERE ($1::text[] IS NULL
             OR (EXISTS (SELECT 1 FROM pages pf WHERE pf.id = l.from_page_id AND pf.source_id = ANY($1))
                 AND EXISTS (SELECT 1 FROM pages pt WHERE pt.id = l.to_page_id AND pt.source_id = ANY($1))))) as link_count,
        (SELECT count(DISTINCT t.tag) FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))) as tag_count,
        (SELECT count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id
          WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))) as timeline_entry_count
    `, [scope]);

    const { rows: types } = await this.db.query(
      `SELECT type, count(*)::int as count FROM pages p WHERE p.deleted_at IS NULL
         AND ($1::text[] IS NULL OR p.source_id = ANY($1))
       GROUP BY type ORDER BY count DESC`,
      [scope]
    );
    const pages_by_type: Record<string, number> = {};
    for (const t of types as { type: string; count: number }[]) {
      pages_by_type[t.type] = t.count;
    }

    const s = stats as Record<string, unknown>;
    return {
      page_count: Number(s.page_count),
      chunk_count: Number(s.chunk_count),
      embedded_count: Number(s.embedded_count),
      link_count: Number(s.link_count),
      tag_count: Number(s.tag_count),
      timeline_entry_count: Number(s.timeline_entry_count),
      pages_by_type,
    };
  }

  async getHealth(opts?: { sourceId?: string; sourceIds?: string[] }): Promise<BrainHealth> {
    return plannerRead(this, this._pageTransaction, () => healthImpl.getHealth(unscopedExecutor(this.engineSql, 'health: unscoped on master (EO4 inventory)'), opts, {
      embeddingColumn: async () => (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name,
      countStalePagesForExtraction: (o) => this.countStalePagesForExtraction(o),
      getConfig: (key) => this.getConfig(key),
      entityTypes: (scope) => resolveEntityTypes(this, scope),
    }));
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    // v0.31.2 (codex P1 #3): source_id threaded so multi-source brains can
    // scope ingest_log queries. Default 'default' matches the column DEFAULT.
    const sourceId = entry.source_id ?? 'default';
    // v254: the writer's version, host and segment-reader mark (writer-versions.ts writerStamp).
    const stamp = writerStamp({ mint: false, engine: this });
    await this.db.query(
      `INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::uuid, true)`,
      [sourceId, entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary, stamp.version, stamp.hostId]
    );
  }

  async getIngestLog(opts?: { limit?: number; sourceIds?: string[] }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    // Source-scope for remote / federated callers; unscoped only for trusted
    // local callers (mirrors the postgres engine).
    const scoped = opts?.sourceIds && opts.sourceIds.length > 0;
    // id DESC breaks ties: PGLite's clock ticks in milliseconds, so rows written in one millisecond share created_at.
    const { rows } = await this.db.query(
      scoped
        ? `SELECT id, source_id, source_type, source_ref, pages_updated, summary, created_at FROM ingest_log WHERE source_id = ANY($2::text[]) ORDER BY created_at DESC, id DESC LIMIT $1`
        : `SELECT id, source_id, source_type, source_ref, pages_updated, summary, created_at FROM ingest_log ORDER BY created_at DESC, id DESC LIMIT $1`,
      scoped ? [limit, opts?.sourceIds] : [limit]
    );
    // Belt-and-suspenders source_id fallback for any pre-v50 row that
    // somehow survived without the backfill.
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
    return this.transaction(tx => pagesImpl.updateSlug((tx as PGLiteEngine).engineSql, tx, oldSlug, newSlug, sourceId));
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub: links use integer page_id FKs, already correct after updateSlug.
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
    return this.transaction(tx => pagesImpl.setPageAliases((tx as PGLiteEngine).engineSql, tx, slug, sourceId, aliasNorms));
  }

  async replaceDerivedAliases(slug: string, sourceId: string, aliases: readonly DerivedAliasRow[]): Promise<void> {
    return pagesImpl.replaceDerivedAliases(this.engineSql, slug, sourceId, aliases);
  }

  async getPageSealState(pageId: number): Promise<{ chunker_version: number | null } | null> {
    return pagesImpl.getPageSealState(unscopedExecutor(this.engineSql, 'pages: seal-state read ran unscoped on the pool on master (executeRaw)'), pageId);
  }

  async refreshPageOrigin(slug: string, opts: { sourceId: string; sourcePath: string; sourceUri?: string | null }): Promise<void> {
    return pagesImpl.refreshPageOrigin(this.engineSql, slug, opts);
  }
  readPageOrigin(target: writeGuardsImpl.PageOriginTarget) { return writeGuardsImpl.readPageOrigin(unscopedExecutor(this.engineSql, 'origin guard: page read ran unscoped through executeRaw'), target); }
  listOriginClaims(sourceId: string, spellings: readonly string[], opts: { lockKeys: readonly string[]; excludePageId?: number | null }) { return writeGuardsImpl.listOriginClaims(this.engineSql, sourceId, spellings, opts); }
  bindPageOrigin(target: writeGuardsImpl.PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }) { return writeGuardsImpl.bindPageOrigin(this.engineSql, target); }
  stampPageIngest(slug: string, stamp: writeGuardsImpl.PageIngestStamp) { return writeGuardsImpl.stampPageIngest(this.engineSql, slug, stamp); }
  sealImportedPage(slug: string, seal: writeGuardsImpl.ImportedPageSeal) { return writeGuardsImpl.sealImportedPage(this.engineSql, slug, seal); }
  readLivePageBody(slug: string, opts: { sourceId: string }) { return writeGuardsImpl.readLivePageBody(unscopedExecutor(this.engineSql, 'valid-time advisory: page body read ran unscoped through executeRaw'), slug, opts); }
  readPageIndexingState(pageId: number) { return writeGuardsImpl.readPageIndexingState(unscopedExecutor(this.engineSql, 'page projection: indexing state read ran unscoped through executeRaw'), pageId); }
  /** The page embedding ledger on the paid path, on the engine's own executor, as planPageEmbedding's `executeRaw` ran (page-embedding-budget.ts). */
  readPageEmbeddingBudget(pageId: number) { return pageEmbeddingBudgetImpl.readPageEmbeddingBudget(unscopedExecutor(this.engineSql, 'page embedding budget: hold read ran unscoped through executeRaw'), pageId); }
  recordPageEmbeddingHold(pageId: number, reason: string) { return pageEmbeddingBudgetImpl.recordPageEmbeddingHold(this.engineSql, pageId, reason); }
  openPageEmbeddingHold(pageId: number) { return pageEmbeddingBudgetImpl.openPageEmbeddingHold(this.engineSql, pageId); }
  reservePageEmbedding(pageId: number, input: Parameters<BrainEngine['reservePageEmbedding']>[1]) { return pageEmbeddingBudgetImpl.reservePageEmbedding(this.engineSql, pageId, input); }
  settlePageEmbeddingReservation(pageId: number, settle: Parameters<BrainEngine['settlePageEmbeddingReservation']>[1]) { return pageEmbeddingBudgetImpl.settlePageEmbeddingReservation(this.engineSql, pageId, settle); }
  /** The embedding effect's install path, on the engine's own executor, as embedPage's and installPageEmbeddings' `executeRaw` ran. */
  readEmbeddingCompletion(pageId: number, opts: embeddingInstallImpl.EmbeddingCompletionOpts) { return embeddingInstallImpl.readEmbeddingCompletion(unscopedExecutor(this.engineSql, 'embedding effect: completion read ran unscoped through executeRaw'), pageId, opts); }
  lockEffectClaimRow(effectId: number | string) { return embeddingInstallImpl.lockEffectClaimRow(this.engineSql, effectId); }
  lockEmbeddingSwitch() { return embeddingInstallImpl.lockEmbeddingSwitch(this.engineSql); }
  installChunkEmbeddings(pageId: number, column: ResolvedColumn, batch: string) { return embeddingInstallImpl.installChunkEmbeddings(this.engineSql, pageId, column, batch); }
  readStoredPageTier(sourceId: string, slug: string) { return writeGuardsImpl.readStoredPageTier(unscopedExecutor(this.engineSql, 'page write gate: stored tier read ran unscoped through executeRaw'), sourceId, slug); }
  readInlinePageRegions(pageId: number) { return writeGuardsImpl.readInlinePageRegions(unscopedExecutor(this.engineSql, 'append tail digest: page body read ran unscoped through executeRaw'), pageId); }
  readPageHiddenFromCaller(sourceId: string, slug: string, opts: { policy: pageVisibilityImpl.PagePolicyPart }) { return pageVisibilityImpl.readPageHiddenFromCaller(unscopedExecutor(this.engineSql, 'page visibility: caller policy read ran unscoped through executeRaw'), sourceId, slug, opts); }
  readCallerPageAccess(pages: readonly { source_id: string; slug: string }[], opts: { policy: pageVisibilityImpl.PagePolicyPart }) { return pageVisibilityImpl.readCallerPageAccess(unscopedExecutor(this.engineSql, 'page visibility: caller policy read ran unscoped through executeRaw'), pages, opts); }
  readWriteVisibilityProbe(sourceId: string, slug: string) { return pageVisibilityImpl.readWriteVisibilityProbe(unscopedExecutor(this.engineSql, 'page visibility: write probe ran unscoped through executeRaw'), sourceId, slug, ownerOnlyLineageReadable(this)); }
  readWriterSlugFence(principal: { kind: string; id: string }, opts?: { delegated?: boolean }) { return pageVisibilityImpl.readWriterSlugFence(unscopedExecutor(this.engineSql, 'page visibility: writer fence read ran unscoped through executeRaw'), principal, opts); }
  setEffectTransactionLimits() { return remoteLinksImpl.setEffectTransactionLimits(this); }
  readOwnedLinks(linkSource: string, originPageId: number | string) { return remoteLinksImpl.readOwnedLinks(unscopedExecutor(this.engineSql, 'links effect: owned edge read ran unscoped through executeRaw'), linkSource, originPageId); }
  deleteOwnedLinks(originPageId: number | string, linkSource: string, ids: readonly (number | string)[]) { return remoteLinksImpl.deleteOwnedLinks(this, originPageId, linkSource, ids); }
  readLinkTargetPages(sourceId: string, slugs: readonly string[], policy: remoteLinksImpl.WriterReadPolicy | null) { return remoteLinksImpl.readLinkTargetPages(unscopedExecutor(this.engineSql, 'links effect: target read ran unscoped through executeRaw'), sourceId, slugs, policy); }
  rearmLinksEffects(opts: remoteLinksImpl.LinksRearm) { return remoteLinksImpl.rearmLinksEffects(this, opts); }
  hasPendingFactsExtraction(pageId: number | string, jobStates: readonly string[]) { return factsBackstopImpl.hasPendingFactsExtraction(unscopedExecutor(this.engineSql, 'facts backstop: pending extraction read ran unscoped through executeRaw'), pageId, jobStates); }
  hasCompletedFactsExtraction(pageId: number | string) { return factsBackstopImpl.hasCompletedFactsExtraction(unscopedExecutor(this.engineSql, 'facts backstop: completed extraction read ran unscoped through executeRaw'), pageId); }
  readStoredBodyBytes(slug: string, sourceId: string) { return largePageImpl.readStoredBodyBytes(unscopedExecutor(this.engineSql, 'large page: stored body size read ran unscoped through executeRaw'), slug, sourceId); }
  readAdmittedPageRefs(refs: readonly relationalReadsImpl.PageRefRow[], policy: PageReadPolicy) { return relationalReadsImpl.readAdmittedPageRefs(unscopedExecutor(this.engineSql, 'relational recall: seed admit read ran unscoped through executeRaw'), refs, policy); }
  readPageSynopses(refs: readonly relationalReadsImpl.PageRefRow[], policy?: PageReadPolicy) { return relationalReadsImpl.readPageSynopses(unscopedExecutor(this.engineSql, 'relational recall: hydrate read ran unscoped through executeRaw'), refs, policy); }
  readSeedTitleSlugs(sourceId: string, types: readonly string[], title: string) { return relationalReadsImpl.readSeedTitleSlugs(unscopedExecutor(this.engineSql, 'relational recall: title seed read ran unscoped through executeRaw'), sourceId, types, title); }
  async readPageBodySizes(pageId: number) { return largePageImpl.readPageBodySizes(this, pageId); }
  listFenceFactRows(target: trustFenceImpl.FenceRowsTarget) { return trustFenceImpl.listFenceFactRows(unscopedExecutor(this.engineSql, 'fence guard: locking fact read ran unscoped through executeRaw'), target); }
  async restorePageTrust(spec: trustFenceImpl.PageTrustRestore) { return trustFenceImpl.restorePageTrust(this, spec); }
  listHeldRows(q: trustFenceImpl.HeldRowsQuery) { return trustFenceImpl.listHeldRows(unscopedExecutor(this.engineSql, 'fence guard: held-row read ran unscoped through executeRaw'), q); }
  listGuardedTakeRows(q: trustFenceImpl.GuardedTakeRowsQuery) { return trustFenceImpl.listGuardedTakeRows(unscopedExecutor(this.engineSql, 'fence guard: batch take guard ran unscoped through executeRaw'), q); }
  insertTrustProposal(input: trustProposalsImpl.NewTrustProposal) { return trustProposalsImpl.insertTrustProposal(this.engineSql, input); }
  getTrustProposal(id: number, lock = false) { return trustProposalsImpl.getTrustProposal(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), id, lock); }
  listTrustProposals(filter: trustProposalsImpl.TrustProposalFilter = {}) { return trustProposalsImpl.listTrustProposals(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), filter); }
  pendingTrustProposalsFor(table: TrustTable, id: number) { return trustProposalsImpl.pendingTrustProposalsFor(unscopedExecutor(this.engineSql, 'trust: the trust proposal read ran through executeRaw unscoped'), table, id); }
  updatePendingTrustProposalAfter(id: number, after: Record<string, unknown>) { return trustProposalsImpl.updatePendingTrustProposalAfter(this.engineSql, id, after); }
  transitionTrustProposal(id: number, from: trustProposalsImpl.TrustProposalStatus, to: trustProposalsImpl.TrustProposalStatus, opts: trustProposalsImpl.TrustProposalTransition = {}) { return trustProposalsImpl.transitionTrustProposal(this.engineSql, id, from, to, opts); }
  listPendingContradictions(filter: trustProposalsImpl.PendingContradictionFilter = {}) { return trustProposalsImpl.listPendingContradictions(unscopedExecutor(this.engineSql, 'trust: the trust review contradiction read ran through executeRaw unscoped'), filter); }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const held = await requestConfigValue(this, key);
    if (held !== undefined) return held;
    const { rows } = await this.db.query('SELECT value FROM config WHERE key = $1', [key]);
    return rows.length > 0 ? (rows[0] as { value: string }).value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
    noteRequestConfigWrite(this, key, value);
  }

  async unsetConfig(key: string): Promise<number> {
    const { affectedRows } = await this.db.query(
      'DELETE FROM config WHERE key = $1',
      [key],
    ) as { affectedRows?: number };
    noteRequestConfigWrite(this, key, null);
    return affectedRows ?? 0;
  }

  async listConfigKeys(prefix: string): Promise<string[]> {
    // LIKE-escape the prefix so a user-supplied % or _ doesn't act as a wildcard.
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const { rows } = await this.db.query(
      `SELECT key FROM config WHERE key LIKE $1 || '%' ESCAPE '\\' ORDER BY key`,
      [escaped],
    );
    return (rows as { key: string }[]).map(r => r.key);
  }

  async getAllConfig(): Promise<Record<string, string>> {
    const held = await requestConfigRows(this);
    if (held) return held;
    const { rows } = await this.db.query('SELECT key, value FROM config');
    const out: Record<string, string> = {};
    for (const row of rows as { key: string; value: string }[]) out[row.key] = row.value;
    return out;
  }

  // Migration support
  async runMigration(_version: number, sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async getChunksWithEmbeddings(slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }): Promise<Chunk[]> {
    return chunksImpl.getChunksWithEmbeddings(unscopedExecutor(this.engineSql, 'chunks: unscoped on master (EO4 inventory)'), slug, opts);
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    // v0.41.18.0 (A20, codex #7): PGLite is in-process WASM with no
    // kernel-level cancellation. Best-effort: pre-check the signal so
    // an already-aborted call returns immediately, and race against
    // a settle promise so a late-arriving abort throws AbortError
    // (the query keeps running in WASM until it returns; the result
    // is discarded). Documented gap in src/core/engine.ts.
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    // #5449: an autocommit write is its own outermost transaction, so it takes the WAL checkpoint guard.
    const queryPromise = !this._pageTransaction && this._dbWork !== null && writesWal(sql)
      ? (this._checkpointGuard ??= new PgliteCheckpointGuard())
        .runStatement(q => this.db.query(q), () => this.db.query(sql, params)).then((r) => r.rows as T[])
      : this.db.query(sql, params).then((r) => r.rows as T[]);
    if (!opts?.signal) return queryPromise;
    const abortPromise = new Promise<T[]>((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
    return Promise.race([queryPromise, abortPromise]);
  }

  /** No statement timeout on PGLite (BrainEngine.keywordBoundedRead): `read` runs on the engine itself. */
  async keywordBoundedRead<T>(read: (db: Pick<BrainEngine, 'executeRaw'>) => Promise<T>): Promise<T> {
    return read(this);
  }

  /**
   * PGLite is in-process WASM with no connection pooler, so the direct-pool
   * routing that `executeRawDirect` provides on Postgres is a no-op here:
   * delegate straight to `executeRaw`. Present so the BrainEngine contract is
   * satisfied and the Minion lock hot-path works identically on both engines.
   */
  async executeRawDirect<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    return this.executeRaw<T>(sql, params, opts);
  }

  // Cycle-lock SQL lives once in ./engine-sql/cycle-locks.ts. The lease statements ran on the attached `db` handle
  // (no checkpoint admission) in db-lock.ts, so they keep it: a heartbeat never queues behind a checkpoint.
  private get cycleLockSql(): SqlExecutor { return pgliteExecutor(this.db); }
  async acquireCycleLock(lockId: string, opts: Parameters<BrainEngine['acquireCycleLock']>[1]) { return cycleLocksImpl.acquireCycleLock(this.cycleLockSql, lockId, opts); }
  /** PGLite never forwarded the signal to the lease renewal (BrainEngine.refreshCycleLock). */
  async refreshCycleLock(lockId: string, opts: Parameters<BrainEngine['refreshCycleLock']>[1]) { return cycleLocksImpl.refreshCycleLock(this.cycleLockSql, lockId, opts); }
  async releaseCycleLock(lockId: string, opts: Parameters<BrainEngine['releaseCycleLock']>[1]) { return cycleLocksImpl.releaseCycleLock(this.cycleLockSql, lockId, opts); }
  async readCycleLocks(filter: CycleLockFilter) { return cycleLocksImpl.readCycleLocks(unscopedExecutor(this.cycleLockSql, 'cycle locks: unscoped on master (db-lock selectLockRows)'), filter); }
  async deleteCycleLock(lockId: string, opts: Parameters<BrainEngine['deleteCycleLock']>[1]) { return cycleLocksImpl.deleteCycleLock(this.cycleLockSql, lockId, opts); }
  async deleteCycleLockIfStale(lockId: string, opts: Parameters<BrainEngine['deleteCycleLockIfStale']>[1]) { return cycleLocksImpl.deleteCycleLockIfStale(this.cycleLockSql, lockId, opts); }
  /** The page embedding lease: on the engine's own executor, as its `executeRaw` statements ran (page-embedding-lease.ts). */
  takePageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['takePageEmbeddingLease']>[1]) { return cycleLocksImpl.takePageEmbeddingLease(this.engineSql, leaseId, opts); }
  renewPageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['renewPageEmbeddingLease']>[1]) { return cycleLocksImpl.renewPageEmbeddingLease(this.engineSql, leaseId, opts); }
  releasePageEmbeddingLease(leaseId: string, opts: Parameters<BrainEngine['releasePageEmbeddingLease']>[1]) { return cycleLocksImpl.releasePageEmbeddingLease(this.engineSql, leaseId, opts); }
  async assertCycleLease(lockId: string, acquisitionToken: string) { return cycleLocksImpl.assertCycleLease(this, lockId, acquisitionToken); }

  // Minion jobs (engine-sql/jobs.ts): the submission and lifecycle writes run in one transaction each; claim and
  // renewal run on executeRawDirect; reads run where they are called (a transaction engine reads inside it).
  async admitJob(spec: AdmitJobSpec, policy: AdmitJobPolicy) { return this.transaction(tx => jobsImpl.admitJob(tx, spec, policy)); }
  async getJob(id: number) { return jobsImpl.getJob(this, id); }
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
  async countTtlExpiredWaiting(name: string, hours: number) { return jobsQueue.countTtlExpiredWaiting(this, name, hours); }
  async readJobStats(since: Date, queue: string) { return jobsQueue.readJobStats(this, since, queue); }
  async readQueueFamilyStats(since: Date) { return jobsQueue.readQueueFamilyStats(this, since); }
  async hasOverdueWatchdogSuspect(queue: string, names: readonly string[], waitMs: number) { return jobsQueue.hasOverdueWatchdogSuspect(this, queue, names, waitMs); }
  async listUnreviewedJobs() { return jobsQueue.listUnreviewedJobs(this); }
  async getFailedJobForRetry(id: number) { return jobsQueue.getFailedJobForRetry(this, id); }
  async countOpenJobsByOwner(clientId: string) { return jobsQueue.countOpenJobsByOwner(this, clientId); }
  async readJobSourceState(sourceId: string) { return jobsQueue.readJobSourceState(this, sourceId); }
  async lockOAuthClient(clientId: string) { return jobsQueue.lockOAuthClient(this, clientId); }
  async listJobPage(spec: JobPageSpec) { return jobsQueue.listJobPage(this, spec); }
  async listJobAttachmentNames(jobId: number) { return jobsQueue.listJobAttachmentNames(this, jobId); }
  async insertJobAttachment(jobId: number, attachment: JobAttachmentInsert) { return jobsQueue.insertJobAttachment(this, jobId, attachment); }
  async listJobAttachments(jobId: number) { return jobsQueue.listJobAttachments(this, jobId); }
  async getJobAttachment(jobId: number, filename: string) { return jobsQueue.getJobAttachment(this, jobId, filename); }
  async deleteJobAttachment(jobId: number, filename: string) { return jobsQueue.deleteJobAttachment(this, jobId, filename); }
  // Queue health reads (lane 5 group A; engine-sql/jobs-health.ts).
  async readQueueHealthSignals(spec: QueueHealthSpec) { return jobsHealth.readQueueHealthSignals(this, spec); }
  async listWaitingByQueue() { return jobsHealth.listWaitingByQueue(this); }
  async readQueueDivergence(spec: QueueDivergenceSpec) { return jobsHealth.readQueueDivergence(this, spec); }
  async listQueueWedgeCounts() { return jobsHealth.listQueueWedgeCounts(this); }
  async listPrivateQueueHealth() { return jobsHealth.listPrivateQueueHealth(this); }
  async readWedgeSignals(queue: string, handlerNames: readonly string[], opts?: { signal?: AbortSignal }) { return jobsHealth.readWedgeSignals(this, queue, handlerNames, opts); }
  async readOldestWaitingAge(queue: string, opts?: { signal?: AbortSignal }) { return jobsHealth.readOldestWaitingAge(this, queue, opts); }
  async countWaitingJobs(excludeFactsAbsorb: boolean) { return jobsHealth.countWaitingJobs(this, excludeFactsAbsorb); }
  async listStuckActiveJobsByName() { return jobsHealth.listStuckActiveJobsByName(this); }

  // Job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts).
  async readLastAutopilotCycles() { return jobsStatus.readLastAutopilotCycles(this); }
  async countJobsByStatus(filter?: JobStatusFilter) { return jobsStatus.countJobsByStatus(this, filter); }
  async readWaitingQueueDepths() { return jobsStatus.readWaitingQueueDepths(this); }
  async readLastCompletedJobAt() { return jobsStatus.readLastCompletedJobAt(this); }
  async countTtlCancelledByName(reasonLike: string, withinSeconds: number) { return jobsStatus.countTtlCancelledByName(this, reasonLike, withinSeconds); }
  async readWaitingScopeState(spec: { name: string; queue: string; jobId: number }) { return jobsStatus.readWaitingScopeState(this, spec); }
  async countRecentCompletedJobs(name: string, withinSeconds: number) { return jobsStatus.countRecentCompletedJobs(this, name, withinSeconds); }
  async listRecentFailedJobErrors(withinSeconds: number) { return jobsStatus.listRecentFailedJobErrors(this, withinSeconds); }
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
  async readOauthClient(clientId: string) { return oauthClients.readOauthClient(this, clientId); }
  async listOauthClients() { return oauthClients.listOauthClients(this); }
  async patchOauthClient(clientId: string, patch: oauthClients.OauthClientPatch, guard?: oauthClients.OauthClientPatchGuard) { return oauthClients.patchOauthClient(this, clientId, patch, guard); }
  async insertAccessToken(row: accessTokens.AccessTokenInsert) { return accessTokens.insertAccessToken(this, row); }
  async findActiveAccessTokens(target: string) { return accessTokens.findActiveAccessTokens(this, target); }
  async setAccessTokenMinTrust(id: string, tier: string | null) { return accessTokens.setAccessTokenMinTrust(this, id, tier); }
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
  async listHeldFenceTakeRows(spec: takesReads.HeldFenceTakeSpec) { return takesReads.listHeldFenceTakeRows(this, spec); }
  async readLivePageIdBySlug(slug: string, sourceId: string) { return takesReads.readLivePageIdBySlug(this, slug, sourceId); }
  async readPageTierRef(pageId: number) { return takesReads.readPageTierRef(this, pageId); }
  async readPageTierRows(ids: readonly number[]) { return takesReads.readPageTierRows(this, ids); }
  async pageHasFrontmatterKey(pageId: number, key: string) { return takesReads.pageHasFrontmatterKey(this, pageId, key); }
  async listTakeIdsLeavingFence(pageId: number, fence: takesReads.TakesLeavingFence) { return takesReads.listTakeIdsLeavingFence(this, pageId, fence); }
  async listTakePreimages(pageId: number, ids: readonly number[], incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>) { return takesReads.listTakePreimages(this, pageId, ids, incoming); }
  async deleteTakesByIds(ids: readonly number[]) { return takesReads.deleteTakesByIds(this, ids); }
  async findTakeId(pageId: number, rowNum: number) { return takesReads.findTakeId(this, pageId, rowNum); }
  async countMcpResolvedTakes(spec: takesReads.McpResolvedSpec) { return takesReads.countMcpResolvedTakes(this, spec); }
  async listTakeSupersessionCandidates(sourceIds: readonly string[]) { return takesReads.listTakeSupersessionCandidates(this, sourceIds); }
  async countZeroWeightWithTakes() { return takesReads.countZeroWeightWithTakes(this); }
  async hasCodeEdgesSymbol(sourceId: string) { return takesReads.hasCodeEdgesSymbol(this, sourceId); }
  async listCorePageRows(spec: trustTierReads.CorePageRowSpec) { return trustTierReads.listCorePageRows(this, spec); }
  async listTrustScanRows(spec: trustTierReads.TrustScanRowSpec) { return trustTierReads.listTrustScanRows(this, spec); }
  async countUnscannedTrustRows(spec: trustTierReads.UnscannedTrustSpec) { return trustTierReads.countUnscannedTrustRows(this, spec); }
  async readBeliefHistoryRows(spec: trustTierReads.BeliefHistoryRowQuery) { return trustTierReads.readBeliefHistoryRows(this, spec); }
  async listVisibleBeliefLifetimes(lifetimes: readonly string[]) { return trustTierReads.listVisibleBeliefLifetimes(this, lifetimes); }
  async listVersionTrustTiers(ids: readonly number[]) { return trustTierReads.listVersionTrustTiers(this, ids); }
  async listVersionReasonWriters(ids: readonly number[]) { return trustTierReads.listVersionReasonWriters(this, ids); }
  async listPageRefsByIds(ids: readonly number[]) { return trustTierReads.listPageRefsByIds(this, ids); }
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

  // Code-edge SQL lives once in ./engine-sql/code-edges.ts (refactor wave 1 C13);
  // getEdgesByChunk is PGLite-specific (./pglite-engine/code-edges.ts).

  /** Narrow deps for the PGLite-specific getEdgesByChunk. */
  private get codeEdgesDeps(): PgliteCodeEdgesDeps {
    const self = this;
    return { get db() { return self.db; } };
  }

  async addCodeEdges(edges: import('./types.ts').CodeEdgeInput[]): Promise<number> {
    return codeEdgesImpl.addCodeEdges(this.engineSql, edges);
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    return codeEdgesImpl.deleteCodeEdgesForChunks(this.engineSql, chunkIds);
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
    return getEdgesByChunkPglite(this.codeEdgesDeps, chunkId, opts);
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
    const raw = filter?.limit;
    const limit = (raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0)
      ? 1000
      : Math.min(Math.floor(raw), 100000);
    const since = filter?.since ?? new Date(0);
    const tool = filter?.tool ?? null;
    // id DESC tiebreaker — see postgres-engine for rationale.
    const { rows } = tool
      ? await this.db.query(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1 AND tool_name = $2
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [since, tool, limit]
        )
      : await this.db.query(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1
           ORDER BY created_at DESC, id DESC LIMIT $2`,
          [since, limit]
        );
    return rows as unknown as EvalCandidate[];
  }

  async deleteEvalCandidatesBefore(date: Date): Promise<number> {
    const { rows } = await this.db.query(
      `DELETE FROM eval_candidates WHERE created_at < $1 RETURNING id`,
      [date]
    );
    return rows.length;
  }

  async logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void> {
    await this.db.query(
      `INSERT INTO eval_capture_failures (reason) VALUES ($1)`,
      [reason]
    );
  }

  async listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]> {
    const since = filter?.since ?? new Date(0);
    const { rows } = await this.db.query(
      `SELECT * FROM eval_capture_failures WHERE ts >= $1 ORDER BY ts DESC, id DESC`,
      [since]
    );
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
  insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null) { return trustWithdrawalsImpl.insertFactWithdrawal(this.engineSql, sourceId, visibility, claim, subject, withdrawnAt); }
  listFactWithdrawalDates(sourceId: string, claims: readonly trustWithdrawalsImpl.WithdrawalClaimRow[], subject: string | null) { return trustWithdrawalsImpl.listFactWithdrawalDates(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, claims, subject); }
  moveFactWithdrawalSubject(sourceId: string, oldSlug: string, newSlug: string) { return trustWithdrawalsImpl.moveFactWithdrawalSubject(this.engineSql, sourceId, oldSlug, newSlug); }
  hasFactWithdrawalForSubject(sourceId: string, subject: string) { return trustWithdrawalsImpl.hasFactWithdrawalForSubject(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, subject); }
  listFactWithdrawalKeys(sourceId: string, limit: number) { return trustWithdrawalsImpl.listFactWithdrawalKeys(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId, limit); }
  readFactCacheWatermark(sourceId: string) { return trustWithdrawalsImpl.readFactCacheWatermark(unscopedExecutor(this.engineSql, 'trust: the withdrawal ledger read ran through executeRaw unscoped'), sourceId); }
  readTrustGeneration() { return trustWithdrawalsImpl.readTrustGeneration(unscopedExecutor(this.engineSql, 'trust: the policy generation read ran through executeRaw unscoped')); }
  readSourcePurgeFlags(sourceId: string) { return trustWithdrawalsImpl.readSourcePurgeFlags(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), sourceId); }
  lockFactForWithdrawal(spec: trustWithdrawalsImpl.WithdrawalLockSpec) { return trustWithdrawalsImpl.lockFactForWithdrawal(this.engineSql, spec); }
  queueWithdrawalReview(sourceId: string, factRef: string) { return trustWithdrawalsImpl.queueWithdrawalReview(this.engineSql, sourceId, factRef); }
  listSegmentedPagesBySlug(sourceId: string, slugs: readonly string[]) { return trustWithdrawalsImpl.listSegmentedPagesBySlug(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), sourceId, slugs); }
  bumpWithdrawnPageRevisions(sourceId: string, slugs: readonly string[]) { return trustWithdrawalsImpl.bumpWithdrawnPageRevisions(this.engineSql, sourceId, slugs); }
  readPageRevisions(ids: readonly number[]) { return trustWithdrawalsImpl.readPageRevisions(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), ids); }
  appendFactForgetReason(id: number, sourceId: string, note: string) { return trustWithdrawalsImpl.appendFactForgetReason(this.engineSql, id, sourceId, note); }
  readFactWithdrawnRow(spec: trustWithdrawalsImpl.FactWithdrawnSpec) { return trustWithdrawalsImpl.readFactWithdrawnRow(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), spec); }
  readFactWithdrawnBacking(spec: trustWithdrawalsImpl.FactWithdrawnSpec) { return trustWithdrawalsImpl.readFactWithdrawnBacking(unscopedExecutor(this.engineSql, 'trust: the withdrawal and purge ledger read ran through executeRaw unscoped'), spec); }
  // Open loops (engine-sql/open-loops.ts), through the raw path as before.
  upsertOpenLoop(loop: OpenLoopUpsertInput) { return openLoopsImpl.upsertOpenLoop(this.engineSql, loop); }
  closeOpenLoop(sourceId: string | null, id: number, status: Exclude<OpenLoopStatus, 'open'>, closedBy: string) { return openLoopsImpl.closeOpenLoop(this.engineSql, sourceId, id, status, closedBy); }
  listOpenLoops(opts?: OpenLoopListOpts) { return openLoopsImpl.listOpenLoops(unscopedExecutor(this.engineSql, 'open loops: the list read ran through executeRaw unscoped'), opts); }
  readEntityOpenLoops(slug: string, sourceId: string, limit: number) { return openLoopsImpl.readEntityOpenLoops(unscopedExecutor(this.engineSql, 'open loops: the entity card read ran through executeRaw unscoped'), slug, sourceId, limit); }
  private get entityIdentityRead() { return unscopedExecutor(this.engineSql, 'entity identities: master engine.executeRaw, unscoped'); }
  linkEntityIdentityRow(input: EntityIdentityLinkInput) { return entityIdentitiesImpl.linkEntityIdentityRow(this.engineSql, input); }
  unlinkEntityIdentityRow(input: EntityIdentityUnlinkInput) { return entityIdentitiesImpl.unlinkEntityIdentityRow(this.engineSql, input); }
  listEntityIdentityRows(filter: EntityIdentityFilter) { return entityIdentitiesImpl.listEntityIdentityRows(this.entityIdentityRead, filter); }
  readEntityIdentityIdsForPages(pages: ReadonlyArray<{ sourceId: string; slug: string }>) { return entityIdentitiesImpl.readEntityIdentityIdsForPages(this.entityIdentityRead, pages); }
  readCanonicalTwin(sourceId: string, slug: string) { return entityIdentitiesImpl.readCanonicalTwin(this.entityIdentityRead, sourceId, slug); }
  upsertWriteGateReceipt(input: trustWriteGateImpl.WriteGateReceiptInput) { return trustWriteGateImpl.upsertWriteGateReceipt(this.engineSql, input); }
  upsertPageWriteGateReceipt(sourceId: string, slug: string, receipt: trustWriteGateImpl.WriteGateReceiptFields) { return trustWriteGateImpl.upsertPageWriteGateReceipt(this.engineSql, sourceId, slug, receipt); }
  deleteStalePageWriteGateReceipts(sourceId: string, slug: string, contentHash: string | null) { return trustWriteGateImpl.deleteStalePageWriteGateReceipts(this.engineSql, sourceId, slug, contentHash); }
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number) { return trustWriteGateImpl.listWriteGateReceiptsFor(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), targetTable, targetId, limit); }
  deleteStaleWriteGateReceipts(olderThanDays: number) { return trustWriteGateImpl.deleteStaleWriteGateReceipts(this.engineSql, olderThanDays); }
  upsertWriteGateHold(input: trustWriteGateImpl.WriteGateHoldRowInput) { return trustWriteGateImpl.upsertWriteGateHold(this.engineSql, input); }
  listWriteGateHoldRows(opts: trustWriteGateImpl.WriteGateHoldListOpts) { return trustWriteGateImpl.listWriteGateHoldRows(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), opts); }
  listTrustAllowRuleRows(opts: trustWriteGateImpl.TrustAllowRuleListOpts = {}) { return trustWriteGateImpl.listTrustAllowRuleRows(unscopedExecutor(this.engineSql, 'trust: the allow rule read ran through executeRaw unscoped'), opts); }
  getWriteGateHoldRow(id: number) { return trustWriteGateImpl.getWriteGateHoldRow(unscopedExecutor(this.engineSql, 'trust: the write gate read ran through executeRaw unscoped'), id); }
  decideWriteGateHold(id: number, status: 'released' | 'dropped', decidedBy: string) { return trustWriteGateImpl.decideWriteGateHold(this.engineSql, id, status, decidedBy); }
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
  claimWakeForgets(spec: { leaseSeconds: number; limit: number }) { return jobsWake.claimWakeForgets(this, spec); }
  settleWakeForget(settle: jobsWake.WakeForgetSettle) { return jobsWake.settleWakeForget(this, settle); }
}
