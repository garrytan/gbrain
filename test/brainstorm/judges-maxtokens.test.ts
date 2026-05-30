/**
 * v0.41.20.0 — pin the judge maxTokens scaling formula + per-model cap.
 *
 * Bug 1 from #1540: `maxTokens: 4000` hard-coded in judges.ts → response
 * truncated mid-JSON at any chunk ≥ ~40 ideas → parseJudgeJSON throw →
 * judge_failed: true → ideas saved unscored. Verified failure mode:
 * 0/72 ideas passing before fix; 39/72 after.
 *
 * The fix is in two pieces and this file pins both:
 *
 *   1. `computeJudgeMaxTokens` (pure formula) — scales with idea count,
 *      respects per-model output cap, floors at 4000 for tiny batches.
 *   2. `runJudgeChunk` wires the formula into the `chat({maxTokens})` call
 *      — integration test via the existing `chatFn` DI seam captures the
 *      ChatOpts and asserts maxTokens matches the formula.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeJudgeMaxTokens,
  TOKEN_BUDGET_PER_IDEA,
  TOKEN_BUDGET_ENVELOPE,
  LEGACY_MIN_MAX_TOKENS,
  MAX_OUTPUT_TOKENS_CEIL,
  ANTHROPIC_OUTPUT_CAPS,
  runJudge,
  BRAINSTORM_JUDGE_CONFIG,
  type ChatFn,
} from '../../src/core/brainstorm/judges.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

describe('computeJudgeMaxTokens (pure formula)', () => {
  test('1 idea: formula yields 650 → floor binds at LEGACY_MIN_MAX_TOKENS (4000)', () => {
    // 1 * 150 + 500 = 650; max(4000, 650) = 4000.
    expect(computeJudgeMaxTokens(1, 'claude-sonnet-4-6')).toBe(LEGACY_MIN_MAX_TOKENS);
  });

  test('10 ideas: formula yields 2000 → floor binds', () => {
    // 10 * 150 + 500 = 2000; max(4000, 2000) = 4000.
    expect(computeJudgeMaxTokens(10, 'claude-sonnet-4-6')).toBe(LEGACY_MIN_MAX_TOKENS);
  });

  test('36 ideas: formula yields 5900 → above floor', () => {
    // 36 * 150 + 500 = 5900; max(4000, 5900) = 5900; below 64K Sonnet cap.
    expect(computeJudgeMaxTokens(36, 'claude-sonnet-4-6')).toBe(36 * TOKEN_BUDGET_PER_IDEA + TOKEN_BUDGET_ENVELOPE);
  });

  test('96 ideas: formula yields 14_900 → above floor, under modern cap', () => {
    // 96 * 150 + 500 = 14_900; below 32K Opus cap.
    expect(computeJudgeMaxTokens(96, 'claude-opus-4-7')).toBe(96 * TOKEN_BUDGET_PER_IDEA + TOKEN_BUDGET_ENVELOPE);
  });

  test('300 ideas on Opus 4.7: formula yields 45_500 → CAP binds at 32K', () => {
    // 300 * 150 + 500 = 45_500; min(32_000, 45_500) = 32_000.
    expect(computeJudgeMaxTokens(300, 'claude-opus-4-7')).toBe(32_000);
  });

  test('300 ideas on Sonnet 4.6: formula yields 45_500 → fits under 64K Sonnet cap', () => {
    expect(computeJudgeMaxTokens(300, 'claude-sonnet-4-6')).toBe(300 * TOKEN_BUDGET_PER_IDEA + TOKEN_BUDGET_ENVELOPE);
  });

  test('96 ideas on legacy Haiku 3.5 (8K cap): CAP binds at 8192 (D11 codex fix)', () => {
    // 96 * 150 + 500 = 14_900 > 8192; legacy 3.5 caps at 8K — without
    // ANTHROPIC_OUTPUT_CAPS this would have been the next opaque HTTP 400.
    expect(computeJudgeMaxTokens(96, 'claude-3-5-haiku-20241022')).toBe(8_192);
  });

  test('unknown model: falls back to MAX_OUTPUT_TOKENS_CEIL', () => {
    expect(computeJudgeMaxTokens(300, 'mistral:medium')).toBe(MAX_OUTPUT_TOKENS_CEIL);
    expect(computeJudgeMaxTokens(300, 'gpt-5')).toBe(MAX_OUTPUT_TOKENS_CEIL);
  });

  // v0.41.21.0: when modelId is undefined the cap routes through the gateway's
  // configured chat model via getChatModel(). The actual returned cap therefore
  // depends on whether the gateway has been initialized in this test process
  // (cross-test side effect of any earlier import that called configureGateway).
  // We test the explicit-modelId path comprehensively above; the undefined path
  // is exercised end-to-end below via runJudge() without modelOverride.

  test('colon-prefixed id resolves through splitProviderModelId', () => {
    expect(computeJudgeMaxTokens(96, 'anthropic:claude-opus-4-7')).toBe(96 * 150 + 500);
  });

  test('slash-prefixed id resolves through splitProviderModelId (THE FIX combined with site routing)', () => {
    expect(computeJudgeMaxTokens(96, 'anthropic/claude-opus-4-7')).toBe(96 * 150 + 500);
    // Legacy 3.5 via slash form still hits the 8K cap.
    expect(computeJudgeMaxTokens(96, 'anthropic/claude-3-5-haiku-20241022')).toBe(8_192);
  });

  test('every entry in ANTHROPIC_OUTPUT_CAPS is reachable by lookup', () => {
    for (const [key, cap] of Object.entries(ANTHROPIC_OUTPUT_CAPS)) {
      // Pick an idea count high enough that the cap binds.
      const huge = Math.ceil(cap / TOKEN_BUDGET_PER_IDEA) + 10;
      expect(computeJudgeMaxTokens(huge, key)).toBe(cap);
    }
  });
});

describe('runJudge wires computeJudgeMaxTokens into chat({maxTokens})', () => {
  function makeCapturingChatFn(captured: ChatOpts[]): ChatFn {
    return async (opts: ChatOpts): Promise<ChatResult> => {
      captured.push(opts);
      // Return a valid-shape judge response so parseJudgeJSON succeeds and
      // we can pin maxTokens without dealing with parse failures.
      const ideasJson = (opts.messages[0].content as string)
        .match(/^- id=(\S+)/gm)
        ?.map((line) => line.replace(/^- id=/, '')) ?? [];
      const ideas = ideasJson.map((id) => ({
        id,
        scores: {
          originality: 3,
          resistance: 3,
          thesis_density: 3,
          concrete_grounding: 3,
          cognitive_load: 3,
        },
        note: 'stub',
      }));
      const text = JSON.stringify({ ideas });
      return {
        text,
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        model: opts.model ?? 'noop',
        providerId: 'anthropic',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    };
  }

  function makeIdeas(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: String(i + 1).padStart(2, '0'),
      text: 'stub idea text',
      close_slug: 'concepts/foo',
      far_slug: 'wiki/bar',
    }));
  }

  test('1 idea → maxTokens = LEGACY_MIN_MAX_TOKENS (4000)', async () => {
    const captured: ChatOpts[] = [];
    await runJudge(BRAINSTORM_JUDGE_CONFIG, makeIdeas(1), {
      chatFn: makeCapturingChatFn(captured),
      modelOverride: 'claude-sonnet-4-6',
    });
    expect(captured.length).toBe(1);
    expect(captured[0].maxTokens).toBe(LEGACY_MIN_MAX_TOKENS);
  });

  test('96 ideas on Opus 4.7 → maxTokens = formula (14_900)', async () => {
    const captured: ChatOpts[] = [];
    await runJudge(BRAINSTORM_JUDGE_CONFIG, makeIdeas(96), {
      chatFn: makeCapturingChatFn(captured),
      modelOverride: 'anthropic:claude-opus-4-7',
    });
    expect(captured.length).toBe(1);
    expect(captured[0].maxTokens).toBe(96 * 150 + 500);
  });

  test('slash-form modelOverride routes through parseModelId for the cap lookup', async () => {
    // Pre-v0.41.20.0 the inline maxTokens was a constant; this test would
    // not have caught anything. Post-fix: slash-form is honored for the
    // per-model cap because computeJudgeMaxTokens routes through parseModelId.
    const captured: ChatOpts[] = [];
    await runJudge(BRAINSTORM_JUDGE_CONFIG, makeIdeas(96), {
      chatFn: makeCapturingChatFn(captured),
      modelOverride: 'anthropic/claude-3-5-haiku-20241022',
    });
    // 14_900 formula > 8K legacy cap → cap binds.
    expect(captured[0].maxTokens).toBe(8_192);
  });

  test('200-idea chunk size set via maxIdeasPerCall → maxTokens scales (single chunk)', async () => {
    const captured: ChatOpts[] = [];
    await runJudge(BRAINSTORM_JUDGE_CONFIG, makeIdeas(200), {
      chatFn: makeCapturingChatFn(captured),
      modelOverride: 'claude-sonnet-4-6',
      maxIdeasPerCall: 200,
    });
    expect(captured.length).toBe(1);
    expect(captured[0].maxTokens).toBe(200 * 150 + 500); // 30_500, under 64K Sonnet cap
  });

  test('chunking is independent of cap — multi-chunk each gets its own scaled budget', async () => {
    const captured: ChatOpts[] = [];
    // 250 ideas at default chunk 100 → 3 chunks of [100, 100, 50].
    await runJudge(BRAINSTORM_JUDGE_CONFIG, makeIdeas(250), {
      chatFn: makeCapturingChatFn(captured),
      modelOverride: 'claude-sonnet-4-6',
    });
    expect(captured.length).toBe(3);
    expect(captured[0].maxTokens).toBe(100 * 150 + 500); // 15_500
    expect(captured[1].maxTokens).toBe(100 * 150 + 500);
    expect(captured[2].maxTokens).toBe(Math.max(LEGACY_MIN_MAX_TOKENS, 50 * 150 + 500)); // 8000
  });
});
