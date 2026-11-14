import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { execFileBounded } from '../brain-repo-durability.ts';
import { gitDurabilityPolicy } from './git-durability-policy.ts';
import type { WorktreeBinding } from './ownership.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { adoptedBy, type GitCommitNote } from './effect-model.ts';
import { persistenceHome } from './identity.ts';
import { nativeFileTarget } from './native-file-target.ts';
import { gitChildEnv, literalPathspecs } from '../git-env.ts';
import type { Action } from '../agent-output.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { proveIndexLockAbandoned, reclaimIndexLock, type IndexLockReclaim } from './index-lock-reclaim.ts';
import { recordCommitAsync, recordIntentAsync } from '../git/commit-ledger.ts';
import { supersededBy } from './import-deferral.ts';
import { rangeSecretRefusal, scanRange } from '../git/range-secret-scan.ts';

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
export const gitFailure = (message: string, cause: string) => opError('git_unavailable', message,
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

export interface GitSession { root: string; hooks: string; signal?: AbortSignal; timeoutMs: number; owner?: GitEffectOwner; indexFile?: string;
  /** GST-2128: puts back the index entries a step staged; withSession runs it when the work throws. */
  undoStaging?: () => Promise<void> }

/** #7759: no global --literal-pathspecs (Git would export it to every hook and child); pathspecs pass through literalPathspecs. */
const gitArgs = (session: GitSession, args: string[]) =>
  ['-C', session.root, '-c', `core.hooksPath=${session.hooks}`, '-c', 'commit.gpgsign=false', ...args];
const gitOptions = (session: GitSession) => ({ timeout: session.timeoutMs, termGraceMs: GIT_TERM_GRACE_MS, maxBuffer: 1024 * 1024, signal: session.signal });
/** Replace refs are off, so the commit a Git effect or the door builds is made of the objects the push secret scan reads. */
const sessionEnv = (session: GitSession) => ({ ...GIT_ENV, GIT_NO_REPLACE_OBJECTS: '1', ...(session.indexFile ? { GIT_INDEX_FILE: session.indexFile } : {}) });

function run(session: GitSession, args: string[]) {
  return execFileBounded('git', gitArgs(session, args), { ...gitOptions(session), env: gitChildEnv(sessionEnv(session)) });
}

/** A read-only git step whose stdout is raw bytes (a tree object); null when git exits non-zero. */
export async function gitBytes(session: GitSession, args: string[]): Promise<Buffer | null> {
  const { error, stdout } = await execFileBounded('git', gitArgs(session, args), { ...gitOptions(session), env: gitChildEnv(sessionEnv(session)), maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  if (error && (error.killed || typeof error.code !== 'number')) throw gitFailure('Git execution did not finish within its bounded attempt.',
    `A git command in the canonical checkout did not finish within ${Math.round(session.timeoutMs / 1000)} seconds or could not start.`);
  return error ? null : stdout;
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
 * #6932: while this session's caller holds the checkout's writer lock, reclaims `lock` once it is proven abandoned
 * (index-lock-reclaim.ts). True when it was reclaimed; otherwise why it stays.
 */
export function reclaimAbandonedIndexLock(session: GitSession, lock: string): true | string {
  if (!session.owner || session.owner.writerLock.released) return 'this caller does not hold the checkout\'s writer lock';
  const verdict = proveIndexLockAbandoned(lock, session.root, INDEX_LOCK_GRACE_MS);
  const receipt = verdict.abandoned ? reclaimIndexLock(lock, session.root, verdict) : null;
  if (receipt) { session.owner.onReclaim?.(receipt); return true; }
  return verdict.abandoned ? 'the lock changed while it was being reclaimed' : verdict.reason;
}

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
  if (mayReclaim) {
    const reclaimed = reclaimAbandonedIndexLock(session, lock);
    if (reclaimed === true) return 'reclaimed';
    why = reclaimed;
  }
  if (age >= 0 && age < INDEX_LOCK_GRACE_MS) {
    return new OperationError('git_index_locked', 'Another Git process holds the canonical checkout index lock.', 'The effect is retried shortly.');
  }
  return opError('git_index_stale', `A Git index lock older than 10 minutes blocks the canonical checkout: ${lock}.`,
    `gbrain did not remove it because ${why}. If no git command is running in that checkout, remove ${lock}, then retry the effect with gbrain sources writer retry-effects <source> --request-id <id>.`,
    { detail: lock, fix: staleLockFix(session.root, lock, why) });
}

export async function git(session: GitSession, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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
  const tracked = await git(session, ['ls-files', '-z', '--error-unmatch', '--', ...literalPathspecs([relativePath])]);
  if (tracked.code !== 0 && tracked.code !== 1) throw gitFailure('Cannot inspect the canonical Git target.', `git ls-files failed for ${relativePath}.`);
  const changed = await git(session, ['status', '--porcelain', '--untracked-files=all', '--', ...literalPathspecs([relativePath])]);
  if (changed.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git status failed for ${relativePath}.`);
  if (changed.stdout.trim()) {
    if (tracked.code === 0 || existsSync(path)) {
      const add = await git(session, ['add', '-A', '--', ...literalPathspecs([relativePath])]);
      if (add.code !== 0) throw gitFailure('Cannot stage the canonical Git target.', `git add failed for ${relativePath}.`);
    }
    const diff = await git(session, ['diff', '--cached', '--quiet', '--', ...literalPathspecs([relativePath])]);
    if (diff.code === 1) return { path: relativePath, state: 'changed' };
    if (diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target.', `git diff --cached failed for ${relativePath}.`);
    return { path: relativePath, state: 'unchanged' };
  }
  if (tracked.code === 0) return { path: relativePath, state: 'unchanged' };
  if (existsSync(path)) await refuseIgnoredTarget(session, relativePath);
  if (existsSync(path)) throw new OperationError('git_target_unsafe', 'Git cannot identify the existing canonical file by its native spelling.',
    'Reconcile the index and worktree spelling before retrying publication.');
  let parent = dirname(path);
  while (!existsSync(parent)) {
    if (parent === resolvePath(root)) throw rootGone(relativePath);
    parent = dirname(parent);
  }
  const scope = relative(root, parent).split(sep).join('/') || '.';
  const deleted = await git(session, ['diff', '--name-only', '--relative', '--diff-filter=D', '--no-renames', '-z', '--', ...literalPathspecs([scope])]);
  const staged = await git(session, ['diff', '--cached', '--name-only', '--relative', '--diff-filter=D', '--no-renames', '-z', '--', ...literalPathspecs([scope])]);
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

/**
 * GBRA-133: an existing untracked file a .gitignore rule excludes cannot be committed while the rule stands. It refuses
 * as `git_target_ignored` naming the rule (`detail`), so the effect parks at once with the cause instead of looping.
 */
async function refuseIgnoredTarget(session: GitSession, relativePath: string): Promise<void> {
  const status = await git(session, ['status', '--porcelain', '--ignored=matching', '--untracked-files=all', '--', ...literalPathspecs([relativePath])]);
  if (status.code !== 0 || !status.stdout.startsWith('!! ')) return;
  throw ignoredTargetError(relativePath, await ignoreRule(session, relativePath));
}

/** The ignore rule (`source:line: pattern`) that matches `relativePath`, tracked or not; `.gitignore` when git cannot name it. */
async function ignoreRule(session: GitSession, relativePath: string): Promise<string> {
  // check-ignore refuses pathspec magic and reads a path literally except a leading ':', which ./ keeps literal; it only names the rule.
  const matched = await run(session, ['check-ignore', '--no-index', '-v', '--', relativePath.startsWith(':') ? `./${relativePath}` : relativePath]);
  return matched.error ? '.gitignore' : matched.stdout.split('\t')[0]!.replace(/^(.*?):(\d+):/, '$1:$2: ');
}

/** The refusal of a target a .gitignore `rule` (`source:line: pattern`) excludes; `detail` names the rule. */
export function ignoredTargetError(relativePath: string, rule: string): OperationError {
  const error = new OperationError('git_target_ignored', `Git ignores ${relativePath} (${rule}), so its Git effect cannot commit it.`,
    `Either remove or narrow the rule (${rule}) and commit that change, then retry the parked effects with gbrain sources writer retry-effects and --parked-code git_target_ignored for the source this checkout backs (gbrain sources writer status names it); or keep the file out of Git and leave the effect parked. The page itself is committed in the database.`);
  error.detail = rule;
  return error;
}

/** A git session with an empty hooks directory; `scaled` sizes its step deadline by the checkout's index. */
export async function withSession<T>(root: string, signal: AbortSignal | undefined, owner: GitEffectOwner | undefined, scaled: boolean,
  work: (session: GitSession) => Promise<T>): Promise<T> {
  const base = join(persistenceHome(), 'empty-hooks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const hooks = mkdtempSync(join(base, 'effect-'));
  try {
    const session: GitSession = { root, hooks, signal, owner, timeoutMs: GIT_STEP_TIMEOUT_MS };
    if (scaled) session.timeoutMs = await stepTimeoutMs(session);
    try { return await work(session); }
    catch (error) { await session.undoStaging?.(); throw error; }
  } finally { rmSync(hooks, { recursive: true, force: true }); }
}

const commitText = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, '');

/**
 * The message paragraphs (`-m` arguments) of a commit of `commitPaths` (see commitGitTargets): the subject, the noted
 * paths' lines when several paths commit together, and their trailers last.
 */
export function commitMessage(commitPaths: string[], noted: ReadonlyMap<string, GitCommitNote>): string[] {
  const subject = commitPaths.length > 1 ? `gbrain: persist ${commitPaths.length} canonical memory updates`
    : commitText(noted.get(commitPaths[0]!)?.subject ?? '') || 'gbrain: persist canonical memory update';
  const body = commitPaths.length > 1 ? [...new Set([...noted.keys()].sort().map(path => commitText(noted.get(path)!.line)).filter(Boolean))] : [];
  const trailers = [...new Set([...noted.keys()].sort().flatMap(path => (noted.get(path)!.trailers ?? []).map(commitText)).filter(Boolean))];
  return [subject, ...(body.length ? [body.join('\n')] : []), ...(trailers.length ? [trailers.join('\n')] : [])];
}

/** Over this many bytes a commit message goes through a file (`-F`): command lines are bounded (32 KiB on Windows). */
export const COMMIT_MESSAGE_ARG_BYTES = 8 * 1024;

/**
 * The git arguments that give a commit `paragraphs` as its message: `-m` per paragraph, or one `-F <file>` written in
 * `dir` once the message is large. Git joins `-m` paragraphs with a blank line, so both forms produce the same message.
 */
export function commitMessageArgs(paragraphs: string[], dir: string | (() => string)): string[] {
  const text = paragraphs.join('\n\n');
  if (Buffer.byteLength(text, 'utf-8') <= COMMIT_MESSAGE_ARG_BYTES) return paragraphs.flatMap(paragraph => ['-m', paragraph]);
  const file = join(typeof dir === 'string' ? dir : dir(), 'commit-message');
  writeFileSync(file, `${text}\n`, { mode: 0o600 });
  return ['-F', file];
}

/**
 * #5530: commit a group of single-file targets with one commit (`effectCommit`). The
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
 *
 * #9227: `commits` receives, for each requested path this call committed, the commit's oid, which the Git effect
 * records in its outcome so a receipt read later can name it.
 */
export async function commitGitTargets(root: string, relativePaths: string[], signal?: AbortSignal,
  notes?: ReadonlyMap<string, GitCommitNote>, owner?: GitEffectOwner, expected?: ReadonlyMap<string, string | null>,
  commits?: Map<string, string>): Promise<Map<string, GitOutcome | OperationError>> {
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
      const out = paths.length ? await git(session, [...args, '--', ...literalPathspecs(paths)]) : { stdout: '', code: 0 };
      if (out.code !== 0) throw gitFailure('Cannot inspect the canonical Git target.', `git ${args[0]} failed for this group of ${paths.length} file(s).`);
      return out.stdout;
    };
    // #7091: ls-files and `diff --relative` print paths relative to the root, but status prints them relative to the
    // repository toplevel; a root below the toplevel (local_path <repo>/brain) strips its prefix so every listing compares.
    const prefix = paths.length ? (await git(session, ['rev-parse', '--show-prefix'])).stdout.replace(/\n$/, '') : '';
    // GST-2552: the HEAD the group stages against; a commit landing after it that touches a target wins over the staged blob.
    const baseline = paths.length ? await git(session, ['rev-parse', '--verify', '--quiet', 'HEAD']) : null;
    const indexBefore = await indexSnapshot(session, paths);
    session.undoStaging = () => restoreIndex(session, prefix, paths, indexBefore);
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
      // GST-2128: tracked paths stage with add -u, which takes a tracked file under a folder an ignore rule covers (plain
      // add stages it yet exits 1) and can never add an untracked file; untracked paths with add -A, which refuses an
      // ignored one. A file either add refuses never parks the group: each file is then staged alone, and a refused one
      // fails by itself (git_target_ignored naming the rule when that is why) with what was staged of it put back.
      const stage = async (paths: string[]) => {
        const kept = paths.filter(path => tracked.has(path)), fresh = paths.filter(path => !tracked.has(path));
        const runs = [...(kept.length ? [['add', '-u', '--', ...literalPathspecs(kept)]] : []), ...(fresh.length ? [['add', '-A', '--', ...literalPathspecs(fresh)]] : [])];
        for (const args of runs) { const out = await git(session, args); if (out.code !== 0) return out; }
        return null;
      };
      let addable = [...new Set(staged)];
      if (await stage(addable)) {
        const refused = new Map<string, OperationError>();
        for (const path of addable) {
          const out = await stage([path]);
          if (out) refused.set(path, /ignored by one of your \.gitignore files/.test(out.stderr) ? ignoredTargetError(path, await ignoreRule(session, path))
            : gitFailure('Cannot stage the canonical Git target.', `git add failed for ${path}.`));
        }
        // Every file refused for a reason other than an ignore rule is git itself failing, not one file: the group fails as before.
        if (refused.size === addable.length && [...refused.values()].every(error => error.code !== 'git_target_ignored')) {
          throw gitFailure('Cannot stage the canonical Git target.', `git add failed for this group of ${addable.length} file(s).`);
        }
        for (const [requested, path] of normalized) if (refused.has(path)) results.set(requested, refused.get(path)!);
        if (refused.size) await restoreIndex(session, prefix, [...refused.keys()], indexBefore);
        addable = addable.filter(path => !refused.has(path));
      }
      const diff = addable.length ? await git(session, ['diff', '--cached', '--name-only', '--relative', '-z', '--no-renames', '--', ...literalPathspecs(addable)]) : { code: 0, stdout: '' };
      if (diff.code !== 0) throw gitFailure('Cannot compare the canonical Git target.', `git diff --cached failed for this group of ${addable.length} file(s).`);
      const indexed = new Set(diff.stdout.split('\0').filter(Boolean));
      for (const [requested, path] of normalized) {
        if (!addable.includes(path) || results.has(requested)) continue;
        if (indexed.has(path)) changed.push({ requested, path });
        else results.set(requested, { git: 'unchanged' });
      }
    }
    if (removed.size) {
      const removals = [...removed];
      const rm = await git(session, [...NO_FSCACHE, 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...literalPathspecs(removals)]);
      if (rm.code !== 0) throw gitFailure('Cannot stage the canonical Git target removal.', `git rm --cached failed for this group of ${removals.length} removed file(s).`);
      const kept = await git(session, [...NO_FSCACHE, 'ls-files', '-z', '--', ...literalPathspecs(removals)]);
      const diff = await git(session, ['diff', '--cached', '--name-only', '--relative', '-z', '--no-renames', '--', ...literalPathspecs(removals)]);
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
    // Only these paths are committed; unrelated staged paths stay staged. After a lost
    // database acknowledgment the same HEAD/file state is an exact no-op.
    const commitPaths = [...new Set(changed.map(c => c.path))];
    const noted = new Map<string, GitCommitNote>();
    for (const c of changed) { const note = notes?.get(c.requested); if (note && !noted.has(c.path)) noted.set(c.path, note); }
    const wanted = new Map<string, string | null>();
    for (const c of changed) {
      const hash = expected?.get(c.requested);
      wanted.set(c.path, hash !== undefined && (!wanted.has(c.path) || wanted.get(c.path) === hash) ? hash : '');
    }
    mkdirSync(persistenceHome(), { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(persistenceHome(), 'effect-commit-'));
    let commit: EffectCommit;
    try {
      commit = await effectCommit(session, root, prefix, scratch, commitPaths, wanted, commitMessage(commitPaths, noted).map(stripspace).filter(Boolean), noted,
        baseline?.code === 0 ? baseline.stdout.trim() : null);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    const { sha, moved, superseded, foreign } = commit;
    // A moved path's index entry another writer replaced stays theirs; one this effect still staged goes back to HEAD's, so
    // no later commit from the index reverts the other commit (a retry stages the file again). Only the rest is restored.
    if (!sha) await restoreIndex(session, prefix, paths.filter(path => !moved.includes(path)), indexBefore);
    const own = moved.filter(path => !foreign.includes(path));
    const reset = !own.length || await git(session, ['reset', '-q', '--', ...literalPathspecs(own)]).then(out => out.code === 0, () => false);
    const outcome = sha ? { git: 'committed' } : moved.length ? gitFailure('Cannot commit the canonical Git target.',
      `Another commit or process changed ${moved.join(', ')} while this group of ${commitPaths.length} file(s) was being committed, so nothing was committed and the other commit stays; the effect retries against the new HEAD.`)
      : gitFailure('Cannot commit the canonical Git target.',
        `git commit failed for ${commitPaths.length} file(s); a missing Git identity (user.name, user.email) in that checkout is one cause to check.`);
    for (const c of changed) {
      const result = reset && superseded.includes(c.path) ? { git: 'superseded', reason: 'committed_by_another_writer' } : outcome;
      results.set(c.requested, result);
      if (sha && result === outcome) commits?.set(c.requested, sha);
    }
  });
  return results;
}

interface IndexSnapshot { entries: Map<string, string>; flagged: Map<string, string> }

/** The index records (`ls-files -s`) and assume-unchanged or skip-worktree tags (`ls-files -v`) under `paths`, keyed by repository path. */
async function indexSnapshot(session: GitSession, paths: string[]): Promise<IndexSnapshot> {
  if (!paths.length) return { entries: new Map(), flagged: new Map() };
  const listed = await git(session, ['ls-files', '-s', '--full-name', '-z', '--', ...literalPathspecs(paths)]);
  const tagged = await git(session, ['ls-files', '-v', '--full-name', '-z', '--', ...literalPathspecs(paths)]);
  if (listed.code !== 0 || tagged.code !== 0) throw gitFailure('Cannot inspect the canonical Git index.', `git ls-files failed for this group of ${paths.length} file(s).`);
  const records = (out: string) => out.split('\0').filter(Boolean);
  return {
    entries: new Map(records(listed.stdout).map(record => [record.slice(record.indexOf('\t') + 1), record.slice(0, record.indexOf('\t'))])),
    flagged: new Map(records(tagged.stdout).filter(record => /^[a-zS] /.test(record)).map(record => [record.slice(2), record[0]!])),
  };
}

/**
 * GST-2128: puts the index entries under `paths` back to `before` after an effect group's add or commit failed. `git add`
 * already staged them in the checkout's shared index, and a parked effect that leaves them there makes every later
 * commit-push naming that folder refuse `commit_prestaged_paths`. Only entries that changed and still differ from HEAD
 * are rewritten, so a commit that landed before its step failed is never reversed in the index; a rewritten entry gets
 * its assume-unchanged or skip-worktree flag back. It runs without the session's abort signal, since an aborted step is
 * one it has to clean up after. Best effort: a failure here never hides the step's own.
 */
async function restoreIndex(session: GitSession, prefix: string, paths: string[], before: IndexSnapshot): Promise<void> {
  try {
    session = { ...session, signal: undefined };
    const now = await indexSnapshot(session, paths);
    const local = (path: string) => path.startsWith(prefix) ? path.slice(prefix.length) : path;
    // ls-tree takes no wildcards but does read pathspec magic (a leading ':'), so each path goes literal.
    const tree = await git(session, ['ls-tree', '-r', '--full-name', '-z', 'HEAD', '--', ...literalPathspecs(paths)]);
    const head = new Map(tree.code !== 0 ? [] : tree.stdout.split('\0').filter(Boolean).map(record => {
      const [mode, , oid] = record.slice(0, record.indexOf('\t')).split(' ');
      return [record.slice(record.indexOf('\t') + 1), `${mode} ${oid} 0`] as const;
    }));
    const staged = (path: string) => now.entries.get(path) !== head.get(path);
    const wanted = new Set(paths);
    const added = [...now.entries.keys()].filter(path => !before.entries.has(path) && staged(path));
    // An entry gone from the index comes back only for a file gone from disk, as the group's own removals are: a file
    // still on disk was untracked by another writer (git rm --cached), and putting it back would track it again.
    const changed = [...before.entries].filter(([path, entry]) => wanted.has(local(path)) && now.entries.get(path) !== entry && staged(path)
      && (now.entries.has(path) || !existsSync(join(session.root, local(path)))));
    if (added.length) await git(session, ['update-index', '--force-remove', '--', ...added.map(local)]);
    const cacheinfo = changed.filter(([, entry]) => entry.endsWith(' 0')).flatMap(([path, entry]) => ['--cacheinfo', `${entry.split(' ')[0]},${entry.split(' ')[1]},${path}`]);
    if (cacheinfo.length) await git(session, ['update-index', '--add', ...cacheinfo]);
    for (const [flag, tags] of [['--skip-worktree', /[sS]/], ['--assume-unchanged', /[a-z]/]] as const) {
      const flagged = changed.map(([path]) => path).filter(path => tags.test(before.flagged.get(path) ?? ''));
      if (flagged.length) await git(session, ['update-index', flag, '--', ...flagged.map(local)]);
    }
  } catch { /* the step's own failure is what the effect reports and retries */ }
}

/** Git's whitespace cleanup of a `-m` paragraph, as `git commit -m` applies it: trailing blanks, repeated and edge blank lines go. */
export function stripspace(paragraph: string): string {
  const lines: string[] = [];
  for (const line of paragraph.split('\n').map(text => text.replace(/[ \t\r]+$/, ''))) if (line || lines.length && lines[lines.length - 1]) lines.push(line);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

/**
 * #8896: a Git effect's commit, made by plumbing so its sha is gbrain's own before any ref names it. The index entries
 * `git add` just staged for `paths` are laid over HEAD's tree in a scratch index, `commit-tree` writes the commit, the
 * ledger records its sha, and `update-ref HEAD <new> <old>` moves the branch only if HEAD is still the commit it was
 * built on; a moved HEAD is read again and the commit rebuilt once. Null when git fails or HEAD moved twice. The
 * secret scan skips an effect commit only by this recorded sha, so an amend, reset or reword is a different commit and
 * is scanned. The record is `verified` only when every path's staged blob is the bytes the effect wrote (`wanted`: the
 * sha256 the effect recorded, null for a removal, '' for none known): the file, read once, hashes to it and has the
 * staged blob's id; an outside edit that reached the index first fails that, and the commit is scanned. An index that
 * no longer holds what was staged (an entry for a file that is gone, none for one on disk, or an entry another process
 * reset to `baseline`'s, which would report that path committed with its old blob), or a tree that equals HEAD's, fails
 * the commit, so the effect retries rather than reporting a commit of the wrong state.
 *
 * GST-2552: the staged blobs are laid only over a HEAD that holds every path as `baseline` (the HEAD the group staged
 * against) did, with the checkout's index still holding what was staged. A commit that landed since and touched a path,
 * or an index entry someone else replaced, means the staged blob is stale for that path: nothing is committed (Git
 * stays the parent, so the other commit stays) and the path is `moved`. A path the other commit changed whose file no
 * longer holds the staged bytes was superseded by it, and the next sync imports its version; the rest fail and retry.
 */
interface EffectCommit { sha: string | null; moved: string[]; superseded: string[]; foreign: string[] }
export const effectSeams: { beforeUpdateRef?: (root: string, attempt: number) => Promise<void> | void } = {};

async function effectCommit(session: GitSession, root: string, prefix: string, scratch: string, paths: string[],
  wanted: ReadonlyMap<string, string | null>, paragraphs: string[], noted: ReadonlyMap<string, GitCommitNote>, baseline: string | null): Promise<EffectCommit> {
  const failed: EffectCommit = { sha: null, moved: [], superseded: [], foreign: [] };
  const indexed = async () => {
    const listed = await git(session, ['ls-files', '-s', '-z', '--', ...literalPathspecs(paths)]);
    return listed.code !== 0 ? null : new Map(listed.stdout.split('\0').filter(Boolean).map(entry => {
      const [mode, oid, stage] = entry.slice(0, entry.indexOf('\t')).split(' ');
      return [entry.slice(entry.indexOf('\t') + 1), { mode: mode!, oid: oid!, stage: stage! }] as const;
    }));
  };
  // ls-tree reads the paths from the working directory (root) and prints them from the toplevel (prefix).
  const committed = async (commit: string | null) => {
    if (!commit) return new Map<string, string>();
    const tree = await git(session, ['ls-tree', '-r', '--full-name', '-z', commit, '--', ...literalPathspecs(paths)]);
    return tree.code !== 0 ? null : new Map(tree.stdout.split('\0').filter(Boolean)
      .map(record => [record.slice(record.indexOf('\t') + 1 + prefix.length), record.slice(0, record.indexOf('\t'))] as const));
  };
  const format = await git(session, ['rev-parse', '--show-object-format']);
  const staged = await indexed();
  if (format.code !== 0 || !staged) return failed;
  if ([...staged.values()].some(entry => entry.stage !== '0') || paths.some(path => staged.has(path) !== existsSync(join(root, path)))) return failed;
  const base = await committed(baseline);
  if (!base) return failed;
  const reset = paths.filter(path => { const record = staged.get(path); return (record && `${record.mode} blob ${record.oid}`) === base.get(path); });
  if (reset.length) return { sha: null, moved: reset, superseded: [], foreign: reset };
  const entry = (record?: { mode: string; oid: string; stage: string }) => record && `${record.mode} ${record.oid} ${record.stage}`;
  // Whether the file still holds what the effect staged: its recorded sha256 when known (clean filters change the blob id).
  const holds = (path: string) => {
    const record = staged.get(path), hash = wanted.get(path);
    if (!record) return !existsSync(join(root, path));
    if (!record.mode.startsWith('100')) return true;
    const digests = fileDigests(join(root, path), format.stdout.trim());
    return !!digests && (hash ? digests.startsWith(`${hash} `) : digests.endsWith(` ${record.oid}`));
  };
  const verified = paths.every(path => {
    const hash = wanted.get(path), entry = staged.get(path);
    if (hash === undefined || hash === '') return false;
    return hash === null ? !entry : !!entry && entry.mode.startsWith('100') && fileDigests(join(root, path), format.stdout.trim()) === `${hash} ${entry.oid}`;
  });
  const trailers = [...noted.values()].flatMap(note => note.trailers ?? []);
  const supersedes = supersededBy(trailers), adopted = adoptedBy(trailers);
  const message = commitMessageArgs(paragraphs, scratch);
  for (let attempt = 0; ; attempt++) {
    // The first attempt builds on the HEAD the group staged against; a later one reads the moved HEAD again.
    const before = attempt ? await git(session, ['rev-parse', '--verify', '--quiet', 'HEAD']) : null;
    const head = before ? before.code === 0 ? before.stdout.trim() : null : baseline;
    if (head !== baseline) {
      const now = await committed(head), index = await indexed();
      if (!now || !index) return failed;
      // A commit that already holds the staged entry (a commit -a that swept it in) changed nothing this effect would lose.
      const committedAway = (path: string) => {
        const record = staged.get(path);
        return now.get(path) !== base.get(path) && now.get(path) !== (record && `${record.mode} blob ${record.oid}`);
      };
      const foreign = paths.filter(path => entry(index.get(path)) !== entry(staged.get(path)));
      const moved = paths.filter(path => foreign.includes(path) || committedAway(path));
      if (moved.length) return { sha: null, moved, superseded: moved.filter(path => committedAway(path) && !holds(path)), foreign };
    }
    await recordIntentAsync(root, { writer: 'effect', head_before: head, message: paragraphs.join('\n\n') });
    // update-index reads --cacheinfo paths from the toplevel and --force-remove paths from the working directory (root).
    const index: GitSession = { ...session, indexFile: join(scratch, `index-${attempt}`) };
    const removals = paths.filter(path => !staged.has(path));
    const entries = paths.flatMap(path => { const entry = staged.get(path); return entry ? ['--cacheinfo', `${entry.mode},${entry.oid},${prefix}${path}`] : []; });
    if ((await git(index, head ? ['read-tree', head] : ['read-tree', '--empty'])).code !== 0
      || entries.length && (await git(index, ['update-index', '--add', ...entries])).code !== 0
      || removals.length && (await git(index, ['update-index', '--force-remove', '--', ...removals])).code !== 0) return failed;
    const tree = await git(index, ['write-tree']);
    const parent = head ? await git(session, ['rev-parse', '--verify', '--quiet', `${head}^{tree}`]) : null;
    if (tree.code !== 0 || parent && (parent.code !== 0 || parent.stdout.trim() === tree.stdout.trim())) return failed;
    const commit = await git(session, ['commit-tree', tree.stdout.trim(), ...(head ? ['-p', head] : []), ...message]);
    if (commit.code !== 0) return failed;
    const created = commit.stdout.trim();
    await recordCommitAsync(root, { sha: created, writer: 'effect', ...(verified ? { verified: true } : {}),
      ...(supersedes.length ? { supersedes } : {}), ...(adopted.length ? { adopted } : {}) });
    await effectSeams.beforeUpdateRef?.(root, attempt);
    const updated = await git(session, ['update-ref', '-m', `commit: ${paragraphs[0]!.split('\n')[0]}`, 'HEAD', created, head ?? '']);
    if (updated.code === 0) {
      const detached = await git(session, ['maintenance', 'run', '--auto', '--quiet', '--detach']).catch(() => null);
      if (detached?.code === 129) await git(session, ['maintenance', 'run', '--auto', '--quiet']).catch(() => undefined);
      return { sha: created, moved: [], superseded: [], foreign: [] };
    }
    if (attempt) return failed;
  }
}

/** `<sha256> <git blob id>` of the file's bytes, read once; null when it cannot be read or changes size while read. */
export function fileDigests(path: string, objectFormat: string): string | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const content = createHash('sha256'), blob = createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1').update(`blob ${size}\0`);
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)); read += n) { content.update(buffer.subarray(0, n)); blob.update(buffer.subarray(0, n)); }
    return read === size ? `${content.digest('hex')} ${blob.digest('hex')}` : null;
  } finally { closeSync(fd); }
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
export const NON_FAST_FORWARD = /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/;
/** Git's refusal of a leased push because the remote branch moved after its tip was read. */
const STALE_LEASE = /\[rejected\][^\n]*\(stale info\)/;
/** The in-process secret scan's budget on the owner's event loop: under the consumer heartbeat's live window (CONSUMER_LIVE_MS). */
const OWNER_SCAN_BUDGET_MS = 10_000;

/**
 * Push the current branch to its tracking remote. A plain push is tried first (idempotent, cannot import remote
 * content). #7010: when the remote moved (a non-fast-forward rejection), the push goes through the shared-checkout
 * publish (`commitAndPush` with `keepCheckout`), which merges the remote commits in memory and pushes the merge
 * without moving the checkout, so `gbrain sources refresh` stays the only importer of remote files. That publish
 * runs synchronously; it starts only after the remote answered this push. Both sides changing one file holds the
 * effect with `integrate_conflict` and the user's choice as its fix.
 * #8896: a script's plain `git commit` in the checkout never passed the write path's scan, so both paths scan what
 * they publish. The plain push reads the remote branch tip (`git ls-remote`, never a possibly stale tracking ref,
 * which would hide a commit a rewound remote no longer has), scans exactly `<tip>..<HEAD sha>` and pushes that sha
 * only as a fast-forward of the tip, leased on it; a tip that is not an ancestor, or a remote that moves before the
 * push lands, goes to the shared publish, which fetches first and runs with `--scan-secrets`. A remote with no such
 * branch (a first push to a new remote) gets HEAD's whole history scanned and the branch created only if it does not
 * exist yet. A finding, an unscannable file or a commit changing what the scan sees holds the effect with
 * `publish_secret_found`; a range git cannot read in full holds it with `publish_scan_unreadable`. The in-process scan
 * runs synchronously on the owner's event loop, so it gets `scanBudgetMs` (well inside the consumer heartbeat's live
 * window); a range it cannot finish in that time goes to the shared publish, whose child process scans with the full budget,
 * except a whole history for a missing branch, which holds the effect with `publish_scan_unreadable` naming the upstream.
 */
export async function pushGitRoot(root: string, signal?: AbortSignal, scanBudgetMs = OWNER_SCAN_BUDGET_MS): Promise<{ push: 'committed'; integrated?: number } | { push: 'skipped'; reason: 'no_tracking_remote' }> {
  return withSession(root, signal, undefined, false, async session => {
    const branch = await git(session, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.code !== 0) return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const remote = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.remote`]);
    const merge = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.merge`]);
    if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') return { push: 'skipped', reason: 'no_tracking_remote' } as const;
    const head = await git(session, ['rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) throw gitFailure('Cannot read the canonical checkout\'s HEAD.', 'git rev-parse HEAD failed, so nothing was scanned or pushed.');
    const sha = head.stdout.trim(), short = merge.stdout.trim().replace(/^refs\/heads\//, ''), ref = `refs/heads/${short}`;
    const unavailable = () => opError('git_push_unavailable', 'The canonical commit is durable locally; its push will retry.',
      `git push to ${remote.stdout.trim()} failed (network, credentials or a remote that refused it). Nothing is lost locally and the worker pushes again on a later pass; gbrain never pulls or rebases the checkout. If it keeps failing, check the remote and its credentials with git push on the brain host.`,
      { fix: effectStatusFix });
    const listed = await git(session, ['ls-remote', '--', remote.stdout.trim(), ref]);
    if (listed.code !== 0) throw unavailable();
    const tip = listed.stdout.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0] ?? '';
    if (!tip || (await git(session, ['merge-base', '--is-ancestor', tip, sha])).code === 0) {
      const scan = scanRange(root, tip, sha, scanBudgetMs);
      if (!scan.timed_out) {
        const refusal = rangeSecretRefusal(root, tip, sha, scan);
        if (refusal) throw heldSecret(root, refusal);
        signal?.throwIfAborted();
        const push = await git(session, ['push', `--force-with-lease=${ref}:${tip}`, '--', remote.stdout.trim(), `${sha}:${ref}`]);
        if (push.code === 0) return { push: 'committed' } as const;
        if (!NON_FAST_FORWARD.test(push.stderr) && !STALE_LEASE.test(push.stderr)) throw unavailable();
      } else if (!tip) throw heldSecret(root, opError('publish_scan_unreadable',
        `${remote.stdout.trim()} has no branch ${short}, and the secret scan of the whole history a first push would create it with ran past its in-process budget. Nothing was pushed.`,
        `Check that the checkout's upstream (branch.${branch.stdout.trim()}.merge) names a branch the remote should have (git ls-remote --heads ${remote.stdout.trim()}). If the branch was deleted or renamed on purpose, point the upstream at the right branch, or review the history and push the branch yourself; gbrain never creates a remote branch from history it has not scanned.`,
        { detail: JSON.stringify({ unreadable: scan.unreadable }), fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
          argv: ['git', '-C', root, 'ls-remote', '--heads', '--', remote.stdout.trim()],
          why: 'Read-only: lists the branches the remote has, to check the checkout\'s upstream.',
          user_message: `The remote ${remote.stdout.trim()} has no branch ${short} for ${root}, and its whole history is too large to scan here, so nothing was pushed. Should the checkout's upstream point at another branch, or will you review the history and push this branch yourself?`,
          docs: 'docs/guides/shared-checkout-git.md#publish_scan_unreadable' } }));
    }
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
  const child = await execFileBounded(cli.cmd, [...cli.argsPrefix, 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets', '--path', root, '--json'], {
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
    throw error.code === 'integrate_conflict' ? heldConflict(root, error) : error.code === 'publish_secret_found' || error.code === 'publish_scan_unreadable' ? heldSecret(root, error) : error;
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

/**
 * #8896: a secret scan that refuses the unpublished commits (`publish_secret_found`) or cannot read them all
 * (`publish_scan_unreadable`) holds the checkout's Git effects (they retry, then park): no retry can succeed until the
 * user removes the values or allowlists a false positive, or repairs what kept the scan from reading the commits.
 */
function heldSecret(root: string, error: OperationError): OperationError {
  const fix = error.fix as Action | undefined;
  return opError(error.code as 'publish_secret_found' | 'publish_scan_unreadable', `Git backups of canonical page writes are held: ${error.message}`,
    `${error.suggestion ?? ''} The page writes themselves are committed in the database and in local commits; nothing is lost, and nothing is pushed from ${root} until the scan passes. Afterwards, gbrain sources writer retry-effects with --parked-pushes for the source this checkout backs (gbrain sources writer status names it) retries the Git effects that parked meanwhile.`,
    { ...(error.detail ? { detail: error.detail } : {}), fix: { ...(fix ?? { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
      why: 'Rewriting unpublished commits, allowlisting a value or repairing the checkout is the user\'s call.' }),
    user_message: `${fix?.user_message ?? `The secret scan refused the unpublished commits in ${root}.`} Until then, Git backups of new page writes from ${root} are held (nothing is lost; the database has every write).`,
    verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--json'] } } });
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
  hardened?: boolean, note?: GitCommitNote, binding?: Pick<WorktreeBinding, 'git_durability'> | null, owner?: GitEffectOwner,
  expectedHash?: string | null, commits?: Map<string, string>): Promise<Record<string, unknown>> {
  if (!(hardened ?? (await gitDurabilityPolicy(binding, root)).durable)) return { ...DURABILITY_NOT_ENABLED };
  const outcome = (await commitGitTargets(root, [relativePath], signal, note ? new Map([[relativePath, note]]) : undefined, owner,
    expectedHash === undefined ? undefined : new Map([[relativePath, expectedHash]]), commits)).get(relativePath)!;
  if (outcome instanceof OperationError) throw outcome;
  if (outcome.reason === 'target_absent' && !(await gitRootAhead(root, signal))) return outcome;
  const pushed = await pushGitRoot(root, signal);
  return { ...outcome, ...pushed };
}
