/**
 * #5575 ENG-16: the write-gate detector searches a window only within each
 * pattern's longest match (its REACH) of the pattern's own anchor words. That
 * finds exactly what a whole-window search finds when every match of the
 * pattern contains one of its anchor words, at most `analyzeRegexSource`'s
 * longest match long, and the pattern reads nothing outside its match but
 * `\b`. This samples thousands of matches per pattern, set in random
 * neighbouring characters, and checks all three for every pattern outside
 * WHOLE_WINDOW_PATTERNS, and that each pattern inside it really breaks the
 * first (so the list holds nothing that could be narrowed).
 * The detector-v2 differential test checks the end-to-end output.
 */
import { describe, expect, test } from 'bun:test';
import { WHOLE_WINDOW_PATTERNS } from '../src/core/write-gate.ts';
import { WRITE_GATE_PATTERNS } from '../src/core/write-gate-patterns.ts';
import { analyzeRegexSource } from '../src/core/write-gate-regex.ts';
import { regexSampler } from './helpers/regex-sample.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NEIGHBOURS = 'abcxyzAZ09_ ,.:@-\n';
/** The detector's anchor key: `@`, or the anchor's longest word. */
const keyWord = (anchor: string) => anchor === '@' ? '@' : anchor.split(/[^a-z0-9]+/).filter(Boolean).reduce((long, w) => w.length > long.length ? w : long, '');

/** Sampled matches of `p` in context: how many were real matches, and the first with no anchor word inside. */
function sampleMatches(p: (typeof WRITE_GATE_PATTERNS)[number], seed: number): { valid: number; longest: number; missing: string | null } {
  const random = rng(seed);
  const sample = regexSampler(p.rx.source, p.rx.flags, random);
  const keys = new Set(p.anchors.map(keyWord));
  const around = () => { let s = ''; for (let n = Math.floor(random() * 4); n > 0; n--) s += NEIGHBOURS[Math.floor(random() * NEIGHBOURS.length)]; return s; };
  // A sample set in up to 3 neighbouring characters each side; the match these regex groups find is a real one.
  const inContext = new RegExp(`^([\\s\\S]{0,3})(?:${p.rx.source})([\\s\\S]{0,3})$`, p.rx.flags);
  let valid = 0;
  let longest = 0;
  let missing: string | null = null;
  for (let tries = 0; tries < 40_000 && valid < 1_000; tries++) {
    const full = around() + sample() + around();
    const m = inContext.exec(full);
    if (!m) continue;
    valid++;
    const from = m[1]!.length;
    const to = full.length - m[m.length - 1]!.length;
    longest = Math.max(longest, to - from);
    // Anchor words as the detector finds them: whole ASCII letter/digit runs (case-folded) and `@`, by end offset.
    const inside = [...full.toLowerCase().matchAll(/[a-z0-9]+|@/g)]
      .some(w => keys.has(w[0]) && w.index! + w[0].length > from && w.index! + w[0].length <= to);
    if (!inside) missing ??= full;
  }
  return { valid, longest, missing };
}

describe('write gate anchor ranges', () => {
  for (const p of WRITE_GATE_PATTERNS) {
    if (WHOLE_WINDOW_PATTERNS.has(p.name)) {
      test(`${p.name} scans whole windows: some match holds no anchor word`, () => {
        expect(sampleMatches(p, 5575).missing).not.toBeNull();
      });
      continue;
    }
    test(`${p.name}: every sampled match holds an anchor word and fits its reach`, () => {
      expect(p.rx.source).not.toMatch(/\(\?<?[=!]|(?<![\\[])[$^]/);
      const { valid, longest, missing } = sampleMatches(p, 5575);
      expect(valid).toBeGreaterThan(100);
      expect(missing).toBeNull();
      expect(longest).toBeLessThanOrEqual(analyzeRegexSource(p.rx.source).maxLength);
    });
  }
});
