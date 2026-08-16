/**
 * Bootstrap-run mutex [G9, CX2-16] + the bootstrap family's typed-error
 * machinery.
 *
 * Two concurrent `gbrain bootstrap` runs against the same workspace would
 * interleave renders, gh calls, and receipt writes. The mutex is an atomic
 * `mkdir` at `<workspace>/.gbrain-bootstrap.lock` with a `meta.json`
 * ({pid, acquired_at, token}) written tmp+rename so a concurrent reader never
 * sees a torn file.
 *
 * Steal policy (the pid-reuse learning from pglite-lock #2058/#2348 applied):
 * a holder is stolen ONLY when its PID is affirmatively dead (kill-0 → ESRCH)
 * AND the lock is older than STALE_AGE_MS. Both conditions are required —
 * a dead-looking young lock may be a concurrent acquirer that hasn't written
 * meta yet, and PID liveness alone is unreliable under PID reuse. A live PID
 * is NEVER stolen regardless of age. Everything else gets the typed
 * BOOTSTRAP_IN_PROGRESS refusal the runbook relays to the human.
 *
 * Release is ownership-checked: the on-disk token must match ours before the
 * lock dir is removed, so a stolen-and-replaced handle can never delete the
 * new owner's live lock (same defense as pglite-lock's releaseLock).
 *
 * This module is the dependency root of the bootstrap family — `BootstrapError`
 * lives here so repo.ts / attach.ts / uninstall.ts can share it without cycles.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../pglite-lock.ts';

// ---------------------------------------------------------------------------
// Typed errors (shared by the whole bootstrap family)
// ---------------------------------------------------------------------------

export type BootstrapErrorCode =
  /** `gh` binary not on PATH — human must install it (exit-code-2 semantics). */
  | 'GH_MISSING'
  /** `gh auth status` failed — human must run `gh auth login` (exit 2). */
  | 'GH_AUTH'
  /** Workspace already has an `origin` remote bootstrap can neither adopt nor
   * claim (foreign owner / receipt mismatch) — pointed at attach [G8]. */
  | 'ORIGIN_EXISTS'
  /** A create-repo-first origin the authed user owns has FOREIGN content —
   * bootstrap adopts only an empty repo (or one carrying our own history), so
   * it never silently no-ops onto an existing project [G8]. */
  | 'ORIGIN_NOT_EMPTY'
  /** Could not reach the origin to confirm it is safe to adopt (git ls-remote
   * failed) — refuse and re-run; never adopt on uncertainty [G8]. */
  | 'REMOTE_CHECK_FAILED'
  /** `gh repo create` (or a required git step) failed. */
  | 'REPO_CREATE_FAILED'
  /** The pre-push secret scan found an unallowlisted secret in the workspace —
   * nothing is committed or pushed until it is removed/allowlisted [G8/D6]. */
  | 'SECRET_SCAN_BLOCKED'
  /** Privacy verify returned an affirmative non-private answer — hard stop. */
  | 'REPO_NOT_PRIVATE'
  /** Privacy verify could not complete (rate limit / 5xx) — refuse and name
   * the reason, never fail-open; the fix is re-running, not panic [G8]. */
  | 'VERIFY_UNAVAILABLE'
  /** Cloud sandbox: a repo created mid-session is never attached to the
   * session's GitHub proxy scope (REST 403, push denied) — creation must
   * happen outside; the session is opened ON the repo, then attach [D-cloud]. */
  | 'CLOUD_SANDBOX_REPO'
  /** No agent.json — not an agent workspace. */
  | 'NOT_A_WORKSPACE'
  /** agent.json says `initialized: false` — an unrendered template clone [CX2-1]. */
  | 'TEMPLATE_UNINITIALIZED'
  /** agent.json unreadable / conflict markers / bad JSON. */
  | 'MANIFEST_INVALID'
  /** agent.json format_version is newer than this binary understands. */
  | 'NEWER_FORMAT'
  /** Another bootstrap run holds the workspace lock [G9]. */
  | 'BOOTSTRAP_IN_PROGRESS'
  /** No machine-local install receipt — nothing bootstrap-created here [CX2-12]. */
  | 'NO_RECEIPT'
  /** The receipt on this machine belongs to a different workspace. */
  | 'RECEIPT_MISMATCH'
  /** A live process (serve or other) holds the PGLite data-dir lock. */
  | 'LIVE_SERVE'
  /** --delete-brain requested but bootstrap did not create this brain [G2]. */
  | 'DELETE_BRAIN_REFUSED'
  /** GBRAIN_HOME guard tripped: not explicit / bad signature / symlink [S3#5]. */
  | 'HOME_GUARD';

/**
 * The bootstrap family's error type. `exitCode` carries dispatcher semantics:
 * 2 = a human action is required (install gh, gh auth login); 1 = everything
 * else. Callers branch on `code`, never on message text.
 */
export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: BootstrapErrorCode, message: string, opts?: { exitCode?: number; details?: Record<string, unknown> }) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    this.exitCode = opts?.exitCode ?? 1;
    this.details = opts?.details ?? {};
  }
}

// ---------------------------------------------------------------------------
// The bootstrap-run mutex
// ---------------------------------------------------------------------------

