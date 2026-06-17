import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Transaction } from '@electric-sql/pglite';
import type {
  BrainEngine,
  BatchOpts,
  LinkBatchInput, TimelineBatchInput,
  ReservedConnection,
  DreamVerdict, DreamVerdictInput,
  FileSpec, FileRow,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
  FactRow, FactKind, FactVisibility, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
  SourceRow,
} from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { withRetry, BULK_RETRY_OPTS, resolveBulkRetryOpts, computeNextDelay, type BatchAuditSite } from './retry.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import { runMigrations } from './migrate.ts';
import { PGLITE_SCHEMA_SQL, getPGLiteSchema } from './pglite-schema.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { DELETE_BATCH_SIZE } from './engine-constants.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput, StaleChunkRow, StalePageRow,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
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
import { validateSlug, contentHash, rowToPage, rowToStalePage, rowToChunk, rowToSearchResult, takeRowToTake, isUndefinedTableError, warnOncePerProcess } from './utils.ts';
import { deriveResolutionTuple, finalizeScorecard } from './takes-resolution.ts';
import { normalizeWeightForStorage } from './takes-fence.ts';
import { executeRawJsonb } from './sql-query.ts';
import { sanitizeForJsonb, buildLinkRows, buildTimelineRows, buildTakeRows } from './batch-rows.ts';
import { GBrainError, PAGE_SORT_SQL, ENRICH_ORDER_SQL } from './types.ts';
import { computeAnomaliesFromBuckets } from './cycle/anomaly.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildRecencyComponentSql, buildBestPerPagePoolCte } from './search/sql-ranking.ts';
import {
  normalizeEngineColumn,
  buildVectorCastFragment,
  quoteIdentifier,
  COLUMN_NAME_REGEX,
  EmbeddingColumnNotRegisteredError,
} from './search/embedding-column.ts';
import { hasCJK, escapeLikePattern } from './cjk.ts';

type PGLiteDB = PGlite;

