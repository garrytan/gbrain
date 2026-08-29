/**
 * One-shot CLI exit + teardown contract (#2084, supersedes the narrower
 * v0.41.8.0 drain-timeout-only force-exit).
 *
 * The CLI must never rely on Bun's event loop draining to exit: on PgBouncer
 * transaction-mode, `endPoolBounded` (db.ts) deliberately races PAST a stuck
 * `pool.end()`, so the promise resolves while the stuck sockets stay open and
 * keep the loop alive (#2084's flat 10s teardown tax). Per the doctrine in
 * timeout.ts, `process.exit` is the real resource-release mechanism for
 * one-shot commands — the kernel reclaims sockets.
 *
 * The contract is a PAIR (documented together in KEY_FILES.md):
 *
 *   op handler returns / throws (catch sets the verdict: setCliExitVerdict(1))
 *           │
 *           ▼  (per call site, in its finally — nine sites in cli.ts)
 *   finishCliTeardown({ engine, drainTimeoutMs? })   ← teardown ONLY, never exits*
 *           │
 *           ├─ arm ref'd backstop timer; deadline COMPUTED from the bounds
 *           │  it guards (sinks × drainTimeoutMs + facts-abort grace
 *           │  + 2 × pool-end bound + slack, floor 10s). The backstop fires
 *           │  ONLY if a component violated its own bound; on fire it prints
 *           │  a truthful banner and *flushThenExit(currentExitCode()).
 *           │  GBRAIN_TEARDOWN_DEADLINE_MS overrides (incident escape hatch).
 *           ▼
 *     drain background sinks (bounded per-sink; CLI-exit-only contract)
 *           ▼
 *     engine.disconnect()  — a throw is warned + swallowed: the exit code
 *           │                reports the OPERATION, not the cleanup
 *           ▼
 *     clear backstop, RETURN to caller
 *           │
 *           ▼  (exactly ONE place: cli.ts import.meta.main main().then/catch)
 *   shouldForceExitAfterMain() && flushThenExit(currentExitCode())
 *     — drain the serialized stdout tail if any interposed write is still in
 *       flight (#4383, ref'd keepalive), then fence stdout+stderr (write-fence
 *       raced with an unref'd guard, EPIPE-safe), hold a short REF'D aliveness
 *       grace for non-TTY stdio (Bun only delivers queued pipe writes while
 *       alive), then process.exit. Stuck sockets become irrelevant.
 *
 * The hard-deadline timer is armed at TEARDOWN start, never before the op
 * handler — a slow-but-healthy handler must not erode the teardown budget
 * (the pre-#2084 bug force-killed any >10s op mid-run with exit 0 and
 * truncated output).
 *
 * Daemons: `serve` is excluded at both layers — its command never reaches a
 * finishCliTeardown call site, and the central exit is gated by
 * `shouldForceExitAfterMain`. The helper itself has NO daemon flag: the drain
 * it runs is CLI-exit-only (it can permanently shut down process-level sinks),
 * so a long-lived process must simply never call it.
 *
 * This module stays importable without cli.ts side effects so tests can drive
 * every path directly (cli.ts is a script entrypoint).
 */

import { writeSync } from 'node:fs';
import { formatWithOptions } from 'node:util';
import {
  drainAllBackgroundWorkForCliExit,
  backgroundWorkSinkCount,
  pgliteCloseTimeoutMs,
  SINK_DRAIN_TIMEOUT_MS,
} from './background-work.ts';
import { POOL_END_TIMEOUT_SECONDS } from './db.ts';
import { parseGlobalFlags } from './cli-options.ts';

const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['serve']);

export function shouldForceExitAfterMain(
  argv: string[] = process.argv.slice(2),
): boolean {
  // Resolve the command the same way main() does — parseGlobalFlags strips
  // global flags INCLUDING space-separated values (`--timeout 30s`), so the
  // command here always matches the dispatched one. The old first-non-dash
  // heuristic saw `30s` as the command for `gbrain --timeout 30s serve` and
  // (post-#2084, where this gates an unconditional process.exit) would have
  // killed the daemon ~250ms after boot. Cross-model adversarial finding.
  let command: string | undefined;
  try {
    command = parseGlobalFlags(argv).rest[0];
  } catch {
    command = argv.find((arg) => !arg.startsWith('-'));
  }
  if (!command) return true;
  return !DAEMON_COMMANDS.has(command);
}

