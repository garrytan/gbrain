/**
 * PGLite WAL-repair orchestrator (#223 / #1670 / #2575).
 *
 * Wraps the pg_resetwal port (`pglite-resetwal.ts`) with everything that makes
 * it safe to run automatically from `PGLiteEngine.connect()`:
 *
 *   validate (read-only, fail-closed) → back up (rename, not copy) →
 *   resetWal → retry create() once → restore on failure.
 *
 * Safety posture (eng-review 1A/2A/3A/4A + codex round):
 *  - WAL surgery only runs under a CLEANLY-acquired data-dir lock. A reaped
 *    acquisition (dead-PID or corrupt-lock-file reap — the only reaps that
 *    exist post-#2348) refuses with `'possibly-live-writer'`; this module
 *    never force-removes `.gbrain-lock`.
 *  - Backup is a whole-`pg_wal/`-directory rename into a sibling dir (O(1),
 *    zero extra disk — a real brain's pg_wal is ~144MB and a copy would
 *    transiently double it, ENOSPC-ing exactly on disk-pressure machines);
 *    only the 8KB `global/pg_control` is copied (it is mutated in place).
 *  - Restore never deletes anything and never leaves the dir without a valid
 *    pg_control: control is restored first (atomic tmp+rename), then the reset
 *    pg_wal is renamed ASIDE into the backup dir and the original renamed back.
 *  - A cooldown sidecar + episode-scoped backups bound the reconnect loops
 *    (autopilot ~10s tick under launchd KeepAlive; minion supervisor): repeated
 *    attempts inside one corruption episode reuse the episode's first backup
 *    (the pre-damage forensic state) instead of stacking new ones, and a
 *    recently-failed attempt skips repair entirely for the cooldown window.
 *
 * `attemptWalRepairAndRetry` NEVER throws — `connect()`'s catch consumes the
 * discriminated union, so no new code path can bypass the engine's single
 * lock-release-then-throw site.
 *
 * Env knobs (incident escape hatches, env-only by design):
 *   GBRAIN_PGLITE_WAL_REPAIR=off                 disable auto-repair
 *   GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS    default 3600
 */
import {
  existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync,
  mkdirSync, rmSync, renameSync,
} from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resetWal, writeFileAtomicSynced, WalResetUnsupportedError, PG_CONTROL_FILE_SIZE, isWalSegmentName } from './pglite-resetwal.ts';
import { msSinceLastReap, isProcessAlive } from './pglite-lock.ts';

// A recent reap on this data dir — by ANY process — means a holder that may
// still be alive lost its lock; auto WAL surgery stays off until the window
// clears (security review: the in-process `reaped` flag alone let the NEXT
// acquirer look clean while the reaped holder was still writing).
const REAP_QUARANTINE_MS = 10 * 60 * 1000;

const BACKUP_DIR_MARKER = '.wal-repair-backup-';
const SIDECAR_SUFFIX = '.wal-repair-attempt.json';
const MAX_SIDECAR_ATTEMPTS = 10;
const KEEP_EPISODES = 3;
const DEFAULT_COOLDOWN_SECONDS = 3600;

export interface WalRepairReceipt {
  dataDir: string;
  /** Sibling dir holding the pre-repair state: `<dataDir>.wal-repair-backup-<ts>/` */
  backupPath: string;
  /** Relative paths preserved in the backup (e.g. 'pg_wal/', 'postmaster.pid', 'global/pg_control'). */
  backedUpFiles: string[];
  /** True when this attempt reused an open episode's existing backup. */
  reusedEpisodeBackup: boolean;
  resetSegment: string;
  timelineId: number;
  walSegSize: number;
  repairedAt: string; // ISO
}

export type WalRepairValidation =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing-dir' | 'not-pglite-layout' | 'unsupported-pg-version' | 'bad-pg-control';
      detail: string;
    };

export interface RestoreResult {
  restored: boolean;
  steps: string[];
  detail?: string;
}

/**
 * Thrown by `repairPgliteWal` when the reset failed AFTER the backup was
 * taken. Carries the receipt and the result of the best-effort restore so the
 * seam can report `restored` HONESTLY instead of assuming the restore worked
 * (the `failed-not-restored` message arm depends on this being truthful).
 */
