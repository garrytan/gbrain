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
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scanRange } from './range-secret-scan.ts';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv, literalPathspecs } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH, GIT_SSRF_SUBCOMMAND_FLAGS, durableSsrfFlags } from '../git-transport.ts';
import { assertManagedFilesystemWrite, hasFilesystemPublication, managedFilesystemRootFor, type ManagedFilesystemRoot } from '../persistence/filesystem-guard.ts';
import { acquireNativeLock, acquireNativeLockSync, type NativeLockSyncHandle } from '../persistence/native-lock.ts';
import { recordCommit, recordIntent } from './commit-ledger.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import { isSyncable } from '../sync.ts';

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
  /**
   * `push_deferred`: an unattended publish found another publish running and left it a request to publish HEAD too.
   * `committed_local`: a managed canonical worktree, or a checkout with no Git remote (`no_remote`), where commit-push only commits the named paths and never pushes.
   */
  outcome: 'pushed' | 'nothing_to_commit' | 'pushed_checkout_lagging' | 'push_deferred' | 'committed_local';
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
  /** The checkout has no Git remote: the paths were committed locally (or were already committed) and nothing was pushed. */
  no_remote?: true;
  /** Conflicted files where the remote held a version this checkout had already replaced: this checkout's version was published. */
  superseded_remote_paths?: string[];
  /** A managed canonical worktree: the named paths were committed (or had no change) and nothing was pushed. */
  managed?: true;
  /** Managed only: commits on the branch its upstream lacks as last fetched; null when no fetched upstream can be read. */
  unpublished?: number | null;
  /** Managed only: the branch's configured upstream (`origin/main`); null when it names none. */
  upstream?: string | null;
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
  /**
   * `--expect-remote`: the remote commit the resolutions were chosen against (required with resolutions). Without
   * resolutions it binds the publish (#7686): HEAD is merged with that commit, pushed with a lease on it, and a remote that
   * moved anywhere else refuses, so a rewrite made after the caller checked the remote is never merged back.
   */
  expectRemote?: string;
  /** How long a foreground publish waits for another publish to finish. */
  publishWaitMs?: number;
  /** Unattended callers (the post-commit hook): publish, but advance the checkout only when it has no local edit. */
  advanceOnlyWhenClean?: boolean;
  /** Push-only: publish HEAD to this remote branch instead of the checked-out branch's upstream (the helper's `--push-only <branch>`). */
  branch?: string;
  /** Push-only: never advance the checkout and skip its pre-push hook (a managed canonical worktree; see the header). */
  keepCheckout?: boolean;
  /** Before pushing, scan what the commits the upstream lacks add (messages, added lines, merge resolutions) and refuse `publish_secret_found` on a finding: the gate for automatic publishes of commits gbrain did not write. */
  scanSecrets?: boolean;
  /** Commit the pending write-through files (`--pending`) instead of named paths. */
  pending?: boolean;
  /** Commit and publish files outside the configured source root(s): the user's explicit choice, or gbrain's own scaffolding at the checkout root. */
  allowOutsideSourceRoot?: boolean;
  /** `--base <path>=<blob>`: the blob (or `absent`) each named path had at HEAD when the writer read it; a moved one refuses `commit_base_moved`. */
  bases?: Map<string, string>;
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

