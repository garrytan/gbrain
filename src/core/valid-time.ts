/**
 * GBRA-217 valid time: which edition of a page was in force on a date, from the frontmatter `valid_from` /
 * `valid_until` each retained version carries. Intervals are half-open, `[valid_from, valid_until)`, as links are
 * (link-validity.ts).
 *
 * One date normaliser serves TypeScript (`validDate`) and the SQL pick (`validDateSql`): a calendar date
 * `YYYY-MM-DD`, a YAML Date, or a midnight-UTC ISO timestamp (the form an unquoted YAML date is stored as). Anything
 * else (a partial date, a time of day, another zone) makes that version undated, never guessed.
 *
 * `validTimeVerdict` holds the status rules of a read, as a pure function over what the pick statement measured.
 */
import { utcToday } from './link-validity.ts';
import { opError } from './ops/contract.ts';

/** Statuses of a valid-time answer. Only `in_force` carries the edition's text at the top level. */
export type ValidTimeStatus = 'in_force' | 'not_in_force' | 'not_yet_in_force' | 'before_recorded_history';
/** Whether gbrain still holds every edition the answer depends on. */
export type ValidTimeHistory = 'retained' | 'incomplete' | 'unknown';
/** Why an answer is uncertain; null when it is not. */
export type ValidTimeWhy = 'history_pruned' | 'history_gap' | 'history_unknown' | 'before_recorded_history'
  | 'edition_pruned' | 'ambiguous_edition_dates' | 'undated_editions';

/**
 * The accepted forms; the same patterns run in TypeScript and in Postgres (ARE). pages-03: frontmatter keeps a
 * timestamp as written, so a value counts when the YAML parser that typed these values before (js-yaml's timestamp)
 * read it as UTC midnight: a calendar date, or any YAML timestamp whose instant is midnight UTC (`T00:00:00Z`, a space
 * or `t` separator, no zone, `+00`, `-00:00`, a space before the zone, `02:00:00+02:00`). Its date is the UTC date.
 */
const DAY_FORM = '^([0-9]{4})-([0-9]{2})-([0-9]{2})$';
/** js-yaml's timestamp grammar: 1 year, 2 month, 3 day, 4 hour, 5 minute, 6 second, 7 fraction, 8 sign, 9-10 zone. */
const STAMP_FORM = '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[Tt]|[ \\t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]*))?(?:[ \\t]*(?:Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?$';
const DAY_RE = new RegExp(DAY_FORM), STAMP_RE = new RegExp(STAMP_FORM);
const DAY_MS = 86_400_000;

/** A real calendar day of a four-digit year from 1000 (the old parser kept a calendar-invalid date as text). */
const inCalendar = (y: number, m: number, d: number) => y >= 1000 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The calendar date a frontmatter value declares, or null when it is not one of the accepted forms. */
export function validDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : validDate(value.toISOString());
  if (typeof value !== 'string') return null;
  const day = DAY_RE.exec(value);
  if (day) return Number(day[1]) >= 1000 && inCalendar(Number(day[1]), Number(day[2]), Number(day[3])) ? value : null;
  const m = STAMP_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (!inCalendar(y, mo, d)) return null;
  // As js-yaml built the instant: the fraction's first three digits are milliseconds, out-of-range fields roll over.
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const zone = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10] ?? 0)) * 60_000 : 0;
  const instant = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - zone;
  if (instant % DAY_MS !== 0) return null;
  // A rollover out of the four-digit years (9999-12-31T24:00:00Z) is no date, as the SQL twin refuses it.
  const year = new Date(instant).getUTCFullYear();
  return year >= 1000 && year <= 9999 ? new Date(instant).toISOString().slice(0, 10) : null;
}

/**
 * SQL twin of `validDate` over a text expression (`frontmatter->>'valid_from'`): the date as `YYYY-MM-DD` text, or
 * NULL. Nested CASE so a bad month never reaches make_date; it never raises on any input.
 */
