/**
 * Pure lock-renewal tick (v0.41.22.2).
 *
 * Extracted from `MinionWorker.launchJob`'s setInterval body so the
 * lock-renewal state machine is testable without timer / process
 * surface. The worker reduces to a thin sync wrapper that calls
 * `runLockRenewalTick` from inside `setInterval(() => {...})`; all
 * decision logic, error-handling, and audit hooks live here as a pure
 * function over injected dependencies.
 *
 * Closes the v0.41.22.1 production crash class
 * (`unhandledRejection at renewLock`) AND four additional gaps the
 * outside-voice (codex) review surfaced:
 *
 *   - **Hung renewLock**: the original PR's re-entrancy guard skipped
 *     overlapping ticks but a permanently-pending await would wedge the
 *     guard forever. `runLockRenewalTick` wraps each renewLock in
 *     `Promise.race(call, timeoutPromise)` with `callTimeoutMs` so the
 *     call cannot pend longer than the configured budget.
 *
 *   - **Verify-before-evict (#4145, replaces the v0.41.22.2 abort-at-
 *     deadline doctrine)**: a thrown/timed-out renewal is NOT evidence of
 *     loss — under event-loop starvation the UPDATE may even have landed
 *     server-side while the local race timeout won. When the NEXT tick
 *     would land past the soft deadline (`lockDuration - safetyMargin`,
 *     cadence-aware per CDX-4), the tick runs ONE bounded VERIFY renewal:
 *     fenced-true → starved-but-ours, lease re-extended, keep working;
 *     fenced-false → CERTAIN loss, abort (stall detector requeues, no
 *     attempt burned); verify unreachable → defer and retry next tick,
 *     aborting only past the `hardEvictMs` backstop (a LOCAL decision
 *     under uncertainty that bounds blind external side effects during a
 *     total outage). The local clock only schedules WHEN to verify —
 *     the DB fence decides WHETHER to evict; production binds `deps.now`
 *     to a monotonic source so wall-clock jumps can't distort the math.
 *     Accepted timing behavior (ENG-E1): at the 30s default a failed
 *     renewal (≤10s) + verify (≤10s) can span 20s > the 15s cadence, so
 *     tickInFlight skips one tick — benign (a verify-success re-extends
 *     the lease and resets the baseline); do not "fix" it into an
 *     overlap. The failure counter is kept for audit-event labeling only.
 *
 *   - **Cancelled-tick race**: if the job ends while a renewLock call
 *     is mid-flight, the IIFE in worker.ts must bail without writing
 *     a misleading audit event. State carries a `cancelled` thunk
 *     that the tick checks at three points (entry, after the await
 *     resolves, after the await throws).
 *
 *   - **Audit defense-in-depth**: each call into the audit sink is
 *     wrapped in its own inner try/catch. The audit-writer primitive
 *     already promises "best-effort, never throws," but a defense
 *     layer here keeps a misbehaving audit from re-introducing the
 *     unhandledRejection bug class through a new surface.
 *
 * Pure function — no I/O, no module-level state, no closure-over-class
 * fields. All effects route through injected `deps` so tests are
 * trivially hermetic.
 *
 * Knob resolution lives in `resolveLockRenewalKnobs(env, lockDuration)`
 * below; tests + workers both consume it.
 */

/**
 * Named error for the per-call timeout race so cause classification is
 * name-based (`call-timeout` vs `refused`), never message-sniffing
 * (issue #4145 request 3).
 */
export class RenewalCallTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'RenewalCallTimeoutError';
  }
}

/**
 * Why a renewal attempt failed, as far as the tick can tell:
 *   - `call-timeout`  — our own race timer fired (starved loop, slow pool,
 *                       or slow DB — the tick can't distinguish; lateness
 *                       + load telemetry does).
 *   - `refused`       — the driver threw (SQLSTATE rides in the audit event).
 *   - `fenced-lost`   — the fenced UPDATE matched 0 rows: CERTAIN loss.
 */
export type RenewalFailureCause = 'call-timeout' | 'refused' | 'fenced-lost';

/**
 * Optional telemetry threaded to the audit sink alongside each event.
 * All fields additive — the 4-outcome audit contract is unchanged and
 * pre-upgrade JSONL lines parse fine without them.
 */
