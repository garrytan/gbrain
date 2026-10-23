/**
 * Shared-checkout-safe commit, push and pull for classic (unmanaged) brain
 * repos (#6530). Many writers (agents, crons, hooks, gbrain's own
 * write-through) commit to ONE checkout, so nothing here rebases, stashes or
 * resets the working tree:
 *
 *   1. two locks per checkout: the short commit lock (`git rev-parse --git-path
 *      brain-commit.lock`, the same flock a bash `flock -x` takes) for local
 *      index/HEAD changes only, and the publish lock (brain-publish.lock) for
 *      the network push; a publisher takes the commit lock only to advance, and
 *      an unattended publisher that finds the publish lock busy leaves a request
 *      the holder honors after it releases (so no commit is stranded);
 *   2. commits carry only the caller's paths (`commit --only -- <paths>`);
 *   3. a rejected push is integrated IN MEMORY (`merge-tree --write-tree`, or a
 *      3-way `read-tree` into a temporary index on git < 2.38) into a merge
 *      commit built with `commit-tree`; no working tree is touched;
 *   4. the shared checkout advances only by `merge --ff-only`, which refuses
 *      (and changes nothing) when HEAD moved or a file it must change is dirty.
 *
 * Managed canonical worktrees are refused: the persistence owner is their
 * only writer. The one exception is a keep-checkout publish (`keepCheckout`,
 * `--push-only --keep-checkout`): it pushes HEAD, merging a moved remote in
 * memory, but never moves the checkout and skips its pre-push hook, so `gbrain sources
 * refresh` stays the only importer of remote files into a managed worktree
 * (#7010; the owner's Git effects publish this way). CLI-only; never exposed
 * over MCP (it pushes with host credentials).
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH, GIT_SSRF_SUBCOMMAND_FLAGS, durableSsrfFlags } from '../git-transport.ts';
import { assertManagedFilesystemWrite } from '../persistence/filesystem-guard.ts';
import { acquireNativeLock, acquireNativeLockSync, type NativeLockSyncHandle } from '../persistence/native-lock.ts';
import { OperationError, opError } from '../ops/contract.ts';

export const COMMIT_LOCK_NAME = 'brain-commit.lock';
/** Taken by pre-#6530 helpers and hooks; held too so they still exclude us during the mixed-version window. */
export const LEGACY_PUSH_LOCK_NAME = 'gbrain-push.lock';
export const COMMIT_LOCK_ENV = 'BRAIN_COMMIT_LOCK_HELD';
export const PUBLISH_LOCK_NAME = 'brain-publish.lock';
const PUBLISH_REQUEST_NAME = 'brain-publish.requested';
const CONFLICT_STATE_NAME = 'brain-integrate-conflict.json';
/** Write-through files gbrain wrote but could not commit (lock busy past the short budget, or a refused commit): one `<iso>\t<json path>` line each. */
const PENDING_NAME = 'brain-writethrough-pending.log';
/** Toplevel-relative source root(s) of this checkout, one value each (`gbrain sources harden` writes them); unset means the whole checkout. */
export const SOURCE_ROOT_CONFIG = 'gbrain.sourceRoot';
/** Set to the commit lock path on every commit gbrain makes under that lock; the opt-in commit guard admits only these. */
export const COMMIT_VIA_ENV = 'GBRAIN_COMMIT_VIA';
const MAX_PUSH_ATTEMPTS = 8;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const INDEX_LOCK_RETRIES = 5;

export type CheckoutState = 'advanced' | 'unchanged' | 'lagging';

export interface CommitPushResult {
  /** `push_deferred`: an unattended publish found another publish running and left it a request to publish HEAD too. */
  outcome: 'pushed' | 'nothing_to_commit' | 'pushed_checkout_lagging' | 'push_deferred';
  /** The commit now on the remote branch (the caller's commit or the merge built over it). */
  sha: string | null;
  committed: string | null;
  branch: string;
  remote: string;
  paths: string[];
  /** Remote commits merged in to publish. */
  integrated: number;
  /** `remote`: a push reported failure but every push destination already holds the commit (a lost acknowledgement or a concurrent pusher). */
  confirmed?: 'push' | 'remote';
  checkout: CheckoutState;
  lagging_reason?: string;
  /** Opt-in quarantine (git config gbrain.quarantine): the local versions of conflicting files, parked under a ref; the remote's version was published. */
  quarantined?: QuarantineEntry;
}

export interface PullResult {
  status: 'up_to_date' | 'advanced' | 'ahead' | 'skipped_dirty' | 'lagging';
  from?: string;
  to?: string;
  merged?: boolean;
  /** Why the checkout could not advance (dirty must-change file, HEAD moved). */
  reason?: string;
}

export interface CommitPushOptions {
  repo: string;
  /** Paths to commit, absolute or relative to `cwd`. Ignored with pushOnly. */
  paths?: string[];
  message?: string;
  pushOnly?: boolean;
  cwd?: string;
  lockWaitMs?: number;
  /** `--resolve`: blob choice per conflicted path for the in-memory merge. */
  resolutions?: Map<string, Resolution>;
  /** `--expect-remote`: the remote commit the resolutions were chosen against (required with resolutions). */
  expectRemote?: string;
  /** How long a foreground publish waits for another publish to finish. */
  publishWaitMs?: number;
  /** Unattended callers (the post-commit hook): publish, but advance the checkout only when it has no local edit. */
  advanceOnlyWhenClean?: boolean;
  /** Push-only: publish HEAD to this remote branch instead of the checked-out branch's upstream (the helper's `--push-only <branch>`). */
  branch?: string;
  /** Push-only: never advance the checkout and skip its pre-push hook (a managed canonical worktree; see the header). */
  keepCheckout?: boolean;
  /** Commit the pending write-through files (`--pending`) instead of named paths. */
  pending?: boolean;
  /** Commit and publish files outside the configured source root(s): the user's explicit choice, or gbrain's own scaffolding at the checkout root. */
  allowOutsideSourceRoot?: boolean;
}

export type Resolution = { kind: 'ours' } | { kind: 'theirs' } | { kind: 'file'; path: string };

interface Ctx {
  root: string;
  branch: string;
  remote: string;
  mergeRef: string;
  trackingRef: string;
  keepCheckout?: boolean;
}

interface GitRun { code: number; stdout: string; stderr: string }

