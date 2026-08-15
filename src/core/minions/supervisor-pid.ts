/**
 * Shared supervisor PID-file read + liveness check (issue #1815, Q4).
 *
 * The `existsSync → readFileSync → parseInt → process.kill(pid,0)` block was
 * copy-pasted across `gbrain jobs supervisor status` and `gbrain doctor`; the
 * #1815 niceness work would have added a third copy in `gbrain jobs stats`.
 * Extracted here so all three share one regression point.
 */

import { existsSync, readFileSync } from 'fs';

export interface SupervisorPidStatus {
  /** Parsed pid from the PID file, or null if missing/corrupt. */
  pid: number | null;
  /** True when `pid` is set AND the process is alive (signalable / EPERM). */
  running: boolean;
}

/**
 * Read a supervisor PID file and report liveness. Best-effort: unreadable or
 * corrupt files yield `{ pid: null, running: false }`. EPERM from the liveness
 * probe counts as running (the process exists, we just can't signal it).
 */
export function readSupervisorPid(pidFile: string): SupervisorPidStatus {
  if (!existsSync(pidFile)) return { pid: null, running: false };
  try {
    const line = readFileSync(pidFile, 'utf8').trim().split('\n')[0];
    const parsed = parseInt(line, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return { pid: null, running: false };
    try {
      process.kill(parsed, 0);
      return { pid: parsed, running: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // EPERM: process exists but not signalable by us → still running.
      return { pid: parsed, running: code === 'EPERM' };
    }
  } catch {
    return { pid: null, running: false };
  }
}