function git(root: string, args: string[], opts: { auth?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {}): GitRun {
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
/** The operator step that commits and pushes only `paths` (relative to `root`) with one -m per message paragraph: the fix text doctor and repair print instead of a bare git add/commit. */
export function commitPushCommand(root: string, paths: readonly string[], messages: readonly string[]): string {
  return shellQuote(['gbrain', 'git', 'commit-push', '--path', root, ...messages.flatMap(m => ['-m', m]), '--', ...paths]);
}

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
  return git(root, ['ls-files', '-s', '-z', '--', ...literalPathspecs(rel)]).stdout.split('\0').filter(Boolean);
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

interface CommitScope { roots: string[]; lockPath: string; markHeld: boolean; bases?: ReadonlyMap<string, string> }

/** A named path `git add -A` left out of the index while still exiting 0 (GST-2116). */
export interface SkippedPath { path: string; reason: 'assume_unchanged' | 'skip_worktree' | 'not_staged' }

/** The flagged index entries in `listed` (`ls-files -v`: lower case for assume-unchanged, S for skip-worktree) whose bytes on disk HEAD lacks. A skip-worktree entry absent from disk is a sparse checkout, not a change. */
function flaggedChanges(root: string, listed: string[]): SkippedPath[] {
  const changed: SkippedPath[] = [];
  const flagged = listed.filter(entry => /^[a-zS] /.test(entry));
  const gitlinks = new Set(flagged.length
    ? gitOk(root, ['ls-files', '-s', '-z', '--', ...literalPathspecs(flagged.map(line => line.slice(2)))], 'ls-files -s')
      .split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1))
    : []);
  for (const line of flagged) {
    const path = line.slice(2);
    if (gitlinks.has(path)) continue;
    const abs = join(root, path);
    const reason = /^[sS]/.test(line) ? 'skip_worktree' as const : 'assume_unchanged' as const;
    const stat = (() => { try { return lstatSync(abs); } catch { return null; } })();
    if (!stat && reason === 'skip_worktree') continue;
    const hashed = !stat ? null : stat.isSymbolicLink()
      ? git(root, ['hash-object', '--stdin'], { input: readlinkSync(abs) })
      : git(root, ['hash-object', '--', path]);
    // An entry git cannot hash (a missing required filter, an unreadable file, a directory now) counts as changed, so it is reported, never dropped.
    const disk = hashed && (hashed.code === 0 ? hashed.stdout.trim() : undefined);
    const committed = git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]).stdout.trim() || null;
    if (disk !== committed) changed.push({ path, reason });
  }
  return changed;
}

/**
 * GST-2116: the named paths whose bytes on disk HEAD still lacks once the commit step is done. `git add -A` stages
 * nothing and exits 0 for a modified entry flagged assume-unchanged or skip-worktree (`ls-files -v`: lower case, or S;
 * `commit --only` may still pick one up beside another path, so the check reads HEAD) and for a file inside an untracked
 * nested repository. A skip-worktree entry absent from disk is a sparse checkout, not a change, and a flagged gitlink
 * is left out (its commit lives in the nested repository, which hash-object cannot read). Ignored files under a named
 * directory are left out as git leaves them; a named ignored file is refused by `git add` itself.
 */
function unstagedPaths(root: string, rel: string[], listed: string[]): SkippedPath[] {
  const skipped = new Map(flaggedChanges(root, listed).map(s => [s.path, s.reason]));
  for (const path of unindexedFiles(root, rel, listed)) if (!skipped.has(path)) skipped.set(path, 'not_staged');
  // Only a named directory can hide an unstaged change from the two checks above (a nested repository inside it).
  const dirs = rel.filter(path => { try { return lstatSync(join(root, path)).isDirectory(); } catch { return false; } });
  // Status lists nothing under a directory that sits inside an untracked nested repository.
  for (const path of dirs) {
    const parents = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    if (!skipped.has(path) && parents.some(parent => existsSync(join(root, parent, '.git')))) skipped.set(path, 'not_staged');
  }
  const status = dirs.length ? gitOk(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...literalPathspecs(dirs)], 'status') : '';
  for (const entry of status.split('\0').filter(Boolean)) {
    const path = entry.slice(3);
    if ((entry[1] !== ' ' || entry.startsWith('??')) && !skipped.has(path)) skipped.set(path, 'not_staged');
  }
  return [...skipped].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path));
}


/** Named paths that are files on disk yet absent from the index (`listed`: `ls-files -v` after `git add -A`), as a file inside a nested repository is. */
function unindexedFiles(root: string, rel: string[], listed: string[]): string[] {
  const indexed = new Set(listed.map(line => line.slice(2)));
  return rel.filter(path => {
    if (indexed.has(path)) return false;
    try { return !lstatSync(join(root, path)).isDirectory(); } catch { return false; }
  });
}

/**
 * GST-2116: a run that left a named path uncommitted fails, after committing (and, on a classic checkout, pushing) the
 * rest, so a write is never reported as saved when it is not. In a managed canonical worktree a skipped page is the
 * owner's to save (`writer_coordinator_required`); anything else is `commit_paths_skipped`.
 */
