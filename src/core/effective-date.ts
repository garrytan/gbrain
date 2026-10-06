/**
 * v0.29.1 — Compute a page's effective_date from frontmatter precedence.
 *
 * The "effective date" is the answer to "when was this page about?" It's
 * NOT updated_at (which churns from auto-link) and NOT created_at (which
 * is the row insert time). It's the user's stated content date.
 *
 * Precedence chain (default order):
 *   1. frontmatter.event_date    — meeting / event pages
 *   2. frontmatter.date          — dated essays
 *   3. frontmatter.published     — writing/
 *   4. filename-date             — leading YYYY-MM-DD in basename
 *   5. frontmatter created keys  — created / created_at / date_created
 *   6. created_at                — fallback: the stable creation anchor
 *   7. updated_at                — last resort
 *
 * Per-prefix override: for `daily/` and `meetings/` slug prefixes, the
 * filename-date jumps to position 1 — the filename is the user's primary
 * signal there ("daily/2024-03-15.md" the FILE date matters more than any
 * frontmatter the user pasted).
 *
 * Returns BOTH the parsed Date and the source label so the doctor's
 * `effective_date_health` check can detect "fell back to updated_at" rows
 * that look populated but are functionally equivalent to a NULL.
 *
 * Range validation: an explicit frontmatter date (event_date, date,
 * published, created keys) written as a calendar date, datetime or YAML date
 * accepts any year >= 1 up to NOW + 1 year, so historical works keep their
 * real date; the epoch-0 and 0001-01-01 placeholders are dropped. Inferred
 * dates (the filename, loosely parsed free text, bare numbers) and the
 * fallback timestamps must be in [1990-01-01, NOW + 1 year]. Out-of-range
 * values are dropped (the chain falls through to the next element). NaN /
 * unparseable strings drop the same way. Timeline entries keep their own
 * 1900-2199 window (src/core/ops/timeline.ts).
 *
 * Pure function. No DB. Tested in test/effective-date.test.ts.
 */

import type { EffectiveDateSource } from './types.ts';

export interface EffectiveDateResult {
  date: Date | null;
  source: EffectiveDateSource | null;
}

