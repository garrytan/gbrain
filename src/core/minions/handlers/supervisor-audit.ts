/**
 * Supervisor lifecycle audit log. JSONL, weekly-rotated, best-effort.
 *
 * Writes one line per supervisor event (started, worker_spawned, worker_exited,
 * backoff, health_warn, health_error, max_crashes_exceeded, shutting_down,
 * stopped, worker_spawn_failed) to
 *   `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl`
 * using ISO-8601 week numbering. `computeAuditFilename(kind, now)` derives
 * the filename; the ISO-week math is shared with `shell-audit.ts` via the
 * `computeIsoWeekName()` helper that both call.
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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './shell-audit.ts';
import type { SupervisorEmission } from '../supervisor.ts';

/**
 * Compute `supervisor-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 * Mirrors `shell-audit.ts:computeAuditFilename()` exactly. Year-boundary
 * edge: 2027-01-01 is ISO week 53 of year 2026, so the correct filename
 * is `supervisor-2026-W53.jsonl`.
 */
export function computeSupervisorAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday (ISO week anchor)
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `supervisor-${isoYear}-W${ww}.jsonl`;
}

/**
 * Append a single supervisor lifecycle event to the rotated JSONL audit
 * file. `supervisorPid` is the OS pid of the supervisor process (added
 * to every line so a log shipper concatenating files from multiple
 * supervisors still produces parseable traces).
 */
export function writeSupervisorEvent(emission: SupervisorEmission, supervisorPid: number): void {
  const dir = resolveAuditDir();
  const filename = computeSupervisorAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({ ...emission, supervisor_pid: supervisorPid }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[supervisor-audit] write failed (${msg}); continuing\n`);
  }
}

/**
 * Read back the latest supervisor audit file. Returns events sorted
 * oldest-first. Best-effort: missing file / parse errors return [].
 * Used by `gbrain doctor` (Lane D) to surface supervisor health.
 */
export function readSupervisorEvents(opts: { sinceMs?: number } = {}): SupervisorEmission[] {
  const dir = resolveAuditDir();
  const filename = computeSupervisorAuditFilename();
  const fullPath = path.join(dir, filename);

  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return [];
  }

  const now = Date.now();
  const cutoff = opts.sinceMs !== undefined ? now - opts.sinceMs : 0;
  const events: SupervisorEmission[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as SupervisorEmission;
      if (!obj.event || !obj.ts) continue;
      if (cutoff > 0) {
        const ts = Date.parse(obj.ts);
        if (!isNaN(ts) && ts < cutoff) continue;
      }
      events.push(obj);
    } catch {
      // Ignore malformed lines (truncated writes, disk-full corruption).
    }
  }
  return events;
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
