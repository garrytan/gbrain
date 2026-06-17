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

const FULL_CYCLE_FLOOR_MIN = 60;

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
  /** Source ids dispatched this tick. */
  dispatched: string[];
  /** Source ids skipped because their last_full_cycle_at is still fresh. */
  skipped_fresh: string[];
  /** Source ids beyond the fanoutMax cap (will retry next tick). */
  skipped_cap: string[];
  /** True when this tick fell back to the legacy single-job path
   *  (no sources rows / engine empty). */
  legacy_fallback: boolean;
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
export function isSourceStale(src: SourceRow, now = Date.now(), floorMin = FULL_CYCLE_FLOOR_MIN): boolean {
  const last = readLastFullCycleAt(src);
  if (last === null) return true;
  const ageMin = (now - last.getTime()) / 60_000;
  return ageMin >= floorMin;
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
  floorMin = FULL_CYCLE_FLOOR_MIN,
): { dispatch: SourceRow[]; skippedFresh: SourceRow[]; skippedCap: SourceRow[] } {
  const stale: SourceRow[] = [];
  const fresh: SourceRow[] = [];
  for (const s of sources) {
    (isSourceStale(s, now, floorMin) ? stale : fresh).push(s);
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
  return { dispatch, skippedFresh: fresh, skippedCap };
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
        idempotency_key: `autopilot-cycle:${opts.slot}`,
        max_attempts: 2,
        timeout_ms: opts.timeoutMs,
        maxWaiting: 1,
      },
    );
    if (opts.jsonMode) {
      emit(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'legacy', slot: opts.slot }));
    } else {
      log(`[dispatch] job #${job.id} autopilot-cycle (legacy single-source)`);
    }
    return { dispatched: [], skipped_fresh: [], skipped_cap: [], legacy_fallback: true };
  }

  const { dispatch, skippedFresh, skippedCap } = selectSourcesForDispatch(sources, opts.fanoutMax);

  const dispatched: string[] = [];
  for (const src of dispatch) {
    try {
      const remoteUrl = typeof src.config?.remote_url === 'string' ? src.config.remote_url : null;
      const job = await queue.add(
        'autopilot-cycle',
        {
          repoPath: opts.repoPath,
          source_id: src.id,
          pull: !!remoteUrl,
        },
        {
          queue: 'default',
          // Per-source idempotency key — two ticks for the same source
          // within the same slot coalesce; different sources never collide.
          idempotency_key: `autopilot-cycle:${src.id}:${opts.slot}`,
          max_attempts: 2,
          timeout_ms: opts.timeoutMs,
          // DELIBERATELY no maxWaiting: 1 here. maxWaiting is per
          // (name, queue), so it would coalesce all N per-source jobs
          // sharing name='autopilot-cycle' down to ONE waiting job —
          // killing the fan-out. The per-source idempotency_key
          // already provides the right dedup granularity (one job per
          // source per slot, regardless of how many ticks try).
        },
      );
      dispatched.push(src.id);
      if (opts.jsonMode) {
        emit(JSON.stringify({
          event: 'dispatched',
          job_id: job.id,
          mode: 'per_source',
          source_id: src.id,
          pull: !!remoteUrl,
          slot: opts.slot,
        }));
      } else {
        log(`[dispatch] job #${job.id} autopilot-cycle source=${src.id}${remoteUrl ? ' pull=yes' : ''}`);
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

  return {
    dispatched,
    skipped_fresh: skippedFresh.map(s => s.id),
    skipped_cap: skippedCap.map(s => s.id),
    legacy_fallback: false,
  };
}
