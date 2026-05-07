import { describe, expect, test } from 'bun:test';

import { parseModelJSON } from '../src/core/cross-modal-eval/json-repair.ts';

describe('cross-modal-eval/json-repair', () => {
  test('parses clean JSON', () => {
    const raw = JSON.stringify({
      scores: {
        goal: { score: 9, feedback: 'on point' },
        depth: { score: 8 },
      },
      overall: 8.5,
      improvements: ['1. tighten the intro'],
    });
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(9);
    expect(out.scores.depth!.score).toBe(8);
    expect(out.overall).toBe(8.5);
    expect(out.improvements).toEqual(['1. tighten the intro']);
  });

  test('strips ```json markdown fences', () => {
    const raw = '```json\n{"scores": {"goal": {"score": 7}}, "improvements": []}\n```';
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
  });

  test('strips bare ``` fences too', () => {
    const raw = '```\n{"scores": {"goal": {"score": 7}}, "improvements": []}\n```';
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
  });

  test('repairs trailing commas before } and ]', () => {
    const raw = '{"scores": {"goal": {"score": 7,},}, "improvements": ["1. tighten",],}';
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
    expect(out.improvements).toEqual(['1. tighten']);
  });

  test('repairs single-quote string delimiters', () => {
    const raw = "{'scores': {'goal': {'score': 7}}, 'improvements': ['1. tighten']}";
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
  });

  test('repairs embedded newlines inside strings', () => {
    const raw = '{"scores": {"goal": {"score": 7, "feedback": "line one\nline two"}}, "improvements": []}';
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
    expect(out.scores.goal!.feedback).toContain('line one');
  });

  test('nuclear option: reconstructs scores from mismatched-brace input', () => {
    // Outer object intentionally unclosed; strategies 1-3 fail, nuclear regex
    // walks the dim:{score:N} pattern at the top level.
    const raw =
      '{ "goal": { "score": 8, "feedback": "good" }, "depth": { "score": 7 }, ' +
      '"overall": 7.5, ' +
      '"improvements": ["1. add concrete examples", "2. tighten the intro"] ';
    const out = parseModelJSON(raw);
    expect(out._repaired).toBe(true);
    expect(out.scores.goal!.score).toBe(8);
    expect(out.scores.depth!.score).toBe(7);
    expect(out.improvements.length).toBeGreaterThan(0);
  });

  test('nuclear option: throws when zero scores recoverable (no fabrication)', () => {
    const raw = 'this is not even close to JSON, just prose with random {"wonky" } shapes';
    expect(() => parseModelJSON(raw)).toThrow();
  });

  test('throws on empty input', () => {
    expect(() => parseModelJSON('')).toThrow();
    expect(() => parseModelJSON('   ')).toThrow();
  });

  test('throws when no { ... } object substring exists', () => {
    expect(() => parseModelJSON('just a plain string with no braces at all')).toThrow();
  });

  test('numeric-shorthand scores are accepted ({"dim": 7})', () => {
    const raw = '{"scores": {"goal": 7, "depth": 8}, "improvements": ["1. x"]}';
    const out = parseModelJSON(raw);
    expect(out.scores.goal!.score).toBe(7);
    expect(out.scores.depth!.score).toBe(8);
  });
});
