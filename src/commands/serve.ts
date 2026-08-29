import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../core/engine.ts';
import { isEngineDegraded as isEngineDegradedForServe } from '../core/degraded-marker.ts';
import { startMcpServer, stdioRpcsInFlightCount } from '../mcp/server.ts';
import { VERB_NAMES } from '../core/verbs.ts';
import { redirectStdoutLoggingToStderr } from '../core/console-prefix.ts';
import {
  installLoopStallWatchdog,
  resolveServeStallWatchdogMs,
  SERVE_STALL_WATCHDOG_ENV,
  STALL_DEFAULT_GRACE_MS,
  type LoopStallWatchdogOpts,
  type WatchdogHandle,
} from '../core/process-watchdog.ts';
// #4409: serve-sync-runner is deliberately NOT imported statically. The #4362
// static import put its 370-line module (plus dependency graph) on EVERY serve
// boot — heavy enough for a one-shot client's stdin EOF to win the race against
// the first tool-call response on the plugin path — and it defeated the
// GBRAIN_SERVE_SYNC_IPC=0 kill switch (mcp/server.ts guards only ITS dynamic
// import). The three consumers below (shutdown chain, idle sweep) load it
// lazily; a never-loaded runner trivially has no delegated sync running.
// Guarded by test/serve-stdin-eof-drain.test.ts's source-text check.
type ServeSyncRunnerModule = typeof import('../core/serve-sync-runner.ts');
const loadSyncRunner = (): Promise<ServeSyncRunnerModule> => import('../core/serve-sync-runner.ts');

// Maximum time the stdio path will wait for engine.disconnect() (PGLite
// close + advisory lock release) before forcing exit. Keeps a wedged
// disconnect from trapping the process forever; the abandoned lock dir is
// already covered by the in-process stale-lock check (acquireLock walks
// the dir, sees a dead PID, and removes it).
const CLEANUP_DEADLINE_MS = 5_000;

// Boot-readiness deadline (#3273). A serve process that wedges mid-boot
// (e.g. an MCP boot step that never completes because a configured
// upstream is unreachable) holds the PGLite write lock indefinitely: the
// post-#2348 lock discipline never steals from a live holder, so every
// CLI consumer times out until someone hunts down and kills the PID. If
// startMcpServer hasn't finished connecting the transport within this
// window, we release the engine (dropping the lock) and exit non-zero so
// a supervisor can restart with backoff. Env-tunable via
// GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS; 0 disables.
const DEFAULT_BOOT_TIMEOUT_SECONDS = 60;

// How often the parent-process watchdog polls the live kernel parent PID
// (via `readLiveParentPid`, NOT the cached `process.ppid` — see that
// helper's comment). We don't receive a signal when our parent dies (the
// kernel just re-parents us to init / launchd / a subreaper-PID), so
// polling is the only reliable way to detect "parent went away without
// closing stdin". 5s matches the cadence in the concurrent #591 PR;
// faster polling has no benefit, slower would extend the lock-leak window.
const PARENT_WATCHDOG_INTERVAL_MS = 5_000;

// Idle maintenance sweep [ENG-5]: cadence of the stdin-inactivity check.
// Each tick that saw NO stdin data since the previous tick runs a bounded
// sweep (fence reconcile / link+timeline extraction / corpus ingest — see
// src/core/sweep.ts). A tick that saw data just resets the flag, so the
// sweep fires after 10–20 min of true inactivity — the armIdle re-arm
// semantics expressed through the injectable deps.setInterval seam.
const IDLE_SWEEP_INTERVAL_MS = 10 * 60_000;

