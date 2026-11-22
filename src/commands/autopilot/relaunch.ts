/**
 * #8840: the autopilot self-upgrade swap exits for a relaunch; this decides who relaunches it, and relaunches the
 * daemon itself when nothing else would.
 */
import { spawn } from '../../core/spawn.ts';

export interface RelaunchDeps {
  /** The installed launchd or systemd autopilot service runs this process (its main pid is this one or its parent). */
  underService: () => Promise<boolean>;
  /** This brain's gbrain cron line, or the launcher `self_upgrade.autopilot_launcher external` declares; null when neither is known. */
  launcher: () => Promise<unknown>;
  /** The command line that starts this daemon again on the installed build. */
  argv: () => string[];
  /** Start a detached shell that waits for `pid` to exit, then runs `argv`. */
  spawnRelauncher: (pid: number, argv: string[]) => void;
}

/**
 * #8840: a detached shell that waits for `pid` to exit, then runs `argv` with this process's environment, directory and output.
 * An exited process whose parent never reaps it (a container bootstrap that execs the agent after starting the wrapper)
 * stays a zombie, which `kill -0` still finds, so a zombie state (from /proc, else ps) also counts as exited.
 */
export function spawnRelauncher(pid: number, argv: string[]): void {
  const wait = 'while kill -0 "$0" 2>/dev/null; do'
    + ' case "$(sed -n \'s/^.*) \\(.\\).*/\\1/p\' "/proc/$0/stat" 2>/dev/null || ps -o stat= -p "$0" 2>/dev/null)" in *Z*) break;; esac;'
    + ' sleep 1; done; exec "$@"';
  const child = spawn('/bin/sh', ['-c', wait, String(pid), ...argv],
    { detached: true, stdio: ['ignore', 'inherit', 'inherit'], cwd: process.cwd(), env: process.env });
  child.unref();
}

/** The real relaunch checks; `resolveCli` is autopilot's `resolveGbrainCliPath`. */
export const defaultRelaunchDeps = (resolveCli: () => string): RelaunchDeps => ({
  underService: async () => {
    const pid = (await import('../upgrade-restart.ts')).hostServices().autopilot?.pid;
    return pid !== null && pid !== undefined && (pid === process.pid || pid === process.ppid);
  },
  launcher: async () => (await import('../upgrade-restart.ts')).autopilotLauncher(),
  argv: () => [resolveCli(), ...process.argv.slice(2)],
  spawnRelauncher,
});

/**
 * #8840: what starts the daemon again once the swap exits it. `supervisor`: the installed launchd or systemd service
 * runs it, this brain's gbrain cron line runs every few minutes, or the operator declared
 * `self_upgrade.autopilot_launcher external`. Otherwise nothing would (the ephemeral-container start script runs the
 * wrapper once at container boot; a daemon started by hand has no launcher), so the daemon relaunches itself: `self`,
 * a detached shell waits for this pid to exit and runs the same command line, which takes the lock the exit frees.
 * `stay`: no relaunch could be set up (no POSIX shell, or the CLI path cannot be resolved), so the daemon keeps
 * running its loaded build rather than exit for a relaunch that never comes; doctor's `runtime_build_skew` reports it.
 */
export async function relaunchAfterSwap(deps: RelaunchDeps): Promise<{ by: 'supervisor' | 'self' | 'stay'; argv?: string[]; reason?: string }> {
  if (await deps.underService().catch(() => false)) return { by: 'supervisor' };
  if (await deps.launcher().catch(() => null)) return { by: 'supervisor' };
  if (process.platform === 'win32') return { by: 'stay', reason: 'no POSIX shell to relaunch it' };
  try {
    const argv = deps.argv();
    deps.spawnRelauncher(process.pid, argv);
    return { by: 'self', argv };
  } catch (e) {
    return { by: 'stay', reason: e instanceof Error ? e.message : String(e) };
  }
}