/** Floor for the computed backstop deadline (the historical hard deadline). */
export const TEARDOWN_DEADLINE_FLOOR_MS = 10_000;
/** Allowance for the facts sink's awaited abort() (shutdown of an in-flight job). */
const FACTS_ABORT_GRACE_MS = 2_000;
/** Headroom over the sum of the guarded bounds so timer jitter can't false-fire. */
const TEARDOWN_SLACK_MS = 2_000;
/** Max wait for the stdio flush fence before exiting anyway (blocked pipe). */
const FLUSH_GUARD_MS = 2_000;
/**
 * Aliveness grace between the fence and process.exit when stdio is NOT a TTY.
 * Empirically verified (#2084 probes): Bun's process.stdout queues pipe writes
 * in a native writer that only pushes to the fd on event-loop turns WHILE THE
 * PROCESS IS ALIVE — process.exit discards the queue, natural event-loop exit
 * discards it too, and no API reaches it (write callbacks fire on accept, not
 * delivery; writableLength/bytesWritten read 0 throughout;
 * Bun.stdout.writer().flush() is a different writer; fs.writeSync(1) is also
 * queued). Staying alive briefly is the ONLY flush. TTY writes are synchronous
 * — no grace needed there.
 */
const FLUSH_GRACE_PIPE_MS = 250;

/**
 * Resolve the non-TTY aliveness grace: `GBRAIN_FLUSH_GRACE_MS` env override
 * (incident/batch escape hatch, same env-only pattern as
 * GBRAIN_TEARDOWN_DEADLINE_MS) over the 250ms default. Consumers piping LARGE
 * payloads into slow readers (a reader that attaches later than the grace
 * loses the tail — Bun gives no delivery signal to wait on) can raise it;
 * high-frequency agent loops capturing to files can lower it.
 */
