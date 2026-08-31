/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `gbrain embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync, renameSync, readlinkSync, type Stats } from 'fs';
import { join } from 'path';
import { execFileSync } from 'node:child_process';
import { parseGlobalFlags } from './cli-options.ts';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';

// #2058: refresh the lock's `refreshed_at` while held so a long-running but
// LIVE holder (embed jobs run for many minutes) is never mistaken for stale.
const HEARTBEAT_INTERVAL_MS = 30_000;

export class LiveServeLockError extends Error {}

function isServeCommand(lockData: { subcommand?: unknown; command?: unknown }): boolean {
  // New lock files store the command after the same global-flag parsing used
  // by cli.ts. This survives paths with spaces and forms such as
  // `gbrain --quiet serve` without confusing `gbrain search serve`.
  if (typeof lockData.subcommand === 'string') return lockData.subcommand === 'serve';

  const command = lockData.command;
  if (typeof command !== 'string') return false;
  const parts = command.trim().split(/\s+/);
  // Backward compatibility for locks created before `subcommand` was stored.
  return parts[0] === 'serve' || parts[1] === 'serve';
}

// #2348: there is NO steal-on-stale-heartbeat anymore. A holder whose PID is
// alive AND still the same program is NEVER reaped, regardless of how long its
// heartbeat has been stale.
// PGLite/WASM is strictly single-writer; the heartbeat runs on the JS event
// loop, which is BLOCKED during long synchronous imports/CHECKPOINTs, so a
// genuinely working `gbrain dream`/embed holder can look stale while alive.
// Reaping it (the old #2058 grace window) let a second OS process open the same
// data dir and corrupt the catalog + pgvector extension state (58P01 /
// internal_load_library / `type "vector" does not exist`), recoverable only by
// wipe+restore. Only affirmative proof of death reaps now: ESRCH from kill-0,
// or a command line (via `ps`/proc) proving the PID was recycled by a
// non-gbrain program — and the latter only with affirmative same-namespace
// proof (the lock's recorded pid_ns/boot_id must be readable and match ours),
// so a cross-namespace or legacy holder is never reaped on cmdline evidence.
// Every reap serializes on an atomic claim dir and re-validates the victim's
// ownership token while the lock is still in place, so concurrent reapers
// can't delete each other's fresh locks.
// A live serve-tagged holder gets the immediate process-conflict explanation
// below; wedged-but-alive holders still time out — never stolen.

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  /**
   * #2058: heartbeat timer + lock-file path, set when a real (on-disk) lock is
   * held so `releaseLock` can stop refreshing. Absent for the in-memory engine
   * (no lock file, no concurrent access possible).
   */
  heartbeat?: ReturnType<typeof setInterval>;
  lockPath?: string;
  /**
   * Our ownership token (`<pid>:<acquired_at>`). Since #2348 a LIVE holder is
   * never reaped, so reap-then-reacquire happens only after the original holder
   * is dead — but the heartbeat and release STILL verify the on-disk lock is
   * ours before touching it (defense-in-depth: a crash-then-restart on a reused
   * PID, or a misclassification, must never let a stale handle refresh or delete
   * the NEW owner's live lock and re-open the concurrent-writer hole).
   */
  ownerToken?: string;
  /**
   * WAL-repair gate (#223 auto-repair): true when this acquisition reaped a
   * prior holder's lock — dead-PID reap or corrupt-lock-file removal. A
   * corrupt lock file cannot prove its holder is dead, and even a dead-PID
   * verdict can be wrong under PID reuse, so auto WAL surgery refuses to run
   * on a reaped acquisition (`'possibly-live-writer'`) and asks for a clean
   * re-run instead. Never set for in-memory engines.
   */
  reaped?: boolean;
}

/** The on-disk lock identity, used to detect "we were reaped and replaced". */
function tokenOf(lockData: { pid?: unknown; acquired_at?: unknown }): string {
  return `${lockData.pid}:${lockData.acquired_at}`;
}

/**
 * #2058: keep the held lock's `refreshed_at` current so a concurrent acquirer
 * can tell a live, working holder from a hung/dead one. Best-effort: if the
 * file is gone (we're being reaped) the write simply fails. `.unref()` so the
 * timer never keeps the process alive on its own. Ownership-checked: if the
 * on-disk lock is no longer ours (we were reaped past grace and replaced), stop
 * the heartbeat instead of clobbering the new owner's lock.
 */
function startHeartbeat(lockPath: string, ownerToken: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (tokenOf(raw) !== ownerToken) {
        // We were reaped and someone else owns it now — do NOT refresh their
        // lock. Stand down.
        clearInterval(timer);
        return;
      }
      raw.refreshed_at = Date.now();
      // Atomic tmp+rename (security review): waiting acquirers poll-read this
      // file every second — an in-place write can be caught mid-flight and a
      // torn read misclassifies a HEALTHY live holder as a corrupt lock,
      // getting it reaped. rename makes every read see old-or-new, never torn.
      const tmpPath = `${lockPath}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(raw), { mode: 0o644 });
      renameSync(tmpPath, lockPath);
    } catch { /* best-effort — file removed or transient FS error */ }
  }, HEARTBEAT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Persisted reap marker (security review): written ONLY for corrupt-lock-file
 * reaps, where the holder's liveness is UNKNOWABLE (the PID can't be read).
 * The in-process `reaped` flag dies with the acquisition — so the reaper
 * destroys a possibly-live holder's lock, exits, and the NEXT process
 * acquires "cleanly" and would run WAL surgery under a live writer. The
 * marker makes that reap visible across processes: `attemptWalRepairAndRetry`
 * refuses auto-repair while a recent unknowable-liveness reap is on record.
 * Dead-PID reaps (affirmative ESRCH verdict) deliberately do NOT write it —
 * the dead-holder recovery cost stays at one failed command + one re-run.
 */
