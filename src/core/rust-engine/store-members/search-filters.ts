/**
 * The page filters the keyword and vector search members send the store in the same shape: the frontmatter `where`
 * filter as containment forms per key, and a date bound as UTC microseconds. Each refuses, for `member`, a shape the
 * store does not read.
 *
 * Not a member file: index.ts does not spread it.
 */
import { refuseMember } from './common.ts';

/** `frontmatterWhereSql`'s containment forms per key: the value, and a numeric or boolean reading of a string. */
export function whereFields(member: string, where: unknown): [string, unknown[]][] {
  if (typeof where !== 'object' || where === null || Array.isArray(where)) refuseMember(member, 'a where that is not an object');
  return Object.entries(where as Record<string, unknown>).map(([key, values]) => {
    // The SQL engines read a normalized where (every key a non-empty list); anything else fails there.
    if (!Array.isArray(values) || values.length === 0) refuseMember(member, `where.${key} that is not a non-empty list`);
    const forms: unknown[] = [];
    for (const v of values) {
      if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
        refuseMember(member, `where.${key} value that is not a string, number or boolean`);
      }
      forms.push(v);
      if (typeof v === 'string') {
        if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) forms.push(Number(v));
        if (v === 'true' || v === 'false') forms.push(v === 'true');
      }
    }
    return [key, forms];
  });
}

// `$n::text::timestamptz` with TimeZone UTC, for the ISO shapes: a date, or a date and time with an optional
// fraction and zone. Postgres reads the date-time separator and the zone letter in either case. Postgres reads many
// more shapes; those refuse.
const ISO_DATE = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/;

/**
 * Postgres's `ParseFractionalSecond`: `rint(strtod(".ffff") * 1e6)`, so a fraction past six digits rounds to the
 * nearest microsecond, a tie goes to the even one, and 0.9999995 or more is a whole second.
 */
function fractionMicros(digits: string | undefined): number {
  if (!digits) return 0;
  const scaled = Number(`0.${digits}`) * 1_000_000;
  const whole = Math.floor(scaled);
  const rest = scaled - whole;
  if (rest > 0.5) return whole + 1;
  if (rest < 0.5) return whole;
  return whole % 2 === 0 ? whole : whole + 1;
}

/** A date bound as UTC microseconds (decimal text), or a refusal for a shape the store does not parse. */
export function dateMicros(member: string, raw: unknown): string {
  const m = typeof raw === 'string' ? ISO_DATE.exec(raw) : null;
  if (!m) refuseMember(member, 'a date bound that is not an ISO date or date-time');
  const [year, month, day, hour = 0, minute = 0, second = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(v => (v === undefined ? undefined : Number(v))) as number[];
  const fraction = fractionMicros(m[7]);
  const monthDays = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const midnight = hour === 24 && minute === 0 && second === 0 && fraction === 0;
  if (month < 1 || month > 12 || day < 1 || day > monthDays || (hour > 23 && !midnight) || minute > 59 || second > 59) {
    refuseMember(member, 'a date bound outside the calendar');
  }
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone && zone !== 'Z' && zone !== 'z') {
    const digits = zone.slice(1).replace(':', '');
    const hh = Number(digits.slice(0, 2));
    const mm = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (hh > 15 || mm > 59) refuseMember(member, 'a date bound with an offset outside ±15:59');
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (hh * 60 + mm);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute - offsetMinutes, second, 0);
  return (BigInt(date.getTime()) * 1000n + BigInt(fraction)).toString();
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
