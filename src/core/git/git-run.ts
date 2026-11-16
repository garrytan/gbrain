/** The plain git runner commit-push and its skipped-path checks share: C locale, hardened env, no prompt. */
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH } from '../git-transport.ts';
import { opError, type OperationError } from '../ops/contract.ts';

export interface GitRun { code: number; stdout: string; stderr: string; stopped?: GitStop }
/** Why a git child ended without exiting on its own: its time limit, an output limit the caller set, or a signal from outside. */
export interface GitStop { reason: 'timeout' | 'output_limit' | 'signal'; signal?: string }

interface GitOpts { auth?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number; returnStopped?: boolean }

/**
 * Output is read whole with no size limit unless the caller sets `maxBuffer`: a listing under a named folder is as long
 * as the folder (a failed commit restores every index entry under it), and Node's default 1 MiB limit killed git on a
 * large checkout. A child that did not exit on its own throws git_command_stopped, so a caller never reads a cut-off
 * listing as the answer; `returnStopped` returns it instead, for remote calls that report their own timeout.
 */
export function git(root: string, args: string[], opts: GitOpts = {}): GitRun {
  const base = opts.auth ? { ...GIT_ENV_AUTH } : { ...GIT_ENV };
  const timeoutMs = opts.timeoutMs ?? 60_000;
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '',
      timeout: timeoutMs,
      maxBuffer: opts.maxBuffer ?? Infinity,
      env: gitChildEnv({ ...base, LC_ALL: 'C', LANGUAGE: 'C', ...opts.env }),
    }).toString();
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number | null; signal?: string | null; code?: string; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const reason: GitStop['reason'] | null = err.code === 'ETIMEDOUT' ? 'timeout' : err.code === 'ENOBUFS' || err.code === 'ERR_STRING_TOO_LONG' ? 'output_limit' : typeof err.status !== 'number' && err.signal ? 'signal' : null;
    const stopped = reason ? { reason, ...(err.signal ? { signal: err.signal } : {}) } : undefined;
    if (stopped && !opts.returnStopped) throw stoppedError(root, args, stopped, timeoutMs, opts.maxBuffer);
    return {
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      ...(stopped ? { stopped } : {}),
    };
  }
}

/** Signals a process raises on itself when it crashes; any other signal came from outside the child. */
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT']);

function stoppedError(root: string, args: string[], stop: GitStop, timeoutMs: number, maxBuffer?: number): OperationError {
  const what = `git ${args.filter(a => !a.startsWith('-c') && !a.includes('=')).slice(0, 2).join(' ')}`;
  const crashed = stop.reason === 'signal' && CRASH_SIGNALS.has(stop.signal ?? '');
  const how = stop.reason === 'timeout' ? `it ran past its ${Math.round(timeoutMs / 1000)} s limit and was stopped`
    : stop.reason === 'output_limit' ? `its output passed ${maxBuffer ? `the ${maxBuffer} byte limit` : 'the largest string this runtime can hold'} and it was stopped`
    : crashed ? `it crashed with ${stop.signal}`
    : `it was killed by ${stop.signal}, from outside gbrain`;
  return opError('git_command_stopped', `${what} in ${root} did not finish: ${how}. ${crashed ? 'Its partial output was not used' : 'Git itself is working; gbrain did not use its partial output'}.`,
    crashed
      ? `Git crashed (a corrupt repository or a git bug can cause it). Run git -C ${root} fsck, then rerun the same command once; if it crashes again, tell the user that ${what} in ${root} crashes.`
      : stop.reason === 'signal'
      ? 'Something on this machine stopped git (often the out-of-memory killer or a process supervisor). Check the machine, then rerun the same command once.'
      : `Rerun the same command once. If it stops again, tell the user that ${what} in ${root} does not finish within the limit.`,
    { reason: stop.reason, detail: JSON.stringify({ command: what, ...stop }) });
}

export function gitOk(root: string, args: string[], what: string, opts: GitOpts = {}): string {
  const r = git(root, args, opts);
  if (r.code !== 0) {
    throw opError('git_unavailable', `git ${what} failed in ${root}: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`,
      `Run git status in ${root}, fix what git reports, then rerun the same gbrain git commit-push command.`);
  }
  return r.stdout.trim();
}
