/**
 * Audit-log JSONL substrate — shared primitive for all `~/.gbrain/audit/*.jsonl`
 * files.
 *
 * Before this module, every audit kind (shell-jobs, slug-fallback,
 * rerank-failures, subagent, supervisor, backpressure) re-implemented the
 * same ~80 lines of:
 *   - ISO-8601 week-number filename math
 *   - audit-dir resolution with `GBRAIN_AUDIT_DIR` override
 *   - mkdir + appendFileSync + stderr-warn-on-failure write path
 *   - readdirSync + JSON.parse with malformed-line tolerance read path
 *
 * Two of those files (shell-audit, backpressure-audit) exported the same
 * function name (`computeAuditFilename`) — literal name collision the
 * factory removes. Another (audit-slug-fallback) imports `resolveAuditDir`
 * from `minions/handlers/shell-audit.ts` — a cross-layer smell the factory
 * fixes by moving `resolveAuditDir` to the core layer.
 *
 * Usage:
 *   const logger = createAuditLogger<MyEvent>({
 *     prefix: 'my-audit-kind',
 *     stderrTag: '[my-audit]',
 *     continueMessage: 'op continues',
 *   });
 *   logger.log({ field1: 'x', field2: 42 });
 *   const recent = logger.readRecent(7);
 *
 * The factory preserves each audit kind's per-domain shape (event type,
 * truncation policy, read-side filters) while consolidating the substrate.
 *
 * Closes #1063 follow-up — 6 files duplicated ~250 lines of primitive;
 * factory removes ~150 net. Existing public exports of each audit module
 * are preserved so callers don't change.
 *
 * Codified 2026-05-16 after a MemoryOS audit found the substrate had been
 * accreted to 6 files without consolidation. The 7th (destructive-audit.ts,
 * in flight as PR #1069) will be folded in once that PR lands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from './config.ts';

// ─── Filename math ────────────────────────────────────────────────────────

/**
 * Compute `<prefix>-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 * Year-boundary edge: 2027-01-01 is ISO week 53 of year 2026, so the correct
 * filename is `<prefix>-2026-W53.jsonl`. This matches the ISO week standard
 * (week containing the first Thursday of the year is W1; week containing
 * Dec 28 is always W52 or W53 of that year).
 *
 * Exported for tests + the rare caller (`readSubagentAuditForJob`) that needs
 * to compute a filename without going through a logger instance.
 */
export function computeIsoWeekFilename(prefix: string, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `${prefix}-${isoYear}-W${ww}.jsonl`;
}

// ─── Dir resolution ───────────────────────────────────────────────────────

/**
 * Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container/sandbox
 * deployments where `$HOME` is read-only. Defaults to `~/.gbrain/audit/`.
 *
 * Moved here from `minions/handlers/shell-audit.ts` (where it was originally
 * defined and re-imported by `audit-slug-fallback.ts`, a cross-layer smell).
 */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return gbrainPath('audit');
}

// ─── Factory types ────────────────────────────────────────────────────────

export interface AuditLogConfig<T extends { ts: string }> {
  /** Filename prefix. E.g. 'shell-jobs', 'rerank-failures', 'destructive-ops'. */
  prefix: string;
  /** Stderr warning tag. E.g. '[shell-audit]', '[gbrain]'. */
  stderrTag: string;
  /**
   * Tail of stderr warn message after the colon. E.g. 'submission continues',
   * 'op continues'. Renders as `<stderrTag> write failed (<msg>); <continueMessage>`.
   */
  continueMessage: string;
  /**
   * Optional pre-write transform. Each event passes through this just before
   * serialization. Use for truncation (`page_slugs.slice(0, 50)`), sanitization,
   * field-redaction, etc. The transform receives the event WITHOUT `ts` (which
   * is added afterward) and returns the same shape (also without `ts`).
   *
   * Default: identity.
   */
  transform?: (event: Omit<T, 'ts'>) => Omit<T, 'ts'>;
}

export interface AuditLogger<T extends { ts: string }> {
  /**
   * Append an event to the audit log. Best-effort: write failures emit a
   * stderr warning and return without throwing. A disk-full attacker can
   * silently disable the trail; this is intentional (operational trace, not
   * security primitive). Each consumer's docs call this out per-domain.
   */
  log: (event: Omit<T, 'ts'>) => void;

  /**
   * Read all events in the last `days` days. Walks every matching audit file
   * in the dir (handles the case where `days` spans a week boundary).
   * Tolerates malformed JSONL lines (skips them silently — partial-write
   * tolerance). Returns newest-first.
   */
  readRecent: (days?: number, now?: Date) => T[];

  /**
   * Compute the audit filename for a given moment. Exposed for tests + the
   * rare caller (e.g. `readSubagentAuditForJob`) that needs to filter by
   * filename predicate.
   */
  computeFilename: (now?: Date) => string;
}

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Build a typed audit logger for one audit-kind. Each call instantiates a
 * pair of {log, readRecent, computeFilename} bound to a single prefix.
 *
 * Each per-domain audit module typically:
 *   1. Defines its event type with `ts: string` at top
 *   2. Calls createAuditLogger with prefix + tags + optional transform
 *   3. Re-exports `logger.log`, `logger.readRecent`, `logger.computeFilename`
 *      under domain-specific names (e.g. `logShellSubmission`,
 *      `readRecentShellJobs`, `computeShellAuditFilename`)
 *
 * Existing public function names are preserved through re-exports so
 * downstream callers don't need to change.
 */
export function createAuditLogger<T extends { ts: string }>(
  cfg: AuditLogConfig<T>,
): AuditLogger<T> {
  const transform = cfg.transform ?? ((e: Omit<T, 'ts'>) => e);

  const computeFilename = (now: Date = new Date()): string =>
    computeIsoWeekFilename(cfg.prefix, now);

  const log = (event: Omit<T, 'ts'>): void => {
    const dir = resolveAuditDir();
    const filename = computeFilename();
    const fullPath = path.join(dir, filename);
    const transformed = transform(event);
    const line = JSON.stringify({ ...transformed, ts: new Date().toISOString() }) + '\n';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${cfg.stderrTag} write failed (${msg}); ${cfg.continueMessage}\n`);
    }
  };

  const readRecent = (days: number = 7, now: Date = new Date()): T[] => {
    const dir = resolveAuditDir();
    if (!fs.existsSync(dir)) return [];
    const cutoffMs = now.getTime() - days * 86400 * 1000;
    const events: T[] = [];
    // Walk files matching our prefix so sibling audit kinds don't bleed in.
    const entries = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${cfg.prefix}-`) && f.endsWith('.jsonl'));
    for (const filename of entries) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, filename), 'utf8');
      } catch {
        continue;
      }
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as T;
          if (!ev.ts) continue;
          const eventMs = Date.parse(ev.ts);
          if (Number.isFinite(eventMs) && eventMs >= cutoffMs) {
            events.push(ev);
          }
        } catch {
          // Skip malformed line — partial-write or crash mid-append
        }
      }
    }
    // Newest-first
    events.sort((a, b) => b.ts.localeCompare(a.ts));
    return events;
  };

  return { log, readRecent, computeFilename };
}
