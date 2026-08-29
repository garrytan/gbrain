/**
 * workspace-push.ts — the `gbrain sources push` core: scan-gated
 * add → commit → pull → push for an agent-workspace repo
 * (agent-bootstrap plan: D6, G6, G8, G14/A5, B4, CX2-3, CX2-6, CX2-7, S3#2).
 *
 * The WHOLE sequence runs under ONE cross-platform lock [G14/A5, CX2-6]:
 * an atomic-mkdir lock dir at `<gbrainHome>/locks/push-<hash>.lock` with an
 * owner file ({pid, acquired_at, token}). flock(1) is NOT a dependency
 * (absent on macOS, the v1 target). Steal policy applies the pid-reuse
 * learning (pglite-lock #2058/#2348): a holder is stolen ONLY when its pid
 * is affirmatively dead AND the lock is older than the stale window — BOTH
 * conditions. A second concurrent caller gets a clean `skipped_in_flight`
 * (exit 0 at the CLI), never an error.
 *
 * Sequence (each step gates the next):
 *   1. resolve the repo ROOT via `git rev-parse --show-toplevel` [CX2-3] —
 *      a workspace layout registers `repo/brain` as the source dir while the
 *      enclosing repo owns `.git`; push always operates on the root.
 *   2. deny-glob backstop [G6]: a TRACKED file matching the deny list
 *      (`*.pglite`, `.env*`, `*.pem`, `*.key`, `.gbrain/**`) HARD-FAILS the
 *      push regardless of .gitignore state (a truncated .gitignore can't
 *      leak). Untracked deny matches — INCLUDING gitignored ones — are
 *      excluded from staging, loudly.
 *   3. `git add -A` FIRST, then un-stage any staged deny match. Repo-local
 *      git identity (`gbrain-bootstrap` / `bootstrap@localhost`) is set ONLY
 *      when none exists, so a commit can never fail on a fresh machine.
 *   4. secret scan (src/core/secret-scan.ts) over the STAGED blobs
 *      (`git cat-file -p :<path>`, size-capped, binary-skipped) so scanned
 *      bytes == committed bytes — no scan→stage TOCTOU window. Findings
 *      block the commit (index restored to HEAD, disk untouched) and name
 *      file+pattern; per-finding override via `<ws>/.gbrain-scan-allow`.
 *   5. commit (skipped when clean).
 *   6. COMMIT FIRST, then `divergenceSafePull` [CX2-7] — pulling before
 *      committing returns `skipped_dirty` and strands local work.
 *   7. push — even on a clean tree: a prior failed run may have left local
 *      ahead of origin.
 *   8. write `<gbrainHome>/bootstrap/push-status.json` {ts, ok, reason?,
 *      ahead?} on success AND failure [B4] (doctor + SessionStart digest
 *      read it).
 *
 * Remote-privacy gate [G8]: refuses a remote that is not VERIFIABLY private.
 * Verification routes through the repo-visibility LADDER (repo-visibility.ts):
 * REST first (`gh api repos/...` — never GraphQL, which cloud proxies pin),
 * then pure git protocol (authed ls-remote + attributed anonymous probe), so
 * the gate keeps working where gh is broken/blocked. Unverifiable visibility
 * is a refusal with the per-rung reason, never fail-open. Escape hatches for
 * self-hosted git you trust, loudly logged, most-portable last: CLI
 * `allowUnverifiedRemote` > env GBRAIN_ALLOW_UNVERIFIED_REMOTE=1 > file-plane
 * config `push.allow_unverified_remote` (readable by detached hook children
 * that can never see a shell export or the DB plane).
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { GIT_ENV, GIT_ENV_AUTH, GIT_SSRF_SUBCOMMAND_FLAGS, detectDefaultBranch, divergenceSafePull } from './git-remote.ts';
import { loadConfigFileOnly } from './config.ts';
import { ensureGbrainHome } from './gbrain-home.ts';
import { invalidateBackupStatus, loadBackupStatus } from './backup/status-file.ts';
import {
  githubOwnerRepoString,
  readCachedPrivateVerdict,
  verifyRepoVisibility,
  writeVisibilityCache,
} from './repo-visibility.ts';
import { isProcessAlive } from './pglite-lock.ts';
import {
  loadWorkspaceAllowlist, matchesGlob, pathAllowlisted, scanText,
  SCAN_ALLOW_FILENAME, SCAN_MAX_FILE_BYTES,
  type SecretFinding,
} from './secret-scan.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export type WorkspacePushStatus =
  | 'pushed'                // local HEAD reached origin (with or without a new commit)
  | 'skipped_in_flight'     // another push holds the lock — clean skip [G14/A5]
  | 'blocked_tracked_deny'  // a TRACKED file matches the deny globs [G6]
  | 'blocked_secrets'       // unallowlisted secret-scan findings [D6]
  | 'blocked_unscannable'   // a staged blob could not be scanned — fail CLOSED
  | 'refused_visibility'    // remote not verifiably private [G8]
  | 'pull_conflict'         // divergenceSafePull aborted a conflicted rebase
  | 'push_failed'           // push rejected / origin unreachable
  | 'error';                // not a git repo / no origin / unexpected failure

export interface WorkspacePushResult {
  ok: boolean;
  status: WorkspacePushStatus;
  reason?: string;
  repoRoot?: string;
  branch?: string;
  /** True when this run created a new commit. */
  committed?: boolean;
  /** Commits local is ahead of origin/<branch> after the run (0 on success). */
  ahead?: number;
  lockHolderPid?: number | null;
  /** Tracked paths that hard-failed the deny-glob backstop. */
  denyMatches?: string[];
  /** Untracked deny-glob matches excluded from staging (kept on disk). */
  excludedUntracked?: string[];
  findings?: SecretFinding[];
  /** Staged paths the secret scan could not read (fail-closed block reason). */
  unscannable?: string[];
}

