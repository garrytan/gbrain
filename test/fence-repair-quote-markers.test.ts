/**
 * #8059 prose-quoted fence markers (src/core/fence-repair/quote-markers.ts) and the screen reason `quoted_marker`.
 *
 * 1. Protects: a facts or takes marker quoted in prose (text after it on its line, or a blockquote line; outside code and
 *    table lines; beginning or ending no fence that holds rows) is wrapped in backticks, and only then; every fence row
 *    stays put; the privacy boundary hides at least what it hid; the edit is a fixed point; the write-path screen names
 *    `quoted_marker` only when the wrap alone would clear the page, and never edits it.
 * 2. Fails when: a real marker is wrapped (rows lost), an existing code span re-pairs, a wrap would show text the
 *    boundary hid, or the screen keeps `repeated_marker` for a page the repair clears.
 *    The screen runs on the write path, so it stays linear: a page of 40,000 mentions (on separate lines or one line)
 *    is screened in under two seconds; the per-mention prefix split and array copies made it quadratic (minutes at 24 MiB).
 * 3. Pure; no engine.
 */
import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as B, FACTS_FENCE_END as E } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE } from '../src/core/takes-fence.ts';
import { quoteMarkerStep } from '../src/core/fence-repair/quote-markers.ts';
import { fenceStep } from '../src/core/fence-repair/tier1.ts';
import { scanCanonicalFences } from '../src/core/fence-repair/refusal.ts';
import { extractRawRows } from '../src/core/fence-repair/raw-rows.ts';
import { FENCE_REASONS } from '../src/core/fence-repair/reasons.ts';
import type { FenceCtx } from '../src/core/fence-repair/types.ts';

const tick = (m: string) => `\`${m}\``;
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const row = (n: number) => `| ${n} | Acme Example claim ${n} | fact | 0.9 | private | medium | 2024-01-01 |  | note | ctx |`;
const FENCE = [B, HEADER, SEP, row(1), row(2), E].join('\n');
const TAKES = [TB, '| # | claim | kind | who | weight | since | source |', '|---|---|---|---|---|---|---|', '| 1 | A synthetic take | take | brain | 0.7 | 2026-01 | chat |', TE].join('\n');
const ctx: FenceCtx = { pageVisibility: 'private' };
const page = (body: string, timeline = '') => ({ compiled_truth: body, timeline });
const rowLines = (text: string) => extractRawRows(text).fences.flatMap(f => f.rows.map(r => text.slice(r.start, r.end)));

