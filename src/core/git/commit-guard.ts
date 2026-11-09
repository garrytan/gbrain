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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV } from '../git-transport.ts';
import { ensureExcluded, resolveHooksDir } from '../brain-repo-durability.ts';
import { assertManagedFilesystemWrite } from '../persistence/filesystem-guard.ts';
import { opError } from '../ops/contract.ts';
import { checkoutRoot, gitVersion, COMMIT_LOCK_NAME, COMMIT_VIA_ENV } from './commit-push.ts';

export const GUARD_HOOK = 'prepare-commit-msg';
export const GUARD_BANNER = '# gbrain commit guard (prepare-commit-msg)';
export const GUARD_BYPASS_ENV = 'GBRAIN_COMMIT_GUARD';

/** PR B Part 5: the owner-path guard's mode line; enforce mode keeps only the merge exemption. */
export const GUARD_ENFORCE_MARKER = '# mode: enforce (managed worktree: only its owner commits; cherry-pick, revert, rebase and sequencer commits are refused too)';
export type GuardMode = 'default' | 'enforce';

/** No mode: the shared-checkout guard of `gbrain git guard`. A mode: the owner-path guard of `gbrain sources guard`. */
export function renderGuardHook(owner?: GuardMode): string {
  const enforce = owner === 'enforce';
  return `#!/usr/bin/env bash
${GUARD_BANNER}
${enforce ? `${GUARD_ENFORCE_MARKER}
# LOCAL + untracked: installed by gbrain sources guard <source> --install --mode enforce, removed by --uninstall.`
    : owner ? '# LOCAL + untracked: installed by gbrain sources guard <source> --install, removed by --uninstall.'
    : '# LOCAL + untracked: installed by gbrain git guard --install, removed by --uninstall.'}
# Refuses commits in this shared brain checkout (--no-verify included) that did not come
# through gbrain git commit-push or gbrain's own page writes, which hold the commit lock.
# A person can bypass it for one command: ${GUARD_BYPASS_ENV}=off git <command>
[ "\${${GUARD_BYPASS_ENV}:-}" = off ] && exit 0
[ "\${2:-}" = merge ] && exit 0
${owner ? `# git worktree add copies config.worktree, so a worktree added after the install inherits this hooks path: only the owner worktree is guarded.
# GST-1623: a git dir git cannot name fails closed; only a hook that belongs to another git dir passes.
_gd="$(git rev-parse --absolute-git-dir 2>/dev/null)" && [ -n "$_gd" ] && _gd="$(cd "$_gd" && pwd -P)" || { echo "gbrain commit guard: could not resolve this checkout's git dir, so the commit was refused; nothing changed." >&2; exit 1; }
[ "$_gd" = "$(cd "$(dirname "$0")/.." && pwd -P)" ] || exit 0
` : ''}for _op in ${enforce ? 'MERGE_HEAD' : 'MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer'}; do
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

// ── PR B Part 5: the owner-path guard (gbrain sources guard) ───────────────

/** The hooks directory private to one worktree; core.hooksPath points there through `git config --worktree`. */
export const OWNER_HOOKS_DIR = 'gbrain-hooks';
const GBRAIN_HOOK = /^# gbrain (commit guard|brain-durability post-commit hook)/m;

export interface OwnerGuardStatus {
  installed: boolean;
  mode: GuardMode | null;
  /** Hooks of other tools at the effective hooks path (pointing the worktree elsewhere would silence them). */
  foreign: string[];
  hook: string;
  /** Where git looks for this worktree's hooks now (core.hooksPath honored). */
  hooks_path: string;
  worktree: string;
  worktree_config: boolean;
}

function gitIn(root: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: gitChildEnv({ ...GIT_ENV, LC_ALL: 'C' }) }).toString().trim(), stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? -1, stdout: e.stdout?.toString().trim() ?? '', stderr: e.stderr?.toString().trim() ?? String(error) };
  }
}

function gitMust(root: string, args: string[]): string {
  const r = gitIn(root, args);
  if (r.code !== 0) throw opError('git_unavailable', `git ${args.join(' ')} failed in ${root}: ${r.stderr.slice(0, 300) || `exit ${r.code}`}`, `Check that git works in ${root} (git status), then rerun. Nothing else was changed.`);
  return r.stdout;
}

