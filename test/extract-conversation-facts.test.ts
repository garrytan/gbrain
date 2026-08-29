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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  parseConversationMessages,
  splitIntoSegments,
  renderSegmentForExtraction,
  runExtractConversationFactsCore,
  runExtractConversationFacts,
  extractConversationFactsFingerprint,
  encodeCheckpointEntry,
  decodeCheckpointEntry,
  DEFAULT_SEGMENT_GAP_MINUTES,
  DEFAULT_SEGMENT_MAX_MESSAGES,
  DEFAULT_SEGMENT_MAX_CHARS,
  EMAIL_SEGMENT_GAP_MINUTES,
  normalizeEmailMessages,
  parseEmailSender,
  renderMessageLine,
  splitOversizedMessage,
  slugBasename,
  EntitySlugCanonicalizer,
  isAutomatedEmailSender,
  isSingleInboundEmail,
  isOutOfScopeEmail,
  SEGMENT_TEXT_CHAR_LIMIT,
  MAX_PAGE_BODY_BYTES,
  TERMINAL_AUDIT_SOURCE,
  NON_EXTRACTABLE_AUDIT_SOURCE,
  PER_SEGMENT_SOURCE_PREFIX,
  ALLOWED_TYPES,
  pageTypesForAllowed,
  ALLOWED_TYPE_ALIASES,
} from '../src/commands/extract-conversation-facts.ts';
import { _resetLlmCacheForTests } from '../src/core/conversation-parser/llm-base.ts';
import {
  validateModelFlag,
  compileEmailSenderDenylist,
  type EmailSenderRule,
  EMAIL_AUTOMATED_SENDERS,
  MAX_CANDIDATE_BATCH,
  PAGE_LIST_BATCH,
  MIN_SEGMENT_MESSAGES,
} from '../src/commands/extract-conversation-facts.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';

// ---------------------------------------------------------------------------
// pageTypesForAllowed — logical→concrete page-type expansion.
// ---------------------------------------------------------------------------

describe('pageTypesForAllowed', () => {
  test('expands slack to canonical + granular collector types', () => {
    expect(pageTypesForAllowed(['slack'])).toEqual(['slack', 'slack-dm-day', 'slack-thread']);
  });

  test('expands email to canonical + granular collector types', () => {
    expect(pageTypesForAllowed(['email'])).toEqual(['email', 'email-digest']);
  });

  test('canonical-only types pass through unchanged', () => {
    expect(pageTypesForAllowed(['meeting'])).toEqual(['meeting']);
    expect(pageTypesForAllowed(['conversation'])).toEqual(['conversation']);
  });

  test('canonical name is always first so consolidated brains keep working', () => {
    expect(pageTypesForAllowed(['slack'])[0]).toBe('slack');
    expect(pageTypesForAllowed(['email'])[0]).toBe('email');
  });

  test('multiple logical types flatten and de-duplicate', () => {
    const got = pageTypesForAllowed(['slack', 'email', 'meeting']);
    expect(got).toEqual(['slack', 'slack-dm-day', 'slack-thread', 'email', 'email-digest', 'meeting']);
    // no duplicates
    expect(new Set(got).size).toBe(got.length);
  });

  test('every ALLOWED_TYPE_ALIASES entry lists its canonical name first', () => {
    for (const [canonical, concretes] of Object.entries(ALLOWED_TYPE_ALIASES)) {
      expect(concretes[0]).toBe(canonical);
    }
  });

  test('empty input yields empty output', () => {
    expect(pageTypesForAllowed([])).toEqual([]);
  });
});

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

test('parses a markdown-heading turn body (## User / ## Assistant)', () => {
  const body = [
    '## User',
    'What is the capital of France?',
    '## Assistant',
    'The capital of France is Paris.',
    'It is also its largest city.',
  ].join('\n');
  const msgs = parseConversationMessages(body, { fallbackDate: '2026-08-11' });
  expect(msgs).toHaveLength(2);
  expect(msgs[0].speaker).toBe('User');
  expect(msgs[0].text).toBe('What is the capital of France?');
  expect(msgs[1].speaker).toBe('Assistant');
  expect(msgs[1].text).toBe(
    'The capital of France is Paris.\nIt is also its largest city.',
  );
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
  let mainChatCalls = 0;
  let chatStopReason: ChatResult['stopReason'] = 'end';
  let chatTextOverride: string | null = null;
  let embeddedTexts: string[] = [];
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
      mainChatCalls++;
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
      (async ({ values }: { values: string[] }) => {
        embeddedTexts.push(...values);
        return { embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)) };
      }) as never,
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
    mainChatCalls = 0;
    chatStopReason = 'end';
    chatTextOverride = null;
    embeddedTexts = [];
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

  test('historical backfill embeds and retains high, medium, low, and absent-tier facts', async () => {
    // Regression target: passing high-only admission into the historical
    // extractor call would suppress low (and absent-tier) facts before embed.
    chatTextOverride = JSON.stringify({
      facts: [
        { fact: 'historical-high', kind: 'event', notability: 'high' },
        { fact: 'historical-medium', kind: 'fact', notability: 'medium' },
        { fact: 'historical-low', kind: 'fact', notability: 'low' },
        { fact: 'historical-absent', kind: 'fact' },
      ],
    });
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'test' },
    });
    await engine.putPage('conversations/historical-tier-coverage', {
      type: 'conversation',
      title: 'Historical tier coverage',
      compiled_truth: [
        fmt('Alice Example', '2024-03-15', '9:00 AM', 'first message'),
        fmt('Bob Demo', '2024-03-15', '9:05 AM', 'second message'),
      ].join('\n'),
      timeline: '',
      frontmatter: {},
    });

    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/historical-tier-coverage',
      sleepMs: 0,
    });
    const rows = await engine.executeRaw<{ fact: string; notability: string; has_embedding: boolean }>(
      `SELECT fact, notability, embedding IS NOT NULL AS has_embedding
       FROM facts WHERE source = $1 ORDER BY row_num`,
      [PER_SEGMENT_SOURCE_PREFIX],
    );

    expect(result.facts_extracted).toBe(4);
    expect(result.facts_inserted).toBe(4);
    expect(embeddedTexts).toEqual([
      'historical-high',
      'historical-medium',
      'historical-low',
      'historical-absent',
    ]);
    expect(rows).toEqual([
      { fact: 'historical-high', notability: 'high', has_embedding: true },
      { fact: 'historical-medium', notability: 'medium', has_embedding: true },
      { fact: 'historical-low', notability: 'low', has_embedding: true },
      { fact: 'historical-absent', notability: 'medium', has_embedding: true },
    ]);
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

  test('email pages never call the LLM fallback, even when it is enabled', async () => {
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'true');
    await engine.putPage('email-thread-noanchor', {
      type: 'email' as never,
      title: 'Email thread: No headings',
      frontmatter: { subject: 'No headings', message_count: 2 },
      compiled_truth: ['# Email thread: No headings', '', 'Plain text with no message headings.', 'Second line.'].join('\n'),
    });
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'email-thread-noanchor',
        sleepMs: 0,
      });
      expect(result.pages_llm_fallback).toBe(0);
      expect(result.pages_processed).toBe(0);
      expect(fallbackCalls).toBe(0);
    });
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
      // The durable completion outcome skips the replay before any parse.
      expect(second.pages_skipped_completed).toBe(1);
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
      // The durable completion outcome skips the replay before any parse.
      expect(second.pages_skipped_completed).toBe(1);
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

  test('extraction BudgetExhausted halts the run after one attempt (#3669)', async () => {
    // Regression: extractFactsFromTurnWithOutcome folds a BudgetExhausted
    // thrown by the provider into `{ ok: false, error }`; the per-segment
    // failure branch used to wrap it in a plain Error, stripping the
    // BUDGET_EXHAUSTED tag. The worker pool's D13 must-abort check never
    // fired, so every remaining page burned a doomed reserve-denied attempt
    // instead of the run halting with budget_exhausted = true.
    chatFailure = new BudgetExhausted('reserve denied', {
      reason: 'cost',
      spent: 5,
      cap: 5,
    });
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        sleepMs: 0,
      });
      // Halted-with-receipt, not a per-page failure loop: exactly ONE
      // extraction attempt (not one per eligible page), and the partial
      // result reports the budget stop.
      expect(result.budget_exhausted).toBe(true);
      expect(mainChatCalls).toBe(1);
      expect(result.pages_failed).toBe(0);
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

  test('canonicalizes a raw LLM entity display name before writing facts.entity_slug', async () => {
    chatTextOverride = JSON.stringify({
      facts: [{
        fact: 'Alice Example signed the offer letter.',
        kind: 'event',
        entity: 'Alice Example',
        confidence: 1.0,
        notability: 'high',
      }],
    });

    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });

    const rows = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts
        WHERE source = $1 AND source_markdown_slug = $2`,
      [PER_SEGMENT_SOURCE_PREFIX, 'conversations/imessage/alice-example'],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.entity_slug === 'people/alice-example')).toBe(true);
  });

  test('preserves an already-canonical LLM entity slug', async () => {
    chatTextOverride = JSON.stringify({
      facts: [{
        fact: 'Alice Example started the new role.',
        kind: 'event',
        entity: 'people/alice-example',
        confidence: 1.0,
        notability: 'high',
      }],
    });

    await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });

    const rows = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts
        WHERE source = $1 AND source_markdown_slug = $2`,
      [PER_SEGMENT_SOURCE_PREFIX, 'conversations/imessage/alice-example'],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.entity_slug === 'people/alice-example')).toBe(true);
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

