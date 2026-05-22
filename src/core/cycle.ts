/**
 * src/core/cycle.ts — The brain maintenance cycle primitive.
 *
 * Composes lint, backlinks, sync, extract, embed, and orphans into
 * one honest unit of work. Called from:
 *   - `gbrain dream` (CLI alias; one-shot cron-triggered cycle)
 *   - `gbrain autopilot` (daemon; scheduled on an interval)
 *   - Minions `autopilot-cycle` handler (durable queue; retry + observability)
 *
 * All three converge on runCycle() so there's one source of truth for
 * what "overnight maintenance" means.
 *
 * PHASE ORDER (semantically driven — fix files first, then index):
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ Phase 1: lint --fix         (filesystem writes, no DB)    │
 *   │ Phase 2: backlinks --fix    (filesystem writes, no DB)    │
 *   │ Phase 3: sync               (DB picks up phases 1+2)      │
 *   │ Phase 4: synthesize         (v0.23: transcripts → pages)  │
 *   │ Phase 5: extract            (DB picks up links from sync  │
 *   │                              + synthesize)                │
 *   │ Phase 6: patterns           (v0.23: cross-session themes; │
 *   │                              MUST be after extract so     │
 *   │                              graph state is fresh)        │
 *   │ Phase 7: embed --stale      (DB writes)                   │
 *   │ Phase 8: orphans            (DB read, report only)        │
 *   └───────────────────────────────────────────────────────────┘
 *
 * COORDINATION:
 *
 * Postgres: a row in gbrain_cycle_locks with a TTL (30 min). Refreshed
 * between phases via yieldBetweenPhases. Works through PgBouncer
 * transaction pooling (session-scoped pg_try_advisory_lock does not).
 *
 * PGLite / engine=null: a file lock at ~/.gbrain/cycle.lock holding
 * the PID + mtime. Same 30-min TTL semantics.
 *
 * LOCK-SKIP:
 *
 * Filesystem-only or read-only phase selections (lint, backlinks,
 * orphans) skip the lock. Only DB-write phases (sync, extract, embed)
 * trigger lock acquisition.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { gbrainPath } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { createProgress, type ProgressReporter } from './progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from './cli-options.ts';

// ─── Types ─────────────────────────────────────────────────────────

export type CyclePhase = 'lint' | 'backlinks' | 'sync' | 'synthesize' | 'extract' | 'patterns' | 'embed' | 'orphans' | 'purge';

export const ALL_PHASES: CyclePhase[] = [
  'lint',
  'backlinks',
  'sync',
  'synthesize',
  'extract',
  'patterns',
  'embed',
  'orphans',
  // v0.26.5: hard-deletes soft-deleted pages and expired archived sources past
  // the 72h recovery window. Runs last so the rest of the cycle sees the
  // recoverable set; the purge then drops what's expired.
  'purge',
];

/**
 * Phases that mutate state (filesystem or DB) and therefore should
 * coordinate via the cycle lock. Only orphans is truly read-only
 * and skips the lock. patterns mutates DB (writes pattern pages) so
 * it acquires the lock; synthesize too. v0.26.5 adds purge (DELETE-cascade
 * across pages and sources).
 */
const NEEDS_LOCK_PHASES: ReadonlySet<CyclePhase> = new Set([
  'lint',
  'backlinks',
  'sync',
  'synthesize',
  'extract',
  'patterns',
  'embed',
  'purge',
]);

export type PhaseStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface PhaseError {
  /** Error class for machine branching — e.g., 'DatabaseConnection', 'Timeout', 'LLMError', 'FilesystemError', 'InternalError'. */
  class: string;
  /** System error code or short identifier, e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'UNKNOWN'. */
  code: string;
  /** Human-readable single-line message. */
  message: string;
  /** Optional suggestion of what to try next. */
  hint?: string;
  /** Optional link to a troubleshooting doc. */
  docs_url?: string;
}

export interface PhaseResult {
  phase: CyclePhase;
  status: PhaseStatus;
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
  error?: PhaseError;
}

export type CycleStatus = 'ok' | 'clean' | 'partial' | 'skipped' | 'failed';

