/**
 * Overlapping windows over one long text (#6503).
 *
 * An LLM extractor reads at most a fixed number of characters per call. A
 * text longer than that is split into windows that each fit, instead of being
 * cut, so every character reaches the model. Consecutive windows overlap by a
 * small margin so a claim that straddles a boundary is read whole at least
 * once; the caller merges what the windows return.
 *
 * Boundaries prefer, in the back half of a window: a blank line, a newline, a
 * sentence end, a space; only text with none of those is cut mid-word, and
 * never inside a UTF-16 surrogate pair. The next window opens `overlapChars`
 * before the previous end, snapped forward to a line or word start within
 * the first half of the overlap. Planning is deterministic, so the same text
 * and budget always yield the same windows (callers key idempotency on them).
 *
 * A text that fits in `maxChars` is exactly one window holding the text
 * unchanged, so callers keep their single-call behavior for it.
 */
import { safeSplitIndex } from './text-safe.ts';

export interface TextWindow {
  /** 0-based position of this window. */
  index: number;
  /** How many windows the text was split into. */
  count: number;
  /** Offset of the window's first character in the full text. */
  start: number;
  /** Offset one past the window's last character in the full text. */
  end: number;
  /** `fullText.slice(start, end)`. */
  text: string;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const SENTENCE_END = /[.!?…。！？][)"'”’»\]]*\s+/g;

/** End of the window opening at `start`: the best boundary in (start + maxChars/2, start + maxChars]. */
function windowEnd(text: string, start: number, maxChars: number): number {
  const limit = start + maxChars;
  if (limit >= text.length) return text.length;
  const floor = start + Math.floor(maxChars / 2);
  const paragraph = text.lastIndexOf('\n\n', limit - 2);
  if (paragraph >= floor) return paragraph + 2;
  const line = text.lastIndexOf('\n', limit - 1);
  if (line >= floor) return line + 1;
  const tail = text.slice(floor, limit);
  let sentence = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(tail); m; m = SENTENCE_END.exec(tail)) sentence = m.index + m[0].length;
  if (sentence > 0) return floor + sentence;
  const space = text.lastIndexOf(' ', limit - 1);
  if (space >= floor) return space + 1;
  return safeSplitIndex(text, limit);
}

/** Start of the window after one ending at `end`: `overlap` back, snapped to a line or word start. */
function nextStart(text: string, start: number, end: number, overlap: number): number {
  if (overlap <= 0) return end;
  let s = Math.max(start + 1, end - overlap);
  const snapLimit = end - Math.floor(overlap / 2);
  const line = text.indexOf('\n', s);
  if (line !== -1 && line + 1 < snapLimit) return line + 1;
  const space = text.indexOf(' ', s);
  if (space !== -1 && space + 1 < snapLimit) return space + 1;
  // Never open inside a surrogate pair; step forward past it when stepping back would not advance.
  if (isLow(text.charCodeAt(s)) && isHigh(text.charCodeAt(s - 1))) s = s - 1 > start ? s - 1 : s + 1;
  return s;
}

/**
 * Split `text` into windows of at most `maxChars` characters, consecutive
 * windows sharing up to `overlapChars` characters (clamped to a quarter of
 * `maxChars` so every window advances by at least a quarter). Concatenating
 * the non-overlapping parts reproduces the text; the last window always ends
 * at `text.length`.
 */
export function planTextWindows(text: string, maxChars: number, overlapChars: number): TextWindow[] {
  if (!Number.isFinite(maxChars) || maxChars < 4) throw new Error(`planTextWindows: maxChars must be >= 4 (got ${maxChars})`);
  const budget = Math.floor(maxChars);
  if (text.length <= budget) return [{ index: 0, count: 1, start: 0, end: text.length, text }];
  const overlap = Math.max(0, Math.min(Math.floor(overlapChars), Math.floor(budget / 4)));
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (;;) {
    const end = windowEnd(text, start, budget);
    spans.push({ start, end });
    if (end >= text.length) break;
    start = nextStart(text, start, end, overlap);
  }
  return spans.map((span, index) => ({ index, count: spans.length, ...span, text: text.slice(span.start, span.end) }));
}