export const BOOTSTRAP_LOCK_DIRNAME = '.gbrain-bootstrap.lock';
const META_FILE = 'meta.json';

/** A dead-PID holder younger than this is NOT stolen (pid-reuse + mkdir-then-
 * write-meta race guard). Exported for tests. */
export const BOOTSTRAP_LOCK_STALE_AGE_MS = 120_000;

export interface BootstrapLockMeta {
  pid: number;
  acquired_at: number;
  token: string;
}

export interface BootstrapLockHandle {
  /** Absolute path of the lock directory. */
  dir: string;
  /** Ownership token — release verifies the on-disk meta still carries it. */
  token: string;
  /** True when this acquisition stole a stale (dead + old) holder's lock. */
  stole: boolean;
  release(): void;
}

export function bootstrapLockDir(workspaceDir: string): string {
  return join(workspaceDir, BOOTSTRAP_LOCK_DIRNAME);
}

function readMeta(lockDir: string): BootstrapLockMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, META_FILE), 'utf8')) as Partial<BootstrapLockMeta>;
    if (typeof parsed.pid !== 'number' || typeof parsed.acquired_at !== 'number' || typeof parsed.token !== 'string') {
      return null;
    }
    return parsed as BootstrapLockMeta;
  } catch {
    return null;
  }
}

/** Age of the holder: meta.acquired_at when readable, else the dir's mtime. */
function holderAgeMs(lockDir: string, meta: BootstrapLockMeta | null, now: number): number {
  if (meta) return now - meta.acquired_at;
  try {
    return now - statSync(lockDir).mtimeMs;
  } catch {
    return 0; // dir vanished mid-check — treat as brand new; the retry handles it
  }
}

function inProgressError(meta: BootstrapLockMeta | null): BootstrapError {
  const pid = meta?.pid;
  return new BootstrapError(
    'BOOTSTRAP_IN_PROGRESS',
    pid !== undefined
      ? `bootstrap already running (pid ${pid}) — wait for it to finish, or remove ${BOOTSTRAP_LOCK_DIRNAME} if you are sure it is dead`
      : `bootstrap already running — wait for it to finish, or remove ${BOOTSTRAP_LOCK_DIRNAME} if you are sure it is dead`,
    { details: { pid } },
  );
}

/**
 * Acquire the workspace bootstrap mutex. Throws BOOTSTRAP_IN_PROGRESS when a
 * live (or not-provably-stale) holder exists. Never waits: bootstrap runs are
 * human-triggered, so the right UX for a collision is an immediate, typed
 * refusal the agent can relay — not a silent queue.
 */
export async function acquireBootstrapLock(
  workspaceDir: string,
  opts?: { now?: () => number },
): Promise<BootstrapLockHandle> {
  const now = opts?.now ?? Date.now;
  const lockDir = bootstrapLockDir(workspaceDir);
  let stole = false;

  // At most two attempts: initial, and one retry after stealing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir, { recursive: false });
    } catch {
      // Held (or the workspace dir itself is missing — surface that plainly).
      try {
        statSync(workspaceDir);
      } catch {
        throw new BootstrapError('NOT_A_WORKSPACE', `workspace directory does not exist: ${workspaceDir}`);
      }
      const meta = readMeta(lockDir);
      const age = holderAgeMs(lockDir, meta, now());
      const dead = meta !== null && !isProcessAlive(meta.pid);
      // Steal ONLY dead + old. A live PID is never stolen; a young lock —
      // even with unreadable meta — may be a concurrent acquirer mid-write.
      const stealable = age > BOOTSTRAP_LOCK_STALE_AGE_MS && (dead || meta === null);
      if (!stealable) throw inProgressError(meta);
      stole = true;
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch { /* raced with the holder's own release — retry below */ }
      continue;
    }

    // mkdir succeeded — write meta atomically (tmp + rename) so a concurrent
    // reader sees the file complete or absent, never torn.
    const meta: BootstrapLockMeta = {
      pid: process.pid,
      acquired_at: now(),
      token: `${process.pid}:${now()}:${crypto.randomUUID()}`,
    };
    const metaPath = join(lockDir, META_FILE);
    const tmp = `${metaPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    renameSync(tmp, metaPath);

    const handle: BootstrapLockHandle = {
      dir: lockDir,
      token: meta.token,
      stole,
      release: () => releaseBootstrapLock(handle),
    };
    return handle;
  }

  // Steal raced with a fresh acquirer — someone live owns it now.
  throw inProgressError(readMeta(lockDir));
}

/**
 * Release the mutex. Ownership-checked: if the on-disk token is readable and
 * is NOT ours, someone stole-and-replaced us — leave their lock alone.
 * Unreadable/absent meta falls through to a best-effort remove (mirrors
 * pglite-lock's releaseLock).
 */
export function releaseBootstrapLock(handle: Pick<BootstrapLockHandle, 'dir' | 'token'>): void {
  const meta = readMeta(handle.dir);
  if (meta && meta.token !== handle.token) return; // not ours anymore
  try {
    rmSync(handle.dir, { recursive: true, force: true });
  } catch { /* already gone */ }
}
