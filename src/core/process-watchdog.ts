/**
 * Out-of-band hard-deadline watchdog (#1633).
 *
 * THE PROBLEM. A `gbrain sync` that spins (e.g. synchronous catastrophic-regex
 * in pack link-inference) STARVES the main event loop. When the loop never
 * yields, the SIGTERM handler (process-cleanup.ts) can't run, a `--timeout`
 * `setTimeout` can't fire, and the abort-flag checks between import iterations
 * can't run either. The process becomes unkillable-by-SIGTERM and, under cron,
 * orphans pile up for 24h+ (the reported incident). The ONLY thing that kills a
 * loop-starved process is an OS signal delivered from OUTSIDE that loop.
 *
 * THE MECHANISM. A Bun `worker_threads` Worker runs on a real, independent OS
 * thread with its own event loop. Its timer fires even while the main thread is
 * in an unyielding synchronous loop. At the deadline it sends SIGTERM to its own
 * process (a clean-shutdown chance if the loop happens to be responsive); at
 * deadline+grace it sends SIGKILL (uncatchable — guaranteed death even when
 * starved). Signaling SELF (`process.kill(process.pid, ...)`) has no PID-reuse
 * footgun: the current process's PID is never reused while it's alive. (The
 * rejected alternative — a detached child that signals the PARENT pid — CAN hit
 * PID reuse and kill an innocent process.)
 *
 * `eval: true` keeps the worker body an inline string so it bakes into the
 * `bun build --compile` binary with no separate-file embedding to worry about.
 * Empirically validated on Bun 1.3.13 (a Worker timer fired + SIGKILLed the
 * process while main was in `while(true){}`).
 *
 *   ┌─ main thread (may be starved) ──────────────┐   ┌─ watchdog worker (OS thread) ─┐
 *   │ sync work / ReDoS spin / connect hang        │   │ t=deadline      -> SIGTERM     │
 *   │   ...never yields...                          │   │ t=deadline+grace-> SIGKILL     │
 *   │ on clean finish: handle.dispose()  ──────────┼──▶│   worker.terminate()           │
 *   └──────────────────────────────────────────────┘   └────────────────────────────────┘
 *
 * Reusable beyond sync (autopilot / cycle are follow-up adopters): the API is
 * just (deadline, grace, label).
 */

import { Worker } from 'node:worker_threads';
// Zero-import teardown-budget leaf — safe edge, no cycle (it imports nothing).
import { MAX_TIMER_DELAY_MS } from './background-work.ts';

export type WatchdogAction = 'wait' | 'sigterm' | 'sigkill';

/**
 * Pure decision function — the watchdog's whole state machine, extracted so it's
 * unit-testable without spawning threads or real timers.
 *   elapsed < deadline            -> 'wait'
 *   deadline <= elapsed < +grace  -> 'sigterm' (clean-shutdown chance)
 *   elapsed >= deadline + grace   -> 'sigkill' (guaranteed)
 */
export function watchdogDecision(elapsedMs: number, deadlineMs: number, graceMs: number): WatchdogAction {
  if (elapsedMs >= deadlineMs + graceMs) return 'sigkill';
  if (elapsedMs >= deadlineMs) return 'sigterm';
  return 'wait';
}

export interface ProcessWatchdogOpts {
  /** Wall-clock ms after which SIGTERM is sent. Must be > 0 or the watchdog is a no-op. */
  deadlineMs: number;
  /** ms after the deadline before SIGKILL. Default 30_000. */
  graceMs?: number;
  /** Prefix for stderr log lines, e.g. 'sync-watchdog'. Default 'watchdog'. */
  label?: string;
  /** Periodic "still alive, kill in Ns" heartbeat interval ms. 0 = off (default). */
  heartbeatMs?: number;
  /** Injectable warn sink (tests). Default writes to process.stderr. */
  onWarn?: (msg: string) => void;
}

export interface WatchdogHandle {
  /** Tear down the watchdog (clean completion). Idempotent. */
  dispose(): void;
  /** True when an out-of-band worker is actually running (false on no-op / fallback). */
  readonly active: boolean;
}

const DEFAULT_GRACE_MS = 30_000;

/**
 * setTimeout delay ceiling (2^31−1): Node/Bun overflow-clamp larger delays to
 * ~1ms, which for the deadline+grace SUM timer would mean SIGKILLing a healthy
 * process almost immediately (#4284 hardening). Aliased from the shared
 * teardown-budget constant so the ceiling cannot drift between modules.
 */
export const MAX_WATCHDOG_TIMER_MS = MAX_TIMER_DELAY_MS;