export class WalRepairError extends Error {
  constructor(
    message: string,
    readonly receipt: WalRepairReceipt,
    readonly restore: RestoreResult,
  ) {
    super(message);
    this.name = 'WalRepairError';
  }
}

export type WalRepairAttempt<T> =
  | { status: 'repaired'; db: T; receipt: WalRepairReceipt }
  | {
      status: 'skipped';
      reason: 'disabled' | 'validation-failed' | 'possibly-live-writer' | 'recently-failed';
      detail: string;
    }
  | { status: 'failed'; receipt: WalRepairReceipt | null; restored: boolean; repairError: string };

export interface PgliteDirDiagnosis {
  exists: boolean;
  postmasterPid: boolean;
  pgControlOk: boolean;
  pgVersion: string | null;
  walSegments: string[];
  lockHeld: boolean;
  lockHolderPid: number | null;
  /** Sibling `*.wal-repair-backup-*` dirs, newest first. */
  backupDirs: string[];
  /** Recent repair attempts from the sidecar, newest last. */
  recentAttempts: Array<{ ts: number; outcome: 'repaired' | 'failed' }>;
  verdict: 'looks-healthy' | 'wal-corruption-likely' | 'locked' | 'missing' | 'unsupported-layout';
  detail: string;
}

interface RepairSidecar {
  /** ts of the first failed attempt of the open episode; null = no open episode. */
  episodeStartedAt: number | null;
  /** The open episode's (first) backup dir — the pre-damage forensic state. */
  episodeBackupPath: string | null;
  attempts: Array<{ ts: number; outcome: 'repaired' | 'failed'; backupPath: string | null }>;
}

function sidecarPath(dataDir: string): string {
  return `${dataDir}${SIDECAR_SUFFIX}`;
}

export function readRepairSidecar(dataDir: string): RepairSidecar {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(dataDir), 'utf-8')) as Partial<RepairSidecar>;
    return {
      episodeStartedAt: typeof raw.episodeStartedAt === 'number' ? raw.episodeStartedAt : null,
      episodeBackupPath: typeof raw.episodeBackupPath === 'string' ? raw.episodeBackupPath : null,
      attempts: Array.isArray(raw.attempts)
        ? raw.attempts.filter(
            (a): a is RepairSidecar['attempts'][number] =>
              !!a && typeof a.ts === 'number' && (a.outcome === 'repaired' || a.outcome === 'failed'),
          )
        : [],
    };
  } catch {
    return { episodeStartedAt: null, episodeBackupPath: null, attempts: [] };
  }
}

