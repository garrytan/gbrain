/**
 * src/commands/autopilot-fanout.ts — per-source autopilot dispatch (v0.38).
 *
 * Replaces the v0.36+ "one autopilot-cycle job per tick" dispatch with a
 * fan-out across all sources whose freshness window has elapsed. The
 * headline win: a 5-source federated brain refreshes in ~5 min wall-clock
 * (parallel via worker pool) instead of ~25 min (sequential across 5 ticks).
 *
 * Per the codex outside-voice review of this plan:
 *   - P0-5: each per-source cycle writes `last_full_cycle_at` in its
 *     `sources.config` JSONB on success (handled in `runCycle` exit hook,
 *     not here — this module just READS it for freshness gating).
 *   - P1-2: explicitly threads `pull: !!source.config.remote_url` so
 *     local-only sources don't try to git-pull.
 *   - P1-3: PGLite engines default `fanoutMax=1` (PGLite is single-writer;
 *     parallel fan-out would queue uselessly behind the file lock).
 *   - P1-4: enumeration filters `local_path IS NOT NULL` so pure-DB
 *     sources don't get dispatched (handler would fall back to global
 *     sync.repo_path, which is wrong for them).
 *   - P1-5: archive recheck happens in the handler (jobs.ts:1146), not
 *     here, so a source archived between fan-out and worker claim still
 *     skips cleanly.
 *
 * Phase-scope caveat (codex r1 P0-1): per-source cycle LOCKS let two cycles
 * RUN concurrently, but several phases (embed, orphans, purge,
 * resolve_symbol_edges, grade_takes, calibration_profile) still walk the
 * brain globally inside each cycle. Genuine per-phase per-source isolation
 * is the deferred Phase 2 follow-up; THIS wave intentionally accepts that
 * two concurrent cycles share embed/orphans work (idempotent at the
 * row layer; cost duplication is the visible tradeoff).
 */

import type { BrainEngine, SourceRow } from '../core/engine.ts';
import type { MinionQueue } from '../core/minions/queue.ts';
import { SOURCE_FRESHNESS_PHASES, MAINTENANCE_PHASES, LAST_GLOBAL_AT_KEY } from '../core/cycle.ts';
import { sourceConfigHasRemoteUrl } from '../core/sources-load.ts';
import { AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES } from './autopilot-remediation-policy.ts';

// #2194 fix #2: failure cooldown. A source whose autopilot-cycle keeps
// failing/timing-out re-dispatches every tick today (only SUCCESS gates
// dispatch), so the same handful of sources fail and re-fan-out forever — the
// self-perpetuating dead-job storm. Back a failed source off with bounded
// exponential cooldown so a chronically-slow source can't re-dispatch every
// tick. Disabled with autopilot.failure_cooldown_min=0.
const FAILURE_COOLDOWN_BASE_MIN = 10;
const FAILURE_COOLDOWN_CAP_MIN = 120;
const FAILURE_COOLDOWN_EXP_CAP = 4; // 2^4 = 16× base before the cap clamps

/** Recent-failure record for one source (from minion_jobs dead/failed rows). */
export interface SourceFailure { count: number; lastFailedAt: Date; }

/** Resolved cooldown knobs. baseMin <= 0 means the cooldown is disabled. */
export interface CooldownOpts { baseMin: number; capMin: number; }

export interface FanoutOpts {
  repoPath: string;
  slot: string;
  timeoutMs: number;
  /**
   * Cap on per-tick job submissions. Postgres default 4; PGLite default 1.
   * Operator override via `autopilot.fanout_max_per_tick` config.
   */
  fanoutMax: number;
  jsonMode: boolean;
  /** Sink for dispatch events; defaults to process.stderr.write. */
  emit?: (line: string) => void;
  /** Sink for non-JSON human log lines; defaults to console.log. */
  log?: (line: string) => void;
}

