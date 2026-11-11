/**
 * Native OpenAI tool definitions keep optional arguments optional.
 *
 * The Responses API treats a function tool with no `strict` field as strict:
 * it marks every property required and the model must fill each one. Brain
 * tools such as get_page have one required argument and many optional
 * selectors, so a strict promotion makes the model send placeholder windows
 * (`bytes: { offset: 0, length: 0 }`) beside `body: 'none'`, which get_page
 * then refuses. The gateway must send `strict: false` on native OpenAI tools
 * and leave every other provider's tool definitions as they were.
 *
 * 1. Protects: the tool definitions that leave gbrain on the native OpenAI
 *    Responses route carry `strict: false` and only the schema's own
 *    `required` list; Anthropic and OpenAI-compatible bodies carry no `strict`.
 * 2. Fails when: `toAISDKTools` output reaches the OpenAI SDK without a
 *    per-tool `strict`, so the SDK omits it from the request body.
 * 3. Existing coverage: test/ai/gateway-tools-schema.test.ts drives a mock
 *    model and never builds a provider request body.
 * 4. Real seams: the real gateway `chat()`, the real SDK request builders, the
 *    real brain-tool registry schema for get_page, and a local HTTP stub.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway, type ChatToolDef } from '../../src/core/ai/gateway.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';

let server: ReturnType<typeof Bun.serve>;
let bodies: any[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      const path = new URL(req.url).pathname;
      if (path.endsWith('/responses')) {
        return Response.json({
          id: 'resp_stub', object: 'response', created_at: 0, status: 'completed', model: body.model,
          output: [{
            type: 'message', id: 'msg_stub', status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          }],
          incomplete_details: null,
          usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        });
      }
      if (path.endsWith('/messages')) {
        return Response.json({
          id: 'msg_stub', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return Response.json({
        id: 'chatcmpl_stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
  resetGateway();
});

beforeEach(() => {
  bodies = [];
  resetGateway();
});

function configure(model: string): void {
  const base = `http://127.0.0.1:${server.port}/v1`;
  configureGateway({
    chat_model: model,
    env: {
      OPENAI_API_KEY: 'stub', OPENAI_BASE_URL: base,
      ANTHROPIC_API_KEY: 'stub', ANTHROPIC_BASE_URL: base,
      DEEPSEEK_API_KEY: 'stub',
    },
    base_urls: { deepseek: base },
  });
}

/** get_page exactly as the subagent registry hands it to the gateway. */
function getPageTool(): ChatToolDef {
  const [def] = buildBrainTools({
    subagentId: 1,
    engine: {} as never,
    config: {} as never,
    allowedNames: new Set(['get_page']),
  });
  return { name: def!.name, description: def!.description, inputSchema: def!.input_schema };
}

async function sendWithTool(model: string): Promise<{ tool: ChatToolDef; body: any }> {
  configure(model);
  const tool = getPageTool();
  await chat({ model, messages: [{ role: 'user', content: 'read notes/alpha-example' }], tools: [tool], maxTokens: 256 });
  expect(bodies).toHaveLength(1);
  return { tool, body: bodies[0] };
}

describe('tool strict mode on the request body', () => {
  test('native OpenAI Responses: get_page is sent with strict false and only slug required', async () => {
    const { tool, body } = await sendWithTool('openai:gpt-4o-mini');
    expect(body.tools).toHaveLength(1);
    const sent = body.tools[0];
    expect(sent.type).toBe('function');
    expect(sent.name).toBe('brain_get_page');
    expect(sent.strict).toBe(false);
    expect(sent.parameters.required).toEqual(['slug']);
    expect(Object.keys(sent.parameters.properties)).toEqual(Object.keys((tool.inputSchema as any).properties));
  });

  test('native Anthropic: no strict field is added', async () => {
    const { body } = await sendWithTool('anthropic:claude-sonnet-4-6');
    expect(body.tools).toHaveLength(1);
    expect('strict' in body.tools[0]).toBe(false);
    expect(body.tools[0].input_schema.required).toEqual(['slug']);
  });

  test('OpenAI-compatible (DeepSeek): no strict field is added', async () => {
    const { body } = await sendWithTool('deepseek:deepseek-chat');
    expect(body.tools).toHaveLength(1);
    expect('strict' in body.tools[0].function).toBe(false);
    expect(body.tools[0].function.parameters.required).toEqual(['slug']);
  });
});
