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
  TakeBatchInput, Take, TakesListOpts, TakeHit, StaleTakeRow, TakeEmbeddingInput,
  TakeResolution, SynthesisEvidenceInput,
  TakesScorecard, TakesScorecardOpts, CalibrationBucket, CalibrationCurveOpts,
  FactRow, FactInsertStatus,
  NewFact, FactListOpts, FactsHealth,
  SourceRow,
} from './engine.ts';
import { DREAM_VERDICT_TTL_SECONDS, MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
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
  isNovelDimension,
} from './chronicle/ontology.ts';
import { logBatchRetry as auditLogBatchRetry, logBatchExhausted as auditLogBatchExhausted } from './audit/batch-retry-audit.ts';
import { runMigrations } from './migrate.ts';
import { hnswEfSearchFor, hnswIndexExpected, HNSW_EF_SEARCH_MAX } from './vector-index.ts';
import { PGLITE_SCHEMA_SQL, getPGLiteSchema } from './pglite-schema.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';
import { DELETE_BATCH_SIZE } from './engine-constants.ts';
import { PageMissingError } from './engine-errors.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from './source-config-sql.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
// Engine-live path (#3596): static import, never a lazy `import()` in the
// connect() catch. No cycle: pglite-repair.ts imports nothing from this file.
import { attemptWalRepairAndRetry, closeRepairEpisodeIfOpen, type WalRepairReceipt } from './pglite-repair.ts';
import { getFtsLanguage } from './fts-language.ts';
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
import { PAGE_SORT_SQL, MIN_ENTITY_PAGES_FOR_COVERAGE } from './types.ts';
import { finalizeLastSeen } from './chronicle/last-seen.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause, buildBestPerPagePoolCte, buildOrFallbackWebsearchQuery, boundWebsearchQuery } from './search/sql-ranking.ts';
import { privatePagesFilterFragment } from './search/private-visibility.ts';
import { unverifiedExtractionFragment } from './extraction-review.ts';
import { shouldExcludeFromOrphanReporting, loadOrphanPolicyOverrides } from './orphan-policy.ts';
import { LINK_EXTRACTOR_VERSION_TS } from './link-extraction.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from './embed-skip.ts';
import { QUARANTINE_FILTER_FRAGMENT } from './quarantine.ts';
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
import { hasCJK } from './cjk.ts';
import * as factsImpl from './pglite-engine/facts.ts';
import type { PgliteFactsDeps } from './pglite-engine/facts.ts';
import * as takesImpl from './pglite-engine/takes.ts';
import type { PgliteTakesDeps } from './pglite-engine/takes.ts';
import * as codeEdgesImpl from './pglite-engine/code-edges.ts';
import type { PgliteCodeEdgesDeps } from './pglite-engine/code-edges.ts';
import * as salienceImpl from './pglite-engine/salience.ts';
import type { PgliteSalienceDeps } from './pglite-engine/salience.ts';
import { searchKeywordCJK } from './pglite-engine/cjk-search.ts';

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

