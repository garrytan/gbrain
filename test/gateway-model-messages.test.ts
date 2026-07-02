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

  // Regression: a reasoning model (e.g. DeepSeek v4) can emit a text part whose
  // `text` is undefined/null. AI SDK v6 rejects it ("messages do not match the
  // ModelMessage[] schema"), failing the whole turn. toModelMessages must drop
  // such parts (mirroring the replay path), so the bug shows up inline but a
  // resumed run — rebuilt via adaptContentBlocksToChatBlocks — recovers.
  test('non-string text block is dropped (v6 rejects undefined/null text)', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: undefined as unknown as string },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} },
        ],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} }] },
    ]);
  });

  test('valid text alongside a non-string text block is kept; null text dropped', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'real answer' },
          { type: 'text', text: null as unknown as string },
        ],
      },
    ];
    expect(toModelMessages(msgs)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
    ]);
  });

  test('empty-string text is kept (valid for v6)', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: '' }] }];
    expect(toModelMessages(msgs)).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '' }] }]);
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
