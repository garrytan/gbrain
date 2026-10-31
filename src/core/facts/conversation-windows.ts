/**
 * Conversation windowing for `extract-conversation-facts` (#6267, wave 15 P2.5).
 *
 *   eligible gap group → bounded windows (message cap + rendered-char budget)
 *
 * Before this module a dense time segment was rendered and then clipped at
 * SEGMENT_TEXT_CHAR_LIMIT with an `…(truncated)` marker, and the 31st reply
 * of a 31-turn group was dropped as a too-short segment, while the page was
 * still stamped complete. Here every eligible turn lands in exactly one
 * window and every rendered window fits the budget, header included.
 *
 * Eligibility is decided per gap-separated group BEFORE windowing: a group
 * needs MIN_SEGMENT_MESSAGES original messages, so an original singleton
 * stays ineligible and splitting one oversized turn never makes a page
 * eligible. Inside an eligible group a window closes when the next message
 * would exceed the message cap or the rendered budget, and that message
 * opens a new bounded window; a trailing single reply of an eligible group
 * is a legitimate one-message window, never glued across a gap and never
 * appended over the budget. A turn that cannot fit alone is split at
 * sentence boundaries (then word, then code-point boundaries) and each
 * piece keeps the `speaker (timestamp): ` prefix. A header that leaves no
 * room for text refuses before any window exists, so the caller fails the
 * page before it cleans up prior facts.
 *
 * Lives in `src/core/facts/` so core consumers never import from
 * `src/commands/` (the command re-exports these names for its callers).
 */
import type { ConversationMessage, ConversationSegment, SplitSegmentsOpts } from './conversation-types.ts';

/** Maximum gap between adjacent messages before we cut a new segment. */
export const DEFAULT_SEGMENT_GAP_MINUTES = 30;

/**
 * Hard cap on messages per window, regardless of timing.
 * Tuned down from PR's 50 → 30 (Eng-v2 T5): combined with the 6500-char
 * SEGMENT_TEXT_CHAR_LIMIT, this keeps headroom under extract.ts's
 * MAX_TURN_TEXT_CHARS = 8000 so tail facts in dense Slack/email
 * segments don't vanish silently.
 */
export const DEFAULT_SEGMENT_MAX_MESSAGES = 30;

/** Minimum original messages a gap group needs to be worth extracting. */
export const MIN_SEGMENT_MESSAGES = 2;

/**
 * Budget on the rendered window passed to the extractor, header included.
 * Tuned down from PR's 7500 → 6500 (Eng-v2 T5) to leave headroom for the
 * topical/temporal header under extract.ts's MAX_TURN_TEXT_CHARS = 8000.
 * Since #6267 this is a window boundary, never a clip.
 */
export const SEGMENT_TEXT_CHAR_LIMIT = 6500;

/** Upper bound for a page's `conversation_segment_gap_minutes` (one week). */
export const MAX_PAGE_SEGMENT_GAP_MINUTES = 10_080;

/** Smallest text a split piece may carry, so a tight header still makes progress. */
const MIN_PIECE_CHARS = 32;

export function renderConversationLine(m: ConversationMessage): string {
  return `${m.speaker} (${m.timestamp}): ${m.text}`;
}

export function renderConversationHeader(pageTitle: string, participants: readonly string[], startIso: string, endIso: string): string {
  return [
    `Page: ${pageTitle}`,
    `Conversation between ${participants.join(' and ')} from ${startIso} to ${endIso}`,
    '---',
  ].join('\n');
}

function participantsOf(messages: readonly ConversationMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (seen.has(m.speaker)) continue;
    seen.add(m.speaker);
    out.push(m.speaker);
  }
  return out;
}

function segmentOf(messages: ConversationMessage[]): ConversationSegment {
  return {
    messages,
    startIso: messages[0].timestamp,
    endIso: messages[messages.length - 1].timestamp,
    participants: participantsOf(messages),
  };
}

function renderedLength(pageTitle: string, messages: readonly ConversationMessage[]): number {
  const header = renderConversationHeader(pageTitle, participantsOf(messages), messages[0].timestamp, messages[messages.length - 1].timestamp);
  let n = header.length;
  for (const m of messages) n += 1 + renderConversationLine(m).length;
  return n;
}

/**
 * Cut `text` into consecutive substrings of at most `budget` UTF-16 units
 * each, preferring a sentence end, then a whitespace gap, and never inside
 * a surrogate pair. `pieces.join('')` is exactly `text`.
 */
export function splitTurnText(text: string, budget: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const head = rest.slice(0, budget);
    let cut = -1;
    const sentence = /[.!?…。！？][)"'”’»]*\s+/g;
    for (let m = sentence.exec(head); m; m = sentence.exec(head)) cut = m.index + m[0].length;
    if (cut < MIN_PIECE_CHARS) {
      const word = /\s+/g;
      for (let m = word.exec(head); m; m = word.exec(head)) cut = m.index + m[0].length;
    }
    if (cut < MIN_PIECE_CHARS) cut = budget;
    const code = head.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || pieces.length === 0) pieces.push(rest);
  return pieces;
}

