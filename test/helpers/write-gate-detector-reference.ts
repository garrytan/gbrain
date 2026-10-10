/**
 * Reference implementation of the write-gate detector (#5575 detector v2) as
 * it stood before the sliding-window prefilter (ENG-16 perf): every window
 * rebuilt its anchor-key Set from the hashed occurrence list. Kept verbatim,
 * outside src, only so test/write-gate-detector-differential.test.ts can prove
 * the optimized src/core/write-gate.ts detector returns identical hits.
 */
import { MAX_MATCH_CHARS, MAX_PRECEDING_CHARS, WRITE_GATE_PATTERNS, type WriteGatePattern } from './write-gate-patterns-reference.ts';
import { normalizeForGate, WRITE_GATE_WINDOW_CHARS, type WriteGateField, type WriteGateHit } from '../../src/core/write-gate.ts';

// UTF-16 code units that start something normalizeForGate changes: the hidden set, the compatibility
// forms, and the high surrogates of tag characters (U+DB40) and mathematical alphanumerics (U+D835).
const NEEDS_NORMALIZING = new Uint8Array(65536);
for (const [lo, hi] of [[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x2100, 0x214f], [0x2460, 0x24ff], [0x3164, 0x3164], [0x3300, 0x33ff], [0xd835, 0xd835],
  [0xdb40, 0xdb40], [0xfb00, 0xfb4f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xff00, 0xffef]] as const) NEEDS_NORMALIZING.fill(1, lo, hi + 1);

const NEGATED_BEFORE_RE = /\b(?:never|not|n't|no)\s{1,4}$/i;
/** Global clones for walking every match of a context-checked pattern (the table's own regexes stay stateless). */
const ITERATORS: ReadonlyMap<string, RegExp> = new Map(WRITE_GATE_PATTERNS.filter(p => p.negatable || p.preceded).map(p => [p.name, new RegExp(p.rx.source, `${p.rx.flags}g`)]));

/**
 * True when `p.rx` matches somewhere its context rules hold: not directly
 * negated, and `preceded` matching the text before it without its `neg` group. Walks every match in
 * the window (bounded by its length), so padding with rejected matches cannot
 * hide a real one.
 */
function matchesInContext(p: WriteGatePattern, window: string, atTextStart: boolean): boolean {
  const rx = ITERATORS.get(p.name)!;
  rx.lastIndex = 0;
  for (let m = rx.exec(window); m; m = rx.exec(window)) {
    const at = m.index;
    // Resume one character later, not at the match end: a rejected match can overlap the one that holds.
    rx.lastIndex = at + 1;
    if (p.negatable && NEGATED_BEFORE_RE.test(window.slice(Math.max(0, at - 10), at))) continue;
    if (!p.preceded) return true;
    // The text start counts as a line start for `preceded` (a pattern may require one).
    const before = at > MAX_PRECEDING_CHARS ? window.slice(at - MAX_PRECEDING_CHARS, at) : `${atTextStart ? '\n' : ''}${window.slice(0, at)}`;
    const context = p.preceded.exec(before);
    if (context && !context.groups?.neg) return true;
  }
  return false;
}

/** FNV-1a over a lowercased ASCII word; collisions only widen the prefilter (the regex still decides). */
function wordHash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** An anchor's prefilter key: `@`, or the hash of its longest word. */
function anchorKey(anchor: string): number | '@' {
  if (anchor === '@') return '@';
  const words = anchor.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return wordHash(words.reduce((long, w) => w.length > long.length ? w : long, ''));
}

const ANCHOR_KEYS: ReadonlyMap<string, number | '@'> = new Map(
  [...new Set(WRITE_GATE_PATTERNS.flatMap(p => [...p.anchors, ...(p.requires ?? [])]))].map(a => [a, anchorKey(a)]));
const ANCHOR_HASHES: ReadonlySet<number> = new Set([...ANCHOR_KEYS.values()].filter((k): k is number => k !== '@'));

// Word characters for the anchor scan, case-folded: ASCII digits and letters map to their lowercase code, everything else to 0.
const WORD_CHAR = new Uint8Array(128);
for (let c = 48; c <= 57; c++) WORD_CHAR[c] = c;
for (let c = 97; c <= 122; c++) { WORD_CHAR[c] = c; WORD_CHAR[c - 32] = c; }
// 16-bit filter over anchor hashes: most words miss it and skip the Set lookup.
const ANCHOR_FILTER = new Uint8Array(65536);
for (const h of ANCHOR_HASHES) ANCHOR_FILTER[h & 0xffff] = 1;
const AT_HASH = -1;

/**
 * One allocation-light pass over the whole text: the end offset and hash of
 * every anchor word (ASCII letters and digits, case-folded, whole words) and
 * of every `@`, in text order, and whether normalizeForGate would change it.
 */
function anchorOccurrences(text: string): { at: number[]; key: number[]; needsNormalizing: boolean } {
  const at: number[] = [];
  const key: number[] = [];
  let normalize = false;
  let h = 0x811c9dc5;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    const code = i < len ? text.charCodeAt(i) : 32;
    const c = code < 128 ? WORD_CHAR[code]! : 0;
    if (c) {
      h = Math.imul(h ^ c, 0x01000193);
      inWord = true;
      continue;
    }
    if (inWord) {
      const word = h >>> 0;
      if (ANCHOR_FILTER[word & 0xffff] && ANCHOR_HASHES.has(word)) { at.push(i); key.push(word); }
      h = 0x811c9dc5;
      inWord = false;
    }
    if (code === 64) { at.push(i + 1); key.push(AT_HASH); }
    else if (code >= 0xad && NEEDS_NORMALIZING[code]) normalize = true;
  }
  return { at, key, needsNormalizing: normalize };
}

