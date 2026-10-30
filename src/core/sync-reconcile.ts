/**
 * Full-sync reconcile planning (#2828 mass-delete valve, #2426 ever-committed
 * gate) + sync deadline/stall resolution (#1633, #1950). Peeled out of
 * src/commands/sync.ts (containment sprint C13-C14) as a pure move.
 */
import { execFileSync } from './spawn.ts';
import { parseDurationSeconds } from './sync-concurrency.ts';
import { resolveStallAbortSecondsFromEnv } from './stall-env.ts';
import { gitChildEnv } from './git-env.ts';

/**
 * #2828 full-sync reconcile safety-valve thresholds. A reconcile that would
 * delete more than MASS_RECONCILE_RATIO of the file-backed pages a strategy
 * manages, on a source that holds more than MASS_RECONCILE_MIN_PAGES of them, is
 * treated as a suspected path-comparison bug rather than a real bulk deletion.
 */
export const MASS_RECONCILE_RATIO = 0.5;
export const MASS_RECONCILE_MIN_PAGES = 20;

/**
 * #7130: absolute caps on what one sync run deletes (a managed pass, a classic full reconcile, a working-tree sync), on
 * top of the 50% valve, which a large source never trips (19,325 deletes were 4% of a 478k-page source). A run over
 * either cap withholds its deletes like the valve does.
 * `sync.max_deletes` (default 500) is a count; `sync.max_delete_ratio` (default 0.01) a share of the source's file-backed
 * pages, applied only to a pass deleting more than `SYNC_DELETE_RATIO_FLOOR` pages so that a small brain's ordinary
 * deletion of a folder is not withheld. A source overrides either with `sync.max_deletes.source.<id>` /
 * `sync.max_delete_ratio.source.<id>`.
 */
export const DEFAULT_SYNC_MAX_DELETES = 500;
export const DEFAULT_SYNC_MAX_DELETE_RATIO = 0.01;
export const SYNC_DELETE_RATIO_FLOOR = 50;
export const SYNC_MAX_DELETES_KEY = 'sync.max_deletes';
export const SYNC_MAX_DELETE_RATIO_KEY = 'sync.max_delete_ratio';

export interface SyncDeleteCaps { maxDeletes: number; maxDeleteRatio: number }
/** Which limit a pass's deletes went over: the #2828 valve (`mass_ratio`), or a #7130 cap. */
export type SyncDeleteTrip = 'mass_ratio' | 'max_deletes' | 'max_delete_ratio';

/** A stored cap value, or null when it is unset or not a valid value (the default then applies). */
export function parseSyncDeleteCap(key: typeof SYNC_MAX_DELETES_KEY | typeof SYNC_MAX_DELETE_RATIO_KEY, raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  if (key === SYNC_MAX_DELETES_KEY) return Number.isInteger(value) ? value : null;
  return value <= 1 ? value : null;
}

/** `gbrain config set`'s refusal of an invalid #7130 delete-safety value (null: valid). */
export function deleteSafetyConfigRefusal(key: string, value: string): string | null {
  if (key === 'purge.retention_hours') return parsePurgeRetentionHours(value) === null ? `purge.retention_hours must be a whole number of hours, at least ${MIN_PURGE_RETENTION_HOURS}; nothing was written.` : null;
  if (key.startsWith('sync.apply_held_deletions')) return ['true', 'false'].includes(value.trim().toLowerCase()) ? null : `${key} must be true or false; nothing was written.`;
  const base = key.startsWith(SYNC_MAX_DELETES_KEY + '.') || key === SYNC_MAX_DELETES_KEY ? SYNC_MAX_DELETES_KEY : SYNC_MAX_DELETE_RATIO_KEY;
  if (parseSyncDeleteCap(base, value) !== null) return null;
  return base === SYNC_MAX_DELETES_KEY ? `${key} must be a whole number of pages, 0 or more; nothing was written.` : `${key} must be a number from 0 to 1 (a share of the source's file-backed pages); nothing was written.`;
}

/**
 * #7130: how long a soft-deleted page waits before the autopilot purge phase may purge it (`purge.retention_hours`,
 * default 72). The setting only lengthens the window: every soft delete promises a 72-hour restore (the 'restore_72h'
 * undo of an automatic repair, the recovery window sync deletes document), so no value below 72 is accepted. The manual
 * `gbrain pages purge-deleted` takes its own `--older-than`, under consent.
 */
export const DEFAULT_PURGE_RETENTION_HOURS = 72;
export const MIN_PURGE_RETENTION_HOURS = 72;
export function parsePurgeRetentionHours(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= MIN_PURGE_RETENTION_HOURS ? value : null;
}
export async function readPurgeRetentionHours(engine: { getConfig(key: string): Promise<string | null> }): Promise<number> {
  return parsePurgeRetentionHours(await engine.getConfig('purge.retention_hours')) ?? DEFAULT_PURGE_RETENTION_HOURS;
}

