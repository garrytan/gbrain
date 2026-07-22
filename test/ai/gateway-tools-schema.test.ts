import { describe, expect, it } from 'bun:test';
import { generateText, jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { toAISDKTools, toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';

// v0.42 AI SDK v6 fix — the regression guard that the original bug evaded.
// Every gateway/toolLoop test stubs the chat transport, which short-circuits
// BEFORE generateText runs, so neither asSchema() (tool schema normalization)
// nor ModelMessage conversion was ever exercised in CI. This test drives the
// REAL generateText with a MockLanguageModelV3 (no network/keys) so both
// failure points are validated against the actual installed AI SDK v6.

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  } as any);
}

const internalMessages: ChatMessage[] = [
  { role: 'user', content: 'find foo' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }],
  },
  {
    role: 'user', // toolLoop's internal feedback role; adapter must promote to 'tool'
    content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { hits: 3 } }],
  },
];

describe('gateway tool schema + message shape (real AI SDK v6)', () => {
  it('jsonSchema()-wrapped tools + adapted messages pass generateText without throwing', async () => {
    const model = mockModel();
    const tools = toAISDKTools([
      {
        name: 'search',
        description: 'search the brain',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);

    const result = await generateText({
      model: model as any,
      tools: tools as any,
      messages: toModelMessages(internalMessages) as any,
    });

    expect(result.text).toBe('ok');
    // The tool result was promoted to a role:'tool' message in the prompt the
    // model actually received — proving ModelMessage conversion accepted it.
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    expect(prompt.some((m) => m.role === 'tool')).toBe(true);
  });

  it('REGRESSION: the bare { jsonSchema } object (pre-fix shape) is rejected by v6', async () => {
    const model = mockModel();
    const badTools = {
      search: {
        description: 'search the brain',
        // The exact pre-v0.42 bug shape: a plain object, not a Schema.
        inputSchema: { jsonSchema: { type: 'object' } } as any,
      },
    };
    await expect(
      generateText({
        model: model as any,
        tools: badTools as any,
        messages: toModelMessages(internalMessages) as any,
      }),
    ).rejects.toThrow();
  });

  it('REGRESSION: raw tool-result in a role:user message (pre-fix shape) is rejected by v6', async () => {
    const model = mockModel();
    const tools = {
      search: {
        description: 'search',
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } } as any),
      },
    };
    // Pre-fix: toolLoop pushed { role:'user', content:[{type:'tool-result', output: <raw> }] }.
    const preFixMessages = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { hits: 3 } }] },
    ];
    await expect(
      generateText({ model: model as any, tools: tools as any, messages: preFixMessages as any }),
    ).rejects.toThrow();
  });

  it('FIX: a tool-call with undefined toolCallId (GLM omission) is coerced to a non-empty string', () => {
    // The exact poisoned shape z.ai/GLM produced: a tool-call part with NO
    // toolCallId. Replayed as assistant history on turn N+1, pre-fix this threw
    // "The messages do not match the ModelMessage[] schema" (toolCallId: z.string())
    // and wedged the job across all 528 autopilot retries. ensureToolCallId()
    // synthesizes a stable id so the v6 ModelMessage schema no longer rejects it.
    // (chat() applies the SAME coercion at the source, so the id it emits flows
    // to BOTH the assistant tool-call block AND its matching tool-result block —
    // a complete matched conversation is covered by the first test above.)
    const poisoned: ChatMessage[] = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: undefined as unknown as string, toolName: 'search', input: { q: 'foo' } }] },
    ];
    const converted = toModelMessages(poisoned) as any[];
    const asst = converted.find((m) => m.role === 'assistant');
    const toolCallPart = asst.content.find((p: any) => p.type === 'tool-call');
    expect(typeof toolCallPart.toolCallId).toBe('string');
    expect(toolCallPart.toolCallId.length).toBeGreaterThan(0);
    // An empty-string id must also be coerced (not just undefined).
    const emptyId = toModelMessages([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '', toolName: 'search', input: {} }] },
    ]) as any[];
    expect(emptyId[0].content[0].toolCallId.length).toBeGreaterThan(0);
  });
});
