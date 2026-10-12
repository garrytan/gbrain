/**
 * Wave 15 P2.5 (PR #6267, [R17] [R24]): `extract-conversation-facts` must
 * deliver every eligible turn to the extractor in bounded windows instead of
 * clipping a dense segment at 6,500 rendered characters or dropping the 31st
 * reply of a 31-turn group.
 *
 *   eligible gap group → bounded windows (message cap + rendered-char budget)
 *
 * Eligibility is decided per gap-separated group before windowing, so an
 * original singleton stays ineligible, a gap-separated tail is never glued to
 * the previous window and a trailing reply that cannot fit opens a new
 * bounded window. Oversized turns split at sentence boundaries with the
 * speaker prefix repeated; a header that leaves no room refuses before any
 * window exists. Pages already stamped complete are not re-extracted.
 *
 * Contributed by @jordanschwartz-js (PR #6267 reproduced the clip and wrote
 * the first coverage cases); this file is the superseding design's tests.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  DEFAULT_SEGMENT_MAX_MESSAGES,
  MIN_SEGMENT_MESSAGES,
  SEGMENT_TEXT_CHAR_LIMIT,
  parseConversationMessages,
  renderSegmentForExtraction,
  runExtractConversationFactsCore,
  splitIntoSegments,
  type ConversationMessage,
  type ConversationSegment,
} from '../src/commands/extract-conversation-facts.ts';

const TITLE = 'imessage: Alice Example';

function at(minute: number, speaker: string, text: string): ConversationMessage {
  const base = Date.UTC(2024, 2, 15, 9, 0, 0);
  return { speaker, timestamp: new Date(base + minute * 60_000).toISOString().replace('.000Z', 'Z'), text };
}

function turns(count: number, textFor: (i: number) => string, startMinute = 0): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => at(startMinute + i, i % 2 === 0 ? 'Alice Example' : 'Bob Demo', textFor(i)));
}

function rendered(segments: ConversationSegment[], title = TITLE): string[] {
  return segments.map((seg) => renderSegmentForExtraction(title, seg));
}

/** Each original turn's text appears in exactly one window, in order. */
function expectEveryTurnOnce(messages: ConversationMessage[], windows: string[]): void {
  for (const m of messages) {
    const line = `${m.speaker} (${m.timestamp}): ${m.text}`;
    const hits = windows.filter((w) => w.includes(line));
    expect(hits).toHaveLength(1);
  }
}

