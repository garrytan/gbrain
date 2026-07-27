// ─────────────────────────────────────────────────────────────────
// Sync failure ledger — issue #1939 (was "Bug 9" in src/core/sync.ts)
// ─────────────────────────────────────────────────────────────────
//
// When a sync run catches a per-file parse error (YAML with unquoted
// colons, malformed frontmatter, a non-string title, etc.), we record it
// here instead of just logging and moving on. Goals:
//   1. Gate the sync.last_commit bookmark advance in BOTH sync gates
//      (incremental + full/runImport) through one shared policy.
//   2. Give a visible, per-(source,path) record of what failed, with the
//      commit hash to re-attempt after fixing the source file.
//   3. `gbrain sync --skip-failed` acknowledges a known-bad set.
//   4. BOUNDED AUTO-SKIP: a file that fails N consecutive syncs is
//      auto-skipped so a single poison file can't wedge ALL indexing
//      forever — without ever silently dropping a FRESH failure, and
//      never auto-skipping an infra sentinel like `<head>`.
//
// This module is a LEAF (imports only fs/path/crypto/config) so it can be
// re-exported from sync.ts without a circular dependency. The state lives
// in `~/.gbrain/sync-failures.jsonl`, one JSON object per line.
//
// State machine (per (source_id, path)):
//
//        recordFailures (file fails a sync run)
//             │  attempts++ each consecutive run
//             ▼
//          ┌──────┐  clearFailures (file imports OK)        ┌─────────┐
//          │ open │ ───────────────────────────────────────│ removed │
//          └──────┘                                          └─────────┘
//          │     │
//   --skip-│     │ attempts >= threshold AND no fresh failures
//   failed │     │ (after bookmark advance)
//          ▼     ▼
//  ┌────────────┐  ┌──────────────┐
//  │acknowledged│  │ auto_skipped │  (still UNRESOLVED → doctor WARN
//  │ (resolved) │  │  visible      │   until the file imports cleanly)
//  └────────────┘  └──────────────┘
//
// `acknowledged` = ok (human resolved). `open` + `auto_skipped` = unresolved
// (doctor surfaces them). `<head>` and any `<…>` sentinel is recorded but
// NEVER auto-skipped/acknowledged-to-advance — a history rewrite must hard-block.

import {
  existsSync as _existsSync,
  readFileSync as _readFileSync,
  writeFileSync as _writeFileSync,
  mkdirSync as _mkdirSync,
  renameSync as _renameSync,
  openSync as _openSync,
  closeSync as _closeSync,
  unlinkSync as _unlinkSync,
  statSync as _statSync,
} from 'fs';
import { join as _joinPath } from 'path';
import { gbrainPath as _gbrainPath } from './config.ts';
import { createHash as _createHash } from 'crypto';

export const DEFAULT_SOURCE_ID = 'default';
/** Reserved sentinel paths (e.g. `<head>`) start with this; never file paths. */
export const SENTINEL_PREFIX = '<';
export const DEFAULT_AUTOSKIP_AFTER = 3;
const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

export type SyncFailureState = 'open' | 'acknowledged' | 'auto_skipped';

export interface SyncFailure {
  /** Owning source (#1939 Codex #2 — failures must not merge across sources). */
  source_id: string;
  path: string;
  error: string;
  /** Structured error code extracted from the error message. */
  code: string;
  /** Most recent commit this path failed on. */
  commit: string;
  line?: number;
  /** ISO — start of the current unresolved streak. */
  first_seen: string;
  /** ISO — last update. */
  ts: string;
  /** Consecutive failed sync runs for (source_id, path). */
  attempts: number;
  state: SyncFailureState;
  resolved_at?: string;
  // Legacy MIRROR fields, still WRITTEN for one release so any pre-#1939
  // reader of `acknowledged_at` keeps working. Derived from `state`.
  acknowledged?: boolean;
  acknowledged_at?: string | null;
}

export interface AcknowledgeResult {
  count: number;
  summary: Array<{ code: string; count: number }>;
}

/** A real importable file (not an infra sentinel like `<head>`). */
export function isSkippablePath(path: string): boolean {
  return !path.startsWith(SENTINEL_PREFIX);
}

