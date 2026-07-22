import type { Recipe } from '../types.ts';

/**
 * `deepseek-reasoner` returns its answer in a separate `reasoning_content`
 * field and leaves `content` empty/whitespace when the whole response was
 * reasoning. The AI SDK's openai-compatible adapter reads only `content`, so
 * the model appears to answer with nothing. This transport shim promotes
 * `reasoning_content` into `content` when `content` is empty, before the
 * adapter parses the body. Fail-open: any error returns the original response.
 * Non-streaming JSON chat completions only.
 *
 * @internal exported for tests.
 */
// Cast through `unknown` because TS's `typeof fetch` includes a `preconnect`
// member the arrow function does not implement (matches azure-openai.ts).
export const deepseekReasoningContentCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const res = await fetch(input as any, init as any);
  try {
    if (!res.ok) return res;
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('application/json')) return res;
    const json = await res.clone().json();
    const choices = Array.isArray(json?.choices) ? json.choices : [];
    let modified = false;
    for (const choice of choices) {
      const msg = choice?.message;
      if (!msg) continue;
      // A tool-call turn legitimately carries content:null — the answer is the
      // tool call, not text. NEVER promote reasoning_content there: DeepSeek's
      // chain-of-thought must not be fed back to the model (it would be
      // persisted as assistant text and replayed every subsequent turn,
      // contaminating context and inflating tokens). Only promote on a terminal
      // text turn whose content is empty.
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const content = msg.content;
      const reasoning = msg.reasoning_content;
      const contentEmpty = content == null || (typeof content === 'string' && content.trim() === '');
      if (!hasToolCalls && contentEmpty && typeof reasoning === 'string' && reasoning.trim() !== '') {
        msg.content = reasoning;
        modified = true;
      }
    }
    if (!modified) return res;
    // Rebuild with a fresh header set: the body length changed, so the
    // upstream content-length / content-encoding would now be wrong.
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(json), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch {
    return res;
  }
}) as unknown as typeof fetch;

/**
 * DeepSeek exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * Useful as the second hop in a refusal-fallback chain and for cheap-
 * research delegation: 25-40x cheaper than Anthropic on equivalent
 * reasoning workloads.
 */
export const deepseek: Recipe = {
  id: 'deepseek',
  name: 'DeepSeek',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.deepseek.com/v1',
  auth_env: {
    required: ['DEEPSEEK_API_KEY'],
    setup_url: 'https://platform.deepseek.com/api_keys',
  },
  touchpoints: {
    chat: {
      models: ['deepseek-chat', 'deepseek-reasoner'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: 0.14, // deepseek-chat off-peak baseline
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.deepseek.com/api_keys, then `export DEEPSEEK_API_KEY=...`',
  compat: { fetch: deepseekReasoningContentCompatFetch },
};
