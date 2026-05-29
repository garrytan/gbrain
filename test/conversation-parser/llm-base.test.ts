/**
 * v0.41.16.0 — LLM base unit tests.
 *
 * Hermetic via the `chatTransport` test seam. No real API calls.
 *
 * Pins:
 *   - Cache hit doesn't re-call transport
 *   - Provider unavailable returns null without calling transport
 *   - Transport throw → fail-open null
 *   - Parse failure → fail-open null
 *   - parseLlmJson 4-strategy fallback
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { withEnv } from '../helpers/with-env.ts';
import {
  runLlmCall,
  parseLlmJson,
  _resetLlmCacheForTests,
  getLlmCacheStats,
  probeLlmAvailability,
} from '../../src/core/conversation-parser/llm-base.ts';
import { makeChatResult } from './helpers.ts';

beforeEach(() => {
  _resetLlmCacheForTests();
});

describe('probeLlmAvailability', () => {
  test('returns null when ANTHROPIC_API_KEY is unset', async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined as unknown as string },
      async () => {
        expect(probeLlmAvailability('claude-haiku-4-5')).toBeNull();
        expect(probeLlmAvailability('anthropic:claude-haiku-4-5')).toBeNull();
      },
    );
  });
  test('returns normalized model when key set', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      expect(probeLlmAvailability('claude-haiku-4-5')).toBe(
        'anthropic:claude-haiku-4-5',
      );
    });
  });
  test('returns null for unknown provider', async () => {
    expect(probeLlmAvailability('madeup-provider:foo-model')).toBeNull();
  });
});

describe('runLlmCall — happy path', () => {
  test('calls transport, parses, caches', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmCall<{ ok: boolean }>({
        shape: 'fallback',
        modelStr: 'claude-haiku-4-5',
        content: 'hello',
        system: 'test',
        parse: (text) => parseLlmJson(text),
        chatTransport: async () => {
          calls++;
          return makeChatResult('{"ok": true}', { input_tokens: 1, output_tokens: 1 });
        },
      });
      expect(result).toEqual({ ok: true });
      expect(calls).toBe(1);
      expect(getLlmCacheStats().misses).toBe(1);
    });
  });
  test('cache hit on second call with same content', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const transport = async () => {
        calls++;
        return makeChatResult('{"ok": true}', { input_tokens: 1, output_tokens: 1 });
      };
      const opts = {
        shape: 'fallback' as const,
        modelStr: 'claude-haiku-4-5',
        content: 'hello',
        system: 'test',
        parse: (t: string) => parseLlmJson<{ ok: boolean }>(t),
        chatTransport: transport,
      };
      await runLlmCall(opts);
      await runLlmCall(opts);
      expect(calls).toBe(1);
      expect(getLlmCacheStats().hits).toBe(1);
    });
  });
});

describe('runLlmCall — fail-open paths', () => {
  test('provider unavailable returns null without calling transport', async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined as unknown as string },
      async () => {
        let calls = 0;
        const result = await runLlmCall<unknown>({
          shape: 'fallback',
          modelStr: 'claude-haiku-4-5',
          content: 'hello',
          system: 'test',
          parse: () => ({}),
          chatTransport: async () => {
            calls++;
            return makeChatResult('{}', { input_tokens: 1, output_tokens: 1 });
          },
        });
        expect(result).toBeNull();
        expect(calls).toBe(0);
      },
    );
  });
  test('transport throw → fail-open null', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmCall<unknown>({
        shape: 'fallback',
        modelStr: 'claude-haiku-4-5',
        content: 'hello',
        system: 'test',
        parse: () => ({}),
        chatTransport: async () => {
          throw new Error('network down');
        },
      });
      expect(result).toBeNull();
    });
  });
  test('parse failure → fail-open null, not cached', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const opts = {
        shape: 'fallback' as const,
        modelStr: 'claude-haiku-4-5',
        content: 'hello',
        system: 'test',
        parse: () => null,
        chatTransport: async () => {
          calls++;
          return makeChatResult('garbage', { input_tokens: 1, output_tokens: 1 });
        },
      };
      const r1 = await runLlmCall(opts);
      const r2 = await runLlmCall(opts);
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      // Both calls hit transport because parse-fail isn't cached.
      expect(calls).toBe(2);
    });
  });
});

describe('parseLlmJson — 4-strategy fallback', () => {
  test('direct parse object', () => {
    expect(parseLlmJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });
  test('strip ```json fences', () => {
    expect(parseLlmJson<{ a: number }>('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  test('strip bare ``` fences', () => {
    expect(parseLlmJson<{ a: number }>('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  test('extract first {...} substring', () => {
    expect(parseLlmJson<{ a: number }>('Here is the output: {"a": 1} (done)')).toEqual({
      a: 1,
    });
  });
  test('array mode: direct parse', () => {
    expect(parseLlmJson<number[]>('[1,2,3]', { array: true })).toEqual([1, 2, 3]);
  });
  test('array mode: extract first [...] substring', () => {
    expect(parseLlmJson<number[]>('Output: [1,2,3] done', { array: true })).toEqual([
      1, 2, 3,
    ]);
  });
  test('non-JSON returns null', () => {
    expect(parseLlmJson<unknown>('not json at all')).toBeNull();
  });
  test('empty string returns null', () => {
    expect(parseLlmJson<unknown>('')).toBeNull();
  });
});
