import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { isDurabilityHardened } from '../brain-repo-durability.ts';
import { OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';

function git(root: string, hooks: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-C', root, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_ICASE_PATHSPECS: '0' },
    }, (error, stdout) => {
      if (error && (error.killed || typeof error.code !== 'number')) reject(new OperationError('git_unavailable', 'Git execution did not finish within its bounded attempt.'));
      else resolve({ stdout, code: error?.code as number ?? 0 });
    });
  });
}

/** Caller owns the native worktree lock. Never run pull, rebase, or legacy hooks. */
export async function publishGitEffect(root: string, relativePath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!isDurabilityHardened(root)) return { git: 'skipped', reason: 'durability_not_enabled', push: 'skipped' };
  const path = nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe');
  relativePath = relative(root, path).split(sep).join('/');
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  try {
    const tracked = await git(root, hooks, ['ls-files', '-z', '--error-unmatch', '--', relativePath], signal);
    if (tracked.code !== 0 && tracked.code !== 1) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
    const changed = await git(root, hooks, ['status', '--porcelain', '--untracked-files=all', '--', relativePath], signal);
    if (changed.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect the canonical Git target.');
    let commit = 'unchanged';
    if (changed.stdout.trim()) {
      if (tracked.code === 0 || existsSync(path)) {
        const add = await git(root, hooks, ['add', '-A', '--', relativePath], signal);
        if (add.code !== 0) throw new OperationError('git_unavailable', 'Cannot stage the canonical Git target.');
      }
      const diff = await git(root, hooks, ['diff', '--cached', '--quiet', '--', relativePath], signal);
      if (diff.code === 1) {
        // --only keeps unrelated staged paths out of this commit. After a lost
        // database acknowledgment the same HEAD/file state is an exact no-op.
        const result = await git(root, hooks, ['commit', '--only', '-m', 'gbrain: persist canonical memory update', '--', relativePath], signal);
        if (result.code !== 0) throw new OperationError('git_unavailable', 'Cannot commit the canonical Git target.');
        commit = 'committed';
      } else if (diff.code !== 0) throw new OperationError('git_unavailable', 'Cannot compare the canonical Git target.');
    } else if (tracked.code !== 0) {
      if (existsSync(path)) throw new OperationError('git_target_unsafe', 'Git cannot identify the existing canonical file by its native spelling.',
        'Reconcile the index and worktree spelling before retrying publication.');
      let parent = dirname(path);
      while (!existsSync(parent)) {
        if (parent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
        parent = dirname(parent);
      }
      const scope = relative(root, parent).split(sep).join('/') || '.';
      const deleted = await git(root, hooks, ['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
      const staged = await git(root, hooks, ['diff', '--cached', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
      if (deleted.code !== 0 || staged.code !== 0) throw new OperationError('git_unavailable', 'Cannot inspect canonical Git deletions.');
      for (const entry of new Set(`${deleted.stdout}${staged.stdout}`.split('\0').filter(Boolean))) {
        if (existsSync(join(root, entry))) continue;
        let missingParent = dirname(nativeFileTarget(root, join(root, entry), 'git_target_unsafe'));
        while (!existsSync(missingParent)) {
          if (missingParent === resolvePath(root)) throw new OperationError('git_target_unsafe', 'The canonical Git root disappeared.');
          missingParent = dirname(missingParent);
        }
        if (missingParent === parent) throw new OperationError('git_target_unsafe', 'The absent target cannot be distinguished from an indexed deletion.',
          'Reconcile the recorded deletion path with the Git index before retrying publication.');
      }
      return { git: 'skipped', reason: 'target_absent', push: 'skipped' };
    }
    const branch = await git(root, hooks, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    if (branch.code !== 0) return { git: commit, push: 'skipped', reason: 'no_tracking_remote' };
    const remote = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.remote`], signal);
    const merge = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.merge`], signal);
    if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') {
      return { git: commit, push: 'skipped', reason: 'no_tracking_remote' };
    }
    // A plain push is idempotent and cannot import remote canonical content.
    const push = await git(root, hooks, ['push', '--', remote.stdout.trim(), `HEAD:${merge.stdout.trim()}`], signal);
    if (push.code !== 0) throw new OperationError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.');
    return { git: commit, push: 'committed' };
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}
