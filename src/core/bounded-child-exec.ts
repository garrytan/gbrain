/**
 * Bounded child-process execution: `execFileBounded` settles at its deadline
 * or on abort from its own timer, whatever the runtime delivers. A leaf module
 * (no gbrain imports), so modules that `brain-repo-durability.ts` imports,
 * such as `git-remote.ts`, can use it without an import cycle;
 * `brain-repo-durability.ts` re-exports it for its existing callers.
 */
import { readFileSync } from 'fs';
import { execFile, type ChildProcess, type ExecFileException } from 'child_process';

const BOUNDED_EXEC_TERM_GRACE_MS = 2_000;

/**
 * Whether a stopped child has exited even if the runtime lost its exit event:
 * on Linux an exited-but-unreaped child is a zombie ('Z' in /proc/<pid>/stat).
 * Elsewhere only the delivered exit counts, so the grace timer bounds the wait.
 */
function childHasExited(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform !== 'linux' || child.pid === undefined) return false;
  try {
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return true;
  }
}

export interface BoundedExecOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
}

/**
 * `execFile` that settles within `timeout` or on abort even when the runtime
 * never delivers the child's exit or pipe close. Bun drops one-shot pipe
 * events (and, before 1.3.14, pidfd exit events: oven-sh/bun#30301) when a
 * callback re-enters the event loop (bun:test `expect().resolves/.rejects`;
 * pipe loss still reproduces on 1.4.2): execFile's
 * callback and its own `timeout` then never fire and the child stays a zombie,
 * so the deadline and abort are enforced with our own timer.
 *
 * Stopping sends SIGTERM first so git can remove its lockfiles (a SIGKILLed
 * `git add`/`commit` leaves `.git/index.lock` behind and every later git call
 * in that worktree fails), then SIGKILLs after a short grace period and
 * settles from the timer even if the exit event never arrives.
 */
export function execFileBounded(file: string, args: string[], options: BoundedExecOptions): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
  const { timeout, signal, ...rest } = options;
  return new Promise(resolve => {
    let settled = false;
    const finish = (error: ExecFileException | null, stdout: string, stderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ error, stdout, stderr });
    };
    let stopped: ExecFileException | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const settleStopped = () => {
      clearTimeout(escalation);
      clearInterval(poll);
      finish(stopped, '', '');
    };
    const child = execFile(file, args, { ...rest, encoding: 'utf8' }, (error, stdout, stderr) => {
      clearTimeout(escalation);
      clearInterval(poll);
      if (stopped) finish(stopped, '', '');
      else finish(error, stdout, stderr);
    });
    const stop = (message: string, code: string) => {
      if (stopped) return;
      stopped = Object.assign(new Error(message), { code, killed: true, signal: 'SIGTERM' as const });
      child.kill('SIGTERM');
      poll = setInterval(() => { if (childHasExited(child)) settleStopped(); }, 25);
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
        settleStopped();
      }, BOUNDED_EXEC_TERM_GRACE_MS);
    };
    const timer = setTimeout(() => stop(`${file} did not finish within ${timeout}ms`, 'ETIMEDOUT'), timeout);
    const onAbort = () => stop(`${file} was aborted`, 'ABORT_ERR');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
