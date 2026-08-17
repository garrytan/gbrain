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
 *     non-blank lines).
 */
export function isTranscriptClaiming(page: Page | undefined, body: string): boolean {
  const raw = page?.frontmatter?.raw_transcript;
  if (typeof raw === 'string' && raw.trim().length > 0) return true;

  if (TRANSCRIPT_HEADING_RX.test(body)) return true;

  const nonBlank = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;
  let timed = 0;
  for (const line of nonBlank) {
    if (TIME_TOKEN_RX.test(line.slice(0, 24))) timed++;
  }
  return timed >= TIME_DENSITY_MIN_LINES && timed / nonBlank.length >= TIME_DENSITY_MIN_SHARE;
}