export function validDateSql(textExpr: string): string {
  const day = (form: string) => {
    const g = (i: number) => `(regexp_match(${textExpr}, '${form}'))[${i}]::int`;
    return { y: g(1), m: g(2), d: g(3), last: `extract(day from make_date(${g(1)}, ${g(2)}, 1) + interval '1 month' - interval '1 day')::int` };
  };
  // Each step is its own CASE, so make_date never sees a month or day the step before refused.
  const inCalendar = (form: string, then: string) => {
    const { y, m, d, last } = day(form);
    return `CASE WHEN ${y} >= 1000 AND ${m} BETWEEN 1 AND 12 AND ${d} >= 1 THEN CASE WHEN ${d} <= ${last} THEN ${then} END END`;
  };
  const g = (i: number) => `(regexp_match(${textExpr}, '${STAMP_FORM}'))[${i}]`;
  // Seconds from the written date's midnight to the instant, and its milliseconds (the fraction's first three digits).
  const seconds = `(${g(4)}::int * 3600 + ${g(5)}::int * 60 + ${g(6)}::int - CASE WHEN ${g(8)} IS NULL THEN 0
      ELSE (CASE WHEN ${g(8)} = '-' THEN -1 ELSE 1 END) * (${g(9)}::int * 3600 + coalesce(${g(10)}, '0')::int * 60) END)`;
  const ms = `rpad(substr(coalesce(${g(7)}, ''), 1, 3), 3, '0')::int`;
  const { y, m, d } = day(STAMP_FORM);
  const stamp = `(make_date(${y}, ${m}, ${d}) + (${seconds} / 86400))`;
  const stampDate = `CASE WHEN ${ms} = 0 AND ${seconds} % 86400 = 0 THEN
      CASE WHEN extract(year from ${stamp}) BETWEEN 1000 AND 9999 THEN to_char(${stamp}, 'YYYY-MM-DD') END END`;
  return `(CASE WHEN ${textExpr} ~ '${DAY_FORM}' THEN ${inCalendar(DAY_FORM, textExpr)}
    WHEN ${textExpr} ~ '${STAMP_FORM}' THEN ${inCalendar(STAMP_FORM, stampDate)}
    END)`;
}

/** A declared but unreadable `valid_from` (the write advisory `valid_from_unparsed` names it). */
export function unparsedValidFrom(frontmatter: Record<string, unknown> | null | undefined): boolean {
  const v = frontmatter?.valid_from;
  return v !== undefined && v !== null && v !== '' && validDate(v) === null;
}

/** What the pick statement measured about the chosen edition, or the earliest dated one when none is in force. */
export interface PickedEdition {
  /** True when this edition has the greatest valid_from on or before the date (it is the rule's pick). */
  chosen: boolean;
  isCurrent: boolean;
  validFrom: string;
  validUntil: string | null;
  /** The retained version recorded after this one was pruned. */
  successorPruned: boolean;
  /** When this edition became current (the previous retained version's snapshot time), ISO; null for the first. */
  recordedSince: string | null;
  /** When a later edition replaced it (its own snapshot time), ISO; null for the current page. */
  replacedAt: string | null;
}

export interface PickFacts {
  asOf: string;
  edition: PickedEdition | null;
  undatedVersions: number;
  /** pages.version_history_gap_at, ISO. */
  gapAt: string | null;
  /** No edition has a file behind it: gbrain wrote the page's first recorded version, so nothing predates it. */
  gbrainWritten: boolean;
  /** No gap is marked, but the page has enough large or segmented versions that a prune may have run before the marker existed. */
  couldHaveBeenPruned: boolean;
  /** Versions around the pick have an ambiguous shape (adjacent same body with another date, or recorded later with an earlier date). */
  ambiguous: boolean;
}

export interface ValidTimeVerdict {
  status: ValidTimeStatus;
  history: ValidTimeHistory;
  uncertain: boolean;
  why: ValidTimeWhy | null;
}

/**
 * Decisions 5 and 6 of the valid-time plan: the status, whether the history the answer rests on is retained, and the
 * one reason it is uncertain. A gap makes the answer uncertain only when it falls inside the chosen edition's recorded
 * span (or the date precedes every retained edition); dates the retained editions cover after a gap stay certain.
 */
export function validTimeVerdict(f: PickFacts): ValidTimeVerdict {
  const e = f.edition?.chosen ? f.edition : null;
  const unknown = f.couldHaveBeenPruned && f.gapAt === null;
  let status: ValidTimeStatus;
  if (e) status = e.validUntil !== null && e.validUntil <= f.asOf ? 'not_in_force' : 'in_force';
  else status = f.gbrainWritten && f.gapAt === null && !unknown ? 'not_yet_in_force' : 'before_recorded_history';
  const gap = f.gapAt === null ? null : Date.parse(f.gapAt);
  const gapInSpan = e !== null && gap !== null && (e.recordedSince === null || Date.parse(e.recordedSince) < gap)
    && (e.replacedAt === null || Date.parse(e.replacedAt) >= gap);
  let why: ValidTimeWhy | null = null;
  let history: ValidTimeHistory = 'retained';
  if (unknown) { history = 'unknown'; why = 'history_unknown'; }
  else if (e?.successorPruned) { history = 'incomplete'; why = 'history_pruned'; }
  else if (gapInSpan) { history = 'incomplete'; why = 'history_gap'; }
  else if (!e && gap !== null) { history = 'incomplete'; why = 'history_gap'; }
  else if (!e && !f.gbrainWritten) { history = 'incomplete'; why = 'before_recorded_history'; }
  if (why === null && f.ambiguous) why = 'ambiguous_edition_dates';
  if (why === null && !e && f.undatedVersions > 0) why = 'undated_editions';
  return { status, history, uncertain: why !== null, why };
}