function skippedPathsError(root: string, skipped: SkippedPath[], result: CommitPushResult, managed?: ManagedFilesystemRoot, publish?: unknown): OperationError {
  const list = `${skipped.slice(0, 20).map(s => `${s.path} (${s.reason})`).join(', ')}${skipped.length > 20 ? ', ...' : ''}`;
  const pushed = !!result.committed && (result.outcome === 'pushed' || result.outcome === 'pushed_checkout_lagging');
  const done = result.committed
    ? `The other named paths were committed as ${result.committed.slice(0, 7)}${pushed ? ` and pushed to ${result.remote}/${result.branch}` : ', not pushed'}.`
    : 'Nothing was committed.';
  const failed = publish as { code?: string; message?: string; detail?: string } | undefined;
  const rest = `${done}${failed ? ` The push failed too (${failed.code ?? 'error'}): ${failed.message ?? String(publish)}` : ''}`;
  const detail = JSON.stringify({ skipped, committed: result.committed, ...(pushed ? { pushed: result.sha } : {}), branch: result.branch,
    ...(failed ? { publish: { code: failed.code ?? null, detail: failed.detail ?? null } } : {}) });
  const docs = 'docs/guides/shared-checkout-git.md#outcomes';
  const flagged = skipped.filter(s => s.reason !== 'not_staged');
  // One update-index call per flag: given both, git clears only the first.
  const clears = (['assume_unchanged', 'skip_worktree'] as const)
    .map(reason => ({ flag: reason === 'skip_worktree' ? '--no-skip-worktree' : '--no-assume-unchanged', paths: flagged.filter(s => s.reason === reason).map(s => s.path) }))
    .filter(c => c.paths.length)
    .map(c => ['git', '-C', root, 'update-index', c.flag, '--', ...c.paths]);
  const clearCommand = clears.map(argv => shellQuote(argv)).join(' && ');
  const flagNote = 'an assume-unchanged or skip-worktree flag; an editor, an indexer or a sparse checkout can leave one, and people also set skip-worktree on purpose to keep local edits out of commits, so clearing it commits those edits';
  const chain = (steps: string[][], last?: Action): Action | undefined => steps.reduceRight<Action | undefined>((then, argv) =>
    ({ argv, consent: [], actor: 'agent', requires_exclusive: false, why: 'Clears the flag so git sees the edit on disk; the file keeps its bytes.', ...(then ? { then } : {}) }), last);
  const pages = managed ? skipped.filter(s => isSyncable(s.path)) : [];
  if (managed && pages.length) {
    const source = managed.sourceId ? { argv: ['--source-id', managed.sourceId], mcp: { source_id: managed.sourceId } } : { argv: [], mcp: {} };
    const put: Action = { argv: ['gbrain', 'put', ...source.argv, '<slug>'],
      mcp: { tool: 'put_page', arguments: { slug: '<slug>', ...source.mcp, content: '<the page file>' } },
      inputs: [{ name: 'slug', how: `Each listed page path without its .md extension; pass the file's content on stdin: ${pages.slice(0, 5).map(s => s.path).join(', ')}` }],
      consent: [], actor: 'agent', requires_exclusive: false,
      why: 'put_page saves the page through the owner, which writes the file, commits only that path and pushes it.',
      verify: { argv: ['gbrain', 'sources', 'writer', 'status', managed.sourceId ?? '<source>', '--json'] } };
    return opError('writer_coordinator_required',
      `${root} is the managed canonical worktree${managed.sourceId ? ` of source ${managed.sourceId}` : ''}, and git did not commit ${skipped.length} named path(s): ${list}. ${rest}`,
      `${clears.length ? `First, with the user's agreement, clear the flags (${clearCommand}), since the owner's own Git step cannot see a flagged edit either. ` : ''}Then save those pages through gbrain (put_page, edit_page or capture; on the CLI, gbrain put${managed.sourceId ? ` --source-id ${managed.sourceId}` : ''} with the page slug and the page on stdin): the persistence owner commits and pushes them. Never commit page files around it.`,
      { docs, detail,
        why: 'The persistence owner is the only Git writer of pages in a managed worktree; a page file written there directly and left uncommitted is neither in Git nor in the database, so reporting success would lose the write silently.',
        fix: { ...(chain(clears, put) ?? put), ask_user: true,
          user_message: `These page files were written straight into the managed checkout and git did not commit them: ${pages.slice(0, 10).map(s => s.path).join(', ')}.${clears.length ? ` Git hides their edits (${flagNote}); clear the flags first.` : ''} Save each one through gbrain (put_page), which replaces the stored page with the file's content?` } });
  }
  return opError('commit_paths_skipped', `git did not commit ${skipped.length} named path(s) in ${root}: ${list}. ${rest}`,
    flagged.length
      ? `Git hides edits to the assume_unchanged and skip_worktree paths from commits. With the user's agreement clear the flags (${clearCommand}), then rerun the same commit-push.`
      : 'Git did not stage the not_staged paths (a file inside a nested Git repository is the usual cause). Move them into the brain checkout proper, or commit them in their own repository, then rerun.',
    { docs, detail,
      why: 'git add stages nothing and still exits 0 for a modified file flagged assume-unchanged or skip-worktree, or a file inside a nested repository; reporting success would leave the write uncommitted with nothing in any log.',
      fix: flagged.length
        ? { ...chain(clears)!, ask_user: true,
          user_message: `Git is set to ignore edits to ${flagged.slice(0, 10).map(s => s.path).join(', ')} (${flagNote}), so they were not committed. Clear those flags and commit the edits?`,
          verify: { argv: ['git', '-C', root, 'ls-files', '-v', '--', ...flagged.map(s => s.path)] } }
        : { consent: [], actor: 'user', requires_exclusive: false,
          why: 'Git cannot commit a file that belongs to another repository, so only moving it or committing it there settles it.',
          user_message: `Git did not commit ${skipped.slice(0, 10).map(s => s.path).join(', ')} in ${root} (a file inside a nested Git repository is the usual cause). Where should they be committed?` } });
}

