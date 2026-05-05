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
// kernel just re-parents us to init / launchd), so polling is the only
// reliable way to detect "parent went away without closing stdin". 5s
// matches the cadence in the concurrent #591 PR; faster polling has no
// benefit, slower would extend the lock-leak window.
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

    const { runServeHttp } = await import('./serve-http.ts');
    await runServeHttp(engine, { port, tokenTtl, enableDcr, publicUrl });
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
  if (!deps.stdin.isTTY) {
    deps.stdin.once('end', () => beginShutdown('stdin-end'));
    deps.stdin.once('close', () => beginShutdown('stdin-close'));
  }

  // Parent-process watchdog. Some hosts (launchd, cron, certain MCP
  // gateways) terminate without closing stdin and without sending a
  // signal — the kernel just re-parents us to init (PID 1). Polling
  // is the only portable way to notice; see `readLiveParentPid` for why
  // we cannot rely on `process.ppid` (cached at process creation and
  // never refreshed on re-parent in Node or Bun). We capture the initial
  // parent at install time so a process that was *legitimately* started
  // under PID 1 (e.g. a systemd service) doesn't immediately shut itself
  // down. `unref()` keeps the interval from blocking other
  // exit paths.
  const initialParentPid = deps.getParentPid();
  if (initialParentPid !== 1) {
    parentWatchdog = deps.setInterval(() => {
      if (deps.getParentPid() === 1) {
        beginShutdown('parent-died');
      }
    }, PARENT_WATCHDOG_INTERVAL_MS);
    (parentWatchdog as { unref?: () => void } | null)?.unref?.();
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
 * us to PID 1 after the original parent dies — which is the exact event
 * the watchdog needs to detect. Empirical evidence on macOS / Bun 1.3.12:
 * `process.ppid` stays at the original parent ID indefinitely while
 * `ps -o ppid= -p $$` reports `1` within one tick.
 *
 * Cost: ~10ms per spawn. Called every 5s (PARENT_WATCHDOG_INTERVAL_MS),
 * so amortized < 0.5% CPU. Falls back to `process.ppid` if `ps` fails
 * (best-effort safety net for stripped-down containers, etc.).
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
