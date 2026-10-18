/**
 * Large pages (Wave A, T30): one canonical unit. Windows, cursors and outlines
 * address UTF-8 byte offsets snapped to code points and line starts; astral
 * characters, CRLF and lone long lines never split a character or lose a byte.
 */
import { describe, test, expect } from 'bun:test';
import {
  decodeCursor, encodeCursor, lineNumberAt, lineOffset, lineStartOf, pageOutline, totalLines,
  windowAround, windowForBytes, windowForLines, windowFrom,
} from '../src/core/page-window/window.ts';

const buf = (s: string) => Buffer.from(s, 'utf8');
const pageAll = (b: Buffer, max: number) => {
  const parts: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < 100_000 && at < b.length; i++) {
    const w = windowFrom(b, at, max);
    expect(w.byte_start).toBe(at);
    expect(Buffer.byteLength(w.text)).toBe(w.byte_end - w.byte_start);
    expect(w.text).not.toContain('\uFFFD');
    parts.push(buf(w.text));
    at = w.byte_end;
  }
  return Buffer.concat(parts);
};

describe('windows', () => {
  test('astral and multi-byte text pages losslessly at every window size', () => {
    const b = buf(Array.from({ length: 300 }, (_, i) => `${i} 😀 naïve 日本語 𝄞`).join('\n'));
    for (const max of [1, 3, 5, 7, 64, 1000]) expect(pageAll(b, max).equals(b)).toBe(true);
  });

  test('CRLF lines keep their carriage returns and count as one line each', () => {
    const b = buf('a\r\nbb\r\nccc\r\n');
    expect(totalLines(b)).toBe(3);
    const w = windowForLines(b, 2, 1, 1000);
    expect(w.text).toBe('bb\r\n');
    expect(w.line_start).toBe(2);
    expect(pageAll(b, 4).equals(b)).toBe(true);
  });

  test('a byte selector snaps back to its line start', () => {
    const b = buf('first line\nsecond 😀 line\nthird\n');
    const inside = b.indexOf('😀') + 2;
    const w = windowForBytes(b, inside, 100);
    expect(w.byte_start).toBe(lineStartOf(b, inside));
    expect(w.text.startsWith('second')).toBe(true);
    expect(lineNumberAt(b, inside)).toBe(2);
    expect(lineOffset(b, 3)).toBe(b.indexOf('third'));
  });

  test('a single line longer than the window is cut on code points and marked', () => {
    const b = buf('😀'.repeat(1000));
    const w = windowFrom(b, 0, 10);
    expect(w.forced_cut).toBe(true);
    expect(w.byte_end % 4).toBe(0);
  });

  test('windows around a span hold the span and the requested context', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const b = buf(lines.join('\n'));
    const start = b.indexOf('line 50');
    const w = windowAround(b, { start, end: start + 7 }, 2, 10_000);
    expect(w.text.split('\n').filter(Boolean)).toEqual(['line 48', 'line 49', 'line 50', 'line 51', 'line 52']);
  });
});

describe('outline', () => {
  test('headings inside code fences are not headings', () => {
    const b = buf('# Top\n\ntext\n\n```\n# not a heading\n```\n\n## Real\n\nmore\n');
    const o = pageOutline(b);
    expect(o.kind).toBe('headings');
    expect(o.entries.map(e => e.heading)).toEqual(['Top', 'Real']);
    expect(o.entries[o.entries.length - 1].byte_end).toBe(b.length);
  });

  test('pages without headings outline as blocks with date ranges, paged by from/limit', () => {
    const b = buf(Array.from({ length: 30_000 }, (_, i) => `2026-0${1 + (i % 9)}-1${i % 10} note ${i}`).join('\n'));
    const first = pageOutline(b, 0, 2);
    expect(first.kind).toBe('blocks');
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].date_min).toMatch(/^2026-0\d-1\d$/);
    expect(first.next_from_index).toBe(2);
    const all = pageOutline(b, 0, 500);
    expect(all.entries[0].byte_start).toBe(0);
    for (let i = 1; i < all.entries.length; i++) expect(all.entries[i].byte_start).toBe(all.entries[i - 1].byte_end);
  });
});

describe('cursor', () => {
  test('round-trips and rejects tampering', () => {
    const c = { page_id: 7, revision: 'r-1', view: 'read' as const, offset: 1234, max_bytes: 40_000 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('gpw1.!!')).toBeNull();
    expect(decodeCursor('nope')).toBeNull();
    const forge = (v: unknown) => 'gpw1.' + Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodeCursor(forge([7, 'r', 'read', -1, 10]))).toBeNull();
    expect(decodeCursor(forge([7, 'r', 'raw', 0, 10]))).toBeNull();
    expect(decodeCursor(forge([7, 'r', 'read', 0, 0]))).toBeNull();
  });
});