/** `--base` keyed by the repository-relative path it names; each must also be a committed path. */
function scopeBases(root: string, opts: CommitPushOptions, rel: string[]): Map<string, string> | undefined {
  if (!opts.bases?.size) return undefined;
  const scoped = new Map<string, string>();
  for (const [path, blob] of opts.bases) {
    const [key] = scopePaths(root, [path], opts.cwd ?? process.cwd());
    if (!key || !rel.includes(key)) throw opError('commit_paths_invalid', `--base names ${path}, which is not one of the paths to commit.`, 'Name every --base path after -- as well.');
    scoped.set(key, blob);
  }
  return scoped;
}

/**
 * Stage and commit exactly `rel` (the caller holds the commit lock). Refused
 * before anything is staged: a path outside the source root(s), and a file
 * another writer already staged under a named directory (name it to claim
 * it). A commit git refuses leaves the index as it found it. `skipped` lists
 * the named paths git left out (GST-2116); the rest are still committed.
 */
function commitPaths(root: string, rel: string[], message: string, scope: CommitScope): { sha: string | null; skipped: SkippedPath[] } {
  const outside = rel.filter(p => !insideSourceRoots(p, scope.roots));
  if (outside.length) throw outsideRootError(root, scope.roots, outside, 'Refusing to commit');
  for (const [path, base] of scope.bases ?? []) {
    const head = git(root, ['rev-parse', '--verify', '-q', `HEAD:${path}`]).stdout.trim() || 'absent';
    if (head !== base) throw opError('commit_base_moved', `${path} changed at HEAD since the writer read it (base ${base}, HEAD ${head}).`,
      `Nothing was staged or committed. Read ${path} at HEAD again (git -C ${root} show HEAD:${path}), redo the change on it, and rerun with --base ${path}=${head}.`,
      { detail: JSON.stringify({ path, base, head }), docs: 'docs/guides/shared-checkout-git.md#base-check' });
  }
  const swept = stagedPaths(root).filter(p => !rel.includes(p) && rel.some(spec => covers(spec, p)));
  if (swept.length) {
    const list = `${swept.slice(0, 10).join(', ')}${swept.length > 10 ? ', ...' : ''}`;
    throw opError('commit_prestaged_paths', `${swept.length} file(s) under the named path(s) were already staged by another writer: ${list}.`  // GST-2118: git add refuses a named skip-worktree file that is on disk; it is left to the skipped-path check, so the other paths still commit.
  const sparse = new Set(gitOk(root, ['ls-files', '-v', '-z', '--', ...literalPathspecs(rel)], 'ls-files -v').split('\0')
    .filter(entry => /^[sS] /.test(entry) && rel.includes(entry.slice(2)) && existsSync(join(root, entry.slice(2)))).map(entry => entry.slice(2)));
  const live = rel.filter(p => !sparse.has(p));
  // #7984: a tracked path stages with `add -u`, because `add -A` refuses a deletion whose only match left is an ignored
  // path; visible untracked files stage with `add -A`; a path already staged as deleted is staged. Any other path keeps
  // git's own refusal (missing, or only an ignored untracked file).
  const listed = (args: string[]) => live.length ? git(root, [...args, '-z', '--', ...literalPathspecs(live)]).stdout.split('\0').filter(Boolean) : [];
  const tracked = before.map(line => line.slice(line.indexOf('\t') + 1));
  const untracked = listed(['ls-files', '--others', '--exclude-standard']);
  const deleted = listed(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=D']);
  const matching = (paths: string[]) => live.filter(spec => paths.some(p => covers(spec, p)));
  const matched = new Set(matching([...tracked, ...untracked, ...deleted]));
  const unmatched = live.filter(spec => !matched.has(spec));
  let landed: { committed: boolean; paths: string[]; listed: string[] };
l for classic (unmanaged) brain
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
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { scanRange } from './range-secret-scan.ts';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv, literalPathspecs } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH, GIT_SSRF_SUBCOMMAND_FLAGS, durableSsrfFlags } from '../git-transport.ts';
import { assertManagedFilesystemWrite, hasFilesystemPublication, managedFilesystemRootFor, type ManagedFilesystemRoot } from '../persistence/filesystem-guard.ts';
import { acquireNativeLock, acquireNativeLockSync, type NativeLockSyncHandle } from '../persistence/native-lock.ts';
import { recordCommit, recordIntent } from './commit-ledger.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import { isSyncable } from '../sync.ts';

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
  /**
   * `push_deferred`: an unattended publish found another publish running and left it a request to publish HEAD too.
   * `committed_local`: a managed canonical worktree, or a checkout with no Git remote (`no_remote`), where commit-push only commits the named paths and never pushes.
   */
  outcome: 'pushed' | 'nothing_to_commit' | 'pushed_checkout_lagging' | 'push_deferred' | 'committed_local';
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
  /** The checkout has no Git remote: the paths were committed locally (or were already committed) and nothing was pushed. */
  no_remote?: true;
  /** Conflicted files where the remote held a version this checkout had already replaced: this checkout's version was published. */
  superseded_remote_paths?: string[];
  /** A managed canonical worktree: the named paths were committed (or had no change) and nothing was pushed. */
  managed?: true;
  /** Managed only: commits on the branch its upstream lacks as last fetched; null when no fetched upstream can be read. */
  unpublished?: number | null;
  /** Managed only: the branch's configured upstream (`origin/main`); null when it names none. */
  upstream?: string | null;
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
  /**
   * `--expect-remote`: the remote commit the resolutions were chosen against (required with resolutions). Without
   * resolutions it binds the publish (#7686): HEAD is merged with that commit, pushed with a lease on it, and a remote that
   * moved anywhere else refuses, so a rewrite made after the caller checked the remote is never merged back.
   */
  expectRemote?: string;
  /** How long a foreground publish waits for another publish to finish. */
  publishWaitMs?: number;
  /** Unattended callers (the post-commit hook): publish, but advance the checkout only when it has no local edit. */
  advanceOnlyWhenClean?: boolean;
  /** Push-only: publish HEAD to this remote branch instead of the checked-out branch's upstream (the helper's `--push-only <branch>`). */
  branch?: string;
  /** Push-only: never advance the checkout and skip its pre-push hook (a managed canonical worktree; see the header). */
  keepCheckout?: boolean;
  /** Before pushing, scan what the commits the upstream lacks add (messages, added lines, merge resolutions) and refuse `publish_secret_found` on a finding: the gate for automatic publishes of commits gbrain did not write. */
  scanSecrets?: boolean;
  /** Commit the pending write-through files (`--pending`) instead of named paths. */
  pending?: boolean;
  /** Commit and publish files outside the configured source root(s): the user's explicit choice, or gbrain's own scaffolding at the checkout root. */
  allowOutsideSourceRoot?: boolean;
  /** `--base <path>=<blob>`: the blob (or `absent`) each named path had at HEAD when the writer read it; a moved one refuses `commit_base_moved`. */
  bases?: Map<string, string>;
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

function git(root: string, args: string[], opts: { auth?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; maxBuffer?: number } = {}): GitRun {
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
/** The operator step that commits and pushes only `paths` (relative to `root`) with one -m per message paragraph: the fix text doctor and repair print instead of a bare git add/commit. */
export function commitPushCommand(root: string, paths: readonly string[], messages: readonly string[]): string {
  return shellQuote(['gbrain', 'git', 'commit-push', '--path', root, ...messages.flatMap(m => ['-m', m]), '--', ...paths]);
}

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
  return git(root, ['ls-files', '-s', '-z', '--', ...literalPathspecs(rel)]).stdout.split('\0').filter(Boolean);
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

interface CommitScope { roots: string[]; lockPath: string; markHeld: boolean; bases?: ReadonlyMap<string, string> }

/** A named path `git add -A` left out of the index while still exiting 0 (GST-2116). */
export interface SkippedPath { path: string; reason: 'assume_unchanged' | 'skip_worktree' | 'not_staged' }

/** The flagged index entries in `listed` (`ls-files -v`: lower case for assume-unchanged, S for skip-worktree) whose bytes on disk HEAD lacks. A skip-worktree entry absent from disk is a sparse checkout, not a change. */
function flaggedChanges(root: string, listed: string[]): SkippedPath[] {
  const changed: SkippedPath[] = [];
  const flagged = listed.filter(entry => /^[a-zS] /.test(entry));
  const gitlinks = new Set(flagged.length
    ? gitOk(root, ['ls-files', '-s', '-z', '--', ...literalPathspecs(flagged.map(line => line.slice(2)))], 'ls-files -s')
      .split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1))
    : []);
  for (const line of flagged) {
    const path = line.slice(2);
    if (gitlinks.has(path)) continue;
    const abs = join(root, path);
    const reason = /^[sS]/.test(line) ? 'skip_worktree' as const : 'assume_unchanged' as const;
    const stat = (() => { try { return lstatSync(abs); } catch { return null; } })();
    if (!stat && reason === 'skip_worktree') continue;
    const hashed = !stat ? null : stat.isSymbolicLink()
      ? git(root, ['hash-object', '--stdin'], { input: readlinkSync(abs) })
      : git(root, ['hash-object', '--', path]);
    // An entry git cannot hash (a missing required filter, an unreadable file, a directory now) counts as changed, so it is reported, never dropped.
    const disk = hashed && (hashed.code === 0 ? hashed.stdout.trim() : undefined);
    const committed = git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]).stdout.trim() || null;
    if (disk !== committed) changed.push({ path, reason });
  }
  return changed;
}