function writeRepairSidecar(dataDir: string, sidecar: RepairSidecar): void {
  try {
    // Atomic tmp+rename: a kill/power-loss mid-write must not truncate the
    // sidecar to invalid JSON (readRepairSidecar would then silently reset the
    // episode/cooldown state — codex review). rename is atomic; a torn tmp is
    // discarded on the next write.
    const tmp = `${sidecarPath(dataDir)}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sidecar), { mode: 0o644 });
    renameSync(tmp, sidecarPath(dataDir));
  } catch { /* best-effort — a sidecar write failure must never block recovery */ }
}

/**
 * Record a real repair attempt (repaired|failed) and manage episode state:
 * a `failed` attempt opens an episode (if none is open) pinning its backup as
 * the episode backup; a VERIFIED `repaired` attempt closes the episode and
 * prunes retained backups to the newest KEEP_EPISODES. The manual command
 * passes `closeEpisode: false` — its "repaired" is unverified (the next
 * connect proves it), and closing+pruning on unverified success let repeated
 * manual runs delete the pre-damage forensic backup (red-team finding); the
 * episode instead closes on the next successful connect
 * (`closeRepairEpisodeIfOpen`).
 *
 * Re-pin rule (red-team finding): a restore MOVES pg_wal back out of the
 * backup, gutting it — if a later failed attempt took a FRESH backup while an
 * episode pinned a gutted dir, the pin moves to the fresh backup so the
 * episode's protected copy is always one that still holds pg_wal.
 */
export function recordRepairAttempt(
  dataDir: string,
  outcome: 'repaired' | 'failed',
  backupPath: string | null,
  opts?: { closeEpisode?: boolean },
): void {
  const sidecar = readRepairSidecar(dataDir);
  sidecar.attempts.push({ ts: Date.now(), outcome, backupPath });
  if (sidecar.attempts.length > MAX_SIDECAR_ATTEMPTS) {
    sidecar.attempts = sidecar.attempts.slice(-MAX_SIDECAR_ATTEMPTS);
  }
  if (outcome === 'failed') {
    if (sidecar.episodeStartedAt === null) {
      sidecar.episodeStartedAt = Date.now();
      sidecar.episodeBackupPath = backupPath;
    } else if (
      backupPath &&
      backupPath !== sidecar.episodeBackupPath &&
      (!sidecar.episodeBackupPath || !existsSync(join(sidecar.episodeBackupPath, 'pg_wal')))
    ) {
      sidecar.episodeBackupPath = backupPath;
    }
  } else if (opts?.closeEpisode !== false) {
    sidecar.episodeStartedAt = null;
    sidecar.episodeBackupPath = null;
  }
  writeRepairSidecar(dataDir, sidecar);
  if (outcome === 'repaired' && opts?.closeEpisode !== false) {
    pruneRepairBackups(dataDir);
  }
}

/**
 * Close any open repair episode after a HEALTHY connect (red-team finding: a
 * plain successful open never touched the sidecar, so an episode stayed open
 * forever — doctor kept reporting corruption-likely, and a weeks-stale
 * episode backup could be reused over much newer data). Cheap no-op when no
 * sidecar exists. Called by PGLiteEngine.connect() on every non-repaired
 * success and by the seam's 'repaired' arm via recordRepairAttempt.
 */
export function closeRepairEpisodeIfOpen(dataDir: string): void {
  try {
    if (!existsSync(sidecarPath(dataDir))) return;
    const sidecar = readRepairSidecar(dataDir);
    if (sidecar.episodeStartedAt === null) return;
    sidecar.episodeStartedAt = null;
    sidecar.episodeBackupPath = null;
    writeRepairSidecar(dataDir, sidecar);
    pruneRepairBackups(dataDir);
  } catch { /* best-effort */ }
}

/**
 * Cooldown: true when the last FAILED attempt is inside the cooldown window.
 * DELIBERATE: a later successful repair does NOT clear the cooldown — repeated
 * corruption right after a "success" usually means the unclean-shutdown
 * genesis is still active, and looping surgery would silently eat a WAL tail
 * per cycle. The manual `gbrain pglite-repair` command bypasses the cooldown.
 */
export function repairCooldownActive(dataDir: string): { active: boolean; detail: string } {
  const seconds = Number(process.env.GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS ?? DEFAULT_COOLDOWN_SECONDS);
  const windowMs = (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_COOLDOWN_SECONDS) * 1000;
  if (windowMs === 0) return { active: false, detail: 'cooldown disabled (0s)' };
  const sidecar = readRepairSidecar(dataDir);
  // Repaired-loop guard (red-team finding): a crash loop where every reopen
  // aborts but repair "succeeds" each time would silently discard a WAL tail
  // per cycle with no failed attempt ever recorded. Two successful repairs
  // inside one window = the corruption genesis is active — stop auto-repair
  // and let doctor escalate.
  const repairedInWindow = sidecar.attempts.filter(
    (a) => a.outcome === 'repaired' && Date.now() - a.ts >= 0 && Date.now() - a.ts < windowMs,
  ).length;
  if (repairedInWindow >= 2) {
    return {
      active: true,
      detail:
        `auto-repair already ran ${repairedInWindow}x in the last ${windowMs / 1000}s — repeated ` +
        'corruption means the unclean-shutdown genesis is still active; refusing to silently ' +
        'discard another WAL tail. Run `gbrain doctor`, or `gbrain pglite-repair` manually.',
    };
  }
  const lastFailed = [...sidecar.attempts].reverse().find((a) => a.outcome === 'failed');
  if (!lastFailed) return { active: false, detail: 'no prior failed attempt' };
  const ageMs = Date.now() - lastFailed.ts;
  // Clock skew (unclean-reboot recovery is exactly when clocks step): a
  // negative age means the recorded ts is in the future — treat as expired
  // rather than suppressing auto-repair until wall-clock catches up.
  if (ageMs >= 0 && ageMs < windowMs) {
    return {
      active: true,
      detail:
        `last auto-repair attempt failed ${Math.round(ageMs / 1000)}s ago ` +
        `(cooldown ${windowMs / 1000}s — set GBRAIN_PGLITE_WAL_REPAIR_COOLDOWN_SECONDS=0 to bypass, ` +
        `or run \`gbrain pglite-repair\` manually)`,
    };
  }
  return { active: false, detail: 'cooldown expired' };
}

