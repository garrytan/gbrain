/**
 * Supervisor lifecycle audit log. JSONL, weekly-rotated, best-effort.
 *
 * Writes one line per supervisor event (started, worker_spawned, worker_exited,
 * backoff, health_warn, health_error, max_crashes_exceeded, shutting_down,
 * stopped, worker_spawn_failed) to
 *   `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl`
 * using ISO-8601 week numbering.
 *
 * Shape: every emission already includes `event` and `ts`; we write it
 * verbatim and let consumers (like `gbrain doctor`) grep for events of
 * interest. `supervisor_pid` is added at start() time so each line is
 * self-describing even if a log shipper concatenates multiple supervisors'
 * files.
 *
 * Best-effort: write failures go to stderr and never block supervisor work.
 * A disk-full attacker could silently disable the trail — this is an
 * operational trace for `gbrain doctor`, not forensic insurance.
 *
 * `GBRAIN_AUDIT_DIR` overrides the default `~/.gbrain/audit/` path for
 * container deploys where `$HOME` is read-only.
 *
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive
 * from `~/Projects/gbrain/src/core/audit-jsonl.ts`. The factory's transform
 * is used to fold `supervisor_pid` into every line.
 */

import { createAuditLogger, computeIsoWeekFilename } from '../../audit-jsonl.ts';
import type { SupervisorEmission } from '../supervisor.ts';

/** The audit-line shape — emission + supervisor_pid. ts comes from the
 *  emission (supervisor sets it before emitting); the factory's stamping
 *  would override it, which we don't want, so this type explicitly has ts. */
type SupervisorAuditLine = SupervisorEmission & { supervisor_pid: number };

const logger = createAuditLogger<SupervisorAuditLine>({
  prefix: 'supervisor',
  stderrTag: '[supervisor-audit]',
  continueMessage: 'continuing',
});

/**
 * Compute `supervisor-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 * Year-boundary edge: 2027-01-01 is ISO week 53 of year 2026, so the correct
 * filename is `supervisor-2026-W53.jsonl`.
 */
export function computeSupervisorAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('supervisor', now);
}

/**
 * Append a single supervisor lifecycle event to the rotated JSONL audit
 * file. `supervisorPid` is the OS pid of the supervisor process (added
 * to every line so a log shipper concatenating files from multiple
 * supervisors still produces parseable traces).
 *
 * Note: the supervisor sets its own `ts` on each emission. The factory's
 * log() would stamp a fresh ts. To preserve the original timestamp, we
 * call log() with a transform-aware shape — the factory will override ts
 * with its own. If the supervisor needs to preserve historical timestamps
 * exactly (e.g. backfilling a log), use the raw append pattern via direct
 * file write. The current callers all emit synchronously so ts = now is
 * the correct value.
 */
export function writeSupervisorEvent(emission: SupervisorEmission, supervisorPid: number): void {
  logger.log({ ...emission, supervisor_pid: supervisorPid });
}

/**
 * Read back the latest supervisor audit file. Returns events sorted
 * oldest-first. Best-effort: missing file / parse errors return [].
 * Used by `gbrain doctor` (Lane D) to surface supervisor health.
 */
export function readSupervisorEvents(opts: { sinceMs?: number } = {}): SupervisorEmission[] {
  // Default to a generous 14-day window; the caller's sinceMs (if set) narrows.
  const daysWindow = 14;
  const now = new Date();
  const cutoffMs = opts.sinceMs !== undefined ? Date.now() - opts.sinceMs : 0;
  const events = logger.readRecent(daysWindow, now)
    .filter((ev) => {
      if (!ev.event || !ev.ts) return false;
      if (cutoffMs > 0) {
        const ts = Date.parse(ev.ts);
        if (!isNaN(ts) && ts < cutoffMs) return false;
      }
      return true;
    });
  // Factory returns newest-first; the legacy API returned oldest-first.
  // Re-sort to preserve the contract.
  return events
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map(({ supervisor_pid: _pid, ...rest }) => {
      void _pid;
      return rest as SupervisorEmission;
    });
}

