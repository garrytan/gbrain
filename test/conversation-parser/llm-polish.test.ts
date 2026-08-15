/**
 * v0.41.16.0 — LLM polish unit tests.
 *
 * Pins:
 *   - applyPolish pure function: merge + drop + edits
 *   - Headroom guard skip path
 *   - Provider unavailable → input messages unchanged
 *   - Cache hit doesn't re-call
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { withEnv } from '../helpers/with-env.ts';
import {
  runLlmPolish,
  applyPolish,
} from '../../src/core/conversation-parser/llm-polish.ts';
import { _resetLlmCacheForTests } from '../../src/core/conversation-parser/llm-base.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { withBudgetTracker } from '../../src/core/ai/gateway.ts';
import type { MatchedMessage } from '../../src/core/conversation-parser/types.ts';
import { makeChatResult } from './helpers.ts';

beforeEach(() => {
  _resetLlmCacheForTests();
});

const SAMPLE: MatchedMessage[] = [
  { speaker: 'Alice', timestamp: '2024-03-15T18:37:00Z', text: 'hello' },
  { speaker: 'Alice', timestamp: '2024-03-15T18:37:30Z', text: 'continuation' },
  { speaker: 'system', timestamp: '2024-03-15T18:38:00Z', text: 'Bob joined' },
  { speaker: 'Bob', timestamp: '2024-03-15T18:39:00Z', text: 'world (edited)' },
];

describe('applyPolish — pure function', () => {
  test('merge two indices into one', () => {
    const r = applyPolish(SAMPLE, {
      merge_indices: [[0, 1]],
      drop_indices: [],
      edits: [],
    });
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0].text).toBe('hello\ncontinuation');
    expect(r.delta.merged).toBe(1);
  });

  test('drop indices', () => {
    const r = applyPolish(SAMPLE, {
      merge_indices: [],
      drop_indices: [2],
      edits: [],
    });
    expect(r.messages).toHaveLength(3);
    expect(r.messages.find((m) => m.text === 'Bob joined')).toBeUndefined();
    expect(r.delta.dropped).toBe(1);
  });

  test('edit speaker and text', () => {
    const r = applyPolish(SAMPLE, {
      merge_indices: [],
      drop_indices: [],
      edits: [
        { index: 3, field: 'text', value: 'world' },
      ],
    });
    expect(r.messages[3].text).toBe('world');
    expect(r.delta.edits).toBe(1);
  });

  test('combined: drop system msg, merge two, edit edited marker', () => {
    const r = applyPolish(SAMPLE, {
      merge_indices: [[0, 1]],
      drop_indices: [2],
      edits: [{ index: 3, field: 'text', value: 'world' }],
    });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].text).toBe('hello\ncontinuation');
    expect(r.messages[1].text).toBe('world');
  });

  test('no-op: returns messages unchanged', () => {
    const r = applyPolish(SAMPLE, {
      merge_indices: [],
      drop_indices: [],
      edits: [],
    });
    expect(r.messages).toHaveLength(4);
    expect(r.delta).toEqual({ merged: 0, dropped: 0, edits: 0 });
  });
});

describe('runLlmPolish', () => {
  test('happy path: LLM returns polish ops, applied', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const r = await runLlmPolish({
        modelStr: 'claude-haiku-4-5',
        body: '...full body...',
        messages: SAMPLE,
        patternId: 'imessage-slack',
        chatTransport: async () =>
          makeChatResult(
            JSON.stringify({
              merge_indices: [[0, 1]],
              drop_indices: [2],
              edits: [{ index: 3, field: 'text', value: 'world' }],
            }),
            { input_tokens: 100, output_tokens: 50 },
          ),
      });
      expect(r.skipped).toBeUndefined();
      expect(r.messages).toHaveLength(2);
      expect(r.delta.merged).toBe(1);
      expect(r.delta.dropped).toBe(1);
      expect(r.delta.edits).toBe(1);
    });
  });

  test('headroom guard: skips when tracker within $0.10 of cap', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const t = new BudgetTracker({ label: 'unit', maxCostUsd: 0.05 });
      let calls = 0;
      await withBudgetTracker(t, async () => {
        const r = await runLlmPolish({
          modelStr: 'claude-haiku-4-5',
          body: 'b',
          messages: SAMPLE,
          patternId: 'imessage-slack',
          chatTransport: async () => {
            calls++;
            return makeChatResult('{"merge_indices":[],"drop_indices":[],"edits":[]}', { input_tokens: 1, output_tokens: 1 });
          },
        });
        expect(r.skipped).toBe('headroom');
        expect(r.messages).toBe(SAMPLE); // unchanged input
      });
      expect(calls).toBe(0);
    });
  });

  test('provider unavailable: returns input unchanged + skipped=provider', async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined as unknown as string },
      async () => {
        const r = await runLlmPolish({
          modelStr: 'claude-haiku-4-5',
          body: 'b',
          messages: SAMPLE,
          patternId: 'imessage-slack',
          chatTransport: async () => makeChatResult('{}', { input_tokens: 1, output_tokens: 1 }),
        });
        expect(r.skipped).toBe('provider');
        expect(r.messages).toEqual(SAMPLE);
      },
    );
  });

  test('cache hit on same (body, patternId) pair', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      let calls = 0;
      const opts = {
        modelStr: 'claude-haiku-4-5',
        body: 'stable',
        messages: SAMPLE,
        patternId: 'imessage-slack',
        chatTransport: async () => {
          calls++;
          return makeChatResult('{"merge_indices":[],"drop_indices":[],"edits":[]}', { input_tokens: 1, output_tokens: 1 });
        },
      };
      await runLlmPolish(opts);
      await runLlmPolish(opts);
      expect(calls).toBe(1);
    });
  });
});