/**
 * GST-2116: the named paths whose bytes on disk HEAD still lacks once the commit step is done. `git add -A` stages
 * nothing and exits 0 for a modified entry flagged assume-unchanged or skip-worktree (`ls-files -v`: lower case, or S;
 * `commit --only` may still pick one up beside another path, so the check reads HEAD) and for a file inside an untracked
 * nested repository. A skip-worktree entry absent from disk is a sparse checkout, not a change, and a flagged gitlink
 * is left out (its commit lives in the nested repository, which hash-object cannot read). Ignored files under a named
 * directory are left out as git leaves them; a named ignored file is refused by `git add` itself.
 */
function unstagedPaths(root: string, rel: string[], listed: string[]): SkippedPath[] {
  const skipped = new Map(flaggedChanges(root, listed).map(s => [s.path, s.reason]));
  for (const path of unindexedFiles(root, rel, listed)) if (!skipped.has(path)) skipped.set(path, 'not_staged');
  // Only a named directory can hide an unstaged change from the two checks above (a nested repository inside it).
  const dirs = rel.filter(path => { try { return lstatSync(join(root, path)).isDirectory(); } catch { return false; } });
  // Status lists nothing under a directory that sits inside an untracked nested repository.
  for (const path of dirs) {
    const parents = path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    if (!skipped.has(path) && parents.some(parent => existsSync(join(root, parent, '.git')))) skipped.set(path, 'not_staged');
  }
  const status = dirs.length ? gitOk(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...literalPathspecs(dirs)], 'status') : '';
  for (const entry of status.split('\0').filter(Boolean)) {
    const path = entry.slice(3);
    if ((entry[1] !== ' ' || entry.startsWith('??')) && !skipped.has(path)) skipped.set(path, 'not_staged');
  }
  return [...skipped].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path));
}


