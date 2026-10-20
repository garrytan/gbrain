import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { execFileBounded } from '../brain-repo-durability.ts';
import { gitDurabilityPolicy } from './git-durability-policy.ts';
import type { WorktreeBinding } from './ownership.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { GitCommitNote } from './effect-model.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';
import { gitChildEnv } from '../git-env.ts';
import type { Action } from '../agent-output.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { proveIndexLockAbandoned, reclaimIndexLock, type IndexLockReclaim } from './index-lock-reclaim.ts';

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

/** #6665: Git for Windows' cached directory listing can still show a delete-pending file; a removal is probed and committed without it. */
const NO_FSCACHE = ['-c', 'core.fscache=false'];
const targetPending = (path: string) => opError('git_target_pending', `Git still lists ${path} in the index although it is absent on disk.`,
  `The removal of ${path} could not be staged, so nothing was committed for it; the page write itself is committed. The effect worker retries it and parks it after repeated failures. On Windows another program (a sync watcher, an indexer or antivirus) may still hold the file open: close it, check with git -c core.fscache=false status on the brain host, then retry the parked effect.`,
  { fix: effectStatusFix });

/** GIT_OPTIONAL_LOCKS=0: read-only steps (status) never take the index lock for an opportunistic refresh. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_GLOB_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0',
  GIT_ICASE_PATHSPECS: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/** Every git step gets at least this long. */
const GIT_STEP_TIMEOUT_MS = 20_000;
/**
 * #6932: each staging and commit step reads, and add/commit rewrite, the whole index, so a large checkout
 * gets this much more per MiB of index, up to {@link GIT_STEP_TIMEOUT_CAP_MS}.
 */
const GIT_STEP_MS_PER_INDEX_MIB = 2_000;
const GIT_STEP_TIMEOUT_CAP_MS = 120_000;
/** A git stalled in I/O or memory reclaim acts on SIGTERM seconds late; SIGKILL before then leaves index.lock behind. */
const GIT_TERM_GRACE_MS = 10_000;

/** The canonical writer's hold on the checkout: it alone may reclaim an abandoned index lock there. */
export interface GitEffectOwner {
  writerLock: NativeLockHandle;
  onReclaim?: (receipt: IndexLockReclaim) => void;
}

interface GitSession { root: string; hooks: string; signal?: AbortSignal; timeoutMs: number; owner?: GitEffectOwner }

function run(session: GitSession, args: string[]) {
  return execFileBounded('git', ['--literal-pathspecs', '-C', session.root, '-c', `core.hooksPath=${session.hooks}`, '-c', 'commit.gpgsign=false', ...args], {
    timeout: session.timeoutMs, termGraceMs: GIT_TERM_GRACE_MS, maxBuffer: 1024 * 1024, signal: session.signal, env: gitChildEnv(GIT_ENV),
  });
}

/** The deadline of one staging or commit step in a checkout whose index holds `indexBytes`. */
export function gitStepTimeoutMs(indexBytes: number): number {
  return Math.min(GIT_STEP_TIMEOUT_CAP_MS, GIT_STEP_TIMEOUT_MS + Math.ceil(Math.max(0, indexBytes) / (1024 * 1024)) * GIT_STEP_MS_PER_INDEX_MIB);
}

/** This checkout's step deadline; the floor when its index cannot be located. */
async function stepTimeoutMs(session: GitSession): Promise<number> {
  const located = await run(session, ['rev-parse', '--git-path', 'index']);
  if (located.error) return GIT_STEP_TIMEOUT_MS;
  try { return gitStepTimeoutMs(statSync(resolvePath(session.root, located.stdout.replace(/\n$/, ''))).size); }
  catch { return GIT_STEP_TIMEOUT_MS; }
}

const staleLockFix = (root: string, lock: string, why: string): Action => ({
  ask_user: true, actor: 'user', consent: [], requires_exclusive: false,
  why: `gbrain did not remove the lock because it could not prove the lock is abandoned: ${why}.`,
  user_message: `A Git index lock (${lock}) has blocked the canonical checkout ${root} for over 10 minutes, so Git backups of new page writes are parked. gbrain did not remove it because ${why}. Please check that no git command is running in that checkout; if none is, remove ${lock}, then run the retry command that gbrain sources writer status lists for each parked effect.`,
  verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] },
});

/**
 * Git refused because another process holds this checkout's index lock. Only the checkout's own index lock
 * (`git rev-parse --git-path index.lock`, so linked worktrees resolve) qualifies; a ref or remote lock with
 * the same wording does not. #6932: while the canonical writer holds its writer lock, a lock it proves
 * abandoned (index-lock-reclaim.ts) is reclaimed and the step runs again ('reclaimed'). Otherwise the lock
 * stays: a fresh one is contention; one older than the grace, or dated in the future, is `git_index_stale`,
 * which counts toward parking, names the lock and says why it was not reclaimed.
 */
