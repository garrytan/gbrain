/**
 * v0.37.x — single source of truth for the ISO-week filename math used by
 * every gbrain audit JSONL writer (shell-audit, phantom-audit,
 * slug-fallback-audit, budget-tracker audit, dream-budget audit).
 *
 * Why: each of those modules grew its own copy of the same ISO-week math
 * with subtle drift (some used UTC, some used local; some used Sunday-start
 * weeks, some used Thursday-start ISO weeks). One shared helper keeps the
 * filenames consistent so an operator can grep one filename pattern across
 * audit dirs.
 *
 * ISO 8601 week numbering:
 *   - Weeks start on Monday.
 *   - Week 1 of any year is the week containing the year's first Thursday.
 *   - A date can belong to a week whose ISO year differs from the calendar
 *     year (Dec 31 of a Wednesday-ending year belongs to W01 of the next).
 *   - Year-boundary correctness is pinned by `test/core/audit-week-file.test.ts`.
 */

import { gbrainPath } from './config.ts';

/**
 * Compute the ISO-8601 week number (1..53) and corresponding ISO week-year
 * for `d` (UTC). Returns `{year, week}` where `year` may differ from
 * `d.getUTCFullYear()` near year boundaries.
 */
export function isoWeek(d: Date): { year: number; week: number } {
  // Algorithm: shift to the Thursday of d's week (since Thursday determines
  // the week's ISO year), then compute weeks since the first Thursday.
  const tgt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tgt.getUTCDay() + 6) % 7; // Monday=0, ..., Sunday=6
  tgt.setUTCDate(tgt.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const isoYear = tgt.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((tgt.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { year: isoYear, week };
}

/**
 * Build a basename like `<prefix>-YYYY-Www.jsonl` (e.g. `budget-2026-W21.jsonl`).
 * Caller is responsible for joining with the audit dir.
 */
export function isoWeekFilename(prefix: string, now: Date = new Date()): string {
  const { year, week } = isoWeek(now);
  return `${prefix}-${year}-W${String(week).padStart(2, '0')}.jsonl`;
}

/**
 * Resolve the audit directory: honors `GBRAIN_AUDIT_DIR` env override,
 * falls back to `gbrainPath('audit')`. The directory may not exist yet;
 * callers `mkdirSync({recursive:true})` before writing.
 */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.length > 0) return override;
  return gbrainPath('audit');
}
