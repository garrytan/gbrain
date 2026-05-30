import { describe, expect, test } from 'bun:test';
import {
  openAICodexChat,
  openAICodexJson,
} from '../src/core/ai/openai-codex/adapter.ts';
import { InMemoryTokenStore } from '../src/core/ai/openai-codex/token-store.ts';

function tokenStore(): InMemoryTokenStore {
  const store = new InMemoryTokenStore();
  void store.set({
    access_token: 'access-token-test',
    refresh_token: 'refresh-token-test',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return store;
}

describe('openai-codex native adapter', () => {
  test('posts ChatGPT OAuth bearer token to backend /responses and normalizes text response', async () => {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), init, body });
      return new Response(JSON.stringify({
        id: 'resp_123',
        model: 'gpt-5.5',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'adapter-ok' }] },
        ],
        usage: { input_tokens: 11, output_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexChat({
      model: 'gpt-5.5',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 32,
      tokenStore: tokenStore(),
      fetchImpl,
    });

    expect(result.text).toBe('adapter-ok');
    expect(result.usage.input_tokens).toBe(11);
    expect(result.usage.output_tokens).toBe(3);
    expect(result.model).toBe('openai-codex:gpt-5.5');
    expect(result.providerId).toBe('openai-codex');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-test');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((calls[0].init.headers as Record<string, string>)['OpenAI-Beta']).toBe('responses_http');
    expect(calls[0].body.model).toBe('gpt-5.5');
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.instructions).toBe('Be terse.');
    expect(calls[0].body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
    ]);
  });

  test('requests strict JSON schema output and parses returned JSON text', async () => {
    const calls: Array<any> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return new Response(JSON.stringify({
        output_text: '{"queries":["alpha","beta"]}',
        usage: { input_tokens: 7, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexJson<{ queries: string[] }>({
      model: 'gpt-5.5',
      prompt: 'Return query rewrites.',
      schemaName: 'gbrain_expansion',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
      },
      tokenStore: tokenStore(),
      fetchImpl,
    });

    expect(result.object).toEqual({ queries: ['alpha', 'beta'] });
    expect(result.usage.input_tokens).toBe(7);
    expect(result.usage.output_tokens).toBe(6);
    expect(calls[0].text.format).toEqual({
      type: 'json_schema',
      name: 'gbrain_expansion',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { queries: { type: 'array', items: { type: 'string' } } },
        required: ['queries'],
      },
      strict: true,
    });
  });

  test('maps assistant history turns to output_text and user turns to input_text', async () => {
    // Regression: the Codex Responses API rejects `input_text` on assistant
    // content parts with HTTP 400. Multi-turn replay (think/dream/subagent
    // history) must send `output_text` for assistant turns.
    const calls: Array<any> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        output_text: '7',
        usage: { input_tokens: 9, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await openAICodexChat({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'My favorite number is 7.' },
        { role: 'assistant', content: 'Got it, 7.' },
        { role: 'user', content: 'What is my favorite number?' },
      ],
      tokenStore: tokenStore(),
      fetchImpl,
    });

    expect(calls[0].input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'My favorite number is 7.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Got it, 7.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'What is my favorite number?' }] },
    ]);
  });

  test('sends tool defs and parses function_call output into tool-call blocks', async () => {
    const calls: Array<any> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        output: [
          { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        usage: { input_tokens: 12, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexChat({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      tokenStore: tokenStore(),
      fetchImpl,
    });

    // Request carried tools in Responses API shape.
    expect(calls[0].tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, strict: false },
    ]);
    expect(calls[0].tool_choice).toBe('auto');

    // Response surfaced a tool-call block + tool_calls stop reason.
    expect(result.stopReason).toBe('tool_calls');
    const toolCall = result.blocks.find((b: any) => b.type === 'tool-call') as any;
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe('call_abc');
    expect(toolCall.toolName).toBe('get_weather');
    expect(toolCall.input).toEqual({ city: 'Paris' });
  });

  test('replays assistant tool-call and tool-result blocks as function_call / function_call_output items', async () => {
    const calls: Array<any> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        output_text: 'It is sunny in Paris.',
        usage: { input_tokens: 20, output_tokens: 6 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await openAICodexChat({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'weather in Paris?' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_abc', toolName: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'assistant', content: [{ type: 'tool-result', toolCallId: 'call_abc', toolName: 'get_weather', output: '{"temp":"22C","sky":"sunny"}' }] },
        { role: 'user', content: 'summarize' },
      ],
      tokenStore: tokenStore(),
      fetchImpl,
    });

    const input = calls[0].input;
    // user text
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'weather in Paris?' }] });
    // assistant function_call
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' });
    // function_call_output
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call_abc', output: '{"temp":"22C","sky":"sunny"}' });
    // trailing user
    expect(input[3]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'summarize' }] });

    expect(result.text).toBe('It is sunny in Paris.');
    expect(result.stopReason).toBe('end');
  });

  test('dedupes streamed function_call output_item.added/done pairs by call_id', async () => {
    const stream = [
      'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_x","name":"get_secret_number","arguments":""}}',
      '',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_x","name":"get_secret_number","arguments":"{\\"k\\":1}"}}',
      '',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchImpl = (async (_u?: any, _i?: any) => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const result = await openAICodexChat({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'secret?' }],
      tools: [{ name: 'get_secret_number', description: 'x', inputSchema: { type: 'object', properties: {}, required: [] } }],
      tokenStore: tokenStore(),
      fetchImpl,
    });
    const toolCalls = result.blocks.filter((b: any) => b.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as any).toolCallId).toBe('call_x');
    expect((toolCalls[0] as any).input).toEqual({ k: 1 });
    expect(result.stopReason).toBe('tool_calls');
  });
});
