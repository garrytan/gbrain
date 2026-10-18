/**
 * Wave B (spec 2.2, 3.1): pass 1 holds O(line buffer) of a newline-free file.
 *
 * Protects: while one 32 MiB line streams through BodyScanner in 64 KiB
 * chunks, the live heap (after a full GC) stays under 4 MiB above where it
 * started, for plain text, CR-only text (old Mac line ends), and CR-only text
 * whose first sub-line is an H1 or an embedded fence `title:` line (the title
 * readers' text is dropped once their regex cannot match).
 * Fails when: a long line is buffered whole (the carry before line buffering
 * retained twice the input), or a title candidate keeps text it cannot use.
 * Why existing coverage misses it: body-scan.test.ts checks results, not
 * what the scanner retains; body-scan-linear.test.ts checks CPU.
 * Seams: bun:jsc heapStats after Bun.gc(true); no mocks.
 */
import { describe, expect, test } from 'bun:test';
import { heapStats } from 'bun:jsc';
import { BodyScanner } from '../../src/core/page-body/body-scan.ts';

const CHUNK = 64 * 1024;
const LINE_BYTES = 32 * 1024 * 1024;
const RETAINED_LIMIT_MIB = 4;

function liveMiB(): number {
  Bun.gc(true);
  const stats = heapStats();
  return (stats.heapSize + stats.extraMemorySize) / 2 ** 20;
}

const SHAPES: Array<{ name: string; lead: string; unit: string }> = [
  { name: 'plain text', lead: 'start ', unit: 'word text ' },
  { name: 'CR-only text', lead: 'start\r', unit: 'word text\r' },
  { name: 'CR-only text after an H1', lead: '# Title\r', unit: 'word text\r' },
  { name: 'CR-only text after an embedded title', lead: '---\ntype: note\n---\n---\ntitle: x\r', unit: 'word text\r' },
];

describe('body scan memory on a newline-free line', () => {
  for (const shape of SHAPES) {
    test(`${shape.name}: live heap stays under ${RETAINED_LIMIT_MIB} MiB above the start`, () => {
      const chunk = Buffer.from(shape.unit.repeat(Math.ceil(CHUNK / shape.unit.length)).slice(0, CHUNK));
      const base = liveMiB();
      const scanner = new BodyScanner('notes/memory-example.md', { validate: true });
      scanner.push(Buffer.from(shape.lead));
      let peak = 0;
      for (let sent = 0, k = 1; sent < LINE_BYTES; sent += CHUNK, k++) {
        scanner.push(Buffer.from(chunk));
        if (k % 128 === 0) peak = Math.max(peak, liveMiB() - base);
      }
      const result = scanner.finish();
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.parsed.title).toBe('Memory Example');
      expect(peak).toBeLessThan(RETAINED_LIMIT_MIB);
    }, 60_000);
  }
});
