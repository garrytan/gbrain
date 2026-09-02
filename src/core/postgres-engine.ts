import postgres from 'postgres';
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
  FactRow, FactInsertStatus,
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
  isNovelDimension,
} from './chronicle/ontology.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import type {
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow,
} from './types.ts';
import { DREAM_VERDICT_TTL_SECONDS, MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { executeRawJsonb, type SqlValue } from './sql-query.ts';
import { sanitizeForJsonb, sanitizeText, buildLinkRows, buildTimelineRows } from './batch-rows.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.generated.ts';
import { verifySchema } from './schema-verify.ts';
import { applyChunkEmbeddingIndexPolicy, dropZombieIndexes, hnswEfSearchFor, hnswIndexExpected, HNSW_EF_SEARCH_MAX } from './vector-index.ts';
import {
  normalizeEngineColumn,
  buildVectorCastFragment,
  vectorCastSuffix,
  resolveActiveEmbeddingColumnFromEngine,
  resolveWriteColumnFromConfigRows,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from './search/embedding-column.ts';
import { getFtsLanguage, applyFtsLanguagePolicy } from './fts-language.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
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
import { privatePagesFilterFragment } from './search/private-visibility.ts';
import { unverifiedExtractionFragment } from './extraction-review.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { DELETE_BATCH_SIZE, TRAVERSE_PATH_ROW_CAP } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from './source-config-sql.ts';
import { shouldExcludeFromOrphanReporting, loadOrphanPolicyOverrides } from './orphan-policy.ts';
import { LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from './embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT, quarantineFilterFragment } from './quarantine.ts';
import { acquireInitSchemaAdvisoryLock } from './postgres-engine/init-schema-lock.ts';
import { applyPostgresForwardReferenceBootstrap } from './postgres-engine/forward-reference-bootstrap.ts';
import * as factsImpl from './postgres-engine/facts.ts';
import type { PgFactsDeps } from './postgres-engine/facts.ts';
import * as takesImpl from './postgres-engine/takes.ts';
import type { PgTakesDeps } from './postgres-engine/takes.ts';
import * as codeEdgesImpl from './postgres-engine/code-edges.ts';
import type { PgCodeEdgesDeps } from './postgres-engine/code-edges.ts';
import * as salienceImpl from './postgres-engine/salience.ts';
import type { PgSalienceDeps } from './postgres-engine/salience.ts';
import { hasCJK } from './cjk.ts';
import { searchKeywordCJK as searchKeywordCJKImpl } from './postgres-engine/cjk-search.ts';
import type { CjkKeywordCtx } from './search/cjk-keyword-sql.ts';

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
  readonly kind = 'postgres' as const;
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
    // Note on nesting: a postgres.js transaction handle exposes
    // `.savepoint()` not `.begin()`, so callbacks must not try to open
    // their own `tx.begin()` inside this wrap — they'd fail with
    // `tx.begin is not a function`. Callbacks that need SET LOCAL emit it
    // directly on the handle (it shares this transaction).
    //
    // `sql.begin<T>(...)` returns `UnwrapPromiseArray<T>` in postgres.js's typings
    // — TypeScript strict-generics can't narrow that back to `T` for arbitrary
    // callback return shapes (TS2322). The unwrap is a no-op when the callback
    // returns a single value (not an array of promises), so the cast is safe.
    return (await this.sql.begin(async (tx: any) => {
      if (this.rlsScopeBindingEnabled) {
        // `SET LOCAL` doesn't accept parameters in PostgreSQL — using
        // `tx\`SET LOCAL ... = ${val}\`` binds val as $1 and errors with
        // `syntax error at or near "$1"`. set_config() is a regular function
        // and accepts a parameterised value; passing `true` as the third
        // argument makes it transaction-local (same scope as SET LOCAL).
        await tx`SELECT set_config('app.scopes', ${scopesValue}, true)`;
      }
      return await callback(tx as ReturnType<typeof postgres>);
    })) as T;
  }

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<void> {
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

    // Resolve the embedding dim/model from the gateway. v0.37 fix wave:
    // fallbacks track the canonical defaults in `ai/defaults.ts` instead of
    // stale v0.13 OpenAI literals, AND we store the full `provider:model`
    // string in the DB config table — consumers like ze-switch and doctor
    // expect the provider prefix. (Round-1 CDX-4 + A.8.)
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
   * Bootstrap state that SCHEMA_SQL forward-references but that older brains
   * don't have yet. Mirror of `PGLiteEngine#applyForwardReferenceBootstrap`
   * in shape and intent. The probe set + DDL live in the shared module
   * `src/core/postgres-engine/forward-reference-bootstrap.ts` (#4477) so the
   * standalone `db.initSchema()` SCHEMA_SQL-replay path runs the SAME
   * bootstrap — keep that module in sync with the PGLite version; covered by
   * `test/schema-bootstrap-coverage.test.ts` (PGLite side) and
   * `test/e2e/postgres-bootstrap.test.ts` (Postgres side).
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
    const conn = this.sql;
    // try/finally, not .finally on the chained promise: begin() can throw
    // SYNCHRONOUSLY (e.g. nested transaction on a tx clone whose conn has no
    // .begin), which would skip a chained .finally and leak the counter.
    this.checkoutGauge.acquire('tx');
    try {
      return await (conn.begin(async (tx) => {
        // Create a scoped engine with tx as its connection, no shared state mutation
        const txEngine = Object.create(this) as PostgresEngine;
        Object.defineProperty(txEngine, 'sql', { get: () => tx });
        Object.defineProperty(txEngine, '_sql', { value: tx as unknown as ReturnType<typeof postgres>, writable: false });
        return fn(txEngine);
      }) as Promise<T>);
    } finally {
      this.checkoutGauge.release('tx');
    }
  }

  /**
   * issue #6 (reserved-connection routing): concurrent DIRECT-pool reserves
   * are capped at directPoolSize - 1 so the claim/renewLock heartbeats always
   * keep >= 1 direct slot; overflow falls back to the READ pool — exactly the
   * pre-routing behavior, so this change is strictly never-worse than the
   * status quo (deliberate rejection of queue-for-a-permit: that would block
   * migrations behind multi-minute CREATE INDEX holds). Per-process by
   * design: each process owns its own direct pool, so a CLI migration's
   * reserves cannot starve a worker's heartbeats.
   */
  private _reservedDirectInFlight = 0;

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    // Long-hold reserved work (CREATE INDEX CONCURRENTLY, transaction:false
    // migration DDL, backfill BEGIN..COMMIT batches) belongs on the DIRECT
    // session lane: 30-min statement_timeout + maintenance_work_mem GUCs and
    // it stops pinning the worker's shared read pool (the observed 353s
    // COMMIT in issue #6 was a reserved read-pool slot). Never reroute inside
    // an open transaction (same guard shape as executeRawDirect).
    const inTransaction = this._sql !== null && this.connectionManager?.peekReadPool() !== this._sql;
    let pool = this.sql;
    let fromDirect = false;
    if (!inTransaction && this.connectionManager?.isDualPoolActive()) {
      const size = this.connectionManager.describeMode().direct_pool_size ?? DEFAULT_DIRECT_POOL_SIZE;
      // NO floor on the cap (red-team finding): at direct_pool_size=1 a
      // Math.max(1, ...) floor would let a multi-minute reserve consume the
      // ONLY direct session and starve claim/renewLock heartbeats — the
      // exact #6 class, reintroduced on the direct pool. cap <= 0 means the
      // direct lane has no spare capacity for reserves: use the read pool
      // (the true status quo).
      const cap = size - 1;
      if (cap >= 1 && this._reservedDirectInFlight < cap) {
        // Take the permit in the SAME synchronous frame as the check — a
        // check-then-increment spanning `await ddl()` is a TOCTOU that lets
        // same-tick concurrent reserves overshoot the cap and starve the
        // heartbeat slot the cap exists to protect (adversarial-review P2).
        this._reservedDirectInFlight += 1;
        fromDirect = true;
        try {
          pool = await this.connectionManager.ddl();
        } catch {
          // ddl() failure flips its own kill switch; fall back to the read
          // pool (status quo) rather than failing the caller.
          this._reservedDirectInFlight -= 1;
          fromDirect = false;
          pool = this.sql;
        }
      }
    }
    // Gauge BEFORE reserve(): a reserve() stuck waiting for a free slot is
    // exactly the in-flight pressure the probe diagnostics should surface.
    this.checkoutGauge.acquire('reserved');
    let reserved: Awaited<ReturnType<typeof pool.reserve>>;
    try {
      reserved = await pool.reserve();
    } catch (e) {
      this.checkoutGauge.release('reserved');
      if (fromDirect) this._reservedDirectInFlight -= 1;
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
      if (fromDirect) this._reservedDirectInFlight -= 1;
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
  async getPage(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeDeleted?: boolean }): Promise<Page | null> {
    const includeDeleted = opts?.includeDeleted === true;
    const sourceId = opts?.sourceId;
    const sourceIds = opts?.sourceIds;
    // Two layers of defense:
    //   1. RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING): wraps the
    //      query in a transaction that sets `app.scopes` so the row-level
    //      policy on `pages` filters at the SQL layer. Pass-through when off.
    //   2. App-layer source filter (#1393): a federated grant (sourceIds[])
    //      takes precedence over scalar sourceId so the exact-match read
    //      honors allowedSources, not just one source.
    return await this.withScopedReadTransaction(sourceIds, sourceId, async (tx) => {
      // v0.26.5: default hides soft-deleted rows. Compose with optional source
      // filter via fragment chaining (postgres.js supports sql`` composition).
      const sourceCondition =
        sourceIds && sourceIds.length > 0
          ? tx`AND source_id = ANY(${sourceIds}::text[])`
          : sourceId
            ? tx`AND source_id = ${sourceId}`
            : tx``;
      const deletedCondition = includeDeleted ? tx`` : tx`AND deleted_at IS NULL`;
      // #3931: anchor on sourceIds[0] (caller's own resolved source, see
      // localFederatedSourceIds) instead of a hardcoded 'default'.
      const anchorSourceId = sourceIds && sourceIds.length > 0 ? sourceIds[0] : 'default';
      const rows = await tx`
        SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, deleted_at,
               effective_date, effective_date_source,
               source_kind, source_uri, ingested_via, ingested_at,
               contextual_retrieval_mode
        FROM pages
        WHERE slug = ${slug} ${sourceCondition} ${deletedCondition}
        ORDER BY (source_id = ${anchorSourceId}) DESC, source_id ASC
        LIMIT 1
      `;
      // Deterministic multi-source tiebreak: anchor-source-first, then stable
      // alpha. Engine parity: pglite-engine.ts carries the identical clause.
      if (rows.length === 0) return null;
      return rowToPage(rows[0]);
    });
  }

  /**
   * v0.41.13 (#1309) — identity-based dedup pre-check.
   * See `BrainEngine.findDuplicatePage` for the contract.
   */
  async findDuplicatePage(
    sourceId: string,
    opts: { hash: string; frontmatterId?: string | null },
  ): Promise<{ slug: string; id: number } | null> {
    const fmId = opts.frontmatterId ?? null;
    // RLS scope binding: sourceId is positional here.
    return await this.withScopedReadTransaction(undefined, sourceId, async (tx) => {
      const rows = await tx`
        SELECT id, slug FROM pages
        WHERE source_id = ${sourceId}
          AND deleted_at IS NULL
          AND (content_hash = ${opts.hash} OR (frontmatter->>'id' = ${fmId} AND ${fmId}::text IS NOT NULL))
        ORDER BY id
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const r = rows[0] as { id: number | string; slug: string };
      return { slug: r.slug, id: Number(r.id) };
    });
  }

  async putPage(slug: string, page: PageInput, opts?: { sourceId?: string; allowEmptyOverwrite?: boolean }): Promise<Page> {
    slug = validateSlug(slug);
    const sql = this.sql;
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};
    const sourceId = opts?.sourceId ?? 'default';

    // Data-loss guard: a page edit is a read-modify-write; if the read returned
    // empty, the modify lands on nothing and this upsert would blank the body
    // over real content (ON CONFLICT sets compiled_truth = EXCLUDED.* flat).
    // Only fires when the incoming body is itself blank, so the common
    // non-empty write pays no extra query. Deletes use deletePage; a deliberate
    // clear passes allowEmptyOverwrite. See isBlankBody.
    if (isBlankBody(page.compiled_truth) && !opts?.allowEmptyOverwrite) {
      const prior = await sql<{ compiled_truth: string | null }[]>`
        SELECT compiled_truth FROM pages
        WHERE source_id = ${sourceId} AND slug = ${slug} AND deleted_at IS NULL
        LIMIT 1`;
      if (prior[0] && !isBlankBody(prior[0].compiled_truth)) {
        throw new Error(
          `putPage: refusing to overwrite non-empty page '${slug}' ` +
            `(${prior[0].compiled_truth!.length} chars) with an empty body — ` +
            `likely a read-modify-write that read empty. Pass ` +
            `{ allowEmptyOverwrite: true } to force, or deletePage to remove it.`,
        );
      }
    }

    // v0.18.0 Step 5+: source_id is now in the INSERT column list so multi-
    // source callers actually land on the (source_id, slug) row they intend.
    // Pre-fix: omitting source_id let the schema DEFAULT 'default' apply, so
    // a caller syncing under 'jarvis-memory' silently fabricated a duplicate
    // at (default, slug); subsequent bare-slug subqueries (getTags, deleteChunks,
    // etc.) then matched 2 rows and blew up with Postgres 21000.
    // ON CONFLICT target is (source_id, slug); global UNIQUE(slug) dropped in v17.
    const pageKind = page.page_kind || 'markdown';
    // v0.29.1 — effective_date / effective_date_source / import_filename are
    // additive opt-in inputs from the importer (computeEffectiveDate). When
    // omitted, the ON CONFLICT path preserves any existing value via
    // COALESCE(EXCLUDED.x, pages.x) so a putPage that doesn't know about
    // these columns (auto-link, code reindex, etc.) doesn't blank them out.
    const effectiveDate = page.effective_date ?? null;
    const effectiveDateSource = page.effective_date_source ?? null;
    const importFilename = page.import_filename ?? null;
    // v0.32.7 CJK wave: chunker_version + source_path columns.
    const chunkerVersion = page.chunker_version ?? null;
    const sourcePath = page.source_path ?? null;
    // v0.39.3.0 provenance write-through (WARN-8 + CV12). Server stamps
    // `ingested_at = now()` ONLY when any provenance is being written —
    // null `source_kind` / `source_uri` / `ingested_via` means no provenance
    // write fired this call, and COALESCE-preserve UPDATE keeps the prior
    // first-write timestamp intact (audit trail survives routine edits).
    const sourceKind = page.source_kind ?? null;
    const sourceUri = page.source_uri ?? null;
    const ingestedVia = page.ingested_via ?? null;
    const ingestedAt = (sourceKind || sourceUri || ingestedVia) ? new Date() : null;
    const rows = await sql`
      INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at, effective_date, effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at)
      VALUES (${sourceId}, ${slug}, ${page.type}, ${pageKind}, ${sanitizeText(page.title)}, ${sanitizeText(page.compiled_truth)}, ${sanitizeText(page.timeline || '')}, ${sql.json(frontmatter as Parameters<typeof sql.json>[0])}, ${hash}, now(), ${effectiveDate}, ${effectiveDateSource}, ${importFilename}, COALESCE(${chunkerVersion}::smallint, ${MARKDOWN_CHUNKER_VERSION}), ${sourcePath}, ${sourceKind}, ${sourceUri}, ${ingestedVia}, ${ingestedAt})
      ON CONFLICT (source_id, slug) DO UPDATE SET
        type = EXCLUDED.type,
        page_kind = EXCLUDED.page_kind,
        title = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        timeline = EXCLUDED.timeline,
        frontmatter = EXCLUDED.frontmatter,
        content_hash = EXCLUDED.content_hash,
        updated_at = now(),
        deleted_at = NULL,
        effective_date        = COALESCE(EXCLUDED.effective_date,        pages.effective_date),
        effective_date_source = COALESCE(EXCLUDED.effective_date_source, pages.effective_date_source),
        import_filename       = COALESCE(EXCLUDED.import_filename,       pages.import_filename),
        chunker_version       = COALESCE(EXCLUDED.chunker_version,       pages.chunker_version),
        source_path           = COALESCE(EXCLUDED.source_path,           pages.source_path),
        source_kind           = COALESCE(EXCLUDED.source_kind,           pages.source_kind),
        source_uri            = COALESCE(EXCLUDED.source_uri,            pages.source_uri),
        ingested_via          = COALESCE(EXCLUDED.ingested_via,          pages.ingested_via),
        ingested_at           = COALESCE(EXCLUDED.ingested_at,           pages.ingested_at)
      RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, effective_date, effective_date_source, import_filename, source_kind, source_uri, ingested_via, ingested_at
    `;
    return rowToPage(rows[0]);
  }

  async deletePage(slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    await sql`DELETE FROM pages WHERE slug = ${slug} AND source_id = ${sourceId}`;
  }

  /**
   * v0.41.19.0 — batch delete primitive. See BrainEngine.deletePages JSDoc.
   * Single SQL round-trip per call; caller is responsible for chunking input
   * to <= DELETE_BATCH_SIZE. RETURNING slug projects the actually-deleted set
   * so the caller can filter pagesAffected.
   */
  async deletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `deletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const sql = this.sql;
    const rows = await sql<{ slug: string }[]>`
      DELETE FROM pages
       WHERE slug = ANY(${slugs}::text[]) AND source_id = ${opts.sourceId}
      RETURNING slug
    `;
    return rows.map(r => r.slug);
  }

  /**
   * v0.41.19.0 — batch path → slug resolution. See BrainEngine.resolveSlugsByPaths
   * JSDoc. Single SQL round-trip; folds rows into a Map.
   */
  async resolveSlugsByPaths(
    paths: string[],
    opts: { sourceId: string },
  ): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    if (paths.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `resolveSlugsByPaths: input size ${paths.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const sql = this.sql;
    const rows = await sql<{ slug: string; source_path: string }[]>`
      SELECT slug, source_path
        FROM pages
       WHERE source_path = ANY(${paths}::text[]) AND source_id = ${opts.sourceId}
    `;
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.source_path, r.slug);
    return m;
  }

  async softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null> {
    const sql = this.sql;
    const sourceId = opts?.sourceId;
    // Idempotent-as-null contract: only flip rows that are currently active.
    // RETURNING projects the slug so we can tell hit-vs-miss without a probe.
    const sourceCondition = sourceId ? sql`AND source_id = ${sourceId}` : sql``;
    const rows = await sql`
      UPDATE pages SET deleted_at = now()
      WHERE slug = ${slug} AND deleted_at IS NULL ${sourceCondition}
      RETURNING slug
    `;
    if (rows.length === 0) return null;
    return { slug: rows[0].slug as string };
  }

  /**
   * #4587 — batch soft-delete primitive. See BrainEngine.softDeletePages
   * JSDoc. Mirrors deletePages' shape (empty-array early-return, batch-size
   * throw, RETURNING slug) with softDeletePage's `deleted_at IS NULL`
   * idempotency predicate. Nothing cascades — the 72h purge phase owns the
   * eventual hard delete.
   */
  async softDeletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `softDeletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const sql = this.sql;
    const rows = await sql<{ slug: string }[]>`
      UPDATE pages SET deleted_at = now()
       WHERE slug = ANY(${slugs}::text[]) AND source_id = ${opts.sourceId} AND deleted_at IS NULL
      RETURNING slug
    `;
    return rows.map(r => r.slug);
  }

  async restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    const sql = this.sql;
    const sourceId = opts?.sourceId;
    const sourceCondition = sourceId ? sql`AND source_id = ${sourceId}` : sql``;
    const rows = await sql`
      UPDATE pages SET deleted_at = NULL
      WHERE slug = ${slug} AND deleted_at IS NOT NULL ${sourceCondition}
      RETURNING slug
    `;
    return rows.length > 0;
  }

  async purgeDeletedPages(
    olderThanHours: number,
    opts?: { dryRun?: boolean },
  ): Promise<{ slugs: string[]; count: number; pages?: { slug: string; deleted_at: Date }[] }> {
    const sql = this.sql;
    // Clamp to non-negative integer; runaway purge protection. The DELETE
    // cascades through content_chunks, page_links, chunk_relations via FKs.
    const hours = Math.max(0, Math.floor(olderThanHours));
    if (opts?.dryRun) {
      // SAME WHERE predicate as the DELETE below (same cutoff arithmetic,
      // same DB now() clock source) — only the verb differs, so preview and
      // purge agree modulo rows crossing the cutoff between statements.
      const rows = await sql`
        SELECT slug, deleted_at FROM pages
        WHERE deleted_at IS NOT NULL
          AND deleted_at < now() - (${hours} || ' hours')::interval
        ORDER BY deleted_at ASC, slug ASC
      `;
      const pages = rows.map((r) => ({
        slug: r.slug as string,
        deleted_at: r.deleted_at instanceof Date ? (r.deleted_at as Date) : new Date(r.deleted_at as string),
      }));
      return { slugs: pages.map((p) => p.slug), count: pages.length, pages };
    }
    const rows = await sql`
      DELETE FROM pages
      WHERE deleted_at IS NOT NULL
        AND deleted_at < now() - (${hours} || ' hours')::interval
      RETURNING slug
    `;
    const slugs = rows.map((r) => r.slug as string);
    return { slugs, count: slugs.length };
  }

  async refreshPageBody(
    slug: string,
    sourceId: string,
    compiledTruth: string,
    timeline: string,
    contentHash: string,
  ): Promise<void> {
    const sql = this.sql;
    // Narrow UPDATE — leaves frontmatter, type, chunks, links, embeddings,
    // tags, takes untouched. Skips soft-deleted rows so a redirect retry
    // can't accidentally reanimate the body of a deleted canonical.
    await sql`
      UPDATE pages
      SET compiled_truth = ${compiledTruth},
          timeline = ${timeline},
          content_hash = ${contentHash},
          updated_at = now()
      WHERE source_id = ${sourceId}
        AND slug = ${slug}
        AND deleted_at IS NULL
    `;
  }

  async updatePageContextualRetrievalState(
    slug: string,
    sourceId: string,
    mode: string,
    corpusGeneration: string | null,
  ): Promise<void> {
    const sql = this.sql;
    // Narrow UPDATE — bumps updated_at as a side effect so the autopilot
    // sweep doesn't think the page hasn't changed since last touch. Skips
    // soft-deleted rows. corpus_generation nullable (caller passes NULL
    // for the 'none' tier path).
    await sql`
      UPDATE pages
      SET contextual_retrieval_mode = ${mode},
          corpus_generation = ${corpusGeneration},
          updated_at = now()
      WHERE source_id = ${sourceId}
        AND slug = ${slug}
        AND deleted_at IS NULL
    `;
  }

  async migrateFactsToCanonical(
    phantomSlug: string,
    canonicalSlug: string,
    sourceId: string,
  ): Promise<{ migrated: number }> {
    const sql = this.sql;
    // UPDATE preserves every other column (embedding, valid_*, kind,
    // status, notability, confidence, source_session, ...). Idempotent
    // by virtue of the WHERE clause matching nothing on re-run.
    //
    // We scope to `expired_at IS NULL` so the migration touches only
    // active facts. Forgotten / superseded rows that already carry an
    // expiry stay where they are — soft-deleting the phantom page is
    // sufficient to make them invisible without rewriting their slug
    // (and rewriting would break the audit trail in listSupersessions).
    const result = await sql`
      UPDATE facts
      SET entity_slug = ${canonicalSlug},
          source_markdown_slug = ${canonicalSlug}
      WHERE source_id = ${sourceId}
        AND source_markdown_slug = ${phantomSlug}
        AND expired_at IS NULL
    `;
    return { migrated: result.count ?? 0 };
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const sql = this.sql;
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    const updatedAfter = filters?.updated_after;

    // postgres.js sql.unsafe is awkward for conditional WHERE; use raw query branching.
    // The 4 dimensions (type, tag, updated_after, none) cross-product into 8 cases;
    // we use postgres.js's tagged-template chaining via sql`` fragments instead.

    // Build conditions with sql fragments. postgres.js supports fragment composition.
    const typeCondition = filters?.type ? sql`AND p.type = ${filters.type}` : sql``;
    const tagJoin = filters?.tag ? sql`JOIN tags t ON t.page_id = p.id` : sql``;
    const tagCondition = filters?.tag ? sql`AND t.tag = ${filters.tag}` : sql``;
    // v0.45.7 keyset (updated_at, slug) supersedes updated_after when set.
    const keyset = filters?.updatedAfterKeyset;
    const updatedCondition = keyset
      ? sql`AND (p.updated_at > ${keyset.updatedAt}::timestamptz OR (p.updated_at = ${keyset.updatedAt}::timestamptz AND p.slug > ${keyset.slug}))`
      : updatedAfter
        ? sql`AND p.updated_at > ${updatedAfter}::timestamptz`
        : sql``;
    // slugPrefix uses the (source_id, slug) UNIQUE btree index for range scans.
    // Escape LIKE metacharacters so the user prefix is treated as a literal.
    const slugPrefix = filters?.slugPrefix;
    const slugCondition = slugPrefix
      ? sql`AND p.slug LIKE ${slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'} ESCAPE '\\'`
      : sql``;
    // v0.31.12 + v0.34.1 (#876, D9): scope to a single source OR an array
    // of sources. When BOTH are set, the array wins (federated semantics
    // subsume the scalar case). When neither is set, no filter applies.
    const sourceCondition = filters?.sourceIds && filters.sourceIds.length > 0
      ? sql`AND p.source_id = ANY(${filters.sourceIds}::text[])`
      : filters?.sourceId
        ? sql`AND p.source_id = ${filters.sourceId}`
        : sql``;
    // v0.26.5: hide soft-deleted by default; opt in via filters.includeDeleted.
    const deletedCondition = filters?.includeDeleted === true
      ? sql``
      : sql`AND p.deleted_at IS NULL`;
    // #4352: untrusted-caller private-page filter (see PageFilters.excludePrivate).
    // Static code-provided fragment (never user input) — same sql.unsafe
    // pattern as the PAGE_SORT_SQL whitelist below.
    const privateCondition = filters?.excludePrivate === true
      ? sql.unsafe(`AND ${privatePagesFilterFragment('p')}`)
      : sql``;
    const effectiveAfterCondition = filters?.effective_after
      ? sql`AND p.effective_date >= ${filters.effective_after}::timestamptz`
      : sql``;
    const effectiveBeforeCondition = filters?.effective_before
      ? sql`AND p.effective_date <= ${filters.effective_before}::timestamptz`
      : sql``;

    // v0.29: ORDER BY threading via PAGE_SORT_SQL whitelist (no SQL injection).
    // postgres.js sql.unsafe lets us splice the literal fragment safely.
    const sortKey = filters?.sort && PAGE_SORT_SQL[filters.sort] ? filters.sort : 'updated_desc';
    const orderBy = sql.unsafe(PAGE_SORT_SQL[sortKey]);

    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING): when
    // enabled, this wraps the query in a transaction that sets
    // `app.scopes` from filters; when disabled, it's a pass-through.
    return await this.withScopedReadTransaction(filters?.sourceIds, filters?.sourceId, async (tx) => {
      const rows = await tx`
        SELECT p.* FROM pages p
        ${tagJoin}
        WHERE 1=1 ${typeCondition} ${tagCondition} ${updatedCondition} ${slugCondition} ${sourceCondition} ${deletedCondition} ${privateCondition} ${effectiveAfterCondition} ${effectiveBeforeCondition}
        ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map(rowToPage);
    });
  }

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      // v0.31.8 (D12): two-branch. See pglite-engine.ts:getAllSlugs for context.
      if (opts?.sourceId) {
        const rows = await tx`SELECT slug FROM pages WHERE source_id = ${opts.sourceId}`;
        return new Set(rows.map((r: Record<string, unknown>) => r.slug as string));
      }
      const rows = await tx`SELECT slug FROM pages`;
      return new Set(rows.map((r: Record<string, unknown>) => r.slug as string));
    });
  }

  async listAllPageRefs(): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>> {
    // v0.32.8: cross-source page enumeration. ORDER BY (source_id, slug) for
    // deterministic iteration (F11) — same-slug-different-source pages stay
    // grouped predictably. WHERE deleted_at IS NULL matches default getPage
    // visibility semantics (v0.26.5). #4304: updated_at projected so --since
    // walks can filter refs before any full-page fetch.
    const sql = this.sql;
    const rows = await sql`
      SELECT slug, source_id, updated_at FROM pages
      WHERE deleted_at IS NULL
      ORDER BY source_id, slug
    `;
    return rows.map((r) => ({
      slug: r.slug as string,
      source_id: r.source_id as string,
      updated_at: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at as string),
    }));
  }

  async listAllSources(opts?: {
    includeArchived?: boolean;
    localPathOnly?: boolean;
  }): Promise<SourceRow[]> {
    // v0.38: lean per-source enumeration for autopilot dispatch + doctor.
    // Filters at SQL so the autopilot tick stays one query regardless of
    // how many archived rows exist. ORDER BY (id='default') DESC, id
    // matches sources-ops.listSources for operator-output stability.
    const sql = this.sql;
    const includeArchived = opts?.includeArchived === true;
    const localPathOnly = opts?.localPathOnly === true;
    const rows = await sql`
      SELECT id, name, local_path, last_sync_at, config
        FROM sources
       WHERE (${includeArchived} OR archived IS NOT TRUE)
         AND (${!localPathOnly} OR local_path IS NOT NULL)
       ORDER BY (id = 'default') DESC, id
    `;
    return rows.map((r) => ({
      id: r.id as string,
      name: (r.name as string | null) ?? null,
      local_path: (r.local_path as string | null) ?? null,
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at as string) : null,
      config: typeof r.config === 'string' ? JSON.parse(r.config) : ((r.config as Record<string, unknown> | null) ?? {}),
    }));
  }

  async updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    // Atomic single-statement merge. The previous read-then-write form dropped
    // concurrent updates: two callers patching different keys could both read
    // the same old config and the later `SET config = ...` clobbered the
    // earlier patch. These keys are written by background cycle/autopilot
    // paths, so the merge must happen inside the UPDATE (parity with
    // pglite-engine.updateSourceConfig, which already uses JSONB `||`).
    //
    // The shared SQL coercion normalizes historical bad shapes inline (so
    // `config` is re-read against the row-locked latest version — a detached
    // read/normalize/write cycle would reintroduce the lost-update race under
    // READ COMMITTED): older code paths
    // could store config as a JSONB string (double-encoded) or as a JSONB array
    // of patch objects. We coerce those to a flat object before the `||` merge
    // so doctor and source routing keep getting flat keys.
    //
    // String branch guard: a JSONB string whose inner text is NOT itself valid
    // JSON (one of the historical bad shapes this path repairs) would make the
    // bare `::jsonb` cast raise `invalid input syntax for type json`, failing
    // the whole UPDATE. Postgres has no `try_cast`, so we gate the cast with
    // the SQL `IS JSON` predicate (Postgres 16+): parseable inner text is
    // double-encoded config and gets parsed; unparseable text falls back to `{}`.
    // The guard keeps the merge a single atomic statement (no extra round-trip,
    // no lost-update race).
    //
    // MUST use sql.json(patch) inside the template tag — postgres-js's
    // positional executeRaw + `$1::jsonb` cast DOUBLE-ENCODES the
    // JSON.stringify'd string, producing a JSONB STRING shape instead
    // of OBJECT. `||` between JSONB object + JSONB string yields a
    // JSONB ARRAY (concat semantics for non-matching types), which
    // wipes every existing config key. sql.json(...) inside the
    // template tag is the canonical safe path — same pattern as
    // putPage + submitJob elsewhere in this file. Empirically verified
    // produces jsonb_typeof = 'object'.
    const sql = this.sql;
    const result = await sql`
      UPDATE sources
         SET config = ${sql.unsafe(SOURCE_CONFIG_OBJECT_SQL)}
           || ${sql.json(patch as Parameters<typeof sql.json>[0])}
       WHERE id = ${sourceId}
    `;
    return (result.count ?? 0) > 0;
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
    if (opts.prefixes.length === 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const staleBias = opts.staleBias === true;
    const staleThreshold = opts.staleThresholdDays ?? 90;
    // Source scoping (D5, codex r2 #2 — federated array wins over scalar).
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(opts.sourceIds, opts.sourceId, async (tx) => {
      const rows = await tx`
      WITH prefix_pages AS (
        SELECT
          p.id AS page_id,
          p.slug,
          p.source_id,
          p.title,
          p.compiled_truth,
          p.last_retrieved_at,
          substring(p.slug from '^[^/]+/[^/]+') AS prefix,
          COUNT(pl.id) AS connection_count
        FROM pages p
        LEFT JOIN page_links pl ON pl.to_page_id = p.id
        WHERE p.deleted_at IS NULL
          AND substring(p.slug from '^[^/]+/[^/]+') = ANY(${opts.prefixes}::text[])
          AND (cardinality(${exclude}::text[]) = 0 OR NOT (p.slug = ANY(${exclude}::text[])))
          AND (
            (${sourceIds}::text[] IS NOT NULL AND p.source_id = ANY(${sourceIds}::text[]))
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NOT NULL AND p.source_id = ${sourceId})
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NULL)
          )
        GROUP BY p.id, p.slug, p.source_id, p.title, p.compiled_truth, p.last_retrieved_at
      ),
      ranked AS (
        SELECT
          pp.*,
          (CASE WHEN ${staleBias}::boolean THEN
            CASE
              WHEN pp.last_retrieved_at IS NULL THEN 2
              WHEN pp.last_retrieved_at < NOW() - (${staleThreshold}::int * INTERVAL '1 day') THEN 1
              ELSE 0
            END
          ELSE 0
          END) AS stale_score,
          ROW_NUMBER() OVER (
            PARTITION BY pp.prefix
            ORDER BY
              (CASE WHEN ${staleBias}::boolean THEN
                CASE
                  WHEN pp.last_retrieved_at IS NULL THEN 2
                  WHEN pp.last_retrieved_at < NOW() - (${staleThreshold}::int * INTERVAL '1 day') THEN 1
                  ELSE 0
                END
              ELSE 0
              END) DESC,
              pp.connection_count DESC,
              pp.slug ASC
          ) AS rn
        FROM prefix_pages pp
      ),
      with_chunk AS (
        SELECT
          r.*,
          (
            SELECT cc.id FROM content_chunks cc
            WHERE cc.page_id = r.page_id AND cc.embedding IS NOT NULL
            ORDER BY cc.chunk_index ASC
            LIMIT 1
          ) AS representative_chunk_id
        FROM ranked r
        WHERE r.rn = 1
      )
      SELECT page_id, slug, source_id, title, compiled_truth, last_retrieved_at,
             prefix, connection_count, representative_chunk_id
      FROM with_chunk
      ORDER BY prefix
    `;
      return rows.map((r: Record<string, unknown>): DomainBankRow => ({
        slug: r.slug as string,
        source_id: r.source_id as string,
        prefix: r.prefix as string | null,
        page_id: Number(r.page_id),
        title: r.title as string | null,
        compiled_truth: (r.compiled_truth as string | null) ?? '',
        connection_count: Number(r.connection_count),
        last_retrieved_at: r.last_retrieved_at as Date | null,
        representative_chunk_id: r.representative_chunk_id == null ? null : Number(r.representative_chunk_id),
      }));
    });
  }

  // v0.37.0 — corpus-sampling fallback when prefix-stratified can't fill M.
  // Deterministic with opts.seed (setseed before SELECT); random otherwise.
  async listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    if (opts.n <= 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    // alwaysTransaction when seeded: setseed() only affects RANDOM() on the
    // SAME connection. On a pool, a bare `sql\`SELECT setseed(...)\`` and the
    // subsequent SELECT can land on different connections, silently breaking
    // the deterministic path — the transaction pins both to one connection.
    return await this.withScopedReadTransaction(opts.sourceIds, opts.sourceId, async (tx) => {
      // setseed deterministic path: use SELECT setseed($1) + RANDOM(). PGLite/Postgres
      // both honor setseed for the same session/transaction. For tests this gives
      // identical ordering across runs.
      if (typeof opts.seed === 'number') {
        // Clamp to [-1, 1] required by setseed.
        const clamped = Math.max(-1, Math.min(1, opts.seed));
        await tx`SELECT setseed(${clamped}::float8)`;
      }
      const rows = await tx`
      WITH sampled AS (
        SELECT
          p.id AS page_id,
          p.slug,
          p.source_id,
          p.title,
          p.compiled_truth,
          p.last_retrieved_at,
          substring(p.slug from '^[^/]+/[^/]+') AS prefix,
          (SELECT COUNT(*) FROM page_links pl WHERE pl.to_page_id = p.id) AS connection_count
        FROM pages p
        WHERE p.deleted_at IS NULL
          AND (cardinality(${exclude}::text[]) = 0 OR NOT (p.slug = ANY(${exclude}::text[])))
          AND (
            (${sourceIds}::text[] IS NOT NULL AND p.source_id = ANY(${sourceIds}::text[]))
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NOT NULL AND p.source_id = ${sourceId})
            OR (${sourceIds}::text[] IS NULL AND ${sourceId}::text IS NULL)
          )
        ORDER BY RANDOM()
        LIMIT ${opts.n}
      )
      SELECT
        s.*,
        (
          SELECT cc.id FROM content_chunks cc
          WHERE cc.page_id = s.page_id AND cc.embedding IS NOT NULL
          ORDER BY cc.chunk_index ASC
          LIMIT 1
        ) AS representative_chunk_id
      FROM sampled s
    `;
      return rows.map((r: Record<string, unknown>): DomainBankRow => ({
        slug: r.slug as string,
        source_id: r.source_id as string,
        prefix: r.prefix as string | null,
        page_id: Number(r.page_id),
        title: r.title as string | null,
        compiled_truth: (r.compiled_truth as string | null) ?? '',
        connection_count: Number(r.connection_count),
        last_retrieved_at: r.last_retrieved_at as Date | null,
        representative_chunk_id: r.representative_chunk_id == null ? null : Number(r.representative_chunk_id),
      }));
    }, { alwaysTransaction: typeof opts.seed === 'number' });
  }

  async resolveSlugs(partial: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<string[]> {
    const sql = this.sql;

    // v0.41.13 #1436: source scope via postgres.js tagged-template
    // fragments. When neither opt is set the resolver stays unscoped
    // for back-compat with internal callers. The `deleted_at IS NULL`
    // filter excludes soft-deleted rows (v0.26.5) from fuzzy candidates
    // — they're not legitimate match targets for a remote `get_page`.
    const sources = opts?.sourceIds ?? null;
    const scalar = opts?.sourceId ?? null;
    const scopeFragment = sources
      ? sql` AND source_id = ANY(${sources}::text[])`
      : scalar
        ? sql` AND source_id = ${scalar}`
        : sql``;

    // Try exact match first
    const exact = await sql`SELECT slug FROM pages WHERE slug = ${partial} AND deleted_at IS NULL${scopeFragment}`;
    if (exact.length > 0) return [exact[0].slug];

    // Fuzzy match via pg_trgm
    const fuzzy = await sql`
      SELECT slug, similarity(title, ${partial}) AS sim
      FROM pages
      WHERE deleted_at IS NULL AND (title % ${partial} OR slug ILIKE ${'%' + partial + '%'})${scopeFragment}
      ORDER BY sim DESC
      LIMIT 5
    `;
    return fuzzy.map((r) => r.slug as string);
  }

  // Search
  // v0.20.0 Cathedral II Layer 3 (1b): chunk-grain FTS internally,
  // dedup-to-best-chunk-per-page on the way out. External shape
  // preserves the v0.19.0 contract so backlinks / enrichment-service /
  // list_pages etc. see zero breaking changes. A2 two-pass (Layer 7)
  // consumes searchKeywordChunks for the raw chunk-grain primitive.
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const detailLow = opts?.detail === 'low';
    // Fetch headroom for dedup: if we only fetch `limit` chunks, a cluster of
    // co-occurring terms in one page can eat the entire result set and we'd
    // ship < limit pages. 3x gives dedup enough to pick top N distinct pages.
    const innerLimit = Math.min(limit * 3, MAX_SEARCH_LIMIT * 3);

    // Source-aware ranking (v0.22): boost curated content (originals/,
    // concepts/, writing/) and dampen bulk content (chat/, daily/, media/x/)
    // by multiplying the chunk-grain ts_rank with a source-factor CASE.
    // Detail-gated — disabled for `detail='high'` (temporal queries) so
    // chat surfaces normally for date-framed lookups. Hard-exclude prefixes
    // (test/, attachments/, .raw/ by default) filter at the chunk-rank stage
    // so they never enter the candidate set. (archive/ is demoted, not
    // excluded — issue #1777.)
    const boostMap = resolveBoostMap();
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
        visibilityClause: buildVisibilityClause('p', 's'),
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
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
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
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });
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
        ORDER BY score DESC
        LIMIT ${innerLimitParam}
      ),
      ${buildBestPerPagePoolCte('ranked_chunks')}
      SELECT slug, page_id, title, type, source_id,
        effective_date, effective_date_source,
        message_id, thread_id, source_subject,
        chunk_id, chunk_index, chunk_text, chunk_source, score,
        false AS stale
      FROM best_per_page
      ORDER BY score DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING) + search-only
    // timeout. alwaysTransaction: this method needed sql.begin() on master
    // already (SET LOCAL statement_timeout must be transaction-scoped so
    // the GUC can never leak onto a pooled connection). Flag off → the
    // wrap is identical to master's; flag on → set_config('app.scopes')
    // shares the same transaction as the timeout.
    const runKeyword = (queryText: string) =>
      this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
        await tx`SET LOCAL statement_timeout = '8s'`;
        const boundParams = [...params];
        boundParams[0] = queryText;
        return await tx.unsafe(rawQuery, boundParams as Parameters<typeof tx.unsafe>[1]);
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
        rows = await runKeyword(orQuery);
        // 2026-09 (#3617 follow-up): relaxed rows are TAGGED so hybrid's
        // fusion can demote them — an OR-of-common-terms match must not
        // outvote a healthy vector arm (SearchResult.keyword_relaxed doc).
        return rows.map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
      }
    }
    return rows.map(rowToSearchResult);
  }

  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm. See the
   * BrainEngine interface doc for the full contract. Queries
   * pages.search_vector (title weight 'A' dominates ts_rank_cd by
   * construction) with the same page-grain filters the keyword arm applies
   * (type/types/excludeSlugs/date/source scoping, hard-excludes,
   * visibility), joined to one representative chunk per page. Applies the
   * same AND→OR recall fallback as searchKeyword. Ordinary long titles are
   * preserved; oversized pasted context is bounded before websearch FTS.
   */
  async searchTitles(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    // language/symbolKind are chunk-grain code filters with no page-grain
    // meaning; a code-scoped query gets no title candidates rather than
    // rows that silently violate the caller's filter.
    if (opts?.language || opts?.symbolKind) return [];
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailLow = opts?.detail === 'low';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const boostMap = resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });
    // FTS config name (e.g. 'english', 'pt_br'). Validated by getFtsLanguage()
    // — safe to interpolate into raw SQL.
    const ftsLang = getFtsLanguage();

    const params: unknown[] = [boundWebsearchQuery(query)];
    let typeClause = '';
    if (opts?.type) {
      params.push(opts.type);
      typeClause = `AND p.type = $${params.length}`;
    }
    let typesClause = '';
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      typesClause = `AND p.type = ANY($${params.length}::text[])`;
    }
    let excludeSlugsClause = '';
    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs);
      excludeSlugsClause = `AND p.slug != ALL($${params.length}::text[])`;
    }
    // Date filters read COALESCE(effective_date, …) — upstream unified the
    // Postgres keyword arm onto the PGLite effective-date-first convention
    // (v0.29.1 parity); the title arm matches it for filter parity.
    let afterDateClause = '';
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
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

    // Page grain — one row per page by construction, so no best_per_page
    // pooling CTE is needed. The LEFT JOIN LATERAL picks the representative
    // chunk (compiled_truth first, then lowest chunk_index); COALESCEs keep
    // chunkless pages retrievable (the extreme D1 case: a title with no
    // body) with the alias-hop row shape (chunk_id 0, empty chunk_text).
    // Accepted limitations (Reviewer F5/F6): the synthetic chunkless row
    // dedups on empty chunk_text (fusion's compiledTruthBoost skips it since
    // #3695 — chunk_id 0 + empty chunk_text never gains chunk authority);
    // and detail='low' filters only the REPRESENTATIVE — pages without a
    // compiled_truth chunk still surface (unlike the keyword arm's filter).
    const rawQuery = `
      SELECT
        p.slug, p.id as page_id, p.title, p.type, p.source_id,
        p.effective_date, p.effective_date_source,
        COALESCE(rep.id, 0) as chunk_id,
        COALESCE(rep.chunk_index, 0) as chunk_index,
        COALESCE(rep.chunk_text, '') as chunk_text,
        COALESCE(rep.chunk_source, 'compiled_truth') as chunk_source,
        ts_rank_cd(p.search_vector, websearch_to_tsquery('${ftsLang}', $1)) * ${sourceFactorCase} AS score,
        false AS stale
      FROM pages p
      JOIN sources s ON s.id = p.source_id
      LEFT JOIN LATERAL (
        SELECT cc.id, cc.chunk_index, cc.chunk_text, cc.chunk_source
        FROM content_chunks cc
        WHERE cc.page_id = p.id
          AND cc.modality = 'text'
          ${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''}
        ORDER BY (cc.chunk_source = 'compiled_truth') DESC, cc.chunk_index ASC
        LIMIT 1
      ) rep ON true
      WHERE p.search_vector @@ websearch_to_tsquery('${ftsLang}', $1)
        ${typeClause}
        ${typesClause}
        ${excludeSlugsClause}
        ${afterDateClause}
        ${beforeDateClause}
        ${sourceClause}
        ${hardExcludeClause}
        ${visibilityClause}
      ORDER BY score DESC, p.id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // Same RLS scope-binding wrapper as searchKeyword (alwaysTransaction:
    // the SET LOCAL statement_timeout needs a transaction regardless of the
    // GBRAIN_RLS_SCOPE_BINDING flag). The OR retry re-executes through the
    // same scoped wrapper.
    const runTitles = (queryText: string) =>
      this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
        await tx`SET LOCAL statement_timeout = '8s'`;
        const boundParams = [...params];
        boundParams[0] = queryText;
        return await tx.unsafe(rawQuery, boundParams as Parameters<typeof tx.unsafe>[1]);
      }, { alwaysTransaction: true });
    let rows = await runTitles(params[0] as string);
    if (rows.length === 0) {
      const orQuery = buildOrFallbackWebsearchQuery(params[0] as string);
      if (orQuery) {
        rows = await runTitles(boundWebsearchQuery(orQuery));
        // 2026-09 (#3617 follow-up): same relaxed-row tagging as the keyword
        // arm — see SearchResult.keyword_relaxed.
        return rows.map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
      }
    }
    return rows.map(rowToSearchResult);
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
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Source-aware ranking applies here too — searchKeywordChunks is the
    // chunk-grain anchor primitive that two-pass retrieval (Layer 7) uses,
    // so curated-vs-bulk dampening should affect the anchor pool. Same
    // detail-gate, same hard-exclude behavior as searchKeyword.
    const boostMap = resolveBoostMap();
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
        visibilityClause: buildVisibilityClause('p', 's'),
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
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
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
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });
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
      ORDER BY score DESC
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
   * as the FTS keyword paths. See src/core/postgres-engine/cjk-search.ts.
   */
  private async _searchKeywordCJK(query: string, ctx: CjkKeywordCtx): Promise<SearchResult[]> {
    return searchKeywordCJKImpl(
      async (sqlText, params) =>
        await this.withScopedReadTransaction(ctx.opts?.sourceIds, ctx.opts?.sourceId, async (tx) => {
          await tx`SET LOCAL statement_timeout = '8s'`;
          return await tx.unsafe(sqlText, params as Parameters<typeof tx.unsafe>[1]) as unknown as Record<string, unknown>[];
        }, { alwaysTransaction: true }),
      query,
      ctx,
    );
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    // Two-stage CTE (v0.22): inner CTE keeps a pure-distance ORDER BY so
    // the HNSW index stays usable. Folding source-boost into the inner
    // ORDER BY would force a sequential scan over every chunk (seconds vs
    // ~10ms with HNSW). Outer SELECT re-ranks the candidate pool by
    // raw_score * source_factor.
    //
    // innerLimit scales with offset to preserve the pagination contract:
    // a fixed cap of 100 would silently empty offset > 100.
    const boostMap = resolveBoostMap();
    // issue #160: the guard predicate is projected as `unverified_stub` in
    // hnsw_candidates (frontmatter isn't otherwise available at re-rank), so
    // unverified auto-extracted stubs get factor 1.0, not the people/ 1.2x.
    const sourceFactorCaseOnSlug = buildSourceFactorCase('slug', boostMap, opts?.detail, 'unverified_stub');
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    // v0.36 (D11): column routing via resolved descriptor. Engine doesn't
    // read config — caller (hybrid/op) resolved it and passed it in.
    // normalizeEngineColumn accepts the legacy union (string literals,
    // ResolvedColumn, undefined) and produces a canonical descriptor.
    // (Hoisted above innerLimit so the escalation cap can key off the
    // column's index eligibility.)
    const resolvedCol = normalizeEngineColumn(opts?.embeddingColumn);
    // v0.46.15 (retrieval-cathedral P1): innerLimit counts CHUNKS before the
    // best-per-page DISTINCT collapse — one dense page (150+ chunks near the
    // query) could consume the whole pool and underfill the PAGE result. The
    // execution below runs a bounded escalation loop (×4, ≤3 times) when the
    // page set comes back short while the candidate pool was FULL (more
    // candidates existed). Cap policy (outside-voice R2-10 + codex ship
    // review): for HNSW-backed columns the scan returns at most ef_search
    // rows and the GUC ceilings at 1000, so inner limits beyond that are
    // fictitious. Columns ABOVE the index dim ceiling (e.g. vector >2000d)
    // fall back to exact scans where ef_search is irrelevant — capping their
    // SQL LIMIT would make offset >= 1000 permanently empty; they stay
    // bounded by the escalation count instead.
    const innerCap = hnswIndexExpected(resolvedCol.type, resolvedCol.dimensions)
      ? HNSW_EF_SEARCH_MAX
      : Number.MAX_SAFE_INTEGER;
    const innerLimit = Math.min(offset + Math.max(limit * 5, 100), innerCap);

    const params: unknown[] = [vecStr];
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
      afterDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    let beforeDateClause = '';
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      beforeDateClause = `AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
    // v0.34.1 (#861, F2 — P0 leak seal): source-isolation in the INNER CTE
    // specifically. Pushing the filter inside narrows the HNSW candidate set
    // before re-rank; pushing it to the outer SELECT would force HNSW to
    // over-fetch then post-filter, wasting candidate slots. Codex flagged
    // this placement during plan review. Array form wins over scalar.
    let sourceClause = '';
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      sourceClause = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      sourceClause = `AND p.source_id = $${params.length}`;
    }
    params.push(innerLimit);
    const innerLimitIdx = params.length - 1; // mutated by the escalation loop
    const innerLimitParam = `$${params.length}`;
    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    // v0.26.5: visibility filter applied in the inner CTE so the HNSW index
    // sees the same row count it always did. Pulling the predicate to the
    // outer SELECT would force the HNSW scan to over-fetch and post-filter,
    // wasting candidate slots on hidden rows.
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });

    // v0.36 Phase 3: 'embedding_multimodal' is the unified column populated
    // by `gbrain reindex --multimodal`. Carries BOTH text and image content
    // in Voyage multimodal-3 space — no modality filter; the column itself
    // is the discriminator (rows without embedding_multimodal aren't searched).
    const { col, castSql } = buildVectorCastFragment(resolvedCol);
    let modalityFilter: string;
    if (resolvedCol.name === 'embedding_image') {
      modalityFilter = `AND cc.modality = 'image'`;
    } else if (resolvedCol.name === 'embedding_multimodal') {
      modalityFilter = '';
    } else {
      modalityFilter = `AND cc.modality = 'text'`;
    }

    const rawQuery = `
      WITH hnsw_candidates AS (
        SELECT
          p.slug, p.id as page_id, p.title, p.type, p.source_id,
          p.effective_date, p.effective_date_source,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
          CASE WHEN NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL
            THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          (${unverifiedExtractionFragment('p')}) AS unverified_stub,
          1 - (cc.${col} <=> ${castSql}) AS raw_score
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        JOIN sources s ON s.id = p.source_id
        WHERE cc.${col} IS NOT NULL ${modalityFilter}
          ${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''}
          ${typeClause}
          ${typesClause}
          ${excludeSlugsClause}
          ${languageClause}
          ${symbolKindClause}
          ${afterDateClause}
          ${beforeDateClause}
          ${sourceClause}
          ${hardExcludeClause}
          ${visibilityClause}
        ORDER BY cc.${col} <=> ${castSql}
        LIMIT ${innerLimitParam}
      ),
      -- score computed as a select-list expr (NOT in the inner ORDER BY, which
      -- must stay pure-distance so the HNSW index is usable).
      scored AS (
        SELECT *, raw_score * ${sourceFactorCaseOnSlug} AS score
        FROM hnsw_candidates
      ),
      -- T1 (retrieval-maxpool incident): collapse to the best chunk PER PAGE
      -- over the full candidate set before the user LIMIT, so a page's strong
      -- chunk can't be crowded out of the result by weaker chunks of other
      -- pages. Shared builder keeps keyword + vector × postgres + pglite in lockstep.
      ${buildBestPerPagePoolCte('scored')}
      SELECT
        slug, page_id, title, type, source_id,
        effective_date, effective_date_source,
        message_id, thread_id, source_subject,
        chunk_id, chunk_index, chunk_text, chunk_source,
        score,
        false AS stale,
        (SELECT count(*) FROM hnsw_candidates)::int AS candidate_pool
      FROM best_per_page
      -- v0.41.13: stable tiebreaker for tied scores. See pglite-engine for
      -- rationale (basis-vector test fixtures, planner-dependent ordering).
      ORDER BY score DESC, page_id ASC, chunk_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `;

    // RLS scope binding + search-only timeout. alwaysTransaction: master
    // already wrapped this in sql.begin() for the SET LOCAL; flag off is
    // identical to that wrap, flag on adds set_config in the same tx.
    //
    // hnsw.ef_search: an HNSW scan returns at most ef_search rows (default
    // 40), so the inner CTE's LIMIT past 40 was silently unreachable — see
    // hnswEfSearchFor. Transaction-local (is_local=true); non-HNSW plans
    // (seq scan, or corpora without the index) ignore the GUC.
    //
    // v0.46.15 bounded escalation (identical logic in pglite-engine —
    // engine-parity pinned): retry ×4 up to 3 times while the PAGE set is
    // short but the pre-collapse candidate pool was FULL. A short page with
    // a non-full pool is a genuine final page (corpus/filter exhausted) —
    // no retry, no event. Zero rows with offset>0 escalates (deep
    // pagination) but never emits: pool state is unknowable there.
    const runOnce = async (il: number) =>
      await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
        await tx`SET LOCAL statement_timeout = '8s'`;
        await tx`SELECT set_config('hnsw.ef_search', ${String(hnswEfSearchFor(il))}, true)`;
        return await tx.unsafe(rawQuery, params as Parameters<typeof tx.unsafe>[1]);
      }, { alwaysTransaction: true });
    let escalations = 0;
    let rows = await runOnce(innerLimit);
    for (;;) {
      const il = params[innerLimitIdx] as number;
      if (rows.length >= limit) break;
      const pool = rows.length > 0 ? Number((rows[0] as { candidate_pool?: number }).candidate_pool ?? 0) : null;
      const shouldEscalate = pool !== null ? pool >= il : offset > 0;
      if (!shouldEscalate) break;
      if (il >= innerCap || escalations >= 3) {
        if (pool !== null && pool >= il) {
          opts?.onVectorPoolMeta?.({ underfilled: true, escalations, innerLimit: il });
        }
        break;
      }
      params[innerLimitIdx] = Math.min(il * 4, innerCap);
      escalations++;
      rows = await runOnce(params[innerLimitIdx] as number);
    }
    return rows.map(rowToSearchResult);
  }

  async getEmbeddingsByChunkIds(
    ids: number[],
    column: string = 'embedding',
  ): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    // v0.36 (D9): column parameter used by hybrid.cosineReScore so
    // rescoring rehydrates from the active column's embedding space,
    // not always 'embedding'. Engine has no resolver access; the
    // caller must pass a known column name. Identifier-quoted (D12
    // defense layer 2) plus a strict regex check (D12 defense layer 1)
    // so even a misconfigured caller can't smuggle a SQL fragment.
    if (!COLUMN_NAME_REGEX.test(column)) {
      throw new EmbeddingColumnNotRegisteredError(column, []);
    }
    const quotedCol = quoteIdentifier(column);
    const sql = this.sql;
    const rawQuery = `
      SELECT id, ${quotedCol} AS embedding FROM content_chunks
      WHERE id = ANY($1::int[]) AND ${quotedCol} IS NOT NULL
    `;
    const rows = await sql.unsafe(rawQuery, [ids] as Parameters<typeof sql.unsafe>[1]);
    const result = new Map<number, Float32Array>();
    for (const row of rows) {
      const embedding = tryParseEmbedding(row.embedding);
      if (embedding) result.set(row.id as number, embedding);
    }
    return result;
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

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn } & BatchOpts): Promise<void> {
    return this.batchRetry(opts?.auditSite ?? 'upsertChunks', opts?.signal, () => this._upsertChunksOnce(slug, chunks, opts), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn }): Promise<void> {
    // Normalize the same way putPage does — pages.slug is stored lowercased,
    // so a raw mixed-case slug here would miss the row it just wrote (#430).
    slug = validateSlug(slug);
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';

    // Source-scope the page-id lookup. Without this filter, multi-source
    // brains where the slug exists in 2+ sources return >1 row and the
    // chunk replacement targets the wrong page (or fans out across pages).
    const pages = await sql`SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId}`;
    if (pages.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const pageId = pages[0].id;

    // Remove chunks that no longer exist (chunk_index beyond new count)
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      await sql`DELETE FROM content_chunks WHERE page_id = ${pageId} AND chunk_index != ALL(${newIndices})`;
    } else {
      await sql`DELETE FROM content_chunks WHERE page_id = ${pageId}`;
      return;
    }

    // Batch upsert: build a single multi-row INSERT ON CONFLICT statement.
    // v0.19.0: includes language/symbol_name/symbol_type/start_line/end_line
    // so code chunks carry tree-sitter metadata into the DB. Markdown chunks
    // pass NULL for all five.
    // v0.20.0 Cathedral II Layer 6: adds parent_symbol_path / doc_comment /
    // symbol_name_qualified so nested-chunk emission (A3) can round-trip
    // scope metadata through upserts.
    // v0.27.1 (Phase 8): added `modality` + `embedding_image` to the column
    // list. Image chunks pass embedding=null + embedding_image=Float32Array.
    //
    // #1262: the text-embedding column is registry-resolved, not the literal
    // `embedding`. A caller-resolved descriptor wins; otherwise the DB-plane
    // registry rows route the write to the SAME active column the read side
    // searches (a Voyage-routed brain must not fail every write with a
    // dimension mismatch against the legacy 1536d column). Config-table read
    // failure (pre-v36 brain mid-migration) falls back to the legacy column;
    // an unregistered `search_embedding_column` throws the resolver's loud
    // paste-ready hint. Mirrored in pglite-engine.ts (parity).
    // Resolution MUST stay on the local sql handle: callers (import-file)
    // invoke this inside their own transaction — re-entering the engine's
    // public surface via resolveActiveEmbeddingColumnFromEngine deadlocks
    // the connection path. Same rows, same pure resolver, no re-entrancy.
    // Mirrored in pglite-engine.ts (parity).
    let writeCol: ResolvedColumn;
    if (opts?.embeddingColumn) {
      writeCol = normalizeEngineColumn(opts.embeddingColumn);
    } else {
      let searchEmbeddingColumn: string | null = null;
      let embeddingColumnsJson: string | null = null;
      try {
        const cfgRows = await sql`SELECT key, value FROM config WHERE key IN ('search_embedding_column', 'embedding_columns')`;
        for (const r of cfgRows) {
          if (r.key === 'search_embedding_column') searchEmbeddingColumn = r.value as string;
          else if (r.key === 'embedding_columns') embeddingColumnsJson = r.value as string;
        }
      } catch {
        // config table unreadable — legacy column via the resolver default.
      }
      writeCol = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn, embeddingColumnsJson });
    }
    const writeColId = quoteIdentifier(writeCol.name);
    const writeCast = vectorCastSuffix(writeCol);

    // #4246: embedded_text_hash records md5(chunk_text) AT EMBED TIME so a
    // later text rewrite that keeps the vector is detectable as content
    // drift (invalidateContentDriftEmbeddings). NULL when no embedding lands.
    const cols = `(page_id, chunk_index, chunk_text, chunk_source, ${writeColId}, model, token_count, embedded_at, embedded_text_hash, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified, modality, embedding_image)`;
    const rows: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Provenance fallback for chunks that don't carry an explicit `model`:
    // resolve the model the gateway ACTUALLY uses at runtime, not the
    // compile-time DEFAULT_EMBEDDING_MODEL constant. Callers like `embed`
    // build ChunkInputs without a `model` field (src/commands/embed.ts), so
    // the old `chunk.model || DEFAULT_EMBEDDING_MODEL` fallback stamped the
    // hardcoded default (e.g. zeroentropyai:zembed-1) onto rows whose vectors
    // were produced by a different, config-resolved model — corrupting the
    // provenance that signature-drift staleness + dim-migration logic trust.
    //
    // #3461: getEmbeddingModel() THROWS when the gateway is unconfigured —
    // it never returns falsy — so an `||` guard here is dead code and the
    // catch path used to stamp the compile-time default onto rows whose
    // vectors came from the config-resolved provider. On the throw path we
    // now fall back to the brain's own `config.embedding_model` row (kept
    // current by init / migrate / retrieval-upgrade), which names the model
    // that actually produced this brain's vectors. The compile-time default
    // is the LAST resort (fresh brain whose config row doesn't exist yet).
    let resolvedModel: string | null = null;
    try {
      // Keep the gateway lazy so module-load failure remains inside this soft
      // fallback boundary; eager evaluation would bypass the config-row fallback.
      const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
      resolvedModel = gw.getEmbeddingModel();
    } catch {
      try {
        const cfg = await sql`SELECT value FROM config WHERE key = 'embedding_model'`;
        resolvedModel = (cfg[0]?.value as string | undefined) ?? null;
      } catch {
        // config table unreadable — fall through to the compile-time default.
      }
    }
    if (!resolvedModel) resolvedModel = DEFAULT_EMBEDDING_MODEL;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;
      const embeddingImageStr = chunk.embedding_image
        ? '[' + Array.from(chunk.embedding_image).join(',') + ']'
        : null;
      const parentPath = chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0
        ? chunk.parent_symbol_path
        : null;
      const modality = chunk.modality ?? 'text';

      const embeddingPh = embeddingStr ? `$${paramIdx++}${writeCast}` : 'NULL';
      const embeddedAtPh = embeddingStr ? 'now()' : 'NULL';
      const embeddingImagePh = embeddingImageStr ? `$${paramIdx++}::vector` : 'NULL';
      // #4246: hash in SQL (not JS) so stamp + drift comparison share ONE
      // md5 implementation. Binds chunk_text a second time.
      const embeddedTextHashPh = embeddingStr ? `md5($${paramIdx++})` : 'NULL';

      rows.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
        `${embeddingPh}, $${paramIdx++}, $${paramIdx++}, ${embeddedAtPh}, ${embeddedTextHashPh}, ` +
        `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
        `$${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++}, ` +
        `$${paramIdx++}, ${embeddingImagePh})`,
      );

      // NUL/lone-surrogate cleanup ONCE into a local shared by BOTH binds:
      // the md5() embedded_text_hash input and the stored chunk_text must see
      // the same bytes, or the hash diverges from the sanitized stored text
      // (and the raw NUL would still abort the INSERT via the md5 param).
      const sanitizedChunkText = sanitizeText(chunk.chunk_text);
      // Param push order MUST match placeholder allocation order.
      if (embeddingStr) params.push(embeddingStr);
      if (embeddingImageStr) params.push(embeddingImageStr);
      if (embeddingStr) params.push(sanitizedChunkText); // embedded_text_hash md5() input
      params.push(
        pageId, chunk.chunk_index, sanitizedChunkText, chunk.chunk_source,
        chunk.model || resolvedModel, chunk.token_count || null,
        chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
        chunk.start_line ?? null, chunk.end_line ?? null,
        parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        modality,
      );
    }

    // Single statement upsert: preserves existing embeddings via COALESCE when new value is NULL.
    // CONSISTENCY: when chunk_text changes and no new embedding is supplied, BOTH embedding AND
    // embedded_at must reset to NULL so 'embed --stale' correctly picks up the row for re-embedding.
    // Without this, embedded_at lies (says "embedded" while embedding=NULL), and any staleness
    // predicate on embedded_at would silently skip the row. This is why the egress fix predicates
    // on 'embedding IS NULL' rather than `embedded_at IS NULL` — and it's why we now keep both
    // columns honest at write time.
    //
    // v0.40.3.0 D24 NULL→non-NULL race fix (TODOS.md v0.35.x item).
    // Two writers racing on the same chunk (e.g., autopilot sync + manual
    // 'embed --stale' + contextual reindex) previously raced last-write-wins
    // via `COALESCE(EXCLUDED.embedding, content_chunks.embedding)`. With
    // per-chunk Haiku synopsis the cost of an overwrite jumped from
    // ~$0.000001 to ~$0.0003. New rule for the text-unchanged branch:
    //   - existing is NULL → take new (cold path, no race)
    //   - new is fresher (embedded_at > existing.embedded_at) → take new
    //   - otherwise → keep existing (slower writer with stale embedding loses)
    // Mirrored in pglite-engine.ts; pinned by test/e2e/concurrent-embed-race.test.ts.
    //
    // Code-chunk metadata columns (language / symbol_name / symbol_type / line range /
    // parent_symbol_path / doc_comment / symbol_name_qualified) follow the SAME chunk_text-gated
    // CASE pattern as `embedding` (#769). Re-chunk (chunk_text changed) trusts EXCLUDED outright;
    // pure re-embed (chunk_text unchanged) COALESCEs so a caller that only carries embedding
    // doesn't clobber metadata to NULL. Without this, every embed --stale pass nuked code-def's
    // primary index for thousands of chunks at once.
    //
    // #3461: `model` mirrors the `embedding` CASE branch-for-branch — the label must
    // describe whichever vector WINS the upsert. The old COALESCE(EXCLUDED.model, …)
    // relabeled preserved (older-model) vectors with the current gateway model on every
    // partial re-embed, corrupting provenance without changing the vector.
    await sql.unsafe(
      `INSERT INTO content_chunks ${cols} VALUES ${rows.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         ${writeColId} = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.${writeColId}
           WHEN content_chunks.${writeColId} IS NULL THEN EXCLUDED.${writeColId}
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.${writeColId}
           ELSE content_chunks.${writeColId}
         END,
         model = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.model
           WHEN content_chunks.${writeColId} IS NULL THEN EXCLUDED.model
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.model
           ELSE content_chunks.model
         END,
         token_count = EXCLUDED.token_count,
         embedded_at = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text AND EXCLUDED.${writeColId} IS NULL THEN NULL
           WHEN content_chunks.${writeColId} IS NULL AND EXCLUDED.${writeColId} IS NOT NULL THEN EXCLUDED.embedded_at
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_at
           ELSE content_chunks.embedded_at
         END,
         embedded_text_hash = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedded_text_hash
           WHEN content_chunks.${writeColId} IS NULL THEN EXCLUDED.embedded_text_hash
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_text_hash
           ELSE content_chunks.embedded_text_hash
         END,
         language = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.language ELSE COALESCE(EXCLUDED.language, content_chunks.language) END,
         symbol_name = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_name ELSE COALESCE(EXCLUDED.symbol_name, content_chunks.symbol_name) END,
         symbol_type = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_type ELSE COALESCE(EXCLUDED.symbol_type, content_chunks.symbol_type) END,
         start_line = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.start_line ELSE COALESCE(EXCLUDED.start_line, content_chunks.start_line) END,
         end_line = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.end_line ELSE COALESCE(EXCLUDED.end_line, content_chunks.end_line) END,
         parent_symbol_path = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.parent_symbol_path ELSE COALESCE(EXCLUDED.parent_symbol_path, content_chunks.parent_symbol_path) END,
         doc_comment = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.doc_comment ELSE COALESCE(EXCLUDED.doc_comment, content_chunks.doc_comment) END,
         symbol_name_qualified = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.symbol_name_qualified ELSE COALESCE(EXCLUDED.symbol_name_qualified, content_chunks.symbol_name_qualified) END,
         modality = EXCLUDED.modality,
         embedding_image = COALESCE(EXCLUDED.embedding_image, content_chunks.embedding_image)`,
      params as Parameters<typeof sql.unsafe>[1],
    );
  }

  async getChunks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean }): Promise<Chunk[]> {
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const scalarSourceId = opts?.sourceId ?? 'default';
    // S2: embedding_is_null reports the registry-ACTIVE column's truth —
    // `embed <page>` filters on it, so legacy-column truth would re-embed
    // every chunk on every pass on a registry-routed brain.
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const includeEmbedding = opts?.includeEmbedding === true;
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(sourceIds, sourceIds ? undefined : scalarSourceId, async (tx) => {
      const scope = sourceIds
        ? tx`p.source_id = ANY(${sourceIds}::text[])`
        : tx`p.source_id = ${scalarSourceId}`;
      // #2544: explicit non-vector column list — most callers discard
      // embeddings, so `cc.*` shipped every vector over the wire only to be
      // thrown away. `includeEmbedding` adds it back for the callers that
      // consume it (embed-reuse.ts); it selects the registry-ACTIVE column
      // (aliased AS embedding) so a reused vector always matches the column
      // upsertChunks writes.
      // embedding_is_null: boolean truth of the stored vector (a schema
      // rebuild NULLs vectors without touching embedded_at).
      const embedCol = includeEmbedding ? tx`, cc.${tx.unsafe(colId)} AS embedding` : tx``;
      const rows = await tx`
        SELECT cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
               cc.model, cc.token_count, cc.embedded_at, cc.language,
               cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
               cc.parent_symbol_path, cc.doc_comment, cc.symbol_name_qualified, cc.modality,
               (cc.${tx.unsafe(colId)} IS NULL) AS embedding_is_null
               ${embedCol}
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = ${slug} AND ${scope}
        ORDER BY cc.chunk_index
      `;
      return rows.map((r: Record<string, unknown>) => rowToChunk(r, includeEmbedding));
    });
  }

  /**
   * Build the stale-chunk WHERE clause + positional params for sql.unsafe.
   * `staleColRef` is the registry-ACTIVE embedding column reference
   * (`cc."<name>"`, S2 unification — a registry-routed brain's staleness
   * lives in the active column, never the literal legacy `cc.embedding`).
   * embed_skip always excluded. `signature` widens "stale" to include
   * embedding_signature drift (NULL grandfathered). `includeNullSignature`
   * (#3391) lifts the grandfather clause so pre-stamp pages count as stale
   * too (provider-migration paths). Shared by countStaleChunks +
   * sumStaleChunkChars (parity with the PGLite sibling).
   */
  private buildStaleChunkWhere(staleColRef: string, opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): { where: string; params: unknown[] } {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (opts?.signature !== undefined) {
      params.push(opts.signature);
      conds.push(
        opts.includeNullSignature
          ? `(${staleColRef} IS NULL OR p.embedding_signature IS NULL OR p.embedding_signature <> $${params.length})`
          : `(${staleColRef} IS NULL OR (p.embedding_signature IS NOT NULL AND p.embedding_signature <> $${params.length}))`,
      );
    } else {
      conds.push(`${staleColRef} IS NULL`);
    }
    conds.push(`NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
    if (opts?.sourceId !== undefined) {
      params.push(opts.sourceId);
      conds.push(`p.source_id = $${params.length}`);
    }
    return { where: conds.join(' AND '), params };
  }

  /** S2: quoted identifier of the registry-ACTIVE embedding column for the
   *  stale/invalidate/health plane — read-only sites pass fallbackToLegacy
   *  so a broken registry row can't crash diagnostics (writes/invalidation
   *  stay loud). Callers prefix the table alias themselves (`cc.${colId}`). */
  private async activeEmbeddingColId(opts?: { fallbackToLegacy?: boolean }): Promise<string> {
    const col = await resolveActiveEmbeddingColumnFromEngine(this, opts);
    return quoteIdentifier(col.name);
  }

  async countStaleChunks(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    // Always JOIN pages so the embed_skip + signature predicates apply.
    // D7: source_id scoping. v0.41.31: optional signature widens staleness
    // to embedding_signature drift (NULL grandfathered unless
    // includeNullSignature, #3391).
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { where, params } = this.buildStaleChunkWhere(`cc.${staleColId}`, opts);
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      const rows = await tx.unsafe(
        `SELECT count(*)::int AS count
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE ${where}`,
        params as Parameters<typeof tx.unsafe>[1],
      );
      return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
    });
  }

  async sumStaleChunkChars(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    // Sibling of countStaleChunks: same stale predicate, summing chunk_text
    // length for the sync cost preview. ::bigint guards int4 overflow.
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { where, params } = this.buildStaleChunkWhere(`cc.${staleColId}`, opts);
    const rows = await this.sql.unsafe(
      `SELECT COALESCE(SUM(LENGTH(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE ${where}`,
      params as Parameters<typeof this.sql.unsafe>[1],
    );
    return Number((rows[0] as { chars?: number | string } | undefined)?.chars ?? 0);
  }

  async setPageEmbeddingSignature(slug: string, opts: { sourceId?: string; signature: string }): Promise<void> {
    const sql = this.sql;
    await sql`
      UPDATE pages SET embedding_signature = ${opts.signature}
      WHERE slug = ${slug} AND source_id = ${opts.sourceId ?? 'default'}
    `;
  }

  async invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string; includeNullSignature?: boolean }): Promise<number> {
    // NULL embeddings whose page signature is set AND differs from current.
    // GRANDFATHER: NULL signature untouched — UNLESS includeNullSignature
    // (#3391): provider migrations must not leave pre-stamp pages in the old
    // embedding space. Feeds the NULL-embedding cursor so listStaleChunks
    // stays unchanged. RETURNING → row count. S2: keyed on the registry-
    // ACTIVE column (loud resolver failure — destructive writes never guess).
    const colId = await this.activeEmbeddingColId();
    const params: unknown[] = [opts.signature];
    let srcClause = '';
    if (opts.sourceId !== undefined) {
      params.push(opts.sourceId);
      srcClause = ` AND p.source_id = $${params.length}`;
    }
    const sigClause = opts.includeNullSignature
      ? `(p.embedding_signature IS NULL OR p.embedding_signature <> $1)`
      : `p.embedding_signature IS NOT NULL
          AND p.embedding_signature <> $1`;
    const rows = await this.sql.unsafe(
      `UPDATE content_chunks cc
          SET ${colId} = NULL, embedded_at = NULL
         FROM pages p
        WHERE cc.page_id = p.id
          AND cc.${colId} IS NOT NULL
          AND ${sigClause}${srcClause}
        RETURNING cc.page_id`,
      params as Parameters<typeof this.sql.unsafe>[1],
    );
    return (rows as unknown[]).length;
  }

  async invalidateContentDriftEmbeddings(opts?: { sourceId?: string }): Promise<number> {
    // #4246: NULL embeddings whose stored embed-time hash no longer matches
    // md5(chunk_text) — the vector was computed from a PREVIOUS content
    // revision. Feeds the NULL-embedding cursor (mirrors the signature
    // invalidation above). GRANDFATHER: NULL hash (pre-v133 rows) untouched
    // so upgrades don't trigger a corpus-wide re-embed spike. embed_skip
    // pages excluded — the stale selectors can't re-embed them, so NULLing
    // would strand them (same never-NULL-what-nothing-re-embeds rule as
    // embedding-invalidation.ts). Mirrored in pglite-engine.ts (parity).
    // S2: keyed on the registry-ACTIVE column (loud resolver failure).
    const colId = await this.activeEmbeddingColId();
    const params: unknown[] = [];
    let srcClause = '';
    if (opts?.sourceId !== undefined) {
      params.push(opts.sourceId);
      srcClause = ` AND p.source_id = $${params.length}`;
    }
    const sql = this.sql;
    const rows = await sql.unsafe(
      `UPDATE content_chunks cc
          SET ${colId} = NULL, embedded_at = NULL, embedded_text_hash = NULL
         FROM pages p
        WHERE cc.page_id = p.id
          AND cc.${colId} IS NOT NULL
          AND cc.embedded_text_hash IS NOT NULL
          AND cc.embedded_text_hash <> md5(cc.chunk_text)
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')${srcClause}
        RETURNING cc.page_id`,
      params as Parameters<typeof sql.unsafe>[1],
    );
    return (rows as unknown[]).length;
  }

  async listStaleChunks(opts?: {
    batchSize?: number;
    afterPageId?: number;
    afterChunkIndex?: number;
    sourceId?: string;
    orderBy?: 'page_id' | 'updated_desc';
    afterUpdatedAt?: string | null;
  }): Promise<StaleChunkRow[]> {
    const limit = opts?.batchSize ?? 2000;
    const afterPid = opts?.afterPageId ?? 0;
    const afterIdx = opts?.afterChunkIndex ?? -1;
    const orderBy = opts?.orderBy ?? 'page_id';

    // S2: stale = NULL in the registry-ACTIVE column. Resolved BEFORE the
    // scoped transaction; read-only listing falls back to legacy on a broken
    // registry (the upsert it feeds throws the loud resolver error anyway).
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });

    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      // v0.41.18.0 (A13, codex #9): --priority recent path. Composite cursor
      // (updated_at DESC NULLS LAST, page_id ASC, chunk_index ASC). Backed by
      // idx_pages_updated_at_desc + content_chunks_stale_idx partial.
      if (orderBy === 'updated_desc') {
        const afterUpdated = opts?.afterUpdatedAt ?? null;
        const isFirstPage = afterUpdated === null && afterPid === 0;
        if (opts?.sourceId === undefined) {
          const rows = isFirstPage ? await tx`
            SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                   cc.model, cc.token_count, p.source_id, cc.page_id,
                   p.updated_at
            FROM content_chunks cc
            JOIN pages p ON p.id = cc.page_id
            WHERE cc.${tx.unsafe(staleColId)} IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT ${limit}
          ` : await tx`
            SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                   cc.model, cc.token_count, p.source_id, cc.page_id,
                   p.updated_at
            FROM content_chunks cc
            JOIN pages p ON p.id = cc.page_id
            WHERE cc.${tx.unsafe(staleColId)} IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
              AND (
                p.updated_at < ${afterUpdated}::timestamptz
                OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id > ${afterPid})
                OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id = ${afterPid} AND cc.chunk_index > ${afterIdx})
              )
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT ${limit}
          `;
          return rows as unknown as StaleChunkRow[];
        }
        const rows = isFirstPage ? await tx`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id,
                 p.updated_at
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${tx.unsafe(staleColId)} IS NULL
            AND p.source_id = ${opts.sourceId}
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT ${limit}
        ` : await tx`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id,
                 p.updated_at
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${tx.unsafe(staleColId)} IS NULL
            AND p.source_id = ${opts.sourceId}
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (
              p.updated_at < ${afterUpdated}::timestamptz
              OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id > ${afterPid})
              OR (p.updated_at = ${afterUpdated}::timestamptz AND p.id = ${afterPid} AND cc.chunk_index > ${afterIdx})
            )
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT ${limit}
        `;
        return rows as unknown as StaleChunkRow[];
      }
      // orderBy === 'page_id' — legacy stable cursor.
      if (opts?.sourceId === undefined) {
        const rows = await tx`
          SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                 cc.model, cc.token_count, p.source_id, cc.page_id
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.${tx.unsafe(staleColId)} IS NULL
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (cc.page_id, cc.chunk_index) > (${afterPid}, ${afterIdx})
          ORDER BY cc.page_id, cc.chunk_index
          LIMIT ${limit}
        `;
        return rows as unknown as StaleChunkRow[];
      }
      const rows = await tx`
        SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
               cc.model, cc.token_count, p.source_id, cc.page_id
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.${tx.unsafe(staleColId)} IS NULL
          AND p.source_id = ${opts.sourceId}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          AND (cc.page_id, cc.chunk_index) > (${afterPid}, ${afterIdx})
        ORDER BY cc.page_id, cc.chunk_index
        LIMIT ${limit}
      `;
      return rows as unknown as StaleChunkRow[];
    });
  }

  /**
   * Shared chunkless-page-with-content predicate (mirrors PGLiteEngine).
   * Excludes quarantined + embed_skip pages — both are intentionally
   * chunkless by design, not drift the safety net should repair.
   */
  private buildChunklessPagesWhere(opts?: { sourceId?: string }): { where: string; params: unknown[] } {
    const conds: string[] = [
      'p.deleted_at IS NULL',
      // healChunklessPages chunks BOTH compiled_truth and timeline (mirrors
      // embedPage) — a timeline-only page (rare but schema-legal) has
      // something to heal even with compiled_truth = ''.
      `(p.compiled_truth <> '' OR p.timeline <> '')`,
      EMBED_SKIP_FILTER_FRAGMENT,
      QUARANTINE_FILTER_FRAGMENT,
      'NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)',
    ];
    const params: unknown[] = [];
    if (opts?.sourceId) {
      params.push(opts.sourceId);
      conds.push(`p.source_id = $${params.length}`);
    }
    return { where: conds.join(' AND '), params };
  }

  async countChunklessPagesWithContent(opts?: { sourceId?: string }): Promise<number> {
    const { where, params } = this.buildChunklessPagesWhere(opts);
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      const rows = await tx.unsafe(
        `SELECT count(*)::int AS count FROM pages p WHERE ${where}`,
        params as Parameters<typeof tx.unsafe>[1],
      );
      return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
    });
  }

  async listChunklessPagesWithContent(opts?: {
    batchSize?: number;
    afterPageId?: number;
    sourceId?: string;
  }): Promise<ChunklessPageRow[]> {
    const { where, params } = this.buildChunklessPagesWhere(opts);
    let afterClause = '';
    if (opts?.afterPageId != null) {
      params.push(opts.afterPageId);
      afterClause = ` AND p.id > $${params.length}`;
    }
    // Small default (unlike the 2000-row chunk-metadata cursors elsewhere):
    // each row here carries a FULL page body. See engine.ts docstring.
    const limit = opts?.batchSize ?? 50;
    params.push(limit);
    const limitIdx = params.length;
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      const rows = await tx.unsafe(
        `SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline
           FROM pages p
          WHERE ${where}${afterClause}
          ORDER BY p.id
          LIMIT $${limitIdx}`,
        params as Parameters<typeof tx.unsafe>[1],
      );
      return (rows as Record<string, unknown>[]).map(r => ({
        id: r.id as number,
        slug: r.slug as string,
        source_id: (r.source_id as string | undefined) ?? 'default',
        compiled_truth: (r.compiled_truth as string | null) ?? '',
        timeline: (r.timeline as string | null) ?? '',
      }));
    });
  }

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    await sql`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId})
    `;
  }

  // ── v0.42.7 (#1696): link/timeline extraction freshness watermark ──

  /** Shared stale-for-extraction predicate. Returns `{ where, params }`. */
  private buildStalePagesWhere(opts?: { sourceId?: string; versionTs?: string }): { where: string; params: unknown[] } {
    const conds: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts?.versionTs) {
      params.push(opts.versionTs);
      conds.push(`(links_extracted_at IS NULL OR links_extracted_at < $${params.length}::timestamptz OR updated_at > links_extracted_at)`);
    } else {
      conds.push('(links_extracted_at IS NULL OR updated_at > links_extracted_at)');
    }
    if (opts?.sourceId) {
      params.push(opts.sourceId);
      conds.push(`source_id = $${params.length}`);
    }
    return { where: conds.join(' AND '), params };
  }

  async countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string }): Promise<number> {
    const { where, params } = this.buildStalePagesWhere(opts);
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts?.sourceId, async (tx) => {
      const rows = await tx.unsafe(
        `SELECT count(*)::int AS count FROM pages WHERE ${where}`,
        params as Parameters<typeof tx.unsafe>[1],
      );
      return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
    });
  }

  async listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
  }): Promise<StalePageRow[]> {
    const { where, params } = this.buildStalePagesWhere(opts);
    let afterClause = '';
    if (opts.afterPageId != null) {
      params.push(opts.afterPageId);
      afterClause = ` AND id > $${params.length}`;
    }
    params.push(opts.batchSize);
    const limitIdx = params.length;
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(undefined, opts.sourceId, async (tx) => {
      const rows = await tx.unsafe(
        // #1768: project a deterministic full-µs UTC string alongside updated_at.
        // to_char (not ::text — DateStyle-fragile) so extractStaleFromDB can stamp
        // links_extracted_at = the exact updated_at and the staleness predicate clears.
        `SELECT id, slug, source_id, type, title, compiled_truth, timeline, frontmatter, updated_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
           FROM pages
           WHERE ${where}${afterClause}
           ORDER BY id
           LIMIT $${limitIdx}`,
        params as Parameters<typeof tx.unsafe>[1],
      );
      return (rows as Record<string, unknown>[]).map(rowToStalePage);
    });
  }

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number> {
    if (refs.length === 0) return 0;
    const slugs = refs.map(r => r.slug);
    const srcs = refs.map(r => r.source_id);
    // Per-ref timestamp (D4 race fix): extract --stale passes each row's read
    // updated_at; sites that omit it fall back to defaultExtractedAt.
    const tss = refs.map(r => r.extractedAt ?? defaultExtractedAt);
    const sql = this.sql;
    // #3957: count() makes the stamped-row count observable so callers
    // (stampExtracted) can surface a wrong-source shortfall instead of
    // claiming success while every ref missed. Mirrors the PGLite engine.
    const result = await sql`
      UPDATE pages p SET links_extracted_at = v.ts::timestamptz
      FROM unnest(${slugs}::text[], ${srcs}::text[], ${tss}::text[]) AS v(slug, source_id, ts)
      WHERE p.slug = v.slug AND p.source_id = v.source_id
    `;
    return result.count ?? 0;
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
    const sql = this.sql;
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    const originSrc = opts?.originSourceId ?? 'default';

    // Default link_source to 'markdown' for back-compat with pre-v0.13 callers.
    const src = linkSource ?? 'markdown';
    // #4109: resolve both required endpoints and upsert from ONE statement
    // snapshot — a separate pre-check raced concurrent hard deletes (a delete
    // winning between check and insert made a zero-row upsert look like
    // success). The lookups stay source-qualified per endpoint (JOIN-on-
    // (slug, source_id), not the pre-v0.18 cross-product that fanned out
    // across sources containing either slug). FOR KEY SHARE makes a
    // concurrent hard delete linearize around the mutation: a delete that
    // wins first is observed as a missing endpoint; a mutation that wins
    // first holds the referenced rows through the insert instead of leaking
    // a raw FK violation.
    const [result] = await sql`
      WITH endpoint_state AS (
        SELECT
          (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc} FOR KEY SHARE) AS from_id,
          (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc} FOR KEY SHARE) AS to_id,
          (SELECT id FROM pages WHERE slug = ${originSlug ?? null} AND source_id = ${originSrc} FOR KEY SHARE) AS origin_id
      ), upserted AS (
        INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
        SELECT s.from_id, s.to_id, ${linkType || ''}, ${sanitizeForJsonb(context || '')}, ${src}, s.origin_id, ${originField ?? null}
        FROM endpoint_state s
        WHERE s.from_id IS NOT NULL AND s.to_id IS NOT NULL
        ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
          context = EXCLUDED.context,
          origin_field = EXCLUDED.origin_field
        RETURNING 1
      )
      SELECT
        endpoint_state.from_id IS NOT NULL AS from_exists,
        endpoint_state.to_id IS NOT NULL AS to_exists
      FROM endpoint_state
    `;
    if (!result?.from_exists) throw new PageMissingError('addLink', 'from', from, fromSrc);
    if (!result.to_exists) throw new PageMissingError('addLink', 'to', to, toSrc);
  }

  async addLinksBatch(links: LinkBatchInput[], opts?: BatchOpts): Promise<number> {
    if (links.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addLinksBatch', opts?.signal, () => this._addLinksBatchOnce(links), links.length);
  }

  private async _addLinksBatchOnce(links: LinkBatchInput[]): Promise<number> {
    // #1861: pass the batch as one JSONB document via jsonb_to_recordset instead
    // of N parallel unnest(${arr}::text[]). The old text[] array-literal path
    // crashed Postgres ("malformed array literal") on free-text context strings
    // (calendar/Zoom lines with commas, quotes, braces, em-dashes); JSONB encodes
    // arbitrary text safely and dodges the 65535-param cap. Binding goes through
    // executeRawJsonb (the audited cross-engine JSONB contract) with an OBJECT
    // wrapper { rows } — a bare top-level array through postgres.js would re-enter
    // the same array serializer this fix exists to avoid. Row construction +
    // NUL-stripping + exact defaulting live in buildLinkRows (shared with PGLite).
    const rows = buildLinkRows(links);
    const result = await executeRawJsonb(
      this,
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, link_kind, origin_page_id, origin_field)
       SELECT f.id, t.id, v.link_type, v.context, v.link_source, v.link_kind, o.id, v.origin_field
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
         from_slug text, to_slug text, link_type text, context text, link_source text,
         origin_slug text, origin_field text, from_source_id text, to_source_id text,
         origin_source_id text, link_kind text
       )
       JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
       JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
       LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
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
    if (pages.length === 0) return 0;
    const payload = { pages, keep: opts.keepTypedNerPairs ?? [] };
    const rows = await executeRawJsonb(
      this,
      `WITH scope AS (
         SELECT f.id AS from_id
         FROM jsonb_to_recordset(($2::jsonb)->'pages') AS p(slug text, source_id text)
         JOIN pages f ON f.slug = p.slug AND f.source_id = p.source_id
       ),
       keep AS (
         SELECT f.id AS from_id, t.id AS to_id
         FROM jsonb_to_recordset(($2::jsonb)->'keep') AS k(
           from_slug text, from_source_id text, to_slug text, to_source_id text
         )
         JOIN pages f ON f.slug = k.from_slug AND f.source_id = k.from_source_id
         JOIN pages t ON t.slug = k.to_slug AND t.source_id = k.to_source_id
       )
       DELETE FROM links l
       USING scope s
       WHERE l.from_page_id = s.from_id
         AND l.link_source = $1
         AND NOT (
           COALESCE(l.link_kind, '') = 'typed_ner'
           AND EXISTS (
             SELECT 1 FROM keep k
             WHERE k.from_id = l.from_page_id AND k.to_id = l.to_page_id
           )
         )
       RETURNING 1`,
      [opts.linkSource],
      [payload],
    );
    return rows.length;
  }

  async removeLink(
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<number> {
    const sql = this.sql;
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    // Build up filters dynamically. linkType + linkSource are independent
    // optional constraints; all four combinations are valid. Each branch's
    // page-id subquery is source-qualified so multi-source brains don't
    // delete the wrong (from, to) pair.
    // #4527: RETURNING 1 so the caller learns how many edges actually died —
    // a zero-match delete must be distinguishable from a real removal.
    if (linkType !== undefined && linkSource !== undefined) {
      const rows = await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_type = ${linkType}
          AND link_source IS NOT DISTINCT FROM ${linkSource}
        RETURNING 1
      `;
      return rows.length;
    } else if (linkType !== undefined) {
      const rows = await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_type = ${linkType}
        RETURNING 1
      `;
      return rows.length;
    } else if (linkSource !== undefined) {
      const rows = await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
          AND link_source IS NOT DISTINCT FROM ${linkSource}
        RETURNING 1
      `;
      return rows.length;
    } else {
      const rows = await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from} AND source_id = ${fromSrc})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to} AND source_id = ${toSrc})
        RETURNING 1
      `;
      return rows.length;
    }
  }

  async getLinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<Link[]> {
    // Two layers of defense (see getPage for the full pattern):
    //   1. RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING)
    //   2. App-layer source filter (#2200 federated)
    return await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
      // #2200: federated grant scopes ALL THREE page endpoints — from, to, AND
      // the origin (the page that authored the edge, surfaced as origin_slug).
      // Scoping only from+to would still leak an out-of-grant origin's slug; the
      // origin LEFT JOIN carries the same ANY($) filter so origin_slug nulls
      // out of grant. Remote MCP clients always land here.
      if (opts?.sourceIds && opts.sourceIds.length > 0) {
        const ids = opts.sourceIds;
        const rows = await tx`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[])
          WHERE f.slug = ${slug} AND f.source_id = ANY(${ids}::text[]) AND t.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL
        `;
        return rows as unknown as Link[];
      }
      // v0.31.8 (D16) + #2200: the federated arm above is the first branch; the
      // two below preserve pre-v0.31.8 semantics. Without opts.sourceId, no
      // source filter (cross-source view for internal callers). With
      // opts.sourceId, scope the from-page lookup.
      // #3754: all three arms filter soft-deleted endpoints (f/t deleted_at IS
      // NULL) so links to/from soft-deleted pages stop voting in the graph,
      // matching orphans/get/list/search visibility.
      if (opts?.sourceId) {
        const rows = await tx`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id
          WHERE f.slug = ${slug} AND f.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL
        `;
        return rows as unknown as Link[];
      }
      const rows = await tx`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE f.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL
      `;
      return rows as unknown as Link[];
    });
  }

  async getBacklinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<Link[]> {
    // Two layers of defense (see getPage for the full pattern):
    //   1. RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING)
    //   2. App-layer source filter (#2200 federated)
    return await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
      // #2200: federated grant scopes all three endpoints (mirrors getLinks) —
      // the referrer (from), the queried page (to), AND the origin — so neither
      // a foreign referrer nor a foreign origin slug is disclosed to the caller.
      if (opts?.sourceIds && opts.sourceIds.length > 0) {
        const ids = opts.sourceIds;
        const rows = await tx`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY(${ids}::text[])
          WHERE t.slug = ${slug} AND t.source_id = ANY(${ids}::text[]) AND f.source_id = ANY(${ids}::text[])
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL
        `;
        return rows as unknown as Link[];
      }
      // v0.31.8 (D16) + #2200: federated arm above is first; two below mirror getLinks
      // (incl. the #3754 soft-delete endpoint filter on all three arms).
      if (opts?.sourceId) {
        const rows = await tx`
          SELECT f.slug as from_slug, f.source_id as from_source_id,
                 t.slug as to_slug, t.source_id as to_source_id,
                 l.link_type, l.context, l.link_source,
                 o.slug as origin_slug, o.source_id as origin_source_id,
                 l.origin_field
          FROM links l
          JOIN pages f ON f.id = l.from_page_id
          JOIN pages t ON t.id = l.to_page_id
          LEFT JOIN pages o ON o.id = l.origin_page_id
          WHERE t.slug = ${slug} AND t.source_id = ${opts.sourceId}
            AND f.deleted_at IS NULL AND t.deleted_at IS NULL
        `;
        return rows as unknown as Link[];
      }
      const rows = await tx`
        SELECT f.slug as from_slug, f.source_id as from_source_id,
               t.slug as to_slug, t.source_id as to_source_id,
               l.link_type, l.context, l.link_source,
               o.slug as origin_slug, o.source_id as origin_source_id,
               l.origin_field
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        JOIN pages t ON t.id = l.to_page_id
        LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE t.slug = ${slug}
          AND f.deleted_at IS NULL AND t.deleted_at IS NULL
      `;
      return rows as unknown as Link[];
    });
  }

  async listLinkSources(
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]> {
    // RLS scope binding (opt-in via GBRAIN_RLS_SCOPE_BINDING).
    return await this.withScopedReadTransaction(opts?.sourceIds, opts?.sourceId, async (tx) => {
      // v114 (#1941): distinct provenances + counts for `gbrain link-sources`.
      // Scope by the FROM page's source (consistent with getLinks). Federated
      // {sourceIds} takes precedence over scalar {sourceId}; neither = unscoped.
      const sourceCondition =
        opts?.sourceIds && opts.sourceIds.length > 0
          ? tx`WHERE f.source_id = ANY(${opts.sourceIds}::text[])`
          : opts?.sourceId
            ? tx`WHERE f.source_id = ${opts.sourceId}`
            : tx``;
      const rows = await tx`
        SELECT l.link_source, COUNT(*)::int AS count
        FROM links l
        JOIN pages f ON f.id = l.from_page_id
        ${sourceCondition}
        GROUP BY l.link_source
        ORDER BY count DESC, l.link_source ASC NULLS LAST
      `;
      return rows as unknown as { link_source: string | null; count: number }[];
    });
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
    sourceId?: string,
  ): Promise<{ slug: string; similarity: number } | null> {
    const sql = this.sql;
    // Use `%` so the existing idx_pages_trgm GIN index can prune candidates
    // when the requested threshold is at least pg_trgm's default 0.3. Below
    // that, retain the exact comparison path so low-threshold callers do not
    // lose valid matches. Keep the explicit comparison in both paths as the
    // result contract.
    //
    // Tie-breaker: sort by slug after similarity so re-runs return the
    // same winner when multiple pages score equally (prevents churn
    // in put_page auto-link reconciliation).
    //
    // `sourceId` + `deleted_at IS NULL` mirror the filters `tryFuzzyMatch`
    // in `src/core/entities/resolve.ts` got via #1436 (v0.41.13.0). Without
    // them, fuzzy resolution could suggest cross-source slugs that the
    // caller then silently drops at the FK filter in
    // `operations.ts:reconcileLinks` (the `allSlugs` filter) — making it
    // look like the match failed when in fact it picked the wrong page.
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const trgmPrefilter = minSimilarity >= 0.3
      ? sql`title % ${name} AND`
      : sql``;
    const rows = sourceId
      ? await sql`
          SELECT slug, similarity(title, ${name}) AS sim
          FROM pages
          WHERE ${trgmPrefilter} similarity(title, ${name}) >= ${minSimilarity}
            AND slug LIKE ${prefixPattern}
            AND source_id = ${sourceId}
            AND deleted_at IS NULL
          ORDER BY sim DESC, slug ASC
          LIMIT 1
        `
      : await sql`
          SELECT slug, similarity(title, ${name}) AS sim
          FROM pages
          WHERE ${trgmPrefilter} similarity(title, ${name}) >= ${minSimilarity}
            AND slug LIKE ${prefixPattern}
          ORDER BY sim DESC, slug ASC
          LIMIT 1
        `;
    if (rows.length === 0) return null;
    const row = rows[0] as { slug: string; sim: number };
    return { slug: row.slug, similarity: row.sim };
  }

  async traverseGraph(
    slug: string,
    depth: number = 5,
    opts?: import('./engine.ts').TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    const sql = this.sql;
    // v0.34.1 (#861 — P0 leak seal): scope visited nodes to the caller's
    // source(s). Without this, the walk follows edges into pages from
    // foreign sources, leaking topology + page metadata. The filter
    // applies at BOTH the seed (root must be in scope) AND the recursive
    // step (every visited neighbor must be in scope). The aggregation
    // subquery also filters so the per-node `links` array only includes
    // edges to in-scope pages.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    const seedScope = useSourceIds
      ? sql`AND p.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;
    const stepScope = useSourceIds
      ? sql`AND p2.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p2.source_id = ${opts.sourceId}`
        : sql``;
    const aggScope = useSourceIds
      ? sql`AND p3.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p3.source_id = ${opts.sourceId}`
        : sql``;
    // T8 (v0.36+): frontier cap. When set, the recursive term applies a
    // parenthesized LIMIT N with ORDER BY (slug, id) for stable selection.
    // Postgres' parenthesized-LIMIT inside a recursive term caps per
    // ITERATION, which maps approximately to per-BFS-LAYER (the mapping is
    // exact when fanout is bounded; for hub-fanout graphs the cap fires
    // early). Post-query, count rows per depth — if any depth == cap, fire
    // the truncation callback.
    const cap = opts?.frontierCap;
    const recursiveStep = cap !== undefined && cap > 0
      ? sql`(SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
             FROM graph g
             JOIN links l ON l.from_page_id = g.id
             JOIN pages p2 ON p2.id = l.to_page_id
             WHERE g.depth < ${depth}
               AND NOT (p2.id = ANY(g.visited))
               AND p2.deleted_at IS NULL
               ${stepScope}
             ORDER BY p2.slug ASC, p2.id ASC
             LIMIT ${cap})`
      : sql`SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
            FROM graph g
            JOIN links l ON l.from_page_id = g.id
            JOIN pages p2 ON p2.id = l.to_page_id
            WHERE g.depth < ${depth}
              AND NOT (p2.id = ANY(g.visited))
              AND p2.deleted_at IS NULL
              ${stepScope}`;
    // Cycle prevention: visited array tracks page IDs already in the path.
    const rows = await sql`
      WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${seedScope}

        UNION ALL

        ${recursiveStep}
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). The underlying links table
          -- preserves every row with its origin_page_id / link_source —
          -- the dedup is presentation-only for the legacy traverseGraph
          -- aggregation. traversePaths has its own in-memory dedup at a
          -- different layer. See plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id AND p3.deleted_at IS NULL ${aggScope}),
          '[]'::jsonb
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug
    `;

    // T8 truncation-detection callback was designed here but the v1 algorithm
    // had both false-positive (organic count == cap) and false-negative
    // (LIMIT-before-DISTINCT in diamond graphs) cases caught by adversarial
    // review. Stripped pending the dedupe-then-cap SQL rewrite + real Postgres
    // parity coverage. See TODOS.md → "T8 truncation signal".

    return rows.map((r: Record<string, unknown>) => ({
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as string,
      depth: r.depth as number,
      links: (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as { to_slug: string; link_type: string }[],
    }));
  }

  async traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string; sourceIds?: string[] },
  ): Promise<GraphPath[]> {
    return (await this.traversePathsDetailed(slug, opts)).paths;
  }

  async traversePathsDetailed(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string; sourceIds?: string[] },
  ): Promise<{ paths: GraphPath[]; truncated: boolean }> {
    const sql = this.sql;
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeMatches = linkType !== null;
    // v0.34.1 (#861 — P0 leak seal): source-scope filter fragments. Applied
    // at seed (root must be in scope) AND at every recursive step (neighbor
    // must be in scope) AND in the SELECT join (final edges respect scope).
    // The 'both' branch needs filters on BOTH endpoint joins.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    const seedScope = useSourceIds
      ? sql`AND p.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;
    const stepScope = useSourceIds
      ? sql`AND p2.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p2.source_id = ${opts.sourceId}`
        : sql``;
    // For the 'both' direction's final SELECT, both endpoint joins (pf, pt)
    // get scope filters so edges crossing into a foreign source are dropped.
    const pfScope = useSourceIds
      ? sql`AND pf.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND pf.source_id = ${opts.sourceId}`
        : sql``;
    const ptScope = useSourceIds
      ? sql`AND pt.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND pt.source_id = ${opts.sourceId}`
        : sql``;

    // #3754: soft-deleted pages are excluded at seed, every recursive step, and
    // the final SELECT joins — a deleted page neither anchors, relays, nor
    // terminates a path (mirrors pglite-engine.traversePaths).
    let rows;
    if (direction === 'out') {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        )
        SELECT w.slug as from_slug, p2.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `;
    } else if (direction === 'in') {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        )
        SELECT p2.slug as from_slug, w.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < ${depth}
          AND p2.deleted_at IS NULL
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `;
    } else {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug} AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
            ${stepScope}
        )
        SELECT pf.slug as from_slug, pt.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND pf.deleted_at IS NULL
          AND pt.deleted_at IS NULL
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
          ${pfScope}
          ${ptScope}
        ORDER BY depth, from_slug, to_slug
        LIMIT ${TRAVERSE_PATH_ROW_CAP + 1}
      `;
    }

    // Row cap: the LIMIT above fetched CAP + 1 rows; the probe row only tells
    // us the walk overflowed and is dropped with everything past the cap.
    const truncated = rows.length > TRAVERSE_PATH_ROW_CAP;
    const bounded = (truncated ? rows.slice(0, TRAVERSE_PATH_ROW_CAP) : rows) as Record<string, unknown>[];
    // Dedup edges (same edge can appear via multiple visited paths).
    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of bounded) {
      const key = `${r.from_slug}|${r.to_slug}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        from_slug: r.from_slug as string,
        to_slug: r.to_slug as string,
        link_type: r.link_type as string,
        context: (r.context as string) || '',
        depth: Number(r.depth),
      });
    }
    return { paths: result, truncated };
  }

  async relationalFanout(
    seeds: string[],
    opts?: import('./types.ts').RelationalFanoutOpts,
  ): Promise<import('./types.ts').RelationalFanoutRow[]> {
    if (!seeds || seeds.length === 0) return [];
    const sql = this.sql;
    const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    const types = opts?.linkTypes && opts.linkTypes.length > 0 ? opts.linkTypes : null;

    // Scope is applied to SEED selection only. Within-source traversal is
    // enforced separately by `p2.source_id = w.seed_source` in the recursive
    // step, so a walk can never cross a source boundary even when several
    // sources are in scope.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    const seedScope = useSourceIds
      ? sql`AND p.source_id = ANY(${opts!.sourceIds!}::text[])`
      : opts?.sourceId
        ? sql`AND p.source_id = ${opts.sourceId}`
        : sql``;
    const typeFilter = types ? sql`AND l.link_type = ANY(${types}::text[])` : sql``;
    const mentionsFilter = opts?.includeMentions
      ? sql``
      : sql`AND l.link_source IS DISTINCT FROM 'mentions'`;

    // Recursive step join differs by direction; everything else is shared.
    const recurStep =
      direction === 'out'
        ? sql`JOIN links l ON l.from_page_id = w.id JOIN pages p2 ON p2.id = l.to_page_id`
        : direction === 'in'
          ? sql`JOIN links l ON l.to_page_id = w.id JOIN pages p2 ON p2.id = l.from_page_id`
          : sql`JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
                JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END`;

    const rows = await sql`
      WITH RECURSIVE walk AS (
        SELECT p.id, p.slug, p.source_id, 0::int AS depth,
               ARRAY[p.id] AS visited, ARRAY[p.slug] AS path,
               p.source_id AS seed_source, NULL::text AS last_link_type
        FROM pages p
        WHERE p.slug = ANY(${seeds}::text[]) ${seedScope} AND p.deleted_at IS NULL
        UNION ALL
        SELECT p2.id, p2.slug, p2.source_id, w.depth + 1,
               w.visited || p2.id, w.path || p2.slug,
               w.seed_source, l.link_type
        FROM walk w
        ${recurStep}
        WHERE w.depth < ${depth}
          AND NOT (p2.id = ANY(w.visited))
          AND p2.source_id = w.seed_source
          AND p2.deleted_at IS NULL
          ${mentionsFilter}
          ${typeFilter}
      )
      SELECT n.source_id, n.slug,
             MIN(n.depth) AS hop,
             COUNT(DISTINCT n.last_link_type) AS edge_count,
             array_agg(DISTINCT n.last_link_type)
               FILTER (WHERE n.last_link_type IS NOT NULL) AS via_link_types,
             -- Final path tie-break (lexicographic) makes the pick deterministic
             -- when a node is reachable at the same depth from multiple seeds;
             -- without it the winner is plan/heap-order dependent and the two
             -- engines (or two runs) can disagree. Relational retrieval is
             -- documented deterministic; keep in lockstep with pglite-engine.ts.
             (array_agg(array_to_string(n.path, chr(9))
               ORDER BY n.depth ASC, array_length(n.path, 1) ASC,
                        array_to_string(n.path, chr(9)) ASC))[1] AS path_str,
             (SELECT cc.id FROM content_chunks cc
               WHERE cc.page_id = n.id ORDER BY cc.chunk_index ASC LIMIT 1) AS canonical_chunk_id
      FROM walk n
      WHERE n.depth > 0
      GROUP BY n.source_id, n.slug, n.id
      ORDER BY hop ASC, edge_count DESC, n.source_id ASC, n.slug ASC
      LIMIT ${limit}
    `;

    return (rows as Record<string, unknown>[]).map(r => ({
      source_id: r.source_id as string,
      slug: r.slug as string,
      hop: Number(r.hop),
      edge_count: Number(r.edge_count),
      via_link_types: Array.isArray(r.via_link_types) ? (r.via_link_types as string[]) : [],
      path: r.path_str ? String(r.path_str).split('\t') : [],
      canonical_chunk_id: r.canonical_chunk_id == null ? null : Number(r.canonical_chunk_id),
    }));
  }

  async getBacklinkCounts(pageIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (pageIds.length === 0) return result;
    for (const id of pageIds) result.set(id, 0);

    // v0.41.18.0 D12: filter mentions OUT of backlink-count for search
    // ranking. `link_source='mentions'` rows are auto-linked body-text
    // mentions from `gbrain extract links --by-mention`; they're
    // graph-completeness signal, NOT human-intent signal. Counting them
    // toward backlinks would shift search ranking globally on first
    // --by-mention run, boosting popular-mention pages over intentional-
    // backlink pages. `IS DISTINCT FROM` is NULL-safe so legacy rows with
    // NULL link_source still count (NULL != 'mentions' → row included).
    // #4380: keyed by p.id, not slug — grouping by bare slug summed every
    // namesake's backlinks across sources, boosting zero-backlink pages.
    const sql = this.sql;
    const rows = await sql`
      SELECT p.id as page_id, COUNT(l.id)::int as cnt
      FROM pages p
      LEFT JOIN links l ON l.to_page_id = p.id
        AND l.link_source IS DISTINCT FROM 'mentions'
      WHERE p.id = ANY(${pageIds}::int[])
      GROUP BY p.id
    `;
    for (const r of rows as unknown as { page_id: number; cnt: number }[]) {
      result.set(Number(r.page_id), Number(r.cnt));
    }
    return result;
  }

  async getAdjacencyBoosts(pageIds: number[]): Promise<Map<number, import('./types.ts').AdjacencyRow>> {
    const result = new Map<number, import('./types.ts').AdjacencyRow>();
    if (pageIds.length === 0) return result;

    const sql = this.sql;
    // SQL contract: see BrainEngine.getAdjacencyBoosts JSDoc. Both ANY
    // filters restrict the scan to the input set's induced subgraph,
    // which keeps cross-source leakage impossible by construction.
    // cross_source_hits uses COALESCE so NULL source_id rows behave as
    // 'default' and don't silently disappear from the count.
    //
    // Defense-in-depth (codex outside-voice review): deleted_at IS NULL
    // on both join sides so a soft-deleted page in the input set
    // (theoretically possible if a future caller bypasses hybridSearch's
    // visibility filter) can't contribute to hits or cross_source_hits.
    // Matches the v0.35.5.0 findOrphanPages fix pattern.
    const rows = await sql`
      WITH targets AS (
        SELECT id, COALESCE(source_id, 'default') AS source_id
        FROM pages
        WHERE id = ANY(${pageIds}::int[])
          AND deleted_at IS NULL
      )
      SELECT
        l.to_page_id AS to_page_id,
        COUNT(DISTINCT l.from_page_id)::int AS hits,
        COUNT(DISTINCT
          CASE WHEN COALESCE(p.source_id, 'default') <> t.source_id
               THEN COALESCE(p.source_id, 'default') END
        )::int AS cross_source_hits
      FROM links l
      JOIN pages   p ON p.id = l.from_page_id AND p.deleted_at IS NULL
      JOIN targets t ON t.id = l.to_page_id
      WHERE l.from_page_id = ANY(${pageIds}::int[])
        AND l.to_page_id   = ANY(${pageIds}::int[])
      GROUP BY l.to_page_id
      HAVING COUNT(DISTINCT l.from_page_id) >= 1
    `;
    for (const r of rows as unknown as { to_page_id: number; hits: number; cross_source_hits: number }[]) {
      result.set(Number(r.to_page_id), {
        hits: Number(r.hits),
        cross_source_hits: Number(r.cross_source_hits),
      });
    }
    return result;
  }

  async getContentFlagsByPageIds(
    pageIds: number[],
  ): Promise<Map<number, { reason: string; detail: string }>> {
    const result = new Map<number, { reason: string; detail: string }>();
    if (pageIds.length === 0) return result;
    const sql = this.sql;
    const rows = await sql`
      SELECT id,
             frontmatter -> 'content_flag' ->> 'reason' AS reason,
             frontmatter -> 'content_flag' ->> 'detail' AS detail
      FROM pages
      WHERE id = ANY(${pageIds}::int[])
        AND frontmatter ? 'content_flag'
    `;
    for (const r of rows as unknown as { id: number; reason: string | null; detail: string | null }[]) {
      if (!r.reason) continue;
      result.set(Number(r.id), { reason: r.reason, detail: r.detail ?? '' });
    }
    return result;
  }

  async getUnverifiedExtractionPageIds(
    pageIds: number[],
  ): Promise<Map<number, { unverified: boolean; status: string }>> {
    const result = new Map<number, { unverified: boolean; status: string }>();
    if (pageIds.length === 0) return result;
    const sql = this.sql;
    // Quarantine predicate is the shared unverifiedExtractionFragment (issue
    // #160) so this query and the SQL-side source-boost guard can never
    // drift. #4220 widened the projection: any page with a frontmatter
    // `status` value is returned (draft/superseded/restricted/... surface on
    // SearchResult.status); the fragment match stays the quarantine flag.
    const rows = await sql.unsafe(
      `SELECT id,
              (COALESCE(frontmatter, '{}'::jsonb) ->> 'status') AS status,
              (${unverifiedExtractionFragment('pages')}) AS unverified
       FROM pages
       WHERE id = ANY($1::int[])
         AND (COALESCE(frontmatter, '{}'::jsonb) ->> 'status') IS NOT NULL`,
      [pageIds] as never,
    );
    for (const r of rows as unknown as { id: number; status: string; unverified: boolean }[]) {
      result.set(Number(r.id), { unverified: r.unverified === true, status: r.status });
    }
    return result;
  }

  async getPageTimestamps(slugs: string[]): Promise<Map<string, Date>> {
    if (slugs.length === 0) return new Map();
    const sql = this.sql;
    const rows = await sql`
      SELECT slug, COALESCE(updated_at, created_at) as ts
      FROM pages WHERE slug = ANY(${slugs}::text[])
    `;
    return new Map(rows.map(r => [r.slug as string, new Date(r.ts as string)]));
  }

  async getEffectiveDates(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, Date>> {
    if (refs.length === 0) return new Map();
    const sql = this.sql;
    const slugs = refs.map(r => r.slug);
    const sourceIds = refs.map(r => r.source_id);
    // Composite-keyed: a page is unique by (source_id, slug). unnest the
    // two arrays in lockstep so multi-source brains don't fan out across
    // sources (codex pass-1 finding #3).
    const rows = await sql`
      SELECT p.slug, p.source_id, COALESCE(p.effective_date, p.updated_at, p.created_at) AS ts
        FROM pages p
        JOIN unnest(${slugs}::text[], ${sourceIds}::text[]) AS u(slug, source_id)
          ON p.slug = u.slug AND p.source_id = u.source_id
    `;
    const out = new Map<string, Date>();
    for (const raw of rows as unknown as Array<Record<string, unknown>>) {
      const r = raw as { slug: string; source_id: string; ts: string | Date };
      const key = `${r.source_id}::${r.slug}`;
      out.set(key, r.ts instanceof Date ? r.ts : new Date(r.ts));
    }
    return out;
  }

  async getSalienceScores(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, number>> {
    if (refs.length === 0) return new Map();
    const sql = this.sql;
    const slugs = refs.map(r => r.slug);
    const sourceIds = refs.map(r => r.source_id);
    // Salience = emotional_weight × 5 + ln(1 + take_count). Pure mattering
    // signal — NO time component (per D9: salience and recency are
    // orthogonal axes). Composite-keyed for multi-source isolation.
    const rows = await sql`
      SELECT p.slug, p.source_id,
             (COALESCE(p.emotional_weight, 0) * 5
              + ln(1 + COUNT(DISTINCT t.id))) AS score
        FROM pages p
        JOIN unnest(${slugs}::text[], ${sourceIds}::text[]) AS u(slug, source_id)
          ON p.slug = u.slug AND p.source_id = u.source_id
        LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE
       GROUP BY p.id
    `;
    const out = new Map<string, number>();
    for (const raw of rows as unknown as Array<Record<string, unknown>>) {
      const r = raw as { slug: string; source_id: string; score: number | string };
      const key = `${r.source_id}::${r.slug}`;
      out.set(key, Number(r.score));
    }
    return out;
  }

  async findOrphanPages(opts?: {
    sourceId?: string;
    sourceIds?: string[];
    mode?: 'inbound' | 'islanded';
  }): Promise<Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean }>> {
    const sql = this.sql;
    // Soft-delete filter on BOTH sides:
    //   - candidate: p.deleted_at IS NULL — soft-deleted pages aren't orphan candidates
    //   - link source: src.deleted_at IS NULL — links FROM soft-deleted pages don't count as inbound
    // Without the link-source filter, a live page can hide from orphan results purely
    // because a soft-deleted page links to it. v0.26.5 invariant; codex C11.
    //
    // v0.41.29.0: scope ONLY the candidate side (`p.source_id`) when opts.sourceId
    // is set. The inbound-link NOT EXISTS deliberately counts links from ANY source:
    // a page in source X linked FROM source Y is reachable, so NOT an orphan of X.
    // Do NOT add `src.source_id = p.source_id` here — that would be the stricter
    // intra-source-only definition we deliberately reject.
    const sourceFilter =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
        : opts?.sourceId
          ? sql`AND p.source_id = ${opts.sourceId}`
          : sql``;
    // #4524: default mode 'islanded' — identical predicate to getHealth's
    // orphan_pages (no live inbound AND no live outbound; outbound counts
    // only when its TARGET page is live, per gbrain#4153 endpoint liveness).
    // mode 'inbound' preserves the legacy no-inbound-only view.
    const outboundFilter =
      (opts?.mode ?? 'islanded') === 'islanded'
        ? sql`AND NOT EXISTS (
            SELECT 1
            FROM links l
            JOIN pages tgt ON tgt.id = l.to_page_id
            WHERE l.from_page_id = p.id
              AND tgt.deleted_at IS NULL
          )`
        : sql``;
    const rows = await sql`
      SELECT
        p.slug,
        COALESCE(p.title, p.slug) AS title,
        p.frontmatter->>'domain' AS domain,
        p.type,
        (NOT ${sql.unsafe(QUARANTINE_FILTER_FRAGMENT)}) AS quarantined
      FROM pages p
      WHERE p.deleted_at IS NULL
        ${sourceFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM links l
          JOIN pages src ON src.id = l.from_page_id
          WHERE l.to_page_id = p.id
            AND src.deleted_at IS NULL
        )
        ${outboundFilter}
      ORDER BY p.slug
    `;
    return rows as unknown as Array<{ slug: string; title: string; domain: string | null; type?: string | null; quarantined?: boolean }>;
  }

  // Tags
  async addTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    // Verify page exists before attempting insert (ON CONFLICT DO NOTHING
    // swallows the "already tagged" case, but we still need to detect missing
    // pages). Source-scoped lookup — pre-v0.18 the bare-slug subquery returned
    // multiple rows in multi-source brains and crashed with Postgres 21000.
    const page = await sql`SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId}`;
    if (page.length === 0) throw new Error(`addTag failed: page "${slug}" (source=${sourceId}) not found`);
    await sql`
      INSERT INTO tags (page_id, tag)
      VALUES (${page[0].id}, ${tag})
      ON CONFLICT (page_id, tag) DO NOTHING
    `;
  }

  async removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    await sql`
      DELETE FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId})
        AND tag = ${tag}
    `;
  }

  async getTags(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<string[]> {
    const sql = this.sql;
    // #2200: federated grant (sourceIds[]) wins over scalar sourceId. Use
    // `page_id IN (subquery)` — NOT `= (subquery)` — because a federated read of
    // a slug present in >1 allowed source resolves multiple page-ids, which would
    // throw under the scalar-subquery form. DISTINCT unions tags across the
    // matched pages. Scalar/unscoped path keeps the legacy `?? 'default'` default.
    const scope =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sql`source_id = ANY(${opts.sourceIds}::text[])`
        : sql`source_id = ${opts?.sourceId ?? 'default'}`;
    const rows = await sql`
      SELECT DISTINCT tag FROM tags
      WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug} AND ${scope})
      ORDER BY tag
    `;
    return rows.map((r) => r.tag as string);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<boolean> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    // #4109: page resolution and insertion share ONE statement snapshot, so a
    // concurrent hard delete linearizes before the lookup (missing) or after
    // the insert (success) instead of surfacing a raw FK violation; FOR KEY
    // SHARE holds the referenced row through the insert. ON CONFLICT DO
    // NOTHING via the (page_id, date, md5(summary), source) unique index
    // (#3737: md5-keyed so long summaries fit the btree row cap).
    // #3827: the `inserted` flag makes the outcome observable — with the
    // page_exists throw below (default) a false return unambiguously means
    // "deduplicated", and under skipExistenceCheck the caller asserts the
    // page exists. Source-qualify the page-id lookup so multi-source brains
    // don't fan timeline rows out across every source containing the slug.
    // Free-text body fields are NUL + lone-surrogate sanitized (#2011) so a
    // surrogate from sliced/imported content can't reach the (later) ::jsonb
    // batch path or corrupt the row; identity fields (slug, date) are left raw.
    const [result] = await sql`
      WITH page_state AS (
        SELECT id FROM pages WHERE slug = ${slug} AND source_id = ${sourceId} FOR KEY SHARE
      ), inserted AS (
        INSERT INTO timeline_entries (page_id, date, source, summary, detail)
        SELECT id, ${entry.date}::date, ${sanitizeForJsonb(entry.source || '')}, ${sanitizeForJsonb(entry.summary)}, ${sanitizeForJsonb(entry.detail || '')}
        FROM page_state
        ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
        RETURNING 1
      )
      SELECT
        EXISTS(SELECT 1 FROM page_state) AS page_exists,
        EXISTS(SELECT 1 FROM inserted) AS inserted
    `;
    if (!result?.page_exists && !opts?.skipExistenceCheck) {
      throw new PageMissingError('addTimelineEntry', 'page', slug, sourceId);
    }
    return result?.inserted === true;
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[], opts?: BatchOpts): Promise<number> {
    if (entries.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addTimelineEntriesBatch', opts?.signal, () => this._addTimelineEntriesBatchOnce(entries), entries.length);
  }

  private async _addTimelineEntriesBatchOnce(entries: TimelineBatchInput[]): Promise<number> {
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). Meeting
    // summary/detail/source are free text with the same array-literal crash
    // hazard as link context. See _addLinksBatchOnce for the full rationale.
    // `date` stays text in the recordset and is cast v.date::date in the SELECT,
    // exactly as the old unnest shape did.
    const rows = buildTimelineRows(entries);
    const result = await executeRawJsonb(
      this,
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT p.id, v.date::date, v.source, v.summary, v.detail
       FROM jsonb_to_recordset(($1::jsonb)->'rows')
         AS v(slug text, date text, source text, summary text, detail text, source_id text)
       JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id AND p.deleted_at IS NULL
       ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const sql = this.sql;
    const limit = opts?.limit || 100;
    // #2200 (D5A): collapse the former 8-branch (sourceId × after × before)
    // cartesian tree into ONE query built from composed WHERE fragments — the
    // same postgres.js `sql`` idiom getPage/getBacklinks/listLinkSources use.
    // Scope precedence: federated sourceIds[] > scalar sourceId > unscoped. The
    // federated arm unions entries across every same-slug page in the grant.
    // (PGLite builds the equivalent via its dynamic where[]/params[] array —
    // different idiom by design, same behavior; lockstep is on result, not builder.)
    const sourceCond =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`
        : opts?.sourceId
          ? sql`AND p.source_id = ${opts.sourceId}`
          : sql``;
    const afterCond = opts?.after ? sql`AND te.date >= ${opts.after}::date` : sql``;
    const beforeCond = opts?.before ? sql`AND te.date <= ${opts.before}::date` : sql``;
    const rows = await sql`
      SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id
      WHERE p.slug = ${slug} ${sourceCond} ${afterCond} ${beforeCond}
      ORDER BY te.date DESC LIMIT ${limit}`;
    return rows as unknown as TimelineEntry[];
  }

  // ── v0.42.x Life Chronicle (#2390) timeline reads ───────────────────────
  // Shared shape: timeline_entries JOIN depth page (deleted_at IS NULL) LEFT
  // JOIN event page; hide soft-deleted event projections (read-time, not just
  // doctor); order by COALESCE(event effective_date, date) for intra-day
  // sequence. Source scope: federated sourceIds[] > scalar sourceId > unscoped.
  // ep=true: the ep LEFT JOIN carries the same scope so out-of-scope event fields null out (#2200 origin-join shape).
  private chronicleSourceCond(opts?: { sourceId?: string; sourceIds?: string[] }, ep = false) {
    const sql = this.sql;
    if (opts?.sourceIds && opts.sourceIds.length > 0)
      return ep ? sql`AND ep.source_id = ANY(${opts.sourceIds}::text[])` : sql`AND p.source_id = ANY(${opts.sourceIds}::text[])`;
    if (opts?.sourceId) return ep ? sql`AND ep.source_id = ${opts.sourceId}` : sql`AND p.source_id = ${opts.sourceId}`;
    return sql``;
  }

  async getTimelineForDate(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const sql = this.sql;
    const limit = opts?.limit ?? 200;
    // ISO week (date_trunc('week') → Monday) or the single day.
    const lower = opts?.week ? sql`date_trunc('week', ${date}::date)::date` : sql`${date}::date`;
    const upper = opts?.week ? sql`(date_trunc('week', ${date}::date) + interval '6 days')::date` : sql`${date}::date`;
    const rows = await sql`
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${this.chronicleSourceCond(opts, true)}
      WHERE te.date >= ${lower} AND te.date <= ${upper}
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${this.chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
      LIMIT ${limit}`;
    return rows as unknown as ChronicleTimelineRow[];
  }

  async getSince(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const sql = this.sql;
    const limit = opts?.limit ?? 200;
    const kindCond = opts?.kind ? sql`AND ep.frontmatter->'event'->>'kind' = ${opts.kind}` : sql``;
    const rows = await sql`
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${this.chronicleSourceCond(opts, true)}
      WHERE te.date >= ${date}::date
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${kindCond}
        ${this.chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
      LIMIT ${limit}`;
    return rows as unknown as ChronicleTimelineRow[];
  }

  async getOnThisDay(opts?: { date?: string; limit?: number; sourceId?: string; sourceIds?: string[] }): Promise<ChronicleTimelineRow[]> {
    const sql = this.sql;
    const limit = opts?.limit ?? 50;
    const target = opts?.date ? sql`${opts.date}::date` : sql`current_date`;
    const rows = await sql`
      SELECT te.date::text AS date, te.summary, te.detail, te.source,
             te.page_id, p.slug AS page_slug,
             te.event_page_id, ep.slug AS event_slug,
             ep.effective_date::text AS effective_date,
             ep.frontmatter->'event'->>'kind' AS kind
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${this.chronicleSourceCond(opts, true)}
      WHERE EXTRACT(MONTH FROM te.date) = EXTRACT(MONTH FROM ${target})
        AND EXTRACT(DAY FROM te.date) = EXTRACT(DAY FROM ${target})
        AND te.date < ${target}
        AND (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        ${this.chronicleSourceCond(opts)}
      ORDER BY te.date DESC, te.id ASC
      LIMIT ${limit}`;
    return rows as unknown as ChronicleTimelineRow[];
  }

  async getLastSeen(entitySlug: string, opts?: { asof?: string; sourceId?: string; sourceIds?: string[] }): Promise<LastSeenResult> {
    const sql = this.sql;
    // "Seen" = the entity's own page has a timeline row, OR an event's `who`
    // array references the entity (exact slug or wikilink-substring match).
    // "Last seen" is a PAST relation: the chronicle legitimately stores
    // future events (calendar-event is eligibility-eligible), so bound to
    // <= asof/today or a scheduled event reads as "seen today". Mirrors
    // getOnThisDay's `te.date < target` bound.
    const seenThrough = opts?.asof ? sql`${opts.asof}::date` : sql`current_date`;
    const rows = await sql`
      SELECT te.date::text AS last_date, ep.slug AS last_event_slug
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
      LEFT JOIN pages ep ON ep.id = te.event_page_id ${this.chronicleSourceCond(opts, true)}
      WHERE (te.event_page_id IS NULL OR ep.deleted_at IS NULL)
        AND te.date <= ${seenThrough}
        AND (
          p.slug = ${entitySlug}
          OR (ep.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(ep.frontmatter->'event'->'who') = 'array'
                   THEN ep.frontmatter->'event'->'who' ELSE '[]'::jsonb END
            ) AS w(name)
            WHERE w.name = ${entitySlug} OR w.name LIKE ${'%' + entitySlug + '%'}
          ))
        )
        ${this.chronicleSourceCond(opts)}
      ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) DESC, te.id DESC
      LIMIT 1`;
    const row = rows[0] as { last_date?: string; last_event_slug?: string } | undefined;
    return finalizeLastSeen(entitySlug, row?.last_date ?? null, row?.last_event_slug ?? null, opts?.asof);
  }

  async upsertEventProjection(opts: { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string }): Promise<{ projected: boolean }> {
    const sql = this.sql;
    const sourceId = opts.sourceId ?? 'default';
    const rows = await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
      SELECT dp.id, ${opts.date}::date, ${'life-chronicle:event:' + opts.eventSlug}, ${opts.summary}, ${opts.detail ?? ''}, ep.id
      FROM pages dp, pages ep
      WHERE dp.slug = ${opts.depthSlug} AND dp.source_id = ${sourceId}
        AND ep.slug = ${opts.eventSlug} AND ep.source_id = ${sourceId}
      ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL
      DO UPDATE SET summary = EXCLUDED.summary, detail = EXCLUDED.detail,
                    page_id = EXCLUDED.page_id, source = EXCLUDED.source
      RETURNING id`;
    return { projected: rows.length > 0 };
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

    if (current && current.value_hash === vh) {
      // Same value → corroboration (or exact dup → noop via the dedup unique).
      const ins = await sql<{ id: number }[]>`
        INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                           confidence, source, source_markdown_slug, valid_from, valid_until, expired_at, consolidated_into)
        VALUES (${sourceId}, ${obs.entitySlug}, ${factText}, 'fact', ${visibility}, ${dimension}, ${obs.value}, ${vh}, ${status},
                ${conf}, ${obs.source}, ${obs.source}, COALESCE(${validFrom}::timestamptz, now()), ${validUntil}, now(), ${current.id})
        ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug) WHERE dimension IS NOT NULL
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
      ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug) WHERE dimension IS NOT NULL
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
    const rows = await sql<OntologyValue[]>`
      SELECT DISTINCT ON (dimension)
        dimension, value, confidence,
        source_markdown_slug AS source, valid_from, valid_until AS valid_to,
        COALESCE(dim_status, 'active') AS status, id AS fact_id
      FROM facts
      WHERE entity_slug = ${entitySlug} AND dimension IS NOT NULL AND expired_at IS NULL
        ${scope}
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

  async findOntologyConflicts(opts?: { sourceId?: string; sourceIds?: string[]; minConfidence?: number }): Promise<OntologyConflict[]> {
    const sql = this.sql;
    const minConf = opts?.minConfidence ?? 0;
    const scope = opts?.sourceIds && opts.sourceIds.length
      ? sql`AND source_id = ANY(${opts.sourceIds})`
      : sql`AND (${opts?.sourceId ?? null}::text IS NULL OR source_id = ${opts?.sourceId ?? null})`;
    const rows = await sql<{ entity_slug: string; dimension: string; values: OntologyConflict['values'] }[]>`
      WITH cur AS (
        SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
        FROM facts
        WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL
          AND (dim_status IS NULL OR dim_status = 'active')
          AND confidence >= ${minConf} ${scope}
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
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<RawData[]> {
    const sql = this.sql;
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const sourceId = sourceIds ? undefined : opts?.sourceId;
    let rows;
    if (source && sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ANY(${sourceIds}::text[])`;
    } else if (sourceIds) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND p.source_id = ANY(${sourceIds}::text[])`;
    } else if (source && sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND rd.source = ${source} AND p.source_id = ${sourceId}`;
    } else if (source) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND rd.source = ${source}`;
    } else if (sourceId) {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND p.source_id = ${sourceId}`;
    } else {
      rows = await sql`SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug}`;
    }
    return rows as unknown as RawData[];
  }

  // Files (v0.27.1): binary asset metadata. Image bytes never touch the DB
  // (storage_path references a path inside the brain repo). Identity is
  // (source_id, storage_path); re-upsert with same content_hash is a no-op,
  // different content_hash overwrites in place.
  async upsertFile(spec: FileSpec): Promise<{ id: number; created: boolean }> {
    const sql = this.sql;
    const sourceId = spec.source_id ?? 'default';
    const metadata = (spec.metadata ?? {}) as Parameters<typeof sql.json>[0];
    const rows = await sql<Array<{ id: number; created: boolean }>>`
      INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
      VALUES (${sourceId}, ${spec.page_slug ?? null}, ${spec.page_id ?? null}, ${spec.filename}, ${spec.storage_path}, ${spec.mime_type ?? null}, ${spec.size_bytes ?? null}, ${spec.content_hash}, ${sql.json(metadata)})
      ON CONFLICT (storage_path) DO UPDATE SET
        page_slug = EXCLUDED.page_slug,
        page_id = EXCLUDED.page_id,
        filename = EXCLUDED.filename,
        mime_type = EXCLUDED.mime_type,
        size_bytes = EXCLUDED.size_bytes,
        content_hash = EXCLUDED.content_hash,
        metadata = EXCLUDED.metadata
      RETURNING id, (xmax = 0) AS created
    `;
    if (rows.length === 0) throw new Error(`upsertFile returned no rows for ${spec.storage_path}`);
    return { id: rows[0].id, created: !!rows[0].created };
  }

  async getFile(sourceId: string, storagePath: string): Promise<FileRow | null> {
    const sql = this.sql;
    const rows = await sql<Array<FileRow>>`
      SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
      FROM files
      WHERE source_id = ${sourceId} AND storage_path = ${storagePath}
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  }

  async listFilesForPage(pageId: number): Promise<FileRow[]> {
    const sql = this.sql;
    const rows = await sql<Array<FileRow>>`
      SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
      FROM files
      WHERE page_id = ${pageId}
      ORDER BY created_at ASC
    `;
    return rows as FileRow[];
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

  // Peeled into ./postgres-engine/facts.ts (containment sprint C15): the
  // methods below are one-line delegates over free functions with a narrow
  // deps surface.

  /** Narrow deps for the peeled facts module. */
  private get factsDeps(): PgFactsDeps {
    const self = this;
    return {
      get sql() { return self.sql; },
      resolveFactsEmbeddingCast: () => self.resolveFactsEmbeddingCast(),
    };
  }

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

  /** Test seam: clear the cached cast suffix so tests can re-probe. */
  __resetFactsEmbeddingCastCacheForTest(): void {
    this._factsEmbeddingCastSuffix = null;
  }

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
    return factsImpl.insertFact(this.factsDeps, input, ctx);
  }

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
    return factsImpl.expireFact(this.factsDeps, id, opts);
  }

  async insertFacts(
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string; superseded_by_row?: number }>,
    ctx: { source_id: string },
    opts?: { deleteForPageFirst?: { slug: string; excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean } },
  ): Promise<{ inserted: number; ids: number[]; warnings: string[]; deleted: number }> {
    return factsImpl.insertFacts(this.factsDeps, rows, ctx, opts);
  }

  async deleteFactsForPage(
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[]; preserveExpiredLegacy?: boolean },
  ): Promise<{ deleted: number }> {
    return factsImpl.deleteFactsForPage(this.factsDeps, slug, source_id, opts);
  }

  async listFactsByEntity(
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsByEntity(this.factsDeps, source_id, entitySlug, opts);
  }

  async listFactsSince(
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string },
  ): Promise<FactRow[]> {
    return factsImpl.listFactsSince(this.factsDeps, source_id, since, opts);
  }

  async listFactsBySession(
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return factsImpl.listFactsBySession(this.factsDeps, source_id, sessionId, opts);
  }

  async listSupersessions(
    source_id: string,
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[] },
  ): Promise<FactRow[]> {
    return factsImpl.listSupersessions(this.factsDeps, source_id, opts);
  }

  async countUnconsolidatedFacts(source_id: string): Promise<number> {
    return factsImpl.countUnconsolidatedFacts(this.factsDeps, source_id);
  }

  async findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array },
  ): Promise<FactRow[]> {
    return factsImpl.findCandidateDuplicates(this.factsDeps, source_id, entitySlug, factText, opts);
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    return factsImpl.consolidateFact(this.factsDeps, id, takeId);
  }

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    return factsImpl.findTrajectory(this.factsDeps, opts);
  }

  async getFactsHealth(source_id: string): Promise<FactsHealth> {
    return factsImpl.getFactsHealth(this.factsDeps, source_id);
  }

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence
  // ============================================================

  // Peeled into ./postgres-engine/takes.ts (containment sprint C15).

  /** Narrow deps for the peeled takes module. */
  private get takesDeps(): PgTakesDeps {
    const self = this;
    return {
      get sql() { return self.sql; },
      batchRetry: <T>(auditSite: BatchAuditSite, signal: AbortSignal | undefined, fn: () => Promise<T>, batchSize: number) =>
        self.batchRetry(auditSite, signal, fn, batchSize),
      executeRawJsonb: <R = Record<string, unknown>>(sqlText: string, scalarParams: SqlValue[], jsonbParams: unknown[]) =>
        executeRawJsonb<R>(self, sqlText, scalarParams, jsonbParams),
    };
  }

  async addTakesBatch(rowsIn: TakeBatchInput[], opts?: BatchOpts): Promise<number> {
    return takesImpl.addTakesBatch(this.takesDeps, rowsIn, opts);
  }

  async listActiveTakesForPages(
    pageIds: number[],
    opts: { takesHoldersAllowList?: string[] } = {},
  ): Promise<Map<number, Take[]>> {
    return takesImpl.listActiveTakesForPages(this.takesDeps, pageIds, opts);
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
    return takesImpl.writeContradictionsRun(this.takesDeps, row);
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
    return takesImpl.loadContradictionsTrend(this.takesDeps, days);
  }

  async getContradictionCacheEntry(key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null> {
    return takesImpl.getContradictionCacheEntry(this.takesDeps, key);
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
    return takesImpl.putContradictionCacheEntry(this.takesDeps, opts);
  }

  async sweepContradictionCache(): Promise<number> {
    return takesImpl.sweepContradictionCache(this.takesDeps);
  }

  async listTakes(opts: TakesListOpts = {}): Promise<Take[]> {
    return takesImpl.listTakes(this.takesDeps, opts);
  }

  async searchTakes(query: string, opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {}): Promise<TakeHit[]> {
    return takesImpl.searchTakes(this.takesDeps, query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[] } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakesVector(this.takesDeps, embedding, opts);
  }

  async getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>> {
    return takesImpl.getTakeEmbeddings(this.takesDeps, ids);
  }

  async countStaleTakes(): Promise<number> {
    return takesImpl.countStaleTakes(this.takesDeps);
  }

  async listStaleTakes(): Promise<StaleTakeRow[]> {
    return takesImpl.listStaleTakes(this.takesDeps);
  }

  async updateTakeEmbeddings(rowsIn: TakeEmbeddingInput[], opts?: BatchOpts): Promise<number> { return takesImpl.updateTakeEmbeddings(this.takesDeps, rowsIn, opts); }

  async updateTake(
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void> {
    return takesImpl.updateTake(this.takesDeps, pageId, rowNum, fields);
  }

  async supersedeTake(
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }> {
    return takesImpl.supersedeTake(this.takesDeps, pageId, oldRow, newRow);
  }

  async resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
    return takesImpl.resolveTake(this.takesDeps, pageId, rowNum, resolution);
  }

  async getScorecard(opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard> {
    return takesImpl.getScorecard(this.takesDeps, opts, allowList);
  }

  async getCalibrationCurve(opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]> {
    return takesImpl.getCalibrationCurve(this.takesDeps, opts, allowList);
  }

  async addSynthesisEvidence(rowsIn: SynthesisEvidenceInput[]): Promise<number> {
    return takesImpl.addSynthesisEvidence(this.takesDeps, rowsIn);
  }

  // Versions
  async createVersion(slug: string, opts?: { sourceId?: string }): Promise<PageVersion> {
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    const rows = await sql`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
      SELECT id, compiled_truth, frontmatter
      FROM pages WHERE slug = ${slug} AND source_id = ${sourceId}
      RETURNING *
    `;
    if (rows.length === 0) throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<PageVersion[]> {
    const sql = this.sql;
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const rows = await sql`
        SELECT pv.* FROM page_versions pv
        JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = ${slug} AND p.source_id = ANY(${opts.sourceIds}::text[])
        ORDER BY pv.snapshot_at DESC
      `;
      return rows as unknown as PageVersion[];
    }
    if (opts?.sourceId) {
      const rows = await sql`
        SELECT pv.* FROM page_versions pv
        JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = ${slug} AND p.source_id = ${opts.sourceId}
        ORDER BY pv.snapshot_at DESC
      `;
      return rows as unknown as PageVersion[];
    }
    const rows = await sql`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ${slug}
      ORDER BY pv.snapshot_at DESC
    `;
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(
    slug: string,
    versionId: number,
    opts?: { sourceId?: string },
  ): Promise<void> {
    const sql = this.sql;
    // v0.31.8 (D12): two-branch. With opts.sourceId, scope BOTH the page lookup
    // AND the version reference. Without it, multi-source brains can revert
    // the wrong same-slug page.
    if (opts?.sourceId) {
      await sql`
        UPDATE pages SET
          compiled_truth = pv.compiled_truth,
          frontmatter = pv.frontmatter,
          updated_at = now()
        FROM page_versions pv
        WHERE pages.slug = ${slug} AND pages.source_id = ${opts.sourceId}
              AND pv.id = ${versionId} AND pv.page_id = pages.id
      `;
      return;
    }
    await sql`
      UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = ${slug} AND pv.id = ${versionId} AND pv.page_id = pages.id
    `;
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
          WHERE cc.${sql.unsafe(colId)} IS NULL
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
    const sql = this.sql;
    const sourceId = opts?.sourceId ?? 'default';
    // Source-qualify so a rename in source A doesn't sweep up same-slug rows
    // in sources B/C/D (which would either rename them all OR fail the
    // (source_id, slug) UNIQUE if the new slug already exists in another source).
    const result = await sql`UPDATE pages SET slug = ${newSlug}, updated_at = now() WHERE slug = ${oldSlug} AND source_id = ${sourceId}`;
    // #3056: rows moved — a zero-row UPDATE does not throw, so the count is
    // the only way callers can see the no-op.
    return result.count ?? 0;
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
  ): Promise<string> {
    return (await this.resolveSlugWithAliasDetailed(slug, sourceOrSources))?.canonical_slug ?? slug;
  }

  async resolveSlugWithAliasDetailed(
    slug: string,
    sourceOrSources: string | readonly string[],
  ): Promise<{ canonical_slug: string; source_id: string } | null> {
    const sql = this.sql;
    const sources = Array.isArray(sourceOrSources) ? sourceOrSources : [sourceOrSources];
    if (sources.length === 0) return null;
    try {
      const rows = await sql`
        SELECT canonical_slug, source_id
        FROM slug_aliases
        WHERE alias_slug = ${slug}
          AND source_id = ANY(${sources}::text[])
        ORDER BY array_position(${sources}::text[], source_id), id
      `;
      if (rows.length === 0) return null;
      if (rows.length > 1) {
        warnOncePerProcess(
          `resolveSlugWithAlias:multi_match:${slug}`,
          `[resolveSlugWithAlias] multi_match: alias '${slug}' exists in ${rows.length} sources; returning first by sourceOrSources order.`,
        );
      }
      return { canonical_slug: rows[0].canonical_slug as string, source_id: rows[0].source_id as string };
    } catch (e) {
      // Pre-v105 brain: slug_aliases table doesn't exist yet. Defense-in-depth
      // per the engine interface contract.
      if (isUndefinedTableError(e)) return null;
      throw e;
    }
  }

  async resolveAliases(
    aliasNorms: string[],
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<Map<string, Array<{ slug: string; source_id: string }>>> {
    const out = new Map<string, Array<{ slug: string; source_id: string }>>();
    if (!aliasNorms || aliasNorms.length === 0) return out;
    const sql = this.sql;
    const sources =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? opts.sourceIds
        : opts?.sourceId
          ? [opts.sourceId]
          : null;
    const rows = sources
      ? await sql`
          SELECT alias_norm, slug, source_id
          FROM page_aliases
          WHERE alias_norm = ANY(${aliasNorms}::text[])
            AND source_id = ANY(${sources}::text[])
          ORDER BY alias_norm, source_id, slug`
      : await sql`
          SELECT alias_norm, slug, source_id
          FROM page_aliases
          WHERE alias_norm = ANY(${aliasNorms}::text[])
          ORDER BY alias_norm, source_id, slug`;
    for (const r of rows) {
      const a = r.alias_norm as string;
      const list = out.get(a) ?? [];
      const ref = { slug: r.slug as string, source_id: r.source_id as string };
      if (!list.some(x => x.slug === ref.slug && x.source_id === ref.source_id)) list.push(ref);
      out.set(a, list);
    }
    return out;
  }

  async setPageAliases(slug: string, sourceId: string, aliasNorms: string[]): Promise<void> {
    const sql = this.sql;
    const uniq = Array.from(new Set(aliasNorms.filter(a => a.length > 0)));
    await sql.begin(async tx => {
      await tx`DELETE FROM page_aliases WHERE source_id = ${sourceId} AND slug = ${slug}`;
      if (uniq.length === 0) return;
      await tx`
        INSERT INTO page_aliases (source_id, alias_norm, slug)
        SELECT ${sourceId}, a, ${slug} FROM unnest(${uniq}::text[]) AS a
        ON CONFLICT (source_id, alias_norm, slug) DO NOTHING`;
    });
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

  async getChunksWithEmbeddings(slug: string, opts?: { sourceId?: string }): Promise<Chunk[]> {
    const conn = this.sql;
    const sourceId = opts?.sourceId;
    const rows = sourceId
      ? await conn`
          SELECT cc.* FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = ${slug} AND p.source_id = ${sourceId}
          ORDER BY cc.chunk_index
        `
      : await conn`
          SELECT cc.* FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = ${slug}
          ORDER BY cc.chunk_index
        `;
    return rows.map((r) => rowToChunk(r as Record<string, unknown>, true));
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
   * The ONLY difference between the two public methods is which connection they
   * pick (read pool vs direct session pool), so the cancellation plumbing lives
   * here in one place rather than being copy-pasted.
   *
   * v0.41.18.0 (A20, codex #7): real cancellation via postgres.js's .cancel()
   * on the pending query. Init nudge (3s wallclock cap) is the first consumer;
   * the AbortSignal fires when the timer trips. An already-aborted signal
   * short-circuits before the network round-trip.
   */
  private runUnsafe<T>(
    conn: ReturnType<typeof postgres>,
    sql: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> {
    // #4145 R2-2 preflight: an ALREADY-aborted signal must short-circuit
    // BEFORE the query is dispatched — the previous order created the
    // pending query first and cancelled it after, which still burned a
    // round-trip (and on a saturated pool, a slot). Cancellation remains
    // BEST-EFFORT overall (PG protocol cancel is async); callers that need
    // correctness must rely on their own fencing, not this signal.
    if (opts?.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const pending = conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1]);
    if (opts?.signal) {
      const onAbort = () => {
        try {
          (pending as unknown as { cancel?: () => void }).cancel?.();
        } catch {
          // best-effort; the .finally below settles regardless
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      return (pending as unknown as Promise<T[]>).finally(() => {
        opts.signal?.removeEventListener('abort', onAbort);
      });
    }
    return pending as unknown as Promise<T[]>;
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

  // Peeled into ./postgres-engine/code-edges.ts (containment sprint C15).

  /** Narrow deps for the peeled code-edges module. */
  private get codeEdgesDeps(): PgCodeEdgesDeps {
    const self = this;
    return { get sql() { return self.sql; } };
  }

  async addCodeEdges(edges: import('./types.ts').CodeEdgeInput[]): Promise<number> {
    return codeEdgesImpl.addCodeEdges(this.codeEdgesDeps, edges);
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    return codeEdgesImpl.deleteCodeEdgesForChunks(this.codeEdgesDeps, chunkIds);
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCallersOf(this.codeEdgesDeps, qualifiedName, opts);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getCalleesOf(this.codeEdgesDeps, qualifiedName, opts);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    return codeEdgesImpl.getEdgesByChunk(this.codeEdgesDeps, chunkId, opts);
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

  // Peeled into ./postgres-engine/salience.ts (containment sprint C15).

  /** Narrow deps for the peeled salience module. */
  private get salienceDeps(): PgSalienceDeps {
    const self = this;
    return { get sql() { return self.sql; } };
  }

  async batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]> {
    return salienceImpl.batchLoadEmotionalInputs(this.salienceDeps, slugs);
  }

  async setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number> {
    return salienceImpl.setEmotionalWeightBatch(this.salienceDeps, rows);
  }

  async getRecentSalience(opts: SalienceOpts): Promise<SalienceResult[]> {
    return salienceImpl.getRecentSalience(this.salienceDeps, opts);
  }

  async listEnrichCandidates(opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]> {
    return salienceImpl.listEnrichCandidates(this.salienceDeps, opts);
  }

  async findAnomalies(opts: AnomaliesOpts): Promise<AnomalyResult[]> {
    return salienceImpl.findAnomalies(this.salienceDeps, opts);
  }
}