// ---------------------------------------------------------------------------
// #4136 — folded speaker headings: decline gate, counter, non-terminal skip.
// Self-contained engine + transport (the main describe resets both in its
// afterAll, so this block installs its own).
// ---------------------------------------------------------------------------

describe('#4136 folded speaker headings — decline gate is non-terminal', () => {
  let engine: PGLiteEngine;

  const FOLDED_BODY = [
    '## User', '', 'What is the deploy command?', '',
    '## Claude', '', 'Run the deploy script from the repo root.', '',
    '## User', '', 'Thanks.',
  ].join('\n');

  const NOTES_BODY = [
    '## User', '', 'Journal entry one.', '',
    '## Notes', '', 'unfenced doc heading inside my own page', '',
    '## User', '', 'Journal entry two.',
  ].join('\n');

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('facts.extraction_enabled', 'true');
    await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: '{"facts":[]}',
      blocks: [{ type: 'text', text: '{"facts":[]}' }],
      stopReason: 'end',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001',
      providerId: 'anthropic',
    }));
    await engine.putPage('conversations/folded-claude-example', {
      type: 'conversation',
      title: 'Folded transcript',
      compiled_truth: FOLDED_BODY,
      timeline: '',
      frontmatter: { date: '2026-06-02' },
    });
    await engine.putPage('conversations/notes-journal-example', {
      type: 'conversation',
      title: 'Single-speaker journal with a Notes heading',
      compiled_truth: NOTES_BODY,
      timeline: '',
      frontmatter: { date: '2026-06-02' },
    });
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  test('a folded speaker-shaped heading with degenerate speakers DECLINES: counter bumped, zero facts, NO durable audit row', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/folded-claude-example',
      sleepMs: 0,
    });
    expect(result.pages_skipped_unrecognized_speaker).toBe(1);
    expect(result.facts_inserted).toBe(0);
    // The single highest-risk line (#4136): a decline must NOT write the
    // EXTRACTION_NOT_APPLICABLE row — that row is versionToken-keyed and
    // would skip the page forever, even after the parser learns the label.
    expect(result.pages_marked_non_extractable).toBe(0);
    const markers = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session LIKE $2`,
      [NON_EXTRACTABLE_AUDIT_SOURCE, `${NON_EXTRACTABLE_AUDIT_SOURCE}:conversations/folded-claude-example:%`],
    );
    expect(Number(markers[0]?.count ?? 0)).toBe(0);
  });

  test('RETRYABLE: a second run re-considers the declined page instead of short-circuiting at the outcome gate', async () => {
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/folded-claude-example',
      sleepMs: 0,
    });
    expect(second.pages_considered).toBe(1);
    expect(second.pages_skipped_completed).toBe(0);
    expect(second.pages_skipped_non_extractable).toBe(0);
    expect(second.pages_skipped_unrecognized_speaker).toBe(1); // declined again — visibly, not silently
  });

  test('WARN-ONLY branch: a speaker-shaped fold BETWEEN alternating speakers proceeds with the stderr warn (residual risk, visible)', async () => {
    await engine.putPage('conversations/folded-multispeaker-example', {
      type: 'conversation',
      title: 'Folded heading between alternating speakers',
      compiled_truth: [
        '## User', '', 'Question one?', '',
        '## Assistant', '', 'Answer one.', '',
        '## Claude', '', 'A folded reply.', '',
        '## User', '', 'Question two?', '',
        '## Assistant', '', 'Answer two.',
      ].join('\n'),
      timeline: '',
      frontmatter: { date: '2026-06-02' },
    });
    const warns: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      warns.push(String(c));
      return origWrite(c);
    };
    try {
      const result = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/folded-multispeaker-example',
        sleepMs: 0,
      });
      // Speakers alternate (User + Assistant = 2 distinct) → NOT declined,
      // extraction proceeds, and the warn names the folded label.
      expect(result.pages_skipped_unrecognized_speaker).toBe(0);
      expect(result.pages_processed).toBe(1);
      expect(warns.some((w) => w.includes('folded unrecognized heading(s) [Claude]') && w.includes('proceeding'))).toBe(true);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = origWrite;
    }
  });

  test('NO REGRESSION: a single-speaker page with an unfenced doc heading (## Notes) is warn-only and still extracts', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/notes-journal-example',
      sleepMs: 0,
    });
    // 'Notes' is stoplisted → not speaker-shaped → no decline, extraction
    // proceeds through the normal pipeline (eng F3: the bare
    // "non-empty + degenerate speakers" rule would have false-declined this).
    expect(result.pages_skipped_unrecognized_speaker).toBe(0);
    expect(result.pages_processed).toBe(1);
    expect(result.segments_processed).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Email thread pages (email-thread-heading path).
// ---------------------------------------------------------------------------

describe('email thread normalization', () => {
  const email = (
    speaker: string,
    timestamp: string,
    text: string,
    direction?: 'sent' | 'received',
  ) => ({ speaker, timestamp, text, ...(direction ? { direction } : {}) });

  test('parseEmailSender decodes entities and splits name/address', () => {
    expect(parseEmailSender('Sam Example &lt;sam@example.com&gt;')).toEqual({
      name: 'Sam Example',
      address: 'sam@example.com',
    });
    expect(
      parseEmailSender('"Frank Sample (Google Docs)" &lt;comments-noreply@docs.google.com&gt;'),
    ).toEqual({ name: 'Frank Sample (Google Docs)', address: 'comments-noreply@docs.google.com' });
    expect(parseEmailSender('ops@example.com')).toEqual({
      name: 'ops@example.com',
      address: 'ops@example.com',
    });
    expect(parseEmailSender('unknown')).toEqual({ name: 'unknown', address: null });
  });

  test('isAutomatedEmailSender matches relays, no-reply and form senders only', () => {
    const auto = [
      '"A (Google Docs)" &lt;comments-noreply@docs.google.com&gt;',
      'Linear &lt;notifications@linear.app&gt;',
      'Drive &lt;drive-shares-dm-noreply@google.com&gt;',
      'Webflow &lt;no-reply@webflow.com&gt;',
      'Zapier &lt;digest@mail.zapier.com&gt;',
      'Google Calendar &lt;calendar-notification@google.com&gt;',
    ];
    for (const s of auto) expect(isAutomatedEmailSender(parseEmailSender(s))).toBe(true);
    const human = [
      'Eve Demo &lt;eve@example.com&gt;',
      'Support &lt;support@example.com&gt;',
      'Brianna (Superhuman Team) &lt;brianna@superhuman.com&gt;',
      'unknown',
    ];
    for (const s of human) expect(isAutomatedEmailSender(parseEmailSender(s))).toBe(false);
  });

  test('normalizeEmailMessages renames speakers, drops automated senders, strips Gmail links', () => {
    const r = normalizeEmailMessages([
      email(
        'Sam Example &lt;sam@example.com&gt;',
        '2026-06-18T07:46:32.000Z',
        '[Open in Gmail](https://mail.google.com/mail/u/?authuser=x#inbox/1)\n\nHey Ed,\n\n\n\nRenewal is due.',
        'sent',
      ),
      email(
        '"Frank Sample (Google Docs)" &lt;comments-noreply@docs.google.com&gt;',
        '2026-06-19T07:46:32.000Z',
        'Frank commented on the doc.',
        'received',
      ),
      email('Eve Demo &lt;eve@example.com&gt;', '2026-08-19T07:03:59.000Z', 'Thanks.', 'received'),
    ]);
    expect(r.dropped).toBe(1);
    expect(r.messages.map((m) => m.speaker)).toEqual(['Sam Example', 'Eve Demo']);
    expect(r.messages[0].text).toBe('Hey Ed,\n\nRenewal is due.');
    expect(r.messages[0].direction).toBe('sent');
    expect(r.distinctSenders).toBe(2);
  });

  test('normalizeEmailMessages counts distinct senders by address, before the address is dropped', () => {
    const r = normalizeEmailMessages([
      email('Sam Example &lt;sam@example.com&gt;', '2026-06-18T07:46:32.000Z', 'Following up.', 'sent'),
      email('Bot &lt;notifications@example.com&gt;', '2026-06-18T08:00:00.000Z', 'auto', 'received'),
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].direction).toBe('sent');
    expect(r.distinctSenders).toBe(1);
    // One newsletter, two display names: still one sender.
    const news = normalizeEmailMessages([
      email('Indie Weekly &lt;hi@indie.example&gt;', '2026-06-01T09:00:00.000Z', 'Issue 41.', 'received'),
      email('Indie Weekly Team &lt;hi@indie.example&gt;', '2026-06-08T09:00:00.000Z', 'Issue 42.', 'received'),
    ]);
    expect(news.distinctSenders).toBe(1);
    // Two people who share a display name are two senders.
    const twins = normalizeEmailMessages([
      email('Alex &lt;alex@a.example&gt;', '2026-06-01T09:00:00.000Z', 'Hi.', 'received'),
      email('Alex &lt;alex@b.example&gt;', '2026-06-01T10:00:00.000Z', 'Hello.', 'received'),
    ]);
    expect(twins.distinctSenders).toBe(2);
  });

  test('isOutOfScopeEmail also drops digest pages (subtype other than thread)', () => {
    const digest = {
      type: 'email' as const,
      frontmatter: { subtype: 'digest', message_count: 28 } as Record<string, unknown>,
      compiled_truth: '# Email digest — 2026-08-09\n\n## Signatures pending (0)\n\n## Triage (3)',
    };
    expect(isOutOfScopeEmail(digest)).toBe(true);
    expect(isOutOfScopeEmail({ ...digest, frontmatter: { subtype: 'thread', message_count: 3 } })).toBe(false);
    // No subtype at all: fall back to the single-inbound rule only.
    expect(isOutOfScopeEmail({ ...digest, frontmatter: { message_count: 3 } })).toBe(false);
    expect(isOutOfScopeEmail({ ...digest, frontmatter: { message_count: 1 } })).toBe(true);
  });

  test('isSingleInboundEmail keys on frontmatter.message_count and the (sent) marker', () => {
    const base = {
      type: 'email' as const,
      frontmatter: { message_count: 1 } as Record<string, unknown>,
      compiled_truth:
        '# Email thread: x\n## A &lt;a@b.c&gt; — Thu, 18 Jun 2026 07:46:32 +0000 (received)\n\nhi',
    };
    expect(isSingleInboundEmail(base)).toBe(true);
    expect(
      isSingleInboundEmail({ ...base, compiled_truth: base.compiled_truth.replace('(received)', '(sent)') }),
    ).toBe(false);
    expect(isSingleInboundEmail({ ...base, frontmatter: { message_count: '3' } })).toBe(false);
    expect(isSingleInboundEmail({ ...base, frontmatter: {} })).toBe(false);
    expect(isSingleInboundEmail({ ...base, type: 'slack' as const })).toBe(false);
  });
});

describe('splitIntoSegments — email options', () => {
  const msg = (i: number, timestamp: string, text = `m${i}`) => ({
    speaker: i % 2 ? 'Bob' : 'Alice',
    timestamp,
    text,
  });

  test('email gap groups replies into week-scale episodes and keeps lone episodes', () => {
    const msgs = [
      msg(0, '2026-06-18T07:46:32.000Z'),
      msg(1, '2026-06-20T09:00:00.000Z'),
      msg(2, '2026-08-19T07:03:59.000Z'),
      msg(3, '2026-08-24T15:56:24.000Z'),
    ];
    // Default 30-minute gap: four lone messages, all below the minimum.
    expect(splitIntoSegments(msgs)).toHaveLength(0);
    // Email gap alone: two episodes, the lone August pair survives on its own.
    const segs = splitIntoSegments(msgs, { gapMinutes: EMAIL_SEGMENT_GAP_MINUTES, minMessages: 1 });
    expect(segs).toHaveLength(2);
    expect(segs[0].messages).toHaveLength(2);
    expect(segs[0].startIso).toBe('2026-06-18T07:46:32.000Z');
    expect(segs[1].messages).toHaveLength(2);
    // The August episode is dated when it happened, not at the thread start.
    expect(segs[1].startIso).toBe('2026-08-19T07:03:59.000Z');
    // A reply more than a week later forms its own one-message episode.
    const late = [...msgs, msg(4, '2026-10-01T10:00:00.000Z')];
    const segs2 = splitIntoSegments(late, { gapMinutes: EMAIL_SEGMENT_GAP_MINUTES, minMessages: 1 });
    expect(segs2).toHaveLength(3);
    expect(segs2[2].messages).toHaveLength(1);
  });

  test('maxChars splits a long thread instead of leaving it to truncation', () => {
    const long = 'x'.repeat(2000);
    const msgs = Array.from({ length: 6 }, (_, i) => msg(i, `2026-06-18T0${i}:00:00.000Z`, long));
    const segs = splitIntoSegments(msgs, {
      gapMinutes: EMAIL_SEGMENT_GAP_MINUTES,
      maxChars: DEFAULT_SEGMENT_MAX_CHARS,
    });
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(renderSegmentForExtraction('t', s).endsWith('…(truncated)')).toBe(false);
    }
    expect(segs.reduce((n, s) => n + s.messages.length, 0)).toBe(6);
  });

  test('a lone message after a char cut is kept (it continues the conversation)', () => {
    const long = 'x'.repeat(3000);
    const msgs = Array.from({ length: 3 }, (_, i) => msg(i, `2026-06-18T0${i}:00:00.000Z`, long));
    const segs = splitIntoSegments(msgs, {
      gapMinutes: EMAIL_SEGMENT_GAP_MINUTES,
      maxChars: DEFAULT_SEGMENT_MAX_CHARS,
    });
    expect(segs.reduce((n, s) => n + s.messages.length, 0)).toBe(3);
  });

  test('minMessages 1 keeps a lone message', () => {
    const one = [msg(0, '2026-06-18T07:46:32.000Z')];
    expect(splitIntoSegments(one)).toHaveLength(0);
    expect(splitIntoSegments(one, { minMessages: 1 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-28 eng review: render DRY, oversize chunking, unescape, canonicalizer.
// ---------------------------------------------------------------------------

describe('renderMessageLine is the single source of the segment body format', () => {
  test('renderSegmentForExtraction body lines are renderMessageLine(m)', () => {
    const msgs = [
      { speaker: 'Alice', timestamp: '2026-06-18T07:46:32.000Z', text: 'hello' },
      { speaker: 'Bob', timestamp: '2026-06-18T07:47:00.000Z', text: 'hi\nsecond line' },
    ];
    const seg = { messages: msgs, startIso: msgs[0].timestamp, endIso: msgs[1].timestamp, participants: ['Alice', 'Bob'] };
    const rendered = renderSegmentForExtraction('Page title', seg);
    for (const m of msgs) expect(rendered).toContain(renderMessageLine(m));
  });
});

describe('splitOversizedMessage', () => {
  const base = { speaker: 'Alice Example', timestamp: '2026-06-18T07:46:32.000Z' };
  test('a short message is returned as-is', () => {
    const m = { ...base, text: 'short' };
    expect(splitOversizedMessage(m, DEFAULT_SEGMENT_MAX_CHARS)).toEqual([m]);
  });
  test('a 12 KB message becomes several same-speaker parts, nothing lost, each under budget', () => {
    const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20).trim();
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${para}`).join('\n\n');
    expect(text.length).toBeGreaterThan(12_000);
    const parts = splitOversizedMessage({ ...base, text, direction: 'sent' as const }, DEFAULT_SEGMENT_MAX_CHARS);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) {
      expect(p.speaker).toBe(base.speaker);
      expect(p.timestamp).toBe(base.timestamp);
      expect(p.direction).toBe('sent');
      expect(renderMessageLine(p).length + 1).toBeLessThanOrEqual(DEFAULT_SEGMENT_MAX_CHARS);
    }
    const joined = parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ');
    expect(joined).toBe(text.replace(/\s+/g, ' '));
  });
  test('splitIntoSegments chunks an oversize message instead of leaving it to truncation', () => {
    const text = 'x'.repeat(4000) + '\n\n' + 'y'.repeat(4000) + '\n\n' + 'z'.repeat(4000);
    const msgs = [
      { speaker: 'Alice', timestamp: '2026-06-18T07:46:32.000Z', text },
      { speaker: 'Bob', timestamp: '2026-06-18T08:00:00.000Z', text: 'ack' },
    ];
    const segs = splitIntoSegments(msgs, { gapMinutes: EMAIL_SEGMENT_GAP_MINUTES, maxChars: DEFAULT_SEGMENT_MAX_CHARS, minMessages: 1 });
    const total = segs.reduce((n, s) => n + s.messages.length, 0);
    expect(total).toBeGreaterThanOrEqual(4);
    for (const s of segs) expect(renderSegmentForExtraction('t', s).endsWith('…(truncated)')).toBe(false);
    expect(segs.flatMap((s) => s.messages).map((m) => m.text).join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, '') + 'ack');
  });
});