describe('conversation windows (#6267): eligibility before windowing', () => {
  test('40 dense turns (~9,000 rendered chars): every turn lands in exactly one window and no window exceeds the budget', () => {
    const messages = turns(40, (i) => `turn ${String(i).padStart(2, '0')} ${'x'.repeat(200)} end-${i}`);
    const segments = splitIntoSegments(messages, { pageTitle: TITLE });
    const windows = rendered(segments);
    expect(segments.reduce((n, s) => n + s.messages.length, 0)).toBe(40);
    for (const w of windows) {
      expect(w.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT);
      expect(w).not.toContain('…(truncated)');
    }
    for (const s of segments) expect(s.messages.length).toBeLessThanOrEqual(DEFAULT_SEGMENT_MAX_MESSAGES);
    expectEveryTurnOnce(messages, windows);
    expect(windows.length).toBeGreaterThanOrEqual(2);
  });

  test('31 messages in one eligible group: the 31st reply is kept as its own bounded window, not dropped', () => {
    const messages = turns(31, (i) => `short ${i}`);
    const segments = splitIntoSegments(messages, { pageTitle: TITLE });
    expect(segments.reduce((n, s) => n + s.messages.length, 0)).toBe(31);
    expect(segments.map((s) => s.messages.length)).toEqual([30, 1]);
    expect(segments[1].messages[0].text).toBe('short 30');
    expect(segments[1].startIso).toBe(messages[30].timestamp);
    expectEveryTurnOnce(messages, rendered(segments));
  });

  test('an original singleton stays ineligible, alone and after a gap', () => {
    expect(splitIntoSegments([at(0, 'Alice Example', 'only one')], { pageTitle: TITLE })).toHaveLength(0);
    const long = at(0, 'Alice Example', `${'A long single turn. '.repeat(600)}`);
    expect(long.text.length).toBeGreaterThan(SEGMENT_TEXT_CHAR_LIMIT);
    // Splitting one oversized turn must not make a singleton conversation eligible.
    expect(splitIntoSegments([long], { pageTitle: TITLE })).toHaveLength(0);
    const withTail = [...turns(2, (i) => `pair ${i}`), at(200, 'Alice Example', 'lonely tail')];
    const segments = splitIntoSegments(withTail, { pageTitle: TITLE });
    expect(segments).toHaveLength(1);
    expect(segments[0].messages.map((m) => m.text)).toEqual(['pair 0', 'pair 1']);
    expect(MIN_SEGMENT_MESSAGES).toBe(2);
  });

  test('a gap-separated tail is never glued to the previous window', () => {
    const head = turns(30, (i) => `head ${i}`);
    const tail = turns(2, (i) => `tail ${i}`, 29 + 90);
    const segments = splitIntoSegments([...head, ...tail], { pageTitle: TITLE });
    expect(segments.map((s) => s.messages.length)).toEqual([30, 2]);
    expect(segments[1].startIso).toBe(tail[0].timestamp);
    for (const s of segments) {
      expect(Date.parse(s.endIso) - Date.parse(s.startIso)).toBeLessThan(90 * 60_000);
    }
    const lonely = splitIntoSegments([...head, at(29 + 90, 'Bob Demo', 'lonely')], { pageTitle: TITLE });
    expect(lonely.reduce((n, s) => n + s.messages.length, 0)).toBe(30);
  });

  test('a full window plus a long final reply: the reply opens new bounded windows split at sentence boundaries with the speaker prefix repeated', () => {
    const head = turns(30, (i) => `head ${i}`);
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence ${i} says 日本語 and 🎉 then stops here. `);
    const reply = at(30, 'Bob Demo', sentences.join('').trimEnd());
    expect(reply.text.length).toBeGreaterThan(SEGMENT_TEXT_CHAR_LIMIT);
    const segments = splitIntoSegments([...head, reply], { pageTitle: TITLE });
    expect(segments[0].messages).toHaveLength(30);
    const pieces = segments.slice(1).flatMap((s) => s.messages);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    for (const p of pieces) {
      expect(p.speaker).toBe('Bob Demo');
      expect(p.timestamp).toBe(reply.timestamp);
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.text.isWellFormed()).toBe(true);
    }
    expect(pieces.map((p) => p.text).join('')).toBe(reply.text);
    // Every cut sits after a sentence end.
    for (const p of pieces.slice(0, -1)) expect(p.text.trimEnd().endsWith('.')).toBe(true);
    for (const w of rendered(segments)) {
      expect(w.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT);
      expect(w).not.toContain('…(truncated)');
    }
    const prefix = `Bob Demo (${reply.timestamp}): `;
    for (const w of rendered(segments).slice(1)) expect(w.split(prefix).length - 1).toBeGreaterThanOrEqual(1);
    expect(segments.reduce((n, s) => n + s.messages.length, 0)).toBe(30 + pieces.length);
  });

  test('a single sentence longer than the budget is cut on code-point boundaries and reassembles exactly', () => {
    const run = '🙂é字'.repeat(4_000);
    const messages = [at(0, 'Alice Example', 'hi'), at(1, 'Bob Demo', run)];
    const segments = splitIntoSegments(messages, { pageTitle: TITLE });
    const pieces = segments.flatMap((s) => s.messages).filter((m) => m.speaker === 'Bob Demo');
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.text.isWellFormed()).toBe(true);
    expect(pieces.map((p) => p.text).join('')).toBe(run);
    for (const w of rendered(segments)) expect(w.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT);
  });

  test('a header that leaves no room for text refuses before any window is built', () => {
    const messages = turns(3, (i) => `turn ${i}`);
    const title = 'T'.repeat(SEGMENT_TEXT_CHAR_LIMIT);
    expect(() => splitIntoSegments(messages, { pageTitle: title })).toThrow(/header/);
  });

  test('renderSegmentForExtraction refuses an oversized hand-built window instead of clipping it', () => {
    const messages = turns(40, (i) => `turn ${i} ${'y'.repeat(200)}`);
    const seg: ConversationSegment = {
      messages,
      startIso: messages[0].timestamp,
      endIso: messages[39].timestamp,
      participants: ['Alice Example', 'Bob Demo'],
    };
    expect(() => renderSegmentForExtraction(TITLE, seg)).toThrow(/window/);
  });

  test('the rendering of a window that fits is unchanged (no extractor-version bump)', () => {
    const messages = turns(2, (i) => `hello ${i}`);
    const [seg] = splitIntoSegments(messages, { pageTitle: TITLE });
    expect(renderSegmentForExtraction(TITLE, seg)).toBe([
      `Page: ${TITLE}`,
      `Conversation between Alice Example and Bob Demo from ${messages[0].timestamp} to ${messages[1].timestamp}`,
      '---',
      `Alice Example (${messages[0].timestamp}): hello 0`,
      `Bob Demo (${messages[1].timestamp}): hello 1`,
    ].join('\n'));
  });

  test('legacy options still apply: maxMessages, gapMinutes and sinceIso', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `**Alice Example** (2024-03-15 9:0${i} AM): msg ${i}`);
    const parsed = parseConversationMessages(lines.join('\n'));
    const capped = splitIntoSegments(parsed, { maxMessages: 3, pageTitle: TITLE });
    expect(capped.map((s) => s.messages.length)).toEqual([3, 3, 1]);
    const since = splitIntoSegments(parsed, { sinceIso: '2024-03-15T09:04:30Z', pageTitle: TITLE });
    expect(since.flatMap((s) => s.messages.map((m) => m.text))).toEqual(['msg 5', 'msg 6']);
    const gapped = splitIntoSegments(parsed, { gapMinutes: 0.5, pageTitle: TITLE });
    expect(gapped).toHaveLength(0);
  });
});

describe('conversation windows (#6267): command path on PGLite', () => {
  let engine: PGLiteEngine;
  const dense = Array.from({ length: 40 }, (_, i) => {
    const mm = String(i).padStart(2, '0');
    const who = i % 2 === 0 ? 'Alice Example' : 'Bob Demo';
    return `**${who}** (2024-03-15 9:${mm} AM): dense turn ${mm} ${'z'.repeat(200)} tail-${mm}`;
  }).join('\n');

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('a dense page delivers every turn once, the preview counts every window, and the completed page is not re-extracted', async () => {
    const slug = 'conversations/dense-example';
    await engine.putPage(slug, { type: 'conversation', title: TITLE, compiled_truth: dense, timeline: '', frontmatter: { date: '2024-03-15' } }, { sourceId: 'default' });
    const preview = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug, dryRun: true, sleepMs: 0, extractor: async () => [] });
    expect(preview.pages_processed).toBe(1);
    const seen: string[] = [];
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug, sleepMs: 0,
      extractor: async (input) => { seen.push(input.turnText); return []; },
    });
    expect(result.pages_processed).toBe(1);
    expect(result.pages_failed).toBe(0);
    expect(seen.length).toBe(preview.segments_processed);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const w of seen) {
      expect(w.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT);
      expect(w).not.toContain('…(truncated)');
    }
    for (let i = 0; i < 40; i++) {
      const mm = String(i).padStart(2, '0');
      expect(seen.filter((w) => w.includes(`tail-${mm}`))).toHaveLength(1);
    }
    let again = 0;
    const replay = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug, sleepMs: 0, extractor: async () => { again++; return []; } });
    expect(replay.pages_skipped_completed).toBe(1);
    expect(again).toBe(0);
  });

  test('a segment-limited run never stamps unseen text complete; the next run reaches the tail', async () => {
    const slug = 'conversations/dense-limited-example';
    await engine.putPage(slug, { type: 'conversation', title: TITLE, compiled_truth: dense, timeline: '', frontmatter: { date: '2024-03-15' } }, { sourceId: 'default' });
    const first: string[] = [];
    const limited = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug, sleepMs: 0, segmentLimit: 1,
      extractor: async (input) => { first.push(input.turnText); return []; },
    });
    expect(limited.segments_processed).toBe(1);
    expect(first.some((w) => w.includes('tail-39'))).toBe(false);
    const rest: string[] = [];
    const resumed = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug, sleepMs: 0,
      extractor: async (input) => { rest.push(input.turnText); return []; },
    });
    expect(resumed.pages_skipped_completed).toBe(0);
    expect(resumed.pages_processed).toBe(1);
    expect(rest.some((w) => w.includes('tail-39'))).toBe(true);
  });
});
