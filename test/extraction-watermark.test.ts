/**
 * planExtraction (src/core/extraction-watermark.ts): the watermark decision
 * on its own, for the cases the pipeline tests do not reach.
 *
 * 1. Protects: offsets are UTF-8 bytes, so a multi-byte body resumes exactly
 *    at the appended text; a stale pipeline version or an offset past the body
 *    falls back to the head with the reason; a tail window never starts inside
 *    a surrogate pair.
 * 2. Regression that fails it: counting the watermark in UTF-16 units, or
 *    trusting a watermark from another pipeline version.
 * 3. The facts and atoms suites use ASCII bodies and the current version.
 * 4. No seam: a pure function.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EXTRACTION_PIPELINE_VERSION, planExtraction, type StoredWatermark } from '../src/core/extraction-watermark.ts';

const opts = { cap: 40, pipeline: 'facts_backstop' as const, emptyTail: 'skip' as const };
const mark = (body: string, version = EXTRACTION_PIPELINE_VERSION.facts_backstop): StoredWatermark => {
  const buf = Buffer.from(body, 'utf8');
  return { pipelineVersion: version, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
};

describe('planExtraction', () => {
  test('a multi-byte body resumes at the appended text (offsets are UTF-8 bytes)', () => {
    const before = 'Grüße aus Zürich — 😀 '.repeat(4);
    const plan = planExtraction(before + 'appended line', mark(before), opts);
    expect(plan).toMatchObject({ mode: 'tail', text: 'appended line', truncated: null });
    expect(plan.next.bytes).toBe(Buffer.byteLength(before + 'appended line', 'utf8'));
  });

  test('a stale pipeline version and an offset past the body read the head with the reason', () => {
    const before = 'x'.repeat(60);
    expect(planExtraction(before + 'more', mark(before, 0), opts).truncated).toMatchObject({ kind: 'head', reason: 'version_changed' });
    expect(planExtraction(before.slice(0, 50), mark(before), opts).truncated).toMatchObject({ kind: 'head', reason: 'prefix_changed' });
  });

  test('nothing appended: skip, or re-read the head when the caller asks', () => {
    const body = 'y'.repeat(60);
    expect(planExtraction(body, mark(body), opts)).toMatchObject({ mode: 'tail', text: '' });
    expect(planExtraction(body, mark(body), { ...opts, emptyTail: 'head' }).truncated).toMatchObject({ kind: 'head', reason: 'no_new_text' });
  });

  test('a tail window never starts inside a surrogate pair', () => {
    const before = 'z'.repeat(60);
    const tail = '😀'.repeat(30) + 'end';
    const plan = planExtraction(before + tail, mark(before), opts);
    expect(plan.truncated).toMatchObject({ kind: 'tail_window', total_chars: tail.length });
    expect(plan.text.endsWith('end')).toBe(true);
    expect(plan.text).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(plan.text.length).toBeLessThanOrEqual(opts.cap);
  });
});
