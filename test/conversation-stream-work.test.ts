/**
 * PR 4 (Wave B incremental derivation, transcripts), lane 4b round 3: the cross-occurrence window stream
 * (src/core/facts/conversation-stream.ts) parses a message that spans many segment cuts once, and reads continuations
 * under the page's grammar instead of detecting it again per occurrence. Engine-free: synthetic occurrences and an
 * in-memory reader; the parse work is counted by spying on the parser.
 *
 * 1. Protects: the parse work over a message spanning 40 occurrences stays linear in the page (at most three times its
 *    length), and the streamed windows equal the whole-page pass's windows exactly, for a time-less transcript
 *    (plain-role-no-time, which only a whole-body score detects) whose continuations alone would fail detection.
 * 2. Fails when: the held message is re-parsed with every occurrence it grows through (quadratic), or a continuation is
 *    dropped because its occurrence was run through pattern detection again.
 */
import { expect, spyOn, test } from 'bun:test';
import * as parser from '../src/core/conversation-parser/parse.ts';
import type { Page } from '../src/core/types.ts';
import type { ConversationOccurrence } from '../src/core/page-body/segment-conversation.ts';
import { streamConversationWindows } from '../src/core/facts/conversation-stream.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../src/core/facts/conversation-windows.ts';

const page = { slug: 'notes/stream-work', title: 'Stream work', frontmatter: { date: '2025-03-01', type: 'conversation' } } as unknown as Page;
const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency'];
const prose = (seed: number, words: number) => Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ');

/** Turns of a time-less transcript; turn `long` carries `longLines` continuation lines. */
function transcript(turns: number, long: number, longLines: number): string {
  const lines: string[] = [];
  for (let t = 0; t < turns; t++) {
    lines.push(`${t % 2 === 0 ? 'user' : 'assistant'}: ${prose(t, 12)}`);
    const continuation = t === long ? longLines : 2;
    for (let c = 0; c < continuation; c++) lines.push(prose(t + c, 14));
  }
  return lines.join('\n') + '\n';
}

/** Cut `text` at line ends into pieces of about `size` characters, as the segmenter cuts a long message. */
function cut(text: string, size: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) end = text.indexOf('\n', end) + 1 || text.length;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

test('a message spanning 40 occurrences is parsed once, and the windows equal the whole-page windows', async () => {
  const body = transcript(600, 300, 40 * 160);
  const texts = cut(body, 20_000);
  const occurrences = texts.map((_, i) => ({ row: { region: 'truth', occurrenceId: i + 1 }, conversation: { pattern: null, fallbackDate: null, lastDate: null, open: false } })) as unknown as ConversationOccurrence[];
  const expected = splitIntoSegments(parser.parseConversation(body, { page }).messages, { pageTitle: 'Stream work' }).map(seg => renderSegmentForExtraction('Stream work', seg));
  let parsed = 0;
  const original = parser.parseConversation;
  const originalApply = parser.applyPattern;
  const parseSpy = spyOn(parser, 'parseConversation').mockImplementation(((text: string, opts?: parser.ParseConversationOpts) => { parsed += text.length; return original(text, opts); }) as never);
  const applySpy = spyOn(parser, 'applyPattern').mockImplementation(((text: string, ...rest: unknown[]) => { parsed += text.length; return (originalApply as (...a: unknown[]) => unknown)(text, ...rest); }) as never);
  const windows: string[] = [];
  try {
    await streamConversationWindows(occurrences, 0, occurrences.length, { page, gapMinutes: null }, async i => texts[i]!, {
      window(_owner, seg) { windows.push(renderSegmentForExtraction('Stream work', seg)); },
      occurrence() {},
    });
  } finally {
    parseSpy.mockRestore();
    applySpy.mockRestore();
  }
  expect(texts.length).toBeGreaterThan(40);
  expect(expected.length).toBeGreaterThan(10);
  expect({ windows: windows.length, same: windows.join('\n---\n') === expected.join('\n---\n'), linear: parsed <= 3 * body.length })
    .toEqual({ windows: expected.length, same: true, linear: true });
});
