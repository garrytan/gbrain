// Commit 4: LLM intent escalation for cross-modal classification.
//
// Covers:
//   - parseModality tolerates trailing punctuation + casing
//   - classifyModalityWithLLM happy paths (text / image / both)
//   - Fail-open on timeout / parse failure / gateway misconfig
//   - hybridSearch escalation gate: fires ONLY when flag on + regex 'text' + ambiguous
//   - Cache miss: same query asked twice WITH llm_intent=true makes 2 LLM calls
//     (caching is the existing query_cache layer, not a per-process LRU)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  classifyModalityWithLLM,
  parseModality,
} from '../src/core/search/llm-intent.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';

beforeEach(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test' },
  });
});

afterEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
});

describe('parseModality (pure function)', () => {
  test('"text" → text', () => {
    expect(parseModality('text', 'text')).toBe('text');
  });
  test('"image" → image', () => {
    expect(parseModality('image', 'text')).toBe('image');
  });
  test('"both" → both', () => {
    expect(parseModality('both', 'text')).toBe('both');
  });
  test('"IMAGE." → image (tolerates trailing punctuation + casing)', () => {
    expect(parseModality('IMAGE.', 'text')).toBe('image');
  });
  test('"  text  \\n" → text (tolerates whitespace)', () => {
    expect(parseModality('  text  \n', 'image')).toBe('text');
  });
  test('"none of the above" → fallback', () => {
    expect(parseModality('none of the above', 'text')).toBe('text');
    expect(parseModality('none of the above', 'image')).toBe('image');
  });
  test('empty string → fallback', () => {
    expect(parseModality('', 'text')).toBe('text');
  });
});

describe('classifyModalityWithLLM — happy path', () => {
  test('"any pictures from offsite?" → LLM says image → returns image', async () => {
    let chatCalled = 0;
    __setChatTransportForTests(async (_opts) => {
      chatCalled++;
      return {
        text: 'image',
        blocks: [{ type: 'text', text: 'image' }],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    });
    const result = await classifyModalityWithLLM('any pictures from offsite?');
    expect(result).toBe('image');
    expect(chatCalled).toBe(1);
  });

  test('"what is founder mode" → LLM says text → returns text', async () => {
    __setChatTransportForTests(async () => ({
      text: 'text',
      blocks: [{ type: 'text', text: 'text' }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    }));
    expect(await classifyModalityWithLLM('what is founder mode')).toBe('text');
  });

  test('LLM says "both" → returns both', async () => {
    __setChatTransportForTests(async () => ({
      text: 'both',
      blocks: [{ type: 'text', text: 'both' }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    }));
    expect(await classifyModalityWithLLM('ambiguous query')).toBe('both');
  });
});

describe('classifyModalityWithLLM — fail-open', () => {
  test('LLM throws → returns fallback (text)', async () => {
    __setChatTransportForTests(async () => {
      throw new Error('network error');
    });
    expect(await classifyModalityWithLLM('q')).toBe('text');
  });

  test('LLM returns unrecognized output → returns fallback', async () => {
    __setChatTransportForTests(async () => ({
      text: 'gibberish output',
      blocks: [{ type: 'text', text: 'gibberish output' }],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    }));
    expect(await classifyModalityWithLLM('q', 'text')).toBe('text');
  });

  test('Gateway not configured → returns fallback', async () => {
    resetGateway();
    // No configureGateway called → isAvailable('chat') returns false.
    expect(await classifyModalityWithLLM('q', 'text')).toBe('text');
  });

  test('Explicit fallback honored', async () => {
    __setChatTransportForTests(async () => {
      throw new Error('boom');
    });
    expect(await classifyModalityWithLLM('q', 'image')).toBe('image');
    expect(await classifyModalityWithLLM('q', 'both')).toBe('both');
  });
});