/** Sibling `*.wal-repair-backup-*` dirs for this data dir, newest first. */
export function listRepairBackups(dataDir: string): string[] {
  try {
    const parent = dirname(dataDir);
    const prefix = `${basename(dataDir)}${BACKUP_DIR_MARKER}`;
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

/**
 * Keep the newest KEEP_EPISODES backups; never prune the open episode's backup.
 * Runs only after a successful repair (episode close) — never mid-incident.
 */
export function pruneRepairBackups(dataDir: string): void {
  const sidecar = readRepairSidecar(dataDir);
  const backups = listRepairBackups(dataDir); // newest first
  const keep = new Set(backups.slice(0, KEEP_EPISODES));
  if (sidecar.episodeBackupPath) keep.add(sidecar.episodeBackupPath);
  for (const dir of backups) {
    if (!keep.has(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export function walRepairEnabled(): boolean {
  return process.env.GBRAIN_PGLITE_WAL_REPAIR !== 'off';
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Read-only, fail-closed: does this look like a PG17 pglite data dir we know
 * how to repair? Tolerates the `.gbrain-lock` entry (the lock lives INSIDE the
 * data dir). Refuses symlinked components (codex 14.8 — a symlinked `pg_wal`
 * or `pg_control` could redirect the backup/restore renames at unrelated
 * files; same confinement discipline as the v0.42.55.0 security wave).
 */
export function validateWalRepairTarget(dataDir: string): WalRepairValidation {
  if (!dataDir) return { ok: false, reason: 'missing-dir', detail: 'no data dir configured (in-memory engine)' };
  if (!existsSync(dataDir)) return { ok: false, reason: 'missing-dir', detail: `${dataDir} does not exist` };
  if (
    isSymlink(dataDir) ||
    isSymlink(join(dataDir, 'pg_wal')) ||
    // `global/` itself must be checked too: lstat on global/pg_control follows
    // the INTERMEDIATE symlink, so a symlinked global/ would pass and surgery
    // would write a forged pg_control through it into a foreign directory
    // (security review finding).
    isSymlink(join(dataDir, 'global')) ||
    isSymlink(join(dataDir, 'global', 'pg_control'))
  ) {
    return { ok: false, reason: 'not-pglite-layout', detail: 'data dir, pg_wal, global, or pg_control is a symlink — refusing to run rename-based repair through symlinks' };
  }
  let pgVersion: string;
  try {
    pgVersion = readFileSync(join(dataDir, 'PG_VERSION'), 'utf-8').trim();
  } catch {
    return { ok: false, reason: 'not-pglite-layout', detail: `no readable PG_VERSION in ${dataDir}` };
  }
  if (pgVersion !== '17') {
    return { ok: false, reason: 'unsupported-pg-version', detail: `PG_VERSION is ${pgVersion}, this repair understands 17 only` };
  }
  if (!existsSync(join(dataDir, 'base'))) {
    return { ok: false, reason: 'not-pglite-layout', detail: `no base/ directory in ${dataDir}` };
  }
  // Live-postmaster refusal (red-team finding): real pg_resetwal refuses when
  // postmaster.pid exists. A LIVE native Postgres 17 data dir passes every
  // layout check here — without this guard, `gbrain pglite-repair --path` at
  // such a dir would rename pg_wal out from under a running postmaster the
  // gbrain lock cannot see. A stale pid file (dead process) stays repairable.
  try {
    const pidRaw = readFileSync(join(dataDir, 'postmaster.pid'), 'utf-8').split('\n')[0]?.trim();
    const pid = Number(pidRaw);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      return {
        ok: false,
        reason: 'not-pglite-layout',
        detail: `postmaster.pid names a LIVE process (PID ${pid}) — refusing WAL surgery on a possibly-running database`,
      };
    }
  } catch { /* no postmaster.pid or unreadable — fine */ }
  const controlPath = join(dataDir, 'global', 'pg_control');
  try {
    const size = statSync(controlPath).size;
    if (size !== PG_CONTROL_FILE_SIZE) {
      return { ok: false, reason: 'bad-pg-control', detail: `pg_control is ${size} bytes, expected ${PG_CONTROL_FILE_SIZE}` };
    }
  } catch {
    return { ok: false, reason: 'bad-pg-control', detail: `no readable ${controlPath}` };
  }
  return { ok: true };
}

/** Read-only diagnosis for `gbrain doctor` and `pglite-repair --dry-run`. */
export function inspectPgliteDataDir(dataDir: string): PgliteDirDiagnosis {
  const sidecar = readRepairSidecar(dataDir);
  const base: Omit<PgliteDirDiagnosis, 'verdict' | 'detail'> = {
    exists: !!dataDir && existsSync(dataDir),
    postmasterPid: !!dataDir && existsSync(join(dataDir, 'postmaster.pid')),
    pgControlOk: false,
    pgVersion: null,
    walSegments: [],
    lockHeld: false,
    lockHolderPid: null,
    backupDirs: listRepairBackups(dataDir),
    recentAttempts: sidecar.attempts.map(({ ts, outcome }) => ({ ts, outcome })),
  };
  if (!base.exists) {
    return { ...base, verdict: 'missing', detail: `${dataDir || '(in-memory)'} does not exist` };
  }
  try {
    base.pgVersion = readFileSync(join(dataDir, 'PG_VERSION'), 'utf-8').trim();
  } catch { /* leave null */ }
  try {
    base.pgControlOk = statSync(join(dataDir, 'global', 'pg_control')).size === PG_CONTROL_FILE_SIZE;
  } catch { /* leave false */ }
  try {
    base.walSegments = readdirSync(join(dataDir, 'pg_wal')).filter(isWalSegmentName).sort();
  } catch { /* leave empty */ }
  try {
    const lockData = JSON.parse(readFileSync(join(dataDir, '.gbrain-lock', 'lock'), 'utf-8')) as { pid?: number };
    if (typeof lockData.pid === 'number' && isProcessAlive(lockData.pid)) {
      base.lockHeld = true;
      base.lockHolderPid = lockData.pid;
    }
  } catch { /* no lock / unreadable — not held */ }

  if (base.lockHeld) {
    return { ...base, verdict: 'locked', detail: `data dir lock held by live PID ${base.lockHolderPid}` };
  }
  const validation = validateWalRepairTarget(dataDir);
  if (!validation.ok) {
    return { ...base, verdict: 'unsupported-layout', detail: validation.detail };
  }
  if (base.postmasterPid || sidecar.episodeStartedAt !== null) {
    return {
      ...base,
      verdict: 'wal-corruption-likely',
      detail: base.postmasterPid
        ? 'stale postmaster.pid present — an unclean shutdown left WAL/checkpoint state torn'
        : 'an unresolved repair episode is open (a prior auto-repair attempt failed)',
    };
  }
  return { ...base, verdict: 'looks-healthy', detail: 'layout validates; no unclean-shutdown markers on disk' };
}

/**
 * Mechanical repair: (backup unless reusing an episode backup) → resetWal.
 * Backup = rename the ENTIRE pg_wal/ dir + postmaster.pid into the backup dir
 * (covers archive_status/summaries too — restore is truly byte-identical) and
 * COPY the 8KB pg_control. If resetWal throws after the backup was taken, a
 * best-effort restore runs before the error propagates — this function never
 * leaves the dir backed-up-but-unrepaired without attempting to put it back.
 */
export async function repairPgliteWal(
  dataDir: string,
  opts?: { reuseBackupPath?: string },
): Promise<WalRepairReceipt> {
  const validation = validateWalRepairTarget(dataDir);
  if (!validation.ok) {
    throw new WalResetUnsupportedError(`refusing repair: ${validation.detail}`);
  }

  // Defense-in-depth (security + red-team reviews): the reuse path comes from
  // the user-writable sidecar JSON — only honor it when it is a real,
  // non-symlink, traversal-free sibling backup dir of THIS data dir that
  // STILL CONTAINS pg_wal (a restore MOVES pg_wal back out, gutting the
  // backup; reusing a gutted backup would let resetWal unlink the only
  // surviving WAL copy in place). Anything else gets a fresh backup.
  const safeReusePath =
    opts?.reuseBackupPath &&
    opts.reuseBackupPath.startsWith(`${dataDir}${BACKUP_DIR_MARKER}`) &&
    !opts.reuseBackupPath.includes('..') &&
    existsSync(opts.reuseBackupPath) &&
    !isSymlink(opts.reuseBackupPath) &&
    existsSync(join(opts.reuseBackupPath, 'pg_wal')) &&
    !isSymlink(join(opts.reuseBackupPath, 'pg_wal'))
      ? opts.reuseBackupPath
      : undefined;
  const backedUpFiles: string[] = [];
  const reusedEpisodeBackup = !!safeReusePath;

  let backupPath: string;
  if (reusedEpisodeBackup) {
    // Episode reuse: the open episode's backup still holds pg_wal (enforced by
    // safeReusePath — a restore MOVES pg_wal back out and guts the backup; a
    // gutted backup must never be reused or resetWal would unlink the only
    // surviving WAL copy in place). resetWal's own deletion loops clear the
    // current segments.
    backupPath = safeReusePath!;
  } else {
    // Fresh backup dir: mkdir with recursive:false and fail-closed on
    // collision (red-team: a predictable pre-existing dir or symlink-to-dir
    // would silently receive the renames, and restore would later read
    // pg_control bytes back OUT of it). Retry with a suffix, then verify we
    // created a real directory.
    backupPath = `${dataDir}${BACKUP_DIR_MARKER}${Date.now()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(backupPath, { recursive: false });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST' && attempt < 5) {
          backupPath = `${dataDir}${BACKUP_DIR_MARKER}${Date.now()}-${attempt + 1}`;
          continue;
        }
        throw err;
      }
    }
    if (isSymlink(backupPath) || !statSync(backupPath).isDirectory()) {
      throw new WalResetUnsupportedError(`backup path ${backupPath} is not a real directory`);
    }
  }
  // Track whether the backup dir received anything, so refusal paths can prune
  // an empty leftover (adversarial review F11: doctor would otherwise inventory
  // an empty `<dataDir>.wal-repair-backup-*` as a real backup).
  const pruneEmptyBackup = () => {
    if (reusedEpisodeBackup) return;
    try { if (readdirSync(backupPath).length === 0) rmSync(backupPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  const receipt: WalRepairReceipt = {
    dataDir,
    backupPath,
    backedUpFiles,
    reusedEpisodeBackup,
    resetSegment: '',
    timelineId: 0,
    walSegSize: 0,
    repairedAt: new Date().toISOString(),
  };

  if (!reusedEpisodeBackup) {
    // Backup phase. Once the FIRST rename lands, any failure here must run a
    // restore and surface via WalRepairError — a generic throw would read as
    // "dir never touched" while pg_wal is actually sitting in the backup dir
    // (red-team finding).
    let backupStarted = false;
    try {
      const walDir = join(dataDir, 'pg_wal');
      if (existsSync(walDir)) {
        await rename(walDir, join(backupPath, 'pg_wal'));
        backupStarted = true;
        backedUpFiles.push('pg_wal/');
      }
      const pidFile = join(dataDir, 'postmaster.pid');
      if (existsSync(pidFile)) {
        await rename(pidFile, join(backupPath, 'postmaster.pid'));
        backupStarted = true;
        backedUpFiles.push('postmaster.pid');
      }
      const control = await readFile(join(dataDir, 'global', 'pg_control'));
      await writeFileAtomicSynced(backupPath, 'pg_control', Buffer.from(control));
      backedUpFiles.push('global/pg_control');
    } catch (err) {
      if (!backupStarted) { pruneEmptyBackup(); throw err; } // dir genuinely untouched
      const restore = await restoreWalBackup(receipt);
      throw new WalRepairError(String((err as Error)?.message ?? err), receipt, restore);
    }
  }

  try {
    const result = await resetWal(dataDir);
    receipt.resetSegment = result.resetSegment;
    receipt.timelineId = result.timelineId;
    receipt.walSegSize = result.walSegSize;
  } catch (err) {
    // Best-effort restore — never leave backed-up-but-unrepaired. The result
    // is THREADED OUT via WalRepairError so callers can report `restored`
    // honestly (review finding: discarding it let 'failed-restored' lie).
    const restore = await restoreWalBackup(receipt);
    throw new WalRepairError(String((err as Error)?.message ?? err), receipt, restore);
  }
  return receipt;
}

/**
 * Put the data dir back to the backed-up state. Overwrite order (eng-review
 * 3A): pg_control FIRST (atomic tmp+rename — no instant leaves the dir without
 * a valid control file), then the pg_wal dir swap (reset dir renamed ASIDE
 * into the backup dir — nothing is ever deleted during restore), postmaster.pid
 * deliberately NOT restored (it was stale by definition). Mtime guard
 * (eng-review 1A): refuses when the current pg_wal contains segments newer
 * than the backup that this repair did not write — a live writer advanced the
 * dir; renaming it away would destroy real WAL.
 * Never throws — reports `{restored:false, detail}` instead.
 */
export async function restoreWalBackup(receipt: WalRepairReceipt): Promise<RestoreResult> {
  const steps: string[] = [];
  try {
    const { dataDir, backupPath } = receipt;
    const walDir = join(dataDir, 'pg_wal');
    const backupWal = join(backupPath, 'pg_wal');
    const backupControl = join(backupPath, 'pg_control');

    // Symlinked backup CHILDREN would let restore read attacker-chosen
    // pg_control bytes or rename a foreign pg_wal into the data dir
    // (red-team) — the top-level checks don't cover them.
    if (isSymlink(backupWal) || isSymlink(backupControl)) {
      return { restored: false, steps, detail: `backup at ${backupPath} contains symlinked components — refusing restore` };
    }

    // Mtime guard: any foreign WAL segment newer than this repair's start?
    const backupTs = Date.parse(receipt.repairedAt);
    if (existsSync(walDir)) {
      for (const f of readdirSync(walDir)) {
        if (!isWalSegmentName(f) || f === receipt.resetSegment) continue;
        try {
          if (statSync(join(walDir, f)).mtimeMs > backupTs) {
            return {
              restored: false,
              steps,
              detail: `mtime-guard: ${f} in pg_wal is newer than the backup — a live writer may have advanced this dir; refusing to swap WAL back`,
            };
          }
        } catch { /* statable race — ignore */ }
      }
    }

    if (existsSync(backupControl)) {
      const control = await readFile(backupControl);
      await writeFileAtomicSynced(join(dataDir, 'global'), 'pg_control', Buffer.from(control));
      steps.push('pg_control restored');
    }

    if (existsSync(backupWal)) {
      if (existsSync(walDir)) {
        const aside = join(backupPath, `pg_wal.reset-aside-${Date.now()}`);
        await rename(walDir, aside);
        steps.push(`reset pg_wal set aside at ${aside}`);
      }
      await rename(backupWal, walDir);
      steps.push('pg_wal restored');
    }
    if (steps.length === 0) {
      // A missing/empty backup means nothing was put back — never claim
      // restoration that did not happen (the 'failed-not-restored' honesty arm).
      return { restored: false, steps, detail: `nothing to restore from backup at ${backupPath} (missing or empty)` };
    }
    return { restored: true, steps };
  } catch (err) {
    return {
      restored: false,
      steps,
      detail: `restore failed after [${steps.join(', ') || 'nothing'}]: ${String((err as Error)?.message ?? err)}`,
    };
  }
}

/**
 * The engine seam. NEVER throws. Gates (in order): kill-switch → live-writer
 * (reaped lock) → layout validation → cooldown. Then: repair (reusing the open
 * episode's backup when present) → retry create() ONCE → on failure, restore
 * and record. Prints a repair-start stderr line the instant surgery begins so
 * a timeout-killed attempt is self-explaining (eng-review 4A).
 */
export async function attemptWalRepairAndRetry<T>(
  dataDir: string,
  retryCreate: () => Promise<T>,
  opts?: { reaped?: boolean },
): Promise<WalRepairAttempt<T>> {
  try {
    if (!walRepairEnabled()) {
      return { status: 'skipped', reason: 'disabled', detail: 'GBRAIN_PGLITE_WAL_REPAIR=off' };
    }
    if (opts?.reaped) {
      return {
        status: 'skipped',
        reason: 'possibly-live-writer',
        detail:
          'this process acquired the data-dir lock by reaping a prior holder — ' +
          'another gbrain process may still be using this brain. Stop it (or confirm ' +
          'none is running), then re-run; a cleanly-acquired lock enables auto-repair.',
      };
    }
    const sinceReap = msSinceLastReap(dataDir);
    // `>= 0` guard (adversarial review F5): a future-dated marker (clock step
    // during the unclean-reboot recovery this feature exists for) yields a
    // negative age; treat it as expired rather than quarantining forever —
    // same policy as repairCooldownActive.
    if (sinceReap !== null && sinceReap >= 0 && sinceReap < REAP_QUARANTINE_MS) {
      return {
        status: 'skipped',
        reason: 'possibly-live-writer',
        detail:
          `a lock on this brain was reaped ${Math.round(sinceReap / 1000)}s ago (possibly from a ` +
          'still-live process) — auto-repair stays off for ' +
          `${REAP_QUARANTINE_MS / 60000} minutes after any reap. Confirm no gbrain process is ` +
          'running, then re-run or use `gbrain pglite-repair`.',
      };
    }
    const validation = validateWalRepairTarget(dataDir);
    if (!validation.ok) {
      return { status: 'skipped', reason: 'validation-failed', detail: validation.detail };
    }
    const cooldown = repairCooldownActive(dataDir);
    if (cooldown.active) {
      return { status: 'skipped', reason: 'recently-failed', detail: cooldown.detail };
    }

    try {
      process.stderr.write(
        `gbrain: PGLite failed to open ${dataDir} — attempting automatic WAL repair ` +
        `(backup at ${dataDir}${BACKUP_DIR_MARKER}*). If this command times out, run ` +
        `\`gbrain pglite-repair\` to finish. Disable auto-repair with GBRAIN_PGLITE_WAL_REPAIR=off.\n`,
      );
    } catch { /* EPIPE under a closed-pipe daemon parent must not read as surgery failure */ }

    const sidecar = readRepairSidecar(dataDir);
    // Stale-episode bound (red-team): an episode left open for a long time
    // means the pinned backup may predate real data — take a fresh backup.
    const episodeFresh =
      sidecar.episodeStartedAt !== null &&
      Date.now() - sidecar.episodeStartedAt >= 0 &&
      Date.now() - sidecar.episodeStartedAt < 24 * 3600 * 1000;
    let receipt: WalRepairReceipt;
    try {
      receipt = await repairPgliteWal(dataDir, {
        reuseBackupPath: episodeFresh ? sidecar.episodeBackupPath ?? undefined : undefined,
      });
    } catch (err) {
      if (err instanceof WalRepairError) {
        // Reset failed AFTER the backup was taken; report the best-effort
        // restore's REAL outcome (hardcoding restored:true here made the
        // 'failed-restored' message lie when the restore itself failed).
        recordRepairAttempt(dataDir, 'failed', err.receipt.backupPath);
        return {
          status: 'failed',
          receipt: err.receipt,
          restored: err.restore.restored,
          repairError: err.message +
            (err.restore.restored ? '' : ` [restore: ${err.restore.detail}]`),
        };
      }
      // Pre-backup refusal (validation) — the dir was never touched, so there
      // is nothing to restore and `restored: true` reads as "dir intact".
      recordRepairAttempt(dataDir, 'failed', sidecar.episodeBackupPath);
      return {
        status: 'failed',
        receipt: null,
        restored: true,
        repairError: String((err as Error)?.message ?? err),
      };
    }

    try {
      const db = await retryCreate();
      recordRepairAttempt(dataDir, 'repaired', receipt.backupPath);
      return { status: 'repaired', db, receipt };
    } catch (retryErr) {
      const restore = await restoreWalBackup(receipt);
      recordRepairAttempt(dataDir, 'failed', receipt.backupPath);
      return {
        status: 'failed',
        receipt,
        restored: restore.restored,
        repairError: String((retryErr as Error)?.message ?? retryErr) +
          (restore.restored ? '' : ` [restore: ${restore.detail}]`),
      };
    }
  } catch (err) {
    // The seam's never-throw contract is load-bearing (single lock-release site
    // in connect()'s catch) — any unexpected error degrades to 'failed'.
    // `restored: true` here is honest: repairPgliteWal/restoreWalBackup handle
    // their own mutation failures via WalRepairError above, so a throw landing
    // HERE happened outside surgery and the dir is untouched (red-team: the
    // old restored:false told users to manually restore a nonexistent backup).
    try { recordRepairAttempt(dataDir, 'failed', null); } catch { /* best-effort — cooldown still engages when possible */ }
    return {
      status: 'failed',
      receipt: null,
      restored: true,
      repairError: `unexpected repair-path error: ${String((err as Error)?.message ?? err)}`,
    };
  }
}