export interface ComputeEffectiveDateOpts {
  slug: string;
  frontmatter: Record<string, unknown>;
  /** `brain.timezone`: IANA zone for offset-less datetimes. Unset or invalid = UTC. */
  timeZone?: string;
  /** Basename without extension, e.g. "2024-03-15-acme-call". May be null/empty. */
  filename?: string | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Slug prefixes where the filename date wins over frontmatter dates. The
 * user's primary signal in these directories is the filename, not arbitrary
 * frontmatter the importer might have copied.
 *
 * Hardcoded in v0.29.1 (commit 2). v0.29.1 commit 5 introduces the
 * recency-decay map; we could move this list there if we wanted user-tunable
 * filename-first prefixes, but the daily/ + meetings/ defaults are stable
 * enough that hardcoding is correct.
 */
const FILENAME_FIRST_PREFIXES = ['daily/', 'meetings/'];

/** Creation-date keys Obsidian and Notion exports carry; a content date after the others. */
const CREATED_KEYS = ['created', 'created_at', 'date_created', 'date created'];

/**
 * The fallback anchor for an undated page: a page that already fell back
 * keeps its stored date, a new file-backed page takes the earliest of its
 * file's birth time, modification time and (when opted in) git first-commit
 * date, and anything else takes the row's creation time. Never the time of
 * the latest write.
 */
export function fallbackCreatedAt(opts: {
  existing?: { effective_date?: Date | string | null; effective_date_source?: string | null; created_at?: Date | string | null } | null;
  fileTimes?: { birthtime?: Date; mtime?: Date; firstCommit?: Date } | null;
  now: Date;
}): Date {
  const { existing, fileTimes, now } = opts;
  if (existing?.effective_date_source === 'fallback' && existing.effective_date) return new Date(existing.effective_date);
  if (existing?.created_at) return new Date(existing.created_at);
  const times = [fileTimes?.birthtime, fileTimes?.mtime, fileTimes?.firstCommit]
    .filter((d): d is Date => d instanceof Date && d.getTime() > 0)
    .map(d => d.getTime());
  return times.length ? new Date(Math.min(...times)) : now;
}

const MIN_DATE_MS = Date.UTC(1990, 0, 1);
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

function maxDateMs(): number {
  // NOW + 1 year, computed at call time so tests with a mocked Date.now()
  // see a moving boundary. Pages dated > 1 year in the future are almost
  // always corrupt (epoch math gone wrong, typoed century, bad parse).
  return Date.now() + 365 * 24 * 60 * 60 * 1000;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const NUMERIC_DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const MONTH_DAY_YEAR_RE = /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i;
const DAY_MONTH_YEAR_RE = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i;
/** Chat-export style "1:56 pm on 8 May, 2023": the clock time is dropped and the date parsed. */
const TIME_ON_PREFIX_RE = /^\d{1,2}:\d{2}\s*(?:am|pm)?\s+on\s+/i;

/** A UTC calendar date, or null when Y/M/D does not name a real day (2024-02-30). */
function utcCalendarDate(year: number, month: number, day: number, h = 0, m = 0, sec = 0, ms = 0): Date | null {
  const d = new Date(Date.UTC(2000, 0, 1, h, m, sec, ms));
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/**
 * Marks a frontmatter Date the YAML parser built from an offset-less datetime
 * (`2024-03-15T10:00:00`): its UTC fields hold the author's wall-clock time.
 */
export const NAIVE_DATETIME = Symbol.for('gbrain.naive-datetime');

/** Whether `timeZone` names an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/** The instant a wall-clock time (held in `wall`'s UTC fields) names in `timeZone`, DST included. */
function zonedWallTime(wall: Date, timeZone: string): Date {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const offsetAt = (instant: number) => {
    const part = (type: string) => +format.formatToParts(instant).find(p => p.type === type)!.value;
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - (instant - instant % 1000);
  };
  const first = wall.getTime() - offsetAt(wall.getTime());
  return new Date(wall.getTime() - offsetAt(first));
}

/**
 * Parse a frontmatter value as a Date. Returns null on any failure.
 *
 * Calendar shapes never depend on the syncing host's timezone: date-only
 * values (`2024-03-15`, `2024/03/15`, `March 5, 2024`, `5 March 2024`) are UTC
 * calendar dates, and a datetime without an offset is read in `timeZone`
 * (the brain's `brain.timezone`; UTC when unset). A calendar-invalid date
 * (`2024-02-30`) is rejected rather than rolled over. Other strings fall back
 * to Date.parse.
 */
export function parseDateLoose(value: unknown, timeZone?: string): Date | null {
  if (value == null) return null;
  const zone = timeZone && timeZone !== 'UTC' ? timeZone : null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return zone && (value as Date & { [NAIVE_DATETIME]?: boolean })[NAIVE_DATETIME] ? zonedWallTime(value, zone) : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const numeric = NUMERIC_DATE_RE.exec(trimmed);
    if (numeric) return utcCalendarDate(+numeric[1], +numeric[2], +numeric[3]);
    const datetime = DATETIME_RE.exec(trimmed);
    if (datetime) {
      const [, y, mo, d, h, mi, sec, frac, offset] = datetime;
      const wall = utcCalendarDate(+y, +mo, +d, +h, +mi, +(sec ?? 0), frac ? Math.round(+frac * 1000) : 0);
      if (!wall || +h > 23 || +mi > 59 || +(sec ?? 0) > 59) return null;
      if (!offset) return zone ? zonedWallTime(wall, zone) : wall;
      if (offset.toUpperCase() === 'Z') return wall;
      const sign = offset.startsWith('-') ? -1 : 1;
      const [zh, zm] = [+offset.slice(1, 3), +offset.slice(-2)];
      return new Date(wall.getTime() - sign * (zh * 60 + zm) * 60_000);
    }
    const dated = trimmed.replace(TIME_ON_PREFIX_RE, '');
    const mdy = MONTH_DAY_YEAR_RE.exec(dated);
    if (mdy && MONTHS[mdy[1].toLowerCase()]) return utcCalendarDate(+mdy[3], MONTHS[mdy[1].toLowerCase()], +mdy[2]);
    const dmy = DAY_MONTH_YEAR_RE.exec(dated);
    if (dmy && MONTHS[dmy[2].toLowerCase()]) return utcCalendarDate(+dmy[3], MONTHS[dmy[2].toLowerCase()], +dmy[1]);
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  }
  if (typeof value === 'number') {
    // Plausibility: numbers are usually ms since epoch but YAML can yield
    // bare integers (year? month? day?) — accept only if the resulting Date
    // falls inside the valid window. validateInRange catches the rest.
    return Number.isFinite(value) ? new Date(value) : null;
  }
  return null;
}

function validateInRange(d: Date | null): Date | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < MIN_DATE_MS) return null;
  if (ms > maxDateMs()) return null;
  return d;
}

