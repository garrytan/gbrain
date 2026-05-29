/**
 * v0.41.16.0 — Conversation parser orchestrator tests.
 *
 * Covers:
 *   - PR #1461's 6 telegram-bracket cases verbatim (REGRESSION pin)
 *   - All 12 built-in patterns hit their test_positive samples
 *   - Date derivation precedence (D8)
 *   - Pattern priority scoring (D18) — overlap resolution
 *   - Quick-reject fast path (D11)
 *   - Multi-line continuation (D5)
 *   - Disabled-builtin honored
 *   - Timezone warning (D19) emitted when frontmatter timezone missing
 *
 * Pure-function tests; no PGLite, no LLM. The LLM polish/fallback
 * tests live in `llm-base.test.ts`, `llm-polish.test.ts`,
 * `llm-fallback.test.ts` (T4).
 */

import { describe, expect, test } from 'bun:test';
import {
  parseConversation,
  deriveDateContext,
  applyPattern,
  scorePattern,
  scorePatternFull,
} from '../../src/core/conversation-parser/parse.ts';
import { BUILTIN_PATTERNS } from '../../src/core/conversation-parser/builtins.ts';
import type { Page } from '../../src/core/types.ts';

// Helper to construct a minimal Page for date-derivation tests.
function makePage(
  frontmatter: Record<string, unknown> = {},
  effective_date?: Date,
): Page {
  return {
    id: 1,
    slug: 'test/page',
    type: 'conversation',
    title: 'Test',
    compiled_truth: '',
    timeline: '',
    frontmatter,
    content_hash: undefined,
    created_at: new Date(),
    updated_at: new Date(),
    effective_date: effective_date ?? null,
  } as Page;
}

// ---------------------------------------------------------------------------
// REGRESSION: PR #1461's 6 telegram-bracket cases verbatim
// ---------------------------------------------------------------------------

