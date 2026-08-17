/**
 * Full-sync reconcile planning (#2828 mass-delete valve, #2426 ever-committed
 * gate) + sync deadline/stall resolution (#1633, #1950). Peeled out of
 * src/commands/sync.ts (containment sprint C13-C14) as a pure move.
 */
import { execFileSync } from 'child_process';
import { parseDurationSeconds } from './sync-concurrency.ts';

/**
 * #2828 full-sync reconcile safety-valve thresholds. A reconcile that would
 * delete more than MASS_RECONCILE_RATIO of the file-backed pages a strategy
 * manages, on a source that holds more than MASS_RECONCILE_MIN_PAGES of them, is
 * treated as a suspected path-comparison bug rather than a real bulk deletion.
 */
export const MASS_RECONCILE_RATIO = 0.5;
export const MASS_RECONCILE_MIN_PAGES = 20;

/**
 * Normalize path separators so a page whose stored `source_path` was written
 * with a different separator than the local OS's `path.relative` produces (e.g.
 * git-derived forward-slash paths on a Windows checkout) still compares equal.
 * Without this, on Windows every file-backed page looks stale and the reconcile
 * wrongly deletes the whole source (#2828).
 */
function normalizeReconcilePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface ReconcilePlan {
  /** Slugs whose backing file is genuinely gone; safe to reconcile-delete. */
  staleSlugs: string[];
  /**
   * File-backed, in-strategy pages the reconcile can act on. This is the
   * denominator for the mass-delete valve (the exact population at risk).
   */
  reconcilableCount: number;
  /**
   * True when `staleSlugs` would sweep more than MASS_RECONCILE_RATIO of
   * `reconcilableCount`, on a source with more than MASS_RECONCILE_MIN_PAGES of
   * them — the mass-delete signal that trips the safety valve.
   */
  massDelete: boolean;
}

/**
 * #2828: decide which file-backed pages a full-sync reconcile should delete, and
 * whether that deletion is suspiciously large. Pure and exported so both the
 * separator normalization and the mass-delete valve are unit-testable without a
 * live engine or a Windows host.
 *
 * @param rows           pages with a non-null `source_path` (deleted_at IS NULL).
 * @param currentFiles   repo-relative paths present in the working tree.
 * @param isSyncablePath predicate excluding metafiles and the wrong strategy.
 */
export function planReconcileDeletes(
  rows: ReadonlyArray<{ slug: string; source_path: string | null }>,
  currentFiles: Iterable<string>,
  isSyncablePath: (p: string) => boolean,
): ReconcilePlan {
  const current = new Set<string>();
  for (const f of currentFiles) current.add(normalizeReconcilePath(f));
  const reconcilable = rows.filter(
    r => r.source_path != null && isSyncablePath(r.source_path),
  );
  const staleSlugs = reconcilable
    .filter(r => !current.has(normalizeReconcilePath(r.source_path as string)))
    .map(r => r.slug);
  const massDelete =
    reconcilable.length > MASS_RECONCILE_MIN_PAGES &&
    staleSlugs.length > reconcilable.length * MASS_RECONCILE_RATIO;
  return { staleSlugs, reconcilableCount: reconcilable.length, massDelete };
}

/**
 * #2426: every repo-relative path that ever appeared as an ADD in git history
 * (rename detection off, so a `git mv` destination still counts as an add).
 * Used by the full-sync reconcile to distinguish "file was committed and later
 * deleted" (genuine delete → reconcile) from "file was NEVER committed"
 * (DB-only write-through → preserve). Returns null when `repoPath` isn't a git
 * work tree or git is unavailable — callers keep the plain-directory behavior.
 * Forward-slash-normalized to match `normalizeReconcilePath` membership tests.
 */
export function listEverCommittedPaths(repoPath: string): Set<string> | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', repoPath, '-c', 'core.quotepath=off', 'log', '--all', '--no-renames',
        '--diff-filter=A', '--format=', '--name-only'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  const set = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line) set.add(line.replace(/\\/g, '/'));
  }
  return set;
}

/**
 * #2828 escape hatch: `GBRAIN_ALLOW_MASS_RECONCILE=1` restores the pre-valve
 * behavior for the rare intentional bulk removal. Env-only (an incident-time
 * override), mirroring `resolveStallAbortSeconds`' pure, env-parameterized shape.
 */
