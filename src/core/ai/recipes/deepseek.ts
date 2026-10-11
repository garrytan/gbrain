import type { Recipe } from '../types.ts';

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
    embedding: {
      models: [],
      user_provided_models: true,
      default_dims: 1536,
      dims_options: [1536],
      cost_per_1m_tokens_usd: 0.001,
      price_last_verified: '2026-06-02',
      max_batch_tokens: 8192,
    },
    expansion: {
      models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
      cost_per_1m_tokens_usd: 0.07,
      price_last_verified: '2026-06-02',
    },
    chat: {
      models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
      supports_vision: true,
      vision_models: ['deepseek-flash', 'deepseek-v4-flash'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_output_tokens: model=>['deepseek-flash','deepseek-v4-flash','deepseek-v4-pro'].includes(model)?393216:undefined,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: 0.07,
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-06-02',
    },
  },
  setup_hint: 'Get an API key at https://platform.deepseek.com/api_keys, then `export DEEPSEEK_API_KEY=...`',
  compat: { fetch: deepseekReasoningContentCompatFetch },
};
