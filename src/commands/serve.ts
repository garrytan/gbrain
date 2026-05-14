import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

// Maximum time the stdio path will wait for engine.disconnect() (PGLite
// close + advisory lock release) before forcing exit. Keeps a wedged
// disconnect from trapping the process forever; the abandoned lock dir is
// already covered by the in-process stale-lock check (acquireLock walks
// the dir, sees a dead PID, and removes it).
const CLEANUP_DEADLINE_MS = 5_000;

// How often the parent-process watchdog polls the live kernel parent PID
// (via `readLiveParentPid`, NOT the cached `process.ppid` — see that
// helper's comment). We don't receive a signal when our parent dies (the
// kernel just re-parents us to init / launchd / a subreaper-PID), so
// polling is the only reliable way to detect "parent went away without
// closing stdin". 5s matches the cadence in the concurrent #591 PR;
// faster polling has no benefit, slower would extend the lock-leak window.
const PARENT_WATCHDOG_INTERVAL_MS = 5_000;

export interface ServeOptions {
  // Test seam — defaults to the live process. The lifecycle plumbing reads
  // these for stdin EOF detection, signal handlers, and exit, so unit
  // tests can drive end-to-end shutdown via mocked streams without
  // spawning a real Bun process. `exit` is typed as `void` (not `never`)
  // so test stubs that record + return are accepted without casts;
  // `process.exit`'s `never` return is assignable to `void`.
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  signals?: Pick<NodeJS.Process, 'on'>;
  exit?: (code?: number) => void;
  log?: (msg: string) => void;
  // Test seam: replace startMcpServer to avoid booting the real MCP SDK
  // (which unconditionally attaches a 'data' listener to real
  // process.stdin and would pollute the test runner's stdin handle).
  // Defaults to the real implementation when omitted.
  startMcpServer?: (engine: BrainEngine) => Promise<void>;
  // Test seam for the parent-process watchdog. The default
  // (`readLiveParentPid`) reads the live kernel PPID via `ps` because
  // `process.ppid` is captured at process creation and does not refresh
  // on re-parent (Node/Bun parity). Tests inject a stub so they can
  // simulate the parent dying without spawning ps or re-parenting any
  // real process.
  getParentPid?: () => number;
  // Test seam: replace setInterval/clearInterval so the watchdog can
  // fire deterministically in tests instead of waiting 5s. Defaults to
  // the global timer functions.
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  // Test seam for the one-shot watchdog readiness probe. The default
  // runs `spawnSync('ps', ['-o','ppid=','-p',PID])` and returns true on
  // success. Tests inject a stub to simulate ps unavailability (e.g.
  // stripped containers, busybox without procps) without modifying PATH.
  // When the probe returns false, `installStdioLifecycle` skips the
  // watchdog interval entirely and emits a loud stderr line. Without
  // the probe, the original PR's behavior was a silent no-op: every
  // tick fell through to the cached `process.ppid` and the watchdog
  // never fired, while still claiming to be installed.
  probeWatchdog?: () => boolean;
  // v0.34.0 (#870): test seam for the MCP_STDIO=1 piped-stdin guard.
  // When true, runServe skips the stdin 'end'/'close' shutdown hooks
  // because the wrapping gateway (OpenClaw bundle-mcp, others) pipes the
  // JSON-RPC handshake and closes stdin immediately. Signal handlers and
  // transport.onclose still cover legitimate shutdown.
  // Defaults to `process.env.MCP_STDIO === '1'` when omitted.
  mcpStdio?: boolean;
}