describe('parseConversation — REGRESSION PR #1461 (telegram-bracket)', () => {
  test('bracket-time with 👤 emoji speaker prefix', () => {
    const body = '**[18:37] \u{1f464} G T:** hello world';
    const r = parseConversation(body, { fallbackDate: '2026-05-24' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('G T');
    expect(r.messages[0].text).toBe('hello world');
    expect(r.messages[0].timestamp).toBe('2026-05-24T18:37:00Z');
    expect(r.matched_pattern_id).toBe('telegram-bracket');
  });

  test('bracket-time with 🤖 robot emoji', () => {
    const body = '**[06:00] \u{1f916} Zion:** On it.';
    const r = parseConversation(body, { fallbackDate: '2026-05-25' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('Zion');
    expect(r.messages[0].text).toBe('On it.');
    expect(r.messages[0].timestamp).toBe('2026-05-25T06:00:00Z');
  });

  test('bracket-time multi-line continuation', () => {
    const body = [
      '**[09:00] \u{1f464} Alice Example:** first line',
      'second line of same message',
      '**[09:05] \u{1f464} Bob Example:** separate message',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-05-20' });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].text).toBe('first line\nsecond line of same message');
    expect(r.messages[1].text).toBe('separate message');
  });

  test('bracket-time falls back to 1970-01-01 without fallbackDate', () => {
    const body = '**[14:30] \u{1f464} Alice Example:** test';
    const r = parseConversation(body);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].timestamp).toBe('1970-01-01T14:30:00Z');
  });

  test('mixed formats in one body: iMessage + bracket-time', () => {
    const body = [
      '**Alice Example** (2024-03-15 9:00 AM): format 1',
      '**[10:30] \u{1f464} Bob Example:** format 2',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    // D18 scoring picks the dominant pattern. Both have one hit; ties
    // resolve to declared priority (imessage-slack=0, telegram-bracket=1).
    // The imessage line matches; the telegram line becomes a
    // continuation. This is a known D18 tradeoff for very-mixed bodies.
    // In practice every chat export is homogeneous, so this is a
    // degenerate test case.
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
    expect(r.matched_pattern_id).toBe('imessage-slack');
  });

  test('bracket-time without emoji prefix', () => {
    const body = '**[22:15] Plain Name:** no emoji';
    const r = parseConversation(body, { fallbackDate: '2026-01-01' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('Plain Name');
    expect(r.messages[0].text).toBe('no emoji');
  });
});

// ---------------------------------------------------------------------------
// All 12 built-ins must parse their test_positive samples
// ---------------------------------------------------------------------------

describe('parseConversation — every built-in matches its test_positive sample', () => {
  for (const entry of BUILTIN_PATTERNS) {
    test(`pattern ${entry.id}: first test_positive parses`, () => {
      const body = entry.test_positive[0];
      // Multi-line patterns need a body line on the next line.
      const fullBody =
        entry.multi_line && entry.captures.text_group === 0
          ? `${body}\nsome body text`
          : body;
      const r = parseConversation(fullBody, {
        fallbackDate: '2024-03-15',
      });
      // Either matches a message OR (for some multi-line patterns) the
      // first line is the anchor and the body is consumed as text.
      expect(r.messages.length).toBeGreaterThanOrEqual(1);
      expect(r.matched_pattern_id).toBe(entry.id);
    });
  }
});

// ---------------------------------------------------------------------------
// Date derivation precedence (D8)
// ---------------------------------------------------------------------------

describe('deriveDateContext (D8 precedence chain)', () => {
  test('explicit fallbackDate wins', () => {
    const page = makePage({ date: '2024-01-01' }, new Date('2023-06-15'));
    const ctx = deriveDateContext({ fallbackDate: '2025-12-25', page });
    expect(ctx.fallbackDate).toBe('2025-12-25');
    expect(ctx.source).toBe('explicit');
  });
  test('frontmatter.date wins over effective_date', () => {
    const page = makePage({ date: '2024-01-01' }, new Date('2023-06-15'));
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2024-01-01');
    expect(ctx.source).toBe('frontmatter_date');
  });
  test('effective_date wins when no frontmatter.date', () => {
    const page = makePage({}, new Date('2023-06-15T00:00:00Z'));
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2023-06-15');
    expect(ctx.source).toBe('effective_date');
  });
  test('epoch_default when nothing set', () => {
    const ctx = deriveDateContext({});
    expect(ctx.fallbackDate).toBe('1970-01-01');
    expect(ctx.source).toBe('epoch_default');
  });
  test('frontmatter.timezone surfaces', () => {
    const page = makePage({
      date: '2024-01-01',
      timezone: 'America/Los_Angeles',
    });
    const ctx = deriveDateContext({ page });
    expect(ctx.timezone).toBe('America/Los_Angeles');
  });
  test('invalid frontmatter.date falls through', () => {
    const page = makePage({ date: 'not-a-date' });
    const ctx = deriveDateContext({ page });
    expect(ctx.source).toBe('epoch_default');
  });
  test('frontmatter.date slices full ISO to YYYY-MM-DD', () => {
    const page = makePage({ date: '2024-03-15T18:37:00Z' });
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2024-03-15');
  });
});

// ---------------------------------------------------------------------------
// Pattern priority scoring (D18)
// ---------------------------------------------------------------------------

describe('scorePattern (D18 priority scoring)', () => {
  test('telegram-bracket scores 1.0 on a pure telegram body', () => {
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
      '**[18:39] \u{1f464} Alice:** three',
    ].join('\n');
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern(body, tg)).toBe(1);
  });
  test('imessage-slack scores 0 on pure telegram body', () => {
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
    ].join('\n');
    const im = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack')!;
    expect(scorePattern(body, im)).toBe(0);
  });
  test('mixed body: D18 picks the higher-scoring pattern', () => {
    // 3 telegram lines + 1 imessage line. Telegram should win.
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
      '**[18:39] \u{1f464} Alice:** three',
      '**Charlie** (2024-03-15 9:00 AM): one imessage',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(r.matched_pattern_id).toBe('telegram-bracket');
  });
});

// ---------------------------------------------------------------------------
// Disabled-builtin honored
// ---------------------------------------------------------------------------

describe('parseConversation — disabledBuiltinIds', () => {
  test('disabling top pattern falls through to next', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const rDefault = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(rDefault.matched_pattern_id).toBe('telegram-bracket');
    const rDisabled = parseConversation(body, {
      fallbackDate: '2024-03-15',
      disabledBuiltinIds: ['telegram-bracket'],
    });
    // No other built-in matches this exact shape → no_match.
    expect(rDisabled.phase).toBe('no_match');
  });
});

// ---------------------------------------------------------------------------
// Multi-line continuation (D5)
// ---------------------------------------------------------------------------

describe('parseConversation — multi-line continuation (D5)', () => {
  test('iMessage continuation absorbs orphan lines', () => {
    const body = [
      '**Alice Example** (2024-03-15 9:00 AM): first line',
      'continuation line',
      'another continuation',
      '**Bob Example** (2024-03-15 9:05 AM): second message',
    ].join('\n');
    const r = parseConversation(body);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].text).toBe(
      'first line\ncontinuation line\nanother continuation',
    );
    expect(r.messages[1].text).toBe('second message');
  });
});

