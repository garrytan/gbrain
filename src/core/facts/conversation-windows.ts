import type { ConversationSegment, ConversationMessage } from '../../commands/extract-conversation-facts.ts';

/** The same topical/date/speaker anchor is repeated on each continuation. */
export function segmentHeader(pageTitle: string, segment: ConversationSegment): string {
  return [
    `Page: ${pageTitle}`,
    `Conversation between ${segment.participants.join(' and ')} from ${segment.startIso} to ${segment.endIso}`,
    '---',
  ].join('\n');
}

const messagePrefix = (m: ConversationMessage) => `${m.speaker} (${m.timestamp}): `;

export function segmentText(pageTitle: string, segment: ConversationSegment): string {
  return segmentHeader(pageTitle, segment) + '\n' +
    segment.messages.map(m => messagePrefix(m) + m.text).join('\n');
}

/** Prefer a text boundary without dropping whitespace or splitting a surrogate pair. */
function cutPoint(text: string, from: number, max: number): number {
  if (max >= text.length) return text.length;
  const floor = from + Math.floor((max - from) / 2);
  const newline = text.lastIndexOf('\n', max - 1);
  if (newline >= floor) return newline + 1;
  const space = text.lastIndexOf(' ', max - 1);
  if (space >= floor) return space + 1;
  const before = text.charCodeAt(max - 1);
  const after = text.charCodeAt(max);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? max - 1 : max;
}

/**
 * Window an already eligible conversation segment. A singleton continuation is
 * eligible because the parent has multiple turns; this never admits an otherwise
 * singleton time group. Whole turns stay together when they fit a fresh window.
 * Oversized turns repeat their original speaker and timestamp on every fragment.
 * No model, filesystem, or persistence operations occur while planning.
 */
export function splitSegmentForExtraction(
  pageTitle: string, segment: ConversationSegment, maxChars: number,
): ConversationSegment[] {
  const anchorChars = segmentHeader(pageTitle, segment).length + 1;
  const bodyBudget = maxChars - anchorChars;
  if (bodyBudget < 2) throw new Error('conversation extraction header exceeds the input budget');
  const out: ConversationSegment[] = [];
  let messages: ConversationMessage[] = [];
  let used = 0;
  const flush = () => {
    if (messages.length) out.push({ ...segment, messages });
    messages = [];
    used = 0;
  };
  for (const m of segment.messages) {
    const prefix = messagePrefix(m).length;
    // Fail before orphan cleanup/provider work rather than clip oversized metadata.
    if (prefix + 2 > bodyBudget) throw new Error('conversation extraction speaker/timestamp exceeds the input budget');
    let from = 0;
    do {
      const separator = messages.length ? 1 : 0;
      const room = bodyBudget - used - separator - prefix;
      const rest = m.text.length - from;
      if (messages.length && (room < 2 || (rest > room && prefix + rest <= bodyBudget))) {
        flush();
        continue;
      }
      const to = cutPoint(m.text, from, from + room);
      messages.push({ ...m, text: m.text.slice(from, to) });
      used += separator + prefix + to - from;
      from = to;
      if (from < m.text.length) flush();
      else break;
    } while (true);
  }
  flush();
  return out;
}