export interface LockRenewalTelemetryCtx {
  cause?: RenewalFailureCause;
  lateness_ms?: number;
  overlap_skips?: number;
  load1?: number;
  cores?: number;
  via?: 'renewal' | 'verify';
  deadline_deferred?: boolean;
}

export interface LockRenewalKnobs {
  /**
   * Failure counter cap used ONLY for audit-event labeling.
   * Abort triggering uses the time-based deadline (NOT this count).
   * Env: `GBRAIN_LOCK_RENEWAL_MAX_FAILURES`. Default: 3.
   */
  maxFailuresForAudit: number;
  /**
   * Per-renewLock-call timeout enforced via `Promise.race`.
   * Env: `GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS`. Default: `min(lockDuration / 3, 15s)`
   * (the cap keeps a long per-job lease from inheriting a call budget that
   * wedges tickInFlight across cadence windows).
   * Bounds the "hung renewLock wedges the re-entrancy guard forever" vector.
   */
  callTimeoutMs: number;
  /**
   * The soft deadline is `lockDuration - safetyMarginMs`: once the NEXT
   * tick would land past it, the tick runs the at-deadline VERIFY renewal
   * (fenced re-check) instead of retrying blindly. The margin is the
   * headroom the verify has to complete before the lease actually lapses.
   * Env: `GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS`. Default: `min(lockDuration / 6, 30s)`.
   */
  safetyMarginMs: number;
  /**
   * The hard local backstop (#4145): when even the VERIFY renewal is
   * unreachable (throws/times out) for this long since the last success,
   * abort anyway. This is an uncertainty BOUND, not a certainty claim —
   * fenced-false is the only CERTAIN loss signal; the hard evict merely
   * caps how long a handler with non-fenced EXTERNAL side effects may run
   * blind during a total DB outage. APPROXIMATE by design: checked after
   * a primary call + verify (overshoot up to ~2×callTimeoutMs + timer
   * lateness), and eviction stays cooperative (an abort-ignoring handler
   * outlives it — the kill/reap follow-up TODO is the true bound).
   * Setting this to the soft deadline approximates the legacy
   * abort-at-deadline behavior (the verify still runs once).
   * Env: `GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS`. Default: `2 × lockDuration`,
   * floored to the soft deadline (warn-once on floor).
   */
  hardEvictMs: number;
}

/**
 * Module-private warned-set so we stderr-once-per-process per bad env
 * value (codex outside-voice review wanted operator-friendly fallback,
 * not silent ignore). Tests reset via `_resetKnobWarningsForTests`.
 */
const _warnedKnobs = new Set<string>();

export function _resetKnobWarningsForTests(): void {
  _warnedKnobs.clear();
}

/**
 * Resolve the three lock-renewal knobs. Pure function over an env-like
 * record and the worker's configured lockDuration.
 *
 * Validation: each env var parsed as a positive integer; on bad input
 * (NaN, zero, negative, non-integer), emit a single stderr warning per
 * process per env-name and fall through to the default. This means an
 * operator who sets `GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS=abc` gets a
 * loud-but-not-fatal nudge AND a working worker.
 */
/**
 * The renewal cadence cap: a long lease renews every 60s (multiple chances
 * per window, matching the cycle refresher's philosophy) instead of the
 * bare lease/2. Leases ≤120s keep the legacy /2 exactly. ONE home for the
 * formula — the worker's timer and resolveLockRenewalKnobs' default both
 * derive from it, so the relational validation always runs against the
 * cadence production actually uses.
 */
export const RENEWAL_INTERVAL_CAP_MS = 60_000;

export function renewalIntervalFor(lockDurationMs: number): number {
  return Math.max(1, Math.min(Math.floor(lockDurationMs / 2), RENEWAL_INTERVAL_CAP_MS));
}

