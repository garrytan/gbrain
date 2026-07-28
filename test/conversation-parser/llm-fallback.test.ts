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

import { describe, expect, test, beforeEach } from 'bun:test';
import { withEnv, emptyHome } from '../helpers/with-env.ts';
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
      { ANTHROPIC_API_KEY: undefined as unknown as string, GBRAIN_HOME: emptyHome() },
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

  test('page date is authoritative prompt context and part of the cache key', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const systems: string[] = [];
      const contents: string[] = [];
      let calls = 0;
      const transport = async (opts: Parameters<NonNullable<Parameters<typeof runLlmFallback>[0]['chatTransport']>>[0]) => {
        calls++;
        systems.push(opts.system ?? '');
        contents.push(String(opts.messages[0]?.content ?? ''));
        return makeChatResult(
          '[{"speaker":"A","timestamp":"2026-06-01T09:00:00Z","text":"hello"}]',
          { input_tokens: 1, output_tokens: 1 },
        );
      };

      const common = {
        modelStr: 'claude-haiku-4-5',
        body: 'same time-only transcript',
        chatTransport: transport,
      };
      await runLlmFallback({ ...common, fallbackDate: '2026-06-01' });
      await runLlmFallback({ ...common, fallbackDate: '2026-06-02' });

      expect(calls).toBe(2);
      expect(systems[0]).toContain('authoritative conversation date is 2026-06-01');
      expect(contents[0]).toContain('<conversation-date>2026-06-01</conversation-date>');
      expect(contents[1]).toContain('<conversation-date>2026-06-02</conversation-date>');
    });
  });

  test('canonicalizes valid offsets and drops unsafe message shapes', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'something',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: '  Alpha  ', timestamp: '2024-03-15T18:37:42-04:00', text: '  good  ' },
              { speaker: 'Beta', timestamp: 'not-a-timestamp', text: 'bad time' },
              { speaker: '   ', timestamp: '2024-03-15T18:39:00Z', text: 'empty speaker' },
              { speaker: 'Gamma', timestamp: '2024-03-15', text: 'date only' },
              { speaker: 'Delta', timestamp: '2024-03-15T18:40:00Z', text: '   ' },
              { speaker: 'Epsilon', timestamp: '2024-02-30T09:00:00Z', text: 'invalid day' },
              { speaker: 'Zeta', timestamp: '2024-03-15T18:37:00', text: 'missing zone' },
              { speaker: 'Eta', timestamp: '9999-12-31T23:59:59Z', text: 'future poison' },
            ]),
            { input_tokens: 10, output_tokens: 30 },
          ),
      });
      expect(result).toEqual([
        { speaker: 'Alpha', timestamp: '2024-03-15T22:37:42Z', text: 'good' },
      ]);
    });
  });

  test('stable-sorts untrusted model output by canonical timestamp', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'something',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: 'Later', timestamp: '2024-03-15T10:00:00Z', text: 'second' },
              { speaker: 'Earlier', timestamp: '2024-03-15T09:00:00Z', text: 'first' },
              { speaker: 'Same time A', timestamp: '2024-03-15T10:00:00Z', text: 'third' },
              { speaker: 'Same time B', timestamp: '2024-03-15T10:00:00Z', text: 'fourth' },
            ]),
            { input_tokens: 10, output_tokens: 30 },
          ),
      });
      expect(result?.map((message) => message.speaker)).toEqual([
        'Earlier',
        'Later',
        'Same time A',
        'Same time B',
      ]);
    });
  });

  test('processes the full body in bounded chunks', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: Array.from({ length: 5 }, (_, i) => `opaque line ${i}`).join('\n'),
        sampleLines: 2,
        chatTransport: async () => {
          const hour = 9 + calls++;
          return makeChatResult(
            JSON.stringify([
              {
                speaker: `Chunk ${calls}`,
                timestamp: `2024-03-15T${String(hour).padStart(2, '0')}:00:00Z`,
                text: 'parsed',
              },
            ]),
            { input_tokens: 10, output_tokens: 10 },
          );
        },
      });
      expect(calls).toBe(3);
      expect(result).toHaveLength(3);
      expect(result?.at(-1)?.speaker).toBe('Chunk 3');
    });
  });

  test('does not request an overlap-only tail window at the exact boundary', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      for (const [lineCount, expectedCalls] of [[100, 1], [101, 2]] as const) {
        _resetLlmCacheForTests();
        let calls = 0;
        const result = await runLlmFallback({
          modelStr: 'claude-haiku-4-5',
          body: Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n'),
          chatTransport: async () => {
            calls++;
            return makeChatResult('[]');
          },
        });
        expect(result).toEqual([]);
        expect(calls).toBe(expectedCalls);
      }
    });
  });

  test('does not return a partial page when a later chunk fails', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: ['line 1', 'line 2', 'line 3'].join('\n'),
        sampleLines: 2,
        chatTransport: async () => {
          calls++;
          return makeChatResult(
            calls === 1
              ? '[{"speaker":"A","timestamp":"2024-03-15T09:00:00Z","text":"ok"}]'
              : 'malformed later chunk',
            { input_tokens: 10, output_tokens: 10 },
          );
        },
      });
      expect(calls).toBe(2);
      expect(result).toBeNull();
    });
  });

  test('overlap deduplicates a boundary message and keeps its complete body', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
        sampleLines: 10,
        chatTransport: async () => {
          calls++;
          return makeChatResult(
            JSON.stringify([
              {
                speaker: 'Boundary Author',
                timestamp: '2024-03-15T09:00:00Z',
                text: calls === 1 ? 'opening' : 'opening\ncontinued after boundary',
              },
            ]),
          );
        },
      });
      expect(calls).toBe(2);
      expect(result).toEqual([
        {
          speaker: 'Boundary Author',
          timestamp: '2024-03-15T09:00:00Z',
          text: 'opening\ncontinued after boundary',
        },
      ]);
    });
  });

  test('does not merge distinct same-second messages within one window', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: 'one window',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: 'Alice', timestamp: '2024-03-15T09:00:00Z', text: 'yes' },
              {
                speaker: 'Alice',
                timestamp: '2024-03-15T09:00:00Z',
                text: 'yes please',
              },
            ]),
          ),
      });
      expect(result?.map((message) => message.text)).toEqual(['yes', 'yes please']);
    });
  });

  test('matches exact same-second messages before overlap containment', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
        sampleLines: 10,
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify([
              { speaker: 'Alice', timestamp: '2024-03-15T09:00:00Z', text: 'yes' },
              {
                speaker: 'Alice',
                timestamp: '2024-03-15T09:00:00Z',
                text: 'yes please',
              },
            ]),
          ),
      });
      expect(result?.map((message) => message.text)).toEqual(['yes', 'yes please']);
    });
  });

  test('matches overlap messages one-to-one before accepting a contained newcomer', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
        sampleLines: 10,
        chatTransport: async () => {
          calls++;
          const texts = calls === 1 ? ['yes'] : ['yes', 'yes please'];
          return makeChatResult(
            JSON.stringify(
              texts.map((text) => ({
                speaker: 'Alice',
                timestamp: '2024-03-15T09:00:00Z',
                text,
              })),
            ),
          );
        },
      });
      expect(result?.map((message) => message.text)).toEqual(['yes', 'yes please']);
    });
  });

  test('extends the most specific unmatched overlap candidate', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const result = await runLlmFallback({
        modelStr: 'claude-haiku-4-5',
        body: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
        sampleLines: 10,
        chatTransport: async () => {
          calls++;
          const texts = calls === 1 ? ['yes', 'yes please'] : ['yes please indeed'];
          return makeChatResult(
            JSON.stringify(
              texts.map((text) => ({
                speaker: 'Alice',
                timestamp: '2024-03-15T09:00:00Z',
                text,
              })),
            ),
          );
        },
      });
      expect(result?.map((message) => message.text)).toEqual([
        'yes',
        'yes please indeed',
      ]);
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