async function indexLockError(session: GitSession, stderr: string, mayReclaim: boolean): Promise<OperationError | 'reclaimed' | null> {
  const refused = LOCK_REFUSAL.exec(stderr)?.[1];
  if (!refused) return null;
  const located = await run(session, ['rev-parse', '--git-path', 'index.lock']);
  if (located.error) return null;
  const lock = resolvePath(session.root, located.stdout.replace(/\n$/, ''));
  if (canonical(resolvePath(session.root, refused)) !== canonical(lock)) return null;
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return null; }
  let why = 'this caller does not hold the checkout\'s writer lock';
  if (session.owner && !session.owner.writerLock.released && mayReclaim) {
    const verdict = proveIndexLockAbandoned(lock, session.root, INDEX_LOCK_GRACE_MS);
    const receipt = verdict.abandoned ? reclaimIndexLock(lock, session.root, verdict) : null;
    if (receipt) { session.owner.onReclaim?.(receipt); return 'reclaimed'; }
    why = verdict.abandoned ? 'the lock changed while it was being reclaimed' : verdict.reason;
  }
  if (age >= 0 && age < INDEX_LOCK_GRACE_MS) {
    return new OperationError('git_index_locked', 'Another Git process holds the canonical checkout index lock.', 'The effect is retried shortly.');
  }
  return opError('git_index_stale', `A Git index lock older than 10 minutes blocks the canonical checkout: ${lock}.`,
    `gbrain did not remove it because ${why}. If no git command is running in that checkout, remove ${lock}, then retry the effect with gbrain sources writer retry-effects <source> --request-id <id>.`,
    { detail: lock, fix: staleLockFix(session.root, lock, why) });
}

async function git(session: GitSession, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  for (let reclaimed = false; ; reclaimed = true) {
    const { error, stdout, stderr } = await run(session, args);
    if (error && (error.killed || typeof error.code !== 'number')) throw gitFailure('Git execution did not finish within its bounded attempt.',
      `A git command in the canonical checkout did not finish within ${Math.round(session.timeoutMs / 1000)} seconds or could not start.`);
    const code = error?.code as number ?? 0;
    if (code === 0) return { stdout, stderr, code };
    const locked = await indexLockError(session, stderr, !reclaimed);
    if (locked === 'reclaimed') continue;
    if (locked) throw locked;
    return { stdout, stderr, code };
  }
}

export const INDEX_LOCK_GRACE_FOR_TESTS = INDEX_LOCK_GRACE_MS;

type GitOutcome = { git: string; reason?: string; push?: string };

/**
 * Stage one single-file target. Returns 'changed' when the index now differs
 * for the path, 'unchanged', or a skip outcome for an absent target.
 */
