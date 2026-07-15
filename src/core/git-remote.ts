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
import { execFileSync } from 'child_process';
import { lstatSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { isInternalUrl } from './url-safety.ts';

/**
 * Git CLI accepts two flag positions:
 *   git [global -c flags] <subcommand> [subcommand flags] [args]
 *
 * Global flags (the `-c key=value` config overrides) MUST come before the
 * subcommand. Subcommand-specific flags (like `--no-recurse-submodules`)
 * MUST come after the subcommand. Mixing the two positions makes git fail
 * with `unknown option` (exit 129). Pre-v0.34 the single GIT_SSRF_FLAGS
 * constant spliced both positions before the verb; real git rejected the
 * subcommand flag but the test harness used a fake-git script that didn't
 * validate, so every remote-source clone/pull broke silently in production.
 *
 * Split into two constants so the call-site spread is unambiguous and the
 * type/name signal the position rule.
 */

/**
 * Global git config flags. Spread BEFORE the subcommand verb.
 * - http.followRedirects=false: closes DNS rebinding via redirect chains
 * - protocol.file.allow=never: no local-file URLs (defense in depth)
 * - protocol.ext.allow=never: no external helpers (`git-remote-foo`)
 */
export const GIT_SSRF_FLAGS = [
  '-c', 'http.followRedirects=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
] as const;

/**
 * Subcommand-level flags. Spread AFTER the subcommand verb (clone/pull).
 * - --no-recurse-submodules: .gitmodules cannot become a second fetch surface
 */
export const GIT_SSRF_SUBCOMMAND_FLAGS = [
  '--no-recurse-submodules',
] as const;

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

export const GIT_ENV = {
  // Confine to the gbrain SSRF model — no credential helpers, no SSH askpass,
  // no GUI prompts. Inherit PATH so git itself is findable.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
} as const;

/**
 * Auth-capable git env for the durability push/probe paths (v0.42.44).
 *
 * Read-only clone/pull keep the strict GIT_ENV (askpass=/bin/false) so they can
 * never prompt. But push, push-probe, and the durability cron's authed fetch
 * MUST be able to consult the repo's configured credential helper (repo-scoped
 * `store`/`osxkeychain`) — a `/bin/false` askpass would defeat that. We drop the
 * askpass overrides but KEEP `GIT_TERMINAL_PROMPT=0` so a *missing* credential
 * fails fast instead of hanging a non-interactive cron forever.
 */
export const GIT_ENV_AUTH = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
} as const;

/**
 * Clone a remote git repo with SSRF-defensive flags.
 * - destDir must NOT exist or must be empty.
 * - Default --depth=1 (no history); pass {depth: 0} for full clone.
 * - Throws GitOperationError on failure; caller is responsible for cleanup.
 */
export function cloneRepo(url: string, destDir: string, opts: CloneOpts = {}): void {
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
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'clone',
      `git clone failed for ${url}: ${(e as Error).message}`,
      e,
    );
  }
}

/** Pull a repo with --ff-only and the same SSRF-defensive flags as cloneRepo. */
export function pullRepo(repoPath: string, opts: { timeoutMs?: number } = {}): void {
  const args: string[] = ['-C', repoPath, ...GIT_SSRF_FLAGS, 'pull', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--ff-only'];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 300_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'pull',
      `git pull failed in ${repoPath}: ${(e as Error).message}`,
      e,
    );
  }
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
  const args: string[] = ['-C', repoPath, ...GIT_SSRF_FLAGS, 'fetch', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch];
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 30_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'fetch',
      `git fetch failed in ${repoPath}: ${(e as Error).message}`,
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
      env: { ...process.env, ...GIT_ENV },
    });
    remoteUrl = out.toString().trim();
  } catch {
    return 'corrupted';
  }

  if (expectedRemoteUrl !== undefined && remoteUrl !== expectedRemoteUrl) {
    return 'url-drift';
  }
  return 'healthy';
}

// ── Durability helpers (v0.42.44) ───────────────────────────────────────────
// Used by the brain-repo durability feature (`gbrain sources harden/pull`) and
// the DB-free pull cron. These are the auth-capable, rebase-aware counterparts
// to the strict read-only `pullRepo` (which stays `--ff-only` for `sync.ts`).