/**
 * B7: a plain read of a current page that is not in force today carries its status (additive). Null for a page with
 * no readable `valid_from` / `valid_until`, or one in force today, so its read is unchanged.
 */
export function currentValidTime(frontmatter: Record<string, unknown> | null | undefined, today: string = utcToday()):
  { status: 'not_in_force' | 'not_yet_in_force'; as_of: string; valid_from: string | null; valid_until: string | null } | null {
  const from = validDate(frontmatter?.valid_from), until = validDate(frontmatter?.valid_until);
  const status = from !== null && from > today ? 'not_yet_in_force' : until !== null && until <= today ? 'not_in_force' : null;
  return status ? { status, as_of: today, valid_from: from, valid_until: until } : null;
}

/**
 * The first release whose get_page answers `as_of` (echoing `valid_time.as_of`). Stamped with the release at ship time;
 * the client names it in `host_upgrade_required`.
 */
export const VALID_TIME_MIN_HOST_VERSION = '0.60.578.0';

/**
 * B4 version skew: an `as_of` read's reply must echo `valid_time.as_of`. An older host ignores the parameter and
 * answers the plain read (the current page), so a reply without the echo fails closed: nothing historical is printed.
 */
export function assertValidTimeEcho(params: Record<string, unknown>, result: unknown, versions: { client: string; host: string | null }): void {
  if (params.as_of === undefined) return;
  const echoed = (result as { valid_time?: { as_of?: unknown } } | null)?.valid_time?.as_of;
  if (echoed === params.as_of) return;
  const host = versions.host ?? 'unknown';
  throw opError('host_upgrade_required',
    `The brain host (gbrain ${host}) answered get_page without valid time, so its reply is the current page, not the edition in force on ${String(params.as_of)}. Nothing was printed.`,
    `Upgrade gbrain on the brain host to ${VALID_TIME_MIN_HOST_VERSION} or later (gbrain upgrade), or ask its operator to, then run the same read again.`,
    { detail: JSON.stringify({ client_version: versions.client, host_version: host, min_host_version: VALID_TIME_MIN_HOST_VERSION }),
      fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: 'The host predates get_page as_of; an upgraded host answers the date read with valid_time.',
        user_message: `This brain's host runs an older gbrain that cannot read a page by date. Please run gbrain upgrade on the brain host (it needs ${VALID_TIME_MIN_HOST_VERSION} or later), or ask whoever runs it.` } });
}

/** A write's valid-time advisory: what the write result tells the writer about the edition dates it kept or changed. */
export interface ValidTimeAdvisory {
  code: 'valid_from_unparsed' | 'valid_time_correction' | 'valid_time_date_only';
  message: string;
  valid_from: string | null;
  previous_valid_from?: string;
}

/**
 * B1/B6: the advisory for one page write, from the page before and after. A body change under an unchanged
 * `valid_from` is read as a correction of that edition; a date-only change is a question, because as_of cannot tell a
 * corrected date from a renewal of unchanged text and flags it. Null when nothing applies.
 */
export function validTimeWriteAdvisory(before: { frontmatter: Record<string, unknown> | null; body: string } | null,
  after: { frontmatter: Record<string, unknown> | null; body: string }): ValidTimeAdvisory | null {
  if (unparsedValidFrom(after.frontmatter)) {
    return { code: 'valid_from_unparsed', valid_from: null,
      message: "valid_from is not a calendar date (YYYY-MM-DD), so this version is undated and as_of reads will not pick it. Write it quoted, for example valid_from: '2026-07-01'." };
  }
  if (!before) return null;
  const was = validDate(before.frontmatter?.valid_from), now = validDate(after.frontmatter?.valid_from);
  const bodyChanged = before.body !== after.body;
  if (now !== null && was === now && bodyChanged) {
    return { code: 'valid_time_correction', valid_from: now,
      message: `Treated as a correction of the edition in force since ${now}; set valid_from if this takes effect later.` };
  }
  if (now !== null && was !== null && was !== now && !bodyChanged) {
    return { code: 'valid_time_date_only', valid_from: now, previous_valid_from: was,
      message: `Only valid_from changed (${was} to ${now}). Is this a correction of the earlier date, or a renewal of an unchanged edition? as_of reads around these dates are marked uncertain (ambiguous_edition_dates), because the two look the same.` };
  }
  return null;
}
