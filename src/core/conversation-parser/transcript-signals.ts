/**
 * Transcript-likeness signals (#4193).
 *
 * `conversation_format_coverage` used to treat every page whose type is in
 * the conversation allowlist as a transcript-parsing candidate, so summary
 * documents that legitimately use `meeting`/`slack` types counted as parser
 * failures even though they contain no conversation turns. This helper is
 * the single definition of "this page claims to contain a transcript" so a
 * `no_match` on a summary page can be reported as summary-only rather than
 * as coverage debt.
 *
 * Deliberately conservative: it never constructs messages and never treats
 * `Name: text` labels as a signal (builtins.ts's own test_negative shows
 * that shape is ambiguous in real summaries). A false positive only means
 * the page keeps today's behavior (counted as a miss).
 */
import type { Page } from '../types.ts';

/**
 * A `## Transcript` / `### Raw transcript` style section heading. Grounded
 * in the real meeting-page shape (`## Summary` + `## Transcript`,
 * see parse.ts's SCORING_HEAD_TRIGGER_THRESHOLD rationale).
 */
const TRANSCRIPT_HEADING_RX = /^#{1,6}\s*(?:raw\s+)?transcript\b/im;

/**
 * A time-of-day token near the start of a line — the anchor shape every
 * time-based builtin uses (`[10:12]`, `(Mon 11:18 AM)`, `18:37 <alice>`,
 * `**Name** (2024-03-15 9:00 AM):`). Checked against the first 24 chars of
 * each line so a stray "standup at 3:00" deep in a bullet doesn't count.
 */
const TIME_TOKEN_RX = /[[(]?\b\d{1,2}:\d{2}(?::\d{2})?\b\s*(?:[APap]\.?[Mm]\.?)?[\])]?/;

/**
 * A calendar field such as `- Start: 08:15 AM PST`, `**Time:** 08:15 – 08:45`
 * or `- 开始时间：2031年3月4日 上午8:15` (#9885). Its clock time describes the
 * meeting, not a spoken turn, so it does not count toward the density
 * signal. Only a known calendar label whose whole value is date/time/zone
 * tokens qualifies; anything else on the line keeps it a timed line.
 */
const CALENDAR_FIELD_RX = new RegExp(
  String.raw`^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?` +
    String.raw`(?:(?:meeting\s+)?(?:date|time|date\s*(?:\/|&|and)\s*time)|(?:start|end)(?:s|ed)?(?:\s+(?:time|at|on))?` +
    String.raw`|created(?:\s+(?:at|on))?|creation\s+time|updated(?:\s+(?:at|on))?|scheduled(?:\s+(?:for|at))?|when` +
    String.raw`|(?:会议)?(?:时间|日期)|开始时间|结束时间|创建时间|更新时间)` +
    String.raw`(?:\*\*|__)?\s*[:：]\s*(.+)$`,
  'i',
);
const CALENDAR_ZONE_ABBR_RX = /\b[A-Z]{2,5}\b/g;
const CALENDAR_VALUE_TOKEN_RX = new RegExp(
  [
    String.raw`\d+(?:st|nd|rd|th|[tz](?=\d|\W|$))?`,
    String.raw`\b[ap]\.?m\.?(?![a-z])`,
    String.raw`\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b`,
    String.raw`\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b`,
    String.raw`\b(?:to|until)\b`,
    String.raw`\b[a-z_]+(?:\/[a-z_+-]+)+`,
    String.raw`上午|下午|中午|晚上|凌晨|(?:周|星期)[一二三四五六日天]|[年月日号点分至到]`,
  ].join('|'),
  'gi',
);

function isCalendarField(line: string): boolean {
  const value = CALENDAR_FIELD_RX.exec(line)?.[1];
  if (value === undefined) return false;
  const rest = value.replace(CALENDAR_ZONE_ABBR_RX, ' ').replace(CALENDAR_VALUE_TOKEN_RX, ' ');
  return /^[\s\p{P}\p{S}]*$/u.test(rest);
}

/** Min timestamped lines + min share of non-blank lines for the density
 *  signal. Mirrors the parser's own density-floor philosophy
 *  (SCORING_MIN_ACCEPTANCE): a couple of times in an agenda list is not a
 *  transcript; a page where 10%+ of lines open with a clock time is. */
const TIME_DENSITY_MIN_LINES = 3;
const TIME_DENSITY_MIN_SHARE = 0.1;

/**
 * Does this page claim to contain conversation turns?
 *
 * True when ANY of:
 *  1. `frontmatter.raw_transcript` is a non-empty string — even if the file
 *     did not resolve, the page claims a transcript, so an unparseable body
 *     is genuine coverage debt;
 *  2. the body has a transcript section heading;
 *  3. enough lines open with a time-of-day token (>=3 lines and >=10% of
 *     non-blank lines), not counting calendar fields.
 */
export function isTranscriptClaiming(page: Page | undefined, body: string): boolean {
  const raw = page?.frontmatter?.raw_transcript;
  if (typeof raw === 'string' && raw.trim().length > 0) return true;

  if (TRANSCRIPT_HEADING_RX.test(body)) return true;

  const nonBlank = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;
  let timed = 0;
  for (const line of nonBlank) {
    if (TIME_TOKEN_RX.test(line.slice(0, 24)) && !isCalendarField(line)) timed++;
  }
  return timed >= TIME_DENSITY_MIN_LINES && timed / nonBlank.length >= TIME_DENSITY_MIN_SHARE;
}
