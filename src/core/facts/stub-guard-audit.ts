/**
 * Stub-guard audit log. JSONL, ISO-week-rotated, best-effort.
 *
 * Writes one line per stub-guard fire to
 *   `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/stub-guard-YYYY-Www.jsonl`
 * when `writeFactsToFence` refuses to spawn an unprefixed entity page. The
 * audit log is the operator visibility surface for the v0.34.5+ stub guard
 * sunset criterion: when this reads <5 hits/week for 3 consecutive weeks
 * on production brains, the guard can be removed in v0.36 (the prefix
 * expansion in resolveEntitySlug is sufficient).
 *
 * Best-effort: write failures go to stderr and never block the legacy DB-only
 * fallback path. A disk-full attacker could silently disable the trail.
 *
 * Reader pattern (READ THIS):
 *
 * `readRecentStubGuardEvents({ sinceMs: 24h })` reads BOTH the current AND
 * the previous ISO-week file before filtering by `ts >= now - sinceMs`.
 * The DELIBERATE divergence from `supervisor-audit.ts:readSupervisorEvents`
 * is the whole reason this module exists separately: that reader reads only
 * the current week file, which loses 24h-window correctness across Monday
 * 00:00 UTC (a Sunday 23:55 event is in last week's file). When the doctor's
 * 24h check runs on Monday 00:01 UTC against a brain that fired the guard
 * Sunday at 23:55, the supervisor pattern would silently miss it. The
 * 2-file read costs nothing (cheap fs read; misses are still cheap when
 * the file doesn't exist) and makes the window correct.
 *
 * Follow-up TODO (filed separately, not in this PR): fix
 * `readSupervisorEvents` to use the same 2-file pattern.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from '../minions/handlers/shell-audit.ts';

export interface StubGuardEvent {
  /** ISO-8601 timestamp of when the guard fired. */
  ts: string;
  /** The slug that triggered the guard. */
  slug: string;
  /** The source the fact was being written into. */
  source_id: string;
  /** How many facts were in the rejected batch (informational). */
  fact_count: number;
}

/**
 * Compute the ISO-8601 week filename `stub-guard-YYYY-Www.jsonl`.
 * Year-boundary edge: 2027-01-01 falls in ISO week 53 of year 2026, so the
 * filename is `stub-guard-2026-W53.jsonl`. Logic mirrors shell-audit.ts
 * verbatim; can't import the helper because shell-audit.ts hardcodes its
 * own `shell-jobs-` prefix.
 */
export function computeStubGuardAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday (ISO week anchor)
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `stub-guard-${isoYear}-W${ww}.jsonl`;
}

/**
 * Append a stub-guard fire to the ISO-week rotated JSONL file. Best-effort:
 * write failures emit a stderr warning and never throw — the legacy
 * DB-only fallback path in `backstop.ts` must keep working even when the
 * audit log can't be written.
 */
export function logStubGuardEvent(event: Omit<StubGuardEvent, 'ts'>): void {
  const dir = resolveAuditDir();
  const filename = computeStubGuardAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[stub-guard-audit] write failed (${msg}); continuing\n`);
  }
}

/**
 * Read recent stub-guard events. Reads BOTH the current AND the previous
 * ISO-week file, then filters by `ts >= now - sinceMs`. The 2-file read is
 * the difference between this reader and `supervisor-audit.ts` — see the
 * module-level JSDoc for why.
 *
 * `now` is injectable for unit tests that need to simulate "Monday 00:01
 * UTC just after a Sunday 23:55 fire" without monkey-patching the clock.
 *
 * Returns events sorted oldest-first. Missing files / parse errors return []
 * for that file (still reads the other one).
 */
export function readRecentStubGuardEvents(opts: { sinceMs: number; now?: Date } = { sinceMs: 24 * 60 * 60 * 1000 }): StubGuardEvent[] {
  const now = opts.now ?? new Date();
  const dir = resolveAuditDir();

  // Compute current and previous ISO-week filenames. 7 days back from `now`
  // lands in the previous ISO week (modulo daylight-saving boundary, which
  // doesn't shift ISO-week boundaries since they're UTC-anchored).
  const prevWeekDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const currentFile = computeStubGuardAuditFilename(now);
  const prevFile = computeStubGuardAuditFilename(prevWeekDate);

  // Dedup if current and prev computed the same name (shouldn't, but defensive).
  const files = currentFile === prevFile ? [currentFile] : [prevFile, currentFile];

  const cutoffMs = now.getTime() - opts.sinceMs;
  const events: StubGuardEvent[] = [];

  for (const filename of files) {
    const fullPath = path.join(dir, filename);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as StubGuardEvent;
        if (!obj.ts || !obj.slug) continue;
        const eventMs = Date.parse(obj.ts);
        if (isNaN(eventMs)) continue;
        if (eventMs < cutoffMs) continue;
        events.push(obj);
      } catch {
        // Ignore malformed lines (truncated writes, disk-full corruption).
      }
    }
  }

  // Sort by timestamp ascending so doctor's count + recent-slug list is stable.
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return events;
}