function reapMarkerPath(dataDir: string): string {
  return `${dataDir}.lock-reap.json`;
}

function recordReap(dataDir: string): void {
  try {
    writeFileSync(reapMarkerPath(dataDir), JSON.stringify({ ts: Date.now(), by: process.pid }), { mode: 0o644 });
  } catch { /* best-effort — a marker write failure must not block acquisition */ }
}

export interface LockHolderInfo {
  /** true only when a LIVE process holds the lock. */
  held: boolean;
  pid?: number;
  /** true when the live holder is a `gbrain serve` (the MCP single-writer). */
  serve?: boolean;
  subcommand?: string;
}

/**
 * READ-ONLY lock inspection for status surfaces (`gbrain engine status`,
 * smoke-test). Never reaps, never mkdirs, never blocks — the whole point is
 * to answer "would a connect attempt hang on the single-writer lock?"
 * without touching the lock. A dead-PID holder reads as `held: false`
 * (a real acquire would reap it), so status doesn't misreport a crashed
 * process as an active writer.
 */
export function inspectLockHolder(dataDir: string | undefined): LockHolderInfo {
  const lockDir = getLockDir(dataDir);
  if (!lockDir || !existsSync(lockDir)) return { held: false };
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- lockDir derives from the OPERATOR's configured PGLite data dir (getLockDir over database_path), LOCK_FILE is a module constant; read-only inspection of the operator's own lock file, same trusted-local shape as this module's pre-existing join sites, never remote input
    const lockData = JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8'));
    const pid = typeof lockData.pid === 'number' ? lockData.pid : undefined;
    const alive = pid !== undefined && isProcessAlive(pid);
    if (!alive) return { held: false, pid };
    return {
      held: true,
      pid,
      serve: isServeCommand(lockData),
      subcommand: typeof lockData.subcommand === 'string' ? lockData.subcommand : undefined,
    };
  } catch {
    // Corrupt/unreadable lock file: liveness is unknowable. Report held so a
    // status surface stays conservative (a probe COULD block); acquire-time
    // logic has its own corrupt-lock handling.
    return { held: true };
  }
}