export interface CycleReport {
  /** Additive schema. Bumped on breaking changes. */
  schema_version: '1';
  timestamp: string;
  duration_ms: number;
  /**
   * Overall status derived from phase results:
   *   - 'clean'   : ran successfully, zero fixes/writes across every phase
   *   - 'ok'      : ran successfully, some work was done
   *   - 'partial' : at least one phase warned or failed, others ran
   *   - 'skipped' : cycle did not run (lock held by another holder)
   *   - 'failed'  : lock acquired but all attempted phases failed
   */
  status: CycleStatus;
  /** Present when status = 'skipped'. E.g., 'cycle_already_running' or 'no_database'. */
  reason?: string;
  brain_dir: string | null;
  phases: PhaseResult[];
  totals: {
    lint_fixes: number;
    backlinks_added: number;
    pages_synced: number;
    pages_extracted: number;
    pages_embedded: number;
    orphans_found: number;
    /** v0.23: number of transcripts the synthesize phase processed (judged + dispatched). */
    transcripts_processed: number;
    /** v0.23: number of new reflection/original/people pages written by synthesize. */
    synth_pages_written: number;
    /** v0.23: number of pattern pages written/updated by patterns phase. */
    patterns_written: number;
    /** v0.26.5: number of source rows hard-deleted by the purge phase. */
    purged_sources_count: number;
    /** v0.26.5: number of page rows hard-deleted by the purge phase. */
    purged_pages_count: number;
  };
}

export interface CycleOpts {
  /** If true, no writes to filesystem or DB. All phases honor this. */
  dryRun?: boolean;
  /** Defaults to ALL_PHASES. Pass a subset for --phase lint etc. */
  phases?: CyclePhase[];
  /** Brain directory (git repo). Required for filesystem phases. */
  brainDir: string;
  /** Whether sync should run `git pull`. Default false (cron-safe). */
  pull?: boolean;
  /**
   * Called between phases AND before runCycle returns. Awaited even
   * after phase failure. Hook exceptions are logged, never fatal.
   * Minions handlers pass a function that yields + renews the job lock
   * + refreshes the cycle-lock-table TTL.
   */
  yieldBetweenPhases?: () => Promise<void>;
  /**
   * Generic in-phase keepalive (v0.23). Long-running phases (synthesize
   * waiting on a fan-out aggregator, patterns rolling up reflections)
   * call this periodically while idle to renew the cycle-lock TTL and
   * the Minions worker job lock. Mirrors `yieldBetweenPhases` shape;
   * passing the same function for both is the common case.
   */
  yieldDuringPhase?: () => Promise<void>;
  /**
   * Synthesize phase scope overrides (v0.23). Forwarded to runPhaseSynthesize.
   * - `synthInputFile`: ad-hoc transcript path (`gbrain dream --input <file>`).
   * - `synthDate` / `synthFrom` / `synthTo`: date filters for corpus scan.
   * Mutually exclusive with each other in CLI parsing; runner trusts the
   * caller (CLI wrapper validates).
   */
  synthInputFile?: string;
  synthDate?: string;
  synthFrom?: string;
  synthTo?: string;
  /**
   * v0.23.2: explicit opt-in to disable the synthesize self-consumption guard.
   * Wired from `gbrain dream --unsafe-bypass-dream-guard`. Never auto-applied
   * for `--input` because that would let any caller silently re-trigger the
   * loop bug (codex finding #3).
   */
  synthBypassDreamGuard?: boolean;
  /**
   * AbortSignal from the Minions worker (v0.22.1, #403). When aborted
   * (timeout, cancel, lock-loss), runCycle bails between phases and
   * returns a 'failed' report instead of running the next phase. Without
   * this, a timed-out autopilot-cycle handler ignores the abort and runs
   * until the worker wedges (the 98-waiting-0-active incident on 2026-04-24).
   */
  signal?: AbortSignal;
}

// ─── Lock primitives ───────────────────────────────────────────────

const CYCLE_LOCK_ID = 'gbrain-cycle';
const LOCK_TTL_MS = 30 * 60 * 1000;       // 30 minutes
// Lazy: GBRAIN_HOME may be set after module load; resolve at call time.
const getLockFilePathDefault = () => gbrainPath('cycle.lock');