function git(root: string, args: string[], opts: { auth?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): GitRun {
  const base = opts.auth ? { ...GIT_ENV_AUTH } : { ...GIT_ENV };
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '',
      timeout: opts.timeoutMs ?? 60_000,
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

function gitOk(root: string, args: string[], what: string, opts: Parameters<typeof git>[2] = {}): string {
  const r = git(root, args, opts);
  if (r.code !== 0) {
    throw opError('git_unavailable', `git ${what} failed in ${root}: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`,
      `Run git status in ${root}, fix what git reports, then rerun the same gbrain git commit-push command.`);
  }
  return r.stdout.trim();
}

/**
 * Transport flags for this checkout's OWN configured remotes: no redirects, no
 * external helpers, no submodule fetch surface. The file protocol keeps git's
 * default (`user`): a bare repo on the same host is a supported brain topology
 * (the pre-#6530 helper pushed to it with plain git), and the URL is the
 * operator's own config, not remote-supplied input. GBRAIN_GIT_ALLOW_FILE_TRANSPORT
 * still forces `always` for tests.
 */
function transportFlags(): string[] {
  return durableSsrfFlags().flatMap((flag, i, all) =>
    all[i - 1] === '-c' && flag.startsWith('protocol.file.allow=') && process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT !== '1'
      ? ['protocol.file.allow=user'] : [flag]);
}

/** Remote operations: transport hardening on every call, credentials allowed, no prompt. */
function remoteGit(root: string, sub: 'fetch' | 'push', args: string[], timeoutMs = 120_000): GitRun {
  return git(root, [...transportFlags(), sub, ...GIT_SSRF_SUBCOMMAND_FLAGS, ...args], { auth: true, timeoutMs });
}

export function gitVersion(root: string): [number, number] {
  const m = /git version (\d+)\.(\d+)/.exec(gitOk(root, ['version'], 'version'));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function absGitPath(root: string, rel: string): string {
  const p = gitOk(root, ['rev-parse', '--git-path', rel], 'rev-parse --git-path');
  if (!p) throw opError('git_unavailable', `git rev-parse --git-path ${rel} printed nothing in ${root}.`, 'Check that git works in this checkout (git status).');
  return isAbsolute(p) ? p : resolve(root, p);
}

/** The checkout's toplevel; throws `commit_paths_invalid` outside a work tree. */
export function checkoutRoot(dir: string): string {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw opError('commit_paths_invalid', `${dir} is not inside a git checkout.`,
      'Run the command inside the brain checkout or pass --path <checkout>.');
  }
  return r.stdout.trim();
}

function resolveCtx(root: string): Ctx {
  const sym = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (sym.code !== 0) {
    throw opError('git_detached_head', `${root} is on a detached HEAD, so there is no branch to publish.`,
      'Check out the branch the remote tracks (git switch <branch>), then rerun.');
  }
  const branch = sym.stdout.trim();
  if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).code !== 0) {
    throw opError('git_detached_head', `Branch ${branch} in ${root} has no commit yet.`,
      'Make the first commit on this branch with git, then rerun.', { reason: 'unborn' });
  }
  const remote = git(root, ['config', '--get', `branch.${branch}.remote`]).stdout.trim() || 'origin';
  const mergeRef = git(root, ['config', '--get', `branch.${branch}.merge`]).stdout.trim() || `refs/heads/${branch}`;
  if (remote === '.' || git(root, ['remote', 'get-url', '--', remote]).code !== 0) {
    throw opError('git_unavailable', `Branch ${branch} in ${root} has no usable remote (${remote}); nothing was committed.`,
      `Add the remote (git remote add ${remote} <url>) or set the branch upstream, then rerun.`);
  }
  const short = mergeRef.replace(/^refs\/heads\//, '');
  return { root, branch, remote, mergeRef, trackingRef: `refs/remotes/${remote}/${short}` };
}

/** `--push-only <branch>`: publish to an explicit remote branch (validated as one exact ref, never a pattern). */
function withBranch(ctx: Ctx, branch: string | undefined): Ctx {
  if (!branch) return ctx;
  const short = branch.replace(/^refs\/heads\//, '');
  if (!short || git(ctx.root, ['check-ref-format', `refs/heads/${short}`]).code !== 0) {
    throw opError('commit_paths_invalid', `${branch} is not a valid branch name.`, 'Pass one exact branch name, e.g. --branch main.', { detail: branch });
  }
  return { ...ctx, mergeRef: `refs/heads/${short}`, trackingRef: `refs/remotes/${ctx.remote}/${short}` };
}

/** The git-dir entries a rebase, merge, cherry-pick or revert leaves while it is in progress. */
export const GIT_OPERATION_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'] as const;

/** Refuse while another git operation is mid-flight; never abort it for the user. */
export function assertNoOperationInProgress(root: string): void {
  for (const marker of GIT_OPERATION_MARKERS) {
    if (existsSync(absGitPath(root, marker))) {
      throw opError('git_operation_in_progress', `A git ${marker.startsWith('rebase') ? 'rebase' : marker.toLowerCase().replace(/_head$/, '')} is in progress in ${root}.`,
        `Finish or abort it first. A stuck rebase may hold another writer's autostash: save it with git stash store <sha from .git/${marker}/autostash> before deleting anything. See docs/guides/shared-checkout-git.md#stuck-rebase.`,
        { detail: marker });
    }
  }
}

// ── Lock ────────────────────────────────────────────────────────────────────

export interface CommitLock { release(): void; lockPath: string; reentrant: boolean }

/**
 * Take this checkout's commit lock (and the legacy push lock). Re-entrant only
 * when BRAIN_COMMIT_LOCK_HELD names this exact lock AND the lock is really
 * held: a stale, spoofed or generic (`1`) marker cannot bypass a lock.
 */
export function acquireCommitLock(root: string, waitMs = defaultLockWaitMs()): CommitLock {
  const lockPath = absGitPath(root, COMMIT_LOCK_NAME);
  const legacyPath = absGitPath(root, LEGACY_PUSH_LOCK_NAME);
  const marker = process.env[COMMIT_LOCK_ENV];
  if (marker && marker !== '1' && resolve(marker) === lockPath) {
    const probe = acquireNativeLockSync(lockPath, { timeoutMs: 0 });
    if (!probe) return { release() {}, lockPath, reentrant: true };
    return withLegacy(root, probe, lockPath, legacyPath, waitMs);
  }
  const handle = acquireNativeLockSync(lockPath, { timeoutMs: waitMs });
  if (!handle) throw lockBusy(lockPath, waitMs);
  return withLegacy(root, handle, lockPath, legacyPath, waitMs);
}

function withLegacy(root: string, handle: NativeLockSyncHandle, lockPath: string, legacyPath: string, waitMs: number): CommitLock {
  let legacy: NativeLockSyncHandle | null;
  try { legacy = acquireNativeLockSync(legacyPath, { timeoutMs: waitMs }); }
  catch (e) { handle.release(); throw e; }
  if (!legacy) { handle.release(); throw lockBusy(legacyPath, waitMs, root); }
  return { lockPath, reentrant: false, release() { legacy!.release(); handle.release(); } };
}

/** The same locks for async callers (`gbrain sync`'s pull), without blocking the event loop while waiting. */
export async function acquireCommitLockAsync(root: string, waitMs = defaultLockWaitMs(), signal?: AbortSignal): Promise<{ release(): Promise<void> }> {
  const lockPath = absGitPath(root, COMMIT_LOCK_NAME);
  const legacyPath = absGitPath(root, LEGACY_PUSH_LOCK_NAME);
  const handle = await acquireNativeLock(lockPath, { timeoutMs: waitMs, signal });
  if (!handle) throw lockBusy(lockPath, waitMs, root);
  let legacy;
  try { legacy = await acquireNativeLock(legacyPath, { timeoutMs: waitMs, signal }); }
  catch (e) { await handle.release(); throw e; }
  if (!legacy) { await handle.release(); throw lockBusy(legacyPath, waitMs, root); }
  return { async release() { await legacy.release(); await handle.release(); } };
}

function defaultLockWaitMs(): number {
  const raw = process.env.GBRAIN_COMMIT_LOCK_WAIT_SECONDS ?? process.env.GBRAIN_PUSH_LOCK_WAIT_SECONDS;
  const secs = raw === undefined ? 60 : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 60_000;
}

function lockBusy(lockPath: string, waitMs: number, root?: string): OperationError {
  return opError('commit_lock_busy', `Another writer held this checkout's commit lock for ${Math.round(waitMs / 1000)}s.`,
    `Another commit or push is running in ${root ?? 'this checkout'} (lock ${lockPath}). Retry once it finishes; nothing was committed.`,
    { detail: lockPath, retryable: true });
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** Repo-relative paths; refuses the root itself, `.git` and anything outside the checkout. */
export function scopePaths(root: string, paths: string[], cwd: string): string[] {
  if (paths.length === 0) {
    throw opError('commit_paths_invalid', 'No paths to commit.',
      'Pass the explicit file(s) you wrote; a repo-wide commit would sweep up other writers\' files.');
  }
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(cwd, p);
    const rel = relative(root, abs);
    if (rel === '' || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
      throw opError('commit_paths_invalid', `Path ${p} is ${rel === '' || rel === '.' ? 'the whole checkout' : 'outside the checkout'}.`,
        'Pass the explicit file(s) you wrote inside the checkout; a repo-wide commit would sweep up other writers\' files.', { detail: p });
    }
    if (rel.split(/[\\/]/)[0] === '.git') {
      throw opError('commit_paths_invalid', `Path ${p} is inside .git.`, 'Pass files in the working tree.', { detail: p });
    }
    out.push(rel.split('\\').join('/'));
  }
  return [...new Set(out)];
}

/** The checkout's configured source roots (`gbrain.sourceRoot`, toplevel-relative); [''] (the whole checkout) when none is set. */
export function configuredSourceRoots(root: string): string[] {
  const roots: string[] = [];
  for (const raw of git(root, ['config', '--get-all', SOURCE_ROOT_CONFIG]).stdout.split('\n').map(v => v.trim()).filter(Boolean)) {
    const rel = (isAbsolute(raw) ? relative(root, raw) : raw).split('\\').join('/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (rel === '' || rel === '.') return [''];
    if (!rel.startsWith('..')) roots.push(rel);
  }
  return roots.length ? [...new Set(roots)] : [''];
}

const covers = (spec: string, path: string) => spec === '' || path === spec || path.startsWith(`${spec}/`);
export const insideSourceRoots = (path: string, roots: string[]) => roots.some(r => covers(r, path));

function outsideRootError(root: string, roots: string[], paths: string[], what: string): OperationError {
  return opError('commit_outside_source_root', `${what} ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', ...' : ''}, outside this brain's source root (${roots.join(', ')}).`,
    `Commit only files under the source root. Files elsewhere in ${root} belong to other projects or writers; commit those with their own tools. Nothing was staged or committed.`,
    { detail: JSON.stringify({ roots, paths }) });
}

// ── Commit ──────────────────────────────────────────────────────────────────

function indexLocked(r: GitRun): boolean {
  return /index\.lock': File exists|Unable to create '.*index\.lock'/.test(r.stderr);
}

/** Run an index-writing git command; a lockless git holding index.lock gets a bounded, jittered retry. */
function withIndexRetry(root: string, args: string[], what: string, env?: NodeJS.ProcessEnv, input?: string): GitRun {
  for (let attempt = 0; ; attempt++) {
    const r = git(root, args, { env, timeoutMs: 120_000, input });
    if (r.code === 0 || !indexLocked(r)) return r;
    if (attempt >= INDEX_LOCK_RETRIES) {
      const lock = absGitPath(root, 'index.lock');
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch { /* gone */ }
      if (ageMs > 10 * 60_000) {
        throw opError('git_index_stale', `A Git index lock older than 10 minutes blocks ${root}: ${lock}.`,
          `If no git command is running in that checkout, remove ${lock}, then rerun. Nothing was committed.`, { detail: lock });
      }
      throw opError('git_index_locked', `Another git process kept ${root}'s index locked during ${what}.`,
        'A git command that does not take the commit lock is running in this checkout. Retry shortly; nothing was committed.', { detail: lock, retryable: true });
    }
    Atomics.wait(sleeper, 0, 0, 100 * 2 ** attempt + Math.floor(Math.random() * 100));
  }
}

/** A staged rename (`git mv`) commits both sides: committing only the new name would publish a duplicate and leave the deletion staged for another writer's commit. */
function withRenamePartners(root: string, rel: string[]): string[] {
  const fields = git(root, ['diff', '--cached', '-M', '--name-status', '-z']).stdout.split('\0');
  const out = new Set(rel);
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    if (!status) break;
    if (/^[RC]/.test(status)) {
      const [from, to] = [fields[i + 1], fields[i + 2]];
      if (status.startsWith('R') && (out.has(from) || out.has(to))) { out.add(from); out.add(to); }
      i += 3;
    } else i += 2;
  }
  return [...out];
}

/** Index entries that differ from HEAD, whoever staged them, with rename detection off so both sides of a rename are listed. */
function stagedPaths(root: string): string[] {
  return git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
}

/** The index entries under `rel` as `ls-files -s` records, so a failed commit can put them back exactly. */
function indexEntries(root: string, rel: string[]): string[] {
  return git(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...rel]).stdout.split('\0').filter(Boolean);
}

/**
 * Put the index under `rel` back to `before` after a commit that did not land:
 * `git add` already staged the paths, and an entry left staged in the shared
 * index is what the next writer's commit without paths sweeps up.
 */
function restoreIndex(root: string, rel: string[], before: string[]): void {
  const pathOf = (line: string) => line.slice(line.indexOf('\t') + 1);
  const kept = new Set(before.map(pathOf));
  const zero = '0'.repeat(git(root, ['rev-parse', 'HEAD']).stdout.trim().length || 40);
  const records = [...indexEntries(root, rel).map(pathOf).filter(p => !kept.has(p)).map(p => `0 ${zero}\t${p}`), ...before];
  if (records.length) withIndexRetry(root, ['update-index', '-z', '--index-info'], 'index restore', undefined, records.map(l => `${l}\0`).join(''));
}

interface CommitScope { roots: string[]; lockPath: string; markHeld: boolean }

/**
 * Stage and commit exactly `rel` (the caller holds the commit lock). Refused
 * before anything is staged: a path outside the source root(s), and a file
 * another writer already staged under a named directory (name it to claim
 * it). A commit git refuses leaves the index as it found it.
 */
function commitPaths(root: string, rel: string[], message: string, scope: CommitScope): string | null {
  const outside = rel.filter(p => !insideSourceRoots(p, scope.roots));
  if (outside.length) throw outsideRootError(root, scope.roots, outside, 'Refusing to commit');
  const swept = stagedPaths(root).filter(p => !rel.includes(p) && rel.some(spec => covers(spec, p)));
  if (swept.length) {
    const list = `${swept.slice(0, 10).join(', ')}${swept.length > 10 ? ', ...' : ''}`;
    throw opError('commit_prestaged_paths', `${swept.length} file(s) under the named path(s) were already staged by another writer: ${list}.`,
      'Nothing was staged or committed. If they are yours, name each file explicitly; otherwise leave them to the writer that staged them, or unstage them with the user\'s agreement (git restore --staged -- <file>; the working tree keeps its bytes).',
      { detail: JSON.stringify({ paths: swept }), fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
        argv: ['git', '-C', root, 'restore', '--staged', '--', ...swept],
        why: 'Another writer staged these files; committing them would publish whatever that writer had in progress, and unstaging them drops its staging.',
        user_message: `Files already staged by another writer sit under the path you asked to commit (${list}). Commit only the files you name, or unstage those (their bytes stay on disk)?`,
        docs: 'docs/guides/shared-checkout-git.md#outcomes' } });
  }
  const before = indexEntries(root, rel);
  const add = withIndexRetry(root, ['--literal-pathspecs', 'add', '-A', '--', ...rel], 'git add');
  if (add.code !== 0) {
    throw opError('commit_paths_invalid', 'git add refused the given paths.', add.stderr.trim().slice(0, 300) || 'Check the paths exist or are tracked.');
  }
  try {
    const paths = withRenamePartners(root, rel);
    const partners = paths.filter(p => !insideSourceRoots(p, scope.roots));
    if (partners.length) throw outsideRootError(root, scope.roots, partners, 'A staged rename would commit');
    if (git(root, ['--literal-pathspecs', 'diff', '--cached', '--quiet', '--', ...paths]).code === 0) return null;
    const env = { [COMMIT_VIA_ENV]: scope.lockPath, ...(scope.markHeld ? { [COMMIT_LOCK_ENV]: scope.lockPath } : {}) };
    const commit = withIndexRetry(root, ['--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...paths], 'git commit', env);
    if (commit.code !== 0) {
      throw opError('git_unavailable', `git commit failed in ${root}; the paths were unstaged again and keep their bytes.`,
        `${commit.stderr.trim().slice(0, 300)} A missing git identity (user.name, user.email) or a refusing pre-commit hook are common causes.`);
    }
    return gitOk(root, ['rev-parse', 'HEAD'], 'rev-parse HEAD');
  } catch (e) {
    try { restoreIndex(root, rel, before); } catch { /* the index lock outlasted the retries; the error below still stands */ }
    throw e;
  }
}

// ── Pending write-through ───────────────────────────────────────────────────

export interface PendingWriteThrough { path: string; since: string }

const PENDING_NOTED = new Set(['commit_lock_busy', 'git_index_locked', 'git_index_stale', 'git_unavailable', 'git_operation_in_progress']);

function readPendingFile(file: string, into: Map<string, string>): void {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    let path: unknown;
    try { path = JSON.parse(line.slice(tab + 1)); } catch { continue; }
    const since = line.slice(0, tab);
    if (typeof path === 'string' && path && (!into.has(path) || since < into.get(path)!)) into.set(path, since);
  }
}

/** Write-through files gbrain wrote in this checkout but could not commit, oldest first. A path committed since stays listed until the next locked commit settles the ledger. */
export function readPendingWriteThrough(repo: string): PendingWriteThrough[] {
  try {
    const file = absGitPath(checkoutRoot(repo), PENDING_NAME);
    const entries = new Map<string, string>();
    readPendingFile(file, entries);
    readPendingFile(`${file}.settle`, entries);
    return [...entries].map(([path, since]) => ({ path, since })).sort((a, b) => a.since.localeCompare(b.since));
  } catch {
    return [];
  }
}

/** The pending ledger's files that still differ from HEAD (doctor's `dirty_age`); the others were committed since. */
export function pendingWriteThroughStillDirty(repo: string): PendingWriteThrough[] {
  const pending = readPendingWriteThrough(repo);
  if (!pending.length) return [];
  const dirty = dirtyPaths(checkoutRoot(repo), pending.map(e => e.path));
  return pending.filter(e => dirty.has(e.path));
}

/** Appends without the lock (O_APPEND), so a writer that could not get it still records its file. */
function notePending(root: string, paths: string[]): void {
  try { appendFileSync(absGitPath(root, PENDING_NAME), paths.map(p => `${new Date().toISOString()}\t${JSON.stringify(p)}\n`).join('')); } catch { /* best-effort */ }
}

/** Which of `paths` differ from HEAD in the index or the working tree. */
function dirtyPaths(root: string, paths: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const entries = git(root, ['--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths.slice(i, i + 500)]).stdout.split('\0');
    for (let j = 0; j < entries.length; j++) {
      if (entries[j].length < 4) continue;
      out.add(entries[j].slice(3));
      if (/^[RC]/.test(entries[j])) j++;
    }
  }
  return out;
}

/** Drop ledger entries whose file no longer differs from HEAD (the caller holds the commit lock). New lines appended meanwhile go to a fresh ledger file. */
function settlePending(root: string): void {
  try {
    const file = absGitPath(root, PENDING_NAME);
    const settle = `${file}.settle`;
    const moved = `${file}.${process.pid}.tmp`;
    if (existsSync(file)) renameSync(file, moved);
    const entries = new Map<string, string>();
    readPendingFile(settle, entries);
    readPendingFile(moved, entries);
    const dirty = dirtyPaths(root, [...entries.keys()]);
    const keep = [...entries].filter(([path]) => dirty.has(path)).map(([path, since]) => `${since}\t${JSON.stringify(path)}\n`);
    if (keep.length) { writeFileSync(`${settle}.tmp`, keep.join('')); renameSync(`${settle}.tmp`, settle); }
    else rmSync(settle, { force: true });
    rmSync(moved, { force: true });
  } catch { /* best-effort: the ledger only feeds retries and doctor */ }
}

/**
 * Commit-only entry for gbrain's own write paths (write-through pages, facts
 * fences, takes, timeline, lint fixes), always under the commit lock. A writer
 * holding the lock past `lockWaitMs` makes this fail `commit_lock_busy` (the
 * file write itself stands) and the file goes into the pending ledger, which
 * the next locked write-through or `gbrain git commit-push --pending` commits and
 * doctor's `dirty_age` reports. It never commits without the lock: that races
 * other writers on the shared index. Paths must sit under `repo` (the source
 * root). No marker is set, so the post-commit hook publishes. Returns the new
 * commit, or null when the paths had no change.
 */
export function commitPathsLocked(repo: string, rel: string[], message: string, opts: { lockWaitMs: number }): string | null {
  const root = checkoutRoot(repo);
  assertManagedFilesystemWrite(root);
  assertNoOperationInProgress(root);
  const paths = scopePaths(root, rel, root);
  const own = relative(realpathSync(root), realpathSync(repo)).split('\\').join('/');
  const roots = [own.startsWith('..') ? '' : own];
  let lock: CommitLock;
  try { lock = acquireCommitLock(root, opts.lockWaitMs); } catch (e) {
    if (PENDING_NOTED.has((e as { code?: string }).code ?? '')) notePending(root, paths);
    throw e;
  }
  try {
    const pending = [...dirtyPaths(root, readPendingWriteThrough(root).map(e => e.path).filter(p => !paths.includes(p) && insideSourceRoots(p, roots)))];
    const scope = { roots, lockPath: lock.lockPath, markHeld: false };
    let sha: string | null;
    try {
      sha = commitPaths(root, [...paths, ...pending], pending.length ? `${message} (+${pending.length} pending write-through file(s))` : message, scope);
    } catch (e) {
      if (!pending.length) throw e;
      sha = commitPaths(root, paths, message, scope);
    }
    settlePending(root);
    return sha;
  } catch (e) {
    if (PENDING_NOTED.has((e as { code?: string }).code ?? '')) notePending(root, paths);
    throw e;
  } finally {
    lock.release();
  }
}

// ── In-memory integrate ─────────────────────────────────────────────────────

interface MergeTree {
  /** The merged tree; with conflicts, a placeholder every conflicted path must be resolved over. */
  tree: string | null;
  /** Raw repo-relative paths (NUL-delimited from git, never C-quoted). */
  conflicts: string[];
  /** Conflicts that are not one path's content (file/directory, renames): never resolvable by a blob choice. */
  structural: string[];
}

/** merge-tree conflict types a per-path blob choice fully resolves; anything else is structural. */
const RESOLVABLE_CONFLICTS = new Set(['CONFLICT (contents)', 'CONFLICT (add/add)', 'CONFLICT (modify/delete)', 'CONFLICT (binary)']);

const versions = new Map<string, [number, number]>();
function cachedGitVersion(root: string): [number, number] {
  let v = versions.get(root);
  if (!v) { v = gitVersion(root); versions.set(root, v); }
  return v;
}

/** `--no-write-fetch-head` exists from git 2.29; older git just writes FETCH_HEAD. */
function fetchFlags(root: string): string[] {
  const [maj, min] = cachedGitVersion(root);
  return ['--no-tags', ...(maj > 2 || (maj === 2 && min >= 29) ? ['--no-write-fetch-head'] : [])];
}

/**
 * merge-tree --write-tree on git >= 2.38; else (or with the GBRAIN_GIT_NO_MERGE_TREE=1 test seam) a 3-way read-tree
 * that treats any same-path change on both sides as a conflict. `base` replaces the merge base (a replayed commit's
 * parent); merge-tree takes it from git 2.40.
 */
function mergeTrees(root: string, ours: string, theirs: string, base?: string): MergeTree {
  const [maj, min] = cachedGitVersion(root);
  if ((maj > 2 || (maj === 2 && min >= (base ? 40 : 38))) && process.env.GBRAIN_GIT_NO_MERGE_TREE !== '1') {
    const r = git(root, ['merge-tree', '--write-tree', '--name-only', '-z', ...(base ? [`--merge-base=${base}`] : []), ours, theirs]);
    if (r.code !== 0 && r.code !== 1) throw opError('git_unavailable', 'git merge-tree failed.', r.stderr.trim().slice(0, 300));
    const f = r.stdout.split('\0');
    const tree = f[0] || null;
    if (r.code === 0) return { tree, conflicts: [], structural: [] };
    let i = 1;
    const conflicts = new Set<string>();
    while (i < f.length && f[i] !== '') conflicts.add(f[i++]);
    i++;
    const structural = new Set<string>();
    while (i < f.length && f[i] !== '') {
      const n = Number(f[i++]);
      if (!Number.isInteger(n) || n < 1) break;
      const paths = f.slice(i, i + n);
      const type = f[i + n] ?? '';
      i += n + 2;
      if (type.startsWith('CONFLICT') && !RESOLVABLE_CONFLICTS.has(type)) for (const p of paths) structural.add(p);
    }
    return { tree, conflicts: [...conflicts], structural: [...conflicts].filter(p => structural.has(p)) };
  }
  const mergeBase = base ?? git(root, ['merge-base', ours, theirs]).stdout.trim();
  if (!mergeBase) throw opError('integrate_conflict', 'The local and remote branches share no history.', 'Reconcile the branches by hand.');
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-integrate-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const read = git(root, ['read-tree', '-m', '-i', '--aggressive', mergeBase, ours, theirs], { env });
    if (read.code !== 0) throw opError('git_unavailable', 'git read-tree failed.', read.stderr.trim().slice(0, 300));
    const unmerged = git(root, ['ls-files', '-u', '-z'], { env }).stdout.split('\0').filter(Boolean);
    if (!unmerged.length) return { tree: gitOk(root, ['write-tree'], 'write-tree', { env }), conflicts: [], structural: [] };
    const conflicts = [...new Set(unmerged.map(l => l.slice(l.indexOf('\t') + 1)))];
    const structural: string[] = [];
    for (const path of conflicts) {
      gitOk(root, ['update-index', '--force-remove', '--', path], 'update-index', { env });
      const mine = unmerged.find(l => l.slice(l.indexOf('\t') + 1) === path && l.split('\t')[0].split(' ')[2] === '2');
      if (!mine) continue;
      const [mode, sha] = mine.split('\t')[0].split(' ');
      if (git(root, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`], { env }).code !== 0) structural.push(path);
    }
    return { tree: gitOk(root, ['write-tree'], 'write-tree', { env }), conflicts, structural };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const treeOf = (root: string, commit: string) => gitOk(root, ['rev-parse', `${commit}^{tree}`], 'rev-parse tree');

interface Integration extends MergeTree {
  /** Local commits left out because an upstream commit already carries the same patch (`git patch-id`). */
  skipped: string[];
}

const MAX_REPLAY = 500;

/**
 * The tree a publish of `local` over `remote` should carry. A 3-way merge of the two tips
 * counts a local commit whose patch already reached the remote (cherry-picked or rebased there) as a new
 * change again: a remote that edited those lines since conflicts forever, and a remote that reverted it gets
 * the change back silently. So when any local commit is patch-equivalent to an upstream one, the local
 * commits are replayed in memory onto the remote tip instead, oldest first, leaving out the equivalent ones
 * and the clean merges (their content is their parents'). A merge that carries its own resolution, a root
 * commit, or more than MAX_REPLAY commits fall back to the tip merge.
 */
function integrate(root: string, local: string, remote: string): Integration {
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', '--cherry-mark', '--right-only', '--parents', `${remote}...${local}`])
    .stdout.split('\n').filter(Boolean).map(line => {
      const [head, ...parents] = line.split(' ');
      return { sha: head.slice(1), equivalent: head.startsWith('='), parents };
    });
  const tipMerge = (): Integration => ({ ...mergeTrees(root, local, remote), skipped: [] });
  if (!commits.some(c => c.equivalent) || commits.length > MAX_REPLAY) return tipMerge();
  let acc = remote;
  const conflicts = new Set<string>();
  const structural = new Set<string>();
  const skipped: string[] = [];
  for (const c of commits) {
    if (c.equivalent) { skipped.push(c.sha); continue; }
    if (c.parents.length !== 1) {
      if (c.parents.length !== 2) return tipMerge();
      const own = mergeTrees(root, c.parents[0], c.parents[1]);
      if (own.conflicts.length || own.tree !== treeOf(root, c.sha)) return tipMerge();
      continue;
    }
    const step = mergeTrees(root, acc, c.sha, c.parents[0]);
    for (const p of step.conflicts) conflicts.add(p);
    for (const p of step.structural) structural.add(p);
    acc = gitOk(root, ['commit-tree', '--no-gpg-sign', step.tree!, '-p', acc, '-m', 'gbrain: replay'], 'commit-tree');
  }
  return { tree: treeOf(root, acc), conflicts: [...conflicts], structural: [...structural], skipped };
}

interface TreeEntry { mode: string; type: string; sha: string }

function treeEntry(root: string, commit: string, path: string): TreeEntry | null {
  for (const line of git(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', path]).stdout.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab === -1 || line.slice(tab + 1) !== path) continue;
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha };
  }
  return null;
}

/** One path's content conflict: a blob (or absent) on every side, no side has it as a directory or under a file. */
function blobConflict(root: string, base: string, ours: string, theirs: string, path: string): boolean {
  const sides = [base, ours, theirs].map(c => (c ? treeEntry(root, c, path) : null));
  if (sides.every(e => !e) || sides.some(e => e && e.type !== 'blob')) return false;
  const parts = path.split('/');
  for (let k = 1; k < parts.length; k++) {
    const prefix = parts.slice(0, k).join('/');
    if ([ours, theirs].some(c => treeEntry(root, c, prefix)?.type === 'blob')) return false;
  }
  return true;
}

/** Apply `--resolve` choices on top of the merge's placeholder tree; structural conflicts are refused. */
function resolvedTree(ctx: Ctx, ours: string, theirs: string, merged: MergeTree, resolutions: Map<string, Resolution>, cwd: string): string {
  if (merged.conflicts.some(p => !resolutions.has(p))) throw conflictError(ctx, ours, theirs, merged);
  const base = git(ctx.root, ['merge-base', ours, theirs]).stdout.trim();
  const structural = merged.conflicts.filter(p => merged.structural.includes(p) || !blobConflict(ctx.root, base, ours, theirs, p));
  if (structural.length) throw conflictError(ctx, ours, theirs, { ...merged, structural });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-resolve-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    gitOk(ctx.root, ['read-tree', merged.tree!], 'read-tree', { env });
    for (const path of merged.conflicts) {
      const choice = resolutions.get(path)!;
      if (choice.kind === 'file') {
        const blob = gitOk(ctx.root, ['hash-object', '-w', '--', resolve(cwd, choice.path)], 'hash-object');
        gitOk(ctx.root, ['update-index', '--add', '--cacheinfo', `${treeEntry(ctx.root, ours, path)?.mode ?? '100644'},${blob},${path}`], 'update-index', { env });
        continue;
      }
      const entry = treeEntry(ctx.root, choice.kind === 'ours' ? ours : theirs, path);
      if (entry) gitOk(ctx.root, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${path}`], 'update-index', { env });
      else gitOk(ctx.root, ['update-index', '--force-remove', '--', path], 'update-index', { env });
    }
    return gitOk(ctx.root, ['write-tree'], 'write-tree', { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shellWord(v: string): string {
  return /^[A-Za-z0-9._\/@%+:-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

function conflictError(ctx: Ctx, ours: string, theirs: string, merged: MergeTree, preface = ''): OperationError {
  const paths = merged.conflicts;
  const local = ours.slice(0, 12);
  const remote = theirs.slice(0, 12);
  const compare = `Compare the two versions (this machine's: git show ${local}:<path>; the remote's: git show ${remote}:<path>)`;
  const fix = merged.structural.length
    ? `${preface}The local commit ${local} stays local and the checkout is unchanged. ${merged.structural.map(shellWord).join(', ')} ${merged.structural.length === 1 ? 'is' : 'are'} a file/directory or rename conflict that a per-file choice cannot resolve. ${compare}, then move or remove the local path in a new commit (gbrain git commit-push -m "<msg>" -- <paths>) and rerun gbrain git commit-push --push-only. See docs/guides/shared-checkout-git.md#conflicts.`
    : `${preface}The local commit ${local} stays local and the checkout is unchanged. ${compare}, then run gbrain git commit-push --push-only${ctx.keepCheckout ? ' --keep-checkout' : ''} --expect-remote ${remote} ${paths.map(p => `--resolve ${shellWord(p)}=ours|theirs`).join(' ')} (ours = this machine's version, theirs = the remote's, or =file:<path> with a merged copy). Until then every push from this checkout reports this conflict. See docs/guides/shared-checkout-git.md#conflicts.`;
  return opError('integrate_conflict', `Local and remote commits both changed ${paths.length} file(s) on ${ctx.branch}; nothing was merged.`, fix,
    { detail: JSON.stringify({ local: ours, remote: theirs, paths, structural: merged.structural }),
      fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
        why: 'Choosing which version of a file wins discards the other side; ask the user before resolving.',
        user_message: `Both this machine and the remote changed ${paths.join(', ')}. Which version should win, or should they be merged by hand?`,
        ...(merged.structural.length ? {} : { argv: ['gbrain', 'git', 'commit-push', '--push-only', ...(ctx.keepCheckout ? ['--keep-checkout'] : []), '--path', ctx.root, '--expect-remote', theirs, ...paths.flatMap(p => ['--resolve', `${p}=<ours|theirs>`])] }),
        docs: 'docs/guides/shared-checkout-git.md#conflicts' } });
}

/** Honors the user's commit signing config, like the `git pull` it replaces. */
function buildMerge(ctx: Ctx, ours: string, theirs: string, tree: string, skipped: string[] = [], extra: string[] = []): string {
  const remote = `${ctx.remote}/${ctx.mergeRef.replace(/^refs\/heads\//, '')}`;
  const note = skipped.length
    ? ['-m', `Left out ${skipped.length} local commit(s) whose patch ${remote} already has: ${skipped.slice(0, 20).map(s => s.slice(0, 12)).join(' ')}${skipped.length > 20 ? ' ...' : ''}`] : [];
  return gitOk(ctx.root, ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', `gbrain: merge ${remote} into ${ctx.branch}`, ...note, ...extra.flatMap(m => ['-m', m])], 'commit-tree');
}

function fetchTracking(ctx: Ctx): string | null {
  const r = remoteGit(ctx.root, 'fetch', [...fetchFlags(ctx.root), '--', ctx.remote, `+${ctx.mergeRef}:${ctx.trackingRef}`]);
  if (r.code !== 0) return null;
  return git(ctx.root, ['rev-parse', '--verify', '--quiet', ctx.trackingRef]).stdout.trim() || null;
}

function isAncestor(root: string, a: string, b: string): boolean {
  return git(root, ['merge-base', '--is-ancestor', a, b]).code === 0;
}

/**
 * #5138: true only when EVERY effective push destination (pushurl and
 * pushInsteadOf expanded) has `sha` on the exact target branch. A URL that git
 * would resolve as another remote alias fails closed, and remote evidence is
 * read live (ls-remote), never from a stale tracking ref or the fetch repo.
 */
function remoteContains(ctx: Ctx, sha: string): boolean {
  const branchRef = ctx.mergeRef;
  if (git(ctx.root, ['check-ref-format', branchRef]).code !== 0) return false;
  const urls = git(ctx.root, ['remote', 'get-url', '--push', '--all', '--', ctx.remote]).stdout.split('\n').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return false;
  for (const url of urls) {
    if (git(ctx.root, ['ls-remote', '--get-url', '--', url]).stdout.trim() !== url) return false;
    const listed = git(ctx.root, [...transportFlags(), 'ls-remote', '--exit-code', '--', url, branchRef], { auth: true, timeoutMs: 60_000 });
    if (listed.code !== 0) return false;
    const tip = listed.stdout.split(/\s/)[0];
    if (!/^[0-9a-f]{40,64}$/.test(tip)) return false;
    if (git(ctx.root, ['cat-file', '-e', `${tip}^{commit}`]).code !== 0) {
      const got = git(ctx.root, [...transportFlags(), 'fetch', '--quiet', ...fetchFlags(ctx.root), ...GIT_SSRF_SUBCOMMAND_FLAGS, '--', url, tip], { auth: true, timeoutMs: 120_000 });
      if (got.code !== 0) return false;
    }
    if (!isAncestor(ctx.root, sha, tip)) return false;
  }
  return true;
}

interface Published { sha: string; integrated: number; confirmed: 'push' | 'remote'; quarantined?: QuarantineEntry }

// ── Quarantine (opt-in) ─────────────────────────────────────────────────────

const QUARANTINE_LEDGER_NAME = 'brain-quarantine.log';
export const QUARANTINE_REF_PREFIX = 'refs/gbrain/quarantine/';

export interface QuarantineEntry { ref: string; local: string; remote: string; paths: string[]; at: string }

const quarantineEnabled = (root: string) => git(root, ['config', '--type=bool', '--get', 'gbrain.quarantine']).stdout.trim() === 'true';

/** Name the local commit under refs/gbrain/quarantine/ and note which files it parks; the ref keeps it even if history is later rewritten. */
function parkLocalVersion(root: string, local: string, remote: string, paths: string[]): QuarantineEntry {
  const at = new Date().toISOString();
  const ref = `${QUARANTINE_REF_PREFIX}${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${local.slice(0, 12)}`;
  gitOk(root, ['update-ref', ref, local], 'update-ref quarantine');
  const entry = { ref, local, remote, paths, at };
  appendFileSync(absGitPath(root, QUARANTINE_LEDGER_NAME), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Parked local versions whose ref still exists (deleting the ref is how the user says they are done with it). */
export function readQuarantine(repo: string): QuarantineEntry[] {
  try {
    const root = checkoutRoot(repo);
    const p = absGitPath(root, QUARANTINE_LEDGER_NAME);
    if (!existsSync(p)) return [];
    const live = new Set(git(root, ['for-each-ref', '--format=%(refname)', QUARANTINE_REF_PREFIX]).stdout.split('\n').filter(Boolean));
    return readFileSync(p, 'utf8').split('\n').flatMap(line => {
      try { const e = JSON.parse(line) as QuarantineEntry; return live.has(e.ref) ? [e] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/**
 * Push `start` (an immutable sha), merging remote commits in memory as needed.
 * When the remote already holds the candidate, the published tip (which may be
 * a merge built over it earlier) is returned so a lagging checkout catches up.
 */
function publish(ctx: Ctx, start: string, resolutions: Map<string, Resolution> | undefined, expectRemote: string | undefined, cwd: string): Published {
  let candidate = start;
  let integrated = 0;
  let lastError = '';
  let stalled = 0;
  let quarantined: QuarantineEntry | undefined;
  const onRemote = (): Published => {
    const tip = fetchTracking(ctx);
    return { sha: tip && isAncestor(ctx.root, candidate, tip) ? tip : candidate, integrated, confirmed: 'remote', ...(quarantined ? { quarantined } : {}) };
  };
  for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
    if (attempt) Atomics.wait(sleeper, 0, 0, Math.min(2000, 50 * 2 ** attempt) + Math.floor(Math.random() * 100));
    const push = remoteGit(ctx.root, 'push', [...(ctx.keepCheckout ? ['--no-verify'] : []), '--', ctx.remote, `${candidate}:${ctx.mergeRef}`]);
    if (push.code === 0) return { sha: candidate, integrated, confirmed: 'push', ...(quarantined ? { quarantined } : {}) };
    lastError = push.stderr.trim();
    if (remoteContains(ctx, candidate)) return onRemote();
    const remoteTip = fetchTracking(ctx);
    if (!remoteTip) break;
    if (isAncestor(ctx.root, remoteTip, candidate)) {
      if (++stalled > 1) break;
      continue;
    }
    const merged = integrate(ctx.root, candidate, remoteTip);
    let tree = merged.tree!;
    let parkedNote: string[] = [];
    if (merged.conflicts.length && !resolutions?.size && !merged.structural.length && quarantineEnabled(ctx.root)) {
      tree = resolvedTree(ctx, candidate, remoteTip, merged, new Map(merged.conflicts.map(p => [p, { kind: 'theirs' } as Resolution])), cwd);
      quarantined = parkLocalVersion(ctx.root, candidate, remoteTip, merged.conflicts);
      parkedNote = [`Quarantined this machine's version of ${merged.conflicts.length} conflicting file(s) under ${quarantined.ref}: ${merged.conflicts.slice(0, 20).join(', ')}`];
    } else if (merged.conflicts.length) {
      if (!resolutions?.size) throw conflictError(ctx, candidate, remoteTip, merged);
      if (!expectRemote || !remoteTip.startsWith(expectRemote.toLowerCase())) {
        throw conflictError(ctx, candidate, remoteTip, merged,
          `The remote moved to ${remoteTip.slice(0, 12)}${expectRemote ? ` after the choice was made against ${expectRemote.slice(0, 12)}` : ''}; review the remote's current version before choosing. `);
      }
      tree = resolvedTree(ctx, candidate, remoteTip, merged, resolutions, cwd);
    }
    integrated += Number(git(ctx.root, ['rev-list', '--count', `${candidate}..${remoteTip}`]).stdout.trim() || 0);
    candidate = buildMerge(ctx, candidate, remoteTip, tree, merged.skipped, parkedNote);
  }
  if (remoteContains(ctx, candidate)) return onRemote();
  throw opError('push_unconfirmed', `The commit is durable locally but no push to ${ctx.remote}/${ctx.mergeRef.replace(/^refs\/heads\//, '')} was confirmed.`,
    `git push failed (network, credentials, branch protection, or a remote that kept moving): ${lastError.slice(0, 500) || 'no detail'}. Rerun gbrain git commit-push --push-only once the remote is reachable; never git pull --rebase in this checkout.`,
    { detail: candidate, retryable: true });
}

/** Non-merge commits in `target` but not in `upstream` (at most 200) that change files outside `roots`; null when git cannot list them. */
export function localCommitsOutsideRoots(root: string, target: string, upstream: string, roots: string[]): Array<{ sha: string; paths: string[] }> | null {
  if (roots.includes('')) return [];
  const local = git(root, ['rev-list', '--no-merges', '--max-count=200', target, '--not', upstream]);
  if (local.code !== 0) return null;
  const offending: Array<{ sha: string; paths: string[] }> = [];
  for (const sha of local.stdout.split('\n').filter(Boolean)) {
    const paths = git(root, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', '--root', sha]).stdout.split('\0').filter(p => p && !insideSourceRoots(p, roots));
    if (paths.length) offending.push({ sha, paths });
  }
  return offending;
}

/**
 * Refuse to publish a local commit that changes files outside the configured source root(s). In a shared
 * checkout a commit made without paths (a cron's `git add <dir>; git commit`) carries whatever any writer
 * had staged; the source-root config is how a brain inside a larger repository says which files are its own.
 * Merge commits are not judged (gbrain's in-memory merges bring remote files in). With no root configured
 * the whole checkout is the root and nothing is refused.
 */
function assertLocalCommitsInsideRoots(ctx: Ctx, target: string, roots: string[]): void {
  const offending = localCommitsOutsideRoots(ctx.root, target, ctx.trackingRef, roots) ?? [];
  if (!offending.length) return;
  const files = [...new Set(offending.flatMap(o => o.paths))];
  const shas = offending.map(o => o.sha.slice(0, 12)).join(', ');
  throw opError('commit_outside_source_root', `${offending.length} local commit(s) (${shas}) change ${files.length} file(s) outside this brain's source root (${roots.join(', ')}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', ...' : ''}. Nothing was pushed.`,
    `A commit made without gbrain git commit-push (for example a cron's git add plus git commit) can carry files other writers had staged. Show the user git show --stat ${offending[0].sha.slice(0, 12)}; if they want it published as is, rerun with --allow-outside-source-root. See docs/guides/shared-checkout-git.md#source-roots.`,
    { detail: JSON.stringify({ roots, commits: offending }),
      fix: { ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
        argv: ['gbrain', 'git', 'commit-push', '--push-only', '--allow-outside-source-root', '--path', ctx.root],
        why: 'These commits change files that are not the brain\'s; publishing them can overwrite other projects\' or writers\' work on the remote.',
        user_message: `Local commit(s) ${shas} change files outside the brain's folder (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}). Publish them anyway?`,
        docs: 'docs/guides/shared-checkout-git.md#source-roots' } });
}

/** Advance the shared checkout (caller holds the commit lock) with a real compare-and-swap: fast-forward only, hooks off, never autostash. */
function advanceLocked(root: string, target: string, expectedHead: string): { checkout: CheckoutState; reason?: string } {
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (head === target || isAncestor(root, target, head)) return { checkout: 'unchanged' };
  if (head !== expectedHead) {
    return { checkout: 'lagging', reason: isAncestor(root, expectedHead, head)
      ? `a newer local commit (${head.slice(0, 12)}) landed during the push; publishing it advances the checkout`
      : `HEAD moved to ${head.slice(0, 12)} during the push (a writer that did not take the commit lock)` };
  }
  if (!isAncestor(root, head, target)) return { checkout: 'lagging', reason: `HEAD ${head.slice(0, 12)} is not part of the published history (it was rewritten locally)` };
  const r = withIndexRetry(root, ['-c', 'core.hooksPath=/dev/null', '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', target], 'checkout advance');
  if (r.code === 0) return { checkout: 'advanced' };
  const dirty = [...r.stderr.matchAll(/^\t(.+)$/gm)].map(m => m[1]);
  if (dirty.length) return { checkout: 'lagging', reason: `local edits in ${dirty.join(', ')} block the fast-forward` };
  throw opError('git_unavailable', `git could not fast-forward ${root} to ${target.slice(0, 12)}.`,
    `${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}. Nothing in the working tree changed; run gbrain git commit-push --pull once git works in this checkout.`, { detail: target });
}

function advanceWithLock(root: string, target: string, expectedHead: string, onlyWhenClean: boolean, lockWaitMs?: number): { checkout: CheckoutState; reason?: string } {
  let lock: CommitLock;
  try { lock = acquireCommitLock(root, lockWaitMs); } catch (e) {
    if ((e as { code?: string }).code !== 'commit_lock_busy') throw e;
    return { checkout: 'lagging', reason: 'another writer held the commit lock; the next publish or --pull advances the checkout' };
  }
  try {
    if (onlyWhenClean && git(root, ['status', '--porcelain']).stdout.trim()) {
      return { checkout: 'lagging', reason: 'the checkout has local edits and this unattended run never moves files under them' };
    }
    return advanceLocked(root, target, expectedHead);
  } finally {
    lock.release();
  }
}

// ── Conflict state (doctor / put_page read it) ──────────────────────────────

export interface IntegrateConflictState { branch: string; at: string; local: string; remote: string; paths: string[] }

/** The unresolved integrate_conflict recorded for this checkout, if any. */
export function readIntegrateConflict(repo: string): IntegrateConflictState | null {
  try {
    const root = checkoutRoot(repo);
    const p = absGitPath(root, CONFLICT_STATE_NAME);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as IntegrateConflictState : null;
  } catch {
    return null;
  }
}

function recordConflict(root: string, branch: string, e: unknown): void {
  try {
    const d = JSON.parse(String((e as { detail?: string }).detail ?? '{}'));
    writeFileSync(absGitPath(root, CONFLICT_STATE_NAME), JSON.stringify({ branch, at: new Date().toISOString(), local: d.local, remote: d.remote, paths: d.paths ?? [] }));
  } catch { /* best-effort */ }
}

// ── Public entry points ─────────────────────────────────────────────────────

function defaultPublishWaitMs(): number {
  const raw = process.env.GBRAIN_PUBLISH_LOCK_WAIT_SECONDS ?? process.env.GBRAIN_PUSH_LOCK_WAIT_SECONDS;
  const secs = raw === undefined ? 300 : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 300_000;
}

export function commitAndPush(opts: CommitPushOptions): CommitPushResult {
  const root = checkoutRoot(opts.repo);
  if (opts.keepCheckout && !opts.pushOnly) throw opError('commit_paths_invalid', 'keepCheckout publishes commits already on the branch; it commits nothing.', 'Use --push-only --keep-checkout.');
  if (!opts.keepCheckout) assertManagedFilesystemWrite(root);
  const cwd = opts.cwd ?? process.cwd();
  const roots = configuredSourceRoots(root);
  const rel = opts.pushOnly ? [] : opts.pending
    ? [...dirtyPaths(root, readPendingWriteThrough(root).map(e => e.path).filter(p => insideSourceRoots(p, roots)))]
    : scopePaths(root, opts.paths ?? [], cwd);
  if (!opts.pushOnly && !opts.message?.trim()) {
    throw opError('commit_paths_invalid', 'A commit message is required.', 'Pass -m "<message>".');
  }
  const upstream = resolveCtx(root);
  const ctx = { ...withBranch(upstream, opts.branch), ...(opts.keepCheckout ? { keepCheckout: true } : {}) };
  const elsewhere = ctx.mergeRef !== upstream.mergeRef;
  assertNoOperationInProgress(root);

  let committed: string | null = null;
  if (!opts.pushOnly) {
    const lock = acquireCommitLock(root, opts.lockWaitMs);
    try {
      assertNoOperationInProgress(root);
      committed = rel.length ? commitPaths(root, rel, opts.message!.trim(), { roots: opts.allowOutsideSourceRoot ? [''] : roots, lockPath: lock.lockPath, markHeld: true }) : null;
      settlePending(root);
    } finally {
      lock.release();
    }
  }

  const unattended = !!opts.advanceOnlyWhenClean;
  const publishLockPath = absGitPath(root, PUBLISH_LOCK_NAME);
  const requestPath = absGitPath(root, PUBLISH_REQUEST_NAME);
  const waitMs = unattended ? 0 : opts.publishWaitMs ?? defaultPublishWaitMs();
  let pub = acquireNativeLockSync(publishLockPath, { timeoutMs: waitMs });
  if (!pub) {
    writeFileSync(requestPath, `${process.pid}\n`);
    pub = acquireNativeLockSync(publishLockPath, { timeoutMs: 0 });
  }
  if (!pub) {
    if (unattended) {
      return { outcome: 'push_deferred', sha: null, committed, branch: ctx.branch, remote: ctx.remote, paths: rel, integrated: 0, checkout: 'unchanged' };
    }
    throw opError('push_unconfirmed', `${committed ? 'The commit is durable locally, but another' : 'Another'} publish held this checkout's push lock for ${Math.round(waitMs / 1000)}s.`,
      `The running publish was asked to push HEAD too once it finishes. Rerun gbrain git commit-push --push-only to confirm; never git pull --rebase in this checkout.`,
      { detail: committed ?? '', retryable: true });
  }

  const cycle = (onlyWhenClean: boolean, start: string | null, resolutions?: Map<string, Resolution>) => {
    const requested = existsSync(requestPath);
    rmSync(requestPath, { force: true });
    try {
      const head = gitOk(root, ['rev-parse', 'HEAD'], 'rev-parse HEAD');
      const target = start && !isAncestor(root, start, head) ? start : head;
      if (!opts.allowOutsideSourceRoot) assertLocalCommitsInsideRoots(ctx, target, roots);
      const published = publish(ctx, target, resolutions, opts.expectRemote, cwd);
      if (!elsewhere) rmSync(absGitPath(root, CONFLICT_STATE_NAME), { force: true });
      const moved = published.sha === head || elsewhere || opts.keepCheckout ? { checkout: 'unchanged' as const } : advanceWithLock(root, published.sha, head, onlyWhenClean, opts.lockWaitMs);
      return { published, moved };
    } catch (e) {
      if ((e as { code?: string }).code === 'integrate_conflict' && !elsewhere) recordConflict(root, ctx.branch, e);
      if (requested) writeFileSync(requestPath, `${process.pid}\n`);
      throw e;
    }
  };

  let first: ReturnType<typeof cycle>;
  try {
    first = cycle(unattended, committed, opts.resolutions);
  } finally {
    pub.release();
  }
  // Publishers that found the push lock busy left a request; honor it after releasing (no commit is stranded).
  for (let i = 0; i < 16 && existsSync(requestPath); i++) {
    const again = acquireNativeLockSync(publishLockPath, { timeoutMs: 0 });
    if (!again) break;
    try { cycle(true, null); } catch { break; } finally { again.release(); }
  }

  const { published, moved } = first;
  return {
    outcome: moved.checkout === 'lagging' ? 'pushed_checkout_lagging' : committed || opts.pushOnly ? 'pushed' : 'nothing_to_commit',
    sha: published.sha, committed, branch: ctx.branch, remote: ctx.remote, paths: rel,
    integrated: published.integrated, confirmed: published.confirmed, checkout: moved.checkout, ...(moved.reason ? { lagging_reason: moved.reason } : {}),
    ...(published.quarantined ? { quarantined: published.quarantined } : {}),
  };
}

/**
 * Bring remote commits into the shared checkout without rebasing it: fetch
 * outside the lock, then (under the commit lock) fast-forward, or merge
 * diverged history in memory and fast-forward to the merge. Never pushes.
 * `requireClean` keeps the unattended cron's conservative "any local edit →
 * skip" rule.
 */
export function pullShared(repo: string, opts: { requireClean?: boolean; lockWaitMs?: number; fetchTimeoutMs?: number; remoteBranch?: string } = {}): PullResult {
  const root = checkoutRoot(repo);
  assertManagedFilesystemWrite(root);
  const ctx = withBranch(resolveCtx(root), opts.remoteBranch);
  if (opts.requireClean && git(root, ['status', '--porcelain']).stdout.trim()) return { status: 'skipped_dirty' };
  assertNoOperationInProgress(root);
  const fetched = remoteGit(root, 'fetch', [...fetchFlags(root), '--', ctx.remote, `+${ctx.mergeRef}:${ctx.trackingRef}`], opts.fetchTimeoutMs ?? 300_000);
  if (fetched.code !== 0) {
    throw opError('git_unavailable', `git fetch from ${ctx.remote} failed in ${root}.`, fetched.stderr.trim().slice(0, 300) || 'Check the remote and its credentials.');
  }
  const remoteTip = gitOk(root, ['rev-parse', ctx.trackingRef], 'rev-parse tracking ref');
  const lock = acquireCommitLock(root, opts.lockWaitMs);
  try {
    assertNoOperationInProgress(root);
    if (opts.requireClean && git(root, ['status', '--porcelain']).stdout.trim()) return { status: 'skipped_dirty' };
    const head = gitOk(root, ['rev-parse', 'HEAD'], 'rev-parse HEAD');
    if (head === remoteTip || isAncestor(root, remoteTip, head)) return { status: head === remoteTip ? 'up_to_date' : 'ahead' };
    let target = remoteTip;
    let merged = false;
    if (!isAncestor(root, head, remoteTip)) {
      const tree = integrate(root, head, remoteTip);
      if (tree.conflicts.length) throw conflictError(ctx, head, remoteTip, tree);
      target = buildMerge(ctx, head, remoteTip, tree.tree!, tree.skipped);
      merged = true;
    }
    const moved = advanceLocked(root, target, head);
    if (moved.checkout === 'lagging') return { status: 'lagging', from: head, reason: moved.reason };
    return { status: 'advanced', from: head, to: target, merged };
  } finally {
    lock.release();
  }
}