/**
 * Denylist of clean-exit `likely_cause` values. Anything not in this set —
 * including future unrecognized values — counts as a crash. Matches the
 * domain asymmetry: clean exits are explicit (the worker exited because we
 * asked it to); crashes are an open catch-all. If a future maintainer adds a
 * new `likely_cause` upstream in `child-worker-supervisor.ts` (e.g.
 * `lock_lost`, `panic`), the doctor surfaces it by default instead of
 * silently underreporting — denylist semantics close the bug class this
 * helper was added to fix.
 */
const CLEAN_EXIT_CAUSES = new Set(['clean_exit', 'graceful_shutdown']);

/**
 * Per-cause crash bucket shape returned by `summarizeCrashes()`. Bucket names
 * mirror the upstream `likely_cause` values: `runtime_error` (code=1),
 * `oom_or_external_kill` (SIGKILL), `unknown` (other signals/codes). The
 * `legacy` bucket catches pre-v0.34 entries lacking `likely_cause` that fall
 * through to the `code !== 0` fallback.
 */
export interface CrashSummary {
  total: number;
  by_cause: {
    runtime_error: number;
    oom_or_external_kill: number;
    unknown: number;
    legacy: number;
  };
  clean_exits: number;
}

/**
 * Classify a single audit event. Returns true when the event represents a
 * worker crash (not a clean shutdown, watchdog drain, or non-exit lifecycle
 * event). Pre-v0.34 audit lines lacking `likely_cause` fall back to
 * `code !== 0`.
 */
export function isCrashExit(event: SupervisorEmission): boolean {
  if (event.event !== 'worker_exited') return false;
  const cause = event.likely_cause as string | undefined;
  if (cause === undefined) {
    // Legacy fallback for pre-v0.34 entries lacking `likely_cause`. Treat
    // any non-zero exit code as a crash; missing/null `code` also counts
    // (truly malformed line — fail-loud, the user can investigate the audit
    // file directly).
    const code = event.code as number | null | undefined;
    return code !== 0;
  }
  return !CLEAN_EXIT_CAUSES.has(cause);
}

/**
 * Summarize crash counts across a window of supervisor audit events. Both
 * `gbrain doctor` and `gbrain jobs supervisor status` consume this — single
 * regression point, single test target.
 *
 * Bucketing rule: `worker_exited` events classified as crashes by
 * `isCrashExit()` are dispatched to `by_cause` based on `likely_cause`. The
 * `legacy` bucket catches BOTH (a) pre-v0.34 entries lacking `likely_cause`
 * that fell through to the `code !== 0` fallback, AND (b) future
 * unrecognized `likely_cause` values not in the explicit allowlist
 * (`runtime_error` / `oom_or_external_kill` / `unknown`). Operators
 * watching `legacy=N` rise know the upstream classifier added a value the
 * doctor doesn't yet name — that's the intended signal for "extend my
 * bucket vocabulary."
 */
export function summarizeCrashes(events: SupervisorEmission[]): CrashSummary {
  const summary: CrashSummary = {
    total: 0,
    by_cause: { runtime_error: 0, oom_or_external_kill: 0, unknown: 0, legacy: 0 },
    clean_exits: 0,
  };
  for (const e of events) {
    if (e.event !== 'worker_exited') continue;
    if (!isCrashExit(e)) {
      summary.clean_exits++;
      continue;
    }
    summary.total++;
    const cause = e.likely_cause as string | undefined;
    if (cause === 'runtime_error') summary.by_cause.runtime_error++;
    else if (cause === 'oom_or_external_kill') summary.by_cause.oom_or_external_kill++;
    else if (cause === 'unknown') summary.by_cause.unknown++;
    else summary.by_cause.legacy++;  // pre-v0.34 fallback OR future unrecognized cause
  }
  return summary;
}
