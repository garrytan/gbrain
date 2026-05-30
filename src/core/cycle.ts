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
 *   │ Phase 7: recompute_emotional_weight (v0.29: DB writes)    │
 *   │ Phase 8: embed --stale      (DB writes)                   │
 *   │ Phase 9: orphans            (DB read, report only)        │
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
import { gbrainPath } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { createProgress, type ProgressReporter } from './progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from './cli-options.ts';
import { tryAcquireDbLock, type DbLockHandle } from './db-lock.ts';
import { assertValidSourceId } from './source-id.ts';

// ─── Types ─────────────────────────────────────────────────────────

export type CyclePhase =
  | 'lint' | 'backlinks' | 'sync' | 'synthesize' | 'extract' | 'extract_facts'
  | 'resolve_symbol_edges'
  | 'patterns' | 'recompute_emotional_weight' | 'consolidate'
  // v0.36.1.0 Hindsight calibration wave:
  //  - propose_takes: LLM scans markdown prose, proposes gradeable claims
  //    to a review queue. User accepts/rejects via `gbrain takes propose`.
  //  - grade_takes: walks unresolved takes, retrieves evidence, asks a
  //    judge model to verdict them. Auto-resolve OFF by default (D17).
  //  - calibration_profile: aggregates the resolved subset into 2-4
  //    narrative pattern statements + active bias tags. Voice-gated.
  | 'propose_takes' | 'grade_takes' | 'calibration_profile'
  | 'embed' | 'orphans' | 'purge'
  // v0.39 T12: schema-suggest passive trigger (D3 + D4 plan-eng-review).
  // Wraps runSuggest() — same library the CLI verb + EIIRP call.
  | 'schema-suggest'
  // v0.41 T9 lens packs:
  //  - extract_atoms: per-source Haiku extraction of atoms from
  //    transcripts/articles/meetings into atom-typed pages. Gated on the
  //    active pack's `phases:` declaration (gbrain-creator or gbrain-
  //    everything declare this); other packs are no-op.
  //  - synthesize_concepts: global aggregation of atoms into tier-promoted
  //    concept pages via dedup → tier → Sonnet T1/T2 voice-gated narratives.
  //    Same pack-gate model.
  | 'extract_atoms' | 'synthesize_concepts'
  // v0.41.11.0 — opt-in (default OFF) bulk fact extraction for long-form
  // conversation pages. The phase wrapper does its own multi-source
  // iteration directly (PHASE_SCOPE='source' here is taxonomy only;
  // see comment above PHASE_SCOPE). Wraps the per-source loop in ONE
  // brain-wide BudgetTracker and passes it through opts.budgetTracker
  // so the core's auto-wrap doesn't REPLACE it.
  | 'conversation_facts_backfill';

export const ALL_PHASES: CyclePhase[] = [
  'lint',
  'backlinks',
  'sync',
  'synthesize',
  'extract',
  // v0.32.2 — reconcile DB facts index from the `## Facts` fence on
  // every affected entity page. Runs AFTER extract (link/timeline
  // materialization) and BEFORE patterns (which reads graph state).
  // The empty-fence guard refuses to run if pre-v51 legacy facts are
  // pending the v0_32_2 backfill (Codex R2-#7).
  'extract_facts',
  // v0.41 T9 — atom extraction (per-source, pack-gated). Runs AFTER
  // extract_facts so the Haiku 3-check has fresh fact context, BEFORE
  // resolve_symbol_edges so new atom pages don't interrupt the symbol
  // resolution sweep mid-flight. Pack-gate via active pack's `phases:`
  // declaration (gbrain-creator + gbrain-everything declare; others skip).
  'extract_atoms',
  // v0.33.3 W0c — within-file two-pass symbol resolution. Runs AFTER
  // extract + extract_facts so any code edges sync emitted (still bare-token)
  // get resolved into {resolved_chunk_id: N} / {ambiguous: true,
  // candidates: [...]} edge_metadata entries before downstream phases read
  // the graph. Quick-cycle compatible: each invocation walks at most
  // BATCH_SIZE*10 chunks where edges_backfilled_at IS NULL or stale.
  'resolve_symbol_edges',
  'patterns',
  // v0.41 T9 — concept synthesis (global, pack-gated). Runs AFTER patterns
  // so the cluster pass sees fresh cross-session themes. Same pack-gate
  // model as extract_atoms.
  'synthesize_concepts',
  // v0.29 — runs AFTER extract + synthesize so it sees the union of
  // sync-touched + synthesize-written pages with fresh tag + take state.
  'recompute_emotional_weight',
  // v0.31: cluster unconsolidated facts per (source_id, entity_slug);
  // Sonnet-synthesize one take per cluster; INSERT into takes(kind='fact');
  // mark facts consolidated_at + consolidated_into. Never DELETE — facts
  // stay as audit trail. Placed AFTER patterns (graph-fresh) and BEFORE
  // embed (so the new takes get embedded same-cycle).
  'consolidate',
  // v0.36.1.0 Hindsight calibration wave. Ordering rationale:
  //   - propose_takes AFTER consolidate so the proposal LLM sees the
  //     freshly-consolidated takes when deciding what's NOT yet captured
  //     (F2 fence-dedup).
  //   - grade_takes AFTER propose so newly-accepted proposals from the
  //     queue are eligible for grading on the next cycle (manual accept
  //     can land between cycle runs; auto-accept is intentionally NOT a
  //     thing — user always reviews).
  //   - calibration_profile AFTER grade so the profile reads fresh
  //     resolutions. Voice-gated narrative; cheap (Haiku judge).
  // Budget caps live in src/core/cycle/budget-meter.ts via BaseCyclePhase.
  'propose_takes',
  'grade_takes',
  'calibration_profile',
  // v0.41.11.0 — opt-in conversation-facts backfill. Default OFF; reads
  // cycle.conversation_facts_backfill.enabled gate inside the wrapper.
  // Ordered AFTER calibration_profile (matches the runCycle dispatch
  // block placement, which runs between the calibration trio and embed),
  // and BEFORE embed so newly-inserted facts get embedded same-cycle.
  'conversation_facts_backfill',
  'embed',
  'orphans',
  // v0.39 T12: passive schema-suggest. Runs LATE so post-sync brain state
  // is settled; thin wrapper around runSuggest() library. Cheap (heuristic
  // by default; LLM only when chat provider configured).
  'schema-suggest',
  // v0.26.5: hard-deletes soft-deleted pages and expired archived sources past
  // the 72h recovery window. Runs last so the rest of the cycle sees the
  // recoverable set; the purge then drops what's expired.
  'purge',
];