// Small per-run budget for idle sweeps: the serve must snap back to
// serving tool calls the moment the client wakes up.
const IDLE_SWEEP_BUDGET_MS = 3_000;

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
  startMcpServer?: (engine: BrainEngine, opts?: { surface?: 'verbs' | 'starter' | 'full'; sourceGuard?: boolean }) => Promise<void>;
  // Test seam for the parent-process watchdog. The default
  // (`readLiveParentPid`) reads the live kernel PPID via `ps` on POSIX
  // because `process.ppid` is captured at process creation and does not
  // refresh on re-parent (Node/Bun parity). On Windows — where the
  // kernel never re-parents, so the cached ppid stays correct — it
  // probes the original parent's liveness with signal-0 instead and
  // reports 0 once the parent is gone. Tests inject a stub so they can
  // simulate the parent dying without spawning ps or re-parenting any
  // real process.
  getParentPid?: () => number;
  // Test seam: replace setInterval/clearInterval so the watchdog can
  // fire deterministically in tests instead of waiting 5s. Defaults to
  // the global timer functions.
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  // Test seam for the one-shot watchdog readiness probe. The default
  // runs `spawnSync('ps', ['-o','ppid=','-p',PID])` on POSIX (signal-0
  // against our own PID on Windows) and returns true on success. Tests
  // inject a stub to simulate ps unavailability (e.g.
  // stripped containers, busybox without procps) without modifying PATH.
  // When the probe returns false, `installStdioLifecycle` skips the
  // watchdog interval entirely and emits a loud stderr line. Without
  // the probe, the original PR's behavior was a silent no-op: every
  // tick fell through to the cached `process.ppid` and the watchdog
  // never fired, while still claiming to be installed.
  probeWatchdog?: () => boolean;
  // v0.34.1 (#870): test seam for the MCP_STDIO=1 piped-stdin guard.
  // When true, runServe skips the stdin 'end'/'close' shutdown hooks
  // because the wrapping gateway (OpenClaw bundle-mcp, others) pipes the
  // JSON-RPC handshake and closes stdin immediately. Signal handlers and
  // transport.onclose still cover legitimate shutdown.
  // Defaults to `process.env.MCP_STDIO === '1'` when omitted.
  mcpStdio?: boolean;
  // Test seam for the boot-readiness deadline (#3273). Milliseconds.
  // Defaults to GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS (seconds; 60 when
  // unset, 0 disables) when omitted.
  bootTimeoutMs?: number;
  // Test seam for the idle maintenance sweep [ENG-5]. Replaces the sweep
  // body so unit tests can assert timer wiring without importing the real
  // sweep core (which opens engine work). Defaults to a lazy-imported
  // runMaintenanceSweep with a small budget.
  sweep?: (engine: BrainEngine) => Promise<unknown>;
  // Kill switch seam for the idle sweep. Defaults to
  // `process.env.GBRAIN_SWEEP !== '0'` when omitted.
  sweepEnabled?: boolean;
  // Test seam for the --http lane (#4281): replaces the dynamically imported
  // runServeHttp so the stall-watchdog arm/dispose ordering can be asserted
  // without booting the real OAuth server. Type-only reference to
  // serve-http.ts — erased at compile time, so the lazy runtime import stays.
  runServeHttp?: (typeof import('./serve-http.ts'))['runServeHttp'];
  // Test seam (#4281): replaces installLoopStallWatchdog.
  installStallWatchdog?: (o: LoopStallWatchdogOpts) => WatchdogHandle;
  // Test seam (#4281) for the loop-stall threshold in ms; 0 = off. Defaults
  // to resolveServeStallWatchdogMs(GBRAIN_SERVE_STALL_WATCHDOG_MS) — opt-in,
  // 15s floor, garbage values warn and stay off.
  stallWatchdogMs?: number;
  // Test seam (#4409): live in-flight stdio RPC count consulted by the
  // stdin-EOF drain. Defaults to mcp/server.ts's stdioRpcsInFlightCount.
  pendingRpcs?: () => number;
  // Test seam (#4409): stdin-EOF drain bound in ms; 0 = immediate shutdown
  // (pre-#4409 behavior). Defaults to GBRAIN_SERVE_EOF_DRAIN_MS (30s when
  // unset; lenient parse).
  eofDrainMs?: number;
}

