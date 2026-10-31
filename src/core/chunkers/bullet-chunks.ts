/**
 * Bullet-aligned passages for the timeline region of a segmented page (Wave B PR 4, lane recall; #7172 follow-up).
 *
 * The recursive chunker packs about 300 words greedily with a 50-word overlap, so in a descending timeline of uniform
 * bullets an entry added at the top moves every passage boundary below it, and each moved passage is new text the
 * embedder is paid for again. Here a timeline passage breaks only at a bullet start, and where it breaks depends only on
 * the bullet that starts there: a passage starts at bullet b when hash(b) < 2^32 * min(1, words(b) / target), so
 * passages average `target` words whatever the bullet length, and a new bullet can change only the passage it joins
 * (or start one of its own). A run over the size bound is split again at a quarter of the target, and so on, and its
 * pieces merge back from the run's end while they fit, so an entry at the top of a long run changes only its top piece
 * and at most one piece more; a run of one bullet over the bound falls back to the hard-capped chunker (`chunkProjectedText` with `boundaryCuts`).
 * Passages carry no overlap, so a change in one never rewrites the next. A region with no bullet line is not handled
 * here (null): the caller chunks it as before.
 */
import { countCJKAwareWords } from '../cjk.ts';
import { chunkProjectedText, utf16ToUtf8Offsets, type TextChunk } from './recursive.ts';
import { DEFAULT_MAX_CHUNK_TOKENS, fitsEmbedTokens } from './token-estimate.ts';

/** Words a timeline passage averages; the size bound is the recursive chunker's merge limit (1.5x), chars and tokens. */
const TARGET_WORDS = 300;
const LIMIT_WORDS = Math.ceil(TARGET_WORDS * 1.5);
const MAX_CHARS = 6000;
/** Past this many re-splits every bullet starts a passage (a run of zero-word bullets would never meet the hash rule). */
const MAX_LEVEL = 6;
/** A top-level list item: `- `, `* ` or `+ ` at a line start followed by text; indented lines continue the item above. */
const BULLET = /^[-*+][ \t]+\S/;

/** @internal Units hashed and runs measured, for the linearity test (counts, not time). */
export const bulletChunkWork = { units: 0, runs: 0 };

/** One bullet with its continuation lines; the first also holds the text before it. `key` hashes the bullet alone. */
interface Unit { start: number; end: number; key: number; words: number }

function fnv1a(text: string, from: number, to: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function units(text: string): Unit[] | null {
  const starts: number[] = [];
  for (let at = 0; at < text.length;) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    if (BULLET.test(text.slice(at, Math.min(end, at + 4)))) starts.push(at);
    at = end + 1;
  }
  if (!starts.length) return null;
  return starts.map((bullet, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
    let last = end;
    while (last > bullet && /\s/.test(text[last - 1]!)) last--;
    bulletChunkWork.units++;
    return { start: i === 0 ? 0 : bullet, end, key: fnv1a(text, bullet, last), words: countCJKAwareWords(text.slice(bullet, end)) };
  });
}

/**
 * Passages of a timeline region's projected text, with UTF-8 spans as chunkProjectedText returns them; null when the
 * text has no bullet line.
 */
export function chunkTimelineBullets(text: string, opts: { maxTokens?: number } = {}): TextChunk[] | null {
  if (!text.trim()) return [];
  const list = units(text);
  if (!list) return null;
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? Math.min(opts.maxTokens, DEFAULT_MAX_CHUNK_TOKENS) : DEFAULT_MAX_CHUNK_TOKENS;
  const words = [0];
  for (const unit of list) words.push(words[words.length - 1]! + unit.words);
  const runs: Array<[number, number]> = [];
  const fits = (from: number, to: number) => {
    bulletChunkWork.runs++;
    const start = list[from]!.start, end = list[to - 1]!.end;
    return words[to]! - words[from]! <= LIMIT_WORDS && end - start <= MAX_CHARS && fitsEmbedTokens(text.slice(start, end).trim(), maxTokens);
  };
  const starts = (from: number, to: number, level: number) => {
    const target = TARGET_WORDS / 4 ** level;
    const out = [from];
    for (let k = from + 1; k < to; k++) {
      const unit = list[k]!;
      if (level >= MAX_LEVEL || unit.key < 2 ** 32 * Math.min(1, unit.words / target)) out.push(k);
    }
    out.push(to);
    return out;
  };
  // A run over the bound splits at the next level's bullets, and its pieces merge again from the run's end while they
  // fit: an entry added at the top of the run then changes its top piece, and the pieces below keep their text.
  const refine = (from: number, to: number, level: number): Array<[number, number]> => {
    if (to - from === 1 || fits(from, to)) return [[from, to]];
    const cuts = starts(from, to, level);
    const pieces = cuts.slice(0, -1).flatMap((at, i) => refine(at, cuts[i + 1]!, level + 1));
    const merged: Array<[number, number]> = [];
    for (let i = pieces.length - 1; i >= 0; i--) {
      const last = merged[merged.length - 1];
      if (last && fits(pieces[i]![0], last[1])) last[0] = pieces[i]![0];
      else merged.push([pieces[i]![0], pieces[i]![1]]);
    }
    return merged.reverse();
  };
  // Level-0 starts are never merged across: they depend on their bullet alone.
  const top = starts(0, list.length, 0);
  for (let i = 0; i + 1 < top.length; i++) runs.push(...refine(top[i]!, top[i + 1]!, 1));

  const pieces: Array<{ text: string; start: number; end: number } | { inner: TextChunk[]; base: number }> = [];
  const offsets: number[] = [];
  for (const [from, to] of runs) {
    const start = list[from]!.start, end = list[to - 1]!.end;
    const raw = text.slice(start, end);
    const body = raw.trim();
    if (!body) continue;
    if (to - from === 1 && !fits(from, to)) {
      pieces.push({ inner: chunkProjectedText(raw, { maxTokens, spans: true, boundaryCuts: true }), base: start });
      offsets.push(start);
      continue;
    }
    const lead = raw.length - raw.trimStart().length;
    pieces.push({ text: body, start: start + lead, end: start + lead + body.length });
    offsets.push(start + lead, start + lead + body.length);
  }
  const bytes = utf16ToUtf8Offsets(text, offsets);
  const out: TextChunk[] = [];
  for (const piece of pieces) {
    if ('inner' in piece) {
      const base = bytes.get(piece.base)!;
      for (const c of piece.inner) out.push({ text: c.text, index: out.length,
        ...(c.byte_start !== undefined && c.byte_end !== undefined ? { byte_start: base + c.byte_start, byte_end: base + c.byte_end } : {}) });
    } else out.push({ text: piece.text, index: out.length, byte_start: bytes.get(piece.start), byte_end: bytes.get(piece.end) });
  }
  return out;
}