/**
 * Pure clamp for the two worker timers (#4284). The worker arms
 * setTimeout(deadlineMs) AND setTimeout(deadlineMs + graceMs); BOTH delays
 * must stay ≤ 2^31−1 or the overflowing one fires at ~1ms — for the sum
 * timer that is an instant SIGKILL. Grace is clamped so the SUM fits, and a
 * NON-FINITE grace is coerced to 0 (never NaN: setTimeout(deadline + NaN)
 * fires at ~1ms — the exact failure this clamp exists to prevent). NaN
 * deadline flows through as NaN so the caller's Number.isFinite inert-check
 * still catches it; an INFINITE deadline clamps to the ceiling and ARMS
 * (~24.8 days) rather than going inert — deliberate, matching the "oversized
 * means longer bound" rule. Exported pure so unit tests verify the arithmetic
 * without ever arming a real max-deadline worker in-suite (whose buggy
 * overflow would SIGTERM the test runner itself).
 */
export function clampWatchdogTimers(deadlineMs: number, graceMs: number): { deadlineMs: number; graceMs: number } {
  const d = Math.min(MAX_WATCHDOG_TIMER_MS, Math.floor(deadlineMs));
  const safeGrace = Number.isFinite(graceMs) ? Math.max(0, Math.floor(graceMs)) : 0;
  const g = Math.min(MAX_WATCHDOG_TIMER_MS - (Number.isFinite(d) ? Math.max(0, d) : 0), safeGrace);
  return { deadlineMs: d, graceMs: g };
}

function defaultWarn(msg: string): void {
  try { process.stderr.write(msg + '\n'); } catch { /* stderr may be broken */ }
}

const INERT: WatchdogHandle = { dispose() {}, get active() { return false; } };

/**
 * Worker body (runs on its own OS thread). Inline string so `eval: true` bakes
 * it into the compiled binary. Uses only built-ins available in a Bun worker.
 *
 * `label` is validated by the caller to a safe charset before it reaches here,
 * so it can't break the string literal or inject log lines.
 */
const WORKER_SRC = `
const { workerData } = require('node:worker_threads');
const { deadlineMs, graceMs, label, heartbeatMs } = workerData;
const t0 = Date.now();
function w(m) { try { process.stderr.write('[' + label + '] ' + m + '\\n'); } catch (e) {} }
if (heartbeatMs > 0) {
  const hb = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const killIn = Math.round((deadlineMs + graceMs - (Date.now() - t0)) / 1000);
    w('parent alive ' + elapsed + 's elapsed, hard-kill in ~' + killIn + 's');
  }, heartbeatMs);
  if (typeof hb.unref === 'function') hb.unref();
}
setTimeout(() => {
  w('deadline reached (' + Math.round(deadlineMs/1000) + 's) — sending SIGTERM for graceful shutdown');
  try { process.kill(process.pid, 'SIGTERM'); } catch (e) {}
}, deadlineMs);
setTimeout(() => {
  w('grace expired — sending SIGKILL (event loop was starved; this is the orphan-pileup backstop)');
  try { process.kill(process.pid, 'SIGKILL'); } catch (e) {}
}, deadlineMs + graceMs);
`;

/**
 * Install the out-of-band hard-deadline watchdog. Returns a handle whose
 * `dispose()` MUST be called on clean completion (a `finally`) so the worker is
 * torn down. If the deadline is non-positive, returns an inert no-op handle.
 *
 * Fallback: if the Worker can't be constructed (unexpected on Bun), degrades to
 * an in-process timer with a loud warning. The in-process timer canNOT fire
 * under event-loop starvation — it only covers the responsive case — so the
 * warning tells the operator the hard guarantee is degraded.
 */
