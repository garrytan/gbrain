/**
 * GBRA-180: the opt-in commit guard for a brain checkout several writers
 * share. A local, untracked prepare-commit-msg hook refuses every commit
 * gbrain did not make under the checkout's commit lock: a plain git commit,
 * -a, --amend, and --no-verify too (that flag skips only pre-commit and
 * commit-msg). gbrain's own commits carry GBRAIN_COMMIT_VIA naming the lock
 * they hold; its in-memory merges never run commit hooks. A merge commit, and
 * a commit that finishes a merge, cherry-pick, revert or rebase, pass: refusing
 * those would leave the operation half done in the shared tree. A refused
 * commit changes nothing (the index keeps what its writer staged). A person
 * bypasses it for one command with GBRAIN_COMMIT_GUARD=off. Off unless the
 * brain opts in with gbrain git guard --install; CLI-only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ensureExcluded, resolveHooksDir } from '../brain-repo-durability.ts';
import { assertManagedFilesystemWrite } from '../persistence/filesystem-guard.ts';
import { opError } from '../ops/contract.ts';
import { checkoutRoot, gitVersion, COMMIT_LOCK_NAME, COMMIT_VIA_ENV } from './commit-push.ts';

export const GUARD_HOOK = 'prepare-commit-msg';
export const GUARD_BANNER = '# gbrain commit guard (prepare-commit-msg)';
export const GUARD_BYPASS_ENV = 'GBRAIN_COMMIT_GUARD';

export function renderGuardHook(): string {
  return `#!/usr/bin/env bash
${GUARD_BANNER}
# LOCAL + untracked: installed by gbrain git guard --install, removed by --uninstall.
# Refuses commits in this shared brain checkout (--no-verify included) that did not come
# through gbrain git commit-push or gbrain's own page writes, which hold the commit lock.
# A person can bypass it for one command: ${GUARD_BYPASS_ENV}=off git <command>
[ "\${${GUARD_BYPASS_ENV}:-}" = off ] && exit 0
[ "\${2:-}" = merge ] && exit 0
for _op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer; do
  [ -e "$(git rev-parse --git-path "$_op")" ] && exit 0
done
_lock="$(git rev-parse --path-format=absolute --git-path ${COMMIT_LOCK_NAME} 2>/dev/null || true)"
if [ -n "$_lock" ] && [ "\${${COMMIT_VIA_ENV}:-}" = "$_lock" ]; then
  command -v flock >/dev/null 2>&1 || exit 0
  flock -n "$_lock" true 2>/dev/null || exit 0
fi
echo "gbrain commit guard: refused a commit that did not come through gbrain git commit-push; nothing changed." >&2
echo "  Commit with: gbrain git commit-push -m '<msg>' -- <paths>   (or scripts/brain-commit-push.sh '<msg>' <paths>)" >&2
echo "  Bring remote commits in with: gbrain git commit-push --pull" >&2
echo "  A person can bypass it once: ${GUARD_BYPASS_ENV}=off git <command>   (docs/guides/shared-checkout-git.md#commit-guard)" >&2
exit 1
`;
}

export interface GuardStatus { installed: boolean; foreign: boolean; hook: string; repo: string }

function hookFile(root: string): { path: string; tracked: boolean } {
  const { dir, tracked } = resolveHooksDir(root);
  return { path: join(dir, GUARD_HOOK), tracked };
}

export function guardStatus(repo: string): GuardStatus {
  const root = checkoutRoot(repo);
  const { path } = hookFile(root);
  const body = existsSync(path) ? readFileSync(path, 'utf8') : null;
  return { installed: !!body?.includes(GUARD_BANNER), foreign: body !== null && !body.includes(GUARD_BANNER), hook: path, repo: root };
}

/** Install or refresh the guard. Refuses a managed worktree, git older than 2.31, and another tool's hook of the same name. */
export function installGuard(repo: string): GuardStatus & { changed: boolean } {
  const root = checkoutRoot(repo);
  assertManagedFilesystemWrite(root);
  const [maj, min] = gitVersion(root);
  if (maj < 2 || (maj === 2 && min < 31)) {
    throw opError('git_unavailable', `The commit guard needs git 2.31 or later (found ${maj}.${min}).`, 'Upgrade git on this machine, then rerun gbrain git guard --install. Nothing was changed.');
  }
  const { path, tracked } = hookFile(root);
  const script = renderGuardHook();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current !== null && !current.includes(GUARD_BANNER)) {
    throw opError('git_unavailable', `${path} is another tool's ${GUARD_HOOK} hook; gbrain does not replace it.`,
      'Move that hook aside or chain it yourself, then rerun gbrain git guard --install. Nothing was changed.', { detail: path });
  }
  if (current === script) return { ...guardStatus(root), changed: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  if (tracked) ensureExcluded(root, relative(root, path));
  return { ...guardStatus(root), changed: true };
}

export function uninstallGuard(repo: string): GuardStatus & { changed: boolean } {
  const root = checkoutRoot(repo);
  const status = guardStatus(root);
  if (!status.installed) return { ...status, changed: false };
  rmSync(status.hook, { force: true });
  return { ...guardStatus(root), changed: true };
}