/** Milliseconds since the last recorded reap on this data dir, or null. */
export function msSinceLastReap(dataDir: string | undefined): number | null {
  if (!dataDir) return null;
  try {
    const raw = JSON.parse(readFileSync(reapMarkerPath(dataDir), 'utf-8')) as { ts?: unknown };
    return typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? Date.now() - raw.ts : null;
  } catch {
    return null;
  }
}

function getLockDir(dataDir: string | undefined): string {
  // Use the parent of the data dir for the lock, or a temp location for in-memory
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
  return join(dataDir, LOCK_DIR_NAME);
}

export function isProcessAlive(pid: number): boolean {
  // Only ESRCH (no such process) is affirmative proof of death. EPERM means
  // the process EXISTS under another user; ERR_INVALID_ARG_TYPE / a malformed
  // or non-finite pid means we can't tell — all of which must read as ALIVE,
  // because a false "dead" reaps a live holder's lock (security/codex review).
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/**
 * Read a process's full command line, or null when it can't be determined.
 * `ps -o args=` works on Linux + macOS (same pattern as autopilot-lock's
 * readProcessCommand); the /proc fallback covers minimal Linux containers
 * where `ps` is absent (cf. #4300). Null means "unknowable" — callers must
 * treat it as ALIVE, never as evidence of death.
 */
function readProcessArgs(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    if (out.length > 0) return out;
  } catch { /* fall through to /proc */ }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const args = raw.replace(/\0/g, ' ').trim();
    if (args.length > 0) return args;
  } catch { /* unreadable — unknowable */ }
  return null;
}

/**
 * This process's PID-namespace id (Linux `pid:[inode]`), or null elsewhere.
 * A PID is only meaningful inside the namespace that produced it: a lock
 * written by a holder in ANOTHER container (shared data dir) records a PID
 * that here belongs to an unrelated process — kill-0 says "alive" and the
 * cmdline is that unrelated process's, so BOTH liveness and cmdline evidence
 * are meaningless across namespaces (the #2840 false-steal class). Unlike
 * boot_id (host-scoped — same-host containers share it), the pid-namespace
 * inode distinguishes containers. Null when unavailable (non-Linux).
 */
function readPidNs(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

/**
 * Boot id of this host (Linux). Complements pid_ns for the cross-HOST case
 * (same data dir shared between VMs/machines, where pid_ns inode numbers can
 * collide). Null when unavailable.
 */
function readBootId(): string | null {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null; // non-Linux — no comparable marker
  }
}

/**
 * PID-reuse detection. `isProcessAlive` (kill-0) only proves SOME process owns
 * the PID — a dead holder's PID can be recycled by an unrelated program
 * (docker-proxy, a shell, a supervisor's next child), which previously wedged
 * the lock until acquire timeout with no automatic recovery. A command line
 * that matches neither "gbrain" nor the recorded command's first token is
 * affirmative proof the original holder is gone — equivalent to an ESRCH
 * verdict — so the lock can be reaped.
 *
 * Fail-safe like isProcessAlive: ANY doubt reads as "not reused" (alive) —
 * unreadable/missing command line, a same-process PID (#1963 semantics: a
 * second acquire from the holder process still waits out the timeout), or
 * missing/mismatched namespace markers. On Linux the cmdline verdict REQUIRES
 * affirmative same-namespace proof (lock's recorded pid_ns === ours; boot_id
 * must also match when both are recorded): legacy locks without markers are
 * never cmdline-reaped (ESRCH reaps still apply). Platforms without namespace
 * markers (macOS) have no reachable cross-namespace data-dir sharing — a
 * Docker VM's PIDs aren't visible to host `ps` at all — so the cmdline
 * verdict stands alone there.
 */