export function installProcessWatchdog(opts: ProcessWatchdogOpts): WatchdogHandle {
  const warn = opts.onWarn ?? defaultWarn;
  const { deadlineMs, graceMs } = clampWatchdogTimers(opts.deadlineMs, opts.graceMs ?? DEFAULT_GRACE_MS);
  // Sanitize label to a safe charset (defends the inline worker string + log lines).
  const label = (opts.label ?? 'watchdog').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) || 'watchdog';
  const heartbeatMs = Math.max(0, Math.floor(opts.heartbeatMs ?? 0));

  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return INERT;

  try {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { deadlineMs, graceMs, label, heartbeatMs },
    });
    // Don't let the watchdog keep the process alive past clean completion.
    (worker as unknown as { unref?: () => void }).unref?.();
    // A worker-side error must never crash the host; log and move on.
    worker.on('error', (err) => warn(`[${label}] watchdog worker error: ${err instanceof Error ? err.message : String(err)}`));
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        void worker.terminate();
      },
      get active() { return !disposed; },
    };
  } catch (err) {
    // Fallback: in-process timer. Starvation-vulnerable — say so loudly.
    warn(
      `[${label}] could not start out-of-band watchdog (${err instanceof Error ? err.message : String(err)}); ` +
      `falling back to an in-process timer that will NOT fire if the event loop is starved.`,
    );
    let killed = false;
    const term = setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch { /* */ } }, deadlineMs);
    const kill = setTimeout(() => { killed = true; try { process.kill(process.pid, 'SIGKILL'); } catch { /* */ } }, deadlineMs + graceMs);
    (term as unknown as { unref?: () => void }).unref?.();
    (kill as unknown as { unref?: () => void }).unref?.();
    let disposed = false;
    return {
      dispose() {
        if (disposed || killed) return;
        disposed = true;
        clearTimeout(term);
        clearTimeout(kill);
      },
      get active() { return !disposed; },
    };
  }
}

/* ————————————————————————————————————————————————————————————————————————
 * Loop-STALL watchdog (#4281).
 *
 * The hard-deadline watchdog above bounds TOTAL wall-clock time — right for a
 * bounded batch (`sync`), wrong for a long-lived server whose legitimate
 * lifetime is unbounded. What a server needs bounded is main-loop
 * RESPONSIVENESS: `gbrain serve --http` wedged in a synchronous spin (ReDoS,
 * runaway parse) stops answering requests AND stops being able to run its own
 * SIGTERM cleanup, holding the PGLite write lock hostage exactly like the
 * #1633 sync incident.
 *
 * Mechanism: the main thread "pets" a worker_threads Worker via postMessage on
 * a short interval. The worker (independent OS thread, own event loop) tracks
 * lag = now − lastPet. lag ≥ stall → SIGTERM once (latched: the graceful path
 * gets exactly one chance PER STALL); lag ≥ stall+grace → SIGKILL (uncatchable
 * — the starved-loop backstop). A loop that recovers after the SIGTERM resumes
 * petting, lag collapses, the SIGKILL never fires, and the latch RESETS — a
 * later, separate stall starts the escalation over from SIGTERM. The
 * escalation only completes while the loop is STILL starved.
 *
 * Suspend forgiveness: across a system sleep (laptop lid) BOTH threads stop,
 * so on wake the worker would see a huge lag on a perfectly healthy process.
 * The worker detects that its own check cadence gapped (it was suspended too)
 * and forgives — a fresh full stall window is required post-wake.
 * ———————————————————————————————————————————————————————————————————————— */

/** Env knob for `gbrain serve --http` (opt-in; ms; 0/unset = off).
 * Large PGLite brains routinely hold the loop synchronously for tens of
 * seconds (WASM checkpoint, vacuum, big JSON parse) — prefer a value well
 * above the floor there (e.g. 60000+) so legitimate pauses never SIGTERM a
 * healthy server. */
export const SERVE_STALL_WATCHDOG_ENV = 'GBRAIN_SERVE_STALL_WATCHDOG_MS';

/**
 * Floor for the env-configured stall threshold. A legitimate serve pauses the
 * loop for whole seconds under heavy synchronous work (large JSON parse, WASM
 * checkpoint); a sub-15s threshold would let a well-meant operator value turn
 * the watchdog into a hair-trigger that SIGTERMs healthy servers.
 */
export const SERVE_STALL_FLOOR_MS = 15_000;

/** Default lag beyond the stall threshold before SIGKILL (plan #4281: 30s). */
export const STALL_DEFAULT_GRACE_MS = 30_000;

/**
 * Pure decision function for the stall watchdog — mirrors the worker's inline
 * logic exactly (same reason watchdogDecision exists: unit-testable without
 * threads or timers). `latched` = "SIGTERM already sent for the CURRENT
 * stall" (see nextStallLatch — recovery resets it).
 *   lag >= stall+grace          -> 'sigkill' (regardless of latch)
 *   lag >= stall and !latched   -> 'sigterm' (caller latches)
 *   otherwise                   -> 'wait' (includes the recovered-loop case:
 *                                  latched but lag back below stall — a
 *                                  petting process is never killed)
 */
export function stallDecision(lagMs: number, stallMs: number, graceMs: number, latched: boolean): WatchdogAction {
  if (lagMs >= stallMs + graceMs) return 'sigkill';
  if (lagMs >= stallMs && !latched) return 'sigterm';
  return 'wait';
}