describe('parseEmailSender undoes the collector escapes', () => {
  test('backslash-escaped brackets and HTML entities', () => {
    expect(parseEmailSender('\\[EXT\\] Dana Reyes &lt;dana@example.com&gt;')).toEqual({
      name: '[EXT] Dana Reyes',
      address: 'dana@example.com',
    });
  });
});

describe('EntitySlugCanonicalizer', () => {
  test('folds raw and display-name forms onto the one known prefixed sibling', () => {
    const c = new EntitySlugCanonicalizer();
    c.register('people/eve-demo');
    c.register('companies/acme');
    expect(c.canonicalize('eve-demo')).toBe('people/eve-demo');
    expect(c.canonicalize('Eve Demo')).toBe('people/eve-demo');
    expect(c.canonicalize('acme')).toBe('companies/acme');
    expect(c.canonicalize('someone-unknown')).toBe('someone-unknown');
    expect(c.canonicalize(null)).toBeNull();
    expect(c.canonicalize(undefined)).toBeUndefined();
  });
  test('a prefixed slug seen at save time registers its basename for later raw forms', () => {
    const c = new EntitySlugCanonicalizer();
    expect(c.canonicalize('companies/ten-dev')).toBe('companies/ten-dev');
    expect(c.canonicalize('ten-dev')).toBe('companies/ten-dev');
    expect(c.canonicalize('Ten Dev')).toBe('companies/ten-dev');
  });
  test('an ambiguous basename (both prefixes) stays raw', () => {
    const c = new EntitySlugCanonicalizer();
    c.register('people/mercury');
    c.register('companies/mercury');
    expect(c.canonicalize('mercury')).toBe('mercury');
  });
  test('slugBasename matches the resolver fallback form', () => {
    // Same function the resolver mints raw slugs with (src/core/entities/resolve.ts slugify):
    // apostrophes become a separator, accents fold, runs collapse.
    expect(slugBasename("Sam's Company, Ltd.")).toBe('sam-s-company-ltd');
    expect(slugBasename('  Eve   Demo ')).toBe('eve-demo');
    expect(slugBasename('José Núñez')).toBe('jose-nunez');
    expect(slugBasename('Sam\u2019s Co')).toBe('sam-s-co');
  });
});