function isPidReusedByOtherProgram(
  pid: number,
  recordedCommand: unknown,
  recordedPidNs: unknown,
  recordedBootId: unknown,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Same-process re-acquire: WE are the recorded holder, so the PID is by
  // definition not recycled. (Also keeps non-gbrain test harnesses that hold a
  // lock with their own PID from reaping themselves.)
  if (pid === process.pid) return false;
  if (process.platform === 'linux') {
    // Linux: cmdline evidence is only meaningful within one PID namespace on
    // one host, so EVERY marker must be readable AND matching — pid_ns rules
    // out other containers, boot_id rules out other hosts (pid_ns inode
    // numbers can collide across machines sharing a data dir). An unreadable
    // local marker, a legacy lock without markers, or any mismatch all veto
    // the reap (fail-closed; ESRCH reaps are unaffected).
    const ourNs = readPidNs();
    const ourBoot = readBootId();
    if (ourNs === null || ourBoot === null) return false;
    if (recordedPidNs !== ourNs) return false;
    if (recordedBootId !== ourBoot) return false;
  }
  const cmdline = readProcessArgs(pid);
  if (cmdline === null) return false; // unknowable — cannot prove reuse
  if (cmdline.includes('gbrain')) return false;
  if (typeof recordedCommand === 'string' && recordedCommand.length > 0) {
    const firstToken = recordedCommand.trim().split(/\s+/)[0];
    if (firstToken && cmdline.includes(firstToken)) return false;
    // False-steal hardening: the recorded first token is often an ABSOLUTE
    // script path (Bun normalizes argv[1]) while `ps`/procfs report the
    // spawn-time RELATIVE form (`bun run src/cli.ts serve …`), so the literal
    // includes() above never matches and a LIVE holder gets classified as
    // recycled — observed as a harness mint stealing a running serve's lock
    // and writing its token to a second PGLite instance the serve never
    // sees. Compare the token's basename too: an unrelated program that
    // genuinely recycled the PID is no more likely to carry `cli.ts` in its
    // argv than the full path, so precision holds.
    const baseToken = firstToken ? firstToken.split('/').pop() : undefined;
    if (baseToken && baseToken.length > 0 && cmdline.includes(baseToken)) return false;
  }
  return true;
}

const REAP_CLAIM_TTL_MS = 30_000;

/**
 * Remove a claim dir whose claimant is provably gone (dead PID) or stalled
 * (older than the TTL — a reap is three syscalls, so 30s means crashed).
 * Returns true when the claim was cleared. Best-effort: losing a concurrent
 * clear race is fine, the caller just retries the claim.
 */
function breakStaleClaim(claimDir: string): boolean {
  let stale: boolean;
  try {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- claimDir derives from getLockDir(dataDir) (internal brain dir) + LOCK_FILE constant — no user input
    const raw = JSON.parse(readFileSync(join(claimDir, LOCK_FILE), 'utf-8'));
    const alive = typeof raw.pid === 'number' && isProcessAlive(raw.pid);
    const fresh = typeof raw.at === 'number' && Date.now() - raw.at < REAP_CLAIM_TTL_MS;
    // Legitimately held only while the claimant is alive AND within TTL;
    // a dead claimant breaks immediately, a live one after the TTL.
    stale = !(alive && fresh);
  } catch {
    // Metadata missing/unparseable: acquisition in flight (mkdir done,
    // metadata not yet published) vs crashed claimant — only the claim DIR's
    // age distinguishes them, so never break a young claim on this evidence.
    try {
      stale = Date.now() - statSync(claimDir).mtimeMs >= REAP_CLAIM_TTL_MS;
    } catch {
      return true; // claim dir already gone — nothing to break
    }
  }
  if (!stale) return false;
  try { rmSync(claimDir, { recursive: true, force: true }); return true; } catch { return false; }
}