/**
 * Pure latch-transition companion to stallDecision (mirrored in the worker —
 * keep them in lockstep). The latch arms when SIGTERM fires and RESETS when
 * lag recovers below the stall threshold: a process that recovered (pets
 * resumed) and later re-stalls is a NEW stall, so it gets a fresh graceful
 * SIGTERM chance before the SIGKILL escalation instead of skipping straight
 * to SIGKILL on the second stall of its lifetime.
 */
export function nextStallLatch(action: WatchdogAction, lagMs: number, stallMs: number, latched: boolean): boolean {
  if (action === 'sigterm') return true;
  if (lagMs < stallMs) return false;
  return latched;
}

/**
 * Pure suspend-detector, mirrored in the worker. If the gap between two
 * consecutive worker-side checks exceeds max(5× the check interval, 2s), the
 * WATCHDOG THREAD itself was stalled (system sleep / suspend / heavy VM
 * pause) — lag measured across that gap is not main-loop starvation and must
 * be forgiven, or every laptop-lid wake SIGKILLs a healthy serve.
 */
export function stallCheckSawSuspend(checkGapMs: number, checkIntervalMs: number): boolean {
  return checkGapMs > Math.max(5 * checkIntervalMs, 2000);
}

/**
 * Resolve GBRAIN_SERVE_STALL_WATCHDOG_MS to a stall threshold in ms.
 * Returns 0 for "off". Lenient (warn + off) rather than throw, matching the
 * boot-timeout env posture in serve.ts: a typo'd escape hatch must never
 * become a process-killer of its own.
 *   unset / blank -> 0, silent (the knob is opt-in)
 *   '0'           -> 0, silent (documented explicit off)
 *   garbage (NaN / negative / non-finite) -> warn + 0
 *   (0, floor)    -> warn + clamp UP to SERVE_STALL_FLOOR_MS
 *   >= floor      -> floor'd integer
 */
export function resolveServeStallWatchdogMs(
  raw: string | undefined,
  warn: (msg: string) => void = defaultWarn,
): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warn(
      `[serve-stall-watchdog] ignoring invalid ${SERVE_STALL_WATCHDOG_ENV}=${JSON.stringify(raw)} — ` +
      `watchdog stays OFF (set a positive integer of milliseconds; floor ${SERVE_STALL_FLOOR_MS}ms, 0 disables)`,
    );
    return 0;
  }
  if (n === 0) return 0;
  if (n < SERVE_STALL_FLOOR_MS) {
    warn(
      `[serve-stall-watchdog] ${SERVE_STALL_WATCHDOG_ENV}=${raw} is below the ${SERVE_STALL_FLOOR_MS}ms floor — ` +
      `clamping up to ${SERVE_STALL_FLOOR_MS}ms (sub-floor thresholds hair-trigger on legitimate synchronous work)`,
    );
    return SERVE_STALL_FLOOR_MS;
  }
  return Math.floor(n);
}

export interface LoopStallWatchdogOpts {
  /** Main-loop lag (ms since last pet) at which SIGTERM fires. Must be > 0 or the handle is inert. */
  stallMs: number;
  /** Additional lag beyond stallMs before SIGKILL. Default STALL_DEFAULT_GRACE_MS (30s). */
  graceMs?: number;
  /** Prefix for stderr log lines. Default 'stall-watchdog'. */
  label?: string;
  /** Pet cadence on the main thread. Default min(1s, stallMs/4); clamped ≤ stallMs/3. */
  petIntervalMs?: number;
  /** Worker-side lag-check cadence. Same default/clamp as petIntervalMs. */
  checkIntervalMs?: number;
  /** Injectable warn sink (tests). Default writes to process.stderr. */
  onWarn?: (msg: string) => void;
}

/**
 * Worker body for the stall watchdog (own OS thread; inline string so
 * `eval: true` bakes into the compiled binary, same as WORKER_SRC). Logic
 * mirrors stallDecision + nextStallLatch + stallCheckSawSuspend — keep them
 * in lockstep.
 * The check interval is deliberately NOT unref'd: it (with the parentPort
 * listener) keeps the worker alive; the MAIN thread unrefs the worker itself
 * so the watchdog never holds the host process open.
 */
