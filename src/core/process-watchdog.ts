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
  const deadlineMs = Math.floor(opts.deadlineMs);
  const graceMs = Math.max(0, Math.floor(opts.graceMs ?? DEFAULT_GRACE_MS));
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
