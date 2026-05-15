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
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';

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
});
