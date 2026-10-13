/**
 * Relative `since` phrases for recall (a dependency-free leaf shared by the
 * recall op and the recall CLI). Both parsers try their existing grammar
 * first (ISO 8601, epoch millis, "8 hours ago", "2d") and fall back to this
 * one, so every input that parsed before keeps its result.
 *
 * Accepted (case-insensitive, any spacing):
 *   - "6 weeks ago", "a week ago", "an hour ago", "one month ago"
 *   - compact weeks, months and years: "3w", "2mo", "1y" (optionally "... ago")
 *   - "last month", "past week", "the last 6 weeks", "in the past 2 years"
 * Months and years step the UTC calendar, clamping the day to the target
 * month's length (March 31 minus one month is February 28 or 29).
 */

const UNITS: Array<[RegExp, 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year']> = [
  [/^(?:s|secs?|seconds?)$/, 'second'],
  [/^(?:mins?|minutes?)$/, 'minute'],
  [/^(?:h|hrs?|hours?)$/, 'hour'],
  [/^(?:d|days?)$/, 'day'],
  [/^(?:w|wks?|weeks?)$/, 'week'],
  [/^(?:mo|mos|months?)$/, 'month'],
  [/^(?:y|yrs?|years?)$/, 'year'],
];

const AGO_RE = /^(?:(?<n>\d+)\s*|(?<one>an?|one)\s+)(?<unit>[a-z]+)(?:\s+ago)?$/;
const LAST_RE = /^(?:in\s+)?(?:the\s+)?(?:last|past)\s+(?:(?:(?<n>\d+)|(?<one>an?|one))\s+)?(?<unit>[a-z]+)$/;

function step(now: number, n: number, unit: string): Date | null {
  const fixed: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
  if (fixed[unit] !== undefined) {
    const d = new Date(now - n * fixed[unit]);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(now);
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth() - (unit === 'year' ? n * 12 : n);
  const year = Math.floor(months / 12);
  const month = months - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  return Number.isFinite(out.getTime()) ? out : null;
}

/** The start of a relative `since` window, or null when the phrase is not one of the forms above. */
export function parseRelativeSince(raw: string, now: number = Date.now()): Date | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const g = (s.match(AGO_RE) ?? s.match(LAST_RE))?.groups;
  if (!g) return null;
  const unit = UNITS.find(([re]) => re.test(g.unit!))?.[1];
  if (!unit) return null;
  const count = g.n === undefined ? 1 : Number(g.n);
  if (!Number.isSafeInteger(count)) return null;
  return step(now, count, unit);
}
