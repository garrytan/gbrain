/**
 * Recall's `since` grammar (a dependency-free leaf). parseSinceParam is the one
 * parser the recall op and the recall CLI share: it tries ISO 8601, epoch
 * millis and "8 hours ago" / "2d" first and falls back to the relative
 * phrases below, so every input that parsed before keeps its result.
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

/**
 * Parse a `since` parameter into a Date. Accepts ISO 8601, plain duration
 * shorthand ("8 hours ago", "3 days ago", "30m", "1h", "2d", "7d"), Unix
 * epoch millis, or a relative phrase (parseRelativeSince: "6 weeks ago",
 * "last month"). Returns null on unparseable input.
 */
export function parseSinceParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Try ISO first.
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  // "N (minutes|hours|days) ago" or compact forms.
  const ago = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)(?:\s+ago)?$/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    const unit = ago[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms);
  }
  return parseRelativeSince(s);
}

/** The accepted `since` grammar, for refusals that echo a bad value. */
export const SINCE_GRAMMAR = 'an ISO 8601 date or datetime ("2026-08-11", "2026-08-11T09:00:00Z"), a duration ("8 hours ago", "30m", "2d"), or a relative phrase ("6 weeks ago", "last month")';