interface LockHandle {
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Acquire the Postgres-backed cycle lock.
 * Returns a LockHandle on success, or null if another live holder has it.
 *
 * Uses INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE ttl_expires_at < NOW()
 * RETURNING *. An empty RETURNING means the existing row is still live.
 * Crashed holders auto-release: when their TTL expires, the next
 * acquirer's UPDATE branch fires and takes over.
 */
async function acquirePostgresLock(engine: BrainEngine): Promise<LockHandle | null> {
  const pid = process.pid;
  const host = hostname();
  // Engine-agnostic: BrainEngine exposes findOrphanPages etc., but not raw SQL.
  // We reach through the engine's internal connection for this lock operation.
  // Both engines expose `sql` (postgres-js tag) or `db.query` (PGLite).
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as { db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } };

  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const rows: Array<{ id: string }> = await sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES (${CYCLE_LOCK_ID}, ${pid}, ${host}, NOW(), NOW() + INTERVAL '30 minutes')
      ON CONFLICT (id) DO UPDATE
        SET holder_pid = ${pid},
            holder_host = ${host},
            acquired_at = NOW(),
            ttl_expires_at = NOW() + INTERVAL '30 minutes'
        WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
      RETURNING id
    `;
    if (rows.length === 0) return null; // live holder
    return {
      refresh: async () => {
        await sql`
          UPDATE gbrain_cycle_locks
            SET ttl_expires_at = NOW() + INTERVAL '30 minutes'
          WHERE id = ${CYCLE_LOCK_ID} AND holder_pid = ${pid}
        `;
      },
      release: async () => {
        await sql`
          DELETE FROM gbrain_cycle_locks
          WHERE id = ${CYCLE_LOCK_ID} AND holder_pid = ${pid}
        `;
      },
    };
  }

  if (engine.kind === 'pglite' && maybePGLite.db) {
    // PGLite is single-writer; the DB row is belt-and-braces on top of the
    // file lock. Callers always hold the file lock first, so this UPSERT
    // is race-free against other processes.
    const db = maybePGLite.db;
    const { rows } = await db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 minutes')
       ON CONFLICT (id) DO UPDATE
         SET holder_pid = $2,
             holder_host = $3,
             acquired_at = NOW(),
             ttl_expires_at = NOW() + INTERVAL '30 minutes'
         WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
       RETURNING id`,
      [CYCLE_LOCK_ID, pid, host],
    );
    if (rows.length === 0) return null;
    return {
      refresh: async () => {
        await db.query(
          `UPDATE gbrain_cycle_locks
              SET ttl_expires_at = NOW() + INTERVAL '30 minutes'
            WHERE id = $1 AND holder_pid = $2`,
          [CYCLE_LOCK_ID, pid],
        );
      },
      release: async () => {
        await db.query(
          `DELETE FROM gbrain_cycle_locks WHERE id = $1 AND holder_pid = $2`,
          [CYCLE_LOCK_ID, pid],
        );
      },
    };
  }

  throw new Error(`Unknown engine kind: ${engine.kind}`);
}

/**
 * Acquire the file-based cycle lock (used when engine === null).
 * Returns a LockHandle on success, or null if a live holder has it.
 *
 * The file contains `{pid}\n{iso-timestamp}`. Staleness = mtime older
 * than LOCK_TTL_MS OR the PID is no longer alive on this host.
 */
