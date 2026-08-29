/**
 * Reasoning-model (`<think>` block) JSON recovery.
 *
 * Models with visible chain-of-thought (DeepSeek-R1, MiniMax M2.x/M3, and any
 * model configured to show thinking) emit reasoning in the SAME text channel as
 * the answer, before it. Because the model usually drafts its JSON while
 * reasoning, that block contains braces/brackets — which defeats the
 * substring-scan strategies in the JSON extractors: the scan starts at a brace
 * inside the reasoning and never parses a valid answer.
 *
 * The fix is a fallback LADDER (raw first, stripped only on failure), so
 * behaviour for models that never emit reasoning is byte-identical.
 *
 * NOTE: every assertion here goes through the PUBLIC parse entry points, all of
 * which exist pre-fix. Importing the new `stripReasoningBlocks` helper directly
 * would turn a reverted-source run into a module-load SyntaxError — the vacuous
 * failure class in CONTRIBUTING.md, where nothing actually executes.
 */
import { describe, expect, test } from 'bun:test';
import { parseLlmJson } from '../src/core/llm-json.ts';
import { parseExtractorJson } from '../src/core/facts/extract.ts';
import { parseAtomsOutcome } from '../src/core/cycle/extract-atoms.ts';

describe('parseLlmJson — reasoning ladder', () => {
  test('recovers the ANSWER, not the draft inside a closed <think> block', () => {
    // Pre-fix: the greedy {...} scan spans draft-open → answer-close and fails.
    const raw = '<think>I will answer {"answer":"draft"} probably</think>{"answer":"final"}';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('recovers when the reasoning block was truncated and never closed', () => {
    // Output budget exhausted mid-reasoning, after the answer was emitted.
    const raw = '{"answer":"final"}<think>ran out of budget {"b"';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('is case-insensitive about the tag', () => {
    const raw = '<THINK>draft {"answer":"draft"}</THINK>{"answer":"final"}';
    expect(parseLlmJson<{ answer: string }>(raw)).toEqual({ answer: 'final' });
  });

  test('recovers an array payload', () => {
    const raw = '<think>maybe [1,2] ?</think>[3,4]';
    expect(parseLlmJson<number[]>(raw, { array: true })).toEqual([3, 4]);
  });

  test('is a ladder, not a pre-filter: valid JSON containing "<think>" is untouched', () => {
    // Stripping first would corrupt this perfectly valid payload. This case
    // passes both pre- and post-fix by design — it guards the ladder ordering.
    const raw = '{"note":"the <think> tag is literal here"}';
    expect(parseLlmJson<{ note: string }>(raw)).toEqual({
      note: 'the <think> tag is literal here',
    });
  });

  test('still returns null when there is no JSON at all', () => {
    expect(parseLlmJson('<think>only reasoning, no answer</think>')).toBeNull();
    expect(parseLlmJson('')).toBeNull();
  });
});

describe('extractors route through the ladder', () => {
  test('facts extractor parses a think-wrapped payload instead of reporting malformed', () => {
    const raw = '<think>candidates: {"facts":[{"fact":"draft"}]}</think>' +
      '{"facts":[{"fact":"Nathan coaches swimming","kind":"identity","notability":"high"}]}';
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0]!.fact).toBe('Nathan coaches swimming');
  });

  test('atoms extractor parses a think-wrapped array instead of halting', () => {
    const raw = '<think>I could emit [ "draft" ]</think>[{"claim":"Water is wet","kind":"fact"}]';
    const outcome = parseAtomsOutcome(raw);
    expect(outcome.ok).toBe(true);
  });

  test('atoms extractor preserves the ORIGINAL failure reason when the retry also fails', () => {
    // This input actually ENTERS the retry branch: the raw parse finds the
    // '[' drafted inside <think> and fails as an unterminated array (no ']'
    // anywhere), while the STRIPPED retry has no bracket at all and would
    // fail with the DIFFERENT reason 'no JSON array in response'. The ladder
    // must discard the failed retry and return the raw parse's reason —
    // asserting the exact string proves which of the two came back.
    const raw = '<think>draft: [1, 2</think>and then some prose';
    const outcome = parseAtomsOutcome(raw);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unterminated JSON array');
  });

  test('atoms extractor: non-reasoning garbage returns the direct reason untouched (strip is a no-op)', () => {
    // Regression guard: the ladder must not mask error reporting for models
    // that never emit reasoning blocks — stripping changes nothing here, so
    // the retry never runs and the direct outcome passes through.
    const outcome = parseAtomsOutcome('not json at all');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('no JSON array');
  });
});
