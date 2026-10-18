import { assertManagedFilesystemWrite } from './persistence/filesystem-guard.ts';
/**
 * gbrain remote-source git helpers (v0.28).
 *
 * Single source of SSRF-defensive git invocations. parseRemoteUrl delegates
 * to isInternalUrl from src/core/url-safety.ts (covers scheme allowlist,
 * IPv6 loopback, IPv4-mapped IPv6, metadata hostnames, hex/octal bypass,
 * and CGNAT 100.64/10).
 *
 * cloneRepo and pullRepo both spread GIT_SSRF_FLAGS so a future flag added
 * to one path lands on both — single source of truth.
 *
 * Tailscale 100.64/10 trips the integrations.ts allowlist (CGNAT line in
 * url-safety.ts isPrivateIpv4). For self-hosted internal git servers
 * reachable only via Tailscale, set GBRAIN_ALLOW_PRIVATE_REMOTES=1; loud
 * stderr warning at use site is the operator's signal.
 */
import { execFileSync } from './spawn.ts';
import { lstatSync, existsSync, readdirSync } from 'fs';
import { isAbsolute, join } from 'path';
import { isInternalUrl } from './url-safety.ts';
import { execFileBounded } from './bounded-child-exec.ts';
import { gitChildEnv } from './git-env.ts';
import { GIT_SSRF_FLAGS, GIT_SSRF_SUBCOMMAND_FLAGS, GIT_ENV, GIT_ENV_AUTH, durableSsrfFlags } from './git-transport.ts';
export { GIT_SSRF_FLAGS, GIT_SSRF_SUBCOMMAND_FLAGS, buildGitEnv, GIT_ENV, GIT_ENV_AUTH, durableSsrfFlags } from './git-transport.ts';
import { pullShared, acquireCommitLockAsync } from './git/commit-push.ts';

export type RemoteUrlErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'path_traversal'
  | 'internal_target';

export class RemoteUrlError extends Error {
  constructor(public code: RemoteUrlErrorCode, message: string) {
    super(message);
    this.name = 'RemoteUrlError';
  }
}

export interface ParsedRemoteUrl {
  url: string;
  hostname: string;
}

/**
 * Validate a remote git URL for clone safety. https:// only.
 * Rejects: non-https schemes, embedded credentials, path traversal, and
 * internal/private targets via isInternalUrl.
 *
 * GBRAIN_ALLOW_PRIVATE_REMOTES=1 lets the URL through with a stderr warning.
 * Needed for self-hosted git over Tailscale (CGNAT 100.64/10) and similar.
 */