export interface FanoutResult {
  /** Source ids whose submission INSERTED a fresh job this tick. */
  dispatched: string[];
  /** Source ids whose submission coalesced onto an existing pending job
   *  (maxPending single-flight or same-slot idempotency) — work is in
   *  flight, but no new row was created. Kept separate so no surface
   *  claims a dispatch that didn't insert. */
  coalesced: string[];
  /** Source ids skipped because their last_full_cycle_at is still fresh. */
  skipped_fresh: string[];
  /** Source ids beyond the fanoutMax cap (will retry next tick). */
  skipped_cap: string[];
  /** Source ids skipped because they're in failure cooldown (#2194 fix #2). */
  skipped_cooldown: string[];
  /** True when this tick fell back to the legacy single-job path
   *  (no sources rows / engine empty). */
  legacy_fallback: boolean;
  /** True when every enumerated source is inside the freshness window. */
  all_sources_fresh: boolean;
}

/**
 * Resolve `fanoutMax` honoring engine kind + operator override.
 *
 * Defaults: Postgres = 4, PGLite = 1.
 * Override: `autopilot.fanout_max_per_tick` config key (must be >= 1).
 * Codex P1-3: PGLite is single-writer; the global cycle.lock serializes
 * all source cycles even with per-source DB lock IDs. fanout > 1 on
 * PGLite produces no parallelism, only queue pressure. The override is
 * still allowed (operator opt-in) but documented as ineffective on PGLite.
 */
export async function resolveFanoutMax(engine: BrainEngine): Promise<number> {
  const override = await engine.getConfig('autopilot.fanout_max_per_tick');
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1) return n;
    // Invalid override falls through to default — never silently below 1.
  }
  return engine.kind === 'pglite' ? 1 : 4;
}

/**
 * Read the worker concurrency the supervisor most recently STARTED with, from
 * its `started` audit event (the lowest-coupling source — no extra lock-row
 * column). Filesystem read; returns null when no supervisor has ever started
 * (or the event lacks concurrency). Filtered by queue so a `shell`-queue
 * supervisor's concurrency doesn't leak into the `default`-queue decision.
 *
 * ADVISORY use only (doctor warning). Behavior-changing callers (the fanout
 * clamp) must additionally gate on a LIVE supervisor — see
 * resolveEffectiveFanoutMax — because a stale `started` row can otherwise
 * shrink fan-out for a supervisor that isn't running that config (codex #9/D5).
 */
export async function readSupervisorConcurrency(queue = 'default'): Promise<number | null> {
  try {
    const { readSupervisorEvents } = await import('../core/minions/handlers/supervisor-audit.ts');
    const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const started = events
      .filter((e) => e.event === 'started' && (e.queue === undefined || e.queue === queue))
      .pop();
    const c = started?.concurrency;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
  } catch {
    return null;
  }
}

/**
 * Resolve fanoutMax CLAMPED to the worker's effective concurrency (#2194 fix #1).
 *
 * Fanning out more cycles than the worker can run guarantees waiters that then
 * race the stalled-sweeper. Clamp to `max(1, concurrency - 1)` — reserving ≥1
 * slot for targeted sync/embed jobs that share the `default` queue.
 *
 * codex #9 / D5: the clamp is BEHAVIOR-changing, so it trusts only a
 * proven-alive supervisor (live DB-lock holder, `ttl_expires_at`-gated). With
 * no live holder the concurrency is UNKNOWN and we fall back to the unclamped
 * default (4 pg / 1 pglite) — the safe direction (never starve on stale data).
 * Operators can disable the clamp via `autopilot.fanout_clamp_to_concurrency`.
 */
export async function resolveEffectiveFanoutMax(engine: BrainEngine, queue = 'default'): Promise<number> {
  const base = await resolveFanoutMax(engine);
  const clampCfg = await engine.getConfig('autopilot.fanout_clamp_to_concurrency');
  if (clampCfg === 'false' || clampCfg === '0') return base; // operator opt-out
  try {
    const { inspectLock, isLockHolderLive } = await import('../core/db-lock.ts');
    const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../core/minions/supervisor.ts');
    const snap = await inspectLock(engine, supervisorLockId(queue));
    if (!snap || !isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN)) return base; // no live holder → unknown → no clamp
    const concurrency = await readSupervisorConcurrency(queue);
    if (concurrency === null) return base;
    return Math.max(1, Math.min(base, concurrency - 1));
  } catch {
    return base;
  }
}

