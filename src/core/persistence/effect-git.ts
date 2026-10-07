import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { execFileBounded, isDurabilityHardenedAsync } from '../brain-repo-durability.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { GitCommitNote } from './effect-model.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';

/** An index lock younger than this is contention; an older one is reported as stale. */
const INDEX_LOCK_GRACE_MS = 10 * 60 * 1000;
/** Git's lock refusal (LC_ALL=C below keeps it untranslated); greedy across lines so a path may hold apostrophes or newlines. */
const LOCK_REFUSAL = /Unable to create '([\s\S]*)': File exists/;
/**
 * One filesystem spelling for a lock path: the directory is canonicalized (a symlinked or PWD-preserved spelling of
 * the same checkout compares equal) but the lock's own name is not, because git locks the directory entry and a
 * symlink named like another lock must stay a different lock.
 */
const canonical = (path: string) => { try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; } };

const effectStatusFix = readFix('Shows each source\'s canonical owner with its retrying and parked Git effects, read-only.',
  { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] });
const gitFailure = (message: string, cause: string) => opError('git_unavailable', message,
  `${cause} The page write itself is committed; the effect worker tries this Git effect again and parks it after repeated failures. If it keeps failing, check the checkout with git status on the brain host.`,
  { fix: effectStatusFix });
const rootGone = (relativePath: string) => opError('git_target_unsafe', 'The canonical Git root disappeared.',
  `The canonical checkout was moved or deleted while ${relativePath} was being committed, so nothing was committed for it; the page write itself is committed. Inspect the owner and tell the user: Git effects resume only once the checkout is back, and how to restore it is their decision.`,
  { fix: effectStatusFix });

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0',
  GIT_ICASE_PATHSPECS: '0', LC_ALL: 'C' };

async function run(root: string, hooks: string, args: string[], signal?: AbortSignal) {
  return execFileBounded('git', ['--literal-pathspecs', '-C', root, '-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], {
    timeout: 20_000, maxBuffer: 1024 * 1024, signal, env: { ...process.env, ...GIT_ENV },
  });
}

/**
 * Git refused because another process holds this checkout's index lock. Only the checkout's own index lock
 * (`git rev-parse --git-path index.lock`, so linked worktrees resolve) qualifies; a ref or remote lock with
 * the same wording does not. The lock is never removed here: its holder may be a live git of the user or of
 * this owner, and a timestamp cannot prove otherwise. A fresh lock is contention; one older than the grace,
 * or dated in the future, is `git_index_stale`, which counts toward parking and names the lock.
 */
async function indexLockError(root: string, hooks: string, stderr: string, signal?: AbortSignal): Promise<OperationError | null> {
  const refused = LOCK_REFUSAL.exec(stderr)?.[1];
  if (!refused) return null;
  const located = await run(root, hooks, ['rev-parse', '--git-path', 'index.lock'], signal);
  if (located.error) return null;
  const lock = resolvePath(root, located.stdout.replace(/\n$/, ''));
  if (canonical(resolvePath(root, refused)) !== canonical(lock)) return null;
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return null; }
  if (age >= 0 && age < INDEX_LOCK_GRACE_MS) {
    return new OperationError('git_index_locked', 'Another Git process holds the canonical checkout index lock.', 'The effect is retried shortly.');
  }
  return new OperationError('git_index_stale', `A Git index lock older than 10 minutes blocks the canonical checkout: ${lock}.`,
    `If no git command is running in that checkout, remove ${lock}, then retry the effect with gbrain sources writer retry-effects <source> --request-id <id>.`);
}

async function git(root: string, hooks: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; code: number }> {
  const { error, stdout, stderr } = await run(root, hooks, args, signal);
  if (error && (error.killed || typeof error.code !== 'number')) throw gitFailure('Git execution did not finish within its bounded attempt.',
    'A git command in the canonical checkout did not finish within 20 seconds or could not start.');
  const code = error?.code as number ?? 0;
  if (code !== 0) { const locked = await indexLockError(root, hooks, stderr, signal); if (locked) throw locked; }
  return { stdout, code };
}

export const INDEX_LOCK_GRACE_FOR_TESTS = INDEX_LOCK_GRACE_MS;

type GitOutcome = { git: string; reason?: string; push?: string };

/**
 * Stage one single-file target. Returns 'changed' when the index now differs
 * for the path, 'unchanged', or a skip outcome for an absent target.
 */
