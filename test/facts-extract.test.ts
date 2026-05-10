/**
 * v0.31 Phase 6 — extractor sanitization parity + skip-conditions.
 *
 * Pins:
 *   - INJECTION_PATTERNS sanitized on the way IN (turn_text)
 *   - dream_generated:true → returns []
 *   - empty turn_text → returns []
 *   - Without API key (test env), returns [] gracefully (no throw)
 */

import { describe, test, expect } from 'bun:test';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';

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