/**
 * Resolve the auto-skip threshold from `GBRAIN_SYNC_AUTOSKIP_AFTER`
 * (default 3). `0` disables the valve entirely (pure fail-closed).
 */
export function resolveAutoSkipThreshold(): number {
  const raw = process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
  if (raw === undefined || raw === '') return DEFAULT_AUTOSKIP_AFTER;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOSKIP_AFTER;
  return Math.floor(n);
}

/**
 * Best-effort extraction of a structured error code from a sync failure
 * message. Order matters: DB-layer errors are checked BEFORE YAML-layer
 * ones so Postgres `duplicate key` isn't mislabeled as a YAML duplicate-key.
 */
export function classifyErrorCode(errorMsg: string): string {
  // SLUG_MISMATCH: thrown by importFromFile() at src/core/import-file.ts.
  if (/slug.*does not match|SLUG_MISMATCH/i.test(errorMsg)) return 'SLUG_MISMATCH';

  // DB-layer errors come BEFORE the YAML duplicate-key check.
  if (/duplicate key value violates unique constraint|DB_DUPLICATE_KEY/i.test(errorMsg)) {
    return 'DB_DUPLICATE_KEY';
  }
  if (/canceling statement due to statement timeout|STATEMENT_TIMEOUT/i.test(errorMsg)) {
    return 'STATEMENT_TIMEOUT';
  }

  // YAML / frontmatter patterns.
  if (/YAML parse failed|YAML_PARSE/i.test(errorMsg)) return 'YAML_PARSE';
  if (/YAMLException|duplicated mapping key|YAML_DUPLICATE_KEY/i.test(errorMsg)) {
    return 'YAML_DUPLICATE_KEY';
  }
  if (/File is empty or whitespace-only|Frontmatter must start with ---|MISSING_OPEN/i.test(errorMsg)) {
    return 'MISSING_OPEN';
  }
  if (/No closing --- delimiter|Heading at line .* found inside frontmatter|MISSING_CLOSE/i.test(errorMsg)) {
    return 'MISSING_CLOSE';
  }
  if (/Frontmatter block is empty|EMPTY_FRONTMATTER/i.test(errorMsg)) return 'EMPTY_FRONTMATTER';
  if (/Content contains null bytes|NULL_BYTES|null byte/i.test(errorMsg)) return 'NULL_BYTES';
  if (/Nested double quotes|NESTED_QUOTES/i.test(errorMsg)) return 'NESTED_QUOTES';

  // Generic fallbacks.
  if (/invalid UTF-?8|INVALID_UTF8/i.test(errorMsg)) return 'INVALID_UTF8';
  if (/file too large|content too large|FILE_TOO_LARGE/i.test(errorMsg)) return 'FILE_TOO_LARGE';
  if (/skipping symlink|symlink|SYMLINK_NOT_ALLOWED/i.test(errorMsg)) return 'SYMLINK_NOT_ALLOWED';

  // takes-v2 fence + holder grammar failures.
  if (/TAKES_TABLE_MALFORMED|TAKES_ROW_NUM_COLLISION|TAKES_FENCE_UNBALANCED/i.test(errorMsg)) {
    return 'TAKES_TABLE_MALFORMED';
  }
  if (/TAKES_HOLDER_INVALID/i.test(errorMsg)) return 'TAKES_HOLDER_INVALID';

  // Embedding error classification.
  if (/embedding requires [A-Z][A-Z0-9_]+_API_KEY|EMBEDDING_NO_CREDS/i.test(errorMsg)) {
    return 'EMBEDDING_NO_CREDS';
  }
  if (/Anthropic has no embedding model|EMBEDDING_NO_TOUCHPOINT/i.test(errorMsg)) {
    return 'EMBEDDING_NO_TOUCHPOINT';
  }
  if (/\brate.?limit|\b429\b|too many requests|rate_limited|RateLimit/i.test(errorMsg)) {
    return 'EMBEDDING_RATE_LIMIT';
  }
  if (/insufficient_quota|quota exceeded|exceeded.*quota|credit balance is too low|billing|EMBEDDING_QUOTA/i.test(errorMsg)) {
    return 'EMBEDDING_QUOTA';
  }
  if (/maximum context length|max_tokens|context length|input too long|input length exceeds|tokens? exceed|too many tokens|EMBEDDING_OVERSIZE/i.test(errorMsg)) {
    return 'EMBEDDING_OVERSIZE';
  }

  // content-sanity reject disposition.
  if (/PAGE_JUNK_PATTERN/i.test(errorMsg)) return 'PAGE_JUNK_PATTERN';

  return 'UNKNOWN';
}

