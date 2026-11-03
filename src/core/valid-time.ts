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

/** The accepted forms; the same pattern runs in TypeScript and in Postgres (ARE), the date is the first group. */
const DATE_FORM = '^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T00:00:00(?:[.]0+)?(?:Z|[+]00:00))?$';
const DATE_RE = new RegExp(DATE_FORM);

/** The calendar date a frontmatter value declares, or null when it is not one of the accepted forms. */
export function validDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : validDate(value.toISOString());
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const date = m[1]!;
  const [year, month, day] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() ? date : null;
}

/**
 * SQL twin of `validDate` over a text expression (`frontmatter->>'valid_from'`): the date as `YYYY-MM-DD` text, or
 * NULL. Nested CASE so a bad month never reaches make_date; it never raises on any input.
 */
export function validDateSql(textExpr: string): string {
  const d = `substring(${textExpr} from '${DATE_FORM}')`;
  const y = `substr(${d}, 1, 4)::int`, m = `substr(${d}, 6, 2)::int`, day = `substr(${d}, 9, 2)::int`;
  return `(CASE WHEN ${d} IS NULL THEN NULL
    WHEN ${y} < 1000 OR ${m} NOT BETWEEN 1 AND 12 THEN NULL
    WHEN ${day} BETWEEN 1 AND extract(day from make_date(${y}, ${m}, 1) + interval '1 month' - interval '1 day')::int THEN ${d}
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
export const VALID_TIME_MIN_HOST_VERSION = '0.60.475.0';

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
