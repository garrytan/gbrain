/**
 * PR 4 (Wave B incremental derivation, transcripts): the conversation windows of a segmented page, streamed across its
 * occurrences (wave-b spec 8.2 "Conversation facts").
 *
 * Messages are parsed one occurrence at a time under one grammar for the whole page: `opts.pattern` (the caller's: the
 * one detectPagePattern picks over the whole page, as the whole-page pass picks it), else the pattern the first parsed
 * text detects.
 * Once known, every later text is parsed under it without detection, so a continuation that would
 * fail the detector's density floor on its own is still read as the message it continues. The last message of an
 * occurrence may continue into the next one, so it is held back and parsed again with the next occurrence's text, from
 * its anchor line and with the day-header date in force there; an occurrence with no anchor line only extends the held
 * message, unparsed, so a message spanning many occurrences is parsed once. The windows (createWindowStream, the same
 * gap groups and bounds as the whole-page pass) then run over message boundaries, never over segment cuts, so a window
 * can span a cut. Each window is owned by the occurrence its first message starts in. Reads one occurrence's text at a
 * time and holds the carried message and the open window, never the whole body.
 *
 * A run of occurrences is streamed on its own when the occurrence after it opens a gap group: its windows then equal
 * the whole stream's, because every window before that occurrence closed at the gap. startsConversationRun tells, from
 * an occurrence's text and the one before it, whether its first message opens a gap group, so the newest run of a page
 * is read without the rest.
 */
import type { Page } from '../types.ts';
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import { normalizeBlockConversation } from '../conversation-parser/normalize-block.ts';
import { DAY_HEADER_RE, applyPattern, createPatternDetector, deriveDateContext, isAnchorLine, parseConversation } from '../conversation-parser/parse.ts';
import type { ConversationOccurrence } from '../page-body/segment-conversation.ts';
import type { ConversationMessage, ConversationSegment } from './conversation-types.ts';
import { DEFAULT_SEGMENT_GAP_MINUTES, MAX_PAGE_SEGMENT_GAP_MINUTES, createWindowStream } from './conversation-windows.ts';

export interface ConversationStreamSink {
  /** A closed window and the occurrence (an index into the occurrences) its first message starts in, which owns it. */
  window(owner: number, seg: ConversationSegment): void;
  /** Occurrence `index` was read; `startsGroup`: its first message opens a gap group. */
  occurrence(index: number, startsGroup: boolean): void;
}

export interface ConversationStreamOpts {
  page: Page;
  gapMinutes: number | null;
  sinceIso?: string;
  /** The page's grammar, when the caller knows it. */
  pattern?: string | null;
}

/** The last message of an occurrence, held back to be parsed with the next occurrence's text. */
interface Carry { parts: string[]; date: string | undefined; owner: number; region: string }

const gapMinutesFor = (opts: ConversationStreamOpts, patternId: string | null) =>
  opts.gapMinutes ?? (patternId === 'email-thread-heading' ? MAX_PAGE_SEGMENT_GAP_MINUTES : undefined);

/**
 * The grammar the whole-page pass picks for the page (parseConversation's choice over its whole parser input: the
 * occurrences in order, truth then timeline joined as readSummaryBody joins them), read one occurrence at a time; null
 * when the page is not a conversation the parser reads.
 */
export async function detectPagePattern(occurrences: readonly ConversationOccurrence[], readText: (index: number) => Promise<string>): Promise<string | null> {
  const detector = createPatternDetector();
  for (let i = 0; i < occurrences.length; i++) {
    if (i > 0 && occurrences[i]!.row.region !== occurrences[i - 1]!.row.region) detector.push('\n\n');
    detector.push(await readText(i));
  }
  return detector.finish();
}

/** Parse `text` under built-in `patternId` without detection, or detect the pattern when there is none yet. */
function parseUnder(text: string, patternId: string | null, opts: ConversationStreamOpts, fallbackDate: string | undefined): { messages: ConversationMessage[]; patternId: string | null } {
  const dated = { page: opts.page, ...(fallbackDate ? { fallbackDate } : {}) };
  const entry = patternId ? BUILTIN_PATTERNS.find(p => p.id === patternId) : undefined;
  if (entry) return { messages: applyPattern(normalizeBlockConversation(text), entry, deriveDateContext(dated)), patternId };
  const parsed = parseConversation(text, dated);
  return { messages: parsed.messages, patternId: patternId ?? parsed.matched_pattern_id ?? null };
}

/** The offset of the first (`last`) line of `text` that opens a message under `patternId`, or -1. */
function anchorOffset(patternId: string, text: string, last: boolean): number {
  if (last) {
    let end = text.length;
    while (end > 0) {
      const start = text.lastIndexOf('\n', end - 1) + 1;
      if (isAnchorLine(patternId, text.slice(start, end).replace(/\r$/, ''))) return start;
      end = start - 1;
    }
    return -1;
  }
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (isAnchorLine(patternId, text.slice(start, end < 0 ? text.length : end).replace(/\r$/, ''))) return start;
    if (end < 0) break;
    start = end + 1;
  }
  return -1;
}

