/**
 * DB liveness probe with pool-starvation disambiguation (issue #6).
 *
 * The incident this exists for: a worker's read pool was exhausted by
 * checked-out-and-abandoned queries, the `SELECT 1` probe couldn't get a slot
 * within its budget, and the worker exited with "DB unreachable" — while the
 * server sat at ~10% of max_connections. Operators spent hours on the wrong
 * layer (evaluating an instance upgrade that would have changed nothing).
 *
 * Mechanism: probe the read pool; on failure, probe the DIRECT session lane
 * (when dual-pool is active). Direct success proves the server is reachable
 * and narrows the fault to the transaction-pooler path — client pool
 * exhaustion or a pooler-layer fault; the probe deliberately does NOT claim
 * to distinguish those two (codex-2 #2). Either way the operator is pointed
 * away from "the database is down / too small".
 *
 * Verdicts:
 *   pool_starved       — read probe failed, direct probe succeeded.
 *   server_unreachable — read AND direct probes failed.
 *   unknown            — read probe failed, no direct lane to disambiguate.
 *
 * Both probes carry an AbortSignal that fires when their deadline wins, so a
 * hung probe is cancelled (slot released), never abandoned — same contract
 * as the lock-renewal tick.
 *
 * Pure/hermetic: every effect is injected via `DbProbeDeps`; the worker's
 * adapter is a thin closure. (lock-renewal-tick.ts is the pattern.)
 */

import type { PoolGaugeSnapshot } from '../pool-gauge.ts';

export type ProbeVerdict = 'pool_starved' | 'server_unreachable' | 'unknown';

/** Default budget for the direct-lane disambiguation probe. */
export const DIRECT_PROBE_TIMEOUT_MS = 3_000;

export interface PoolDiagnostics {
  /** Gauge counts — a tracked SUBSET (see pool-gauge.ts honesty contract). */
  tracked: PoolGaugeSnapshot;
  /** Read-pool max, when the engine can report it; null otherwise. */
  poolMax: number | null;
}

export interface DbProbeDeps {
  /** SELECT 1 on the read pool; MUST honor the signal (cancellation). */
  probeRead: (signal: AbortSignal) => Promise<void>;
  /**
   * SELECT 1 on the direct session lane. Present ONLY when dual-pool is
   * genuinely active — an executeRawDirect that would silently fall back to
   * the read pool (kill-switch collapse) must NOT be passed here, or the
   * "disambiguation" would probe the same starved pool twice.
   */
  probeDirect?: (signal: AbortSignal) => Promise<void>;
  /** Optional gauge snapshot for supporting detail. Fail-open: may be absent or throw. */
  getDiagnostics?: () => PoolDiagnostics | null;
  /** Read-probe budget (worker default 10s). */
  timeoutMs: number;
  /** Direct-probe budget (default 3s). */
  directTimeoutMs: number;
}

export type DbProbeResult =
  | { ok: true }
  | { ok: false; verdict: ProbeVerdict; detail: string };

/**
 * Narrow, shared view of the engine's ConnectionManager for routing-aware
 * callers (the worker's probe adapter, jobs.ts's single-pool startup
 * warning). One typed accessor instead of hand-rolled structural casts that
 * drift independently from the real class (maintainability review).
 */
export interface EngineConnectionRouting {
  isDualPoolActive?: () => boolean;
  describeMode?: () => { kill_switch_active?: boolean; direct_pool_size?: number };
}

export function getConnectionRouting(engine: unknown): EngineConnectionRouting | null {
  const cm = (engine as { connectionManager?: EngineConnectionRouting }).connectionManager;
  return cm ?? null;
}

async function withDeadline(
  run: (signal: AbortSignal) => Promise<void>,
  ms: number,
  label: string,
): Promise<void> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      run(ac.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error(`${label} timeout after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/** Render gauge detail. Never throws; empty string when unavailable. */
function renderDiagnostics(getDiagnostics?: () => PoolDiagnostics | null): string {
  try {
    const diag = getDiagnostics?.();
    if (!diag) return '';
    const { tracked, poolMax } = diag;
    const maxNote = poolMax != null ? ` (read pool max ${poolMax})` : '';
    const base =
      ` gbrain-tracked in flight (subset — template-path queries untracked):` +
      ` raw=${tracked.raw}, direct=${tracked.direct}, reserved=${tracked.reserved}, tx=${tracked.tx}${maxNote}.`;
    const total = tracked.raw + tracked.direct + tracked.reserved + tracked.tx;
    if (total === 0) {
      return (
        base +
        ' Tracked subset shows 0 in flight — the saturation is in untracked' +
        ' template-query traffic; see docs/guides/queue-operations-runbook.md.'
      );
    }
    return base;
  } catch {
    return '';
  }
}

export async function runDbProbe(deps: DbProbeDeps): Promise<DbProbeResult> {
  let readErrMsg: string;
  try {
    await withDeadline(deps.probeRead, deps.timeoutMs, 'probe');
    return { ok: true };
  } catch (e) {
    readErrMsg = e instanceof Error ? e.message : String(e);
  }

  if (!deps.probeDirect) {
    return {
      ok: false,
      verdict: 'unknown',
      detail: `${readErrMsg}; no direct lane available to disambiguate pool starvation from a dead server`,
    };
  }

  const t0 = Date.now();
  try {
    await withDeadline(deps.probeDirect, deps.directTimeoutMs, 'direct probe');
    return {
      ok: false,
      verdict: 'pool_starved',
      detail:
        `read-pool probe failed (${readErrMsg}) but the direct-lane probe succeeded in ${Date.now() - t0}ms — ` +
        `the server IS reachable; the fault is in the transaction-pooler path ` +
        `(client pool exhaustion or a pooler-layer fault).` +
        renderDiagnostics(deps.getDiagnostics),
    };
  } catch (e) {
    const directErrMsg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      verdict: 'server_unreachable',
      detail: `read probe: ${readErrMsg}; direct probe: ${directErrMsg} — server/network unreachable`,
    };
  }
}
