/**
 * Reap zombie child processes.
 *
 * Bun (like Node) only auto-reaps child processes when a SIGCHLD handler is
 * installed. Without this, child processes spawned by the worker (embed
 * batches, shell jobs, sub-agents) become zombies when they exit,
 * accumulating in the PID table and (in the original production cascade)
 * holding phantom DB connection slots.
 *
 * A no-op handler is sufficient — the runtime calls waitpid() internally as
 * long as a listener is registered. EventEmitter does NOT dedupe listeners by
 * reference; the includes() check below is what prevents duplicate listeners
 * across hot-import scenarios (test harnesses re-importing modules in the
 * same process).
 */

import { readdirSync, readFileSync } from 'node:fs';

const reapHandler = () => {};

export function installSigchldHandler(): void {
  // SIGCHLD is POSIX-only. On Windows, `process.on('SIGCHLD', ...)` throws
  // "ENOTSUP" because Windows doesn't have signals. Guard by platform so a
  // future Windows port of any gbrain CLI doesn't crash at boot.
  if (process.platform === 'win32') return;
  if (!process.listeners('SIGCHLD').includes(reapHandler)) {
    process.on('SIGCHLD', reapHandler);
  }
}

/**
 * Test-only: removes the handler so other test files in the same shard
 * process don't observe a pre-installed listener. Call from `afterAll` in
 * `test/zombie-reap.test.ts`.
 */
export function _uninstallSigchldHandlerForTests(): void {
  process.removeListener('SIGCHLD', reapHandler);
}

/**
 * #2443: PID-1 orphan reaper.
 *
 * The SIGCHLD handler above only makes the runtime reap its OWN children.
 * When gbrain runs as PID 1 (a container entrypoint: `gbrain serve`,
 * `gbrain jobs supervisor start`), the kernel re-parents every orphaned
 * grandchild (e.g. `git` spawned by a worker that died) onto us — and
 * nothing waits on them. The zombies accumulate until the cgroup pids.max
 * is exhausted and fork starts failing with EAGAIN.
 *
 * We can't blanket `waitpid(-1)` on SIGCHLD: that races the runtime's own
 * per-child reaping and can steal exit statuses from Bun.spawn /
 * child_process (exit events never fire → hangs). Instead: a periodic
 * /proc sweep collects Z-state children of PID 1 and only reaps a pid seen
 * in TWO consecutive sweeps. The runtime reaps its own children within
 * milliseconds of exit, so anything still a zombie a full sweep interval
 * later is an orphan (or native-spawned) that only we can collect.
 * waitpid targets the specific pid with WNOHANG, so a mistaken candidate
 * costs nothing.
 *
 * Linux-only by construction (/proc + the container PID-1 scenario).
 * Running under an init like tini/`docker run --init` remains the
 * recommended deployment (see docs/mcp/DEPLOY.md); this is the in-process
 * backstop for images that don't.
 */

/** Parse one /proc/<pid>/stat line → { pid, state, ppid }, or null. */
export function parseProcStatLine(stat: string): { pid: number; state: string; ppid: number } | null {
  // Format: `pid (comm) state ppid ...` — comm may contain spaces and
  // parens, so split on the LAST ')'.
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const pid = parseInt(stat.slice(0, stat.indexOf(' ')), 10);
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  if (!Number.isFinite(pid) || rest.length < 2) return null;
  const ppid = parseInt(rest[1], 10);
  if (!Number.isFinite(ppid)) return null;
  return { pid, state: rest[0], ppid };
}

/** List Z-state children of this process by walking /proc. Linux only. */
function listZombieChildrenViaProc(selfPid: number): number[] {
  const out: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const parsed = parseProcStatLine(readFileSync(`/proc/${entry}/stat`, 'utf8'));
      if (parsed && parsed.state === 'Z' && parsed.ppid === selfPid) out.push(parsed.pid);
    } catch {
      // Process vanished mid-walk — fine.
    }
  }
  return out;
}

/** Lazily-loaded libc waitpid via bun:ffi. null = unavailable (not Bun / no libc match). */
let cachedWaitpid: ((pid: number) => void) | null | undefined;
async function loadWaitpid(): Promise<((pid: number) => void) | null> {
  if (cachedWaitpid !== undefined) return cachedWaitpid;
  cachedWaitpid = null;
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const candidates = process.platform === 'darwin'
      ? ['libSystem.dylib']
      : ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1'];
    for (const name of candidates) {
      try {
        const lib = dlopen(name, {
          waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        });
        const status = new Int32Array(1);
        const WNOHANG = 1;
        cachedWaitpid = (pid: number) => { lib.symbols.waitpid(pid, ptr(status), WNOHANG); };
        break;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // Not running under Bun — no FFI, reaper stays inert.
  }
  return cachedWaitpid;
}

export interface OrphanReaperSweeper {
  /** Run one sweep. Exposed so tests can drive it deterministically. */
  sweep: () => Promise<void>;
}

/**
 * Two-sweep-confirmation sweeper core (exported for tests; seams replace
 * the /proc walk and the FFI waitpid).
 */
export function createOrphanSweeper(
  listZombieChildren: () => number[],
  reapPid: (pid: number) => void,
): OrphanReaperSweeper {
  let pendingFromLastSweep = new Set<number>();
  return {
    sweep: async () => {
      const zombies = listZombieChildren();
      const next = new Set<number>();
      for (const pid of zombies) {
        if (pendingFromLastSweep.has(pid)) {
          try { reapPid(pid); } catch { /* best effort */ }
        } else {
          next.add(pid);
        }
      }
      pendingFromLastSweep = next;
    },
  };
}

export interface InstallOrphanReaperOpts {
  /** Test seams. */
  pid?: number;
  platform?: NodeJS.Platform;
  intervalMs?: number;
  listZombieChildren?: () => number[];
  reapPid?: (pid: number) => void;
}

const ORPHAN_SWEEP_INTERVAL_MS = 30_000;

/**
 * Install the PID-1 orphan reaper. No-op (returns null) unless this process
 * is PID 1 on Linux. Returns a stop function otherwise. The interval is
 * unref'd so it never keeps the process alive.
 */
export function installPid1OrphanReaper(opts: InstallOrphanReaperOpts = {}): (() => void) | null {
  const pid = opts.pid ?? process.pid;
  const platform = opts.platform ?? process.platform;
  if (pid !== 1 || platform !== 'linux') return null;

  const list = opts.listZombieChildren ?? (() => listZombieChildrenViaProc(pid));
  const sweeper = createOrphanSweeper(list, (zombiePid) => {
    if (opts.reapPid) {
      opts.reapPid(zombiePid);
      return;
    }
    void loadWaitpid().then((waitpid) => { waitpid?.(zombiePid); });
  });

  const timer = setInterval(() => { void sweeper.sweep(); }, opts.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