/** The caps in effect for `sourceId`: its own key, else the brain's, else the default. */
export async function readSyncDeleteCaps(engine: { getConfig(key: string): Promise<string | null> }, sourceId: string): Promise<SyncDeleteCaps> {
  const maxDeletes = parseSyncDeleteCap(SYNC_MAX_DELETES_KEY, await engine.getConfig(`sync.max_deletes.source.${sourceId}`))
    ?? parseSyncDeleteCap(SYNC_MAX_DELETES_KEY, await engine.getConfig(SYNC_MAX_DELETES_KEY)) ?? DEFAULT_SYNC_MAX_DELETES;
  const maxDeleteRatio = parseSyncDeleteCap(SYNC_MAX_DELETE_RATIO_KEY, await engine.getConfig(`sync.max_delete_ratio.source.${sourceId}`))
    ?? parseSyncDeleteCap(SYNC_MAX_DELETE_RATIO_KEY, await engine.getConfig(SYNC_MAX_DELETE_RATIO_KEY)) ?? DEFAULT_SYNC_MAX_DELETE_RATIO;
  return { maxDeletes, maxDeleteRatio };
}

/** The limit `deletes` deletions out of `reconcilable` file-backed pages go over, or null. */
export function syncDeleteTrip(deletes: number, reconcilable: number, caps: SyncDeleteCaps): SyncDeleteTrip | null {
  if (deletes <= 0) return null;
  if (reconcilable > MASS_RECONCILE_MIN_PAGES && deletes > reconcilable * MASS_RECONCILE_RATIO) return 'mass_ratio';
  if (deletes > caps.maxDeletes) return 'max_deletes';
  if (deletes > SYNC_DELETE_RATIO_FLOOR && deletes > reconcilable * caps.maxDeleteRatio) return 'max_delete_ratio';
  return null;
}

/** What a trip means, in the words status and the dry run use. */
export function syncDeleteTripText(trip: SyncDeleteTrip, caps: SyncDeleteCaps): string {
  if (trip === 'mass_ratio') return `more than ${Math.round(MASS_RECONCILE_RATIO * 100)}% of its file-backed pages`;
  if (trip === 'max_deletes') return `more than sync.max_deletes (${caps.maxDeletes}) pages`;
  return `more than sync.max_delete_ratio (${caps.maxDeleteRatio}) of its file-backed pages`;
}

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
    r => r.source_path != null && isSyncablePath(normalizeReconcilePath(r.source_path)),
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
      { env: gitChildEnv(), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
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
  /**
   * Progress-aware window (ms). Set for the default and env deadlines: past
   * the deadline the run continues while it keeps importing, and stops only
   * after this long without progress. Absent for the explicit `--hard-deadline`
   * and `--timeout` flags, which stay strict wall-clock caps.
   */
  progressWindowMs?: number;
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
  return resolveStallAbortSecondsFromEnv(
    'GBRAIN_SYNC_STALL_ABORT_SECONDS', DEFAULT_SYNC_STALL_ABORT_SEC, env,
  );
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
 * non-TTY default (3600s) > none. The env and default deadlines are
 * progress-aware (`progressWindowMs`); the explicit flags are strict.
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

  // A large first sync legitimately outlives the default hour, so these two
  // deadlines never stop a run that is still importing: past the deadline they
  // extend while progress keeps arriving, for up to one stall window between
  // progress notes (the same window the in-band stall watchdog uses).
  const stallSec = resolveStallAbortSeconds(env);
  const progressAware = (res: HardDeadlineResolution | null): HardDeadlineResolution | null =>
    res && { ...res, progressWindowMs: (stallSec > 0 ? stallSec : DEFAULT_SYNC_STALL_ABORT_SEC) * 1000 };

  const envRaw = env.GBRAIN_SYNC_MAX_RUNTIME_SECONDS;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return progressAware(mk(n, 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS')); // n<=0 disables
  }

  if (!opts.isTty) return progressAware(mk(opts.defaultNonTtySec ?? 3600, 'default:non-tty'));

  return null;
}

/**
 * The `gbrain sync` watchdog installation for a resolved deadline: the
 * `installProcessWatchdog` options (progress window and stop notice included)
 * and the stderr line announcing it.
 */
export function syncWatchdogPlan(args: string[], res: HardDeadlineResolution): {
  watchdog: { deadlineMs: number; graceMs: number; label: string; heartbeatMs: number; progressWindowMs?: number; stopNotice: string; progressSignal: 'committed'; stallNotice: string };
  armedLine: string;
} {
  return {
    watchdog: { deadlineMs: res.deadlineMs, graceMs: res.graceMs, label: 'sync-watchdog', heartbeatMs: 60_000,
      progressWindowMs: res.progressWindowMs, stopNotice: syncDeadlineStopNotice(args, res), progressSignal: 'committed', stallNotice: syncDeadlineStallNotice(args, res) },
    armedLine: `[sync-watchdog] hard deadline armed: ${Math.round(res.deadlineMs / 1000)}s + ${Math.round(res.graceMs / 1000)}s grace (${res.reason})` +
      (res.progressWindowMs ? `; extends while the sync keeps progressing (stops after ${Math.round(res.progressWindowMs / 1000)}s without progress)` : '') +
      '; disable with --no-hard-deadline\n',
  };
}

/**
 * #6278: the `gbrain sync` arguments (after `sync`) that resume a managed cursor
 * with its stored processing and cursor options, so a follow-up printed by a
 * hold, `sources retry-held` or doctor keeps `--no-embed` and friends instead
 * of starting a second cursor. `syncResumeCommand` quotes them.
 */
export function managedSyncResumeArgs(input: { sourceId: string; processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean } | null;
  syncOptions?: { full?: boolean; workingTree?: boolean; srcSubpath?: string | null; exclude?: string[]; includeHidden?: string[]; strategy?: string | null } | null;
  repoPath?: string | null }): string[] {
  const p = input.processingOptions ?? {}, c = input.syncOptions ?? {};
  return ['--source', input.sourceId, '--no-pull', ...(input.repoPath ? ['--repo', input.repoPath] : []), ...(p.noEmbed ? ['--no-embed'] : []), ...(p.noExtract ? ['--no-extract'] : []),
    ...(p.noSchemaPack ? ['--no-schema-pack'] : []), ...(c.full ? ['--full'] : []), ...(c.workingTree ? ['--working-tree'] : []), ...(c.srcSubpath ? ['--src-subpath', c.srcSubpath] : []),
    ...(c.exclude ?? []).flatMap(pattern => ['--exclude', pattern]), ...(c.includeHidden ?? []).flatMap(pattern => ['--include-hidden', pattern]), ...(c.strategy ? ['--strategy', c.strategy] : [])];
}