/** Named paths that are files on disk yet absent from the index (`listed`: `ls-files -v` after `git add -A`), as a file inside a nested repository is. */
function unindexedFiles(root: string, rel: string[], listed: string[]): string[] {
  const indexed = new Set(listed.map(line => line.slice(2)));
  return rel.filter(path => {
    if (indexed.has(path)) return false;
    try { return !lstatSync(join(root, path)).isDirectory(); } catch { return false; }
  });
}

/**
 * GST-2116: a run that left a named path uncommitted fails, after committing (and, on a classic checkout, pushing) the
 * rest, so a write is never reported as saved when it is not. In a managed canonical worktree a skipped page is the
 * owner's to save (`writer_coordinator_required`); anything else is `commit_paths_skipped`.
 */
function skippedPathsError(root: string, skipped: SkippedPath[], result: CommitPushResult, managed?: ManagedFilesystemRoot, publish?: unknown): OperationError {
  const list = `${skipped.slice(0, 20).map(s => `${s.path} (${s.reason})`).join(', ')}${skipped.length > 20 ? ', ...' : ''}`;
  const pushed = !!result.committed && (result.outcome === 'pushed' || result.outcome === 'pushed_checkout_lagging');
  const done = result.committed
    ? `The other named paths were committed as ${result.committed.slice(0, 7)}${pushed ? ` and pushed to ${result.remote}/${result.branch}` : ', not pushed'}.`
    : 'Nothing was committed.';
  const failed = publish as { code?: string; message?: string; detail?: string } | undefined;
  const rest = `${done}${failed ? ` The push failed too (${failed.code ?? 'error'}): ${failed.message ?? String(publish)}` : ''}`;
  const detail = JSON.stringify({ skipped, committed: result.committed, ...(pushed ? { pushed: result.sha } : {}), branch: result.branch,
    ...(failed ? { publish: { code: failed.code ?? null, detail: failed.detail ?? null } } : {}) });
  const docs = 'docs/guides/shared-checkout-git.md#outcomes';
  const flagged = skipped.filter(s => s.reason !== 'not_staged');
  // One update-index call per flag: given both, git clears only the first.
  const clears = (['assume_unchanged', 'skip_worktree'] as const)
    .map(reason => ({ flag: reason === 'skip_worktree' ? '--no-skip-worktree' : '--no-assume-unchanged', paths: flagged.filter(s => s.reason === reason).map(s => s.path) }))
    .filter(c => c.paths.length)
    .map(c => ['git', '-C', root, 'update-index', c.flag, '--', ...c.paths]);
  const clearCommand = clears.map(argv => shellQuote(argv)).join(' && ');
  const flagNote = 'an assume-unchanged or skip-worktree flag; an editor, an indexer or a sparse checkout can leave one, and people also set skip-worktree on purpose to keep local edits out of commits, so clearing it commits those edits';
  const chain = (steps: string[][], last?: Action): Action | undefined => steps.reduceRight<Action | undefined>((then, argv) =>
    ({ argv, consent: [], actor: 'agent', requires_exclusive: false, why: 'Clears the flag so git sees the edit on disk; the file keeps its bytes.', ...(then ? { then } : {}) }), last);
  const pages = managed ? skipped.filter(s => isSyncable(s.path)) : [];
  if (managed && pages.length) {
    const source = managed.sourceId ? { argv: ['--source-id', managed.sourceId], mcp: { source_id: managed.sourceId } } : { argv: [], mcp: {} };
    const put: Action = { argv: ['gbrain', 'put', ...source.argv, '<slug>'],
      mcp: { tool: 'put_page', arguments: { slug: '<slug>', ...source.mcp, content: '<the page file>' } },
      inputs: [{ name: 'slug', how: `Each listed page path without its .md extension; pass the file's content on stdin: ${pages.slice(0, 5).map(s => s.path).join(', ')}` }],
      consent: [], actor: 'agent', requires_exclusive: false,
      why: 'put_page saves the page through the owner, which writes the file, commits only that path and pushes it.',
      verify: { argv: ['gbrain', 'sources', 'writer', 'status', managed.sourceId ?? '<source>', '--json'] } };
    return opError('writer_coordinator_required',
      `${root} is the managed canonical worktree${managed.sourceId ? ` of source ${managed.sourceId}` : ''}, and git did not commit ${skipped.length} named path(s): ${list}. ${rest}`,
      `${clears.length ? `First, with the user's agreement, clear the flags (${clearCommand}), since the owner's own Git step cannot see a flagged edit either. ` : ''}Then save those pages through gbrain (put_page, edit_page or capture; on the CLI, gbrain put${managed.sourceId ? ` --source-id ${managed.sourceId}` : ''} with the page slug and the page on stdin): the persistence owner commits and pushes them. Never commit page files around it.`,
      { docs, detail,
        why: 'The persistence owner is the only Git writer of pages in a managed worktree; a page file written there directly and left uncommitted is neither in Git nor in the database, so reporting success would lose the write silently.',
        fix: { ...(chain(clears, put) ?? put), ask_user: true,
          user_message: `These page files were written straight into the managed checkout and git did not commit them: ${pages.slice(0, 10).map(s => s.path).join(', ')}.${clears.length ? ` Git hides their edits (${flagNote}); clear the flags first.` : ''} Save each one through gbrain (put_page), which replaces the stored page with the file's content?` } });
  }
  return opError('commit_paths_skipped', `git did not commit ${skipped.length} named path(s) in ${root}: ${list}. ${rest}`,
    flagged.length
      ? `Git hides edits to the assume_unchanged and skip_worktree paths from commits. With the user's agreement clear the flags (${clearCommand}), then rerun the same commit-push.`
      : 'Git did not stage the not_staged paths (a file inside a nested Git repository is the usual cause). Move them into the brain checkout proper, or commit them in their own repository, then rerun.',
    { docs, detail,
      why: 'git add stages nothing and still exits 0 for a modified file flagged assume-unchanged or skip-worktree, or a file inside a nested repository; reporting success would leave the write uncommitted with nothing in any log.',
      fix: flagged.length
        ? { ...chain(clears)!, ask_user: true,
          user_message: `Git is set to ignore edits to ${flagged.slice(0, 10).map(s => s.path).join(', ')} (${flagNote}), so they were not committed. Clear those flags and commit the edits?`,
          verify: { argv: ['git', '-C', root, 'ls-files', '-v', '--', ...flagged.map(s => s.path)] } }
        : { consent: [], actor: 'user', requires_exclusive: false,
          why: 'Git cannot commit a file that belongs to another repository, so only moving it or committing it there settles it.',
          user_message: `Git did not commit ${skipped.slice(0, 10).map(s => s.path).join(', ')} in ${root} (a file inside a nested Git repository is the usual cause). Where should they be committed?` } });
}