export function massReconcileAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GBRAIN_ALLOW_MASS_RECONCILE === '1';
}

/**
 * Grace window (seconds) between the watchdog's SIGTERM and SIGKILL. SIGTERM
 * gives a responsive loop a clean shutdown; SIGKILL is the starvation backstop.
 */
export const HARD_DEADLINE_GRACE_SEC = 30;

export interface HardDeadlineResolution {
  deadlineMs: number;
  graceMs: number;
  /** Where the deadline came from (for the armed-log line + tests). */
  reason: string;
}

/**
 * #1950: default no-import-progress window before the in-band stall watchdog
 * aborts the drain. Generous on purpose — it must clear one legitimately large
 * file (cross-region, big page) without false-tripping; one file taking longer
 * than this trips it (documented limit). Distinct from the wall-clock hard
 * deadline (whole-run cap) and the lock heartbeat (refreshes regardless of
 * import progress). Env-tunable; <=0 disables.
 */
export const DEFAULT_SYNC_STALL_ABORT_SEC = 900;

export function resolveStallAbortSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GBRAIN_SYNC_STALL_ABORT_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_SYNC_STALL_ABORT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SYNC_STALL_ABORT_SEC;
  return n; // n <= 0 disables the watchdog
}

/**
 * Resolve the out-of-band hard-deadline for a `gbrain sync` invocation (#1633).
 * Pure + argv/env-only so it runs BEFORE `connectEngine` (so a connect-phase hang
 * is also bounded — `timeout-layer-vs-connectengine` learning). DB-plane config
 * (`gbrain config set`) is unreadable pre-connect, so the operator knob is the
 * `GBRAIN_SYNC_MAX_RUNTIME_SECONDS` env var; bare cron is covered by the non-TTY
 * default. Returns null when no watchdog should arm (TTY interactive with no
 * flag, or an explicit opt-out / 0).
 *
 * Precedence: --no-hard-deadline > --hard-deadline > --timeout(non-all) > env >
 * non-TTY default (3600s) > none.
 */
export function resolveSyncHardDeadline(
  args: string[],
  opts: { isTty: boolean; env?: Record<string, string | undefined>; defaultNonTtySec?: number },
): HardDeadlineResolution | null {
  const env = opts.env ?? {};
  const graceMs = HARD_DEADLINE_GRACE_SEC * 1000;
  const mk = (sec: number, reason: string): HardDeadlineResolution | null =>
    sec > 0 ? { deadlineMs: sec * 1000, graceMs, reason } : null;

  if (args.includes('--no-hard-deadline')) return null;

  const hardStr = args.find((a, i) => args[i - 1] === '--hard-deadline');
  if (hardStr !== undefined) {
    // Throws on a bad value (cli.ts surfaces it + exits 1) — same posture as --timeout.
    const sec = parseDurationSeconds(hardStr, '--hard-deadline');
    return mk(sec ?? 0, 'flag:--hard-deadline');
  }

  // --timeout auto-arms a hard backstop at timeout(+grace), but ONLY single-source.
  // For --all, per-source budgets don't collapse to one wall-clock; fall through.
  const isAll = args.includes('--all');
  const timeoutStr = args.find((a, i) => args[i - 1] === '--timeout');
  if (timeoutStr !== undefined && !isAll) {
    const sec = parseDurationSeconds(timeoutStr, '--timeout');
    if (sec && sec > 0) return mk(sec, 'flag:--timeout');
  }

  const envRaw = env.GBRAIN_SYNC_MAX_RUNTIME_SECONDS;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return mk(n, 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS'); // n<=0 disables
  }

  if (!opts.isTty) return mk(opts.defaultNonTtySec ?? 3600, 'default:non-tty');

  return null;
}

/**
 * Compose 1..N AbortSignals into one (CQ2). Undefined inputs are dropped; the
 * result aborts when ANY input aborts. Returns a single signal directly (no
 * wrapper), `undefined` when nothing is set. Used at both performSync call sites
 * so the SIGINT graceful-cancel signal and the per-source `--timeout` signal
 * compose without duplicating `AbortSignal.any` logic.
 */
export function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}
