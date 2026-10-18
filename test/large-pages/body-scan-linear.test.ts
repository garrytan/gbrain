/**
 * Wave B (spec 3.1): pass 1 stays linear in the file size.
 *
 * Protects: the streamed body scan does O(bytes) work on a page dense with
 * every state the scan carries (quoted sentinels inside fences, `---` lines
 * awaiting a Timeline H2, bare-section headings that fail their lookahead,
 * CRLF, astral text). The scan counts its work in `bodyScanWork`: bytes the
 * line split searches and the head readers read, bytes copied to join a carry
 * or keep a code-point tail, lines read, units the per-line passes read
 * (decode, NUL and content endpoints, line-head classifiers, fence tokens,
 * region walks, long-line and title readers), and region-walk steps. Counts,
 * not CPU time: a co-tenant on a sibling vCPU inflates one size's thread CPU
 * by 1.06-1.65x on CI, which no count sees.
 * Fails when: at n and 2n bytes (n = 4 MiB) a counter exceeds its per-byte
 * bound, or (with at least MIN_RATIO_COUNT counts at n) grows 2.1x or more:
 * a step that re-reads buffered input per line or per chunk (a re-decoded
 * prefix, a re-split carry, a per-candidate rescan). The forced probe re-reads
 * the whole buffered prefix through a fresh BodyScanner before each 32 KiB
 * push and asserts the counts catch it; the inflation probe burns 60% extra
 * thread CPU around the large size and asserts the counts and bounds hold
 * (the old CPU-time ratio read 3.16x there, 1.93x plain, past its 2.5x bound).
 * A new loop over the input or over carried state must count its work too.
 * Why existing coverage misses it: split-body-linear covers the whole-string
 * splitBody, not the streaming scanner.
 * Seams: `bodyScanWork` (@internal counters in body-scan.ts).
 * Measured (deterministic; per byte at n, doubling ratio): bytes 1.24 x1.81
 * (the 256 KiB head is read once), carry 0.077 x1.01 (the head join), lines
 * 0.049 x2.00, chars 11.15 x2.00, walks 0.112 x2.00. Prefix-re-reading probe
 * (n = 512 KiB): lines, chars and walks x4.51, bytes x3.28.
 */
import { describe, expect, test } from 'bun:test';
import { BodyScanner, bodyScanWork } from '../../src/core/page-body/body-scan.ts';
import {
  countWork, describeWork, linearityViolations, MAX_DOUBLING_RATIO, withCpuInflation, type Sample,
} from '../helpers/work-counts.ts';

const MB = 1024 * 1024;
/** Per input byte, about 2x the measured value or more. */
const PER_BYTE = { 'scan.bytes': 3, 'scan.carry': 0.5, 'scan.lines': 1, 'scan.chars': 24, 'scan.walks': 0.5 };
const PROBE_PUSH = 32 * 1024;

function page(bytes: number): Uint8Array {
  const unit = [
    '## Message from alice-example', 'Some prose with **bold** and 😀 𝄞', '', '---', '```ts', 'const x = 1; <!-- timeline -->', '```',
    '- 2024-05-01: dated entry', '## History', 'prose disqualifies the bare section', '  indented continuation',
  ].join('\r\n') + '\r\n';
  const head = '---\ntitle: Linear Example\ntags: [a, b]\n---\n';
  return Buffer.from(head + unit.repeat(Math.ceil(bytes / unit.length)) + '<!-- timeline -->\n- 2024: end\n');
}

function scan(bytes: Uint8Array): void {
  const scanner = new BodyScanner('notes/linear-example.md', { validate: true });
  for (let at = 0; at < bytes.length; at += 64 * 1024) scanner.push(bytes.subarray(at, at + 64 * 1024));
  expect(scanner.finish().kind).toBe('ok');
}

/** The deliberately quadratic variant: re-reads everything buffered so far through a fresh scanner before each push. */
function quadraticScan(bytes: Uint8Array): void {
  const scanner = new BodyScanner('notes/linear-example.md', { validate: true });
  for (let at = 0; at < bytes.length; at += PROBE_PUSH) {
    new BodyScanner('notes/linear-example.md', { validate: true }).push(bytes.subarray(0, at));
    scanner.push(bytes.subarray(at, at + PROBE_PUSH));
  }
  expect(scanner.finish().kind).toBe('ok');
}

const sample = (bytes: Uint8Array, run: (bytes: Uint8Array) => void): Sample => ({ bytes: bytes.length, work: countWork({ scan: bodyScanWork }, () => run(bytes)) });

describe('body scan work', () => {
  test('work per byte is bounded and doubles with the input', () => {
    const a = sample(page(4 * MB), scan);
    const b = sample(page(8 * MB), scan);
    console.log(`[body-scan-linear] scan: ${describeWork(a, b)}`);
    expect(linearityViolations(a, b, PER_BYTE)).toEqual([]);
  }, 60_000);

  test('forced probe: the same bounds fail a scan that re-reads its buffered prefix', () => {
    const a = sample(page(MB / 2), quadraticScan);
    const b = sample(page(MB), quadraticScan);
    console.log(`[body-scan-linear] prefix-re-reading scan (quadratic probe): ${describeWork(a, b)}`);
    expect(b.work['scan.chars']! / a.work['scan.chars']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
    expect(b.work['scan.lines']! / a.work['scan.lines']!).toBeGreaterThan(MAX_DOUBLING_RATIO);
  }, 120_000);

  test('inflation probe: 60% extra CPU on the large size cannot move the counts', () => {
    const a = sample(page(4 * MB), scan);
    const large = page(8 * MB);
    const plain = sample(large, scan);
    let cpu = { workMs: 0, totalMs: 0 };
    const inflated = sample(large, bytes => { cpu = withCpuInflation(() => scan(bytes), 0.6); });
    console.log(`[body-scan-linear] large size under a co-tenant: ${cpu.workMs.toFixed(0)} ms work, ${cpu.totalMs.toFixed(0)} ms thread CPU`);
    expect(inflated.work).toEqual(plain.work);
    expect(linearityViolations(a, inflated, PER_BYTE)).toEqual([]);
  }, 60_000);
});
