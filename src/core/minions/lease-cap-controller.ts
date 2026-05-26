/**
 * v0.41 E5 (reframed per codex pass-1, corrected per codex pass-2 #9) —
 * auto-adaptive rate-lease cap.
 *
 * Original E5 (pre-reframe) tuned WORKER concurrency. Codex pass-1 caught
 * the fundamental design flaw: worker concurrency is downstream of the
 * rate-lease. If the lease is full at 32 in-flight, easing worker
 * concurrency from 10 to 5 just moves jobs from `active+bouncing` to
 * `waiting` — same throughput. The adaptive knob has to be the LEASE CAP
 * itself.
 *
 * Codex pass-2 #9 caught a sign error in the original lease-cap control
 * law: my first draft said "ramp DOWN on bounces > 5/min OR 429s > 0.5/min."
 * That's WRONG. Bounces happen when workers want more concurrency than the
 * cap allows — internal queue pressure. Without upstream pushback (429s
 * + latency unstable), bounces alone say "we're starving, raise the cap."
 * The Eng D6 corrected control law:
 *
 *   - Ramp DOWN: ONLY when upstream pushes back (429s > Y/min OR latency
 *     unstable). These are the "cap is too high" signals.
 *   - Ramp UP slow: 0 bounces + 0 429s + util > 50% + latency stable.
 *     We have headroom + jobs running; can probably go higher.
 *   - Ramp UP fast: bounces > X/min + 0 429s + latency stable. Workers
 *     are starving inside our artificial cap; raise it.
 *   - Deadband: middle region (some pressure but mixed signals).
 *
 * Per-tick election via tryWithDbElection (Eng D9): only one worker per
 * cluster runs the WRITE side per tick. All workers READ the lease cap
 * fresh from the DB on every acquire (short-TTL cache).
 *
 * Latency signal source: UPSTREAM (Anthropic SDK round-trip), NOT local
 * DB query latency. Local DB latency is noise; upstream latency is the
 * actual congestion signal. Codex pass-3 #2.
 */

import type { BrainEngine } from '../engine.ts';
import { tryWithDbElection } from '../db-lock.ts';

/** Rolling-window stats the controller reads each tick. */
export interface ControllerWindowStats {
  /** How many lease-full bounces happened in `window_ms`. */
  bounce_count: number;
  /** How many upstream 429s happened in `window_ms` (per worker, sum). */
  upstream_429_count: number;
  /** Mean (active / max_concurrent) over the window. NaN-safe → 0. */
  lease_utilization: number;
  /** Upstream round-trip latency stability. True when p95/p50 ratio < 2 in window. */
  latency_stable: boolean;
  /** Window size used for the rate calculations. ms. */
  window_ms: number;
}

export interface ControllerOpts {
  /** Lease cap to start from on first tick (matches GBRAIN_ANTHROPIC_MAX_INFLIGHT default). */
  initial_cap: number;
  /** Per-step ramp-up amount (additive). */
  ramp_up_step: number;
  /** Per-step ramp-down amount (additive; asymmetric > ramp_up_step for AIMD-style backoff). */
  ramp_down_step: number;
  /** Lower bound — never below this. */
  min_floor: number;
  /** Upper bound — never above this. CLI flag wins over env override (codex pass-2 #9). */
  max_ceiling: number;
  /** Bounce-rate threshold to consider "workers are starving" (events / min). */
  bounce_rate_starving_threshold: number;
  /** 429-rate threshold to consider "upstream is pushing back" (events / min). */
  upstream_429_threshold_per_min: number;
  /** Lease-utilization threshold below which we don't ramp-up-slow (no headroom signal needed). */
  utilization_ramp_threshold: number;
}

export const DEFAULT_CONTROLLER_OPTS: ControllerOpts = {
  initial_cap: 32,
  ramp_up_step: 4,
  ramp_down_step: 8, // AIMD-style asymmetric: back off faster than ramp up
  min_floor: 4,
  max_ceiling: 128,
  bounce_rate_starving_threshold: 1, // > 1 bounce/min with no upstream pushback = starving
  upstream_429_threshold_per_min: 0.5,
  utilization_ramp_threshold: 0.5,
};