/** Group failures by error code and return a sorted summary. */
export function summarizeFailuresByCode(
  failures: Array<{ error: string; code?: string }>,
): Array<{ code: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const code = f.code ?? classifyErrorCode(f.error);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => ({ code, count }));
}

/**
 * Format a code-grouped summary as a human-readable multi-line string.
 * Accepts either raw failures (summarized internally) or an already-
 * summarized `{code, count}[]`. Empty input → empty string.
 */
export function formatCodeBreakdown(
  input: Array<{ error: string; code?: string }> | Array<{ code: string; count: number }>,
): string {
  const summary =
    input.length > 0 && typeof (input[0] as { count?: unknown }).count === 'number'
      ? (input as Array<{ code: string; count: number }>)
      : summarizeFailuresByCode(input as Array<{ error: string; code?: string }>);
  return summary.map(s => `  ${s.code}: ${s.count}`).join('\n');
}

function _failuresDir(): string {
  return _gbrainPath();
}

export function syncFailuresPath(): string {
  return _joinPath(_failuresDir(), 'sync-failures.jsonl');
}

function _ledgerKey(f: { source_id: string; path: string }): string {
  // NUL separator can't appear in a source id or path.
  return `${f.source_id} ${f.path}`;
}

// ─── State mirror ───────────────────────────────────────────────────

/**
 * Keep the legacy `acknowledged`/`acknowledged_at` fields consistent with
 * `state`. `auto_skipped` is intentionally NOT acknowledged (it is still an
 * unindexed page) so even a pre-#1939 reader counting `!acknowledged_at`
 * keeps surfacing it.
 */
function _applyMirror(f: SyncFailure): SyncFailure {
  if (f.state === 'acknowledged') {
    f.acknowledged = true;
    f.acknowledged_at = f.resolved_at ?? f.ts;
  } else {
    f.acknowledged = false;
    f.acknowledged_at = null;
  }
  return f;
}

// ─── Load + normalize ────────────────────────────────────────────────

function _normalizeRow(raw: Record<string, unknown>): SyncFailure {
  const source_id =
    typeof raw.source_id === 'string' && raw.source_id ? raw.source_id : DEFAULT_SOURCE_ID;
  const error = String(raw.error ?? '');
  const code = typeof raw.code === 'string' && raw.code ? raw.code : classifyErrorCode(error);
  const ts = typeof raw.ts === 'string' && raw.ts ? raw.ts : new Date(0).toISOString();
  const first_seen =
    typeof raw.first_seen === 'string' && raw.first_seen ? raw.first_seen : ts;
  let state: SyncFailureState;
  if (raw.state === 'open' || raw.state === 'acknowledged' || raw.state === 'auto_skipped') {
    state = raw.state;
  } else {
    state = raw.acknowledged === true || raw.acknowledged_at ? 'acknowledged' : 'open';
  }
  const attempts =
    typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) && raw.attempts > 0
      ? Math.floor(raw.attempts)
      : 1;
  const row: SyncFailure = {
    source_id,
    path: String(raw.path ?? ''),
    error,
    code,
    commit: String(raw.commit ?? ''),
    line: typeof raw.line === 'number' ? raw.line : undefined,
    first_seen,
    ts,
    attempts,
    state,
    resolved_at:
      typeof raw.resolved_at === 'string'
        ? raw.resolved_at
        : typeof raw.acknowledged_at === 'string'
          ? raw.acknowledged_at
          : undefined,
  };
  return _applyMirror(row);
}