/**
 * #5742: an explicit frontmatter date in a structured shape keeps any year >= 1
 * (up to NOW + 1 year) except the epoch-0 and 0001-01-01 placeholders. Loosely
 * parsed strings and bare numbers are inference, so they keep the 1990 floor.
 */
function validateExplicit(value: unknown, timeZone?: string): Date | null {
  const d = parseDateLoose(value, timeZone);
  const structured = value instanceof Date || (typeof value === 'string'
    && [NUMERIC_DATE_RE, DATETIME_RE, MONTH_DAY_YEAR_RE, DAY_MONTH_YEAR_RE].some(re => re.test(value.trim().replace(TIME_ON_PREFIX_RE, ''))));
  if (!structured) return validateInRange(d);
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms) || ms === 0 || ms > maxDateMs()) return null;
  const year = d.getUTCFullYear();
  if (year < 1 || (year === 1 && d.getUTCMonth() === 0 && d.getUTCDate() === 1)) return null;
  return d;
}

function extractFilenameDate(filename: string | null | undefined): Date | null {
  if (!filename) return null;
  const m = filename.match(FILENAME_DATE_RE);
  if (!m) return null;
  return validateInRange(parseDateLoose(m[1]));
}

function hasFilenameFirstPrefix(slug: string): boolean {
  for (const p of FILENAME_FIRST_PREFIXES) {
    if (slug.startsWith(p)) return true;
  }
  return false;
}

/**
 * Run the precedence chain. Returns the first valid (in-range) date and its
 * source label. Falls all the way through to updated_at / created_at as
 * 'fallback' when nothing in frontmatter or filename parses.
 */
export function computeEffectiveDate(opts: ComputeEffectiveDateOpts): EffectiveDateResult {
  const { slug, frontmatter, filename, updatedAt, createdAt } = opts;
  const filenameFirst = hasFilenameFirstPrefix(slug);
  const timeZone = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : undefined;

  const fmEvent = validateExplicit(frontmatter.event_date, timeZone);
  const fmDate = validateExplicit(frontmatter.date, timeZone);
  const fmPublished = validateExplicit(frontmatter.published, timeZone);
  const filenameDate = extractFilenameDate(filename);
  const fmCreated = CREATED_KEYS.map(key => validateExplicit(frontmatter[key], timeZone)).find(d => d !== null) ?? null;

  // Build the ordered candidate list. For filename-first prefixes
  // (daily/, meetings/) the filename moves to the head of the chain.
  const candidates: Array<{ date: Date | null; source: EffectiveDateSource }> = filenameFirst
    ? [
        { date: filenameDate, source: 'filename' },
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: fmCreated, source: 'created' },
      ]
    : [
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: filenameDate, source: 'filename' },
        { date: fmCreated, source: 'created' },
      ];

  for (const c of candidates) {
    if (c.date !== null) return { date: c.date, source: c.source };
  }

  // Fallback chain: the creation anchor, then updated_at. The anchor is
  // stable across edits (see fallbackCreatedAt), so an undated page keeps its
  // date instead of taking every write's time. Both are guaranteed non-null
  // by the schema; the validation here is defensive against bad fixtures.
  const cre = validateInRange(createdAt);
  if (cre !== null) return { date: cre, source: 'fallback' };
  const upd = validateInRange(updatedAt);
  if (upd !== null) return { date: upd, source: 'fallback' };

  return { date: null, source: null };
}