export interface WorkspacePushOpts {
  /** Any directory inside the repo; the root is resolved via rev-parse [CX2-3]. */
  dir: string;
  /** Branch to pull/push; default `detectDefaultBranch(root)`. */
  branch?: string;
  /** Escape hatch for self-hosted git: skip the gh privacy verification [G8]. Logged. */
  allowUnverifiedRemote?: boolean;
  commitMessage?: string;
  logger?: (line: string) => void;
  /**
   * TEST SEAM: hold the lock for N ms after acquisition, before any git work.
   * Lets a concurrency test make "N callers, 1 winner" deterministic.
   */
  holdLockMs?: number;
}

/** Deny-glob backstop list [G6]. Matched with secret-scan's glob dialect. */
export const PUSH_DENY_GLOBS: readonly string[] = [
  '*.pglite', '.env*', '*.pem', '*.key', '.gbrain/**',
];

/** Files larger than this are neither scanned nor considered text candidates. */
export const PUSH_MAX_SCAN_BYTES = SCAN_MAX_FILE_BYTES;

// ── Cross-platform push lock [CX2-6, G14/A5] ────────────────────────────────

/** A holder is stolen only when pid is DEAD **and** the lock is older than this. */
export const PUSH_LOCK_STALE_MS = 120_000;

interface LockOwner {
  pid: number;
  acquired_at: string; // ISO
  token: string;
}

export interface PushLockHandle {
  dir: string;
  token: string;
  release(): void;
}

export type PushLockResult =
  | { acquired: true; handle: PushLockHandle }
  | { acquired: false; holderPid: number | null };

export function pushLockDir(repoRoot: string): string {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return join(ensureGbrainHome(), 'locks', `push-${hash}.lock`);
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
    if (typeof raw?.pid === 'number' && typeof raw?.acquired_at === 'string' && typeof raw?.token === 'string') {
      return raw as LockOwner;
    }
    return null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockDir: string, owner: LockOwner | null): number {
  if (owner) {
    const t = Date.parse(owner.acquired_at);
    if (Number.isFinite(t)) return Date.now() - t;
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return 0; // can't tell → treat as fresh (never steal on uncertainty)
  }
}

function tryMkdirLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir); // atomic on POSIX — the lock primitive [CX2-6]
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the per-repo push lock. Never blocks: returns `{acquired: false}`
 * with the live holder's pid when contended. Steals ONLY dead-pid AND
 * stale-age holders (both — the pid-reuse learning); a live pid is never
 * stolen regardless of age, and a young lock is never stolen regardless of
 * pid state (a concurrent acquirer may not have written owner.json yet).
 */
