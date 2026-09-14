/**
 * calendar-horizon — shared calendar event classification and horizon containment.
 *
 * Single source of truth for:
 *   - deterministic civil calendar-day arithmetic in authoritative IANA timezones;
 *   - bounded future-horizon evaluation (default 60 days, clamped 1..365);
 *   - explicit recurrence classification ('recurring' | 'single' | 'unknown');
 *   - past vs future event separation for chronicle and timeline consumers;
 *   - fail-closed validation for malformed/missing dates or invalid timezones.
 *
 * Pure functions only. Zero runtime dependencies outside standard platform primitives.
 */

export type RecurrenceKind = 'recurring' | 'single' | 'unknown';

export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
  dateStr: string; // YYYY-MM-DD
}

export interface CalendarClassification {
  isCalendar: boolean;
  recurrenceKind: RecurrenceKind;
  beyondFutureHorizon: boolean;
  isFuture: boolean;
  valid: boolean;
  startDate?: string;
  error?: string;
}

export interface ClassifyCalendarEventOptions {
  slug?: string;
  type?: string;
  frontmatter?: Record<string, unknown> | null;
  nowMs?: number;
  futureDays?: number;
  timeZone?: string;
}

/**
 * Validates an IANA timezone identifier string. Throws Error if missing or invalid.
 */
