import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

function stubFacts(facts: unknown[]): void {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts }),
    blocks: [],
    stopReason: 'end',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'test:stub',
    providerId: 'test',
  }));
}

async function extract() {
  return extractFactsFromTurnWithOutcome({
    turnText: 'Conversation segment under test.',
    source: 'test:salvage',
  });
}

describe('facts extractor candidate salvage (#3866)', () => {
  test('keeps valid facts when another candidate is malformed', async () => {
    stubFacts([
      {
        fact: 'The migration completed',
        kind: 'event',
        entity: null,
        confidence: 1.0,
        notability: 'high',
      },
      {
        fact: 'This candidate has no valid kind',
        kind: null,
      },
    ]);

    const outcome = await extract();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.facts).toHaveLength(1);
    expect(outcome.facts[0]!.fact).toBe('The migration completed');
  });

  test('keeps malformed_output when every candidate is invalid', async () => {
    stubFacts([
      { fact: 'Missing kind', kind: null },
      { fact: null, kind: 'fact' },
    ]);

    const outcome = await extract();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('malformed_output');
      // The outcome names the resolved model so failure surfaces (absorb log,
      // warn lines) can tell the operator WHICH model misbehaved.
      expect(typeof outcome.model).toBe('string');
    }
  });

  test('keeps an explicitly empty array as a successful empty result', async () => {
    stubFacts([]);

    expect(await extract()).toEqual({ ok: true, facts: [] });
  });
});