async function stageTarget(session: GitSession, relativePath: string): Promise<{ path: string; state: 'changed' | 'unchanged' } | { path: string; skip: GitOutcome }> {
  const root = session.root;
  const path = nativeFileTarget(root, resolvePath(root, relativePath), 'git_target_unsafe');
  relativePath = relative(root, path).split(sep).join('/');
  const tracked = await git(session, ['ls-files', '-z', '--error-unmatch', '--', relativePath]);
  if (tracked.code !== 0 && tracked.code !== 1) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files failed for ${relativePath}.`);
  const changed = await git(session, ['status', '--porcelain', '--untracked-files=all', '--', relativePath]);
  if (changed.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git status failed for ${relativePath}.`);
  if (changed.stdout.trim()) {
    if (tracked.code === 0 || existsSync(path)) {
      const add = await git(session, ['add', '-A', '--', relativePath]);
      if (add.code !== 0) throw gitFailure('Cannot stage the canonical Git target.', `git add failed for ${relativePath}.`);
    }
    const diff = await git(session, ['diff', '--cached', '--quiet', '--', relativePath]);
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
  const deleted = await git(session, ['diff', '--name-only', '--relative', '--diff-filter=D', '--no-renames', '-z', '--', scope]);
  const staged = await git(session, ['diff', '--cached', '--name-only', '--relative', '--diff-filter=D', '--no-renames', '-z', '--', scope]);
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

/** A git session with an empty hooks directory; `scaled` sizes its step deadline by the checkout's index. */
async function withSession<T>(root: string, signal: AbortSignal | undefined, owner: GitEffectOwner | undefined, scaled: boolean,
  work: (session: GitSession) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  try {
    const session: GitSession = { root, hooks, signal, owner, timeoutMs: GIT_STEP_TIMEOUT_MS };
    if (scaled) session.timeoutMs = await stepTimeoutMs(session);
    return await work(session);
  } finally { rmSync(hooks, { recursive: true, force: true }); }
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
 * order. A note's `gbrain-repair:` trailer goes in the message's last
 * paragraph (one line per noted path), where Git reads trailers. Control
 * characters are stripped from all three.
 *
 * `owner` is the caller's writer lock on this checkout: with it, an index lock
 * that is provably abandoned is reclaimed and the step retried (#6932).
 */
export async function commitGitTargets(root: string, relativePaths: string[], signal?: AbortSignal,
  notes?: ReadonlyMap<string, GitCommitNote>, owner?: GitEffectOwner): Promise<Map<string, GitOutcome | OperationError>> {
  const results = new Map<string, GitOutcome | OperationError>();
  await withSession(root, signal, owner, true, async session => {
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
      const out = paths.length ? await git(session, [...args, '--', ...paths]) : { stdout: '', code: 0 };
      if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ${args[0]} failed for this group of ${paths.length} file(s).`);
      return out.stdout;
    };
    // #7091: ls-files and `diff --relative` print paths relative to the root, but status prints them relative to the
    // repository toplevel; a root below the toplevel (local_path <repo>/brain) strips its prefix so every listing compares.
    const prefix = paths.length ? (await git(session, ['rev-parse', '--show-prefix'])).stdout.replace(/\n$/, '') : '';
    const tracked = new Set((await list(['ls-files', '-z'])).split('\0').filter(Boolean));
    const dirty = new Set((await list(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])).split('\0').filter(Boolean)
      .map(entry => entry.slice(3)).map(path => path.startsWith(prefix) ? path.slice(prefix.length) : path));
    const changed: { requested: string; path: string }[] = [];
    const staged: string[] = [];
    // #6665: a tracked path absent on disk is staged as a removal without trusting status, which can
    // still list a delete-pending file on Windows (core.fscache), so status said clean and nothing was committed.
    const removed = new Set(paths.filter(path => tracked.has(path) && !existsSync(join(root, path))));
    for (const [requested, path] of normalized) {
      if (removed.has(path)) continue;
      if (!tracked.has(path) && !(existsSync(join(root, path)) && dirty.has(path))) {
        try {
          const target = await stageTarget(session, requested);
          if ('skip' in target) results.set(requested, target.skip);
          else if (target.state === 'changed') changed.push({ requested, path: target.path });
          else results.set(requested, { git: 'unchanged' });
        } catch (error) { if (!(error instanceof OperationError)) throw error; results.set(requested, error); }
      } else if (dirty.has(path)) staged.push(path);
      else results.set(requested, { git: 'unchanged' });
    }
    if (staged.length) {
      const add = await git(session, ['add', '-A', '--', ...new Set(staged)]);
      if (add.code !== 0) throw gitFailure('Cannot stage the canonical Git target.', `git add failed for this group of ${new Set(staged).size} file(s).`);
      const diff = await git(session, ['diff', '--cached', '--name-only', '--relative', '-z', '--no-renames', '--', ...new Set(staged)]);
      if (diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target.', `git diff --cached failed for this group of ${new Set(staged).size} file(s).`);
      const indexed = new Set(diff.stdout.split('\0').filter(Boolean));
      for (const [requested, path] of normalized) {
        if (!staged.includes(path) || results.has(requested)) continue;
        if (indexed.has(path)) changed.push({ requested, path });
        else results.set(requested, { git: 'unchanged' });
      }
    }
    if (removed.size) {
      const removals = [...removed];
      const rm = await git(session, [...NO_FSCACHE, 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...removals]);
      if (rm.code !== 0) throw gitFailure('Cannot stage the canonical Git target removal.', `git rm --cached failed for this group of ${removals.length} removed file(s).`);
      const kept = await git(session, [...NO_FSCACHE, 'ls-files', '-z', '--', ...removals]);
      const diff = await git(session, ['diff', '--cached', '--name-only', '--relative', '-z', '--no-renames', '--', ...removals]);
      if (kept.code !== 0 || diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target removal.', `git ls-files or git diff --cached failed for this group of ${removals.length} removed file(s).`);
      const still = new Set(kept.stdout.split('\0').filter(Boolean));
      const indexed = new Set(diff.stdout.split('\0').filter(Boolean));
      for (const [requested, path] of normalized) {
        if (!removed.has(path)) continue;
        if (still.has(path)) results.set(requested, targetPending(path));
        else if (indexed.has(path)) changed.push({ requested, path });
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
    const trailers = [...new Set([...noted.keys()].sort().map(path => commitText(noted.get(path)!.trailer ?? '')).filter(Boolean))];
    const result = await git(session, [...(commitPaths.some(path => removed.has(path)) ? NO_FSCACHE : []), 'commit', '--only', '-m', subject, ...(body.length ? ['-m', body.join('\n')] : []), ...(trailers.length ? ['-m', trailers.join('\n')] : []), '--', ...commitPaths]);
    const outcome = result.code === 0 ? { git: 'committed' } : gitFailure('Cannot commit the canonical Git target.',
      `git commit failed for ${commitPaths.length} file(s); a missing Git identity (user.name, user.email) in that checkout is one cause to check.`);
    for (const c of changed) results.set(c.requested, outcome);
  });
  return results;
}

/**
 * #7089: whether `root`'s branch has commits its upstream (the local remote-tracking ref, never fetched) lacks; false
 * without an upstream. A Git effect whose target is absent asks this before completing: its removal may have been
 * committed by an earlier attempt whose push failed, and only a root that is ahead owes a push.
 */
export async function gitRootAhead(root: string, signal?: AbortSignal): Promise<boolean> {
  return withSession(root, signal, undefined, false, async session => {
    const count = await git(session, ['rev-list', '--count', '@{upstream}..HEAD']);
    return count.code === 0 && Number(count.stdout.trim()) > 0;
  });
}

/** Git's refusal of a push because the remote branch moved (LC_ALL=C keeps it untranslated). */
const NON_FAST_FORWARD = /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/;

/**
 * Push the current branch to its tracking remote. A plain push is tried first (idempotent, cannot import remote
 * content). #7010: when the remote moved (a non-fast-forward rejection), the push goes through the shared-checkout
 * publish (`commitAndPush` with `keepCheckout`), which merges the remote commits in memory and pushes the merge
 * without moving the checkout, so `gbrain sources refresh` stays the only importer of remote files. That publish
 * runs synchronously; it starts only after the remote answered this push. Both sides changing one file holds the
 * effect with `integrate_conflict` and the user's choice as its fix.
 */
export async function pushGitRoot(root: string, signal?: AbortSignal): Promise<{ push: 'committed'; integrated?: number } | { push: 'skipped'; reason: 'no_tracking_remote' }> {
  return withSession(root, signal, undefined, false, async session => {
    const branch = await git(session, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.code !== 0) return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const remote = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.remote`]);
    const merge = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.merge`]);
    if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const push = await git(session, ['push', '--', remote.stdout.trim(), `HEAD:${merge.stdout.trim()}`]);
    if (push.code === 0) return { push: 'committed' } as const;
    if (!NON_FAST_FORWARD.test(push.stderr)) throw opError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.',
      `git push to ${remote.stdout.trim()} failed (network, credentials or a remote that refused it). Nothing is lost locally and the worker pushes again on a later pass; gbrain never pulls or rebases the checkout. If it keeps failing, check the remote and its credentials with git push on the brain host.`,
      { fix: effectStatusFix });
    signal?.throwIfAborted();
    return publishKeepingCheckout(root, signal);
  });
}

/** #7010: the bound on one keep-checkout publish (a fetch, an in-memory merge and a push, repeated while the remote keeps moving). */
const KEEP_CHECKOUT_PUBLISH_TIMEOUT_MS = 600_000;

/**
 * #7010: run the shared publish in a child `gbrain git commit-push --push-only --keep-checkout`. The shared publish is
 * synchronous (fetches and pushes block for up to minutes), so it never runs on the owner's event loop, where it
 * would stall lease renewals. The child is this process's own executable, never a `gbrain` found on PATH (an older
 * install would not know the flag); a busy publish lock fails at once and the effect retries.
 */
async function publishKeepingCheckout(root: string, signal?: AbortSignal): Promise<{ push: 'committed'; integrated?: number }> {
  const { CHILD_ENV, resolveChildCliInvocation } = await import('../minions/job-isolation.ts');
  const cli = resolveChildCliInvocation(process.env, process.execPath, process.argv[1], () => null);
  if (!cli) throw opError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.',
    `The remote branch moved, and publishing over it runs gbrain git commit-push --push-only --keep-checkout, but this process could not locate its own gbrain executable (set ${CHILD_ENV.childCliOverride} to it). Nothing is lost locally.`,
    { fix: effectStatusFix });
  const child = await execFileBounded(cli.cmd, [...cli.argsPrefix, 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', root, '--json'], {
    timeout: KEEP_CHECKOUT_PUBLISH_TIMEOUT_MS, termGraceMs: GIT_TERM_GRACE_MS, maxBuffer: 1024 * 1024, signal,
    env: { ...process.env, GBRAIN_PUBLISH_LOCK_WAIT_SECONDS: '0', GBRAIN_PUSH_LOCK_WAIT_SECONDS: '0' },
  });
  signal?.throwIfAborted();
  let doc: Record<string, unknown> | null = null;
  try { doc = JSON.parse(child.stdout.trim()); } catch { /* reported below */ }
  if (!child.error && doc?.outcome === 'pushed') return { push: 'committed', ...(Number(doc.integrated) ? { integrated: Number(doc.integrated) } : {}) };
  if (doc && typeof doc.code === 'string' && typeof doc.message === 'string') {
    const error = opError(doc.code as Parameters<typeof opError>[0], doc.message, typeof doc.suggestion === 'string' ? doc.suggestion : '',
      { ...(typeof doc.detail === 'string' ? { detail: doc.detail } : {}), ...(doc.fix ? { fix: doc.fix as Action } : {}), retryable: doc.retryable === true });
    throw error.code === 'integrate_conflict' ? heldConflict(root, error) : error;
  }
  throw opError('push_unconfirmed', 'The canonical commit is durable locally; its push will retry.',
    `The remote branch moved and the keep-checkout publish did not report a push (${child.error ? `exit ${String(child.error.code ?? child.error.signal ?? 'unknown')}` : `outcome ${String(doc?.outcome ?? 'unreadable')}`}: ${child.stderr.trim().slice(0, 300) || 'no detail'}). Nothing is lost locally; the worker pushes again on a later pass.`,
    { fix: effectStatusFix, retryable: true });
}

/**
 * #7010: a true conflict holds the checkout's Git effects (they retry, then park) until the user picks a side.
 * The fix keeps the shared publish's choice command (`--keep-checkout`, so the checkout stays put) and adds the
 * retry of parked effects and a read-only verify.
 */
function heldConflict(root: string, error: OperationError): OperationError {
  const fix = error.fix as Action | undefined;
  const held = opError('integrate_conflict', `Git backups of canonical page writes are held: ${error.message}`,
    `${error.suggestion ?? ''} The page writes themselves are committed in the database and in local commits; nothing is lost, and nothing is pushed from ${root} until the conflict is resolved. After the choice is pushed, gbrain sources writer retry-effects with --parked-pushes for the source this checkout backs (gbrain sources writer status names it) retries the Git effects that parked meanwhile, and gbrain sources refresh for that source brings the merged remote files into the checkout.`,
    { ...(error.detail ? { detail: error.detail } : {}), fix: { ...(fix ?? { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
      why: 'Choosing which version of a file wins discards the other side; ask the user before resolving.' }),
    user_message: `${fix?.user_message ?? 'This machine and the remote changed the same file.'} Until you choose, Git backups of new page writes from ${root} are held (nothing is lost; the database has every write).`,
    verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
  return held;
}

/** The outcome a Git effect records when its root has no durability hook: no git command ran. */
export const DURABILITY_NOT_ENABLED = { git: 'skipped', reason: 'durability_not_enabled', push: 'skipped' } as const;

/**
 * Caller owns the native worktree lock. Never run pull, rebase, or legacy hooks.
 * `hardened` is the caller's durability verdict for `root`, taken before it
 * locked the worktree. Without one, the binding's recorded git_durability
 * decides (#5182): `enabled`/`disabled` never consult the legacy hook probe,
 * and an unrecorded binding falls back to the probe, fail-closed.
 * #7089: an absent target pushes when the root is ahead of its upstream (an
 * earlier attempt may have committed its removal and failed to push); on a
 * root that is not ahead it completes without a push, as before.
 */
export async function publishGitEffect(root: string, relativePath: string, signal?: AbortSignal,
  hardened?: boolean, note?: GitCommitNote, binding?: Pick<WorktreeBinding, 'git_durability'> | null, owner?: GitEffectOwner): Promise<Record<string, unknown>> {
  if (!(hardened ?? (await gitDurabilityPolicy(binding, root)).durable)) return { ...DURABILITY_NOT_ENABLED };
  const outcome = (await commitGitTargets(root, [relativePath], signal, note ? new Map([[relativePath, note]]) : undefined, owner)).get(relativePath)!;
  if (outcome instanceof OperationError) throw outcome;
  if (outcome.reason === 'target_absent' && !(await gitRootAhead(root, signal))) return outcome;
  const pushed = await pushGitRoot(root, signal);
  return { ...outcome, ...pushed };
}