export function acquirePushLock(repoRoot: string): PushLockResult {
  const lockDir = pushLockDir(repoRoot);
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });

  const writeOwnerAndHandle = (): PushLockResult => {
    const owner: LockOwner = {
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      token: randomBytes(16).toString('hex'),
    };
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    return {
      acquired: true,
      handle: {
        dir: lockDir,
        token: owner.token,
        release: () => releasePushLock(lockDir, owner.token),
      },
    };
  };

  if (tryMkdirLock(lockDir)) return writeOwnerAndHandle();

  const owner = readLockOwner(lockDir);
  const alive = owner ? isProcessAlive(owner.pid) : false; // no owner file → can't prove alive
  const age = lockAgeMs(lockDir, owner);
  if (!alive && age > PUSH_LOCK_STALE_MS) {
    // Dead AND stale → steal: remove, then re-race the mkdir exactly once.
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch { /* raced with another stealer */ }
    if (tryMkdirLock(lockDir)) return writeOwnerAndHandle();
    return { acquired: false, holderPid: readLockOwner(lockDir)?.pid ?? null };
  }
  return { acquired: false, holderPid: owner?.pid ?? null };
}

/** Ownership-checked release: only removes the lock if OUR token still owns it. */
function releasePushLock(lockDir: string, token: string): void {
  try {
    const owner = readLockOwner(lockDir);
    if (owner && owner.token !== token) return; // stolen + re-acquired — not ours
    rmSync(lockDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ── git helpers ─────────────────────────────────────────────────────────────

function git(
  root: string,
  args: string[],
  opts: { timeoutMs?: number; auth?: boolean } = {},
): string {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.auth ? GIT_ENV_AUTH : GIT_ENV) },
  }).toString();
}

function tryGit(root: string, args: string[], opts: { timeoutMs?: number; auth?: boolean } = {}): string | null {
  try {
    return git(root, args, opts).trim();
  } catch {
    return null;
  }
}

/** Raw-bytes git output (no encoding) — for reading staged blobs verbatim. */
function gitBuffer(root: string, args: string[], timeoutMs = 60_000): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...GIT_ENV },
  });
}

/**
 * Mirror of git-remote.ts's private `durableSsrfFlags()`: push acts on an
 * ALREADY-configured origin; the file transport honors the same env escape
 * hatch (`GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1`) the durability paths and the
 * test suite use. Default stays `never`.
 */
function pushSsrfFlags(): string[] {
  const fileAllow = process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never';
  return [
    '-c', 'http.followRedirects=false',
    '-c', `protocol.file.allow=${fileAllow}`,
    '-c', 'protocol.ext.allow=never',
  ];
}

/** Resolve the repo ROOT for any dir inside it [CX2-3]; null when not a repo. */
export function resolveWorkspaceRoot(dir: string): string | null {
  return tryGit(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 });
}

function listZ(root: string, args: string[]): string[] {
  const out = git(root, [...args, '-z']);
  return out.split('\0').filter((s) => s.length > 0);
}

/**
 * Ensure SOME git identity exists so the commit can't fail on a fresh
 * machine. Never overrides an existing name/email (any config scope).
 */
function ensureLocalIdentity(root: string): void {
  if (tryGit(root, ['config', '--get', 'user.email']) === null) {
    git(root, ['config', 'user.email', 'bootstrap@localhost']);
  }
  if (tryGit(root, ['config', '--get', 'user.name']) === null) {
    git(root, ['config', 'user.name', 'gbrain-bootstrap']);
  }
}

// ── Remote-privacy verification [G8] ────────────────────────────────────────

export type RemotePrivacyVerdict =
  | { verdict: 'private' }
  | { verdict: 'not_private'; detail: string }
  | { verdict: 'unverifiable'; detail: string };

/** Parse `owner/repo` out of a github.com remote URL (https, scp-like, or
 * ssh://). Back-compat adapter over the canonical repo-visibility parser. */
export function parseGithubOwnerRepo(url: string): string | null {
  return githubOwnerRepoString(url);
}

