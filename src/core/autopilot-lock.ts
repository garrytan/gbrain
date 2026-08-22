import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type AutopilotLockHolder =
  | { state: 'dead' }
  | { state: 'self' }
  | { state: 'alive-autopilot' }
  | { state: 'alive-foreign' }
  | { state: 'alive-unknown' };

export interface AutopilotLockProbeDeps {
  isPidAlive?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string | null;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcessCommandProbeDeps {
  /** Injected for tests; defaults to fs.readFileSync of /proc/<pid>/cmdline. */
  readCmdlineFile?: (path: string) => Buffer | string;
}

/**
 * Best-effort process command lookup. On Linux, /proc/<pid>/cmdline is read
 * first (no subprocess, works even when `ps` is unavailable or restricted —
 * e.g. minimal containers), falling back to `ps -o args=` elsewhere (#4300).
 */
export function readProcessCommand(pid: number, deps: ProcessCommandProbeDeps = {}): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const readCmdline = deps.readCmdlineFile ?? readFileSync;
  try {
    const raw = readCmdline(`/proc/${pid}/cmdline`);
    // argv is NUL-separated with a trailing NUL; normalize to a space-joined line.
    const cmd = raw.toString().split('\0').filter((part) => part.length > 0).join(' ').trim();
    if (cmd.length > 0) return cmd;
  } catch {
    // Not Linux (no /proc) or unreadable — fall through to ps.
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function looksLikeGbrainAutopilotCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').trim();
  if (!/(^|\s)autopilot(\s|$)/i.test(normalized)) return false;
  if (/(^|[\/\s])gbrain(?:\.exe)?(\s|$)/i.test(normalized)) return true;
  return /(^|\s)(?:\S+\/)?(?:\.{1,2}\/)?(?:src\/)?cli\.(?:ts|js|mjs)(\s|$)/i.test(normalized)
    || /(^|\s)\S*\/src\/cli\.(?:ts|js|mjs)(\s|$)/i.test(normalized);
}

export function classifyAutopilotLockHolder(
  pid: number,
  currentPid: number = process.pid,
  deps: AutopilotLockProbeDeps = {},
): AutopilotLockHolder {
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'dead' };
  if (pid === currentPid) return { state: 'self' };

  const probeAlive = deps.isPidAlive ?? isPidAlive;
  if (!probeAlive(pid)) return { state: 'dead' };

  const probeCommand = deps.readProcessCommand ?? readProcessCommand;
  const command = probeCommand(pid);
  if (command === null) return { state: 'alive-unknown' };
  return looksLikeGbrainAutopilotCommand(command)
    ? { state: 'alive-autopilot' }
    : { state: 'alive-foreign' };
}