/**
 * v0.38 (CEO + eng review): phase-scope taxonomy. Each entry in
 * `ALL_PHASES` declares whether its work is naturally per-source,
 * brain-global, or mixed. Static documentation only — no runtime
 * enforcement yet (filed as follow-up TODO in the plan).
 *
 * Load-bearing for any future fan-out wave:
 *   - `source`: safe to parallelize per source. Sync reads/writes the
 *     one source's rows; extract walks changed slugs.
 *   - `global`: must serialize across the brain. Embed walks all stale
 *     chunks; orphans/purge sweep brain-wide; grade_takes + calibration
 *     aggregate across sources; resolve_symbol_edges walks every chunk.
 *   - `mixed`: per-phase decomposition needed before parallelizing.
 *     Synthesize reads the brain-global transcripts dir but writes to
 *     per-source slugs (via subagent allowlist). Patterns reads
 *     cross-source reflections but writes pattern pages.
 *
 * Per-source cycle locks (codex r2 fix) let two cycles RUN concurrently,
 * but `global` phases inside each cycle will still touch the same rows.
 * Genuine per-source autopilot fan-out requires the deferred TODOs.
 */
export type PhaseScope = 'source' | 'global' | 'mixed';
export const PHASE_SCOPE: Record<CyclePhase, PhaseScope> = {
  lint: 'source',
  backlinks: 'source',
  sync: 'source',
  synthesize: 'mixed',
  extract: 'source',
  extract_facts: 'source',
  resolve_symbol_edges: 'global',
  patterns: 'mixed',
  recompute_emotional_weight: 'source',
  consolidate: 'source',
  propose_takes: 'source',
  grade_takes: 'global',
  calibration_profile: 'global',
  embed: 'global',
  orphans: 'global',
  purge: 'global',
  'schema-suggest': 'source',
  // v0.41 T9 — extract_atoms is naturally per-source (each source's
  // transcript dir gets walked independently). synthesize_concepts is
  // global because concept clusters cross sources by nature.
  extract_atoms: 'source',
  synthesize_concepts: 'global',
  // v0.41.11.0 — declared 'source' for taxonomy alignment with
  // extract_facts (per-source semantics). PHASE_SCOPE has no runtime
  // fanout enforcement today (per the comment above); the phase
  // wrapper does its own multi-source loop via listSources().
  conversation_facts_backfill: 'source',
};

/**
 * Phases that mutate state (filesystem or DB) and therefore should
 * coordinate via the cycle lock. Only orphans is truly read-only
 * and skips the lock. patterns mutates DB (writes pattern pages) so
 * it acquires the lock; synthesize too. v0.26.5 adds purge (DELETE-cascade
 * across pages and sources). v0.31 adds consolidate (writes takes rows
 * + facts UPDATEs).
 */
const NEEDS_LOCK_PHASES: ReadonlySet<CyclePhase> = new Set([
  'lint',
  'backlinks',
  'sync',
  'synthesize',
  'extract',
  // v0.32.2 — wipes + re-inserts facts per affected page.
  'extract_facts',
  // v0.33.3 W0c — writes code_edges_symbol.edge_metadata + content_chunks.edges_backfilled_at.
  'resolve_symbol_edges',
  'patterns',
  // v0.29 — writes pages.emotional_weight column.
  'recompute_emotional_weight',
  'consolidate',
  // v0.36.1.0 — propose_takes / grade_takes / calibration_profile all
  // mutate DB state (take_proposals, take_grade_cache, calibration_profiles)
  // so they coordinate via the cycle lock.
  'propose_takes',
  'grade_takes',
  'calibration_profile',
  // v0.41 T9 — extract_atoms writes atom-typed pages via put_page;
  // synthesize_concepts writes concept-typed pages + tier updates. Both
  // mutate DB state and need the lock.
  'extract_atoms',
  'synthesize_concepts',
  // v0.41.11.0 — inserts facts + writes terminal audit rows; needs lock.
  'conversation_facts_backfill',
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
    /** v0.29: number of pages whose emotional_weight was (re)computed. */
    pages_emotional_weight_recomputed: number;
    /** v0.34: number of code edges resolved (1 candidate) by the resolve_symbol_edges phase. */
    edges_resolved: number;
    /** v0.34: number of code edges marked ambiguous (2+ candidates) by the resolve_symbol_edges phase. */
    edges_ambiguous: number;
    /** v0.26.5: number of source rows hard-deleted by the purge phase. */
    purged_sources_count: number;
    /** v0.26.5: number of page rows hard-deleted by the purge phase. */
    purged_pages_count: number;
    /** v0.31: number of facts promoted to takes by the consolidate phase. */
    facts_consolidated: number;
    /** v0.31: number of new takes created by the consolidate phase. */
    consolidate_takes_written: number;
    /**
     * v0.35.5: number of phantom unprefixed entity pages (e.g. `alice.md`)
     * redirected to their canonical prefixed slugs (`people/alice-example`)
     * by the phantom-redirect pre-pass inside `extract_facts`. Capped per
     * cycle by `GBRAIN_PHANTOM_REDIRECT_LIMIT` (default 50).
     */
    phantoms_redirected: number;
    /**
     * v0.35.5: number of phantom pages skipped because their canonical
     * resolved to multiple candidates. Operator must triage manually via
     * the `~/.gbrain/audit/phantoms-YYYY-Www.jsonl` audit log.
     */
    phantoms_ambiguous: number;
    /**
     * v0.35.5: number of phantom pages skipped because the disk fence and
     * DB body disagreed on the parsed fact row set, OR because the redirect
     * commit phase failed mid-way and surfaces as drift on retry. Audit log
     * records the specific reason.
     */
    phantoms_skipped_drift: number;
  };
}

export interface CycleOpts {
  /** If true, no writes to filesystem or DB. All phases honor this. */
  dryRun?: boolean;
  /** Defaults to ALL_PHASES. Pass a subset for --phase lint etc. */
  phases?: CyclePhase[];
  /**
   * Brain directory (git repo). Required for filesystem phases (lint,
   * backlinks, sync, synthesize, extract, patterns). `null` when the brain has
   * no on-disk checkout (postgres/remote engine) — those phases are skipped
   * with reason `no_brain_dir` and the DB-only phases still run.
   */
  brainDir: string | null;
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
  /**
   * v0.38: source-scope the cycle lock. When set, the cycle acquires
   * `gbrain-cycle:<source_id>` instead of the legacy global `gbrain-cycle`,
   * so two cycles for different sources can run concurrently on Postgres.
   * When unset, the legacy global lock is used (back-compat for autopilot
   * + every existing caller).
   *
   * **Note for follow-up waves:** this only scopes the LOCK. Several
   * cycle phases (`embed`, `orphans`, `purge`, `resolve_symbol_edges`,
   * `grade_takes`, `calibration_profile`) still operate brain-wide
   * regardless of sourceId — see the `PHASE_SCOPE` taxonomy. Per-source
   * cycle locks let two cycles RUN, but the global-scoped phases
   * inside each will still touch the same rows. Genuine per-source
   * fan-out requires the deferred TODOs in the plan.
   *
   * Validated via `assertValidSourceId` in `cycleLockIdFor` (defense-in-depth).
   */
  sourceId?: string;
}

// ─── Lock primitives ───────────────────────────────────────────────

/**
 * Default cycle lock ID, kept for back-compat: pre-v0.38 callers that
 * pass no `sourceId` continue to use this exact string. Autopilot's
 * existing dispatch + every existing minion job in flight at upgrade
 * time use this row in `gbrain_cycle_locks`.
 */