/**
 * Verify the origin remote is a PRIVATE repo via the repo-visibility ladder
 * (REST first, git-protocol fallback — see repo-visibility.ts for the full
 * verdict matrix). Anything short of a proven `private` is either
 * `not_private` (proven public) or `unverifiable` — the caller refuses both
 * unless an escape hatch is set [G8: never fail-open]. Fresh `private`
 * verdicts are cached (1h TTL, private-only) so the per-turn push cadence
 * doesn't re-pay the network probes every turn [D11].
 */
export async function verifyRemotePrivacy(root: string): Promise<RemotePrivacyVerdict> {
  const url = tryGit(root, ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 });
  if (!url) return { verdict: 'unverifiable', detail: 'no origin remote configured' };
  if (readCachedPrivateVerdict(url) !== null) return { verdict: 'private' };
  const v = await verifyRepoVisibility({ originUrl: url, repoDir: root });
  writeVisibilityCache(url, v);
  if (v.verdict === 'private') return { verdict: 'private' };
  if (v.verdict === 'public') return { verdict: 'not_private', detail: v.detail };
  return { verdict: 'unverifiable', detail: v.detail };
}

/** File-plane escape hatch [D18]: `gbrain config set push.allow_unverified_remote true`.
 * Read tolerantly from ~/.gbrain/config.json — detached hook children never see
 * a shell export, and the DB plane is unreadable while a serve holds the
 * single-writer lock, so the file plane is the only channel that always works. */
export function configAllowsUnverifiedRemote(): boolean {
  try {
    const cfg = loadConfigFileOnly();
    const v = cfg?.push?.allow_unverified_remote as unknown;
    return v === true || v === 'true' || v === '1';
  } catch {
    return false;
  }
}

// ── push-status.json [B4] ───────────────────────────────────────────────────

/** Legacy single-file location (pre-per-root). Read-only compatibility: the
 * reader consults it only when NO per-root files exist yet (fresh upgrade). */
export function pushStatusPath(): string {
  return join(ensureGbrainHome(), 'bootstrap', 'push-status.json');
}

/** Stable short key for per-root state files [D3/D13]: one gbrain home serves
 * many bootstrap workspaces, so every push/debounce/announce state file is
 * keyed by workspace root — a single shared file is last-writer-wins, which
 * either masks one workspace's failure or defeats another's debounce. */
export function workspaceRootHash(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

export function pushStatusPathForRoot(root: string): string {
  return join(ensureGbrainHome(), 'bootstrap', `push-status-${workspaceRootHash(root)}.json`);
}

/** One parsed push-status record [D8: one reader, three formatters]. */
export interface PushStatusEntry {
  ts?: string;
  ok?: boolean;
  reason?: string;
  ahead?: number;
  repoRoot?: string;
  /** Absolute path of the status file (per-root announce-state keying). */
  file: string;
}

const PUSH_STATUS_FILE_RE = /^push-status-[0-9a-f]{12}\.json$/;

/** Tolerant reader over every push-status file (banner, SessionStart note,
 * and doctor all consume THIS — one parse, one schema owner). Per-root files
 * win; the legacy global file is consulted only when none exist, so a stale
 * pre-upgrade record can't shadow live per-root state. */
export function readPushStatuses(): PushStatusEntry[] {
  const dir = join(ensureGbrainHome(), 'bootstrap');
  const parse = (file: string): PushStatusEntry | null => {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Omit<PushStatusEntry, 'file'>;
      return { ...s, file };
    } catch {
      return null; // torn/corrupt/missing → skip, never throw
    }
  };
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => PUSH_STATUS_FILE_RE.test(n));
  } catch {
    return [];
  }
  // The legacy file is consulted only when NO per-root FILES exist on disk —
  // if per-root files exist but are all corrupt, an empty result is the honest
  // answer (doctor pairs it with pushStatusFilesExist for the loud warn); a
  // stale pre-upgrade record must never shadow live-but-unreadable state.
  if (names.length === 0) {
    const legacy = parse(pushStatusPath());
    return legacy ? [legacy] : [];
  }
  return names
    .map((n) => parse(join(dir, n)))
    .filter((e): e is PushStatusEntry => e !== null)
    // A record whose workspace no longer exists on disk is a ghost: it can
    // never be cleared by a re-push (the root is gone), so it must not feed
    // the failure banner / staleness note forever (deleted Conductor
    // workspaces are routine). Entries without repoRoot (legacy shape in a
    // per-root file) are kept — absence of evidence is not a ghost.
    .filter((e) => e.repoRoot === undefined || existsSync(e.repoRoot));
}