// ---------------------------------------------------------------------------
// Timezone warning (D19)
// ---------------------------------------------------------------------------

describe('parseConversation — timezone warning (D19)', () => {
  test('telegram-bracket emits warning when no timezone in frontmatter', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(r.timezone_warning).toBeDefined();
    expect(r.timezone_warning).toContain('telegram-bracket');
    expect(r.timezone_warning).toContain('UTC');
  });
  test('telegram-bracket does NOT warn when timezone is present', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const page = makePage({
      date: '2024-03-15',
      timezone: 'America/Los_Angeles',
    });
    const r = parseConversation(body, { page });
    expect(r.timezone_warning).toBeUndefined();
  });
  test('imessage-slack does NOT warn (inline_utc policy)', () => {
    const body = '**Alice Example** (2024-03-15 9:00 AM): hello';
    const r = parseConversation(body);
    expect(r.timezone_warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty body + degenerate cases
// ---------------------------------------------------------------------------

describe('parseConversation — degenerate inputs', () => {
  test('empty body returns no_match + empty messages', () => {
    expect(parseConversation('')).toEqual({
      messages: [],
      phase: 'no_match',
    });
  });
  test('non-conversational text returns no_match', () => {
    const r = parseConversation('This is just prose with no chat shape.');
    expect(r.phase).toBe('no_match');
    expect(r.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPattern — direct unit tests for the matcher
// ---------------------------------------------------------------------------

describe('applyPattern — quick_reject fast path (D11)', () => {
  test('telegram quick_reject skips iMessage lines fast', () => {
    const body = '**Alice Example** (2024-03-15 9:00 AM): hello';
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    const r = applyPattern(body, tg, {
      fallbackDate: '2024-03-15',
      source: 'explicit',
    });
    // Quick_reject /^\*\*\[/ rejects '**Alice' (no `[`). Zero matches.
    expect(r).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scorePattern boundary cases
// ---------------------------------------------------------------------------

describe('scorePattern — boundary', () => {
  test('empty body scores 0', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern('', tg)).toBe(0);
  });
  test('only blank lines scores 0', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern('\n\n   \n', tg)).toBe(0);
  });
  // T5 reshape (Codex P2 #6): pins BEHAVIOR not the constant value.
  // The prior test ("100 matching lines score 1.0") would pass with
  // head=10 or head=1000 — it didn't prove anything about the cap.
  test('head cap ignores lines past line 10 (10 match + 1 non-match scores 1.0)', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    const matching = Array.from(
      { length: 10 },
      (_, i) => `**[18:${String(i).padStart(2, '0')}] \u{1f464} Alice:** msg ${i}`,
    );
    const body = [...matching, 'plain text outside the head window'].join('\n');
    // First 10 lines all match → 10/10. Line 11 was ignored.
    expect(scorePattern(body, tg)).toBe(1);
  });
  test('head cap stops at line 10 (9 non-match + 1 match at line 10 + 100 match after scores 0.1)', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    const nonMatches = Array.from({ length: 9 }, (_, i) => `non-matching prose line ${i}`);
    const matchingLate = Array.from(
      { length: 100 },
      (_, i) => `**[18:${String(i).padStart(2, '0')}] \u{1f464} Alice:** msg ${i}`,
    );
    // Line 10 (index 9 in the matching array) IS a match; lines 11-109 are too
    // but are past the head cap and don't count.
    const body = [...nonMatches, matchingLate[0], ...matchingLate.slice(1)].join('\n');
    // Head sees 9 non-matches + 1 match = 1/10 = 0.1. Pre-fix: same result.
    // Post-fix: same result (this test pins head-cap behavior, not the new
    // fallback path — that's tested separately below).
    expect(scorePattern(body, tg)).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// scorePatternFull — direct unit tests (v0.41.18+ T3 #5)
// ---------------------------------------------------------------------------

describe('scorePatternFull — full-body scoring (v0.41.18+ Codex P1 #1)', () => {
  test('empty body scores 0', () => {
    const im = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack')!;
    expect(scorePatternFull('', im)).toBe(0);
  });
  test('preamble + 20 matching lines scores 20/(preamble + 20)', () => {
    const im = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack')!;
    const preamble = ['## Summary', 'Three sentences.', '> Source: ref', '## Transcript'];
    const matches = Array.from(
      { length: 20 },
      (_, i) => `**Garry Tan** (2026-01-29 12:00 PM): message ${i}`,
    );
    const body = [...preamble, ...matches].join('\n');
    // 24 total non-blank, 20 match → 20/24 ≈ 0.833
    expect(scorePatternFull(body, im)).toBeCloseTo(20 / 24, 5);
  });
  test('preamble-only-no-match scores 0', () => {
    const im = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack')!;
    const body = '## Summary\nProse paragraph.\n> Blockquote\n## Heading';
    expect(scorePatternFull(body, im)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bold-paren-time pattern (v0.41.18+ D-FOLLOWUP-1.B; closes user-facing
// half of #1533 — the 112 Circleback meeting files at
// ~/git/brain/meetings/*.md with `source: circleback` frontmatter)
// ---------------------------------------------------------------------------

describe('bold-paren-time pattern (Circleback meeting transcripts)', () => {
  test('matches **Speaker** (HH:MM): text with frontmatter date', () => {
    const body = [
      '**Alice Example** (00:00): Hey, can you hear me?',
      '**Participant 2** (02:22): Yeah, just joined.',
      '**Alice Example** (15:09): That makes sense.',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-03-19' });
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-paren-time');
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]).toEqual({
      speaker: 'Alice Example',
      timestamp: '2026-03-19T00:00:00Z',
      text: 'Hey, can you hear me?',
    });
    expect(r.messages[2]).toEqual({
      speaker: 'Alice Example',
      timestamp: '2026-03-19T15:09:00Z',
      text: 'That makes sense.',
    });
  });

  test('matches **Speaker** (HH:MM:SS): text shape (Circleback seconds variant)', () => {
    const body = [
      '**Participant 1** (00:00:00): opening line',
      '**Participant 2** (00:00:19): quick reply',
      '**Participant 1** (01:23:45): later in the meeting',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-04-01' });
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-paren-time');
    expect(r.messages).toHaveLength(3);
    // Seconds segment is non-capturing; minute_group still captures the
    // minutes component. Time-format is wall-clock 24h on frontmatter date.
    expect(r.messages[0].timestamp).toBe('2026-04-01T00:00:00Z');
    expect(r.messages[1].timestamp).toBe('2026-04-01T00:00:00Z');
    expect(r.messages[2].timestamp).toBe('2026-04-01T01:23:00Z');
  });

  test('imessage-slack shape still wins over bold-paren-time on overlap', () => {
    // Both patterns start with `**` and have parens. The imessage-
    // slack regex requires a full date+time inside; bold-paren-time
    // requires just `(HH:MM)`. The dates-with-AM/PM shape MUST fall
    // through to imessage-slack, not bold-paren-time.
    const body = '**Alice Example** (2024-03-15 9:00 AM): hello world';
    const r = parseConversation(body);
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe('hello world');
  });

  test('meeting page with preamble + bold-paren-time transcript hits fallback', () => {
    // Real Circleback shape: ## Summary + blockquote + ## Transcript
    // before the bold-paren-time chat. Same fallback gate that
    // closes #1533 must work for this pattern too.
    const preamble = [
      '## Summary',
      'Meeting covered Q1 roadmap discussion.',
      '> Source: circleback meeting #7411053',
      '## Topics Discussed',
      '- Roadmap',
      '- Hiring',
      '## Transcript',
    ];
    const transcript = Array.from(
      { length: 20 },
      (_, i) => `**Participant 2** (${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i * 11) % 60).padStart(2, '0')}): transcript line ${i}`,
    );
    const body = [...preamble, ...transcript].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-03-19' });
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-paren-time');
    expect(r.messages).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// bold-name-no-time pattern (Circleback / Granola / Zoom transcripts with NO
// per-line timestamp — `**Speaker:** text`). Additive pattern; the colon
// inside the bold markers + the `(?!\[)` lookahead are what keep it from
// shadowing bold-paren-time / telegram-bracket (NOT declaration order).
// ---------------------------------------------------------------------------

describe('bold-name-no-time pattern (Circleback/Granola/Zoom, no timestamp)', () => {
  test('parses **Speaker:** text transcript with frontmatter date anchor', () => {
    const body = [
      '**Alice Example:** Okay, start on. And then weirdly like zoom doesn’t...',
      '**Participant 2:** he tried to reset it remotely the other night. Let me ask him.',
      '**Alice Example:** I mean it’s really just like we need to get zoom to fix this.',
      '**Participant 2:** Okay, let me.',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-05-28' });
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-name-no-time');
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0]).toEqual({
      speaker: 'Alice Example',
      timestamp: '2026-05-28T00:00:00Z',
      text: 'Okay, start on. And then weirdly like zoom doesn’t...',
    });
    expect(r.messages[1].speaker).toBe('Participant 2');
    expect(r.messages[1].text).toBe(
      'he tried to reset it remotely the other night. Let me ask him.',
    );
    expect(r.messages[3]).toEqual({
      speaker: 'Participant 2',
      timestamp: '2026-05-28T00:00:00Z',
      text: 'Okay, let me.',
    });
    // No-time pattern anchors at 00:00:00 of the frontmatter date
    // (same convention as irc-classic). No wall-clock time fabricated.
  });

  test('scores above the 0.05 floor on a pure bold-name transcript (epoch default)', () => {
    const body = [
      '**Alice Example:** line one',
      '**Participant 2:** line two',
      '**Alice Example:** line three',
    ].join('\n');
    const r = parseConversation(body);
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-name-no-time');
    expect(r.messages).toHaveLength(3);
    // No fallbackDate → epoch default, still anchors at 00:00:00.
    expect(r.messages[0].timestamp).toBe('1970-01-01T00:00:00Z');
  });

  // REGRESSION: must NOT shadow bold-paren-time. A `**Name** (00:00): text`
  // line has its colon OUTSIDE the bold markers, so it must still parse via
  // bold-paren-time (the safety is the regex, not declaration order).
  test('REGRESSION: **Speaker** (HH:MM): text still matches bold-paren-time', () => {
    const body = [
      '**Alice Example** (00:00): Hey, can you hear me?',
      '**Participant 2** (02:22): Yeah, just joined.',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-03-19' });
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('bold-paren-time');
    expect(r.matched_pattern_id).not.toBe('bold-name-no-time');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].timestamp).toBe('2026-03-19T00:00:00Z');
  });

  // REGRESSION: a pure telegram-bracket transcript has the colon inside the
  // bold markers BUT the speaker starts with `[`, so the `(?!\[)` lookahead
  // rejects it AND telegram-bracket (lower declaration index) wins anyway.
  test('REGRESSION: telegram-bracket transcript still matches telegram-bracket', () => {
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(r.matched_pattern_id).toBe('telegram-bracket');
  });

  // F1 (Codex): the broad regex matches any `**Label:** text`. A prose notes
  // page with bold labels CLUSTERED in its first 10 lines scores 0.3 on the
  // head pass (3/10) — NOT < SCORING_HEAD_TRIGGER_THRESHOLD (0.3), so the
  // full-body fallback never fires — and that 0.3 clears the 0.05 floor.
  // Without score_full_body this page would mis-parse as a conversation.
  // score_full_body recomputes the winner over the FULL body: 3 labels /
  // 83 lines ≈ 0.036 < 0.05 → no_match. This is the exact bug Codex caught
  // and the test the naive "0.05 floor protects us" assumption would fail.
  test('F1: prose with bold labels clustered in the head returns no_match', () => {
    const lines = [
      '**Attendees:** Alice Example, Bob Example, Participant 2',
      '**Date:** 2026-05-28',
      '**Goal:** decide on the Q3 roadmap and unblock the vendor migration',
    ];
    // 80 plain prose lines (no bold-label shape) → 83 total, only 3 match.
    // First 10 lines = 3 labels + 7 prose → head score 0.3 (skips rescore).
    // Full body = 3/83 ≈ 0.036 < 0.05 floor.
    for (let i = 0; i < 80; i++) {
      lines.push(
        `This is an ordinary prose sentence number ${i} describing the meeting in detail.`,
      );
    }
    const body = lines.join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-05-28' });
    expect(r.phase).toBe('no_match');
  });
});

// ---------------------------------------------------------------------------
// parseConversation — full-body fallback (v0.41.18+ #1533 + Codex P1 #1, #2, #8)
// ---------------------------------------------------------------------------

describe('parseConversation — full-body fallback', () => {
  // T3 #1: IRON-RULE regression pin for #1533. Pre-fix this returns
  // no_match because head 10 sees only preamble.
  test('#1533: meeting page with ## Summary + blockquote + ## Transcript before chat hits fallback', () => {
    const preamble = [
      '## Summary',
      'This meeting covered Q1 roadmap discussion.',
      'Three engineers participated in the call.',
      'Action items were captured during the conversation.',
      '> Source: [meeting recording](https://example.com/rec/123)',
      '## Topics Discussed',
      '- Product roadmap for Q1',
      '- Engineering team allocation',
      '- Customer feedback synthesis',
      '## Transcript',
    ];
    const transcript = Array.from(
      { length: 20 },
      (_, i) => `**Garry Tan** (2026-01-29 12:00 PM): line ${i}`,
    );
    const body = [...preamble, ...transcript].join('\n');
    const r = parseConversation(body);
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages).toHaveLength(20);
  });

  // T3 #2: diagnostic now reports total_non_blank - matched, not total.
  test('#1533: unmatched_line_count subtracts matched messages after fallback', () => {
    const preamble = [
      '## Summary',
      'Prose A.',
      'Prose B.',
      '> Blockquote',
      '## Transcript',
    ];
    const transcript = Array.from(
      { length: 20 },
      (_, i) => `**Garry Tan** (2026-01-29 12:00 PM): line ${i}`,
    );
    const body = [...preamble, ...transcript].join('\n');
    const r = parseConversation(body, { diagnostic: true });
    expect(r.phase).toBe('regex_match');
    expect(r.unmatched_line_count).toBe(5); // 25 total non-blank - 20 messages = 5
  });

  // T3 #3: a 50-line essay with no chat shape stays no_match.
  test('pure-prose 50-line essay stays no_match (fallback found nothing to anchor)', () => {
    const body = Array.from(
      { length: 50 },
      (_, i) => `This is the ${i + 1}th paragraph of a pure-prose article.`,
    ).join('\n');
    const r = parseConversation(body);
    expect(r.phase).toBe('no_match');
    expect(r.messages).toHaveLength(0);
  });

  // T3 #4: proves "full-body" not just "wider window" — 300-line preamble
  // far exceeds any reasonable head-bump alternative.
  test('300-line preamble + 50 chat lines hits fallback (any preamble length)', () => {
    const preamble = Array.from(
      { length: 300 },
      (_, i) => `Preamble paragraph ${i + 1} with prose content here.`,
    );
    const transcript = Array.from(
      { length: 50 },
      (_, i) => `**Garry Tan** (2026-01-29 12:00 PM): chat line ${i}`,
    );
    const body = [...preamble, ...transcript].join('\n');
    const r = parseConversation(body);
    expect(r.phase).toBe('regex_match');
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages).toHaveLength(50);
  });

  // T3 #6 (Codex P1 #1 + #8): stray-head-match doesn't suppress fallback.
  // Pre-fix: irc-classic 0.1 in head → no fallback → irc-classic wins with 1
  // message. Post-fix: 0.1 < 0.3 trigger → fallback re-scores → imessage-slack
  // wins (50/60 ≈ 0.83 vs irc-classic 1/60 ≈ 0.017).
  test('Codex P1 #1: stray irc-classic match in head does not suppress fallback', () => {
    const preamble = [
      '## Meeting Notes',
      '<presenter> Garry Tan opening remarks', // stray irc-classic match
      '- agenda item 1',
      '- agenda item 2',
      '- agenda item 3',
      '- agenda item 4',
      '- agenda item 5',
      '- agenda item 6',
      '- agenda item 7',
      '## Transcript',
    ];
    const transcript = Array.from(
      { length: 50 },
      (_, i) => `**Garry Tan** (2024-01-29 12:00 PM): real transcript line ${i}`,
    );
    const body = [...preamble, ...transcript].join('\n');
    const r = parseConversation(body);
    expect(r.phase).toBe('regex_match');
    // The critical assertion: imessage-slack wins, NOT irc-classic.
    expect(r.matched_pattern_id).toBe('imessage-slack');
    expect(r.messages).toHaveLength(50);
  });

  // T3 #7 (Codex P1 #2): essay with one stray chat-shape line stays
  // no_match. 1/301 ≈ 0.003, below SCORING_MIN_ACCEPTANCE (0.05).
  test('Codex P1 #2: 300-line essay with one stray chat line stays no_match (acceptance floor)', () => {
    const prose = Array.from(
      { length: 150 },
      (_, i) => `Essay paragraph ${i + 1} of pure prose with no chat shape.`,
    );
    const strayChatLine = '**Author Name** (2024-01-01 9:00 AM): stray quoted snippet';
    const morePros = Array.from(
      { length: 150 },
      (_, i) => `Essay continuation paragraph ${i + 151}.`,
    );
    const body = [...prose, strayChatLine, ...morePros].join('\n');
    const r = parseConversation(body);
    // Pre-fix: regex_match with messages.length === 1.
    // Post-fix: no_match because 1/301 < 0.05 acceptance floor.
    expect(r.phase).toBe('no_match');
    expect(r.messages).toHaveLength(0);
  });
});
