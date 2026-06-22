import { describe, expect, it } from 'bun:test';
import { generateText, jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';

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
    // Built exactly as gateway.chat() builds it (the primary fix).
    const tools = {
      search: {
        description: 'search the brain',
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } } as any),
      },
    };

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

  it('REGRESSION: live synth replay with DB BigInt tool output passes ModelMessage schema', async () => {
    const model = mockModel();
    const tools = {
      brain_query: {
        description: 'query the brain',
        inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' }, adaptive_return: { type: 'boolean' } } } as any),
      },
      brain_get_page: {
        description: 'get a page',
        inputSchema: jsonSchema({ type: 'object', properties: { slug: { type: 'string' } } } as any),
      },
    };
    const replayMessages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'synthesize this transcript' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will search first.' },
          { type: 'tool-call', toolCallId: 'toolu_01Cuq8THTQ8PubikSgFwhw8i', toolName: 'brain_query', input: { query: 'systematic debugging skill SkillOpt Codex', adaptive_return: true } },
          { type: 'tool-call', toolCallId: 'toolu_01NqeZySmCtpWEmxRVPa1bQu', toolName: 'brain_query', input: { query: 'Sawyer debugging methodology mental models', adaptive_return: true } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_01Cuq8THTQ8PubikSgFwhw8i',
            toolName: 'brain_query',
            output: [{ page_id: 17775n, chunk_id: 183106n, slug: 'wiki/personal/reflections/2026-05-26-codex-systematic-debugging-oauth-session-cookie-secure-580411' }],
          },
          {
            type: 'tool-result',
            toolCallId: 'toolu_01NqeZySmCtpWEmxRVPa1bQu',
            toolName: 'brain_query',
            output: [{ page_id: 17760n, chunk_id: 183056n, slug: 'wiki/personal/reflections/2026-05-26-codex-systematic-debugging-cart-discount-rounding-d2aca5' }],
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Now let me search for one more page.' },
          { type: 'tool-call', toolCallId: 'toolu_01XqcAd7vWeWhU9CHKCTQFH1', toolName: 'brain_query', input: { query: 'SkillOpt path mismatch', adaptive_return: true } },
          { type: 'tool-call', toolCallId: 'toolu_01JdRsDHvFNCBsTeMqT8UiJ6', toolName: 'brain_get_page', input: { slug: 'wiki/personal/reflections/2026-05-26-codex-systematic-debugging-bigquery-receipt-timestamp-fea68e' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_01XqcAd7vWeWhU9CHKCTQFH1',
            toolName: 'brain_query',
            output: [{ page_id: 17773n, chunk_id: 183098n, slug: 'wiki/originals/ideas/2026-05-26-timeout-as-masking-error-timestamp-semantics-drift-fea68e' }],
          },
          {
            type: 'tool-result',
            toolCallId: 'toolu_01JdRsDHvFNCBsTeMqT8UiJ6',
            toolName: 'brain_get_page',
            output: { id: 17773n, slug: 'wiki/personal/reflections/2026-05-26-codex-systematic-debugging-bigquery-receipt-timestamp-fea68e' },
          },
        ],
      },
    ];

    const result = await generateText({
      model: model as any,
      tools: tools as any,
      messages: toModelMessages(replayMessages) as any,
    });

    expect(result.text).toBe('ok');
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(prompt.at(-1).content[1].output.value.id).toBe('17773');
  });

  it('REGRESSION: live 22625-style multi-turn tool replay with DB ids passes the real ModelMessage schema', async () => {
    const model = mockModel();
    const tools = {
      brain_query: {
        description: 'query the brain',
        inputSchema: jsonSchema({ type: 'object', properties: { question: { type: 'string' } } } as any),
      },
      brain_get_page: {
        description: 'get a page',
        inputSchema: jsonSchema({ type: 'object', properties: { slug: { type: 'string' } } } as any),
      },
    };
    const replayMessages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'synthesize this transcript' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect neighboring memory first.' },
          { type: 'tool-call', toolCallId: 'toolu_01Cuq8THTQ8PubikSgFwhw8i', toolName: 'brain_query', input: { question: 'what changed in the prior run' } },
          { type: 'tool-call', toolCallId: 'toolu_01NqeZySmCtpWEmxRVPa1bQu', toolName: 'brain_query', input: { question: 'what is still unresolved' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_01Cuq8THTQ8PubikSgFwhw8i',
            toolName: 'brain_query',
            output: [{ slug: 'sessions/22625-neighbor-one', page_id: 17775n, chunk_id: 183106n }],
          },
          {
            type: 'tool-result',
            toolCallId: 'toolu_01NqeZySmCtpWEmxRVPa1bQu',
            toolName: 'brain_query',
            output: [{ slug: 'sessions/22625-neighbor-two', page_id: 17776n, chunk_id: 183107n }],
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I need one full page and another neighbor.' },
          { type: 'tool-call', toolCallId: 'toolu_01XqcAd7vWeWhU9CHKCTQFH1', toolName: 'brain_query', input: { question: 'operator proof gate' } },
          { type: 'tool-call', toolCallId: 'toolu_01JdRsDHvFNCBsTeMqT8UiJ6', toolName: 'brain_get_page', input: { slug: 'sessions/22625-neighbor-one' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_01XqcAd7vWeWhU9CHKCTQFH1',
            toolName: 'brain_query',
            output: [{ slug: 'sessions/22625-neighbor-three', page_id: 17777n, chunk_id: 183108n }],
          },
          {
            type: 'tool-result',
            toolCallId: 'toolu_01JdRsDHvFNCBsTeMqT8UiJ6',
            toolName: 'brain_get_page',
            output: { id: 17775n, slug: 'sessions/22625-neighbor-one', body: 'page body' },
          },
        ],
      },
    ];

    const result = await generateText({
      model: model as any,
      tools: tools as any,
      messages: toModelMessages(replayMessages) as any,
    });

    expect(result.text).toBe('ok');
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(prompt.at(-1).content[1].output.value.id).toBe('17775');
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
});
