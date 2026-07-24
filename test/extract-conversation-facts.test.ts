/**
 * Tests for `gbrain extract-conversation-facts` — deterministic parsing,
 * segmenting, rendering, checkpoint encoding, and core wiring contracts.
 *
 * Hermetic via __setChatTransportForTests + __setEmbedTransportForTests
 * stubs so the suite stays offline. Real-LLM extraction quality is the
 * job of test/eval/conversation-extraction-quality.eval.ts (env-gated).
 *
 * Test-isolation invariants (per CLAUDE.md R3+R4):
 *   - One PGLite engine per file, created in beforeAll, disposed in afterAll
 *   - Per-test state reset via TRUNCATE inside beforeEach (canonical pattern)
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
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
  extractConversationFactsFingerprint,
  encodeCheckpointEntry,
  decodeCheckpointEntry,
  DEFAULT_SEGMENT_GAP_MINUTES,
  DEFAULT_SEGMENT_MAX_MESSAGES,
  SEGMENT_TEXT_CHAR_LIMIT,
  MAX_PAGE_BODY_BYTES,
  TERMINAL_AUDIT_SOURCE,
  NON_EXTRACTABLE_AUDIT_SOURCE,
  PER_SEGMENT_SOURCE_PREFIX,
  ALLOWED_TYPES,
} from '../src/commands/extract-conversation-facts.ts';
import { _resetLlmCacheForTests } from '../src/core/conversation-parser/llm-base.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function fmt(name: string, date: string, time: string, body: string): string {
  return `**${name}** (${date} ${time}): ${body}`;
}

// ---------------------------------------------------------------------------
// parseConversationMessages — PR's 5 cases verbatim.
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

test('conversation-facts allowlist includes native iMessage page types (#2756)', () => {
  expect(ALLOWED_TYPES).toContain('imessage');
  expect(ALLOWED_TYPES).toContain('imessage-daily');
});

// ---------------------------------------------------------------------------
// splitIntoSegments — PR's 5 cases verbatim plus tuning regression.
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

  test('tuned defaults: 30/30 (Eng-v2 T5)', () => {
    expect(DEFAULT_SEGMENT_GAP_MINUTES).toBe(30);
    expect(DEFAULT_SEGMENT_MAX_MESSAGES).toBe(30);
    expect(SEGMENT_TEXT_CHAR_LIMIT).toBe(6500);
  });
});

// ---------------------------------------------------------------------------
// renderSegmentForExtraction.
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
// Fingerprint + checkpoint encoding.
// ---------------------------------------------------------------------------

describe('extractConversationFactsFingerprint (Eng-v2 A3)', () => {
  test('same sourceId yields same fingerprint', () => {
    expect(extractConversationFactsFingerprint({ sourceId: 'default' }))
      .toBe(extractConversationFactsFingerprint({ sourceId: 'default' }));
  });

  test('different sourceId yields different fingerprint', () => {
    expect(extractConversationFactsFingerprint({ sourceId: 'a' }))
      .not.toBe(extractConversationFactsFingerprint({ sourceId: 'b' }));
  });
});

describe('checkpoint entry encoding', () => {
  test('round-trips sourceId | slug | iso', () => {
    const entry = encodeCheckpointEntry('default', 'conversations/imessage/alice-example', '2024-03-16T08:05:00Z');
    const decoded = decodeCheckpointEntry(entry);
    expect(decoded).toEqual({
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      endIso: '2024-03-16T08:05:00Z',
    });
  });

  test('decodes null for malformed entries', () => {
    expect(decodeCheckpointEntry('no-pipes-here')).toBeNull();
    expect(decodeCheckpointEntry('only-one|pipe')).toBeNull();
  });

  test('slug with forward slashes survives encoding (no pipe collision)', () => {
    const entry = encodeCheckpointEntry('src-a', 'conversations/group/2024/march/team-x', '2024-03-16T08:05:00Z');
    const decoded = decodeCheckpointEntry(entry);
    expect(decoded?.slug).toBe('conversations/group/2024/march/team-x');
  });
});

// ---------------------------------------------------------------------------
// runExtractConversationFactsCore — engine-wired contract tests.
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
  let repoDir: string;
  let chatFailure: Error | null = null;
  let chatHook: (() => Promise<void>) | null = null;
  let chatStopReason: ChatResult['stopReason'] = 'end';
  let chatTextOverride: string | null = null;
  let fallbackCalls = 0;
  let fallbackContents: string[] = [];
  let fallbackControlError: Error | null = null;
  let fallbackOnCall: (() => void) | null = null;
  let fallbackSingleMessage = false;
  let fallbackUsage = { input_tokens: 100, output_tokens: 50 };

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoDir = mkdtempSync(join(tmpdir(), 'gbrain-convo-facts-'));

    // Deterministic chat-transport stub. Records calls + returns one
    // fact per turn. Real-LLM extraction quality is the eval suite's job.
    let callIndex = 0;
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      if (String(opts.system).includes('You parse messages out of a chat-log body')) {
        fallbackCalls++;
        const content = String(opts.messages[0]?.content ?? '');
        fallbackContents.push(content);
        fallbackOnCall?.();
        if (fallbackControlError) throw fallbackControlError;
        const messages = content.includes('chunk-line-200')
          ? [
              { speaker: 'Tail Alpha', timestamp: '2026-06-02T10:00:00Z', text: 'tail first' },
              { speaker: 'Tail Beta', timestamp: '2026-06-02T10:05:00Z', text: 'tail second' },
            ]
          : content.includes('chunk-line-000')
            ? [
                { speaker: 'Head Alpha', timestamp: '2026-06-02T09:00:00Z', text: 'head first' },
                { speaker: 'Head Beta', timestamp: '2026-06-02T09:05:00Z', text: 'head second' },
              ]
            : content.includes('chunk-line-080')
              ? []
              : [
                { speaker: 'Alpha Example', timestamp: '2026-06-02T09:00:00Z', text: 'first' },
                { speaker: 'Beta Example', timestamp: '2026-06-02T09:05:00Z', text: 'second' },
              ];
        return {
          text: JSON.stringify(fallbackSingleMessage ? messages.slice(0, 1) : messages),
          blocks: [],
          stopReason: 'end',
          usage: {
            input_tokens: fallbackUsage.input_tokens,
            output_tokens: fallbackUsage.output_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: opts.model!,
          providerId: 'stub',
        };
      }
      if (chatFailure) throw chatFailure;
      const hook = chatHook;
      chatHook = null;
      if (hook) await hook();
      callIndex++;
      return {
        text: chatTextOverride ?? JSON.stringify({
          facts: [{
            fact: `synthetic fact #${callIndex}`,
            kind: 'event',
            entity: 'companies/acme-corp',
            confidence: 1.0,
            notability: 'high',
          }],
        }),
        blocks: [],
        stopReason: chatStopReason,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'stub:stub',
        providerId: 'stub',
      };
    });

    // Deterministic embedding stub.
    __setEmbedTransportForTests(
      (async () => ({
        embeddings: [Array.from({ length: 1536 }, () => 0.1)],
      })) as never,
    );
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
    rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    chatFailure = null;
    chatHook = null;
    chatStopReason = 'end';
    chatTextOverride = null;
    fallbackCalls = 0;
    fallbackContents = [];
    fallbackControlError = null;
    fallbackOnCall = null;
    fallbackSingleMessage = false;
    fallbackUsage = { input_tokens: 100, output_tokens: 50 };
    _resetLlmCacheForTests();
    // Clean state per test. Use executeRaw because PGLite uses different
    // truncation semantics than the canonical reset helper.
    await engine.executeRaw(`DELETE FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`);
    await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
    await engine.executeRaw(`DELETE FROM extract_rollup_7d`);
    await engine.executeRaw(`DELETE FROM conversation_parser_llm_cache`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'conversations/%' OR slug LIKE 'people/alice%'`);
    // Set facts.extraction_enabled=true so kill-switch doesn't refuse.
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    await engine.setConfig('sync.repo_path', repoDir);
    // Seed test pages.
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY,
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('conversations/imessage/native-example', {
      type: 'imessage',
      title: 'Native iMessage export',
      compiled_truth: SAMPLE_BODY,
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('conversations/novel-format-example', {
      type: 'conversation',
      title: 'Novel chat export',
      compiled_truth: [
        'Alpha Example ~~ 09:00 ~~ first',
        'Beta Example ~~ 09:05 ~~ second',
      ].join('\n'),
      timeline: '',
      frontmatter: { date: '2026-06-02' },
    });
    await engine.putPage('conversations/long-novel-format-example', {
      type: 'conversation',
      title: 'Long novel chat export',
      compiled_truth: Array.from(
        { length: 205 },
        (_, i) => `opaque chunk-line-${String(i).padStart(3, '0')}`,
      ).join('\n'),
      timeline: '',
      frontmatter: { date: '2026-06-02' },
    });
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Profile content for Alice Example.',
      timeline: '',
      frontmatter: {},
    });
    const rawDir = join(repoDir, 'meetings/raw-speaker-example.raw');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(
      join(rawDir, 'transcript.txt'),
      [
        'Speaker A: We finally shipped the parser fix.',
        'Speaker B: Good. Now rerun extraction.',
        'Speaker A: I also turned the fallback flag on.',
        'Speaker B: Perfect.',
      ].join('\n'),
      'utf8',
    );
    await engine.putPage('meetings/raw-speaker-example', {
      type: 'meeting',
      title: 'Raw speaker transcript example',
      compiled_truth: [
        '## Executive Summary',
        '- This is a polished meeting note, not the transcript.',
      ].join('\n'),
      timeline: '',
      frontmatter: {
        date: '2026-06-01',
        raw_transcript: 'meetings/raw-speaker-example.raw/transcript.txt',
      },
    });
  });

  test('dry-run reports segmentation without writing facts', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_considered).toBe(1);
    expect(result.pages_processed).toBe(1);
    expect(result.facts_inserted).toBe(0);
    expect(result.segments_processed).toBeGreaterThanOrEqual(1);
  });

  test('dry-run does not write the extract_rollup_7d cache row', async () => {
    // Regression: --dry-run promises "no DB writes" but writeRunReceiptAndRollup
    // upsert-ed extract_rollup_7d unconditionally. A preview must not mutate the DB.
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      dryRun: true,
      sleepMs: 0,
    });
    const rows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM extract_rollup_7d WHERE kind = 'facts.conversation' AND source_id = 'default'`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  test('non-conversation pages are skipped', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'people/alice-example',
      dryRun: true,
      sleepMs: 0,
    });
    // pages_considered counts only pages whose type matches the allowlist.
    expect(result.pages_considered).toBe(0);
  });

  test('native imessage page types are eligible by default', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/native-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_considered).toBe(1);
    expect(result.pages_processed).toBe(1);
  });

  test('LLM fallback is privacy-gated off by default', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/novel-format-example',
      sleepMs: 0,
    });
    expect(result.pages_llm_fallback).toBe(0);
    expect(result.pages_skipped).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test('dry-run never calls the provider even when fallback is enabled', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/novel-format-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_llm_fallback).toBe(0);
    expect(result.pages_skipped).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test('opt-in fallback receives page date and advances the page checkpoint', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const first = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/novel-format-example',
        sleepMs: 0,
      });
      expect(first.pages_llm_fallback).toBe(1);
      expect(first.pages_processed).toBe(1);
      expect(first.segments_processed).toBe(1);
      expect(fallbackCalls).toBe(1);
      expect(fallbackContents[0]).toContain(
        '<conversation-date>2026-06-02</conversation-date>',
      );

      const second = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/novel-format-example',
        sleepMs: 0,
      });
      expect(second.pages_processed).toBe(0);
      expect(second.pages_skipped).toBe(1);
      // The content-hash cache serves the deterministic replay for free.
      expect(fallbackCalls).toBe(1);
    });
  });

  test('opt-in fallback processes and checkpoints transcript lines after 200', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const first = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/long-novel-format-example',
        sleepMs: 0,
      });
      expect(first.pages_llm_fallback).toBe(1);
      expect(first.pages_processed).toBe(1);
      expect(first.segments_processed).toBe(2);
      expect(fallbackCalls).toBe(3);
      expect(fallbackContents[2]).toContain('chunk-line-200');

      const second = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/long-novel-format-example',
        sleepMs: 0,
      });
      expect(second.pages_processed).toBe(0);
      expect(second.pages_skipped).toBe(1);
      expect(fallbackCalls).toBe(3);
    });
  });

  test('opt-in fallback preserves the extraction budget-stop outcome', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    fallbackControlError = new BudgetExhausted('test budget stop', {
      reason: 'cost',
      spent: 1,
      cap: 1,
    });
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/novel-format-example',
        sleepMs: 0,
      });
      expect(result.budget_exhausted).toBe(true);
      expect(result.pages_processed).toBe(0);
      expect(result.pages_llm_fallback).toBe(0);
      expect(fallbackCalls).toBe(1);
    });
  });

  test('final fallback call reports a post-record budget overage', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    fallbackSingleMessage = true;
    fallbackUsage = { input_tokens: 10_000_000, output_tokens: 1_000_000 };
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/novel-format-example',
        sleepMs: 0,
        maxCostUsd: 1,
      });
      expect(result.budget_exhausted).toBe(true);
      expect(result.pages_processed).toBe(0);
      expect(result.pages_skipped).toBe(1);
      expect(result.spent_usd).toBeGreaterThan(1);
      expect(fallbackCalls).toBe(1);
    });
  });

  test('provider AbortError fails open while the caller signal is live', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    fallbackControlError = Object.assign(new Error('provider timeout'), { name: 'AbortError' });
    const controller = new AbortController();
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runExtractConversationFactsCore(
        engine,
        {
          sourceId: 'default',
          slug: 'conversations/novel-format-example',
          sleepMs: 0,
        },
        controller.signal,
      );
      expect(result.pages_skipped).toBe(1);
      expect(result.pages_llm_fallback).toBe(0);
      expect(fallbackCalls).toBe(1);
    });
  });

  test('caller cancellation propagates through the fallback promptly', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    fallbackControlError = Object.assign(new Error('caller cancelled'), { name: 'AbortError' });
    const controller = new AbortController();
    controller.abort();
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      await expect(
        runExtractConversationFactsCore(
          engine,
          {
            sourceId: 'default',
            slug: 'conversations/novel-format-example',
            sleepMs: 0,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  test('caller cancellation propagates from a final pooled batch', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    const cancellation = Object.assign(new Error('caller cancelled in pool'), {
      name: 'AbortError',
    });
    const controller = new AbortController();
    fallbackOnCall = () => controller.abort(cancellation);
    fallbackControlError = cancellation;
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      await expect(
        runExtractConversationFactsCore(
          engine,
          {
            sourceId: 'default',
            types: ['conversation'],
            workers: 1,
            sleepMs: 0,
          },
          controller.signal,
        ),
      ).rejects.toBe(cancellation);
      expect(fallbackCalls).toBe(1);
    });
  });

  test('sinceIso filters already-processed history', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      dryRun: true,
      sleepMs: 0,
      sinceIso: '2099-01-01T00:00:00Z',
    });
    expect(result.pages_processed).toBe(0);
    expect(result.pages_skipped).toBe(1);
  });

  test('meeting page reads raw_transcript sidecar instead of polished summary body', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/raw-speaker-example',
      dryRun: true,
      sleepMs: 0,
    });
    expect(result.pages_processed).toBe(1);
    expect(result.segments_processed).toBeGreaterThanOrEqual(1);
    expect(result.pages_skipped).toBe(0);
  });

  test('writes facts with per-segment source_session AND terminal audit row (E16)', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(result.pages_processed).toBe(1);
    expect(result.facts_inserted).toBeGreaterThan(0);

    // Per-segment facts present.
    const perSegFacts = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [PER_SEGMENT_SOURCE_PREFIX, `${PER_SEGMENT_SOURCE_PREFIX}:conversations/imessage/alice-example`],
    );
    expect(Number(perSegFacts[0]?.count ?? 0)).toBeGreaterThan(0);

    const validTimes = await engine.executeRaw<{ valid_from: Date }>(
      `SELECT valid_from FROM facts
       WHERE source = $1 AND source_session = $2
       ORDER BY valid_from ASC`,
      [PER_SEGMENT_SOURCE_PREFIX, `${PER_SEGMENT_SOURCE_PREFIX}:conversations/imessage/alice-example`],
    );
    expect(validTimes.map((row) => new Date(row.valid_from).toISOString())).toEqual([
      '2024-03-15T09:00:00.000Z',
      '2024-03-16T08:00:00.000Z',
    ]);

    // Terminal audit row present.
    const terminalRows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts
        WHERE source = $1 AND source_session LIKE $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example:page-%`],
    );
    expect(Number(terminalRows[0]?.count ?? 0)).toBe(1);
  });

  test('terminal outcome skips a completed page after checkpoint GC', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`,
    );

    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(1);
    expect(second.pages_processed).toBe(0);
    expect(second.segments_processed).toBe(0);
  });

  test('page edits make an older terminal outcome stale', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY + '\n' + [
        fmt('Alice Example', '2024-03-17', '9:00 AM', 'new tail'),
        fmt('Bob Demo', '2024-03-17', '9:01 AM', 'new response'),
      ].join('\n'),
      timeline: '',
      frontmatter: {},
    });

    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(0);
    expect(second.pages_processed).toBe(1);
  });

  test('records and then skips a definitive scan with no eligible segment', async () => {
    await engine.putPage('conversations/single-message', {
      type: 'slack',
      title: 'Single message',
      compiled_truth: fmt('Alice Example', '2024-03-15', '9:00 AM', 'only one'),
      timeline: '',
      frontmatter: {},
    });
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/single-message',
      types: ['slack'],
      sleepMs: 0,
    });
    expect(first.pages_marked_non_extractable).toBe(1);
    const markers = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts
        WHERE source = $1 AND source_session LIKE $2`,
      [
        NON_EXTRACTABLE_AUDIT_SOURCE,
        `${NON_EXTRACTABLE_AUDIT_SOURCE}:conversations/single-message:page-%`,
      ],
    );
    expect(Number(markers[0]?.count ?? 0)).toBe(1);

    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/single-message',
      types: ['slack'],
      sleepMs: 0,
    });
    expect(second.pages_skipped_non_extractable).toBe(1);
    expect(second.pages_marked_non_extractable).toBe(0);
  });

  test('does not classify an unrecognized parser miss as non-extractable', async () => {
    await engine.putPage('meetings/unrecognized-format', {
      type: 'meeting',
      title: 'Unrecognized meeting format',
      compiled_truth: 'Alice spoke first. Bob answered later.',
      timeline: '',
      frontmatter: {},
    });
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/unrecognized-format',
      types: ['meeting'],
      sleepMs: 0,
    });
    expect(result.pages_marked_non_extractable).toBe(0);
    const markers = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_markdown_slug = $2`,
      [NON_EXTRACTABLE_AUDIT_SOURCE, 'meetings/unrecognized-format'],
    );
    expect(Number(markers[0]?.count ?? 0)).toBe(0);
  });

  test('same-timestamp text edits replay instead of trusting a stale checkpoint', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY.replace(
        'Staff engineer on the platform team.',
        'Principal engineer on the infrastructure team.',
      ),
      timeline: '',
      frontmatter: {},
    });

    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(0);
    expect(second.segments_processed).toBe(2);
  });

  test('an edit during extraction cannot mint a terminal for the old snapshot', async () => {
    chatHook = async () => {
      await engine.putPage('conversations/imessage/alice-example', {
        type: 'conversation',
        title: 'iMessage: Alice Example',
        compiled_truth: SAMPLE_BODY.replace('Nice.', 'Updated while extraction ran.'),
        timeline: '',
        frontmatter: {},
      });
    };
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(first.pages_processed).toBe(1);
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);

    const retry = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(retry.pages_skipped_completed).toBe(0);
    expect(retry.pages_processed).toBe(1);
  });

  test('raw transcript sidecar edits invalidate the durable outcome', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/raw-speaker-example',
      types: ['meeting'],
      sleepMs: 0,
    });
    writeFileSync(
      join(repoDir, 'meetings/raw-speaker-example.raw/transcript.txt'),
      [
        'Speaker A: The sidecar changed after the first extraction.',
        'Speaker B: Then the snapshot hash must force a replay.',
      ].join('\n'),
      'utf8',
    );
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/raw-speaker-example',
      types: ['meeting'],
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(0);
    expect(second.pages_processed).toBe(1);
  });

  test('provider failure leaves no terminal and retries on the next run', async () => {
    chatFailure = new Error('synthetic provider outage');
    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/imessage/alice-example',
        sleepMs: 0,
      }),
    ).rejects.toThrow('provider_error');
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);

    chatFailure = null;
    const retry = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(retry.pages_processed).toBe(1);
  });

  test('non-terminal model stop leaves no terminal outcome', async () => {
    chatStopReason = 'other';
    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/imessage/alice-example',
        sleepMs: 0,
      }),
    ).rejects.toThrow('non_terminal_stop');
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);
  });

  test('schema-invalid model facts leave no terminal outcome', async () => {
    chatTextOverride = JSON.stringify({ facts: [{ fact: 123, kind: 'fact' }] });
    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/imessage/alice-example',
        sleepMs: 0,
      }),
    ).rejects.toThrow('malformed_output');
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);
  });

  test('insert failure leaves no terminal and retries from a clean replay', async () => {
    const engineAny = engine as any;
    const originalInsertFacts = engineAny.insertFacts.bind(engine);
    engineAny.insertFacts = async (facts: Array<{ source?: string }>, opts: unknown) => {
      if (facts.some((fact) => fact.source === PER_SEGMENT_SOURCE_PREFIX)) {
        throw new Error('synthetic insert outage');
      }
      return originalInsertFacts(facts, opts);
    };
    try {
      await expect(
        runExtractConversationFactsCore(engine, {
          sourceId: 'default',
          slug: 'conversations/imessage/alice-example',
          sleepMs: 0,
        }),
      ).rejects.toThrow('synthetic insert outage');
    } finally {
      engineAny.insertFacts = originalInsertFacts;
    }
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);
    const retry = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(retry.pages_processed).toBe(1);
  });

  test('terminal insert failure is reported as unfinished in bulk mode', async () => {
    const engineAny = engine as any;
    const originalInsertFacts = engineAny.insertFacts.bind(engine);
    engineAny.insertFacts = async (facts: Array<{ source?: string }>, opts: unknown) => {
      if (facts.some((fact) => fact.source === TERMINAL_AUDIT_SOURCE)) {
        throw new Error('synthetic terminal insert outage');
      }
      return originalInsertFacts(facts, opts);
    };
    try {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        types: ['conversation'],
        sleepMs: 0,
      });
      expect(result.pages_failed).toBe(1);
      expect(result.pages_processed).toBe(0);
    } finally {
      engineAny.insertFacts = originalInsertFacts;
    }
    const terminals = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(Number(terminals[0]?.count ?? 0)).toBe(0);
  });

  test('cleanup failure cannot mint a non-extractable marker', async () => {
    await engine.putPage('conversations/cleanup-failure', {
      type: 'slack',
      title: 'Cleanup failure',
      compiled_truth: fmt('Alice Example', '2024-03-15', '9:00 AM', 'one message'),
      timeline: '',
      frontmatter: {},
    });
    const engineAny = engine as any;
    const originalExecuteRaw = engineAny.executeRaw.bind(engine);
    engineAny.executeRaw = async (sql: string, params?: unknown[]) => {
      if (sql.includes('WITH del AS')) throw new Error('synthetic cleanup outage');
      return originalExecuteRaw(sql, params);
    };
    try {
      await expect(
        runExtractConversationFactsCore(engine, {
          sourceId: 'default',
          slug: 'conversations/cleanup-failure',
          types: ['slack'],
          sleepMs: 0,
        }),
      ).rejects.toThrow('synthetic cleanup outage');
    } finally {
      engineAny.executeRaw = originalExecuteRaw;
    }
    const markers = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1`,
      [NON_EXTRACTABLE_AUDIT_SOURCE],
    );
    expect(Number(markers[0]?.count ?? 0)).toBe(0);
  });

  test('--limit counts pending work after completed pages are filtered', async () => {
    for (const slug of ['conversations/a-complete', 'conversations/b-pending']) {
      await engine.putPage(slug, {
        type: 'slack',
        title: slug,
        compiled_truth: SAMPLE_BODY,
        timeline: '',
        frontmatter: {},
      });
    }
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/a-complete',
      types: ['slack'],
      sleepMs: 0,
    });
    const bulk = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['slack'],
      limit: 1,
      sleepMs: 0,
    });
    expect(bulk.pages_skipped_completed).toBe(1);
    expect(bulk.pages_processed).toBe(1);
    const pendingTerminal = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts
        WHERE source = $1 AND source_markdown_slug = $2`,
      [TERMINAL_AUDIT_SOURCE, 'conversations/b-pending'],
    );
    expect(Number(pendingTerminal[0]?.count ?? 0)).toBe(1);
  });

  test('bulk mode reports provider failures instead of returning a clean result', async () => {
    chatFailure = new Error('synthetic bulk provider outage');
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['conversation'],
      sleepMs: 0,
    });
    expect(result.pages_failed).toBe(1);
    expect(result.pages_processed).toBe(0);
  });

  test('content identity reopens a page even when updated_at is unchanged', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    const original = await engine.executeRaw<{ updated_at: Date }>(
      `SELECT updated_at FROM pages
        WHERE source_id = 'default' AND slug = 'conversations/imessage/alice-example'`,
    );
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY.replace('Nice.', 'Changed at the same timestamp.'),
      timeline: '',
      frontmatter: {},
    });
    await engine.executeRaw(
      `UPDATE pages SET updated_at = $1
        WHERE source_id = 'default' AND slug = 'conversations/imessage/alice-example'`,
      [original[0]!.updated_at],
    );
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(result.pages_skipped_completed).toBe(0);
    expect(result.pages_processed).toBe(1);
  });

  test('effective_date survives locked refetch and invalidates completion', async () => {
    await engine.putPage('meetings/effective-date', {
      type: 'meeting',
      title: 'Effective date meeting',
      compiled_truth: [
        'Speaker A: We approved the proposal.',
        'Speaker B: I will publish it tomorrow.',
      ].join('\n'),
      timeline: '',
      frontmatter: {},
    });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-01-01T00:00:00Z'
        WHERE source_id = 'default' AND slug = 'meetings/effective-date'`,
    );
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/effective-date',
      types: ['meeting'],
      sleepMs: 0,
    });
    expect(first.pages_processed).toBe(1);
    const firstTerminal = await engine.executeRaw<{ source_session: string }>(
      `SELECT source_session FROM facts
        WHERE source = $1 AND source_markdown_slug = 'meetings/effective-date'`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(firstTerminal[0]!.source_session.endsWith('-2026-01-01')).toBe(true);

    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-01-02T00:00:00Z'
        WHERE source_id = 'default' AND slug = 'meetings/effective-date'`,
    );
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'meetings/effective-date',
      types: ['meeting'],
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(0);
    expect(second.pages_processed).toBe(1);
  });

  test('legacy terminal rows do not suppress strict v2 replay', async () => {
    await engine.executeRaw(
      `INSERT INTO facts (
         fact, kind, source, source_session, confidence, notability,
         row_num, source_markdown_slug, source_id
       ) VALUES (
         'EXTRACTION_COMPLETE', 'fact', $1, $2, 1.0, 'low', 0, $3, 'default'
       )`,
      [
        'cli:extract-conversation-facts:terminal',
        'cli:extract-conversation-facts:terminal:conversations/imessage/alice-example',
        'conversations/imessage/alice-example',
      ],
    );
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(result.pages_skipped_completed).toBe(0);
    expect(result.pages_processed).toBe(1);
  });

  test('row_num accumulator: segment 2 facts start after segment 1 (Codex C1)', async () => {
    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    const rows = await engine.executeRaw<{ row_num: number }>(
      `SELECT row_num FROM facts
        WHERE source = $1 AND source_markdown_slug = $2
        ORDER BY row_num ASC`,
      [PER_SEGMENT_SOURCE_PREFIX, 'conversations/imessage/alice-example'],
    );
    // Each row_num must be unique (no per-segment collision on row 0).
    const nums = rows.map((r) => Number(r.row_num));
    expect(new Set(nums).size).toBe(nums.length);
    // Strictly monotonic + zero-based.
    for (let i = 0; i < nums.length; i++) {
      expect(nums[i]).toBe(i);
    }
  });

  test('--force clears resume entry, allowing re-run', async () => {
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(first.pages_processed).toBe(1);
    // Re-run without force: no new segments (sinceIso > newest segment endIso).
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.pages_skipped_completed).toBe(1);
    // Re-run with force: re-processes.
    const third = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
      force: true,
    });
    expect(third.pages_processed).toBe(1);
    expect(third.segments_processed).toBeGreaterThanOrEqual(1);
  });

  test('honors facts.extraction_enabled kill-switch (F2)', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/imessage/alice-example',
        sleepMs: 0,
      }),
    ).rejects.toThrow(/extraction_enabled=false/);
  });

  test('--override-disabled bypasses kill-switch', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
      overrideDisabled: true,
    });
    expect(result.pages_processed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Body cap (Eng A2 / E17) — pin the cap constant; integration via reads
// in seeded huge pages would require >25MB fixture, not viable in unit suite.
// ---------------------------------------------------------------------------

describe('body cap constant (Eng A2)', () => {
  test('MAX_PAGE_BODY_BYTES is 25MB', () => {
    expect(MAX_PAGE_BODY_BYTES).toBe(25 * 1024 * 1024);
  });
});