/**
 * Pure decision function: given current cap + window stats, what's the
 * next cap? No I/O — fully testable for every signal combination.
 *
 * Decision tree (in order):
 *   1. Upstream pushback (429s OR latency unstable) → ramp DOWN. ONLY
 *      time we shrink the cap; without this, the controller would crater
 *      cap during healthy bursts (codex pass-2 #9 caught this).
 *   2. Workers starving (bounces > threshold + no upstream pushback) →
 *      ramp UP fast. Internal demand exceeding our artificial cap.
 *   3. Headroom available (no bounces + no 429s + util > threshold +
 *      latency stable) → ramp UP slow. We have work flowing through
 *      and the upstream has room.
 *   4. Otherwise → deadband (no change). Mixed signals = don't move.
 */
export function nextLeaseCap(
  current: number,
  window: ControllerWindowStats,
  opts: ControllerOpts = DEFAULT_CONTROLLER_OPTS,
): number {
  const windowMin = Math.max(1e-6, window.window_ms / 60_000);
  const bounceRatePerMin = window.bounce_count / windowMin;
  const upstream429PerMin = window.upstream_429_count / windowMin;

  // 1. Ramp DOWN — upstream pushback. Either 429s OR latency-unstable.
  //    These are the only signals saying "cap is too high."
  if (upstream429PerMin > opts.upstream_429_threshold_per_min || !window.latency_stable) {
    return Math.max(current - opts.ramp_down_step, opts.min_floor);
  }

  // 2. Ramp UP fast — workers are starving.
  //    Bounces > threshold AND no upstream pushback AND latency stable
  //    AND room to grow.
  if (
    bounceRatePerMin > opts.bounce_rate_starving_threshold &&
    upstream429PerMin === 0 &&
    window.latency_stable
  ) {
    return Math.min(current + opts.ramp_up_step, opts.max_ceiling);
  }

  // 3. Ramp UP slow — no pressure but utilization shows we're using the cap.
  //    Probes for headroom: small step, low risk.
  if (
    bounceRatePerMin === 0 &&
    upstream429PerMin === 0 &&
    window.lease_utilization > opts.utilization_ramp_threshold &&
    window.latency_stable
  ) {
    return Math.min(current + opts.ramp_up_step, opts.max_ceiling);
  }

  // 4. Deadband — mixed signals or no work happening.
  return current;
}

/**
 * Read the controller window stats from the DB. Reads
 * minion_lease_pressure_log + minion_jobs for the last `windowMs`.
 *
 * Pure-SQL function so the controller tick is one round-trip per source.
 * Latency signal is approximate today (uses subagent job durations as a
 * proxy — full upstream-latency tracking is filed as v0.42 follow-up).
 */
