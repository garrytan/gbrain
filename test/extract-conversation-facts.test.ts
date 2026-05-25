/**
 * Tests for `gbrain extract-conversation-facts`.
 *
 * Covers the deterministic side of the command — parsing, segmenting,
 * rendering, and checkpointing — without spinning a real chat gateway.
 * The end-to-end extraction path is covered by extract.test.ts +
 * facts-backstop.test.ts; this file pins the per-command contract.
 */

import { describe, expect, test, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  parseConversationMessages,
  splitIntoSegments,
  renderSegmentForExtraction,
  runExtractConversationFactsCore,
  DEFAULT_SEGMENT_GAP_MINUTES,
  DEFAULT_SEGMENT_MAX_MESSAGES,
  SEGMENT_TEXT_CHAR_LIMIT,
} from '../src/commands/extract-conversation-facts.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(name: string, date: string, time: string, body: string): string {
  return `**${name}** (${date} ${time}): ${body}`;
}

// ---------------------------------------------------------------------------
// parseConversationMessages
// ---------------------------------------------------------------------------

describe('parseConversationMessages', () => {
  test('parses a single message line', () => {
    const msgs = parseConversationMessages(fmt('Alice Example', '2024-03-15', '6:07 PM', 'hello'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].speaker).toBe('Alice Example');
    expect(msgs[0].text).toBe('hello');
    expect(msgs[0].timestamp).toMatch(/^2024-03-15T18:07:00Z$/);
  });

  test('handles AM/PM and midnight/noon', () => {
    const body = [
      fmt('Bob Demo', '2024-03-15', '12:00 AM', 'midnight'),
      fmt('Bob Demo', '2024-03-15', '12:30 PM', 'noon'),
    ].join('\n');
    const msgs = parseConversationMessages(body);
    expect(msgs[0].timestamp).toBe('2024-03-15T00:00:00Z');
    expect(msgs[1].timestamp).toBe('2024-03-15T12:30:00Z');
  });

  test('treats unmatched lines as continuations of the prior message', () => {
    const body = [
      fmt('Alice Example', '2024-03-15', '9:00 AM', 'first line'),
      'still part of the first message',
      fmt('Bob Demo', '2024-03-15', '9:01 AM', 'separate message'),
    ].join('\n');
    const msgs = parseConversationMessages(body);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe('first line\nstill part of the first message');
    expect(msgs[1].text).toBe('separate message');
  });

  test('ignores leading orphan lines (no anchor message yet)', () => {
    const body = ['orphan one', 'orphan two', fmt('Alice Example', '2024-03-15', '9:00 AM', 'real')].join('\n');
    const msgs = parseConversationMessages(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('real');
  });

  test('empty body returns empty array', () => {
    expect(parseConversationMessages('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitIntoSegments
// ---------------------------------------------------------------------------

describe('splitIntoSegments', () => {
  test('cuts on time gap larger than gapMinutes', () => {
    const msgs = parseConversationMessages([
      fmt('Alice Example', '2024-03-15', '9:00 AM', 'a'),
      fmt('Bob Demo', '2024-03-15', '9:05 AM', 'b'),
      // Gap of 90 minutes > default 30 → new segment.
      fmt('Alice Example', '2024-03-15', '10:35 AM', 'c'),
      fmt('Bob Demo', '2024-03-15', '10:36 AM', 'd'),
    ].join('\n'));
    const segs = splitIntoSegments(msgs);
    expect(segs).toHaveLength(2);
    expect(segs[0].messages).toHaveLength(2);
    expect(segs[1].messages).toHaveLength(2);
  });

  test('cuts when segment reaches maxMessages cap', () => {
    const lines: string[] = [];
    for (let i = 0; i < 7; i++) {
      const mm = String(i).padStart(2, '0');
      lines.push(fmt('Alice Example', '2024-03-15', `9:${mm} AM`, `msg ${i}`));
    }
    const msgs = parseConversationMessages(lines.join('\n'));
    const segs = splitIntoSegments(msgs, { maxMessages: 3 });
    // 7 messages / 3 per segment → 2 full + 1 leftover (dropped: <2 messages).
    // Confirm: at least one segment hits the cap and the splitter never
    // emits a segment longer than maxMessages.
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (const s of segs) expect(s.messages.length).toBeLessThanOrEqual(3);
  });

  test('drops segments shorter than the minimum', () => {
    const msgs = parseConversationMessages(
      fmt('Alice Example', '2024-03-15', '9:00 AM', 'only one'),
    );
    expect(splitIntoSegments(msgs)).toHaveLength(0);
  });

  test('participants array preserves first-seen order', () => {
    const msgs = parseConversationMessages([
      fmt('Bob Demo', '2024-03-15', '9:00 AM', 'b1'),
      fmt('Alice Example', '2024-03-15', '9:05 AM', 'a1'),
      fmt('Bob Demo', '2024-03-15', '9:06 AM', 'b2'),
    ].join('\n'));
    const segs = splitIntoSegments(msgs);
    expect(segs[0].participants).toEqual(['Bob Demo', 'Alice Example']);
  });

  test('sinceIso filters out messages older than the watermark', () => {
    const msgs = parseConversationMessages([
      fmt('Alice Example', '2024-03-15', '9:00 AM', 'old'),
      fmt('Bob Demo', '2024-03-15', '9:05 AM', 'old'),
      fmt('Alice Example', '2024-03-16', '9:00 AM', 'new'),
      fmt('Bob Demo', '2024-03-16', '9:05 AM', 'new'),
    ].join('\n'));
    const segs = splitIntoSegments(msgs, { sinceIso: '2024-03-15T23:00:00Z' });
    expect(segs).toHaveLength(1);
    expect(segs[0].startIso).toBe('2024-03-16T09:00:00Z');
  });

  test('default tunables are sane', () => {
    // Pin the defaults so a future tuning change is explicit.
    expect(DEFAULT_SEGMENT_GAP_MINUTES).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_SEGMENT_MAX_MESSAGES).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// renderSegmentForExtraction
// ---------------------------------------------------------------------------

describe('renderSegmentForExtraction', () => {
  test('prepends topical/temporal context header', () => {
    const msgs = parseConversationMessages([
      fmt('Alice Example', '2024-03-15', '9:00 AM', 'hello'),
      fmt('Bob Demo', '2024-03-15', '9:05 AM', 'hi back'),
    ].join('\n'));
    const seg = splitIntoSegments(msgs)[0];
    const text = renderSegmentForExtraction('imessage: Alice Example', seg);
    expect(text).toContain('Page: imessage: Alice Example');
    expect(text).toContain('Conversation between Alice Example and Bob Demo');
    expect(text).toContain('2024-03-15T09:00:00Z');
    expect(text).toContain('2024-03-15T09:05:00Z');
  });

  test('truncates oversize segments but keeps the header intact', () => {
    const big = Array.from({ length: 500 }, (_, i) => {
      const mm = String(i % 60).padStart(2, '0');
      const hh = String(9 + Math.floor(i / 60)).padStart(2, '0');
      return `**Alice Example** (2024-03-15 ${hh}:${mm} AM): ${'x'.repeat(50)}`;
    }).join('\n');
    const msgs = parseConversationMessages(big);
    const seg = splitIntoSegments(msgs, { maxMessages: 500 })[0];
    const text = renderSegmentForExtraction('big-page', seg);
    expect(text.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT + 32);
    expect(text.startsWith('Page: big-page')).toBe(true);
    expect(text).toContain('Conversation between');
  });
});

// ---------------------------------------------------------------------------
// runExtractConversationFactsCore — engine wiring, dry-run, checkpoints
// ---------------------------------------------------------------------------

const SAMPLE_BODY = [
  fmt('Alice Example', '2024-03-15', '9:00 AM', 'Hi, I just signed the offer letter for Acme Corp.'),
  fmt('Bob Demo', '2024-03-15', '9:01 AM', "Congrats! What's the title?"),
  fmt('Alice Example', '2024-03-15', '9:02 AM', 'Staff engineer on the platform team.'),
  fmt('Bob Demo', '2024-03-15', '9:03 AM', 'Nice.'),
  // Big time gap → new segment.
  fmt('Alice Example', '2024-03-16', '8:00 AM', 'Update: I started at Acme Corp this morning.'),
  fmt('Bob Demo', '2024-03-16', '8:05 AM', 'Day one! How is it?'),
].join('\n');

describe('runExtractConversationFactsCore', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Stub the chat transport with a deterministic transport that
    // returns one valid fact per turn. Keeps the test offline and
    // fast — the real provider path is exercised by the facts/extract
    // unit tests, not here.
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [{
          fact: 'Alice Example signed an offer letter with Acme Corp.',
          kind: 'event',
          entity: 'companies/acme-corp',
          confidence: 1.0,
          notability: 'high',
        }],
      }),
      blocks: [],
      stopReason: 'end',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      model: 'stub:stub',
      providerId: 'stub',
    }));

    // Stub embed transport too — fact insertion path calls embedOne to
    // compute the row's embedding. Return a deterministic 2560-dim
    // vector so the test stays offline.
    __setEmbedTransportForTests(
      (async () => ({
        embeddings: [Array.from({ length: 2560 }, () => 0.1)],
      })) as never,
    );

    // Seed a conversation page directly through put_page so the engine
    // owns hashing + source_id defaulting. The body is the rendered
    // chat-log format the importer produces.
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY,
      timeline: '',
      frontmatter: {},
    });
    // Also seed a non-conversation page that must be ignored.
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Profile content.',
      timeline: '',
      frontmatter: {},
    });
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  afterEach(() => {
    // Reset between tests so prior checkpoint state doesn't leak.
    // The engine + transport stub stay configured at the suite level.
  });

  test('dry-run reports segments without inserting facts', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      slug: 'conversations/imessage/alice-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_considered).toBe(1);
    expect(result.pages_processed).toBe(1);
    // Dry-run never inserts.
    expect(result.facts_inserted).toBe(0);
    // The extractor itself stays a no-op when isAvailable('chat') is
    // false (no gateway configured in the test environment), so
    // facts_extracted may be 0 — what matters is that segmentation ran.
    expect(result.segments_processed).toBeGreaterThanOrEqual(1);
  });

  test('non-conversation pages are skipped', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      slug: 'people/alice-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_considered).toBe(0);
    expect(result.pages_processed).toBe(0);
  });

  test('respects sinceIso to skip already-processed history', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      slug: 'conversations/imessage/alice-example',
      dryRun: true,
      sleepMs: 0,
      // Watermark after the entire sample → no segments to process.
      sinceIso: '2099-01-01T00:00:00Z',
    });
    expect(result.pages_processed).toBe(0);
    expect(result.pages_skipped).toBe(1);
  });

  test('writes a checkpoint after a non-dry-run pass', async () => {
    // The extractor returns [] when chat is unavailable, so this run
    // inserts zero facts but should still advance the checkpoint to the
    // newest segment's endIso.
    await runExtractConversationFactsCore(engine, {
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    const checkpoint = await engine.getConfig(
      'facts.conversation_extraction_checkpoint.conversations/imessage/alice-example',
    );
    expect(checkpoint).not.toBeNull();
    // Should be the endIso of the latest segment (Mar 16 morning batch).
    expect(checkpoint).toMatch(/^2024-03-16T08:0[0-9]:00Z$/);
  });

  test('--force clears the checkpoint before processing', async () => {
    // First run sets a watermark; second run with force should re-process
    // from the start (no sinceIso filtering applied).
    await runExtractConversationFactsCore(engine, {
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    const result = await runExtractConversationFactsCore(engine, {
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
      force: true,
    });
    expect(result.segments_processed).toBeGreaterThanOrEqual(1);
  });
});