/** True when any push-status file exists on disk (parseable or not). The
 * reader skips corrupt files silently; doctor pairs this with an empty read
 * to say "status present but unreadable" instead of saying nothing. */
export function pushStatusFilesExist(): boolean {
  const dir = join(ensureGbrainHome(), 'bootstrap');
  try {
    if (readdirSync(dir).some((n) => PUSH_STATUS_FILE_RE.test(n))) return true;
  } catch {
    /* fall through */
  }
  return existsSync(pushStatusPath());
}

/** The per-root status for one workspace, or null. Direct keyed read first —
 * the scan is only a fallback for legacy records carrying a repoRoot field. */
export function readPushStatusForRoot(root: string): PushStatusEntry | null {
  const keyedPath = pushStatusPathForRoot(root);
  try {
    const s = JSON.parse(readFileSync(keyedPath, 'utf8')) as Omit<PushStatusEntry, 'file'>;
    return { ...s, file: keyedPath };
  } catch {
    /* fall through to the scan */
  }
  return readPushStatuses().find((e) => e.repoRoot === root) ?? null;
}

/** One aggregation for every status surface (SessionStart note, doctor,
 * banner counting): the failing entries and the stalest success timestamp. */
/** Failure reasons carry remote-influenced text (git stderr → rung log →
 * push-status.reason). Clamp to a safe printable charset + length before ANY
 * model- or human-visible surface embeds it (banner, doctor, status blob) so
 * it can't become an injection or formatting vector — the free-form
 * counterpart to hook.ts's reasonCode() for typed codes. */