const keysOf = (anchors: readonly string[]) => [...new Set(anchors.map(a => { const k = ANCHOR_KEYS.get(a)!; return k === '@' ? AT_HASH : k; }))];
/** Per pattern (same order as WRITE_GATE_PATTERNS): the anchor keys, and the `requires` keys or null. */
const PATTERN_KEYS: ReadonlyArray<{ anchors: number[]; requires: number[] | null }> =
  WRITE_GATE_PATTERNS.map(p => ({ anchors: keysOf(p.anchors), requires: p.requires ? keysOf(p.requires) : null }));

function hasAny(keys: readonly number[], present: ReadonlySet<number>): boolean {
  for (const k of keys) if (present.has(k)) return true;
  return false;
}

/** Pure detector: every (family, pattern, field) the pattern table finds in the fields. */
export function referenceDetectInstructionLike(fields: ReadonlyArray<readonly [WriteGateField, string]>): WriteGateHit[] {
  const hits: WriteGateHit[] = [];
  for (const [field, raw] of fields) {
    if (!raw) continue;
    let text = raw;
    let occ = anchorOccurrences(text);
    if (occ.needsNormalizing) { text = normalizeForGate(raw); occ = anchorOccurrences(text); }
    const found = new Set<string>();
    let first = 0;
    const step = WRITE_GATE_WINDOW_CHARS - MAX_MATCH_CHARS - MAX_PRECEDING_CHARS;
    for (let start = 0; start < text.length; start += step) {
      const end = start + WRITE_GATE_WINDOW_CHARS;
      const window = text.slice(start, end);
      while (first < occ.at.length && occ.at[first]! <= start) first++;
      const present = new Set<number>();
      for (let k = first; k < occ.at.length && occ.at[k]! <= end; k++) present.add(occ.key[k]!);
      for (let i = 0; i < WRITE_GATE_PATTERNS.length; i++) {
        const p = WRITE_GATE_PATTERNS[i]!;
        const keys = PATTERN_KEYS[i]!;
        if (found.has(p.name) || !hasAny(keys.anchors, present) || (keys.requires && !hasAny(keys.requires, present))) continue;
        if (!(p.negatable || p.preceded ? matchesInContext(p, window, start === 0) : p.rx.test(window))) continue;
        found.add(p.name);
        hits.push({ family: p.family, pattern: p.name, field });
      }
      if (start + WRITE_GATE_WINDOW_CHARS >= text.length) break;
    }
  }
  return hits;
}
