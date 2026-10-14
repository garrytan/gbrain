/**
 * A PID that is provably not running: a child spawned and already reaped, re-checked with
 * `kill -0` so a reused number is retried. Tests that stage a "stale" postmaster.pid or lock
 * must not write a fixed number such as 99999: on a busy gate VM (pid_max 4194304) it can
 * name a live process, and the live-process guards then refuse the directory.
 */
export function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pid = Bun.spawnSync(['bash', '-c', 'exit 0']).pid;
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('could not obtain a provably-dead PID after 5 spawns');
}