/**
 * Read `last_full_cycle_at` ISO string from a source's config JSONB.
 * Returns null when missing or unparseable. Pure function over the row
 * shape `listAllSources` returns (config is already a parsed object).
 */
export function readLastFullCycleAt(src: SourceRow): Date | null {
  const raw = src.config?.last_full_cycle_at;
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * A source needs work when either:
 *   1. It has never had a full cycle complete (`last_full_cycle_at` null), OR
 *   2. The last full cycle is older than the freshness floor.
 *
 * `last_sync_at` is NOT consulted here — sync is one phase of a cycle, and
 * a brain may have fresh sync but stale extract/embed. The 60-min floor on
 * full-cycle is the canonical freshness signal for autopilot dispatch.
 */
export function isSourceStale(
  src: SourceRow,
  now = Date.now(),
  floorMin = AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES,
): boolean {
  const last = readLastFullCycleAt(src);
  if (last === null) return true;
  const ageMin = (now - last.getTime()) / 60_000;
  return ageMin >= floorMin;
}

/**
 * Most recent SUCCESSFUL cycle for a source. Prefers `last_source_cycle_at`
 * (per-source phases, written by the split cycle) and falls back to the legacy
 * `last_full_cycle_at`, so this works before AND after the cycle split.
 */
export function readLastSuccessAt(src: SourceRow): Date | null {
  const c = src.config ?? {};
  const raw = (typeof c.last_source_cycle_at === 'string' && c.last_source_cycle_at)
    || (typeof c.last_full_cycle_at === 'string' && c.last_full_cycle_at)
    || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Bounded exponential cooldown window (minutes) for a given failure count. */
export function cooldownMinForCount(count: number, opts: CooldownOpts): number {
  if (count <= 0 || opts.baseMin <= 0) return 0;
  const mult = Math.pow(2, Math.min(count - 1, FAILURE_COOLDOWN_EXP_CAP));
  return Math.min(opts.baseMin * mult, opts.capMin);
}

/**
 * Is a source currently in failure cooldown? Pure — drives both the dispatch
 * gate and the claim-time guard. A SUCCESS at-or-after the most recent failure
 * clears the cooldown (codex #7: operator repair / manual cycle re-eligibility),
 * so a recovered source is never suppressed by stale failure history.
 */
export function isInFailureCooldown(
  failure: SourceFailure | undefined,
  lastSuccessAt: Date | null,
  now: number,
  opts: CooldownOpts,
): boolean {
  if (opts.baseMin <= 0) return false;            // disabled
  if (!failure || failure.count <= 0) return false;
  if (lastSuccessAt && lastSuccessAt.getTime() >= failure.lastFailedAt.getTime()) return false;
  const cooldownMs = cooldownMinForCount(failure.count, opts) * 60_000;
  return (now - failure.lastFailedAt.getTime()) < cooldownMs;
}

/**
 * Resolve cooldown knobs from config. `autopilot.failure_cooldown_min` overrides
 * the base (0 = disable entirely — exactly today's behavior);
 * `autopilot.failure_cooldown_cap_min` overrides the ceiling.
 */
export async function resolveFailureCooldownOpts(engine: BrainEngine): Promise<CooldownOpts> {
  let baseMin = FAILURE_COOLDOWN_BASE_MIN;
  let capMin = FAILURE_COOLDOWN_CAP_MIN;
  const baseCfg = await engine.getConfig('autopilot.failure_cooldown_min');
  if (baseCfg !== null && baseCfg !== undefined && baseCfg !== '') {
    const n = parseInt(baseCfg, 10);
    if (Number.isFinite(n) && n >= 0) baseMin = n;
  }
  const capCfg = await engine.getConfig('autopilot.failure_cooldown_cap_min');
  if (capCfg) {
    const n = parseInt(capCfg, 10);
    if (Number.isFinite(n) && n >= 1) capMin = n;
  }
  return { baseMin, capMin };
}

/**
 * Read recent dead/failed autopilot-cycle jobs grouped by source. Read-at-
 * dispatch (NOT a write hook) because timeouts/RSS-kills/stalls dead-letter via
 * SQL in queue.ts and never run handler code — a write-only cooldown would miss
 * the exact failures that drive the storm. Engine-parity-safe via executeRaw
 * (one query, both engines); cutoff is precomputed in JS to avoid INTERVAL
 * portability concerns. codex #6: rows with a null source_id are excluded.
 */
export async function readRecentSourceFailures(
  engine: BrainEngine,
  opts: { sinceMin?: number; sourceId?: string } = {},
): Promise<Map<string, SourceFailure>> {
  const sinceMin = opts.sinceMin ?? FAILURE_COOLDOWN_CAP_MIN;
  const cutoff = new Date(Date.now() - sinceMin * 60_000).toISOString();
  const map = new Map<string, SourceFailure>();
  try {
    const params: unknown[] = [cutoff];
    let sql =
      `SELECT data->>'source_id' AS source_id,
              count(*)::int AS fail_count,
              max(finished_at) AS last_failed_at
         FROM minion_jobs
        WHERE name = 'autopilot-cycle'
          AND status IN ('dead','failed')
          AND data->>'source_id' IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > $1`;
    if (opts.sourceId) { params.push(opts.sourceId); sql += ` AND data->>'source_id' = $${params.length}`; }
    sql += ` GROUP BY data->>'source_id'`;
    const rows = await engine.executeRaw<{ source_id: string | null; fail_count: number; last_failed_at: string | Date }>(sql, params);
    for (const r of rows) {
      if (!r.source_id) continue; // codex #6 null-source guard (defensive)
      const last = r.last_failed_at instanceof Date ? r.last_failed_at : new Date(r.last_failed_at);
      if (!Number.isFinite(last.getTime())) continue;
      map.set(r.source_id, { count: Number(r.fail_count) || 0, lastFailedAt: last });
    }
  } catch {
    // Pre-migration / transient DB error → no cooldown data (fail open: dispatch).
  }
  return map;
}

/**
 * Claim-time cooldown guard (codex #5 / D4): a job already queued or retrying
 * (max_attempts:2) can reach the worker after the dispatch gate decided. The
 * handler calls this immediately before runCycle; an in-cooldown claim becomes
 * a no-op skip (NOT a failure — it must not re-arm the cooldown). Shares the
 * exact cooldown math with the dispatch gate (DRY).
 */
export async function isSourceInCooldown(engine: BrainEngine, sourceId: string, now = Date.now()): Promise<boolean> {
  const opts = await resolveFailureCooldownOpts(engine);
  if (opts.baseMin <= 0) return false;
  const failures = await readRecentSourceFailures(engine, { sinceMin: opts.capMin, sourceId });
  const failure = failures.get(sourceId);
  if (!failure) return false;
  let lastSuccessAt: Date | null = null;
  try {
    const rows = await engine.executeRaw<{ config: Record<string, unknown> | null }>(
      `SELECT config FROM sources WHERE id = $1`, [sourceId],
    );
    if (rows[0]) lastSuccessAt = readLastSuccessAt({ config: rows[0].config ?? {} } as SourceRow);
  } catch { /* treat as no success */ }
  return isInFailureCooldown(failure, lastSuccessAt, now, opts);
}

/**
 * Decide which sources to dispatch this tick. Pure function so tests can
 * exercise the freshness gate + cap math without an engine.
 *
 * Returns the ordered list of source ids to fan out:
 *   - Filters to stale sources (per isSourceStale).
 *   - Sorts by oldest-first (sources with NULL last_full_cycle_at go first;
 *     then oldest by ascending date). Deterministic for tests.
 *   - Caps at fanoutMax. Sources past the cap retry next tick.
 */
export function selectSourcesForDispatch(
  sources: SourceRow[],
  fanoutMax: number,
  now = Date.now(),
  floorMin = AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES,
  recentFailures: Map<string, SourceFailure> = new Map(),
  cooldownOpts: CooldownOpts = { baseMin: FAILURE_COOLDOWN_BASE_MIN, capMin: FAILURE_COOLDOWN_CAP_MIN },
): { dispatch: SourceRow[]; skippedFresh: SourceRow[]; skippedCap: SourceRow[]; skippedCooldown: SourceRow[] } {
  const stale: SourceRow[] = [];
  const fresh: SourceRow[] = [];
  const cooldown: SourceRow[] = [];
  for (const s of sources) {
    if (!isSourceStale(s, now, floorMin)) { fresh.push(s); continue; }
    // #2194 fix #2: a stale source that recently failed is held in cooldown so
    // it can't re-dispatch every tick (the storm). Success clears it.
    if (isInFailureCooldown(recentFailures.get(s.id), readLastSuccessAt(s), now, cooldownOpts)) {
      cooldown.push(s);
      continue;
    }
    stale.push(s);
  }
  // Oldest-first ordering: NULL last_full_cycle_at sorts before any timestamp.
  stale.sort((a, b) => {
    const la = readLastFullCycleAt(a)?.getTime() ?? -Infinity;
    const lb = readLastFullCycleAt(b)?.getTime() ?? -Infinity;
    if (la !== lb) return la - lb;
    return a.id.localeCompare(b.id); // tiebreaker: stable alphabetical
  });
  const dispatch = stale.slice(0, fanoutMax);
  const skippedCap = stale.slice(fanoutMax);
  return { dispatch, skippedFresh: fresh, skippedCap, skippedCooldown: cooldown };
}

/**
 * Per-tick autopilot fan-out. Replaces the v0.36+ single autopilot-cycle
 * dispatch when `shouldFullCycle` is true.
 *
 * Fallback path: if `listAllSources` returns 0 rows (fresh install before
 * `gbrain sources add`, or `sources` table not migrated yet), submit ONE
 * legacy autopilot-cycle with no source_id so the existing single-source
 * brain keeps working.
 */
export async function dispatchPerSource(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: FanoutOpts,
): Promise<FanoutResult> {
  const emit = opts.emit ?? ((line) => process.stderr.write(line + '\n'));
  const log = opts.log ?? ((line) => console.log(line));

  let sources: SourceRow[];
  try {
    sources = await engine.listAllSources({ localPathOnly: true });
  } catch (e) {
    // Brand-new brain without sources table (pre-v0.18) — fall through
    // to the legacy single-job path. The error path here also covers
    // a misconfigured engine, but legacy fallback is safer than failing.
    if (opts.jsonMode) {
      emit(JSON.stringify({ event: 'fanout_unavailable', error: e instanceof Error ? e.message : String(e) }));
    }
    sources = [];
  }

  if (sources.length === 0) {
    // Legacy path — preserves today's behavior for single-source brains
    // (default source) and pre-v0.18 brains without the sources table.
    const job = await queue.add(
      'autopilot-cycle',
      { repoPath: opts.repoPath },
      {
        queue: 'default',
        // Slot key dedups repeats within one slot; maxPending: 1 is the
        // cross-slot guard — an in-flight (waiting or live-lock active)
        // cycle suppresses re-dispatch even after the slot rotates. This
        // closes the unbounded-duplicate loop: slot rotation used to mint
        // a fresh key every baseInterval while maxWaiting ignored the
        // active row, growing the queue forever when a cycle stalled.
        idempotency_key: `autopilot-cycle:${opts.slot}`,
        max_attempts: 2,
        timeout_ms: opts.timeoutMs,
        maxPending: 1,
      },
    );
    if (job.coalesced) {
      if (opts.jsonMode) {
        emit(JSON.stringify({ event: 'dispatch_coalesced', job_id: job.id, mode: 'legacy', slot: opts.slot }));
      } else {
        log(`[dispatch] coalesced onto job #${job.id} autopilot-cycle (legacy single-source; already in flight)`);
      }
    } else if (opts.jsonMode) {
      emit(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'legacy', slot: opts.slot }));
    } else {
      log(`[dispatch] job #${job.id} autopilot-cycle (legacy single-source)`);
    }
    return {
      dispatched: [],
      coalesced: [],
      skipped_fresh: [],
      skipped_cap: [],
      skipped_cooldown: [],
      legacy_fallback: true,
      all_sources_fresh: false,
    };
  }

  // #2194 fix #2: load recent per-source failures + cooldown knobs so a
  // chronically-failing source is backed off instead of re-dispatched every
  // tick. Fail-open: cooldown is an optimization, not a correctness gate — if
  // config/job-history reads fail (or the engine lacks them), dispatch proceeds
  // with no cooldown rather than blocking.
  let cooldownOpts: CooldownOpts = { baseMin: 0, capMin: FAILURE_COOLDOWN_CAP_MIN };
  let recentFailures = new Map<string, SourceFailure>();
  try {
    cooldownOpts = await resolveFailureCooldownOpts(engine);
    if (cooldownOpts.baseMin > 0) {
      recentFailures = await readRecentSourceFailures(engine, { sinceMin: cooldownOpts.capMin });
    }
  } catch {
    cooldownOpts = { baseMin: 0, capMin: FAILURE_COOLDOWN_CAP_MIN };
  }

  const { dispatch, skippedFresh, skippedCap, skippedCooldown } =
    selectSourcesForDispatch(
      sources,
      opts.fanoutMax,
      Date.now(),
      AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES,
      recentFailures,
      cooldownOpts,
    );

  const dispatched: string[] = [];
  const coalesced: string[] = [];
  for (const src of dispatch) {
    try {
      const shouldPull = sourceConfigHasRemoteUrl(src.config);
      const job = await queue.add(
        'autopilot-cycle',
        {
          repoPath: opts.repoPath,
          source_id: src.id,
          pull: shouldPull,
          // Freshness is stamped by bounded deterministic work only. LLM-backed
          // source enrichment (atoms, takes, thin-page development, etc.) is
          // explicit/background work and cannot hold source freshness hostage.
          phases: SOURCE_FRESHNESS_PHASES,
        },
        {
          queue: 'default',
          // Per-source idempotency key — two ticks for the same source
          // within the same slot coalesce; different sources never collide.
          idempotency_key: `autopilot-cycle:${src.id}:${opts.slot}`,
          max_attempts: 2,
          timeout_ms: opts.timeoutMs,
          // Still DELIBERATELY no maxWaiting here (its NULL-as-wildcard
          // source scope would coalesce N per-source jobs down to one).
          // maxPending is safe: its scope is EXACT on
          // COALESCE(data.sourceId, data.source_id), so each source keeps
          // an independent single-flight cap — and unlike the slot key, it
          // suppresses cross-slot re-dispatch while THIS source's cycle is
          // still in flight (waiting or live-lock active).
          maxPending: 1,
        },
      );
      if (job.coalesced) {
        coalesced.push(src.id);
        if (opts.jsonMode) {
          emit(JSON.stringify({
            event: 'dispatch_coalesced',
            job_id: job.id,
            mode: 'per_source',
            source_id: src.id,
            slot: opts.slot,
          }));
        } else {
          log(`[dispatch] coalesced onto job #${job.id} autopilot-cycle source=${src.id} (already in flight)`);
        }
      } else {
        dispatched.push(src.id);
        if (opts.jsonMode) {
          emit(JSON.stringify({
            event: 'dispatched',
            job_id: job.id,
            mode: 'per_source',
            source_id: src.id,
            pull: shouldPull,
            slot: opts.slot,
          }));
        } else {
          log(`[dispatch] job #${job.id} autopilot-cycle source=${src.id}${shouldPull ? ' pull=yes' : ''}`);
        }
      }
    } catch (e) {
      // Per-source submit failure does NOT abort the tick (codex E1 F1
      // defensive). Other sources still dispatched; this one retries
      // next tick.
      if (opts.jsonMode) {
        emit(JSON.stringify({
          event: 'fanout_submit_failed',
          source_id: src.id,
          error: e instanceof Error ? e.message : String(e),
        }));
      } else {
        log(`[dispatch] WARN source=${src.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (skippedCap.length > 0 && opts.jsonMode) {
    emit(JSON.stringify({
      event: 'fanout_cap_reached',
      cap: opts.fanoutMax,
      pending: skippedCap.map(s => s.id),
    }));
  }

  if (skippedCooldown.length > 0 && opts.jsonMode) {
    emit(JSON.stringify({
      event: 'fanout_cooldown_skipped',
      sources: skippedCooldown.map(s => s.id),
    }));
  }

  return {
    dispatched,
    coalesced,
    skipped_fresh: skippedFresh.map(s => s.id),
    skipped_cap: skippedCap.map(s => s.id),
    skipped_cooldown: skippedCooldown.map(s => s.id),
    legacy_fallback: false,
    all_sources_fresh: skippedFresh.length === sources.length,
  };
}

const GLOBAL_FLOOR_MIN = 60;

/** Is the brain-wide maintenance overdue? Null/unparseable → overdue. */
export function isGlobalMaintenanceStale(lastGlobalAtIso: string | null, now = Date.now(), floorMin = GLOBAL_FLOOR_MIN): boolean {
  if (!lastGlobalAtIso) return true;
  const d = new Date(lastGlobalAtIso);
  if (!Number.isFinite(d.getTime())) return true;
  return (now - d.getTime()) / 60_000 >= floorMin;
}

/**
 * #2194 fix #3 / #2227 bug #3 — dispatch the single brain-wide maintenance job
 * that runs the `mixed` + `global` cycle phases ONCE per
 * window, instead of N per-source cycles each running them concurrently (the
 * RSS blowout). Single-flight is structural: one `idempotency_key` per slot +
 * `maxPending:1` (an in-flight waiting/live-lock-active run suppresses
 * re-dispatch even across slot rotation), so a slow run never stacks. Gated on
 * `autopilot.last_global_at` (stamped by the handler on success). Postgres-only
 * fan-out concern; on PGLite the file lock already serializes, but the job is
 * still correct there.
 */
export async function dispatchGlobalMaintenance(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { repoPath: string; slot: string; timeoutMs: number; jsonMode: boolean; emit?: (l: string) => void; log?: (l: string) => void },
): Promise<{ dispatched: boolean; coalesced?: boolean; reason: 'stale' | 'fresh' }> {
  const emit = opts.emit ?? ((line) => process.stderr.write(line + '\n'));
  const log = opts.log ?? ((line) => console.log(line));

  let floorMin = GLOBAL_FLOOR_MIN;
  const floorCfg = await engine.getConfig('autopilot.global_floor_min');
  if (floorCfg) {
    const n = parseInt(floorCfg, 10);
    if (Number.isFinite(n) && n >= 1) floorMin = n;
  }
  const lastGlobalAt = await engine.getConfig(LAST_GLOBAL_AT_KEY);
  if (!isGlobalMaintenanceStale(lastGlobalAt, Date.now(), floorMin)) {
    return { dispatched: false, reason: 'fresh' };
  }

  const job = await queue.add(
    'autopilot-global-maintenance',
    { repoPath: opts.repoPath, phases: MAINTENANCE_PHASES },
    {
      queue: 'default',
      // Structural single-flight: one global job per slot; maxPending:1
      // coalesces any surplus — including across slot rotation while a slow
      // brain-wide pass is still in flight — so duplicates never stack.
      idempotency_key: `autopilot-global:${opts.slot}`,
      max_attempts: 2,
      timeout_ms: opts.timeoutMs,
      maxPending: 1,
    },
  );
  if (job.coalesced) {
    if (opts.jsonMode) {
      emit(JSON.stringify({ event: 'dispatch_coalesced', job_id: job.id, mode: 'global_maintenance', slot: opts.slot }));
    } else {
      log(`[dispatch] coalesced onto job #${job.id} autopilot-global-maintenance (already in flight)`);
    }
    // dispatched: false — no row was inserted (same honest-dispatch contract
    // as dispatchPerSource, where coalesced sources are excluded from
    // `dispatched`). The coalesced flag says work is already in flight.
    return { dispatched: false, coalesced: true, reason: 'stale' };
  }
  if (opts.jsonMode) {
    emit(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'global_maintenance', slot: opts.slot }));
  } else {
    log(`[dispatch] job #${job.id} autopilot-global-maintenance (brain-wide phases)`);
  }
  return { dispatched: true, reason: 'stale' };
}