describe('CLI + job wiring pins (2026-08-28 review)', () => {
  const cmdSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'extract-conversation-facts.ts'), 'utf8');
  const jobsSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'), 'utf8');
  const modelFlagSrc = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'extract-conversation-facts', 'model-flag.ts'), 'utf8');
  test('--model is parsed, validated up front, and handed to the core', () => {
    expect(cmdSrc).toContain("if (a === '--model') { out.model = args[++i]; continue; }");
    // One gate (model-flag.ts) for the CLI (before the job is enqueued), the job handler and the core.
    expect(modelFlagSrc).toContain('export function validateModelFlag(model: string): string | null');
    expect(modelFlagSrc).toContain("!isAvailable('chat', model)");
    expect(modelFlagSrc).toContain('!canonicalLookup(model)');
    expect(cmdSrc).toContain('validateModelFlag(pre.model)');
    expect(cmdSrc.indexOf('validateModelFlag(pre.model)')).toBeLessThan(cmdSrc.indexOf('const backgrounded = await maybeBackground('));
    expect(cmdSrc).toContain('validateModelFlag(opts.model)');
    expect(cmdSrc).toMatch(/dryRun: parsed\.dryRun,\n\s+model: parsed\.model,/);
  });
  test('the background job handler forwards job.data.model (round trip with buildJobParams)', () => {
    const start = jobsSrc.indexOf("registerBuiltinJob(worker, engine, 'extract-conversation-facts'");
    expect(start).toBeGreaterThan(0);
    const end = jobsSrc.indexOf('return result;', start);
    const handler = jobsSrc.slice(start, end);
    expect(handler).toContain("const model = typeof job.data.model === 'string' ? job.data.model : undefined;");
    expect(handler).toContain('validateModelFlag(model)');
    expect(handler).toMatch(/\n\s+model,\n/);
    expect(handler).toContain("workers: typeof job.data.workers === 'number' ? job.data.workers : undefined");
  });
});

// ---------------------------------------------------------------------------
// Email thread pages end to end through the core (PGLite, injected extractor).
// ---------------------------------------------------------------------------

const EMAIL_HDR = (name: string, addr: string, date: string, dir: 'sent' | 'received') =>
  `## ${name} &lt;${addr}&gt; — ${date} (${dir})`;

