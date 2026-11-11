/**
 * `execFileBounded`: run a child process that always settles by its deadline
 * or on abort, using our own timer rather than trusting the runtime's exit
 * events. It lives in this dependency-free module so that `git-remote.ts`,
 * which `brain-repo-durability.ts` itself imports, can use it too;
 * `brain-repo-durability.ts` re-exports it for its older callers.
 */
import { readFileSync } from 'fs';
import { execFile, execFileSync, type ChildProcess, type ExecFileException } from './spawn.ts';

/** Default time a stopped child gets to exit after SIGTERM before SIGKILL; a caller passes `termGraceMs` for children that need longer to clean up. */
const BOUNDED_EXEC_TERM_GRACE_MS = 2_000;

/**
 * Whether a stopped child has exited even if the runtime lost its exit event:
 * on Linux an exited-but-unreaped child is a zombie ('Z' in /proc/<pid>/stat).
 * Elsewhere only the delivered exit counts, so the grace timer bounds the wait.
 */
function childHasExited(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return child.pid === undefined ? false : process.platform === 'linux' ? pidGone(child.pid) : false;
}

/** Whether `pid` no longer runs: no such process, or on Linux a zombie waiting for its parent to reap it. */
function pidGone(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return true;
    }
  }
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** GST-2250: every process below `pids` in the POSIX process table, so a stopped child's git, ssh or hook descendants are stopped with it. */
function descendantsOf(pids: number[]): number[] {
  let listing = '';
  try { listing = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 5_000 }) as string; } catch { return []; }
  const children = new Map<number, number[]>();
  for (const row of listing.split('\n')) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [], queue = [...pids];
  while (queue.length) for (const pid of children.get(queue.shift()!) ?? []) if (!found.includes(pid)) { found.push(pid); queue.push(pid); }
  return found;
}

export interface BoundedExecOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
  termGraceMs?: number;
  /** 'buffer' returns stdout and stderr as raw bytes (NUL-delimited git listings); default 'utf8'. */
  encoding?: 'utf8' | 'buffer';
  /** Stop the child's descendants too (read before the first signal, again before SIGKILL), and settle only once none runs. POSIX only. */
  killTree?: boolean;
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
 * settles from the timer even if the exit event never arrives. A git stalled in
 * uninterruptible I/O or memory reclaim acts on SIGTERM only seconds later, so
 * git callers pass a longer `termGraceMs` (#6932).
 */
export function execFileBounded(file: string, args: string[], options: BoundedExecOptions & { encoding: 'buffer' }): Promise<{ error: ExecFileException | null; stdout: Buffer; stderr: Buffer }>;
export function execFileBounded(file: string, args: string[], options: BoundedExecOptions): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>;
export function execFileBounded(file: string, args: string[], options: BoundedExecOptions): Promise<{ error: ExecFileException | null; stdout: string | Buffer; stderr: string | Buffer }> {
  const { timeout, signal, termGraceMs = BOUNDED_EXEC_TERM_GRACE_MS, encoding = 'utf8', killTree = false, ...rest } = options;
  const empty = encoding === 'buffer' ? Buffer.alloc(0) : '';
  return new Promise(resolve => {
    let settled = false;
    const finish = (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer = empty) => {
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
      finish(stopped, empty, empty);
    };
    const child = execFile(file, args, { ...rest, encoding: encoding as BufferEncoding }, (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      clearTimeout(escalation);
      clearInterval(poll);
      if (stopped) finish(stopped, empty, empty);
      else finish(error, stdout, stderr);
    });
    const stop = (message: string, code: string) => {
      if (stopped) return;
      stopped = Object.assign(new Error(message), { code, killed: true, signal: 'SIGTERM' as const });
      const tree = killTree && process.platform !== 'win32' && child.pid !== undefined ? descendantsOf([child.pid]) : [];
      const signalTree = (name: NodeJS.Signals) => { for (const pid of tree) try { process.kill(pid, name); } catch { /* already gone */ } };
      child.kill('SIGTERM');
      signalTree('SIGTERM');
      poll = setInterval(() => { if (childHasExited(child) && tree.every(pidGone)) settleStopped(); }, 25);
      escalation = setTimeout(() => {
        if (tree.length) for (const pid of descendantsOf([child.pid!, ...tree])) if (!tree.includes(pid)) tree.push(pid);
        child.kill('SIGKILL');
        signalTree('SIGKILL');
        settleStopped();
      }, termGraceMs);
    };
    const timer = setTimeout(() => stop(`${file} did not finish within ${timeout}ms`, 'ETIMEDOUT'), timeout);
    const onAbort = () => stop(`${file} was aborted`, 'ABORT_ERR');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