// Per-process memo. MIGRATIONS + PGLITE_SCHEMA_SQL are static for the life of
// the process, so the schema hash is too; the version file and the ~42MB tar
// are read once per (path, process) instead of once per engine construction
// (a full suite constructs 600+ engines — the un-memoized loader re-read the
// tar and re-hashed 131 migration handler sources every time, ~84MB of
// transient allocation per call). A null entry means the path is terminally
// unusable this process (missing/stale/torn) — no retry per construction.
// The dims/model shape gate is deliberately NOT memoized: tests reconfigure
// the gateway mid-process (zembed/1280) and a mismatched engine must fall
// back to cold init even when an earlier engine loaded this same snapshot.
// Accepted limitation: a snapshot file rewritten mid-process is not observed;
// the only writer (build-pglite-snapshot.ts) runs before test fan-out.
let _snapshotSchemaHashMemo: string | null = null;
// blob stays null until the FIRST caller whose shape gate passes — a process
// whose gateway shape never matches the snapshot (the zembed/1280 test
// files) never pays the 42MB tar read at all.
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
  // Instrumentation-immune schema hash: the raw FILE BYTES of migrate.ts +
  // pglite-schema.ts, resolved relative to this module.
  //
  // The previous form hashed the in-memory MIGRATIONS array, folding each
  // migration handler's Function.prototype.toString (W0 D5.13 — editing a
  // handler must stale the snapshot). But coverage instrumentation rewrites
  // LOADED function bodies, so under `bun test --coverage` (every CI shard)
  // the runtime hash never matched the plain-`bun run` builder's, and every
  // CI engine silently cold-initted ("snapshot stale") — a permanent
  // CI-vs-local timing divergence that amplified ordering flakes. File bytes
  // keep the D5.13 property (a handler edit edits the file) and are identical
  // under any loader, runtime, or instrumentation. They are also the same
  // inputs CI's snapshot-cache key hashes, so builder, engine, and cache can
  // no longer disagree in kind.
  //
  // Returns null when the source files are unreadable (compiled binary) —
  // the snapshot is a dev/test fixture; no-snapshot is the safe answer there.
  try {
    const hash = crypto.createHash('sha256');
    hash.update('files:v2\n');
    hash.update(fs.readFileSync(new URL('./migrate.ts', import.meta.url)));
    hash.update('\n--\n');
    hash.update(fs.readFileSync(new URL('./pglite-schema.ts', import.meta.url)));
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
        '    1. gbrain pglite-repair --dry-run   (diagnose, mutates nothing)\n' +
        '       gbrain pglite-repair --yes       (in-place WAL repair, data preserved)\n' +
        '    2. Rebuild from your brain repo: `gbrain reinit-pglite` (or manually:\n' +
        '       back up ~/.gbrain, move brain.pglite aside, `gbrain init --pglite`,\n' +
        '       re-add sources + `gbrain sync` + `gbrain embed`).\n' +
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
    `    Data files were preserved; transactions not checkpointed before the`,
    `    corruption may be lost (the standard pg_resetwal caveat).`,
    `    Pre-repair backup: ${receipt.backupPath}`,
    `    Recommended: run \`gbrain doctor\` to verify brain integrity.`,
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

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    this._savedConfig = config; // #2034: remember for reconnect()
    this.walRepairReceipt = null; // per-connect: stale receipts must not survive reconnect()
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
    // Embedded WASM/fsBundle/extension assets (Bun vfs #1340). Resolved once
    // here so both the initial create and the WAL-repair retry below share the
    // same compiled modules. Its `extensions` replaces the stock vector/pg_trgm.
    const embedded = await getEmbeddedPgliteOptions();
    try {
      this._db = await preservingProcessExitCode(() =>
        PGlite.create({
          dataDir,
          loadDataDir,
          ...embedded,
        }),
      );
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
            this._db = attempt.db;
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

      const wrapped = new Error(buildPgliteInitErrorMessage(verdict, original, process.platform, ctx));
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
    if (!db && !lock) return; // already disconnected — nothing to drain or close

    // #4284 — out-of-band watchdog (opt-in; see pgliteCloseWatchdogMs). Armed
    // ONLY when a live handle exists (a lock-only teardown has no close to
    // wedge) and BEFORE the drain so a drain-side wedge is covered too.
    // Scope: a PGLite disconnect with a live handle — nothing else. Disposed
    // in the outer finally below, even when the drain or releaseLock throws.
    let watchdog: { dispose(): void } | null = null;
    if (db) {
      const { deadlineMs, graceMs } = pgliteCloseWatchdogMs();
      if (deadlineMs > 0) {
        watchdog = installProcessWatchdog({
          deadlineMs,
          graceMs,
          label: 'pglite-disconnect-watchdog',
        });
        // Keyed by the computed deadline (not once-per-process flat): in a
        // long-lived daemon the drain-aware floor grows as sinks register, and
        // this breadcrumb is the kill's attribution surface — it must re-fire
        // when the effective deadline changes (#4284 red-team).
        warnOncePerProcess(
          `pglite-close-watchdog-armed:${deadlineMs}:${graceMs}`,
          `[pglite] disconnect watchdog armed: SIGTERM at ${deadlineMs}ms, SIGKILL at ${deadlineMs + graceMs}ms (out-of-band worker thread — fires even if the event loop wedges; #4284).`,
        );
      }
    }

    try {
      // #4143: drain in-flight background work AFTER the early-null and BEFORE
      // close(). PGLite's close() deadlocks PERMANENTLY — close's promise AND
      // the in-flight query's promise never settle — when any statement is in
      // flight (the trigger was the telemetry flush issuing two sequential
      // INSERTs). Ordering is load-bearing: the early-null means no NEW
      // statement can reach the raw handle (drainer writes fail fast with
      // 'PGLite not connected' and are swallowed — that is intended), while
      // statements ALREADY in flight settle against the still-open handle.
      // Reordering the drain above the null would reopen the #1337 race.
      // Inside the try (#4284 red-team): the drain is contractually
      // non-throwing, but the no-leaked-armed-worker guarantee must be
      // structural, not contractual — a throw here still reaches the
      // finally's releaseLock + dispose.
      await drainBackgroundWorkBeforeDisconnect();
      if (db) {
        // #3893 (reimplemented from @y2688): best-effort WAL flush BEFORE
        // close(). A clean close() checkpoints on its own, but the #4143
        // class below means close can time out or wedge and be abandoned —
        // an explicit pre-close CHECKPOINT makes the data files current so
        // an abandoned close loses no committed rows. PGLite-only by design
        // (no postgres-engine parity twin): a server Postgres owns its own
        // checkpointer and survives this process dying. Bounded by the same
        // close timeout and never throwing — a slow or failed CHECKPOINT
        // must not block teardown. Runs after the drain so it is the only
        // statement in flight when it executes.
        let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            db.query('CHECKPOINT').catch(() => undefined),
            new Promise<void>((resolve) => {
              checkpointTimer = setTimeout(resolve, pgliteCloseTimeoutMs());
            }),
          ]);
        } finally {
          if (checkpointTimer) clearTimeout(checkpointTimer);
        }

        // Deliberately NOT wrapped in preservingProcessExitCode: close's
        // status write (0) is long-standing baseline behavior that test-runner
        // processes depend on (wrapping it flipped bun test's own exit code —
        // #2084 implementation note), and the CLI's exit verdict doesn't read
        // process.exitCode at all — it lives in the gbrain-owned channel
        // (setCliExitVerdict/currentExitCode in cli-force-exit.ts).
        //
        // #4143/#4284 in-loop bound — HONEST SCOPE: catches a close that
        // still YIELDS (slow, or promise-deadlocked with an idle loop). It
        // can NEVER fire against a close that wedges the event loop (#4284):
        // the timers phase doesn't run, so no same-loop timer wins this
        // race. That class is prevented by the drain above; the opt-in
        // watchdog is the only observer. The timer is armed BEFORE close()
        // is called so close's pre-first-yield work runs with the bound
        // already ticking, and it is deliberately REF'D (no unref): in the
        // one case this bound can catch, an unref'd timer would let Bun exit
        // before the warn and the lock release fire (precedent:
        // cli-force-exit.ts adversarial F3, db-pacer.ts). Deliberately NOT
        // timeout.ts:withTimeout — it unrefs its timer and rejects; this
        // site needs a ref'd race that resolves a flag. A close-throw still
        // propagates (lock releases in finally, same as before). Note for
        // reconnect(): a timed-out close leaves a zombie instance briefly
        // coexisting with a re-opened dataDir — the WAL-repair path covers
        // the consequence on next open.
        const timeoutMs = pgliteCloseTimeoutMs();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timedOutPromise = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), timeoutMs);
          });
          const closePromise = db.close();
          const timedOut = await Promise.race([
            closePromise.then(() => false),
            timedOutPromise,
          ]);
          if (timedOut) {
            warnOncePerProcess(
              'pglite-close-timeout',
              `[pglite] db.close() did not settle within ${timeoutMs}ms — proceeding with teardown (a statement may still be in flight; #4143). Override with GBRAIN_PGLITE_CLOSE_TIMEOUT_MS. A close that WEDGES the event loop cannot be caught by this in-loop bound — arm GBRAIN_PGLITE_CLOSE_WATCHDOG_MS for the out-of-band watchdog (#4284).`,
            );
            // Abandoned close may reject later — never let it become an
            // unhandled rejection.
            closePromise.catch(() => { /* abandoned after timeout */ });
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      try {
        if (lock?.acquired) {
          await releaseLock(lock);
        }
      } finally {
        // #4284: dispose even when releaseLock throws — a leaked armed worker
        // would SIGTERM/SIGKILL a process whose close already completed.
        watchdog?.dispose();
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
      // Keep the gateway lazy: its static closure is large, and evaluation inside
      // this try/catch preserves the unconfigured-gateway default fallback.
      const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
      // Both accessors THROW when the gateway is unconfigured (they never
      // return falsy), so the catch below is the only fallback path (#3461).
      dims = gw.getEmbeddingDimensions();
      model = gw.getEmbeddingModel();
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
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='oauth_clients' AND column_name='surface') AS oauth_clients_surface_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='oauth_clients' AND column_name='surface_set_by') AS oauth_clients_surface_set_by_exists,
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
                WHERE table_schema='public' AND table_name='pages' AND column_name='links_extracted_at') AS pages_links_extracted_at_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='timeline_entries') AS timeline_entries_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='timeline_entries' AND column_name='event_page_id') AS timeline_event_page_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='minion_jobs') AS minion_jobs_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='minion_jobs' AND column_name='timeout_at') AS minion_jobs_timeout_at_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='minion_jobs' AND column_name='idempotency_key') AS minion_jobs_idempotency_key_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='minion_jobs' AND column_name='private_queue_owner_job_id') AS minion_jobs_pq_owner_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='minion_jobs' AND column_name='private_queue_owner_token') AS minion_jobs_pq_token_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='minion_jobs' AND column_name='private_queue_lease_until') AS minion_jobs_pq_lease_exists
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
      oauth_clients_surface_exists: boolean;
      oauth_clients_surface_set_by_exists: boolean;
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
      timeline_entries_exists: boolean;
      timeline_event_page_id_exists: boolean;
      minion_jobs_exists: boolean;
      minion_jobs_timeout_at_exists: boolean;
      minion_jobs_idempotency_key_exists: boolean;
      minion_jobs_pq_owner_exists: boolean;
      minion_jobs_pq_token_exists: boolean;
      minion_jobs_pq_lease_exists: boolean;
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
    // WP4 (v127): oauth_clients.surface + surface_set_by. No PGLITE_SCHEMA_SQL
    // index references them, but the columns are migration-added AND in the
    // blob's CREATE TABLE — the exact v121 mask class — so the bootstrap adds
    // them defense-in-depth (and satisfies the MIGRATIONS ADD COLUMN
    // coverage gate). They ship in one migration and go missing together.
    const needsOauthClientsSurface = probe.oauth_clients_exists
      && (!probe.oauth_clients_surface_exists || !probe.oauth_clients_surface_set_by_exists);
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
    // v121: schema-blob indexes reference event_page_id before migrations run.
    const needsTimelineEventPageId = probe.timeline_entries_exists && !probe.timeline_event_page_id_exists;
    // v7-era (#2626 class sweep): minion_jobs.timeout_at + idempotency_key are
    // migration-added AND referenced by blob indexes (idx_minion_jobs_timeout,
    // uniq_minion_jobs_idempotency) — a pre-v7 minion_jobs wedges blob replay
    // exactly like the v121 incident.
    const needsMinionJobsTimeoutAt = probe.minion_jobs_exists && !probe.minion_jobs_timeout_at_exists;
    const needsMinionJobsIdempotencyKey = probe.minion_jobs_exists && !probe.minion_jobs_idempotency_key_exists;
    // Token rides the probe too: a token-only-missing brain (partial upgrade)
    // would otherwise be unrepairable — the ALTER block adds all three.
    const needsMinionJobsPrivateQueue = probe.minion_jobs_exists
      && (!probe.minion_jobs_pq_owner_exists || !probe.minion_jobs_pq_token_exists
          || !probe.minion_jobs_pq_lease_exists);

    // Fresh installs (no tables yet) and modern brains both no-op.
    if (!needsPagesBootstrap && !needsLinksBootstrap && !needsChunksBootstrap
        && !needsPagesDeletedAt && !needsChunksEmbeddingImage
        && !needsMcpLogBootstrap && !needsSubagentProviderId
        && !needsPagesRecency && !needsIngestLogSourceId
        && !needsFilesBootstrap && !needsOauthClientsBootstrap
        && !needsOauthClientsSurface
        && !needsSourcesArchive && !needsPagesLastRetrievedAt
        && !needsPagesProvenance
        && !needsContextualRetrievalColumns && !needsPagesGeneration
        && !needsPagesEmbeddingSignature
        && !needsPagesLinksExtractedAt
        && !needsTimelineEventPageId
        && !needsMinionJobsTimeoutAt && !needsMinionJobsIdempotencyKey
        && !needsMinionJobsPrivateQueue) return;

    process.stderr.write('  Schema forward-reference gap detected, applying bootstrap\n');

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

    if (needsOauthClientsSurface) {
      // WP4 (v127): per-client MCP tool surface + operator-lock marker.
      // Nullable TEXT, no index — bootstrap mirrors the v127 column shape so
      // the blob's CREATE TABLE presence can't mask the forward reference on
      // pre-v127 brains (the v121 wedge class). v127 runs later via
      // runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT;
        ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT;
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

    if (needsTimelineEventPageId) {
      // Add only the forward-referenced column. Migration v121 remains the
      // source of truth for the FK and indexes and runs idempotently afterward.
      await this.db.exec(`
        ALTER TABLE timeline_entries ADD COLUMN IF NOT EXISTS event_page_id INTEGER;
      `);
    }

    if (needsMinionJobsTimeoutAt) {
      // v7: blob index idx_minion_jobs_timeout references timeout_at; a
      // pre-v7 minion_jobs wedges blob replay without it (same class as v121).
      await this.db.exec(`
        ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
      `);
    }
    if (needsMinionJobsIdempotencyKey) {
      // v7: blob index uniq_minion_jobs_idempotency references idempotency_key.
      await this.db.exec(`
        ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      `);
    }
    if (needsMinionJobsPrivateQueue) {
      // v0.46.26: blob indexes idx_minion_jobs_private_queue_recovery /
      // idx_minion_jobs_private_queue_owner reference the private-queue
      // owner/lease columns; a pre-upgrade minion_jobs wedges blob replay
      // without them (same class as v121). The token column is not indexed
      // but rides along so upgraded rows carry the full lifecycle shape.
      await this.db.exec(`
        ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL;
        ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_token TEXT;
        ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_lease_until TIMESTAMPTZ;
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

  // NOTE: the tx-engine handed to `fn` proxies `db` to a PGLite Transaction,
  // which has query/sql/exec but NO .transaction — so engine methods that
  // open their own transaction (searchVector since #3613) will throw if
  // called on the tx-engine. No current callback does; keep it that way or
  // add pass-through nesting first.
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
    // #3931: anchor the tiebreak on sourceIds[0] (the caller's own resolved
    // source — see localFederatedSourceIds) instead of a hardcoded 'default',
    // so a shadowed slug resolves to the caller's own copy.
    const anchorSourceId = sourceIds && sourceIds.length > 0 ? sourceIds[0] : 'default';
    params.push(anchorSourceId);
    const anchorParamIdx = params.length;
    const { rows } = await this.db.query(
      `SELECT id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, deleted_at,
              effective_date, effective_date_source,
              source_kind, source_uri, ingested_via, ingested_at,
              contextual_retrieval_mode
       FROM pages WHERE ${where.join(' AND ')}
       ORDER BY (source_id = $${anchorParamIdx}) DESC, source_id ASC
       LIMIT 1`,
      params
    );
    // Deterministic multi-source tiebreak: anchor-source-first, then stable
    // alpha. Engine parity: postgres-engine.ts carries the identical clause.
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

  async putPage(slug: string, page: PageInput, opts?: { sourceId?: string; allowEmptyOverwrite?: boolean }): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};
    const sourceId = opts?.sourceId ?? 'default';

    // Data-loss guard (mirrors postgres-engine.ts): a page edit is a
    // read-modify-write; if the read returned empty, the modify lands on
    // nothing and this upsert would blank the body over real content. Only
    // fires when the incoming body is itself blank. Deletes use deletePage; a
    // deliberate clear passes allowEmptyOverwrite. See isBlankBody.
    if (isBlankBody(page.compiled_truth) && !opts?.allowEmptyOverwrite) {
      const { rows: prior } = await this.db.query<{ compiled_truth: string | null }>(
        `SELECT compiled_truth FROM pages
         WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [sourceId, slug],
      );
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now(), $10::timestamptz, $11, $12, COALESCE($13, ${MARKDOWN_CHUNKER_VERSION}), $14, $15, $16, $17, $18::timestamptz)
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
       RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, effective_date, effective_date_source, import_filename, source_kind, source_uri, ingested_via, ingested_at`,
      [sourceId, slug, page.type, pageKind, sanitizeText(page.title), sanitizeText(page.compiled_truth), sanitizeText(page.timeline || ''), JSON.stringify(frontmatter), hash, effectiveDate, effectiveDateSource, importFilename, chunkerVersion, sourcePath, sourceKind, sourceUri, ingestedVia, ingestedAt]
    );
    // PGLite can return zero rows from INSERT ... ON CONFLICT DO UPDATE ...
    // RETURNING in no-op/trigger edge cases, which made rowToPage(undefined)
    // throw "undefined is not an object (evaluating 'row.deleted_at')" and
    // skip the file during sync. The row WAS written, so re-read instead of
    // crashing.
    if (rows.length === 0) {
      const reread = await this.getPage(slug, { sourceId });
      if (reread) return reread;
      throw new Error(`putPage: RETURNING produced no row for ${sourceId}/${slug}`);
    }
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
    if (slugs.length === 0) return [];
    if (slugs.length > DELETE_BATCH_SIZE) {
      throw new Error(
        `softDeletePages: input size ${slugs.length} exceeds DELETE_BATCH_SIZE=${DELETE_BATCH_SIZE}. Caller must chunk.`,
      );
    }
    const { rows } = await this.db.query<{ slug: string }>(
      'UPDATE pages SET deleted_at = now() WHERE slug = ANY($1::text[]) AND source_id = $2 AND deleted_at IS NULL RETURNING slug',
      [slugs, opts.sourceId],
    );
    return rows.map(r => r.slug);
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

  async purgeDeletedPages(
    olderThanHours: number,
    opts?: { dryRun?: boolean },
  ): Promise<{ slugs: string[]; count: number; pages?: { slug: string; deleted_at: Date }[] }> {
    // Clamp to non-negative integer; cascade through FKs (content_chunks,
    // page_links, chunk_relations) on DELETE.
    const hours = Math.max(0, Math.floor(olderThanHours));
    if (opts?.dryRun) {
      // SAME WHERE predicate as the DELETE below (same cutoff arithmetic,
      // same DB now() clock source) — only the verb differs, so preview and
      // purge agree modulo rows crossing the cutoff between statements.
      const { rows } = await this.db.query(
        `SELECT slug, deleted_at FROM pages
         WHERE deleted_at IS NOT NULL
           AND deleted_at < now() - ($1 || ' hours')::interval
         ORDER BY deleted_at ASC, slug ASC`,
        [hours]
      );
      const pages = (rows as { slug: string; deleted_at: Date | string }[]).map((r) => ({
        slug: r.slug,
        deleted_at: r.deleted_at instanceof Date ? r.deleted_at : new Date(r.deleted_at),
      }));
      return { slugs: pages.map((p) => p.slug), count: pages.length, pages };
    }
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
    if (filters?.updatedAfterKeyset) {
      // v0.45.7 keyset: (updated_at, slug) strict-greater — supersedes updated_after.
      params.push(filters.updatedAfterKeyset.updatedAt);
      const tsIdx = params.length;
      params.push(filters.updatedAfterKeyset.slug);
      const slugIdx = params.length;
      where.push(
        `(p.updated_at > $${tsIdx}::timestamptz OR (p.updated_at = $${tsIdx}::timestamptz AND p.slug > $${slugIdx}))`,
      );
    } else if (filters?.updated_after) {
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
    // #4352: untrusted-caller private-page filter (see PageFilters.excludePrivate).
    if (filters?.excludePrivate === true) {
      where.push(privatePagesFilterFragment('p'));
    }
    if (filters?.effective_after) {
      params.push(filters.effective_after);
      where.push(`p.effective_date >= $${params.length}::timestamptz`);
    }
    if (filters?.effective_before) {
      params.push(filters.effective_before);
      where.push(`p.effective_date <= $${params.length}::timestamptz`);
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

  async listAllPageRefs(): Promise<Array<{ slug: string; source_id: string; updated_at: Date }>> {
    // v0.32.8: see postgres-engine.ts:listAllPageRefs for context. ORDER BY
    // (source_id, slug) for determinism; WHERE deleted_at IS NULL matches
    // default page visibility. #4304: updated_at projected so --since walks
    // can filter refs before any full-page fetch.
    const { rows } = await this.db.query(
      `SELECT slug, source_id, updated_at FROM pages
       WHERE deleted_at IS NULL
       ORDER BY source_id, slug`
    );
    return (rows as { slug: string; source_id: string; updated_at: string | Date }[]).map(r => ({
      slug: r.slug,
      source_id: r.source_id,
      updated_at: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    }));
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
    // Parity with postgres-engine.updateSourceConfig: normalize historical
    // string/array shapes atomically before the JSONB patch merge.
    const result = await this.db.query<{ id: string }>(
      `UPDATE sources
          SET config = ${SOURCE_CONFIG_OBJECT_SQL} || $1::jsonb
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
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });

    // v0.32.7: CJK query branch. PGLite uses websearch_to_tsquery('english')
    // which can't tokenize CJK; queries return empty. Switch to ILIKE on
    // chunk_text with term-frequency-count ranking when the query contains
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
         ORDER BY score DESC
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
      }
    }

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
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
   *
   * CJK queries fall through to websearch FTS here (a single-token CJK
   * query CAN exact-match a single-token CJK title); the richer CJK ILIKE
   * fallback stays keyword-arm-only.
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

    const params: unknown[] = [boundWebsearchQuery(query), limit, offset];
    let extraFilter = '';
    if (opts?.type) {
      params.push(opts.type);
      extraFilter += ` AND p.type = $${params.length}`;
    }
    if (opts?.types && opts.types.length > 0) {
      params.push(opts.types);
      extraFilter += ` AND p.type = ANY($${params.length}::text[])`;
    }
    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs);
      extraFilter += ` AND p.slug != ALL($${params.length}::text[])`;
    }
    if (opts?.afterDate) {
      params.push(opts.afterDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) > $${params.length}::timestamptz`;
    }
    if (opts?.beforeDate) {
      params.push(opts.beforeDate);
      extraFilter += ` AND COALESCE(p.effective_date, p.updated_at, p.created_at) < $${params.length}::timestamptz`;
    }
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      extraFilter += ` AND p.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      extraFilter += ` AND p.source_id = $${params.length}`;
    }

    // Page grain — one row per page by construction, so no best_per_page
    // pooling CTE is needed. The LEFT JOIN LATERAL picks the representative
    // chunk (compiled_truth first, then lowest chunk_index); COALESCEs keep
    // chunkless pages retrievable (the extreme D1 case: a title with no
    // body) with the alias-hop row shape (chunk_id 0, empty chunk_text).
    // Accepted limitations (Reviewer F5/F6): the synthetic chunkless row
    // inherits the compiled-truth RRF boost and dedups on empty chunk_text;
    // and detail='low' filters only the REPRESENTATIVE — pages without a
    // compiled_truth chunk still surface (unlike the keyword arm's filter).
    const titlesSql =
      `SELECT
         p.slug, p.id as page_id, p.title, p.type, p.source_id,
         p.effective_date, p.effective_date_source,
         COALESCE(rep.id, 0) as chunk_id,
         COALESCE(rep.chunk_index, 0) as chunk_index,
         COALESCE(rep.chunk_text, '') as chunk_text,
         COALESCE(rep.chunk_source, 'compiled_truth') as chunk_source,
         ts_rank_cd(p.search_vector, websearch_to_tsquery('${ftsLang}', $1)) * ${sourceFactorCase} AS score,
         CASE WHEN p.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
         ) THEN true ELSE false END AS stale
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
         ${extraFilter} ${hardExcludeClause} ${visibilityClause}
       ORDER BY score DESC, p.id ASC
       LIMIT $2 OFFSET $3`;

    let { rows } = await this.db.query(titlesSql, params);
    if (rows.length === 0) {
      const orQuery = buildOrFallbackWebsearchQuery(params[0] as string);
      if (orQuery) {
        const fallbackParams = [...params];
        fallbackParams[0] = boundWebsearchQuery(orQuery);
        ({ rows } = await this.db.query(titlesSql, fallbackParams));
      }
    }
    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
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
    return searchKeywordCJK({ db: this.db }, query, ctx);
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
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });

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
    // issue #160: guard predicate projected as `unverified_stub` in
    // hnsw_candidates (parity with postgres-engine) so unverified stubs get
    // factor 1.0, not the people/ 1.2x, inside the pre-LIMIT re-rank.
    const sourceFactorCaseOnSlug = buildSourceFactorCase('slug', boostMap, opts?.detail, 'unverified_stub');
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    // v0.46.15 (retrieval-cathedral P1): bounded escalation — see
    // postgres-engine.ts searchVector for the full rationale; the logic here
    // is IDENTICAL (engine-parity pinned). Cap policy (R2-10 + codex ship
    // review): the ef_search ceiling applies only to HNSW-backed columns;
    // above-ceiling columns fall back to exact scans where capping the SQL
    // LIMIT would make offset >= 1000 permanently empty — those stay bounded
    // by the escalation count instead. (Hoisted resolvedColEarly: same
    // descriptor the cast fragment uses below.)
    const resolvedColEarly = normalizeEngineColumn(opts?.embeddingColumn);
    const innerCap = hnswIndexExpected(resolvedColEarly.type, resolvedColEarly.dimensions)
      ? HNSW_EF_SEARCH_MAX
      : Number.MAX_SAFE_INTEGER;
    const innerLimit = Math.min(offset + Math.max(limit * 5, 100), innerCap);

    const params: unknown[] = [vecStr, innerLimit, limit, offset];
    const innerLimitIdx = 1; // mutated by the escalation loop
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
    const visibilityClause = buildVisibilityClause('p', 's', { excludePrivate: opts?.excludePrivate === true });

    // v0.36 (D11): column routing via resolved descriptor. Engine doesn't
    // read config — caller resolved at hybrid/op boundary. The cast SQL
    // ($1::vector vs $1::halfvec(N)) comes from buildVectorCastFragment.
    //
    // v0.36 Phase 3: 'embedding_multimodal' is the unified column populated
    // by `gbrain reindex --multimodal`. No modality filter — the column
    // itself is the discriminator (only re-embedded rows have non-NULL).
    const resolvedCol = resolvedColEarly;
    const { col, castSql } = buildVectorCastFragment(resolvedCol);
    let modalityFilter: string;
    if (resolvedCol.name === 'embedding_image') {
      modalityFilter = `AND cc.modality = 'image'`;
    } else if (resolvedCol.name === 'embedding_multimodal') {
      modalityFilter = '';
    } else {
      modalityFilter = `AND cc.modality = 'text'`;
    }

    // hnsw.ef_search: an HNSW scan returns at most ef_search rows (default
    // 40), so LIMIT $2 past 40 was silently unreachable — see hnswEfSearchFor.
    // SET LOCAL semantics need a transaction (PGLite autocommits bare
    // queries); scoping it locally keeps the engine's single session clean.
    const runOnce = async (il: number) => (await this.db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(hnswEfSearchFor(il))]);
      return tx.query(
      `WITH hnsw_candidates AS (
         SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id, p.updated_at,
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
         bpp.message_id, bpp.thread_id, bpp.source_subject,
         bpp.chunk_id, bpp.chunk_index, bpp.chunk_text, bpp.chunk_source,
         bpp.score,
         CASE WHEN bpp.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = bpp.page_id
         ) THEN true ELSE false END AS stale,
         (SELECT count(*) FROM hnsw_candidates)::int AS candidate_pool
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
    })).rows;

    // v0.46.15 bounded escalation loop — IDENTICAL logic to postgres-engine
    // (parity-pinned): retry ×4 up to 3 times while the PAGE set is short
    // but the pre-collapse candidate pool was full; a short page with a
    // non-full pool is a genuine final page. Zero rows with offset>0
    // escalates (deep pagination) but never emits — pool unknowable there.
    let escalations = 0;
    let rows = await runOnce(innerLimit);
    for (;;) {
      const il = params[innerLimitIdx] as number;
      if (rows.length >= limit) break;
      const pool = rows.length > 0
        ? Number((rows[0] as { candidate_pool?: number }).candidate_pool ?? 0)
        : null;
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
    //
    // #1262: the text-embedding column is registry-resolved, not the literal
    // `embedding`. A caller-resolved descriptor wins; otherwise the DB-plane
    // registry rows route the write to the SAME active column the read side
    // searches. Config-table read failure falls back to the legacy column;
    // an unregistered `search_embedding_column` throws the resolver's loud
    // paste-ready hint. Mirrors postgres-engine.ts for parity.
    // Resolution MUST stay on the raw db handle: callers (import-file) invoke
    // this inside their own transaction while holding the engine's public
    // surface — routing through resolveActiveEmbeddingColumnFromEngine (which
    // re-enters engine.executeRaw) deadlocks the single-connection path. Same
    // rows, same pure resolver, no re-entrancy.
    let writeCol: ResolvedColumn;
    if (opts?.embeddingColumn) {
      writeCol = normalizeEngineColumn(opts.embeddingColumn);
    } else {
      let searchEmbeddingColumn: string | null = null;
      let embeddingColumnsJson: string | null = null;
      try {
        const cfgResult = await this.db.query(
          `SELECT key, value FROM config WHERE key IN ('search_embedding_column', 'embedding_columns')`,
        );
        for (const r of cfgResult.rows as { key: string; value: string }[]) {
          if (r.key === 'search_embedding_column') searchEmbeddingColumn = r.value;
          else if (r.key === 'embedding_columns') embeddingColumnsJson = r.value;
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
    const rowParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Provenance fallback for chunks without an explicit `model`: resolve the
    // gateway's runtime model, not the compile-time DEFAULT_EMBEDDING_MODEL.
    // #3461: getEmbeddingModel() THROWS when unconfigured (never returns
    // falsy) — on the throw path fall back to the brain's own
    // `config.embedding_model` row, then the compile-time default as the
    // last resort. See postgres-engine.ts _upsertChunksOnce for the full
    // rationale — pglite mirrors it for parity.
    let resolvedModel: string | null = null;
    try {
      // Keep the gateway lazy so module-load failure remains inside this soft
      // fallback boundary; eager evaluation would bypass the config-row fallback.
      const gw = await import('./ai/gateway.ts'); // engine-dynamic-import-ok
      resolvedModel = gw.getEmbeddingModel();
    } catch {
      try {
        const cfg = await this.db.query(
          `SELECT value FROM config WHERE key = 'embedding_model'`,
        );
        resolvedModel = ((cfg.rows[0] as { value?: string } | undefined)?.value) ?? null;
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

      // Inline ::vector NULL literals to avoid a per-branch placeholder.
      const embeddingPh = embeddingStr ? `$${paramIdx++}${writeCast}` : 'NULL';
      const embeddedAtPh = embeddingStr ? 'now()' : 'NULL';
      const embeddingImagePh = embeddingImageStr ? `$${paramIdx++}::vector` : 'NULL';
      // #4246: hash in SQL (not JS) so stamp + drift comparison share ONE
      // md5 implementation. Binds chunk_text a second time.
      const embeddedTextHashPh = embeddingStr ? `md5($${paramIdx++})` : 'NULL';

      rowParts.push(
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
      // Param push order MUST match placeholder allocation order. Both
      // embedding placeholders (when present) are allocated BEFORE the
      // bulk row placeholders, so their values must be pushed first.
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

    // CONSISTENCY: when chunk_text changes and no new embedding is supplied, BOTH embedding AND
    // embedded_at must reset to NULL so 'embed --stale' correctly picks up the row for re-embedding.
    // See postgres-engine.ts upsertChunks for the full rationale — pglite mirrors it for parity.
    //
    // v0.40.3.0 D24 NULL→non-NULL race fix mirrors postgres-engine.ts. Two writers
    // racing on the same chunk previously raced last-write-wins; the fix lets the
    // fresher `embedded_at` win in the text-unchanged branch.
    //
    // Code-chunk metadata columns follow the same chunk_text-gated CASE pattern as `embedding`
    // (#769). Re-chunk trusts EXCLUDED outright; pure re-embed COALESCEs so a caller carrying
    // only embedding-shaped fields doesn't clobber metadata to NULL.
    //
    // #3461: `model` mirrors the `embedding` CASE branch-for-branch so the label always
    // describes whichever vector wins the upsert. See postgres-engine.ts for rationale.
    await this.db.query(
      `INSERT INTO content_chunks ${cols} VALUES ${rowParts.join(', ')}
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
      params
    );
  }

  async getChunks(slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean }): Promise<Chunk[]> {
    const sourceIds = opts?.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
    const source = sourceIds ?? opts?.sourceId ?? 'default';
    // S2: embedding_is_null reports the registry-ACTIVE column's truth —
    // `embed <page>` filters on it, so legacy-column truth would re-embed
    // every chunk on every pass on a registry-routed brain.
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    // #2544: explicit non-vector column list — most callers discard embeddings,
    // so `cc.*` shipped every vector only to be thrown away. `includeEmbedding`
    // adds the vector back for the callers that consume it (embed-reuse.ts);
    // it selects the registry-ACTIVE column (aliased AS embedding) so a reused
    // vector always matches the column upsertChunks writes.
    // embedding_is_null: boolean truth of the stored vector (a schema rebuild
    // NULLs vectors without touching embedded_at).
    const includeEmbedding = opts?.includeEmbedding === true;
    const { rows } = await this.db.query(
      `SELECT cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
              cc.model, cc.token_count, cc.embedded_at, cc.language,
              cc.symbol_name, cc.symbol_type, cc.start_line, cc.end_line,
              cc.parent_symbol_path, cc.doc_comment, cc.symbol_name_qualified, cc.modality,
              (cc.${colId} IS NULL) AS embedding_is_null
              ${includeEmbedding ? `, cc.${colId} AS embedding` : ''}
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1 AND ${sourceIds ? 'p.source_id = ANY($2::text[])' : 'p.source_id = $2'}
       ORDER BY cc.chunk_index`,
      [slug, source]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r, includeEmbedding));
  }

  /**
   * Build the stale-chunk WHERE clause + positional params. embed_skip is
   * always excluded. `signature` widens "stale" to include embedding_signature
   * drift (NULL grandfathered → never stale). `includeNullSignature` (#3391)
   * lifts the grandfather clause so pre-stamp pages count as stale too
   * (provider-migration paths). Shared by countStaleChunks +
   * sumStaleChunkChars so they can't drift.
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
   *  stay loud). Callers prefix the table alias themselves (`cc.${colId}`).
   *  Mirrors postgres-engine.ts (parity). */
  private async activeEmbeddingColId(opts?: { fallbackToLegacy?: boolean }): Promise<string> {
    const col = await resolveActiveEmbeddingColumnFromEngine(this, opts);
    return quoteIdentifier(col.name);
  }

  async countStaleChunks(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    // D7: source-scoped count for `gbrain embed --stale --source X`. Always
    // JOIN pages so embed-skip + signature predicates apply. PGLite is
    // PostgreSQL 17.5 in WASM and supports the full JSONB operator set.
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { where, params } = this.buildStaleChunkWhere(`cc.${staleColId}`, opts);
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

  async sumStaleChunkChars(opts?: { sourceId?: string; signature?: string; includeNullSignature?: boolean }): Promise<number> {
    // Sibling of countStaleChunks: same stale predicate, summing chunk_text
    // length for the sync cost preview. ::bigint guards int4 overflow.
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { where, params } = this.buildStaleChunkWhere(`cc.${staleColId}`, opts);
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

  async invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string; includeNullSignature?: boolean }): Promise<number> {
    // NULL out embeddings whose page signature is set AND differs from the
    // current model signature. GRANDFATHER: NULL signature untouched —
    // UNLESS includeNullSignature (#3391): provider migrations must not
    // leave pre-stamp pages in the old embedding space. Feeds the existing
    // NULL-embedding cursor so listStaleChunks stays unchanged. S2: keyed on
    // the registry-ACTIVE column (loud resolver failure — destructive writes
    // never guess).
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
    const { rows } = await this.db.query(
      `UPDATE content_chunks cc
          SET ${colId} = NULL, embedded_at = NULL
         FROM pages p
        WHERE cc.page_id = p.id
          AND cc.${colId} IS NOT NULL
          AND ${sigClause}${srcClause}
        RETURNING cc.page_id`,
      params,
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
    // embedding-invalidation.ts). Mirrors postgres-engine.ts (parity).
    // S2: keyed on the registry-ACTIVE column (loud resolver failure).
    const colId = await this.activeEmbeddingColId();
    const params: unknown[] = [];
    let srcClause = '';
    if (opts?.sourceId !== undefined) {
      params.push(opts.sourceId);
      srcClause = ` AND p.source_id = $${params.length}`;
    }
    const { rows } = await this.db.query(
      `UPDATE content_chunks cc
          SET ${colId} = NULL, embedded_at = NULL, embedded_text_hash = NULL
         FROM pages p
        WHERE cc.page_id = p.id
          AND cc.${colId} IS NOT NULL
          AND cc.embedded_text_hash IS NOT NULL
          AND cc.embedded_text_hash <> md5(cc.chunk_text)
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')${srcClause}
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

    // S2: stale = NULL in the registry-ACTIVE column (fallback to legacy on
    // a broken registry so read-only listing never crashes diagnostics).
    const staleColId = await this.activeEmbeddingColId({ fallbackToLegacy: true });

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
            WHERE cc.${staleColId} IS NULL
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
            WHERE cc.${staleColId} IS NULL
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
          WHERE cc.${staleColId} IS NULL
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
          WHERE cc.${staleColId} IS NULL
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
          WHERE cc.${staleColId} IS NULL
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
        WHERE cc.${staleColId} IS NULL
          AND p.source_id = $1
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
          AND (cc.page_id, cc.chunk_index) > ($2, $3)
        ORDER BY cc.page_id, cc.chunk_index
        LIMIT $4`,
      [opts.sourceId, afterPid, afterIdx, limit],
    );
    return rows as unknown as StaleChunkRow[];
  }

  /**
   * Shared chunkless-page-with-content predicate (mirrors PostgresEngine).
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
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS count FROM pages p WHERE ${where}`,
      params,
    );
    const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
    return Number(count);
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
    const { rows } = await this.db.query(
      `SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline
         FROM pages p
        WHERE ${where}${afterClause}
        ORDER BY p.id
        LIMIT $${limitIdx}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(r => ({
      id: r.id as number,
      slug: r.slug as string,
      source_id: (r.source_id as string | undefined) ?? 'default',
      compiled_truth: (r.compiled_truth as string | null) ?? '',
      timeline: (r.timeline as string | null) ?? '',
    }));
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

  async markPagesExtractedBatch(refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string): Promise<number> {
    if (refs.length === 0) return 0;
    const slugs = refs.map(r => r.slug);
    const srcs = refs.map(r => r.source_id);
    // Per-ref timestamp (D4 race fix): extract --stale passes each row's read
    // updated_at; sites that omit it fall back to defaultExtractedAt.
    const tss = refs.map(r => r.extractedAt ?? defaultExtractedAt);
    // #3957: RETURNING 1 makes the stamped-row count observable so callers
    // (stampExtracted) can surface a wrong-source shortfall instead of
    // claiming success while every ref missed.
    const { rows } = await this.db.query(
      `UPDATE pages p SET links_extracted_at = v.ts::timestamptz
         FROM unnest($1::text[], $2::text[], $3::text[]) AS v(slug, source_id, ts)
         WHERE p.slug = v.slug AND p.source_id = v.source_id
         RETURNING 1`,
      [slugs, srcs, tss],
    );
    return rows.length;
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

    const src = linkSource ?? 'markdown';
    // #4109: mirrors PostgresEngine — resolve both required endpoints and
    // upsert from one statement snapshot, reporting the missing endpoint
    // individually. Lookups stay source-qualified per endpoint (not the old
    // cross-product over pages f/t that fanned out across sources containing
    // the slugs). No FOR KEY SHARE here: PGLite is single-writer in-process,
    // so no concurrent session can delete between lookup and insert.
    const result = await this.db.query<{ from_exists: boolean; to_exists: boolean }>(
      `WITH endpoint_state AS (
         SELECT
           (SELECT id FROM pages WHERE slug = $1 AND source_id = $2) AS from_id,
           (SELECT id FROM pages WHERE slug = $3 AND source_id = $4) AS to_id,
           (SELECT id FROM pages WHERE slug = $5 AND source_id = $6) AS origin_id
       ), upserted AS (
         INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
         SELECT s.from_id, s.to_id, $7, $8, $9, s.origin_id, $10
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
       FROM endpoint_state`,
      [from, fromSrc, to, toSrc, originSlug ?? null, originSrc, linkType || '', sanitizeForJsonb(context || ''), src, originField ?? null]
    );
    const row = result.rows[0];
    if (!row?.from_exists) throw new PageMissingError('addLink', 'from', from, fromSrc);
    if (!row.to_exists) throw new PageMissingError('addLink', 'to', to, toSrc);
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
    const fromSrc = opts?.fromSourceId ?? 'default';
    const toSrc = opts?.toSourceId ?? 'default';
    // Each branch source-qualifies page-id subqueries so a delete only targets
    // the intended edge between per-source slug rows.
    // #4527: RETURNING 1 so the caller learns how many edges actually died —
    // a zero-match delete must be distinguishable from a real removal.
    if (linkType !== undefined && linkSource !== undefined) {
      const { rows } = await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_type = $5
           AND link_source IS NOT DISTINCT FROM $6
         RETURNING 1`,
        [from, fromSrc, to, toSrc, linkType, linkSource]
      );
      return rows.length;
    } else if (linkType !== undefined) {
      const { rows } = await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_type = $5
         RETURNING 1`,
        [from, fromSrc, to, toSrc, linkType]
      );
      return rows.length;
    } else if (linkSource !== undefined) {
      const { rows } = await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
           AND link_source IS NOT DISTINCT FROM $5
         RETURNING 1`,
        [from, fromSrc, to, toSrc, linkSource]
      );
      return rows.length;
    } else {
      const { rows } = await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $3 AND source_id = $4)
         RETURNING 1`,
        [from, fromSrc, to, toSrc]
      );
      return rows.length;
    }
  }

  async getLinks(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<Link[]> {
    // #2200: federated grant scopes ALL THREE page endpoints — from, to, AND the
    // origin (the authoring page, surfaced as origin_slug). The origin LEFT JOIN
    // carries the same ANY($) filter so an out-of-grant origin's slug nulls out.
    // Remote MCP clients always land here.
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, f.source_id as from_source_id,
                t.slug as to_slug, t.source_id as to_source_id,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, o.source_id as origin_source_id,
                l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY($2::text[])
         WHERE f.slug = $1 AND f.source_id = ANY($2::text[]) AND t.source_id = ANY($2::text[])
           AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [slug, opts.sourceIds]
      );
      return rows as unknown as Link[];
    }
    // v0.31.8 (D16) + #2200: the federated arm above is the first branch; the two
    // below preserve pre-v0.31.8 semantics. Without opts.sourceId, no source filter
    // (cross-source view for back-link validators and reconcileLinks). With
    // opts.sourceId, scope to that source (D20).
    // #3754: all three arms filter soft-deleted endpoints (f/t deleted_at IS NULL)
    // so links to/from soft-deleted pages stop voting in the graph, matching
    // orphans/get/list/search visibility.
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, f.source_id as from_source_id,
                t.slug as to_slug, t.source_id as to_source_id,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, o.source_id as origin_source_id,
                l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
         WHERE f.slug = $1 AND f.source_id = $2
           AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [slug, opts.sourceId]
      );
      return rows as unknown as Link[];
    }
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, f.source_id as from_source_id,
              t.slug as to_slug, t.source_id as to_source_id,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, o.source_id as origin_source_id,
              l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE f.slug = $1
         AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
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
        `SELECT f.slug as from_slug, f.source_id as from_source_id,
                t.slug as to_slug, t.source_id as to_source_id,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, o.source_id as origin_source_id,
                l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id AND o.source_id = ANY($2::text[])
         WHERE t.slug = $1 AND t.source_id = ANY($2::text[]) AND f.source_id = ANY($2::text[])
           AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [slug, opts.sourceIds]
      );
      return rows as unknown as Link[];
    }
    // v0.31.8 (D16) + #2200: federated arm above is first; two below mirror getLinks
    // (incl. the #3754 soft-delete endpoint filter on all three arms).
    if (opts?.sourceId) {
      const { rows } = await this.db.query(
        `SELECT f.slug as from_slug, f.source_id as from_source_id,
                t.slug as to_slug, t.source_id as to_source_id,
                l.link_type, l.context, l.link_source,
                o.slug as origin_slug, o.source_id as origin_source_id,
                l.origin_field
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
         WHERE t.slug = $1 AND t.source_id = $2
           AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [slug, opts.sourceId]
      );
      return rows as unknown as Link[];
    }
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, f.source_id as from_source_id,
              t.slug as to_slug, t.source_id as to_source_id,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, o.source_id as origin_source_id,
              l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE t.slug = $1
         AND f.deleted_at IS NULL AND t.deleted_at IS NULL`,
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
    sourceId?: string,
  ): Promise<{ slug: string; similarity: number } | null> {
    // Use `%` so idx_pages_trgm can prune candidates for normal thresholds at
    // or above 0.3. Retain the exact comparison-only path below 0.3 so callers
    // do not lose low-similarity matches. Tie-breaker: sort by slug so re-runs
    // pick the same winner.
    //
    // `sourceId` + `deleted_at IS NULL` mirror the filters `tryFuzzyMatch` in
    // `src/core/entities/resolve.ts` got via #1436 (v0.41.13.0). Without them,
    // fuzzy resolution could suggest cross-source slugs that the caller then
    // silently drops at the FK filter — making it look like the match failed
    // when in fact it picked the wrong page.
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const trgmPrefilter = minSimilarity >= 0.3 ? 'title % $1 AND ' : '';
    const { rows } = sourceId
      ? await this.db.query(
          `SELECT slug, similarity(title, $1) AS sim
           FROM pages
           WHERE ${trgmPrefilter}similarity(title, $1) >= $3
             AND slug LIKE $2
             AND source_id = $4
             AND deleted_at IS NULL
           ORDER BY sim DESC, slug ASC
           LIMIT 1`,
          [name, prefixPattern, minSimilarity, sourceId]
        )
      : await this.db.query(
          `SELECT slug, similarity(title, $1) AS sim
           FROM pages
           WHERE ${trgmPrefilter}similarity(title, $1) >= $3
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
          AND p2.deleted_at IS NULL
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
          AND p2.deleted_at IS NULL
          ${stepScope}`;
    }

    // Cycle prevention: visited array tracks page IDs already in the path.
    // Prevents exponential blowup on cyclic subgraphs (e.g., A->B->A).
    const { rows } = await this.db.query(
      `WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL ${seedScope}

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
           WHERE l2.from_page_id = g.id AND p3.deleted_at IS NULL ${aggScope}),
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

    // #3754: soft-deleted pages are excluded at seed, every recursive step, and
    // the final SELECT joins — a deleted page neither anchors, relays, nor
    // terminates a path (mirrors postgres-engine.traversePaths).
    let sql: string;
    if (direction === 'out') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
            ${linkTypeWhere}
            ${stepScope}
        )
        SELECT w.slug AS from_slug, p2.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < $2
          AND p2.deleted_at IS NULL
          ${linkTypeWhere}
          ${stepScope}
        ORDER BY depth, from_slug, to_slug
      `;
    } else if (direction === 'in') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
            ${linkTypeWhere}
            ${stepScope}
        )
        SELECT p2.slug AS from_slug, w.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < $2
          AND p2.deleted_at IS NULL
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
          FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL ${seedScope}
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            AND p2.deleted_at IS NULL
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
          AND pf.deleted_at IS NULL
          AND pt.deleted_at IS NULL
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
             -- Final path tie-break (lexicographic) makes the pick deterministic
             -- when a node is reachable at the same depth from multiple seeds;
             -- without it the winner is plan/heap-order dependent and the two
             -- engines (or two runs) can disagree. Relational retrieval is
             -- documented deterministic; keep in lockstep with postgres-engine.ts.
             (array_agg(array_to_string(n.path, chr(9))
               ORDER BY n.depth ASC, array_length(n.path, 1) ASC,
                        array_to_string(n.path, chr(9)) ASC))[1] AS path_str,
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

  async getBacklinkCounts(pageIds: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (pageIds.length === 0) return result;
    // Initialize all ids to 0 so callers get a consistent map.
    for (const id of pageIds) result.set(id, 0);

    // v0.41.18.0 D12: filter mentions OUT of backlink-count for search
    // ranking — parity with postgres-engine.ts. See that file's comment
    // for the full rationale. `IS DISTINCT FROM` is NULL-safe so legacy
    // rows with NULL link_source still count toward backlinks.
    // #4380: keyed by p.id, not slug — parity with postgres-engine.ts.
    // PGLite needs explicit cast for array binding (does not auto-serialize JS arrays).
    const { rows } = await this.db.query(
      `SELECT p.id AS page_id, COUNT(l.id)::int AS cnt
       FROM pages p
       LEFT JOIN links l ON l.to_page_id = p.id
         AND l.link_source IS DISTINCT FROM 'mentions'
       WHERE p.id = ANY($1::int[])
       GROUP BY p.id`,
      [pageIds]
    );
    for (const r of rows as { page_id: number; cnt: number }[]) {
      result.set(Number(r.page_id), Number(r.cnt));
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

  async getUnverifiedExtractionPageIds(
    pageIds: number[],
  ): Promise<Map<number, { unverified: boolean; status: string }>> {
    const result = new Map<number, { unverified: boolean; status: string }>();
    if (pageIds.length === 0) return result;
    // Parity with PostgresEngine.getUnverifiedExtractionPageIds (issue #160,
    // widened for #4220). Quarantine predicate is the shared
    // unverifiedExtractionFragment so this query and the SQL-side
    // source-boost guard can never drift; any page with a frontmatter
    // `status` value is returned so draft/superseded/restricted surface on
    // SearchResult.status.
    const { rows } = await this.db.query(
      `SELECT id,
              (COALESCE(frontmatter, '{}'::jsonb) ->> 'status') AS status,
              (${unverifiedExtractionFragment('pages')}) AS unverified
       FROM pages
       WHERE id = ANY($1::int[])
         AND (COALESCE(frontmatter, '{}'::jsonb) ->> 'status') IS NOT NULL`,
      [pageIds]
    );
    for (const r of rows as { id: number; status: string; unverified: boolean }[]) {
      result.set(Number(r.id), { unverified: r.unverified === true, status: r.status });
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
    mode?: 'inbound' | 'islanded';
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
    // #4524: default mode 'islanded' — identical predicate to getHealth's
    // orphan_pages (no live inbound AND no live outbound; outbound counts
    // only when its TARGET page is live, per gbrain#4153 endpoint liveness).
    // mode 'inbound' preserves the legacy no-inbound-only view.
    const outboundFilter =
      (opts?.mode ?? 'islanded') === 'islanded'
        ? `AND NOT EXISTS (
             SELECT 1
             FROM links l
             JOIN pages tgt ON tgt.id = l.to_page_id
             WHERE l.from_page_id = p.id
               AND tgt.deleted_at IS NULL
           )`
        : '';
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
         ${outboundFilter}
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
  ): Promise<boolean> {
    const sourceId = opts?.sourceId ?? 'default';
    // #4109: mirrors PostgresEngine — page resolution and insertion share one
    // statement snapshot so the miss is typed (PageMissingError) rather than
    // inferred from a zero-row insert. ON CONFLICT DO NOTHING via the
    // (page_id, date, md5(summary), source) unique index (#3737: md5-keyed so
    // long summaries fit the btree row cap).
    // #3827: the `inserted` flag makes the outcome observable (true =
    // inserted, false = deduplicated, or page missing under
    // skipExistenceCheck), mirroring the Postgres engine. Source-qualify the
    // page-id lookup so multi-source brains don't fan timeline rows out
    // across every source containing the slug.
    // Free-text body fields are NUL + lone-surrogate sanitized (#2011), matching
    // the batch path and the Postgres engine; identity fields (slug, date) raw.
    const result = await this.db.query<{ page_exists: boolean; inserted: boolean }>(
      `WITH page_state AS (
         SELECT id FROM pages WHERE slug = $1 AND source_id = $6
       ), inserted AS (
         INSERT INTO timeline_entries (page_id, date, source, summary, detail)
         SELECT id, $2::date, $3, $4, $5
         FROM page_state
         ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
         RETURNING 1
       )
       SELECT
         EXISTS(SELECT 1 FROM page_state) AS page_exists,
         EXISTS(SELECT 1 FROM inserted) AS inserted`,
      [slug, entry.date, sanitizeForJsonb(entry.source || ''), sanitizeForJsonb(entry.summary), sanitizeForJsonb(entry.detail || ''), sourceId]
    );
    if (!result.rows[0]?.page_exists && !opts?.skipExistenceCheck) {
      throw new PageMissingError('addTimelineEntry', 'page', slug, sourceId);
    }
    return result.rows[0]?.inserted === true;
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
       JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id AND p.deleted_at IS NULL
       ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING
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

  // ── v0.42.x Life Chronicle (#2390) timeline reads ───────────────────────
  // Same result contract as the Postgres engine (parity is on results, not the
  // builder idiom): JOIN depth page (deleted_at IS NULL), LEFT JOIN event page,
  // hide soft-deleted event projections, order by COALESCE(event effective_date,
  // date). Source scope: federated sourceIds[] > scalar sourceId > unscoped.
  // Returns the ep-side fragment (same param slot): the event-page LEFT JOIN carries
  // the caller's scope so out-of-scope event fields null out (#2200 origin-join shape).
  private pushChronicleSource(where: string[], params: unknown[], opts?: { sourceId?: string; sourceIds?: string[] }): string {
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      params.push(opts.sourceIds);
      where.push(`p.source_id = ANY($${params.length}::text[])`);
      return ` AND ep.source_id = ANY($${params.length}::text[])`;
    } else if (opts?.sourceId) {
      params.push(opts.sourceId);
      where.push(`p.source_id = $${params.length}`);
      return ` AND ep.source_id = $${params.length}`;
    }
    return '';
  }

  private static chronicleSelect(epScope: string): string {
    return `
    SELECT te.date::text AS date, te.summary, te.detail, te.source,
           te.page_id, p.slug AS page_slug,
           te.event_page_id, ep.slug AS event_slug,
           ep.effective_date::text AS effective_date,
           ep.frontmatter->'event'->>'kind' AS kind
    FROM timeline_entries te
    JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
    LEFT JOIN pages ep ON ep.id = te.event_page_id${epScope}`;
  }

  async getTimelineForDate(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 200;
    const params: unknown[] = [date];
    const lower = opts?.week ? `date_trunc('week', $1::date)::date` : `$1::date`;
    const upper = opts?.week ? `(date_trunc('week', $1::date) + interval '6 days')::date` : `$1::date`;
    const where: string[] = [
      `te.date >= ${lower}`,
      `te.date <= ${upper}`,
      `(te.event_page_id IS NULL OR ep.deleted_at IS NULL)`,
    ];
    const epScope = this.pushChronicleSource(where, params, opts);
    params.push(limit);
    const result = await this.db.query(
      `${PGLiteEngine.chronicleSelect(epScope)}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows as unknown as ChronicleTimelineRow[];
  }

  async getSince(date: string, opts?: ChronicleTimelineOpts): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 200;
    const params: unknown[] = [date];
    const where: string[] = [
      `te.date >= $1::date`,
      `(te.event_page_id IS NULL OR ep.deleted_at IS NULL)`,
    ];
    if (opts?.kind) {
      params.push(opts.kind);
      where.push(`ep.frontmatter->'event'->>'kind' = $${params.length}`);
    }
    const epScope = this.pushChronicleSource(where, params, opts);
    params.push(limit);
    const result = await this.db.query(
      `${PGLiteEngine.chronicleSelect(epScope)}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows as unknown as ChronicleTimelineRow[];
  }

  async getOnThisDay(opts?: { date?: string; limit?: number; sourceId?: string; sourceIds?: string[] }): Promise<ChronicleTimelineRow[]> {
    const limit = opts?.limit ?? 50;
    const params: unknown[] = [];
    let target: string;
    if (opts?.date) { params.push(opts.date); target = `$${params.length}::date`; }
    else { target = `current_date`; }
    const where: string[] = [
      `EXTRACT(MONTH FROM te.date) = EXTRACT(MONTH FROM ${target})`,
      `EXTRACT(DAY FROM te.date) = EXTRACT(DAY FROM ${target})`,
      `te.date < ${target}`,
      `(te.event_page_id IS NULL OR ep.deleted_at IS NULL)`,
    ];
    const epScope = this.pushChronicleSource(where, params, opts);
    params.push(limit);
    const result = await this.db.query(
      `${PGLiteEngine.chronicleSelect(epScope)}
       WHERE ${where.join(' AND ')}
       ORDER BY te.date DESC, te.id ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows as unknown as ChronicleTimelineRow[];
  }

  async getLastSeen(entitySlug: string, opts?: { asof?: string; sourceId?: string; sourceIds?: string[] }): Promise<LastSeenResult> {
    const params: unknown[] = [entitySlug, `%${entitySlug}%`];
    const where: string[] = [
      `(te.event_page_id IS NULL OR ep.deleted_at IS NULL)`,
      `(p.slug = $1 OR (ep.id IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(ep.frontmatter->'event'->'who') = 'array'
                 THEN ep.frontmatter->'event'->'who' ELSE '[]'::jsonb END
          ) AS w(name) WHERE w.name = $1 OR w.name LIKE $2)))`,
    ];
    // "Last seen" is a PAST relation: chronicle stores future events
    // (calendar-event is eligible), which must not read as "last seen".
    // Bound to <= asof/today, mirroring getOnThisDay's `te.date < target`.
    let seenThrough: string;
    if (opts?.asof) { params.push(opts.asof); seenThrough = `$${params.length}::date`; }
    else { seenThrough = `current_date`; }
    where.push(`te.date <= ${seenThrough}`);
    const epScope = this.pushChronicleSource(where, params, opts);
    const result = await this.db.query(
      `SELECT te.date::text AS last_date, ep.slug AS last_event_slug
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id AND p.deleted_at IS NULL
       LEFT JOIN pages ep ON ep.id = te.event_page_id${epScope}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) DESC, te.id DESC
       LIMIT 1`,
      params,
    );
    const row = result.rows[0] as { last_date?: string; last_event_slug?: string } | undefined;
    return finalizeLastSeen(entitySlug, row?.last_date ?? null, row?.last_event_slug ?? null, opts?.asof);
  }

  async upsertEventProjection(opts: { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string }): Promise<{ projected: boolean }> {
    const sourceId = opts.sourceId ?? 'default';
    const r = await this.db.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
       SELECT dp.id, $1::date, $2, $3, $4, ep.id
       FROM pages dp, pages ep
       WHERE dp.slug = $5 AND dp.source_id = $6 AND ep.slug = $7 AND ep.source_id = $6
       ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL
       DO UPDATE SET summary = EXCLUDED.summary, detail = EXCLUDED.detail,
                     page_id = EXCLUDED.page_id, source = EXCLUDED.source
       RETURNING id`,
      [opts.date, 'life-chronicle:event:' + opts.eventSlug, opts.summary, opts.detail ?? '', opts.depthSlug, sourceId, opts.eventSlug],
    );
    return { projected: r.rows.length > 0 };
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

    if (current && current.value_hash === vh) {
      const ins = await this.db.query(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, dim_status,
                            confidence, source, source_markdown_slug, valid_from, valid_until, expired_at, consolidated_into)
         VALUES ($1,$2,$3,'fact',$4,$5,$6,$7,$8,$9,$10,$10,COALESCE($11::timestamptz, now()),$12, now(), $13)
         ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug) WHERE dimension IS NOT NULL
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
       ON CONFLICT (source_id, entity_slug, dimension, value_hash, source_markdown_slug) WHERE dimension IS NOT NULL
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
    const r = await this.db.query(
      `SELECT DISTINCT ON (dimension) dimension, value, confidence,
         source_markdown_slug AS source, valid_from, valid_until AS valid_to,
         COALESCE(dim_status,'active') AS status, id AS fact_id
       FROM facts
       WHERE entity_slug = $1 AND dimension IS NOT NULL AND expired_at IS NULL ${scope}
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

  async findOntologyConflicts(opts?: { sourceId?: string; sourceIds?: string[]; minConfidence?: number }): Promise<OntologyConflict[]> {
    const minConf = opts?.minConfidence ?? 0;
    const params: unknown[] = [minConf];
    let scope: string;
    if (opts?.sourceIds && opts.sourceIds.length) { params.push(opts.sourceIds); scope = `AND source_id = ANY($${params.length})`; }
    else { params.push(opts?.sourceId ?? null); scope = `AND ($${params.length}::text IS NULL OR source_id = $${params.length})`; }
    const r = await this.db.query(
      `WITH cur AS (
         SELECT entity_slug, dimension, value, source_markdown_slug AS source, confidence, id AS fact_id
         FROM facts WHERE dimension IS NOT NULL AND expired_at IS NULL AND valid_until IS NULL
           AND (dim_status IS NULL OR dim_status = 'active') AND confidence >= $1 ${scope}
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
    opts?: { sourceId?: string; sourceIds?: string[] },
  ): Promise<RawData[]> {
    // v0.31.8 (D21): build WHERE clause dynamically. Without opts.sourceId,
    // no source filter (preserves pre-v0.31.8 cross-source read).
    const where: string[] = ['p.slug = $1'];
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

  // Peeled into ./pglite-engine/facts.ts (containment sprint C15): the
  // methods below are one-line delegates over free functions with a narrow
  // deps surface.

  /** Narrow deps for the peeled facts module. */
  private get factsDeps(): PgliteFactsDeps {
    const self = this;
    return { get db() { return self.db; } };
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

  async findTrajectory(opts: import('./engine.ts').TrajectoryOpts): Promise<import('./engine.ts').TrajectoryPoint[]> {
    return factsImpl.findTrajectory(this.factsDeps, opts);
  }

  async consolidateFact(id: number, takeId: number): Promise<void> {
    return factsImpl.consolidateFact(this.factsDeps, id, takeId);
  }

  async getFactsHealth(source_id: string): Promise<FactsHealth> {
    return factsImpl.getFactsHealth(this.factsDeps, source_id);
  }

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis_evidence
  // ============================================================

  // Peeled into ./pglite-engine/takes.ts (containment sprint C15).

  /** Narrow deps for the peeled takes module. */
  private get takesDeps(): PgliteTakesDeps {
    const self = this;
    return {
      get db() { return self.db; },
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

  async searchTakes(
    query: string,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
  ): Promise<TakeHit[]> {
    return takesImpl.searchTakes(this.takesDeps, query, opts);
  }

  async searchTakesVector(
    embedding: Float32Array,
    opts: SearchOpts & { takesHoldersAllowList?: string[] } = {},
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

  async getVersions(slug: string, opts?: { sourceId?: string; sourceIds?: string[] }): Promise<PageVersion[]> {
    if (opts?.sourceIds && opts.sourceIds.length > 0) {
      const { rows } = await this.db.query(
        `SELECT pv.* FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
         WHERE p.slug = $1 AND p.source_id = ANY($2::text[])
         ORDER BY pv.snapshot_at DESC`,
        [slug, opts.sourceIds]
      );
      return rows as unknown as PageVersion[];
    }
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
    // Combined metrics from master (brain_score components: dead_links, link_count,
    // pages_with_timeline) and v0.10.3 graph layer (link_coverage, timeline_coverage,
    // most_connected). Both coexist: master's brain_score is the composite
    // dashboard, v0.10.3 metrics give entity-page-level granularity.
    // #1305: every page-scoped count here excludes soft-deleted rows — same
    // posture as getStats — so brain_score moves when the user deletes pages.
    // Chunk/link counts stay raw (storage until the purge phase), matching
    // getStats, and destructive-removal counts elsewhere deliberately stay raw.
    // S2: coverage + missing_embeddings key on the registry-ACTIVE column.
    // #4592: optional source scope — parity with postgres-engine.getHealth
    // (bound as $1, never interpolated; both-endpoint rule for link-derived
    // numbers; out-of-scope endpoints can't rescue a page from orphan-hood).
    const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
    const colId = await this.activeEmbeddingColId({ fallbackToLegacy: true });
    const { rows: [h] } = await this.db.query(`
      WITH scoped_pages AS (
        SELECT id, slug, frontmatter, deleted_at, source_id FROM pages p
        WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))
      ),
      entity_pages AS (
        SELECT id, slug FROM scoped_pages WHERE id IN (
          SELECT id FROM pages WHERE type IN ('entity', 'person', 'company') AND deleted_at IS NULL
        )
      )
      SELECT
        (SELECT count(*) FROM scoped_pages WHERE deleted_at IS NULL) as page_count,
        -- Parity with postgres-engine: stored-VECTOR truth over ELIGIBLE
        -- chunks (embedding, not embedded_at; embed_skip excluded from BOTH
        -- sides; zero eligible = vacuous 100%).
        (SELECT CASE
           WHEN count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')) = 0
           THEN 1.0
           ELSE count(*) FILTER (WHERE cc.${colId} IS NOT NULL
                                   AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
              / count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
         END
         FROM content_chunks cc
         JOIN scoped_pages p ON p.id = cc.page_id) as embed_coverage,
        0 as stale_pages,
        -- Bug 11 — orphan = islanded (no inbound AND no outbound). The raw
        -- list is filtered in TS using the shared orphan-reporting policy.
        0 as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
           AND ($1::text[] IS NULL
                OR EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id))
        ) as dead_links,
        -- Parity with postgres-engine.ts: same predicate as
        -- buildStaleChunkWhere / countStaleChunks, i.e. what 'embed --stale'
        -- actually processes. 'embedding IS NULL' (not embedded_at, which can
        -- be non-NULL while embedding is NULL) and embed_skip excluded, so the
        -- count can reach zero and the embed.stale remediation can converge.
        (SELECT count(*) FROM content_chunks cc
           JOIN scoped_pages p ON p.id = cc.page_id
          WHERE cc.${colId} IS NULL
            AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
        ) as missing_embeddings,
        (SELECT count(*) FROM links l
          WHERE ($1::text[] IS NULL
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
    `, [scope]);

    // Top 5 most connected entities by total link count (in + out).
    // X8 (#4592): a degree counts an edge only when its FAR endpoint is in
    // scope too — parity with postgres-engine's rule and comment.
    const { rows: connected } = await this.db.query(`
      SELECT p.slug,
             (SELECT count(*) FROM links l
               WHERE (l.from_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.to_page_id AND fp.source_id = ANY($1))))
                  OR (l.to_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.from_page_id AND fp.source_id = ANY($1))))
             )::int as link_count
      FROM pages p
      WHERE p.type IN ('entity', 'person', 'company') AND p.deleted_at IS NULL
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
      ORDER BY link_count DESC
      LIMIT 5
    `, [scope]);

    // Per-page flags for the linkable scope: orphan_pages and the
    // no-orphans / timeline-coverage DENOMINATORS are all computed over
    // pages the shared orphan-reporting policy considers linkable (the same
    // scope `gbrain orphans` and doctor's orphan_ratio use), so one doctor
    // report cannot carry two contradictory orphan/coverage numbers.
    // Archive (raw/), generated, and daily-log pages are not expected to
    // participate in the curated graph. Filtered in TS because the policy
    // includes per-brain config overrides.
    // gbrain#4153: endpoint liveness in BOTH directions — an inbound link
    // only counts when its SOURCE page is live (the invariant
    // findOrphanPages documents), and an outbound link only counts when its
    // TARGET is live. Without this, get_health's orphan_pages disagreed with
    // `gbrain orphans` whenever a soft-deleted page still linked to (or was
    // linked from) a live one.
    // #4592: out-of-scope endpoints cannot rescue a page from orphan-hood.
    const { rows: pageScopeRows } = await this.db.query(`
      SELECT p.slug,
             (NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages src ON src.id = l.from_page_id
                          WHERE l.to_page_id = p.id AND src.deleted_at IS NULL
                            AND ($1::text[] IS NULL OR src.source_id = ANY($1)))
              AND NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages tgt ON tgt.id = l.to_page_id
                          WHERE l.from_page_id = p.id AND tgt.deleted_at IS NULL
                            AND ($1::text[] IS NULL OR tgt.source_id = ANY($1)))) as islanded,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) as has_timeline
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
    `, [scope]);

    const r = h as Record<string, unknown>;
    const pageCount = Number(r.page_count);
    const embedCoverage = Number(r.embed_coverage);
    // Scoped: sum the scalar-sourceId counter per grant (parity with
    // postgres-engine; the unmatchable __all__ scalar fail-closes to 0).
    const stalePages = scope === null
      ? await this.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })
      : (await Promise.all(scope.map(sid =>
          this.countStalePagesForExtraction({ sourceId: sid, versionTs: LINK_EXTRACTOR_VERSION_TS }),
        ))).reduce((a, b) => a + b, 0);
    const orphanOverrides = await loadOrphanPolicyOverrides(this);
    const linkablePages = (pageScopeRows as { slug: string; islanded: boolean; has_timeline: boolean }[])
      .filter(row => !shouldExcludeFromOrphanReporting(row.slug, orphanOverrides));
    const linkablePageCount = linkablePages.length;
    const orphanPages = linkablePages.filter(row => row.islanded).length;
    const linkableTimelinePages = linkablePages.filter(row => row.has_timeline).length;
    const deadLinks = Number(r.dead_links);
    const linkCount = Number(r.link_count);

    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    // linkablePageCount === 0 gets full marks for the orphan / timeline
    // components (same vacuous-truth rule as the empty-brain fix below):
    // an all-archive brain has no curated graph to penalize.
    const timelineCoverageDensity =
      linkablePageCount > 0 ? Math.min(linkableTimelinePages / linkablePageCount, 1) : 1;
    const noOrphans = linkablePageCount > 0 ? 1 - (orphanPages / linkablePageCount) : 1;
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
      linkable_page_count: linkablePageCount,
      embed_coverage: embedCoverage,
      stale_pages: stalePages,
      orphan_pages: orphanPages,
      missing_embeddings: Number(r.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      entity_page_count: Number(r.entity_page_count),
      // gbrain#4147: below the small-N floor the ratio is statistically
      // meaningless (0/0 used to read as a hard 0%), so it reports null and
      // consumers suppress both the percentage and its remediation actions.
      link_coverage: Number(r.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(r.link_coverage) : null,
      timeline_coverage: Number(r.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(r.timeline_coverage) : null,
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
    // Source-qualify so a rename in source A doesn't sweep up same-slug rows
    // in sources B/C/D (mirrors postgres-engine.ts).
    const result = await this.db.query(
      `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2 AND source_id = $3`,
      [newSlug, oldSlug, sourceId]
    );
    // #3056: rows moved — a zero-row UPDATE does not throw, so the count is
    // the only way callers can see the no-op.
    return result.affectedRows ?? 0;
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

  // Peeled into ./pglite-engine/code-edges.ts (containment sprint C15).

  /** Narrow deps for the peeled code-edges module. */
  private get codeEdgesDeps(): PgliteCodeEdgesDeps {
    const self = this;
    return { get db() { return self.db; } };
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

  // Peeled into ./pglite-engine/salience.ts (containment sprint C15).

  /** Narrow deps for the peeled salience module. */
  private get salienceDeps(): PgliteSalienceDeps {
    const self = this;
    return { get db() { return self.db; } };
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