describe('email pages through runExtractConversationFactsCore', () => {
  let engine: PGLiteEngine;
  const turns: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(
      (async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
      })) as never,
    );
    await engine.putPage('people/eve-demo', {
      type: 'person',
      title: 'Eve Demo',
      compiled_truth: 'Profile.',
      frontmatter: {},
    });
    // (1) A real thread: owner sent, one automated relay, one human reply.
    await engine.putPage('email-thread-aaa1', {
      type: 'email' as never,
      title: 'Email thread: Acme - Renewal',
      compiled_truth: [
        '# Email thread: Acme - Renewal',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Thu, 18 Jun 2026 07:46:32 +0000', 'sent'),
        '',
        '[Open in Gmail](https://mail.google.com/mail/u/?authuser=juan%40example.com#inbox/aaa1)',
        '',
        'Hey Ed, your renewal is due on 28 August 2026.',
        '',
        EMAIL_HDR('"Frank Sample (Google Docs)"', 'comments-noreply@docs.google.com', 'Thu, 18 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Frank commented on the doc.',
        '',
        EMAIL_HDR('Eve Demo', 'eve@example.com', 'Fri, 19 Jun 2026 08:03:59 +0100', 'received'),
        '',
        "I'd like to descope the agreement.",
      ].join('\n'),
      frontmatter: { subject: 'Acme - Renewal', message_count: 3 },
    });
    // (2) A single message the owner sent.
    await engine.putPage('email-thread-bbb2', {
      type: 'email' as never,
      title: 'Email thread: Following up',
      compiled_truth: [
        '# Email thread: Following up',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 22 Jun 2026 10:00:00 +0000', 'sent'),
        '',
        'Following up on the proposal I sent last week.',
      ].join('\n'),
      frontmatter: { subject: 'Following up', message_count: 1 },
    });
    // (3) A single inbound message: out of scope, pre-filtered, never audited.
    await engine.putPage('email-thread-ccc3', {
      type: 'email' as never,
      title: 'Email thread: Weekly digest',
      compiled_truth: [
        '# Email thread: Weekly digest',
        EMAIL_HDR('Newsletter', 'news@example.com', 'Tue, 23 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'Read this.',
      ].join('\n'),
      frontmatter: { subject: 'Weekly digest', message_count: 1 },
    });
    // (5) A daily digest page: same `email` type, digest format, out of scope.
    await engine.putPage('email-2026-08-09', {
      type: 'email' as never,
      title: 'Email digest — 2026-08-09',
      compiled_truth: '# Email digest — 2026-08-09\n\n## Signatures pending (0)\n\n## Triage (3)\n\n- something',
      frontmatter: { subtype: 'digest', message_count: 28 },
    });
    // (4) Two messages, both automated: parses, normalizes to nothing, audited.
    await engine.putPage('email-thread-ddd4', {
      type: 'email' as never,
      title: 'Email thread: Doc comments',
      compiled_truth: [
        '# Email thread: Doc comments',
        EMAIL_HDR('"A (Google Docs)"', 'comments-noreply@docs.google.com', 'Wed, 24 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'A commented.',
        '',
        EMAIL_HDR('"B (Google Docs)"', 'comments-noreply@docs.google.com', 'Wed, 24 Jun 2026 11:00:00 +0000', 'received'),
        '',
        'B commented.',
      ].join('\n'),
      frontmatter: { subject: 'Doc comments', message_count: 2 },
    });
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('extracts the thread and the owner-sent single, skips the inbound single, audits the automated pair', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['email'],
      overrideDisabled: true,
      extractor: async (input) => {
        turns.push(input.turnText);
        return [
          // A person page exists: the shipped resolver already maps this one.
          { fact: 'Eve Demo wants to descope the agreement.', kind: 'commitment', entity_slug: 'eve-demo', confidence: 0.9, notability: 'medium' } as never,
          // No page for Oto: the resolver slugifies; the prefixed form seen
          // first in this turn registers, and the raw form folds onto it.
          { fact: 'Oto renews on 28 August.', kind: 'event', entity_slug: 'companies/acme', confidence: 0.9, notability: 'medium' } as never,
          { fact: 'Oto wants a smaller scope.', kind: 'commitment', entity_slug: 'acme', confidence: 0.9, notability: 'medium' } as never,
        ];
      },
    });
    expect(result.pages_processed).toBe(2);
    // The inbound single and the digest page: skipped before any durable write.
    expect(result.pages_skipped_out_of_scope_email).toBe(2);
    expect(result.pages_marked_non_extractable).toBe(1);
    expect(result.email_messages_dropped_automated).toBe(3);
    expect(result.facts_inserted).toBe(6);
    expect(result.entity_slugs_canonicalized).toBe(2);
    // The thread's segment text: display names, no relay, no Gmail link.
    const thread = turns.find((t) => t.includes('Acme - Renewal'));
    expect(thread).toBeDefined();
    expect(thread).toContain('Sam Example [sent] (2026-06-18T07:46:32.000Z): Hey Ed');
    expect(thread).toContain('Eve Demo [received] (2026-06-19T07:03:59.000Z):');
    expect(thread).not.toContain('Open in Gmail');
    expect(thread).not.toContain('Google Docs');
    expect(thread).not.toContain('&lt;');
    const rows = await engine.executeRaw<{ source_markdown_slug: string; entity_slug: string; valid_from: string; source: string }>(
      `SELECT source_markdown_slug, entity_slug, valid_from::text AS valid_from, source
         FROM facts WHERE source_id = 'default' ORDER BY source_markdown_slug, source`,
    );
    const real = rows.filter((r) => r.source === 'cli:extract-conversation-facts');
    expect([...new Set(real.map((r) => r.source_markdown_slug))].sort()).toEqual(['email-thread-aaa1', 'email-thread-bbb2']);
    expect(new Set(real.map((r) => r.entity_slug))).toEqual(new Set(['people/eve-demo', 'companies/acme']));
    expect(real.find((r) => r.source_markdown_slug === 'email-thread-aaa1')?.valid_from.startsWith('2026-06-18')).toBe(true);
    const terminal = rows.filter((r) => r.source === 'cli:extract-conversation-facts:terminal:v2').map((r) => r.source_markdown_slug).sort();
    expect(terminal).toEqual(['email-thread-aaa1', 'email-thread-bbb2']);
    const audited = rows.filter((r) => r.source === 'cli:extract-conversation-facts:non-extractable:v2').map((r) => r.source_markdown_slug);
    expect(audited).toEqual(['email-thread-ddd4']);
    // Never audited: the inbound single and the digest are skipped before any durable write.
    expect(rows.some((r) => r.source_markdown_slug === 'email-thread-ccc3')).toBe(false);
    expect(rows.some((r) => r.source_markdown_slug === 'email-2026-08-09')).toBe(false);
  });

  test('a second run skips both completed pages via durable outcomes and re-skips the inbound single', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['email'],
      overrideDisabled: true,
      extractor: async () => [],
    });
    expect(result.pages_processed).toBe(0);
    expect(result.pages_skipped_completed).toBe(2);
    expect(result.pages_skipped_non_extractable).toBe(1);
    expect(result.pages_skipped_out_of_scope_email).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: enumeration across batches (generator + keyset walk).
// ---------------------------------------------------------------------------

describe('enumeration walks every batch and honors --limit across batches', () => {
  let engine: PGLiteEngine;
  const PAGES = 25; // > 2 x PAGE_LIST_BATCH so the walk crosses batch boundaries

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(
      (async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
      })) as never,
    );
    for (let i = 0; i < PAGES; i++) {
      await engine.putPage(`conversations/walk-${String(i).padStart(2, '0')}`, {
        type: 'conversation',
        title: `Walk ${i}`,
        compiled_truth: [
          fmt('Alice Example', '2024-03-15', '9:00 AM', `Message ${i} one.`),
          fmt('Bob Demo', '2024-03-15', '9:01 AM', `Message ${i} two.`),
        ].join('\n'),
        frontmatter: { date: '2024-03-15' },
      });
    }
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  const run = (limit?: number) =>
    runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['conversation'],
      overrideDisabled: true,
      ...(limit ? { limit } : {}),
      extractor: async () => [
        { fact: 'A fact.', kind: 'fact', entity_slug: 'alice-example', confidence: 0.9, notability: 'low' } as never,
      ],
    });

  test('--limit 7 processes exactly 7 pages even though a batch holds 10', async () => {
    const r = await run(7);
    expect(r.pages_processed).toBe(7);
  });

  test('the next unbounded run processes the remaining 18 and skips the 7 durable ones', async () => {
    const r = await run();
    expect(r.pages_processed).toBe(PAGES - 7);
    expect(r.pages_skipped_completed).toBe(7);
  });

  test('a third run touches nothing', async () => {
    const r = await run();
    expect(r.pages_processed).toBe(0);
    expect(r.pages_skipped_completed).toBe(PAGES);
  });
});

// ---------------------------------------------------------------------------
// Ship audit: email-path edge and error cases through the core, --model
// plumbing, streaming-enumeration abort + candidate accumulation, and the
// canonicalizer's engine-backed load.
// ---------------------------------------------------------------------------

const EMBED_STUB = (async ({ values }: { values: string[] }) => ({
  embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.1)),
})) as never;

describe('EntitySlugCanonicalizer.load', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(EMBED_STUB);
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('registers prefixed slugs from the source\'s existing facts, not only from pages', async () => {
    await engine.insertFacts(
      [{ fact: 'Acme Example raised a round.', kind: 'event', entity_slug: 'companies/acme-example', source: 'test:seed', confidence: 0.9, notability: 'medium' } as never],
      { source_id: 'default' },
    );
    const c = await EntitySlugCanonicalizer.load(engine, 'default');
    expect(c.canonicalize('acme-example')).toBe('companies/acme-example');
    expect(c.canonicalize('Acme Example')).toBe('companies/acme-example');
    // Facts of another source do not register.
    const other = await EntitySlugCanonicalizer.load(engine, 'other-source');
    expect(other.canonicalize('acme-example')).toBe('acme-example');
  });

  test('a failing engine leaves every raw slug raw and warns instead of throwing', async () => {
    const broken = {
      executeRaw: async () => {
        throw new Error('db down');
      },
    } as unknown as PGLiteEngine;
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      errs.push(String(s));
      return true;
    };
    let c: EntitySlugCanonicalizer;
    try {
      c = await EntitySlugCanonicalizer.load(broken, 'default');
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(c!.canonicalize('eve-demo')).toBe('eve-demo');
    expect(c!.canonicalize('companies/acme')).toBe('companies/acme');
    expect(errs.join('')).toContain('slug canonicalizer load failed (db down)');
  });
});

describe('--model override reaches the extraction provider', () => {
  let engine: PGLiteEngine;
  const modelsSeen: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('facts.extraction_enabled', 'true');
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      modelsSeen.push(String(opts.model));
      return {
        text: JSON.stringify({
          facts: [{ fact: 'Alice Example joined Acme.', kind: 'event', entity: 'people/alice-example', confidence: 1.0, notability: 'high' }],
        }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: String(opts.model),
        providerId: 'stub',
      };
    });
    __setEmbedTransportForTests(EMBED_STUB);
    await engine.putPage('email-thread-model-1', {
      type: 'email' as never,
      title: 'Email thread: Model override',
      compiled_truth: [
        '# Email thread: Model override',
        EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'),
        '',
        'I joined Acme this week.',
        '',
        EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'Congratulations.',
      ].join('\n'),
      frontmatter: { subject: 'Model override', message_count: 2 },
    });
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('the core passes opts.model to the extraction chat call', async () => {
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['email'],
      sleepMs: 0,
      model: 'openai:gpt-5.2',
    });
    expect(result.pages_processed).toBe(1);
    expect(result.facts_inserted).toBeGreaterThan(0);
    expect(modelsSeen.length).toBeGreaterThan(0);
    expect(new Set(modelsSeen)).toEqual(new Set(['openai:gpt-5.2']));
  });
});