export function validateIanaTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new Error(`Invalid or missing IANA timeZone: "${timeZone}"`);
  }
  const tz = timeZone.trim();
  try {
    // Intl.DateTimeFormat throws RangeError on invalid IANA time zone identifiers
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA timeZone identifier: "${tz}"`);
  }
  return tz;
}

/**
 * Extract calendar date parts (year, month, day) in the given IANA timezone for an epoch instant.
 */
export function getCalendarDatePartsInTz(epochMs: number, timeZone: string): CalendarDateParts {
  const tz = validateIanaTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));

  let year = 0;
  let month = 0;
  let day = 0;

  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value, 10);
    else if (p.type === 'month') month = parseInt(p.value, 10);
    else if (p.type === 'day') day = parseInt(p.value, 10);
  }

  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, dateStr };
}

/**
 * Deterministic calendar-day addition on the civil calendar grid.
 * Adding N days to (year, month, day) produces the exact calendar date (year, month, day)
 * without DST distortion or leap-second drift.
 */
export function addCalendarDays(year: number, month: number, day: number, days: number): CalendarDateParts {
  const target = new Date(Date.UTC(year, month - 1, day + days));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth() + 1;
  const d = target.getUTCDate();
  const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { year: y, month: m, day: d, dateStr };
}

/**
 * Returns the timezone offset in milliseconds for a given UTC Date instant in a specific timezone.
 */
function getTzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(date);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;

  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value, 10);
    else if (p.type === 'month') month = parseInt(p.value, 10);
    else if (p.type === 'day') day = parseInt(p.value, 10);
    else if (p.type === 'hour') hour = parseInt(p.value === '24' ? '00' : p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'second') second = parseInt(p.value, 10);
    else if (p.type === 'fractionalSecond') millisecond = parseInt(p.value || '0', 10);
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  return asUtc - date.getTime();
}

/**
 * Converts a local wall-clock date and time in a specific timezone to a UTC Date.
 * Resolves DST spring-forward (gap) and fall-back (overlap) transitions cleanly.
 */
export function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const tz = validateIanaTimeZone(timeZone);
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTzOffsetMs(new Date(approxUtc), tz);
  const cand = approxUtc - offset1;
  const offset2 = getTzOffsetMs(new Date(cand), tz);
  const finalMs = approxUtc - offset2;
  return new Date(finalMs);
}

/**
 * Returns the end-of-day cutoff instant in UTC milliseconds for (nowMs + futureDays)
 * in the specified IANA timezone. The cutoff is the start of the following calendar day (00:00:00).
 */
export function getCutoffInstantMs(nowMs: number, futureDays: number, timeZone: string): number {
  const current = getCalendarDatePartsInTz(nowMs, timeZone);
  const target = addCalendarDays(current.year, current.month, current.day, futureDays);
  const nextDay = addCalendarDays(target.year, target.month, target.day, 1);
  const cutoffDate = localDateTimeToUtc(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, timeZone);
  return cutoffDate.getTime();
}

/**
 * Validates whether a YYYY-MM-DD string is a valid real Gregorian calendar date.
 * Enforces correct months (1-12), days per month (28, 29, 30, 31), and leap-year rules.
 */
export function isValidGregorianDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parts = dateStr.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= daysInMonth[m - 1];
}

/**
 * Evaluates whether an ingestion calendar event is beyond the future horizon.
 */
export function isEventBeyondFutureHorizon(
  ev: { startIso: string; allDay: boolean; startDate?: string },
  futureDays: number,
  timeZone: string,
  nowMs: number = Date.now(),
): boolean {
  const tz = validateIanaTimeZone(timeZone);
  const today = getCalendarDatePartsInTz(nowMs, tz);
  const cutoff = addCalendarDays(today.year, today.month, today.day, futureDays);

  if (ev.allDay) {
    const dateStr = ev.startDate && isValidGregorianDate(ev.startDate)
      ? ev.startDate
      : (ev.startIso && isValidGregorianDate(ev.startIso.slice(0, 10)) ? ev.startIso.slice(0, 10) : '');
    if (!isValidGregorianDate(dateStr)) return true; // fail closed
    return dateStr > cutoff.dateStr;
  }

  const startMs = Date.parse(ev.startIso);
  const datePart = ev.startIso ? ev.startIso.slice(0, 10) : '';
  if (!Number.isFinite(startMs) || !isValidGregorianDate(datePart)) return true; // fail closed
  const cutoffInstantMs = getCutoffInstantMs(nowMs, futureDays, tz);
  return startMs >= cutoffInstantMs;
}

/**
 * Classifies a stored or in-memory page for calendar horizon containment and recurrence.
 *
 * Guarantees:
 *   - Non-calendar meeting pages return isCalendar: false, beyondFutureHorizon: false.
 *   - Legacy pages without recurrence metadata return recurrenceKind: 'unknown'.
 *   - Explicit new pages return recurrenceKind: 'recurring' | 'single'.
 *   - Missing or malformed date fields return valid: false, beyondFutureHorizon: true, isFuture: true (fail-closed).
 */
export function classifyCalendarEvent(opts: ClassifyCalendarEventOptions): CalendarClassification {
  const slug = opts.slug ?? '';
  const type = opts.type ?? '';
  const fm = (opts.frontmatter ?? {}) as Record<string, unknown>;
  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  // 1. Calendar page detection
  const isCalSlug = slug.startsWith('calendar/') || slug.startsWith('cal/');
  const isCalType = type === 'calendar-event';
  const hasCalMarkers = fm.type === 'meeting' && (
    fm.event_id !== undefined ||
    fm.start_date !== undefined ||
    fm.all_day !== undefined ||
    fm.recurrence !== undefined ||
    fm.recurring_event_id !== undefined ||
    isCalSlug
  );

  const isCalendar = isCalSlug || isCalType || Boolean(hasCalMarkers);
  if (!isCalendar) {
    return {
      isCalendar: false,
      recurrenceKind: 'single',
      beyondFutureHorizon: false,
      isFuture: false,
      valid: true,
    };
  }

  // 2. Recurrence classification
  let recurrenceKind: RecurrenceKind = 'unknown';
  if (fm.recurrence === 'recurring' || Boolean(fm.recurring_event_id) || Boolean(fm.original_start_time)) {
    recurrenceKind = 'recurring';
  } else if (fm.recurrence === 'single') {
    recurrenceKind = 'single';
  } else {
    // Legacy pages omitting recurrence evaluate to 'unknown'.
    // Never infer recurrence from slugs or event IDs.
    recurrenceKind = 'unknown';
  }

  // 3. Timezone resolution - fail closed on missing/invalid timezone. NO UTC FALLBACK.
  const tzRaw = typeof fm.timezone === 'string' && fm.timezone.trim()
    ? fm.timezone.trim()
    : typeof opts.timeZone === 'string' && opts.timeZone.trim()
      ? opts.timeZone.trim()
      : null;

  if (!tzRaw) {
    return {
      isCalendar: true,
      recurrenceKind,
      beyondFutureHorizon: true,
      isFuture: true,
      valid: false,
      error: 'Missing required timezone on calendar event (fail-closed, no UTC fallback)',
    };
  }

  let tz: string;
  try {
    tz = validateIanaTimeZone(tzRaw);
  } catch (e) {
    return {
      isCalendar: true,
      recurrenceKind,
      beyondFutureHorizon: true,
      isFuture: true,
      valid: false,
      error: `Invalid timezone: "${tzRaw}"`,
    };
  }

  // 4. Resolve futureDays: explicit option wins, then frontmatter horizon_days/future_days, then default 60.
  const fmHorizon = typeof fm.horizon_days === 'number' && Number.isFinite(fm.horizon_days)
    ? fm.horizon_days
    : typeof fm.future_days === 'number' && Number.isFinite(fm.future_days)
      ? fm.future_days
      : undefined;

  const futureDays = typeof opts.futureDays === 'number' && Number.isFinite(opts.futureDays)
    ? Math.max(1, Math.min(365, Math.floor(opts.futureDays)))
    : (fmHorizon !== undefined
      ? Math.max(1, Math.min(365, Math.floor(fmHorizon)))
      : 60);

  const today = getCalendarDatePartsInTz(nowMs, tz);
  const cutoff = addCalendarDays(today.year, today.month, today.day, futureDays);
  const isAllDay = fm.all_day === true || fm.all_day === 'true';

  const rawStartDate = typeof fm.start_date === 'string' ? fm.start_date.trim() : '';
  const rawStart = typeof fm.start === 'string' ? fm.start.trim() : '';

  if (isAllDay) {
    // All-day event: derives strictly from start_date (or YYYY-MM-DD prefix of start)
    const dateStr = rawStartDate || (rawStart ? rawStart.slice(0, 10) : '');
    if (!isValidGregorianDate(dateStr)) {
      return {
        isCalendar: true,
        recurrenceKind,
        beyondFutureHorizon: true,
        isFuture: true,
        valid: false,
        error: `Malformed, invalid, or non-Gregorian all-day start date: "${dateStr}"`,
      };
    }
    const isFuture = dateStr > today.dateStr;
    const beyondFutureHorizon = dateStr > cutoff.dateStr;
    return {
      isCalendar: true,
      recurrenceKind,
      beyondFutureHorizon,
      isFuture,
      valid: true,
      startDate: dateStr,
    };
  }

  // Timed event: must preserve instant precision (comparing startMs with nowMs)
  if (!rawStart) {
    return {
      isCalendar: true,
      recurrenceKind,
      beyondFutureHorizon: true,
      isFuture: true,
      valid: false,
      error: 'Missing start timestamp for timed calendar event',
    };
  }

  const startMs = Date.parse(rawStart);
  const rawDatePart = rawStart.slice(0, 10);
  if (!Number.isFinite(startMs) || !isValidGregorianDate(rawDatePart)) {
    return {
      isCalendar: true,
      recurrenceKind,
      beyondFutureHorizon: true,
      isFuture: true,
      valid: false,
      error: `Malformed start timestamp: "${rawStart}"`,
    };
  }

  const cutoffInstantMs = getCutoffInstantMs(nowMs, futureDays, tz);
  const isFuture = startMs > nowMs;
  const beyondFutureHorizon = startMs >= cutoffInstantMs;

  return {
    isCalendar: true,
    recurrenceKind,
    beyondFutureHorizon,
    isFuture,
    valid: true,
    startDate: rawStart.slice(0, 10),
  };
}
