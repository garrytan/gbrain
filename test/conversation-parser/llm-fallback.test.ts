/**
 * v0.41.16.0 — LLM fallback unit tests.
 *
 * Hermetic via the `chatTransport` test seam.
 *
 * Pins:
 *   - Happy path: parses LLM-returned JSON array
 *   - Adversarial input: LLM returns [] → parser returns [] (skip page)
 *   - Malformed LLM output → fail-open null
 *   - Provider unavailable → null
 *   - Cache hit: doesn't re-call
 */

import { describe, expect, test, beforeEach, beforeAll, afterAll } from 'bun:test';
import { withEnv } from '../helpers/with-env.ts';
import { suppressAnthropicKey } from '../helpers/no-anthropic-key.ts';

// Isolate "no API key" assertions from the developer's real ~/.gbrain config.
let __restoreNoKey: () => void;
beforeAll(() => { __restoreNoKey = suppressAnthropicKey(); });
afterAll(() => { __restoreNoKey?.(); });
import { runLlmFallback } from '../../src/core/conversation-parser/llm-fallback.ts';
import { _resetLlmCacheForTests } from '../../src/core/conversation-parser/llm-base.ts';
import { makeChatResult } from './helpers.ts';

beforeEach(() => {
  _resetLlmCacheForTests();
});

describe('runLlmFallback', () => {
  test('happy path: parses LLM JSON output', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'some-novel-chat-format',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: 'Alice', timestamp: '2024-03-15T18:37:00Z', text: 'hello' },
              { speaker: 'Bob', timestamp: '2024-03-15T18:38:00Z', text: 'world' },
            ]),
            { input_tokens: 10, output_tokens: 30 },
          ),
      });
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0].speaker).toBe('Alice');
      expect(result![1].text).toBe('world');
    });
  });

  test('adversarial input: LLM returns [] → empty array', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'This is just a recipe for cookies. Not a chat log.',
        chatTransport: async () => makeChatResult('[]', { input_tokens: 10, output_tokens: 1 }),
      });
      expect(result).toEqual([]);
    });
  });

  test('malformed output → fail-open null', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'something',
        chatTransport: async () =>
          makeChatResult(
            'I think this might be a chat log but I am not sure.',
            { input_tokens: 10, output_tokens: 12 },
          ),
      });
      expect(result).toBeNull();
    });
  });

  test('provider unavailable: returns null without calling transport', async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined as unknown as string },
      async () => {
        let calls = 0;
        const result = await runLlmFallback({
          modelStr: 'claude-haiku-4-5',
          body: 'whatever',
          chatTransport: async () => {
            calls++;
            return makeChatResult('[]', { input_tokens: 1, output_tokens: 1 });
          },
        });
        expect(result).toBeNull();
        expect(calls).toBe(0);
      },
    );
  });

  test('cache hit: second call doesnt re-invoke transport', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const opts = {
        modelStr: 'claude-haiku-4-5',
        body: 'stable-body-for-cache',
        chatTransport: async () => {
          calls++;
          return makeChatResult('[{"speaker":"A","timestamp":"2024-01-01T00:00:00Z","text":"x"}]', { input_tokens: 1, output_tokens: 1 });
        },
      };
      await runLlmFallback(opts);
      await runLlmFallback(opts);
      expect(calls).toBe(1);
    });
  });

  test('strips invalid items from array', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'something',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: 'Alice', timestamp: '2024-03-15T18:37:00Z', text: 'good' },
              { speaker: 42, timestamp: 'x', text: 'bad shape' }, // speaker not string
              { timestamp: '2024-03-15T18:38:00Z', text: 'missing speaker' },
              { speaker: 'Bob', timestamp: '2024-03-15T18:39:00Z', text: 'good2' },
            ]),
            { input_tokens: 10, output_tokens: 30 },
          ),
      });
      expect(result).toHaveLength(2);
      expect(result![0].speaker).toBe('Alice');
      expect(result![1].speaker).toBe('Bob');
    });
  });
});
