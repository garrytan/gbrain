/**
 * Email thread pages for extract-conversation-facts: the collector format
 * (`## From — RFC-2822 date (sent|received)` headings), sender parsing, the
 * automated-sender denylist, scope rules and the anchor-count guard. Pure
 * helpers plus one config read; the extraction core in
 * ../extract-conversation-facts.ts owns the pipeline.
 */

import type { BrainEngine } from '../../core/engine.ts';
import type { Page } from '../../core/types.ts';
import type { MatchedMessage } from '../../core/conversation-parser/types.ts';

/**
 * Email threads: replies arrive over days, not minutes, so the episode gap is
 * a week. Facts are dated at their segment's start (claim-time dating), so a
 * wider gap would date a reply months early; a narrower one would fragment
 * a normal back-and-forth. Episodes of a real thread are all kept, even a
 * one-message episode (see the email branch in processPage).
 */
export const EMAIL_SEGMENT_GAP_MINUTES = 60 * 24 * 7;

/**
 * Rendered-body char budget per segment. Keeps every segment under
 * SEGMENT_TEXT_CHAR_LIMIT with headroom for the header, so a long thread
 * splits into more segments instead of losing its tail to truncation.
 * Opt-in via SplitSegmentsOpts.maxChars (the email path); other types keep
 * the historical message-count-only cut.
 */
export const DEFAULT_SEGMENT_MAX_CHARS = 5800;

/** Pattern id the email path forces (see ParseConversationOpts.forcePatternId). */
export const EMAIL_THREAD_PATTERN_ID = 'email-thread-heading';

/**
 * Default senders whose messages carry no conversational facts:
 * comment/notification relays, bounce and no-reply addresses, form
 * submissions, job boards. Tested against the lowercased address (or the
 * name when no address parsed) and dropped before segmenting, so a thread
 * with one human reply keeps the human messages only. Operators extend the
 * list with `facts.email_automated_senders` (a JSON array of lowercase
 * strings: an entry with `@` matches the address exactly or as a suffix,
 * `@relay.example`; any other entry matches as a substring, `noreply`);
 * see compileEmailSenderDenylist.
 */
export const EMAIL_AUTOMATED_SENDERS: readonly RegExp[] = [
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply)@/,
  /^(?:notifications?|notify|mailer-daemon|bounces?|postmaster|alerts?|calendar-notification)[@._+-]/,
  /@docs\.google\.com$/,
  /@calendar-server\.bounces\.google\.com$/,
  /@mail\.zapier\.com$/,
  /@webflow\.com$/,
  /@jobsinnetwork\.com$/,
];

/** Config key: extra automated-sender rules, merged with EMAIL_AUTOMATED_SENDERS. */
export const EMAIL_AUTOMATED_SENDERS_CONFIG_KEY = 'facts.email_automated_senders';

/**
 * One denylist rule: a built-in RegExp, or an operator string. Strings are
 * never compiled into a RegExp (an operator typo cannot become a
 * catastrophic pattern, and the input is attacker-influenced email text):
 * an entry containing `@` matches the address exactly or as a suffix, any
 * other entry matches as a substring of the address (or of the lowercased
 * display name when no address parsed).
 */
export type EmailSenderRule = RegExp | string;

/**
 * The run's sender denylist: the built-in defaults plus operator rules.
 * A non-string or empty entry is reported and skipped, never fatal, so one
 * mistake in config cannot stop a backfill.
 */
export function compileEmailSenderDenylist(extra: readonly unknown[] | undefined): readonly EmailSenderRule[] {
  const out: EmailSenderRule[] = [...EMAIL_AUTOMATED_SENDERS];
  for (const entry of extra ?? []) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      process.stderr.write(
        `[extract-conversation-facts] ${EMAIL_AUTOMATED_SENDERS_CONFIG_KEY}: entry ${JSON.stringify(entry)} ignored (expected a non-empty string)\n`,
      );
      continue;
    }
    out.push(entry.trim().toLowerCase());
  }
  return out;
}

function senderRuleMatches(rule: EmailSenderRule, probe: string): boolean {
  if (typeof rule !== 'string') return rule.test(probe);
  if (rule.includes('@')) return probe === rule || probe.endsWith(rule);
  return probe.includes(rule);
}

export async function loadEmailSenderDenylist(engine: BrainEngine): Promise<readonly EmailSenderRule[]> {
  const raw = await engine.getConfig(EMAIL_AUTOMATED_SENDERS_CONFIG_KEY);
  if (!raw) return EMAIL_AUTOMATED_SENDERS;
  try {
    const parsed = JSON.parse(raw);
    return compileEmailSenderDenylist(Array.isArray(parsed) ? parsed : []);
  } catch {
    process.stderr.write(
      `[extract-conversation-facts] ${EMAIL_AUTOMATED_SENDERS_CONFIG_KEY} is not a JSON array; using the built-in denylist\n`,
    );
    return EMAIL_AUTOMATED_SENDERS;
  }
}

// ---------------------------------------------------------------------------
// Email thread pages (collector format, see EMAIL_THREAD_PATTERN_ID).
// ---------------------------------------------------------------------------