/**
 * Teardown for the HTTP serve path, reached once the server lifecycle resolves.
 *
 * `serve` deliberately skips both `finishCliTeardown` and the force-exit seam,
 * so simply returning here leaves the never-disconnected engine's handles
 * keeping an orphaned process alive — port released, but the PID still owning
 * the PGLite write lock, which blocks every later CLI write. Disconnect first
 * (checkpoint / pool drain) so the store is not left needing recovery, raced
 * against the same deadline the stdio path uses in case a wedged WASM close
 * would otherwise trap us.
 *
 * Extracted and seam-injected because this — not the socket severing in
 * serve-http.ts — is the half that actually closes the orphan, and it was
 * previously unreachable from a test.
 *
 * ponytail: on SIGTERM this races process-cleanup's own exit(143) and loses,
 * because that path does not await a disconnect. That is the outcome we want.
 * Plumb a settle-reason through `runServeHttp` if it ever needs to be
 * guaranteed rather than merely reliable.
 */
export async function finishHttpServe(
  engine: Pick<BrainEngine, 'disconnect'>,
  opts: Pick<ServeOptions, 'exit' | 'log'> & { deadlineMs?: number } = {},
): Promise<void> {
  const exit = opts.exit ?? ((code?: number) => process.exit(code));
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const deadlineMs = opts.deadlineMs ?? CLEANUP_DEADLINE_MS;

  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const deadline = setTimeout(() => {
    log(`GBrain MCP server: cleanup deadline (${deadlineMs}ms) exceeded — forcing exit`);
    exitOnce(0);
  }, deadlineMs);
  deadline.unref?.();

  try {
    await engine.disconnect();
  } catch (err: unknown) {
    log(`GBrain MCP server: cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(deadline);
  // `process.exit` never returns, so the guard is inert in production. It
  // matters for the injected seam: a disconnect that outlives the deadline
  // must not exit a second time.
  exitOnce(0);
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

  // MEMORY_VERBS v1: tool-surface mode. Flag > config `mcp_surface` > 'full'.
  // 'verbs' exposes exactly the seven protocol verbs (the quickstart surface);
  // 'starter' the ~20-op daily-driver set; 'full' (default) keeps every
  // operation — existing installs see no change.
  const { parseSurfaceFlag, resolveSurface } = await import('../mcp/surface.ts');
  const { loadConfig } = await import('../core/config.ts');
  const surface = resolveSurface(parseSurfaceFlag(args), loadConfig());

  // --source-guard (plugin lanes, EV1): fail-closed write routing for
  // user-global serves whose cwd is meaningless (plugin snapshots). Write/
  // admin ops error actionably unless the source resolution tier proves the
  // binding is deliberate or unambiguous — sole-source brains are a pure
  // no-op. Stdio-only: the OAuth HTTP path scopes writes per token instead.
  const sourceGuard = args.includes('--source-guard');
  if (sourceGuard && isHttp) {
    // Loud posture warning (the --log-full-params precedent): the guard is a
    // stdio-lane mechanism; HTTP writes are scoped per token instead. An
    // operator who passed the flag believing fail-closed routing is active
    // must not discover otherwise silently.
    console.error(
      '[gbrain serve] WARNING: --source-guard applies to the stdio lane only and is IGNORED with --http — ' +
        'HTTP writes are scoped by per-token grants (access_tokens.permissions), not the tier guard.',
    );
  }

  if (isHttp) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3131 : 3131;

    const ttlIdx = args.indexOf('--token-ttl');
    const tokenTtl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1]) || 3600 : 3600;

    // #1353: --enable-dcr-insecure opts into the consent-bypassing
    // client_credentials grant on the DCR path. It implies --enable-dcr (you
    // can't allow insecure DCR clients without DCR). Plain --enable-dcr keeps
    // the secure default: DCR clients are authorization_code (consent-bearing).
    const enableDcrInsecure = args.includes('--enable-dcr-insecure');
    const enableDcr = args.includes('--enable-dcr') || enableDcrInsecure;

    const publicUrlIdx = args.indexOf('--public-url');
    const publicUrl = publicUrlIdx >= 0 ? args[publicUrlIdx + 1] : undefined;

    // F8 escape hatch: --log-full-params writes raw payloads to mcp_request_log
    // and the admin SSE feed instead of redacted summaries. Off by default
    // (privacy-first); operators running gbrain on their own laptop can flip
    // it on for debug visibility. Loud startup warning fires in serve-http.ts
    // when set so the posture change is visible in stderr.
    const logFullParams = args.includes('--log-full-params');

    // v0.34.1 (#864, D11): `--bind HOST` lets operators choose the network
    // interface to listen on. When unset, runServeHttp defaults to 127.0.0.1
    // (loopback) — server operators who need remote access pass
    // `--bind 0.0.0.0` (or a specific interface IP). `bind` is intentionally
    // left undefined here when the flag is absent so the WARN-on-public-url
    // path in serve-http can distinguish "operator chose loopback explicitly"
    // from "operator didn't set the flag at all."
    const bindIdx = args.indexOf('--bind');
    const bind = bindIdx >= 0 ? args[bindIdx + 1] : undefined;

    // v0.36.x #1024: suppress the printed admin bootstrap token. Pair with
    // GBRAIN_ADMIN_BOOTSTRAP_TOKEN for production deployments that don't
    // want the value leaking into log aggregators on every supervisor
    // restart.
    const suppressBootstrapToken = args.includes('--suppress-bootstrap-token');

    // #2624: by default the generated token only prints on an interactive
    // TTY (never into container log storage). --print-admin-token forces the
    // raw value even on a non-TTY start.
    const printAdminToken = args.includes('--print-admin-token');

    // `??` short-circuits, so the real module only loads when no seam is injected.
    const runHttp = opts.runServeHttp ?? (await import('./serve-http.ts')).runServeHttp;

    // Loop-stall watchdog (#4281): opt-in via GBRAIN_SERVE_STALL_WATCHDOG_MS.
    // A serve wedged in a synchronous spin can't answer requests OR run its
    // own SIGTERM cleanup (process-cleanup.ts needs a live loop), so it holds
    // the PGLite write lock hostage — the serve-shaped twin of the #1633 sync
    // incident. The watchdog worker (own OS thread) is petted by the main
    // loop; sustained lag ≥ stall latches one SIGTERM (graceful chance),
    // lag ≥ stall+grace SIGKILLs. Armed around runServeHttp ONLY: the stdio
    // lane has its own lifecycle above, and finishHttpServe below carries its
    // own cleanup deadline.
    const httpLog = opts.log ?? ((msg: string) => console.error(msg));
    const stallMs = opts.stallWatchdogMs ?? resolveServeStallWatchdogMs(process.env[SERVE_STALL_WATCHDOG_ENV], httpLog);
    let stallWatchdog: WatchdogHandle | null = null;
    if (stallMs > 0) {
      const installStall = opts.installStallWatchdog ?? installLoopStallWatchdog;
      stallWatchdog = installStall({ stallMs, graceMs: STALL_DEFAULT_GRACE_MS, label: 'serve-http-stall', onWarn: httpLog });
      if (stallWatchdog.active) {
        httpLog(
          `[serve-http-stall] loop-stall watchdog armed: SIGTERM after ${stallMs}ms of main-loop stall, ` +
          `SIGKILL ${STALL_DEFAULT_GRACE_MS}ms later (${SERVE_STALL_WATCHDOG_ENV}; 0 disables)`,
        );
      }
    }

    try {
      await runHttp(engine, { port, tokenTtl, enableDcr, enableDcrInsecure, publicUrl, logFullParams, bind, suppressBootstrapToken, printAdminToken, surface });
    } finally {
      stallWatchdog?.dispose();
    }

    await finishHttpServe(engine, opts);
    return;
  }

  // stdio path — install lifecycle handlers BEFORE startMcpServer so that
  // an early stdin EOF (parent died before our first read) can still
  // trigger graceful release of the PGLite write lock held by `engine`.
  // The HTTP / OAuth path above has its own lifecycle in serve-http.ts
  // and is intentionally NOT wired into this stdio plumbing.
  console.error(
    surface === 'verbs'
      // v0.45.7: count derives from VERB_NAMES (7 with context_pack + delta)
      // so the banner can't drift from the frozen set again.
      ? `Starting GBrain MCP server (stdio) — serving ${VERB_NAMES.length} memory verbs (MEMORY_VERBS v1)...`
      : 'Starting GBrain MCP server (stdio)...',
  );

  // stdout is reserved for JSON-RPC frames from here on. Ops that run
  // in-process (sync_brain -> performSync -> embed --stale) emit progress
  // via slog/console.log, which would otherwise land on stdout and make
  // the MCP client log "Failed to parse JSONRPC message" for every line.
  redirectStdoutLoggingToStderr();

  installStdioLifecycle(engine, args, opts);

  const start = opts.startMcpServer ?? startMcpServer;

  // Boot-readiness deadline (#3273): never sit on the PGLite write lock
  // forever with a boot that never completes. On expiry: log, release the
  // engine (drops the lock), exit non-zero so supervisors restart with
  // backoff. The disconnect itself is raced against CLEANUP_DEADLINE_MS,
  // same as the graceful-shutdown path, so a wedged WASM close can't trap
  // us either.
  const bootTimeoutMs = opts.bootTimeoutMs ?? resolveBootTimeoutMs();
  let bootDeadline: ReturnType<typeof setTimeout> | null = null;
  if (bootTimeoutMs > 0) {
    const log = opts.log ?? ((msg: string) => console.error(msg));
    const exit = opts.exit ?? ((code?: number) => { process.exit(code); });
    bootDeadline = setTimeout(() => {
      log(
        `GBrain MCP server: boot did not complete within ${bootTimeoutMs}ms — releasing DB lock and exiting so other consumers unblock (check configured provider endpoints; tune via GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS, 0 disables)`,
      );
      const cleanup = setTimeout(() => { exit(1); }, CLEANUP_DEADLINE_MS);
      cleanup.unref?.();
      Promise.resolve()
        .then(() => engine.disconnect())
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`GBrain MCP server: boot-deadline cleanup error: ${msg}`);
        })
        .finally(() => {
          clearTimeout(cleanup);
          exit(1);
        });
    }, bootTimeoutMs);
    bootDeadline.unref?.();
  }

  try {
    await start(engine, { surface, ...(sourceGuard ? { sourceGuard } : {}) });
  } finally {
    if (bootDeadline) clearTimeout(bootDeadline);
  }
  // startMcpServer's `await server.connect(transport)` resolves once the
  // SDK has wired up its stdin 'data' listener; that listener keeps the
  // event loop alive. We deliberately do NOT add `await new Promise(() =>
  // {})` here — it would block this async frame and stop the lifecycle
  // hooks from being able to call process.exit() cleanly.
}

// #4409: stdin-EOF drain bound. Long enough for a real tool call (a query
// with embedding + LLM expansion) to finish; short enough that a genuinely
// wedged handler can't pin the PGLite lock forever after the parent left.
const DEFAULT_EOF_DRAIN_MS = 30_000;

// Env resolution for the stdin-EOF drain bound. Lenient like
// resolveBootTimeoutMs: a typo'd env var must not turn the data-loss fix
// into a shutdown failure. 0 disables the drain (immediate exit).
function resolveEofDrainMs(): number {
  const raw = process.env.GBRAIN_SERVE_EOF_DRAIN_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EOF_DRAIN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `[gbrain serve] ignoring invalid GBRAIN_SERVE_EOF_DRAIN_MS=${JSON.stringify(raw)} — using default ${DEFAULT_EOF_DRAIN_MS}ms`,
    );
    return DEFAULT_EOF_DRAIN_MS;
  }
  return Math.floor(n);
}

// Env resolution for the boot deadline. Lenient (warn + default) rather
// than throw: this is an incident-time escape hatch, and a typo'd env var
// must not turn a boot-safety net into a boot failure of its own.
function resolveBootTimeoutMs(): number {
  const raw = process.env.GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BOOT_TIMEOUT_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `[gbrain serve] ignoring invalid GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS=${JSON.stringify(raw)} — using default ${DEFAULT_BOOT_TIMEOUT_SECONDS}s`,
    );
    return DEFAULT_BOOT_TIMEOUT_SECONDS * 1000;
  }
  return n * 1000;
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
  let idleSweepTimer: unknown = null;
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

    // Stop the idle-sweep interval too [ENG-5] — a sweep must never start
    // while the engine is being disconnected underneath it.
    if (idleSweepTimer !== null) {
      deps.clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }

    deps.log(`GBrain MCP server: graceful exit (${reason})`);

    // Race the cleanup against a deadline. engine.disconnect() does a
    // PGLite WASM close + a synchronous rmSync on the lock dir; both
    // should be sub-second, but a wedged WASM runtime shouldn't be able
    // to trap us forever. If we hit the deadline we still exit; the
    // lock dir is advisory and the next process's stale-lock check
    // (process.kill(pid, 0) → ESRCH) will reclaim it.
    // A running delegated sync extends the deadline by exactly its settle
    // bound: shutdownDelegatedSync must finish its abort+settle against the
    // live engine BEFORE disconnect, and a fixed 5s would force-exit mid-
    // settle (second-outside-voice finding EV1). #4409: the runner loads
    // lazily inside the chain (module-cache hit when a sync ever ran; a
    // fresh load trivially reports no sync running), so the deadline arms
    // at the base bound first and re-arms with the settle extension once
    // the runner state is known.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = (ms: number): void => {
      deadline = setTimeout(() => {
        deps.log(
          `GBrain MCP server: cleanup deadline (${ms}ms) exceeded — forcing exit`,
        );
        deps.exit(0);
      }, ms);
      deadline.unref?.();
    };
    armDeadline(CLEANUP_DEADLINE_MS);

    Promise.resolve()
      // Idempotent shared promise — mcp/server.ts's shutdown races here on
      // the same signals; whichever runs first does the abort+settle, the
      // other awaits it. Must precede disconnect (settle writes need the
      // live engine; the disconnect-mode drain is allowAbort:false).
      .then(() => loadSyncRunner())
      .then((runner) => {
        if (runner.isDelegatedSyncRunning()) {
          if (deadline) clearTimeout(deadline);
          armDeadline(CLEANUP_DEADLINE_MS + runner.delegatedSyncSettleMs());
        }
        return runner.shutdownDelegatedSync();
      })
      .then(() => engine.disconnect())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`GBrain MCP server: cleanup error: ${msg}`);
      })
      .finally(() => {
        if (deadline) clearTimeout(deadline);
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
  // v0.34.1 (#870): when MCP_STDIO=1, the wrapping gateway pipes the
  // JSON-RPC handshake then closes its stdin half. Treating that as a
  // permanent disconnect kills the server before the first tool call.
  // Signal handlers (SIGTERM/SIGINT/SIGHUP), transport.onclose, and the
  // parent-process watchdog below still cover legitimate shutdown paths.
  // `mcpStdio` is the injectable form; default reads the env once at
  // install time so tests stay isolated (no process.env mutation).
  const mcpStdioMode = opts.mcpStdio ?? (process.env.MCP_STDIO === '1');
  // #4409: a one-shot MCP client writes its frames and closes stdin
  // immediately. Node delivers 'end' AFTER all 'data' events, and the SDK
  // parses every received frame synchronously during 'data' (handler start
  // is queued as a microtask) — so at EOF time requests can be in flight
  // with no response written yet. Treating EOF as an immediate shutdown
  // silently dropped those responses (the codex-plugin door went red on
  // exactly this shape). Drain in-flight RPCs — bounded — before the
  // graceful exit; idle servers still exit promptly (one timer tick).
  // GBRAIN_SERVE_EOF_DRAIN_MS tunes the bound; 0 restores immediate exit.
  const pendingRpcs = opts.pendingRpcs ?? stdioRpcsInFlightCount;
  const eofDrainMs = opts.eofDrainMs ?? resolveEofDrainMs();
  let eofDrainStarted = false;
  const drainThenShutdown = (reason: string): void => {
    if (shuttingDown || eofDrainStarted) return;
    eofDrainStarted = true;
    void (async () => {
      if (eofDrainMs > 0) {
        // One macrotask so already-parsed requests' handlers (microtasks)
        // start and increment the counter before the first check.
        await new Promise<void>((r) => setTimeout(r, 0));
        if (pendingRpcs() > 0) {
          deps.log(
            `GBrain MCP server: stdin EOF with ${pendingRpcs()} in-flight request(s) — draining before exit (bound ${eofDrainMs}ms; GBRAIN_SERVE_EOF_DRAIN_MS)`,
          );
          const deadlineAt = Date.now() + eofDrainMs;
          while (pendingRpcs() > 0 && Date.now() < deadlineAt && !shuttingDown) {
            await new Promise<void>((r) => setTimeout(r, 25));
          }
        }
        // One extra macrotask: the SDK sends the response in a .then AFTER
        // the handler resolves — let that stdout write get issued before
        // the cleanup chain starts.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      beginShutdown(reason);
    })();
  };
  if (!deps.stdin.isTTY && !mcpStdioMode) {
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
        '[gbrain serve] watchdog disabled: no parent-liveness mechanism (ps / signal-0 probe failed) — child will rely on stdin EOF / signals only',
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

  // Idle maintenance sweep [ENG-5]: every IDLE_SWEEP_INTERVAL_MS tick that
  // saw no stdin data since the previous tick runs one bounded sweep (small
  // budget). SEPARATE timer from the parent watchdog, through the same
  // injectable deps.setInterval seam, unref'd per the serve convention so
  // it can never hold the process open. Cleared in beginShutdown. Kill
  // switch: GBRAIN_SWEEP=0 (seam: opts.sweepEnabled). Chunk-level stdin
  // 'data' granularity is sufficient — same rationale as armIdle below.
  const sweepEnabled = opts.sweepEnabled ?? (process.env.GBRAIN_SWEEP !== '0');
  if (sweepEnabled) {
    const runIdleSweep = opts.sweep ?? (async (e: BrainEngine) => {
      // #4409: the runner loads lazily here too — the sweep fires after
      // 10-20 min of idle, well off the boot path this fix protects.
      const runner = await loadSyncRunner();
      // A delegated sync owns the event loop right now — sweeping under it
      // is pointless contention; the next idle tick catches up.
      if (runner.isDelegatedSyncRunning()) return;
      // Lazy import keeps the sweep core off the serve boot path.
      const { runMaintenanceSweep } = await import('../core/sweep.ts');
      await runMaintenanceSweep(e, {
        sourceId: process.env.GBRAIN_SOURCE || 'default',
        budgetMs: IDLE_SWEEP_BUDGET_MS,
      });
      // Deferred-embed drain: delegated syncs always run noEmbed (the #2139
      // cost gate lives in runSync); the lock owner closes that loop here.
      await runner.maybeDrainDeferredEmbeds(e);
    });
    let stdinSawData = false;
    let sweepInFlight = false;
    let dataListenerAttached = false;
    idleSweepTimer = deps.setInterval(() => {
      if (shuttingDown) return;
      if (!dataListenerAttached) {
        // Attach the activity listener LAZILY on the first tick. Attaching
        // a 'data' listener at install time would flip stdin into flowing
        // mode before the MCP SDK's transport attaches its own listener,
        // racing the JSON-RPC handshake bytes (this timer is default-ON,
        // unlike the opt-in --stdio-idle-timeout listener below). By the
        // first tick the transport is long live. No activity signal exists
        // for this first window yet, so treat it as active and re-arm.
        deps.stdin.on('data', () => { stdinSawData = true; });
        dataListenerAttached = true;
        return;
      }
      if (stdinSawData) { stdinSawData = false; return; } // active — re-arm
      if (sweepInFlight) return; // never overlap sweeps
      // Degraded mode (db-availability 4c): background sweeps must not burn
      // the min-interval reconnect budget — tool calls own recovery.
      if (isEngineDegradedForServe(engine)) return;
      sweepInFlight = true;
      Promise.resolve()
        .then(() => runIdleSweep(engine))
        .catch(() => { /* idle sweep is best-effort; never kill serve */ })
        .finally(() => { sweepInFlight = false; });
    }, IDLE_SWEEP_INTERVAL_MS);
    (idleSweepTimer as { unref?: () => void } | null)?.unref?.();
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