/** The day-header date in force at `offset` of `text`, else `fallback`. */
function dateAt(text: string, offset: number, fallback: string | undefined): string | undefined {
  let end = offset;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 2) + 1;
    const match = DAY_HEADER_RE.exec(text.slice(start, end).trim());
    if (match) return match[1];
    end = start;
  }
  return fallback;
}

/**
 * Whether occurrence `index`'s first message opens a gap group: it comes more than the gap after the last message of
 * the occurrence before it (`previous`, read with the date in force at its last anchor).
 */
export function startsConversationRun(occurrences: readonly ConversationOccurrence[], index: number, text: string, previous: string,
  opts: ConversationStreamOpts): boolean {
  if (index === 0) return true;
  const occurrence = occurrences[index]!;
  const parsed = parseUnder(text, opts.pattern ?? null, opts, occurrence.conversation?.fallbackDate ?? undefined);
  const { patternId } = parsed;
  const first = parsed.messages[0] ? Date.parse(parsed.messages[0].timestamp) : NaN;
  const at = patternId ? anchorOffset(patternId, previous, true) : -1;
  if (at < 0 || !Number.isFinite(first)) return false;
  const date = occurrence.conversation?.lastDate ?? dateAt(previous, at, occurrences[index - 1]!.conversation?.fallbackDate ?? undefined);
  const last = parseUnder(previous.slice(at), patternId, opts, date).messages[0];
  const gapMs = (gapMinutesFor(opts, patternId) ?? DEFAULT_SEGMENT_GAP_MINUTES) * 60_000;
  return !!last && first - Date.parse(last.timestamp) > gapMs;
}

/**
 * Stream the windows of occurrences `from`..`to` (exclusive) of a segmented conversation page (module doc) into `sink`,
 * and return the grammar they were parsed under and how many messages were parsed. `to` is the page's end or an
 * occurrence whose first message opens a gap group; the text before that occurrence's first anchor line still belongs
 * to the last message before it.
 */
export async function streamConversationWindows(occurrences: readonly ConversationOccurrence[], from: number, to: number, opts: ConversationStreamOpts,
  readText: (index: number) => Promise<string>, sink: ConversationStreamSink): Promise<{ pattern: string | null; messages: number }> {
  const pageTitle = opts.page.title || opts.page.slug;
  let patternId = opts.pattern ?? null;
  let parsedMessages = 0;
  let stream: ReturnType<typeof createWindowStream<number>> | null = null;
  let carry: Carry | null = null;
  const joint = (region: string, next: string) => (region === next ? '' : '\n\n');
  for (let i = from; i < to; i++) {
    const occurrence = occurrences[i]!;
    const region = occurrence.row.region;
    let text = await readText(i);
    if (i === to - 1 && to < occurrences.length && patternId) {
      const next = await readText(to);
      const lead = anchorOffset(patternId, next, false);
      if (lead > 0) text += joint(region, occurrences[to]!.row.region) + next.slice(0, lead);
    }
    if (carry && patternId && i < to - 1 && anchorOffset(patternId, text, false) < 0) {
      carry.parts.push(joint(carry.region, region), text);
      carry.region = region;
      sink.occurrence(i, false);
      continue;
    }
    const carried: string = carry ? carry.parts.join('') + joint(carry.region, region) : '';
    const chunk: string = carried + text;
    const fallbackDate: string | undefined = carry ? carry.date : occurrence.conversation?.fallbackDate ?? undefined;
    const parsed = parseUnder(chunk, patternId, opts, fallbackDate);
    patternId = parsed.patternId;
    stream ??= createWindowStream<number>({ pageTitle, sinceIso: opts.sinceIso, gapMinutes: gapMinutesFor(opts, patternId) });
    let messages = parsed.messages;
    parsedMessages += messages.length;
    const firstOwner = carry ? carry.owner : i;
    let next: Carry | null = null;
    if (i < to - 1 && messages.length && patternId) {
      const inText = anchorOffset(patternId, text, true);
      if (inText >= 0) {
        const at: number = carried.length + inText;
        next = { parts: [chunk.slice(at)], date: dateAt(chunk, at, fallbackDate), owner: i, region };
        messages = messages.slice(0, -1);
        parsedMessages--;
      }
    }
    let startsGroup: boolean | null = null;
    messages.forEach((message, k) => {
      const owner = k === 0 ? firstOwner : i;
      const pushed = stream!.push(message, owner);
      if (pushed.accepted && owner === i && startsGroup === null) startsGroup = pushed.startsGroup;
      for (const w of pushed.windows) sink.window(w.tag, w.seg);
    });
    sink.occurrence(i, startsGroup === true);
    carry = next;
  }
  for (const w of stream?.end() ?? []) sink.window(w.tag, w.seg);
  return { pattern: patternId, messages: parsedMessages };
}