export function sanitizePushReason(reason: string | undefined): string {
  if (!reason) return 'unknown reason';
  return reason.replace(/[^\x20-\x7E]/g, ' ').replace(/[`$\\]/g, "'").slice(0, 140);
}

export function summarizePushStatuses(entries: PushStatusEntry[]): {
  failing: PushStatusEntry[];
  stalestTs: number | null;
} {
  const failing = entries.filter((e) => e.ok === false);
  const stamps = entries.map((e) => Date.parse(e.ts ?? '')).filter((t) => Number.isFinite(t));
  return { failing, stalestTs: stamps.length > 0 ? Math.min(...stamps) : null };
}

function writePushStatus(
  status: { ts: string; ok: boolean; reason?: string; ahead?: number; repoRoot: string },
): void {
  try {
    const p = pushStatusPathForRoot(status.repoRoot);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    // tmp+rename (the writeReceipt pattern): a concurrent reader never sees a
    // torn half-written status file.
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, p);
  } catch { /* best-effort — status telemetry never fails a push */ }
}

// ── The push sequence ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Commits ahead of origin/<branch> (undefined when git can't answer).
 * Exported for the backup-coverage probe (src/core/backup/coverage.ts). */
export function aheadCount(root: string, branch: string): number | undefined {
  const out = tryGit(root, ['rev-list', '--count', `origin/${branch}..HEAD`], { timeoutMs: 15_000 });
  if (out === null) return undefined;
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function workspacePush(opts: WorkspacePushOpts): Promise<WorkspacePushResult> {
  const log = (line: string) => opts.logger?.(line);

  const root = resolveWorkspaceRoot(opts.dir);
  if (!root) {
    return { ok: false, status: 'error', reason: `not a git repository: ${opts.dir}` };
  }
  const branch = opts.branch || detectDefaultBranch(root);

  // ONE lock spans scan → stage → commit → pull → push [G14/A5, CX2-6].
  const lock = acquirePushLock(root);
  if (!lock.acquired) {
    return {
      ok: true,
      status: 'skipped_in_flight',
      repoRoot: root,
      branch,
      lockHolderPid: lock.holderPid,
      reason: `push in flight (pid ${lock.holderPid ?? 'unknown'})`,
    };
  }

  const finish = (r: WorkspacePushResult): WorkspacePushResult => {
    // B4: written on success AND failure — only by the lock WINNER (a skip
    // must not clobber the in-flight run's eventual status). Keyed per root
    // [D13] so one workspace's success can never mask another's failure.
    writePushStatus({
      ts: new Date().toISOString(),
      ok: r.ok,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.ahead !== undefined ? { ahead: r.ahead } : {}),
      repoRoot: root,
    });
    // Fix-path invalidation: a successful push changes the backup-coverage
    // answer (workspace failing→ok, unpushed→pushed) — but ONLY when the
    // cached verdict carried something a push can fix. The routine healthy
    // stop-push must not delete an ok cache every session (that would defeat
    // the monthly compute throttle for the healthiest cohort).
    if (r.ok) {
      try {
        const s = loadBackupStatus();
        if (s && (s.overall === 'warn' || s.totals.failing > 0 || s.totals.unpushed > 0)) {
          invalidateBackupStatus();
        }
      } catch {
        /* best-effort */
      }
    }
    return r;
  };

  try {
    if (opts.holdLockMs && opts.holdLockMs > 0) await sleep(opts.holdLockMs);

    // 2. deny-glob inputs: tracked + untracked listings. `--others` deliberately WITHOUT
    // --exclude-standard: a gitignored deny match (brain.pglite behind a
    // `*.pglite` ignore line) is still reported loudly in excludedUntracked.
    let tracked: string[];
    let untracked: string[];
    try {
      tracked = listZ(root, ['ls-files', '--cached']);
      untracked = listZ(root, ['ls-files', '--others']);
    } catch (e) {
      return finish({
        ok: false, status: 'error', repoRoot: root, branch,
        reason: `git ls-files failed: ${(e as Error).message.slice(0, 140)}`,
      });
    }

    // Deny-glob backstop [G6]: TRACKED match = hard fail, .gitignore state
    // irrelevant (that's the point — a truncated .gitignore can't leak).
    const denyMatch = (p: string) => PUSH_DENY_GLOBS.some((g) => matchesGlob(g, p));
    const trackedDeny = tracked.filter(denyMatch);
    if (trackedDeny.length > 0) {
      const reason =
        `tracked file(s) match the deny list (${trackedDeny.slice(0, 10).join(', ')}` +
        `${trackedDeny.length > 10 ? ', …' : ''}) — remove from the index ` +
        `(git rm --cached <path>) before pushing`;
      log(`PUSH BLOCKED: ${reason}`);
      return finish({
        ok: false, status: 'blocked_tracked_deny', repoRoot: root, branch,
        denyMatches: trackedDeny, reason,
      });
    }
    // `--others` excludes index entries, so every listing IS untracked.
    const untrackedDeny = untracked.filter(denyMatch);

    // 3. stage FIRST — the scan below reads the STAGED blobs, so scanned
    // bytes == committed bytes (scanning disk before `add -A` left a TOCTOU
    // window where a file mutated after the snapshot was committed unscanned).
    const excludedUntracked: string[] = [];
    let stagedForScan: string[];
    try {
      ensureLocalIdentity(root);
      git(root, ['add', '-A'], { timeoutMs: 120_000 });
      // Un-stage any newly-added deny match (tracked ones already hard-failed
      // above, so anything staged AND deny-matched got here via add -A —
      // untrackedDeny names the expected set; the staged list is the source
      // of truth). `git rm --cached` un-adds without touching the disk file.
      const staged = listZ(root, ['diff', '--cached', '--name-only']);
      for (const p of staged.filter(denyMatch)) {
        git(root, ['rm', '--cached', '-q', '--', p]);
        excludedUntracked.push(p);
        log(`excluded from commit (deny list): ${p}`);
      }
      for (const p of untrackedDeny) {
        if (!excludedUntracked.includes(p)) {
          excludedUntracked.push(p); // ignored-but-deny-matched: never staged, still reported
        }
      }
      stagedForScan = staged.filter((p) => !denyMatch(p));
    } catch (e) {
      return finish({
        ok: false, status: 'error', repoRoot: root, branch,
        reason: `stage/commit failed: ${(e as Error).message.slice(0, 200)}`,
      });
    }

    // 4. secret scan over the STAGED content. This is the SOLE
    // block-secrets-before-they-leave control, so it FAILS CLOSED: the only
    // benign "no blob" case is a staged DELETION (removes content — nothing to
    // leak); every OTHER unscannable case (cat-file error, oversized blob)
    // BLOCKS the push naming the path, rather than silently exempting it.
    // `git cat-file -p :<path>` reads the index blob verbatim (no filters) —
    // exactly what a commit would record.
    let stagedDeletions: Set<string>;
    try {
      stagedDeletions = new Set(listZ(root, ['diff', '--cached', '--name-only', '--diff-filter=D']));
    } catch {
      // Can't enumerate deletions → treat nothing as a deletion (fail closed:
      // a real deletion then reports unscannable, which is safe — it blocks,
      // never leaks).
      stagedDeletions = new Set();
    }
    const allowlist = loadWorkspaceAllowlist(root);
    const findings: SecretFinding[] = [];
    const unscannable: string[] = [];
    for (const rel of stagedForScan) {
      if (pathAllowlisted(rel, allowlist)) continue; // user-declared safe path
      if (stagedDeletions.has(rel)) continue;        // deletion — no content to scan
      let blob: Buffer;
      try {
        blob = gitBuffer(root, ['cat-file', '-p', `:${rel}`]);
      } catch (e) {
        // NOT a deletion (checked above) — we cannot prove this file is clean.
        // A blob we can't read (missing index entry, over maxBuffer, git error)
        // must never sail through the only pre-push secret gate.
        unscannable.push(`${rel} (unreadable: ${(e as Error).message.slice(0, 80)})`);
        continue;
      }
      if (blob.length > PUSH_MAX_SCAN_BYTES) {
        // Too big to scan in-memory → block rather than exempt.
        unscannable.push(`${rel} (${blob.length}B exceeds the ${PUSH_MAX_SCAN_BYTES}B scan cap)`);
        continue;
      }
      // Binary (NUL-sniffed) files are scanned ANYWAY — a NUL byte doesn't mean
      // the blob is secret-free (an ASCII key can sit inside a "binary" file).
      // Buffer.toString('utf-8') keeps ASCII runs intact so the named patterns
      // still fire; invalid byte sequences become U+FFFD and simply don't match.
      for (const f of scanText(blob.toString('utf-8'), { allowlist })) {
        findings.push({ ...f, file: rel });
      }
    }
    if (findings.length > 0) {
      // Restore the index to HEAD (disk files untouched) — a blocked push
      // leaves nothing staged and nothing committed, same as before.
      tryGit(root, ['reset', '-q']);
      const summary = findings
        .slice(0, 10)
        .map((f) => `${f.file}:${f.line} [${f.pattern}]`)
        .join(', ');
      const reason =
        `secret scan found ${findings.length} finding(s): ${summary}` +
        `${findings.length > 10 ? ', …' : ''} — nothing committed. ` +
        `Add a fingerprint or glob line to ${SCAN_ALLOW_FILENAME} to override a false positive.`;
      log(`PUSH BLOCKED: ${reason}`);
      return finish({
        ok: false, status: 'blocked_secrets', repoRoot: root, branch, findings, reason,
      });
    }
    if (unscannable.length > 0) {
      // Fail CLOSED: an unscannable staged file could hide a secret. Restore
      // the index to HEAD (nothing staged, nothing committed) and block.
      tryGit(root, ['reset', '-q']);
      const summary = unscannable.slice(0, 10).join(', ') + (unscannable.length > 10 ? ', …' : '');
      const reason =
        `secret scan could not read ${unscannable.length} staged file(s): ${summary} — nothing committed. ` +
        `The pre-push secret gate fails closed: remove the file from the index (git rm --cached <path>), ` +
        `keep it under the scan cap (${PUSH_MAX_SCAN_BYTES}B), or allowlist it in ${SCAN_ALLOW_FILENAME}.`;
      log(`PUSH BLOCKED: ${reason}`);
      return finish({
        ok: false, status: 'blocked_unscannable', repoRoot: root, branch, unscannable, reason,
      });
    }

    // 5. commit (COMMIT FIRST, then pull — see step 6) [CX2-7].
    let committed = false;
    try {
      const clean = tryGit(root, ['diff', '--cached', '--quiet']) !== null;
      if (!clean) {
        git(root, ['commit', '-m', opts.commitMessage ?? 'gbrain: workspace push'], { timeoutMs: 60_000 });
        committed = true;
      }
    } catch (e) {
      return finish({
        ok: false, status: 'error', repoRoot: root, branch,
        reason: `stage/commit failed: ${(e as Error).message.slice(0, 200)}`,
      });
    }

    // Remote-privacy gate [G8] — after the local commit (committing is safe
    // and preserves the work either way), before anything touches the remote.
    if (tryGit(root, ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 }) === null) {
      return finish({
        ok: false, status: 'error', repoRoot: root, branch, committed,
        reason: 'no origin remote configured — nothing to push to',
      });
    }
    // Escape-hatch resolution [D18], most explicit first: CLI flag > env var >
    // file-plane config. Every path warns loudly. The hatches downgrade ONLY
    // the `unverifiable` verdict — the ladder still runs and an affirmatively
    // PUBLIC origin refuses regardless, matching every piece of user-facing
    // copy ("for self-hosted git you trust", never "push to public repos").
    const unverifiedVia = opts.allowUnverifiedRemote
      ? 'the allow-unverified-remote flag'
      : process.env.GBRAIN_ALLOW_UNVERIFIED_REMOTE === '1'
        ? 'GBRAIN_ALLOW_UNVERIFIED_REMOTE=1'
        : configAllowsUnverifiedRemote()
          ? 'config push.allow_unverified_remote (sticky — unset it once verification works)'
          : null;
    {
      const privacy = await verifyRemotePrivacy(root);
      if (privacy.verdict === 'not_private') {
        const reason = `origin is not private: ${privacy.detail} — refusing to push workspace contents` +
          (unverifiedVia !== null ? ` (the unverified-remote override via ${unverifiedVia} does NOT cover proven-public origins)` : '');
        log(`PUSH REFUSED: ${reason}`);
        return finish({
          ok: false, status: 'refused_visibility', repoRoot: root, branch, committed, reason,
        });
      }
      if (privacy.verdict === 'unverifiable') {
        if (unverifiedVia !== null) {
          log(`WARN: origin visibility unverifiable — pushing anyway via ${unverifiedVia}; you are trusting this remote`);
        } else {
          const reason =
            `cannot verify origin visibility (${privacy.detail}) — refusing to push. ` +
            `Pass --allow-unverified-remote (or set GBRAIN_ALLOW_UNVERIFIED_REMOTE=1, or ` +
            '`gbrain config set push.allow_unverified_remote true`) for self-hosted git you trust.';
          log(`PUSH REFUSED: ${reason}`);
          return finish({
            ok: false, status: 'refused_visibility', repoRoot: root, branch, committed, reason,
          });
        }
      }
    }

    // 6. pull AFTER commit [CX2-7] — a dirty tree is impossible here short of
    // a mid-run writer, and divergenceSafePull handles that as skipped_dirty.
    try {
      const pull = divergenceSafePull(root, branch);
      if (pull.status === 'conflict_aborted') {
        return finish({
          ok: false, status: 'pull_conflict', repoRoot: root, branch, committed,
          ahead: aheadCount(root, branch),
          reason: pull.detail,
        });
      }
      if (pull.status === 'skipped_dirty') {
        log('WARN: tree re-dirtied mid-run — pull skipped; pushing the committed HEAD anyway');
      }
    } catch (e) {
      // fetch failure etc. — still attempt the push; it will name the problem.
      log(`WARN: pull failed (${(e as Error).message.slice(0, 120)}); attempting push`);
    }

    // 7. push — even with no new commit (a prior failure may have left local ahead).
    try {
      git(root, [...pushSsrfFlags(), 'push', ...GIT_SSRF_SUBCOMMAND_FLAGS, 'origin', `HEAD:${branch}`], {
        timeoutMs: 120_000, auth: true,
      });
    } catch (e) {
      return finish({
        ok: false, status: 'push_failed', repoRoot: root, branch, committed,
        ahead: aheadCount(root, branch),
        reason: `git push failed: ${(e as Error).message.slice(0, 200)}`,
      });
    }

    const ahead = aheadCount(root, branch) ?? 0;
    log(`pushed ${root} → origin/${branch}${committed ? ' (new commit)' : ''}`);
    return finish({
      ok: true, status: 'pushed', repoRoot: root, branch, committed, ahead,
      ...(excludedUntracked.length > 0 ? { excludedUntracked } : {}),
    });
  } finally {
    lock.handle.release();
  }
}