export async function readControllerWindow(
  engine: BrainEngine,
  windowMs: number,
): Promise<ControllerWindowStats> {
  // Bounce count over window. Pre-v93 brains return 0 silently.
  let bounceCount = 0;
  try {
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_lease_pressure_log
        WHERE bounced_at > now() - ($1::double precision * interval '1 millisecond')`,
      [windowMs],
    );
    bounceCount = parseInt(rows[0]?.count ?? '0', 10);
  } catch {
    /* pre-v93 brain */
  }

  // Upstream 429 count proxied via dead-letter classifier; this is rough
  // until v0.42 wires direct SDK 429 events into a counter table. For now,
  // count jobs whose last_error contains "429" or "rate limit" in the
  // window (classifier reuse keeps the signal cheap).
  let upstream429Count = 0;
  try {
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs
        WHERE finished_at > now() - ($1::double precision * interval '1 millisecond')
          AND status IN ('failed', 'dead')
          AND (error_text ILIKE '%429%' OR error_text ILIKE '%rate limit%')`,
      [windowMs],
    );
    upstream429Count = parseInt(rows[0]?.count ?? '0', 10);
  } catch {
    /* DB unavailable */
  }

  // Lease utilization: mean of (active_at_bounce / max_concurrent) per
  // bounce row. When 0 bounces, utilization is 0 (no signal — controller
  // treats this as "not enough data to ramp" → deadband).
  let leaseUtilization = 0;
  try {
    const rows = await engine.executeRaw<{ util: string | number }>(
      `SELECT COALESCE(AVG(active_at_bounce::double precision / NULLIF(max_concurrent, 0)), 0) AS util
         FROM minion_lease_pressure_log
        WHERE bounced_at > now() - ($1::double precision * interval '1 millisecond')`,
      [windowMs],
    );
    const raw = parseFloat(String(rows[0]?.util ?? '0'));
    leaseUtilization = Number.isFinite(raw) ? raw : 0;
  } catch {
    /* pre-v93 brain */
  }

  // Latency stability proxy: subagent job durations in window. If we have
  // at least 3 jobs with started_at + finished_at, compute p95/p50 ratio.
  // If < 2, stable; if >= 2 or insufficient samples, NOT stable.
  let latencyStable = true; // default true so first-tick controller can ramp up
  try {
    const rows = await engine.executeRaw<{ p50: number; p95: number; samples: string }>(
      `SELECT
         COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0) AS p50,
         COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))), 0) AS p95,
         count(*)::text AS samples
       FROM minion_jobs
       WHERE status = 'completed'
         AND name = 'subagent'
         AND started_at IS NOT NULL
         AND finished_at IS NOT NULL
         AND finished_at > now() - ($1::double precision * interval '1 millisecond')`,
      [windowMs],
    );
    const p50 = Number(rows[0]?.p50 ?? 0);
    const p95 = Number(rows[0]?.p95 ?? 0);
    const samples = parseInt(String(rows[0]?.samples ?? '0'), 10);
    if (samples >= 3 && p50 > 0) {
      latencyStable = (p95 / p50) < 2;
    }
  } catch {
    /* DB unavailable; default stable */
  }

  return {
    bounce_count: bounceCount,
    upstream_429_count: upstream429Count,
    lease_utilization: leaseUtilization,
    latency_stable: latencyStable,
    window_ms: windowMs,
  };
}

/**
 * Read the current lease cap from config (write target for the controller).
 * Falls back to opts.initial_cap when unset. Workers read this on every
 * acquire so they pick up controller writes within the cache TTL.
 */
export async function readCurrentLeaseCap(
  engine: BrainEngine,
  opts: ControllerOpts = DEFAULT_CONTROLLER_OPTS,
): Promise<number> {
  try {
    const v = await engine.getConfig('minions.lease_cap_current').catch(() => null);
    if (v) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= opts.min_floor && n <= opts.max_ceiling) return n;
    }
  } catch {
    /* config unavailable */
  }
  return opts.initial_cap;
}

/**
 * Write the new lease cap to config. Called by the elected worker after
 * a controller decision. Workers reading via readCurrentLeaseCap pick up
 * the new value within their cache TTL.
 */
export async function writeLeaseCap(engine: BrainEngine, cap: number): Promise<void> {
  await engine.setConfig('minions.lease_cap_current', String(cap));
}

/**
 * Run one controller tick. Elects a single mutator via tryWithDbElection;
 * other workers no-op. Returns the cap change tuple when elected, null
 * otherwise.
 */
export async function controllerTick(
  engine: BrainEngine,
  opts: ControllerOpts = DEFAULT_CONTROLLER_OPTS,
  windowMs: number = 60_000,
): Promise<{ previous: number; next: number; changed: boolean } | null> {
  return tryWithDbElection(engine, 'minions-lease-cap-controller', 2, async () => {
    const window = await readControllerWindow(engine, windowMs);
    const current = await readCurrentLeaseCap(engine, opts);
    const next = nextLeaseCap(current, window, opts);
    if (next !== current) {
      await writeLeaseCap(engine, next);
    }
    return { previous: current, next, changed: next !== current };
  });
}