function splitOversizedTurn(m: ConversationMessage, pageTitle: string, maxChars: number): ConversationMessage[] {
  const fixed = renderedLength(pageTitle, [{ ...m, text: '' }]);
  const budget = maxChars - fixed;
  if (budget < MIN_PIECE_CHARS) {
    throw new Error(
      `conversation window header leaves no room for text: the page title, speaker "${m.speaker}" and timestamps render to ${fixed} of ${maxChars} characters; ` +
      'shorten the page title or the speaker label, then rerun extraction for this page',
    );
  }
  return splitTurnText(m.text, budget).map((text) => ({ ...m, text }));
}

/** A closed window and the tag of the message it starts with. */
export interface TaggedWindow<Tag> { seg: ConversationSegment; tag: Tag }

/** What one pushed message did: dropped (filtered out), or accepted, opening a new gap group or not. */
export type WindowPush<Tag> = { accepted: false; windows: [] } | { accepted: true; startsGroup: boolean; windows: TaggedWindow<Tag>[] };

/**
 * splitIntoSegments as a stream: push messages in order, get each window as it closes, then `end()` for the rest.
 * Holds only the open window (and, while its gap group has a single original message, that message's split pieces), so
 * a caller can window a conversation of any length one segment at a time. The windows equal splitIntoSegments' over the
 * same messages.
 */
export function createWindowStream<Tag>(opts: SplitSegmentsOpts = {}) {
  const gapMs = (opts.gapMinutes ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  const maxMessages = opts.maxMessages ?? DEFAULT_SEGMENT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? SEGMENT_TEXT_CHAR_LIMIT;
  const pageTitle = opts.pageTitle ?? '';
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;
  let lastTs: number | null = null;
  let groupMessages = 0;
  let cur: ConversationMessage[] = [];
  let curTag: Tag | undefined;
  let held: TaggedWindow<Tag>[] = [];
  const close = (out: TaggedWindow<Tag>[]) => {
    if (cur.length > 0) held.push({ seg: segmentOf(cur), tag: curTag as Tag });
    cur = [];
    if (groupMessages >= MIN_SEGMENT_MESSAGES) { out.push(...held); held = []; }
  };
  const endGroup = (out: TaggedWindow<Tag>[]) => {
    close(out);
    held = [];
    groupMessages = 0;
  };
  return {
    push(m: ConversationMessage, tag: Tag): WindowPush<Tag> {
      const ts = Date.parse(m.timestamp);
      if (!Number.isFinite(ts) || (Number.isFinite(sinceMs) && ts <= sinceMs)) return { accepted: false, windows: [] };
      const windows: TaggedWindow<Tag>[] = [];
      const startsGroup = lastTs === null || ts - lastTs > gapMs;
      if (startsGroup) endGroup(windows);
      lastTs = ts;
      groupMessages++;
      const parts = renderedLength(pageTitle, [m]) <= maxChars ? [m] : splitOversizedTurn(m, pageTitle, maxChars);
      for (const part of parts) {
        if (cur.length >= maxMessages || (cur.length > 0 && renderedLength(pageTitle, [...cur, part]) > maxChars)) close(windows);
        if (cur.length === 0) curTag = tag;
        cur.push(part);
      }
      if (groupMessages >= MIN_SEGMENT_MESSAGES && held.length) { windows.push(...held); held = []; }
      return { accepted: true, startsGroup, windows };
    },
    end(): TaggedWindow<Tag>[] {
      const windows: TaggedWindow<Tag>[] = [];
      endGroup(windows);
      return windows;
    },
  };
}

/**
 * Split parsed messages into bounded extraction windows.
 *
 * 1. Drop messages at or before `sinceIso` and unparseable timestamps.
 * 2. Cut gap groups on `gapMinutes`; a group with fewer than
 *    MIN_SEGMENT_MESSAGES messages is ineligible and dropped whole.
 * 3. Window each eligible group under `maxMessages` and `maxChars`
 *    (the rendered budget, header included, for `pageTitle`): a window
 *    closes when the next message would exceed either, and a turn that cannot
 *    fit alone is replaced by its pieces (same speaker and timestamp).
 */
export function splitIntoSegments(
  messages: ConversationMessage[],
  opts: SplitSegmentsOpts = {},
): ConversationSegment[] {
  const stream = createWindowStream<null>(opts);
  const out: ConversationSegment[] = [];
  for (const m of messages) for (const w of stream.push(m, null).windows) out.push(w.seg);
  for (const w of stream.end()) out.push(w.seg);
  return out;
}

/**
 * Render one window with its topical/temporal header. Windows from
 * `splitIntoSegments` always fit; a hand-built segment that does not is
 * refused instead of clipped, so an extractor never certifies text it did
 * not see.
 */
export function renderSegmentForExtraction(
  pageTitle: string,
  segment: ConversationSegment,
  maxChars: number = SEGMENT_TEXT_CHAR_LIMIT,
): string {
  const header = renderConversationHeader(pageTitle, segment.participants, segment.startIso, segment.endIso);
  const full = `${header}\n${segment.messages.map(renderConversationLine).join('\n')}`;
  if (full.length > maxChars) {
    throw new Error(
      `conversation window ${segment.startIso}..${segment.endIso} renders to ${full.length} characters, over the ${maxChars} budget; ` +
      'windows must come from splitIntoSegments, which bounds them',
    );
  }
  return full;
}