const STALL_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { stallMs, graceMs, label, checkIntervalMs } = workerData;
let lastPet = Date.now();
let lastCheck = Date.now();
let latched = false;
function w(m) { try { process.stderr.write('[' + label + '] ' + m + '\\n'); } catch (e) {} }
if (parentPort) parentPort.on('message', () => { lastPet = Date.now(); });
setInterval(() => {
  const now = Date.now();
  const checkGap = now - lastCheck;
  lastCheck = now;
  if (checkGap > Math.max(5 * checkIntervalMs, 2000)) {
    // mirrors stallCheckSawSuspend: the watchdog thread itself just stalled
    // (system sleep / suspend) — forgive; require a fresh stall window.
    lastPet = now;
    return;
  }
  const lag = now - lastPet;
  if (lag >= stallMs + graceMs) {
    w('main loop unresponsive for ' + Math.round(lag / 1000) + 's (stall ' + Math.round(stallMs / 1000) + 's + grace ' + Math.round(graceMs / 1000) + 's) — sending SIGKILL (loop starved through the grace window; orphan-lock backstop)');
    try { process.kill(process.pid, 'SIGKILL'); } catch (e) {}
  } else if (lag >= stallMs && !latched) {
    latched = true;
    w('main loop unresponsive for ' + Math.round(lag / 1000) + 's (>= ' + Math.round(stallMs / 1000) + 's stall threshold) — sending SIGTERM for graceful shutdown');
    try { process.kill(process.pid, 'SIGTERM'); } catch (e) {}
  } else if (latched && lag < stallMs) {
    // mirrors nextStallLatch: the loop recovered (pets resumed), so a later
    // re-stall is a NEW stall — re-arm the graceful SIGTERM rather than
    // skipping straight to SIGKILL on the second stall of this lifetime.
    latched = false;
    w('main loop recovered — re-arming graceful SIGTERM for any future stall');
  }
}, checkIntervalMs);
`;

/**
 * Install the loop-stall watchdog. Returns a handle whose `dispose()` MUST be
 * called on clean completion (a `finally`) so the worker + pet interval are
 * torn down. Inert no-op handle when stallMs is non-positive / non-finite.
 *
 * No in-process fallback exists for this watchdog: an in-process timer cannot
 * observe its own loop's starvation (it fires late or never — exactly the
 * failure being guarded). If the Worker can't be constructed we warn loudly
 * and return an inert handle.
 */
export function installLoopStallWatchdog(opts: LoopStallWatchdogOpts): WatchdogHandle {
  const warn = opts.onWarn ?? defaultWarn;
  const stallMs = Number.isFinite(opts.stallMs) ? Math.floor(opts.stallMs) : Number.NaN;
  if (!Number.isFinite(stallMs) || stallMs <= 0) return INERT;

  // Non-finite grace coerces to the DEFAULT (not 0): grace only feeds lag
  // comparisons here (no setTimeout arming, so no #4284 overflow class), and
  // a NaN comparison would silently disable the SIGKILL escalation forever.
  const rawGrace = opts.graceMs ?? STALL_DEFAULT_GRACE_MS;
  const graceMs = Number.isFinite(rawGrace) ? Math.max(0, Math.floor(rawGrace)) : STALL_DEFAULT_GRACE_MS;

  // Sanitize label to a safe charset (defends the inline worker string + log lines).
  const label = (opts.label ?? 'stall-watchdog').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) || 'stall-watchdog';

  // Cadences must sit well below the stall threshold or every check would see
  // a false "lag": clamp both to ≤ stallMs/3 (floor 10ms).
  const maxCadence = Math.max(10, Math.floor(stallMs / 3));
  const petIntervalMs = Math.min(maxCadence, Math.max(10, Math.floor(opts.petIntervalMs ?? Math.min(1000, stallMs / 4))));
  const checkIntervalMs = Math.min(maxCadence, Math.max(10, Math.floor(opts.checkIntervalMs ?? Math.min(1000, stallMs / 4))));

  try {
    const worker = new Worker(STALL_WORKER_SRC, {
      eval: true,
      workerData: { stallMs, graceMs, label, checkIntervalMs },
    });
    // Don't let the watchdog keep the process alive past clean completion.
    (worker as unknown as { unref?: () => void }).unref?.();
    // A worker-side error must never crash the host; log and move on.
    worker.on('error', (err) => warn(`[${label}] stall-watchdog worker error: ${err instanceof Error ? err.message : String(err)}`));
    // The pet: proof-of-life from the main event loop. postMessage after
    // terminate is a no-op in worker_threads, but guard anyway.
    const pet = setInterval(() => { try { worker.postMessage(1); } catch { /* worker gone */ } }, petIntervalMs);
    (pet as unknown as { unref?: () => void }).unref?.();
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        clearInterval(pet);
        void worker.terminate();
      },
      get active() { return !disposed; },
    };
  } catch (err) {
    warn(
      `[${label}] could not start loop-stall watchdog (${err instanceof Error ? err.message : String(err)}); ` +
      `running WITHOUT a stall backstop — an in-process fallback cannot observe its own starved loop.`,
    );
    return INERT;
  }
}
