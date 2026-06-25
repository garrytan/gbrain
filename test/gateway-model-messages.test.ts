/**
 * Pins `toModelMessages` — the gbrain ChatMessage[] → AI SDK v6 ModelMessage[]
 * converter. v6 tightened ModelMessage validation: tool results must ride on a
 * dedicated `role:'tool'` message with a structured `{type,value}` output part,
 * not a `role:'user'` message with a bare-value tool-result block (which is how
 * gbrain's toolLoop pushes them). Without this conversion every multi-turn tool
 * loop — skillopt rollouts AND production subagent jobs — throws "messages do
 * not match the ModelMessage[] schema" the moment the model calls a tool.
 *
 * Surfaced by the SkillOpt real-LLM eval (Track B). These cases pin the exact
 * v6 shapes that `generateText` accepts (verified against AI SDK 6.0.174).
 */
import { describe, test, expect } from 'bun:test';
import { toModelMessages, type ChatMessage } from '../src/core/ai/gateway.ts';

describe('toModelMessages — v6 ModelMessage shape', () => {
  test('string content passes through unchanged', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(toModelMessages(msgs)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('assistant text block maps to {type:text,text}', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(toModelMessages(msgs)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  test('assistant tool-call block keeps {toolCallId,toolName,input}', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'x' } }],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'x' } }],
      },
    ]);
  });

  test('tool-result on a user-role message becomes role:tool with json output', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { hits: 0 } }],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'json', value: { hits: 0 } } },
        ],
      },
    ]);
  });

  test('string tool-result output becomes {type:text,value}', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'echo', output: 'done' }],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'echo', output: { type: 'text', value: 'done' } }],
      },
    ]);
  });

  test('errored tool-result becomes {type:error-text,value}', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { msg: 'boom' }, isError: true }],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'error-text', value: '{"msg":"boom"}' } },
        ],
      },
    ]);
  });

  test('null tool-result output is preserved as json null (not dropped)', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'noop', output: null }],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'noop', output: { type: 'json', value: null } }],
      },
    ]);
  });

  test('full multi-turn conversation: user → assistant(tool-call) → tool(result)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'find widget' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'widget' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { hits: 0 } }] },
    ];
    const out = toModelMessages(msgs);
    expect(out).toHaveLength(3);
    expect((out[0] as any).role).toBe('user');
    expect((out[1] as any).role).toBe('assistant');
    expect((out[2] as any).role).toBe('tool');
    expect((out[2] as any).content[0].output).toEqual({ type: 'json', value: { hits: 0 } });
  });

  // Regression: gbrain tool outputs carry non-JSON values that AI SDK v6's
  // strict JSONValue schema rejects. node-postgres returns `timestamptz`
  // columns as JS Date, so brain_get_page / brain_list_pages rows include
  // Date-typed updated_at/created_at. A raw Date made the whole tool message
  // fail the ModelMessage union ("messages do not match the ModelMessage[]
  // schema") on every live multi-turn run. Replay didn't hit it because the
  // value had already been JSON-round-tripped through the jsonb column.
  test('Date in tool-result output is normalized to an ISO string (v6 JSONValue)', () => {
    const when = new Date('2026-06-04T12:34:56.000Z');
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'brain_list_pages', output: { rows: [{ slug: 'a', updated_at: when }] } }],
      },
    ];
    const out = toModelMessages(msgs);
    expect((out[0] as any).content[0].output).toEqual({
      type: 'json',
      value: { rows: [{ slug: 'a', updated_at: '2026-06-04T12:34:56.000Z' }] },
    });
  });

  test('undefined fields in tool-result output are dropped (valid JSONValue)', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: { a: 1, b: undefined } }],
      },
    ];
    expect((toModelMessages(msgs)[0] as any).content[0].output).toEqual({ type: 'json', value: { a: 1 } });
  });

  test('a Date-bearing tool output is ACCEPTED by AI SDK generateText validation (no ModelMessage rejection)', async () => {
    const { generateText } = await import('ai');
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'list pages' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'brain_list_pages', input: {} }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'brain_list_pages', output: { rows: [{ slug: 'a', updated_at: new Date('2026-06-04T00:00:00Z') }] } }] },
    ];
    // Dead URL + no retries: prompt validation runs BEFORE the network call, so
    // a schema rejection would throw synchronously. Assert the error (if any) is
    // a connection error, NOT a ModelMessage schema rejection.
    const provider = createOpenAICompatible({ name: 'dead', baseURL: 'http://127.0.0.1:1/v1' });
    let msg = '';
    try {
      await generateText({ model: provider('m'), messages: toModelMessages(msgs) as any, maxOutputTokens: 8, maxRetries: 0 });
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg).not.toContain('ModelMessage');
    expect(msg).not.toContain('Invalid prompt');
  });
});