export function resolveLockRenewalKnobs(
  env: Record<string, string | undefined>,
  lockDurationMs: number,
  intervalMs: number = renewalIntervalFor(lockDurationMs),
): LockRenewalKnobs {
  const defaultMaxFailures = 3;
  // #4145: the derived defaults CAP at 15s/30s so a long per-job lease
  // (300s) doesn't inherit a 100s call timeout (which would wedge
  // tickInFlight across cadence windows) or a 50s margin. The 30s worker
  // default keeps today's 10s/5s exactly. Env overrides are still applied
  // first and then pass the relational validation below.
  const defaultCallTimeout = Math.min(Math.max(1, Math.floor(lockDurationMs / 3)), 15_000);
  const defaultSafetyMargin = Math.min(Math.max(1, Math.floor(lockDurationMs / 6)), 30_000);
  const defaultHardEvict = lockDurationMs * 2;

  const knobs: LockRenewalKnobs = {
    maxFailuresForAudit: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_MAX_FAILURES,
      defaultMaxFailures,
      'GBRAIN_LOCK_RENEWAL_MAX_FAILURES',
    ),
    callTimeoutMs: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS,
      defaultCallTimeout,
      'GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS',
    ),
    safetyMarginMs: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS,
      defaultSafetyMargin,
      'GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS',
    ),
    hardEvictMs: parsePositiveInt(
      env.GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS,
      defaultHardEvict,
      'GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS',
    ),
  };

  // [CDX-10] Relational validation: positive-integer parsing alone lets a
  // margin exceed the lease or a call timeout exceed the cadence, which
  // silently re-breaks the deadline math. Clamp the offending knob (to a
  // relationally-valid derivation) and warn once per process per knob.
  // Runs per job launch against the EFFECTIVE per-job lease.
  if (knobs.safetyMarginMs >= lockDurationMs / 2) {
    warnRelationalClamp(
      'GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS',
      `safetyMarginMs (${knobs.safetyMarginMs}) must be < lockDuration/2 (${lockDurationMs / 2})`,
      defaultSafetyMargin,
    );
    knobs.safetyMarginMs = defaultSafetyMargin;
  }
  if (knobs.callTimeoutMs > intervalMs) {
    warnRelationalClamp(
      'GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS',
      `callTimeoutMs (${knobs.callTimeoutMs}) must be <= the renewal cadence (${intervalMs}) or a slow call wedges tickInFlight across intervals`,
      intervalMs,
    );
    knobs.callTimeoutMs = intervalMs;
  }
  const softDeadline = lockDurationMs - knobs.safetyMarginMs;
  if (knobs.hardEvictMs < softDeadline) {
    warnRelationalClamp(
      'GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS',
      `hardEvictMs (${knobs.hardEvictMs}) must be >= the soft deadline (${softDeadline})`,
      softDeadline,
    );
    knobs.hardEvictMs = softDeadline;
  }
  return knobs;
}

