/**
 * Native OpenAI tool definitions are sent with `strict: false` (GST-2435).
 *
 * The native-openai route builds its model with `createOpenAI(...).languageModel()`,
 * which talks to the Responses API. When a function tool carries no `strict`
 * field, the Responses API treats it as strict: every property becomes
 * required, so the model fills optional arguments with placeholders (a zero
 * line window, an empty byte range) that gbrain's own validators then reject.
 *
 * Drives the real gateway against a local stub and asserts the request body
 * that leaves gbrain, per route: native OpenAI via chat() and toolLoop() (every
 * turn) carries `strict: false` on each tool; native Anthropic, native Google
 * and an openai-compatible chat-completions recipe send no strict field at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway, toolLoop, type ChatToolDef, type ToolHandler } from '../../src/core/ai/gateway.ts';

let server: ReturnType<typeof Bun.serve>;
let bodies: any[] = [];
let callToolFirst = false;
const realFetch = globalThis.fetch;

const TOOL: ChatToolDef = {
  name: 'lookup_page',
  description: 'Read one page by slug.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      lines: { type: 'object', properties: { from: { type: 'integer' }, count: { type: 'integer' } } },
    },
    required: ['slug'],
  },
};

function responsesReply(body: any): Response {
  const toolTurn = callToolFirst && !(body.input ?? []).some((i: any) => i.type === 'function_call_output');
  const output = toolTurn
    ? [{ type: 'function_call', id: 'fc_stub', call_id: 'call_stub', name: TOOL.name, arguments: '{"slug":"alpha"}', status: 'completed' }]
    : [{ type: 'message', id: 'msg_stub', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
  return Response.json({
    id: 'resp_stub', object: 'response', created_at: 0, status: 'completed', model: body.model, output,
    incomplete_details: null,
    usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
}

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }) as typeof fetch;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      const path = new URL(req.url).pathname;
      if (path.endsWith('/responses')) return responsesReply(body);
      if (path.endsWith('/messages')) {
        return Response.json({
          id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return Response.json({
        id: 'chatcmpl_stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
  resetGateway();
});

beforeEach(() => {
  bodies = [];
  callToolFirst = false;
  resetGateway();
});

function configure(model: string): void {
  const base = `http://127.0.0.1:${server.port}/v1`;
  configureGateway({
    chat_model: model,
    env: {
      ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: base,
      OPENAI_API_KEY: 'stub', OPENAI_BASE_URL: base, GOOGLE_GENERATIVE_AI_API_KEY: 'stub',
      GROQ_API_KEY: 'stub',
    },
    base_urls: { groq: base },
  });
}

async function chatWithTool(model: string): Promise<any> {
  configure(model);
  await chat({ model, system: 'Use the tool.', messages: [{ role: 'user', content: 'read alpha' }], tools: [TOOL], maxTokens: 200 });
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

describe('tool definitions per route (GST-2435)', () => {
  test('native OpenAI chat() sends each tool with strict: false and keeps the schema as written', async () => {
    const body = await chatWithTool('openai:gpt-5.2');
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: TOOL.name, strict: false });
    expect(body.tools[0].parameters.required).toEqual(['slug']);
  });

  test('native OpenAI toolLoop() sends strict: false on every turn', async () => {
    configure('openai:gpt-5.2');
    callToolFirst = true;
    const calls: unknown[] = [];
    const handlers = new Map<string, ToolHandler>([[TOOL.name, { execute: async (input) => { calls.push(input); return { ok: true }; } }]]);
    await toolLoop({
      model: 'openai:gpt-5.2',
      system: 'Use the tool.',
      initialMessages: [{ role: 'user', content: 'read alpha' }],
      tools: [TOOL],
      toolHandlers: handlers,
      maxTurns: 3,
      maxTokens: 200,
    });
    expect(calls).toEqual([{ slug: 'alpha' }]);
    expect(bodies.length).toBe(2);
    for (const body of bodies) expect(body.tools.map((t: any) => t.strict)).toEqual([false]);
  });

  test('native Anthropic sends no strict field', async () => {
    const body = await chatWithTool('anthropic:claude-sonnet-4-6');
    expect(body.tools[0].name).toBe(TOOL.name);
    expect('strict' in body.tools[0]).toBe(false);
  });

  test('native Google sends no strict field', async () => {
    const body = await chatWithTool('google:gemini-2.5-flash');
    expect(JSON.stringify(body.tools)).toContain(TOOL.name);
    expect(JSON.stringify(body.tools)).not.toContain('strict');
  });

  test('an openai-compatible chat-completions recipe sends no strict field', async () => {
    const body = await chatWithTool('groq:llama-3.3-70b-versatile');
    expect(body.tools[0].function.name).toBe(TOOL.name);
    expect('strict' in body.tools[0].function).toBe(false);
  });
});