/**
 * Remove a lock dir we classified as reaped, WITHOUT racing concurrent
 * reapers. Two acquirers can classify the same dead/recycled victim; a plain
 * rmSync (or rename-aside, which momentarily makes the lock dir vanish) lets
 * the slower reaper delete — or displace — the FASTER one's freshly installed
 * lock: two writers on one data dir.
 *
 * Instead, reapers serialize on an atomic claim dir (mkdir). While holding
 * the claim — the only entitlement to remove the lock — the winner
 * re-validates that the lock on disk is still the victim it classified, and
 * only then deletes. A loser (or a validator that finds a NEW holder's lock)
 * touches nothing. The claim self-heals: a crashed claimant's dir is broken
 * after REAP_CLAIM_TTL_MS or when its PID is dead.
 *
 * `victimToken` null = corrupt/unparseable lock (no token to compare; we
 * re-confirm it is still unparseable instead).
 */
function tryReapLockDir(lockDir: string, victimToken: string | null): boolean {
  // Capture the victim directory's identity before we claim the reap. If the
  // directory is replaced (same path, different inode) while we hold the
  // claim, an ENOENT read would no longer describe the lock we classified.
  let victimDirStat: Stats;
  try {
    victimDirStat = statSync(lockDir);
  } catch {
    return false; // vanished before we could claim it
  }

  const claimDir = `${lockDir}.reap-claim`;
  const claim = (): boolean => {
    try {
      mkdirSync(claimDir);
      // Publish ownership atomically (tmp+rename) — a concurrent stale-claim
      // breaker must never see a claimed dir with missing/torn metadata.
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: internal lock dir + constant + own pid
      const tmp = join(claimDir, `${LOCK_FILE}.tmp-${process.pid}`);
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o644 });
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: internal lock dir + constant
      renameSync(tmp, join(claimDir, LOCK_FILE));
      return true;
    } catch {
      return false;
    }
  };
  if (!claim() && !(breakStaleClaim(claimDir) && claim())) {
    return false; // another reaper holds the claim — outer loop re-reads
  }
  try {
    if (victimToken !== null) {
      let current: string;
      try {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- lockDir = getLockDir(dataDir), internal + constant
        current = tokenOf(JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8')));
      } catch {
        return false; // vanished (another outcome already resolved it)
      }
      if (current !== victimToken) return false; // a NEW holder's lock — leave it
    } else {
      try {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: internal lock dir + constant
        JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8'));
        return false; // became parseable — not the corrupt lock we classified
      } catch (err) {
        // ENOENT can mean "still corrupt" OR "the lockDir was replaced by a
        // new holder that hasn't written its file yet". Reap only if the
        // directory inode is unchanged, i.e. it is the same directory we
        // classified as corrupt.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            if (statSync(lockDir).ino !== victimDirStat.ino) return false;
          } catch {
            return false; // gone
          }
        }
        /* any other read/parse error = still corrupt — proceed */
      }
    }
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return true;
  } finally {
    try { rmSync(claimDir, { recursive: true, force: true }); } catch { /* stale-claim breaker handles leftovers */ }
  }
}

function formatLockTimestamp(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : 'unknown time';
}

function pgliteLockTimeoutError(lockDir: string): Error {
  const lockPath = join(lockDir, LOCK_FILE);
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const pid = String(lockData.pid ?? 'unknown');
    const command = String(lockData.command ?? 'unknown');
    const serveHint = command.includes('gbrain serve')
      ? ' The holder looks like `gbrain serve`, so this is probably serve↔sync contention from an MCP/HTTP server; stop that server/client and rerun the command.'
      : '';

    return new Error(
      `GBrain: Timed out waiting for PGLite data-dir lock. Process ${pid} has held it since ${formatLockTimestamp(lockData.acquired_at)} (command: ${command}). ` +
      `Lock directory: ${lockDir}. If that process is dead, remove the lock directory and try again. ` +
      `This is a PGLite data-dir lock, not the \`gbrain-sync:*\` advisory lock; \`gbrain sync --break-lock\` will not clear a live PGLite holder.` +
      serveHint,
    );
  } catch {
    return new Error(
      `GBrain: Timed out waiting for PGLite lock. Remove ${lockDir} and try again.`
    );
  }
}

