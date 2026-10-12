/**
 * Shared supervisor PID-file read + liveness check (issue #1815, Q4).
 *
 * The `existsSync → readFileSync → parseInt → process.kill(pid,0)` block was
 * copy-pasted across `gbrain jobs supervisor status` and `gbrain doctor`; the
 * #1815 niceness work would have added a third copy in `gbrain jobs stats`.
 * Extracted here so all three share one regression point.
 */

import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { processStartTime } from '../pglite-lock.ts';

export interface SupervisorPidStatus {
  /** Parsed pid from the PID file, or null if missing/corrupt. */
  pid: number | null;
  /** True when `pid` is set AND the process is alive (signalable / EPERM). */
  running: boolean;
  /** The hostname the supervisor recorded when it took its lock (line 3); absent on a PID file an older supervisor wrote. */
  host?: string;
}

/**
 * Read a supervisor PID file and report liveness. Best-effort: unreadable or
 * corrupt files yield `{ pid: null, running: false }`. EPERM from the liveness
 * probe counts as running (the process exists, we just can't signal it).
 */
export function readSupervisorPid(pidFile: string): SupervisorPidStatus {
  if (!existsSync(pidFile)) return { pid: null, running: false };
  try {
    const lines = readFileSync(pidFile, 'utf8').trim().split('\n');
    const parsed = parseInt(lines[0], 10);
    if (Number.isNaN(parsed) || parsed <= 0) return { pid: null, running: false };
    const host = lines[2]?.trim();
    const recorded = host ? { host } : {};
    try {
      process.kill(parsed, 0);
      return { pid: parsed, running: true, ...recorded };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // EPERM: process exists but not signalable by us → still running.
      return { pid: parsed, running: code === 'EPERM', ...recorded };
    }
  } catch {
    return { pid: null, running: false };
  }
}

/**
 * W9F item 7: process identity for `jobs supervisor stop`. The PID file body
 * is the supervisor pid, then (Linux) its kernel start time, so a stale PID
 * file whose pid was recycled is told apart from the supervisor, then (PR
 * #6463) the hostname the supervisor puts in its DB lock, so doctor can tell a
 * hostname label change from a second supervisor. Every reader takes the first
 * line; `jobs supervisor stop` reads line 2 (non-numeric = unknown); doctor
 * reads line 3 (missing = an older supervisor). An unknown start time leaves
 * line 2 empty so the hostname stays on line 3.
 */
export function pidFileContents(pid: number = process.pid, host: string = hostname()): string {
  return `${pid}\n${processStartTime(pid) ?? ''}\n${host}\n`;
}

/** `{ [key]: <kernel start time of pid> }` for an audit row, or nothing when it is unknowable. */
export function processStartStamp(key: string, pid: number): Record<string, string> {
  const start = processStartTime(pid);
  return start ? { [key]: start } : {};
}