describe('runExtractConversationFacts --model gate (CLI wrapper)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('facts.extraction_enabled', 'true');
    // Present as "chat available" so the generic gateway gate passes and the
    // --model gates are the ones under test. Any real call is a failure.
    __setChatTransportForTests(async () => {
      throw new Error('provider must not be called');
    });
    __setEmbedTransportForTests(EMBED_STUB);
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  async function runCli(args: string[]): Promise<{ exitCode: number | undefined; errs: string[] }> {
    const errs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    const origExit = process.exit;
    let exitCode: number | undefined;
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    console.log = () => {};
    (process as { exit: unknown }).exit = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    try {
      await runExtractConversationFacts(engine, args).catch((e) => {
        if (!/__exit__/.test(String((e as Error)?.message))) throw e;
      });
    } finally {
      console.error = origErr;
      console.log = origLog;
      process.exit = origExit;
    }
    return { exitCode, errs };
  }

  test('an unpriced --model exits 1 before any page is claimed; --dry-run skips the gate', async () => {
    const gated = await runCli(['--types', 'email', '--model', 'openai:no-such-model-id']);
    expect(gated.exitCode).toBe(1);
    expect(gated.errs.join('\n')).toContain('has no pricing entry');

    const preview = await runCli(['--types', 'email', '--model', 'openai:no-such-model-id', '--dry-run']);
    expect(preview.exitCode).toBeUndefined();
    expect(preview.errs.join('\n')).not.toContain('has no pricing entry');
    expect(preview.errs.join('\n')).not.toContain('provider must not be called');
  });

  test('--background does not dodge the gate: an unpriced --model exits 1 before the job is enqueued', async () => {
    const gated = await runCli(['--background', '--types', 'email', '--model', 'openai:no-such-model-id']);
    expect(gated.exitCode).toBe(1);
    expect(gated.errs.join('\n')).toContain('has no pricing entry');
    expect(gated.errs.join('\n')).not.toContain('Unknown flag');
  });
});