export interface LockPeekResult {
  held: boolean;
  isServe?: boolean;
  pid?: number;
}

/**
 * Pure read of the PGLite lock: no mkdir, no acquire side effect, never
 * throws LiveServeLockError. For a third-party caller deciding whether to
 * even attempt a connection (e.g. Memorable's local hook against a PGLite
 * brain) — not part of gbrain's own acquisition path, which is unchanged.
 * "Not held" covers: no lock dir, a dead-PID holder, or a lock file that does
 * not parse (left to a real connect attempt to sort out, same as acquireLock
 * does today). A lock file that DOES parse but carries no usable `pid` reads
 * as HELD with `pid: undefined` — `isProcessAlive` treats an unprovable pid as
 * alive on purpose, and reporting "not held" there would invite a caller to
 * steal a live holder's lock. Erring toward held costs a retry; erring the
 * other way corrupted catalogs (#2348).
 */
export function peekLock(dataDir: string | undefined): LockPeekResult {
  const lockDir = getLockDir(dataDir);
  if (!lockDir || !existsSync(lockDir)) return { held: false };
  let lockData: { pid?: unknown; subcommand?: unknown; command?: unknown };
  try {
    // lockDir comes from getLockDir (the engine's own configured data dir),
    // LOCK_FILE is a module constant — no user-controlled path segment.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    lockData = JSON.parse(readFileSync(join(lockDir, LOCK_FILE), 'utf-8'));
  } catch {
    return { held: false };
  }
  const pid = lockData.pid as number;
  if (!isProcessAlive(pid)) return { held: false };
  return { held: true, isServe: isServeCommand(lockData), pid };
}

