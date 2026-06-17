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
 *     — fence stdout+stderr (write-fence raced with an unref'd guard,
 *       EPIPE-safe), hold a short REF'D aliveness grace for non-TTY stdio
 *       (Bun only delivers queued pipe writes while alive), then
 *       process.exit. Stuck sockets become irrelevant.
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

import { drainAllBackgroundWorkForCliExit, backgroundWorkSinkCount } from './background-work.ts';
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
/** Default per-sink drain budget (matches drainAllBackgroundWorkForCliExit). */
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

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
  const computed =
    opts.sinkCount * opts.drainTimeoutMs +
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
}

export interface FinishCliTeardownOpts {
  /** Engine to disconnect. A disconnect throw is warned + swallowed (D3). */
  engine: { disconnect(): Promise<void> };
  /** Per-sink drain budget. Default 2000 (the registry default). */
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
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
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