function acquireFileLock(lockPath = getLockFilePathDefault()): LockHandle | null {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  const pid = process.pid;

  if (existsSync(lockPath)) {
    // Check TTL.
    try {
      const st = statSync(lockPath);
      const ageMs = Date.now() - st.mtimeMs;
      const existingContent = readFileSync(lockPath, 'utf-8').trim();
      const existingPid = parseInt(existingContent.split('\n')[0] || '0', 10);

      // PID liveness check (same host only). kill(pid, 0) distinguishes:
      //   - success         → process exists, caller can signal it
      //   - error ESRCH     → no such process (truly dead)
      //   - error EPERM     → process exists but caller can't signal it
      //                       (e.g., PID 1/init on unix) → still alive
      // Any error code OTHER than ESRCH means the PID is alive.
      let pidAlive = false;
      if (existingPid > 0 && existingPid !== pid) {
        try {
          process.kill(existingPid, 0);
          pidAlive = true;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          pidAlive = code !== 'ESRCH';
        }
      } else if (existingPid === pid) {
        // Our own stale lock (same pid, previous run) — treat as stale.
        pidAlive = false;
      }

      if (pidAlive && ageMs < LOCK_TTL_MS) {
        return null; // live holder
      }
      // Stale lock — fall through to overwrite.
    } catch {
      // Any read/stat error: treat as stale.
    }
  }

  writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n`);

  return {
    refresh: async () => {
      try {
        writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n`);
      } catch {
        /* non-fatal — a next-run stale check will notice */
      }
    },
    release: async () => {
      try {
        const content = readFileSync(lockPath, 'utf-8').trim();
        const heldPid = parseInt(content.split('\n')[0] || '0', 10);
        if (heldPid === pid) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function makeErrorFromException(e: unknown, fallbackClass = 'InternalError'): PhaseError {
  const err = e instanceof Error ? e : new Error(String(e));
  // Node errors often have .code (e.g., 'ECONNREFUSED').
  const code = (err as NodeJS.ErrnoException).code || 'UNKNOWN';
  let className = fallbackClass;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') className = 'DatabaseConnection';
  if (code === 'ETIMEDOUT') className = 'Timeout';
  if (/OpenAI|embed/i.test(err.message)) className = 'LLMError';
  if (/ENOENT|EACCES|EISDIR|ENOTDIR/.test(code)) className = 'FilesystemError';
  return {
    class: className,
    code,
    message: err.message.slice(0, 200),
  };
}

async function timePhase<T>(fn: () => Promise<T>): Promise<{ result: T; duration_ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, duration_ms: Math.round(performance.now() - start) };
}

async function safeYield(hook?: () => Promise<void>) {
  if (!hook) return;
  try {
    await hook();
  } catch (e) {
    console.warn(`[cycle] yieldBetweenPhases hook error (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Check if the abort signal has fired. Called between phases so that a
 * timed-out Minions job bails promptly instead of grinding through all
 * remaining phases while the worker thinks it's still at capacity.
 */
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error
      ? signal.reason.message
      : String(signal.reason || 'aborted');
    throw new Error(`[cycle] aborted between phases: ${reason}`);
  }
}

// ─── Phase runners ─────────────────────────────────────────────────

async function runPhaseLint(brainDir: string, dryRun: boolean): Promise<PhaseResult> {
  try {
    const { runLintCore } = await import('../commands/lint.ts');
    const result = await runLintCore({ target: brainDir, fix: true, dryRun });
    const issues = result.total_issues ?? 0;
    const fixed = result.total_fixed ?? 0;
    const remaining = Math.max(0, issues - fixed);
    // 'ok' when nothing noteworthy remains:
    //   - no issues at all, or
    //   - non-dry-run and everything fixable was fixed.
    // 'warn' when issues remain after the run.
    const status: PhaseStatus =
      issues === 0 || (!dryRun && remaining === 0) ? 'ok' : 'warn';
    return {
      phase: 'lint',
      status,
      duration_ms: 0, // set by caller
      summary: dryRun
        ? `${issues} issue(s) found (dry-run, no writes)`
        : `${fixed} fix(es) applied, ${remaining} remaining`,
      details: { issues, fixed, pages_scanned: result.pages_scanned, dryRun },
    };
  } catch (e) {
    return {
      phase: 'lint',
      status: 'fail',
      duration_ms: 0,
      summary: 'lint phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

async function runPhaseBacklinks(brainDir: string, dryRun: boolean): Promise<PhaseResult> {
  try {
    // Library function path — the v0.15 backlinks.ts exports
    // runBacklinksCore when --fix is requested.
    const { runBacklinksCore } = await import('../commands/backlinks.ts');
    const result = await runBacklinksCore({
      action: 'fix',
      dir: brainDir,
      dryRun,
    });
    const gaps = result.gaps_found ?? 0;
    const added = result.fixed ?? 0;
    const remaining = Math.max(0, gaps - added);
    const status: PhaseStatus =
      gaps === 0 || (!dryRun && remaining === 0) ? 'ok' : 'warn';
    return {
      phase: 'backlinks',
      status,
      duration_ms: 0,
      summary: dryRun
        ? `${gaps} missing back-link(s) (dry-run)`
        : `${added} back-link(s) added, ${remaining} remaining`,
      details: { gaps, added, pages_affected: result.pages_affected, dryRun },
    };
  } catch (e) {
    return {
      phase: 'backlinks',
      status: 'fail',
      duration_ms: 0,
      summary: 'backlinks phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

/** Extended sync result that also carries the changed slug list for downstream phases. */
interface SyncPhaseResult extends PhaseResult {
  /** Slugs that sync added or modified. Used by extract for incremental processing. */
  pagesAffected?: string[];
}

/**
 * Resolve the source id for a brain directory by looking up the sources
 * table. Returns undefined when no registered source matches (falls back
 * to pre-v0.18 global config.sync.* keys).
 */
async function resolveSourceForDir(
  engine: BrainEngine,
  brainDir: string,
): Promise<string | undefined> {
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE local_path = $1 LIMIT 1`,
      [brainDir],
    );
    return rows[0]?.id;
  } catch {
    // sources table might not exist on very old brains — fall through.
    return undefined;
  }
}

async function runPhaseSync(
  engine: BrainEngine,
  brainDir: string,
  dryRun: boolean,
  pull: boolean,
  willRunExtractPhase: boolean,
): Promise<SyncPhaseResult> {
  try {
    const { performSync } = await import('../commands/sync.ts');
    // Resolve the per-source id so sync reads source-scoped last_commit
    // instead of the global config key. The global key can drift out of
    // git history (force push, GC) causing a full reimport of all files.
    const sourceId = await resolveSourceForDir(engine, brainDir);
    const result = await performSync(engine, {
      repoPath: brainDir,
      sourceId,
      dryRun,
      noPull: !pull,
      noEmbed: true,                       // embed is a separate phase
      noExtract: willRunExtractPhase,      // dedupe ONLY when cycle's extract phase will also run.
                                           // If extract isn't scheduled (e.g. `gbrain dream --phase sync`),
                                           // sync's inline extract still runs to preserve prior behavior.
    });
    const syncedCount = result.added + result.modified;
    return {
      phase: 'sync',
      status: result.status === 'blocked_by_failures' ? 'warn' : 'ok',
      duration_ms: 0,
      summary: dryRun
        ? `${syncedCount} page(s) would sync, ${result.deleted} would delete`
        : `+${result.added} added, ~${result.modified} modified, -${result.deleted} deleted`,
      details: {
        added: result.added,
        modified: result.modified,
        deleted: result.deleted,
        renamed: result.renamed,
        chunksCreated: result.chunksCreated,
        failedFiles: result.failedFiles ?? 0,
        syncStatus: result.status,
        dryRun,
      },
      pagesAffected: result.pagesAffected,
    };
  } catch (e) {
    return {
      phase: 'sync',
      status: 'fail',
      duration_ms: 0,
      summary: 'sync phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

async function runPhaseExtract(
  engine: BrainEngine,
  brainDir: string,
  dryRun: boolean,
  changedSlugs?: string[],
): Promise<PhaseResult> {
  try {
    const { runExtractCore } = await import('../commands/extract.ts');
    // Extract is read-mostly against the filesystem + write to links table.
    // Honor dryRun by skipping with a 'skipped' entry: extract doesn't have
    // a clean dry-run mode today and runCycle should be honest about it.
    if (dryRun) {
      return {
        phase: 'extract',
        status: 'skipped',
        duration_ms: 0,
        summary: 'dry-run: extract phase skipped (no dry-run mode yet)',
        details: { dryRun: true, reason: 'no_dry_run_support' },
      };
    }
    // Incremental path: if sync told us which slugs changed, only extract those.
    // On a 54K-page brain this turns a 10-minute full walk into a sub-second pass.
    const result = await runExtractCore(engine, {
      mode: 'all',
      dir: brainDir,
      slugs: changedSlugs,  // undefined = full walk (first run / manual)
    });
    const linksCreated = result?.links_created ?? 0;
    const timelineCreated = result?.timeline_entries_created ?? 0;
    const incremental = changedSlugs !== undefined;
    return {
      phase: 'extract',
      status: 'ok',
      duration_ms: 0,
      summary: incremental
        ? `${linksCreated} link(s), ${timelineCreated} timeline entries (incremental: ${changedSlugs.length} slugs)`
        : `${linksCreated} link(s), ${timelineCreated} timeline entries`,
      details: {
        linksCreated, timelineCreated,
        pages_processed: result?.pages_processed ?? 0,
        incremental,
        ...(incremental ? { slugs_targeted: changedSlugs.length } : {}),
      },
    };
  } catch (e) {
    return {
      phase: 'extract',
      status: 'fail',
      duration_ms: 0,
      summary: 'extract phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

async function runPhaseEmbed(engine: BrainEngine, dryRun: boolean): Promise<PhaseResult> {
  try {
    const { runEmbedCore } = await import('../commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true, dryRun });
    const embeddedCount = dryRun ? result.would_embed : result.embedded;
    return {
      phase: 'embed',
      status: 'ok',
      duration_ms: 0,
      summary: dryRun
        ? `${result.would_embed} chunk(s) would be embedded (dry-run)`
        : `${result.embedded} chunk(s) newly embedded (${result.skipped} already had embeddings)`,
      details: {
        embedded: result.embedded,
        skipped: result.skipped,
        would_embed: result.would_embed,
        total_chunks: result.total_chunks,
        pages_processed: result.pages_processed,
        dryRun,
        // Convenience field used by CycleReport.totals.pages_embedded.
        // In dry-run, this counts pages with stale chunks that would
        // have been processed (same semantic as a real run).
        pages_embedded_count: dryRun ? result.pages_processed : embeddedCount > 0 ? result.pages_processed : 0,
      },
    };
  } catch (e) {
    return {
      phase: 'embed',
      status: 'fail',
      duration_ms: 0,
      summary: 'embed phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

/**
 * v0.26.5 — purge phase. Hard-deletes:
 *  - source rows where `archived = true AND archive_expires_at <= now()`
 *    (paired with the cascade FK to `pages`, this also drops the source's pages)
 *  - page rows where `deleted_at` is older than 72h
 *
 * Cascade on `pages` covers `content_chunks`, `page_links`, `chunk_relations`.
 * `dryRun` short-circuits — no DELETEs are issued.
 *
 * Mirrors the operator escape hatches: `gbrain sources purge` (no id) and
 * `gbrain pages purge-deleted` both call the same library functions, so
 * scripted purges and the autopilot phase converge on a single behavior.
 */
async function runPhasePurge(engine: BrainEngine, dryRun: boolean): Promise<PhaseResult> {
  try {
    if (dryRun) {
      return {
        phase: 'purge',
        status: 'ok',
        duration_ms: 0,
        summary: 'dry-run: skipped purge sweep',
        details: { dry_run: true, purged_sources_count: 0, purged_pages_count: 0 },
      };
    }
    const { purgeExpiredSources } = await import('./destructive-guard.ts');
    const purgedSources = await purgeExpiredSources(engine);
    const purgedPages = await engine.purgeDeletedPages(SOFT_DELETE_TTL_HOURS_FOR_PURGE);
    return {
      phase: 'purge',
      status: 'ok',
      duration_ms: 0,
      summary: `purged ${purgedSources.length} source(s) and ${purgedPages.count} page(s) past the 72h recovery window`,
      details: {
        purged_sources_count: purgedSources.length,
        purged_pages_count: purgedPages.count,
        purged_sources: purgedSources,
        purged_page_slugs: purgedPages.slugs,
      },
    };
  } catch (e) {
    return {
      phase: 'purge',
      status: 'fail',
      duration_ms: 0,
      summary: 'purge phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

/** v0.26.5: matches SOFT_DELETE_TTL_HOURS in destructive-guard.ts. Inlined here
 *  to avoid a static import (purge phase is only loaded in the autopilot path). */
const SOFT_DELETE_TTL_HOURS_FOR_PURGE = 72;

async function runPhaseOrphans(engine: BrainEngine): Promise<PhaseResult> {
  try {
    const { findOrphans } = await import('../commands/orphans.ts');
    const result = await findOrphans(engine);
    const count = result.total_orphans;
    return {
      phase: 'orphans',
      status: count > 20 ? 'warn' : 'ok',
      duration_ms: 0,
      summary: `${count} orphan page(s) out of ${result.total_pages} total`,
      details: {
        total_orphans: count,
        total_pages: result.total_pages,
        excluded: result.excluded,
      },
    };
  } catch (e) {
    return {
      phase: 'orphans',
      status: 'fail',
      duration_ms: 0,
      summary: 'orphans phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

// ─── Main ──────────────────────────────────────────────────────────

/**
 * Run the brain maintenance cycle.
 *
 * Engine may be null: filesystem phases (lint, backlinks) still run;
 * DB-dependent phases skip with status='skipped', reason='no_database'.
 *
 * Acquires the cycle lock for any DB-write phase selection. Non-DB-write
 * selections (e.g., --phase lint) skip the lock as an optimization so
 * single-phase runs are always responsive even if another cycle is live.
 */
export async function runCycle(
  engine: BrainEngine | null,
  opts: CycleOpts,
): Promise<CycleReport> {
  const start = performance.now();
  const phases = opts.phases ?? ALL_PHASES;
  const dryRun = !!opts.dryRun;
  const pull = !!opts.pull;
  const timestamp = new Date().toISOString();
  const phaseResults: PhaseResult[] = [];

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Decide if we need the cycle lock: any state-mutating phase in the selection.
  const needsLock = phases.some(p => NEEDS_LOCK_PHASES.has(p));

  let lock: LockHandle | null = null;
  if (needsLock) {
    if (engine) {
      try {
        lock = await acquirePostgresLock(engine);
      } catch (e) {
        // Lock acquisition failed catastrophically (e.g., migration missing).
        // Return a failed report rather than silently running without a lock.
        return {
          schema_version: '1',
          timestamp,
          duration_ms: Math.round(performance.now() - start),
          status: 'failed',
          reason: 'lock_acquisition_error',
          brain_dir: opts.brainDir,
          phases: [
            {
              phase: 'sync',
              status: 'fail',
              duration_ms: 0,
              summary: 'could not acquire cycle lock',
              details: {},
              error: makeErrorFromException(e, 'DatabaseConnection'),
            },
          ],
          totals: emptyTotals(),
        };
      }
    } else {
      lock = acquireFileLock();
    }

    if (lock === null) {
      return {
        schema_version: '1',
        timestamp,
        duration_ms: Math.round(performance.now() - start),
        status: 'skipped',
        reason: 'cycle_already_running',
        brain_dir: opts.brainDir,
        phases: [],
        totals: emptyTotals(),
      };
    }
  }

  try {
    // ── Phase 1: lint ────────────────────────────────────────────
    if (phases.includes('lint')) {
      checkAborted(opts.signal);
      progress.start('cycle.lint');
      const { result, duration_ms } = await timePhase(() => runPhaseLint(opts.brainDir, dryRun));
      result.duration_ms = duration_ms;
      phaseResults.push(result);
      progress.finish();
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 2: backlinks ──────────────────────────────────────
    if (phases.includes('backlinks')) {
      checkAborted(opts.signal);
      progress.start('cycle.backlinks');
      const { result, duration_ms } = await timePhase(() => runPhaseBacklinks(opts.brainDir, dryRun));
      result.duration_ms = duration_ms;
      phaseResults.push(result);
      progress.finish();
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 3: sync ───────────────────────────────────────────
    // Track which slugs sync touched so extract can run incrementally.
    let syncPagesAffected: string[] | undefined;
    if (phases.includes('sync')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'sync',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.sync');
        const { result, duration_ms } = await timePhase(() => runPhaseSync(engine, opts.brainDir, dryRun, pull, phases.includes('extract')));
        result.duration_ms = duration_ms;
        // Capture changed slugs for incremental extract.
        syncPagesAffected = (result as SyncPhaseResult).pagesAffected;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 4: synthesize (v0.23) ─────────────────────────────
    if (phases.includes('synthesize')) {
      if (!engine) {
        phaseResults.push({
          phase: 'synthesize',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.synthesize');
        const { runPhaseSynthesize } = await import('./cycle/synthesize.ts');
        const { result, duration_ms } = await timePhase(() => runPhaseSynthesize(engine, {
          brainDir: opts.brainDir,
          dryRun,
          yieldDuringPhase: opts.yieldDuringPhase,
          inputFile: opts.synthInputFile,
          date: opts.synthDate,
          from: opts.synthFrom,
          to: opts.synthTo,
          bypassDreamGuard: opts.synthBypassDreamGuard,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 5: extract (now picks up synthesize output) ───────
    if (phases.includes('extract')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'extract',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        // Pass changed slugs from sync for incremental extract.
        // If sync didn't run (phases exclude it) or failed, syncPagesAffected
        // is undefined → extract falls back to full walk (safe default).
        progress.start('cycle.extract');
        const { result, duration_ms } = await timePhase(() => runPhaseExtract(engine, opts.brainDir, dryRun, syncPagesAffected));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 6: patterns (v0.23) ───────────────────────────────
    // MUST run after extract so the graph state reads fresh — subagent
    // put_page calls in synthesize set ctx.remote=true, so auto-link
    // only fires for trusted-workspace writes (allow-listed). extract
    // is the canonical materialization step.
    if (phases.includes('patterns')) {
      if (!engine) {
        phaseResults.push({
          phase: 'patterns',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.patterns');
        const { runPhasePatterns } = await import('./cycle/patterns.ts');
        const { result, duration_ms } = await timePhase(() => runPhasePatterns(engine, {
          brainDir: opts.brainDir,
          dryRun,
          yieldDuringPhase: opts.yieldDuringPhase,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 7: embed ──────────────────────────────────────────
    if (phases.includes('embed')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'embed',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.embed');
        const { result, duration_ms } = await timePhase(() => runPhaseEmbed(engine, dryRun));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 8: orphans ────────────────────────────────────────
    if (phases.includes('orphans')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'orphans',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.orphans');
        const { result, duration_ms } = await timePhase(() => runPhaseOrphans(engine));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 9: purge (v0.26.5) ────────────────────────────────
    // Hard-delete soft-deleted pages and expired archived sources past the
    // 72h recovery window. Runs last so the rest of the cycle sees the
    // recoverable set; the purge then drops what's truly expired.
    if (phases.includes('purge')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'purge',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.purge');
        const { result, duration_ms } = await timePhase(() => runPhasePurge(engine, dryRun));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* best-effort */ }
    }
  }

  const duration_ms = Math.round(performance.now() - start);
  const totals = extractTotals(phaseResults);
  const status = deriveStatus(phaseResults, totals);

  return {
    schema_version: '1',
    timestamp,
    duration_ms,
    status,
    brain_dir: opts.brainDir,
    phases: phaseResults,
    totals,
  };
}

// ─── Totals + status derivation ────────────────────────────────────

function emptyTotals(): CycleReport['totals'] {
  return {
    lint_fixes: 0,
    backlinks_added: 0,
    pages_synced: 0,
    pages_extracted: 0,
    pages_embedded: 0,
    orphans_found: 0,
    transcripts_processed: 0,
    synth_pages_written: 0,
    patterns_written: 0,
    purged_sources_count: 0,
    purged_pages_count: 0,
  };
}

function extractTotals(phases: PhaseResult[]): CycleReport['totals'] {
  const t = emptyTotals();
  for (const p of phases) {
    if (p.phase === 'lint' && p.details) {
      t.lint_fixes = Number(p.details.fixed ?? 0);
    } else if (p.phase === 'backlinks' && p.details) {
      t.backlinks_added = Number(p.details.added ?? 0);
    } else if (p.phase === 'sync' && p.details) {
      t.pages_synced = Number(p.details.added ?? 0) + Number(p.details.modified ?? 0);
    } else if (p.phase === 'extract' && p.details) {
      t.pages_extracted = Number(p.details.linksCreated ?? 0);
    } else if (p.phase === 'embed' && p.details) {
      // In dry-run, use would_embed as the "activity" measure; else embedded.
      const dryRun = p.details.dryRun === true;
      t.pages_embedded = dryRun
        ? Number(p.details.would_embed ?? 0)
        : Number(p.details.embedded ?? 0);
    } else if (p.phase === 'orphans' && p.details) {
      t.orphans_found = Number(p.details.total_orphans ?? 0);
    } else if (p.phase === 'synthesize' && p.details) {
      t.transcripts_processed = Number(p.details.transcripts_processed ?? 0);
      t.synth_pages_written = Number(p.details.pages_written ?? 0);
    } else if (p.phase === 'patterns' && p.details) {
      t.patterns_written = Number(p.details.patterns_written ?? 0);
    } else if (p.phase === 'purge' && p.details) {
      t.purged_sources_count = Number(p.details.purged_sources_count ?? 0);
      t.purged_pages_count = Number(p.details.purged_pages_count ?? 0);
    }
  }
  return t;
}

function deriveStatus(phases: PhaseResult[], totals: CycleReport['totals']): CycleStatus {
  if (phases.length === 0) return 'failed';
  const anyFailed = phases.some(p => p.status === 'fail');
  const allFailed = phases.every(p => p.status === 'fail');
  const anyWarn = phases.some(p => p.status === 'warn');
  if (allFailed) return 'failed';
  if (anyFailed || anyWarn) return 'partial';
  // All phases 'ok' or 'skipped'. Distinguish clean (no activity) from ok (work done).
  const anyWork =
    totals.lint_fixes > 0 ||
    totals.backlinks_added > 0 ||
    totals.pages_synced > 0 ||
    totals.pages_extracted > 0 ||
    totals.pages_embedded > 0;
  return anyWork ? 'ok' : 'clean';
}