/**
 * #5984: the shell-quoted `gbrain sync` command that resumes this run with the
 * same brain, source and cursor-defining options (`args` are the sync argv).
 */
export function syncResumeCommand(args: string[], brain: string | null = null): string {
  return ['gbrain', ...(brain ? ['--brain', brain] : []), 'sync', ...args].map(a => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * The stdout notice the sync watchdog prints when it stops a run, so the agent
 * sees why the sync ended and the exact command that resumes it (a SIGTERMed
 * process prints no summary of its own). One JSON object under `--json`.
 */
export function syncDeadlineStopNotice(args: string[], res: HardDeadlineResolution): string {
  const deadlineSec = Math.round(res.deadlineMs / 1000);
  const windowSec = res.progressWindowMs ? Math.round(res.progressWindowMs / 1000) : null;
  const resume = syncResumeCommand(args);
  const cause = windowSec
    ? `the ${deadlineSec}s sync deadline (${res.reason}) passed and the run made no progress for ${windowSec}s`
    : `the ${deadlineSec}s sync deadline (${res.reason}) passed`;
  const fix = 'Pages imported before the stop are kept and a rerun skips them. Resume with: ' + resume +
    '. If the stop was wrong for this brain, rerun with --hard-deadline <seconds> or --no-hard-deadline.';
  if (args.includes('--json')) {
    return JSON.stringify({ status: 'stopped', code: 'sync_deadline_stop', reason: res.reason, deadline_seconds: deadlineSec,
      progress_window_seconds: windowSec, cause, resume_command: resume, fix });
  }
  return `gbrain sync stopped (code=sync_deadline_stop): ${cause}. ${fix}`;
}

/**
 * GBRA-133 PR 3a: the stdout notice the sync watchdog prints when a progress-aware deadline passes and the run committed
 * nothing (no page written, deleted or renamed, no cursor advanced; screening unchanged files and legacy-sweep slices do
 * not count). The run is a stall, not progress: `code`, `why` and an agent-operator `fix` (read-only sync status, which
 * names what the run is stuck on) instead of the resume line, since rerunning the same way commits nothing again.
 */
export function syncDeadlineStallNotice(args: string[], res: HardDeadlineResolution): string {
  const deadlineSec = Math.round(res.deadlineMs / 1000);
  const source = args.find((_, i) => args[i - 1] === '--source');
  const status = ['gbrain', 'sync', 'status', ...(source ? ['--source', source] : []), '--json'];
  const resume = syncResumeCommand(args);
  const message = `The ${deadlineSec}s sync deadline (${res.reason}) passed and the run committed nothing.`;
  const why = 'No page was written, deleted or renamed and no sync cursor advanced before the deadline (screening unchanged files and legacy-sweep slices '
    + 'are not progress), so the run stopped as a stall instead of extending. Rerunning the same way is unlikely to commit either; sync status names what '
    + `the source is stuck on (read-only). Fix what it names, then rerun: ${resume}`;
  const fix = { next: 'run', argv: status, command: status.join(' '), actor: 'agent', consent: [], requires_exclusive: false,
    why: 'Read-only: the source\'s state, holds, last error and the next step.', verify: { argv: status } };
  if (args.includes('--json')) {
    return JSON.stringify({ status: 'stalled', code: 'sync_deadline_stalled', message, why, reason: res.reason, deadline_seconds: deadlineSec, committed: 0,
      resume_command: resume, docs: 'docs/guides/error-codes.md#sync_deadline_stalled', fix });
  }
  return `gbrain sync stopped (code=sync_deadline_stalled): ${message} ${why} Fix: ${fix.command}`;
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