/** Merge legacy duplicate rows for one (source_id, path) into a single row. */
function _mergeGroup(group: SyncFailure[]): SyncFailure {
  const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const latest = sorted[sorted.length - 1];
  const first_seen = sorted.reduce(
    (m, r) => (r.first_seen && r.first_seen < m ? r.first_seen : m),
    sorted[0].first_seen,
  );
  const hasOpen = group.some(r => r.state === 'open');
  const hasAuto = group.some(r => r.state === 'auto_skipped');
  const state: SyncFailureState = hasOpen ? 'open' : hasAuto ? 'auto_skipped' : 'acknowledged';
  // attempts reconstruction: distinct commits is a proxy for distinct runs;
  // never under-count below the largest recorded attempts.
  const distinctCommits = new Set(group.map(r => r.commit)).size;
  const maxAttempts = group.reduce((m, r) => Math.max(m, r.attempts), 0);
  const attempts = Math.max(distinctCommits, maxAttempts, 1);
  return _applyMirror({ ...latest, first_seen, state, attempts });
}

/**
 * Read the ledger, normalizing every row (backfill source_id/state/attempts/
 * first_seen) and collapsing duplicate (source_id, path) rows. Skips malformed
 * lines with a warning. Empty array if the file doesn't exist.
 */
export function loadSyncFailures(): SyncFailure[] {
  const path = syncFailuresPath();
  if (!_existsSync(path)) return [];
  const raw = _readFileSync(path, 'utf-8');
  const rows: SyncFailure[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(_normalizeRow(JSON.parse(trimmed) as Record<string, unknown>));
    } catch {
      console.warn(`[sync-failures] skipping malformed line: ${trimmed.slice(0, 120)}`);
    }
  }
  const byKey = new Map<string, SyncFailure[]>();
  for (const r of rows) {
    const k = _ledgerKey(r);
    const arr = byKey.get(k);
    if (arr) arr.push(r);
    else byKey.set(k, [r]);
  }
  const out: SyncFailure[] = [];
  for (const group of byKey.values()) {
    out.push(group.length === 1 ? group[0] : _mergeGroup(group));
  }
  return out;
}

/** Unresolved failures (open + auto_skipped). */
export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter(e => e.state !== 'acknowledged');
}

// ─── Concurrency: cross-process lock + atomic write ──────────────────

function _sleepSync(ms: number): void {
  // Synchronous sleep without busy-spin; works in Node + Bun.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function _acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      _closeSync(_openSync(lockPath, 'wx'));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return false; // best-effort
      // Age-based stale break (prefer age over PID liveness, per db-lock learning).
      try {
        const st = _statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { _unlinkSync(lockPath); } catch { /* raced; retry */ }
          continue;
        }
      } catch {
        continue; // lock vanished underfoot; retry acquire
      }
      if (Date.now() >= deadline) return false;
      _sleepSync(LOCK_SPIN_MS);
    }
  }
}

/**
 * Serialize a read-modify-write of the ledger across processes
 * (`sync --all`, per-source cron). Falls back to best-effort (no lock) on
 * acquire timeout so a sync is never deadlocked by a wedged lock holder.
 */
