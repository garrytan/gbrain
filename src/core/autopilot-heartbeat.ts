/**
 * #7003: the autopilot daemon's heartbeat sidecar, and how `gbrain autopilot --status` grades staleness from it.
 *
 * The lock file's mtime stays the liveness signal (refreshed at the top of every tick). Before this, `--status`
 * judged it against 6 x the status caller's `--interval` flag (default 300 s), but the daemon sleeps an adaptive
 * interval (2 x its own `--interval` on a brain scoring 90 or more), so a healthy daemon started with
 * `--interval 1500` read stale on every long sleep. The daemon now writes this sidecar at the top of each tick
 * (phase `cycle`) and before each sleep (phase `sleep`, with `next_tick_at`). Grading:
 * - phase sleep: stale once the lock is older than (next_tick_at - lock mtime) + a grace of max(base interval, 120 s),
 *   the time the next tick has to refresh the lock;
 * - phase cycle: stale after 6 x the daemon's own base interval (a cycle in progress has no next tick yet);
 * - no sidecar, one written by another pid than the lock holder, or one older than the lock (a daemon binary that
 *   does not write it): the caller's flag, as before.
 */
import { closeSync, fstatSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { autopilotHeartbeatPath, autopilotLockPath } from './autopilot-paths.ts';
import { isProcessAlive } from './pglite-lock.ts';

export interface AutopilotHeartbeat {
  pid: number;
  written_at: string;
  phase: 'cycle' | 'sleep';
  /** The sleep the daemon chose after its last cycle (adaptive), null during a cycle. */
  interval_s: number | null;
  base_interval_s: number;
  next_tick_at: string | null;
}

/** Best-effort: a heartbeat that cannot be written leaves --status on the flag fallback. */
export function writeAutopilotHeartbeat(fields: Omit<AutopilotHeartbeat, 'pid' | 'written_at'>, path = autopilotHeartbeatPath(), now = new Date()): void {
  try {
    const body: AutopilotHeartbeat = { pid: process.pid, written_at: now.toISOString(), ...fields };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body) + '\n');
    renameSync(tmp, path);
  } catch { /* status falls back to the flag */ }
}

export function readAutopilotHeartbeat(path = autopilotHeartbeatPath()): AutopilotHeartbeat | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutopilotHeartbeat>;
    if (typeof raw.pid !== 'number' || typeof raw.written_at !== 'string' || (raw.phase !== 'cycle' && raw.phase !== 'sleep')
      || typeof raw.base_interval_s !== 'number') return null;
    return { pid: raw.pid, written_at: raw.written_at, phase: raw.phase, interval_s: typeof raw.interval_s === 'number' ? raw.interval_s : null,
      base_interval_s: raw.base_interval_s, next_tick_at: typeof raw.next_tick_at === 'string' ? raw.next_tick_at : null };
  } catch { return null; }
}

/** Tolerance for the clock gap between the lock refresh and the sidecar write at the top of a tick. */
const WRITE_SKEW_MS = 5_000;

/**
 * The daemon's own staleness threshold in seconds of lock age, or null when the sidecar is absent, foreign or stale
 * (the caller then uses its flag).
 */
export function daemonStaleAfterSeconds(heartbeat: AutopilotHeartbeat | null, lock: { mtimeMs: number; pid: number | null } | null): { staleAfter: number; nextTickAt: string | null } | null {
  if (!heartbeat || !lock) return null;
  if (lock.pid !== null && heartbeat.pid !== lock.pid) return null;
  const writtenMs = Date.parse(heartbeat.written_at);
  if (!Number.isFinite(writtenMs) || writtenMs < lock.mtimeMs - WRITE_SKEW_MS) return null;
  const base = Number.isFinite(heartbeat.base_interval_s) && heartbeat.base_interval_s > 0 ? heartbeat.base_interval_s : null;
  if (base === null) return null;
  if (heartbeat.phase === 'cycle') return { staleAfter: base * 6, nextTickAt: null };
  const nextMs = heartbeat.next_tick_at ? Date.parse(heartbeat.next_tick_at) : NaN;
  if (!Number.isFinite(nextMs)) return null;
  return { staleAfter: Math.max(0, Math.ceil((nextMs - lock.mtimeMs) / 1000)) + Math.max(base, 120), nextTickAt: heartbeat.next_tick_at };
}

/** Read the lock's timestamp and owner from the same file, even if a restart replaces the path. */
function readAutopilotLock(path: string): { read: 'available'; mtimeMs: number; pid: number | null } | { read: 'unavailable' } {
  try {
    const fd = openSync(path, 'r');
    try {
      const { mtimeMs } = fstatSync(fd);
      const value = readFileSync(fd, 'utf-8').trim();
      const parsed = Number(value);
      const pid = /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(parsed) && parsed <= 0x7fffffff ? parsed : null;
      return { read: 'available', mtimeMs, pid };
    } finally {
      closeSync(fd);
    }
  } catch {
    // A lock readable only as metadata still provides the legacy age signal.
    try { return { read: 'available', mtimeMs: statSync(path).mtimeMs, pid: null }; } catch { return { read: 'unavailable' }; }
  }
}

export function readAutopilotStatusHeartbeat() {
  const snapshot = readAutopilotLock(autopilotLockPath());
  const lock = snapshot.read === 'available' ? snapshot : null;
  const heartbeatAgeSeconds = lock ? Math.max(0, Math.floor((Date.now() - lock.mtimeMs) / 1000)) : null;
  const heartbeatOwnerExited = lock?.pid != null && !isProcessAlive(lock.pid);
  const daemon = heartbeatOwnerExited ? null : daemonStaleAfterSeconds(readAutopilotHeartbeat(), lock);
  return { heartbeatAgeSeconds, heartbeatOwnerExited, daemon };
}