function warnRelationalClamp(name: string, violation: string, clampedTo: number): void {
  const key = `relational:${name}`;
  if (!_warnedKnobs.has(key)) {
    _warnedKnobs.add(key);
    process.stderr.write(
      `[lock-renewal] ${violation}; clamping to ${clampedTo}\n`,
    );
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  // Reject obvious non-integers (`abc`, `1.5`, `1e9`) by requiring the
  // string to be all digits. `Number.parseInt` is too lenient — it
  // accepts `1.5` as `1` and `abc` as NaN.
  if (!/^\d+$/.test(raw.trim())) {
    return warnAndFallback(name, raw, fallback);
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return warnAndFallback(name, raw, fallback);
  }
  return n;
}

function warnAndFallback(name: string, raw: string, fallback: number): number {
  if (!_warnedKnobs.has(name)) {
    _warnedKnobs.add(name);
    process.stderr.write(
      `[lock-renewal] env ${name}=${JSON.stringify(raw)} is not a positive integer; falling back to default ${fallback}\n`,
    );
  }
  return fallback;
}

/**
 * Injected dependency surface. All I/O hooks routed through here so
 * `runLockRenewalTick` is pure and trivially testable.
 */
export interface LockRenewalDeps {
  /**
   * The fenced renewal UPDATE. The optional `opts.signal` is aborted when
   * this call loses the tick's timeout race (both attempts: primary AND the
   * #4145 at-deadline verify), so the underlying UPDATE is CANCELLED
   * (postgres.js `.cancel()` via executeRawDirect) instead of orphaned on a
   * checked-out pool slot for its full server-side duration — the #6
   * starvation class. Cancellation is BEST-EFFORT (pool acquisition and PG
   * protocol cancel are async; PGLite ignores the signal); the token FENCE
   * is the correctness authority. Optional-param widening keeps the legacy
   * 3-arg test mocks compiling.
   */
  renewLock: (
    jobId: number,
    lockToken: string,
    lockDurationMs: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<boolean>;
  audit: LockRenewalAuditSinkLike;
  /** Injectable for hermetic time-based tests. Production: `Date.now`. */
  now: () => number;
  /**
   * Injectable for hermetic Promise.race tests. Production:
   * `globalThis.setTimeout`. The function must return a value that
   * `clearTimeout` accepts: on the win path the race clears the losing
   * timer (via global clearTimeout) so it doesn't later fire a stray
   * no-op abort against a settled query. The losing renewLock is no
   * longer merely abandoned: the timeout callback also aborts the per-call
   * signal so the query releases its pool slot.
   */
  setTimeout: (cb: () => void, ms: number) => unknown;
  /**
   * issue #1678 (Codex #2): OPTIONAL pool rebuild. When a renewLock throw
   * looks like a reaped / nulled connection, the tick calls this ONCE
   * (bounded by callTimeoutMs) before returning `ok`, so the NEXT tick's
   * renewLock hits a live pool. This is deliberately NOT a `withRetry` around
   * renewLock — a background retry would outlive this tick's own timeout race
   * and could refresh a lock after the worker already gave it up (two holders).
   * Absent on engines without a pool (PGLite) and in the legacy tests; the
   * no-reconnect path behaves exactly as before.
   *
   * v0.42.12.0 (#1685 GAP B, CODEX impl review #2): accepts an optional ctx so
   * the tick can thread the triggering renewLock error. PostgresEngine.reconnect
   * classifies it — a CONNECTION_ENDED renewLock failure (the common pooler
   * idle-reap) is then audited as `reap_detected`, not `reconnect_other`, so
   * `pool_reap_health` actually fires for the #1678 incident pattern. The widened
   * (optional-param) signature stays back-compatible with no-arg test mocks.
   */
  reconnect?: (ctx?: { error?: unknown }) => Promise<void>;
  /**
   * OPTIONAL host-load probe for eviction telemetry (issue #4145 req 3).
   * The worker binds `os.loadavg()[0]` + a cached core count. Every call
   * is wrapped in try/catch here (CEO-F2) — a throwing telemetry hook
   * must never re-open the unhandledRejection class this module exists
   * to close; on throw the event simply logs without load fields.
   */
  loadSnapshot?: () => { load1: number; cores: number };
  /**
   * OPTIONAL success hook. The worker resets its event-loop-delay
   * histogram here (R2-9) so an eviction-time sample attributes to the
   * window since the LAST SUCCESSFUL renewal, not process lifetime.
   * Best-effort: called inside try/catch.
   */
  onRenewalSuccess?: () => void;
}

/**
 * Minimal subset of `LockRenewalAuditSink` from
 * `src/core/audit/lock-renewal-audit.ts` so this module doesn't have to
 * import the full audit module and inflate the test surface.
 */
export interface LockRenewalAuditSinkLike {
  // The trailing `ctx` is optional and additive (ENG-E2): pre-existing
  // test fakes with the old arity stay structurally assignable.
  logFailure(jobId: number, jobName: string, attempt: number, err: unknown, ctx?: LockRenewalTelemetryCtx): void;
  logSuccessAfterFailure(jobId: number, jobName: string, recoveredAfterAttempts: number, ctx?: LockRenewalTelemetryCtx): void;
  logGaveUp(jobId: number, jobName: string, totalFailures: number, err: unknown, ctx?: LockRenewalTelemetryCtx): void;
}

export interface LockRenewalState {
  jobId: number;
  jobName: string;
  lockToken: string;
  lockDurationMs: number;
  knobs: LockRenewalKnobs;
  /** Updated to `deps.now()` on every successful renewal. */
  lastSuccessfulRenewalAt: number;
  /** Bumped on each renewLock throw; reset to 0 on success. Audit-only. */
  consecutiveFailures: number;
  /**
   * Closure thunk reading the timer's `cancelled` flag in worker.ts.
   * Returns `true` once `executeJob.finally` has run. The tick checks
   * this at entry, after the await resolves, AND after the await
   * throws — three guards because a long await can outlive both the
   * cancellation event AND the post-await branch decisions.
   */
  cancelled: () => boolean;
  /**
   * The renewal timer's cadence (ms) — the SAME value the worker gave
   * setInterval. Used for tick-lateness telemetry (below) and the
   * cadence-aware verify trigger.
   */
  intervalMs: number;
  /**
   * Timestamp of the previous tick's entry, on the SAME clock as
   * `deps.now` (production binds a monotonic source; R2-4). Seeded to
   * launch time. Lateness = max(0, now - lastTickFiredAt - intervalMs)
   * is the PRIMARY local-starvation signal: interval callbacks COALESCE
   * under a blocked event loop (one late callback, not N), so a
   * missed-tick counter cannot measure starvation — lateness can.
   */
  lastTickFiredAt: number;
  /**
   * Count of interval callbacks skipped by the worker's tickInFlight
   * re-entrancy guard. These are OVERLAP skips (a prior tick still in
   * flight), NOT missed intervals — see lastTickFiredAt. Incremented by
   * the worker's interval closure; read here for telemetry.
   */
  overlapSkips: number;
}

export type TickResult =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'lock_lost'; cause: 'fenced-lost'; via: 'renewal' | 'verify' }
  | {
      kind: 'should_abort';
      reason: 'lock-renewal-failed';
      /** What the FINAL failed attempt looked like (R2-7 telemetry). */
      cause: RenewalFailureCause;
      latenessMs: number;
      sinceLastSuccessMs: number;
      overlapSkips: number;
      load1?: number;
      cores?: number;
    };

/**
 * Execute one renewal tick. Returns a tagged result the worker switches
 * on; the worker is responsible for the `abort.abort()` / `clearInterval`
 * side effects that depend on its closure scope.
 */
export async function runLockRenewalTick(
  deps: LockRenewalDeps,
  state: LockRenewalState,
): Promise<TickResult> {
  // Tick-lateness telemetry (CDX-13): how late did this callback fire vs
  // its own cadence? Computed FIRST — even a cancelled tick advances the
  // baseline so the next measurement stays honest.
  const tickEnteredAt = deps.now();
  const latenessMs = Math.max(0, tickEnteredAt - state.lastTickFiredAt - state.intervalMs);
  state.lastTickFiredAt = tickEnteredAt;

  if (state.cancelled()) return { kind: 'cancelled' };

  let renewed: boolean;
  try {
    renewed = await racedRenewLock(deps, state);
  } catch (err) {
    if (state.cancelled()) return { kind: 'cancelled' };
    state.consecutiveFailures += 1;
    const cause = classifyFailure(err);
    const load = safeLoadSnapshot(deps);
    const telemetry: LockRenewalTelemetryCtx = {
      cause,
      lateness_ms: latenessMs,
      overlap_skips: state.overlapSkips,
      ...load,
    };
    // Defense-in-depth (codex C4): audit must never escape this catch.
    try {
      deps.audit.logFailure(state.jobId, state.jobName, state.consecutiveFailures, err, telemetry);
    } catch { /* audit best-effort */ }

    const sinceLastSuccess = deps.now() - state.lastSuccessfulRenewalAt;
    const deadline = state.lockDurationMs - state.knobs.safetyMarginMs;

    // [CDX-4] Cadence-aware trigger: run the at-deadline VERIFY when the
    // NEXT tick would land past the soft deadline — `>= deadline` alone is
    // unreachable under cadence quantization (a 300s lease with a 60s
    // cadence has no tick between 240s and expiry; the first eligible tick
    // would already be past the lease).
    if (sinceLastSuccess + state.intervalMs < deadline) {
      // Not near the deadline: retry on the next tick.
      // issue #1678 (Codex #2): if the engine can rebuild its pool, do it
      // ONCE now (bounded) so the next renewLock sees a live connection.
      await attemptReconnectOnce(deps, state, err);
      if (state.cancelled()) return { kind: 'cancelled' };
      return { kind: 'ok' }; // counter incremented; not yet at deadline
    }

    // ── At the deadline: VERIFY before evicting (#4145) ──────────────────
    // The throw above is NOT evidence of loss (db-lock.ts doctrine:
    // fenced-false = certain, throw = transient). Under event-loop
    // starvation the renewal may even have LANDED server-side while our
    // local race timeout won. renewLock is fenced on lock_token and does
    // NOT check lock_until, so an expired-but-unstolen lease renews fine —
    // ask the DB the authoritative question.
    //
    // Reconciling with queue.ts's "renewLock is deliberately not
    // retry-wrapped" rationale (two-holders risk): that comment forbids
    // BACKGROUND retries that outlive this tick's own timeout race. This
    // verify is a synchronous, cancelled()-guarded, callTimeoutMs-bounded
    // call INSIDE the tick's flow, and both UPDATEs are same-token
    // idempotent lease extensions — a fenced row cannot gain two holders.
    let verified: boolean | null = null; // null = the verify itself threw
    let verifyErr: unknown = null;
    try {
      verified = await racedRenewLock(deps, state);
    } catch (vErr) {
      verifyErr = vErr;
    }
    if (state.cancelled()) return { kind: 'cancelled' };

    if (verified === true) {
      // Starved-but-ours: the lease is re-extended; the incident-saving path.
      try {
        deps.audit.logSuccessAfterFailure(
          state.jobId, state.jobName, state.consecutiveFailures, { via: 'verify' },
        );
      } catch { /* audit best-effort */ }
      state.consecutiveFailures = 0;
      state.lastSuccessfulRenewalAt = deps.now();
      try { deps.onRenewalSuccess?.(); } catch { /* telemetry best-effort */ }
      return { kind: 'ok' };
    }

    if (verified === false) {
      // Fenced miss: CERTAIN loss (stall sweep reclaimed / pauseJob).
      return { kind: 'lock_lost', cause: 'fenced-lost', via: 'verify' };
    }

    // The verify was unreachable too — that is a second failed attempt.
    // NOTE for audit readers: at the deadline `attempt` advances by 2 per
    // tick (primary + verify) — the counter counts ATTEMPTS, not ticks.
    state.consecutiveFailures += 1;
    const verifyCause = classifyFailure(verifyErr);
    // Re-sample load: the bounded verify can consume up to callTimeoutMs,
    // and the verify-failure event should carry the load at ITS failure,
    // not a snapshot stale by the verify's whole duration.
    const verifyLoad = safeLoadSnapshot(deps);
    const verifyTelemetry: LockRenewalTelemetryCtx = {
      cause: verifyCause,
      lateness_ms: latenessMs,
      overlap_skips: state.overlapSkips,
      ...verifyLoad,
    };

    // Recompute elapsed AFTER the verify: the bounded verify itself can
    // consume up to callTimeoutMs, and comparing the stale pre-verify value
    // would defer one extra cadence past the advertised backstop.
    const sinceLastSuccessAfterVerify = deps.now() - state.lastSuccessfulRenewalAt;
    if (sinceLastSuccessAfterVerify >= state.knobs.hardEvictMs) {
      // Hard backstop: a LOCAL decision under uncertainty, by design —
      // bounds how long non-fenced external side effects run blind during
      // a total outage. DB writes stay split-brain-safe via the fence.
      try {
        deps.audit.logGaveUp(
          state.jobId, state.jobName, state.consecutiveFailures, verifyErr ?? err, verifyTelemetry,
        );
      } catch { /* audit best-effort */ }
      return {
        kind: 'should_abort',
        reason: 'lock-renewal-failed',
        cause: verifyCause,
        latenessMs,
        sinceLastSuccessMs: sinceLastSuccessAfterVerify,
        overlapSkips: state.overlapSkips,
        ...verifyLoad,
      };
    }

    // Deferred past the soft deadline: keep the job and retry next tick —
    // the fence is the correctness backstop (a reclaim surfaces as a
    // fenced-false on the next attempt; no attempt is burned). CEO-F3:
    // give the next tick a live pool.
    try {
      deps.audit.logFailure(
        state.jobId, state.jobName, state.consecutiveFailures, verifyErr ?? err,
        { ...verifyTelemetry, deadline_deferred: true },
      );
    } catch { /* audit best-effort */ }
    await attemptReconnectOnce(deps, state, verifyErr ?? err);
    if (state.cancelled()) return { kind: 'cancelled' };
    return { kind: 'ok' };
  }

  if (state.cancelled()) return { kind: 'cancelled' };
  if (!renewed) {
    // Token-fence failure: another worker reclaimed the row, or pauseJob
    // cleared the token. NOT an infrastructure fault — no audit event
    // (audit channel is for infrastructure faults only). The worker
    // observes `lock_lost` and stderr-warns + aborts. This is the ONLY
    // CERTAIN loss signal (exactly 0 rows matched the fence).
    return { kind: 'lock_lost', cause: 'fenced-lost', via: 'renewal' };
  }

  if (state.consecutiveFailures > 0) {
    try {
      deps.audit.logSuccessAfterFailure(
        state.jobId,
        state.jobName,
        state.consecutiveFailures,
        { via: 'renewal' },
      );
    } catch { /* audit best-effort */ }
    state.consecutiveFailures = 0;
  }
  state.lastSuccessfulRenewalAt = deps.now();
  // R2-9: let the worker reset its event-loop-delay histogram so the next
  // eviction-time sample attributes to the window since THIS success.
  try { deps.onRenewalSuccess?.(); } catch { /* telemetry best-effort */ }
  return { kind: 'ok' };
}

/**
 * CEO-F2: telemetry must never throw into the tick's control flow — a
 * throwing loadavg probe re-opening the unhandledRejection class would
 * be a bitter irony. On throw, the event logs without load fields.
 */
function safeLoadSnapshot(deps: LockRenewalDeps): { load1?: number; cores?: number } {
  try {
    const s = deps.loadSnapshot?.();
    return s ? { load1: s.load1, cores: s.cores } : {};
  } catch {
    return {};
  }
}

/**
 * One bounded renewal attempt: renewLock raced against callTimeoutMs.
 * When the timeout wins the race it also ABORTS the per-call signal so the
 * losing UPDATE releases its pool slot instead of holding it until the
 * server finishes (issue #6 — an abandoned racer under a saturated pooler
 * pinned a checked-out connection for minutes). On the win path the
 * late-firing timer aborts an already-settled query, which runUnsafe
 * ignores (abort listener removed in its .finally). Cancellation is
 * BEST-EFFORT (CDX-2/R2-2 — the fence is the correctness authority; PGLite
 * ignores the signal and resolves via the race alone). The race attaches
 * handlers to both contenders, so a late loser settlement is absorbed,
 * never an unhandledRejection.
 */
function racedRenewLock(deps: LockRenewalDeps, state: LockRenewalState): Promise<boolean> {
  const controller = new AbortController();
  let timer: unknown;
  return Promise.race([
    deps.renewLock(state.jobId, state.lockToken, state.lockDurationMs, { signal: controller.signal }),
    new Promise<never>((_, reject) => {
      timer = deps.setTimeout(() => {
        try { controller.abort(); } catch { /* best-effort */ }
        reject(new RenewalCallTimeoutError('renewLock', state.knobs.callTimeoutMs));
      }, state.knobs.callTimeoutMs);
    }),
  ]).finally(() => {
    // Win-path hygiene: clear the losing timer so it can't fire a stray
    // late abort at a settled query (absorbed by runUnsafe, but noisy).
    // Test fakes may return null from the seam; clearTimeout(null) is a
    // harmless no-op.
    try { clearTimeout(timer as ReturnType<typeof setTimeout>); } catch { /* best-effort */ }
  }) as Promise<boolean>;
}

function classifyFailure(err: unknown): RenewalFailureCause {
  return err instanceof Error && err.name === 'RenewalCallTimeoutError' ? 'call-timeout' : 'refused';
}

/**
 * issue #1678 (Codex #2): bounded, best-effort, ONCE-per-tick pool rebuild
 * so the NEXT renewal attempt sees a live connection instead of throwing
 * the same reaped-socket error. Threads the triggering error so the engine
 * can classify a CONNECTION_ENDED pooler reap as `reap_detected`. A
 * reconnect throw/timeout is swallowed — it must NEVER escape into the
 * tick's catch (the unhandledRejection class this module exists to close).
 */
async function attemptReconnectOnce(
  deps: LockRenewalDeps,
  state: LockRenewalState,
  err: unknown,
): Promise<void> {
  if (!deps.reconnect) return;
  const reconnect = deps.reconnect;
  let timer: unknown;
  try {
    await Promise.race([
      reconnect({ error: err }),
      new Promise<never>((_, reject) => {
        timer = deps.setTimeout(
          () => reject(new Error(`reconnect timed out after ${state.knobs.callTimeoutMs}ms`)),
          state.knobs.callTimeoutMs,
        );
      }),
    ]);
  } catch { /* reconnect best-effort; next tick retries against a fresh attempt */
  } finally {
    try { clearTimeout(timer as ReturnType<typeof setTimeout>); } catch { /* best-effort */ }
  }
}