describe('quoteMarkerStep', () => {
  test('a prose-quoted begin and end above a real fence are wrapped; the real fence and its rows stay; the page compiles', () => {
    const before = page(`We said ${B} starts a fence and ${E} ends it.\n\n${FENCE}\n`);
    expect(scanCanonicalFences(before).defects.map(d => d.reason)).toEqual(['repeated_marker']);
    const step = quoteMarkerStep(before);
    expect(step.page.compiled_truth).toBe(`We said ${tick(B)} starts a fence and ${tick(E)} ends it.\n\n${FENCE}\n`);
    expect(step.fixes).toEqual([
      { fence: 'facts', section: 'body', row: null, column: null, line: 1, class: 'quote_marker' },
      { fence: 'facts', section: 'body', row: null, column: null, line: 1, class: 'quote_marker' },
    ]);
    expect(scanCanonicalFences(step.page).defects).toEqual([]);
    expect(rowLines(step.page.compiled_truth)).toEqual([row(1), row(2)]);
    expect(quoteMarkerStep(step.page).fixes).toEqual([]);
  });

  test('a blockquote line and the timeline section are mentions; CRLF lines keep their terminators', () => {
    const step = quoteMarkerStep(page(`> ${E}\r\n> quoted\r\n\r\n${FENCE.replaceAll('\n', '\r\n')}\r\n`, `- 2026-01-01: noted that ${TB} opens takes\n`));
    expect(step.page.compiled_truth.startsWith(`> ${tick(E)}\r\n> quoted\r\n`)).toBe(true);
    expect(step.page.timeline).toBe(`- 2026-01-01: noted that ${tick(TB)} opens takes\n`);
    expect(step.fixes.map(f => [f.fence, f.section, f.line])).toEqual([['facts', 'body', 1], ['takes', 'timeline', 1]]);
  });

  test('not mentions: text only before the marker, a table line, inline code, a fenced code block, a backtick neighbour', () => {
    for (const body of [
      `Facts: ${FENCE}\n`,
      `${FENCE}\n\n| 3 | ${B} in a cell | fact |\n`,
      `Use ${tick(B)} and more.\n\n${FENCE}\n`,
      `\`\`\`md\nWe said ${B} here\n\`\`\`\n\n${FENCE}\n`,
      `x\`${B} y\n`,
    ]) expect(quoteMarkerStep(page(body)).fixes).toEqual([]);
  });

  test('a line whose existing code spans would re-pair keeps its marker; double-backtick and escaped-backtick spans are kept', () => {
    expect(quoteMarkerStep(page(`odd \` tick ${B} here\n`)).fixes).toEqual([]);
    const kept = quoteMarkerStep(page(`see \`\`a\`b\`\` and \\\` then ${E} here\n`));
    expect(kept.page.compiled_truth).toBe(`see \`\`a\`b\`\` and \\\` then ${tick(E)} here\n`);
  });

  test('a marker that begins or ends a fence holding rows is real, even with text after it: only the prose mention is wrapped', () => {
    const before = page(`${FENCE.replace(E, `${E}Next paragraph`)}\nLater: see ${B} docs.\n`);
    const step = quoteMarkerStep(before);
    expect(step.page.compiled_truth).toBe(`${FENCE.replace(E, `${E}Next paragraph`)}\nLater: see ${tick(B)} docs.\n`);
    expect(rowLines(step.page.compiled_truth)).toEqual([row(1), row(2)]);
    const realBegin = page(`${B} the table below\n${HEADER}\n${SEP}\n${row(1)}\n${E}\n`);
    expect(quoteMarkerStep(realBegin).fixes).toEqual([]);
  });

  test('a wrap that would show text the privacy boundary hid is not made (a begin followed by an end already quoted in code)', () => {
    const before = page(`Prose ${B} opens.\nMiddle line.\nThen ${tick(E)} quoted.\nTail text.\n`);
    expect(quoteMarkerStep(before)).toEqual({ page: before, fixes: [] });
  });

  test('takes markers are mentions too', () => {
    const step = quoteMarkerStep(page(`The ${TB} and ${TE} markers.\n\n${TAKES}\n`));
    expect(step.fixes.map(f => f.fence)).toEqual(['takes', 'takes']);
    expect(scanCanonicalFences(step.page).defects).toEqual([]);
  });
});

describe('the screen reason', () => {
  test('quoted_marker is a deterministic, auto-retried screen reason', () => {
    expect(FENCE_REASONS.quoted_marker).toMatchObject({ stage: 'screen', tier: 'deterministic', manualOnly: false, autoRetry: true });
  });

  test('fenceStep names quoted_marker when the wrap alone clears the page, and never edits it', () => {
    const before = page(`We said ${B} starts a fence.\n\n${FENCE}\n`);
    const step = fenceStep(before, ctx, { normalize: true });
    expect(step.status).toBe('residual');
    if (step.status !== 'residual') return;
    expect(step.issues).toEqual([{ fence: 'facts', section: 'body', row: null, column: null, line: 1, reason: 'quoted_marker' }]);
    expect(step.location).toMatchObject({ reason: 'quoted_marker', fence: 'facts', section: 'body', line: 1 });
  });

  test('fenceStep keeps the plain reason when the wrap would not clear the page', () => {
    const bad = FENCE.replace(row(2), '| 2 | Acme Example claim 2 | fact | 0.9 | sideways | medium | 2024-01-01 |  | note | ctx |');
    const step = fenceStep(page(`We said ${B} starts a fence.\n\n${bad}\n`), ctx, { normalize: true });
    expect(step.status).toBe('residual');
    if (step.status === 'residual') expect(step.issues.map(i => i.reason)).not.toContain('quoted_marker');
  });
});

describe('the screen stays linear in the page', () => {
  const timed = (body: string) => {
    const started = performance.now();
    const quoted = quoteMarkerStep(page(body));
    return { ms: performance.now() - started, fixes: quoted.fixes.length };
  };
  test('40,000 quoted markers on their own lines are screened in under two seconds', () => {
    const run = timed(Array.from({ length: 40_000 }, () => `See the ${E} marker in prose here.`).join('\n') + '\n');
    expect(run.fixes).toBe(40_000);
    expect(run.ms).toBeLessThan(2_000);
  });
  test('40,000 quoted markers on one line are screened as fast', () => {
    const run = timed(Array.from({ length: 40_000 }, () => `a ${E} b`).join(' ') + '\n');
    expect(run.fixes).toBe(40_000);
    expect(run.ms).toBeLessThan(2_000);
  });
});