/** `--base` keyed by the repository-relative path it names; each must also be a committed path. */
function scopeBases(root: string, opts: CommitPushOptions, rel: string[]): Map<string, string> | undefined {
  if (!opts.bases?.size) return undefined;
  const scoped = new Map<string, string>();
  for (const [path, blob] of opts.bases) {
    const [key] = scopePaths(root, [path], opts.cwd ?? process.cwd());
    if (!key || !rel.includes(key)) throw opError('commit_paths_invalid', `--base names ${path}, which is not one of the paths to commit.`, 'Name every --base path after -- as well.');
    scoped.set(key, blob);
  }
  return scoped;
}

/**
 * Stage and commit exactly `rel` (the caller holds the commit lock). Refused
 * before anything is staged: a path outside the source root(s), and a file
 * another writer already staged under a named directory (name it to claim
 * it). A commit git refuses leaves the index as it found it. `skipped` lists
 * the named paths git left out (GST-2116); the rest are still committed.
 */
function commitPaths(root: string, rel: string[], message: string, scope: CommitScope): { sha: string | null; skipped: SkippedPath[] } {
  const outside = rel.filter(p => !insideSourceRoots(p, scope.roots));
  if (outside.length) throw outsideRootError(root, scope.roots, outside, 'Refusing to commit');
  for (const [path, base] of scope.bases ?? []) {
    const head = git(root, ['rev-parse', '--verify', '-q', `HEAD:${path}`]).stdout.trim() || 'absent';
    if (head !== base) throw opError('commit_base_moved', `${path} changed at HEAD since the writer read it (base ${base}, HEAD ${head}).`,
      `Nothing was staged or committed. Read ${path} at HEAD again (git -C ${root} show HEAD:${path}), redo the change on it, and rerun with --base ${path}=${head}.`,
      { detail: JSON.stringify({ path, base, head }), docs: 'docs/guides/shared-checkout-git.md#base-check' });
  }
  const swept = stagedPaths(root).filter(p => !rel.includes(p) && rel.some(spec => covers(spec, p)));
  if (swept.length) {
    const list = `${swept.slice(0, 10).join(', ')}${swept.length > 10 ? ', ...' : ''}`;
    throw opError('commit_prestaged_paths', `${swept.length} file(s) under the named path(s) were already staged by another writer: ${list}.`,