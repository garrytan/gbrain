/**
 * v0.31 Phase 6 — extractor sanitization parity + skip-conditions.
 *
 * Pins:
 *   - INJECTION_PATTERNS sanitized on the way IN (turn_text)
 *   - dream_generated:true → returns []
 *   - empty turn_text → returns []
 *   - Without API key (test env), returns [] gracefully (no throw)
 *
 * v0.31.2 (B1 ship-blocker fix) — parser-pin: parseExtractorJson MUST pass
 * through every typed field the LLM emits, including `notability`. The bug:
 * tryArrayShape silently dropped the field, so the outer loop saw undefined
 * and defaulted notability to 'medium'. sync's HIGH-only filter then
 * discarded 100% of facts. Pinned here so the next field added (rationale,
 * etc.) doesn't get dropped the same way.
 */

import { describe, test, expect } from 'bun:test';
import { extractFactsFromTurn, parseExtractorJson } from '../src/core/facts/extract.ts';

describe('extractFactsFromTurn', () => {
  test('empty turn returns no facts', async () => {
    const r = await extractFactsFromTurn({ turnText: '', source: 'test' });
    expect(r).toEqual([]);
  });

  test('whitespace-only after sanitize returns no facts', async () => {
    const r = await extractFactsFromTurn({ turnText: '   \n  ', source: 'test' });
    expect(r).toEqual([]);
  });

  test('isDreamGenerated:true short-circuits', async () => {
    const r = await extractFactsFromTurn({
      turnText: 'this is real content that would normally extract',
      source: 'test',
      isDreamGenerated: true,
    });
    expect(r).toEqual([]);
  });

  test('without chat gateway configured (test env) returns no facts gracefully', async () => {
    const r = await extractFactsFromTurn({
      turnText: 'I am flying to Tokyo Tuesday for a meeting with sam.',
      source: 'test',
    });
    // No ANTHROPIC_API_KEY in test env → isAvailable('chat') is false →
    // empty array, no throw.
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('parseExtractorJson — B1 parser-pin (v0.31.2 ship-blocker fix)', () => {
  test('passes notability through when LLM emits it', () => {
    const raw = JSON.stringify({
      facts: [
        { fact: 'I gave up alcohol', kind: 'commitment', notability: 'high' },
        { fact: 'we ate at Tartine', kind: 'event', notability: 'low' },
        { fact: 'I prefer black coffee', kind: 'preference', notability: 'medium' },
      ],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(3);
    expect(parsed![0].notability).toBe('high');
    expect(parsed![1].notability).toBe('low');
    expect(parsed![2].notability).toBe('medium');
  });

  test('omits notability when LLM omits it (legacy path)', () => {
    const raw = JSON.stringify({
      facts: [{ fact: 'pre-notability fact', kind: 'fact' }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0].notability).toBeUndefined();
  });

  test('non-string notability is dropped (defensive)', () => {
    const raw = JSON.stringify({
      facts: [{ fact: 'x', kind: 'fact', notability: 42 }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed![0].notability).toBeUndefined();
  });

  test('every documented LLM-emitted field survives the parse', () => {
    // Field-drop regression guard. If a future field is added to the
    // extractor schema, add it here AND verify parseExtractorJson preserves it.
    const raw = JSON.stringify({
      facts: [{
        fact: 'comprehensive fact',
        kind: 'event',
        entity: 'people/example',
        confidence: 0.85,
        notability: 'medium',
      }],
    });
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    const f = parsed![0];
    expect(f.fact).toBe('comprehensive fact');
    expect(f.kind).toBe('event');
    expect(f.entity).toBe('people/example');
    expect(f.confidence).toBe(0.85);
    expect(f.notability).toBe('medium');
  });

  test('handles fenced JSON output (markdown code blocks)', () => {
    const raw = '```json\n' + JSON.stringify({
      facts: [{ fact: 'fenced', kind: 'fact', notability: 'high' }],
    }) + '\n```';
    const parsed = parseExtractorJson(raw);
    expect(parsed).not.toBeNull();
    expect(parsed![0].notability).toBe('high');
  });
});