const LEGACY_CYCLE_LOCK_ID = 'gbrain-cycle';
// v0.41.19.0 (T2 of ops-fix-wave): dropped from 30 min to 5 min so a
// crashed cycle releases the lock within 5 min instead of holding it for
// the full 30-min TTL. Wired with active in-phase refresh via
// `buildYieldDuringPhase` (T3) — the closure passed to long phases as
// `yieldDuringPhase` calls `lock.refresh()` every 30s, so a healthy
// long-running cycle keeps the TTL alive while the shorter window
// shrinks crash recovery 6×.
const LOCK_TTL_MS = 5 * 60 * 1000;        // 5 minutes (was 30)
const LOCK_TTL_MINUTES = 5;               // was 30; db-lock.ts takes minutes
// Lazy: GBRAIN_HOME may be set after module load; resolve at call time.
const getLockFilePathDefault = () => gbrainPath('cycle.lock');

export interface LockHandle {
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Compute the cycle lock ID for a given source.
 *
 * - `undefined` returns the legacy `'gbrain-cycle'` ID, preserving
 *   back-compat for every existing caller (autopilot, `gbrain dream`
 *   without `--source`, the no-DB file-lock path).
 * - Any string is validated via `assertValidSourceId` first (codex r2 P1-B
 *   defense-in-depth: `CycleOpts.sourceId` is a new direct API surface
 *   that becomes part of a DB lock ID AND, on PGLite, a filesystem path
 *   component; callers cannot be trusted to pre-validate).
 * - Valid IDs return `'gbrain-cycle:<source_id>'` so per-source cycles
 *   acquire distinct rows in `gbrain_cycle_locks` and don't serialize
 *   through one global lock.
 *
 * @throws if `sourceId` is provided but invalid per `source-id.ts`.
 */
export function cycleLockIdFor(sourceId?: string): string {
  if (sourceId === undefined) return LEGACY_CYCLE_LOCK_ID;
  assertValidSourceId(sourceId);
  return `${LEGACY_CYCLE_LOCK_ID}:${sourceId}`;
}

/**
 * Acquire the DB-backed cycle lock for a given source.
 *
 * Pre-v0.38 this file had its own copy of the UPSERT-with-TTL SQL for both
 * the postgres and pglite engines (`acquirePostgresLock` + `acquirePGLiteLock`).
 * That duplicated `src/core/db-lock.ts:tryAcquireDbLock` which was extracted
 * in v0.22.13. Codex eng-review caught the DRY violation. This is now a thin
 * adapter that:
 *   - calls `tryAcquireDbLock` with the per-source lock ID,
 *   - returns the existing `LockHandle` shape (decouples cycle.ts's internal
 *     handle type from db-lock.ts's `DbLockHandle` so refactors stay local).
 *
 * Deliberately uses `tryAcquireDbLock` and NOT `withRefreshingLock`:
 *   - `tryAcquireDbLock` returns `null` on busy lock → cycle returns
 *     `{status: 'skipped', reason: 'cycle_already_running'}` (existing
 *     contract — codex r2 P0-A regression guard).
 *   - `withRefreshingLock` THROWS on busy → would convert busy cycles into
 *     failures.
 *   - The auto-refresh timer in `withRefreshingLock` would also run
 *     `SELECT 1 + UPDATE` against the same engine while phases are
 *     executing (risky for PGLite's single connection — codex r2 P1-A)
 *     AND skip Minion job-lock renewal (codex r2 P0-B: yieldBetweenPhases
 *     handles BOTH DB lock refresh AND Minion job-lock renewal at phase
 *     boundaries; replacing it with a background timer drops the Minion
 *     side).
 */
async function acquireDbCycleLock(engine: BrainEngine, sourceId?: string): Promise<LockHandle | null> {
  const lockId = cycleLockIdFor(sourceId);
  const handle: DbLockHandle | null = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  if (handle === null) return null;
  return {
    refresh: handle.refresh,
    release: handle.release,
  };
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

/**
 * v0.41.19.0 (T3 of ops-fix-wave): build the closure that long phases
 * call to keep the cycle DB lock alive AND fire the existing cooperative
 * yield hook (Minion job-lock renewal in jobs.ts / autopilot.ts).
 *
 * Codex caught that the prior `yieldBetweenPhases` opt does NOT refresh
 * the cycle lock — it's just a `setImmediate()` from external callers,
 * and `lock.refresh()` was only ever called via the implicit final
 * `release()` path. Combined with the TTL drop 30→5min (T2), a long
 * phase like `extract_atoms` or `synthesize_concepts` would lose the
 * lock to a competing worker mid-phase.
 *
 * The returned closure does TWO things on each fire:
 *   1. `await lock.refresh()` to bump `ttl_expires_at` + `last_refreshed_at`
 *   2. `await outer()` to renew any external job-lock the caller threaded in
 *
 * Both are wrapped in try/catch — a refresh failure logs to stderr but
 * doesn't crash the phase (if the lock was truly stolen, we want this
 * run to wind down gracefully, not throw mid-LLM-call).
 *
 * Returns `undefined` when there's no lock AND no outer hook so phases
 * short-circuit via their `if (!opts.yieldDuringPhase) return;` guard.
 */
export function buildYieldDuringPhase(
  lock: LockHandle | null,
  outer?: () => Promise<void>,
): (() => Promise<void>) | undefined {
  if (!lock && !outer) return undefined;
  return async () => {
    if (lock) {
      try {
        await lock.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Non-fatal: a refresh error doesn't crash the phase. If the
        // lock truly expired and was stolen, the next acquire by another
        // worker has already happened — let this run wind down rather
        // than throw mid-phase.
        console.error(`[cycle] lock refresh failed (non-fatal): ${msg}`);
      }
    }
    if (outer) {
      try { await outer(); } catch { /* outer hook errors are not fatal */ }
    }
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

// v0.39 — runPhaseLint + runPhaseBacklinks are exported for the cycle-
// legacy-phases test (audit GAP 5 / D9). Exporting widens the public API
// surface; consumers outside of runCycle should NOT take a dependency on
// these — they exist for the cycle's internal composition. The export
// keyword is the minimal seam that lets behavioral tests drive the
// wrapper's result-mapping (counter → status enum + summary) without
// going through runCycle's full setup cost.
export async function runPhaseLint(brainDir: string, dryRun: boolean): Promise<PhaseResult> {
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

export async function runPhaseBacklinks(brainDir: string, dryRun: boolean): Promise<PhaseResult> {
  try {
    // Maintenance cycles must not rewrite tracked brain pages with generated
    // "Referenced in" timeline bullets. The graph extractor/auto-link path is
    // the canonical link store during sync/dream/autopilot; the legacy
    // filesystem fixer remains available explicitly via `gbrain check-backlinks
    // fix` for users who truly want markdown backlinks materialized.
    const { runBacklinksCore } = await import('../commands/backlinks.ts');
    const result = await runBacklinksCore({
      action: 'check',
      dir: brainDir,
      dryRun,
    });
    const gaps = result.gaps_found ?? 0;
    const added = result.fixed ?? 0;
    const status: PhaseStatus = 'ok';
    return {
      phase: 'backlinks',
      status,
      duration_ms: 0,
      summary: gaps === 0
        ? 'no missing back-links found'
        : `${gaps} missing back-link(s) found (audit-only; run gbrain check-backlinks fix to materialize)`,
      details: { gaps, added, pages_affected: result.pages_affected, dryRun, mode: 'audit-only' },
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
  brainDir: string | null,
): Promise<string | undefined> {
  // No checkout → no path-derived source. Callers fall back to opts.sourceId
  // (the cycleSourceId precedence) or 'default'.
  if (brainDir === null) return undefined;
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

// v0.41 T9 D4-B — orchestrator-level pack gate for lens-pack phases.
//
// Returns true when the ACTIVE pack's `phases:` list includes `phase`.
// Phases are local to the manifest that declares them — extends chains
// inherit page_types + link_types + filing_rules via the registry's
// standard merge semantics, but NOT phases. Per D4-B, each pack declares
// its own phase participation explicitly. The gbrain-everything meta-
// pack therefore re-declares creator's phases verbatim in its own
// manifest (asserted by test/lens-pack-manifests.test.ts).
//
// Why local-only: phases are runtime control flow, not data. A user pack
// that extends gbrain-creator may NOT want extract_atoms to run (e.g. they
// derive atoms differently). Inheriting phases would force them into a
// no-op-or-fork choice; local-only declaration lets them opt in cleanly.
//
// Fail-open semantics: if the registry lookup throws (pack not found,
// manifest malformed, registry not initialized), the gate returns FALSE.
// Better to skip a pack-gated phase than to run it for a brain that
// can't resolve its active pack. Skipped phases land in the cycle report
// with `not_in_active_pack` so doctor can surface to the user.
async function packDeclaresPhase(
  engine: BrainEngine,
  phase: CyclePhase,
): Promise<boolean> {
  try {
    const { loadActivePack } = await import('./schema-pack/load-active.ts');
    const { loadConfig } = await import('./config.ts');
    const cfg = loadConfig();
    const resolved = await loadActivePack({ cfg, remote: false });
    const phases = resolved.manifest.phases ?? [];
    return phases.includes(phase);
  } catch {
    return false;
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

async function runPhaseExtractFacts(
  engine: BrainEngine,
  brainDir: string | null,
  sourceId: string,
  dryRun: boolean,
  changedSlugs?: string[],
): Promise<PhaseResult> {
  try {
    const { runExtractFacts } = await import('./cycle/extract-facts.ts');
    const result = await runExtractFacts(engine, {
      slugs: changedSlugs,
      dryRun,
      sourceId,
      brainDir: brainDir ?? undefined,
    });

    // Empty-fence guard: pre-v51 legacy rows pending the v0_32_2 backfill.
    // Surface as 'warn' so doctor + the cycle report can see it; don't fail
    // the cycle because the workaround is well-defined (run apply-migrations).
    if (result.guardTriggered) {
      return {
        phase: 'extract_facts',
        status: 'warn',
        duration_ms: 0,
        summary: `extract_facts skipped: ${result.legacyRowsPending} legacy v0.31 facts pending fence backfill`,
        details: {
          legacyRowsPending: result.legacyRowsPending,
          hint: 'gbrain apply-migrations --yes',
          warnings: result.warnings,
        },
      };
    }

    // v0.35.5: phantom-redirect counters bubble up alongside the existing
    // fact-reconcile counts. We summarize the phantom counters in the
    // human-readable summary line when any non-zero phantom work happened
    // so the daily cycle report makes the cleanup visible.
    const phantomSummary = (result.phantomsRedirected
      || result.phantomsAmbiguous
      || result.phantomsSkippedDrift)
      ? `, ${result.phantomsRedirected} phantom(s) redirected (${result.phantomsAmbiguous} ambiguous, ${result.phantomsSkippedDrift} drift-skipped)`
      : '';
    return {
      phase: 'extract_facts',
      status: result.warnings.length > 0 ? 'warn' : 'ok',
      duration_ms: 0,
      summary: `${result.factsInserted} fact(s) reconciled across ${result.pagesScanned} page(s)${phantomSummary}` +
        (result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ''),
      details: {
        pagesScanned: result.pagesScanned,
        pagesWithFacts: result.pagesWithFacts,
        factsInserted: result.factsInserted,
        factsDeleted: result.factsDeleted,
        warnings: result.warnings.slice(0, 5),
        // v0.35.5: phantom counters surfaced so extractTotals() can lift
        // them to CycleReport.totals and the daily report makes the
        // cleanup visible.
        phantoms_scanned: result.phantomsScanned,
        phantoms_redirected: result.phantomsRedirected,
        phantoms_ambiguous: result.phantomsAmbiguous,
        phantoms_skipped_drift: result.phantomsSkippedDrift,
        phantoms_lock_busy: result.phantomsLockBusy,
        phantoms_more_pending: result.phantomsMorePending,
      },
    };
  } catch (e) {
    return {
      phase: 'extract_facts',
      status: 'fail',
      duration_ms: 0,
      summary: 'extract_facts phase failed',
      details: {},
      error: makeErrorFromException(e),
    };
  }
}

/**
 * v0.33.3 W0c — resolve_symbol_edges phase.
 *
 * Walks at most BATCH_SIZE*10 chunks per invocation where
 * `edges_backfilled_at` is NULL or older than EDGE_EXTRACTOR_VERSION_TS.
 * Resumable across cycles via the watermark; quick-cycle compatible.
 *
 * Source scoping: walks every registered source. Pre-v0.33.3 silently
 * crossed sources; now each source is walked independently so symbol
 * resolution stays within its source boundary (matches the W0a fix).
 */
async function runPhaseResolveSymbolEdges(
  engine: BrainEngine,
  dryRun: boolean,
): Promise<PhaseResult> {
  if (dryRun) {
    return {
      phase: 'resolve_symbol_edges',
      status: 'skipped',
      duration_ms: 0,
      summary: 'dry-run: resolve_symbol_edges phase skipped',
      details: { dryRun: true, reason: 'no_dry_run_support' },
    };
  }
  try {
    const { resolveSymbolEdgesIncremental } = await import('./chunkers/symbol-resolver.ts');
    const { listSources } = await import('./sources-ops.ts');
    const sources = await listSources(engine);
    let totalChunks = 0;
    let totalResolved = 0;
    let totalAmbiguous = 0;
    let totalUnmatched = 0;
    for (const s of sources) {
      const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: s.id });
      totalChunks += stats.chunks_walked;
      totalResolved += stats.edges_resolved;
      totalAmbiguous += stats.edges_ambiguous;
      totalUnmatched += stats.edges_unmatched;
    }
    return {
      phase: 'resolve_symbol_edges',
      status: 'ok',
      duration_ms: 0,
      summary:
        totalChunks === 0
          ? 'no chunks needed symbol resolution'
          : `${totalChunks} chunk(s) walked; resolved ${totalResolved}, ambiguous ${totalAmbiguous}, unmatched ${totalUnmatched}`,
      details: {
        chunks_walked: totalChunks,
        edges_resolved: totalResolved,
        edges_ambiguous: totalAmbiguous,
        edges_unmatched: totalUnmatched,
        sources_walked: sources.length,
      },
    };
  } catch (e) {
    return {
      phase: 'resolve_symbol_edges',
      status: 'fail',
      duration_ms: 0,
      summary: 'resolve_symbol_edges phase failed',
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
/**
 * v0.28 P1: sweep $GBRAIN_HOME/clones/.tmp/ for entries older than the
 * configured TTL. addSource / recloneIfMissing clone into temp first then
 * rename atomically; if the process is SIGKILL'd between clone and rename,
 * the temp dir orphans. Without this sweep, a brain server accumulates
 * gigabytes over months. Mirrors the page/source soft-delete TTL pattern
 * so behavior is uniform across the purge phase.
 */
async function purgeOrphanClones(staleHours: number): Promise<{ count: number; bytes: number; names: string[] }> {
  const fs = await import('fs');
  const cfg = await import('./config.ts');
  const tmpRoot = cfg.gbrainPath('clones', '.tmp');
  if (!fs.existsSync(tmpRoot)) return { count: 0, bytes: 0, names: [] };
  const STALE_MS = staleHours * 3600 * 1000;
  const now = Date.now();
  const removed: string[] = [];
  let bytes = 0;
  for (const ent of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
    const full = `${tmpRoot}/${ent.name}`;
    try {
      const st = fs.lstatSync(full);
      if (now - st.mtimeMs <= STALE_MS) continue;
      // Approximate size via stat (rough — recursive walk would be slow on
      // a stuck-clone with thousands of files; the bytes field is just
      // operator-visible feedback, not load-bearing).
      try { bytes += st.size; } catch { /* skip */ }
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(ent.name);
    } catch {
      /* skip unreadable / racing-with-another-process */
    }
  }
  return { count: removed.length, bytes, names: removed };
}

async function runPhasePurge(engine: BrainEngine, dryRun: boolean): Promise<PhaseResult> {
  try {
    if (dryRun) {
      return {
        phase: 'purge',
        status: 'ok',
        duration_ms: 0,
        summary: 'dry-run: skipped purge sweep',
        details: { dry_run: true, purged_sources_count: 0, purged_pages_count: 0, purged_orphan_clones_count: 0 },
      };
    }
    const { purgeExpiredSources } = await import('./destructive-guard.ts');
    const purgedSources = await purgeExpiredSources(engine);
    const purgedPages = await engine.purgeDeletedPages(SOFT_DELETE_TTL_HOURS_FOR_PURGE);
    const purgedClones = await purgeOrphanClones(SOFT_DELETE_TTL_HOURS_FOR_PURGE);
    // v0.36+ folded scope item +C: GC stale op_checkpoints rows.
    // 7-day TTL is deliberately generous; any reasonable long-running op
    // finishes inside that window. Cheap (few KB per row).
    let purgedCheckpoints = 0;
    try {
      const { purgeStaleCheckpoints } = await import('./op-checkpoint.ts');
      purgedCheckpoints = await purgeStaleCheckpoints(engine, 7);
    } catch {
      // Non-fatal: op_checkpoints table may not exist yet on pre-v67 brains.
    }
    // v0.37.x — TX3 / A5: GC stale brainstorm checkpoints (filesystem-side).
    // 7-day mtime window mirrors op_checkpoints. Wrapped in try/catch
    // because the brainstorm dir may not exist on a brain that's never
    // run a brainstorm.
    let purgedBrainstormCheckpoints = 0;
    try {
      const { gcStaleCheckpoints } = await import('./brainstorm/checkpoint.ts');
      purgedBrainstormCheckpoints = gcStaleCheckpoints(7);
    } catch {
      // Non-fatal.
    }
    // v0.41.18.0 codex H-8 — actual 30-day pruning of batch-retry audit JSONL.
    // The pre-v0.41.18 plan promised this "by convention"; this is the real
    // implementation. Never throws — best-effort GC.
    let purgedBatchRetryAuditFiles = 0;
    try {
      const { pruneOldBatchRetryAuditFiles } = await import('./audit/batch-retry-audit.ts');
      purgedBatchRetryAuditFiles = pruneOldBatchRetryAuditFiles(30).removed;
    } catch {
      // Non-fatal.
    }
    return {
      phase: 'purge',
      status: 'ok',
      duration_ms: 0,
      summary:
        `purged ${purgedSources.length} source(s), ${purgedPages.count} page(s), ` +
        `${purgedClones.count} orphan clone temp dir(s), ${purgedCheckpoints} stale op_checkpoint(s), ` +
        `${purgedBrainstormCheckpoints} stale brainstorm checkpoint(s), ` +
        `and ${purgedBatchRetryAuditFiles} stale batch-retry audit file(s)`,
      details: {
        purged_sources_count: purgedSources.length,
        purged_pages_count: purgedPages.count,
        purged_orphan_clones_count: purgedClones.count,
        purged_orphan_clone_names: purgedClones.names,
        purged_sources: purgedSources,
        purged_page_slugs: purgedPages.slugs,
        purged_checkpoints_count: purgedCheckpoints,
        purged_brainstorm_checkpoints_count: purgedBrainstormCheckpoints,
        purged_batch_retry_audit_files_count: purgedBatchRetryAuditFiles,
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
    // Orphans are a code-smell signal, not a fatal condition. The
    // original `count > 20` cutoff was tuned for small dev brains; on
    // any corpus past a few hundred pages it fires 'warn' every cycle
    // in steady state. Combined with the autopilot circuit-breaker
    // historically tripping on cycle.status='partial', that produced
    // respawn storms under KeepAlive=true. Switch to a ratio: warn
    // only when more than half the corpus is orphaned (the real "your
    // graph fell apart" signal). total_pages=0 is a defensive 'ok'.
    const status: PhaseStatus =
      result.total_pages > 0 && count / result.total_pages > 0.5 ? 'warn' : 'ok';
    return {
      phase: 'orphans',
      status,
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

  // Capture as a const so it narrows to `string` inside the `else` branches of
  // the per-phase `if (brainDir === null)` guards, even within async closures
  // (const bindings narrow across closures; property accesses don't).
  const brainDir = opts.brainDir;

  // Skip result for a filesystem phase when the brain has no on-disk checkout.
  const skipNoBrainDir = (phase: CyclePhase): PhaseResult => ({
    phase,
    status: 'skipped',
    duration_ms: 0,
    summary: 'requires a local brain directory; this brain has no on-disk checkout '
      + '(postgres/remote engine); pass --dir <path> to run filesystem phases',
    details: { reason: 'no_brain_dir' },
  });

  // A1: canonical per-source scope for the DB-capable per-source phases
  // (extract_facts, extract_atoms, the calibration trio). Explicit --source
  // (opts.sourceId) wins; else derive from the resolved checkout dir. Without
  // this, `gbrain dream --source repo-a` on a checkout-less brain would scope
  // those phases to 'default' (resolveSourceForDir(null) → undefined) while the
  // cycle still locks + stamps last_full_cycle_at for repo-a — a freshness
  // stamp that lies. resolveSourceForDir returns undefined when brainDir is
  // null, so opts.sourceId is the only signal in the no-checkout case.
  const cycleSourceId: string | undefined = engine
    ? (opts.sourceId ?? (await resolveSourceForDir(engine, brainDir)))
    : opts.sourceId;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Decide if we need the cycle lock: any state-mutating phase in the selection.
  const needsLock = phases.some(p => NEEDS_LOCK_PHASES.has(p));

  let lock: LockHandle | null = null;
  if (needsLock) {
    if (engine) {
      // v0.38 (codex r2 P0-C + P0-D): on PGLite, acquire the GLOBAL file
      // lock FIRST, then the per-source DB lock. PGLite is single-writer at
      // the process layer (PGlite WASM blocks concurrent connects to the
      // same brain dir), but the global file lock is belt-and-braces against
      // anything that bypasses the engine — and importantly it preserves
      // the single-writer invariant even though per-source DB lock IDs
      // would otherwise allow two PGLite cycles to run concurrently. The
      // ordering invariant (file → DB; release-both-on-failure; release
      // both on exit) is documented in section 5 of the plan.
      //
      // Postgres engines skip the file lock entirely — per-source DB lock
      // IDs are the full granularity, and there's no single-writer
      // constraint to enforce.
      let pgliteFileLock: LockHandle | null = null;
      if (engine.kind === 'pglite') {
        pgliteFileLock = acquireFileLock();
        if (pgliteFileLock === null) {
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

      let dbLock: LockHandle | null = null;
      try {
        // v0.38: per-source lock ID when opts.sourceId is set; legacy
        // `gbrain-cycle` otherwise (autopilot still passes nothing).
        // cycleLockIdFor validates the sourceId via assertValidSourceId.
        dbLock = await acquireDbCycleLock(engine, opts.sourceId);
      } catch (e) {
        // Lock acquisition failed catastrophically (e.g., migration missing).
        // Release the PGLite file lock before returning so it doesn't strand
        // the next acquirer (codex r2 P0-C cleanup guarantee).
        if (pgliteFileLock) {
          try { await pgliteFileLock.release(); } catch { /* best effort */ }
        }
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

      if (dbLock === null) {
        // Busy DB lock (another cycle for the same source already running).
        // Release the file lock before returning skipped.
        if (pgliteFileLock) {
          try { await pgliteFileLock.release(); } catch { /* best effort */ }
        }
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

      // Compose the two handles into one so the existing release/refresh
      // sites at the cycle body's finally block don't need to know about
      // the file/DB split. Release order is reverse-of-acquire (DB first,
      // file last) so the file lock isn't released while the DB lock is
      // still live — preserves the single-writer invariant up to the last
      // possible moment.
      lock = pgliteFileLock
        ? {
            refresh: async () => {
              await dbLock!.refresh();
              await pgliteFileLock!.refresh();
            },
            release: async () => {
              try { await dbLock!.release(); } catch { /* fall through to file release */ }
              await pgliteFileLock!.release();
            },
          }
        : dbLock;
    } else {
      lock = acquireFileLock();
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
  }

  try {
    // ── Phase 1: lint ────────────────────────────────────────────
    if (phases.includes('lint')) {
      checkAborted(opts.signal);
      if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('lint'));
      } else {
        progress.start('cycle.lint');
        const { result, duration_ms } = await timePhase(() => runPhaseLint(brainDir, dryRun));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 2: backlinks ──────────────────────────────────────
    if (phases.includes('backlinks')) {
      checkAborted(opts.signal);
      if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('backlinks'));
      } else {
        progress.start('cycle.backlinks');
        const { result, duration_ms } = await timePhase(() => runPhaseBacklinks(brainDir, dryRun));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 3: sync ───────────────────────────────────────────
    // Track which slugs sync touched so extract can run incrementally,
    // and which slugs synthesize wrote so recompute_emotional_weight can
    // pick up the union of (sync ∪ synthesize) for v0.29 incremental mode.
    let syncPagesAffected: string[] | undefined;
    let synthesizeWrittenSlugs: string[] | undefined;
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
      } else if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('sync'));
      } else {
        progress.start('cycle.sync');
        const { result, duration_ms } = await timePhase(() => runPhaseSync(engine, brainDir, dryRun, pull, phases.includes('extract')));
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
      } else if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('synthesize'));
      } else {
        progress.start('cycle.synthesize');
        const { runPhaseSynthesize } = await import('./cycle/synthesize.ts');
        const { result, duration_ms } = await timePhase(() => runPhaseSynthesize(engine, {
          brainDir,
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
        // v0.29: capture synthesize-written slugs so the recompute_emotional_weight
        // phase can union them with sync's pagesAffected for incremental mode.
        if (result.details && Array.isArray(result.details.written_slugs)) {
          synthesizeWrittenSlugs = result.details.written_slugs as string[];
        }
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
      } else if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('extract'));
      } else {
        // Pass changed slugs from sync for incremental extract.
        // If sync didn't run (phases exclude it) or failed, syncPagesAffected
        // is undefined → extract falls back to full walk (safe default).
        progress.start('cycle.extract');
        const { result, duration_ms } = await timePhase(() => runPhaseExtract(engine, brainDir, dryRun, syncPagesAffected));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 5b: extract_facts (v0.32.2) ───────────────────────
    // Reconcile DB facts index from the `## Facts` fence on every
    // affected entity page. Runs AFTER extract (link/timeline
    // materialization) and BEFORE patterns/recompute_emotional_weight
    // so downstream phases see fresh DB facts. Empty-fence guard
    // refuses to run while v0.31 legacy facts are pending the
    // v0_32_2 backfill (Codex R2-#7).
    if (phases.includes('extract_facts')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'extract_facts',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.extract_facts');
        // v0.35.5 (codex #10): thread sourceId so multi-source brains route
        // the phantom-redirect pass to the right source, and brainDir so
        // the redirect handler can read/write disk fences. brainDir is the
        // already-resolved cycle scope; sourceId defaults to 'default' when
        // the sources table doesn't recognize this brainDir (pre-multi-
        // source installs).
        const xfSourceId = cycleSourceId ?? 'default';
        const { result, duration_ms } = await timePhase(() =>
          runPhaseExtractFacts(engine, brainDir, xfSourceId, dryRun, syncPagesAffected));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── v0.41 T9: extract_atoms (per-source, pack-gated) ──────────
    // Orchestrator-level pack gate: consults the active pack's `phases:`
    // declaration. When the active pack does NOT declare extract_atoms
    // (e.g. user is on gbrain-base or gbrain-investor), this phase is a
    // no-op with reason='not_in_active_pack'. When the pack does declare
    // it (gbrain-creator, gbrain-everything), dispatches to the
    // extract-atoms.ts module (real body in T5; stub for now).
    //
    // borrow_from does NOT borrow phases — each pack declares phase
    // participation explicitly. The packDeclaresPhase helper walks the
    // resolved active pack's `phases:` list ONLY; not the extends chain
    // or borrow_from targets.
    if (phases.includes('extract_atoms')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'extract_atoms',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else if (!(await packDeclaresPhase(engine, 'extract_atoms'))) {
        phaseResults.push({
          phase: 'extract_atoms',
          status: 'skipped',
          duration_ms: 0,
          summary: 'extract_atoms: active pack does not declare this phase',
          details: { reason: 'not_in_active_pack' },
        });
      } else {
        progress.start('cycle.extract_atoms');
        const { runPhaseExtractAtoms } = await import('./cycle/extract-atoms.ts');
        const xaSourceId = cycleSourceId ?? 'default';
        // v0.41.2.1 (D9 #5): union sync + synthesize affected slugs so the
        // incremental discovery path doesn't miss pages just-written by the
        // synthesize phase that ran earlier in the same cycle.
        const xaAffectedSlugs =
          syncPagesAffected || synthesizeWrittenSlugs
            ? [
                ...(syncPagesAffected ?? []),
                ...(synthesizeWrittenSlugs ?? []),
              ]
            : undefined;
        const { result, duration_ms } = await timePhase(() => runPhaseExtractAtoms(engine, {
          brainDir: brainDir ?? undefined,
          sourceId: xaSourceId,
          dryRun,
          affectedSlugs: xaAffectedSlugs,
          // v0.41.19.0 (T3): closure refreshes cycle lock + fires outer hook.
          yieldDuringPhase: buildYieldDuringPhase(lock, opts.yieldDuringPhase),
          // v0.41.19.0 (T4): pass same reporter (not a child — cycle.ts
          // owns start/finish; phase only ticks).
          progress,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── v0.33.3 W0c: resolve_symbol_edges (between extract_facts + patterns) ──
    // Walks chunks whose edges_backfilled_at is null/stale. Resumable
    // across cycles via the watermark. Quick-cycle compatible — caps at
    // BATCH_SIZE * 10 chunks per invocation so a 60s watchdog tick stays
    // responsive even on a 100K-chunk brain.
    if (phases.includes('resolve_symbol_edges')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'resolve_symbol_edges',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.resolve_symbol_edges');
        const { result, duration_ms } = await timePhase(() => runPhaseResolveSymbolEdges(engine, dryRun));
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
      } else if (brainDir === null) {
        phaseResults.push(skipNoBrainDir('patterns'));
      } else {
        progress.start('cycle.patterns');
        const { runPhasePatterns } = await import('./cycle/patterns.ts');
        const { result, duration_ms } = await timePhase(() => runPhasePatterns(engine, {
          brainDir,
          dryRun,
          yieldDuringPhase: opts.yieldDuringPhase,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── v0.41 T9: synthesize_concepts (global, pack-gated) ───────
    // Same pack-gate model as extract_atoms. Reads `phases:` from the
    // resolved active pack manifest; no-op when this phase isn't
    // declared. Real body in T6 — synthesize-concepts.ts is a stub today.
    if (phases.includes('synthesize_concepts')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'synthesize_concepts',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else if (!(await packDeclaresPhase(engine, 'synthesize_concepts'))) {
        phaseResults.push({
          phase: 'synthesize_concepts',
          status: 'skipped',
          duration_ms: 0,
          summary: 'synthesize_concepts: active pack does not declare this phase',
          details: { reason: 'not_in_active_pack' },
        });
      } else {
        progress.start('cycle.synthesize_concepts');
        const { runPhaseSynthesizeConcepts } = await import('./cycle/synthesize-concepts.ts');
        const { result, duration_ms } = await timePhase(() => runPhaseSynthesizeConcepts(engine, {
          brainDir: brainDir ?? undefined,
          dryRun,
          // v0.41.19.0 (T3): closure refreshes cycle lock + fires outer hook.
          yieldDuringPhase: buildYieldDuringPhase(lock, opts.yieldDuringPhase),
          // v0.41.19.0 (T4): pass same reporter (not a child).
          progress,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 7: recompute_emotional_weight (v0.29) ─────────────
    // Runs AFTER extract + synthesize so it sees fresh tags + takes for
    // every page touched in this cycle. Incremental mode uses union(sync,
    // synthesize); full mode walks every page in the brain.
    if (phases.includes('recompute_emotional_weight')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'recompute_emotional_weight',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.recompute_emotional_weight');
        const { runPhaseRecomputeEmotionalWeight } = await import('./cycle/recompute-emotional-weight.ts');
        // Determine incremental vs full mode. If sync OR synthesize ran in this
        // cycle, do incremental over their union. If neither phase ran (e.g.,
        // user passed `--phase recompute_emotional_weight`), do full walk.
        const incremental: string[] | undefined =
          (syncPagesAffected || synthesizeWrittenSlugs)
            ? Array.from(new Set([
                ...(syncPagesAffected ?? []),
                ...(synthesizeWrittenSlugs ?? []),
              ]))
            : undefined;
        const { result, duration_ms } = await timePhase(() =>
          runPhaseRecomputeEmotionalWeight(engine, {
            dryRun,
            affectedSlugs: incremental,
          }),
        );
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 8 (v0.31): consolidate facts → takes ──────────────
    // Cluster unconsolidated facts per entity, Sonnet-synthesize one take
    // per cluster, INSERT into takes(kind='fact'), mark facts as
    // consolidated_into. Never DELETE — facts are the audit trail.
    if (phases.includes('consolidate')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'consolidate',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.consolidate');
        const { runPhaseConsolidate } = await import('./cycle/phases/consolidate.ts');
        const { result, duration_ms } = await timePhase(() => runPhaseConsolidate(engine, {
          dryRun,
          yieldDuringPhase: opts.yieldDuringPhase,
        }));
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── v0.36.1.0 calibration phases (propose_takes → grade_takes →
    //    calibration_profile). These run AFTER consolidate so the proposal
    //    LLM sees newly-promoted facts, AFTER any take resolutions made
    //    earlier in the cycle, and BEFORE embed so the calibration
    //    narrative is available for downstream surfaces.
    //
    //    The three phases construct an OperationContext on the fly. The
    //    cycle is a trusted-workspace caller (operator CLI / autopilot
    //    daemon), so `remote: false` is the correct trust tier. sourceId
    //    is resolved via the same `resolveSourceForDir` helper sync uses.
    if (phases.includes('propose_takes') ||
        phases.includes('grade_takes') ||
        phases.includes('calibration_profile')) {
      if (engine) {
        const cfgMod = await import('./config.ts');
        const calibrationConfig = cfgMod.loadConfig() ?? ({} as ReturnType<typeof cfgMod.loadConfig> & object);
        const calibrationSourceId = cycleSourceId;
        const calibrationCtx = {
          engine,
          config: calibrationConfig,
          logger: { info() {}, warn() {}, error() {} } as never,
          dryRun,
          remote: false as const,
          sourceId: calibrationSourceId,
        } as never;

        if (phases.includes('propose_takes')) {
          checkAborted(opts.signal);
          progress.start('cycle.propose_takes');
          const { runPhaseProposeTakes } = await import('./cycle/propose-takes.ts');
          const { result, duration_ms } = await timePhase(() => runPhaseProposeTakes(calibrationCtx, { repoPath: brainDir ?? undefined }) as Promise<PhaseResult>);
          result.duration_ms = duration_ms;
          phaseResults.push(result);
          progress.finish();
          await safeYield(opts.yieldBetweenPhases);
        }

        if (phases.includes('grade_takes')) {
          checkAborted(opts.signal);
          progress.start('cycle.grade_takes');
          const { runPhaseGradeTakes } = await import('./cycle/grade-takes.ts');
          const { result, duration_ms } = await timePhase(() => runPhaseGradeTakes(calibrationCtx, {}) as Promise<PhaseResult>);
          result.duration_ms = duration_ms;
          phaseResults.push(result);
          progress.finish();
          await safeYield(opts.yieldBetweenPhases);
        }

        if (phases.includes('calibration_profile')) {
          checkAborted(opts.signal);
          progress.start('cycle.calibration_profile');
          const { runPhaseCalibrationProfile } = await import('./cycle/calibration-profile.ts');
          const { result, duration_ms } = await timePhase(() => runPhaseCalibrationProfile(calibrationCtx, {}) as Promise<PhaseResult>);
          result.duration_ms = duration_ms;
          phaseResults.push(result);
          progress.finish();
          await safeYield(opts.yieldBetweenPhases);
        }
      } else {
        for (const p of (['propose_takes', 'grade_takes', 'calibration_profile'] as const)) {
          if (phases.includes(p)) {
            phaseResults.push({
              phase: p,
              status: 'skipped',
              duration_ms: 0,
              summary: 'no database connected',
              details: { reason: 'no_database' },
            });
          }
        }
      }
    }

    // ── v0.41.11.0: conversation_facts_backfill ─────────────────
    // Opt-in (default OFF). Walks long-form conversation/meeting/slack/
    // email pages, segments by 30-min gap, runs facts extractor with a
    // topical/temporal header, writes facts + per-page TERMINAL audit
    // row. Per-source + brain-wide cost AND walltime caps; budget
    // tracker passed in from the phase wrapper (NOT nested-wrapped in
    // core — would REPLACE not stack).
    if (phases.includes('conversation_facts_backfill')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'conversation_facts_backfill',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.conversation_facts_backfill');
        const { runPhaseConversationFactsBackfill } = await import('./cycle/conversation-facts-backfill.ts');
        const { result, duration_ms } = await timePhase(() =>
          runPhaseConversationFactsBackfill(engine, { dryRun, signal: opts.signal }),
        );
        result.duration_ms = duration_ms;
        phaseResults.push(result);
        progress.finish();
      }
      await safeYield(opts.yieldBetweenPhases);
    }

    // ── Phase 8: embed ──────────────────────────────────────────
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

    // ── Phase 9: orphans ────────────────────────────────────────
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

    // ── v0.39 T12: schema-suggest ───────────────────────────────
    // Passive trigger of the runSuggest() library (D3 + D4 plan-eng-review).
    // Best-effort: phase failure does not abort the cycle. Writes nothing
    // to user data — output goes to ~/.gbrain/audit/schema-events-*.jsonl
    // (T15) and the disk-derived candidate set surfaced by `gbrain schema
    // review-candidates`.
    if (phases.includes('schema-suggest')) {
      checkAborted(opts.signal);
      if (!engine) {
        phaseResults.push({
          phase: 'schema-suggest',
          status: 'skipped',
          duration_ms: 0,
          summary: 'no database connected',
          details: { reason: 'no_database' },
        });
      } else {
        progress.start('cycle.schema_suggest');
        try {
          const { runSchemaSuggestPhase } = await import('./cycle/schema-suggest.ts');
          const { result, duration_ms } = await timePhase(async () => {
            const r = await runSchemaSuggestPhase(engine, { dryRun: !!opts.dryRun });
            return {
              phase: 'schema-suggest' as const,
              status: (r.skipped ? 'skipped' : 'ok') as PhaseStatus,
              duration_ms: 0,
              summary: r.skipped ? `skipped: ${r.reason ?? 'unknown'}` : `${r.suggestions_emitted} suggestions emitted`,
              details: { ...r },
            };
          });
          result.duration_ms = duration_ms;
          phaseResults.push(result);
        } catch (e) {
          phaseResults.push({
            phase: 'schema-suggest',
            status: 'fail',
            duration_ms: 0,
            summary: `error: ${(e as Error).message}`,
            details: { error: (e as Error).message },
          });
        }
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

  // v0.38 (codex r1 P0-5): persist per-source cycle completion timestamp
  // when the cycle ran successfully against an explicit source. Read by
  // autopilot's per-source freshness gate next tick. Skipped when:
  //   - opts.sourceId is unset (legacy callers — autopilot still here)
  //   - engine is null (no-DB path)
  //   - status is 'failed' or 'skipped' (don't mark a non-run as fresh)
  //   - dryRun (writes are out of scope)
  //
  // Best-effort: a write failure does NOT change the CycleReport status.
  // The cost of writing the wrong timestamp post-failure is higher than
  // the cost of missing a successful write (next cycle will redo work).
  if (opts.sourceId && engine && !dryRun && (status === 'ok' || status === 'clean' || status === 'partial')) {
    try {
      await engine.updateSourceConfig(opts.sourceId, {
        last_full_cycle_at: new Date().toISOString(),
      });
    } catch (e) {
      // Best-effort; cycle already succeeded by the time we get here.
      console.warn(`[cycle] failed to write last_full_cycle_at for source ${opts.sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
    pages_emotional_weight_recomputed: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    purged_sources_count: 0,
    purged_pages_count: 0,
    facts_consolidated: 0,
    consolidate_takes_written: 0,
    phantoms_redirected: 0,
    phantoms_ambiguous: 0,
    phantoms_skipped_drift: 0,
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
    } else if (p.phase === 'recompute_emotional_weight' && p.details) {
      t.pages_emotional_weight_recomputed = Number(p.details.pages_recomputed ?? 0);
    } else if (p.phase === 'resolve_symbol_edges' && p.details) {
      t.edges_resolved = Number(p.details.edges_resolved ?? 0);
      t.edges_ambiguous = Number(p.details.edges_ambiguous ?? 0);
    } else if (p.phase === 'purge' && p.details) {
      t.purged_sources_count = Number(p.details.purged_sources_count ?? 0);
      t.purged_pages_count = Number(p.details.purged_pages_count ?? 0);
    } else if (p.phase === 'consolidate' && p.details) {
      t.facts_consolidated = Number(p.details.facts_consolidated ?? 0);
      t.consolidate_takes_written = Number(p.details.takes_written ?? 0);
    } else if (p.phase === 'extract_facts' && p.details) {
      // v0.35.5: phantom-redirect counters live inside the extract_facts
      // phase's details block (the pre-pass runs before the main reconcile
      // loop and stamps its counts in the same phase result).
      t.phantoms_redirected = Number(p.details.phantoms_redirected ?? 0);
      t.phantoms_ambiguous = Number(p.details.phantoms_ambiguous ?? 0);
      t.phantoms_skipped_drift = Number(p.details.phantoms_skipped_drift ?? 0);
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
    totals.pages_embedded > 0 ||
    totals.pages_emotional_weight_recomputed > 0 ||
    // A7: a code brain runs `gbrain dream` specifically to build the call graph
    // (resolve_symbol_edges). Without these, an edges-only cycle reports 'clean'
    // — indistinguishable from "nothing happened" even when N edges resolved.
    totals.edges_resolved > 0 ||
    totals.edges_ambiguous > 0;
  return anyWork ? 'ok' : 'clean';
}
