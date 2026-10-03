import { tryAcquirePoolLongHold, PoolCapacityError } from './pool-budget.ts';
import { replaceDerivedLinks, type DerivedLinkOrigin, type DerivedLinkReplacementOptions } from './derived-links.ts';
import { mutatePageTag } from './page-state/tags.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import { assertPageRevision } from './page-state/types.ts';
import { lockPageKeys as acquirePageKeys } from './page-state/guards.ts';
import { readPageSnapshot as readCanonicalPageSnapshot } from './page-state/snapshot.ts';
import { createPageVersion } from './page-state/versions.ts';
import { moveSlugBindings, recordRenameAlias } from './page-state/rename-alias.ts';
import { composablePostgresTransaction } from './page-state/transactions.ts';
import type { PageReadScope } from './types.ts';
import type { PageReadPolicy } from './types.ts';
import { readRelationalFanout, readAliases, readBacklinkCounts, readAdjacencyBoosts, readContentFlags, readExtractionStates, readEffectiveDates, readSalienceScores } from './search/read-enrichment.ts';
import postgres from '#postgres'
import { hasPostgresCancellationCapability, postgresCancellationUnavailable, reserveWithCancellation } from './postgres-engine/cancellation.ts';
export { hasPostgresCancellationCapability } from './postgres-engine/cancellation.ts';
import type {
  BrainEngine,
  BatchOpts,
  LinkBatchInput, TimelineBatchInput,
  ReservedConnection,
  DreamVerdict, DreamVerdictInput,
  FileSpec, FileRow,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow, TakeEmbeddingInput,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
  FactRow, FactInsertStatus, FactKind,
  NewFact, FactListOpts, FactsHealth,
  SourceRow,
} from './engine.ts';
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
import { isConnectionEndedError } from './retry-matcher.ts';
import { CheckoutGauge, type PoolGaugeSnapshot } from './pool-gauge.ts';
import {
  valueHash,
  normalizeDimension,
  isNovelDimension, isBackdatedObservation,
} from './chronicle/ontology.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import type {
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow,
} from './types.ts';
import { DREAM_VERDICT_TTL_SECONDS, clampSearchLimit } from './engine.ts';
import { searchLimitCap } from './search/eval-pool-depth.ts';
import { executeRawJsonb, type SqlValue } from './sql-query.ts';
import { sanitizeForJsonb, sanitizeText, buildLinkRows, buildTimelineRows } from './batch-rows.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.generated.ts';
import { verifySchema } from './schema-verify.ts';
import { applyChunkEmbeddingIndexPolicy, dropZombieIndexes, supportsHnswIterativeScan } from './vector-index.ts';
import { searchVectorPool, readVectorPool, remainingVectorBudget, type VectorPoolAttempt } from './search/vector-pool.ts';
import { buildVectorSearchStatement, SET_STATEMENT_TIMEOUT_SQL, VECTOR_EXTENSION_VERSION_SQL, type VectorSearchStatement } from './search/vector-statement.ts';
import { withVectorSettings } from './search/vector-settings.ts';
import {
  vectorCastSuffix,
  resolveActiveEmbeddingColumnFromEngine,
  resolveWriteColumnFromConfigRows,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from './search/embedding-column.ts';
import { getFtsLanguage, applyFtsLanguagePolicy } from './fts-language.ts';
import { splitEmbeddingSignature, currentSpaceChunkPredicate, lockEmbeddingSources } from './embedding-invalidation.ts';
import { SAFE_FENCE_CHUNKER_VERSION, bodyWriteChunkVersion, chunkWriteInvalidation, currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from './search/safe-chunks.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput, StaleChunkRow, StalePageRow, ChunklessPageRow,
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
  EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';
import { GBrainError, PAGE_SORT_SQL, MIN_ENTITY_PAGES_FOR_COVERAGE } from './types.ts';
import { finalizeLastSeen } from './chronicle/last-seen.ts';
import * as db from './db.ts';
import { ConnectionManager, DEFAULT_DIRECT_POOL_SIZE } from './connection-manager.ts';
import { logConnectionEvent } from './connection-audit.ts';
import { drainBackgroundWorkBeforeDisconnect } from './background-work.ts';
import { validateSlug, contentHash, isBlankBody, rowToPage, rowToStalePage, rowToChunk, rowToSearchResult, parseEmbedding, tryParseEmbedding, isUndefinedTableError, warnOncePerProcess } from './utils.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildBestPerPagePoolCte, buildOrFallbackWebsearchQuery, boundWebsearchQuery } from './search/sql-ranking.ts';
import { privatePagesFilterFragment, privateSnapshotFilterFragment, privateLinkOriginFilterFragment, privateTimelineEventFilterFragment, privateProvenanceFilterFragment } from './search/private-visibility.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { readStoredEmbeddingIdentity } from './stored-embedding-identity.ts';
import { DELETE_BATCH_SIZE, TRAVERSE_PATH_ROW_CAP, TRAVERSE_WALK_ROW_CAP } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { shouldExcludeFromOrphanReporting, loadOrphanPolicyOverrides } from './orphan-policy.ts';
import { LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from './embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT, quarantineFilterFragment } from './quarantine.ts';
import { acquireInitSchemaAdvisoryLock } from './postgres-engine/init-schema-lock.ts';
import { applyPostgresForwardReferenceBootstrap } from './engine-sql/bootstrap.ts';
import * as factsImpl from './engine-sql/facts.ts';
import * as takesImpl from './engine-sql/takes.ts';
import * as codeEdgesImpl from './engine-sql/code-edges.ts';
import * as salienceImpl from './engine-sql/salience.ts';
import * as pagesImpl from './engine-sql/pages.ts';
import * as tagsImpl from './engine-sql/tags.ts';
import * as linksImpl from './engine-sql/links.ts';
import * as timelineImpl from './engine-sql/timeline.ts';
import * as sourcesImpl from './engine-sql/sources.ts';
import * as filesImpl from './engine-sql/files.ts';
import type { ChunkWindowRequest, ChunkWindowOpts, ChunkWindowPage } from './search/chunk-windows.ts';
import * as chunksImpl from './engine-sql/chunks.ts';
import { hasCJK } from './cjk.ts';
import { searchKeywordCJK as searchKeywordCJKImpl } from './engine-sql/cjk-search.ts';
import * as titlesImpl from './engine-sql/titles.ts';
import type { CjkKeywordCtx } from './search/cjk-keyword-sql.ts';
import { postgresExecutor, type RunUnsafeOpts } from './engine-sql/dialect-postgres.ts';
import type { SqlExecutor } from './engine-sql/executor.ts';
import { scopedRead, unscopedExecutor } from './engine-sql/brands.ts';

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

export class PostgresEngine implements BrainEngine {
  private vectorIterativeScan?: Promise<boolean>;
  /** Transaction clones keep chunk invalidation and replacement atomic. */
  private _chunkWritesInTransaction = false;
  readonly kind = 'postgres' as const;
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
    return this.engineSqlOn(this.sql);
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
  // they had before this helper existed. No read gains a new per-read
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
    opts?: { alwaysTransaction?: boolean },
  ): Promise<T> {
    // Flag off + no pre-existing transaction need: call through on the
    // shared pool exactly as master does. No tx round-trip, no pool slot
    // held for the duration of the read.
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
    return this.transaction(async engine => {
      const tx = (engine as PostgresEngine).sql;
      const previous = this.rlsScopeBindingEnabled
        ? await tx`SELECT current_setting('app.scopes', true) AS scopes` : [];
      if (this.rlsScopeBindingEnabled) await tx`SELECT set_config('app.scopes', ${scopesValue}, true)`;
      const result = await callback(tx);
      // Successful RELEASE SAVEPOINT retains SET LOCAL; a failed callback
      // rolls it back with the savepoint and must preserve its original error.
      if (this.rlsScopeBindingEnabled) await tx`SELECT set_config('app.scopes', ${previous[0]?.scopes ?? ''}, true)`;
      return result;
    });
  }

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<void> {
    this.vectorIterativeScan = undefined;
    this._savedConfig = config;
    const url = config.database_url;
    if (config.poolSize) {
      // Instance-level connection for worker isolation. resolvePoolSize lets
      // GBRAIN_POOL_SIZE cap below the caller's requested size when set — the
      // env var is a user escape hatch, so it wins.
      const url = config.database_url;
      if (!url) throw new GBrainError('No database URL', 'database_url is missing', 'Provide --url');
      const size = Math.min(config.poolSize, db.resolvePoolSize(config.poolSize));
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
        connect_timeout: 10,
        // Explicit (matches the postgres.js implicit default; GBRAIN_POOL_MAX_LIFETIME_S overrides).
        max_lifetime: db.resolveMaxLifetimeSeconds(),
        types: { bigint: postgres.BigInt },
        // Silence postgres NOTICE-level messages by default. See db.ts for
        // rationale (stdout-parsing callers like jobs-submit --json break when
        // idempotent CREATE migrations flood stdout). Opt back in with
        // GBRAIN_PG_NOTICES=1.
        onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
      };
      if (Object.keys(timeouts).length > 0) {
        opts.connection = timeouts;
      }
      if (typeof prepare === 'boolean') {
        opts.prepare = prepare;
      }
      this._sql = postgres(url, opts);
      await this._sql`SELECT 1`;
      await db.setSessionDefaults(this._sql);
      this._connectionStyle = 'instance';

      // v0.30.1: instance-owned ConnectionManager wraps the read pool we just
      // built. Parent inheritance (T5/X1): worker engines pass their parent's
      // manager so kill-switch state and direct pool are shared.
      this.connectionManager = new ConnectionManager({
        url,
        parent: config.parentConnectionManager,
        readPoolOwnedExternally: true, // we own _sql; manager just routes
      });
      this.connectionManager.setReadPool(this._sql);
    } else {
      // Module-level singleton (backward compat for CLI main engine).
      // #1471: db.connect() returns whether THIS call created the singleton —
      // decided atomically inside connect() (no await between its null-check and
      // pool assignment), so two concurrent module connects can't both claim
      // ownership. Store the token; only the owner tears the singleton down.
      this._ownsModuleSingleton = await db.connect(config);
      this._connectionStyle = 'module';

      // v0.30.1: connection-manager wraps the module singleton.
      if (url) {
        this.connectionManager = new ConnectionManager({
          url,
          parent: config.parentConnectionManager,
          readPoolOwnedExternally: true, // db.ts owns the pool
        });
        this.connectionManager.setReadPool(db.getConnection());
      }
    }
  }

  async disconnect(): Promise<void> {
    this.vectorIterativeScan = undefined;
    if (this._disconnectPromise) return this._disconnectPromise;
    const work = this.disconnectInternal();
    this._disconnectPromise = work;
    try { await work; }
    finally { if (this._disconnectPromise === work) this._disconnectPromise = null; }
  }

  private async disconnectInternal(): Promise<void> {
    for (const stop of this._beforeDisconnect) await stop();
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
    if (this.connectionManager || this._sql || this._connectionStyle === 'module') {
      await drainBackgroundWorkBeforeDisconnect();
    }
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

  async initSchema(): Promise<void> {
    // v0.30.1 (X1): route DDL through the direct pool when ConnectionManager
    // is in dual-pool mode. The pooler's 2-min statement_timeout truncates
    // SCHEMA_SQL replays + migrations on Supabase; the direct pool gets
    // 30min. Lane B replaces the lock primitive with a TTL+heartbeat table
    // lock; Lane A does the routing and keeps pg_advisory_lock(42) on the
    // SAME connection so the lock is correct.
    const conn = this.connectionManager
      ? await this.connectionManager.ddl()
      : this.sql;

    let dims: number = DEFAULT_EMBEDDING_DIMENSIONS;
    let model: string = DEFAULT_EMBEDDING_MODEL;
    try {
      // Keep the gateway lazy: its static closure is large, and evaluation inside
      // this try/catch preserves the unconfigured-gateway default fallback.
      const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
      // Both accessors THROW when the gateway is unconfigured (they never
      // return falsy), so the catch below is the only fallback path (#3461).
      dims = gw.getEmbeddingDimensions();
      model = gw.getEmbeddingModel();
    } catch { /* gateway not yet configured — use defaults */ }

    const storedIdentity = await readStoredEmbeddingIdentity(this);
    if (storedIdentity) {
      if (!storedIdentity.model) throw new Error('Stored embedding model is unknown. Run gbrain migrate embeddings --status and explicitly migrate before schema initialization.');
      dims = storedIdentity.dimensions;
      model = storedIdentity.model;
    }
    const sqlText = getPostgresSchema(dims, model);

    // Advisory lock prevents concurrent initSchema() calls from deadlocking
    // on DDL statements (DROP TRIGGER + CREATE TRIGGER acquire AccessExclusiveLock).
    //
    // v0.30.1 honest limitation: pg_advisory_lock(42) is session-scoped to
    // `conn`. When dual-pool routing is active, conn is a direct-pool reserved
    // backend, so the lock is held for the duration of initSchema. Lane B
    // replaces this with a TTL+heartbeat table lock that survives pooler-side
    // session resets.
    const t0 = Date.now();
    logConnectionEvent({
      pool: this.connectionManager?.isDualPoolActive() ? 'ddl' : 'read',
      op: 'acquire',
      caller: 'PostgresEngine.initSchema',
    });
    // Lock-census (PR6 D5): INTENTIONALLY brain-global (session lock, fixed key 42) — initSchema DDL mutates the whole database; a per-source key would let two initSchema calls deadlock on shared DDL.
    // #2898: deadlined pg_try_advisory_lock loop + stderr heartbeat instead of
    // an unbounded pg_advisory_lock — a leaked pooler session holding key 42
    // hung every gbrain invocation forever with no output. On timeout the
    // error names the holder pid with pg_terminate_backend recovery guidance.
    await acquireInitSchemaAdvisoryLock((q) => conn.unsafe(q));
    try {
      // Pre-schema bootstrap: add forward-referenced state the embedded schema
      // blob requires but that older brains don't have yet (issues #366/#375/
      // #378/#396 + #266/#357). Idempotent on fresh installs and modern brains.
      // Threads the DDL connection (same one holding the advisory lock above)
      // so bootstrap probes run on the locked connection — without this, the
      // probes ran through `this.sql` (the pooler/instance pool) outside the
      // lock, opening a concurrent-bootstrap race for Supabase users on the
      // transaction pooler. Codex P1 finding from v0.36 dreamy-thompson wave.
      await this.applyForwardReferenceBootstrap(conn);

      await conn.unsafe(sqlText);

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

      // v0.30.1 (Fix 5): sweep zombie HNSW indexes (indisvalid=false) from
      // crashed CREATE INDEX CONCURRENTLY calls. Best-effort; errors logged
      // to stderr but never block engine.connect.
      try {
        const result = await dropZombieIndexes(this);
        if (result.dropped.length > 0) {
          process.stderr.write(`  HNSW sweep: dropped ${result.dropped.length} zombie index(es)\n`);
        }
      } catch { /* best-effort */ }
    } finally {
      await conn`SELECT pg_advisory_unlock(42)`;
      logConnectionEvent({
        pool: this.connectionManager?.isDualPoolActive() ? 'ddl' : 'read',
        op: 'release',
        caller: 'PostgresEngine.initSchema',
        duration_ms: Date.now() - t0,
      });
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

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.transactionOn(this.sql, fn);
  }

  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const conn = !this._pageTransaction && this.connectionManager?.isDualPoolActive()
      ? await this.connectionManager.ddl() : this.sql;
    return this.transactionOn(conn, fn);
  }

  private async transactionOn<T>(conn: ReturnType<typeof postgres>, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    // try/finally, not .finally on the chained promise: begin() can throw
    // SYNCHRONOUSLY (e.g. nested transaction on a tx clone whose conn has no
    // .begin), which would skip a chained .finally and leak the counter.
    if (!this._pageTransaction) this.checkoutGauge.acquire('tx');
    try {
      return await (conn.begin(async (handle) => {
        const tx = composablePostgresTransaction(handle);
        // Create a scoped engine with tx as its connection, no shared state mutation
        const txEngine = Object.create(this) as PostgresEngine;
        Object.defineProperty(txEngine, '_chunkWritesInTransaction', { value: true });
        Object.defineProperty(txEngine, '_pageTransaction', { value: true });
        Object.defineProperty(txEngine, 'sql', { get: () => tx });
        Object.defineProperty(txEngine, '_sql', { value: tx as unknown as ReturnType<typeof postgres>, writable: false });
        return fn(txEngine);
      }) as Promise<T>);
    } finally {
      if (!this._pageTransaction) this.checkoutGauge.release('tx');
    }
  }

  /** Long holds share a budget across every engine that uses the same physical pool. */
  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    let pool = this.sql;
    let releasePermit: (() => void) | null = null;
    if (!this._pageTransaction && this.connectionManager?.isDualPoolActive()) {
      try {
        const direct = await this.connectionManager.ddl();
        releasePermit = tryAcquirePoolLongHold(direct, this.connectionManager.describeMode().direct_pool_size ?? DEFAULT_DIRECT_POOL_SIZE);
        if (releasePermit) pool = direct;
      } catch {
        // A disabled direct route falls back to the same bounded ordinary pool.
      }
    }
    releasePermit ??= tryAcquirePoolLongHold(pool);
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
    try {
      const conn: ReservedConnection = {
        async executeRaw<R = Record<string, unknown>>(
          query: string,
          params?: unknown[],
          opts?: { signal?: AbortSignal },
        ): Promise<R[]> {
          // ReservedConnection.executeRaw doesn't wire AbortSignal today
          // (the only use site is migrations + cycle-lock writes that don't
          // want cancellation). Signature matches the interface so callers
          // that pass opts don't typecheck-break; opts.signal is ignored.
          void opts;
          const rows = params === undefined
            ? await reserved.unsafe(query)
            : await reserved.unsafe(query, params as Parameters<typeof reserved.unsafe>[1]);
          return rows as unknown as R[];
        },
      };
      return await fn(conn);
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
  getPoolDiagnostics(): { tracked: PoolGaugeSnapshot; poolMax: number | null } | null {
    try {
      const max = (this.sql as unknown as { options?: { max?: number } }).options?.max;
      return {
        tracked: this.checkoutGauge.snapshot(),
        poolMax: typeof max === 'number' ? max : null,
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
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx =>
      readCanonicalPageSnapshot(async (query, params) => Array.from(await tx.unsafe(query, params as never)) as never, slug, opts));
  }

  async lockPageKeys(keys: readonly PageKey[]): Promise<void> {
    if (!this._pageTransaction) throw new Error('lockPageKeys requires engine.transaction()');
    await acquirePageKeys(this, keys);
  }

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

  private _pageTransaction = false;

  async putPage(slug: string, page: PageInput, opts?: PageWriteOptions): Promise<Page> {
    slug = validateSlug(slug);
    return this.transaction(async tx => {
      const sourceId = opts?.sourceId ?? 'default';
      await tx.lockPageKeys([{ sourceId, slug }]);
      if (opts?.expectedRevision !== undefined || opts?.force !== undefined) {
        assertPageRevision(await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true }), opts);
      }
      return pagesImpl.putPage((tx as PostgresEngine).engineSql, slug, page, opts);
    });
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
    return pagesImpl.restorePage(this.engineSql, slug, opts);
  }

  async purgeDeletedPages(
    olderThanHours: number,
    opts?: { dryRun?: boolean },
  ): Promise<{ slugs: string[]; count: number; pages?: { slug: string; deleted_at: Date }[] }> {
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
    return pagesImpl.updatePageContextualRetrievalState(this.engineSql, slug, sourceId, mode, corpusGeneration);
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
    // Idempotent by virtue of the WHERE clause matching nothing on re-run.
    //
    // We scope to `expired_at IS NULL` so the migration touches only
    // active facts. Forgotten / superseded rows that already carry an
    // expiry stay where they are — soft-deleting the phantom page is
    // sufficient to make them invisible without rewriting their slug
    // (and rewriting would break the audit trail in listSupersessions).
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

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => pagesImpl.getAllSlugs(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async listAllPageRefs(): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>> {
    return pagesImpl.listAllPageRefs(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'));
  }

  // Sources SQL lives once in ./engine-sql/sources.ts (refactor wave 1, W1-extended).
  async listAllSources(opts?: { includeArchived?: boolean; localPathOnly?: boolean }): Promise<SourceRow[]> {
    return sourcesImpl.listAllSources(unscopedExecutor(this.engineSql, 'sources: unscoped on master (EO4 inventory)'), opts);
  }

  async updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    return sourcesImpl.updateSourceConfig(this.engineSql, sourceId, patch);
  }

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
        visibilityClause: buildVisibilityClause('p', 's', opts),
        detailFilter: detailLow ? `AND cc.chunk_source = 'compiled_truth'` : '',
        opts, dedup: true,
      });
    }

    const params: unknown[] = [query];
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
    const visibilityClause = buildVisibilityClause('p', 's', opts);
    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();

    const rawQuery = `
      WITH ranked_chunks AS (
        SELECT
          p.slug, p.id as page_id, p.title, p.type, p.source_id,
          p.effective_date, p.effective_date_source,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          ts_rank(cc.search_vector, websearch_to_tsquery('${ftsLang}', $1)) * ${sourceFactorCase} AS score
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
          -- v0.27.1: hide image rows from text-keyword search so OCR text
          -- doesn't drown text-page hits. Image search runs a separate
          -- vector path on embedding_image.
          AND cc.modality = 'text'
        ORDER BY score DESC, page_id ASC, chunk_id ASC
        LIMIT ${innerLimitParam}
      ),
      ${buildBestPerPagePoolCte('ranked_chunks')}
      SELECT slug, page_id, title, type, source_id,
        effective_date, effective_date_source,
        message_id, thread_id, source_subject,
        chunk_id, chunk_index, chunk_text, chunk_source, score,
        false AS stale
      FROM best_per_page
      ORDER BY score DESC, page_id ASC, chunk_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING) + search-only
    // timeout. alwaysTransaction: this method needed sql.begin() on master
    // already (SET LOCAL statement_timeout must be transaction-scoped so
    // the GUC can never leak onto a pooled connection). Flag off → the
    // wrap is identical to master's; flag on → set_config('app.scopes')
    // shares the same transaction as the timeout.
    const runKeyword = (queryText: string, relaxed = false) =>
      this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
        await tx`SET LOCAL statement_timeout = '8s'`;
        const previous = relaxed ? await tx`SHOW enable_seqscan` : [];
        if (relaxed) await tx`SET LOCAL enable_seqscan = off`;
        const boundParams = [...params];
        boundParams[0] = queryText;
        const rows = await tx.unsafe(rawQuery, boundParams as Parameters<typeof tx.unsafe>[1]);
        if (relaxed) await tx`SELECT set_config('enable_seqscan', ${previous[0].enable_seqscan}, true)`;
        return rows;
      }, { alwaysTransaction: true });
    let rows = await runKeyword(query);
    // D2 fix (fix/title-retrieval-arm): websearch AND semantics at chunk
    // grain mean one non-co-occurring token zeroes keyword recall. When the
    // strict query returns nothing, retry ONCE with OR-of-terms — through
    // the SAME scoped wrapper (the retry is a fresh scoped transaction, so
    // RLS scope binding applies identically). Strict-AND results always win
    // when non-empty (no change for working queries).
    // Opt-in via SearchOpts.orFallback (Reviewer F1): only hybridSearch's
    // recall arm relaxes; precision consumers (countMentions,
    // link-extraction, eval) keep the strict-AND contract.
    if (rows.length === 0 && opts?.orFallback) {
      const orQuery = buildOrFallbackWebsearchQuery(query);
      if (orQuery) {
        rows = await runKeyword(orQuery, true);
        // 2026-09 (#3617 follow-up): relaxed rows are TAGGED so hybrid's
        // fusion can demote them — an OR-of-common-terms match must not
        // outvote a healthy vector arm (SearchResult.keyword_relaxed doc).
        return rows.map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
      }
    }
    return rows.map(rowToSearchResult);
  }

  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm. SQL lives
   * once in engine-sql/titles.ts (exact-title key #5889, index-backed remote
   * predicate). Each attempt (strict, then OR fallback) runs in its own
   * scoped read transaction with an 8s statement timeout.
   */
  async searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    return titlesImpl.searchTitles(
      (read) => this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => read(scopedRead(this.engineSqlOn(tx))), { alwaysTransaction: true }),
      query,
      opts,
      { statementTimeout: '8s', relaxedPrefersIndex: true, staleProbe: false },
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
        visibilityClause: buildVisibilityClause('p', 's', opts),
        detailFilter: detailLow ? `AND cc.chunk_source = 'compiled_truth'` : '',
        opts, dedup: false,
      });
    }

    const params: unknown[] = [query];
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
    const visibilityClause = buildVisibilityClause('p', 's', opts);
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
    // already wrapped this in sql.begin() for the SET LOCAL; flag off is
    // identical to that wrap, flag on adds set_config in the same tx.
    const rows = await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
      await tx`SET LOCAL statement_timeout = '8s'`;
      return await tx.unsafe(rawQuery, params as Parameters<typeof tx.unsafe>[1]);
    }, { alwaysTransaction: true });
    return rows.map(rowToSearchResult);
  }

  /**
   * #3986: CJK keyword fallback (parity port of PGLite's v0.32.7 branch).
   * SQL builds in the shared cjk-keyword-sql.ts; execution goes through the
   * same scoped read transaction (RLS scope binding + 8s statement timeout)
   * as the FTS keyword paths. See src/core/engine-sql/cjk-search.ts.
   */
  private async _searchKeywordCJK(query: string, ctx: CjkKeywordCtx): Promise<SearchResult[]> {
    return searchKeywordCJKImpl(
      async (read) =>
        await this.withScopedReadTransaction(ctx.opts?.sourceIds, ctx.opts?.sourceId, async (tx) => {
          await tx`SET LOCAL statement_timeout = '8s'`;
          return await read(scopedRead(postgresExecutor(tx, {
            runUnsafe: (conn, sql, params, opts) => this.runUnsafe(conn, sql, params, opts),
            gauge: this.checkoutGauge,
          })));
        }, { alwaysTransaction: true }),
      query,
      ctx,
    );
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    if (opts?.limit && opts.limit > searchLimitCap()) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
    }
    // Two-stage CTE (v0.22): the candidate CTE keeps a pure-distance ORDER BY
    // so the HNSW index stays usable; the outer stages re-rank by source
    // factor. Statement shape, freshness placement (#5824) and pool counts
    // live in search/vector-statement.ts, shared with PGLite and doctor.
    const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding, limit, offset: opts?.offset || 0, opts });
    const iterative = await this.vectorIterativeScanSupported();
    const rows = await searchVectorPool(limit, stmt.innerLimit, iterative, stmt.indexed, 'postgres',
      async attempt => {
        const batch = await this.runVectorAttempt(stmt, attempt, iterative, opts, (tx, sql, bound) => tx.unsafe(sql, bound));
        return { ...readVectorPool(batch), exhausted: attempt.exact };
      },
      async (pool, remainingMs) => {
        const deadline = performance.now() + remainingMs;
        return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async tx => {
          const previous = await tx`SHOW statement_timeout`;
          await tx.unsafe(SET_STATEMENT_TIMEOUT_SQL, [String(remainingVectorBudget(deadline))]);
          const rows = await tx.unsafe(stmt.hasMoreSql, [...stmt.params.slice(0, stmt.innerLimitIdx), pool + 1] as Parameters<typeof tx.unsafe>[1]);
          await tx.unsafe(SET_STATEMENT_TIMEOUT_SQL, [previous[0].statement_timeout]);
          return Number(rows[0].eligible) > pool;
        }, { alwaysTransaction: true });
      },
      opts?.onVectorPoolMeta,
    );
    return rows.map(rowToSearchResult);
  }

  /**
   * EXPLAIN (no ANALYZE) of the first ANN attempt `searchVector` runs for
   * these options: the same statement, bound parameters, scoped read
   * transaction and scan settings, through `tx.unsafe` (the vendored driver
   * never prepares it). Used by doctor `vector_plan` and the plan-proof E2E.
   */
  async explainVectorSearch(embedding: Float32Array, opts?: SearchOpts): Promise<Record<string, unknown>> {
    const limit = clampSearchLimit(opts?.limit, 20, searchLimitCap());
    const stmt = buildVectorSearchStatement({ dialect: 'postgres', embedding, limit, offset: opts?.offset || 0, opts });
    const iterative = await this.vectorIterativeScanSupported();
    const attempt = { innerLimit: stmt.innerLimit, maxScanTuples: 2_000, remainingMs: 8_000, exact: false };
    const [row] = await this.runVectorAttempt(stmt, attempt, iterative, opts, (tx, sql, bound) => tx.unsafe(`EXPLAIN (FORMAT JSON) ${sql}`, bound));
    const plan = row?.['QUERY PLAN'];
    return (Array.isArray(plan) ? plan[0] : plan) as Record<string, unknown>;
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
    stmt: VectorSearchStatement,
    { innerLimit, maxScanTuples, remainingMs, exact }: VectorPoolAttempt,
    iterative: boolean,
    opts: SearchOpts | undefined,
    run: (tx: ReturnType<typeof postgres>, sql: string, bound: Parameters<ReturnType<typeof postgres>['unsafe']>[1]) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    const deadline = performance.now() + remainingMs;
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async tx => {
      return withVectorSettings((sql, values) => tx.unsafe(sql, values as Parameters<typeof tx.unsafe>[1]), iterative, innerLimit, maxScanTuples, async () => {
        const bound = [...stmt.params];
        bound[stmt.innerLimitIdx] = exact ? null : innerLimit;
        await tx.unsafe(SET_STATEMENT_TIMEOUT_SQL, [String(remainingVectorBudget(deadline))]);
        return run(tx, exact ? stmt.exactSql : stmt.sql, bound as Parameters<typeof tx.unsafe>[1]);
      }, deadline);
    }, { alwaysTransaction: true });
  }

  async getEmbeddingsByChunkIds(ids: number[], column: string = 'embedding'): Promise<Map<number, Float32Array>> {
    return chunksImpl.getEmbeddingsByChunkIds(unscopedExecutor(this.engineSql, 'chunks: unscoped on master (EO4 inventory)'), ids, column);
  }

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
  async upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string } & BatchOpts): Promise<void> {
    if (this._chunkWritesInTransaction) return this._upsertChunksOnce(slug, chunks, opts);
    return this.batchRetry(opts?.auditSite ?? 'upsertChunks', opts?.signal,
      () => this.transaction(tx => (tx as PostgresEngine)._upsertChunksOnce(slug, chunks, opts)), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string }): Promise<void> {
    return chunksImpl.upsertChunksOnce(this.engineSql, {
      lockPageKeys: (keys) => this.lockPageKeys(keys),
      readPageSnapshot: (pageSlug, snapshotOpts) => this.readPageSnapshot(pageSlug, snapshotOpts),
    }, slug, chunks, opts);
  }

  getChunkWindows(requests: ChunkWindowRequest[], opts: ChunkWindowOpts): Promise<ChunkWindowPage[]> {
    return this.withScopedReadTransaction(opts.sourceIds?.length ? opts.sourceIds : undefined, opts.sourceIds?.length ? undefined : opts.sourceId, tx => chunksImpl.getChunkWindows(scopedRead(this.engineSqlOn(tx)), requests, opts));
  }

  async getChunks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; excludePrivate?: boolean; requireSafeChunks?: boolean; includeUnsealed?: boolean }): Promise<Chunk[]> {
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = opts?.sourceId ?? 'default';
    const column = (await resolveActiveEmbeddingColumnFromEngine(this, { fallbackToLegacy: true })).name;
    return this.withScopedReadTransaction(sourceIds, sourceIds ? undefined : sourceId, tx => chunksImpl.getChunks(scopedRead(this.engineSqlOn(tx)), column, slug, { sourceIds, sourceId }, opts));
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

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunks(this.engineSql, slug, opts);
  }

  async countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked' }): Promise<number> {
    return this.withScopedReadTransaction(undefined, opts?.sourceId, tx => pagesImpl.countStalePagesForExtraction(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
  }): Promise<StalePageRow[]> {
    return this.withScopedReadTransaction(undefined, opts.sourceId, tx => pagesImpl.listStalePagesForExtraction(scopedRead(this.engineSqlOn(tx)), opts));
  }

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number> {
    return pagesImpl.markPagesExtractedBatch(this.engineSql, refs, defaultExtractedAt);
  }

  async markPagesAttendanceBlocked(refs: Array<{ slug: string; source_id: string; revision: string }>): Promise<number> {
    return pagesImpl.markPagesAttendanceBlocked(this.engineSql, refs);
  }

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

  async getLinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<Link[]> {
    return this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, tx => linksImpl.getLinks(scopedRead(this.engineSqlOn(tx)), slug, opts));
  }

  async getBacklinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<Link[]> {
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
    return pagesImpl.findByTitleFuzzy(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), name, dirPrefix, minSimilarity, sourceId);
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
    return readRelationalFanout(this.executeRaw.bind(this), seeds, opts);
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
    mode?: 'inbound' | 'islanded';
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
         AND (dim_status IS NULL OR dim_status = 'active')
       ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC
       LIMIT 1`;
    const current = cur[0];

    if (current && current.value_hash === vh && !isBackdatedObservation(validFrom, current.valid_from)) {
      // Same value → corroboration, or noop when this provenance already
      // observed the value during the current stint.
      const seen = await sql`
        SELECT 1 FROM facts
         WHERE source_id = ${sourceId} AND entity_slug = ${obs.entitySlug} AND dimension = ${dimension}
           AND value_hash = ${vh} AND source_markdown_slug = ${obs.source}
           AND COALESCE(valid_from, '-infinity'::timestamptz) >= COALESCE(${current.valid_from}::timestamptz, '-infinity'::timestamptz)
         LIMIT 1`;
      if (seen.length) return { action: 'noop', factId: null, supersededId: null };
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
        await sql`UPDATE facts SET valid_until = COALESCE(${validFrom}::timestamptz, now()), superseded_by = ${newId}
                   WHERE id = ${current.id} AND valid_until IS NULL`;
        supersededId = Number(current.id);
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
    // Page-visibility gate on the provenance page, applied BEFORE DISTINCT ON
    // so the untrusted caller resolves the newest value they may see.
    const privacy = opts?.excludePrivate ? sql.unsafe(`AND ${privateProvenanceFilterFragment('facts')}`) : sql``;
    const visibility = opts?.visibility ? sql`AND visibility = ANY(${opts.visibility})` : sql``;
    const rows = await sql<OntologyValue[]>`
      SELECT DISTINCT ON (dimension)
        dimension, value, confidence,
        source_markdown_slug AS source, valid_from, valid_until AS valid_to,
        COALESCE(dim_status, 'active') AS status, id AS fact_id
      FROM facts
      WHERE entity_slug = ${entitySlug} AND dimension IS NOT NULL AND expired_at IS NULL
        ${scope} ${privacy} ${visibility}
        AND COALESCE(valid_from, '-infinity'::timestamptz) <= COALESCE(${asof}::timestamptz, now())
        AND COALESCE(valid_until, 'infinity'::timestamptz) > COALESCE(${asof}::timestamptz, now())
        AND confidence >= ${minConf}
        AND (${includeQ}::boolean OR dim_status IS NULL OR dim_status = 'active')
      ORDER BY dimension, valid_from DESC NULLS LAST, confidence DESC, id DESC`;
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
      WHERE dimension IS NOT NULL AND expired_at IS NULL ${scope}
      GROUP BY dimension ORDER BY entities DESC, dimension`;
    return rows.map((r) => ({ dimension: r.dimension, entities: Number(r.entities), observations: Number(r.observations) }));
  }

  async findOntologyConflicts(opts?: PageReadScope & { minConfidence?: number; visibility?: OntologyReadOpts['visibility'] }): Promise<OntologyConflict[]> {
    const sql = this.sql;
    const minConf = opts?.minConfidence ?? 0;
    const scope = opts?.sourceIds && opts.sourceIds.length
      ? sql`AND source_id = ANY(${opts.sourceIds})`
      : sql`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
    // Same provenance-page gate as getOntology, inside the CTE so a conflict
    // that only exists because of a hidden provenance is never reported.
    const privacy = opts?.excludePrivate ? sql.unsafe(`AND ${privateProvenanceFilterFragment('facts')}`) : sql``;
    const visibility = opts?.visibility ? sql`AND visibility = ANY(${opts.visibility})` : sql``;
    const rows = await sql<{ entity_slug: string; dimension: string; values: OntologyConflict['values'] }[]>`
      WITH cur AS (
        SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
        FROM facts
        WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL
          AND (dim_status IS NULL OR dim_status = 'active')
          AND confidence >= ${minConf} ${scope} ${privacy} ${visibility}
      )
      SELECT entity_slug, dimension,
             json_agg(json_build_object('value', value, 'source', source, 'confidence', confidence, 'fact_id', fact_id)) AS values
      FROM cur
      GROUP BY entity_slug, dimension
      HAVING count(DISTINCT value) >= 2 AND count(DISTINCT source) >= 2
      ORDER BY entity_slug, dimension`;
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
    const privacy = opts?.excludePrivate ? sql.unsafe(`AND ${privatePagesFilterFragment('p')}`) : sql``;
    const alive = opts?.includeDeleted ? sql`` : sql`AND p.deleted_at IS NULL`; // raw_data follows the page soft-delete
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = sourceIds ? undefined : opts?.sourceId;
    let rows;
    if (source && sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ANY(${sourceIds}::text[])`;
    } else if (sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND p.source_id = ANY(${sourceIds}::text[])`;
    } else if (source && sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ${sourceId}`;
    } else if (source) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND rd.source = ${source}`;
    } else if (sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug} AND p.source_id = ${sourceId}`;
    } else {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id ${privacy} ${alive}
        WHERE p.slug = ${slug}`;
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
      // ordering note.
      if (formatted && /halfvec\(\d+\)/i.test(formatted)) {
        this._factsEmbeddingCastSuffix = '::halfvec';
      } else {
        // Default to '::vector' (the pre-v0.41.15 behavior). On a brain
        // without the facts.embedding column yet (pre-v40), the cast
        // suffix is irrelevant — the INSERT would fail elsewhere
        // anyway. Caching the default still saves the SELECT on
        // subsequent inserts.
        this._factsEmbeddingCastSuffix = '::vector';
      }
    } catch {
      // Probe failed — fall back to '::vector' default. Cache so we
      // don't re-probe on every insert.
      this._factsEmbeddingCastSuffix = '::vector';
    }
    return this._factsEmbeddingCastSuffix;
  }

  async insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
    return factsImpl.insertFact(this.engineSql, () => this.resolveFactsEmbeddingCast(), input, ctx);
  }

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
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
    opts?: FactListOpts & { entitySlug?: string; sessionId?: string },
  ): Promise<FactRow[]> {
    return factsImpl.listFactsSince(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, since, opts);
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
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[]; kinds?: FactKind[] },
  ): Promise<FactRow[]> {
    return factsImpl.listSupersessions(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, opts);
  }

  async countUnconsolidatedFacts(source_id: string): Promise<number> {
    return factsImpl.countUnconsolidatedFacts(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id);
  }

  async findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array; embeddingModel?: string | null },
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

  async searchTakes(query: string, opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {}): Promise<TakeHit[]> {
    return takesImpl.searchTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakesVector(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), embedding, opts);
  }

  async getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>> {
    return takesImpl.getTakeEmbeddings(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), ids);
  }

  async countStaleTakes(): Promise<number> {
    return takesImpl.countStaleTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'));
  }

  async listStaleTakes(): Promise<StaleTakeRow[]> {
    return takesImpl.listStaleTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'));
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
  async createVersion(slug: string, opts?: { sourceId?: string }): Promise<PageVersion> {
    return createPageVersion(this, slug, opts?.sourceId ?? 'default');
  }

  async getVersions(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<PageVersion[]> {
    return pagesImpl.getVersions(unscopedExecutor(this.engineSql, 'pages: unscoped on master (EO4 inventory)'), slug, opts);
  }

  async revertToVersion(
    slug: string,
    versionId: number,
    opts?: { sourceId?: string },
  ): Promise<void> {
    return pagesImpl.revertToVersion(this.engineSql, slug, versionId, opts);
  }

  // Stats + health
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
      GROUP BY type ORDER BY count DESC
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
    const sql = this.sql;
    // #4592: optional source scope — same contract as getStats. Every count,
    // coverage numerator AND denominator, degree, and the islanded predicate
    // confine to the scope; a link only contributes when BOTH endpoints are
    // in scope (a granted→ungranted edge must not leak the far side's
    // existence through a degree or rescue a page from orphan-hood).
    const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
    // Bug 11 doc-drift fix — orphan_pages means "islanded" (no inbound AND
    // no outbound links). The raw islanded list is filtered through the same
    // policy as `gbrain orphans` so convention pages do not count against
    // dashboard health.
    // #1305: every page-scoped count here excludes soft-deleted rows — same
    // posture as getStats — so brain_score moves when the user deletes pages.
    // Chunk/link counts stay raw (storage until the purge phase), matching
    // getStats, and destructive-removal counts elsewhere deliberately stay raw.
    // S2: coverage + missing_embeddings key on the registry-ACTIVE column.
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const [h] = await sql`
      WITH scoped_pages AS (
        SELECT id, slug, frontmatter, deleted_at, source_id FROM pages p
        WHERE (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
      ),
      entity_pages AS (
        -- #4280: quarantined entity shells are not served memory — keep them
        -- out of the link/timeline coverage denominators (parity with
        -- onboard's VISIBLE_ENTITY_PREDICATE).
        SELECT id, slug FROM scoped_pages WHERE id IN (
          SELECT id FROM pages WHERE type IN ('entity', 'person', 'company') AND deleted_at IS NULL
            AND ${sql.unsafe(quarantineFilterFragment('pages'))}
        )
      )
      SELECT
        (SELECT count(*) FROM scoped_pages WHERE deleted_at IS NULL) as page_count,
        -- Coverage is the stored-VECTOR truth over ELIGIBLE chunks: keyed on
        -- embedding (not embedded_at, which a schema rebuild leaves stale) and
        -- excluding embed_skip pages from BOTH sides so a brain with zero
        -- remediable work can't read as under-covered. Zero eligible chunks =
        -- vacuous 100%, matching missing_embeddings' exclusion below.
        (SELECT CASE
           WHEN count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')) = 0
           THEN 1.0
           ELSE count(*) FILTER (WHERE cc.${sql.unsafe(colId)} IS NOT NULL
                                   AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
              / count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
         END
         FROM content_chunks cc
         JOIN scoped_pages p ON p.id = cc.page_id) as embed_coverage,
        0 as stale_pages,
        0 as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
           AND (${scope}::text[] IS NULL
                OR EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id))
        ) as dead_links,
        -- missing_embeddings uses the same predicate as the thing that
        -- resolves it: buildStaleChunkWhere / countStaleChunks, i.e. what
        -- 'embed --stale' actually processes. Two divergences existed:
        --   1. embedded_at vs embedding. upsertChunks resets BOTH to NULL
        --      when chunk_text changes, but the stale-chunk predicate keys
        --      on 'embedding IS NULL' deliberately (see the CONSISTENCY note
        --      on that upsert) because embedded_at can be non-NULL while
        --      embedding is NULL. Health should agree with the embedder.
        --   2. embed_skip pages were counted here but excluded there, so
        --      chunks the author opted out of read as permanently "missing"
        --      and the count could never reach zero.
        -- Effect of the mismatch: computeRecommendations emits an embed.stale
        -- step from a number that 'embed --stale' reports as 0, so the step
        -- cannot move it and 'doctor --remediate' re-plans it every pass.
        (SELECT count(*) FROM content_chunks cc
           JOIN scoped_pages p ON p.id = cc.page_id
          WHERE cc.${sql.unsafe(colId)} IS NULL AND p.deleted_at IS NULL
            AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
        ) as missing_embeddings,
        (SELECT count(*) FROM links l
          WHERE (${scope}::text[] IS NULL
             OR (EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id)
                 AND EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.to_page_id)))) as link_count,
        (SELECT count(*) FROM entity_pages) as entity_page_count,
        -- gbrain#4153 consistency: an inbound link counts toward coverage
        -- only when its SOURCE page is live — the same endpoint-liveness rule
        -- the islanded predicate below applies, so an entity whose only
        -- inbound link comes from a soft-deleted page can't read as covered
        -- AND islanded in one payload.
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM links l
                       JOIN scoped_pages src ON src.id = l.from_page_id
                       WHERE l.to_page_id = e.id AND src.deleted_at IS NULL))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as link_coverage,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as timeline_coverage
    `;

    // X8 (#4592): a degree counts an edge only when its FAR endpoint is in
    // scope too — otherwise a granted→ungranted edge leaks through the count.
    // NULL scope keeps the historical raw degree (far-endpoint EXISTS against
    // an unfiltered pages row is FK-total for live links; dead links kept by
    // the OR NOT EXISTS arm so unscoped output is byte-identical).
    const connected = await sql`
      SELECT p.slug,
             (SELECT count(*) FROM links l
               WHERE (l.from_page_id = p.id
                      AND (${scope}::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.to_page_id AND fp.source_id = ANY(${scope}))))
                  OR (l.to_page_id = p.id
                      AND (${scope}::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.from_page_id AND fp.source_id = ANY(${scope}))))
             )::int as link_count
      FROM pages p
      WHERE p.type IN ('entity', 'person', 'company') AND p.deleted_at IS NULL
        AND ${sql.unsafe(QUARANTINE_FILTER_FRAGMENT)}
        AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
      ORDER BY link_count DESC
      LIMIT 5
    `;

    // Per-page flags for the linkable scope: orphan_pages and the
    // no-orphans / timeline-coverage DENOMINATORS are all computed over
    // pages the shared orphan-reporting policy considers linkable (the same
    // scope `gbrain orphans` and doctor's orphan_ratio use), so one doctor
    // report cannot carry two contradictory orphan/coverage numbers.
    // Archive (raw/), generated, and daily-log pages are not expected to
    // participate in the curated graph. Filtered in TS because the policy
    // includes per-brain config overrides. PGLite path has the same logic.
    // gbrain#4153: endpoint liveness in BOTH directions — an inbound link
    // only counts when its SOURCE page is live (the invariant
    // findOrphanPages documents), and an outbound link only counts when its
    // TARGET is live. Without this, get_health's orphan_pages disagreed with
    // `gbrain orphans` whenever a soft-deleted page still linked to (or was
    // linked from) a live one.
    // #4592: out-of-scope endpoints cannot rescue a page from orphan-hood —
    // the caller's graph IS its grant.
    // #4280: quarantined pages drop out of the linkable scope in SQL;
    // machine leaf types (atom/conversation/source) drop out through the
    // shared policy below via p.type.
    const pageScopeRows = await sql<{ slug: string; type: string; islanded: boolean; has_timeline: boolean }[]>`
      SELECT p.slug, p.type,
             (NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages src ON src.id = l.from_page_id
                          WHERE l.to_page_id = p.id AND src.deleted_at IS NULL
                            AND (${scope}::text[] IS NULL OR src.source_id = ANY(${scope})))
              AND NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages tgt ON tgt.id = l.to_page_id
                          WHERE l.from_page_id = p.id AND tgt.deleted_at IS NULL
                            AND (${scope}::text[] IS NULL OR tgt.source_id = ANY(${scope})))) as islanded,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) as has_timeline
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ${sql.unsafe(QUARANTINE_FILTER_FRAGMENT)}
        AND (${scope}::text[] IS NULL OR p.source_id = ANY(${scope}))
    `;

    const pageCount = Number(h.page_count);
    const embedCoverage = Number(h.embed_coverage);
    // Scoped: sum the scalar-sourceId counter per grant (grants are small);
    // the unmatchable __all__ sentinel scalar fail-closes to 0 naturally.
    const stalePages = scope === null
      ? await this.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })
      : (await Promise.all(scope.map(sid =>
          this.countStalePagesForExtraction({ sourceId: sid, versionTs: LINK_EXTRACTOR_VERSION_TS }),
        ))).reduce((a, b) => a + b, 0);
    const orphanOverrides = await loadOrphanPolicyOverrides(this);
    const linkablePages = pageScopeRows.filter(row =>
      !shouldExcludeFromOrphanReporting(row.slug, orphanOverrides, { type: row.type }));
    const linkablePageCount = linkablePages.length;
    const orphanPages = linkablePages.filter(row => row.islanded).length;
    const linkableTimelinePages = linkablePages.filter(row => row.has_timeline).length;
    const deadLinks = Number(h.dead_links);
    const linkCount = Number(h.link_count);

    // brain_score: 0-100 weighted average
    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    // linkablePageCount === 0 gets full marks for the orphan / timeline
    // components (same vacuous-truth rule as the empty-brain fix below):
    // an all-archive brain has no curated graph to penalize.
    const timelineCoverageWhole =
      linkablePageCount > 0 ? Math.min(linkableTimelinePages / linkablePageCount, 1) : 1;
    const noOrphans = linkablePageCount > 0 ? 1 - (orphanPages / linkablePageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    // Per-component points. Sum equals brainScore by construction.
    //
    // v0.37.10.0: empty brains (pageCount === 0) get FULL marks (100/100),
    // not 0. Semantically an empty brain has no coverage problem to penalize
    // — there's nothing to embed, nothing to link, nothing to orphan. The
    // pre-fix "empty = 0" caused fresh-init brains to score as critically
    // unhealthy on `gbrain doctor`, which was a structural surprise to users
    // who'd just successfully run init. PGLite path has the same fix.
    const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineCoverageWhole * 15);
    const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
    const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

    return {
      page_count: pageCount,
      linkable_page_count: linkablePageCount,
      embed_coverage: embedCoverage,
      stale_pages: stalePages,
      orphan_pages: orphanPages,
      missing_embeddings: Number(h.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      entity_page_count: Number(h.entity_page_count),
      // gbrain#4147: below the small-N floor the ratio is statistically
      // meaningless (0/0 used to read as a hard 0%), so it reports null and
      // consumers suppress both the percentage and its remediation actions.
      link_coverage: Number(h.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(h.link_coverage) : null,
      timeline_coverage: Number(h.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(h.timeline_coverage) : null,
      most_connected: (connected as unknown as { slug: string; link_count: number }[]).map(c => ({
        slug: c.slug,
        link_count: Number(c.link_count),
      })),
      embed_coverage_score: embedCoverageScore,
      link_density_score: linkDensityScore,
      timeline_coverage_score: timelineCoverageScore,
      no_orphans_score: noOrphansScore,
      no_dead_links_score: noDeadLinksScore,
    };
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    const sql = this.sql;
    // v0.31.2 (codex P1 #3): source_id threaded so multi-source brains can
    // scope ingest_log queries. Default 'default' matches the column DEFAULT.
    const sourceId = entry.source_id ?? 'default';
    await sql`
      INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary)
      VALUES (${sourceId}, ${entry.source_type}, ${entry.source_ref}, ${sql.json(entry.pages_updated)}, ${entry.summary})
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
    const rows = await sql`
      SELECT * FROM ingest_log ${scope} ORDER BY created_at DESC LIMIT ${limit}
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

  async setPageAliases(slug: string, sourceId: string, aliasNorms: string[]): Promise<void> {
    return this.transaction(tx => pagesImpl.setPageAliases((tx as PostgresEngine).engineSql, tx, slug, sourceId, aliasNorms));
  }

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
    // #1603: a transient pooler drop on this read used to throw / fall through
    // to defaults silently — which on remote Postgres surfaces as the wrong
    // search mode/knobs and empty-stdout queries.
    return this.connRetry(async () => {
      const rows = await this.sql`SELECT value FROM config WHERE key = ${key}`;
      return rows.length > 0 ? (rows[0].value as string) : null;
    });
  }

  async setConfig(key: string, value: string): Promise<void> {
    return this.connRetry(async () => {
      await this.sql`
        INSERT INTO config (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
    });
  }

  async unsetConfig(key: string): Promise<number> {
    return this.connRetry(async () => {
      const result = await this.sql`DELETE FROM config WHERE key = ${key}` as unknown as { count: number };
      return result.count ?? 0;
    });
  }

  async listConfigKeys(prefix: string): Promise<string[]> {
    // LIKE-escape literal % and _ so a config key with those chars resolves
    // correctly. Pure string work — stays outside the retried thunk.
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `${escaped}%`;
    return this.connRetry(async () => {
      const rows = await this.sql<{ key: string }[]>`
        SELECT key FROM config WHERE key LIKE ${pattern} ESCAPE '\\' ORDER BY key
      `;
      return rows.map(r => r.key);
    });
  }

  async getAllConfig(): Promise<Record<string, string>> {
    return this.connRetry(async () => {
      const rows = await this.sql<{ key: string; value: string }[]>`
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
      // New pool is live — discard the old one best-effort.
      if (oldSql) { try { await oldSql.end({ timeout: 5 }); } catch { /* swallow */ } }
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
    return (async () => {
      const signal = opts?.signal;
      let reserved: postgres.ReservedSql | undefined;
      let pending: ReturnType<typeof conn.unsafe> | undefined;
      let cancellation: Promise<void> | undefined;
      let retired = false;
      let owner: postgres.TransactionSql | postgres.ReservedSql = conn as unknown as postgres.TransactionSql;
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        reserved = signal && typeof conn.reserve === 'function' ? await reserveWithCancellation(opts => conn.reserve(opts), signal) : undefined;
        if (reserved) conn = reserved;
        owner = reserved ?? conn as unknown as postgres.TransactionSql;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (signal && !hasPostgresCancellationCapability(owner)) throw postgresCancellationUnavailable();
        // prepare/simple are forwarded only when a caller sets them (the
        // engine-sql adapter, EO2); executeRaw/executeRawDirect never do.
        const driverOpts = opts?.prepare === undefined && opts?.simple === undefined
          ? { cancelFence: !!signal }
          : { cancelFence: !!signal, prepare: opts.prepare, simple: opts.simple };
        pending = conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1], driverOpts);
        return await pending as unknown as T[];
      } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
          if (cancellation) await cancellation;
          if (retired) owner.discard();
        } finally { reserved?.release(); }
      }
      function onAbort() {
        if (!pending || cancellation) return;
        try { cancellation = pending.cancel().catch(() => { retired = true; }); }
        catch { retired = true; }
      }
    })();
  }

  async executeRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    // try/finally (not .finally on the promise): runUnsafe throws
    // SYNCHRONOUSLY on a pre-aborted signal, which would skip a chained
    // .finally and leak the counter.
    this.checkoutGauge.acquire('raw');
    try {
      return await this.runUnsafe<T>(this.sql, sql, params, opts);
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
      return await this.runUnsafe<T>(conn, sql, params, opts);
    } finally {
      this.checkoutGauge.release('direct');
    }
  }

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

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCallersOf(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), qualifiedName, opts);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number; bareFallback?: boolean },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCalleesOf(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), qualifiedName, opts);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getEdgesByChunk(unscopedExecutor(this.engineSql, 'code-edges: unscoped on master (EO4 inventory)'), chunkId, opts);
  }

  // Eval capture (v0.25.0). See BrainEngine interface docs.
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO eval_candidates (
        tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
        expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
        latency_ms, remote, job_id, subagent_id, embedding_column
      ) VALUES (
        ${input.tool_name}, ${input.query}, ${input.retrieved_slugs}, ${input.retrieved_chunk_ids}, ${input.source_ids},
        ${input.expand_enabled}, ${input.detail}, ${input.detail_resolved}, ${input.vector_enabled}, ${input.expansion_applied},
        ${input.latency_ms}, ${input.remote}, ${input.job_id}, ${input.subagent_id}, ${input.embedding_column ?? null}
      )
      RETURNING id
    `;
    return rows[0]!.id as number;
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
      ORDER BY ts DESC
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
}
