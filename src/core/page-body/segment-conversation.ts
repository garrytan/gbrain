/**
 * Segmented page storage (Wave B, spec 8, PR 2 full-pass mode): the
 * conversation parser input of a segmented page, through ranged reads.
 *
 * The input is readSummaryBody's join of the trusted stored body
 * (`${compiled_truth}\n\n${timeline}`, either side alone when the other is
 * empty), as readPageSnapshot gives it for an inline page. A body within
 * CONVERSATION_WINDOW_BYTES is read whole, exactly as an inline page of that
 * size. A larger body, which Wave A could only skip, is read as its newest
 * window: the last whole segments (never starting inside a run of forced
 * cuts) that fit the window, so the extraction covers the newest messages,
 * as Wave A's tail windows do for appended text. Conversation segments cut at
 * message lines and day headers, and the window's first segment carries the
 * day-header date in its entry state, which the parse takes as its fallback
 * date. Reads at most the window's bytes.
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { readEntryState } from './entry-state.ts';
import { openSegmentedBody, readBodyRange, type BodyRow, type SegmentedBody } from './read-range.ts';
import { readGarbageCollector, segmentedPassWork } from './segment-blocks.ts';
import type { BodyRegion } from './types.ts';

/** The largest parser input held as one string: Wave A's single-string ceiling. */
export const CONVERSATION_WINDOW_BYTES = PAGE_MAX_BYTES;

/** A parser input that is the newest window of a larger body. */
export interface ConversationWindow {
  /** UTF-8 bytes of the whole stored body (truth plus timeline). */
  totalBytes: number;
  /** The day-header date in force where the window starts, or null. */
  fallbackDate: string | null;
  /** The window was not read: the page has this many conversation facts, which a window run would clear (conversation-parser/body.ts). */
  priorFacts?: number;
}

export interface SegmentedConversationInput { body: string; window?: ConversationWindow }

/** The parser input of a segmented page: its whole summary body within `cap` bytes, else its newest window. */
export async function readSegmentedConversationInput(engine: BrainEngine, page: { id: number },
  cap = CONVERSATION_WINDOW_BYTES): Promise<SegmentedConversationInput> {
  const body = await openSegmentedBody(engine, { pageId: Number(page.id) });
  const rows = [...body.rows.filter(row => row.region === 'truth'), ...body.rows.filter(row => row.region === 'timeline')];
  let first = 0;
  let window: ConversationWindow | undefined;
  if (body.bodyBytes > cap) {
    const forced = new Set(await engine.listForcedCutSeqs(body.pageId, body.generation));
    let bytes = 0;
    first = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      bytes += rows[i]!.byteLen;
      if (bytes > cap) break;
      const startsFresh = i === 0 || rows[i - 1]!.region !== rows[i]!.region || !forced.has(rows[i - 1]!.seq);
      if (startsFresh) first = i;
    }
    const [entry] = first < rows.length ? await engine.readBodyManifestMeta(body.pageId, [rows[first]!.occurrenceId], body.generation) : [];
    const state = readEntryState(typeof entry?.entry_state === 'string' ? JSON.parse(entry.entry_state) : entry?.entry_state);
    window = { totalBytes: body.bodyBytes, fallbackDate: state?.conversation.fallbackDate ?? null };
  }
  const collect = readGarbageCollector();
  const regionText = async (region: BodyRegion): Promise<string> => {
    const own = rows.slice(first).filter(row => row.region === region);
    if (!own.length) return '';
    const parts: Buffer[] = [];
    const start = own[0]!.byteStart;
    const end = own[own.length - 1]!.byteStart + own[own.length - 1]!.byteLen;
    for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'stored', start, end, audience: 'trusted', region, body })) {
      parts.push(piece.bytes);
      segmentedPassWork.bytes += piece.bytes.length;
      collect(piece.bytes.length);
    }
    return Buffer.concat(parts).toString('utf8');
  };
  const truth = await regionText('truth');
  const timeline = await regionText('timeline');
  const text = !truth ? timeline : !timeline ? truth : `${truth}\n\n${timeline}`;
  return window ? { body: text, window } : { body: text };
}

/** A live occurrence of a segmented page with the conversation context its entry state carries in (entry-state.ts). */
export interface ConversationOccurrence { row: BodyRow; conversation: EntryStateConversation | null }
type EntryStateConversation = { pattern: string | null; fallbackDate: string | null; lastDate: string | null; open: boolean };

/**
 * The live occurrences of a segmented page in parser-input order (truth, then timeline, as readSummaryBody joins them)
 * with each one's conversation entry state: manifest metadata only, no segment text.
 */
export async function readConversationOccurrences(engine: BrainEngine, pageId: number): Promise<{ body: SegmentedBody; occurrences: ConversationOccurrence[] }> {
  const body = await openSegmentedBody(engine, { pageId });
  const rows = [...body.rows.filter(row => row.region === 'truth'), ...body.rows.filter(row => row.region === 'timeline')];
  const states = new Map((await engine.readBodyManifestMeta(body.pageId, rows.map(row => row.occurrenceId), body.generation)).map(row => {
    const state = (typeof row.entry_state === 'string' ? JSON.parse(row.entry_state) : row.entry_state) as { conversation?: EntryStateConversation | null } | null;
    return [Number(row.occurrence_id), state?.conversation ?? null] as const;
  }));
  return { body, occurrences: rows.map(row => ({ row, conversation: states.get(row.occurrenceId) ?? null })) };
}

/** Bytes conversation facts read to detect a page's grammar over the whole page (conversation-incremental.ts), apart from segmentedPassWork. */
export const conversationDetectionWork = { bytes: 0 };

/** One occurrence's trusted stored text: reads exactly its segment's bytes, counted in segmentedPassWork (conversationDetectionWork with `detection`). */
export async function readOccurrenceText(engine: BrainEngine, body: SegmentedBody, row: BodyRow, opts: { detection?: boolean } = {}): Promise<string> {
  const collect = readGarbageCollector();
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'stored', start: row.byteStart, end: row.byteStart + row.byteLen,
    audience: 'trusted', region: row.region, body })) {
    parts.push(piece.bytes);
    if (opts.detection) conversationDetectionWork.bytes += piece.bytes.length;
    else segmentedPassWork.bytes += piece.bytes.length;
    collect(piece.bytes.length);
  }
  return Buffer.concat(parts).toString('utf8');
}
