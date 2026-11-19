/**
 * date-grounding.ts — the time vocabulary and the relative-date rule shared by
 * every LLM extraction prompt.
 *
 * THREE TIMES. Every stored claim can carry three different times; code and
 * prompts must never conflate them:
 *
 *   observation time  when the source text was written or said (a chat turn's
 *                     timestamp, a dated note's filename or `date:`). Relative
 *                     phrases ("last week", "by Friday") resolve against it.
 *   event/validity    when the claim was true in the world (`facts.valid_from`;
 *     time            later, edge validity). May differ from observation time:
 *                     a 2026-03 note says "we closed the round in 2024".
 *   recording time    when Foresights stored it (`created_at`). Never used to
 *                     interpret text.
 *
 * WHY. "User went to Lisbon last week" is useless months later; the extractor
 * must write "the week of 2026-03-02". Keeping the relative phrase beside the
 * date ("two days ago (2026-03-02)") reads wrong once the fact is shown under
 * its event date: a reader applies "two days ago" a second time. Resolving against today's date
 * (the run date) silently re-dates historical imports, so the rule names the
 * observation date and forbids "today". When the observation date is unknown
 * the phrase is kept as written — never a guessed date.
 *
 * `resolveObservationDate` deliberately does NOT use a page's `event_date`
 * (an event's own time, not when the note was written) nor the `fallback`
 * effective-date source (row creation / update time), and never returns now.
 *
 * Pure: no engine, no IO. Shared API (other extraction work imports it).
 */

import { computeEffectiveDate, parseDateLoose } from '../effective-date.ts';

/** Prompt-text identity for the grounding rule (provenance; bump on rule edits). */
export const DATE_GROUNDING_RULE_VERSION = 'date-grounding-v2';

/** Where an observation date came from. `caller` = supplied by the code path (turn timestamp, message date). */
export type ObservationDateSource = 'caller' | 'filename' | 'date' | 'published' | 'created';

export interface ObservationDate {
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  source: ObservationDateSource;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD of a Date in UTC. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Observation date of a page: its filename/slug date, frontmatter `date`,
 * `published`, or a created key — whichever `computeEffectiveDate`'s
 * precedence picks once `event_date` is removed. Null when none exists; never
 * the row timestamps and never now().
 */
export function resolveObservationDate(page: {
  slug: string;
  frontmatter?: Record<string, unknown> | null;
  /** Import basename without extension, when known. Defaults to the slug's last segment. */
  filename?: string | null;
  /** `brain.timezone` for offset-less datetimes. */
  timeZone?: string;
}): ObservationDate | null {
  const { event_date: _eventDate, ...frontmatter } = page.frontmatter ?? {};
  const invalid = new Date(Number.NaN);
  const result = computeEffectiveDate({
    slug: page.slug,
    frontmatter,
    filename: page.filename ?? page.slug.split('/').pop() ?? null,
    timeZone: page.timeZone,
    createdAt: invalid,
    updatedAt: invalid,
  });
  if (!result.date || !result.source) return null;
  if (result.source !== 'filename' && result.source !== 'date' && result.source !== 'published' && result.source !== 'created') {
    return null;
  }
  return { date: isoDay(result.date), source: result.source };
}

/** An observation date supplied directly by a code path (turn timestamp, message date). Null when unparseable. */
export function observationDateFrom(value: Date | string | null | undefined): ObservationDate | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : parseDateLoose(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  return { date: isoDay(d), source: 'caller' };
}

/**
 * The rule text for a SYSTEM prompt. Static (no date inside), so a system
 * prompt that embeds it stays byte-identical across calls and prompt-cache
 * friendly; the date itself goes in the user message via `observationDateLine`.
 */
export function observationDateRule(): string {
  return [
    'Dates: the input states its observation date (when the text was written or said).',
    'Rewrite every relative time reference (yesterday, last week, next month, recently, in 18 months, by Friday,',
    'for about a month) as an absolute date or bound resolved against the observation date,',
    "never against today's date, so the saved text means the same thing on any later day:",
    "'flew to Lisbon last week' -> 'flew to Lisbon the week of 2026-03-02', 'due by Friday' -> 'due by 2026-03-13',",
    "'has played for about a month' -> 'has played since about 2026-02-10', 'recently moved' -> 'moved before 2026-03-10'.",
    'Do not leave the relative phrase beside its date. Never turn an absolute date into a vague one. If the observation',
    'date is unknown, keep relative phrases exactly as written and do not invent dates.',
    'Never alter text you are asked to quote verbatim.',
  ].join('\n');
}

/** The user-message line carrying the observation date (or its absence). */
export function observationDateLine(observation: ObservationDate | null): string {
  return observation
    ? `Observation date: ${observation.date} (when this text was written or said; resolve relative dates against it).`
    : 'Observation date: unknown (keep relative dates as written).';
}

/** Earliest event date an extractor may assert. */
const MIN_EVENT_YEAR = 1900;

/**
 * Validate an extractor-stated event date (`YYYY-MM-DD`). Rejects malformed
 * values, dates before 1900, and dates more than one year after `now`
 * (the same forward window effective dates use). Returns a UTC-midnight Date.
 */
export function parseExtractedEventDate(raw: unknown, now: Date = new Date()): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || isoDay(d) !== s) return null;
  if (d.getUTCFullYear() < MIN_EVENT_YEAR) return null;
  const max = new Date(now.getTime());
  max.setUTCFullYear(max.getUTCFullYear() + 1);
  if (d.getTime() > max.getTime()) return null;
  return d;
}

/** Which input set a fact's valid_from. */
export type ValidFromSource = 'extracted' | 'caller' | 'observation' | 'now';

/**
 * `facts.valid_from` precedence: an event date the extractor stated (already
 * validated) > a caller-supplied time > the observation date > now.
 */
export function resolveValidFrom(input: {
  extracted?: Date | null;
  caller?: Date | null;
  observation?: ObservationDate | null;
  now?: Date;
}): { date: Date; source: ValidFromSource } {
  if (input.extracted) return { date: input.extracted, source: 'extracted' };
  if (input.caller) return { date: input.caller, source: 'caller' };
  if (input.observation) return { date: new Date(`${input.observation.date}T00:00:00.000Z`), source: 'observation' };
  return { date: input.now ?? new Date(), source: 'now' };
}

/**
 * Judge-free check used by tests and the eval: true when `text` holds a
 * relative time phrase NOT followed by a parenthesized absolute date or bound.
 */
const RELATIVE_PHRASE_RE = /\b(yesterday|today|tomorrow|tonight|last (?:week|month|year|night|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (?:week|month|year|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:week|month|year|weekend|morning|afternoon|evening)|recently|\d+ (?:days?|weeks?|months?|years?) ago|in \d+ (?:days?|weeks?|months?|years?))\b(?!\s*\()/i;

export function hasUnresolvedRelativeDate(text: string): boolean {
  return RELATIVE_PHRASE_RE.test(text);
}