export function withLedgerLock<T>(fn: () => T): T {
  _mkdirSync(_failuresDir(), { recursive: true });
  const lockPath = syncFailuresPath() + '.lock';
  const got = _acquireLock(lockPath);
  if (!got) {
    console.warn('[sync-failures] could not acquire ledger lock; proceeding best-effort');
  }
  try {
    return fn();
  } finally {
    if (got) {
      try { _unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

function _writeAll(entries: SyncFailure[]): void {
  _mkdirSync(_failuresDir(), { recursive: true });
  const target = syncFailuresPath();
  const tmp = `${target}.tmp-${process.pid}`;
  const body = entries.map(e => JSON.stringify(e)).join('\n');
  _writeFileSync(tmp, entries.length ? body + '\n' : '');
  _renameSync(tmp, target); // atomic on POSIX
}

// ─── Mutations ───────────────────────────────────────────────────────

/**
 * Record this run's failures AND clear succeeded paths in ONE locked
 * transaction. Returns post-state attempts for each failing path.
 *
 * Upsert is keyed by (source_id, path) over OPEN rows: an existing open row
 * increments `attempts` (consecutive); anything else (no row, or an
 * acknowledged/auto_skipped row) starts a fresh open row at attempts 1 — a
 * re-failure after a fix is a new streak (#1939 Codex #4).
 */
function _recordAndClear(
  sourceId: string,
  succeededPaths: string[],
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): Map<string, number> {
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const byKey = new Map<string, SyncFailure>();
    for (const e of entries) byKey.set(_ledgerKey(e), e);
    let mutated = false;

    // Resolve succeeded paths (success fully clears the row — #1939 Codex #4).
    for (const p of succeededPaths) {
      if (byKey.delete(_ledgerKey({ source_id: sourceId, path: p }))) mutated = true;
    }

    const now = new Date().toISOString();
    for (const f of failures) {
      const key = _ledgerKey({ source_id: sourceId, path: f.path });
      const ex = byKey.get(key);
      const code = classifyErrorCode(f.error);
      if (ex && ex.state === 'open') {
        ex.attempts += 1;
        ex.ts = now;
        ex.commit = commit;
        ex.error = f.error;
        ex.code = code;
        ex.line = f.line;
        _applyMirror(ex);
      } else {
        byKey.set(
          key,
          _applyMirror({
            source_id: sourceId,
            path: f.path,
            error: f.error,
            code,
            commit,
            line: f.line,
            first_seen: now,
            ts: now,
            attempts: 1,
            state: 'open',
          }),
        );
      }
      mutated = true;
    }

    // Skip the write (and avoid creating an empty ledger file) when a clean run
    // touched nothing — e.g. succeeded paths that had no prior failure rows.
    if (mutated) _writeAll([...byKey.values()]);

    const attempts = new Map<string, number>();
    for (const f of failures) {
      attempts.set(
        f.path,
        byKey.get(_ledgerKey({ source_id: sourceId, path: f.path }))?.attempts ?? 1,
      );
    }
    return attempts;
  });
}

/**
 * Public single-purpose recorder (no clear). Used by callers outside the
 * sync gate (e.g. `gbrain import`). Increments attempts like the gate.
 */
export function recordFailures(
  sourceId: string,
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  if (failures.length === 0) return;
  _recordAndClear(sourceId, [], failures, commit);
}

/** Remove ledger rows for the given (sourceId, paths) — used on success. */
export function clearFailures(sourceId: string, paths: string[]): void {
  if (paths.length === 0) return;
  withLedgerLock(() => {
    const entries = loadSyncFailures();
    const remove = new Set(paths.map(p => _ledgerKey({ source_id: sourceId, path: p })));
    const kept = entries.filter(e => !remove.has(_ledgerKey(e)));
    if (kept.length !== entries.length) _writeAll(kept);
  });
}

/**
 * Acknowledge OPEN file failures (human `--skip-failed`). Scoped to one
 * source when `sourceId` is given (never acks another source — #1939 Codex
 * #2). Sentinels (`<head>`) are NEVER acknowledged this way.
 */
export function acknowledgeFailures(sourceId?: string): AcknowledgeResult {
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const now = new Date().toISOString();
    let changed = 0;
    const acked: SyncFailure[] = [];
    for (const e of entries) {
      if (e.state !== 'open') continue;
      if (sourceId !== undefined && e.source_id !== sourceId) continue;
      if (!isSkippablePath(e.path)) continue;
      e.state = 'acknowledged';
      e.resolved_at = now;
      _applyMirror(e);
      changed++;
      acked.push(e);
    }
    if (changed > 0) _writeAll(entries);
    return { count: changed, summary: summarizeFailuresByCode(acked) };
  });
}

/**
 * Mark the given chronic file paths `auto_skipped` (valve fired). Only OPEN,
 * non-sentinel rows transition. Auto-skipped rows stay UNRESOLVED so doctor
 * keeps warning until the file imports cleanly.
 */
