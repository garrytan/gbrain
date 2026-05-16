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
