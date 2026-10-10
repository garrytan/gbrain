/**
 * GBRA-68: the inline-citation reader returns early when a page has no
 * `[Source:` (a match needs that literal, and neither code masking nor the
 * paragraph join can create it). Seeded random markdown pins that the exit
 * changes no result: appending a neutral comment paragraph that contains
 * `[Source:` makes the reader take its full path without joining or changing
 * any other paragraph; inputs that already cite take the full path both ways,
 * which shows the paragraph is neutral.
 */
import { describe, expect, test } from 'bun:test';
import { isDatedTimelineLine, parseInlineCitationTimelineEntries, supersededInlineCitationEntries } from '../src/core/timeline-citations.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  '`', '``', '```', '````', '~~~', '~~~~', '```ts', '``` x `', '~~~ `', '\n', '\n', '\n', '\r\n', '\r', ' ', '   ', '    ', '\t',
  '<', '<!--', '-->', '<!-- note -->', '<b>', 'word', 'two words', 'é', '😀', '[[alice-example]]', '[[people/bob-example|Bob]]',
  '[Source: Meeting notes, 2024-03-05]', '[Source: A, 2024-02-01; B, 2024-02-03]', '[Source:', '[source: x, 2024-01-01]', ', 2024-13-40]',
  '- **2024-03-05** | Joined', '## Timeline', '# Title', '- ', '1. ', '> ', '*emph*', '**bold**', '---', 'title: x', ']', '[',
];

function randomDoc(next: () => number): string {
  const n = Math.floor(next() * 120);
  let doc = '';
  for (let k = 0; k < n; k++) doc += TOKENS[Math.floor(next() * TOKENS.length)];
  return doc;
}

describe('inline-citation reader: the no-citation exit changes no result', () => {
  const NEUTRAL = '\n\n<!-- [Source: neutral, 2024-01-01] -->\n';
  const readers = [
    (c: string) => parseInlineCitationTimelineEntries(c),
    (c: string) => parseInlineCitationTimelineEntries(c, { skipLine: isDatedTimelineLine }),
    (c: string) => supersededInlineCitationEntries(c, { skipLine: (line) => /^-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|/.test(line) }),
  ];

  test('20,000 seeded random documents', () => {
    const next = rng(6801);
    let cited = 0;
    for (let k = 0; k < 20_000; k++) {
      const doc = randomDoc(next);
      if (doc.includes('[Source:')) cited++;
      for (const read of readers) {
        const fast = read(doc);
        const full = read(doc + NEUTRAL);
        if (JSON.stringify(fast) !== JSON.stringify(full)) expect({ doc, fast }).toEqual({ doc, fast: full });
      }
    }
    expect(cited).toBeGreaterThan(5_000);
    expect(cited).toBeLessThan(19_000);
  });
});