export async function runServe(
  engine: BrainEngine,
  args: string[] = [],
  opts: ServeOptions = {},
) {
  // v0.26+: --http dispatches to the full OAuth 2.1 server (serve-http.ts)
  // with admin dashboard, scope enforcement, SSE feed, and the requireBearerAuth
  // middleware. Master's simpler startHttpTransport from v0.22.7 is superseded
  // — the OAuth provider in serve-http.ts handles bearer auth via
  // verifyAccessToken with legacy access_tokens fallback (so v0.22.7 callers
  // that used `gbrain auth create` keep working unchanged).
  const isHttp = args.includes('--http');

  if (isHttp) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3131 : 3131;

    const ttlIdx = args.indexOf('--token-ttl');
    const tokenTtl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1]) || 3600 : 3600;

    const enableDcr = args.includes('--enable-dcr');

    const publicUrlIdx = args.indexOf('--public-url');
    const publicUrl = publicUrlIdx >= 0 ? args[publicUrlIdx + 1] : undefined;

    // F8 escape hatch: --log-full-params writes raw payloads to mcp_request_log
    // and the admin SSE feed instead of redacted summaries. Off by default
    // (privacy-first); operators running gbrain on their own laptop can flip
    // it on for debug visibility. Loud startup warning fires in serve-http.ts
    // when set so the posture change is visible in stderr.
    const logFullParams = args.includes('--log-full-params');

    // v0.34.0 (#864, D11): `--bind HOST` lets operators choose the network
    // interface to listen on. When unset, runServeHttp defaults to 127.0.0.1
    // (loopback) — server operators who need remote access pass
    // `--bind 0.0.0.0` (or a specific interface IP). `bind` is intentionally
    // left undefined here when the flag is absent so the WARN-on-public-url
    // path in serve-http can distinguish "operator chose loopback explicitly"
    // from "operator didn't set the flag at all."
    const bindIdx = args.indexOf('--bind');
    const bind = bindIdx >= 0 ? args[bindIdx + 1] : undefined;

    const { runServeHttp } = await import('./serve-http.ts');
    await runServeHttp(engine, { port, tokenTtl, enableDcr, publicUrl, logFullParams, bind });
    return;
  }

  // stdio path — install lifecycle handlers BEFORE startMcpServer so that
  // an early stdin EOF (parent died before our first read) can still
  // trigger graceful release of the PGLite write lock held by `engine`.
  // The HTTP / OAuth path above has its own lifecycle in serve-http.ts
  // and is intentionally NOT wired into this stdio plumbing.
  console.error('Starting GBrain MCP server (stdio)...');

  installStdioLifecycle(engine, args, opts);

  const start = opts.startMcpServer ?? startMcpServer;
  await start(engine);
  // startMcpServer's `await server.connect(transport)` resolves once the
  // SDK has wired up its stdin 'data' listener; that listener keeps the
  // event loop alive. We deliberately do NOT add `await new Promise(() =>
  // {})` here — it would block this async frame and stop the lifecycle
  // hooks from being able to call process.exit() cleanly.
}

interface StdioLifecycleDeps {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  signals: Pick<NodeJS.Process, 'on'>;
  exit: (code?: number) => void;
  log: (msg: string) => void;
  getParentPid: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  probeWatchdog: () => boolean;
}

function installStdioLifecycle(
  engine: BrainEngine,
  args: string[],
  opts: ServeOptions,
): void {
  const deps: StdioLifecycleDeps = {
    stdin: opts.stdin ?? process.stdin,
    signals: opts.signals ?? process,
    exit: opts.exit ?? ((code?: number) => { process.exit(code); }),
    log: opts.log ?? ((msg: string) => console.error(msg)),
    getParentPid: opts.getParentPid ?? readLiveParentPid,
    setInterval: opts.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
    clearInterval: opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)),
    probeWatchdog: opts.probeWatchdog ?? probeWatchdogAvailable,
  };

  let shuttingDown = false;
  let parentWatchdog: unknown = null;
  const beginShutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop the parent-watchdog interval as soon as a shutdown begins so
    // it cannot fire a redundant 'parent-died' shutdown while the first
    // one is still draining the cleanup chain.
    if (parentWatchdog !== null) {
      deps.clearInterval(parentWatchdog);
      parentWatchdog = null;
    }

    deps.log(`GBrain MCP server: graceful exit (${reason})`);

    // Race the cleanup against a deadline. engine.disconnect() does a
    // PGLite WASM close + a synchronous rmSync on the lock dir; both
    // should be sub-second, but a wedged WASM runtime shouldn't be able
    // to trap us forever. If we hit the deadline we still exit; the
    // lock dir is advisory and the next process's stale-lock check
    // (process.kill(pid, 0) → ESRCH) will reclaim it.
    const deadline = setTimeout(() => {
      deps.log(
        `GBrain MCP server: cleanup deadline (${CLEANUP_DEADLINE_MS}ms) exceeded — forcing exit`,
      );
      deps.exit(0);
    }, CLEANUP_DEADLINE_MS);
    deadline.unref?.();

    Promise.resolve()
      .then(() => engine.disconnect())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`GBrain MCP server: cleanup error: ${msg}`);
      })
      .finally(() => {
        clearTimeout(deadline);
        deps.exit(0);
      });
  };

  // Signal-based termination. SIGTERM: daemon ask. SIGINT: user Ctrl-C.
  // SIGHUP: terminal disconnect / daemon-style "reload" channels — Aragorn
  // observed real-world hosts (Claude Desktop on macOS, hermes-agent
  // restart) send these instead of closing stdin. All three get the same
  // graceful path; the idempotency guard absorbs duplicate signals.
  deps.signals.on('SIGTERM', () => beginShutdown('SIGTERM'));
  deps.signals.on('SIGINT', () => beginShutdown('SIGINT'));
  deps.signals.on('SIGHUP', () => beginShutdown('SIGHUP'));

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
  // v0.34.0 (#870): when MCP_STDIO=1, the wrapping gateway pipes the
  // JSON-RPC handshake then closes its stdin half. Treating that as a
  // permanent disconnect kills the server before the first tool call.
  // Signal handlers (SIGTERM/SIGINT/SIGHUP), transport.onclose, and the
  // parent-process watchdog below still cover legitimate shutdown paths.
  // `mcpStdio` is the injectable form; default reads the env once at
  // install time so tests stay isolated (no process.env mutation).
  const mcpStdioMode = opts.mcpStdio ?? (process.env.MCP_STDIO === '1');
  if (!deps.stdin.isTTY && !mcpStdioMode) {
    deps.stdin.once('end', () => beginShutdown('stdin-end'));
    deps.stdin.once('close', () => beginShutdown('stdin-close'));
  }

  // Parent-process watchdog. Some hosts (launchd, cron, certain MCP
  // gateways) terminate without closing stdin and without sending a
  // signal — the kernel just re-parents us to whichever ancestor is
  // still alive (PID 1, or any closer subreaper such as launchd, systemd,
  // tmux, or a parent shell with PR_SET_CHILD_SUBREAPER). Polling is the
  // only portable way to notice; see `readLiveParentPid` for why we
  // cannot rely on `process.ppid` (cached at process creation and never
  // refreshed on re-parent in Node or Bun).
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
  const initialParentPid = deps.getParentPid();
  if (initialParentPid !== 1) {
    if (!deps.probeWatchdog()) {
      deps.log(
        '[gbrain serve] watchdog disabled: ps unavailable, parent-death detection unavailable — child will rely on stdin EOF / signals only',
      );
    } else {
      parentWatchdog = deps.setInterval(() => {
        if (deps.getParentPid() !== initialParentPid) {
          beginShutdown('parent-died');
        }
      }, PARENT_WATCHDOG_INTERVAL_MS);
      (parentWatchdog as { unref?: () => void } | null)?.unref?.();
    }
  }

  // Optional idle-timeout safety net. Default OFF; opt-in via
  // `--stdio-idle-timeout <seconds>`. The flag is for the rare case where
  // the parent leaks the stdin pipe but never closes it (so 'end' never
  // fires) and never sends another message — we'd otherwise sit on the
  // PGLite lock forever. Off by default because most parents close
  // properly and an over-eager idle timeout would surprise long-poll
  // workloads.
  const idleTimeoutSec = parseStdioIdleTimeout(args);
  if (idleTimeoutSec > 0) {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => beginShutdown(`stdio-idle-timeout (${idleTimeoutSec}s)`),
        idleTimeoutSec * 1000,
      );
      idleTimer.unref?.();
    };
    armIdle();
    // Reset on every chunk. We can't observe SDK-parsed messages from
    // here, but every JSON-RPC frame causes a 'data' event on stdin, so
    // chunk-level granularity is sufficient.
    deps.stdin.on('data', armIdle);
    deps.log(`GBrain MCP server: stdio idle timeout = ${idleTimeoutSec}s`);
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
 * Cost: ~10ms per spawn. Called every 5s (PARENT_WATCHDOG_INTERVAL_MS),
 * so amortized < 0.5% CPU. Falls back to `process.ppid` if `ps` fails
 * (best-effort safety net for stripped-down containers, etc.); the
 * startup probe at watchdog-install time loud-logs and skips the
 * interval entirely when ps is unavailable, so a per-tick fallback is
 * a redundant safety net rather than a primary mechanism.
 */
