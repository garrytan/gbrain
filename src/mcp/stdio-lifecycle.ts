/**
 * The engine-free part of a stdio MCP server's lifecycle, shared by local
 * `gbrain serve` (src/commands/serve.ts installStdioLifecycle, which adds its
 * engine hooks: idle sweep, facts drain, tickers, engine close) and the
 * thin-client bridge (src/mcp/remote-bridge.ts, which has none):
 *   - SIGTERM / SIGINT / SIGHUP converge on one graceful shutdown;
 *   - stdin EOF drains in-flight RPCs, bounded, before it (#4409), and is
 *     ignored under MCP_STDIO=1, where a gateway closes its stdin half after
 *     the handshake (#870), and on a TTY;
 *   - the parent-pid watchdog notices a parent that died without closing
 *     stdin or signalling.
 * This module imports no engine, dispatch or operation module, so the bridge
 * can use it without loading a brain.
 */
import { spawnSync } from '../core/spawn.ts';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Largest JSON-RPC message the stdio server reads (the SDK default is 10 MiB,
 * and an oversized message closes the session). A page at the 24 MiB ceiling
 * travels JSON-escaped, and newlines and quotes double, so 64 MiB carries it
 * with room; the persistence journal caps a principal's outstanding intents at
 * the same 64 MiB.
 */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** The stdio transport `gbrain serve` connects, sized for ceiling-size page writes. */
export function mcpStdioTransport(stdin: Readable = process.stdin, stdout: Writable = process.stdout): StdioServerTransport {
  return new StdioServerTransport(stdin, stdout, { maxBufferSize: MCP_STDIO_MAX_MESSAGE_BYTES });
}

// How often the parent-process watchdog polls the live kernel parent PID
// (via `readLiveParentPid`, NOT the cached `process.ppid` — see that
// helper's comment). We don't receive a signal when our parent dies (the
// kernel just re-parents us to init / launchd / a subreaper-PID), so
// polling is the only reliable way to detect "parent went away without
// closing stdin". 5s matches the cadence in the concurrent #591 PR;
// faster polling has no benefit, slower would extend the lock-leak window.
export const PARENT_WATCHDOG_INTERVAL_MS = 5_000;

// #4409: stdin-EOF drain bound. Long enough for a real tool call (a query
// with embedding + LLM expansion) to finish; short enough that a genuinely
// wedged handler can't pin the PGLite lock forever after the parent left.
export const DEFAULT_EOF_DRAIN_MS = 30_000;

// Env resolution for the stdin-EOF drain bound. Lenient like
// resolveBootTimeoutMs: a typo'd env var must not turn the data-loss fix
// into a shutdown failure. 0 disables the drain (immediate exit).
export function resolveEofDrainMs(defaultMs: number = DEFAULT_EOF_DRAIN_MS): number {
  const raw = process.env.GBRAIN_SERVE_EOF_DRAIN_MS;
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `[gbrain serve] ignoring invalid GBRAIN_SERVE_EOF_DRAIN_MS=${JSON.stringify(raw)} — using default ${defaultMs}ms`,
    );
    return defaultMs;
  }
  return Math.floor(n);
}

/** How long an exit waits for buffered stdout; a reader that stopped reading cannot hold the process past it. */
export const STDOUT_DRAIN_MS = 5_000;

/**
 * GST-2760: the process exit both stdio servers use. Bun's process.exit drops stdout it still buffers natively (an
 * 8 MiB reply written just before exit arrives as 64 KiB), so the exit waits for stdout.end() to report the buffer
 * flushed, an error (the reader is gone) or STDOUT_DRAIN_MS, whichever comes first.
 */
export function exitAfterStdoutDrains(exit: (code?: number) => void = (code) => { process.exit(code); }, stdout: Writable = process.stdout, boundMs = STDOUT_DRAIN_MS): (code?: number) => void {
  return (code) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exit(code);
    };
    const timer = setTimeout(finish, boundMs);
    stdout.once('error', finish);
    try { stdout.end(finish); } catch { finish(); }
  };
}

