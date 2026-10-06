import { registerManagedFilesystemEngine } from './persistence/filesystem-guard.ts';
import { replaceDerivedLinks, type DerivedLinkOrigin, type DerivedLinkReplacementOptions } from './derived-links.ts';
import { trackPgliteDatabase, PgliteClosingError, notifyPgliteOpened } from './pglite-lifecycle.ts';
import { mutatePageTag } from './page-state/tags.ts';
import type { PageKey, PageSnapshot, PageSnapshotOptions, PageWriteOptions } from './page-state/types.ts';
import { assertPageRevision } from './page-state/types.ts';
import { lockUnheldPageKeys, withHeldPageKeys, type HeldPageKeys } from './page-state/guards.ts';
import { readPageSnapshot as readCanonicalPageSnapshot } from './page-state/snapshot.ts';
import { createPageVersion } from './page-state/versions.ts';
import { moveSlugBindings, recordRenameAlias } from './page-state/rename-alias.ts';
import { composablePgliteTransaction, transactionMemo } from './page-state/transactions.ts';
import { dropRowTypeArrayParsers, PgliteStatementCache } from './pglite-statements.ts';
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
import { getEmbeddedPgliteOptions } from './pglite-embedded-assets.ts';
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
  FileSpec, FileRow,
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow, StaleTakeOpts, TakeEmbeddingInput,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
  FactRow, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
  SourceRow,
} from './engine.ts';
import { DREAM_VERDICT_TTL_SECONDS, clampSearchLimit } from './engine.ts';
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
  isNovelDimension, isBackdatedObservation,
} from './chronicle/ontology.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import { runMigrations } from './migrate.ts';
import { supportsHnswIterativeScan } from './vector-index.ts';
import { searchVectorPool, readVectorPool } from './search/vector-pool.ts';
import { beforePlannerRead, plannerRead } from './planner-stats.ts';
import { buildVectorSearchStatement, VECTOR_EXTENSION_VERSION_SQL } from './search/vector-statement.ts';
import { withVectorSettings } from './search/vector-settings.ts';
import { PGLITE_SCHEMA_SQL, getPGLiteSchema } from './pglite-schema.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { readStoredEmbeddingIdentity } from './stored-embedding-identity.ts';
import { DELETE_BATCH_SIZE, TRAVERSE_PATH_ROW_CAP, TRAVERSE_WALK_ROW_CAP } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { SAFE_FENCE_CHUNKER_VERSION, bodyWriteChunkVersion, chunkWriteInvalidation, currentTextProjectionFilter, requiresSafeChunks, safeChunksFilter } from './search/safe-chunks.ts';
import { acquireLock, pgliteLockDirFor, releaseLock, type LockHandle } from './pglite-lock.ts';
import { assertPgliteGraduationOpenable } from './persistence/graduation-custody.ts';
// Engine-live path (#3596): static import, never a lazy `import()` in the
// connect() catch. No cycle: pglite-repair.ts imports nothing from this file.
import { attemptWalRepairAndRetry, closeRepairEpisodeIfOpen, readRepairFailedMarker, recordFailedAutoRepair, type WalRepairReceipt } from './pglite-repair.ts';
import { getFtsLanguage } from './fts-language.ts';
import { splitEmbeddingSignature, currentSpaceChunkPredicate, lockEmbeddingSources } from './embedding-invalidation.ts';
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
  DomainBankSampleOpts, CorpusSampleOpts, DomainBankRow,
  EnrichCandidatesOpts, EnrichCandidate,
} from './types.ts';
import { validateSlug, contentHash, isBlankBody, rowToPage, rowToStalePage, rowToChunk, rowToSearchResult, isUndefinedTableError, warnOncePerProcess } from './utils.ts';
import { executeRawJsonb, type SqlValue } from './sql-query.ts';
import { sanitizeForJsonb, sanitizeText, buildLinkRows, buildTimelineRows } from './batch-rows.ts';
import { PAGE_SORT_SQL } from './types.ts';
import { finalizeLastSeen } from './chronicle/last-seen.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildBestPerPagePoolCte, buildOrFallbackWebsearchQuery, boundWebsearchQuery } from './search/sql-ranking.ts';
import { privatePagesFilterFragment, privateSnapshotFilterFragment, privateLinkOriginFilterFragment, privateTimelineEventFilterFragment, privateProvenanceFilterFragment } from './search/private-visibility.ts';
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
import * as takesImpl from './engine-sql/takes.ts';
import { PgliteCheckpointGuard, writesWal } from './pglite-engine/checkpoint-guard.ts';
import { pgliteExecutor } from './engine-sql/dialect-pglite.ts';
import type { SqlExecutor } from './engine-sql/executor.ts';
import { scopedRead, unscopedExecutor } from './engine-sql/brands.ts';
import * as codeEdgesImpl from './engine-sql/code-edges.ts';
import { getEdgesByChunk as getEdgesByChunkPglite, type PgliteCodeEdgesDeps } from './pglite-engine/code-edges.ts';
import * as salienceImpl from './engine-sql/salience.ts';
import * as healthImpl from './engine-sql/health.ts';
import * as pagesImpl from './engine-sql/pages.ts';
import * as tagsImpl from './engine-sql/tags.ts';
import * as linksImpl from './engine-sql/links.ts';
import * as timelineImpl from './engine-sql/timeline.ts';
import * as sourcesImpl from './engine-sql/sources.ts';
import * as filesImpl from './engine-sql/files.ts';
import type { ChunkWindowRequest, ChunkWindowOpts, ChunkWindowPage } from './search/chunk-windows.ts';
import * as chunksImpl from './engine-sql/chunks.ts';
import { searchKeywordCJK } from './engine-sql/cjk-search.ts';
import * as titlesImpl from './engine-sql/titles.ts';
import { applyForwardReferenceBootstrap, pgliteBootstrapTarget } from './engine-sql/bootstrap.ts';

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
  private vectorIterativeScan?: Promise<boolean>;
  /** Transaction clones keep chunk invalidation and replacement atomic. */
  private _chunkWritesInTransaction = false;
  private _checkpointGuard: PgliteCheckpointGuard | undefined;
  readonly kind = 'pglite' as const;
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
    return pgliteExecutor(this.db);
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
        await dropRowTypeArrayParsers(this.db);
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
    // Embedded WASM/fsBundle/extension assets (Bun vfs #1340). Resolved once
    // here so both the initial create and the WAL-repair retry below share the
    // same compiled modules. Its `extensions` replaces the stock vector/pg_trgm.
    const embedded = await getEmbeddedPgliteOptions();
    try {
      this._db = this._attachDatabase(await preservingProcessExitCode(() =>
        PGlite.create({
          dataDir,
          loadDataDir,
          ...embedded,
        }),
      ));
      // Snapshot-timezone parity: dumpDataDir bakes the BUILD process's
      // TimeZone into the restored cluster's defaults, so a snapshot-loaded
      // engine would run sessions in the build machine's zone while a
      // cold-init engine follows this process (bun test pins TZ=UTC; bun run
      // follows the host). That divergence shifted every naive-timestamp
      // day-boundary comparison by the offset — date-dependent tests failed
      // only in the evening, only under the snapshot. Pin the session to the
      // RUNTIME zone so restored engines behave exactly like cold ones.
      if (this._snapshotLoaded && this._db) {
        const runtimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        await this._db.query(`SELECT set_config('TimeZone', $1, false)`, [runtimeZone]);
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
    // applied. Nothing to do. Returns immediately.
    if (this._snapshotLoaded) {
      return;
    }
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
    } catch { /* gateway not configured — use defaults */ }

    const storedIdentity = await readStoredEmbeddingIdentity(this);
    if (storedIdentity) {
      if (!storedIdentity.model) throw new Error('Stored embedding model is unknown. Run gbrain migrate embeddings --status and explicitly migrate before schema initialization.');
      dims = storedIdentity.dimensions;
      model = storedIdentity.model;
    }
    await this.applyForwardReferenceBootstrap();
    await this.db.exec(getPGLiteSchema(dims, model));

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      process.stderr.write(`  ${applied} migration(s) applied\n`);
    }
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

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
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

  async transactionDirect<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  // Pages CRUD
  async getPage(slug: string, opts?: PageSnapshotOptions): Promise<Page | null> {
    return (await this.readPageSnapshot(slug, opts))?.page ?? null;
  }

  async readPageSnapshot(slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
    return readCanonicalPageSnapshot(this.executeRaw.bind(this), slug, opts);
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

  private _pageTransaction = false;

  async putPage(slug: string, page: PageInput, opts?: PageWriteOptions): Promise<Page> {
    slug = validateSlug(slug);
    return this.transaction(async tx => {
      const sourceId = opts?.sourceId ?? 'default';
      await tx.lockPageKeys([{ sourceId, slug }]);
      if (opts?.expectedRevision !== undefined || opts?.force !== undefined) {
        assertPageRevision(await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true }), opts);
      }
      return pagesImpl.putPage((tx as PGLiteEngine).engineSql, slug, page, opts, (s, src) => tx.getPage(s, { sourceId: src }));
    });
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
    // Parity with PostgresEngine.migrateFactsToCanonical. UPDATE preserves
    // every column except entity_slug + source_markdown_slug + row_num,
    // which is offset past canonical's current MAX(row_num) (#4558; NULL
    // stays NULL, expired rows count — see the Postgres twin). Active rows
    // only (expired_at IS NULL) so we don't disturb the supersession audit
    // trail.
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

  async getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>> {
    return pagesImpl.getAllSlugs(scopedRead(this.engineSql), opts);
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
  // See postgres-engine.ts:listPrefixSampledPages for the ranking + source-scope rationale.
  // PGLite runs the same SQL (Postgres 17.5 under the hood) with positional `$N` binding.
  async listPrefixSampledPages(opts: DomainBankSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listPrefixSampledPages(async read => read(scopedRead(this.engineSql)), opts);
  }

  async listCorpusSample(opts: CorpusSampleOpts): Promise<DomainBankRow[]> {
    return pagesImpl.listCorpusSample(async read => read(scopedRead(this.engineSql)), opts);
  }

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
    const visibilityClause = buildVisibilityClause('p', 's', opts);

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

    const keywordSql =
      `WITH ranked AS (
         SELECT
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
           -- v0.27.1: hide image rows from default text-keyword search so
           -- OCR text doesn't drown text-page hits. Image-similarity queries
           -- run a separate vector path on embedding_image.
           AND cc.modality = 'text'
         ORDER BY score DESC, page_id ASC, chunk_id ASC
         LIMIT $2
       ),
       ${buildBestPerPagePoolCte('ranked')}
       SELECT * FROM best_per_page
       ORDER BY score DESC, page_id ASC, chunk_id ASC
       LIMIT $3 OFFSET $4`;

    let { rows } = await this.db.query(keywordSql, params);
    // D2 fix (fix/title-retrieval-arm): websearch AND semantics at chunk
    // grain mean one non-co-occurring token zeroes keyword recall. When the
    // strict query returns nothing, retry ONCE with OR-of-terms. Strict-AND
    // results always win when non-empty (no change for working queries).
    // Opt-in via SearchOpts.orFallback (Reviewer F1): only hybridSearch's
    // recall arm relaxes; precision consumers (countMentions,
    // link-extraction, eval) keep the strict-AND contract.
    if (rows.length === 0 && opts?.orFallback) {
      const orQuery = buildOrFallbackWebsearchQuery(query);
      if (orQuery) {
        const fallbackParams = [...params];
        fallbackParams[0] = orQuery;
        ({ rows } = await this.db.query(keywordSql, fallbackParams));
        settle();
        // 2026-09 (#3617 follow-up): relaxed rows are TAGGED so hybrid's
        // fusion can demote them — an OR-of-common-terms match must not
        // outvote a healthy vector arm (SearchResult.keyword_relaxed doc).
        return (rows as Record<string, unknown>[]).map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
      }
    }

    settle();
    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  /**
   * fix/title-retrieval-arm (D1): page-grain title candidate arm. SQL lives
   * once in engine-sql/titles.ts (exact-title key #5889, index-backed remote
   * predicate). CJK queries fall through to websearch FTS (a single-token CJK
   * query CAN exact-match a single-token CJK title); the richer CJK ILIKE
   * fallback stays keyword-arm-only.
   */
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
    return searchKeywordCJK(async (read) => read(scopedRead(this.engineSql)), query, ctx);
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
    const visibilityClause = buildVisibilityClause('p', 's', opts);

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
    const stmt = buildVectorSearchStatement({ dialect: 'pglite', embedding, limit, offset: opts?.offset || 0, opts });
    this.vectorIterativeScan ??= this.executeRaw<{ extversion: string }>(VECTOR_EXTENSION_VERSION_SQL)
      .then(rows => supportsHnswIterativeScan(rows[0]?.extversion));
    const probe = this.vectorIterativeScan;
    let iterative: boolean;
    try { iterative = await probe; }
    catch (error) {
      if (this.vectorIterativeScan === probe) this.vectorIterativeScan = undefined;
      throw error;
    }
    const rows = await searchVectorPool(limit, stmt.innerLimit, iterative, stmt.indexed, 'pglite',
      async ({ innerLimit: requested, maxScanTuples }) => this.db.transaction(async tx => {
        return withVectorSettings(async (sql, values) => (await tx.query<Record<string, unknown>>(sql, values)).rows, iterative, requested, maxScanTuples, async () => {
          const bound = [...stmt.params];
          bound[stmt.innerLimitIdx] = requested;
          return readVectorPool((await tx.query<Record<string, unknown>>(stmt.sql, bound)).rows);
        });
      }),
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
  async upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number } & BatchOpts): Promise<void> {
    if (this._chunkWritesInTransaction) return this._upsertChunksOnce(slug, chunks, opts);
    return this.batchRetry(opts?.auditSite ?? 'upsertChunks', opts?.signal,
      () => this.transaction(tx => (tx as PGLiteEngine)._upsertChunksOnce(slug, chunks, opts)), chunks.length);
  }

  private async _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; embeddingColumn?: ResolvedColumn; expectedRevision?: string; sealChunkerVersion?: number }): Promise<void> {
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

  async deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void> {
    return chunksImpl.deleteChunks(this.engineSql, slug, opts);
  }

  async countStalePagesForExtraction(opts?: { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked' }): Promise<number> {
    return pagesImpl.countStalePagesForExtraction(scopedRead(this.engineSql), opts);
  }

  async listStalePagesForExtraction(opts: {
    batchSize: number;
    afterPageId?: number;
    sourceId?: string;
    versionTs?: string;
  }): Promise<StalePageRow[]> {
    return pagesImpl.listStalePagesForExtraction(scopedRead(this.engineSql), opts);
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
    mode?: 'inbound' | 'islanded';
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
          AND (dim_status IS NULL OR dim_status = 'active')
        ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`,
      [sourceId, obs.entitySlug, dimension],
    );
    const current = cur.rows[0] as { id: number; value_hash: string; valid_from: string | null } | undefined;

    if (current && current.value_hash === vh && !isBackdatedObservation(validFrom, current.valid_from)) {
      // This provenance already observed the value during the current stint.
      const seen = await this.db.query(
        `SELECT 1 FROM facts
          WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND value_hash = $4 AND source_markdown_slug = $5
            AND COALESCE(valid_from,'-infinity'::timestamptz) >= COALESCE($6::timestamptz,'-infinity'::timestamptz) LIMIT 1`,
        [sourceId, obs.entitySlug, dimension, vh, obs.source, current.valid_from],
      );
      if (seen.rows.length) return { action: 'noop', factId: null, supersededId: null };
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
        await this.db.query(
          `UPDATE facts SET valid_until = COALESCE($1::timestamptz, now()), superseded_by = $2 WHERE id = $3 AND valid_until IS NULL`,
          [validFrom, newId, current.id],
        );
        supersededId = current.id;
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
    // Page-visibility gate on the provenance page, applied BEFORE DISTINCT ON
    // so the untrusted caller resolves the newest value they may see.
    const privacy = opts?.excludePrivate ? `AND ${privateProvenanceFilterFragment('facts')}` : '';
    params.push(opts?.visibility ?? null);
    const visibility = `AND ($${params.length}::text[] IS NULL OR visibility = ANY($${params.length}::text[]))`;
    const r = await this.db.query(
      `SELECT DISTINCT ON (dimension) dimension, value, confidence,
         source_markdown_slug AS source, valid_from, valid_until AS valid_to,
         COALESCE(dim_status,'active') AS status, id AS fact_id
       FROM facts
       WHERE entity_slug = $1 AND dimension IS NOT NULL AND expired_at IS NULL ${scope} ${privacy} ${visibility}
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
       FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL ${scope}
       GROUP BY dimension ORDER BY entities DESC, dimension`,
      params,
    );
    return r.rows.map((row) => {
      const x = row as { dimension: string; entities: number; observations: number };
      return { dimension: x.dimension, entities: Number(x.entities), observations: Number(x.observations) };
    });
  }

  async findOntologyConflicts(opts?: PageReadScope & { minConfidence?: number; visibility?: OntologyReadOpts['visibility'] }): Promise<OntologyConflict[]> {
    const minConf = opts?.minConfidence ?? 0;
    const params: unknown[] = [minConf];
    let scope: string;
    if (opts?.sourceIds && opts.sourceIds.length) { params.push(opts.sourceIds); scope = `AND source_id = ANY($${params.length})`; }
    else { params.push(opts?.sourceId ?? null); scope = `AND ($${params.length}::text IS NULL OR source_id = $${params.length})`; }
    // Same provenance-page gate as getOntology, inside the CTE so a conflict
    // that only exists because of a hidden provenance is never reported.
    const privacy = opts?.excludePrivate ? `AND ${privateProvenanceFilterFragment('facts')}` : '';
    params.push(opts?.visibility ?? null);
    const visibility = `AND ($${params.length}::text[] IS NULL OR visibility = ANY($${params.length}::text[]))`;
    const r = await this.db.query(
      `WITH cur AS (
         SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
         FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL
           AND (dim_status IS NULL OR dim_status = 'active') AND confidence >= $1 ${scope} ${privacy} ${visibility}
       )
       SELECT entity_slug, dimension,
              json_agg(json_build_object('value', value, 'source', source, 'confidence', confidence, 'fact_id', fact_id)) AS values
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
    if (opts?.excludePrivate) where.push(privatePagesFilterFragment('p'));
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
       WHERE ${where.join(' AND ')}`,
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

  async expireFact(id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean> {
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
    opts?: FactListOpts & { entitySlug?: string; sessionId?: string },
  ): Promise<FactRow[]> {
    return factsImpl.listFactsSince(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), source_id, since, opts);
  }

  async listFactsKeyset(
    source_id: string,
    after: { createdAt: string; id: number | null } | null,
    opts?: FactListOpts,
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
    opts?: { since?: Date; limit?: number; visibility?: ('private' | 'world')[] },
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

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    return factsImpl.findTrajectory(unscopedExecutor(this.engineSql, 'facts: unscoped on master (EO4 inventory)'), opts);
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    return factsImpl.consolidateFact(this.engineSql, id, takeId);
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

  async searchTakes(
    query: string,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakes(unscopedExecutor(this.engineSql, 'takes: unscoped on master (EO4 inventory)'), query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
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
  async createVersion(slug: string, opts?: { sourceId?: string; preimage?: PageSnapshot }): Promise<PageVersion> {
    return createPageVersion(this, slug, opts?.sourceId ?? 'default', opts?.preimage);
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
    }));
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

  async getIngestLog(opts?: { limit?: number; sourceIds?: string[] }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    // Source-scope for remote / federated callers; unscoped only for trusted
    // local callers (mirrors the postgres engine).
    const scoped = opts?.sourceIds && opts.sourceIds.length > 0;
    const { rows } = await this.db.query(
      scoped
        ? `SELECT * FROM ingest_log WHERE source_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT $1`
        : `SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT $1`,
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

  async setPageAliases(slug: string, sourceId: string, aliasNorms: string[]): Promise<void> {
    return this.transaction(tx => pagesImpl.setPageAliases((tx as PGLiteEngine).engineSql, tx, slug, sourceId, aliasNorms));
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

  async getAllConfig(): Promise<Record<string, string>> {
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
    return getEdgesByChunkPglite(this.codeEdgesDeps, chunkId, opts);
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