export function autoSkipFailures(sourceId: string, paths: string[]): AcknowledgeResult {
  if (paths.length === 0) return { count: 0, summary: [] };
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const target = new Set(
      paths.filter(isSkippablePath).map(p => _ledgerKey({ source_id: sourceId, path: p })),
    );
    const now = new Date().toISOString();
    let changed = 0;
    const skipped: SyncFailure[] = [];
    for (const e of entries) {
      if (!target.has(_ledgerKey(e))) continue;
      if (e.state !== 'open') continue;
      e.state = 'auto_skipped';
      e.resolved_at = now;
      _applyMirror(e);
      changed++;
      skipped.push(e);
    }
    if (changed > 0) _writeAll(entries);
    return { count: changed, summary: summarizeFailuresByCode(skipped) };
  });
}

// ─── Legacy shims (re-exported from sync.ts for existing callers) ─────

/** @deprecated use recordFailures(sourceId, …). Defaults to the host source. */
export function recordSyncFailures(
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  recordFailures(DEFAULT_SOURCE_ID, failures, commit);
}

/** @deprecated use acknowledgeFailures(sourceId). Acks ALL sources' open files. */
export function acknowledgeSyncFailures(): AcknowledgeResult {
  return acknowledgeFailures(undefined);
}

// ─── Pure decisions (no side effects — the unit-test surface) ─────────

export interface GateDecision {
  action: 'hard_block' | 'block' | 'advance' | 'advance_then_autoskip';
  autoSkipPaths: string[];
}

/**
 * Decide what the sync gate should do, given this run's failures and the
 * current attempt counts. Pure — the caller executes effects in the safe
 * order (advance THEN ack, so a crash can't mark a file skipped while the
 * sync stays wedged — #1939 Codex #5).
 *
 *   sentinels present                 → hard_block (ALWAYS, even --skip-failed)
 *   no file failures                  → advance
 *   --skip-failed                     → advance (ack handled post-advance)
 *   valve disabled (threshold<=0)     → block (pure fail-closed) if failures
 *   any fresh (attempts<threshold)    → block
 *   all chronic (attempts>=threshold) → advance_then_autoskip
 */
export function decideGateAction(args: {
  fileFailures: Array<{ path: string }>;
  sentinels: Array<{ path: string }>;
  attemptsByPath: Map<string, number>;
  threshold: number;
  skipFailed: boolean;
}): GateDecision {
  if (args.sentinels.length > 0) return { action: 'hard_block', autoSkipPaths: [] };
  if (args.fileFailures.length === 0) return { action: 'advance', autoSkipPaths: [] };
  if (args.skipFailed) return { action: 'advance', autoSkipPaths: [] };
  if (args.threshold <= 0) return { action: 'block', autoSkipPaths: [] };

  const chronic: string[] = [];
  let fresh = 0;
  for (const f of args.fileFailures) {
    const a = args.attemptsByPath.get(f.path) ?? 1;
    if (a >= args.threshold) chronic.push(f.path);
    else fresh++;
  }
  if (fresh > 0) return { action: 'block', autoSkipPaths: [] };
  if (chronic.length > 0) return { action: 'advance_then_autoskip', autoSkipPaths: chronic };
  return { action: 'block', autoSkipPaths: [] };
}

export interface SeverityResult {
  status: 'ok' | 'warn' | 'fail';
  unresolved: number;
  open: number;
  auto_skipped: number;
}

/**
 * Decide the `sync_failures` doctor severity from ledger entries. Pure;
 * `nowMs` is injected for deterministic boundary tests. Both doctor surfaces
 * (local + remote) call this so they can never drift (#1939 Codex #1).
 *
 *   unresolved (open|auto_skipped) == 0      → ok
 *   oldest OPEN older than failHours, OR
 *     total unresolved >= 10                 → fail
 *   else (incl. auto_skipped-only)           → warn (stays visible)
 *   malformed ts → treated as not-old (never crashes doctor)
 */