function ownerPaths(worktree: string) {
  const root = checkoutRoot(worktree);
  const gitDir = gitMust(root, ['rev-parse', '--absolute-git-dir']);
  const common = resolve(root, gitMust(root, ['rev-parse', '--git-common-dir']));
  const own = join(gitDir, OWNER_HOOKS_DIR);
  const effective = resolve(root, gitMust(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']));
  return { root, gitDir, common, own, hook: join(own, GUARD_HOOK), effective };
}

/** Active hooks at `dir` that gbrain did not write (sample files and gbrain's own hooks are not foreign). */
function foreignHooks(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(name => {
    if (name.endsWith('.sample')) return false;
    const path = join(dir, name);
    try { if (!statSync(path).isFile()) return false; return !GBRAIN_HOOK.test(readFileSync(path, 'utf8')); } catch { return false; }
  }).map(name => join(dir, name));
}

export function ownerGuardStatus(worktree: string): OwnerGuardStatus {
  const p = ownerPaths(worktree);
  const body = existsSync(p.hook) ? readFileSync(p.hook, 'utf8') : null;
  const installed = p.effective === p.own && !!body?.includes(GUARD_BANNER);
  return { installed, mode: installed ? (body!.includes(GUARD_ENFORCE_MARKER) ? 'enforce' : 'default') : null,
    foreign: p.effective === p.own ? (body !== null && !body.includes(GUARD_BANNER) ? [p.hook] : []) : foreignHooks(p.effective),
    hook: p.hook, hooks_path: p.effective, worktree: p.root, worktree_config: gitIn(p.root, ['config', '--type=bool', '--get', 'extensions.worktreeConfig']).stdout === 'true' };
}

/**
 * Point only this worktree's core.hooksPath at a hooks directory inside its own git dir and write the guard there. With
 * linked worktrees present, extensions.worktreeConfig is enabled first (moving core.bare / core.worktree into the main
 * worktree's config.worktree, as git requires), so a sibling worktree keeps its own hooks. Refuses, changing nothing, on
 * git older than 2.31 or another tool's hook at the effective hooks path. gbrain's own hooks there (the brain-durability
 * post-commit hook decides whether Git effects commit and push) are copied along, so the switch silences none of them.
 * The caller holds the worktree's writer lock.
 */
export function installOwnerGuard(worktree: string, mode: GuardMode): OwnerGuardStatus & { changed: boolean } {
  const p = ownerPaths(worktree);
  const [maj, min] = gitVersion(p.root);
  if (maj < 2 || (maj === 2 && min < 31)) {
    throw opError('git_unavailable', `The owner-path guard needs git 2.31 or later (found ${maj}.${min}).`, 'Upgrade git on the owner host, then rerun. Nothing was changed.');
  }
  const before = ownerGuardStatus(p.root);
  if (before.foreign.length) {
    throw opError('git_unavailable', `Another tool's hook(s) live at this worktree's hooks path ${p.effective}: ${before.foreign.join(', ')}; gbrain does not replace or silence them.`,
      'Move those hooks aside or chain them yourself, then rerun the same gbrain sources guard --install command. Nothing was changed.', { detail: before.foreign.join(',') });
  }
  const script = renderGuardHook(mode);
  const current = existsSync(p.hook) ? readFileSync(p.hook, 'utf8') : null;
  let changed = false;
  if (current !== script) {
    mkdirSync(p.own, { recursive: true });
    writeFileSync(p.hook, script);
    chmodSync(p.hook, 0o755);
    changed = true;
  }
  if (p.effective !== p.own) {
    for (const name of existsSync(p.effective) ? readdirSync(p.effective) : []) {
      const from = join(p.effective, name), to = join(p.own, name);
      if (name === GUARD_HOOK || name.endsWith('.sample') || !statSync(from).isFile()) continue;
      const body = readFileSync(from, 'utf8');
      if (!GBRAIN_HOOK.test(body) || (existsSync(to) && readFileSync(to, 'utf8') === body)) continue;
      writeFileSync(to, body);
      chmodSync(to, 0o755);
    }
    if (!before.worktree_config) enableWorktreeConfig(p.root, p.common);
    gitMust(p.root, ['config', '--worktree', 'core.hooksPath', p.own]);
    changed = true;
  }
  return { ...ownerGuardStatus(p.root), changed };
}

/** git's documented upgrade: core.bare=true and core.worktree move from the common config to the main worktree's config.worktree. */
function enableWorktreeConfig(root: string, common: string): void {
  const config = join(common, 'config');
  const main = join(common, 'config.worktree');
  for (const key of ['core.bare', 'core.worktree']) {
    const value = gitIn(root, ['config', '--file', config, '--get', key]);
    if (value.code !== 0 || (key === 'core.bare' && value.stdout !== 'true')) continue;
    gitMust(root, ['config', '--file', main, key, value.stdout]);
    gitMust(root, ['config', '--file', config, '--unset', key]);
  }
  gitMust(root, ['config', '--file', config, 'extensions.worktreeConfig', 'true']);
}

export function uninstallOwnerGuard(worktree: string): OwnerGuardStatus & { changed: boolean } {
  const p = ownerPaths(worktree);
  let changed = false;
  if (existsSync(p.hook) && readFileSync(p.hook, 'utf8').includes(GUARD_BANNER)) { rmSync(p.hook, { force: true }); changed = true; }
  if (gitIn(p.root, ['config', '--worktree', '--get', 'core.hooksPath']).stdout === p.own) {
    gitMust(p.root, ['config', '--worktree', '--unset', 'core.hooksPath']);
    changed = true;
  }
  return { ...ownerGuardStatus(p.root), changed };
}