async function stageTarget(root: string, hooks: string, relativePath: string, signal?: AbortSignal): Promise<{ path: string; state: 'changed' | 'unchanged' } | { path: string; skip: GitOutcome }> {
  const path = nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe');
  relativePath = relative(root, path).split(sep).join('/');
  const tracked = await git(root, hooks, ['ls-files', '-z', '--error-unmatch', '--', relativePath], signal);
  if (tracked.code !== 0 && tracked.code !== 1) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files failed for ${relativePath}.`);
  const changed = await git(root, hooks, ['status', '--porcelain', '--untracked-files=all', '--', relativePath], signal);
  if (changed.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git status failed for ${relativePath}.`);
  if (changed.stdout.trim()) {
    if (tracked.code === 0 || existsSync(path)) {
      const add = await git(root, hooks, ['add', '-A', '--', relativePath], signal);
      if (add.code !== 0) throw gitFailure('Cannot stage the canonical Git target.', `git add failed for ${relativePath}.`);
    }
    const diff = await git(root, hooks, ['diff', '--cached', '--quiet', '--', relativePath], signal);
    if (diff.code === 1) return { path: relativePath, state: 'changed' };
    if (diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target.', `git diff --cached failed for ${relativePath}.`);
    return { path: relativePath, state: 'unchanged' };
  }
  if (tracked.code === 0) return { path: relativePath, state: 'unchanged' };
  if (existsSync(path)) throw new OperationError('git_target_unsafe', 'Git cannot identify the existing canonical file by its native spelling.',
    'Reconcile the index and worktree spelling before retrying publication.');
  let parent = dirname(path);
  while (!existsSync(parent)) {
    if (parent === resolvePath(root)) throw rootGone(relativePath);
    parent = dirname(parent);
  }
  const scope = relative(root, parent).split(sep).join('/') || '.';
  const deleted = await git(root, hooks, ['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
  const staged = await git(root, hooks, ['diff', '--cached', '--name-only', '--diff-filter=D', '--no-renames', '-z', '--', scope], signal);
  if (deleted.code !== 0 || staged.code !== 0) throw gitFailure('Cannot inspect canonical Git deletions.', `git diff could not list the deletions under ${scope}.`);
  for (const entry of new Set(`${deleted.stdout}${staged.stdout}`.split('\0').filter(Boolean))) {
    if (existsSync(join(root, entry))) continue;
    let missingParent = dirname(nativeFileTarget(root, join(root, entry), 'git_target_unsafe'));
    while (!existsSync(missingParent)) {
      if (missingParent === resolvePath(root)) throw rootGone(relativePath);
      missingParent = dirname(missingParent);
    }
    if (missingParent === parent) throw new OperationError('git_target_unsafe', 'The absent target cannot be distinguished from an indexed deletion.',
      'Reconcile the recorded deletion path with the Git index before retrying publication.');
  }
  return { path: relativePath, skip: { git: 'skipped', reason: 'target_absent', push: 'skipped' } };
}

function withHooks<T>(run: (hooks: string) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  return run(hooks).finally(() => rmSync(hooks, { recursive: true, force: true }));
}

const commitText = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, '');

/**
 * #5530: commit a group of single-file targets with one `commit --only`. The
 * caller owns the native worktree lock and has probed durability. Each
 * target's outcome (or its own error) is keyed by its requested relative
 * path; a failing target never enters the commit. Nothing is pushed.
 *
 * `notes` (keyed by requested path) carry a preparer's commit metadata: a
 * path that commits alone with a note uses its subject; a group keeps the
 * generic subject and lists the noted paths' lines in the body, in path
 * order. Control characters are stripped from both.
 */
export async function commitGitTargets(root: string, relativePaths: string[], signal?: AbortSignal,
  notes?: ReadonlyMap<string, GitCommitNote>): Promise<Map<string, GitOutcome | OperationError>> {
  const results = new Map<string, GitOutcome | OperationError>();
  await withHooks(async hooks => {
    // One ls-files, one status, one add and one diff for the group; targets
    // that are neither tracked nor present take the per-target path, which
    // owns the absent-target and native-spelling refusals.
    const normalized = new Map<string, string>();
    for (const requested of new Set(relativePaths)) {
      try { normalized.set(requested, relative(root, nativeFileTarget(root, resolvePath(root, requested), 'git_target_unsafe')).split(sep).join('/')); }
      catch (error) { if (!(error instanceof OperationError)) throw error; results.set(requested, error); }
    }
    const paths = [...new Set(normalized.values())];
    const list = async (args: string[]) => {
      const out = paths.length ? await git(root, hooks, [...args, '--', ...paths], signal) : { stdout: '', code: 0 };
      if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ${args[0]} failed for this group of ${paths.length} file(s).`);
      return out.stdout;
    };
    const tracked = new Set((await list(['ls-files', '-z'])).split('\0').filter(Boolean));
    const dirty = new Set((await list(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])).split('\0').filter(Boolean).map(entry => entry.slice(3)));
    const changed: { requested: string; path: string }[] = [];
    const staged: string[] = [];
    for (const [requested, path] of normalized) {
      if (!tracked.has(path) && !(existsSync(join(root, path)) && dirty.has(path))) {
        try {
          const target = await stageTarget(root, hooks, requested, signal);
          if ('skip' in target) results.set(requested, target.skip);
          else if (target.state === 'changed') changed.push({ requested, path: target.path });
          else results.set(requested, { git: 'unchanged' });
        } catch (error) { if (!(error instanceof OperationError)) throw error; results.set(requested, error); }
      } else if (dirty.has(path)) staged.push(path);
      else results.set(requested, { git: 'unchanged' });
    }
    if (staged.length) {
      const add = await git(root, hooks, ['add', '-A', '--', ...new Set(staged)], signal);
      if (add.code !== 0) throw gitFailure('Cannot stage the canonical Git target.', `git add failed for this group of ${new Set(staged).size} file(s).`);
      const diff = await git(root, hooks, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--', ...new Set(staged)], signal);
      if (diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target.', `git diff --cached failed for this group of ${new Set(staged).size} file(s).`);
      const indexed = new Set(diff.stdout.split('\0').filter(Boolean));
      for (const [requested, path] of normalized) {
        if (!staged.includes(path) || results.has(requested)) continue;
        if (indexed.has(path)) changed.push({ requested, path });
        else results.set(requested, { git: 'unchanged' });
      }
    }
    if (!changed.length) return;
    // --only keeps unrelated staged paths out of this commit. After a lost
    // database acknowledgment the same HEAD/file state is an exact no-op.
    const commitPaths = [...new Set(changed.map(c => c.path))];
    const noted = new Map<string, GitCommitNote>();
    for (const c of changed) { const note = notes?.get(c.requested); if (note && !noted.has(c.path)) noted.set(c.path, note); }
    const subject = commitPaths.length > 1 ? `gbrain: persist ${commitPaths.length} canonical memory updates`
      : commitText(noted.get(commitPaths[0]!)?.subject ?? '') || 'gbrain: persist canonical memory update';
    const body = commitPaths.length > 1 ? [...new Set([...noted.keys()].sort().map(path => commitText(noted.get(path)!.line)).filter(Boolean))] : [];
    const result = await git(root, hooks, ['commit', '--only', '-m', subject, ...(body.length ? ['-m', body.join('\n')] : []), '--', ...commitPaths], signal);
    const outcome = result.code === 0 ? { git: 'committed' } : gitFailure('Cannot commit the canonical Git target.',
      `git commit failed for ${commitPaths.length} file(s); a missing Git identity (user.name, user.email) in that checkout is one cause to check.`);
    for (const c of changed) results.set(c.requested, outcome);
  });
  return results;
}

/** Push the current branch to its tracking remote once. A plain push is idempotent and cannot import remote canonical content. */
export async function pushGitRoot(root: string, signal?: AbortSignal): Promise<{ push: 'committed' } | { push: 'skipped'; reason: 'no_tracking_remote' }> {
  return withHooks(async hooks => {
    const branch = await git(root, hooks, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    if (branch.code !== 0) return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const remote = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.remote`], signal);
    const merge = await git(root, hooks, ['config', '--get', `branch.${branch.stdout.trim()}.merge`], signal);
    if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const push = await git(root, hooks, ['push', '--', remote.stdout.trim(), `HEAD:${merge.stdout.trim()}`], signal);
    if (push.code !== 0) throw opError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.',
      `git push to ${remote.stdout.trim()} failed (network, credentials or a rejected non-fast-forward). Nothing is lost locally and the worker pushes again on a later pass; gbrain never pulls or rebases the checkout. If it keeps failing, check the remote and its credentials with git push on the brain host.`,
      { fix: effectStatusFix });
    return { push: 'committed' } as const;
  });
}

/**
 * Caller owns the native worktree lock. Never run pull, rebase, or legacy hooks.
 * `hardened` is the caller's durability probe of `root`, taken before it locked
 * the worktree.
 */
export async function publishGitEffect(root: string, relativePath: string, signal?: AbortSignal,
  hardened?: boolean, note?: GitCommitNote): Promise<Record<string, unknown>> {
  if (!(hardened ?? await isDurabilityHardenedAsync(root))) return { git: 'skipped', reason: 'durability_not_enabled', push: 'skipped' };
  const outcome = (await commitGitTargets(root, [relativePath], signal, note ? new Map([[relativePath, note]]) : undefined)).get(relativePath)!;
  if (outcome instanceof OperationError) throw outcome;
  if (outcome.reason === 'target_absent') return outcome;
  const pushed = await pushGitRoot(root, signal);
  return { git: outcome.git, ...pushed };
}
