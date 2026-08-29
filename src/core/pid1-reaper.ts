/**
 * PID-1 orphan zombie reaper (#2443).
 *
 * `gbrain serve` in a container frequently runs as PID 1 (image without
 * tini / `docker run --init`). PID 1 inherits every orphaned process in the
 * PID namespace: when a spawned worker's own child outlives it, the
 * grandchild re-parents to PID 1 and, on exit, becomes a zombie that the Bun
 * runtime will NEVER reap — the SIGCHLD handler in zombie-reap.ts only makes
 * the runtime waitpid() children Bun itself spawned and tracks. Orphan
 * zombies then accumulate in the PID table for the container's lifetime.
 *
 * Strategy: an unref'd interval (default 30s) scans `/proc/<pid>/stat` for
 * state 'Z' with ppid == self. A zombie must persist across TWO consecutive
 * scans before it is reaped — this never steals a Bun-tracked child's exit
 * (the runtime reaps its own within milliseconds of SIGCHLD, so a tracked
 * exit can't survive a 30s window). Confirmed zombies are reaped with
 * `waitpid(pid, NULL, WNOHANG)` through bun:ffi libc. Every step is
 * fail-open: a reaper bug must never take down the serve process, and a
 * failed dlopen simply disables reaping (the pre-fix behavior).
 *
 * Gates: linux + pid == 1 + `GBRAIN_PID1_REAP` not '0'/'false'. The real fix
 * remains a proper init (tini / `docker run --init`) — see
 * docs/mcp/DEPLOY.md — this is the in-process fallback for images without one.
 *
 * Tested in test/pid1-reaper.test.ts (fixture procDir + injected waitpid).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const WNOHANG = 1;

/** Injectable deps so tests never need a real /proc or libc. */
export interface Pid1ReaperDeps {
  /** proc filesystem root (default '/proc'). */
  procDir?: string;
  /** the reaper's own pid (default process.pid). */
  selfPid?: number;
  /** platform gate override (default process.platform). */
  platform?: NodeJS.Platform;
  /** reap syscall (default libc waitpid via bun:ffi, WNOHANG). */
  waitpid?: (pid: number) => void;
  /** scan cadence in ms (default 30_000). */
  intervalMs?: number;
}

/**
 * Scan `procDir` for zombie children of `selfPid`. Reads each numeric
 * entry's `stat` file: `<pid> (<comm>) <state> <ppid> …` — comm may contain
 * spaces/parens, so fields are taken after the LAST ')'. Fail-open per
 * entry (processes exit between readdir and read).
 */
export function scanZombieChildren(procDir: string, selfPid: number): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    try {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a readdir entry gated by /^\d+$/ two lines up (single numeric segment, no separators or ..); procDir is a trusted injectable ('/proc' default, test fixture dirs otherwise), never user input
      const raw = readFileSync(join(procDir, name, 'stat'), 'utf8');
      const close = raw.lastIndexOf(')');
      if (close < 0) continue;
      const fields = raw.slice(close + 1).trim().split(/\s+/);
      const state = fields[0];
      const ppid = Number(fields[1]);
      if (state === 'Z' && ppid === selfPid) out.push(pid);
    } catch {
      /* raced a process exit — skip */
    }
  }
  return out;
}

// Lazily-resolved libc waitpid. `undefined` = not attempted, `null` = failed
// (musl/glibc name miss, sandbox) → reaping disabled, fail-open.
let libcWaitpid: ((pid: number) => void) | null | undefined;

function defaultWaitpid(pid: number): void {
  if (libcWaitpid === undefined) {
    libcWaitpid = null;
    try {
      // bun:ffi is always present under Bun; dlopen may still fail (name
      // varies across glibc/musl) — try the common spellings, fail-open.
      const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
      for (const lib of ['libc.so.6', 'libc.so', 'libSystem.B.dylib']) {
        try {
          const handle = dlopen(lib, {
            waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
          });
          libcWaitpid = (p: number) => {
            handle.symbols.waitpid(p, null, WNOHANG);
          };
          break;
        } catch {
          /* try next name */
        }
      }
    } catch {
      /* no ffi — reaping disabled */
    }
  }
  try {
    libcWaitpid?.(pid);
  } catch {
    /* fail-open */
  }
}

/**
 * Build one reaper tick with 2-scan persistence: a pid is reaped only when
 * it was a zombie on the PREVIOUS scan and still is now. Returns the count
 * reaped (for tests/telemetry). Pure over its injected deps.
 */
export function createPid1ReaperTick(deps: {
  procDir: string;
  selfPid: number;
  waitpid: (pid: number) => void;
}): () => number {
  let pendingConfirm = new Set<number>();
  return () => {
    const zombies = scanZombieChildren(deps.procDir, deps.selfPid);
    let reaped = 0;
    const nextPending = new Set<number>();
    for (const pid of zombies) {
      if (pendingConfirm.has(pid)) {
        try {
          deps.waitpid(pid);
        } catch {
          /* fail-open */
        }
        reaped++;
      } else {
        nextPending.add(pid); // first sighting — confirm next scan
      }
    }
    pendingConfirm = nextPending;
    return reaped;
  };
}

let installedTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Install the PID-1 orphan reaper. No-op (returns false) unless running as
 * PID 1 on linux with `GBRAIN_PID1_REAP` not set to '0'/'false'. Idempotent.
 */
export function installPid1OrphanReaper(deps: Pid1ReaperDeps = {}): boolean {
  const off = (process.env.GBRAIN_PID1_REAP ?? '').toLowerCase();
  if (off === '0' || off === 'false') return false;
  if ((deps.platform ?? process.platform) !== 'linux') return false;
  const selfPid = deps.selfPid ?? process.pid;
  if (selfPid !== 1) return false;
  if (installedTimer) return true;

  const tick = createPid1ReaperTick({
    procDir: deps.procDir ?? '/proc',
    selfPid,
    waitpid: deps.waitpid ?? defaultWaitpid,
  });
  installedTimer = setInterval(() => {
    try {
      tick();
    } catch {
      /* fail-open — never let the reaper take down serve */
    }
  }, deps.intervalMs ?? 30_000);
  // Never keep the process alive for the reaper.
  installedTimer.unref?.();
  return true;
}

/** Test-only: clear the interval + install latch. */
export function _uninstallPid1OrphanReaperForTests(): void {
  if (installedTimer) {
    clearInterval(installedTimer);
    installedTimer = null;
  }
}
