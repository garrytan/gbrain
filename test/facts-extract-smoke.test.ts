/**
 * v0.31.2 (B1 ship-blocker fix) — end-to-end smoke for the notability-aware
 * extraction pipeline.
 *
 * Pins:
 *   - A known-HIGH input that returns notability:'high' from the LLM is
 *     correctly threaded through extractFactsFromTurn into ExtractedFact.
 *   - parser → outer loop → push() preserves the LLM's notability tier.
 *   - This guards against (a) the original B1 bug (parser dropped the field)
 *     AND (b) future prompt drift where Sonnet returns 'medium' for
 *     everything (smoke fails loudly so the eval-mining flow gets triggered).
 *
 * Uses `__setChatTransportForTests` to stub the LLM call deterministically.
 * The embed call is left to fail (no gateway config) — extract.ts's catch
 * absorbs that into a NULL embedding, which is fine for this smoke.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { extractFactsFromTurn, shouldSkipTurnForFactsExtraction, normalizeExtractedFactKind } from '../src/core/facts/extract.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('extractFactsFromTurn — B1 end-to-end smoke', () => {
  test('notability:high from stubbed LLM survives all the way to ExtractedFact', async () => {
    // Stub the LLM to return what a well-tuned Sonnet would emit for a
    // life-event input.
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [
          {
            fact: 'Sold the company today',
            kind: 'event',
            entity: null,
            confidence: 1.0,
            notability: 'high',
          },
        ],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));

    const facts = await extractFactsFromTurn({
      turnText: 'I sold the company today.',
      source: 'test:smoke',
    });

    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('Sold the company today');
    expect(facts[0].kind).toBe('event');
    // The headline assertion. If notability is 'medium' here, B1 has
    // re-regressed (or a new field-drop bug landed).
    expect(facts[0].notability).toBe('high');
  });

  test('notability:low from stubbed LLM also threads through correctly', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [
          {
            fact: 'we ate at Tartine',
            kind: 'event',
            entity: null,
            confidence: 0.9,
            notability: 'low',
          },
        ],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));

    const facts = await extractFactsFromTurn({
      turnText: 'we ate at Tartine for breakfast',
      source: 'test:smoke',
    });

    expect(facts).toHaveLength(1);
    expect(facts[0].notability).toBe('low');
  });

  test('LLM omitting notability defaults to medium (legacy compat)', async () => {
    // Older prompt versions (pre-v0.31.2) didn't ask for notability. The
    // outer loop's default keeps backward compatibility.
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [
          { fact: 'something happened', kind: 'event', entity: null, confidence: 1.0 },
        ],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));

    const facts = await extractFactsFromTurn({
      turnText: 'something happened',
      source: 'test:smoke',
    });

    expect(facts).toHaveLength(1);
    expect(facts[0].notability).toBe('medium');
  });

  test('mixed-tier batch — every tier survives in correct order', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: [
          { fact: 'separation', kind: 'event', entity: null, confidence: 1.0, notability: 'high' },
          { fact: 'I prefer dark roast', kind: 'preference', entity: null, confidence: 0.9, notability: 'medium' },
          { fact: 'parking spot 4B', kind: 'fact', entity: null, confidence: 0.8, notability: 'low' },
        ],
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));

    const facts = await extractFactsFromTurn({
      turnText: 'long meeting transcript',
      source: 'test:smoke',
    });

    expect(facts).toHaveLength(3);
    expect(facts.map(f => f.notability)).toEqual(['high', 'medium', 'low']);
  });

  test('deterministic pre-filter skips transient tasks before calling chat', async () => {
    let chatCalled = false;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalled = true;
      return {
        text: JSON.stringify({ facts: [{ fact: 'Should not be extracted', kind: 'fact' }] }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    expect(shouldSkipTurnForFactsExtraction('Can you look at GitHub and tell me if this is a good skill?')).toBe(true);
    const facts = await extractFactsFromTurn({
      turnText: 'Can you look at GitHub and tell me if this is a good skill?',
      source: 'test:prefilter',
    });

    expect(facts).toEqual([]);
    expect(chatCalled).toBe(false);
  });

  test('deterministic pre-filter keeps durable style feedback and rules', () => {
    expect(shouldSkipTurnForFactsExtraction('can you summarize all of this high level for me, too long')).toBe(false);
    expect(shouldSkipTurnForFactsExtraction('make sure all agents use the 1-3-1 rule for asking me questions')).toBe(false);
    expect(shouldSkipTurnForFactsExtraction('Smoke test. Reply exactly: OK')).toBe(true);
    expect(shouldSkipTurnForFactsExtraction('yes')).toBe(true);
  });

  test('kind normalizer pins high-signal preferences, commitments, beliefs, and metrics', () => {
    expect(normalizeExtractedFactKind('fact', 'Brad likes tables in code blocks', 'tables are not bad. I like tables in code blocks.', false)).toBe('preference');
    expect(normalizeExtractedFactKind('belief', 'All agents use the 1-3-1 rule', 'make sure all agents use the 1-3-1 rule for asking me questions', false)).toBe('commitment');
    expect(normalizeExtractedFactKind('fact', 'The software-development folder is redundant', 'Actually I think the software-development folder is redundant', false)).toBe('belief');
    expect(normalizeExtractedFactKind('event', 'MRR is $50K', 'MRR is $50K', true)).toBe('fact');
  });

  test('kind normalizer does not smear a decision marker across preference facts in multi-claim turns', () => {
    const turn = 'I prefer concise fact extraction candidates. I decided to use private Gemma for GBrain fact extraction.';
    expect(normalizeExtractedFactKind('commitment', 'prefer concise fact extraction candidates', turn, false)).toBe('preference');
    expect(normalizeExtractedFactKind('fact', 'decided to use private Gemma for GBrain fact extraction', turn, false)).toBe('commitment');
  });
});
