/**
 * "Not extractable" outcomes for conversation-facts extraction (#5025 /
 * N2), decided after parsing and before segmentation. A durable outcome is
 * recorded against the page's content version, so the page leaves the
 * backlog until it changes.
 *
 *   - Undated: a time-only parse on a page with no date anchors every turn
 *     on 1970-01-01, so its facts would be dated at the epoch.
 *   - Single email: an email thread page with one message is an email, not
 *     a conversation.
 *   - Prose: a meeting or email page with no speaker turns and the shape of
 *     meeting notes or a calendar event, when no LLM fallback is
 *     configured. Other speaker-less pages stay retryable (a later parser
 *     may learn their format).
 *
 * On a managed brain the single-email and prose outcomes are not durable:
 * recording them would turn a page that wrote nothing into a derived-facts
 * write without a persistence receipt, so those pages stay retryable there.
 * A multi-message email thread on a managed brain is skipped the same way:
 * replacing a page's conversation facts has no receipted publication path
 * yet, so it writes nothing and is retried (TODOS.md, managed conversation
 * facts).
 */
import { looksLikeMeetingNotes } from '../conversation-parser/builtins.ts';
import { deriveDateContext } from '../conversation-parser/parse.ts';
import type { ParseResult } from '../conversation-parser/types.ts';
import type { Page } from '../types.ts';
import { ALLOWED_TYPE_ALIASES } from './conversation-types.ts';

const PROSE_PAGE_TYPES = new Set([...ALLOWED_TYPE_ALIASES.meeting, ...ALLOWED_TYPE_ALIASES.email]);

export interface ConversationSkip {
  /** Recorded on the not-extractable audit row when durable. */
  reason: string;
  /** The operator-facing line: what happened and what reopens the page. */
  message: string;
  /** False: skipped this run, nothing recorded, retried next run. */
  durable: boolean;
}

export function conversationSkip(
  page: Page,
  body: string,
  parse: Pick<ParseResult, 'phase' | 'matched_pattern_id'>,
  messages: ReadonlyArray<{ timestamp: string }>,
  opts: { llmFallback: boolean; managed: boolean },
): ConversationSkip | null {
  if (messages.length > 0 && deriveDateContext({ page }).source === 'epoch_default' && messages.some((m) => m.timestamp.startsWith('1970-01-01T'))) {
    return {
      reason: 'no page date to place message times',
      message: 'no page date to place message times (they would read 1970-01-01); add a date: to the page frontmatter to extract it',
      durable: true,
    };
  }
  if (opts.managed && messages.length > 1 && parse.matched_pattern_id === 'email-thread-heading') {
    return {
      reason: `an email thread in this ${page.type} page`,
      message: `an email thread in this ${page.type} page; managed brains do not extract email-thread conversation facts yet (no receipted publication path); skipped`,
      durable: false,
    };
  }
  let reason: string | null = null;
  if (messages.length === 1 && parse.matched_pattern_id === 'email-thread-heading') {
    reason = `a single email message in this ${page.type} page, not a conversation`;
  } else if (messages.length === 0 && parse.phase === 'no_match' && !opts.llmFallback && PROSE_PAGE_TYPES.has(page.type) && looksLikeMeetingNotes(body)) {
    reason = `no speaker turns in this ${page.type} page (prose, not a transcript)`;
  }
  if (!reason) return null;
  return opts.managed
    ? { reason, message: `${reason}; skipped`, durable: false }
    : { reason, message: `${reason}; not extractable until the page changes`, durable: true };
}