export function decideSyncFailureSeverity(args: {
  entries: SyncFailure[];
  nowMs: number;
  failHours: number;
}): SeverityResult {
  const unresolved = args.entries.filter(
    e => e.state === 'open' || e.state === 'auto_skipped',
  );
  const autoSkipped = unresolved.filter(e => e.state === 'auto_skipped').length;
  const open = unresolved.length - autoSkipped;
  if (unresolved.length === 0) {
    return { status: 'ok', unresolved: 0, open: 0, auto_skipped: 0 };
  }
  let oldestOpenMs = Infinity;
  for (const e of unresolved) {
    if (e.state !== 'open') continue;
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms)) oldestOpenMs = Math.min(oldestOpenMs, ms);
  }
  const blockedTooLong =
    Number.isFinite(oldestOpenMs) && args.nowMs - oldestOpenMs > args.failHours * 3_600_000;
  // FAIL keys off OPEN (blocking) failures only — many open, or one blocking the
  // bookmark past the fail cadence. `auto_skipped` rows already advanced the
  // bookmark (indexing is NOT wedged) so they stay WARN-visible regardless of
  // count, matching the state-machine contract. (#1939 adversarial finding #3.)
  const status: 'warn' | 'fail' = open >= 10 || blockedTooLong ? 'fail' : 'warn';
  return { status, unresolved: unresolved.length, open, auto_skipped: autoSkipped };
}

// ─── Shared gate orchestrator (incremental + full sync) ──────────────

export interface SyncGateInput {
  sourceId: string;
  /** All per-file failures this run, including sentinels like `<head>`. */
  failedFiles: Array<{ path: string; error: string; line?: number }>;
  /** File paths that imported successfully this run (clears their rows). */
  succeededPaths: string[];
  /** Pin commit the run drained to (stamped on recorded failures). */
  commit: string;
  skipFailed: boolean;
  threshold?: number;
  /** Advances the bookmark + clears checkpoints. Awaited BEFORE any ack. */
  advance: () => Promise<void> | void;
}

export interface SyncGateOutcome {
  advanced: boolean;
  sentinelBlocked: boolean;
  fresh: number;
  chronic: number;
  autoSkipped: string[];
  acknowledged: number;
}

/**
 * The one gate both sync paths share (#1939 Codex #6). Records/clears the
 * ledger under a single lock, decides, then on advance runs `advance()`
 * FIRST and only marks auto_skipped/acknowledged afterwards (#1939 Codex #5).
 */
export async function applySyncFailureGate(input: SyncGateInput): Promise<SyncGateOutcome> {
  const threshold = input.threshold ?? resolveAutoSkipThreshold();
  const sentinels = input.failedFiles.filter(f => !isSkippablePath(f.path));
  const fileFailures = input.failedFiles.filter(f => isSkippablePath(f.path));

  // Fast path: clean run touched no failures and no successes — nothing to
  // reconcile in the ledger, just advance.
  if (input.failedFiles.length === 0 && input.succeededPaths.length === 0) {
    await input.advance();
    return {
      advanced: true,
      sentinelBlocked: false,
      fresh: 0,
      chronic: 0,
      autoSkipped: [],
      acknowledged: 0,
    };
  }

  const attemptsByPath = _recordAndClear(
    input.sourceId,
    input.succeededPaths,
    input.failedFiles,
    input.commit,
  );

  const decision = decideGateAction({
    fileFailures,
    sentinels,
    attemptsByPath,
    threshold,
    skipFailed: input.skipFailed,
  });

  let fresh = 0;
  let chronic = 0;
  for (const f of fileFailures) {
    if ((attemptsByPath.get(f.path) ?? 1) >= threshold && threshold > 0) chronic++;
    else fresh++;
  }

  if (decision.action === 'hard_block' || decision.action === 'block') {
    return {
      advanced: false,
      sentinelBlocked: decision.action === 'hard_block',
      fresh,
      chronic,
      autoSkipped: [],
      acknowledged: 0,
    };
  }

  // ATOMICITY: advance the bookmark BEFORE marking anything skipped/acked.
  await input.advance();

  let autoSkipped: string[] = [];
  let acknowledged = 0;
  if (input.skipFailed) {
    acknowledged = acknowledgeFailures(input.sourceId).count;
  } else if (decision.action === 'advance_then_autoskip') {
    autoSkipped = decision.autoSkipPaths;
    autoSkipFailures(input.sourceId, autoSkipped);
  }

  return {
    advanced: true,
    sentinelBlocked: false,
    fresh,
    chronic,
    autoSkipped,
    acknowledged,
  };
}