describe('email threads through the core: char cap, drops, folds, date fallback, dry run, abort', () => {
  let engine: PGLiteEngine;
  const turns: string[] = [];
  const LONG = Array.from(
    { length: 40 },
    (_, i) => `Sentence ${i} of a long email body that keeps going on about the renewal terms.`,
  ).join(' ');

  const extractor = async (input: { turnText: string }) => {
    turns.push(input.turnText);
    return [
      { fact: 'A fact.', kind: 'fact', entity_slug: 'people/alice-example', confidence: 0.9, notability: 'low' } as never,
    ];
  };
  const run = (opts: Record<string, unknown> = {}) =>
    runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['email'],
      overrideDisabled: true,
      extractor,
      sleepMs: 0,
      ...opts,
    });
  const thread = (slug: string, title: string, body: string[], frontmatter: Record<string, unknown>) =>
    engine.putPage(slug, { type: 'email' as never, title, compiled_truth: [`# ${title}`, ...body].join('\n'), frontmatter });

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(EMBED_STUB);
  });

  beforeEach(async () => {
    turns.length = 0;
    await engine.executeRaw(`DELETE FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`);
    await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
    await engine.executeRaw(`DELETE FROM pages WHERE type IN ('email', 'conversation')`);
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  test('a thread over the segment char cap splits into several untruncated segments on one page', async () => {
    await thread('email-thread-long', 'Email thread: Long', [
      EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', LONG, '',
      EMAIL_HDR('Bob Example', 'bob@example.com', 'Tue, 02 Jun 2026 09:00:00 +0000', 'received'), '', LONG, '',
      EMAIL_HDR('Alice Example', 'alice@example.com', 'Wed, 03 Jun 2026 09:00:00 +0000', 'sent'), '', LONG, '',
      EMAIL_HDR('Bob Example', 'bob@example.com', 'Thu, 04 Jun 2026 09:00:00 +0000', 'received'), '', LONG,
    ], { subject: 'Long', message_count: 4 });
    const r = await run();
    expect(r.pages_processed).toBe(1);
    expect(r.segments_processed).toBeGreaterThanOrEqual(2);
    expect(turns).toHaveLength(r.segments_processed);
    for (const t of turns) {
      expect(t.length).toBeLessThanOrEqual(SEGMENT_TEXT_CHAR_LIMIT);
      expect(t.endsWith('…(truncated)')).toBe(false);
    }
    // Every message's tail survived the cut.
    expect(turns.join('\n').split('Sentence 39 of').length - 1).toBe(4);
  });

  test('after automated drops, a lone inbound human message is audited as fewer than two eligible messages', async () => {
    await thread('email-thread-relay', 'Email thread: Relay', [
      EMAIL_HDR('"A (Google Docs)"', 'comments-noreply@docs.google.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'), '', 'A commented.', '',
      EMAIL_HDR('"B (Google Docs)"', 'comments-noreply@docs.google.com', 'Mon, 01 Jun 2026 09:30:00 +0000', 'received'), '', 'B commented.', '',
      EMAIL_HDR('Carol Example', 'carol@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'), '', 'Looks good to me.',
    ], { subject: 'Relay', message_count: 3 });
    const r = await run();
    expect(r.pages_processed).toBe(0);
    expect(r.email_messages_dropped_automated).toBe(2);
    expect(r.pages_marked_non_extractable).toBe(1);
    expect(turns).toHaveLength(0);
    const rows = await engine.executeRaw<{ context: string }>(
      `SELECT context FROM facts WHERE source = $1 AND source_markdown_slug = 'email-thread-relay'`,
      [NON_EXTRACTABLE_AUDIT_SOURCE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toContain('fewer than two eligible messages');
  });

  test('a forwarded speaker-shaped heading inside an email body never declines the page', async () => {
    const body = [
      EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', 'Forwarding the note below.', '',
      '## Alice Smith', 'Alice wrote this section in the forwarded newsletter.', '',
      EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 11:00:00 +0000', 'sent'), '', 'Following up on it.',
    ];
    await thread('email-thread-fwd', 'Email thread: Forward', body, { subject: 'Forward', message_count: 2 });
    const r = await run();
    expect(r.pages_processed).toBe(1);
    expect(r.pages_skipped_unrecognized_speaker).toBe(0);
    expect(turns.join('\n')).toContain('## Alice Smith');
    // Contrast: the same body on a non-email page keeps the #4136 decline
    // (one speaker + a speaker-shaped fold), so the email guard is load-bearing.
    turns.length = 0;
    await engine.putPage('conversations/fwd-as-chat', {
      type: 'conversation',
      title: 'Forward as chat',
      compiled_truth: body.join('\n'),
      frontmatter: { date: '2026-06-01' },
    });
    const chat = await run({ types: ['conversation'] });
    expect(chat.pages_skipped_unrecognized_speaker).toBe(1);
    expect(chat.pages_processed).toBe(0);
  });

  test('an anchor with an unparseable date is kept as its own turn, anchored on the page date', async () => {
    await thread('email-thread-baddate', 'Email thread: Bad date', [
      EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', 'alice body', '',
      EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Xxx 2026 10:00:00 +0000', 'received'), '', 'bob body',
    ], { subject: 'Bad date', message_count: 2, date: '2026-06-18' });
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      errs.push(String(s));
      return true;
    };
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run();
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(r!.pages_processed).toBe(1);
    const all = turns.join('\n');
    expect(all).toContain('Alice Example [sent] (2026-06-01T09:00:00.000Z): alice body');
    expect(all).toContain('Bob Example [received] (2026-06-18T00:00:00Z): bob body');
    expect(errs.join('')).toContain('email-thread-baddate: 1 anchor line(s) had an unparseable date');
  });

  test('dry run on email pages writes nothing durable but still reports the email counters', async () => {
    await thread('email-thread-dry-inbound', 'Email thread: Inbound only', [
      EMAIL_HDR('Newsletter', 'news@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'), '', 'Read this.',
    ], { subject: 'Inbound only', message_count: 1 });
    await thread('email-thread-dry-real', 'Email thread: Real', [
      EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', 'Can we meet?', '',
      EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'), '', 'Yes, Friday.',
    ], { subject: 'Real', message_count: 2 });
    const r = await run({ dryRun: true });
    expect(r.pages_skipped_out_of_scope_email).toBe(1);
    expect(r.pages_processed).toBe(1);
    expect(r.facts_inserted).toBe(0);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`,
    );
    expect(Number(rows[0].n)).toBe(0);
    const cps = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM op_checkpoints WHERE op = 'extract-conversation-facts'`,
    );
    expect(Number(cps[0].n)).toBe(0);
  });

  test('an abort raised while the stream still holds pages stops the run; the next run finishes the rest', async () => {
    const N = 6;
    for (let i = 0; i < N; i++) {
      await thread(`email-thread-abort-${i}`, `Email thread: Abort ${i}`, [
        EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', `Question ${i}.`, '',
        EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'), '', `Answer ${i}.`,
      ], { subject: `Abort ${i}`, message_count: 2 });
    }
    const controller = new AbortController();
    let calls = 0;
    const abortingExtractor = async () => {
      calls++;
      if (calls === 2) {
        const err = Object.assign(new Error('caller cancelled'), { name: 'AbortError' });
        controller.abort(err);
        throw err;
      }
      return [{ fact: 'A fact.', kind: 'fact', entity_slug: 'people/alice-example', confidence: 0.9, notability: 'low' } as never];
    };
    await expect(
      runExtractConversationFactsCore(
        engine,
        { sourceId: 'default', types: ['email'], overrideDisabled: true, extractor: abortingExtractor, sleepMs: 0 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const done = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    const first = Number(done[0].n);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(N);
    const second = await run();
    expect(second.pages_processed).toBe(N - first);
    expect(second.pages_skipped_completed).toBe(first);
  });
});

describe('streaming enumeration accumulates candidates across list reads', () => {
  let engine: PGLiteEngine;
  const N = 25; // > 2 batches; every other page is out of scope, so a batch yields ~5 candidates

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(EMBED_STUB);
    for (let i = 0; i < N; i++) {
      const slug = `email-thread-mix-${String(i).padStart(2, '0')}`;
      const inbound = i % 2 === 0;
      await engine.putPage(slug, {
        type: 'email' as never,
        title: `Email thread: Mix ${i}`,
        compiled_truth: inbound
          ? [`# Email thread: Mix ${i}`, EMAIL_HDR('Newsletter', 'news@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'), '', `Issue ${i}.`].join('\n')
          : [
              `# Email thread: Mix ${i}`,
              EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'), '', `Question ${i}.`, '',
              EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'), '', `Answer ${i}.`,
            ].join('\n'),
        frontmatter: { subject: `Mix ${i}`, message_count: inbound ? 1 : 2 },
      });
    }
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    await engine.disconnect();
  });

  const run = () =>
    runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      types: ['email'],
      overrideDisabled: true,
      sleepMs: 0,
      extractor: async () => [
        { fact: 'A fact.', kind: 'fact', entity_slug: 'people/alice-example', confidence: 0.9, notability: 'low' } as never,
      ],
    });

  test('every in-scope thread is processed exactly once and every out-of-scope page is counted', async () => {
    const inbound = Math.ceil(N / 2);
    const r = await run();
    expect(r.pages_skipped_out_of_scope_email).toBe(inbound);
    expect(r.pages_processed).toBe(N - inbound);
    const terminal = await engine.executeRaw<{ source_markdown_slug: string }>(
      `SELECT source_markdown_slug FROM facts WHERE source = $1`,
      [TERMINAL_AUDIT_SOURCE],
    );
    expect(terminal).toHaveLength(N - inbound);
    expect(new Set(terminal.map((t) => t.source_markdown_slug)).size).toBe(N - inbound);
    const again = await run();
    expect(again.pages_processed).toBe(0);
    expect(again.pages_skipped_completed).toBe(N - inbound);
    expect(again.pages_skipped_out_of_scope_email).toBe(inbound);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-28 ship review fixes.
// ---------------------------------------------------------------------------

describe('review fixes (2026-08-28 ship)', () => {
  test('a lone oversized message never manufactures the segment minimum through the char-cut exemption', () => {
    const lone = [{ speaker: 'Newsletter', timestamp: '2026-06-18T07:46:32.000Z', text: 'word '.repeat(2400) }];
    const segs = splitIntoSegments(lone, {
      gapMinutes: EMAIL_SEGMENT_GAP_MINUTES,
      maxChars: DEFAULT_SEGMENT_MAX_CHARS,
      minMessages: 2,
    });
    expect(segs).toHaveLength(0);
    // A conversation that meets the minimum keeps the exemption: both sides of a cut survive.
    const pair = [
      ...lone,
      { speaker: 'Sam Example', timestamp: '2026-06-18T08:00:00.000Z', text: 'Short reply.' },
    ];
    const kept = splitIntoSegments(pair, {
      gapMinutes: EMAIL_SEGMENT_GAP_MINUTES,
      maxChars: DEFAULT_SEGMENT_MAX_CHARS,
      minMessages: 2,
    });
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.flatMap((s) => s.messages).length).toBeGreaterThanOrEqual(pair.length);
  });

  test('email-digest typed pages are out of scope before parsing', () => {
    expect(isOutOfScopeEmail({ type: 'email-digest' as never, frontmatter: {}, compiled_truth: '## Triage' })).toBe(true);
    expect(isOutOfScopeEmail({ type: 'email' as never, frontmatter: { subtype: 'digest' }, compiled_truth: '' })).toBe(true);
    expect(isOutOfScopeEmail({ type: 'conversation' as never, frontmatter: {}, compiled_truth: '' })).toBe(false);
  });

  test('compileEmailSenderDenylist merges operator rules as plain strings and skips invalid entries', () => {
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      errs.push(String(s));
      return true;
    };
    let list: readonly EmailSenderRule[];
    try {
      list = compileEmailSenderDenylist(['@relay.example', 'Noreply ', 42 as never, '']);
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    // Two rules kept (suffix + substring, lowercased); the number and the empty string are reported.
    expect(list.length).toBe(EMAIL_AUTOMATED_SENDERS.length + 2);
    expect(list.slice(-2)).toEqual(['@relay.example', 'noreply']);
    expect(errs.join('')).toContain('ignored (expected a non-empty string)');
    const msgs = [
      { speaker: 'Bot &lt;bot@relay.example&gt;', timestamp: '2026-06-18T07:46:32.000Z', text: 'ping' },
      { speaker: 'Eve Demo &lt;eve@example.com&gt;', timestamp: '2026-06-18T08:00:00.000Z', text: 'pong' },
    ];
    expect(normalizeEmailMessages(msgs).dropped).toBe(0);
    const n = normalizeEmailMessages(msgs, list);
    expect(n.dropped).toBe(1);
    expect(n.messages.map((m) => m.speaker)).toEqual(['Eve Demo']);
    expect(compileEmailSenderDenylist(undefined)).toEqual(EMAIL_AUTOMATED_SENDERS);
  });

  test('the canonicalizer registers only people/ and companies/ slugs', () => {
    const c = new EntitySlugCanonicalizer();
    expect(c.canonicalize('projects/apollo')).toBe('projects/apollo');
    expect(c.canonicalize('apollo')).toBe('apollo');
    expect(c.canonicalize('companies/a/b')).toBe('companies/a/b');
    expect(c.canonicalize('a/b')).toBe('a/b');
    expect(c.canonicalize('people/eve-demo')).toBe('people/eve-demo');
    expect(c.canonicalize('eve-demo')).toBe('people/eve-demo');
    expect(c.canonicalize('Eve Demo')).toBe('people/eve-demo');
  });

  test('the canonicalizer loads sibling pages from the run source only', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const fake = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('FROM pages') ? [{ slug: 'people/alice-example' }] : [];
      },
    } as unknown as PGLiteEngine;
    const c = await EntitySlugCanonicalizer.load(fake, 'src-a');
    const pagesQuery = calls.find((x) => x.sql.includes('FROM pages'))!;
    expect(pagesQuery.sql).toMatch(/WHERE source_id = \$1/);
    expect(pagesQuery.params).toEqual(['src-a']);
    const factsQuery = calls.find((x) => x.sql.includes('FROM facts'))!;
    expect(factsQuery.params).toEqual(['src-a']);
    expect(c.canonicalize('alice-example')).toBe('people/alice-example');
  });

  test('the candidate set is bounded by MAX_CANDIDATE_BATCH', () => {
    expect(MAX_CANDIDATE_BATCH).toBeGreaterThanOrEqual(PAGE_LIST_BATCH);
    for (const workers of [1, 16, 64, 500]) {
      const candidateBatch = Math.min(MAX_CANDIDATE_BATCH, Math.max(PAGE_LIST_BATCH, workers * 2));
      expect(candidateBatch).toBeLessThanOrEqual(MAX_CANDIDATE_BATCH);
      expect(candidateBatch).toBeGreaterThanOrEqual(PAGE_LIST_BATCH);
    }
  });
});