// Tier 3 snapshot fast-restore. Reads a tar dump produced by
// `bun run scripts/build-pglite-snapshot.ts`. Snapshot is matched against
// the current MIGRATIONS hash via a sidecar `.version` file; on mismatch we
// silently fall through to a normal initSchema (snapshot is just an
// optimization, never authoritative).
let _snapshotWarnLogged = false;
function tryLoadSnapshot(snapshotPath: string): Blob | null {
  try {
    // Lazy require so production builds without these imports don't crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const { MIGRATIONS } = require('./migrate.ts') as typeof import('./migrate.ts');
    const { PGLITE_SCHEMA_SQL } = require('./pglite-schema.ts') as typeof import('./pglite-schema.ts');

    if (!fs.existsSync(snapshotPath)) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] GBRAIN_PGLITE_SNAPSHOT set but file missing: ${snapshotPath} — using normal init.`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const versionPath = snapshotPath.replace(/\.tar(?:\.gz)?$/, '.version');
    if (!fs.existsSync(versionPath)) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] snapshot version file missing: ${versionPath} — using normal init.`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const expectedHash = computeSnapshotSchemaHash(MIGRATIONS, PGLITE_SCHEMA_SQL, crypto);
    const actualHash = fs.readFileSync(versionPath, 'utf8').trim();
    if (expectedHash !== actualHash) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] snapshot stale (schema hash mismatch) — using normal init. Rebuild with: bun run build:pglite-snapshot`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const buf = fs.readFileSync(snapshotPath);
    return new Blob([buf]);
  } catch {
    // Any failure -> fall through to normal init. Never block tests.
    return null;
  }
}

export function computeSnapshotSchemaHash(
  migrations: Array<{ version: number; name: string; sql?: string; sqlFor?: { pglite?: string } }>,
  schemaSQL: string,
  crypto: typeof import('node:crypto'),
): string {
  const hash = crypto.createHash('sha256');
  hash.update('schema:');
  hash.update(schemaSQL);
  hash.update('\nmigrations:\n');
  for (const m of migrations) {
    hash.update(String(m.version));
    hash.update('\t');
    hash.update(m.name);
    hash.update('\t');
    hash.update(m.sql ?? '');
    hash.update('\t');
    hash.update(m.sqlFor?.pglite ?? '');
    hash.update('\n');
  }
  return hash.digest('hex');
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
 * `macos-26-3` — the pre-existing #223 hint signature (early macOS
 *   26.3 builds shipped a broken WASM runtime).
 *
 * `unknown` — falls through to a generic hint that still names the
 *   doctor command and the most-common-cause link.
 *
 * Regex tightened per Codex eng-review finding #9: don't match
 * generic `pglite.data` substring (could fire on unrelated PGLite
 * errors). Match the literal `$$bunfs` marker OR ENOENT+pglite.data
 * co-occurrence.
 */
export type PgliteInitFailure = 'bunfs' | 'macos-26-3' | 'unknown';

export function classifyPgliteInitError(message: string): PgliteInitFailure {
  if (/\$\$bunfs|ENOENT[\s\S]*pglite\.data/i.test(message)) return 'bunfs';
  if (/abort.*runtime|macos.*26\.3|wasm.*runtime/i.test(message)) {
    return 'macos-26-3';
  }
  return 'unknown';
}

export function buildPgliteInitErrorMessage(
  verdict: PgliteInitFailure,
  original: string,
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
    case 'macos-26-3':
      hint =
        '  This is most commonly the macOS 26.3 WASM bug:\n' +
        '  https://github.com/garrytan/gbrain/issues/223';
      break;
    case 'unknown':
    default:
      hint =
        '  Most common cause: the macOS 26.3 WASM bug\n' +
        '  (https://github.com/garrytan/gbrain/issues/223).\n' +
        '  Run `gbrain doctor` for a full diagnosis.';
      break;
  }
  return `${header}\n${hint}\n  Original error: ${original}`;
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

export class PGLiteEngine implements BrainEngine {
  readonly kind = 'pglite' as const;
  private _db: PGLiteDB | null = null;
  private _lock: LockHandle | null = null;
  // #2034: captured at connect() so reconnect() can restore the same data dir
  // after a drop, matching PostgresEngine's _savedConfig contract.
  private _savedConfig: EngineConfig | null = null;
  // Tier 3: when GBRAIN_PGLITE_SNAPSHOT loaded a post-initSchema state into
  // PGlite.create(loadDataDir), initSchema is a no-op (schema is already
  // present + migrations already applied). Saves ~1-3s per fresh test PGLite.
  private _snapshotLoaded = false;

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config; // #2034: remember for reconnect()
    const dataDir = config.database_path || undefined; // undefined = in-memory

    // Acquire file lock to prevent concurrent PGLite access (crashes with Aborted())
    this._lock = await acquireLock(dataDir);

    if (!this._lock.acquired) {
      throw new Error('Could not acquire PGLite lock. Another gbrain process is using the database.');
    }

    // Tier 3: optional snapshot fast-restore. Only applies to in-memory
    // engines (no persistent dataDir). The snapshot was built from a fresh
    // `initSchema()` run; if the version file matches the current MIGRATIONS
    // hash, load the dump and skip the schema replay. Mismatch or missing
    // file silently falls back to normal init.
    let loadDataDir: Blob | undefined;
    if (!dataDir && process.env.GBRAIN_PGLITE_SNAPSHOT) {
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
    try {
      this._db = await preservingProcessExitCode(() =>
        PGlite.create({
          dataDir,
          loadDataDir,
          extensions: { vector, pg_trgm },
        }),
      );
    } catch (err) {
      // v0.13.1: any PGLite.create() failure becomes actionable. v0.41.8.0
      // (#1340): the previous error hint hardcoded the macOS 26.3 link, but
      // the same crash shape can come from Bun's vfs (`/$$bunfs/root` is
      // read-only on older macOS + Bun 1.3.x, so PGLite can't extract its
      // pglite.data WASM payload). Route the hint by failure shape so
      // users get the right next step.
      const original = err instanceof Error ? err.message : String(err);
      const verdict = classifyPgliteInitError(original);
      const wrapped = new Error(buildPgliteInitErrorMessage(verdict, original));
      // Release the lock so a fresh process can try again; leaking the lock
      // here turns a recoverable init error into a stuck-brain state.
      if (this._lock?.acquired) {
        try { await releaseLock(this._lock); } catch { /* ignore cleanup error */ }
        this._lock = null;
      }
      throw wrapped;
    }
  }

  async disconnect(): Promise<void> {
    // v0.41.8.0: snapshot + early-null up front so a concurrent
    // `connect()` cannot observe `_db` pointing at a handle that's
    // mid-close (partial-state race). Closes the bug class PR #1337
    // originally surfaced.
    //
    // try/finally guarantees the file lock releases even if
    // `db.close()` throws. Pre-fix, a close-throw would leak the
    // lock and the next gbrain invocation would wedge waiting for it.
    // The pre-fix code happened to work because the close branch
    // ran first and the lock branch ran second only when close
    // didn't throw — moving to the snapshot pattern made the
    // try/finally explicitly necessary.
    const db = this._db;
    this._db = null;
    const lock = this._lock;
    this._lock = null;
    try {
      if (db) {
        // Deliberately NOT wrapped in preservingProcessExitCode: close's
        // status write (0) is long-standing baseline behavior that test-runner
        // processes depend on (wrapping it flipped bun test's own exit code —
        // #2084 implementation note), and the CLI's exit verdict doesn't read
        // process.exitCode at all — it lives in the gbrain-owned channel
        // (setCliExitVerdict/currentExitCode in cli-force-exit.ts).
        await db.close();
      }
    } finally {
      if (lock?.acquired) {
        await releaseLock(lock);
      }
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
    // applied. Nothing to do. Returns immediately.
    if (this._snapshotLoaded) {
      return;
    }
    // Pre-schema bootstrap: add forward-referenced state the embedded schema
    // blob requires but that older brains don't have yet (issues #366/#375/
    // #378/#396 + #266/#357). Bootstrap is idempotent and a no-op on fresh
    // installs and modern brains.
    await this.applyForwardReferenceBootstrap();

    // Resolve embedding dim/model from gateway. v0.37 fix wave: fallbacks
    // track the canonical defaults in `ai/defaults.ts` (zeroentropyai:zembed-1
    // / 1280d) instead of the stale v0.13 OpenAI literals, AND we store the
    // full `provider:model` string in the DB config table — consumers like
    // ze-switch, doctor, and recommendation-context expect the provider
    // prefix. (Round-1 CDX-4 + A.8.)
    let dims: number = DEFAULT_EMBEDDING_DIMENSIONS;
    let model: string = DEFAULT_EMBEDDING_MODEL;
    try {
      const gw = await import('./ai/gateway.ts');
      dims = gw.getEmbeddingDimensions();
      model = gw.getEmbeddingModel() || model;
    } catch { /* gateway not configured — use defaults */ }

    await this.db.exec(getPGLiteSchema(dims, model));

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      process.stderr.write(`  ${applied} migration(s) applied\n`);
    }
  }

  /**
   * Bootstrap state that PGLITE_SCHEMA_SQL forward-references but that older
   * brains don't have yet. Currently covers:
   *
   *   - `sources` table + default seed (FK target of pages.source_id) — v0.18
   *   - `pages.source_id` column (indexed by `idx_pages_source_id`) — v0.18
   *   - `links.link_source` column (indexed by `idx_links_source`) — v0.13
   *   - `links.origin_page_id` column (indexed by `idx_links_origin`) — v0.13
   *   - `content_chunks.symbol_name` column (indexed by `idx_chunks_symbol_name`) — v0.19
   *   - `content_chunks.language` column (indexed by `idx_chunks_language`) — v0.19
   *   - `content_chunks.search_vector` + `parent_symbol_path` + `doc_comment`
   *     + `symbol_name_qualified` columns (indexed by `idx_chunks_search_vector`
   *     and `idx_chunks_symbol_qualified`) — v0.20 Cathedral II
   *   - `pages.deleted_at` column (indexed by `pages_deleted_at_purge_idx`) — v0.26.5
   *   - `mcp_request_log.agent_name` + `params` + `error_message` columns
   *     (indexed by `idx_mcp_log_agent_time`) — v0.26.3
   *   - `subagent_messages.provider_id` column (indexed by
   *     `idx_subagent_messages_provider`) — v0.27
   *
   * **Maintenance contract:** when a future migration adds a column-with-index
   * or new-table-with-FK referenced by PGLITE_SCHEMA_SQL, extend this method
   * AND `test/schema-bootstrap-coverage.test.ts`'s `REQUIRED_BOOTSTRAP_COVERAGE`.
   * The coverage test fails loudly if the bootstrap drifts behind the schema.
   */
  private async applyForwardReferenceBootstrap(): Promise<void> {
    // Single round-trip probe for every forward-reference target.
    const { rows } = await this.db.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='pages') AS pages_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='source_id') AS source_id_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='deleted_at') AS deleted_at_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='links') AS links_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='links' AND column_name='link_source') AS link_source_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='links' AND column_name='origin_page_id') AS origin_page_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='content_chunks') AS chunks_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='symbol_name') AS symbol_name_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='language') AS language_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='search_vector') AS search_vector_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='embedding_image') AS embedding_image_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='effective_date') AS effective_date_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='mcp_request_log') AS mcp_log_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='mcp_request_log' AND column_name='agent_name') AS agent_name_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='subagent_messages') AS subagent_messages_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='subagent_messages' AND column_name='provider_id') AS subagent_provider_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='ingest_log') AS ingest_log_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='ingest_log' AND column_name='source_id') AS ingest_log_source_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='files') AS files_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='files' AND column_name='source_id') AS files_source_id_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='files' AND column_name='page_id') AS files_page_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='oauth_clients') AS oauth_clients_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='oauth_clients' AND column_name='source_id') AS oauth_clients_source_id_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='oauth_clients' AND column_name='federated_read') AS oauth_clients_federated_read_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='sources') AS sources_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sources' AND column_name='archived') AS sources_archived_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sources' AND column_name='archived_at') AS sources_archived_at_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sources' AND column_name='archive_expires_at') AS sources_archive_expires_at_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='last_retrieved_at') AS pages_last_retrieved_at_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='ingested_via') AS pages_ingested_via_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='ingested_at') AS pages_ingested_at_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='source_uri') AS pages_source_uri_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='source_kind') AS pages_source_kind_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='contextual_retrieval_mode') AS pages_cr_mode_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='corpus_generation') AS pages_corpus_generation_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sources' AND column_name='contextual_retrieval_mode') AS sources_cr_mode_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='sources' AND column_name='trust_frontmatter_overrides') AS sources_trust_fm_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='generation') AS pages_generation_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='embedding_signature') AS pages_embedding_signature_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='links_extracted_at') AS pages_links_extracted_at_exists
    `);
    const probe = rows[0] as {
      pages_exists: boolean;
      source_id_exists: boolean;
      deleted_at_exists: boolean;
      links_exists: boolean;
      link_source_exists: boolean;
      origin_page_id_exists: boolean;
      chunks_exists: boolean;
      symbol_name_exists: boolean;
      language_exists: boolean;
      search_vector_exists: boolean;
      embedding_image_exists: boolean;
      effective_date_exists: boolean;
      mcp_log_exists: boolean;
      agent_name_exists: boolean;
      subagent_messages_exists: boolean;
      subagent_provider_id_exists: boolean;
      ingest_log_exists: boolean;
      ingest_log_source_id_exists: boolean;
      files_exists: boolean;
      files_source_id_exists: boolean;
      files_page_id_exists: boolean;
      oauth_clients_exists: boolean;
      oauth_clients_source_id_exists: boolean;
      oauth_clients_federated_read_exists: boolean;
      sources_exists: boolean;
      sources_archived_exists: boolean;
      sources_archived_at_exists: boolean;
      sources_archive_expires_at_exists: boolean;
      pages_last_retrieved_at_exists: boolean;
      pages_ingested_via_exists: boolean;
      pages_ingested_at_exists: boolean;
      pages_source_uri_exists: boolean;
      pages_source_kind_exists: boolean;
      pages_cr_mode_exists: boolean;
      pages_corpus_generation_exists: boolean;
      sources_cr_mode_exists: boolean;
      sources_trust_fm_exists: boolean;
      pages_generation_exists: boolean;
      pages_embedding_signature_exists: boolean;
      pages_links_extracted_at_exists: boolean;
    };

    const needsPagesBootstrap = probe.pages_exists && !probe.source_id_exists;
    const needsLinksBootstrap = probe.links_exists
      && (!probe.link_source_exists || !probe.origin_page_id_exists);
    const needsChunksBootstrap = probe.chunks_exists
      && (!probe.symbol_name_exists || !probe.language_exists || !probe.search_vector_exists);
    const needsPagesDeletedAt = probe.pages_exists && !probe.deleted_at_exists;
    // v0.27.1 — partial HNSW idx_chunks_embedding_image references this column.
    const needsChunksEmbeddingImage = probe.chunks_exists && !probe.embedding_image_exists;
    // v0.26.3 (v33): idx_mcp_log_agent_time in PGLITE_SCHEMA_SQL needs agent_name col.
    const needsMcpLogBootstrap = probe.mcp_log_exists && !probe.agent_name_exists;
    // v0.27 (v36): idx_subagent_messages_provider in PGLITE_SCHEMA_SQL needs
    // provider_id (the SECOND column in the composite index `(job_id, provider_id)`).
    const needsSubagentProviderId = probe.subagent_messages_exists && !probe.subagent_provider_id_exists;
    // v0.29.1 (v40 + v41): pages_coalesce_date_idx expression index in
    // PGLITE_SCHEMA_SQL references effective_date. Use effective_date_exists
    // as the proxy for the five v40 + v41 pages columns.
    const needsPagesRecency = probe.pages_exists && !probe.effective_date_exists;
    // v0.31.2 (v50): idx_ingest_log_source_type_created in PGLITE_SCHEMA_SQL
    // references source_id. Old brains have ingest_log without source_id;
    // bootstrap adds the column before SCHEMA_SQL replay creates the index.
    const needsIngestLogSourceId = probe.ingest_log_exists && !probe.ingest_log_source_id_exists;
    // v0.18 (v18): files.source_id + files.page_id added; idx_files_source_id
    // and idx_files_page_id in PGLITE_SCHEMA_SQL crash without them.
    const needsFilesBootstrap = probe.files_exists
      && (!probe.files_source_id_exists || !probe.files_page_id_exists);
    // v0.34.1 (v60+v61+v65): oauth_clients.source_id + federated_read added;
    // FK to sources(id) + GIN index idx_oauth_clients_federated_read in
    // PGLITE_SCHEMA_SQL crash without them.
    const needsOauthClientsBootstrap = probe.oauth_clients_exists
      && (!probe.oauth_clients_source_id_exists || !probe.oauth_clients_federated_read_exists);
    // v0.26.5 (v34): sources.archived + archived_at + archive_expires_at added
    // for soft-delete lifecycle. Not directly referenced by indexes BUT
    // PGLITE_SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS sources` is a no-op on
    // pre-existing sources tables (won't add columns), so visibility filters
    // referencing these columns trip on old brains. The bootstrap closes the
    // gap before any visibility-filter SQL runs.
    const needsSourcesArchive = probe.sources_exists
      && (!probe.sources_archived_exists
          || !probe.sources_archived_at_exists
          || !probe.sources_archive_expires_at_exists);
    // v0.37.0 (v79): pages_last_retrieved_at_idx in PGLITE_SCHEMA_SQL
    // references last_retrieved_at. Pre-v79 brains crash without the column.
    const needsPagesLastRetrievedAt = probe.pages_exists && !probe.pages_last_retrieved_at_exists;
    // v0.38.0 (v80): provenance columns on pages. Not referenced by any
    // SCHEMA_SQL index or FK today, but added defense-in-depth so future
    // schema work that references them doesn't wedge pre-v80 brains.
    const needsPagesProvenance = probe.pages_exists
      && (!probe.pages_ingested_via_exists
          || !probe.pages_ingested_at_exists
          || !probe.pages_source_uri_exists
          || !probe.pages_source_kind_exists);
    // v0.40.3.0 (v90, renumbered from v0.40.3.0 v81 on master merge):
    // contextual retrieval columns on pages + sources. No SCHEMA_SQL index
    // references them today, but bootstrap probes are defense-in-depth so
    // future schema work doesn't wedge pre-v90 brains.
    const needsContextualRetrievalColumns = (probe.pages_exists
        && (!probe.pages_cr_mode_exists || !probe.pages_corpus_generation_exists))
      || (probe.sources_exists
          && (!probe.sources_cr_mode_exists || !probe.sources_trust_fm_exists));
    // v0.40.3.0 (v91): pages.generation BIGINT bumped by
    // bump_page_generation_trg. Forward-referenced by pages_generation_idx
    // in PGLITE_SCHEMA_SQL. The trigger itself is created in the schema
    // body; bootstrap only needs to add the column on pre-v91 brains so
    // the CREATE INDEX doesn't crash.
    const needsPagesGeneration = probe.pages_exists && !probe.pages_generation_exists;
    // v0.41.31 (v108): pages.embedding_signature for real stale semantics.
    // No SCHEMA_SQL index references it today; bootstrap is defense-in-depth
    // so future schema work doesn't wedge pre-v108 brains.
    const needsPagesEmbeddingSignature = probe.pages_exists && !probe.pages_embedding_signature_exists;
    // v0.42.7 (v112): pages.links_extracted_at link-extraction freshness
    // watermark. pages_links_extracted_at_idx in PGLITE_SCHEMA_SQL references
    // it; pre-v112 brains crash without the column, so bootstrap adds it before
    // the CREATE INDEX runs. v112 runs later via runMigrations and is idempotent.
    const needsPagesLinksExtractedAt = probe.pages_exists && !probe.pages_links_extracted_at_exists;

    // Fresh installs (no tables yet) and modern brains both no-op.
    if (!needsPagesBootstrap && !needsLinksBootstrap && !needsChunksBootstrap
        && !needsPagesDeletedAt && !needsChunksEmbeddingImage
        && !needsMcpLogBootstrap && !needsSubagentProviderId
        && !needsPagesRecency && !needsIngestLogSourceId
        && !needsFilesBootstrap && !needsOauthClientsBootstrap
        && !needsSourcesArchive && !needsPagesLastRetrievedAt
        && !needsPagesProvenance
        && !needsContextualRetrievalColumns && !needsPagesGeneration
        && !needsPagesEmbeddingSignature
        && !needsPagesLinksExtractedAt) return;

    process.stderr.write('  Pre-v0.21 brain detected, applying forward-reference bootstrap\n');

    if (needsPagesBootstrap) {
      // Mirror schema-embedded.ts shape for `sources` so the subsequent
      // PGLITE_SCHEMA_SQL CREATE TABLE IF NOT EXISTS is a true no-op.
      // Archive columns (v34) are folded in here so a pre-v18 brain doesn't
      // need needsSourcesArchive to also fire — bootstrap creates a complete
      // v34-shape sources in one go. needsSourcesArchive then only fires on
      // the pre-v34 case (sources exists, archive cols don't).
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id                 TEXT PRIMARY KEY,
          name               TEXT NOT NULL UNIQUE,
          local_path         TEXT,
          last_commit        TEXT,
          last_sync_at       TIMESTAMPTZ,
          config             JSONB NOT NULL DEFAULT '{}'::jsonb,
          archived           BOOLEAN NOT NULL DEFAULT FALSE,
          archived_at        TIMESTAMPTZ,
          archive_expires_at TIMESTAMPTZ,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO sources (id, name, config)
          VALUES ('default', 'default', '{"federated": true}'::jsonb)
          ON CONFLICT (id) DO NOTHING;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
      `);
    }

    if (needsLinksBootstrap) {
      // v11 (links_provenance_columns) is responsible for the CHECK constraint
      // and backfill. The bootstrap only adds enough state for SCHEMA_SQL's
      // `CREATE INDEX idx_links_source/origin` not to crash. v11 runs later
      // via runMigrations and is idempotent (`IF NOT EXISTS` everywhere).
      await this.db.exec(`
        ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
        ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
          REFERENCES pages(id) ON DELETE SET NULL;
      `);
    }

    if (needsChunksBootstrap) {
      // v26 (content_chunks_code_metadata) adds symbol_name + language; v27
      // (Cathedral II) adds parent_symbol_path + doc_comment +
      // symbol_name_qualified + search_vector. PGLITE_SCHEMA_SQL has indexes
      // (idx_chunks_search_vector, idx_chunks_symbol_qualified) that need the
      // v27 columns to exist before they run. v26 + v27 run later via
      // runMigrations and are idempotent.
      await this.db.exec(`
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS language TEXT;
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS symbol_name TEXT;
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT[];
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS doc_comment TEXT;
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT;
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
      `);
    }

    if (needsPagesDeletedAt) {
      // v34 (destructive_guard_columns) adds the column + sources columns +
      // partial purge index. Bootstrap only adds enough for PGLITE_SCHEMA_SQL's
      // `CREATE INDEX pages_deleted_at_purge_idx ... WHERE deleted_at IS NOT NULL`
      // not to crash. v34 runs later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      `);
    }

    if (needsChunksEmbeddingImage) {
      // v39 (multimodal_dual_column_v0_27_1) adds modality + embedding_image
      // columns to content_chunks plus the partial HNSW index that references
      // the column. Bootstrap mirrors enough for PGLITE_SCHEMA_SQL's
      // `CREATE INDEX idx_chunks_embedding_image ... WHERE embedding_image IS NOT NULL`
      // not to crash. v39 runs later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text';
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_image vector(1024);
      `);
    }

    if (needsMcpLogBootstrap) {
      // v33 (admin_dashboard_columns_v0_26_3) adds agent_name + params +
      // error_message to mcp_request_log. PGLITE_SCHEMA_SQL's
      // `CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name,...)`
      // crashes without agent_name. v33 runs later via runMigrations and is
      // idempotent (and also handles backfill).
      await this.db.exec(`
        ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT;
        ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS params JSONB;
        ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_message TEXT;
      `);
    }

    if (needsSubagentProviderId) {
      // v36 (subagent_provider_neutral_persistence_v0_27) adds provider_id +
      // schema_version on subagent_messages and subagent_tool_executions.
      // PGLITE_SCHEMA_SQL's `CREATE INDEX idx_subagent_messages_provider ON
      // subagent_messages (job_id, provider_id)` crashes without provider_id
      // (composite-index second column). v36 runs later via runMigrations and
      // is idempotent.
      await this.db.exec(`
        ALTER TABLE subagent_messages ADD COLUMN IF NOT EXISTS provider_id TEXT;
      `);
    }

    if (needsPagesRecency) {
      // v40 (pages_emotional_weight) adds emotional_weight; v41
      // (pages_recency_columns) adds effective_date + effective_date_source +
      // import_filename + salience_touched_at and the
      // `pages_coalesce_date_idx ON pages ((COALESCE(effective_date, updated_at)))`
      // expression index. PGLITE_SCHEMA_SQL's CREATE INDEX for that expression
      // crashes before v41 runs. Bootstrap adds all five additive columns;
      // v40 + v41 run later via runMigrations and are idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight      REAL NOT NULL DEFAULT 0.0;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date        TIMESTAMPTZ;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename       TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at   TIMESTAMPTZ;
      `);
    }

    if (needsIngestLogSourceId) {
      // v50 (ingest_log_source_id) adds source_id + the
      // idx_ingest_log_source_type_created composite index.
      // PGLITE_SCHEMA_SQL's CREATE INDEX (source_id, source_type, created_at)
      // crashes without source_id. Bootstrap adds the column with NOT NULL
      // DEFAULT 'default' so the index can build cleanly.
      await this.db.exec(`
        ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';
      `);
    }

    if (needsFilesBootstrap) {
      // v18 (files_provenance_columns) adds source_id + page_id to files plus
      // idx_files_source_id and idx_files_page_id in PGLITE_SCHEMA_SQL. Pre-v18
      // brains crash on the CREATE INDEX. Bootstrap adds both columns; v18
      // runs later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE files ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS page_id INTEGER
          REFERENCES pages(id) ON DELETE SET NULL;
      `);
    }

    if (needsOauthClientsBootstrap) {
      // v60+v61+v65 (oauth_clients_source_id_fk, oauth_clients_federated_read_column,
      // oauth_clients_federated_read_gin_index) add source_id + federated_read
      // and the GIN index idx_oauth_clients_federated_read. PGLITE_SCHEMA_SQL's
      // FK + index references crash on pre-v60 brains. Bootstrap mirrors the
      // v60+v61 column shape; v60-v65 run later via runMigrations and are
      // idempotent (and handle backfill + RESTRICT-flip).
      await this.db.exec(`
        ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT
          DEFAULT 'default' REFERENCES sources(id) ON DELETE SET NULL;
        ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_read TEXT[]
          NOT NULL DEFAULT '{}';
      `);
    }

    if (needsSourcesArchive) {
      // v34 (destructive_guard_columns) promotes archive lifecycle from JSONB
      // config to real columns on sources. PGLITE_SCHEMA_SQL's
      // `CREATE TABLE IF NOT EXISTS sources` is a no-op against an existing
      // pre-v34 sources table, so the column-add never lands until the v34
      // migration runs. v34's UPDATE statements + downstream visibility filters
      // (search/query/list_pages) need the columns to exist on the table
      // schema. Bootstrap adds the three columns; v34 runs later via
      // runMigrations and is idempotent (and handles JSONB → column backfill).
      await this.db.exec(`
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;
      `);
    }

    if (needsPagesLastRetrievedAt) {
      // v79 (pages_last_retrieved_at): adds the stale-page signal column +
      // full B-tree index. PGLITE_SCHEMA_SQL's CREATE INDEX
      // pages_last_retrieved_at_idx crashes without the column. v79 runs
      // later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
      `);
    }

    if (needsPagesProvenance) {
      // v81 (pages_provenance_columns): four nullable columns added by the
      // v0.38 ingestion cathedral. No SCHEMA_SQL index or FK references
      // them today, but bootstrap probes cover the column-only forward-
      // reference class defense-in-depth so future schema work doesn't
      // wedge pre-v81 brains.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_via TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_uri TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_kind TEXT;
      `);
    }

    if (needsContextualRetrievalColumns) {
      // v0.40.3.0 v90 (contextual_retrieval_columns, renumbered from
      // v0.40.3.0 v81 on master merge). Five additive columns wiring the
      // three-tier wrapper ladder. Defense-in-depth probes; v90 runs later
      // via runMigrations and is idempotent (ADD COLUMN IF NOT EXISTS).
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS corpus_generation TEXT;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT FALSE;
      `);
    }

    if (needsPagesGeneration) {
      // v0.40.3.0 v91 (pages_generation_trigger_and_bookmark): pages.generation
      // BIGINT + query_cache.max_generation_at_store BIGINT + trigger + index.
      // PGLITE_SCHEMA_SQL CREATE INDEX pages_generation_idx ON pages
      // (generation) crashes on pre-v91 brains without this. The trigger
      // and index land via v91 migration run later; bootstrap only adds
      // the column. v91 is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
      `);
    }

    if (needsPagesEmbeddingSignature) {
      // v108 (pages_embedding_signature): embedding provenance for real
      // stale semantics. NULL grandfathered (never stale). v108 runs later
      // via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_signature TEXT;
      `);
    }

    if (needsPagesLinksExtractedAt) {
      // v112 (pages_links_extracted_at): link-extraction freshness watermark.
      // PGLITE_SCHEMA_SQL CREATE INDEX pages_links_extracted_at_idx references
      // it, so bootstrap adds the column before the blob's CREATE INDEX runs.
      // v112 runs later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ;
      `);
    }
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

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    });
  }

  // Pages CRUD
  async getPage(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeDeleted?: boolean }): Promise<Page | null> {
    // v0.26.5: hide soft-deleted by default; opt-in via opts.includeDeleted.
    const includeDeleted = opts?.includeDeleted === true;
    const sourceId = opts?.sourceId;
    const sourceIds = opts?.sourceIds;
    const where: string[] = ['slug = $1'];
    const params: unknown[] = [slug];
    // #1393: federated grant (sourceIds[]) wins over scalar sourceId so the
    // exact-match read honors allowedSources, not just one source.
    if (sourceIds && sourceIds.length > 0) {
      params.push(sourceIds);
      where.push(`source_id = ANY($${params.length}::text[])`);
    } else if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    if (!includeDeleted) {
      where.push('deleted_at IS NULL');
    }
    const { rows } = await this.db.query(
      `SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, deleted_at,
              source_kind, source_uri, ingested_via, ingested_at
       FROM pages WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (rows.length === 0) return null;
    return rowToPage(rows[0] as Record<string, unknown>);
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
    const sql = `SELECT id, slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND (content_hash = $2 OR (frontmatter->>'id' = $3 AND $3 IS NOT NULL))
       ORDER BY id
       LIMIT 1`;
    const { rows } = await this.db.query(sql, [sourceId, opts.hash, fmId]);
    if (rows.length === 0) return null;
    const r = rows[0] as { id: number | string; slug: string };
    return { slug: r.slug, id: Number(r.id) };
  }

  async putPage(slug: string, page: PageInput, opts?: { sourceId?: string }): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};
    const sourceId = opts?.sourceId ?? 'default';

    // v0.18.0 Step 5+: source_id is now in the INSERT column list so multi-
    // source callers land on the intended (source_id, slug) row. Omitting it
    // let the schema DEFAULT 'default' apply, fabricating duplicate slugs that
    // later made bare-slug subqueries return multiple rows.
    // ON CONFLICT target is (source_id, slug); global UNIQUE(slug) dropped in v17.
    const pageKind = page.page_kind || 'markdown';
    // v0.29.1 — additive opt-in columns. COALESCE(EXCLUDED.x, pages.x)
    // preserves existing values when caller omits them (auto-link path,
    // code reindex, etc.). Mirrors postgres-engine.ts.
    const effectiveDate = page.effective_date instanceof Date
      ? page.effective_date.toISOString()
      : (page.effective_date ?? null);
    const effectiveDateSource = page.effective_date_source ?? null;
    const importFilename = page.import_filename ?? null;
    // v0.32.7 CJK wave: chunker_version + source_path columns.
    const chunkerVersion = page.chunker_version ?? null;
    const sourcePath = page.source_path ?? null;
    // v0.39.3.0 provenance write-through (WARN-8 + CV12). Mirrors postgres-engine.ts.
    // Server stamps `ingested_at = now()` ONLY when any provenance field is being
    // written this call. COALESCE-preserve UPDATE keeps the prior first-write
    // timestamp intact so the audit trail survives routine edits.
    const sourceKind = page.source_kind ?? null;
    const sourceUri = page.source_uri ?? null;
    const ingestedVia = page.ingested_via ?? null;
    const ingestedAt = (sourceKind || sourceUri || ingestedVia) ? new Date().toISOString() : null;
    const { rows } = await this.db.query(
      `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at, effective_date, effective_date_source, import_filename, chunker_version, source_path, source_kind, source_uri, ingested_via, ingested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now(), $10::timestamptz, $11, $12, COALESCE($13, 1), $14, $15, $16, $17, $18::timestamptz)
       ON CONFLICT (source_id, slug) DO UPDATE SET
         type = EXCLUDED.type,
         page_kind = EXCLUDED.page_kind,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         timeline = EXCLUDED.timeline,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         updated_at = now(),
         effective_date        = COALESCE(EXCLUDED.effective_date,        pages.effective_date),
         effective_date_source = COALESCE(EXCLUDED.effective_date_source, pages.effective_date_source),
         import_filename       = COALESCE(EXCLUDED.import_filename,       pages.import_filename),
         chunker_version       = COALESCE(EXCLUDED.chunker_version,       pages.chunker_version),
         source_path           = COALESCE(EXCLUDED.source_path,           pages.source_path),
         source_kind           = COALESCE(EXCLUDED.source_kind,           pages.source_kind),
         source_uri            = COALESCE(EXCLUDED.source_uri,            pages.source_uri),
         ingested_via          = COALESCE(EXCLUDED.ingested_via,          pages.ingested_via),
         ingested_at           = COALESCE(EXCLUDED.ingested_at,           pages.ingested_at)
       RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, effective_date, effective_date_source, import_filename, source_kind, source_uri, ingested_via, ingested_at`,
      [sourceId, slug, page.type, pageKind, page.title, page.compiled_truth, page.timeline || '', JSON.stringify(frontmatter), hash, effectiveDate, effectiveDateSource, importFilename, chunkerVersion, sourcePath, sourceKind, sourceUri, ingestedVia, ingestedAt]
    );
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async deletePage(slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    await this.db.query(
      'DELETE FROM pages WHERE slug = $1 AND source_id = $2',
      [slug, sourceId]
    );
  }

  /**
   * v0.41.19.0 — batch delete primitive. See BrainEngine.deletePages JSDoc.
   * Parity implementation with PostgresEngine.deletePages. PGLite supports
   * `slug = ANY($1)` array-param binding natively (addLinksBatch already
   * proves this).
   */
  async deletePages(slugs: string[], opts: { sourceId: string }): Promise<string[]> {
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `deletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const { rows } = await this.db.query<{ slug: string }>(
      'DELETE FROM pages WHERE slug = ANY($1::text[]) AND source_id = $2 RETURNING slug',
      [slugs, opts.sourceId],
    );
    return rows.map(r => r.slug);
  }

  /**
   * v0.41.19.0 — batch path → slug resolution. See BrainEngine.resolveSlugsByPaths
   * JSDoc.
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
    const { rows } = await this.db.query<{ slug: string; source_path: string }>(
      'SELECT slug, source_path FROM pages WHERE source_path = ANY($1::text[]) AND source_id = $2',
      [paths, opts.sourceId],
    );
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.source_path, r.slug);
    return m;
  }

  async softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null> {
    // Idempotent-as-null: only flip rows currently active. Source filter is
    // optional; without it the first matching row across sources gets soft-deleted.
    const sourceId = opts?.sourceId;
    const where: string[] = ['slug = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [slug];
    if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    const { rows } = await this.db.query(
      `UPDATE pages SET deleted_at = now() WHERE ${where.join(' AND ')} RETURNING slug`,
      params
    );
    if (rows.length === 0) return null;
    return { slug: (rows[0] as { slug: string }).slug };
  }

  async restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    const sourceId = opts?.sourceId;
    const where: string[] = ['slug = $1', 'deleted_at IS NOT NULL'];
    const params: unknown[] = [slug];
    if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    const { rows } = await this.db.query(
      `UPDATE pages SET deleted_at = NULL WHERE ${where.join(' AND ')} RETURNING slug`,
      params
    );
    return rows.length > 0;
  }

  async purgeDeletedPages(olderThanHours: number): Promise<{ slugs: string[]; count: number }> {
    // Clamp to non-negative integer; cascade through FKs (content_chunks,
    // page_links, chunk_relations) on DELETE.
    const hours = Math.max(0, Math.floor(olderThanHours));
    const { rows } = await this.db.query(
      `DELETE FROM pages
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - ($1 || ' hours')::interval
       RETURNING slug`,
      [hours]
    );
    const slugs = (rows as { slug: string }[]).map((r) => r.slug);
    return { slugs, count: slugs.length };
  }

  async refreshPageBody(
    slug: string,
    sourceId: string,
    compiledTruth: string,
    timeline: string,
    contentHash: string,
  ): Promise<void> {
    // Parity with PostgresEngine.refreshPageBody: narrow UPDATE only.
    // The deleted_at filter prevents a redirect retry from reviving a
    // canonical that was already purged.
    await this.db.query(
      `UPDATE pages
         SET compiled_truth = $1,
             timeline = $2,
             content_hash = $3,
             updated_at = now()
       WHERE source_id = $4
         AND slug = $5
         AND deleted_at IS NULL`,
      [compiledTruth, timeline, contentHash, sourceId, slug],
    );
  }

  async updatePageContextualRetrievalState(
    slug: string,
    sourceId: string,
    mode: string,
    corpusGeneration: string | null,
  ): Promise<void> {
    // Parity with PostgresEngine — narrow stamp of the two CR-state
    // columns. corpus_generation nullable for the 'none' tier path.
    await this.db.query(
      `UPDATE pages
         SET contextual_retrieval_mode = $1,
             corpus_generation = $2,
             updated_at = now()
       WHERE source_id = $3
         AND slug = $4
         AND deleted_at IS NULL`,
      [mode, corpusGeneration, sourceId, slug],
    );
  }

  async migrateFactsToCanonical(
    phantomSlug: string,
    canonicalSlug: string,
    sourceId: string,
  ): Promise<{ migrated: number }> {
    // Parity with PostgresEngine.migrateFactsToCanonical. UPDATE preserves
    // every column except entity_slug + source_markdown_slug. Active rows
    // only (expired_at IS NULL) so we don't disturb the supersession audit
    // trail.
    const { rows } = await this.db.query(
      `UPDATE facts
         SET entity_slug = $1,
             source_markdown_slug = $1
       WHERE source_id = $2
         AND source_markdown_slug = $3
         AND expired_at IS NULL
       RETURNING id`,
      [canonicalSlug, sourceId, phantomSlug],
    );
    return { migrated: rows.length };
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    const where: string[] = [];
    const params: unknown[] = [];
    const tagJoin = filters?.tag ? 'JOIN tags t ON t.page_id = p.id' : '';

    if (filters?.type) {
      params.push(filters.type);
      where.push(`p.type = $${params.length}`);
    }
    if (filters?.tag) {
      params.push(filters.tag);
      where.push(`t.tag = $${params.length}`);
    }
    if (filters?.updated_after) {
      params.push(filters.updated_after);
      where.push(`p.updated_at > $${params.length}::timestamptz`);
    }
    // slugPrefix uses the (source_id, slug) UNIQUE btree for index range scans.
    // Escape LIKE metacharacters so the user prefix is treated as a literal.
    if (filters?.slugPrefix) {
      const escaped = filters.slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      params.push(escaped);
      where.push(`p.slug LIKE $${params.length} ESCAPE '\\'`);
    }
    // v0.31.12 + v0.34.1 (#876, D9): scope to a single source OR an array
    // of sources. Array form wins (federated subsumes scalar).
    if (filters?.sourceIds && filters.sourceIds.length > 0) {
      params.push(filters.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
    } else if (filters?.sourceId) {
      params.push(filters.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }
    // v0.26.5: hide soft-deleted by default; opt in via filters.includeDeleted.
    if (filters?.includeDeleted !== true) {
      where.push('p.deleted_at IS NULL');
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    // v0.29: ORDER BY threading via PAGE_SORT_SQL whitelist (no SQL injection).
    const sortKey = filters?.sort && PAGE_SORT_SQL[filters.sort] ? filters.sort : 'updated_desc';
    const orderBy = PAGE_SORT_SQL[sortKey];

    const { rows } = await this.db.query(
      `SELECT p.* FROM pages p ${tagJoin} ${whereSql}
       ORDER BY ${orderBy} ${limitSql}`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToPage);
  }

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    // v0.31.8 (D12): when opts.sourceId is set, return only that source's
    // slugs (used by reconcileLinks so wikilink resolution doesn't span
    // unrelated sources). Without opts, returns the union across sources
    // (pre-v0.31.8 behavior — preserved for callers that still expect the
    // brain-wide slug index, e.g. extract.ts's link resolver).
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        'SELECT slug FROM pages WHERE source_id = $1',
        [opts.sourceId]
      );
      return new Set((rows as { slug: string }[]).map(r => r.slug));
    }
    const { rows } = await this.db.query('SELECT slug FROM pages');
    return new Set((rows as { slug: string }[]).map(r => r.slug));
  }

  async listAllPageRefs(): Promise<Array<{ slug: string; source_id: string }>> {
    // v0.32.8: see postgres-engine.ts:listAllPageRefs for context. ORDER BY
    // (source_id, slug) for determinism; WHERE deleted_at IS NULL matches
    // default page visibility.
    const { rows } = await this.db.query(
      `SELECT slug, source_id FROM pages
       WHERE deleted_at IS NULL
       ORDER BY source_id, slug`
    );
    return (rows as { slug: string; source_id: string }[]).map(r => ({ slug: r.slug, source_id: r.source_id }));
  }

  async listAllSources(opts?: {
    includeArchived?: boolean;
    localPathOnly?: boolean;
  }): Promise<SourceRow[]> {
    // v0.38: parity with postgres-engine.listAllSources. Defaults match
    // sources-ops.listSources (archived rows filtered out by default).
    // localPathOnly skips pure-DB sources so autopilot fan-out doesn't
    // dispatch jobs that would fall back to the global sync.repo_path.
    const includeArchived = opts?.includeArchived === true;
    const localPathOnly = opts?.localPathOnly === true;
    const { rows } = await this.db.query<{
      id: string;
      name: string | null;
      local_path: string | null;
      last_sync_at: string | null;
      config: unknown;
    }>(
      `SELECT id, name, local_path, last_sync_at, config
         FROM sources
        WHERE ($1::boolean OR archived IS NOT TRUE)
          AND ($2::boolean OR local_path IS NOT NULL)
        ORDER BY (id = 'default') DESC, id`,
      [includeArchived, !localPathOnly],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      local_path: r.local_path,
      last_sync_at: r.last_sync_at ? new Date(r.last_sync_at) : null,
      config: typeof r.config === 'string'
        ? JSON.parse(r.config) as Record<string, unknown>
        : ((r.config as Record<string, unknown> | null) ?? {}),
    }));
  }

  async updateSourceConfig(sourceId: string, patch: Record<string, unknown>): Promise<boolean> {
    // v0.38: parity with postgres-engine.updateSourceConfig. JSONB `||`
    // concat operator (overrides same-key, no deep merge). PGLite passes
    // `JSON.stringify(patch)` as the param; cast to jsonb on the SQL side.
    const result = await this.db.query<{ id: string }>(
      `UPDATE sources
          SET config = COALESCE(config, '{}'::jsonb) || $1::jsonb
        WHERE id = $2
        RETURNING id`,
      [JSON.stringify(patch), sourceId],
    );
    return result.rows.length > 0;
  }

  // v0.37.0 — domain-bank engine methods (D14 + D5 + D10).
  // See postgres-engine.ts:listPrefixSampledPages for the ranking + source-scope rationale.
  // PGLite runs the same SQL (Postgres 17.5 under the hood) with positional `$N` binding.
  async listPrefixSampledPages(opts: DomainBankSampleOpts): Promise<DomainBankRow[]> {
    if (opts.prefixes.length === 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const staleBias = opts.staleBias === true;
    const staleThreshold = opts.staleThresholdDays ?? 90;
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    const { rows } = await this.db.query(
      `WITH prefix_pages AS (
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
           AND substring(p.slug from '^[^/]+/[^/]+') = ANY($1::text[])
           AND (cardinality($2::text[]) = 0 OR NOT (p.slug = ANY($2::text[])))
           AND (
             ($3::text[] IS NOT NULL AND p.source_id = ANY($3::text[]))
             OR ($3::text[] IS NULL AND $4::text IS NOT NULL AND p.source_id = $4)
             OR ($3::text[] IS NULL AND $4::text IS NULL)
           )
         GROUP BY p.id, p.slug, p.source_id, p.title, p.compiled_truth, p.last_retrieved_at
       ),
       ranked AS (
         SELECT
           pp.*,
           (CASE WHEN $5::boolean THEN
             CASE
               WHEN pp.last_retrieved_at IS NULL THEN 2
               WHEN pp.last_retrieved_at < NOW() - ($6::int * INTERVAL '1 day') THEN 1
               ELSE 0
             END
           ELSE 0
           END) AS stale_score,
           ROW_NUMBER() OVER (
             PARTITION BY pp.prefix
             ORDER BY
               (CASE WHEN $5::boolean THEN
                 CASE
                   WHEN pp.last_retrieved_at IS NULL THEN 2
                   WHEN pp.last_retrieved_at < NOW() - ($6::int * INTERVAL '1 day') THEN 1
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
       ORDER BY prefix`,
      [opts.prefixes, exclude, sourceIds, sourceId, staleBias, staleThreshold]
    );
    return (rows as Array<Record<string, unknown>>).map((r): DomainBankRow => ({
      slug: r.slug as string,
      source_id: r.source_id as string,
      prefix: r.prefix as string | null,
      page_id: Number(r.page_id),
      title: r.title as string | null,
      compiled_truth: (r.compiled_truth as string | null) ?? '',
      connection_count: Number(r.connection_count),
      last_retrieved_at: r.last_retrieved_at == null ? null : new Date(r.last_retrieved_at as string),
      representative_chunk_id: r.representative_chunk_id == null ? null : Number(r.representative_chunk_id),
    }));
  }

  async listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    if (opts.n <= 0) return [];
    const exclude = opts.excludeSlugs ?? [];
    const sourceIds = opts.sourceIds ?? null;
    const sourceId = opts.sourceId ?? null;
    if (typeof opts.seed === 'number') {
      const clamped = Math.max(-1, Math.min(1, opts.seed));
      await this.db.query('SELECT setseed($1::float8)', [clamped]);
    }
    const { rows } = await this.db.query(
      `WITH sampled AS (
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
           AND (cardinality($1::text[]) = 0 OR NOT (p.slug = ANY($1::text[])))
           AND (
             ($2::text[] IS NOT NULL AND p.source_id = ANY($2::text[]))
             OR ($2::text[] IS NULL AND $3::text IS NOT NULL AND p.source_id = $3)
             OR ($2::text[] IS NULL AND $3::text IS NULL)
           )
         ORDER BY RANDOM()
         LIMIT $4
       )
       SELECT
         s.*,
         (
           SELECT cc.id FROM content_chunks cc
           WHERE cc.page_id = s.page_id AND cc.embedding IS NOT NULL
           ORDER BY cc.chunk_index ASC
           LIMIT 1
         ) AS representative_chunk_id
       FROM sampled s`,
      [exclude, sourceIds, sourceId, opts.n]
    );
    return (rows as Array<Record<string, unknown>>).map((r): DomainBankRow => ({
      slug: r.slug as string,
      source_id: r.source_id as string,
      prefix: r.prefix as string | null,
      page_id: Number(r.page_id),
      title: r.title as string | null,
      compiled_truth: (r.compiled_truth as string | null) ?? '',
      connection_count: Number(r.connection_count),
      last_retrieved_at: r.last_retrieved_at == null ? null : new Date(r.last_retrieved_at as string),
      representative_chunk_id: r.representative_chunk_id == null ? null : Number(r.representative_chunk_id),
    }));
  }

  async resolveSlugs(partial: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<string[]> {
    // v0.41.13 #1436: source scope. When opts.sourceIds is set
    // (federated_read OAuth tier), filter via `source_id = ANY($N::text[])`.
    // When opts.sourceId is set (scalar single-source tier), filter via
    // `source_id = $N`. When neither is set, preserve the pre-fix unscoped
    // behavior so internal CLI callers (`gbrain query --resolve` etc.)
    // continue to walk every source.
    const sources = opts?.sourceIds ?? null;
    const scalar = opts?.sourceId ?? null;
    const scopeSql = sources
      ? ` AND source_id = ANY($${'__N__'}::text[])`
      : scalar
        ? ` AND source_id = $${'__N__'}`
        : '';

    // Try exact match first
    const exactSql = `SELECT slug FROM pages WHERE slug = $1 AND deleted_at IS NULL${scopeSql.replace('__N__', '2')}`;
    const exactParams: unknown[] = sources ? [partial, sources] : scalar ? [partial, scalar] : [partial];
    const exact = await this.db.query(exactSql, exactParams);
    if (exact.rows.length > 0) return [(exact.rows[0] as { slug: string }).slug];

    // Fuzzy match via pg_trgm
    const fuzzySql = `SELECT slug, similarity(title, $1) AS sim
       FROM pages
       WHERE deleted_at IS NULL AND (title % $1 OR slug ILIKE $2)${scopeSql.replace('__N__', '3')}
       ORDER BY sim DESC
       LIMIT 5`;
    const fuzzyParams: unknown[] = sources
      ? [partial, '%' + partial + '%', sources]
      : scalar
        ? [partial, '%' + partial + '%', scalar]
        : [partial, '%' + partial + '%'];
    const { rows } = await this.db.query(fuzzySql, fuzzyParams);
    return (rows as { slug: string }[]).map(r => r.slug);
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
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Fetch 3x to give dedup headroom, then page-dedup + re-limit.
    const innerLimit = Math.min(limit * 3, MAX_SEARCH_LIMIT * 3);

    // Source-aware ranking (v0.22): see postgres-engine.ts for rationale.
    const boostMap = resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    // v0.26.5: visibility filter (soft-deleted + archived-source).
    const visibilityClause = buildVisibilityClause('p', 's');

    // v0.32.7: CJK query branch. PGLite uses websearch_to_tsquery('english')
    // which can't tokenize CJK; queries return empty. Switch to ILIKE on
    // chunk_text with bigram-frequency-count ranking when the query contains
    // CJK characters. ASCII path stays exactly the same below.
    if (hasCJK(query)) {
      return this._searchKeywordCJK(query, {
        limit, offset, innerLimit, sourceFactorCase,
        hardExcludeClause, visibilityClause, detailFilter, opts,
        dedup: true,
      });
    }

    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    const params: unknown[] = [query, innerLimit, limit, offset];
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
    // v0.29.1 — since/until date filter (Postgres parity, codex pass-1 #10).
    // Reads against COALESCE(effective_date, updated_at) so date filtering
    // matches user intent (a meeting was on its event_date, not when it
    // got reimported). Same param shape as Postgres engine.
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation. Array wins over scalar.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    const { rows } = await this.db.query(
      `WITH ranked AS (
         SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id,
           p.effective_date, p.effective_date_source,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           ts_rank(cc.search_vector, websearch_to_tsquery('english', $1)) * ${sourceFactorCase} AS score,
           CASE WHEN p.updated_at < (
             SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
           ) THEN true ELSE false END AS stale
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.search_vector @@ websearch_to_tsquery('english', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
           -- v0.27.1: hide image rows from default text-keyword search so
           -- OCR text doesn't drown text-page hits. Image-similarity queries
           -- run a separate vector path on embedding_image.
           AND cc.modality = 'text'
         ORDER BY score DESC
         LIMIT $2
       ),
       ${buildBestPerPagePoolCte('ranked')}
       SELECT * FROM best_per_page
       ORDER BY score DESC, page_id ASC, chunk_id ASC
       LIMIT $3 OFFSET $4`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  /**
   * v0.32.7 CJK keyword fallback. PGLite's `websearch_to_tsquery('english')`
   * can't tokenize CJK so the FTS path returns empty for Chinese / Japanese /
   * Korean queries. This routes to an ILIKE substring scan with
   * bigram-frequency-count ranking as a ts_rank substitute.
   *
   * Codex outside-voice C8 corrections in place:
   *   - Two distinct parameter bindings: $qLike (LIKE-escaped, for ILIKE) and
   *     $qRaw (un-escaped, for ranking arithmetic via position/replace).
   *     Escaped chars cannot be reused as ranking substrings.
   *   - Explicit `ESCAPE '\'` on the ILIKE clause.
   *   - Symmetric: no asymmetric whitespace strip (caller's query and
   *     chunk_text are compared as-stored).
   *   - Empty-query guard returns no results without binding SQL.
   *
   * Postgres engine is intentionally untouched (multi-tenant deployments
   * can install pgroonga / zhparser when needed; out of scope here).
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
    const { limit, offset, innerLimit, sourceFactorCase, hardExcludeClause, visibilityClause, detailFilter, opts, dedup } = ctx;
    const qRaw = query;
    if (qRaw.length === 0) return [];
    const qLike = escapeLikePattern(qRaw);

    // $1 = qLike (escaped for ILIKE)
    // $2 = qRaw  (raw for position()/replace() ranking arithmetic)
    // $3 = inner limit (dedup path) OR final limit (chunk-grain path)
    // $4 = final limit (dedup path only) — see callers
    // $5 = offset (dedup path)  /  $4 = offset (chunk-grain path)
    const params: unknown[] = dedup
      ? [qLike, qRaw, innerLimit, limit, offset]
      : [qLike, qRaw, limit, offset];

    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
    // v0.34.1 (#861 — P0 leak seal): source-isolation on the CJK fallback path.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    // Bigram-frequency count: count occurrences of $qRaw in chunk_text via
    // (length(chunk) - length(replace(chunk, q, ''))) / length(q). Acts as
    // a ts_rank substitute. position()-tiebreaker so earlier-in-chunk hits
    // outrank later ones at the same occurrence count.
    const scoreExpr = `
      ((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $2, ''))) / NULLIF(LENGTH($2), 0)::real
        + 1.0 / NULLIF(POSITION($2 IN cc.chunk_text), 0)::real)
      * ${sourceFactorCase}
    `;

    if (dedup) {
      const { rows } = await this.db.query(
        `WITH ranked AS (
           SELECT
             p.slug, p.id as page_id, p.title, p.type, p.source_id,
             p.effective_date, p.effective_date_source,
             cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
             ${scoreExpr} AS score,
             CASE WHEN p.updated_at < (
               SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
             ) THEN true ELSE false END AS stale
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
           JOIN sources s ON s.id = p.source_id
           WHERE cc.chunk_text ILIKE '%' || $1 || '%' ESCAPE '\\' ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
             AND cc.modality = 'text'
           ORDER BY score DESC
           LIMIT $3
         ),
         ${buildBestPerPagePoolCte('ranked')}
         SELECT * FROM best_per_page
         ORDER BY score DESC, page_id ASC, chunk_id ASC
         LIMIT $4 OFFSET $5`,
        params,
      );
      return (rows as Record<string, unknown>[]).map(rowToSearchResult);
    } else {
      const { rows } = await this.db.query(
        `SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id,
           p.effective_date, p.effective_date_source,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           ${scoreExpr} AS score,
           CASE WHEN p.updated_at < (
             SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
           ) THEN true ELSE false END AS stale
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.chunk_text ILIKE '%' || $1 || '%' ESCAPE '\\' ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY score DESC
         LIMIT $3 OFFSET $4`,
        params,
      );
      return (rows as Record<string, unknown>[]).map(rowToSearchResult);
    }
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
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Source-aware ranking applied here too — searchKeywordChunks is the
    // chunk-grain anchor primitive that two-pass retrieval (Layer 7) uses.
    const boostMap = resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    const visibilityClause = buildVisibilityClause('p', 's');

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

    const params: unknown[] = [query, limit, offset];
    let extraFilter = '';
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
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
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

    const { rows } = await this.db.query(
      `SELECT
         p.slug, p.id as page_id, p.title, p.type, p.source_id,
         p.effective_date, p.effective_date_source,
         cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
         ts_rank(cc.search_vector, websearch_to_tsquery('english', $1)) * ${sourceFactorCase} AS score,
         CASE WHEN p.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
         ) THEN true ELSE false END AS stale
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       JOIN sources s ON s.id = p.source_id
       WHERE cc.search_vector @@ websearch_to_tsquery('english', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
       ORDER BY score DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Two-stage CTE (v0.22): pure-distance ORDER BY in inner CTE preserves
    // HNSW; outer SELECT re-ranks by raw_score * source_factor over the
    // narrow candidate pool. innerLimit scales with offset to preserve the
    // pagination contract. See postgres-engine.ts searchVector for rationale.
    const boostMap = resolveBoostMap();
    // Outer SELECT references the aliased CTE column. Aliasing the CTE as `hc`
    // disambiguates the correlated subquery (`te.page_id = hc.page_id`) from
    // the inner column. Without the alias, an unqualified `page_id` in the
    // subquery's WHERE would lexically resolve back to `te.page_id` itself
    // and degrade to `te.page_id = te.page_id` (always true), making every
    // result stale=true. Codex caught this in adversarial review.
    // Built on the bare `slug` output column: applied inside the `scored` CTE
    // whose FROM is the single relation `hnsw_candidates`, so unqualified
    // `slug` resolves cleanly (T1 per-page pool restructure).
    const sourceFactorCaseOnSlug = buildSourceFactorCase('slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    const innerLimit = offset + Math.max(limit * 5, 100);

    const params: unknown[] = [vecStr, innerLimit, limit, offset];
    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }
    // v0.33: multi-type filter for whoknows. Applied inside HNSW candidate
    // CTE so the candidate pool consists only of typed pages — limit budget
    // goes to person/company pages instead of being eaten by other types.
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      extraFilter += ` AND p.type = ANY($${params.length}::text[])`;
    }
    // v0.29.1 since/until parity (codex pass-1 #10). Filter applied INSIDE
    // the inner CTE so HNSW's candidate pool already excludes out-of-range
    // pages — preserves pagination contract.
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
    // v0.34.1 (#861, F2 — P0 leak seal): source-isolation in the INNER CTE
    // so HNSW candidate pool narrows before re-rank. Mirrors postgres-engine
    // placement decision (codex flagged this during plan review).
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    // v0.26.5: visibility filter applied in the inner CTE so HNSW sees the
    // same candidate count it always did. See postgres-engine.ts for rationale.
    const visibilityClause = buildVisibilityClause('p', 's');

    // v0.36 (D11): column routing via resolved descriptor. Engine doesn't
    // read config — caller resolved at hybrid/op boundary. The cast SQL
    // ($1::vector vs $1::halfvec(N)) comes from buildVectorCastFragment.
    //
    // v0.36 Phase 3: 'embedding_multimodal' is the unified column populated
    // by `gbrain reindex --multimodal`. No modality filter — the column
    // itself is the discriminator (only re-embedded rows have non-NULL).
    const resolvedCol = normalizeEngineColumn(opts?.embeddingColumn);
    const { col, castSql } = buildVectorCastFragment(resolvedCol);
    let modalityFilter: string;
    if (resolvedCol.name === 'embedding_image') {
      modalityFilter = `AND cc.modality = 'image'`;
    } else if (resolvedCol.name === 'embedding_multimodal') {
      modalityFilter = '';
    } else {
      modalityFilter = `AND cc.modality = 'text'`;
    }

    const { rows } = await this.db.query(
      `WITH hnsw_candidates AS (
         SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id, p.updated_at,
           p.effective_date, p.effective_date_source,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           1 - (cc.${col} <=> ${castSql}) AS raw_score
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.${col} IS NOT NULL ${modalityFilter} ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY cc.${col} <=> ${castSql}
         LIMIT $2
       ),
       -- score as a select-list expr; inner ORDER BY stays pure-distance so
       -- the HNSW index is usable.
       scored AS (
         SELECT *, raw_score * ${sourceFactorCaseOnSlug} AS score
         FROM hnsw_candidates
       ),
       -- T1 (retrieval-maxpool incident): collapse to the best chunk PER PAGE
       -- over the full candidate set before the user LIMIT. Shared builder with
       -- postgres-engine + the keyword path so they cannot drift.
       ${buildBestPerPagePoolCte('scored')}
       SELECT
         bpp.slug, bpp.page_id, bpp.title, bpp.type, bpp.source_id,
         bpp.effective_date, bpp.effective_date_source,
         bpp.chunk_id, bpp.chunk_index, bpp.chunk_text, bpp.chunk_source,
         bpp.score,
         CASE WHEN bpp.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = bpp.page_id
         ) THEN true ELSE false END AS stale
       FROM best_per_page bpp
       -- v0.41.13: stable tiebreaker. When two chunks share a score (same
       -- source-prefix boost + same cosine distance, the basis-vector + same-
       -- source-prefix case in eval fixtures), older page_id wins. Without
       -- this, planner choice + index presence can flip ordering between
       -- master and feature branches that add unrelated indexes — see the
       -- pages_dedup_idx (v95) regression that motivated this.
       ORDER BY bpp.score DESC, bpp.page_id ASC, bpp.chunk_id ASC
       LIMIT $3
       OFFSET $4`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  async getEmbeddingsByChunkIds(
    ids: number[],
    column: string = 'embedding',
  ): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    // v0.36 (D9): column parameter so hybrid.cosineReScore can rehydrate
    // from the active embedding space (Voyage 1024d, ZE halfvec 2560d,
    // etc.). Identifier-quoted (D12 layer 2) plus strict regex on the
    // column name (D12 layer 1) before interpolation.
    if (!COLUMN_NAME_REGEX.test(column)) {
      throw new EmbeddingColumnNotRegisteredError(column, []);
    }
    const quotedCol = quoteIdentifier(column);
    const { rows } = await this.db.query(
      `SELECT id, ${quotedCol} AS embedding FROM content_chunks WHERE id = ANY($1::int[]) AND ${quotedCol} IS NOT NULL`,
      [ids]
    );
    const result = new Map<number, Float32Array>();
    for (const row of rows as Record<string, unknown>[]) {
      if (row.embedding) {
        const emb = typeof row.embedding === 'string'
          ? new Float32Array(JSON.parse(row.embedding))
          : row.embedding as Float32Array;
        result.set(row.id as number, emb);
      }
    }
    return result;
  }

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
      const { isRetryableConnError } = await import('./retry.ts');
      if (isRetryableConnError(err)) {
        auditLogBatchExhausted(auditSite, batchSize, opts.maxRetries + 1, err);
      }
      throw err;
    }
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string } & BatchOpts): Promise<void> {
    return this.batchRetry(opts?.auditSite ?? 'upsertChunks', opts?.signal, () => this._upsertChunksOnce(slug, chunks, opts), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';

    // Source-scope the page-id lookup so duplicate slugs in different sources
    // do not return multiple rows or target the wrong page.
    const pageResult = await this.db.query(
      'SELECT id FROM pages WHERE slug = $1 AND source_id = $2',
      [slug, sourceId]
    );
    if (pageResult.rows.length === 0) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const pageId = (pageResult.rows[0] as { id: number }).id;

    // Remove chunks that no longer exist
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      // PGLite doesn't auto-serialize arrays, so use ANY with explicit array cast
      await this.db.query(
        `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index != ALL($2::int[])`,
        [pageId, newIndices]
      );
    } else {
      await this.db.query('DELETE FROM content_chunks WHERE page_id = $1', [pageId]);
      return;
    }

    // Batch upsert: build dynamic multi-row INSERT.
    // v0.19.0: includes language/symbol_name/symbol_type/start_line/end_line
    // so code chunks carry their tree-sitter metadata into the DB. Markdown
    // chunks pass NULL for all five. Order must match the column list.
    // v0.20.0 Cathedral II Layer 6: adds parent_symbol_path / doc_comment /
    // symbol_name_qualified so nested-chunk emission (A3) and eventual A1
    // edge resolution can round-trip metadata through upserts.
    // v0.27.1 (Phase 8): added `modality` + `embedding_image` to the column
    // list. Image chunks pass embedding=null + embedding_image=Float32Array
    // (1024-dim Voyage). Text/code chunks pass embedding=Float32Array +
    // embedding_image=null. Default modality='text' when omitted.
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified, modality, embedding_image)';
    const rowParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

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

      // Inline ::vector NULL literals to avoid a per-branch placeholder.
      const embeddingPh = embeddingStr ? `$${paramIdx++}::vector` : 'NULL';
      const embeddedAtPh = embeddingStr ? 'now()' : 'NULL';
      const embeddingImagePh = embeddingImageStr ? `$${paramIdx++}::vector` : 'NULL';

      rowParts.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
        `${embeddingPh}, $${paramIdx++}, $${paramIdx++}, ${embeddedAtPh}, ` +
        `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
        `$${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++}, ` +
        `$${paramIdx++}, ${embeddingImagePh})`,
      );

      // Param push order MUST match placeholder allocation order. Both
      // embedding placeholders (when present) are allocated BEFORE the
      // bulk row placeholders, so their values must be pushed first.
      if (embeddingStr) params.push(embeddingStr);
      if (embeddingImageStr) params.push(embeddingImageStr);
      params.push(
        pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
        chunk.model || DEFAULT_EMBEDDING_MODEL, chunk.token_count || null,
        chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
        chunk.start_line ?? null, chunk.end_line ?? null,
        parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        modality,
      );
    }

    // CONSISTENCY: when chunk_text changes and no new embedding is supplied, BOTH embedding AND
    // embedded_at must reset to NULL so `embed --stale` correctly picks up the row for re-embedding.
    // See postgres-engine.ts upsertChunks for the full rationale — pglite mirrors it for parity.
    //
    // v0.40.3.0 D24 NULL→non-NULL race fix mirrors postgres-engine.ts. Two writers
    // racing on the same chunk previously raced last-write-wins; the fix lets the
    // fresher `embedded_at` win in the text-unchanged branch.
    await this.db.query(
      `INSERT INTO content_chunks ${cols} VALUES ${rowParts.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedding
           WHEN content_chunks.embedding IS NULL THEN EXCLUDED.embedding
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedding
           ELSE content_chunks.embedding
         END,
         model = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count = EXCLUDED.token_count,
         embedded_at = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text AND EXCLUDED.embedding IS NULL THEN NULL
           WHEN content_chunks.embedding IS NULL AND EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedded_at
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_at
           ELSE content_chunks.embedded_at
         END,
         language = EXCLUDED.language,
         symbol_name = EXCLUDED.symbol_name,
         symbol_type = EXCLUDED.symbol_type,
         start_line = EXCLUDED.start_line,
         end_line = EXCLUDED.end_line,
         parent_symbol_path = EXCLUDED.parent_symbol_path,
         doc_comment = EXCLUDED.doc_comment,
         symbol_name_qualified = EXCLUDED.symbol_name_qualified,
         modality = EXCLUDED.modality,
         embedding_image = COALESCE(EXCLUDED.embedding_image, content_chunks.embedding_image)`,
      params
    );
  }

  async getChunks(slug: string, opts?: { sourceId?: string }): Promise<Chunk[]> {
    const sourceId = opts?.sourceId ?? 'default';
    const { rows } = await this.db.query(
      `SELECT cc.* FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1 AND p.source_id = $2
       ORDER BY cc.chunk_index`,
      [slug, sourceId]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r));
  }

  /**
   * Build the stale-chunk WHERE clause + positional params. embed_skip is
   * always excluded. `signature` widens "stale" to include embedding_signature
   * drift (NULL grandfathered → never stale). Shared by countStaleChunks +
   * sumStaleChunkChars so they can't drift.
   */
  private buildStaleChunkWhere(opts?: { sourceId?: string; signature?: string }): { where: string; params: unknown[] } {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (opts?.signature !== undefined) {
      params.push(opts.signature);
      conds.push(`(cc.embedding IS NULL OR (p.embedding_signature IS NOT NULL AND p.embedding_signature <> $${params.length}))`);
    } else {
      conds.push(`cc.embedding IS NULL`);
    }
    conds.push(`NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
    if (opts?.sourceId !== undefined) {
      params.push(opts.sourceId);
      conds.push(`p.source_id = $${params.length}`);
    }
    return { where: conds.join(' AND '), params };
  }

  async countStaleChunks(opts?: { sourceId?: string; signature?: string }): Promise<number> {
    // D7: source-scoped count for `gbrain embed --stale --source X`. Always
    // JOIN pages so embed-skip + signature predicates apply. PGLite is
    // PostgreSQL 17.5 in WASM and supports the full JSONB operator set.
    const { where, params } = this.buildStaleChunkWhere(opts);
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS count
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE ${where}`,
      params,
    );
    const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
    return Number(count);
  }

  async sumStaleChunkChars(opts?: { sourceId?: string; signature?: string }): Promise<number> {
    // Sibling of countStaleChunks: same stale predicate, summing chunk_text
    // length for the sync cost preview. ::bigint guards int4 overflow.
    const { where, params } = this.buildStaleChunkWhere(opts);
    const { rows } = await this.db.query(
      `SELECT COALESCE(SUM(LENGTH(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE ${where}`,
      params,
    );
    const chars = (rows[0] as { chars: number | string } | undefined)?.chars ?? 0;
    return Number(chars);
  }

  async setPageEmbeddingSignature(slug: string, opts: { sourceId?: string; signature: string }): Promise<void> {
    await this.db.query(
      `UPDATE pages SET embedding_signature = $1 WHERE slug = $2 AND source_id = $3`,
      [opts.signature, slug, opts.sourceId ?? 'default'],
    );
  }

  async invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string }): Promise<number> {
    // NULL out embeddings whose page signature is set AND differs from the
    // current model signature. GRANDFATHER: NULL signature untouched. Feeds
    // the existing NULL-embedding cursor so listStaleChunks stays unchanged.
    const params: unknown[] = [opts.signature];
    let srcClause = '';
    if (opts.sourceId !== undefined) {
      params.push(opts.sourceId);
      srcClause = ` AND p.source_id = $${params.length}`;
    }
    const { rows } = await this.db.query(
      `UPDATE content_chunks cc
          SET embedding = NULL, embedded_at = NULL
         FROM pages p
        WHERE cc.page_id = p.id
          AND cc.embedding IS NOT NULL
          AND p.embedding_signature IS NOT NULL
          AND p.embedding_signature <> $1${srcClause}
        RETURNING cc.page_id`,
      params,
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

    // v0.41.18.0 (A13, codex #9): --priority recent path. See postgres-engine
    // sibling for full rationale. Same composite cursor + ORDER BY.
    if (orderBy === 'updated_desc') {
      const afterUpdated = opts?.afterUpdatedAt ?? null;
      const isFirstPage = afterUpdated === null && afterPid === 0;
      if (opts?.sourceId === undefined) {
        const { rows } = isFirstPage ? await this.db.query(
          `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                  cc.model, cc.token_count, p.source_id, cc.page_id,
                  p.updated_at
             FROM content_chunks cc
             JOIN pages p ON p.id = cc.page_id
            WHERE cc.embedding IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT $1`,
          [limit],
        ) : await this.db.query(
          `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                  cc.model, cc.token_count, p.source_id, cc.page_id,
                  p.updated_at
             FROM content_chunks cc
             JOIN pages p ON p.id = cc.page_id
            WHERE cc.embedding IS NULL
              AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
              AND (
                p.updated_at < $1::timestamptz
                OR (p.updated_at = $1::timestamptz AND p.id > $2)
                OR (p.updated_at = $1::timestamptz AND p.id = $2 AND cc.chunk_index > $3)
              )
            ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
            LIMIT $4`,
          [afterUpdated, afterPid, afterIdx, limit],
        );
        return rows as unknown as StaleChunkRow[];
      }
      const { rows } = isFirstPage ? await this.db.query(
        `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                cc.model, cc.token_count, p.source_id, cc.page_id,
                p.updated_at
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE cc.embedding IS NULL
            AND p.source_id = $1
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT $2`,
        [opts.sourceId, limit],
      ) : await this.db.query(
        `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                cc.model, cc.token_count, p.source_id, cc.page_id,
                p.updated_at
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE cc.embedding IS NULL
            AND p.source_id = $1
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (
              p.updated_at < $2::timestamptz
              OR (p.updated_at = $2::timestamptz AND p.id > $3)
              OR (p.updated_at = $2::timestamptz AND p.id = $3 AND cc.chunk_index > $4)
            )
          ORDER BY p.updated_at DESC NULLS LAST, p.id ASC, cc.chunk_index ASC
          LIMIT $5`,
        [opts.sourceId, afterUpdated, afterPid, afterIdx, limit],
      );
      return rows as unknown as StaleChunkRow[];
    }
    // orderBy === 'page_id' — legacy stable cursor (unchanged below).
    // D7: optional source-scoped cursor scan. PGLite mirrors postgres-engine
    // so the engine-parity E2E catches drift.
    // v0.41 (D4+D8): NOT (frontmatter ? 'embed_skip') filter for soft-blocked
    // pages, matching the postgres-engine sibling.
    if (opts?.sourceId === undefined) {
      const { rows } = await this.db.query(
        `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                cc.model, cc.token_count, p.source_id, cc.page_id
           FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
          WHERE cc.embedding IS NULL
            AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
            AND (cc.page_id, cc.chunk_index) > ($1, $2)
          ORDER BY cc.page_id, cc.chunk_index
          LIMIT $3`,
        [afterPid, afterIdx, limit],
      );
      return rows as unknown as StaleChunkRow[];
    }
    const { rows } = await this.db.query(
      `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
              cc.model, cc.token_count, p.source_id, cc.page_id
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NULL
          AND p.source_id = $1
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          AND (cc.page_id, cc.chunk_index) > ($2, $3)
        ORDER BY cc.page_id, cc.chunk_index
        LIMIT $4`,
      [opts.sourceId, afterPid, afterIdx, limit],
    );
    return rows as unknown as StaleChunkRow[];
  }

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    // Source-qualify the page-id subquery; slugs are only unique per source.
    await this.db.query(
      `DELETE FROM content_chunks
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)`,
      [slug, sourceId]
    );
  }

  // ── v0.42.7 (#1696): link/timeline extraction freshness watermark ──

  /** Shared stale-for-extraction predicate (mirrors PostgresEngine). */
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
    const { rows } = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pages WHERE ${where}`,
      params,
    );
    return rows[0]?.count ?? 0;
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
    const { rows } = await this.db.query(
      // #1768: engine parity — project the same deterministic full-µs UTC string
      // as postgres-engine.ts so extractStaleFromDB stamps the exact updated_at.
      `SELECT id, slug, source_id, type, title, compiled_truth, timeline, frontmatter, updated_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
         FROM pages
         WHERE ${where}${afterClause}
         ORDER BY id
         LIMIT $${limitIdx}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToStalePage);
  }

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<void> {
    if (refs.length === 0) return;
    const slugs = refs.map(r => r.slug);
    const srcs = refs.map(r => r.source_id);
    // Per-ref timestamp (D4 race fix): extract --stale passes each row's read
    // updated_at; sites that omit it fall back to defaultExtractedAt.
    const tss = refs.map(r => r.extractedAt ?? defaultExtractedAt);
    await this.db.query(
      `UPDATE pages p SET links_extracted_at = v.ts::timestamptz
         FROM unnest($1::text[], $2::text[], $3::text[]) AS v(slug, source_id, ts)
         WHERE p.slug = v.slug AND p.source_id = v.source_id`,
      [slugs, srcs, tss],
    );
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
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    const originSrc = opts?.originSourceId ?? 'default';

    // Source-qualified pre-check gives a clean missing-page error before the
    // INSERT SELECT path can silently return zero rows.
    const exists = await this.db.query(
      `SELECT 1 FROM pages WHERE slug = $1 AND source_id = $2
       INTERSECT
       SELECT 1 FROM pages WHERE slug = $3 AND source_id = $4`,
      [from, fromSrc, to, toSrc]
    );
    if (exists.rows.length === 0) {
      throw new Error(`addLink failed: page "${from}" (source=${fromSrc}) or "${to}" (source=${toSrc}) not found`);
    }
    const src = linkSource ?? 'markdown';
    // Mirror addLinksBatch's VALUES + composite JOIN shape. The old cross-
    // product over pages f/t fanned out across sources containing the slugs.
    await this.db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
       SELECT f.id, t.id, v.link_type, v.context, v.link_source, o.id, v.origin_field
       FROM (VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10))
         AS v(from_slug, to_slug, link_type, context, link_source, origin_slug, origin_field, from_source_id, to_source_id, origin_source_id)
       JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
       JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
       LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
         context = EXCLUDED.context,
         origin_field = EXCLUDED.origin_field`,
      [from, to, linkType || '', sanitizeForJsonb(context || ''), src, originSlug ?? null, originField ?? null, fromSrc, toSrc, originSrc]
    );
  }

  async addLinksBatch(links: LinkBatchInput[], opts?: BatchOpts): Promise<number> {
    if (links.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addLinksBatch', opts?.signal, () => this._addLinksBatchOnce(links), links.length);
  }

  private async _addLinksBatchOnce(links: LinkBatchInput[]): Promise<number> {
    if (links.length === 0) return 0;
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). The
    // text[] array-literal path crashed Postgres on free-text context; JSONB
    // encodes arbitrary text safely and dodges the 65535-param cap. Mirrors
    // PostgresEngine exactly (engine parity); binding goes through the audited
    // executeRawJsonb contract with an OBJECT wrapper { rows }. Composite
    // (slug, source_id) JOINs + LEFT JOIN origin behavior are unchanged.
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

  async removeLink(
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<void> {
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    // Each branch source-qualifies page-id subqueries so a delete only targets
    // the intended edge between per-source slug rows.
    if (linkType !== undefined && linkSource !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_type = $5
           AND link_source IS NOT DISTINCT FROM $6`,
        [from, fromSrc, to, toSrc, linkType, linkSource]
      );
    } else if (linkType !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_type = $5`,
        [from, fromSrc, to, toSrc, linkType]
      );
    } else if (linkSource !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_source IS NOT DISTINCT FROM $5`,
        [from, fromSrc, to, toSrc, linkSource]
      );
    } else {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)`,
        [from, fromSrc, to, toSrc]
      );
    }
  }

  async getLinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<Link[]> {
    // #2200: federated grant scopes ALL THREE page endpoints — from, to, AND the
    // origin (the authoring page, surfaced as origin_slug). The origin LEFT JOIN
    // carries the same ANY($) filter so an out-of-grant origin's slug nulls out.
    // Remote MCP clients always land here.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, t.slug as to_slug,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY($2::text[])
         WHERE f.slug = $1 AND f.source_id = ANY($2::text[]) AND t.source_id = ANY($2::text[])`,
        [slug, opts.sourceIds]
      );
      return rows as unknown as Link[];
    }
    // v0.31.8 (D16) + #2200: the federated arm above is the first branch; the two
    // below preserve pre-v0.31.8 semantics. Without opts.sourceId, no source filter
    // (cross-source view for back-link validators and reconcileLinks). With
    // opts.sourceId, scope to that source (D20).
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, t.slug as to_slug,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
         WHERE f.slug = $1 AND f.source_id = $2`,
        [slug, opts.sourceId]
      );
      return rows as unknown as Link[];
    }
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE f.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<Link[]> {
    // #2200: federated grant scopes all three endpoints (mirrors getLinks) — the
    // referrer (from), the queried page (to), AND the origin — so neither a
    // foreign referrer nor a foreign origin slug is disclosed to the caller.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, t.slug as to_slug,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY($2::text[])
         WHERE t.slug = $1 AND t.source_id = ANY($2::text[]) AND f.source_id = ANY($2::text[])`,
        [slug, opts.sourceIds]
      );
      return rows as unknown as Link[];
    }
    // v0.31.8 (D16) + #2200: federated arm above is first; two below mirror getLinks.
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, t.slug as to_slug,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
         WHERE t.slug = $1 AND t.source_id = $2`,
        [slug, opts.sourceId]
      );
      return rows as unknown as Link[];
    }
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE t.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async listLinkSources(
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<{ link_source: string | null; count: number }[]> {
    // v114 (#1941): distinct provenances + counts for `gbrain link-sources`.
    // Scope by the FROM page's source (consistent with getLinks). Federated
    // {sourceIds} takes precedence over scalar {sourceId}; neither = unscoped.
    const params: unknown[] = [];
    let where = '';
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where = `JOIN pages f ON f.id = l.from_page_id WHERE f.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      where = `JOIN pages f ON f.id = l.from_page_id WHERE f.source_id = $${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT l.link_source, COUNT(*)::int AS count
       FROM links l
       ${where}
       GROUP BY l.link_source
       ORDER BY count DESC, l.link_source ASC NULLS LAST`,
      params,
    );
    return rows as unknown as { link_source: string | null; count: number }[];
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
  ): Promise<{ slug: string; similarity: number } | null> {
    // Inline threshold comparison instead of `SET LOCAL pg_trgm.similarity_threshold`.
    // The GUC only scopes to the current transaction and pglite auto-commits each
    // .query() call, so the SET LOCAL would be a no-op. Using similarity() >= $N
    // directly gives predictable behavior. Tie-breaker: sort by slug so re-runs
    // pick the same winner.
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const { rows } = await this.db.query(
      `SELECT slug, similarity(title, $1) AS sim
       FROM pages
       WHERE similarity(title, $1) >= $3
         AND slug LIKE $2
       ORDER BY sim DESC, slug ASC
       LIMIT 1`,
      [name, prefixPattern, minSimilarity]
    );
    if (rows.length === 0) return null;
    const row = rows[0] as { slug: string; sim: number };
    return { slug: row.slug, similarity: row.sim };
  }

  async traverseGraph(
    slug: string,
    depth: number = 5,
    opts?: import('./engine.ts').TraverseGraphOpts,
  ): Promise<GraphNode[]> {
    // v0.34.1 (#861 — P0 leak seal): source-scope filters at seed, step, and
    // aggregation subquery. Mirrors postgres-engine.traverseGraph placement.
    const params: unknown[] = [slug, depth];
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    let seedScope = '';
    let stepScope = '';
    let aggScope = '';
    if (useSourceIds) {
      params.push(opts!.sourceIds);
      const idx = params.length;
      seedScope = `AND p.source_id = ANY($${idx}::text[])`;
      stepScope = `AND p2.source_id = ANY($${idx}::text[])`;
      aggScope = `AND p3.source_id = ANY($${idx}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      const idx = params.length;
      seedScope = `AND p.source_id = $${idx}`;
      stepScope = `AND p2.source_id = $${idx}`;
      aggScope = `AND p3.source_id = $${idx}`;
    }

    // T8 (v0.36+): frontier cap. When set, the recursive term applies a
    // parenthesized LIMIT N ORDER BY (slug, id) for stable selection. Per-
    // ITERATION cap, which maps approximately to per-BFS-LAYER (exact when
    // fanout is bounded; for hub-fanout the cap fires early). Truncation
    // signal computed post-query by counting rows per depth.
    const cap = opts?.frontierCap;
    let recursiveTerm: string;
    if (cap !== undefined && cap > 0) {
      params.push(cap);
      const capIdx = params.length;
      recursiveTerm = `(SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < $2
          AND NOT (p2.id = ANY(g.visited))
          ${stepScope}
        ORDER BY p2.slug ASC, p2.id ASC
        LIMIT $${capIdx})`;
    } else {
      recursiveTerm = `SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < $2
          AND NOT (p2.id = ANY(g.visited))
          ${stepScope}`;
    }

    // Cycle prevention: visited array tracks page IDs already in the path.
    // Prevents exponential blowup on cyclic subgraphs (e.g., A->B->A).
    const { rows } = await this.db.query(
      `WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = $1 ${seedScope}

        UNION ALL

        ${recursiveTerm}
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). Presentation-only dedup;
          -- the links table still preserves every provenance row. See
          -- plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id ${aggScope}),
          '[]'::jsonb
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug`,
      params
    );

    // T8 truncation-detection callback stripped in /review — see
    // postgres-engine.traverseGraph for the parallel comment + TODOS.md.

    return (rows as Record<string, unknown>[]).map(r => ({
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
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeWhere = linkType !== null ? 'AND l.link_type = $3' : '';
    const params: unknown[] = [slug, depth];
    if (linkType !== null) params.push(linkType);

    // v0.34.1 (#861 — P0 leak seal): source-scope filters at seed + step +
    // final SELECT joins (for the 'both' branch's pf + pt). Mirrors
    // postgres-engine.traversePaths placement.
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    let seedScope = '';
    let stepScope = '';
    let pfScope = '';
    let ptScope = '';
    if (useSourceIds) {
      params.push(opts!.sourceIds);
      const idx = params.length;
      seedScope = `AND p.source_id = ANY($${idx}::text[])`;
      stepScope = `AND p2.source_id = ANY($${idx}::text[])`;
      pfScope = `AND pf.source_id = ANY($${idx}::text[])`;
      ptScope = `AND pt.source_id = ANY($${idx}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      const idx = params.length;
      seedScope = `AND p.source_id = $${idx}`;
      stepScope = `AND p2.source_id = $${idx}`;
      pfScope = `AND pf.source_id = $${idx}`;
      ptScope = `AND pt.source_id = $${idx}`;
    }

    let sql: string;
    if (direction === 'out') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1 ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
            ${stepScope}
        )
        SELECT w.slug AS from_slug, p2.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
      `;
    } else if (direction === 'in') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1 ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
            ${stepScope}
        )
        SELECT p2.slug AS from_slug, w.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
      `;
    } else {
      // both: walk in both directions, emit every traversed edge (preserving its
      // natural from->to direction from the links table).
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1 ${seedScope}
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
            ${stepScope}
        )
        SELECT pf.slug AS from_slug, pt.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
          ${pfScope}
          ${ptScope}
        ORDER BY depth, from_slug, to_slug
      `;
    }

    const { rows } = await this.db.query(sql, params);
    // Dedup edges (same from/to/type/depth can appear via multiple visited paths).
    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      const key = `${r.from_slug}|${r.to_slug}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        from_slug: r.from_slug as string,
        to_slug: r.to_slug as string,
        link_type: r.link_type as string,
        context: (r.context as string) || '',
        depth: r.depth as number,
      });
    }
    return result;
  }

  async relationalFanout(
    seeds: string[],
    opts?: import('./types.ts').RelationalFanoutOpts,
  ): Promise<import('./types.ts').RelationalFanoutRow[]> {
    if (!seeds || seeds.length === 0) return [];
    const depth = Math.min(Math.max(1, opts?.depth ?? 2), 3);
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 200);
    const types = opts?.linkTypes && opts.linkTypes.length > 0 ? opts.linkTypes : null;

    // $1=seeds, $2=depth, $3=limit; optional scope/type params appended.
    const params: unknown[] = [seeds, depth, limit];
    const useSourceIds = opts?.sourceIds && opts.sourceIds.length > 0;
    let seedScope = '';
    if (useSourceIds) {
      params.push(opts!.sourceIds);
      seedScope = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      seedScope = `AND p.source_id = $${params.length}`;
    }
    let typeFilter = '';
    if (types) {
      params.push(types);
      typeFilter = `AND l.link_type = ANY($${params.length}::text[])`;
    }
    const mentionsFilter = opts?.includeMentions ? '' : `AND l.link_source IS DISTINCT FROM 'mentions'`;

    const recurStep =
      direction === 'out'
        ? `JOIN links l ON l.from_page_id = w.id JOIN pages p2 ON p2.id = l.to_page_id`
        : direction === 'in'
          ? `JOIN links l ON l.to_page_id = w.id JOIN pages p2 ON p2.id = l.from_page_id`
          : `JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
             JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END`;

    const sql = `
      WITH RECURSIVE walk AS (
        SELECT p.id, p.slug, p.source_id, 0::int AS depth,
               ARRAY[p.id] AS visited, ARRAY[p.slug] AS path,
               p.source_id AS seed_source, NULL::text AS last_link_type
        FROM pages p
        WHERE p.slug = ANY($1::text[]) ${seedScope} AND p.deleted_at IS NULL
        UNION ALL
        SELECT p2.id, p2.slug, p2.source_id, w.depth + 1,
               w.visited || p2.id, w.path || p2.slug,
               w.seed_source, l.link_type
        FROM walk w
        ${recurStep}
        WHERE w.depth < $2
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
             (array_agg(array_to_string(n.path, chr(9))
               ORDER BY n.depth ASC, array_length(n.path, 1) ASC))[1] AS path_str,
             (SELECT cc.id FROM content_chunks cc
               WHERE cc.page_id = n.id ORDER BY cc.chunk_index ASC LIMIT 1) AS canonical_chunk_id
      FROM walk n
      WHERE n.depth > 0
      GROUP BY n.source_id, n.slug, n.id
      ORDER BY hop ASC, edge_count DESC, n.source_id ASC, n.slug ASC
      LIMIT $3
    `;

    const { rows } = await this.db.query(sql, params);
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

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    // Initialize all slugs to 0 so callers get a consistent map.
    for (const s of slugs) result.set(s, 0);

    // v0.41.18.0 D12: filter mentions OUT of backlink-count for search
    // ranking — parity with postgres-engine.ts. See that file's comment
    // for the full rationale. `IS DISTINCT FROM` is NULL-safe so legacy
    // rows with NULL link_source still count toward backlinks.
    // PGLite needs explicit cast for array binding (does not auto-serialize JS arrays).
    const { rows } = await this.db.query(
      `SELECT p.slug AS slug, COUNT(l.id)::int AS cnt
       FROM pages p
       LEFT JOIN links l ON l.to_page_id = p.id
         AND l.link_source IS DISTINCT FROM 'mentions'
       WHERE p.slug = ANY($1::text[])
       GROUP BY p.slug`,
      [slugs]
    );
    for (const r of rows as { slug: string; cnt: number }[]) {
      result.set(r.slug, Number(r.cnt));
    }
    return result;
  }

  async getAdjacencyBoosts(pageIds: number[]): Promise<Map<number, import('./types.ts').AdjacencyRow>> {
    const result = new Map<number, import('./types.ts').AdjacencyRow>();
    if (pageIds.length === 0) return result;

    // PGLite parity with PostgresEngine.getAdjacencyBoosts. SQL contract
    // and source-scope rationale: see BrainEngine.getAdjacencyBoosts JSDoc.
    // Same CTE shape, same COALESCE on source_id for NULL safety, same
    // CASE-WHEN exclusion of target's own source for cross_source_hits.
    //
    // Defense-in-depth (codex outside-voice review): deleted_at IS NULL
    // on both join sides. Matches Postgres-engine parity.
    const { rows } = await this.db.query(
      `WITH targets AS (
         SELECT id, COALESCE(source_id, 'default') AS source_id
         FROM pages
         WHERE id = ANY($1::int[])
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
       WHERE l.from_page_id = ANY($1::int[])
         AND l.to_page_id   = ANY($1::int[])
       GROUP BY l.to_page_id
       HAVING COUNT(DISTINCT l.from_page_id) >= 1`,
      [pageIds]
    );
    for (const r of rows as { to_page_id: number; hits: number; cross_source_hits: number }[]) {
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
    // Parity with PostgresEngine.getContentFlagsByPageIds (issue #1699).
    const { rows } = await this.db.query(
      `SELECT id,
              frontmatter -> 'content_flag' ->> 'reason' AS reason,
              frontmatter -> 'content_flag' ->> 'detail' AS detail
       FROM pages
       WHERE id = ANY($1::int[])
         AND frontmatter ? 'content_flag'`,
      [pageIds]
    );
    for (const r of rows as { id: number; reason: string | null; detail: string | null }[]) {
      if (!r.reason) continue;
      result.set(Number(r.id), { reason: r.reason, detail: r.detail ?? '' });
    }
    return result;
  }

  async getPageTimestamps(slugs: string[]): Promise<Map<string, Date>> {
    if (slugs.length === 0) return new Map();
    const { rows } = await this.db.query(
      `SELECT slug, COALESCE(updated_at, created_at) as ts
       FROM pages WHERE slug = ANY($1::text[])`,
      [slugs]
    );
    return new Map(rows.map((r: any) => [r.slug as string, new Date(r.ts as string)]));
  }

  async getEffectiveDates(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, Date>> {
    if (refs.length === 0) return new Map();
    const slugs = refs.map(r => r.slug);
    const sourceIds = refs.map(r => r.source_id);
    const { rows } = await this.db.query(
      `SELECT p.slug, p.source_id, COALESCE(p.effective_date, p.updated_at, p.created_at) AS ts
         FROM pages p
         JOIN unnest($1::text[], $2::text[]) AS u(slug, source_id)
           ON p.slug = u.slug AND p.source_id = u.source_id`,
      [slugs, sourceIds],
    );
    const out = new Map<string, Date>();
    for (const r of rows as Array<{slug: string; source_id: string; ts: string | Date}>) {
      const key = `${r.source_id}::${r.slug}`;
      out.set(key, r.ts instanceof Date ? r.ts : new Date(r.ts));
    }
    return out;
  }

  async getSalienceScores(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, number>> {
    if (refs.length === 0) return new Map();
    const slugs = refs.map(r => r.slug);
    const sourceIds = refs.map(r => r.source_id);
    const { rows } = await this.db.query(
      `SELECT p.slug, p.source_id,
              (COALESCE(p.emotional_weight, 0) * 5
               + ln(1 + COUNT(DISTINCT t.id))) AS score
         FROM pages p
         JOIN unnest($1::text[], $2::text[]) AS u(slug, source_id)
           ON p.slug = u.slug AND p.source_id = u.source_id
         LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE
        GROUP BY p.id`,
      [slugs, sourceIds],
    );
    const out = new Map<string, number>();
    for (const r of rows as Array<{slug: string; source_id: string; score: number | string}>) {
      const key = `${r.source_id}::${r.slug}`;
      out.set(key, Number(r.score));
    }
    return out;
  }

  async findOrphanPages(opts?: {
    sourceId?: string;
    sourceIds?: string[];
  }): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    // Soft-delete filter on BOTH sides:
    //   - candidate: p.deleted_at IS NULL — soft-deleted pages aren't orphan candidates
    //   - link source: src.deleted_at IS NULL — links FROM soft-deleted pages don't count as inbound
    // Without the link-source filter, a live page can hide from orphan results purely
    // because a soft-deleted page links to it. v0.26.5 invariant; codex C11.
    //
    // v0.41.29.0: scope ONLY the candidate side (`p.source_id`) when opts.sourceId
    // is set. The inbound-link NOT EXISTS deliberately counts links from ANY source:
    // a page in source X linked FROM source Y is reachable, so NOT an orphan of X.
    // Do NOT add `src.source_id = p.source_id` here — that is the stricter
    // intra-source-only definition we deliberately reject.
    let sourceFilter = '';
    const params: unknown[] = [];
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      sourceFilter = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      sourceFilter = `AND p.source_id = $${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT
         p.slug,
         COALESCE(p.title, p.slug) AS title,
         p.frontmatter->>'domain' AS domain
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
       ORDER BY p.slug`,
      params
    );
    return rows as Array<{ slug: string; title: string; domain: string | null }>;
  }

  // Tags
  async addTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    // Pre-check source-scoped page existence; ON CONFLICT only handles the
    // already-tagged case, not missing pages.
    const page = await this.db.query(
      'SELECT id FROM pages WHERE slug = $1 AND source_id = $2',
      [slug, sourceId]
    );
    if (page.rows.length === 0) throw new Error(`addTag failed: page "${slug}" (source=${sourceId}) not found`);
    await this.db.query(
      `INSERT INTO tags (page_id, tag)
       VALUES ($1, $2)
       ON CONFLICT (page_id, tag) DO NOTHING`,
      [(page.rows[0] as { id: number }).id, tag]
    );
  }

  async removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    // Source-qualify the page-id subquery; slugs are only unique per source.
    await this.db.query(
      `DELETE FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
         AND tag = $3`,
      [slug, sourceId, tag]
    );
  }

  async getTags(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<string[]> {
    // #2200: federated grant (sourceIds[]) wins over scalar. `page_id IN (..)`
    // (not `= (..)`) so a slug present in >1 allowed source doesn't blow up;
    // DISTINCT unions tags across the matched pages. Scalar/unscoped keeps the
    // legacy `?? 'default'` default. Source-qualify; slugs are unique per source.
    const scope =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? { sql: 'source_id = ANY($2::text[])', param: opts.sourceIds }
        : { sql: 'source_id = $2', param: opts?.sourceId ?? 'default' };
    const { rows } = await this.db.query(
      `SELECT DISTINCT tag FROM tags
       WHERE page_id IN (SELECT id FROM pages WHERE slug = $1 AND ${scope.sql})
       ORDER BY tag`,
      [slug, scope.param]
    );
    return (rows as { tag: string }[]).map(r => r.tag);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<void> {
    const sourceId = opts?.sourceId ?? 'default';
    if (!opts?.skipExistenceCheck) {
      const { rows } = await this.db.query(
        'SELECT 1 FROM pages WHERE slug = $1 AND source_id = $2',
        [slug, sourceId]
      );
      if (rows.length === 0) {
        throw new Error(`addTimelineEntry failed: page "${slug}" (source=${sourceId}) not found`);
      }
    }
    // ON CONFLICT DO NOTHING via the (page_id, date, summary) unique index.
    // Source-qualify the page-id lookup so multi-source brains don't fan
    // timeline rows out across every source containing the slug.
    // Free-text body fields are NUL + lone-surrogate sanitized (#2011), matching
    // the batch path and the Postgres engine; identity fields (slug, date) raw.
    await this.db.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT id, $2::date, $3, $4, $5
       FROM pages WHERE slug = $1 AND source_id = $6
       ON CONFLICT (page_id, date, summary, source) DO NOTHING`,
      [slug, entry.date, sanitizeForJsonb(entry.source || ''), sanitizeForJsonb(entry.summary), sanitizeForJsonb(entry.detail || ''), sourceId]
    );
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[], opts?: BatchOpts): Promise<number> {
    if (entries.length === 0) return 0;
    return this.batchRetry(opts?.auditSite ?? 'addTimelineEntriesBatch', opts?.signal, () => this._addTimelineEntriesBatchOnce(entries), entries.length);
  }

  private async _addTimelineEntriesBatchOnce(entries: TimelineBatchInput[]): Promise<number> {
    if (entries.length === 0) return 0;
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]); free-text
    // summary/detail/source carry the same array-literal crash hazard. Mirrors
    // PostgresEngine. `date` stays text in the recordset and is cast v.date::date.
    const rows = buildTimelineRows(entries);
    const result = await executeRawJsonb(
      this,
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT p.id, v.date::date, v.source, v.summary, v.detail
       FROM jsonb_to_recordset(($1::jsonb)->'rows')
         AS v(slug text, date text, source text, summary text, detail text, source_id text)
       JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id
       ON CONFLICT (page_id, date, summary, source) DO NOTHING
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    // v0.31.8 (D16) + #2200: build WHERE clause dynamically so the source scope
    // composes cleanly with the after/before filters. Precedence: federated
    // sourceIds[] > scalar sourceId > unscoped (cross-source, pre-v0.31.8).
    // (Postgres builds the equivalent via sql`` fragment composition — different
    // idiom, same result; the engines stay lockstep on behavior, not on builder.)
    const limit = opts?.limit || 100;
    const where: string[] = ['p.slug = $1'];
    const params: unknown[] = [slug];
    if (opts?.after) {
      params.push(opts.after);
      where.push(`te.date >= $${params.length}::date`);
    }
    if (opts?.before) {
      params.push(opts.before);
      where.push(`te.date <= $${params.length}::date`);
    }
    // #2200: federated grant (sourceIds[]) wins over scalar sourceId. The join
    // unions timeline entries across every same-slug page in the grant.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }
    params.push(limit);
    const result = await this.db.query(
      `SELECT te.* FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       WHERE ${where.join(' AND ')}
       ORDER BY te.date DESC LIMIT $${params.length}`,
      params
    );
    return result.rows as unknown as TimelineEntry[];
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
    if (opts?.sourceId) {
      await this.db.query(
        `INSERT INTO raw_data (page_id, source, data)
         SELECT id, $2, $3::jsonb
         FROM pages WHERE slug = $1 AND source_id = $4
         ON CONFLICT (page_id, source) DO UPDATE SET
           data = EXCLUDED.data,
           fetched_at = now()`,
        [slug, source, JSON.stringify(data), opts.sourceId]
      );
      return;
    }
    await this.db.query(
      `INSERT INTO raw_data (page_id, source, data)
       SELECT id, $2, $3::jsonb
       FROM pages WHERE slug = $1
       ON CONFLICT (page_id, source) DO UPDATE SET
         data = EXCLUDED.data,
         fetched_at = now()`,
      [slug, source, JSON.stringify(data)]
    );
  }

  async getRawData(
    slug: string,
    source?: string,
    opts?: { sourceId?: string },
  ): Promise<RawData[]> {
    // v0.31.8 (D21): build WHERE clause dynamically. Without opts.sourceId,
    // no source filter (preserves pre-v0.31.8 cross-source read).
    const where: string[] = ['p.slug = $1'];
    const params: unknown[] = [slug];
    if (source) {
      params.push(source);
      where.push(`rd.source = $${params.length}`);
    }
    if (opts?.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }
    const result = await this.db.query(
      `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
       JOIN pages p ON p.id = rd.page_id
       WHERE ${where.join(' AND ')}`,
      params
    );
    return result.rows as unknown as RawData[];
  }

  // Files (v0.27.1): see PostgresEngine.upsertFile for the same contract.
  async upsertFile(spec: FileSpec): Promise<{ id: number; created: boolean }> {
    const sourceId = spec.source_id ?? 'default';
    const result = await this.db.query<{ id: number; created: boolean }>(
      `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         page_slug = EXCLUDED.page_slug,
         page_id = EXCLUDED.page_id,
         filename = EXCLUDED.filename,
         mime_type = EXCLUDED.mime_type,
         size_bytes = EXCLUDED.size_bytes,
         content_hash = EXCLUDED.content_hash,
         metadata = EXCLUDED.metadata
       RETURNING id, (xmax = 0) AS created`,
      [
        sourceId,
        spec.page_slug ?? null,
        spec.page_id ?? null,
        spec.filename,
        spec.storage_path,
        spec.mime_type ?? null,
        spec.size_bytes ?? null,
        spec.content_hash,
        JSON.stringify(spec.metadata ?? {}),
      ]
    );
    if (result.rows.length === 0) {
      throw new Error(`upsertFile returned no rows for ${spec.storage_path}`);
    }
    return { id: result.rows[0].id, created: !!result.rows[0].created };
  }

  async getFile(sourceId: string, storagePath: string): Promise<FileRow | null> {
    const result = await this.db.query<FileRow>(
      `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
       FROM files
       WHERE source_id = $1 AND storage_path = $2
       LIMIT 1`,
      [sourceId, storagePath]
    );
    return result.rows.length > 0 ? (result.rows[0] as FileRow) : null;
  }

  async listFilesForPage(pageId: number): Promise<FileRow[]> {
    const result = await this.db.query<FileRow>(
      `SELECT id, source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata, created_at
       FROM files
       WHERE page_id = $1
       ORDER BY created_at ASC`,
      [pageId]
    );
    return result.rows as FileRow[];
  }

  // Dream-cycle significance verdict cache (v0.23).
  async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
    const result = await this.db.query<{
      worth_processing: boolean;
      reasons: string[] | null;
      judged_at: Date | string;
    }>(
      `SELECT worth_processing, reasons, judged_at
       FROM dream_verdicts
       WHERE file_path = $1 AND content_hash = $2`,
      [filePath, contentHash]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      worth_processing: r.worth_processing,
      reasons: r.reasons ?? [],
      judged_at: r.judged_at instanceof Date ? r.judged_at.toISOString() : String(r.judged_at),
    };
  }

  async putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void> {
    await this.db.query(
      `INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (file_path, content_hash) DO UPDATE SET
         worth_processing = EXCLUDED.worth_processing,
         reasons = EXCLUDED.reasons,
         judged_at = now()`,
      [filePath, contentHash, verdict.worth_processing, JSON.stringify(verdict.reasons)]
    );
  }

  // ============================================================
  // v0.31: Hot memory — facts table operations
  // ============================================================

  async insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }> {
    const validFrom = input.valid_from ?? new Date();
    const validUntil = input.valid_until ?? null;
    const kind = input.kind ?? 'fact';
    const visibility = input.visibility ?? 'private';
    const notability = input.notability ?? 'medium';
    const confidence = input.confidence ?? 1.0;
    const entitySlug = input.entity_slug ?? null;
    const context = input.context ?? null;
    const sourceSession = input.source_session ?? null;
    const embedding = input.embedding ?? null;
    const embeddedAt = embedding ? new Date() : null;
    const embedStr = embedding ? toPgVectorLiteral(embedding) : null;
    // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
    const claimMetric = input.claim_metric ?? null;
    const claimValue  = input.claim_value  ?? null;
    const claimUnit   = input.claim_unit   ?? null;
    const claimPeriod = input.claim_period ?? null;

    if (ctx.supersedeId !== undefined) {
      // Supersede flow: insert new + expire old in one txn so observers never
      // see both rows active simultaneously.
      const result = await this.db.transaction(async (tx) => {
        const ins = await tx.query<{ id: number }>(
          embedStr === null
            ? `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 claim_metric, claim_value, claim_unit, claim_period
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 NULL, NULL,
                 $13, $14, $15, $16
               ) RETURNING id`
            : `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 claim_metric, claim_value, claim_unit, claim_period
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 $13::vector, $14,
                 $15, $16, $17, $18
               ) RETURNING id`,
          embedStr === null
            ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, claimMetric, claimValue, claimUnit, claimPeriod]
            : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embedStr, embeddedAt, claimMetric, claimValue, claimUnit, claimPeriod],
        );
        const newId = ins.rows[0].id;
        await tx.query(
          `UPDATE facts SET expired_at = now(), superseded_by = $1
           WHERE id = $2 AND expired_at IS NULL`,
          [newId, ctx.supersedeId],
        );
        return newId;
      });
      return { id: result, status: 'superseded' };
    }

    const ins = await this.db.query<{ id: number }>(
      embedStr === null
        ? `INSERT INTO facts (
             source_id, entity_slug, fact, kind, visibility, notability, context,
             valid_from, valid_until, source, source_session, confidence,
             embedding, embedded_at,
             claim_metric, claim_value, claim_unit, claim_period
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             NULL, NULL,
             $13, $14, $15, $16
           ) RETURNING id`
        : `INSERT INTO facts (
             source_id, entity_slug, fact, kind, visibility, notability, context,
             valid_from, valid_until, source, source_session, confidence,
             embedding, embedded_at,
             claim_metric, claim_value, claim_unit, claim_period
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             $13::vector, $14,
             $15, $16, $17, $18
           ) RETURNING id`,
      embedStr === null
        ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, claimMetric, claimValue, claimUnit, claimPeriod]
        : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embedStr, embeddedAt, claimMetric, claimValue, claimUnit, claimPeriod],
    );
    return { id: ins.rows[0].id, status: 'inserted' };
  }

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
    const at = opts?.at ?? new Date();
    const result = await this.db.query(
      `UPDATE facts SET expired_at = $1, superseded_by = COALESCE($2, superseded_by)
       WHERE id = $3 AND expired_at IS NULL`,
      [at, opts?.supersededBy ?? null, id],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  async insertFacts(
    rows: Array<NewFact & { row_num: number; source_markdown_slug: string }>,
    ctx: { source_id: string },
  ): Promise<{ inserted: number; ids: number[] }> {
    if (rows.length === 0) return { inserted: 0, ids: [] };

    // Single transaction so the v51 partial UNIQUE index can roll back the
    // whole batch on constraint violation. Per-row INSERTs (not multi-row
    // VALUES) keep the embedding-vs-no-embedding branching readable; batch
    // sizes are small (5-30 rows per page in practice) so the loop overhead
    // is negligible vs the embedding compute cost.
    const ids = await this.db.transaction(async (tx) => {
      const out: number[] = [];
      for (const input of rows) {
        const validFrom = input.valid_from ?? new Date();
        const validUntil = input.valid_until ?? null;
        const kind = input.kind ?? 'fact';
        const visibility = input.visibility ?? 'private';
        const notability = input.notability ?? 'medium';
        const confidence = input.confidence ?? 1.0;
        const entitySlug = input.entity_slug ?? null;
        const context = input.context ?? null;
        const sourceSession = input.source_session ?? null;
        const embedding = input.embedding ?? null;
        const embeddedAt = embedding ? new Date() : null;
        const embedStr = embedding ? toPgVectorLiteral(embedding) : null;
        // v0.35.4 (D-CDX-5) — typed-claim columns. All four nullable.
        const claimMetric = input.claim_metric ?? null;
        const claimValue  = input.claim_value  ?? null;
        const claimUnit   = input.claim_unit   ?? null;
        const claimPeriod = input.claim_period ?? null;
        // v0.40.2.0 — event_type column (Commit 1 migration v89).
        const eventType   = input.event_type   ?? null;

        // Param-positional dispatch: embedStr presence shifts the trailing
        // slots by one. Order of named slots stays stable across both
        // branches: embedded_at, row_num, source_markdown_slug,
        // claim_metric, claim_value, claim_unit, claim_period, event_type.
        const ins = await tx.query<{ id: number }>(
          embedStr === null
            ? `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 row_num, source_markdown_slug,
                 claim_metric, claim_value, claim_unit, claim_period,
                 event_type
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 NULL, $13,
                 $14, $15,
                 $16, $17, $18, $19,
                 $20
               ) RETURNING id`
            : `INSERT INTO facts (
                 source_id, entity_slug, fact, kind, visibility, notability, context,
                 valid_from, valid_until, source, source_session, confidence,
                 embedding, embedded_at,
                 row_num, source_markdown_slug,
                 claim_metric, claim_value, claim_unit, claim_period,
                 event_type
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 $13::vector, $14,
                 $15, $16,
                 $17, $18, $19, $20,
                 $21
               ) RETURNING id`,
          embedStr === null
            ? [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embeddedAt, input.row_num, input.source_markdown_slug, claimMetric, claimValue, claimUnit, claimPeriod, eventType]
            : [ctx.source_id, entitySlug, input.fact, kind, visibility, notability, context, validFrom, validUntil, input.source, sourceSession, confidence, embedStr, embeddedAt, input.row_num, input.source_markdown_slug, claimMetric, claimValue, claimUnit, claimPeriod, eventType],
        );
        out.push(ins.rows[0].id);
      }
      return out;
    });
    return { inserted: ids.length, ids };
  }

  async deleteFactsForPage(
    slug: string,
    source_id: string,
    opts?: { excludeSourcePrefixes?: string[] },
  ): Promise<{ deleted: number }> {
    const prefixes = opts?.excludeSourcePrefixes;
    if (prefixes && prefixes.length > 0) {
      // #1928: keep rows whose `source` matches an excluded prefix (e.g.
      // `cli:` conversation facts). COALESCE so NULL/empty-source fence rows
      // stay deletable — only the explicitly-protected prefixes survive.
      const patterns = prefixes.map(p => `${p}%`);
      const result = await this.db.query(
        `DELETE FROM facts
           WHERE source_id = $1 AND source_markdown_slug = $2
             AND NOT (COALESCE(source, '') LIKE ANY($3::text[]))`,
        [source_id, slug, patterns],
      );
      return { deleted: result.affectedRows ?? 0 };
    }
    const result = await this.db.query(
      `DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`,
      [source_id, slug],
    );
    return { deleted: result.affectedRows ?? 0 };
  }

  async listFactsByEntity(
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return this._listFacts(source_id, {
      ...opts,
      whereClauses: [`entity_slug = $entitySlug`],
      whereParams: { entitySlug },
      order: 'valid_from DESC, id DESC',
    });
  }

  async listFactsSince(
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string },
  ): Promise<FactRow[]> {
    const where: string[] = [`created_at >= $since`];
    const params: Record<string, unknown> = { since };
    if (opts?.entitySlug) {
      where.push(`entity_slug = $entitySlug`);
      params.entitySlug = opts.entitySlug;
    }
    return this._listFacts(source_id, {
      ...opts,
      whereClauses: where,
      whereParams: params,
      order: 'created_at DESC, id DESC',
    });
  }

  async listFactsBySession(
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]> {
    return this._listFacts(source_id, {
      ...opts,
      whereClauses: [`source_session = $sessionId`],
      whereParams: { sessionId },
      order: 'created_at DESC, id DESC',
    });
  }

  async listSupersessions(
    source_id: string,
    opts?: { since?: Date; limit?: number },
  ): Promise<FactRow[]> {
    const where: string[] = [`expired_at IS NOT NULL`, `superseded_by IS NOT NULL`];
    const params: Record<string, unknown> = {};
    if (opts?.since) {
      where.push(`expired_at >= $since`);
      params.since = opts.since;
    }
    return this._listFacts(source_id, {
      activeOnly: false,
      limit: opts?.limit,
      whereClauses: where,
      whereParams: params,
      order: 'expired_at DESC, id DESC',
    });
  }

  async countUnconsolidatedFacts(source_id: string): Promise<number> {
    const r = await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM facts
       WHERE source_id = $1 AND consolidated_at IS NULL AND expired_at IS NULL`,
      [source_id],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  async findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array },
  ): Promise<FactRow[]> {
    const k = Math.min(Math.max(opts?.k ?? 5, 1), 20);
    if (opts?.embedding) {
      // Embedding-cosine ordered candidates within the entity bucket.
      const vec = toPgVectorLiteral(opts.embedding);
      const result = await this.db.query<FactRowSqlShape>(
        `SELECT * FROM facts
         WHERE source_id = $1
           AND entity_slug = $2
           AND expired_at IS NULL
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector
         LIMIT $4`,
        [source_id, entitySlug, vec, k],
      );
      return result.rows.map(rowToFact);
    }
    // Recency fallback when no embedding.
    const result = await this.db.query<FactRowSqlShape>(
      `SELECT * FROM facts
       WHERE source_id = $1
         AND entity_slug = $2
         AND expired_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [source_id, entitySlug, k],
    );
    return result.rows.map(rowToFact);
  }

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const sinceDate = opts.since ? new Date(opts.since) : null;
    const untilDate = opts.until ? new Date(opts.until) : null;
    const metric = opts.metric ?? null;
    const kind = opts.kind ?? 'all';
    const useArray = Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0;
    const sourceIds = useArray ? opts.sourceIds! : null;
    const sourceId = opts.sourceId ?? 'default';
    const remoteFilter = opts.remote === true;

    // Build SQL dynamically. PGLite uses $N positional params; we
    // assemble the WHERE clauses + params array in tandem to keep them
    // aligned. Final shape is single SELECT, ORDER BY (valid_from, id) ASC.
    const where: string[] = [
      useArray ? `source_id = ANY($1::text[])` : `source_id = $1`,
      `entity_slug = $2`,
      `expired_at IS NULL`,
    ];
    const params: unknown[] = [useArray ? sourceIds : sourceId, opts.entitySlug];
    let p = 3;
    if (remoteFilter) {
      where.push(`visibility = 'world'`);
    }
    if (metric !== null) {
      where.push(`claim_metric = $${p}`);
      params.push(metric);
      p += 1;
    }
    // v0.40.2.0 — kind filter. 'all' (default) no-ops. 'metric' restricts
    // to typed-claim rows; 'event' restricts to event-shaped rows.
    if (kind === 'metric') {
      where.push(`claim_metric IS NOT NULL`);
    } else if (kind === 'event') {
      where.push(`event_type IS NOT NULL`);
    }
    if (sinceDate) {
      where.push(`valid_from >= $${p}`);
      params.push(sinceDate);
      p += 1;
    }
    if (untilDate) {
      where.push(`valid_from <= $${p}`);
      params.push(untilDate);
      p += 1;
    }
    params.push(limit);
    const limitPlaceholder = p;

    const sqlText = `
      SELECT id, valid_from,
             claim_metric, claim_value, claim_unit, claim_period,
             event_type,
             fact, source_session, source_markdown_slug,
             embedding
      FROM facts
      WHERE ${where.join(' AND ')}
      ORDER BY valid_from ASC, id ASC
      LIMIT $${limitPlaceholder}
    `;
    const result = await this.db.query<{
      id: number;
      valid_from: Date | string;
      claim_metric: string | null;
      claim_value: number | null;
      claim_unit: string | null;
      claim_period: string | null;
      event_type: string | null;
      fact: string;
      source_session: string | null;
      source_markdown_slug: string | null;
      embedding: string | number[] | Float32Array | null;
    }>(sqlText, params);

    return result.rows.map(r => {
      // Inline embedding parser — mirrors rowToFact() at line 3911.
      let embedding: Float32Array | null = null;
      if (r.embedding != null) {
        if (r.embedding instanceof Float32Array) embedding = r.embedding;
        else if (Array.isArray(r.embedding)) embedding = new Float32Array(r.embedding);
        else if (typeof r.embedding === 'string') {
          const trimmed = r.embedding.trim();
          const inner = trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed;
          const parts = inner.split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite);
          embedding = parts.length > 0 ? new Float32Array(parts) : null;
        }
      }
      return {
        fact_id: Number(r.id),
        valid_from: r.valid_from instanceof Date ? r.valid_from : new Date(r.valid_from),
        metric: r.claim_metric,
        value: r.claim_value === null ? null : Number(r.claim_value),
        unit: r.claim_unit,
        period: r.claim_period,
        event_type: r.event_type,
        text: r.fact,
        source_session: r.source_session,
        source_markdown_slug: r.source_markdown_slug,
        embedding,
      };
    });
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    await this.db.query(
      `UPDATE facts SET consolidated_at = now(), consolidated_into = $1 WHERE id = $2`,
      [takeId, id],
    );
  }

  async getFactsHealth(source_id: string): Promise<FactsHealth> {
    const total = await this.db.query<{
      total_active: number; total_today: number; total_week: number;
      total_expired: number; total_consolidated: number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE expired_at IS NULL)                                    AS total_active,
         COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '24 hours') AS total_today,
         COUNT(*) FILTER (WHERE expired_at IS NULL AND created_at > now() - interval '7 days')   AS total_week,
         COUNT(*) FILTER (WHERE expired_at IS NOT NULL)                                AS total_expired,
         COUNT(*) FILTER (WHERE consolidated_at IS NOT NULL)                           AS total_consolidated
       FROM facts WHERE source_id = $1`,
      [source_id],
    );
    const top = await this.db.query<{ entity_slug: string; count: number }>(
      `SELECT entity_slug, COUNT(*)::int AS count
       FROM facts
       WHERE source_id = $1 AND expired_at IS NULL AND entity_slug IS NOT NULL
       GROUP BY entity_slug
       ORDER BY count DESC, entity_slug ASC
       LIMIT 5`,
      [source_id],
    );
    const r = total.rows[0] ?? {
      total_active: 0, total_today: 0, total_week: 0, total_expired: 0, total_consolidated: 0,
    };
    return {
      source_id,
      total_active: Number(r.total_active),
      total_today: Number(r.total_today),
      total_week: Number(r.total_week),
      total_expired: Number(r.total_expired),
      total_consolidated: Number(r.total_consolidated),
      top_entities: top.rows.map(t => ({ entity_slug: t.entity_slug, count: Number(t.count) })),
    };
  }

  /**
   * Internal helper: shared list-facts query builder.
   * Supports source_id always, plus arbitrary additional WHERE clauses.
   */
  private async _listFacts(
    source_id: string,
    opts: FactListOpts & {
      whereClauses?: string[];
      whereParams?: Record<string, unknown>;
      order: string;
    },
  ): Promise<FactRow[]> {
    const limit = clampSearchLimit(opts.limit, 50, MAX_SEARCH_LIMIT);
    const offset = Math.max(0, opts.offset ?? 0);
    const whereParts: string[] = [`source_id = $source_id`];
    const params: Record<string, unknown> = { source_id };
    if (opts.activeOnly !== false) {
      whereParts.push(`expired_at IS NULL`);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      whereParts.push(`kind = ANY($kinds)`);
      params.kinds = opts.kinds;
    }
    if (opts.visibility && opts.visibility.length > 0) {
      whereParts.push(`visibility = ANY($visibility)`);
      params.visibility = opts.visibility;
    }
    for (const c of opts.whereClauses ?? []) whereParts.push(c);
    Object.assign(params, opts.whereParams ?? {});

    // Convert $name placeholders to numbered $1, $2, ... for PGLite.
    const orderedKeys = Object.keys(params);
    const indexFor = (name: string): number => orderedKeys.indexOf(name) + 1;
    const sql = `SELECT * FROM facts
       WHERE ${whereParts.join(' AND ').replace(/\$(\w+)/g, (_m, k) => `$${indexFor(k)}`)}
       ORDER BY ${opts.order}
       LIMIT ${limit} OFFSET ${offset}`;
    const result = await this.db.query<FactRowSqlShape>(sql, orderedKeys.map(k => params[k]));
    return result.rows.map(rowToFact);
  }

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence
  // ============================================================

  async addTakesBatch(rowsIn: TakeBatchInput[], opts?: BatchOpts): Promise<number> {
    if (rowsIn.length === 0) return 0;
    // v0.42.26: wrap in batchRetry to match links/timeline (takes was the only
    // batch primitive without retry resilience).
    return this.batchRetry(opts?.auditSite ?? 'addTakesBatch', opts?.signal, () => this._addTakesBatchOnce(rowsIn), rowsIn.length);
  }

  private async _addTakesBatchOnce(rowsIn: TakeBatchInput[]): Promise<number> {
    // #1861: JSONB jsonb_to_recordset instead of unnest(${arr}::text[]). Mirrors
    // PostgresEngine: `claim` is free LLM prose (array-literal crash hazard);
    // native recordset types + JSON-native numbers/booleans retire the per-engine
    // element-type casts. Weight clamp/round + NUL strip live in buildTakeRows.
    // ON CONFLICT DO UPDATE — intra-batch dup (page_id, row_num) errors, same as
    // the pre-#1861 unnest path.
    const { rows, weightClamped } = buildTakeRows(rowsIn);
    if (weightClamped > 0) {
      process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: ${weightClamped} row(s) had weight outside [0,1]; clamped\n`);
    }
    const result = await executeRawJsonb(
      this,
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, until_date, source, superseded_by, active)
       SELECT v.page_id, v.row_num, v.claim, v.kind, v.holder, v.weight,
              v.since_date, v.until_date, v.source, v.superseded_by, v.active
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(
         page_id int, row_num int, claim text, kind text, holder text, weight real,
         since_date text, until_date text, source text, superseded_by int, active boolean
       )
       ON CONFLICT (page_id, row_num) DO UPDATE SET
         claim         = EXCLUDED.claim,
         kind          = EXCLUDED.kind,
         holder        = EXCLUDED.holder,
         weight        = EXCLUDED.weight,
         since_date    = EXCLUDED.since_date,
         until_date    = EXCLUDED.until_date,
         source        = EXCLUDED.source,
         superseded_by = EXCLUDED.superseded_by,
         active        = EXCLUDED.active,
         updated_at    = now()
       RETURNING 1`,
      [],
      [{ rows }],
    );
    return result.length;
  }

  /** v0.32.6 P1 — batched per-page active-takes fetch for the contradiction probe. */
  async listActiveTakesForPages(
    pageIds: number[],
    opts: { takesHoldersAllowList?: string[] } = {},
  ): Promise<Map<number, Take[]>> {
    const out = new Map<number, Take[]>();
    for (const pid of pageIds) out.set(pid, []);
    if (pageIds.length === 0) return out;
    const { rows } = await this.db.query(
      `SELECT t.*, p.slug AS page_slug
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.page_id = ANY($1::int[])
         AND t.active = true
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
       ORDER BY t.page_id, t.row_num`,
      [pageIds, opts.takesHoldersAllowList ?? null]
    );
    for (const r of rows) {
      const take = takeRowToTake(r as Record<string, unknown>);
      const bucket = out.get(take.page_id);
      if (bucket) bucket.push(take);
    }
    return out;
  }

  /** v0.32.6 M5 — persist a probe run row. Idempotent on run_id. */
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
    const result = await this.db.query(
      `INSERT INTO eval_contradictions_runs (
         run_id, judge_model, prompt_version,
         queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
         wilson_ci_lower, wilson_ci_upper, judge_errors_total,
         cost_usd_total, duration_ms,
         source_tier_breakdown, report_json
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8, $9,
         $10, $11,
         $12::jsonb, $13::jsonb
       )
       ON CONFLICT (run_id) DO NOTHING`,
      [
        row.run_id, row.judge_model, row.prompt_version,
        row.queries_evaluated, row.queries_with_contradiction, row.total_contradictions_flagged,
        row.wilson_ci_lower, row.wilson_ci_upper, row.judge_errors_total,
        row.cost_usd_total, row.duration_ms,
        row.source_tier_breakdown, row.report_json,
      ]
    );
    return (result.affectedRows ?? 0) > 0;
  }

  /** v0.32.6 M5 — read probe runs from the last N days. */
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
    const cutoff = new Date(Date.now() - Math.max(0, days) * 86400000);
    const { rows } = await this.db.query(
      `SELECT run_id, ran_at, judge_model,
              queries_evaluated, queries_with_contradiction, total_contradictions_flagged,
              wilson_ci_lower, wilson_ci_upper, judge_errors_total,
              cost_usd_total, duration_ms,
              source_tier_breakdown, report_json
       FROM eval_contradictions_runs
       WHERE ran_at >= $1
       ORDER BY ran_at DESC`,
      [cutoff]
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      run_id: r.run_id as string,
      ran_at: r.ran_at instanceof Date ? (r.ran_at as Date).toISOString() : String(r.ran_at),
      judge_model: r.judge_model as string,
      queries_evaluated: Number(r.queries_evaluated),
      queries_with_contradiction: Number(r.queries_with_contradiction),
      total_contradictions_flagged: Number(r.total_contradictions_flagged),
      wilson_ci_lower: Number(r.wilson_ci_lower),
      wilson_ci_upper: Number(r.wilson_ci_upper),
      judge_errors_total: Number(r.judge_errors_total),
      cost_usd_total: Number(r.cost_usd_total),
      duration_ms: Number(r.duration_ms),
      source_tier_breakdown: r.source_tier_breakdown as Record<string, unknown>,
      report_json: r.report_json as Record<string, unknown>,
    }));
  }

  /** v0.32.6 P2 — cache lookup; returns verdict JSON or null. */
  async getContradictionCacheEntry(key: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
  }): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query(
      `SELECT verdict FROM eval_contradictions_cache
       WHERE chunk_a_hash = $1
         AND chunk_b_hash = $2
         AND model_id = $3
         AND prompt_version = $4
         AND truncation_policy = $5
         AND expires_at > now()
       LIMIT 1`,
      [key.chunk_a_hash, key.chunk_b_hash, key.model_id, key.prompt_version, key.truncation_policy]
    );
    if (rows.length === 0) return null;
    return (rows[0] as Record<string, unknown>).verdict as Record<string, unknown>;
  }

  /** v0.32.6 P2 — cache upsert with TTL refresh on conflict. */
  async putContradictionCacheEntry(opts: {
    chunk_a_hash: string;
    chunk_b_hash: string;
    model_id: string;
    prompt_version: string;
    truncation_policy: string;
    verdict: Record<string, unknown>;
    ttl_seconds?: number;
  }): Promise<void> {
    const ttl = Math.max(60, opts.ttl_seconds ?? 30 * 86400);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.db.query(
      `INSERT INTO eval_contradictions_cache (
         chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy,
         verdict, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
       DO UPDATE SET
         verdict = EXCLUDED.verdict,
         expires_at = EXCLUDED.expires_at,
         created_at = now()`,
      [
        opts.chunk_a_hash, opts.chunk_b_hash, opts.model_id,
        opts.prompt_version, opts.truncation_policy,
        opts.verdict, expiresAt,
      ]
    );
  }

  /** v0.32.6 P2 — periodic sweep of expired cache rows. */
  async sweepContradictionCache(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM eval_contradictions_cache WHERE expires_at <= now()`
    );
    return result.affectedRows ?? 0;
  }

  async listTakes(opts: TakesListOpts = {}): Promise<Take[]> {
    const limit = clampSearchLimit(opts.limit, 100, 500);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const active = opts.active ?? true;
    const sortBy = opts.sortBy ?? 'created_at';
    const { rows } = await this.db.query(
      `SELECT t.*, p.slug AS page_slug
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE 1=1
         AND ($1::int   IS NULL OR t.page_id = $1::int)
         AND ($2::text  IS NULL OR p.slug    = $2::text)
         AND ($3::text  IS NULL OR t.holder  = $3::text)
         AND ($4::text  IS NULL OR t.kind    = $4::text)
         AND ($5::boolean IS NULL OR t.active = $5::boolean)
         AND (
           $6::boolean IS NULL
           OR ($6::boolean = true  AND t.resolved_at IS NOT NULL)
           OR ($6::boolean = false AND t.resolved_at IS NULL)
         )
         AND ($7::text[] IS NULL OR t.holder = ANY($7::text[]))
       ORDER BY
         CASE WHEN $8 = 'weight'      THEN t.weight     END DESC NULLS LAST,
         CASE WHEN $8 = 'since_date'  THEN t.since_date END DESC NULLS LAST,
         CASE WHEN $8 = 'created_at'  THEN t.created_at END DESC NULLS LAST
       LIMIT $9 OFFSET $10`,
      [
        opts.page_id ?? null,
        opts.page_slug ?? null,
        opts.holder ?? null,
        opts.kind ?? null,
        active,
        opts.resolved === undefined ? null : opts.resolved,
        opts.takesHoldersAllowList ?? null,
        sortBy,
        limit,
        offset,
      ]
    );
    return rows.map((r) => takeRowToTake(r as Record<string, unknown>));
  }

  async searchTakes(
    query: string,
    opts: { limit?: number; takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const { rows } = await this.db.query(
      `SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
              t.claim, t.kind, t.holder, t.weight,
              similarity(t.claim, $1)::real AS score
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active
         AND t.claim % $1
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
       ORDER BY score DESC, t.weight DESC
       LIMIT $3`,
      [query, opts.takesHoldersAllowList ?? null, limit]
    );
    return rows as unknown as TakeHit[];
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: { limit?: number; takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    const limit = clampSearchLimit(opts.limit, 30, 100);
    const vec = `[${Array.from(embedding).join(',')}]`;
    const { rows } = await this.db.query(
      `SELECT t.id AS take_id, t.page_id, p.slug AS page_slug, t.row_num,
              t.claim, t.kind, t.holder, t.weight,
              (1 - (t.embedding <=> $1::vector))::real AS score
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active
         AND t.embedding IS NOT NULL
         AND ($2::text[] IS NULL OR t.holder = ANY($2::text[]))
       ORDER BY t.embedding <=> $1::vector
       LIMIT $3`,
      [vec, opts.takesHoldersAllowList ?? null, limit]
    );
    return rows as unknown as TakeHit[];
  }

  async getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.db.query(
      `SELECT id, embedding FROM takes WHERE id = ANY($1::bigint[]) AND embedding IS NOT NULL`,
      [ids]
    );
    const out = new Map<number, Float32Array>();
    for (const r of rows as Array<{ id: number; embedding: unknown }>) {
      const v = r.embedding;
      if (typeof v === 'string') {
        const trimmed = v.replace(/^\[|\]$/g, '');
        const arr = trimmed.split(',').map(parseFloat).filter(n => !Number.isNaN(n));
        out.set(Number(r.id), new Float32Array(arr));
      } else if (Array.isArray(v)) {
        out.set(Number(r.id), new Float32Array(v as number[]));
      }
    }
    return out;
  }

  async countStaleTakes(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS count FROM takes WHERE active AND embedding IS NULL`
    );
    return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
  }

  async listStaleTakes(): Promise<StaleTakeRow[]> {
    const { rows } = await this.db.query(
      `SELECT t.id AS take_id, p.slug AS page_slug, t.row_num, t.claim
       FROM takes t
       JOIN pages p ON p.id = t.page_id
       WHERE t.active AND t.embedding IS NULL
       ORDER BY t.id
       LIMIT 100000`
    );
    return rows as unknown as StaleTakeRow[];
  }

  async updateTake(
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void> {
    let weight = fields.weight;
    if (weight !== undefined) {
      const norm = normalizeWeightForStorage(weight);
      if (norm.clamped) {
        process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: updateTake clamped weight ${weight} → ${norm.weight}\n`);
      }
      weight = norm.weight;
    }
    const result = await this.db.query(
      `UPDATE takes SET
         weight     = COALESCE($3::real, weight),
         since_date = COALESCE($4::text, since_date),
         source     = COALESCE($5::text, source),
         updated_at = now()
       WHERE page_id = $1 AND row_num = $2
       RETURNING 1`,
      [pageId, rowNum, weight ?? null, fields.since_date ?? null, fields.source ?? null]
    );
    if (result.rows.length === 0) {
      throw new GBrainError(
        'TAKE_ROW_NOT_FOUND',
        `take not found at page_id=${pageId} row=${rowNum}`,
        'list takes for this page with `gbrain takes <slug>` to see valid row numbers',
      );
    }
  }

  async supersedeTake(
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }> {
    return await this.db.transaction(async (tx) => {
      const existingRes = await tx.query(
        `SELECT resolved_at FROM takes WHERE page_id = $1 AND row_num = $2`,
        [pageId, oldRow]
      );
      const existing = existingRes.rows[0] as { resolved_at?: unknown } | undefined;
      if (!existing) {
        throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${oldRow}`, 'list takes with `gbrain takes <slug>`');
      }
      if (existing.resolved_at) {
        throw new GBrainError('TAKE_RESOLVED_IMMUTABLE', `take ${pageId}#${oldRow} is resolved`, 'resolved bets are immutable; add a new take instead');
      }
      const maxRowRes = await tx.query(
        `SELECT COALESCE(MAX(row_num), 0) + 1 AS next FROM takes WHERE page_id = $1`,
        [pageId]
      );
      const newRowNum = Number((maxRowRes.rows[0] as { next?: number })?.next ?? 1);
      const w = Math.max(0, Math.min(1, newRow.weight ?? 0.5));
      await tx.query(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, since_date, until_date, source, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text, $8::text, $9, $10)`,
        [
          pageId, newRowNum, newRow.claim, newRow.kind, newRow.holder, w,
          newRow.since_date ?? null, newRow.until_date ?? null, newRow.source ?? null,
          newRow.active ?? true,
        ]
      );
      await tx.query(
        `UPDATE takes SET active = false, superseded_by = $3, updated_at = now()
         WHERE page_id = $1 AND row_num = $2`,
        [pageId, oldRow, newRowNum]
      );
      return { oldRow, newRow: newRowNum };
    });
  }

  async resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void> {
    const existingRes = await this.db.query(
      `SELECT resolved_at FROM takes WHERE page_id = $1 AND row_num = $2`,
      [pageId, rowNum]
    );
    const existing = existingRes.rows[0] as { resolved_at?: unknown } | undefined;
    if (!existing) {
      throw new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${rowNum}`, 'list takes with `gbrain takes <slug>`');
    }
    if (existing.resolved_at) {
      throw new GBrainError('TAKE_ALREADY_RESOLVED', `take ${pageId}#${rowNum} already resolved`, 'resolution is immutable; add a new take to record a new outcome');
    }
    // v0.30.0: derive (quality, outcome) tuple. quality wins when both set.
    const { quality, outcome } = deriveResolutionTuple(resolution);
    await this.db.query(
      `UPDATE takes SET
         resolved_at      = now(),
         resolved_quality = $3::text,
         resolved_outcome = $4,
         resolved_value   = $5::real,
         resolved_unit    = $6::text,
         resolved_source  = $7::text,
         resolved_by      = $8,
         updated_at       = now()
       WHERE page_id = $1 AND row_num = $2`,
      [
        pageId, rowNum,
        quality,
        outcome,
        resolution.value ?? null,
        resolution.unit ?? null,
        resolution.source ?? null,
        resolution.resolvedBy,
      ]
    );
  }

  /**
   * v0.30.0: aggregate scorecard. SQL-level allow-list filter (D4 fail-closed).
   * Hidden-holder rows contribute zero to aggregates.
   */
  async getScorecard(opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard> {
    // Build the WHERE clause with positional params. PGLite (postgres-via-WASM)
    // shares the SQL dialect with real Postgres so the math expressions match.
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts.holder !== undefined) { params.push(opts.holder); clauses.push(`AND holder = $${params.length}`); }
    if (opts.domainPrefix !== undefined) {
      params.push(opts.domainPrefix + '%');
      clauses.push(`AND EXISTS (SELECT 1 FROM pages p WHERE p.id = takes.page_id AND p.slug LIKE $${params.length})`);
    }
    if (opts.since !== undefined) { params.push(opts.since); clauses.push(`AND since_date >= $${params.length}`); }
    if (opts.until !== undefined) { params.push(opts.until); clauses.push(`AND since_date <= $${params.length}`); }
    if (allowList !== undefined) { params.push(allowList); clauses.push(`AND holder = ANY($${params.length}::text[])`); }
    const where = clauses.join(' ');
    // v0.36.1.1 T1c: `resolved` deliberately filters to the 3-state subset
    // (correct|incorrect|partial) — NOT `resolved_quality IS NOT NULL` — so
    // historical comparisons against pre-v74 scorecards stay valid.
    // `unresolvable_count` is a sibling field counting the new 4th state.
    const res = await this.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'bet')::int                                              AS total_bets,
         COUNT(*) FILTER (WHERE resolved_quality IN ('correct','incorrect','partial'))::int     AS resolved,
         COUNT(*) FILTER (WHERE resolved_quality = 'correct')::int                              AS correct,
         COUNT(*) FILTER (WHERE resolved_quality = 'incorrect')::int                            AS incorrect,
         COUNT(*) FILTER (WHERE resolved_quality = 'partial')::int                              AS partial,
         COUNT(*) FILTER (WHERE resolved_quality = 'unresolvable')::int                         AS unresolvable_count,
         AVG(
           CASE WHEN resolved_quality IN ('correct','incorrect')
                THEN POWER(weight - (CASE resolved_quality WHEN 'correct' THEN 1 ELSE 0 END), 2)
           END
         )::float                                                                               AS brier
       FROM takes
       WHERE 1=1 ${where}`,
      params,
    );
    const r = res.rows[0] as { total_bets: number; resolved: number; correct: number; incorrect: number; partial: number; unresolvable_count: number; brier: number | null };
    return finalizeScorecard(r);
  }

  /**
   * v0.30.0: calibration curve. Bins resolved correct/incorrect bets by stated weight.
   */
  async getCalibrationCurve(opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]> {
    const bucketSize = opts.bucketSize && opts.bucketSize > 0 && opts.bucketSize <= 1 ? opts.bucketSize : 0.1;
    const maxIdx = Math.floor(1 / bucketSize) - 1;
    const params: unknown[] = [bucketSize, maxIdx];
    const clauses: string[] = [];
    if (opts.holder !== undefined) { params.push(opts.holder); clauses.push(`AND holder = $${params.length}`); }
    if (allowList !== undefined) { params.push(allowList); clauses.push(`AND holder = ANY($${params.length}::text[])`); }
    const where = clauses.join(' ');
    // NUMERIC casts for exact decimal arithmetic — keeps PGLite + Postgres
    // bucket boundaries identical at FP-edge weights (e.g. 0.7/0.1).
    // See parity test in test/e2e/takes-scorecard-parity.test.ts.
    const res = await this.db.query(
      `WITH binned AS (
         SELECT
           LEAST(FLOOR(weight::numeric / $1::numeric)::int, $2::int)::int AS bucket_idx,
           weight,
           (resolved_quality = 'correct')::int            AS hit
         FROM takes
         WHERE resolved_quality IN ('correct','incorrect')
           ${where}
       )
       SELECT
         (bucket_idx::numeric * $1::numeric)::float        AS bucket_lo,
         ((bucket_idx + 1)::numeric * $1::numeric)::float  AS bucket_hi,
         COUNT(*)::int                                     AS n,
         AVG(hit)::float                                   AS observed,
         AVG(weight)::float                                AS predicted
       FROM binned
       GROUP BY bucket_idx
       ORDER BY bucket_idx`,
      params,
    );
    return (res.rows as { bucket_lo: number; bucket_hi: number; n: number; observed: number | null; predicted: number | null }[]).map(r => ({
      bucket_lo: r.bucket_lo,
      bucket_hi: r.bucket_hi,
      n: r.n,
      observed: r.n > 0 ? r.observed : null,
      predicted: r.n > 0 ? r.predicted : null,
    }));
  }

  async addSynthesisEvidence(rowsIn: SynthesisEvidenceInput[]): Promise<number> {
    if (rowsIn.length === 0) return 0;
    const synthesisIds = rowsIn.map(r => r.synthesis_page_id);
    const takePageIds  = rowsIn.map(r => r.take_page_id);
    const takeRowNums  = rowsIn.map(r => r.take_row_num);
    const citationIxs  = rowsIn.map(r => r.citation_index);
    const result = await this.db.query(
      `INSERT INTO synthesis_evidence (synthesis_page_id, take_page_id, take_row_num, citation_index)
       SELECT v.synthesis_page_id::int, v.take_page_id::int, v.take_row_num::int, v.citation_index::int
       FROM unnest($1::int[], $2::int[], $3::int[], $4::int[])
         AS v(synthesis_page_id, take_page_id, take_row_num, citation_index)
       ON CONFLICT (synthesis_page_id, take_page_id, take_row_num) DO NOTHING
       RETURNING 1`,
      [synthesisIds, takePageIds, takeRowNums, citationIxs]
    );
    return result.rows.length;
  }

  // Versions
  async createVersion(slug: string, opts?: { sourceId?: string }): Promise<PageVersion> {
    const sourceId = opts?.sourceId ?? 'default';
    const { rows } = await this.db.query(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       SELECT id, compiled_truth, frontmatter
       FROM pages WHERE slug = $1 AND source_id = $2
       RETURNING *`,
      [slug, sourceId]
    );
    if (rows.length === 0) throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string, opts?: { sourceId?: string }): Promise<PageVersion[]> {
    // v0.31.8 (D16): two-branch. Without opts.sourceId, joins return versions
    // for every same-slug page (preserves pre-v0.31.8 cross-source view).
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        `SELECT pv.* FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
         WHERE p.slug = $1 AND p.source_id = $2
         ORDER BY pv.snapshot_at DESC`,
        [slug, opts.sourceId]
      );
      return rows as unknown as PageVersion[];
    }
    const { rows } = await this.db.query(
      `SELECT pv.* FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = $1
       ORDER BY pv.snapshot_at DESC`,
      [slug]
    );
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(
    slug: string,
    versionId: number,
    opts?: { sourceId?: string },
  ): Promise<void> {
    // v0.31.8 (D12): when opts.sourceId is set, scope BOTH the page lookup
    // and the version row reference. Without it, multi-source brains can
    // revert the wrong same-slug page (the one Postgres returns first).
    if (opts?.sourceId) {
      await this.db.query(
        `UPDATE pages SET
          compiled_truth = pv.compiled_truth,
          frontmatter = pv.frontmatter,
          updated_at = now()
        FROM page_versions pv
        WHERE pages.slug = $1 AND pages.source_id = $3
              AND pv.id = $2 AND pv.page_id = pages.id`,
        [slug, versionId, opts.sourceId]
      );
      return;
    }
    await this.db.query(
      `UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = $1 AND pv.id = $2 AND pv.page_id = pages.id`,
      [slug, versionId]
    );
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const { rows: [stats] } = await this.db.query(`
      SELECT
        -- v0.26.5: exclude soft-deleted from page_count (mirrors postgres-engine).
        (SELECT count(*) FROM pages WHERE deleted_at IS NULL) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count,
        (SELECT count(*) FROM timeline_entries) as timeline_entry_count
    `);

    const { rows: types } = await this.db.query(
      `SELECT type, count(*)::int as count FROM pages GROUP BY type ORDER BY count DESC`
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

  async getHealth(): Promise<BrainHealth> {
    // Combined metrics from master (brain_score components: dead_links, link_count,
    // pages_with_timeline) and v0.10.3 graph layer (link_coverage, timeline_coverage,
    // most_connected). Both coexist: master's brain_score is the composite
    // dashboard, v0.10.3 metrics give entity-page-level granularity.
    const { rows: [h] } = await this.db.query(`
      WITH entity_pages AS (
        SELECT id, slug FROM pages WHERE type IN ('person', 'company')
      )
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL)::float /
          GREATEST((SELECT count(*) FROM content_chunks), 1)::float as embed_coverage,
        (SELECT count(*) FROM pages p
         WHERE p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id)
        ) as stale_pages,
        -- Bug 11 — orphan = islanded (no inbound AND no outbound).
        -- See BrainHealth.orphan_pages docstring; docs updated to match this.
        (SELECT count(*) FROM pages p
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
        ) as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
        ) as dead_links,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) as missing_embeddings,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT page_id) FROM timeline_entries) as pages_with_timeline,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as link_coverage,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as timeline_coverage
    `);

    // Top 5 most connected entities by total link count (in + out).
    const { rows: connected } = await this.db.query(`
      SELECT p.slug,
             (SELECT count(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id)::int as link_count
      FROM pages p
      WHERE p.type IN ('person', 'company')
      ORDER BY link_count DESC
      LIMIT 5
    `);

    const r = h as Record<string, unknown>;
    const pageCount = Number(r.page_count);
    const embedCoverage = Number(r.embed_coverage);
    const orphanPages = Number(r.orphan_pages);
    const deadLinks = Number(r.dead_links);
    const linkCount = Number(r.link_count);
    const pagesWithTimeline = Number(r.pages_with_timeline);

    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    const timelineCoverageDensity = pageCount > 0 ? Math.min(pagesWithTimeline / pageCount, 1) : 0;
    const noOrphans = pageCount > 0 ? 1 - (orphanPages / pageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    // Bug 11 — per-component points. Sum equals brainScore by construction
    // so `doctor` can render a breakdown that adds up to the total.
    //
    // v0.37.10.0: empty brains (pageCount === 0) get FULL marks (100/100),
    // not 0. Semantically an empty brain has no coverage problem to penalize
    // — there's nothing to embed, nothing to link, nothing to orphan. The
    // pre-fix "empty = 0" caused fresh-init brains to score as critically
    // unhealthy on `gbrain doctor`, which was a structural surprise to users
    // who'd just successfully run init.
    const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineCoverageDensity * 15);
    const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
    const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

    return {
      page_count: pageCount,
      embed_coverage: embedCoverage,
      stale_pages: Number(r.stale_pages),
      orphan_pages: orphanPages,
      missing_embeddings: Number(r.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      link_coverage: Number(r.link_coverage),
      timeline_coverage: Number(r.timeline_coverage),
      most_connected: (connected as { slug: string; link_count: number }[]).map(c => ({
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
    // v0.31.2 (codex P1 #3): source_id threaded so multi-source brains can
    // scope ingest_log queries. Default 'default' matches the column DEFAULT.
    const sourceId = entry.source_id ?? 'default';
    await this.db.query(
      `INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [sourceId, entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary]
    );
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    const { rows } = await this.db.query(
      `SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    // Belt-and-suspenders source_id fallback for any pre-v50 row that
    // somehow survived without the backfill.
    return (rows as unknown as IngestLogEntry[]).map(r => ({
      ...r,
      source_id: r.source_id ?? 'default',
    }));
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string, opts?: { sourceId?: string }): Promise<void> {
    newSlug = validateSlug(newSlug);
    const sourceId = opts?.sourceId ?? 'default';
    // Source-qualify so a rename in source A doesn't sweep up same-slug rows
    // in sources B/C/D (mirrors postgres-engine.ts).
    await this.db.query(
      `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2 AND source_id = $3`,
      [newSlug, oldSlug, sourceId]
    );
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub: links use integer page_id FKs, already correct after updateSlug.
  }

  async resolveSlugWithAlias(
    slug: string,
    sourceOrSources: string | readonly string[],
  ): Promise<string> {
    const sources = Array.isArray(sourceOrSources)
      ? [...sourceOrSources]
      : [sourceOrSources as string];
    if (sources.length === 0) return slug;
    try {
      // PGLite supports `= ANY($N::text[])` per pgvector / postgres semantics.
      // ORDER BY array_position pins the federated-read precedence so the
      // multi-source ambiguity warning is deterministic.
      const placeholders = sources.map((_, i) => `$${i + 2}`).join(',');
      const { rows } = await this.db.query(
        `SELECT canonical_slug, source_id
         FROM slug_aliases
         WHERE alias_slug = $1
           AND source_id IN (${placeholders})
         ORDER BY id`,
        [slug, ...sources],
      );
      if (rows.length === 0) return slug;
      if (rows.length > 1) {
        warnOncePerProcess(
          `resolveSlugWithAlias:multi_match:${slug}`,
          `[resolveSlugWithAlias] multi_match: alias '${slug}' exists in ${rows.length} sources; returning first.`,
        );
      }
      // Match Postgres engine: prefer rows in sourceOrSources order
      const indexedRows = rows.map(r => ({
        ...(r as { canonical_slug: string; source_id: string }),
        order: sources.indexOf((r as { source_id: string }).source_id),
      }));
      indexedRows.sort((a, b) => a.order - b.order);
      return indexedRows[0].canonical_slug ?? slug;
    } catch (e) {
      if (isUndefinedTableError(e)) return slug;
      throw e;
    }
  }

  async resolveAliases(
    aliasNorms: string[],
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<Map<string, Array<{ slug: string; source_id: string }>>> {
    const out = new Map<string, Array<{ slug: string; source_id: string }>>();
    if (!aliasNorms || aliasNorms.length === 0) return out;
    const sources =
      opts?.sourceIds && opts.sourceIds.length > 0
        ? opts.sourceIds
        : opts?.sourceId
          ? [opts.sourceId]
          : null;
    let q = `SELECT alias_norm, slug, source_id FROM page_aliases WHERE alias_norm = ANY($1::text[])`;
    const params: unknown[] = [aliasNorms];
    if (sources) {
      params.push(sources);
      q += ` AND source_id = ANY($2::text[])`;
    }
    q += ` ORDER BY alias_norm, source_id, slug`;
    const { rows } = await this.db.query(q, params);
    for (const r of rows as Array<{ alias_norm: string; slug: string; source_id: string }>) {
      const list = out.get(r.alias_norm) ?? [];
      if (!list.some(x => x.slug === r.slug && x.source_id === r.source_id)) {
        list.push({ slug: r.slug, source_id: r.source_id });
      }
      out.set(r.alias_norm, list);
    }
    return out;
  }

  async setPageAliases(slug: string, sourceId: string, aliasNorms: string[]): Promise<void> {
    const uniq = Array.from(new Set(aliasNorms.filter(a => a.length > 0)));
    await this.db.query(`DELETE FROM page_aliases WHERE source_id = $1 AND slug = $2`, [sourceId, slug]);
    if (uniq.length === 0) return;
    await this.db.query(
      `INSERT INTO page_aliases (source_id, alias_norm, slug)
       SELECT $1, a, $2 FROM unnest($3::text[]) AS a
       ON CONFLICT (source_id, alias_norm, slug) DO NOTHING`,
      [sourceId, slug, uniq],
    );
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const { rows } = await this.db.query('SELECT value FROM config WHERE key = $1', [key]);
    return rows.length > 0 ? (rows[0] as { value: string }).value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  async unsetConfig(key: string): Promise<number> {
    const { affectedRows } = await this.db.query(
      'DELETE FROM config WHERE key = $1',
      [key],
    ) as { affectedRows?: number };
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

  // Migration support
  async runMigration(_version: number, sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async getChunksWithEmbeddings(slug: string, opts?: { sourceId?: string }): Promise<Chunk[]> {
    const sourceId = opts?.sourceId;
    const { rows } = sourceId
      ? await this.db.query(
          `SELECT cc.* FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
           WHERE p.slug = $1 AND p.source_id = $2
           ORDER BY cc.chunk_index`,
          [slug, sourceId]
        )
      : await this.db.query(
          `SELECT cc.* FROM content_chunks cc
           JOIN pages p ON p.id = cc.page_id
           WHERE p.slug = $1
           ORDER BY cc.chunk_index`,
          [slug]
        );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r, true));
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
    const queryPromise = this.db.query(sql, params).then((r) => r.rows as T[]);
    if (!opts?.signal) return queryPromise;
    const abortPromise = new Promise<T[]>((_resolve, reject) => {
      opts.signal!.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
    return Promise.race([queryPromise, abortPromise]);
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

  // ============================================================
  // v0.20.0 Cathedral II: code edges (Layer 1 stubs — filled by Layer 5)
  // ============================================================
  // Declared here so the interface contract is satisfied and consumers can
  // import against them. Implementations throw until the edge extractor +
  // per-lang tree-sitter queries land in Layer 5/6.
  // ============================================================

  async addCodeEdges(edges: import('./types.ts').CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    let inserted = 0;
    // Split into resolved vs unresolved. Resolved rows carry to_chunk_id
    // (known target chunk); unresolved rows only know the qualified name.
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    if (resolved.length > 0) {
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of resolved) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.to_chunk_id, e.from_symbol_qualified,
          e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await this.db.query(
        `INSERT INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }
    if (unresolved.length > 0) {
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of unresolved) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? 'default',
        );
      }
      const res = await this.db.query(
        `INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }
    return inserted;
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    // Both directions on code_edges_chunk; from-only on code_edges_symbol
    // (unresolved edges don't have a to_chunk_id to match against).
    await this.db.query(
      `DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY($1::int[]) OR to_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
    await this.db.query(
      `DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE to_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE to_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE from_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE from_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const edgeTypeClause = opts?.edgeType ? `AND edge_type = '${opts.edgeType.replace(/'/g, "''")}'` : '';
    // Build the chunk-table filter based on direction. Unresolved edges
    // (code_edges_symbol) only carry from_chunk_id — there's no inbound
    // direction into them from a chunk ID, so we include them only when
    // direction is 'out' or 'both'.
    let chunkFilter = '';
    if (direction === 'in') chunkFilter = `WHERE to_chunk_id = $1`;
    else if (direction === 'out') chunkFilter = `WHERE from_chunk_id = $1`;
    else chunkFilter = `WHERE from_chunk_id = $1 OR to_chunk_id = $1`;

    let symbolFilter = '';
    if (direction === 'out' || direction === 'both') {
      symbolFilter = `WHERE from_chunk_id = $1`;
    }

    const unionClause = symbolFilter ? `
      UNION ALL
      SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        ${symbolFilter} ${edgeTypeClause}
    ` : '';

    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         ${chunkFilter} ${edgeTypeClause}
       ${unionClause}
       LIMIT $2`,
      [chunkId, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  // Eval capture (v0.25.0). See BrainEngine interface docs.
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO eval_candidates (
         tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
         expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
         latency_ms, remote, job_id, subagent_id, embedding_column
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        input.tool_name,
        input.query,
        input.retrieved_slugs,
        input.retrieved_chunk_ids,
        input.source_ids,
        input.expand_enabled,
        input.detail,
        input.detail_resolved,
        input.vector_enabled,
        input.expansion_applied,
        input.latency_ms,
        input.remote,
        input.job_id,
        input.subagent_id,
        input.embedding_column ?? null,
      ]
    );
    return rows[0]!.id;
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
      `SELECT * FROM eval_capture_failures WHERE ts >= $1 ORDER BY ts DESC`,
      [since]
    );
    return rows as unknown as EvalCaptureFailure[];
  }

  // ============================================================
  // v0.29 — Salience + Anomaly Detection
  // ============================================================

  async batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]> {
    // Two CTEs avoid the N×M cartesian product (codex C4#4).
    const baseSql = `
      WITH page_tags AS (
        SELECT page_id, array_agg(DISTINCT tag) AS tags
          FROM tags GROUP BY page_id
      ),
      page_takes AS (
        SELECT page_id, json_agg(json_build_object(
                 'holder', holder, 'weight', weight, 'kind', kind, 'active', active
               )) AS takes
          FROM takes WHERE active = TRUE GROUP BY page_id
      )
      SELECT p.slug, p.source_id,
             COALESCE(pt.tags, ARRAY[]::text[]) AS tags,
             COALESCE(pk.takes, '[]'::json) AS takes
        FROM pages p
        LEFT JOIN page_tags pt  ON pt.page_id = p.id
        LEFT JOIN page_takes pk ON pk.page_id = p.id
    `;
    const { rows } = slugs
      ? await this.db.query(`${baseSql} WHERE p.slug = ANY($1::text[])`, [slugs])
      : await this.db.query(baseSql);
    return (rows as Record<string, unknown>[]).map(r => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      tags: (r.tags as string[]) ?? [],
      takes: (r.takes as EmotionalWeightInputRow['takes']) ?? [],
    }));
  }

  async setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const slugs = rows.map(r => r.slug);
    const sourceIds = rows.map(r => r.source_id);
    const weights = rows.map(r => r.weight);
    // Composite-keyed UPDATE FROM unnest (codex C4#3).
    // v0.29.1: bump salience_touched_at when emotional_weight actually changes
    // so the salience query window picks up newly-salient old pages. Mirror
    // of postgres-engine.ts.
    const result = await this.db.query(
      `UPDATE pages
          SET emotional_weight = u.weight,
              salience_touched_at = CASE
                WHEN pages.emotional_weight IS DISTINCT FROM u.weight THEN now()
                ELSE pages.salience_touched_at
              END
         FROM unnest($1::text[], $2::text[], $3::real[])
           AS u(slug, source_id, weight)
        WHERE pages.slug = u.slug AND pages.source_id = u.source_id
        RETURNING 1`,
      [slugs, sourceIds, weights]
    );
    return result.rows.length;
  }

  async getRecentSalience(opts: SalienceOpts): Promise<SalienceResult[]> {
    const days = Math.max(0, opts.days ?? 14);
    const limit = clampSearchLimit(opts.limit, 20, 100);
    const slugPrefix = opts.slugPrefix;
    const boundaryIso = new Date(Date.now() - days * 86400000).toISOString();

    const params: unknown[] = [boundaryIso];
    let prefixCondition = '';
    if (slugPrefix) {
      const escaped = slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      params.push(escaped);
      prefixCondition = `AND p.slug LIKE $${params.length} ESCAPE '\\'`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    // v0.29.1: third score term via buildRecencyComponentSql. Default
    // 'flat' = v0.29.0 behavior. 'on' opts into per-prefix decay.
    const recencyBias = opts.recency_bias ?? 'flat';
    let recencySql: string;
    if (recencyBias === 'on') {
      const { resolveRecencyDecayMap, DEFAULT_FALLBACK } = await import('./search/recency-decay.ts');
      recencySql = buildRecencyComponentSql({
        slugColumn: 'p.slug',
        dateExpr: 'COALESCE(p.effective_date, p.updated_at)',
        decayMap: resolveRecencyDecayMap(),
        fallback: DEFAULT_FALLBACK,
      });
    } else {
      recencySql = buildRecencyComponentSql({
        slugColumn: 'p.slug',
        dateExpr: 'p.updated_at',
        decayMap: {},
        fallback: { halflifeDays: 1, coefficient: 1.0 },
      });
    }
    const { rows } = await this.db.query(
      `SELECT p.slug, p.source_id, p.title, p.type, p.updated_at, p.emotional_weight,
              COUNT(DISTINCT t.id) AS take_count,
              COALESCE(AVG(t.weight), 0) AS take_avg_weight,
              (p.emotional_weight * 5)
                + ln(1 + COUNT(DISTINCT t.id))
                + ${recencySql}
                AS score
         FROM pages p
         LEFT JOIN takes t ON t.page_id = p.id AND t.active = TRUE
        WHERE GREATEST(p.updated_at, COALESCE(p.salience_touched_at, p.updated_at)) >= $1::timestamptz
          ${prefixCondition}
        GROUP BY p.id
        ORDER BY score DESC
        LIMIT ${limitParam}`,
      params
    );
    return (rows as Record<string, unknown>[]).map(r => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as SalienceResult['type'],
      updated_at: r.updated_at as Date,
      emotional_weight: Number(r.emotional_weight ?? 0),
      take_count: Number(r.take_count ?? 0),
      take_avg_weight: Number(r.take_avg_weight ?? 0),
      score: Number(r.score ?? 0),
    }));
  }

  async listEnrichCandidates(opts: EnrichCandidatesOpts): Promise<EnrichCandidate[]> {
    // v0.41.39 (issue #1700). Parity with postgres-engine.listEnrichCandidates.
    if (!opts.types || opts.types.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 5000));
    const threshold = Math.max(0, opts.thinThreshold);

    const params: unknown[] = [];
    params.push(opts.types);
    const typesParam = `$${params.length}`;
    params.push(threshold);
    const thresholdParam = `$${params.length}`;

    const where: string[] = [
      'p.deleted_at IS NULL',
      `p.type = ANY(${typesParam}::text[])`,
      `(char_length(p.compiled_truth) + char_length(COALESCE(p.timeline, ''))) < ${thresholdParam}`,
    ];

    // Source scope: array wins over scalar.
    if (opts.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
    } else if (opts.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
    }

    // Re-enrich recency guard. Lexical text compare on the ISO `enriched_at`
    // (never cast → can't throw on a malformed value). NULL → eligible.
    const reenrichMs = opts.reenrichAfterMs ?? 0;
    if (reenrichMs > 0) {
      params.push(new Date(Date.now() - reenrichMs).toISOString());
      where.push(
        `NOT (p.frontmatter ->> 'enriched_at' IS NOT NULL AND p.frontmatter ->> 'enriched_at' > $${params.length})`,
      );
    }

    const orderKey = ENRICH_ORDER_SQL[opts.order] ? opts.order : 'inbound-links';
    const orderBy = ENRICH_ORDER_SQL[orderKey];

    params.push(limit);
    const limitParam = `$${params.length}`;

    const { rows } = await this.db.query(
      `SELECT
         p.slug,
         p.source_id,
         p.title,
         p.type,
         (char_length(p.compiled_truth) + char_length(COALESCE(p.timeline, ''))) AS body_len,
         COALESCE((
           SELECT COUNT(*)
             FROM links l
            WHERE l.to_page_id = p.id
              AND l.link_source IS DISTINCT FROM 'mentions'
         ), 0)::int AS inbound_count
       FROM pages p
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ${limitParam}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      slug: String(r.slug),
      source_id: String(r.source_id),
      title: String(r.title ?? ''),
      type: r.type as EnrichCandidate['type'],
      body_len: Number(r.body_len ?? 0),
      inbound_count: Number(r.inbound_count ?? 0),
    }));
  }

  async findAnomalies(opts: AnomaliesOpts): Promise<AnomalyResult[]> {
    const sigma = opts.sigma ?? 3.0;
    const lookbackDays = Math.max(1, opts.lookback_days ?? 30);
    const sinceIso = (opts.since ?? new Date().toISOString().slice(0, 10));
    const sinceDate = new Date(sinceIso + 'T00:00:00Z');
    const sinceEnd = new Date(sinceDate.getTime() + 86400000);
    const baselineStart = new Date(sinceDate.getTime() - lookbackDays * 86400000);

    const tagBaselineRes = await this.db.query(
      `WITH days AS (
         SELECT day::date FROM generate_series(
           $1::date, $2::date - 1, '1 day'::interval
         ) AS day
       ),
       cohort_keys AS (
         SELECT DISTINCT t.tag FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
       ),
       touched AS (
         SELECT t.tag,
                date_trunc('day', p.updated_at)::date AS day,
                COUNT(DISTINCT p.id) AS cnt
           FROM tags t JOIN pages p ON p.id = t.page_id
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
          GROUP BY 1, 2
       )
       SELECT cd.tag AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
         FROM cohort_keys cd CROSS JOIN days d
         LEFT JOIN touched t ON t.tag = cd.tag AND t.day = d.day`,
      [baselineStart.toISOString(), sinceDate.toISOString()]
    );

    const typeBaselineRes = await this.db.query(
      `WITH days AS (
         SELECT day::date FROM generate_series(
           $1::date, $2::date - 1, '1 day'::interval
         ) AS day
       ),
       cohort_keys AS (
         SELECT DISTINCT p.type FROM pages p
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
       ),
       touched AS (
         SELECT p.type,
                date_trunc('day', p.updated_at)::date AS day,
                COUNT(DISTINCT p.id) AS cnt
           FROM pages p
          WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
          GROUP BY 1, 2
       )
       SELECT cd.type AS cohort_value, d.day::text AS day, COALESCE(t.cnt, 0)::int AS count
         FROM cohort_keys cd CROSS JOIN days d
         LEFT JOIN touched t ON t.type = cd.type AND t.day = d.day`,
      [baselineStart.toISOString(), sinceDate.toISOString()]
    );

    const tagTodayRes = await this.db.query(
      `SELECT t.tag AS cohort_value,
              COUNT(DISTINCT p.id)::int AS count,
              array_agg(DISTINCT p.slug) AS slugs
         FROM tags t JOIN pages p ON p.id = t.page_id
        WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
        GROUP BY 1`,
      [sinceIso, sinceEnd.toISOString()]
    );

    const typeTodayRes = await this.db.query(
      `SELECT p.type AS cohort_value,
              COUNT(DISTINCT p.id)::int AS count,
              array_agg(DISTINCT p.slug) AS slugs
         FROM pages p
        WHERE p.updated_at >= $1::timestamptz AND p.updated_at < $2::timestamptz
        GROUP BY 1`,
      [sinceIso, sinceEnd.toISOString()]
    );

    const baseline = [
      ...(tagBaselineRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
      ...(typeBaselineRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        day: String(r.day),
        count: Number(r.count),
      })),
    ];
    const today = [
      ...(tagTodayRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'tag' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
      ...(typeTodayRes.rows as Record<string, unknown>[]).map(r => ({
        cohort_kind: 'type' as const,
        cohort_value: String(r.cohort_value),
        count: Number(r.count),
        page_slugs: (r.slugs as string[]) ?? [],
      })),
    ];

    return computeAnomaliesFromBuckets(baseline, today, sigma);
  }
}

/**
 * Raw row shape returned from `SELECT * FROM facts`. The `embedding`
 * column comes back as a string (`[0.1,0.2,...]`) on PGLite when
 * postgres-style types aren't auto-decoded; we parse on the way out.
 */
interface FactRowSqlShape {
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  expired_at: Date | string | null;
  superseded_by: number | null;
  consolidated_at: Date | string | null;
  consolidated_into: number | null;
  source: string;
  source_session: string | null;
  confidence: number;
  embedding: string | number[] | Float32Array | null;
  embedded_at: Date | string | null;
  created_at: Date | string;
}

function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

function rowToFact(row: FactRowSqlShape): FactRow {
  let embedding: Float32Array | null = null;
  if (row.embedding != null) {
    if (row.embedding instanceof Float32Array) embedding = row.embedding;
    else if (Array.isArray(row.embedding)) embedding = new Float32Array(row.embedding);
    else if (typeof row.embedding === 'string') {
      // pgvector text format: "[0.1,0.2,...]"
      const trimmed = row.embedding.trim();
      const inner = trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed;
      const parts = inner.split(',').map(p => parseFloat(p.trim())).filter(Number.isFinite);
      embedding = parts.length > 0 ? new Float32Array(parts) : null;
    }
  }
  return {
    id: Number(row.id),
    source_id: row.source_id,
    entity_slug: row.entity_slug,
    fact: row.fact,
    kind: row.kind,
    visibility: row.visibility,
    // v0.31.2: notability column added by migration v46. Same fallback
    // as Postgres (belt-and-suspenders with the NOT NULL DEFAULT).
    notability: row.notability ?? 'medium',
    context: row.context,
    valid_from: toDate(row.valid_from)!,
    valid_until: toDate(row.valid_until),
    expired_at: toDate(row.expired_at),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_at: toDate(row.consolidated_at),
    consolidated_into: row.consolidated_into == null ? null : Number(row.consolidated_into),
    source: row.source,
    source_session: row.source_session,
    confidence: Number(row.confidence),
    embedding,
    embedded_at: toDate(row.embedded_at),
    created_at: toDate(row.created_at)!,
  };
}

/**
 * Encode a Float32Array as the pgvector text-form literal `[0.1,0.2,...]`.
 * Both PGLite and Postgres accept this when the parameter is cast to ::vector.
 */
function toPgVectorLiteral(v: Float32Array | number[]): string {
  if (v instanceof Float32Array) return '[' + Array.from(v).join(',') + ']';
  return '[' + v.join(',') + ']';
}

function rowToCodeEdge(row: Record<string, unknown>): import('./types.ts').CodeEdgeResult {
  return {
    id: row.id as number,
    from_chunk_id: row.from_chunk_id as number,
    to_chunk_id: row.to_chunk_id == null ? null : (row.to_chunk_id as number),
    from_symbol_qualified: (row.from_symbol_qualified as string) ?? '',
    to_symbol_qualified: (row.to_symbol_qualified as string) ?? '',
    edge_type: (row.edge_type as string) ?? '',
    edge_metadata: (row.edge_metadata as Record<string, unknown>) ?? {},
    source_id: row.source_id == null ? null : (row.source_id as string),
    resolved: Boolean(row.resolved),
  };
}
