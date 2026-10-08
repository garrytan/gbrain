/**
 * Git invocation for directories gbrain does not trust (a user-chosen checkout,
 * a candidate clone): the repository's own configuration must not run code or
 * reach the network. Every call scrubs `GIT_*` from the environment, ignores
 * system and global config, and disables fsmonitor, hooks, the untracked
 * cache, submodule recursion, protocols, credential helpers and automatic
 * maintenance. Arguments are an argv array, never a shell string. Callers
 * bound time and output (`company-brain/revision.ts` streams with its own
 * caps; `hardenedGitSync` takes a timeout and a byte cap).
 *
 * Git has no switch that turns off `filter.<driver>.clean|process` or
 * `diff.<driver>.textconv` from the repository's config, and porcelain such as
 * `status`, `diff`, `show` or `add` runs them whenever it converts working-tree
 * bytes. So only plumbing that never converts content is allowed
 * (`assertHardenedGitArgs`, wave 12 W4.3), and `hardenedPathDirty` answers
 * "is this file changed from HEAD" without `git status`.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const HARDENED_GIT_ARGS: readonly string[] = ['--no-pager', '--no-optional-locks', '--no-replace-objects',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'credential.helper=',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

export function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C' };
}

export type HardenedGitResult = { ok: true; stdout: Buffer } | { ok: false; reason: 'exit' | 'timeout' | 'too_large' | 'unavailable'; status?: number };

const CONVERTING_OPTIONS = new Set(['--filters', '--textconv', '--ext-diff', '-p', '--patch', '-u', '--stat', '--word-diff']);
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'hash-object', 'check-attr', 'diff-index']);

/**
 * Refuses (throws) any Git invocation that could run a repository-configured
 * clean/process filter or textconv: only the allow-listed plumbing, with
 * `hash-object` only under `--no-filters` and `diff-index` only `--cached`.
 */
export function assertHardenedGitArgs(args: readonly string[]): void {
  const sub = args[0] ?? '';
  const ok = ALLOWED_SUBCOMMANDS.has(sub) && !args.some(arg => CONVERTING_OPTIONS.has(arg) || arg.startsWith('--textconv') || arg.startsWith('--filters'))
    && (sub !== 'hash-object' || args.includes('--no-filters')) && (sub !== 'diff-index' || args.includes('--cached'));
  if (!ok) throw new Error(`hardened git refuses \`git ${args.slice(0, 2).join(' ')}\`: only filter-free plumbing may run in an untrusted checkout (see src/core/hardened-git.ts)`);
}

/** Runs `git -C <root> <args>` synchronously under the hardening above, within `timeoutMs` and `maxBytes` of stdout. */
export function hardenedGitSync(root: string, args: string[], limits: { timeoutMs: number; maxBytes: number }): HardenedGitResult {
  assertHardenedGitArgs(args);
  const run = spawnSync('git', [...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: hardenedGitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], timeout: limits.timeoutMs, maxBuffer: limits.maxBytes, killSignal: 'SIGKILL' });
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (code === 'ENOBUFS') return { ok: false, reason: 'too_large' };
  if (run.error) return { ok: false, reason: 'unavailable' };
  if (run.status !== 0) return { ok: false, reason: 'exit', ...(run.status === null ? {} : { status: run.status }) };
  return { ok: true, stdout: run.stdout };
}

const PATH_LIMITS = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };

/**
 * Whether `rel` (repository-relative, `/`-separated) differs from HEAD the
 * way `git status --porcelain -- <rel>` would report it, computed from
 * filter-free plumbing: untracked and not ignored, staged (index differs from
 * HEAD, or unborn HEAD), or working-tree bytes differ from the index blob.
 * `null` when Git cannot say without running repository code or reading
 * config: a conversion attribute (`filter`, `text`, `eol`,
 * `working-tree-encoding`), CRLF working-tree bytes (`core.autocrlf`), a
 * symlink or gitlink, an executable-bit-only difference (`core.filemode`), or
 * any Git failure.
 */
export function hardenedPathDirty(root: string, rel: string): boolean | null {
  const indexed = hardenedGitSync(root, ['ls-files', '-s', '--eol', '-z', '--', rel], PATH_LIMITS);
  if (!indexed.ok) return null;
  const entry = indexed.stdout.toString('utf8').split('\0')[0];
  if (!entry) {
    const untracked = hardenedGitSync(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', rel], PATH_LIMITS);
    return untracked.ok ? untracked.stdout.length > 0 : null;
  }
  const [meta = '', eolInfo = ''] = entry.split('\t');
  const [mode, blob, stage] = meta.split(' ');
  const worktreeEol = eolInfo.trim().split(/\s+/)[1];
  if (!mode || !blob || !stage) return null;
  if (stage !== '0') return true;
  if (mode !== '100644' && mode !== '100755') return null;
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], PATH_LIMITS);
  if (!head.ok) return head.reason === 'exit' && head.status === 1 ? true : null;
  const staged = hardenedGitSync(root, ['diff-index', '--cached', '--quiet', 'HEAD', '--', rel], PATH_LIMITS);
  if (!staged.ok) return staged.reason === 'exit' && staged.status === 1 ? true : null;
  const hashed = hardenedGitSync(root, ['hash-object', '--no-filters', '--', rel], PATH_LIMITS);
  if (!hashed.ok) return null;
  let executable: boolean;
  try { executable = (lstatSync(join(root, ...rel.split('/'))).mode & 0o111) !== 0; } catch { return null; }
  if (hashed.stdout.toString('utf8').trim() === blob) return executable === (mode === '100755') ? false : null;
  if (worktreeEol === 'w/crlf' || worktreeEol === 'w/mixed') return null;
  const attrs = hardenedGitSync(root, ['check-attr', '-z', 'filter', 'text', 'eol', 'working-tree-encoding', '--', rel], PATH_LIMITS);
  if (!attrs.ok) return null;
  const values = attrs.stdout.toString('utf8').split('\0').filter((_, i) => i % 3 === 2);
  return values.every(value => value === 'unspecified' || value === 'unset') ? true : null;
}
