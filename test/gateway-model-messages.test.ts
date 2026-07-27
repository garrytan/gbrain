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

  test('Date in tool-result json output serializes to ISO string (Postgres timestamptz)', () => {
    // node-postgres returns timestamptz columns as JS Date; AI SDK v6's
    // JSONValue schema rejects a raw Date, dead-lettering the tool loop.
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'brain_get_page',
          output: { rows: [{ updated_at: new Date('2026-06-26T06:56:59.000Z'), nested: { created_at: new Date('2026-01-02T03:04:05.000Z') } }] },
        }],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    const value = out[0].content[0].output.value;
    expect(out[0].content[0].output.type).toBe('json');
    expect(value.rows[0].updated_at).toBe('2026-06-26T06:56:59.000Z');
    expect(value.rows[0].nested.created_at).toBe('2026-01-02T03:04:05.000Z');
    // No Date instance survives (would throw in AI SDK v6).
    expect(value.rows[0].updated_at instanceof Date).toBe(false);
  });

  test('non-string text block is dropped (reasoning-model null-text guard)', () => {
    // DeepSeek v4 / reasoning models can emit text:null/undefined thinking
    // parts; AI SDK v6 rejects them. Dropped here; tool-call sibling kept.
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: null as unknown as string },
          { type: 'text', text: undefined as unknown as string },
          { type: 'text', text: 'kept' },
          { type: 'text', text: '' }, // empty string is valid — kept
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} },
        ],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out[0].content).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'text', text: '' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} },
    ]);
  });

  test('errored tool-result never throws on circular/bigint output (safeStringify)', () => {
    const circular: any = {};
    circular.self = circular;
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: circular, isError: true }] },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out[0].content[0].output.type).toBe('error-text');
    expect(typeof out[0].content[0].output.value).toBe('string');
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
});