/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  // `lockDir` being set implies `dataDir` is set (see getLockDir), but TS
  // can't derive that across helper boundaries.
  mkdirSync(dataDir as string, { recursive: true });

  const timeoutMs = opts?.timeoutMs ?? 30_000; // 30 second default timeout
  const startTime = Date.now();
  let reaped = false; // see LockHandle.reaped

  while (Date.now() - startTime < timeoutMs) {
    // Check for stale lock first
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const lockPid = lockData.pid as number;

        // #2348: classify ONLY by affirmative proof of death. A live holder is
        // NEVER reaped (stealing a live single-writer is what corrupted the
        // catalog/extension state). A long synchronous import blocks the
        // heartbeat, so "stale heartbeat" is NOT evidence of death — only a
        // dead PID (ESRCH) or a PID provably recycled by a non-gbrain program
        // (cmdline mismatch under affirmative same-namespace proof) is.
        const alive = isProcessAlive(lockPid)
          && !isPidReusedByOtherProgram(lockPid, lockData.command, lockData.pid_ns, lockData.boot_id);
        if (!alive) {
          // Holder process is gone — reap and try to acquire. This verdict is
          // affirmative (kill-0 threw ESRCH; EPERM reads as alive), so no
          // cross-process quarantine marker: the same-acquisition `reaped`
          // flag alone gates repair, keeping the dead-holder recovery cost at
          // one failed command + one re-run. tryReapLockDir serializes
          // concurrent reapers on an atomic claim dir; losing it just means
          // the winner's fresh lock shows up on the next loop iteration.
          if (tryReapLockDir(lockDir, tokenOf(lockData))) reaped = true;
        } else {
          if (isServeCommand(lockData)) {
            throw new LiveServeLockError(
              `GBrain's local database is already open through \`gbrain serve\` (MCP, PID ${lockPid}). ` +
              `This brain uses PGLite, so a separate CLI process cannot open it at the same time. ` +
              `\`gbrain sync\` runs through the live serve automatically (serve-delegated sync); ` +
              `for other CLI write commands, stop \`gbrain serve\` and retry. ` +
              `(\`gbrain serve\` is usually spawned by your agent harness — close or exit that ` +
              `Claude Code/Codex session to release the database.) ` +
              `Or keep it running and use its MCP tools instead. ` +
              `A process with the recorded PID is still running, so GBrain will not remove ${lockDir} automatically.`,
            );
          }
          // Other live holders may be short-lived, so wait and retry. If one is
          // genuinely wedged (or its PID was reused), the acquire times out;
          // we never force-steal a live holder.
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      } catch (err) {
        // A live MCP server is not a stale or corrupt lock. Surface the useful
        // explanation without touching the lock it still owns.
        if (err instanceof LiveServeLockError) throw err;
        // ENOENT = acquisition in flight (a concurrent acquirer did mkdir but
        // hasn't written the lock file yet) — reaping HERE would destroy a
        // LIVE acquirer's lock and put two writers on one dir (red-team).
        // Give the writer a grace window keyed on the lock dir's age.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          let lockDirAgeMs = Infinity;
          try { lockDirAgeMs = Date.now() - statSync(lockDir).mtimeMs; } catch { /* dir gone — retry loop handles */ }
          if (lockDirAgeMs < 10_000) {
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
        }
        // Corrupt lock file — remove it. The holder's liveness is UNKNOWABLE
        // here (unreadable PID), so this counts as a reap for the repair gate.
        // Same serialized claim + revalidation as the dead-PID path (the
        // corrupt case re-confirms the file is still unparseable).
        if (tryReapLockDir(lockDir, null)) {
          reaped = true;
          recordReap(dataDir as string);
        }
      }
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      // We got the lock — write our PID. #2058: seed `refreshed_at` and start
      // the heartbeat so this holder reads as alive-and-working to others.
      const lockPath = join(lockDir, LOCK_FILE);
      const now = Date.now();
      // Atomic tmp+rename, same torn-read protection as the heartbeat: a
      // concurrent poll-reader must see the file complete or absent, never
      // mid-write (a torn read classifies a LIVE holder as corrupt).
      const initTmp = `${lockPath}.tmp-${process.pid}`;
      writeFileSync(initTmp, JSON.stringify({
        pid: process.pid,
        acquired_at: now,
        refreshed_at: now,
        command: process.argv.slice(1).join(' '),
        subcommand: parseGlobalFlags(process.argv.slice(2)).rest[0] ?? null,
        pid_ns: readPidNs(),
        boot_id: readBootId(),
      }), { mode: 0o644 });
      renameSync(initTmp, lockPath);

      const ownerToken = tokenOf({ pid: process.pid, acquired_at: now });
      return { lockDir, acquired: true, lockPath, ownerToken, reaped, heartbeat: startHeartbeat(lockPath, ownerToken) };
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        throw pgliteLockTimeoutError(lockDir);
      }
      // Brief wait before retry
      await new Promise(r => setTimeout(r, 500));
    }
  }

  throw pgliteLockTimeoutError(lockDir);
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  // #2058: stop the heartbeat first so it can't recreate/rewrite the lock file
  // after we remove it.
  if (lock.heartbeat) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = undefined;
  }
  if (!lock.lockDir || !lock.acquired) return;

  // #2058 (codex): only remove the lock if it is STILL ours. If we were reaped
  // past the grace and another process re-acquired, removing its live lock
  // would let a third process in alongside it — the corruption this fix exists
  // to prevent. Unreadable/absent lock falls through to a best-effort remove.
  if (lock.ownerToken) {
    try {
      const raw = JSON.parse(readFileSync(join(lock.lockDir, LOCK_FILE), 'utf-8'));
      if (tokenOf(raw) !== lock.ownerToken) return; // someone else owns it now
    } catch { /* unreadable/gone — fall through to best-effort cleanup */ }
  }

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