const HTML_ENTITY_RE = /&(lt|gt|amp|quot|#39);/g;
const HTML_ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  '#39': "'",
};
function decodeEntities(s: string): string {
  return s.replace(HTML_ENTITY_RE, (_, k: string) => HTML_ENTITY_MAP[k] ?? '');
}
const OPEN_IN_GMAIL_RE = /^\[Open in Gmail\]\([^)]*\)\s*$/;
const EMAIL_SENT_HEADING_RE = /^##\s.*\(sent\)\s*$/m;
/**
 * A collector message heading in full shape: `## From — Date (direction)`,
 * where Date starts like an RFC-2822 date (`Thu, 18 Jun 2026` or
 * `18 Jun 26`). A quoted section heading such as `## Notes — Q3 plan (sent)`
 * has no date and is body text.
 */
const EMAIL_ANCHOR_LINE_RE = /^## .+ — (?:[A-Za-z]{3}, )?\d{1,2} [A-Za-z]{3} \d{2,4} .*\((?:sent|received)\)\s*$/;

/**
 * Number of body lines shaped like a collector message heading. Compared with
 * the parsed message count so a heading the pattern rejects (an unexpected
 * date shape) can never fold silently into the previous sender's body.
 */
export function countEmailAnchorLines(body: string): number {
  let n = 0;
  for (const line of body.split(/\r?\n/)) if (EMAIL_ANCHOR_LINE_RE.test(line.trim())) n++;
  return n;
}

export interface EmailSender {
  name: string;
  address: string | null;
}

/** Split the collector's HTML-escaped `Name <addr>` into display name + address. */
export function parseEmailSender(raw: string): EmailSender {
  // The collector's escapeMd emits `&lt;`/`&gt;` and backslash-escaped `[`/`]`.
  const decoded = decodeEntities(raw).replace(/\\([\[\]])/g, '$1').trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(decoded);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name || m[2], address: m[2].toLowerCase() };
  }
  if (/^[^\s<>]+@[^\s<>]+$/.test(decoded)) {
    return { name: decoded, address: decoded.toLowerCase() };
  }
  const name = decoded.replace(/^"(.*)"$/, '$1').trim();
  return { name: name || 'unknown', address: null };
}

export function isAutomatedEmailSender(
  sender: EmailSender,
  denylist: readonly EmailSenderRule[] = EMAIL_AUTOMATED_SENDERS,
): boolean {
  const probe = sender.address ?? sender.name.toLowerCase();
  return denylist.some((rule) => senderRuleMatches(rule, probe));
}

export interface NormalizedEmailMessages {
  messages: MatchedMessage[];
  /** Messages dropped because their sender is automated. */
  dropped: number;
  /**
   * Distinct senders among the kept messages, keyed by address when one
   * parsed (else by lowercased display name), counted before the address is
   * dropped from the speaker: a newsletter whose display name varies per
   * issue is still one sender.
   */
  distinctSenders: number;
}

/**
 * Email-page post-parse normalization:
 *   - speaker `Name &lt;addr&gt;` -> display name (the address only drives policy)
 *   - automated senders dropped before segmenting
 *   - `[Open in Gmail](...)` link lines stripped from bodies
 */
export function normalizeEmailMessages(
  messages: readonly MatchedMessage[],
  denylist: readonly EmailSenderRule[] = EMAIL_AUTOMATED_SENDERS,
): NormalizedEmailMessages {
  const out: MatchedMessage[] = [];
  const senders = new Set<string>();
  let dropped = 0;
  for (const m of messages) {
    const sender = parseEmailSender(m.speaker);
    if (isAutomatedEmailSender(sender, denylist)) {
      dropped++;
      continue;
    }
    senders.add(sender.address ?? sender.name.toLowerCase());
    const text = m.text
      .split(/\r?\n/)
      .filter((line) => !OPEN_IN_GMAIL_RE.test(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out.push(
      m.direction !== undefined
        ? { speaker: sender.name, timestamp: m.timestamp, text, direction: m.direction }
        : { speaker: sender.name, timestamp: m.timestamp, text },
    );
  }
  return { messages: out, dropped, distinctSenders: senders.size };
}

/**
 * Email pages with a single inbound message (newsletters, notifications,
 * one-off sends to the owner) are out of scope for conversation facts. Cheap
 * pre-parse check on frontmatter + the heading marker, so enumeration skips
 * them for the cost of one list read and writes no durable audit row.
 */
export function isSingleInboundEmail(
  page: Pick<Page, 'type' | 'frontmatter' | 'compiled_truth'>,
): boolean {
  if (page.type !== 'email') return false;
  const raw = page.frontmatter?.message_count;
  const count = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(count) || count >= 2) return false;
  return !EMAIL_SENT_HEADING_RE.test(page.compiled_truth ?? '');
}

/**
 * Email pages the facts pipeline never extracts: the collector's daily digest
 * pages (type `email-digest`, or `frontmatter.subtype` other than `thread`,
 * e.g. `digest`, whose body is `## Signatures pending` / `## Triage`
 * sections, not messages) and single inbound messages. Enumeration skips
 * both before parsing and writes no audit row.
 */
export function isOutOfScopeEmail(
  page: Pick<Page, 'type' | 'frontmatter' | 'compiled_truth'>,
): boolean {
  if (page.type === 'email-digest') return true;
  if (page.type !== 'email') return false;
  const subtype = page.frontmatter?.subtype;
  if (typeof subtype === 'string' && subtype !== 'thread') return true;
  return isSingleInboundEmail(page);
}