/**
 * Global SSRF flags for the durability fetch/pull/push paths. Identical to
 * GIT_SSRF_FLAGS except `protocol.file.allow` honors the env escape hatch
 * `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1` (mirrors GBRAIN_ALLOW_PRIVATE_REMOTES) so
 * self-hosted local-filesystem remotes — and the test suite — can use the file
 * transport. Default stays `never`. These ops act on an ALREADY-validated origin
 * (set + checked at clone time); `http.followRedirects=false` is the live guard.
 */
function durableSsrfFlags(): string[] {
  const fileAllow = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never';
  return [
    '-c', 'http.followRedirects=false',
    '-c', `protocol.file.allow=${fileAllow}`,
    '-c', 'protocol.ext.allow=never',
  ];
}

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
        env: { ...process.env, ...(opts.env ?? GIT_ENV) },
      },
    );
    return out.toString().trim();
  } catch (e) {
    throw new GitOperationError(op, `git ${subcommand} failed in ${repoPath}: ${(e as Error).message}`, e);
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
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    if (sym.startsWith('origin/')) return sym.slice('origin/'.length);
    if (sym) return sym;
  } catch { /* origin/HEAD not set — fall through */ }
  try {
    const cur = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
    }).toString().trim();
    if (cur && cur !== 'HEAD') return cur;
  } catch { /* detached or no commits */ }
  return 'main';
}

/** True if a rebase is mid-flight (rebase-merge or rebase-apply state dir exists). */
function rebaseInProgress(repoPath: string): boolean {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', name], {
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, ...GIT_ENV },
      }).toString().trim();
      const abs = p.startsWith('/') ? p : join(repoPath, p);
      if (existsSync(abs)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export type PullOutcome =
  | { status: 'up_to_date' }
  | { status: 'advanced'; from: string; to: string }
  | { status: 'skipped_dirty' }
  | { status: 'conflict_aborted'; detail: string };

/**
 * Divergence-safe pull: `fetch` + `pull --rebase`, never leaving a mid-rebase.
 *
 *  - Dirty working tree  → `skipped_dirty` (NORMAL mid-session state, not an
 *    error; never auto-stashes, never touches in-progress edits).
 *  - Rebase conflict     → `git rebase --abort`, verify no rebase state remains,
 *    return `conflict_aborted` ("manual attention needed"). Never throws past
 *    this — the repo is always left clean (possibly un-advanced).
 *
 * Auth-capable (GIT_ENV_AUTH) so it works against private remotes via the
 * repo's configured credential helper. SSRF flags applied on every call.
 */
export function divergenceSafePull(
  repoPath: string,
  branch: string,
  opts: { timeoutMs?: number } = {},
): PullOutcome {
  const timeoutMs = opts.timeoutMs ?? 300_000;

  if (isWorkingTreeDirty(repoPath)) return { status: 'skipped_dirty' };

  const before = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  const ssrf = durableSsrfFlags();

  runGit(repoPath, ssrf, 'fetch', [...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', branch], 'pull', {
    timeoutMs, env: { ...GIT_ENV_AUTH },
  });

  try {
    runGit(repoPath, ssrf, 'pull', [...GIT_SSRF_SUBCOMMAND_FLAGS, '--rebase', 'origin', branch], 'pull', {
      timeoutMs, env: { ...GIT_ENV_AUTH },
    });
  } catch (e) {
    // Abort any half-applied rebase so the tree is never left mid-rebase.
    try {
      execFileSync('git', ['-C', repoPath, 'rebase', '--abort'], {
        stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV },
      });
    } catch { /* best-effort */ }
    // If state STILL remains, try once more, then report regardless.
    if (rebaseInProgress(repoPath)) {
      try {
        execFileSync('git', ['-C', repoPath, 'rebase', '--abort'], {
          stdio: 'ignore', timeout: 30_000, env: { ...process.env, ...GIT_ENV },
        });
      } catch { /* best-effort */ }
    }
    return {
      status: 'conflict_aborted',
      detail: `pull --rebase on ${branch} conflicted; rebase aborted — manual attention needed (${(e as Error).message.slice(0, 120)})`,
    };
  }

  const after = runGit(repoPath, [], 'rev-parse', ['HEAD'], 'pull', { timeoutMs: 10_000 });
  return before === after ? { status: 'up_to_date' } : { status: 'advanced', from: before, to: after };
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
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000, env: { ...process.env, ...GIT_ENV_AUTH } },
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