export function parseRemoteUrl(s: string): ParsedRemoteUrl {
  if (!s || typeof s !== 'string') {
    throw new RemoteUrlError('invalid_url', 'URL is empty or not a string');
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new RemoteUrlError('invalid_url', `URL malformed: ${s}`);
  }
  if (url.protocol !== 'https:') {
    throw new RemoteUrlError(
      'unsupported_scheme',
      `URL scheme not supported (https:// only): ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new RemoteUrlError(
      'embedded_credentials',
      'URL must not contain embedded credentials (https://user:pass@host)',
    );
  }
  if (s.includes('..')) {
    throw new RemoteUrlError('path_traversal', 'URL must not contain path-traversal (..)');
  }
  if (isInternalUrl(s)) {
    if (process.env.GBRAIN_ALLOW_PRIVATE_REMOTES === '1') {
      console.error(
        `[gbrain] WARN: GBRAIN_ALLOW_PRIVATE_REMOTES=1, accepting internal/private URL: ${url.hostname}`,
      );
    } else {
      throw new RemoteUrlError(
        'internal_target',
        `URL targets internal/private network: ${url.hostname} ` +
          `(set GBRAIN_ALLOW_PRIVATE_REMOTES=1 for self-hosted git over Tailscale or similar)`,
      );
    }
  }
  return { url: s, hostname: url.hostname };
}

export interface CloneOpts {
  depth?: number; // default 1; 0 means full clone
  branch?: string;
  timeoutMs?: number; // default 600_000 (10 min)
}

export class GitOperationError extends Error {
  constructor(
    public op: 'clone' | 'pull' | 'fetch' | 'remote_get_url',
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

/**
 * Stderr-first error detail for a failed git subprocess (#1315).
 *
 * execFileSync errors put the full argv echo FIRST
 * ("Command failed: git -C <path> -c http.followRedirects=false …") and the
 * real `fatal: …` stderr last — so every downstream `.slice(0, N)` (sync's
 * warn-and-continue lines, phase breadcrumbs) truncated the message before
 * the actual reason ever appeared. Lead with the captured stderr; fall back
 * to the envelope message when stderr is empty (e.g. spawn failures).
 */
function gitErrorDetail(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | null)?.stderr;
  if (stderr != null) {
    const s = String(stderr).trim();
    if (s) return s;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Clone a remote git repo with SSRF-defensive flags.
 * - destDir must NOT exist or must be empty.
 * - Default --depth=1 (no history); pass {depth: 0} for full clone.
 * - Throws GitOperationError on failure; caller is responsible for cleanup.
 */
export function cloneRepo(url: string, destDir: string, opts: CloneOpts = {}): void {
  assertManagedFilesystemWrite(destDir);
  if (existsSync(destDir)) {
    let entries: string[];
    try {
      entries = readdirSync(destDir);
    } catch (e) {
      throw new GitOperationError(
        'clone',
        `Cannot inspect destination ${destDir}: ${(e as Error).message}`,
        e,
      );
    }
    if (entries.length > 0) {
      throw new GitOperationError(
        'clone',
        `Destination ${destDir} exists and is not empty; refusing to clone`,
      );
    }
  }

  const args: string[] = [...GIT_SSRF_FLAGS, 'clone', ...GIT_SSRF_SUBCOMMAND_FLAGS];
  if (opts.depth !== 0) {
    args.push(`--depth=${opts.depth ?? 1}`);
  }
  if (opts.branch) {
    args.push('--branch', opts.branch);
  }
  args.push(url, destDir);

  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 600_000,
      env: gitChildEnv({ ...GIT_ENV }),
    });
  } catch (e) {
    throw new GitOperationError(
      'clone',
      `git clone failed for ${url}: ${gitErrorDetail(e)}`,
      e,
    );
  }
}

/**
 * Pull a repo with --ff-only and the same SSRF-defensive flags as cloneRepo.
 * #3836: global flags build via durableSsrfFlags() so the documented
 * GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 escape hatch reaches sync's pull —
 * self-hosted local-filesystem remotes could clone but never pull. Default
 * stays `never`; the origin was already validated at clone time.
 *
 * Runs asynchronously so the caller's event loop stays live while git waits
 * on the remote: --timeout timers, signal handlers and job-lease renewals keep
 * firing. The child is stopped when `opts.signal` aborts or after
 * `opts.timeoutMs` (default 5 min); `isStoppedGitPull` recognizes the error
 * that produces, so callers can tell "we stopped it" from "git failed".
 */
export async function pullRepo(repoPath: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  assertManagedFilesystemWrite(repoPath);
  const fail = (reason: string, error: unknown): never => {
    throw new GitOperationError('pull', `git pull failed in ${repoPath}: ${reason}`, error);
  };
  // #6530: fetch outside the writer lock, then fast-forward under it with
  // autostash off, so a shared checkout is never stashed or moved mid-commit.
  const fetch = await execFileBounded('git', ['-C', repoPath, ...durableSsrfFlags(), 'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS], {
    timeout: opts.timeoutMs ?? 300_000,
    env: gitChildEnv({ ...GIT_ENV }),
    signal: opts.signal,
  });
  // execFile hands stderr back beside the error rather than on it, so lead
  // with it here to keep the #1315 stderr-first message.
  if (fetch.error) fail(fetch.stderr.trim() || fetch.error.message, fetch.error);
  let lock: { release(): Promise<void> };
  try {
    lock = await acquireCommitLockAsync(repoPath, undefined, opts.signal);
  } catch (e) {
    return fail((e as Error).message, opts.signal?.aborted ? Object.assign(new Error('pull stopped'), { code: 'ABORT_ERR' }) : e);
  }
  try {
    const merge = await execFileBounded('git', ['-C', repoPath, '-c', 'core.hooksPath=/dev/null', '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', '@{upstream}'], {
      timeout: opts.timeoutMs ?? 300_000,
      env: gitChildEnv({ ...GIT_ENV }),
      signal: opts.signal,
    });
    if (merge.error) fail(merge.stderr.trim() || merge.error.message, merge.error);
  } finally {
    await lock.release();
  }
}

/**
 * Whether a `pullRepo` rejection means the pull was stopped (its deadline
 * passed, its signal aborted, or something outside sent git SIGTERM) rather
 * than git reporting a failure. GitOperationError keeps the subprocess error
 * as `cause`, so the stop markers are read there: `code` ETIMEDOUT/ABORT_ERR
 * or `signal` SIGTERM.
 */
export function isStoppedGitPull(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== 'object') return false;
  const { code, signal } = cause as { code?: unknown; signal?: unknown };
  return code === 'ETIMEDOUT' || code === 'ABORT_ERR' || signal === 'SIGTERM';
}

/**
 * Fetch a single remote branch with the SAME SSRF-defensive flags + no-prompt
 * env as cloneRepo/pullRepo (GIT_SSRF_FLAGS, --no-recurse-submodules,
 * GIT_TERMINAL_PROMPT=0). Used by the sync cost-estimator's fetch-first path
 * (#2139) so a cost preview / dry-run never hits a remote through a
 * less-protected route than real sync. Throws GitOperationError on failure;
 * the estimator catches and falls back to local HEAD.
 */
export function fetchRemote(repoPath: string, branch: string, opts: { timeoutMs?: number } = {}): void {
  // #3836: durableSsrfFlags (not the hardcoded GIT_SSRF_FLAGS) so the
  // file-transport escape hatch applies to the estimator's fetch too.
  const args: string[] = ['-C', repoPath, ...durableSsrfFlags(), 'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 30_000,
      env: gitChildEnv({ ...GIT_ENV }),
    });
  } catch (e) {
    throw new GitOperationError(
      'fetch',
      `git fetch failed in ${repoPath}: ${gitErrorDetail(e)}`,
      e,
    );
  }
}

export type RepoState =
  | 'healthy'
  | 'missing'
  | 'not-a-dir'
  | 'no-git'
  | 'url-drift'
  | 'corrupted';

/**
 * Classify the on-disk state of a clone. Used by performSync to decide
 * whether to run pull (healthy), re-clone (missing/no-git/not-a-dir),
 * refuse with corruption error (corrupted), or refuse with rebase-clone
 * hint (url-drift).
 */
export function validateRepoState(
  repoPath: string,
  expectedRemoteUrl?: string,
): RepoState {
  let stat;
  try {
    stat = lstatSync(repoPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    return 'not-a-dir';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  if (!existsSync(join(repoPath, '.git'))) return 'no-git';

  let remoteUrl: string;
  try {
    const out = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: gitChildEnv({ ...GIT_ENV }),
    });
    remoteUrl = out.toString().trim();
  } catch {
    // #4559 (reported by @matteborje): a local-only source has no `origin`
    // by design — `git remote get-url origin` exiting non-zero is only
    // corruption when a remote was actually expected (a managed clone
    // missing its origin). With no expectedRemoteUrl, classify on real
    // repository integrity instead so a healthy no-remote repo doesn't
    // read clone_state=corrupted forever.
    if (expectedRemoteUrl === undefined) {
      try {
        execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
          env: gitChildEnv({ ...GIT_ENV }),
        });
        return 'healthy';
      } catch {
        return 'corrupted';
      }
    }
    return 'corrupted';
  }

  if (expectedRemoteUrl !== undefined && remoteUrl !== expectedRemoteUrl) {
    return 'url-drift';
  }
  return 'healthy';
}

/**
 * True if `path` is itself a git repo OR a subdirectory of one, per
 * `git rev-parse --show-toplevel`. Mirrors the walk-up discovery
 * `sync.ts:discoverGitRoot` performs at sync time (#753/#774 — subdir-of-git
 * sources are valid), so a directory that passes this check is guaranteed
 * not to hit sync's "Not inside a git repository" error later. Used by
 * `addSource` (#2707) to validate `--path` at registration time instead of
 * deferring the failure to the first sync.
 */
export function isInsideGitRepo(path: string): boolean {
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: gitChildEnv({ ...GIT_ENV }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The empty-tree object ID for `path`'s repo, derived (not hardcoded) so
 * this works for both the default SHA-1 object format and the opt-in
 * `--object-format=sha256` one (git 2.29+) — each has its own empty-tree
 * OID. `git hash-object -t tree --stdin < /dev/null` computes the hash of
 * a zero-entry tree using whatever hash algorithm `path`'s repo is
 * configured for, without needing to know which one that is. #2707 codex
 * round 4 (P2): an earlier version hardcoded the well-known SHA-1 constant
 * (`4b825dc6...`), which silently mismatched — and so let an empty
 * SHA-256 repo through — on a SHA-256 repo's real (different) empty-tree
 * OID.
 */
function emptyTreeOid(path: string): string {
  return execFileSync('git', ['-C', path, 'hash-object', '-t', 'tree', '--stdin'], {
    input: '',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    env: gitChildEnv({ ...GIT_ENV }),
  }).toString().trim();
}

/**
 * True if `path`'s HEAD tree has at least one tracked entry scoped to
 * `path` itself. `-C path` + the `HEAD:./` revision syntax resolves the
 * tree object for `path` specifically (not the whole repo root), so this
 * is correct for both a repo's toplevel AND a subdirectory-of-a-repo
 * source — then a single OID comparison against that repo's empty-tree
 * object (see `emptyTreeOid`) tells us whether that tree is empty. #2707
 * codex round 3 (P2): unlike listing (`ls-tree`), this is O(1) output — no
 * `maxBuffer` exposure on a repo with a very large number of entries.
 *
 * Subsumes "no commits at all" (`HEAD:./` on an unborn repo fails to
 * resolve — there's no HEAD) AND "has a HEAD commit but it's empty"
 * (#2707 codex round 2): `git commit --allow-empty` followed by creating
 * untracked files resolves `HEAD:./` successfully (to the empty-tree OID)
 * but that tree has zero entries — a directory that would pass a bare
 * `rev-parse HEAD` check yet still can't sync (or worse, "succeeds"
 * importing nothing and then never notices the untracked files change —
 * the silent-staleness class #2707 exists to prevent). A directory
 * that's `git init`ed but never committed, or where this specific path
 * was never `git add`ed, fails this check either way.
 */
export function hasTrackedContent(path: string): boolean {
  try {
    const out = execFileSync('git', ['-C', path, 'rev-parse', '--verify', 'HEAD:./'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: gitChildEnv({ ...GIT_ENV }),
    });
    return out.toString().trim() !== emptyTreeOid(path);
  } catch {
    return false;
  }
}

// ── Durability helpers (v0.42.44) ───────────────────────────────────────────
// Used by the brain-repo durability feature (`gbrain sources harden/pull`) and
// the DB-free pull cron. These are the auth-capable, rebase-aware counterparts
// to the strict read-only `pullRepo` (which stays `--ff-only` for `sync.ts`).

/** Run a git subcommand, returning trimmed stdout. Throws GitOperationError. */
function runGit(
  repoPath: string,
  globalFlags: readonly string[],
  subcommand: string,
  subArgs: readonly string[],
  op: GitOperationError['op'],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): string {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, ...globalFlags, subcommand, ...subArgs],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 120_000,
        env: gitChildEnv({ ...(opts.env ?? GIT_ENV) }),
      },
    );
    return out.toString().trim();
  } catch (e) {
    throw new GitOperationError(op, `git ${subcommand} failed in ${repoPath}: ${gitErrorDetail(e)}`, e);
  }
}

/** True if the working tree has staged or unstaged changes (untracked too). */
export function isWorkingTreeDirty(repoPath: string): boolean {
  const out = runGit(repoPath, [], 'status', ['--porcelain'], 'pull', { timeoutMs: 30_000 });
  return out.length > 0;
}

/**
 * Resolve the repo's default branch, local-only (no network):
 *   origin/HEAD symbolic-ref → current branch (if not detached) → 'main'.
 */
export function detectDefaultBranch(repoPath: string): string {
  try {
    const sym = execFileSync('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
    if (sym.startsWith('origin/')) return sym.slice('origin/'.length);
    if (sym) return sym;
  } catch { /* origin/HEAD not set — fall through */ }
  try {
    const cur = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
    if (cur && cur !== 'HEAD') return cur;
  } catch { /* detached or no commits */ }
  return 'main';
}

/** True if the git-dir entry `name` (a state file or directory) exists; false when git cannot be asked. */
function gitStateExists(repoPath: string, name: string): boolean {
  try {
    const p = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', name], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv({ ...GIT_ENV }),
    }).toString().trim();
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `p` is git's own answer to `rev-parse --git-path <literal>` for the checkout at repoPath (MERGE_HEAD, rebase-merge, rebase-apply); no caller passes user input, and the result is only tested for existence.
    return existsSync(isAbsolute(p) ? p : join(repoPath, p));
  } catch { return false; }
}

/** True if a rebase is mid-flight (rebase-merge or rebase-apply state dir exists). */
function rebaseInProgress(repoPath: string): boolean {
  return ['rebase-merge', 'rebase-apply'].some(name => gitStateExists(repoPath, name));
}

export type PullOutcome =
  | { status: 'up_to_date' }
  | { status: 'advanced'; from: string; to: string }
  | { status: 'skipped_dirty' }
  | { status: 'skipped_busy' }
  | { status: 'conflict_aborted'; detail: string };

/** How `divergenceSafePull` reconciles local commits with origin (#5429): `sources.config.pull_strategy`, default `rebase`. */
export const PULL_STRATEGIES = ['rebase', 'merge'] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];
export function isPullStrategy(value: unknown): value is PullStrategy {
  return typeof value === 'string' && (PULL_STRATEGIES as readonly string[]).includes(value);
}
/** The strategy a source's parsed `config` records; anything else is the default. */
export function pullStrategyOf(config: Record<string, unknown> | null | undefined): PullStrategy {
  return isPullStrategy(config?.pull_strategy) ? config.pull_strategy : 'rebase';
}

/**
 * Divergence-safe pull for a checkout other writers share (#6530). Delegates
 * to `pullShared` (src/core/git/commit-push.ts): fetch outside the writer
 * lock, then under `brain-commit.lock` fast-forward, or merge diverged history
 * IN MEMORY and fast-forward to the merge. Nothing rebases, stashes or resets
 * the working tree, and no rebase or merge state can be left behind.
 *
 *  - Any local edit → `skipped_dirty` (the unattended rule: never move files
 *    under a writer mid-edit), checked before and again under the lock.
 *  - Another writer holds the lock → `skipped_busy`; the next run catches up.
 *  - Both sides changed a file → `conflict_aborted`; nothing changed.
 *
 * `strategy` is kept for callers and `sources set-pull-strategy`; since #6530
 * both strategies integrate by merge (the shared tree is never rebased).
 * Auth-capable and SSRF-hardened through the same transport flags as before.
 */
export function divergenceSafePull(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; strategy?: PullStrategy } = {},
): PullOutcome {
  assertManagedFilesystemWrite(repoPath);
  try {
    const r = pullShared(repoPath, { requireClean: true, remoteBranch: branch, fetchTimeoutMs: opts.timeoutMs ?? 300_000 });
    if (r.status === 'advanced') return { status: 'advanced', from: r.from!, to: r.to! };
    if (r.status === 'skipped_dirty' || r.status === 'lagging') return { status: 'skipped_dirty' };
    return { status: 'up_to_date' };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'commit_lock_busy') return { status: 'skipped_busy' };
    if (code === 'integrate_conflict' || code === 'git_operation_in_progress' || code === 'git_detached_head') {
      return { status: 'conflict_aborted', detail: `pull on ${branch} conflicted and was not applied: ${(e as Error).message} — manual attention needed` };
    }
    throw new GitOperationError('pull', `git pull failed in ${repoPath}: ${(e as Error).message}${(e as { suggestion?: string }).suggestion ? ` ${(e as { suggestion?: string }).suggestion}` : ''}`, e);
  }
}

export type PushProbeResult =
  | { ok: true }
  | { ok: false; reason: 'auth' | 'protected' | 'unreachable' | 'other'; detail: string };

/**
 * Authenticated `git push --dry-run` against origin/<branch>. Proves push auth
 * works AND surfaces read-only PATs / branch protection BEFORE harden declares
 * "hardened" — with zero history pollution (no commit). Auth-capable env.
 *
 * `redactDetail` (e.g. shell-redact's value scrubber bound to the PAT) is
 * applied to the captured stderr so a token echoed by git never reaches a log.
 */
export function pushProbe(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number; redactDetail?: (s: string) => string } = {},
): PushProbeResult {
  const redact = opts.redactDetail ?? ((s: string) => s);
  try {
    execFileSync(
      'git',
      ['-C', repoPath, ...durableSsrfFlags(), 'push', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--dry-run', 'origin', `HEAD:${branch}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000, env: gitChildEnv({ ...GIT_ENV_AUTH }) },
    );
    return { ok: true };
  } catch (e) {
    const raw = redact((e as Error).message || '');
    const low = raw.toLowerCase();
    let reason: 'auth' | 'protected' | 'unreachable' | 'other' = 'other';
    if (low.includes('authentication') || low.includes('403') || low.includes('permission') || low.includes('could not read')) reason = 'auth';
    else if (low.includes('protected') || low.includes('pre-receive') || low.includes('hook declined')) reason = 'protected';
    else if (low.includes('could not resolve') || low.includes('unable to access') || low.includes('timed out') || low.includes('network')) reason = 'unreachable';
    return { ok: false, reason, detail: raw.slice(0, 200) };
  }
}