describe('review fixes through the core (2026-08-28 ship)', () => {
  let engine: PGLiteEngine;
  const extractor = async () =>
    [{ fact: 'x', kind: 'fact', confidence: 0.9, notability: 'low' }] as never;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __setEmbedTransportForTests(EMBED_STUB);
    // Two issues of one newsletter: message_count 2, both received, one sender.
    await engine.putPage('email-thread-news2', {
      type: 'email' as never,
      title: 'Email thread: Weekly digest',
      frontmatter: { subject: 'Weekly digest', message_count: 2 },
      compiled_truth: [
        '# Email thread: Weekly digest',
        EMAIL_HDR('Indie Weekly', 'hi@indieweekly.example', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Issue 41: growth tactics.',
        '',
        EMAIL_HDR('Indie Weekly', 'hi@indieweekly.example', 'Mon, 08 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Issue 42: pricing.',
      ].join('\n'),
    });
    // Two distinct humans, neither the owner: a real exchange the owner was copied on.
    await engine.putPage('email-thread-cc2', {
      type: 'email' as never,
      title: 'Email thread: Contract draft',
      frontmatter: { subject: 'Contract draft', message_count: 2 },
      compiled_truth: [
        '# Email thread: Contract draft',
        EMAIL_HDR('Alice Example', 'alice@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Draft attached, please review.',
        '',
        EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'Reviewed, two comments.',
      ].join('\n'),
    });
    // Operator denylist drops a sender the built-in list does not know.
    await engine.putPage('email-thread-relay2', {
      type: 'email' as never,
      title: 'Email thread: Ticket 77',
      frontmatter: { subject: 'Ticket 77', message_count: 2 },
      compiled_truth: [
        '# Email thread: Ticket 77',
        EMAIL_HDR('Support Bot', 'bot@relay.example', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Ticket opened.',
        '',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'sent'),
        '',
        'Closing this, resolved.',
      ].join('\n'),
    });
  });

  afterAll(async () => {
    __setEmbedTransportForTests(null);
    __setChatTransportForTests(null);
    await engine.disconnect();
  });

  test('two issues of one newsletter stay below the minimum and are audited; two distinct humans qualify', async () => {
    const news = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-news2', types: ['email'], overrideDisabled: true, extractor,
    });
    expect(news.pages_marked_non_extractable).toBe(1);
    expect(news.facts_inserted).toBe(0);
    const cc = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-cc2', types: ['email'], overrideDisabled: true, extractor,
    });
    expect(cc.pages_processed).toBe(1);
    expect(cc.facts_inserted).toBeGreaterThan(0);
  });

  test('opts.emailAutomatedSenders extends the built-in denylist for the run', async () => {
    const r = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-relay2', types: ['email'], overrideDisabled: true, extractor,
      emailAutomatedSenders: ['@relay.example'],
    });
    expect(r.email_messages_dropped_automated).toBe(1);
    // The owner's lone sent message still qualifies the thread.
    expect(r.pages_processed).toBe(1);
  });

  test('the core rejects an unpriced --model before any page is claimed', async () => {
    __setChatTransportForTests(async () => {
      throw new Error('provider must not be called');
    });
    expect(validateModelFlag('openai:no-such-model-id')).toContain('has no pricing entry');
    await expect(
      runExtractConversationFactsCore(engine, {
        sourceId: 'default', slug: 'email-thread-cc2', types: ['email'], overrideDisabled: true,
        model: 'openai:no-such-model-id',
      }),
    ).rejects.toThrow('has no pricing entry');
    // dryRun skips the gate (no provider call is made either way).
    const preview = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-cc2', types: ['email'], overrideDisabled: true, dryRun: true,
      model: 'openai:no-such-model-id', extractor,
    });
    expect(preview.pages_considered).toBe(1);
  });

  test('a heading the pattern rejects declines the page instead of folding into the previous sender', async () => {
    await engine.putPage('email-thread-badhdr', {
      type: 'email' as never,
      title: 'Email thread: Odd date',
      frontmatter: { subject: 'Odd date', message_count: 2 },
      compiled_truth: [
        '# Email thread: Odd date',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'),
        '',
        'Can you confirm the fee?',
        '',
        // Two-digit year: outside the pattern, passes quick_reject.
        EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 26 10:00:00 +0000', 'received'),
        '',
        'Confirmed, 5k.',
      ].join('\n'),
    });
    const errs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      errs.push(String(s));
      return true;
    };
    let r;
    try {
      r = await runExtractConversationFactsCore(engine, {
        sourceId: 'default', slug: 'email-thread-badhdr', types: ['email'], overrideDisabled: true, extractor,
      });
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(r.pages_skipped_unrecognized_speaker).toBe(1);
    expect(r.facts_inserted).toBe(0);
    expect(errs.join('')).toContain('2 heading line(s) but 1 parsed message(s)');
    // Non-terminal: no audit row, the page is retried once the format is handled.
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug = 'email-thread-badhdr'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('a quoted section heading shaped like `## Notes — Q3 plan (sent)` is body text, not a missing anchor', async () => {
    await engine.putPage('email-thread-quoted', {
      type: 'email' as never,
      title: 'Email thread: Quoted',
      frontmatter: { subject: 'Quoted', message_count: 2 },
      compiled_truth: [
        '# Email thread: Quoted',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'),
        '',
        'See the notes below.',
        '## Notes — Q3 plan (sent)',
        'Pasted section.',
        '',
        EMAIL_HDR('Bob Example', 'bob@example.com', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'Got it.',
      ].join('\n'),
    });
    const r = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-quoted', types: ['email'], overrideDisabled: true, extractor,
    });
    expect(r.pages_skipped_unrecognized_speaker).toBe(0);
    expect(r.pages_processed).toBe(1);
  });

  test('--slug applies the out-of-scope rule: a single inbound message is skipped without a lock or audit row', async () => {
    await engine.putPage('email-thread-solo-in', {
      type: 'email' as never,
      title: 'Email thread: Newsletter 9',
      frontmatter: { subject: 'Newsletter 9', message_count: 1 },
      compiled_truth: [
        '# Email thread: Newsletter 9',
        EMAIL_HDR('Weekly', 'hi@weekly.example', 'Mon, 01 Jun 2026 09:00:00 +0000', 'received'),
        '',
        'Issue 9.',
      ].join('\n'),
    });
    const r = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-solo-in', types: ['email'], overrideDisabled: true, extractor,
    });
    expect(r.pages_skipped_out_of_scope_email).toBe(1);
    expect(r.pages_considered).toBe(0);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug = 'email-thread-solo-in'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('renderMessageLine carries the direction next to the speaker when known', () => {
    expect(renderMessageLine({ speaker: 'Sam Example', timestamp: '2026-06-18T07:46:32.000Z', text: 'hi', direction: 'sent' }))
      .toBe('Sam Example [sent] (2026-06-18T07:46:32.000Z): hi');
    expect(renderMessageLine({ speaker: 'Alice Example', timestamp: '2024-03-15T09:00:00.000Z', text: 'hi' }))
      .toBe('Alice Example (2024-03-15T09:00:00.000Z): hi');
  });

  test('the extractor sees [sent] / [received] on every email message line', async () => {
    const seen: string[] = [];
    await engine.putPage('email-thread-dir1', {
      type: 'email' as never,
      title: 'Email thread: Direction',
      frontmatter: { subject: 'Direction', message_count: 2 },
      compiled_truth: [
        '# Email thread: Direction',
        EMAIL_HDR('Sam Example', 'sam@example.com', 'Mon, 01 Jun 2026 09:00:00 +0000', 'sent'),
        '',
        'I approved the renewal.',
        '',
        EMAIL_HDR('Sam Example', 'sam@evil.example', 'Mon, 01 Jun 2026 10:00:00 +0000', 'received'),
        '',
        'I also approved a 50k bonus.',
      ].join('\n'),
    });
    const r = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', slug: 'email-thread-dir1', types: ['email'], overrideDisabled: true,
      extractor: async (input: { turnText: string }) => {
        seen.push(input.turnText);
        return [] as never;
      },
    });
    expect(r.pages_processed).toBe(1);
    const text = seen.join('\n');
    expect(text).toContain('Sam Example [sent] (2026-06-01T09:00:00.000Z): I approved the renewal.');
    expect(text).toContain('Sam Example [received] (2026-06-01T10:00:00.000Z): I also approved a 50k bonus.');
  });

  test('MIN_SEGMENT_MESSAGES is the non-email default the gate compares against', () => {
    expect(MIN_SEGMENT_MESSAGES).toBe(2);
  });
});