function readLiveParentPid(): number {
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
 * One-shot probe at watchdog-install time to confirm ps actually works
 * on this host. Returns true iff `spawnSync('ps','-o','ppid=','-p',PID)`
 * exits 0 with a parseable integer. When it returns false, the caller
 * skips installing the watchdog and emits a loud stderr line — the
 * operator sees "watchdog disabled" instead of an installed-but-never-
 * fires phantom.
 *
 * Why a separate probe rather than relying on the per-tick fallback in
 * `readLiveParentPid`: the per-tick fallback returns the cached
 * `process.ppid` silently, so the watchdog runs every 5s, compares
 * cached PPID to itself, never detects a change, and never fires —
 * while still claiming to be active. The probe surfaces the gap once
 * at install time and lets the caller short-circuit cleanly.
 */
function probeWatchdogAvailable(): boolean {
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

function parseStdioIdleTimeout(args: string[]): number {
  const idx = args.indexOf('--stdio-idle-timeout');
  if (idx < 0) return 0;
  const raw = args[idx + 1];
  // Strict parsing — silent fallback to 0 turns an opt-in safety net into
  // a no-op when an operator typos the value (e.g. `--stdio-idle-timeout
  // 30s`). `Number()` rejects partial parses like `30junk` (returns NaN),
  // unlike `parseInt` which would silently accept it. A missing value
  // (`--stdio-idle-timeout` at end of args) and any non-integer / negative
  // value are surfaced as a CLI error before we install the timer.
  if (raw === undefined) {
    throw new Error(
      '--stdio-idle-timeout requires a non-negative integer (seconds). Got: (missing value)',
    );
  }
  // Reject empty / whitespace-only explicitly: `Number('')` is 0 in JS,
  // which would silently turn `--stdio-idle-timeout ""` into the
  // documented opt-out — the exact silent-fallback failure mode this
  // strict parser exists to prevent.
  if (raw.trim() === '') {
    throw new Error(
      '--stdio-idle-timeout requires a non-negative integer (seconds). Got: (blank value)',
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `--stdio-idle-timeout requires a non-negative integer (seconds). Got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
