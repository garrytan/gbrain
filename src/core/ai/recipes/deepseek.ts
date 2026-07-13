import type { Recipe } from '../types.ts';

/**
 * DeepSeek-style reasoning models can return the assistant answer in
 * `message.reasoning_content` while leaving `message.content` empty. The AI
 * SDK's OpenAI-compatible adapter reads only `content`, so promote the field
 * before the SDK parses the response.
 */
export const deepseekReasoningContentCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const resp = await fetch(input, init);
  if (!resp.ok) return resp;
  const ct = resp.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return resp;

  try {
    const json: any = await resp.clone().json();
    if (!json || typeof json !== 'object' || !Array.isArray(json.choices)) {
      return resp;
    }

    let modified = false;
    for (const choice of json.choices) {
      const message = choice?.message;
      if (!message || typeof message !== 'object') continue;
      const content = message.content;
      const reasoningContent = message.reasoning_content;
      const contentIsEmpty =
        content === null ||
        content === undefined ||
        (typeof content === 'string' && content.trim().length === 0);
      if (
        contentIsEmpty &&
        typeof reasoningContent === 'string' &&
        reasoningContent.trim().length > 0
      ) {
        message.content = reasoningContent;
        modified = true;
      }
    }

    if (!modified) return resp;
    return new Response(JSON.stringify(json), {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  } catch {
    return resp;
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
  compat: {
    fetch: deepseekReasoningContentCompatFetch,
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
};