export interface StdioLifecycleDeps {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  signals: Pick<NodeJS.Process, 'on'>;
  exit: (code?: number) => void;
  log: (msg: string) => void;
  getParentPid: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  probeWatchdog: () => boolean;
}

export interface StdioShutdownTriggerOpts {
  /** The idempotent graceful shutdown every trigger converges on. */
  beginShutdown: (reason: string) => void;
  isShuttingDown: () => boolean;
  /** Live count of JSON-RPC requests whose handlers have not settled. */
  pendingRpcs: () => number;
  /** stdin-EOF drain bound in ms; 0 = immediate shutdown. */
  eofDrainMs: number;
  /** MCP_STDIO=1: stdin EOF is not a disconnect (#870). */
  mcpStdio: boolean;
  /** Called once when the drain bound expires with requests still in flight, before the shutdown. */
  onDrainExpired?: () => void;
  /** Prefix of this server's own stderr lines. */
  logPrefix?: string;
}

/**
 * Install the signal, stdin-EOF and parent-watchdog triggers. Returns the
 * drain-then-shutdown entry point (for callers that start a shutdown on
 * their own, such as a transport close) and a stop for the watchdog, which
 * the shutdown calls first so it cannot fire a second one.
 */
export function installStdioShutdownTriggers(deps: StdioLifecycleDeps, o: StdioShutdownTriggerOpts): { drainThenShutdown: (reason: string) => void; stopWatchdog: () => void } {
  let parentWatchdog: unknown = null;
  const stopWatchdog = (): void => {
    if (parentWatchdog === null) return;
    deps.clearInterval(parentWatchdog);
    parentWatchdog = null;
  };

  // Signal-based termination. SIGTERM: daemon ask. SIGINT: user Ctrl-C.
  // SIGHUP: terminal disconnect / daemon-style "reload" channels — Aragorn
  // observed real-world hosts (Claude Desktop on macOS, hermes-agent
  // restart) send these instead of closing stdin. All three get the same
  // graceful path; the idempotency guard absorbs duplicate signals.
  deps.signals.on('SIGTERM', () => o.beginShutdown('SIGTERM'));
  deps.signals.on('SIGINT', () => o.beginShutdown('SIGINT'));
  deps.signals.on('SIGHUP', () => o.beginShutdown('SIGHUP'));

  // Stdin EOF — the parent closes the pipe but the MCP SDK's
  // StdioServerTransport only listens for 'data'/'error', not 'end' or
  // 'close', so without these hooks the process keeps the engine (and its
  // PGLite write lock) live indefinitely after the parent disconnects.
  // 'end' fires on a clean EOF; 'close' fires when the underlying handle
  // is destroyed (e.g. parent SIGKILL'd while pipe still open). Both
  // converge on the same idempotent shutdown.
  // Skip when stdin is a TTY: interactive `gbrain serve` use shouldn't
  // terminate just because the user hasn't typed anything. Signal /
  // watchdog paths still cover that case if needed.
  // v0.34.1 (#870): when MCP_STDIO=1, the wrapping gateway pipes the
  // JSON-RPC handshake then closes its stdin half. Treating that as a
  // permanent disconnect kills the server before the first tool call.
  // Signal handlers (SIGTERM/SIGINT/SIGHUP), transport.onclose, and the
  // parent-process watchdog below still cover legitimate shutdown paths.
  // #4409: a one-shot MCP client writes its frames and closes stdin
  // immediately. Node delivers 'end' AFTER all 'data' events, and the SDK
  // parses every received frame synchronously during 'data' (handler start
  // is queued as a microtask) — so at EOF time requests can be in flight
  // with no response written yet. Treating EOF as an immediate shutdown
  // silently dropped those responses (the codex-plugin door went red on
  // exactly this shape). Drain in-flight RPCs — bounded — before the
  // graceful exit; idle servers still exit promptly (one timer tick).
  // GBRAIN_SERVE_EOF_DRAIN_MS tunes the bound; 0 restores immediate exit.
  let eofDrainStarted = false;
  const drainThenShutdown = (reason: string): void => {
    if (o.isShuttingDown() || eofDrainStarted) return;
    eofDrainStarted = true;
    void (async () => {
      if (o.eofDrainMs > 0) {
        // One macrotask so already-parsed requests' handlers (microtasks)
        // start and increment the counter before the first check.
        await new Promise<void>((r) => setTimeout(r, 0));
        if (o.pendingRpcs() > 0) {
          deps.log(
            `GBrain MCP server: stdin EOF with ${o.pendingRpcs()} in-flight request(s) — draining before exit (bound ${o.eofDrainMs}ms; GBRAIN_SERVE_EOF_DRAIN_MS)`,
          );
          const deadlineAt = Date.now() + o.eofDrainMs;
          while (o.pendingRpcs() > 0 && Date.now() < deadlineAt && !o.isShuttingDown()) {
            await new Promise<void>((r) => setTimeout(r, 25));
          }
          if (o.pendingRpcs() > 0 && !o.isShuttingDown()) o.onDrainExpired?.();
        }
        // One extra macrotask: the SDK sends the response in a .then AFTER
        // the handler resolves — let that stdout write get issued before
        // the cleanup chain starts.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      o.beginShutdown(reason);
    })();
  };
  if (!deps.stdin.isTTY && !o.mcpStdio) {
    deps.stdin.once('end', () => drainThenShutdown('stdin-end'));
    deps.stdin.once('close', () => drainThenShutdown('stdin-close'));
  }

  // Parent-process watchdog. Some hosts (launchd, cron, certain MCP
  // gateways) terminate without closing stdin and without sending a
  // signal — the kernel just re-parents us to whichever ancestor is
  // still alive (PID 1, or any closer subreaper such as launchd, systemd,
  // tmux, or a parent shell with PR_SET_CHILD_SUBREAPER). Polling is the
  // only portable way to notice; see `readLiveParentPid` for why we
  // cannot rely on `process.ppid` (cached at process creation and never
  // refreshed on re-parent in Node or Bun). On Windows the same class of
  // orphan is WORSE in practice: MCP hosts typically launch the server
  // through a `cmd.exe` wrapper (.bat/.cmd), and killing the wrapper
  // does not kill the child — so without a watchdog the orphan holds the
  // PGLite write lock until the machine reboots. `readLiveParentPid`
  // handles the platform split internally (PPID-change on POSIX,
  // parent-liveness on Windows); the comparison below works for both.
  //
  // We capture the initial parent PID once at install time and fire on
  // ANY change, not just reparent-to-PID-1. The PR-#676 author's original
  // `=== 1` check missed reparent-to-subreaper-PID-N, which is the actual
  // observed behavior under launchd / systemd subreapers (codex review
  // finding #3). A process legitimately started under PID 1 (e.g. a
  // systemd service) skips the watchdog: there's no parent-death event
  // to detect, and any reparent FROM 1 doesn't happen. `unref()` keeps
  // the interval from blocking other exit paths.
  //
  // A one-shot startup probe (D2-revisited per codex finding #4) verifies
  // that the underlying mechanism (`spawnSync('ps')`) actually works on
  // this host. Stripped containers / busybox-without-procps environments
  // would silently fall back to the cached `process.ppid` on every tick
  // — the watchdog claims to be installed but never fires. When the probe
  // fails, we skip installing the interval entirely and log loudly so the
  // operator sees the degraded mode instead of a phantom watchdog.
  // `> 1` (was `!== 1`): PID 1 is the documented legitimate-init-child
  // skip; PID 0 is the new "parent already gone at install time" report
  // from the Windows liveness reader — installing an interval that
  // compares 0 to 0 forever would be a phantom watchdog, and stdin
  // 'close' already covers a parent that died before we booted.
  const initialParentPid = deps.getParentPid();
  if (initialParentPid > 1) {
    if (!deps.probeWatchdog()) {
      deps.log(
        `${o.logPrefix ?? '[gbrain serve]'} watchdog disabled: no parent-liveness mechanism (ps / signal-0 probe failed) — child will rely on stdin EOF / signals only`,
      );
    } else {
      parentWatchdog = deps.setInterval(() => {
        if (deps.getParentPid() !== initialParentPid) {
          o.beginShutdown('parent-died');
        }
      }, PARENT_WATCHDOG_INTERVAL_MS);
      (parentWatchdog as { unref?: () => void } | null)?.unref?.();
    }
  }

  return { drainThenShutdown, stopWatchdog };
}

/**
 * Signal-0 process-liveness probe (`process.kill(pid, 0)` — existence
 * check only, no signal delivered; OpenProcess under the hood on
 * Windows). EPERM means the PID exists but we lack rights to signal it
 * — that is still "alive" for watchdog purposes. Exported for direct
 * unit testing of the Windows watchdog path.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolve the live parent PID from the kernel (not the cached startup
 * value). Both Node and Bun expose `process.ppid` as a property captured
 * at process creation, so it does NOT update when the kernel re-parents
 * us to a new ancestor after the original parent dies — which is the
 * exact event the watchdog needs to detect. Empirical evidence on
 * macOS / Bun 1.3.12: `process.ppid` stays at the original parent ID
 * indefinitely while `ps -o ppid= -p $$` reports the new parent within
 * one tick.
 *
 * Windows has no `ps` — the original ps-only implementation made the
 * startup probe fail on every Windows host, so the watchdog was always
 * disabled and an orphaned serve (e.g. its cmd.exe .bat wrapper killed
 * by the MCP host without closing stdin) held the PGLite write lock
 * indefinitely. But Windows also never re-parents orphans, so the
 * cached `process.ppid` stays correct for the process's lifetime and
 * the question inverts from "did the live PPID change?" to "is the
 * original parent still alive?" — answered in-process via signal-0,
 * no external binary needed. Parent dead → report 0 (kernel PID 0 is
 * the System Idle Process, never our parent), which differs from
 * `initialParentPid` and fires the watchdog. Known degraded mode:
 * Windows recycles PIDs aggressively, so a reused parent PID can mask
 * a death — stdin EOF / signals remain the primary shutdown channels
 * and the watchdog stays the backstop, same posture as POSIX.
 *
 * Cost: ~10ms per ps spawn on POSIX, effectively free on Windows.
 * Called every 5s (PARENT_WATCHDOG_INTERVAL_MS), so amortized < 0.5%
 * CPU. Falls back to `process.ppid` if `ps` fails (best-effort safety
 * net for stripped-down containers, etc.); the startup probe at
 * watchdog-install time loud-logs and skips the interval entirely when
 * no mechanism is available, so a per-tick fallback is a redundant
 * safety net rather than a primary mechanism.
 *
 * `platform` is a test seam (defaults to the real platform) so CI on
 * any OS can exercise both branches — signal-0 works everywhere.
 */
export function readLiveParentPid(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') {
    return isPidAlive(process.ppid) ? process.ppid : 0;
  }
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(process.pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const n = parseInt(r.stdout.trim(), 10);
      if (Number.isInteger(n) && n >= 0) return n;
    }
  } catch {
    /* fall through */
  }
  return process.ppid;
}

/**
 * One-shot probe at watchdog-install time to confirm the platform's
 * parent-liveness mechanism actually works on this host. POSIX: true
 * iff `spawnSync('ps','-o','ppid=','-p',PID)` exits 0 with a parseable
 * integer. Windows: true iff signal-0 succeeds against our own PID
 * (always alive — verifies the mechanism, not the parent). When it
 * returns false, the caller skips installing the watchdog and emits a
 * loud stderr line — the operator sees "watchdog disabled" instead of
 * an installed-but-never-fires phantom.
 *
 * Why a separate probe rather than relying on the per-tick fallback in
 * `readLiveParentPid`: the per-tick fallback returns the cached
 * `process.ppid` silently, so the watchdog runs every 5s, compares
 * cached PPID to itself, never detects a change, and never fires —
 * while still claiming to be active. The probe surfaces the gap once
 * at install time and lets the caller short-circuit cleanly.
 */
export function probeWatchdogAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    return isPidAlive(process.pid);
  }
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(process.pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return false;
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isInteger(n) && n >= 0;
  } catch {
    return false;
  }
}
