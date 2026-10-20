/**
 * GBRA-133 PR 2a: how the commit notifier sees a checkout move (core in ../commit-notifier.ts).
 *
 * - `resolveGitDirs` resolves `--absolute-git-dir` and `--git-common-dir`, so a linked worktree watches both its own git
 *   dir (HEAD, logs/HEAD, index.lock, rebase state) and the shared one (refs/heads, packed-refs).
 * - `watchGitDirs` registers a non-persistent fs.watch on the git dir, its logs/, the common dir and its refs/heads; an
 *   event only brings the next poll forward (the async rev-parse poll stays the source of truth). When no directory can
 *   be watched it returns null and the source runs in poll mode; `GBRAIN_NOTIFIER_DETECTION=poll` forces poll mode.
 * - `gitQuiet` is the quiet predicate: no rebase, merge, cherry-pick, revert or sequencer state (the list
 *   git/commit-push.ts refuses on) and no index.lock, so a sync never starts in the middle of a multi-commit operation.
 * Every git call runs with GIT_OPTIONAL_LOCKS=0 and never writes into the checkout.
 */
import { existsSync, watch as fsWatch } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_OPERATION_MARKERS } from '../git/commit-push.ts';

export async function git(root: string, args: string[]): Promise<string> {
  const r = await execFileBounded('git', ['-C', root, ...args], { timeout: 5_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  if (r.error) throw new Error((r.stderr || r.error.message).trim().split('\n')[0] || 'git failed');
  return r.stdout.trim();
}

export async function revParseHead(root: string): Promise<string> {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
}

export async function resolveGitDirs(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const out = await git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).catch(() => null);
  if (!out) return null;
  const [gitDir, common] = out.split('\n').map(line => line.trim());
  if (!gitDir) return null;
  const commonDir = !common ? gitDir : isAbsolute(common) ? common : resolve(root, common);
  return { gitDir, commonDir };
}

/** The directories a commit, checkout, reset or ref update touches, deduplicated, existing ones only. */
export function watchTargets(gitDir: string, commonDir: string | null): string[] {
  const dirs = [gitDir, join(gitDir, 'logs')];
  if (commonDir) dirs.push(commonDir, join(commonDir, 'logs'), join(commonDir, 'refs', 'heads'));
  return [...new Set(dirs)].filter(dir => existsSync(dir));
}

export type WatchFn = (dirs: string[], onChange: () => void) => (() => void) | null;

export const watchGitDirs: WatchFn = (dirs, onChange) => {
  const closers: Array<() => void> = [];
  for (const dir of dirs) {
    try {
      const w = fsWatch(dir, { persistent: false }, () => onChange());
      w.on('error', () => { try { w.close(); } catch { /* already closed */ } });
      closers.push(() => w.close());
    } catch { /* this directory stays poll-only */ }
  }
  return closers.length ? () => { for (const close of closers) { try { close(); } catch { /* already closed */ } } } : null;
};

/** The quiet predicate: true when no multi-step git operation or index write is in progress in this worktree. */
export function gitQuiet(gitDir: string | null): boolean {
  if (!gitDir) return true;
  if (existsSync(join(gitDir, 'index.lock'))) return false;
  return !GIT_OPERATION_MARKERS.some(marker => existsSync(join(gitDir, marker)));
}
