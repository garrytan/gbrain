/** The plain git runner commit-push and its skipped-path checks share: C locale, hardened env, no prompt. */
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH } from '../git-transport.ts';
import { opError } from '../ops/contract.ts';

export interface GitRun { code: number; stdout: string; stderr: string }

export function git(root: string, args: string[], opts: { auth?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {}): GitRun {
  const base = opts.auth ? { ...GIT_ENV_AUTH } : { ...GIT_ENV };
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '',
      timeout: opts.timeoutMs ?? 60_000,
      ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
      env: gitChildEnv({ ...base, LC_ALL: 'C', LANGUAGE: 'C', ...opts.env }),
    }).toString();
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      code: typeof err.status === 'number' ? err.status : -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

export function gitOk(root: string, args: string[], what: string, opts: Parameters<typeof git>[2] = {}): string {
  const r = git(root, args, opts);
  if (r.code !== 0) {
    throw opError('git_unavailable', `git ${what} failed in ${root}: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`,
      `Run git status in ${root}, fix what git reports, then rerun the same gbrain git commit-push command.`);
  }
  return r.stdout.trim();
}
