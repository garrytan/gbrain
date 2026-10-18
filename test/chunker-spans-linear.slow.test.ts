/**
 * chunkText stays linear with spans on (large pages, Wave A).
 *
 * Span tracking carries offset segments through merge and overlap; copying a
 * run's segments on every merge made the merge quadratic in pieces per chunk.
 * That cost is per chunk, so doubling the input only doubles it: a time ratio
 * between 2 MB and 4 MB read 2.0x on the quadratic merge too (3.2x slower in
 * absolute terms), and on shared CI runners thread CPU time itself grows
 * when a co-tenant slows the core (a 2 MB / 4 MB ratio of 3.04 on linear
 * code; GC is under 2% of the run). So this test counts the bookkeeping's
 * work instead (`spanWork`: seg entries visited or copied, steps the
 * UTF-8 offset walk takes) and bounds it per chunk and per input code unit.
 * Counts are deterministic: no machine can move them.
 */
import { describe, test, expect } from 'bun:test';
import { chunkText, spanWork } from '../src/core/chunkers/recursive.ts';

function chatLog(chars: number): string {
  let a = 0x9e3779b9;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const who = ['alice-example', 'bob-example', 'carol-example'];
  const words = ['ok', 'lol', 'see you at', 'the acme-example demo', 'running late', 'did you get', 'the doc', 'sounds good', '😂', 'can you send the link', 'https://example.com/x'];
  const parts: string[] = [];
  let len = 0;
  let day = 0;
  while (len < chars) {
    const line = r() < 0.02
      ? `\n## 2026-03-${String((day++ % 28) + 1).padStart(2, '0')}\n\n`
      : `[10:${String(Math.floor(r() * 60)).padStart(2, '0')}] ${who[Math.floor(r() * 3)]}: ${Array.from({ length: 1 + Math.floor(r() * 12) }, () => words[Math.floor(r() * words.length)]).join(' ')}\n`;
    parts.push(line);
    len += line.length;
  }
  return parts.join('');
}

/** Span bookkeeping work for one chunkText call. */
function work(text: string): { chunks: number; segs: number; units: number } {
  spanWork.segs = 0;
  spanWork.units = 0;
  const chunks = chunkText(text, { spans: true });
  expect(chunks.every(c => c.byte_start !== undefined)).toBe(true);
  return { chunks: chunks.length, segs: spanWork.segs, units: spanWork.units };
}

const MB = 1024 * 1024;
/** Seg entries per chunk: about 10 with in-place merging; the per-merge copy read 470 (chat) and 103,000 (one-word). */
const SEGS_PER_CHUNK = 32;

describe('chunkText(spans: true) scales linearly', () => {
  for (const [name, make] of [
    ['chat log', chatLog],
    ['one-word paragraphs', (chars: number) => 'x\n\n'.repeat(Math.floor(chars / 3))],
  ] as const) {
    test(`${name}: span work per chunk is bounded and doubles with the input`, () => {
      const smallText = make(2 * MB);
      const largeText = make(4 * MB);
      const small = work(smallText);
      const large = work(largeText);
      for (const [w, text] of [[small, smallText], [large, largeText]] as const) {
        expect(w.segs / w.chunks).toBeLessThan(SEGS_PER_CHUNK);
        // One pass over the projected text, never a walk per offset.
        expect(w.units).toBeLessThanOrEqual(text.length);
      }
      expect(large.chunks / small.chunks).toBeLessThan(2.1);
      expect(large.segs / small.segs).toBeLessThan(2.1);
      expect(large.units / small.units).toBeLessThan(2.1);
    }, 120_000);
  }
});