function resolveFlushGraceMs(): number {
  const env = Number(process.env.GBRAIN_FLUSH_GRACE_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return FLUSH_GRACE_PIPE_MS;
}
/**
 * Default cap on the exit-seam stdout tail drain (#4383's D2 remediation).
 * The tail drain is EPIPE-settled when a reader dies, but a reader that stays
 * OPEN and never drains (a wedged consumer holding the pipe) would otherwise
 * hang the exit forever. Generous by design — a healthy-but-slow reader must
 * never be truncated by an impatient cap; only a genuinely wedged one is.
 */
const STDOUT_DRAIN_DEADLINE_MS = 120_000;

/**
 * Resolve the stdout tail-drain cap: `GBRAIN_STDOUT_DRAIN_DEADLINE_MS` env
 * override (same env-only pattern as GBRAIN_TEARDOWN_DEADLINE_MS) over the
 * 120s default. `0` disables the cap entirely (pre-cap unbounded behavior).
 * On expiry the exit seam prints a one-line stderr note and proceeds to the
 * fence + grace — bounded truncation with a visible message beats an
 * invisible hang.
 */
export function resolveStdoutDrainDeadlineMs(): number {
  const env = Number(process.env.GBRAIN_STDOUT_DRAIN_DEADLINE_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return STDOUT_DRAIN_DEADLINE_MS;
}

/** Default per-sink drain budget (matches drainAllBackgroundWorkForCliExit). */
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Resolve the per-sink drain budget: `GBRAIN_DRAIN_TIMEOUT_MS` env override
 * (slow-provider escape hatch, same env-only pattern as
 * GBRAIN_TEARDOWN_DEADLINE_MS) over the 2000ms default. An explicit
 * `drainTimeoutMs` from a call site still wins — the env replaces only the
 * DEFAULT. The 2s default assumes a sub-second cloud chat provider; a
 * self-hosted model (e.g. ollama at 10-20s per completion) can never finish a
 * fire-and-forget facts:absorb extraction inside it, so every one-shot CLI
 * exit — sync timers especially — aborts the in-flight chat and the
 * extraction never lands, retrying (and re-aborting) on each subsequent sync
 * of the same page. Raising the budget via env lets those installs drain
 * instead of abort; computeTeardownDeadlineMs already scales the backstop
 * from the resolved value, so the deadline widens with it.
 */
export function resolveDrainTimeoutMs(): number {
  const env = Number(process.env.GBRAIN_DRAIN_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

/**
 * Backstop deadline for drain + disconnect COMBINED, computed from the bounds
 * it guards so it fires only when a component violated its own bound (#2084
 * eng-review D9 — a static 10s fired on healthy-but-slow bounded teardown:
 * 4 sinks × 2s + facts grace + 2 × ~2.5s pool ends ≈ 13s).
 * `GBRAIN_TEARDOWN_DEADLINE_MS` overrides the formula (incident escape hatch,
 * same env-only pattern as the GBRAIN_SYNC_* knobs).
 */
export function computeTeardownDeadlineMs(opts: {
  sinkCount: number;
  drainTimeoutMs: number;
}): number {
  const env = Number(process.env.GBRAIN_TEARDOWN_DEADLINE_MS);
  if (Number.isFinite(env) && env > 0) return env;
  // +500 mirrors endPoolBounded's slack over the postgres.js hint (db.ts);
  // ×2 budgets the worst case of two sequential pool ends (direct + read).
  const poolEndBoundMs = POOL_END_TIMEOUT_SECONDS * 1000 + 500;
  // #4143: engine.disconnect() now runs its OWN drain pass (the
  // in-flight-settle drain, SINK_DRAIN_TIMEOUT_MS/sink — see
  // drainBackgroundWorkBeforeDisconnect) AFTER the exit-mode drain above it
  // in finishCliTeardown, plus PGLite's bounded close. Budget both, or
  // the backstop fires while every component honored its own bound (the D9
  // false-backstop class this formula exists to kill). #4284: the close
  // bound is env-tunable (its own warn text tells operators to raise it),
  // so budget the RESOLVED bound, never a hardcoded copy of its default —
  // a 60s GBRAIN_PGLITE_CLOSE_TIMEOUT_MS must widen this backstop too.
  const disconnectDrainBoundMs = opts.sinkCount * SINK_DRAIN_TIMEOUT_MS;
  const pgliteCloseBoundMs = pgliteCloseTimeoutMs();
  const computed =
    opts.sinkCount * opts.drainTimeoutMs +
    disconnectDrainBoundMs +
    pgliteCloseBoundMs +
    FACTS_ABORT_GRACE_MS +
    2 * poolEndBoundMs +
    TEARDOWN_SLACK_MS;
  return Math.max(TEARDOWN_DEADLINE_FLOOR_MS, computed);
}

/**
 * Minimal writable surface for the flush fence — process.stdout/stderr satisfy
 * it; tests inject fakes.
 */
export interface MinimalWritable {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * #2084 — the CLI's exit verdict lives in a gbrain-OWNED variable, never read
 * back from `process.exitCode`. PGLite's Emscripten runtime writes its own
 * status into `process.exitCode` at arbitrary points DURING a run (99 at
 * create; in-memory brains run initdb whose exit status, e.g. 100, lands on a
 * later event-loop turn — after any point-in-time snapshot), so the global is
 * unreadable as a verdict channel on PGLite. Writers call `setCliExitVerdict`
 * (which mirrors into `process.exitCode` for anything external that reads the
 * global); the exit seam reads `currentExitCode()`, which trusts only the
 * owned variable. No verdict set ⇒ 0.
 */
let cliVerdict: number | null = null;

export function setCliExitVerdict(code: number): void {
  cliVerdict = code;
  process.exitCode = code; // best-effort mirror; never read back
}

export function currentExitCode(): number {
  return cliVerdict ?? 0;
}

/** Test seam — clears the verdict so each test starts clean. */
export function _resetCliExitVerdictForTests(): void {
  cliVerdict = null;
}

export interface FlushThenExitOpts {
  exit?: (code: number) => void;
  stdout?: MinimalWritable;
  stderr?: MinimalWritable;
  guardMs?: number;
  /**
   * Aliveness window between the fence and exit. Default: 0 when BOTH stdio
   * streams are TTYs (synchronous writes), FLUSH_GRACE_PIPE_MS otherwise.
   * The grace timer is deliberately ref'd — keeping the loop alive is the
   * only thing that delivers Bun's queued pipe writes (see module constant).
   */
  graceMs?: number;
}

/**
 * Flush stdout + stderr, then exit with `code` — exactly once.
 *
 * Two stages, both bounded:
 *  1. Fence: an empty `write('', cb)` per stream serializes behind the accept
 *     queue; an unref'd guard bounds a stream whose callback never fires.
 *     (In Bun the callback fires on ACCEPT, not delivery — the fence alone is
 *     NOT sufficient; verified in the #2084 probes.)
 *  2. Aliveness grace: a REF'D timer keeps the process alive `graceMs` so
 *     Bun's native writer can push the queued bytes to the fd / a consuming
 *     reader (#1959 truncation class). TTY stdio skips this (sync writes).
 *
 * A reader that consumes nothing for longer than guard+grace loses the tail —
 * unavoidable without waiting forever; strictly better than the pre-#2084
 * behavior (immediate process.exit discarded everything still queued).
 *
 * `process.exitCode` is set up front so that even a stubbed `exit` (tests) or
 * a natural event-loop exit keeps the right code.
 */
/** Process-level guard: the REAL process.exit fires at most once even if both
 * the backstop and the central seam reach flushThenExit (test-injected exit
 * fns are exempt so unit tests stay independent). */
let realExitInitiated = false;

export function flushThenExit(code: number, opts: FlushThenExitOpts = {}): void {
  if (!opts.exit) {
    if (realExitInitiated) return;
    realExitInitiated = true;
  }
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const streams: MinimalWritable[] = [
    opts.stdout ?? process.stdout,
    opts.stderr ?? process.stderr,
  ];
  const guardMs = opts.guardMs ?? FLUSH_GUARD_MS;
  const bothTty = streams.every((s) => (s as { isTTY?: boolean }).isTTY === true);
  const graceMs = opts.graceMs ?? (bothTty ? 0 : resolveFlushGraceMs());
  process.exitCode = code;
  const beginFence = () => {
    let fenced = false;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (fenced) return;
      fenced = true;
      if (guard) clearTimeout(guard);
      if (graceMs <= 0) {
        exit(code);
        return;
      }
      // Ref'd on purpose: aliveness IS the flush (Bun pipe-write semantics).
      setTimeout(() => exit(code), graceMs);
    };
    let pending = streams.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) finish();
    };
    guard = setTimeout(finish, guardMs);
    guard.unref?.();
    for (const s of streams) {
      try {
        // EPIPE on a closed pipe surfaces as an async 'error' event; swallow it —
        // the guard or the other stream's callback still drives the exit.
        s.once?.('error', () => {});
        s.write('', () => done());
      } catch {
        done(); // sync EPIPE / destroyed stream
      }
    }
  };
  if (stdoutTailPending > 0) {
    // #4383 — interposed/serialized stdout writes are still in flight (only
    // possible on the EAGAIN continuation path: on a blocking pipe fd the
    // writeSync loop completes inside the original call). Drain the tail
    // before the fence so
    // the exit cannot truncate a CLI_ONLY payload. The keepalive interval is
    // deliberately REF'D: awaiting a promise does not by itself keep Bun's
    // loop alive, and exiting naturally here would discard the very bytes the
    // tail exists to deliver. Same well-behaved-pipe-writer posture as
    // writeStdoutFinal (#3423); EPIPE settles the tail when the reader dies,
    // so a gone reader cannot hang the exit — but a STALLED-OPEN reader
    // (alive, never draining) would, so the drain is bounded by
    // resolveStdoutDrainDeadlineMs(): on expiry, print a one-line stderr note
    // and proceed to the fence + grace (visible bounded truncation beats an
    // invisible hang). 0 disables the cap.
    const keepalive = setInterval(() => {}, 500);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let proceeded = false;
    const proceed = () => {
      if (proceeded) return;
      proceeded = true;
      clearInterval(keepalive);
      if (deadline) clearTimeout(deadline);
      beginFence();
    };
    const drainDeadlineMs = resolveStdoutDrainDeadlineMs();
    if (drainDeadlineMs > 0) {
      deadline = setTimeout(() => {
        try {
          (opts.stderr ?? process.stderr).write(
            `[cli] stdout tail drain exceeded ${drainDeadlineMs}ms (GBRAIN_STDOUT_DRAIN_DEADLINE_MS) — exiting; piped output may be truncated\n`,
          );
        } catch {
          // stderr gone — still proceed to exit
        }
        proceed();
      }, drainDeadlineMs);
    }
    void stdoutTailIdle().then(proceed, proceed);
    return;
  }
  beginFence();
}

// ---------------------------------------------------------------------------
// #4383 — delivery-exact serialized stdout for one-shot commands.
//
// The #3423 fix (writeStdoutFinal) covered the shared-op paths, but CLI_ONLY
// handlers still emit payloads through bare process.stdout.write (advisor
// --json, eval-brainbench/eval-compare outcomes, agent results, calibration
// reports, ...). Those writes land in Bun's queued native writer, so a payload
// past the 64KiB kernel pipe buffer piped to a reader slower than the exit
// seam's fence guard + grace loses its tail with exit 0 — verified truncation
// at exactly 65,536 bytes on this exact shape. The cure: route the bytes
// through direct fd-1 write syscalls (fs.writeSync loop below), which only
// return/settle once the fd accepted every byte. An explicit FIFO queue of
// {buf, offset} entries plus ONE async pump serializes every routed write so
// ordering is preserved; flushThenExit drains the queue (awaits pump idle)
// before its fence + grace, and a DIRECT process.exit(N) — the CLI's
// validation paths call it without ever reaching flushThenExit (exit-2 JSON
// envelopes, help/usage sites) — drains it SYNCHRONOUSLY via the patched
// exit installed by installStdoutPipeDelivery. Pre-fix, a direct exit
// discarded the whole queued tail whenever a prior bulk write had
// EAGAIN-deferred: the small envelope written after it queued BEHIND the
// deferred payload and both were lost (reproduced in CI + under serial-lane
// load on the code-callers bad-pin exit-2 envelope).
//
// Why NOT Bun.write(Bun.stdout) (the #3423 primitive): initializing the
// node:stream process.stdout wrapper — which patching process.stdout.write
// requires, and which merely reading process.stdout.isTTY already does —
// flips fd 1 to O_NONBLOCK, and from then on Bun.write(Bun.stdout, big)
// writes the first 64KiB and its promise NEVER settles, even after the
// reader drains (probed on Bun 1.3.14: touch isTTY → Bun.write of 200KB
// wedges forever at 65,536 bytes). The writeSync loop handles both regimes:
// a blocking fd delivers synchronously inside the call; a non-blocking fd
// partial-writes, gets EAGAIN, and resumes off a short poll timer.
//
// console.log (and info/debug — the stdout-bound console methods) IS rerouted
// through the same chain, because the wrapper init above also breaks Bun's
// console writer: with fd 1 blocking, console.log delivers sync-blocking and
// can never truncate, but once the wrapper flips fd 1 to O_NONBLOCK — which
// the real CLI does long before a payload prints (any process.stdout touch) —
// console.log's write EAGAINs into a queue that process.exit discards. That
// is precisely the `orphans --json | slow-reader` field truncation. The
// rerouted methods keep Node's console formatting via util.formatWithOptions.
// The many `console.log(...); process.exit(1)` help/usage sites stay safe
// because the chain's fast path completes delivery SYNCHRONOUSLY inside the
// call whenever the chain is idle and the pipe has room (the overwhelmingly
// common case for small text) — no microtask has to run before a synchronous
// exit for those bytes to land.
// ---------------------------------------------------------------------------

/**
 * One queued payload awaiting delivery. `offset` is the resume point — only
 * ever advanced by whichever drainer (the async pump or the synchronous
 * direct-exit drain) is running; the two can never run concurrently (single
 * thread: the sync drain only fires while the pump is parked at an await, at
 * which point `offset` is current). `consumed` marks a fully-delivered (or
 * EPIPE/errno-finished) entry so the pump never double-writes an entry the
 * sync drain already delivered. `settle` resolves the per-write delivery
 * promise (write callbacks + writeStdoutFinal awaiters).
 */
interface StdoutQueueEntry {
  buf: Buffer;
  offset: number;
  consumed: boolean;
  settle: () => void;
}

/** FIFO of deferred payloads: every routed stdout write settles in order. */
const stdoutQueue: StdoutQueueEntry[] = [];
/** Writes on the queue that have not yet settled (0 ⇒ safe to start eagerly). */
let stdoutTailPending = 0;
/** True while the single async pump owns the queue head. */
let stdoutPumpRunning = false;
/** Exit-seam waiters released when the queue fully settles (pump idle). */
let stdoutIdleWaiters: Array<() => void> = [];
let stdoutInterposed = false;

/** Mark `entry` finished: settle its delivery promise and, when the queue
 * goes quiet, release the exit seam's idle waiters. Idempotent — both
 * drainers funnel completion through here. */
function completeStdoutEntry(entry: StdoutQueueEntry): void {
  if (entry.consumed) return;
  entry.consumed = true;
  stdoutTailPending -= 1;
  entry.settle();
  if (stdoutTailPending === 0) {
    const waiters = stdoutIdleWaiters;
    stdoutIdleWaiters = [];
    for (const w of waiters) w();
  }
}

/** Resolves once every queued write has settled (immediately when idle). */
function stdoutTailIdle(): Promise<void> {
  if (stdoutTailPending === 0) return Promise.resolve();
  return new Promise((r) => stdoutIdleWaiters.push(r));
}

/** Poll interval while a non-blocking fd 1 reports EAGAIN (reader backpressure). */
const STDOUT_EAGAIN_POLL_MS = 5;

/**
 * Push bytes of `buf` from `off` to fd 1 until done or backpressure.
 * Returns 'done' when every byte was accepted OR the reader is gone (EPIPE
 * only — partial delivery to a gone reader is not an op failure); returns
 * the resume offset on EAGAIN (non-blocking fd + full pipe). On a blocking
 * fd this loop delivers the whole payload synchronously, blocking like any
 * well-behaved pipe writer.
 *
 * D2 remediation: any OTHER errno (ENOSPC, EIO, ...) means the payload was
 * genuinely lost mid-delivery — that is an honest failure, never a silent
 * exit-0 truncation. It warns on stderr naming the errno, flips the exit
 * verdict nonzero via setCliExitVerdict(1), and then finishes the chain
 * ('done') so the exit seam can never hang on an unwritable fd.
 *
 * `write` is injectable for unit tests only; production callers use the
 * real fd-1 writeSync.
 */
export function writeChunkSync(
  buf: Buffer,
  off: number,
  write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync,
): 'done' | number {
  while (off < buf.length) {
    try {
      off += write(1, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EINTR is retryable like EAGAIN — dropping the tail on a signal
      // interrupt would be a silent truncation.
      if (code === 'EAGAIN' || code === 'EINTR') return off;
      // EPIPE / closed reader — the operation itself already succeeded.
      if (code === 'EPIPE') return 'done';
      // ENOSPC / EIO / anything else: bytes were LOST with the reader still
      // there. Say so on stderr and report failure through the exit verdict.
      try {
        process.stderr.write(
          `[cli] stdout write failed (${code ?? 'unknown errno'}) at byte ${off} of ${buf.length} — output truncated; exit code set to 1\n`,
        );
      } catch {
        // stderr unusable too — the verdict flip below still reports it
      }
      setCliExitVerdict(1);
      return 'done';
    }
  }
  return 'done';
}

/**
 * The single async pump: consumes the queue head-first with the old
 * per-write continuation's semantics (writeChunkSync until done, retrying
 * EAGAIN off a ref'd poll timer that also keeps Bun's loop alive until
 * delivery; EPIPE/errno handling lives in writeChunkSync). Never rejects —
 * the tail must always settle so the exit seam can never hang on it. The
 * inner try/finally releases the running flag SYNCHRONOUSLY with the final
 * queue-empty check (same continuation), so an enqueue can never observe a
 * "running" pump that has already decided to stop.
 */
async function runStdoutPump(): Promise<void> {
  try {
    for (;;) {
      const entry = stdoutQueue[0];
      if (!entry) return;
      if (entry.consumed) {
        // The synchronous direct-exit drain finished this one while the pump
        // was parked at the poll sleep — never write it again.
        stdoutQueue.shift();
        continue;
      }
      const at = writeChunkSync(entry.buf, entry.offset);
      if (at === 'done') {
        completeStdoutEntry(entry);
        stdoutQueue.shift();
        continue;
      }
      entry.offset = at;
      await new Promise((r) => setTimeout(r, STDOUT_EAGAIN_POLL_MS));
    }
  } finally {
    stdoutPumpRunning = false;
  }
}

function ensureStdoutPump(): void {
  if (stdoutPumpRunning) return;
  stdoutPumpRunning = true;
  void runStdoutPump();
}

/** Append a payload (with its resume `offset`) to the FIFO and make sure the
 * pump is running. The returned promise settles on DELIVERY. */
function enqueueStdoutEntry(buf: Buffer, offset: number): Promise<void> {
  stdoutTailPending += 1;
  return new Promise<void>((settle) => {
    stdoutQueue.push({ buf, offset, consumed: false, settle });
    ensureStdoutPump();
  });
}

/** Shared cell for Atomics.wait-based blocking sleeps on the direct-exit path. */
const syncSleepCell: Int32Array<SharedArrayBuffer> | null = (() => {
  try {
    return new Int32Array(new SharedArrayBuffer(4));
  } catch {
    return null; // SharedArrayBuffer unavailable — spin fallback below
  }
})();

/**
 * Block the thread ~`ms` WITHOUT timers: the direct-exit path never returns
 * to the event loop, so a setTimeout could never fire. Atomics.wait on a
 * SharedArrayBuffer is the sanctioned main-thread blocking sleep in Bun/Node;
 * if unavailable, a bounded spin (plain loop counter — no Date, no timers)
 * burns a short slice instead. Either way the CALLER's deadline bounds the
 * total wait.
 */
function sleepSyncMs(ms: number): void {
  if (syncSleepCell) {
    try {
      Atomics.wait(syncSleepCell, 0, 0, ms);
      return;
    } catch {
      // fall through to the spin
    }
  }
  for (let i = 0; i < 4_000_000; i += 1) {
    // spin — bounded busy-wait; the caller's deadline is the real cap
  }
}

/**
 * Synchronously drain every queued stdout entry — the direct-process.exit
 * seam (#4383 residual). CLI validation paths print their payload and call
 * process.exit(N) directly, never reaching flushThenExit; pre-fix, whenever a
 * prior bulk write had EAGAIN-deferred into the queue, the payload written
 * after it (e.g. the exit-2 JSON error envelope) queued BEHIND the deferred
 * write and the direct exit discarded both. This loops writeChunkSync over
 * the remaining entries with a bounded blocking EAGAIN retry (Atomics.wait
 * micro-sleeps — no timers), marking each delivered entry consumed so the
 * async pump never double-writes. `deadlineMs` caps the total blocking wait
 * (default resolveStdoutDrainDeadlineMs(); 0 = uncapped, matching the async
 * drain's contract); on expiry it prints the same one-line stderr note as
 * the async drain and returns — visible bounded truncation beats a wedged
 * exit. EPIPE/errno semantics are writeChunkSync's, unchanged.
 */
export function drainStdoutQueueSync(deadlineMs: number = resolveStdoutDrainDeadlineMs()): void {
  const startedAt = Date.now();
  while (stdoutQueue.length > 0) {
    const entry = stdoutQueue[0];
    if (entry.consumed) {
      stdoutQueue.shift();
      continue;
    }
    const at = writeChunkSync(entry.buf, entry.offset);
    if (at === 'done') {
      completeStdoutEntry(entry);
      stdoutQueue.shift();
      continue;
    }
    entry.offset = at; // bank partial progress for whoever drains next
    if (deadlineMs > 0 && Date.now() - startedAt >= deadlineMs) {
      try {
        process.stderr.write(
          `[cli] stdout tail drain exceeded ${deadlineMs}ms (GBRAIN_STDOUT_DRAIN_DEADLINE_MS) — exiting; piped output may be truncated\n`,
        );
      } catch {
        // stderr gone — still proceed to exit
      }
      return;
    }
    sleepSyncMs(STDOUT_EAGAIN_POLL_MS);
  }
}

/**
 * Append one payload to the serialized stdout chain.
 *
 * Fast path when nothing is in flight: delivery completes synchronously
 * INSIDE this call (blocking fd: always; non-blocking fd: whenever the pipe
 * has room), so the common `write(...); process.exit(...)` / multi-
 * `console.log(...); process.exit(1)` shapes cannot lose their payload to a
 * chained microtask that a synchronous exit never runs — and the chain stays
 * idle (no pending state) for the next caller. Only genuine backpressure
 * (EAGAIN mid-payload) or a prior in-flight write defers to the async tail,
 * preserving order.
 */
function chainStdoutWrite(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  const buf =
    typeof data === 'string'
      ? Buffer.from(data, encoding ?? 'utf8')
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (stdoutTailPending === 0) {
    const rest = writeChunkSync(buf, 0);
    if (rest === 'done') return Promise.resolve();
    return enqueueStdoutEntry(buf, rest);
  }
  return enqueueStdoutEntry(buf, 0);
}

/**
 * Interpose process.stdout.write so CLI_ONLY payloads flow through the
 * serialized fd-1 write chain (see the #4383 block comment above). Installed
 * once per process from cli.ts's import.meta.main seam, ONLY for one-shot
 * commands (`shouldForceExitAfterMain()`): daemons (`serve`) keep Bun's
 * native streaming writer. TTY stdout writes synchronously already — nothing
 * to fix — so the interposer is a no-op there.
 *
 * The replacement keeps the Writable#write surface the callers use: optional
 * encoding, optional callback (fired after DELIVERY, not accept — strictly
 * later than the native writer fired it, never earlier), boolean return
 * (always true: the chain owns backpressure, and flushThenExit awaits it).
 */
export function installStdoutPipeDelivery(): void {
  if (stdoutInterposed) return;
  if (process.stdout.isTTY) return;
  stdoutInterposed = true;
  const interposed = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    maybeCb?: (err?: Error | null) => void,
  ): boolean {
    let encoding: BufferEncoding | undefined;
    let cb: ((err?: Error | null) => void) | undefined;
    if (typeof encodingOrCb === 'function') {
      cb = encodingOrCb;
    } else {
      encoding = encodingOrCb;
      if (typeof maybeCb === 'function') cb = maybeCb;
    }
    const settled = chainStdoutWrite(chunk, encoding);
    if (cb) void settled.then(() => cb(null));
    return true;
  };
  process.stdout.write = interposed as typeof process.stdout.write;
  // #4383 residual: the CLI's validation paths call process.exit(N) DIRECTLY
  // (exit-2 JSON error envelopes, the many help/usage sites) without ever
  // reaching flushThenExit. The fast path above delivers small payloads
  // synchronously inside write() while the queue is idle — but once a bulk
  // write EAGAIN-defers, every subsequent write queues BEHIND it, and a
  // direct exit used to discard the whole queued tail (envelope included).
  // Patch process.exit ONCE: drain the queue synchronously (bounded by
  // resolveStdoutDrainDeadlineMs, same policy as the async drain), then call
  // the real exit. flushThenExit is unaffected — it drains via the pump
  // before it ever reaches exit, so the patched drain is a no-op there.
  const realExit = process.exit.bind(process);
  const patchedExit = ((code?: number | string | null): never => {
    if (stdoutTailPending > 0) drainStdoutQueueSync();
    return realExit(code as number);
  }) as typeof process.exit;
  process.exit = patchedExit;
  // Reroute the stdout-bound console methods through the same chain (see the
  // #4383 block comment: once the wrapper init above flips fd 1 to
  // O_NONBLOCK, Bun's own console writer EAGAINs big payloads into a queue
  // that process.exit discards — the `orphans --json` truncation). Formatting
  // parity comes from util.formatWithOptions (what Node's Console uses);
  // colors stay off — this path is non-TTY by construction. console.error /
  // console.warn are stderr-bound and stay native.
  const consoleToChain = (...args: unknown[]): void => {
    void chainStdoutWrite(formatWithOptions({ colors: false }, ...args) + '\n');
  };
  console.log = consoleToChain;
  console.info = consoleToChain;
  console.debug = consoleToChain;
}

/**
 * Deliver a one-shot command's stdout payload FULLY before the exit seam runs.
 *
 * process.stdout.write queues pipe writes in a native writer that only pushes
 * to the fd while the process stays alive (see FLUSH_GRACE_PIPE_MS), so a
 * payload larger than the kernel pipe buffer (64KiB) piped to a reader that
 * drains slower than the exit grace loses its tail with exit 0 (#3423) — and
 * the tail is exactly where a verify-read's fresh edit lives. The serialized
 * fd-1 write chain settles only after the fd accepted every byte, so awaiting
 * it here makes the exit safe at any reader pace; backpressure from a slow
 * reader blocks like any well-behaved pipe writer instead of truncating.
 * EPIPE (reader closed early, e.g. `| head`) is swallowed — partial delivery
 * to a gone reader is not an op failure. #4383: joins the same serialized
 * chain as the interposed process.stdout.write, so a final payload can never
 * overtake an earlier CLI_ONLY write — and, unlike the original
 * Bun.write(Bun.stdout) primitive, it cannot wedge when the process.stdout
 * wrapper has been initialized (see the #4383 block comment above).
 */
export async function writeStdoutFinal(output: string): Promise<void> {
  await chainStdoutWrite(output);
}

export interface FinishCliTeardownOpts {
  /** Engine to disconnect. A disconnect throw is warned + swallowed (D3). */
  engine: { disconnect(): Promise<void> };
  /**
   * Per-sink drain budget. Default: `GBRAIN_DRAIN_TIMEOUT_MS` env override,
   * else 2000 (the registry default).
   */
  drainTimeoutMs?: number;
  /** Test seam — wins over the env override and the computed formula. */
  deadlineMs?: number;
  /** Forwarded to flushThenExit on the backstop path (test seam). */
  graceMs?: number;
  // ---- test seams (default to the real thing) ----
  exit?: (code: number) => void;
  warn?: (msg: string) => void;
  drain?: (opts: { timeoutMs: number }) => Promise<void>;
  stdout?: MinimalWritable;
  stderr?: MinimalWritable;
}

/**
 * CLI-EXIT-ONLY teardown: bounded drain of every background-work sink, then
 * bounded engine disconnect, under a computed-deadline backstop. Returns to
 * the caller — the explicit process exit happens once, in cli.ts's
 * import.meta.main seam (see module header). The backstop timer is the ONLY
 * exit in here, and it means a component violated its own bound.
 */
export async function finishCliTeardown(opts: FinishCliTeardownOpts): Promise<void> {
  const drainTimeoutMs = opts.drainTimeoutMs ?? resolveDrainTimeoutMs();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const drain = opts.drain ?? drainAllBackgroundWorkForCliExit;
  const deadlineMs =
    opts.deadlineMs ??
    computeTeardownDeadlineMs({ sinkCount: backgroundWorkSinkCount(), drainTimeoutMs });

  const backstop = setTimeout(() => {
    warn(
      `[cli] teardown (background-work drain + engine.disconnect()) did not return within ${deadlineMs}ms — force-exiting`,
    );
    // currentExitCode() reads the gbrain-owned verdict channel — an errored
    // op's setCliExitVerdict(1) is honored even when PGLite has scribbled over
    // process.exitCode; a bare exit(0) would mask the failure.
    flushThenExit(currentExitCode(), opts);
  }, deadlineMs);
  // Deliberately REF'D (adversarial F3): if teardown hangs while nothing else
  // keeps Bun's loop alive, an unref'd timer would let the process exit
  // NATURALLY — skipping the flush and exiting with whatever PGLite scribbled
  // into process.exitCode. The ref'd timer costs nothing on the clean path
  // (cleared in the finally as soon as teardown returns).

  try {
    try {
      await drain({ timeoutMs: drainTimeoutMs });
    } catch (e) {
      // The registry is contractually non-throwing, but a throw here must not
      // skip the disconnect or escape a caller's finally (it would replace a
      // successful op's completion). Same D3 posture as the disconnect guard.
      warn(
        `[cli] background-work drain failed during teardown: ${e instanceof Error ? e.message : String(e)} — continuing to disconnect`,
      );
    }
    try {
      await opts.engine.disconnect();
    } catch (e) {
      // D3: the exit code reports the operation, not the cleanup. Matches the
      // non-throwing posture of endPoolBounded (db.ts).
      warn(
        `[cli] engine.disconnect() failed during teardown: ${e instanceof Error ? e.message : String(e)} — continuing to exit`,
      );
    }
  } finally {
    clearTimeout(backstop);
  }
}
