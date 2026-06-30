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
  PER_SEGMENT_SOURCE_PREFIX,
} from '../src/commands/extract-conversation-facts.ts';

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

  test('intra-page rowNum watermark round-trips; new entries always carry it (incl 0)', () => {
    // New entries encode the rowNum (even 0) → always 4-field.
    const e0 = encodeCheckpointEntry('default', 'conversations/x', '2024-03-16T08:05:00Z', 0);
    expect(e0).toBe('default|conversations/x|2024-03-16T08:05:00Z|0');
    expect(decodeCheckpointEntry(e0)?.rowNum).toBe(0);

    const e5 = encodeCheckpointEntry('default', 'conversations/x', '2024-03-16T08:05:00Z', 5);
    expect(decodeCheckpointEntry(e5)?.rowNum).toBe(5);

    // Legacy 3-field entry (no rowNum) decodes with rowNum undefined — the
    // signal cpEntriesToMap uses to force a safe full re-extract (no
    // tail-only resume that would wipe an unaccounted committed prefix).
    const legacy = encodeCheckpointEntry('default', 'conversations/x', '2024-03-16T08:05:00Z');
    expect(legacy).toBe('default|conversations/x|2024-03-16T08:05:00Z');
    expect(decodeCheckpointEntry(legacy)?.rowNum).toBeUndefined();
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

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Deterministic chat-transport stub. Records calls + returns one
    // fact per turn. Real-LLM extraction quality is the eval suite's job.
    let callIndex = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      callIndex++;
      return {
        text: JSON.stringify({
          facts: [{
            fact: `synthetic fact #${callIndex}`,
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
  });

  beforeEach(async () => {
    // Clean state per test. Use executeRaw because PGLite uses different
    // truncation semantics than the canonical reset helper.
    await engine.executeRaw(`DELETE FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`);
    await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = 'extract-conversation-facts'`);
    await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'conversations/%' OR slug LIKE 'people/alice%'`);
    // Set facts.extraction_enabled=true so kill-switch doesn't refuse.
    await engine.setConfig('facts.extraction_enabled', 'true');
    // Seed test pages.
    await engine.putPage('conversations/imessage/alice-example', {
      type: 'conversation',
      title: 'iMessage: Alice Example',
      compiled_truth: SAMPLE_BODY,
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Profile content for Alice Example.',
      timeline: '',
      frontmatter: {},
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

    // Terminal audit row present.
    const terminalRows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example`],
    );
    expect(Number(terminalRows[0]?.count ?? 0)).toBe(1);
  });

  test('B1: a swallowed insertFacts failure does NOT advance the cursor (page re-extracts next run)', async () => {
    // Regression for cursor-only-on-confirmed-write. The per-segment insert
    // is best-effort (the catch swallows + continues); pre-B1 the cursor
    // still advanced past the unwritten facts and the terminal row was
    // written, so the page was marked complete and never retried. This
    // forces the INSERT-failure path (NOT abort — abort was already safe).
    type IF = PGLiteEngine['insertFacts'];
    const realInsertFacts: IF = engine.insertFacts.bind(engine);
    let failing = true;
    engine.insertFacts = (async (rows, opts) => {
      if (failing) throw new Error('synthetic insertFacts failure');
      return realInsertFacts(rows, opts);
    }) as IF;

    let firstThrew = false;
    let first: Awaited<ReturnType<typeof runExtractConversationFactsCore>> | null = null;
    try {
      first = await runExtractConversationFactsCore(engine, {
        sourceId: 'default',
        slug: 'conversations/imessage/alice-example',
        sleepMs: 0,
      });
    } catch {
      firstThrew = true;
    } finally {
      failing = false;
      engine.insertFacts = realInsertFacts;
    }

    // Best-effort: the call resolves (does not throw) but writes nothing.
    expect(firstThrew).toBe(false);
    expect(first?.facts_inserted ?? -1).toBe(0);

    // No terminal audit row — the page was NOT marked complete.
    const terminalAfterFail = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example`],
    );
    expect(Number(terminalAfterFail[0]?.count ?? 0)).toBe(0);

    // Second run WITHOUT --force must RE-PROCESS (the cursor never advanced).
    // Pre-B1 this skipped (cursor had advanced past every segment).
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.pages_processed).toBe(1);
    expect(second.facts_inserted).toBeGreaterThan(0);
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

  test('intra-page resume: a partial run resumes mid-page without re-extracting the committed prefix', async () => {
    // Force a partial run: segmentLimit=1 processes only segment 1 (Mar 15),
    // leaves segment 2 (Mar 16) for next time, and writes NO terminal row.
    const first = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
      segmentLimit: 1,
    });
    expect(first.segments_processed).toBe(1);
    expect(first.facts_inserted).toBe(1);

    const seg1 = `${PER_SEGMENT_SOURCE_PREFIX}:conversations/imessage/alice-example`;
    const factsAfter1 = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [PER_SEGMENT_SOURCE_PREFIX, seg1],
    );
    expect(Number(factsAfter1[0]?.count ?? 0)).toBe(1);
    // No terminal row — the page is NOT complete.
    const term1 = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example`],
    );
    expect(Number(term1[0]?.count ?? 0)).toBe(0);

    // Second run, NO segmentLimit: must RESUME from segment 2 — NOT wipe and
    // re-extract segment 1. The committed prefix is preserved (no orphan
    // cleanup), row_num stays contiguous, and the page completes.
    const second = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
    });
    expect(second.orphan_facts_cleaned).toBe(0); // committed prefix preserved
    expect(second.segments_processed).toBe(1);   // only segment 2 re-done
    expect(second.facts_inserted).toBe(1);

    // Total per-segment facts = 2 (segment 1 preserved + segment 2 new).
    const factsAfter2 = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [PER_SEGMENT_SOURCE_PREFIX, seg1],
    );
    expect(Number(factsAfter2[0]?.count ?? 0)).toBe(2);
    // row_num contiguous across the two runs (0,1) — continuity preserved.
    const rows = await engine.executeRaw<{ row_num: number }>(
      `SELECT row_num FROM facts WHERE source = $1 AND source_markdown_slug = $2 ORDER BY row_num ASC`,
      [PER_SEGMENT_SOURCE_PREFIX, 'conversations/imessage/alice-example'],
    );
    expect(rows.map((r) => Number(r.row_num))).toEqual([0, 1]);
    // Page now complete — terminal row present.
    const term2 = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example`],
    );
    expect(Number(term2[0]?.count ?? 0)).toBe(1);
  });

  test('segmentLimit equal to the segment count still completes (writes terminal row, no livelock)', async () => {
    // SAMPLE_BODY has exactly 2 segments. segmentLimit=2 processes both; the
    // page MUST get its terminal row (else it sits in the backlog forever:
    // next run sees 0 segments and returns before any terminal write).
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default',
      slug: 'conversations/imessage/alice-example',
      sleepMs: 0,
      segmentLimit: 2,
    });
    expect(result.segments_processed).toBe(2);
    const term = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM facts WHERE source = $1 AND source_session = $2`,
      [TERMINAL_AUDIT_SOURCE, `${TERMINAL_AUDIT_SOURCE}:conversations/imessage/alice-example`],
    );
    expect(Number(term[0]?.count ?? 0)).toBe(1);
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
    expect(second.pages_skipped).toBe(1);
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
