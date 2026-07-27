/**
 * Pins the DeepSeek reasoning_content transport shim. `deepseek-reasoner`
 * returns its answer in a separate `reasoning_content` field and leaves
 * `content` empty when the whole turn was reasoning; the AI SDK's
 * openai-compatible adapter reads only `content`, so the model appears to
 * answer with nothing. The shim promotes `reasoning_content` into `content`
 * when `content` is empty, fail-open on anything unexpected.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { deepseekReasoningContentCompatFetch, deepseek } from '../../src/core/ai/recipes/deepseek.ts';
import { applyOpenAICompatConfig } from '../../src/core/ai/gateway.ts';
import type { Recipe, AIGatewayConfig } from '../../src/core/ai/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(body: unknown, init?: { status?: number; contentType?: string }) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'content-type': init?.contentType ?? 'application/json' },
    })) as unknown as typeof fetch;
}

describe('deepseekReasoningContentCompatFetch', () => {
  test('promotes reasoning_content when content is empty', async () => {
    stubFetch({ choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'the answer' } }] });
    const res = await deepseekReasoningContentCompatFetch('https://api.deepseek.com/v1/chat/completions');
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('the answer');
  });

  test('promotes when content is null or whitespace-only', async () => {
    stubFetch({ choices: [{ message: { content: null, reasoning_content: 'from null' } }, { message: { content: '   ', reasoning_content: 'from ws' } }] });
    const res = await deepseekReasoningContentCompatFetch('u');
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('from null');
    expect(json.choices[1].message.content).toBe('from ws');
  });

  test('leaves non-empty content untouched (no duplication)', async () => {
    stubFetch({ choices: [{ message: { content: 'real content', reasoning_content: 'ignored' } }] });
    const res = await deepseekReasoningContentCompatFetch('u');
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('real content');
  });

  test('both empty: stays empty, no crash', async () => {
    stubFetch({ choices: [{ message: { content: '', reasoning_content: '' } }] });
    const res = await deepseekReasoningContentCompatFetch('u');
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('');
  });

  test('tool-call turn (content:null + tool_calls) is NOT promoted — never feed CoT back', async () => {
    // content:null is the standard OpenAI shape on a tool-call turn. Promoting
    // reasoning_content here would inject the whole chain-of-thought as assistant
    // text, which the loop persists + replays every turn. Must be left alone.
    stubFetch({ choices: [{ finish_reason: 'tool_calls', message: {
      content: null,
      reasoning_content: 'INTERNAL CHAIN OF THOUGHT — must not leak',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'brain_search', arguments: '{}' } }],
    } }] });
    const res = await deepseekReasoningContentCompatFetch('u');
    const json = await res.json();
    expect(json.choices[0].message.content).toBeNull();
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
  });

  test('rebuilt response drops stale content-length header', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'x' } }] }), {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999' },
    })) as unknown as typeof fetch;
    const res = await deepseekReasoningContentCompatFetch('u');
    expect(res.headers.get('content-length')).toBeNull();
    expect((await res.json()).choices[0].message.content).toBe('x');
  });
});

describe('applyOpenAICompatConfig — compat.fetch wiring (gateway seam)', () => {
  const cfg = { env: {}, base_urls: {} } as unknown as AIGatewayConfig;

  test('threads recipe.compat.fetch onto the resolved config (deepseek)', () => {
    // Guards the src/core/ai/gateway.ts wiring: without `?? recipe.compat?.fetch`
    // the DeepSeek shim would never install in production.
    const resolved = applyOpenAICompatConfig(deepseek, cfg);
    expect(resolved.fetch).toBe(deepseekReasoningContentCompatFetch);
  });

  test('a resolveOpenAICompatConfig-provided fetch takes precedence over compat.fetch', () => {
    const ownFetch = (async () => new Response('{}')) as unknown as typeof fetch;
    const recipe = {
      id: 'x', name: 'X', tier: 'openai-compat', implementation: 'openai-compatible',
      touchpoints: {},
      compat: { fetch: deepseekReasoningContentCompatFetch },
      resolveOpenAICompatConfig: () => ({ baseURL: 'http://x', fetch: ownFetch }),
    } as unknown as Recipe;
    expect(applyOpenAICompatConfig(recipe, cfg).fetch).toBe(ownFetch);
  });

  test('falls back to compat.fetch when resolveOpenAICompatConfig omits a fetch', () => {
    const recipe = {
      id: 'y', name: 'Y', tier: 'openai-compat', implementation: 'openai-compatible',
      touchpoints: {},
      compat: { fetch: deepseekReasoningContentCompatFetch },
      resolveOpenAICompatConfig: () => ({ baseURL: 'http://y' }),
    } as unknown as Recipe;
    expect(applyOpenAICompatConfig(recipe, cfg).fetch).toBe(deepseekReasoningContentCompatFetch);
  });

  test('fail-open on non-ok / non-json responses', async () => {
    stubFetch({ error: 'nope' }, { status: 500 });
    const res = await deepseekReasoningContentCompatFetch('u');
    expect(res.status).toBe(500);
    globalThis.fetch = (async () =>
      new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const res2 = await deepseekReasoningContentCompatFetch('u');
    expect(await res2.text()).toBe('plain text');
  });

  test('recipe wires the shim via compat.fetch', () => {
    expect(deepseek.compat?.fetch).toBe(deepseekReasoningContentCompatFetch);
  });
});
