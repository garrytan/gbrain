/**
 * The time frame `think` reads in: today's date (or a caller-supplied
 * reference date) in the brain's timezone, and the content date of each
 * gathered page. Relative time words in the question ("last month") resolve
 * against the reference date; relative words inside a page resolve against
 * that page's date.
 *
 * Only content dates are shown to the reader. A page whose effective date
 * fell back to its creation or update time carries no date, because that
 * time says when the row was written, not when the content happened.
 *
 * Pure apart from the one config read in `resolveThinkTemporalContext`.
 */

import type { BrainEngine } from '../engine.ts';
import { isValidTimeZone } from '../effective-date.ts';

export interface ThinkTemporalContext {
  /** YYYY-MM-DD in `timeZone`. */
  referenceDate: string;
  /** IANA zone (`brain.timezone`), or 'UTC' when unset or invalid. */
  timeZone: string;
  /** True when the caller supplied the reference date. */
  explicitReference: boolean;
}

export class ReferenceDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceDateError';
  }
}

/** Effective-date sources that describe the content rather than the row. */
const CONTENT_DATE_SOURCES = new Set(['event_date', 'date', 'published', 'filename']);

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day an instant falls on in `timeZone`, as YYYY-MM-DD. */
export function dayInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/**
 * Validates a caller-supplied reference date: a real YYYY-MM-DD calendar day,
 * no later than tomorrow in the brain's timezone (one day of slack covers a
 * caller whose clock is ahead of the brain's zone).
 */
export function parseReferenceDate(raw: string, timeZone: string, now: Date = new Date()): string {
  const value = raw.trim();
  const m = ISO_DAY.exec(value);
  if (!m) throw new ReferenceDateError(`reference_date must be YYYY-MM-DD (got "${value.slice(0, 40)}").`);
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() !== +m[2] - 1 || day.getUTCDate() !== +m[3]) {
    throw new ReferenceDateError(`reference_date is not a real calendar date: "${value}".`);
  }
  const tomorrow = dayInZone(new Date(now.getTime() + 86_400_000), timeZone);
  if (value > tomorrow) throw new ReferenceDateError(`reference_date ${value} is in the future (today is ${dayInZone(now, timeZone)} in ${timeZone}).`);
  return value;
}

export async function resolveThinkTemporalContext(
  engine: BrainEngine,
  opts: { referenceDate?: string; now?: Date } = {},
): Promise<ThinkTemporalContext> {
  const configured = (await engine.getConfig('brain.timezone').catch(() => null))?.trim();
  const timeZone = configured && isValidTimeZone(configured) ? configured : 'UTC';
  const now = opts.now ?? new Date();
  if (opts.referenceDate !== undefined) {
    return { referenceDate: parseReferenceDate(opts.referenceDate, timeZone, now), timeZone, explicitReference: true };
  }
  return { referenceDate: dayInZone(now, timeZone), timeZone, explicitReference: false };
}

/**
 * The content date of a gathered page as YYYY-MM-DD, or null. A value stored
 * at exactly midnight UTC is a day-only frontmatter date and renders as
 * written; any other instant renders in the brain's timezone.
 */
export function pageContentDate(
  page: { effective_date?: string | Date | null; effective_date_source?: string | null },
  timeZone: string,
): string | null {
  if (!page.effective_date_source || !CONTENT_DATE_SOURCES.has(page.effective_date_source)) return null;
  const raw = page.effective_date;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string' && ISO_DAY.test(raw.trim())) return raw.trim();
  const instant = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(instant.getTime())) return null;
  if (instant.getUTCHours() === 0 && instant.getUTCMinutes() === 0 && instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0) {
    return instant.toISOString().slice(0, 10);
  }
  return dayInZone(instant, timeZone);
}
